const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `index.html 应定义 ${name}()`);
  const open = html.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let regex = false;
  let escaped = false;
  for (let i = open; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (regex) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "/") regex = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/") {
      const prefix = html.slice(start, i).trimEnd();
      const prev = prefix.at(-1) || "";
      const word = prefix.match(/([a-zA-Z_$][\w$]*)$/)?.[1] || "";
      if (!prefix || "([{:;,=!?&|".includes(prev) || word === "return") {
        regex = true;
        continue;
      }
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`${name}() 函数体不完整`);
}

function loadFunctions(names) {
  const context = vm.createContext({ URLSearchParams });
  names.forEach((name) => vm.runInContext(functionSource(name), context));
  return context;
}

test("不同数据集的 PromQL 使用各自标签，不会串用另一个数据集", () => {
  const ctx = loadFunctions(["escQL", "labelSelector", "withLabels"]);
  const query = "sum(rate(vllm:tokens_total[5m]))";

  assert.equal(
    ctx.withLabels(query, { model_name: "baseline-model", xds_namespace: "ns-a" }),
    'sum(rate(vllm:tokens_total{model_name="baseline-model",xds_namespace="ns-a"}[5m]))',
  );
  assert.equal(
    ctx.withLabels(query, { model_name: "degraded-model", xds_namespace: "ns-b" }),
    'sum(rate(vllm:tokens_total{model_name="degraded-model",xds_namespace="ns-b"}[5m]))',
  );
});

test("每个数据集独立计算相对或绝对时间窗口", () => {
  const ctx = loadFunctions(["datasetWindow"]);
  const now = 1_800_000_000;

  assert.deepEqual(
    { ...ctx.datasetWindow({ rangeM: 60, abs: null }, 48, now) },
    { end: 1_800_000_000, step: 75 },
  );
  assert.deepEqual(
    { ...ctx.datasetWindow({ rangeM: 5, abs: { from: 1_700_000_000, to: 1_700_004_800 } }, 48, now) },
    { end: 1_700_004_800, step: 100 },
  );
});

test("劣化方向按指标语义计算：时延升高和吞吐下降均为劣化", () => {
  const ctx = loadFunctions(["metricChange"]);

  assert.deepEqual(
    { ...ctx.metricChange(100, 150, false) },
    { base: 100, degraded: 150, delta: 50, pct: 50, worsePct: 50 },
  );
  assert.deepEqual(
    { ...ctx.metricChange(1000, 800, true) },
    { base: 1000, degraded: 800, delta: -200, pct: -20, worsePct: 20 },
  );
});

test("旧版全局设置迁移为单数据集 A，数据集 B 保持独立默认值", () => {
  const ctx = loadFunctions(["normalizeDatasetConfig", "normalizeDatasetState"]);
  const legacy = {
    labels: { model_name: "legacy-model", xds_namespace: "legacy-ns" },
    rangeM: 720,
    abs: { from: 100, to: 200 },
    logDir: "/logs/a/",
    profDir: "/prof/a/",
  };

  const state = ctx.normalizeDatasetState(null, legacy);

  assert.equal(state.mode, "single");
  assert.deepEqual(
    JSON.parse(JSON.stringify(state.a)),
    {
      model_name: "legacy-model",
      xds_namespace: "legacy-ns",
      rangeM: 720,
      abs: { from: 100, to: 200 },
      logDir: "/logs/a",
      profDir: "/prof/a",
    },
  );
  assert.equal(state.b.model_name, "");
  assert.equal(state.b.rangeM, 240);
  assert.equal(state.b.abs, null);
});

test("旧版时间对比迁移为 A 基线、B 劣化对象", () => {
  const ctx = loadFunctions(["normalizeDatasetConfig", "normalizeDatasetState"]);
  const state = ctx.normalizeDatasetState(null, {
    labels: { model_name: "legacy-model", xds_namespace: "legacy-ns" },
    rangeM: 60,
    abs: null,
    logDir: "/logs/current",
    profDir: "/prof/current",
    compare: { on: true, shift: 86_400, abs: null },
    now: 1_800_000_000,
  });

  assert.equal(state.mode, "compare");
  assert.equal(state.a.model_name, "legacy-model");
  assert.deepEqual(
    JSON.parse(JSON.stringify(state.a.abs)),
    { from: 1_799_910_000, to: 1_799_913_600 },
  );
  assert.equal(state.b.model_name, "legacy-model");
  assert.equal(state.b.abs, null);
});

test("Prometheus 标签值写入 HTML 属性时转义引号", () => {
  const ctx = loadFunctions(["escAttr"]);

  assert.equal(
    ctx.escAttr('model" onmouseover="alert(1)\'&<>'),
    "model&quot; onmouseover=&quot;alert(1)&#39;&amp;&lt;&gt;",
  );
});

test("Prometheus 轮次与配置、画板代次任一不符时均视为旧响应", () => {
  const ctx = loadFunctions(["staleRun"]);
  ctx.CONFIG_GEN = 3;
  ctx.PROM_GEN = 8;

  assert.equal(ctx.staleRun({ configGen: 3, promGen: 8 }), false);
  assert.equal(ctx.staleRun({ configGen: 2, promGen: 8 }), true);
  assert.equal(ctx.staleRun({ configGen: 3, promGen: 7 }), true);
});

test("辅助证据仅在 A/B 两侧均加载成功时可比较", () => {
  const ctx = loadFunctions(["auxReady"]);
  ctx.AUX = { a: { logState: "loaded", profState: "failed" }, b: { logState: "loaded", profState: "loaded" } };

  assert.equal(ctx.auxReady("log"), true);
  assert.equal(ctx.auxReady("prof"), false);
});

test("任意内置指标的有限值都可判定 Prometheus 数据已就绪", () => {
  const ctx = loadFunctions(["hasFiniteMetricData"]);

  assert.equal(ctx.hasFiniteMetricData({ ts: ["12:00"], tps: [NaN, 812], ttft: { p99: [NaN] } }), true);
  assert.equal(ctx.hasFiniteMetricData({ ts: ["12:00"], profOps: [["op", "30%"]], tps: [NaN] }), false);
});

test("Prometheus 缺失时，日志或 Profiling 仍可让报告进入证据分析", () => {
  const ctx = loadFunctions(["hasReportEvidence"]);

  assert.equal(ctx.hasReportEvidence(false, false, false), false);
  assert.equal(ctx.hasReportEvidence(false, true, false), true);
  assert.equal(ctx.hasReportEvidence(false, false, true), true);
});

test("当前 Prometheus 轮次无数据时清空上一轮指标与 A/B 对比", () => {
  const ctx = loadFunctions(["clearPromRound"]);
  ctx.PROM_MATCHED = 4;
  ctx.COMPARE = { tps: [1_000] };
  ctx.DATA = { ts: ["old"], tps: [800] };
  ctx.LIVE = true;
  ctx.applySeries = () => { ctx.DATA.tps = [NaN]; };
  ctx.clearAllSel = () => {};
  ctx.renderAll = () => {};

  ctx.clearPromRound(["new"]);

  assert.equal(ctx.PROM_MATCHED, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.COMPARE)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.DATA.ts)), ["new"]);
  assert.equal(ctx.LIVE, false);
});

test("流水线运行耗时字符串解析为秒", () => {
  const ctx = loadFunctions(["parseRunDur"]);

  assert.equal(ctx.parseRunDur("45s"), 45);
  assert.equal(ctx.parseRunDur("2m14s"), 134);
  assert.equal(ctx.parseRunDur("10m0s"), 600);
  assert.equal(ctx.parseRunDur("3m"), 180);
  assert.equal(ctx.parseRunDur(""), 0);
  assert.equal(ctx.parseRunDur(null), 0);
  assert.equal(ctx.parseRunDur("abc"), 0);
});

test("运行导入窗口优先取运行起止，缺起点时用耗时回推", () => {
  const ctx = loadFunctions(["parseRunDur", "runImportWindow"]);

  assert.deepEqual(
    { ...ctx.runImportWindow({ ts: 1789517405110, startTs: 1789517271275, dur: "2m14s" }, 240) },
    { from: 1789517271, to: 1789517405 },
  );
  assert.deepEqual(
    { ...ctx.runImportWindow({ ts: 1789517405110, startTs: null, dur: "2m14s" }, 240) },
    { from: 1789517405 - 134, to: 1789517405 },
  );
  assert.deepEqual(
    { ...ctx.runImportWindow({ ts: 1789517405110, dur: "" }, 240) },
    { from: 1789517405 - 14400, to: 1789517405 },
  );
  assert.equal(ctx.runImportWindow({ ts: 0, startTs: 0 }, 240), null);
  assert.equal(ctx.runImportWindow({ ts: 100000, startTs: 200000 }, 240), null);
});

test("运行导入填充：普罗标签非空才覆盖，归档目录作为日志目录", () => {
  const ctx = loadFunctions(["parseRunDur", "runImportWindow", "runImportPatch"]);
  const ds = { model_name: "old-model", xds_namespace: "old-ns", rangeM: 240, abs: null, logDir: "/logs/old", profDir: "" };

  const full = ctx.runImportPatch(
    { ts: 1789517405110, startTs: 1789517271275, archive: "/var/log/op_test/x/", prom: { enabled: true, modelName: "m1", xdsNamespace: "ns1" } },
    ds,
  );
  assert.equal(full.model_name, "m1");
  assert.equal(full.xds_namespace, "ns1");
  assert.deepEqual(JSON.parse(JSON.stringify(full.abs)), { from: 1789517271, to: 1789517405 });
  assert.equal(full.logDir, "/var/log/op_test/x");

  const noProm = ctx.runImportPatch({ ts: 1789517405110, startTs: 1789517271275, archive: "", prom: null }, ds);
  assert.equal(noProm.model_name, "old-model");
  assert.equal(noProm.xds_namespace, "old-ns");
  assert.equal(noProm.logDir, "/logs/old");

  const emptyLabels = ctx.runImportPatch(
    { ts: 1789517405110, startTs: 1789517271275, prom: { enabled: true, modelName: "", xdsNamespace: "-ns" } },
    ds,
  );
  assert.equal(emptyLabels.model_name, "old-model");
  assert.equal(emptyLabels.xds_namespace, "-ns");
});

test("运行列表过滤按编号/tag/流水线/环境/提交/操作人匹配", () => {
  const ctx = loadFunctions(["runMatchesFilter"]);
  const rec = { no: 109, tag: "0807-805fd", pipeline: "test", env: "115.33.98.101:2222", commit: "805fd38", by: "lihaifeng", status: "failed" };

  assert.equal(ctx.runMatchesFilter(rec, ""), true);
  assert.equal(ctx.runMatchesFilter(rec, "  "), true);
  assert.equal(ctx.runMatchesFilter(rec, "805fd"), true);
  assert.equal(ctx.runMatchesFilter(rec, "LIHAIFENG"), true);
  assert.equal(ctx.runMatchesFilter(rec, "109"), true);
  assert.equal(ctx.runMatchesFilter(rec, "prod"), false);
});

test("series 标签值提取去重排序并容错", () => {
  const ctx = loadFunctions(["seriesLabelValues"]);

  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.seriesLabelValues(
      [{ model_name: "b", xds_namespace: "n1" }, { model_name: "a" }, { model_name: "a" }, { xds_namespace: "n2" }, null],
      "model_name",
    ))),
    ["a", "b"],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.seriesLabelValues([{ model_name: "m" }], "xds_namespace"))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.seriesLabelValues([], "model_name"))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.seriesLabelValues(null, "model_name"))), []);
});

test("导入标签选项：运行记录值优先，唯一候选自动选中", () => {
  const ctx = loadFunctions(["importLabelChoices"]);

  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.importLabelChoices("-lihaifeng", ["ns-a", "-lihaifeng"]))),
    { options: ["-lihaifeng", "ns-a"], selected: "-lihaifeng" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.importLabelChoices("", ["only"]))),
    { options: ["only"], selected: "only" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.importLabelChoices("", ["a", "b"]))),
    { options: ["a", "b"], selected: "" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.importLabelChoices("", []))),
    { options: [], selected: "" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.importLabelChoices("", null))),
    { options: [], selected: "" },
  );
});

test("AI 诊断卡片挂在诊断报告页：选择器、按钮与函数齐备", () => {
  for (const id of ["aiCard", "aiAgentPick", "aiChat", "aiInput", "aiStartBtn", "aiSendBtn", "aiStopBtn", "aiNewBtn", "aiCopyBtn", "aiStateBadge", "aiHint"])
    assert.ok(html.includes(`id="${id}"`), `index.html 应包含 #${id}`);
  for (const name of ["aiAgentCmd", "buildAiBrief", "aiHistPush", "aiExecStream", "aiSend", "aiRunCli"])
    assert.notEqual(html.indexOf(`function ${name}(`), -1, `index.html 应定义 ${name}()`);
  /* 卡片挂在「诊断报告」标签页内（报告页起点之后、时延页起点之前） */
  const reportPane = html.indexOf('data-pane="report"');
  const aiCard = html.indexOf('id="aiCard"');
  const latencyPane = html.indexOf('data-pane="latency"');
  assert.ok(reportPane !== -1 && reportPane < aiCard && aiCard < latencyPane, "aiCard 应位于诊断报告页内");
  /* 运行中锁定 Agent 切换：流式回显与续接标记按发起时 Agent 记账 */
  assert.ok(html.includes("diag-agentPick-lock"), "运行中应锁定 Agent 选择样式");
  assert.ok(html.includes("if(AI_RUNNING)return;"), "运行中应拦截 Agent 切换点击");
  assert.ok(html.includes("function aiAppendStream(aid,text)"), "流式回显应显式按发起时 Agent 记账");
});

test("规则引擎结论写入 LAST_FINDINGS 供 AI 简报引用", () => {
  assert.ok(html.includes("var LAST_FINDINGS=[];"), "index.html 应声明 LAST_FINDINGS");
  assert.ok(html.includes("LAST_FINDINGS=findings;"), "renderAll 应把诊断结论写入 LAST_FINDINGS");
});

test("AI Agent 命令行：首轮开新会话，续聊带各 CLI 的会话续接参数", () => {
  const ctx = loadFunctions(["aiAgentCmd"]);

  assert.equal(ctx.aiAgentCmd("kimi", false), 'kimi -p "$PROMPT"');
  assert.equal(ctx.aiAgentCmd("kimi", true), 'kimi -c -p "$PROMPT"');
  assert.equal(ctx.aiAgentCmd("mimo", false), 'mimo run "$PROMPT"');
  assert.equal(ctx.aiAgentCmd("mimo", true), 'mimo run -c "$PROMPT"');
  assert.equal(ctx.aiAgentCmd("codex", false), 'codex exec --skip-git-repo-check "$PROMPT"');
  assert.equal(ctx.aiAgentCmd("codex", true), 'codex exec resume --last "$PROMPT"');
  assert.equal(ctx.aiAgentCmd("claude", false), 'claude -p "$PROMPT"');
  assert.equal(ctx.aiAgentCmd("claude", true), 'claude -p -c "$PROMPT"');
  /* 未知 Agent 回退 claude 首轮命令（续聊标记不误传到不存在的会话） */
  assert.equal(ctx.aiAgentCmd("unknown", false), 'claude -p "$PROMPT"');
  assert.equal(ctx.aiAgentCmd("unknown", true), 'claude -p "$PROMPT"');
});

test("AI 简报（单数据集）：概览统计、诊断结论、日志摘要与目录路径齐备", () => {
  const ctx = loadFunctions(["buildAiBrief", "aiLastVal", "fmtRange", "logClass"]);
  ctx.ANALYSIS_MODE = "single";
  ctx.PROM_URL = "http://prom:9090";
  ctx.PROM_PANEL_MODE = "ok";
  ctx.PROM_RANGE_M = 240;
  ctx.DATASETS = {
    a: { model_name: "m1", xds_namespace: "ns1", rangeM: 60, abs: null, logDir: "/logs/a", profDir: "/prof/a" },
    b: { model_name: "", xds_namespace: "", rangeM: 240, abs: null, logDir: "", profDir: "" },
  };
  ctx.DATA = {
    ttft: { p99: [NaN, 820] }, tpot: { p99: [95] },
    queue: { gw: [3], sched: [50], pd: [2] },
    tps: [812], hit: [58.2], kv: { usage: [91.5] },
    profOps: [["gemm", "30.0%"]],
  };
  ctx.LAST_FINDINGS = [["TPOT P99 95ms：Decode 侧带宽接近饱和", "warn"]];
  ctx.AUX = {
    a: { logState: "loaded", logName: "/logs/a/server.log", logs: ["INFO serving", "ERROR kv cache overflow", "WARN retry"] },
    b: { logState: "unconfigured", logName: "", logs: [] },
  };

  const brief = ctx.buildAiBrief();

  assert.match(brief, /单数据集瓶颈分析/);
  assert.match(brief, /model_name="m1"/);
  assert.match(brief, /TTFT P99：820 ms/);
  assert.match(brief, /队列时延（网关\+调度\+PD）：55 ms/);
  assert.match(brief, /KV Blocks 占用：91\.5%/);
  assert.match(brief, /TPOT P99 95ms：Decode 侧带宽接近饱和/);
  assert.match(brief, /gemm：30\.0%/);
  assert.match(brief, /日志目录：\/logs\/a/);
  assert.match(brief, /Profiling 目录：\/prof\/a/);
  assert.match(brief, /ERROR kv cache overflow/);
  assert.match(brief, /WARN retry/);
  assert.ok(!brief.includes("INFO serving"));   /* 有异常行时只摘异常行 */
  assert.ok(!brief.includes("A/B 劣化对比"));
});

test("AI 简报（双数据集）：含 A/B 劣化对比表与两侧日志摘要", () => {
  const ctx = loadFunctions(["buildAiBrief", "aiLastVal", "fmtRange", "fmtTs", "logClass", "compareRows", "seriesAvg", "metricChange", "fmtNum"]);
  ctx.ANALYSIS_MODE = "compare";
  ctx.PROM_URL = "http://prom:9090";
  ctx.PROM_PANEL_MODE = "ok";
  ctx.PROM_RANGE_M = 240;
  ctx.DATASETS = {
    a: { model_name: "m1", xds_namespace: "ns1", rangeM: 240, abs: { from: 1700000000, to: 1700003600 }, logDir: "/logs/a", profDir: "" },
    b: { model_name: "m1", xds_namespace: "ns1", rangeM: 240, abs: null, logDir: "/logs/b", profDir: "" },
  };
  ctx.DATA = {
    ttft: { p99: [820] }, tpot: { p99: [95] },
    queue: { gw: [3], sched: [50], pd: [2] },
    tps: [800], hit: [58], kv: { usage: [90] },
    batch: { wait: [12] }, transfer: { kv: [40] },
    profOps: [],
  };
  ctx.COMPARE = { "ttft.p99": [600], "tpot.p99": [80], tps: [1000], hit: [70], kvUsage: [80], "batch.wait": [4], "transfer.kv": [20], "queue.gw": [2], "queue.sched": [30], "queue.pd": [1] };
  ctx.LAST_FINDINGS = [["【Prometheus】TPOT 上升 18.8%：Decode 计算、HBM 带宽或 KV 换出是优先排查方向。", "warn"]];
  ctx.AUX = {
    a: { logState: "loaded", logName: "/logs/a/server.log", logs: ["INFO a ok"] },
    b: { logState: "loaded", logName: "/logs/b/server.log", logs: ["ERROR b boom"] },
  };

  const brief = ctx.buildAiBrief();

  assert.match(brief, /双数据集劣化对比（B 相对基线 A）/);
  assert.match(brief, /A\/B 劣化对比/);
  assert.match(brief, /\| TTFT P99 \| 600ms \| 820ms \| \+36\.7% \| 36\.7% \|/);
  assert.match(brief, /基线 A/);
  assert.match(brief, /数据集 A 日志摘要/);
  assert.match(brief, /INFO a ok/);   /* A 无异常行 → 退化为尾部摘要 */
  assert.match(brief, /ERROR b boom/);
  assert.match(brief, /绝对 .* ~ /);   /* 基线 A 用绝对时间窗口 */
});

test("AI 对话历史上限：超出条数从头部丢弃", () => {
  const ctx = loadFunctions(["aiHist", "aiHistPush"]);
  ctx.AI_HIST = {};
  ctx.AI_HIST_MAX = 3;
  let saved = 0;
  ctx.aiSaveJSON = () => { saved += 1; };

  for (let i = 0; i < 5; i += 1) ctx.aiHistPush("kimi", { role: "user", text: "m" + i });

  assert.equal(ctx.AI_HIST.kimi.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.AI_HIST.kimi.map((m) => m.text))), ["m2", "m3", "m4"]);
  assert.equal(saved, 5);
});
