const fs = require("fs");
const vm = require("vm");

const pipelineHtml = process.env.PIPELINE_HTML;
if (!pipelineHtml) throw new Error("PIPELINE_HTML is required");
const source = fs.readFileSync(pipelineHtml, "utf8");

// 切片 1：parseStageVars + mergeStageVars + substRunVars（KEY=VALUE / 单行 JSON 提取与 ${VAR} 引用替换）
const s1 = source.indexOf("function parseStageVars(stdout)");
const e1 = source.indexOf("async function execScript", s1);
if (s1 < 0 || e1 < 0) throw new Error("parseStageVars not found");

// 切片 2：execScript（脚本阶段参数值 ${VAR} 替换的端到端验证，fetch 打桩）
const s2 = source.indexOf("async function execScript(");
const e2 = source.indexOf("function jkJobPath(job)", s2);
if (s2 < 0 || e2 < 0) throw new Error("execScript not found");

// 切片 3：Jenkins 阶段执行链（jkJobPath/jkTriggerBuild/jkGetText/runJenkinsStep）
const s3 = source.indexOf("function jkJobPath(job)");
const e3 = source.indexOf("async function runScriptStep", s3);
if (s3 < 0 || e3 < 0) throw new Error("runJenkinsStep not found");

const triggerCalls = [];
const execRequests = [];
let advancedTo = null;
let finishedWith = null;
const context = {
  __curRun: {
    vars: { UP_VER: "1.2.3", SHARED: "from-upstream" },
    envs: [{ ip: "192.0.2.10", user: "root", pass: "secret" }],
    image: "registry.example.com/xds",
    tag: "test",
    pipelineName: "contract-test",
    branch: "feat/demo",
    token: 1,
  },
  __stages: [
    { id: "st-jk", name: "Jenkins 阶段", jenkins: {
      job: "job-a",
      params: [
        { name: "SHARED", defaultParameterValue: { value: "" } },
        { name: "PLAIN", defaultParameterValue: { value: "" } },
        { name: "REF", defaultParameterValue: { value: "" } },
      ],
      values: { SHARED: "explicit", REF: "${UP_VER}" },   // 显式参数压过同名上游变量；${VAR} 引用上游产出
      outVars: "RENAMED=NEW_KEY, DECLARED_ONLY",           // 改名映射 + 无来源声明（后者应跳过）
    } },
    { id: "st-jk-url", name: "Jenkins URL 阶段", jenkins: {
      job: "http://jk.local/job/app/job/{GIT_BRANCH}/",   // 任务 URL：{VAR} 占位符运行时用环境变量替换
      params: [],
      values: {},
    } },
  ],
  JSON, URL, setTimeout, clearTimeout, setInterval, clearInterval, Date, console,
  // 页面侧依赖全部打桩：本测试只关心变量传递链路
  activeStages: () => context.__stages,
  applyStatusClasses: () => {},
  renderFlow: () => {},
  renderDetail: () => {},
  archiveStageLog: () => {},
  advance: (i) => { advancedTo = i; },
  finish: (s) => { finishedWith = s; },
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
  `let curRun = globalThis.__curRun;
   var nodes = {}; let selectedId = ""; let running = true; let timer = null;
   let scriptsDir = "/tmp/scripts";
   let jenkins = { url: "http://jk.local", user: "", token: "", mode: "local" };
${source.slice(s1, e1)}
${source.slice(s2, e2)}
${source.slice(s3, e3)}`,
  context,
);
// jkTriggerBuild / jkGetText 在切片内有真实实现（走 fetch / proxy），eval 后替换为桩：前者捕获构建参数，后者返回含单行 JSON 的控制台日志
context.jkTriggerBuild = async (job, params) => { triggerCalls.push({ job, params }); return true; };
context.jkGetText = async () => 'build log line\n{"NEW_KEY":"new-value","COUNT":2}\ntrailer';

(async () => {
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
  if (context.substRunVars("pre-${UP_VER}", context.__curRun) !== "pre-1.2.3") throw new Error("嵌段引用应替换");
  if (context.substRunVars("${UP_VER}", context.__curRun) !== "1.2.3") throw new Error("整值引用应替换");
  if (context.substRunVars("${NOPE}", context.__curRun) !== "") throw new Error("整值单个未定义引用应按空值处理");
  if (context.substRunVars("x${NOPE}y", context.__curRun) !== "x${NOPE}y") throw new Error("嵌段未定义引用应原样保留");
  if (context.substRunVars("${TARGET_IP}", context.__curRun) !== "192.0.2.10") throw new Error("运行级变量应可引用");
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

  // ③ runJenkinsStep：上游变量注入构建参数 + ${VAR} 引用 + 控制台 JSON 回传 + 输出变量改名
  await context.runJenkinsStep(0);
  if (!triggerCalls.length) throw new Error("构建未被触发");
  const params = triggerCalls[0].params;
  if (params.UP_VER !== "1.2.3") throw new Error("上游变量应注入为构建参数，得到 " + JSON.stringify(params.UP_VER));
  if (params.SHARED !== "explicit") throw new Error("同名时阶段显式参数应优先于上游变量，得到 " + JSON.stringify(params.SHARED));
  if (params.REF !== "1.2.3") throw new Error("Jenkins 参数值 ${VAR} 引用应替换，得到 " + JSON.stringify(params.REF));
  if ("PLAIN" in params) throw new Error("空值显式参数不应下发");
  if (params.TARGET_IP !== "192.0.2.10") throw new Error("运行级默认注入不应受影响，得到 " + JSON.stringify(params.TARGET_IP));
  if (context.__curRun.vars.NEW_KEY !== "new-value") throw new Error("控制台单行 JSON 应累计回 curRun.vars");
  if (context.__curRun.vars.COUNT !== "2") throw new Error("控制台 JSON 数字字段应字符串化累计");
  if (context.__curRun.vars.RENAMED !== "new-value") throw new Error("输出变量映射应把 NEW_KEY 改名为 RENAMED");
  if ("DECLARED_ONLY" in context.__curRun.vars) throw new Error("无来源的输出变量声明不应产生变量");
  if (context.nodes["st-jk"].varsOut.RENAMED !== "new-value") throw new Error("改名后的变量应体现在 varsOut 展示中");
  if (advancedTo !== 1) throw new Error("成功后应推进到下一阶段，得到 " + JSON.stringify(advancedTo));
  if (finishedWith !== null) throw new Error("成功路径不应 finish，得到 " + JSON.stringify(finishedWith));
  console.log("PASS: Jenkins 阶段双向传递变量（上游注入构建参数 / ${VAR} 引用 / 控制台回传 / 输出变量改名）");

  // ④ 任务 URL + {VAR} 占位符：jkIsUrl / jkSubstUrl / jkJobRef 单测 + runJenkinsStep 端到端
  if (context.jkIsUrl("a/b")) throw new Error("fullName 不应判定为 URL");
  if (!context.jkIsUrl(" https://jk.local/job/app/ ")) throw new Error("http(s) 地址应判定为 URL");
  if (context.jkSubstUrl("/job/{GIT_BRANCH}/", { GIT_BRANCH: "feat/x" }) !== "/job/feat%2Fx/") throw new Error("已定义变量应替换并 URL 编码");
  if (context.jkSubstUrl("/job/{NOPE}/", { GIT_BRANCH: "feat/x" }) !== "/job/{NOPE}/") throw new Error("未定义变量应原样保留");
  if (context.jkSubstUrl("/job/{EMPTY}/", { EMPTY: "" }) !== "/job/{EMPTY}/") throw new Error("空值变量应原样保留");
  if (context.jkJobRef("a/b", {}) !== "/job/a/job/b/") throw new Error("fullName 仍按 /job/ 段拼接，得到 " + context.jkJobRef("a/b", {}));
  if (context.jkJobRef("http://jk.local:8080/job/app/job/{GIT_BRANCH}/", { GIT_BRANCH: "feat/x" }) !== "/job/app/job/feat%2Fx/") throw new Error("URL 应替换占位符后取路径，得到 " + context.jkJobRef("http://jk.local:8080/job/app/job/{GIT_BRANCH}/", { GIT_BRANCH: "feat/x" }));
  await context.runJenkinsStep(1);
  if (triggerCalls.length !== 2) throw new Error("URL 阶段构建未被触发");
  if (triggerCalls[1].job !== "/job/app/job/feat%2Fdemo/") throw new Error("触发路径应由 {GIT_BRANCH} 替换得到，得到 " + JSON.stringify(triggerCalls[1].job));
  if (triggerCalls[1].params.GIT_BRANCH !== "feat/demo") throw new Error("运行级 GIT_BRANCH 注入不应受影响，得到 " + JSON.stringify(triggerCalls[1].params.GIT_BRANCH));
  if (advancedTo !== 2) throw new Error("URL 阶段成功后应推进到下一阶段，得到 " + JSON.stringify(advancedTo));
  console.log("PASS: Jenkins 任务 URL 支持 {GIT_BRANCH} 等 {变量} 占位符（运行时替换并 URL 编码）");
})().catch((e) => { console.error(e); process.exit(1); });
