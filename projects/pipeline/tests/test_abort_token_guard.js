// test_abort_token_guard.js — 中止回归测试：脚本在途时中止并启动新运行，
// 旧脚本迟回的结果不得污染新运行（不得 advance/finish、不得改写节点状态、不得动新运行的 timer）。
// 多运行上下文改造后：每次运行持有独立 rc，迟回守卫为 rc.over || rc.token !== tk（令牌仅在 startSimRun 创建 rc 时 ++runSeq 发放）。
// 用法：PIPELINE_HTML=<pipeline.html 路径> node test_abort_token_guard.js
const fs = require("fs");
const vm = require("vm");

const pipelineHtml = process.env.PIPELINE_HTML || __dirname + "/../pipeline.html";
const source = fs.readFileSync(pipelineHtml, "utf8");
const start = source.indexOf("async function runScriptStep(rc, i)");
const end = source.indexOf("function runStage(rc, i)", start);
if (start < 0 || end < 0) throw new Error("runScriptStep not found");

let rcSeq = 0;
function makeRc(token) {   // 与 startSimRun 构造的运行上下文同形状
  return {
    id: "r-test-" + (++rcSeq),
    stages: [{ id: "s1", name: "部署", script: { name: "deploy.sh", path: "/tmp/deploy.sh" }, timeout: 120 }],
    nodes: {}, selId: null, timer: null, over: false, overall: null,
    env: "", envs: [], image: "img", release: "img", commit: "abcdef0", tag: "t" + token,
    startTs: Date.now(), by: "test", source: "manual",
    pipelineId: "p1", pipelineName: "pipe", repoId: null, repoName: "", repoUrl: "", giturl: "",
    repoUser: "", repoPass: "", branch: "main", strategy: "", prom: null, vars: {}, archive: null,
    token,
  };
}

function makeContext() {
  const calls = { advance: [], finish: [] };
  const context = {
    running: false,
    activeRuns: [],
    viewRc: null,          // 编排区当前展示的运行上下文（视图层全局）
    selectedId: null,      // 视图层选中节点（syncViewRun 由 viewRc.selId 重绑的全局别名）
    calls,
    resolveExec: null,
    console,
    AbortController,
    setInterval: () => 1,
    clearInterval: () => {},
    runSetSel(rc, id) { rc.selId = id; if (context.viewRc === rc) context.selectedId = id; },   // 与页面同名实现对齐
    rcRender() {},
    rcOverall(rc, txt, cls, color) { rc.overall = { txt, cls, color: color || "" }; },
    syncViewRun() {},
    syncRunState() { context.running = context.activeRuns.length > 0; },
    viewActive() { return !!(context.viewRc && !context.viewRc.over); },
    renderDetail() {},
    archiveFolderFor() { return null; },
    taskLogFile(ctx, seq, name) { return "run-" + ctx.tag + "-" + seq + "-" + name + ".log"; },
    mergeStageVars() { return {}; },
    parseStageJson() { return null; },
    applyOutVars() {},
    archiveStageLog() {},
    stageSeq(stg, i) { return i + 1; },   // 序号函数现签名 (stg, i)：非预设阶段取 i+1
    advance(rc, i) { calls.advance.push({ rc, i }); },
    finish(rc, result) { calls.finish.push({ rc, result }); },
    execScript() { return new Promise((res) => { context.resolveExec = res; }); },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

(async () => {
  // 场景 1：中止后启动新运行，旧脚本迟回 → 必须被丢弃（rc.over 守卫），且不得触碰新运行的 nodes/timer
  {
    const ctx = makeContext();
    const rc1 = makeRc(1);
    ctx.activeRuns.push(rc1); ctx.viewRc = rc1;
    const p = ctx.runScriptStep(rc1, 0);
    if (rc1.nodes.s1.status !== "running") throw new Error("stage should be running");
    if (rc1.selId !== "s1") throw new Error("runSetSel should select the running stage");
    // 中止（对齐 abortRun/finish 的可观察效果：清本运行 timer、运行中节点置 aborted、标 over）
    rc1.timer = null;
    rc1.nodes.s1 = { status: "aborted", progress: 0, dur: 0, sub: {}, varsIn: {}, varsOut: {} };
    rc1.over = true;
    const rc2 = makeRc(2);            // 队列/手动启动新运行：独立上下文、新令牌（token:++runSeq）
    rc2.timer = 7;                    // 新运行的在途 interval（mock setInterval 返回值之外的标记值）
    ctx.activeRuns.push(rc2); ctx.viewRc = rc2;
    ctx.resolveExec({ code: 0, stdout: "", stderr: "" });   // 旧脚本迟回
    await p;
    if (ctx.calls.advance.length || ctx.calls.finish.length)
      throw new Error("stale script result advanced the NEW run: " + JSON.stringify(ctx.calls));
    if (Object.keys(rc2.nodes).length)
      throw new Error("stale script result rewrote the NEW run nodes: " + JSON.stringify(rc2.nodes));
    if (rc2.timer !== 7)
      throw new Error("stale script result touched the NEW run timer: " + rc2.timer);
    if (rc1.nodes.s1.status !== "aborted")
      throw new Error("stale script result rewrote the aborted run node: " + JSON.stringify(rc1.nodes.s1));
    console.log("scenario 1 (abort → new run, stale result discarded): OK");
  }
  // 场景 1b：运行令牌与开跑时快照不一致（rc.token !== tk 守卫）→ 迟回同样丢弃，且不清本运行 timer
  {
    const ctx = makeContext();
    const rc = makeRc(1);
    ctx.activeRuns.push(rc); ctx.viewRc = rc;
    const p = ctx.runScriptStep(rc, 0);
    const inflightTimer = rc.timer;   // mock setInterval 的返回值
    rc.token = 99;                    // 令牌已换发：本次迟回属于旧令牌
    ctx.resolveExec({ code: 0, stdout: "", stderr: "" });
    await p;
    if (ctx.calls.advance.length || ctx.calls.finish.length)
      throw new Error("stale-token result advanced the run: " + JSON.stringify(ctx.calls));
    if (rc.nodes.s1.status !== "running")
      throw new Error("stale-token result rewrote the node: " + JSON.stringify(rc.nodes.s1));
    if (rc.timer !== inflightTimer)
      throw new Error("stale-token result cleared the in-flight timer");
    console.log("scenario 1b (token mismatch, stale result discarded, timer kept): OK");
  }
  // 场景 2：同一运行令牌未变 → 正常推进
  {
    const ctx = makeContext();
    const rc = makeRc(1);
    ctx.activeRuns.push(rc); ctx.viewRc = rc;
    const p = ctx.runScriptStep(rc, 0);
    ctx.resolveExec({ code: 0, stdout: "", stderr: "" });
    await p;
    if (ctx.calls.advance.length !== 1 || ctx.calls.advance[0].rc !== rc || ctx.calls.advance[0].i !== 1)
      throw new Error("same-run result should advance this run to stage 1: " + JSON.stringify(ctx.calls));
    if (ctx.calls.finish.length)
      throw new Error("successful stage must not finish the run: " + JSON.stringify(ctx.calls.finish));
    if (rc.nodes.s1.status !== "success")
      throw new Error("stage should be marked success: " + JSON.stringify(rc.nodes.s1));
    if (rc.timer !== null)
      throw new Error("run timer should be cleared after the stage settled");
    console.log("scenario 2 (same run, result applied and advanced): OK");
  }
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
