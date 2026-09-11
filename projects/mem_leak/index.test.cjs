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

test("lvJudgeSeries 样本不足、线性上升判泄漏、平稳判健康", () => {
  const ctx = loadFunctions(["analyze", "lvJudgeSeries"]);
  const few = ctx.lvJudgeSeries([{ t: 0, v: 100 }, { t: 1, v: 110 }]);
  assert.equal(few.sev, "wait");
  assert.equal(few.cur, 110);
  const rising = [];
  for (let i = 0; i < 10; i++) rising.push({ t: i, v: 10000 + i * 100 });
  const j = ctx.lvJudgeSeries(rising);
  assert.equal(j.sev, "high");
  assert.equal(j.label, "疑似显存泄漏");
  assert.equal(Math.round(j.rateH), 6000);
  const flat = [];
  for (let i = 0; i < 10; i++) flat.push({ t: i, v: 10000 });
  assert.equal(ctx.lvJudgeSeries(flat).sev, "low");
});
