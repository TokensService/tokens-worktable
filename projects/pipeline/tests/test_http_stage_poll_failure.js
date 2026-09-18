/* HTTP 阶段（URL 含 /job/ 的 Jenkins 任务路径）浏览器本地执行：构建状态轮询失败的兜底回归测试。
   旧行为：轮询 catch 吞掉一切错误且无限重试——「Jenkins 服务配置」地址不对 / 桥接未启动 / CORS 拦截 /
   401·403 等持续性故障会让阶段永远卡在「运行中」，日志看不到任何原因（阶段超时默认留空无兜底）。
   新行为：按触发响应的 queue Location 精确轮询本次任务；连续失败计数、首次与每 15 次回显原因、
   连续 30 次按阶段失败收尾，不再用 nextBuildNumber/lastBuild 猜测并发构建。
   沙盒切片与打桩方式同 test_jenkins_stage_vars.js。 */
const fs = require("fs");
const vm = require("vm");

const pipelineHtml = process.env.PIPELINE_HTML || __dirname + "/../pipeline.html";
const source = fs.readFileSync(pipelineHtml, "utf8");

const s0 = source.indexOf("function stageUrlOf(s)");
const e0 = source.indexOf("\n", s0) + 1;
const s1 = source.indexOf("function forEachOutputLine(output, visit)");
const e1 = source.indexOf("async function execScript", s1);
const s2 = source.indexOf("async function execScript(");
const e2 = source.indexOf("function jkJobPath(job)", s2);
const s3 = source.indexOf("function jkJobPath(job)");
const e3 = source.indexOf("async function runScriptStep", s3);
const s4 = source.indexOf("function createLiveOutputState(");
const e4 = source.indexOf("/* 流式执行：POST", s4);
if ([s0, e0, s1, e1, s2, e2, s3, e3, s4, e4].some(x => x < 0)) throw new Error("slice not found");

let advancedTo = null;
let finishedWith = null;

function makeRc(stage) {
  return {
    id: "rc-poll", stages: [stage], nodes: {}, selId: "", timer: null, over: false, overall: null,
    token: 1, vars: {}, env: "", envs: [{ ip: "192.0.2.10", user: "root", pass: "" }],
    image: "", release: null, commit: null, tag: "poll", startTs: Date.now(), by: "tester",
    source: "test", pipelineId: "pl-poll", pipelineName: "poll-test", repoId: null, repoName: null,
    repoUrl: "", giturl: "", repoUser: "", repoPass: "", branch: "main", strategy: "", prom: null, archive: "",
  };
}

const context = {
  JSON, URL, TextEncoder, AbortController, Date, console,
  setTimeout: (fn) => { fn(); return 1; },   // 轮询等待立即到期（与 test_jenkins_stage_vars.js 大日志用例同法）
  clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
  scriptsDir: "/tmp/scripts",
  jenkins: { url: "http://jk.local", user: "", token: "", mode: "local" },
  curRun: null, viewRc: null, selectedId: "", activeRuns: [], running: true,
  viewActive: () => true,
  syncRunState: () => {}, syncViewRun: () => {},
  runSetSel: (rc_, id) => { rc_.selId = id; },
  rcRender: () => {}, rcOverall: () => {},
  applyStatusClasses: () => {}, renderFlow: () => {}, renderDetail: () => {},
  archiveStageLog: () => {},
  createClientStageLogSink: () => null,
  readBrowserResponseText: async response => response.text(),
  stageSeq: (stg, i) => i + 1,
  advance: (rc_, i) => { advancedTo = i; },
  finish: (rc_, s) => { finishedWith = s; },
  fetch: async () => ({ ok: true, status: 200, headers: { get: name => name.toLowerCase() === "location" ? "/queue/item/7/" : null }, text: async () => "triggered" }),
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
/* 控制台增量读取在切片内有真实实现，eval 后替换为桩，只隔离外部 Jenkins 控制台；
   轮询行为由每个用例自己的 jkFetchJson 桩控制。 */
context.jkGetProgressiveText = async (_path, start) => ({ text: "", next: start });
context.jkGetText = async () => "";

function freshRun() {
  const stage = { id: "st-http", name: "HTTP 阶段", kind: "http", url: { url: "http://jk.local/job/demo/build?token=t", outVars: "" } };
  const rc = makeRc(stage);
  advancedTo = null; finishedWith = null;
  context.curRun = rc; context.viewRc = rc; context.activeRuns = [rc];
  return { stage, rc };
}

(async () => {
  // ① 持续性故障（CORS 拦截 / 桥接未启动 / 配置地址不对）：不得永远卡住——连续 30 次失败按阶段失败收尾并回显原因
  {
    const { stage, rc } = freshRun();
    let calls = 0;
    context.jkFetchJson = async () => { calls += 1; throw new TypeError("Failed to fetch"); };
    await context.runUrlStep(rc, 0);
    if (finishedWith !== "failed") throw new Error("持续轮询故障应按失败收尾，得到 " + JSON.stringify({ advancedTo, finishedWith }));
    if (calls !== 30) throw new Error("30 次精确 queue 轮询后应止损，得到 " + calls + " 次请求（旧代码此处永不返回）");
    const node = rc.nodes["st-http"] || {};
    if (node.status !== "failed") throw new Error("阶段节点应置为 failed，得到 " + JSON.stringify(node.status));
    if (rc.timer !== null) throw new Error("失败收尾后 rc.timer 应已清理");
    const stderr = (stage._out && stage._out.stderr) || "";
    if (!/Jenkins queue 状态轮询持续失败（连续 30 次）：Failed to fetch/.test(stderr)) throw new Error("失败原因应写入阶段 stderr，得到 " + JSON.stringify(stderr));
    const stdout = (stage._out && stage._out.stdout) || "";
    if (!/queue 状态轮询连续失败 1 次/.test(stdout)) throw new Error("首次轮询失败即应回显原因");
    if (!/queue 状态轮询连续失败 15 次/.test(stdout) || !/queue 状态轮询连续失败 30 次/.test(stdout)) throw new Error("每 15 次失败应再回显一次");
    if (!/Jenkins 服务配置/.test(stdout) || !/CORS/.test(stdout)) throw new Error("告警应给出排查指引（服务配置 / CORS）");
    console.log("PASS: 构建状态轮询持续失败有界收尾并回显原因（不再无限卡住）");
  }

  // ② queue item 尚未分配 executable 时继续等待，不能改查共享 lastBuild
  {
    const { stage, rc } = freshRun();
    let polls = 0;
    context.jkFetchJson = async (_j, url) => {
      if (url.includes("/queue/item/7/api/json")) {
        polls += 1;
        return polls <= 3 ? {} : { executable: { number: 7 } };
      }
      return { number: 7, building: false, result: "SUCCESS", duration: 1 };
    };
    await context.runUrlStep(rc, 0);
    if (finishedWith !== null) throw new Error("排队等待后成功不应 finish，得到 " + JSON.stringify(finishedWith));
    if (advancedTo !== 1) throw new Error("构建成功后应推进到下一阶段，得到 " + JSON.stringify(advancedTo));
    if ((rc.nodes["st-http"] || {}).status !== "success") throw new Error("阶段节点应置为 success");
    const stdout = (stage._out && stage._out.stdout) || "";
    if (/轮询连续失败/.test(stdout)) throw new Error("首次构建排队中的 404 属合法等待，不应计为轮询失败");
    console.log("PASS: 精确 queue item 未分配 executable 时继续等待（不查询共享 lastBuild）");
  }

  // ③ 瞬时故障（网络抖动）恢复后照常成功；失败计数在成功后清零
  {
    const { stage, rc } = freshRun();
    let polls = 0;
    context.jkFetchJson = async (_j, url) => {
      if (url.includes("/queue/item/7/api/json")) {
        polls += 1;
        if (polls <= 2) throw new TypeError("Failed to fetch");
        return { executable: { number: 7 } };
      }
      return { number: 7, building: false, result: "SUCCESS", duration: 1 };
    };
    await context.runUrlStep(rc, 0);
    if (advancedTo !== 1 || finishedWith !== null) throw new Error("瞬时故障恢复后应成功推进，得到 " + JSON.stringify({ advancedTo, finishedWith }));
    const stdout = (stage._out && stage._out.stdout) || "";
    if (!/轮询连续失败 1 次/.test(stdout)) throw new Error("首次失败应即时回显原因");
    if (/轮询持续失败/.test((stage._out && stage._out.stderr) || "")) throw new Error("未达上限的瞬时故障不应判失败");
    console.log("PASS: 瞬时轮询故障恢复后照常成功（计数成功后清零）");
  }

  console.log("全部通过：HTTP 阶段构建状态轮询失败兜底");
  process.exit(0);
})().catch(e => { console.error("FAIL:", e && e.message ? e.message : e); process.exit(1); });
