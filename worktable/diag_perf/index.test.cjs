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
