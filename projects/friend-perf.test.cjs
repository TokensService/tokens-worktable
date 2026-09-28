const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "friend-perf.html"), "utf8");

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `friend-perf.html 应定义 ${name}()`);
  const open = html.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = open; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`${name}() 函数体不完整`);
}

function loadContext() {
  const context = vm.createContext({ Math, JSON, String });
  const wordsDecl = html.match(/var WORDS=\([\s\S]*?\)\.split\(' '\);/);
  assert.ok(wordsDecl, "friend-perf.html 应定义 WORDS 词表");
  vm.runInContext(wordsDecl[0], context);
  ["estTokens", "genText", "parseSseLines"].forEach((name) =>
    vm.runInContext(functionSource(name), context)
  );
  return context;
}

test("estTokens 按字符数估算 token（向上取整）", () => {
  const ctx = loadContext();
  assert.equal(ctx.estTokens(""), 0);
  assert.equal(ctx.estTokens("abc"), 1);
  assert.equal(ctx.estTokens("a".repeat(32)), 10);
});

test("genText 达到目标估算长度且 deterministic 模式可复现", () => {
  const ctx = loadContext();
  const a = ctx.genText(500, false);
  const b = ctx.genText(500, false);
  assert.equal(a, b, "rand=false 应产出完全相同的文本（固定前缀依赖跨轮复现）");
  assert.ok(ctx.estTokens(a) >= 500, "应达到目标估算长度");
  assert.ok(ctx.estTokens(a) < 560, "不应明显超出目标长度");
});

test("genText 为线性复杂度：大目标长度不再随规模平方劣化", () => {
  const ctx = loadContext();
  // 旧实现每轮 out.join(' ') 重算全长（O(n²)），50000 tokens 需要秒级；
  // 线性实现应在毫秒级完成。此处只做宽松上限，防回归即可。
  const t0 = process.hrtime.bigint();
  const s = ctx.genText(50000, false);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ctx.estTokens(s) >= 50000);
  assert.ok(ms < 500, `genText(50000) 耗时 ${ms.toFixed(1)}ms，疑似退化为平方复杂度`);
});

test("parseSseLines 提取内容增量与 usage，忽略 [DONE] 与坏行", () => {
  const ctx = loadContext();
  const r = ctx.parseSseLines([
    "",
    "event: message",
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    'data: {"choices":[{"delta":{"content":"你"}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"嗯"}}]}',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
    "data: [DONE]",
    "data: {bad json",
  ]);
  // vm 上下文里的数组/对象与主 realm 原型不同，deepStrictEqual 会误判，统一按 JSON 比较
  assert.equal(JSON.stringify(r.pieces), JSON.stringify(["你", "嗯"]), "role-only / 空 delta 不产生内容，content 与 reasoning_content 按序拼接");
  assert.equal(JSON.stringify(r.usage), JSON.stringify({ prompt_tokens: 10, completion_tokens: 2 }));
});

test("parseSseLines 兼容 CRLF 与 data: 后无空格的行", () => {
  const ctx = loadContext();
  const r = ctx.parseSseLines(['data:{"choices":[{"delta":{"content":"x"}}]}\r']);
  assert.equal(JSON.stringify(r.pieces), JSON.stringify(["x"]));
});

test("单次测试在计时起点之前构造提示词（buildPrompt 不计入 TTFT/总耗时）", () => {
  const src = functionSource("testProvider");
  const iPrompt = src.indexOf("var prompt=buildPrompt();");
  const iT0 = src.indexOf("t0=performance.now()");
  assert.notEqual(iPrompt, -1, "testProvider 应先构造提示词");
  assert.notEqual(iT0, -1, "testProvider 应记录计时起点 t0");
  assert.ok(iPrompt < iT0, "buildPrompt() 必须早于 t0，否则本地构词开销计入 TTFT");
  const iFetch = src.indexOf("llmFetch(");
  assert.ok(iT0 < iFetch, "t0 应在发起请求之前");
});

test("流读取收尾冲刷解码器并解析残余 buffer（防丢末尾 usage 块）", () => {
  const src = functionSource("testProvider");
  const doneIdx = src.indexOf("if(r.done)");
  assert.notEqual(doneIdx, -1);
  const tail = src.slice(doneIdx, doneIdx + 400);
  assert.ok(tail.includes("dec.decode()"), "done 分支应无参调用 dec.decode() 冲刷残余字节");
  assert.ok(tail.includes("buf.split('\\n')"), "done 分支应解析 buf 中未被换行终止的最后一段");
});

test("TPOT 口径：usage.completion_tokens 优先，缺失时按文本估算，分母为 outTok-1", () => {
  const src = functionSource("testProvider");
  assert.ok(
    src.includes("var outTok=(usage&&usage.completion_tokens)||Math.max(1,estTokens(content));"),
    "outTokens 应优先取 usage.completion_tokens"
  );
  assert.ok(
    src.includes("rec.tpot=outTok>1?Math.round((tEnd-tFirst)/(outTok-1)*10)/10:null"),
    "TPOT = (tEnd - tFirst) / (outTok - 1)"
  );
});

test("记录服务端口径 TTFT：读取中继 x-worktable-llm-ttfb 响应头写入 rec.serverTtft", () => {
  const src = functionSource("testProvider");
  assert.ok(src.includes("x-worktable-llm-ttfb"), "testProvider 应读取中继 ttfb 响应头");
  assert.ok(src.includes("rec.serverTtft"), "testProvider 应把服务端 TTFT 记入记录");
});

test("记录表含服务端TTFT列，失败展开行 colSpan 同步", () => {
  assert.ok(html.includes("服务端TTFT"), "表头应包含服务端TTFT列");
  assert.ok(html.includes("td.colSpan=11"), "失败展开行 colSpan 应随列数更新为 11");
});
