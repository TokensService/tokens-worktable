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

// 与 /api/worktable/gpu detail=true 响应同形的样例：两个进程同容器、一个无容器无内存字段
const GPU_DETAIL = {
  total: 1,
  used: 1,
  gpus: [{ index: "0", util: "35", mem: "12345", memTotal: "24576" }],
  procs: [
    { pid: "123", uuid: "GPU-a", proc: "/usr/bin/python", container: "xds-prefill", up: "Up 3 days", gpuMem: "8192", rss: "1024.0", cgMem: "2048.0" },
    { pid: "456", uuid: "GPU-a", proc: "/usr/bin/python", container: "xds-prefill", up: "Up 3 days", gpuMem: "4096", rss: "512.0", cgMem: "2048.0" },
    { pid: "789", uuid: "GPU-a", proc: "", container: "", up: "", gpuMem: "", rss: "", cgMem: "" },
  ],
  containers: ["xds-prefill"],
};

test("lvNum 只接受有限数值，空串/缺省/非数值均为 null", () => {
  const ctx = loadFunctions(["lvNum"]);
  assert.equal(ctx.lvNum("12345"), 12345);
  assert.equal(ctx.lvNum("10.5"), 10.5);
  assert.equal(ctx.lvNum(""), null);
  assert.equal(ctx.lvNum(undefined), null);
  assert.equal(ctx.lvNum("abc"), null);
});

test("lvProcLabel 容器名前缀 + basename(+pid)，缺进程名回退 pid", () => {
  const ctx = loadFunctions(["lvProcLabel"]);
  assert.equal(ctx.lvProcLabel({ pid: "123", proc: "/usr/bin/python", container: "xds-prefill" }), "xds-prefill · python(123)");
  assert.equal(ctx.lvProcLabel({ pid: "123", proc: "/usr/bin/python", container: "" }), "python(123)");
  assert.equal(ctx.lvProcLabel({ pid: "123", proc: "", container: "" }), "pid 123(123)");
});

test("lvPushPoint 同时间戳覆盖、超上限丢弃最旧点", () => {
  const ctx = loadFunctions(["lvPushPoint"]);
  ctx.LV_MAX_PTS = 3;
  const series = {};
  ctx.lvPushPoint(series, "gpu:1", "a", "gpu", 0, 10);
  ctx.lvPushPoint(series, "gpu:1", "a", "gpu", 0, 20);
  assert.deepEqual(JSON.parse(JSON.stringify(series["gpu:1"].pts)), [{ t: 0, v: 20 }]);
  ctx.lvPushPoint(series, "gpu:1", "a", "gpu", 1, 30);
  ctx.lvPushPoint(series, "gpu:1", "a", "gpu", 2, 40);
  ctx.lvPushPoint(series, "gpu:1", "a", "gpu", 3, 50);
  assert.deepEqual(JSON.parse(JSON.stringify(series["gpu:1"].pts)), [
    { t: 1, v: 30 },
    { t: 2, v: 40 },
    { t: 3, v: 50 },
  ]);
});

test("lvCollectPoints 按进程建显存/RSS 序列，同容器只建一条容器序列，缺值跳过", () => {
  const ctx = loadFunctions(["lvNum", "lvProcLabel", "lvPushPoint", "lvCollectPoints"]);
  ctx.LV_MAX_PTS = 720;
  const series = ctx.lvCollectPoints({}, GPU_DETAIL, null, 0.5);
  assert.deepEqual(Object.keys(series).sort(), ["cg:xds-prefill", "gpu:123", "gpu:456", "rss:123", "rss:456"]);
  assert.equal(series["gpu:123"].pts[0].v, 8192);
  assert.equal(series["gpu:123"].pts[0].t, 0.5);
  assert.equal(series["rss:456"].pts[0].v, 512);
  assert.equal(series["cg:xds-prefill"].pts[0].v, 2048);
  assert.equal(series["cg:xds-prefill"].pts.length, 1);
  assert.equal(series["gpu:123"].label, "xds-prefill · python(123)");
  assert.equal(series["cg:xds-prefill"].kind, "cg");
});

test("lvCollectPoints 只采勾选进程（未勾选的进程与其容器序列都不落点）", () => {
  const ctx = loadFunctions(["lvNum", "lvProcLabel", "lvPushPoint", "lvCollectPoints"]);
  ctx.LV_MAX_PTS = 720;
  const series = ctx.lvCollectPoints({}, GPU_DETAIL, { 123: true, 456: false }, 0);
  assert.deepEqual(Object.keys(series).sort(), ["cg:xds-prefill", "gpu:123", "rss:123"]);
});

test("analyze 把超过 50 MiB/h 的通用序列标成待分层确认，而非直接宣判显存泄漏", () => {
  const ctx = loadFunctions(["analyze"]);
  const rising = [];
  for (let i = 0; i < 10; i++) rising.push({ t: i, v: 10000 + i });

  const result = ctx.analyze(rising);
  assert.equal(result.verdict, "持续上升（需分层确认）");
  assert.equal(result.sev, "mid");
  assert.equal(result.trendThreshold, 50 / 60);
});

test("lvJudgeSeries 对 RSS 只做持续增长预警，不把总 RSS 直接定性为泄漏", () => {
  const ctx = loadFunctions(["analyze", "hasSustainedRise", "lvJudgeSeries"]);
  const few = ctx.lvJudgeSeries([{ t: 0, v: 100 }, { t: 1, v: 110 }], "rss");
  assert.equal(few.sev, "wait");
  assert.equal(few.cur, 110);
  const rising = [];
  for (let i = 0; i < 10; i++) rising.push({ t: i * 10, v: 10000 + i * 10 });
  const j = ctx.lvJudgeSeries(rising, "rss");
  assert.equal(j.sev, "mid");
  assert.equal(j.label, "RSS 持续上涨，需拆分 anon/file");
  assert.equal(Math.round(j.rateH), 60);
  const flat = [];
  for (let i = 0; i < 10; i++) flat.push({ t: i, v: 10000 });
  assert.equal(ctx.lvJudgeSeries(flat, "rss").sev, "low");
});

test("lvJudgeSeries 要求连续两个窗口同向，单窗口突发只提示继续观察", () => {
  const ctx = loadFunctions(["analyze", "hasSustainedRise", "lvJudgeSeries"]);
  const lateRise = [
    { t: 0, v: 10000 }, { t: 10, v: 10000 }, { t: 20, v: 10000 },
    { t: 30, v: 10000 }, { t: 40, v: 10000 }, { t: 50, v: 10000 },
    { t: 60, v: 10010 }, { t: 70, v: 10020 }, { t: 80, v: 10030 },
  ];
  const j = ctx.lvJudgeSeries(lateRise, "rss");
  assert.equal(j.sev, "wait");
  assert.equal(j.label, "RSS 上涨，继续观察第二窗口");
});

test("lvJudgeSeries 不用容器总量实锤泄漏，并把显存上涨降级为归因提示", () => {
  const ctx = loadFunctions(["analyze", "hasSustainedRise", "lvJudgeSeries"]);
  const rising = [];
  for (let i = 0; i < 10; i++) rising.push({ t: i * 10, v: 10000 + i * 100 });

  const cgroup = ctx.lvJudgeSeries(rising, "cg");
  assert.equal(cgroup.sev, "wait");
  assert.equal(cgroup.label, "容器总量需拆分 anon/cache/shmem");

  const gpu = ctx.lvJudgeSeries(rising, "gpu");
  assert.equal(gpu.sev, "mid");
  assert.equal(gpu.label, "显存持续上涨，需排除预分配");
});

test("hasSustainedRise 使用最近两个固定 30 分钟窗口，短时噪声不会外推告警", () => {
  const ctx = loadFunctions(["analyze", "hasSustainedRise"]);
  const shortNoise = [];
  for (let i = 0; i < 6; i++) shortNoise.push({ t: i, v: 10000 + i * 100 });
  assert.equal(ctx.hasSustainedRise(shortNoise, 50, 30), false);

  const oldFlatRecentRise = [];
  for (let t = 0; t <= 60; t += 10) oldFlatRecentRise.push({ t, v: 10000 });
  for (let t = 70; t <= 120; t += 10) oldFlatRecentRise.push({ t, v: 10000 + (t - 60) });
  assert.equal(ctx.hasSustainedRise(oldFlatRecentRise, 50, 30), true);
});

test("hasSustainedRise 按时间戳兼容采样间隔变化，并拒绝回落窗口与精确阈值", () => {
  const ctx = loadFunctions(["analyze", "hasSustainedRise"]);
  const mixedIntervals = [0, 10, 20, 30, 31, 40, 50, 60].map((t) => ({ t, v: 10000 + t }));
  assert.equal(ctx.hasSustainedRise(mixedIntervals, 50, 30), true);

  const riseThenFall = [0, 10, 20, 30, 40, 50, 60].map((t) => ({
    t,
    v: t <= 30 ? 10000 + t : 10030 - (t - 30),
  }));
  assert.equal(ctx.hasSustainedRise(riseThenFall, 50, 30), false);

  const exactThreshold = [0, 10, 20, 30, 40, 50, 60].map((t) => ({
    t,
    v: 10000 + t * (50 / 60),
  }));
  assert.equal(ctx.hasSustainedRise(exactThreshold, 50, 30), false);
});

test("lvJudgeSeries 把显著负斜率显示为回落，而不是平稳", () => {
  const ctx = loadFunctions(["analyze", "hasSustainedRise", "lvJudgeSeries"]);
  const falling = [];
  for (let i = 0; i < 10; i++) falling.push({ t: i * 10, v: 10000 - i * 10 });

  assert.equal(ctx.lvJudgeSeries(falling, "rss").label, "RSS 回落（释放正常）");
  assert.equal(ctx.lvJudgeSeries(falling, "cg").label, "容器总量回落");
  assert.equal(ctx.lvJudgeSeries(falling, "gpu").label, "显存回落（释放正常）");
});

test("lvJudgeBadge 保留有效待观察原因，只有无有效分析时显示样本不足", () => {
  const ctx = loadFunctions(["verdictBadge", "lvJudgeBadge"]);
  const waiting = ctx.lvJudgeBadge({
    ok: true,
    sev: "wait",
    label: "容器总量需拆分 anon/cache/shmem",
  });
  assert.match(waiting, /容器总量需拆分 anon\/cache\/shmem/);
  assert.doesNotMatch(waiting, /样本不足/);

  assert.match(ctx.lvJudgeBadge({ ok: false, sev: "wait", label: "样本不足" }), /样本不足/);
});

test("生产手册不把 memory.force_empty 暴露为在线诊断命令", () => {
  assert.doesNotMatch(html, /echo\s+0\s+[^\n]*memory\.force_empty/);
  assert.match(html, /不要在承载流量的容器执行/);
  assert.match(html, /强制回收/);
  assert.match(html, /摘流或隔离副本/);
});

test("多标签与长代码标识在窄屏可滚动或换行", () => {
  assert.match(html, /\.dshell-tabs\s*\{[^}]*overflow-x\s*:\s*auto[^}]*\}/s);
  assert.match(html, /\.dshell-tab\s*\{[^}]*white-space\s*:\s*nowrap[^}]*\}/s);
  assert.match(html, /\.ml-prose code[^\{]*\{[^}]*overflow-wrap\s*:\s*anywhere[^}]*\}/s);
});

test("新版检查清单不复用旧索引语义，并把状态写入独立版本键", () => {
  const ctx = loadFunctions(["loadChecklistState", "saveChecklistState"]);
  const calls = [];
  const storage = {
    getItem(key) {
      calls.push(["get", key]);
      return key === "memLeak.checklist" ? '{"chk0":true}' : null;
    },
    setItem(key, value) {
      calls.push(["set", key, value]);
    },
  };

  assert.deepEqual(JSON.parse(JSON.stringify(ctx.loadChecklistState(storage))), {});
  ctx.saveChecklistState(storage, { chk2: true });
  assert.deepEqual(calls, [
    ["get", "memLeak.checklist.v2"],
    ["set", "memLeak.checklist.v2", '{"chk2":true}'],
  ]);
});
