// Jenkins/EvalTokens 阶段完成状态改经服务端 stage-poll 长轮询的客户端回归测试：
// ① 服务端轮询循环（queue 拿构建号 → build 带 console 增量续传 → 终态 result；evaltokens 到终态 kind）；
// ② 404（旧服务端）/403（目标非内网）回退浏览器直连轮询，一次阶段内只回退一次并 console.warn；
// ③ 服务端 30 连败兜底 {done:true, failed:'poll'} 按阶段失败收尾；
// ④ 浏览器↔dsh 传输故障沿用连续失败计数与 30 次兜底；
// ⑤ 中止语义：AbortController 中断 fetch，finally 仍走 jkCancelExecution，rc.over||rc.token!==tk 迟回守卫。
// 沙盒切片与打桩方式同 test_http_stage_poll_failure.js。
const fs = require("fs");
const vm = require("vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const pipelineHtml = process.env.PIPELINE_HTML || __dirname + "/../pipeline.html";
const source = fs.readFileSync(pipelineHtml, "utf8");

const s0 = source.indexOf("function stageUrlOf(s)");
const e0 = source.indexOf("\n", s0) + 1;
const s1 = source.indexOf("function forEachOutputLine(output, visit)");
const e1 = source.indexOf("async function execScript", s1);
const s2 = source.indexOf("async function execScript(");
const e2 = source.indexOf("function jkJobPath(job)", s2);
const s3 = source.indexOf("function jkJobPath(job)");
const e3 = source.indexOf("async function runScriptStep", s3);   // 含 stage-poll 助手/常量、runUrlStep、EvalTokens 段、runEvaltokensStep
const s4 = source.indexOf("function createLiveOutputState(");
const e4 = source.indexOf("/* 流式执行：POST", s4);
if ([s0, e0, s1, e1, s2, e2, s3, e3, s4, e4].some(x => x < 0)) throw new Error("slice not found");

const jsonResp = obj => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => obj, text: async () => JSON.stringify(obj) });

function makeRc(stage) {
  return {
    id: "rc-poll", stages: [stage], nodes: {}, selId: "", timer: null, over: false, overall: null,
    token: 1, vars: {}, env: "", envs: [{ ip: "192.0.2.10", user: "root", pass: "" }],
    image: "", release: null, commit: null, tag: "poll", startTs: Date.now(), by: "tester",
    source: "test", pipelineId: "pl-poll", pipelineName: "poll-test", repoId: null, repoName: null,
    repoUrl: "", giturl: "", repoUser: "", repoPass: "", branch: "main", strategy: "", prom: null, archive: "",
  };
}

/* 每个用例独立沙盒：fetch 按 URL 路由（触发请求 / stage-poll 脚本化应答），jkFetchJson 等直连桩按用例注入 */
function makeContext(opts) {
  const calls = { advance: [], finish: [], stagePoll: [], warn: [], cancel: [], trigger: [] };
  const context = {
    JSON, URL, TextEncoder, AbortController, Date, console: {
      log: () => {}, warn: (...a) => { calls.warn.push(a.map(String).join(" ")); }, error: () => {},
      info: () => {},
    },
    setTimeout: fn => { fn(); return 1; },   // 轮询等待立即到期
    clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    scriptsDir: "/tmp/scripts",
    jenkins: { url: "http://jk.local", user: "", token: "", mode: "local" },
    evaltok: { url: "http://ev.local", token: "", mode: "local" },
    evaltokHeaders: e => (e.token ? { Authorization: "Bearer " + e.token } : {}),
    secToMinInput: v => String(v),
    curRun: null, viewRc: null, selectedId: "", activeRuns: [], running: true,
    viewActive: () => true,
    syncRunState: () => {}, syncViewRun: () => {},
    runSetSel: (rc_, id) => { rc_.selId = id; },
    rcRender: () => {}, rcOverall: () => {},
    applyStatusClasses: () => {}, renderFlow: () => {}, renderDetail: () => {},
    archiveStageLog: () => {}, flashRunTip: () => {},
    createClientStageLogSink: () => null,
    readBrowserResponseText: async response => response.text(),
    stageSeq: (stg, i) => i + 1,
    advance: (rc_, i) => { calls.advance.push(i); },
    finish: (rc_, s) => { calls.finish.push(s); },
    fetch: async (url, init) => {
      const u = String(url);
      if (u.includes("/api/worktable/pipeline/stage-poll/")) {
        calls.stagePoll.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null });
        return opts.stagePoll(calls.stagePoll.length, u);
      }
      if (u.startsWith("http://jk.local/")) { calls.trigger.push(u); return { ok: true, status: 200, headers: { get: n => (String(n).toLowerCase() === "location" ? "/queue/item/7/" : null) }, text: async () => "triggered" }; }
      if (opts.fetch) return opts.fetch(u, init);
      throw new Error("unexpected fetch " + u);
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(s0, e0)}
${source.slice(s1, e1)}
${source.slice(s4, e4)}
${source.slice(s2, e2)}
${source.slice(s3, e3)}`,
    context,
  );
  context.jkCancelExecution = async (...a) => { calls.cancel.push(a); };
  context.jkGetProgressiveText = async (_p, start) => ({ text: "", next: start });
  context.jkGetText = async () => "";
  return { context, calls };
}

function freshRun(context, stage) {
  const rc = makeRc(stage);
  context.curRun = rc; context.viewRc = rc; context.activeRuns = [rc];
  return rc;
}

const httpStage = () => ({ id: "st-http", name: "HTTP 阶段", kind: "http", url: { url: "http://jk.local/job/demo/build?token=t", outVars: "" } });

/* ---------- Jenkins：服务端轮询主路径 ---------- */
test("jenkins：queue 拿构建号 → build 带 console 增量续传 → 终态 SUCCESS 推进", async () => {
  const queueAnswers = [{ done: false }, { done: true, buildNumber: 42 }];
  const buildAnswers = [
    { done: false, console: { text: "line1\n", offset: 6 } },
    { done: true, result: "SUCCESS", console: { text: "end\n", offset: 10 } },
    { done: true, result: "SUCCESS", console: { text: "", offset: 10 } },   // 收尾 drain
  ];
  const { context, calls } = makeContext({
    stagePoll: () => jsonResp(queueAnswers.length ? queueAnswers.shift() : buildAnswers.shift()),
  });
  let directPolls = 0;
  context.jkFetchJson = async () => { directPolls += 1; throw new Error("直连轮询不应被调用"); };
  const rc = freshRun(context, httpStage());
  await context.runUrlStep(rc, 0);

  assert.deepEqual(calls.advance, [1], "构建成功应推进到下一阶段");
  assert.deepEqual(calls.finish, [], "成功路径不应 finish");
  assert.equal(rc.nodes["st-http"].status, "success");
  assert.equal(directPolls, 0, "服务端轮询可用时不得走浏览器直连");
  const phases = calls.stagePoll.map(r => r.body.phase);
  assert.deepEqual(phases, ["queue", "queue", "build", "build", "build"], "queue 两次（含窗口耗尽续发）+ build 两次 + 收尾 drain");
  assert.equal(calls.stagePoll[0].body.url, "http://jk.local/queue/item/7/api/json", "queue 阶段按 queue Location 绝对地址轮询");
  assert.equal(calls.stagePoll[2].body.url, "http://jk.local/job/demo/42/api/json?tree=number,building,result,duration");
  assert.equal(calls.stagePoll[2].body.console, true);
  assert.equal(calls.stagePoll[2].body.offset, 0, "build 阶段首轮 offset 从 0 开始");
  assert.equal(calls.stagePoll[3].body.offset, 6, "offset 按服务端返回值续传");
  assert.equal(calls.stagePoll[4].body.offset, 10, "收尾 drain 带最终 offset");
  assert.equal(calls.stagePoll[2].body.timeoutMs, 2500, "build 阶段长轮询窗口调小，保持控制台回显节奏");
  assert.equal(calls.stagePoll[0].body.timeoutMs, undefined, "queue 阶段用服务端默认窗口");
  const stdout = rc.stages[0]._out.stdout || "";
  assert.ok(stdout.includes("line1\nend\n"), "控制台增量分片应按续传顺序拼入日志：" + JSON.stringify(stdout.slice(-200)));
  assert.ok(stdout.includes("[HTTP result SUCCESS]"));
});

test("jenkins：queue 被取消 → {done:true, cancelled:true} 按队列取消失败收尾", async () => {
  const { context, calls } = makeContext({ stagePoll: () => jsonResp({ done: true, cancelled: true }) });
  const stage = httpStage();
  const rc = freshRun(context, stage);
  await context.runUrlStep(rc, 0);
  assert.deepEqual(calls.finish, ["failed"]);
  assert.deepEqual(calls.advance, []);
  assert.equal(rc.nodes["st-http"].status, "failed");
  assert.match(stage._out.stderr || "", /Jenkins 队列任务已取消/);
});

test("jenkins：服务端 30 连败兜底 {done:true, failed:'poll'} 按阶段失败收尾", async () => {
  const { context, calls } = makeContext({ stagePoll: () => jsonResp({ done: true, failed: "poll", failures: 30 }) });
  const stage = httpStage();
  const rc = freshRun(context, stage);
  await context.runUrlStep(rc, 0);
  assert.deepEqual(calls.finish, ["failed"]);
  assert.match(stage._out.stderr || "", /Jenkins queue 状态轮询持续失败（服务端连续 30 次/);
  assert.equal(calls.stagePoll.length, 1, "服务端已兜底判败，客户端不再续发");
});

test("jenkins：404（旧服务端无 stage-poll）回退浏览器直连轮询，一次阶段内只回退一次", async () => {
  const { context, calls } = makeContext({
    stagePoll: () => ({ ok: false, status: 404, json: async () => ({ error: "not found" }) }),
  });
  let queuePolls = 0;
  context.jkFetchJson = async (_j, url) => {
    if (url.includes("/queue/item/7/api/json")) { queuePolls += 1; return queuePolls < 2 ? {} : { executable: { number: 7 } }; }
    return { number: 7, building: false, result: "SUCCESS", duration: 1 };
  };
  const rc = freshRun(context, httpStage());
  await context.runUrlStep(rc, 0);
  assert.deepEqual(calls.advance, [1], "回退直连后照常构建成功推进");
  assert.equal(calls.stagePoll.length, 1, "回退后本阶段不再尝试 stage-poll（queue/build 阶段共用一次回退）");
  assert.equal(queuePolls, 2, "queue 阶段已切浏览器直连轮询");
  assert.equal(calls.warn.filter(w => /回退浏览器直连/.test(w)).length, 1, "回退应 console.warn 留痕一次");
  assert.match(rc.stages[0]._out.stdout || "", /回退浏览器直连轮询/);
});

test("jenkins：403（目标非内网）同样回退浏览器直连轮询", async () => {
  const { context, calls } = makeContext({
    stagePoll: () => ({ ok: false, status: 403, json: async () => ({ error: "forbidden" }) }),
  });
  context.jkFetchJson = async (_j, url) => {
    if (url.includes("/queue/item/7/api/json")) return { executable: { number: 7 } };
    return { number: 7, building: false, result: "SUCCESS", duration: 1 };
  };
  const rc = freshRun(context, httpStage());
  await context.runUrlStep(rc, 0);
  assert.deepEqual(calls.advance, [1]);
  assert.equal(calls.stagePoll.length, 1);
  assert.equal(calls.warn.filter(w => /回退浏览器直连/.test(w)).length, 1);
});

test("jenkins：stage-poll 传输故障（浏览器↔dsh）沿用连败计数，30 次兜底判败", async () => {
  const { context, calls } = makeContext({
    stagePoll: () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }),
  });
  const stage = httpStage();
  const rc = freshRun(context, stage);
  await context.runUrlStep(rc, 0);
  assert.deepEqual(calls.finish, ["failed"]);
  assert.equal(calls.stagePoll.length, 30, "传输故障连续 30 次后止损");
  assert.match(stage._out.stderr || "", /Jenkins queue 状态轮询持续失败（stage-poll 传输，连续 30 次）：stage-poll HTTP 500/);
  assert.match(stage._out.stdout || "", /stage-poll 传输/);
});

test("jenkins：服务端长轮询在途时中止——fetch 被 AbortController 中断，finally 仍按 queue Location 取消外部构建", async () => {
  const { context, calls } = makeContext({
    stagePoll: () => new Promise((resolve, reject) => {
      const sig = context.__signal;
      if (!sig) return;
      const onAbort = () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); };
      if (sig.aborted) onAbort(); else sig.addEventListener("abort", onAbort, { once: true });
    }),
  });
  /* 把每次 fetch 的 signal 暴露给 stagePoll 桩（makeContext 的 fetch 已透传 init.signal 语义，这里简化为记录最近一次） */
  const innerFetch = context.fetch;
  context.fetch = (url, init) => { context.__signal = init && init.signal; return innerFetch(url, init); };
  const rc = freshRun(context, httpStage());
  const p = context.runUrlStep(rc, 0);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(calls.stagePoll.length, 1, "中止前已进入服务端长轮询");
  /* 模拟 abortRun 的可观察次序：先 ctrl.abort() 中断在途 fetch，finish 同步置 rc.over */
  rc.scriptAbort.abort();
  rc.over = true;
  await p;
  assert.deepEqual(calls.advance, [], "中止后不得推进");
  assert.deepEqual(calls.finish, [], "中止收尾由 abortRun/finish 负责，阶段自身不再 finish");
  assert.equal(calls.cancel.length, 1, "finally 仍取消 Jenkins 外部任务");
  assert.deepEqual(calls.cancel[0], ["/job/demo/", null, "/queue/item/7/"], "未拿到构建号时按 queue Location 取消");
  assert.equal(rc.scriptAbort, null, "阶段结束释放中止句柄");
});

/* ---------- EvalTokens：服务端轮询主路径与回退 ---------- */
const evalStage = () => ({ id: "st-ev", name: "评测阶段", timeout: null, evaltokens: { taskId: "t-1", taskName: "", outVars: "", collectReport: false } });

function makeEvalContext(overrides) {
  return makeContext(Object.assign({
    fetch: (u, init) => {
      if (u.endsWith("/api/open/v1/tasks")) return jsonResp([{ task_id: "t-1", name: "评测一" }]);
      if (u.endsWith("/api/open/v1/tasks/t-1/run")) return jsonResp({ run_id: "r-9", status: "running" });
      throw new Error("unexpected evaltokens fetch " + u);
    },
  }, overrides || {}));
}

test("evaltokens：窗口耗尽 {done:false} 续发到终态 {done:true, status, run}，run 对象捕获为输出变量", async () => {
  const answers = [{ done: false }, { done: false, failures: 1 }, { done: true, status: "success", run: { run_id: "r-9", status: "success", score: 0.9 } }];
  const { context, calls } = makeEvalContext({ stagePoll: () => jsonResp(answers.shift()) });
  const stage = evalStage();
  const rc = freshRun(context, stage);
  await context.runEvaltokensStep(rc, 0);

  assert.deepEqual(calls.advance, [1]);
  assert.deepEqual(calls.finish, []);
  assert.equal(rc.nodes["st-ev"].status, "success");
  assert.equal(calls.stagePoll.length, 3);
  assert.equal(calls.stagePoll[0].body.url, "http://ev.local/api/open/v1/tasks/runs?task_id=t-1");
  assert.equal(calls.stagePoll[0].body.runId, "r-9", "轮询以启动响应的 run_id 为唯一依据");
  const stdout = stage._out.stdout || "";
  assert.ok(stdout.includes("status=success"), "状态行含服务端终态 kind");
  assert.ok(stdout.includes("[EvalTokens result success]"));
  assert.equal(rc.vars.score, "0.9", "终态 run 对象顶层标量应捕获为输出变量");
  assert.equal(rc.vars.run_id, "r-9");
});

test("evaltokens：服务端 30 连败 {done:true, failed:'poll'} 按阶段失败收尾", async () => {
  const { context, calls } = makeEvalContext({ stagePoll: () => jsonResp({ done: true, failed: "poll", failures: 30 }) });
  const stage = evalStage();
  const rc = freshRun(context, stage);
  await context.runEvaltokensStep(rc, 0);
  assert.deepEqual(calls.finish, ["failed"]);
  assert.deepEqual(calls.advance, []);
  assert.match(stage._out.stderr || "", /EvalTokens 状态轮询持续失败（服务端连续 30 次/);
});

test("evaltokens：404 回退 evaltokFetchRuns 直连轮询（一次阶段内只回退一次）", async () => {
  let directPolls = 0;
  const { context, calls } = makeEvalContext({
    stagePoll: () => ({ ok: false, status: 404, json: async () => ({ error: "not found" }) }),
    fetch: (u, init) => {
      if (u.endsWith("/api/open/v1/tasks")) return jsonResp([{ task_id: "t-1", name: "评测一" }]);
      if (u.endsWith("/api/open/v1/tasks/t-1/run")) return jsonResp({ run_id: "r-9", status: "running" });
      if (u.includes("/api/open/v1/tasks/runs?task_id=t-1")) { directPolls += 1; return jsonResp({ runs: [{ run_id: "r-9", status: directPolls < 2 ? "running" : "success" }] }); }
      throw new Error("unexpected evaltokens fetch " + u);
    },
  });
  const stage = evalStage();
  const rc = freshRun(context, stage);
  await context.runEvaltokensStep(rc, 0);
  assert.deepEqual(calls.advance, [1], "回退直连轮询后照常成功推进");
  assert.equal(calls.stagePoll.length, 1, "回退后不再尝试 stage-poll");
  assert.ok(directPolls >= 2, "直连轮询接管到终态");
  assert.equal(calls.warn.filter(w => /回退浏览器直连/.test(w)).length, 1);
  assert.match(stage._out.stdout || "", /回退浏览器直连轮询/);
});
