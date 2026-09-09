const fs = require("fs");
const vm = require("vm");

const pipelineHtml = process.env.PIPELINE_HTML || __dirname + "/../pipeline.html";
const source = fs.readFileSync(pipelineHtml, "utf8");

// 切片 0：HTTP 阶段统一取 URL（兼容存量 jenkins.job）
const s0 = source.indexOf("function stageUrlOf(s)");
const e0 = source.indexOf("\n", s0) + 1;
if (s0 < 0 || e0 < 0) throw new Error("stageUrlOf not found");

// 切片 1：parseStageVars + mergeStageVars + substRunVars（KEY=VALUE / 单行 JSON 提取与 ${VAR} 引用替换）
const s1 = source.indexOf("function forEachOutputLine(output, visit)");
const e1 = source.indexOf("async function execScript", s1);
if (s1 < 0 || e1 < 0) throw new Error("output parsers not found");

// 切片 2：execScript（脚本阶段参数值 ${VAR} 替换的端到端验证，fetch 打桩）
const s2 = source.indexOf("async function execScript(");
const e2 = source.indexOf("function jkJobPath(job)", s2);
if (s2 < 0 || e2 < 0) throw new Error("execScript not found");

// 切片 3：HTTP 阶段执行链（jkJobPath/jkTriggerBuild/jkTriggerGet/jkGetText/runUrlStep）
const s3 = source.indexOf("function jkJobPath(job)");
const e3 = source.indexOf("async function runScriptStep", s3);
if (s3 < 0 || e3 < 0) throw new Error("runUrlStep not found");

// 切片 4：各类长任务共用的有界实时输出状态
const s4 = source.indexOf("function createLiveOutputState(");
const e4 = source.indexOf("/* 流式执行：POST", s4);
if (s4 < 0 || e4 < 0) throw new Error("live output helpers not found");

const triggerCalls = [];
const execRequests = [];
const overallCalls = [];
let advancedTo = null;
let finishedWith = null;

/* 多运行上下文：引擎函数（runUrlStep 等）签名已改为接收 rc，读写 rc.stages/rc.nodes/rc.vars/rc.timer，
   不再触碰 curRun/runStages/nodes/selectedId/timer 全局单例；此处按真实运行上下文形状构造。 */
const stages = [
  { id: "st-jk", name: "Jenkins 兼容阶段", kind: "http", url: {
    url: "job-a",
    outVars: "RENAMED=NEW_KEY, DECLARED_ONLY",           // 改名映射 + 无来源声明（后者应跳过）
  } },
  { id: "st-jk-url", name: "HTTP URL 阶段", kind: "http", url: {
    url: "http://jk.local/hooks/{GIT_BRANCH}",           // 非 Jenkins 标准路径：直接 GET，{VAR} 运行时替换
    outVars: "HOOK_VALUE=value",
  } },
];
const rc = {
  id: "rc-test",
  stages: stages,
  nodes: {},
  selId: "",
  timer: null,
  over: false,
  overall: null,
  token: 1,
  vars: { UP_VER: "1.2.3", SHARED: "from-upstream" },
  env: "",
  envs: [{ ip: "192.0.2.10", user: "root", pass: "secret" }],
  image: "registry.example.com/xds",
  release: null,
  commit: null,
  tag: "test",
  startTs: Date.now(),
  by: "tester",
  source: "test",
  pipelineId: "pl-test",
  pipelineName: "contract-test",
  repoId: null,
  repoName: null,
  repoUrl: "",
  giturl: "",
  repoUser: "",
  repoPass: "",
  branch: "feat/demo",
  strategy: "",
  prom: null,
  archive: "",
};

const context = {
  rc: rc,
  JSON, URL, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval, Date, console,
  scriptsDir: "/tmp/scripts",
  jenkins: { url: "http://jk.local", user: "", token: "", mode: "local" },
  // 视图层全局（与引擎同文件但在被测切片之外）：按真实语义给轻量桩
  curRun: rc,                 // execScript 缺省 runCtx 时回退 curRun
  viewRc: rc,                 // 编排区当前聚焦本运行
  selectedId: "",             // 视图层选中别名（rcRender/runSetSel 聚焦时同步）
  activeRuns: [rc],
  running: true,
  viewActive: () => !!(context.viewRc && !context.viewRc.over),
  syncRunState: () => { context.running = context.activeRuns.length > 0; },
  syncViewRun: () => { const v = context.viewRc; context.curRun = v; context.selectedId = v ? v.selId : ""; },
  runSetSel: (rc_, id) => { rc_.selId = id; if (context.viewRc === rc_) context.selectedId = id; },
  rcRender: (rc_, withFlow) => { if (context.viewRc !== rc_) return; context.applyStatusClasses(); if (withFlow) context.renderFlow(); context.renderDetail(); },
  rcOverall: (rc_, txt, cls, color) => { rc_.overall = { txt: txt, cls: cls, color: color || "" }; overallCalls.push({ rc: rc_, txt: txt, cls: cls }); },
  // 页面侧依赖全部打桩：本测试只关心变量传递链路
  applyStatusClasses: () => {},
  renderFlow: () => {},
  renderDetail: () => {},
  archiveStageLog: () => {},
  stageSeq: (stg, i) => i + 1,
  advance: (rc_, i) => { advancedTo = i; },
  finish: (rc_, s) => { finishedWith = s; },
  jkFetchJson: async (_j, url) => {
    if (url.includes("nextBuildNumber")) return { nextBuildNumber: 7 };
    return { number: 7, building: false, result: "SUCCESS", duration: 1 };
  },
  fetch: async (_url, init) => {
    execRequests.push(JSON.parse(init.body));
    return { json: async () => ({ code: 0, stdout: "", stderr: "" }) };
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
const realJkGetProgressiveText = context.jkGetProgressiveText;
const realJkReadConsoleDelta = context.jkReadConsoleDelta;
// HTTP/Jenkins 请求在切片内有真实实现，eval 后替换为桩，只隔离外部 Jenkins 服务
context.jkTriggerBuild = async (job, params) => { triggerCalls.push({ job, params }); return true; };
context.jkGetText = async () => 'build log line\n{"NEW_KEY":"new-value","COUNT":2}\ntrailer';
context.jkGetProgressiveText = async (_path, start) => {
  const full = 'build log line\n{"NEW_KEY":"new-value","COUNT":2}\ntrailer';
  return { text: full.slice(start), next: full.length };
};
context.jkTriggerGet = async (url) => { triggerCalls.push({ url }); return '{"value":"hook-value"}'; };

(async () => {
  // progressiveText 未暴露 X-Text-Size（常见于 CORS 未 expose 自定义响应头）时，按 UTF-8 字节数推进；路径自动补斜杠
  const savedFetch = context.fetch;
  let progressiveUrl = "";
  context.fetch = async (url) => {
    progressiveUrl = url;
    return { status: 200, headers: { get: () => null }, text: async () => "尾声" };
  };
  const noHeaderDelta = await realJkGetProgressiveText("/job/a/7", 11);
  context.fetch = savedFetch;
  if (progressiveUrl !== "http://jk.local/job/a/7/logText/progressiveText?start=11") throw new Error("progressiveText 路径拼接错误：" + progressiveUrl);
  if (noHeaderDelta.next !== 11 + Buffer.byteLength("尾声")) throw new Error("缺少 X-Text-Size 时应按 UTF-8 字节推进，得到 " + noHeaderDelta.next);
  const savedProgressive = context.jkGetProgressiveText;
  const savedGetText = context.jkGetText;
  let fallbackPath = "";
  context.jkGetProgressiveText = async () => null;
  context.jkGetText = async path => { fallbackPath = path; return "0123456789"; };
  const fallbackDelta = await realJkReadConsoleDelta("/job/a/7", 4, true);
  context.jkGetProgressiveText = savedProgressive;
  context.jkGetText = savedGetText;
  if (fallbackPath !== "/job/a/7/consoleText" || fallbackDelta.text !== "456789" || fallbackDelta.next !== 10 || fallbackDelta.progressive !== false) {
    throw new Error("progressiveText 不支持时未正确降级 consoleText：" + JSON.stringify({ fallbackPath, fallbackDelta }));
  }

  // ① parseStageVars：KEY=VALUE 行 / 单行 JSON 对象 / 混排与同 key 覆盖
  const v = context.parseStageVars([
    "FOO=bar",
    'BAZ="quoted"',
    "not-a-var line",
    '{"IMAGE_URL":"reg/x:test","REPLICAS":3,"DEBUG":true,"nested":{"a":1},"skipNull":null}',
    "{broken json}",
    "FOO=bar2",
  ].join("\n"));
  if (v.FOO !== "bar2") throw new Error("KEY=VALUE 同 key 后写应覆盖，得到 " + JSON.stringify(v.FOO));
  if (v.BAZ !== "quoted") throw new Error("引号包裹值应去引号，得到 " + JSON.stringify(v.BAZ));
  if (v.IMAGE_URL !== "reg/x:test") throw new Error("单行 JSON 字符串字段应被提取，得到 " + JSON.stringify(v.IMAGE_URL));
  if (v.REPLICAS !== "3") throw new Error("JSON 数字字段应字符串化，得到 " + JSON.stringify(v.REPLICAS));
  if (v.DEBUG !== "true") throw new Error("JSON 布尔字段应字符串化，得到 " + JSON.stringify(v.DEBUG));
  if ("nested" in v || "skipNull" in v) throw new Error("JSON 嵌套对象 / null 字段不应提取");
  console.log("PASS: parseStageVars 同时识别 KEY=VALUE 行与单行 JSON 对象");

  // ② substRunVars + execScript：脚本参数值 ${VAR} 引用替换
  if (context.substRunVars("pre-${UP_VER}", rc) !== "pre-1.2.3") throw new Error("嵌段引用应替换");
  if (context.substRunVars("${UP_VER}", rc) !== "1.2.3") throw new Error("整值引用应替换");
  if (context.substRunVars("${NOPE}", rc) !== "") throw new Error("整值单个未定义引用应按空值处理");
  if (context.substRunVars("x${NOPE}y", rc) !== "x${NOPE}y") throw new Error("嵌段未定义引用应原样保留");
  if (context.substRunVars("${TARGET_IP}", rc) !== "192.0.2.10") throw new Error("运行级变量应可引用");
  await context.execScript({
    path: "/tmp/t.sh",
    params: [{ kind: "pos", key: "1", def: "" }, { kind: "env", key: "CFG", def: "" }, { kind: "env", key: "NOPE_ENV", def: "" }],
    values: { "1": "${UP_VER}", CFG: "cfg-${UP_VER}", NOPE_ENV: "${NOPE}" },
  });
  const req = execRequests[0];
  if (req.args[0] !== "1.2.3") throw new Error("位置参数应替换 ${VAR}，得到 " + JSON.stringify(req.args));
  if (req.env.CFG !== "cfg-1.2.3") throw new Error("env 参数应替换 ${VAR}，得到 " + JSON.stringify(req.env.CFG));
  if ("NOPE_ENV" in req.env) throw new Error("整值未定义引用的 env 参数应按空值处理（不下发/继承）");
  console.log("PASS: 脚本阶段参数值支持 ${VAR} 引用（位置参数与 env 参数）");

  // ③ runUrlStep 兼容旧 Jenkins fullName：上游变量注入构建参数 + 控制台 JSON 回传 + 输出变量改名
  await context.runUrlStep(rc, 0);
  if (!triggerCalls.length) throw new Error("构建未被触发");
  const params = triggerCalls[0].params;
  if (params.UP_VER !== "1.2.3") throw new Error("上游变量应注入为构建参数，得到 " + JSON.stringify(params.UP_VER));
  if (params.SHARED !== "from-upstream") throw new Error("同名上游变量应原样传入 HTTP/Jenkins 兼容阶段，得到 " + JSON.stringify(params.SHARED));
  if (params.TARGET_IP !== "192.0.2.10") throw new Error("运行级默认注入不应受影响，得到 " + JSON.stringify(params.TARGET_IP));
  if (rc.vars.NEW_KEY !== "new-value") throw new Error("控制台单行 JSON 应累计回 rc.vars");
  if (rc.vars.COUNT !== "2") throw new Error("控制台 JSON 数字字段应字符串化累计");
  if (rc.vars.RENAMED !== "new-value") throw new Error("输出变量映射应把 NEW_KEY 改名为 RENAMED");
  if ("DECLARED_ONLY" in rc.vars) throw new Error("无来源的输出变量声明不应产生变量");
  if (rc.nodes["st-jk"].varsOut.RENAMED !== "new-value") throw new Error("改名后的变量应体现在 varsOut 展示中");
  if (rc.timer !== null) throw new Error("阶段结束后本运行的 rc.timer 应已清理");
  if (advancedTo !== 1) throw new Error("成功后应推进到下一阶段，得到 " + JSON.stringify(advancedTo));
  if (finishedWith !== null) throw new Error("成功路径不应 finish，得到 " + JSON.stringify(finishedWith));
  console.log("PASS: HTTP 阶段兼容 Jenkins fullName 双向传递变量（上游注入 / 控制台回传 / 输出变量改名）");

  // ④ 任务 URL + {VAR} 占位符：jkIsUrl / jkSubstUrl / jkJobRef 单测 + runUrlStep 端到端
  if (context.jkIsUrl("a/b")) throw new Error("fullName 不应判定为 URL");
  if (!context.jkIsUrl(" https://jk.local/job/app/ ")) throw new Error("http(s) 地址应判定为 URL");
  if (context.jkSubstUrl("/job/{GIT_BRANCH}/", { GIT_BRANCH: "feat/x" }) !== "/job/feat%2Fx/") throw new Error("已定义变量应替换并 URL 编码");
  if (context.jkSubstUrl("/job/{NOPE}/", { GIT_BRANCH: "feat/x" }) !== "/job/{NOPE}/") throw new Error("未定义变量应原样保留");
  if (context.jkSubstUrl("/job/{EMPTY}/", { EMPTY: "" }) !== "/job/{EMPTY}/") throw new Error("空值变量应原样保留");
  if (context.jkJobRef("a/b", {}) !== "/job/a/job/b/") throw new Error("fullName 仍按 /job/ 段拼接，得到 " + context.jkJobRef("a/b", {}));
  if (context.jkJobRef("http://jk.local:8080/job/app/job/{GIT_BRANCH}/", { GIT_BRANCH: "feat/x" }) !== "/job/app/job/feat%2Fx/") throw new Error("URL 应替换占位符后取路径，得到 " + context.jkJobRef("http://jk.local:8080/job/app/job/{GIT_BRANCH}/", { GIT_BRANCH: "feat/x" }));
  await context.runUrlStep(rc, 1);
  if (triggerCalls.length !== 2) throw new Error("URL 阶段请求未被触发");
  if (triggerCalls[1].url !== "http://jk.local/hooks/feat%2Fdemo") throw new Error("触发 URL 应由 {GIT_BRANCH} 替换得到，得到 " + JSON.stringify(triggerCalls[1].url));
  if (rc.vars.HOOK_VALUE !== "hook-value") throw new Error("HTTP JSON 响应应按输出变量映射回传，得到 " + JSON.stringify(rc.vars.HOOK_VALUE));
  if (advancedTo !== 2) throw new Error("URL 阶段成功后应推进到下一阶段，得到 " + JSON.stringify(advancedTo));
  console.log("PASS: HTTP URL 支持 {GIT_BRANCH} 等占位符（运行时替换并 URL 编码）");

  // ⑤ Jenkins 大量控制台输出：按服务端 offset 增量读取；运行中回显有界，但中止归档可见完整分片
  const heavy = { id: "st-heavy", name: "Jenkins 大日志", kind: "http", url: { url: "job-heavy", outVars: "" } };
  stages.push(heavy);
  const consoleChunks = [
    "EARLY-LINE\n" + "a".repeat(410 * 1024) + "\n",
    "MIDDLE-LINE\n" + "b".repeat(410 * 1024) + "\n",
    "LATE-LINE\n" + "c".repeat(410 * 1024) + "\n",
  ];
  const heavyConsole = consoleChunks.join("");
  const requestedStarts = [];
  let buildPolls = 0;
  let maxLiveChars = 0;
  let liveArchiveText = "";
  context.setTimeout = (fn) => { fn(); return 1; };
  context.jkFetchJson = async (_j, url) => {
    if (url.includes("nextBuildNumber")) return { nextBuildNumber: 7 };
    buildPolls += 1;
    return { number: 7, building: buildPolls < 3, result: buildPolls < 3 ? null : "SUCCESS", duration: 1 };
  };
  context.jkGetText = async () => { throw new Error("支持 progressiveText 时不得重复下载 consoleText 全文"); };
  context.jkGetProgressiveText = async (_path, start) => {
    requestedStarts.push(start);
    const text = consoleChunks[requestedStarts.length - 1] || "";
    return { text, next: start + text.length };
  };
  context.renderDetail = () => {
    if (heavy._out && heavy._out.code === null) {
      maxLiveChars = Math.max(maxLiveChars, heavy._out.stdout.length);
      if (Array.isArray(heavy._archiveOutputParts)) liveArchiveText = heavy._archiveOutputParts.join("");
    }
  };
  await context.runUrlStep(rc, 2);
  const firstEnd = consoleChunks[0].length;
  const secondEnd = firstEnd + consoleChunks[1].length;
  if (JSON.stringify(requestedStarts) !== JSON.stringify([0, firstEnd, secondEnd, heavyConsole.length])) {
    throw new Error("Jenkins progressiveText offset 不连续，得到 " + JSON.stringify(requestedStarts));
  }
  if (maxLiveChars > 256 * 1024) throw new Error("Jenkins 实时快照不得累积全量控制台日志，峰值=" + maxLiveChars);
  if (!liveArchiveText.includes("EARLY-LINE") || !liveArchiveText.includes("LATE-LINE")) {
    throw new Error("运行中止归档必须能取得实时回显之外的完整早期/末尾日志");
  }
  if (!heavy._out.stdout.includes(heavyConsole)) throw new Error("Jenkins 阶段结束后必须保留完整日志");
  console.log("PASS: Jenkins 大日志按 offset 增量读取，实时快照有界且中止/终态全文保留");
})().catch((e) => { console.error(e); process.exit(1); });
