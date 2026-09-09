// test_abort_token_guard.js — 中止回归测试：脚本在途时中止并启动新运行，
// 旧脚本迟回的结果不得污染新运行（不得 advance/finish、不得改写节点状态）。
// 用法：PIPELINE_HTML=<pipeline.html 路径> node test_abort_token_guard.js
const fs = require("fs");
const vm = require("vm");

const pipelineHtml = process.env.PIPELINE_HTML || __dirname + "/pipeline.html";
const source = fs.readFileSync(pipelineHtml, "utf8");
const start = source.indexOf("async function runScriptStep(i)");
const end = source.indexOf("function runStage(i)", start);
if (start < 0 || end < 0) throw new Error("runScriptStep not found");

function makeContext() {
  const calls = { advance: [], finish: [] };
  const context = {
    running: true,
    curRun: { token: 1, vars: {} },
    runStages: [{ id: "s1", script: { name: "deploy.sh", path: "/tmp/deploy.sh" }, timeout: 120 }],
    nodes: {},
    selectedId: null,
    timer: null,
    calls,
    resolveExec: null,
    console,
    AbortController,
    setInterval: () => 1,
    clearInterval: () => {},
    activeStages: null, // 下方以闭包赋值（vm 内裸调用时 this 不指向本对象）
    applyStatusClasses() {},
    renderFlow() {},
    renderDetail() {},
    mergeStageVars() { return {}; },
    parseStageJson() { return null; },
    applyOutVars() {},
    archiveStageLog() {},
    stageSeq(i) { return i + 1; },   // 归档序号帮助函数（预设任务改造后由 runScriptStep 调用）
    archiveFolderFor() { return null; },
    advance(i) { calls.advance.push(i); },
    finish(r) { calls.finish.push(r); },
    execScript() { return new Promise((res) => { context.resolveExec = res; }); },
  };
  context.activeStages = () => context.runStages;
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

(async () => {
  // 场景 1：中止后启动新运行，旧脚本迟回 → 必须被丢弃
  {
    const ctx = makeContext();
    const p = ctx.runScriptStep(0);
    if (ctx.nodes.s1.status !== "running") throw new Error("stage should be running");
    ctx.running = false; ctx.curRun = null;                 // 中止
    ctx.curRun = { token: 2, vars: {} }; ctx.running = true; // 队列/手动启动新运行
    ctx.resolveExec({ code: 0, stdout: "", stderr: "" });    // 旧脚本迟回
    await p;
    if (ctx.calls.advance.length || ctx.calls.finish.length)
      throw new Error("stale script result advanced the NEW run: " + JSON.stringify(ctx.calls));
    console.log("scenario 1 (abort → new run, stale result discarded): OK");
  }
  // 场景 2：同一运行令牌未变 → 正常推进
  {
    const ctx = makeContext();
    const p = ctx.runScriptStep(0);
    ctx.resolveExec({ code: 0, stdout: "", stderr: "" });
    await p;
    if (ctx.calls.advance.length !== 1 || ctx.calls.advance[0] !== 1)
      throw new Error("same-run result should advance to stage 1: " + JSON.stringify(ctx.calls));
    console.log("scenario 2 (same run, result applied and advanced): OK");
  }
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
