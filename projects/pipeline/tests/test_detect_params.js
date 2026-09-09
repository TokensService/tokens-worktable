const fs = require("fs");
const vm = require("vm");

const pipelineHtml = process.env.PIPELINE_HTML || __dirname + "/../pipeline.html";
const source = fs.readFileSync(pipelineHtml, "utf8");

// 切片 1：scanShellRefs/isDynDef/parseCommentLabels/internalAssignedVars/detectPythonParams/detectParams
const s1 = source.indexOf("function scanShellRefs(src)");
const e1 = source.indexOf("/* ---------- 结构化阶段编辑器", s1);
if (s1 < 0 || e1 < 0) throw new Error("detectParams not found");

// 切片 2：parseStageVars + mergeStageVars + substRunVars（execScript 依赖）
const s2 = source.indexOf("function parseStageVars(stdout)");
const e2 = source.indexOf("async function execScript", s2);
if (s2 < 0 || e2 < 0) throw new Error("substRunVars not found");

// 切片 3：execScript（动态默认值注入行为验证，fetch 打桩）
const s3 = source.indexOf("async function execScript(");
const e3 = source.indexOf("function jkJobPath(job)", s3);
if (s3 < 0 || e3 < 0) throw new Error("execScript not found");

const execRequests = [];
const context = {
  JSON, console,
  __curRun: { vars: {}, envs: [{ ip: "192.0.2.10", user: "root", pass: "secret" }], image: "reg/xds", tag: "t1", pipelineName: "p", token: 1 },
  fetch: async (_url, init) => { execRequests.push(JSON.parse(init.body)); return { json: async () => ({ code: 0, stdout: "", stderr: "" }) }; },
};
vm.createContext(context);
vm.runInContext(
  `let curRun = globalThis.__curRun; let scriptsDir = "/tmp/scripts";
${source.slice(s1, e1)}
${source.slice(s2, e2)}
${source.slice(s3, e3)}`,
  context,
);

const detect = context.detectParams;

(async () => {
  // ① 嵌套 ${} 默认值按花括号配平完整捕获并标记 dyn（不再截断为 ${RUN_DIR）
  const ps1 = detect([
    'RENDER_DIR="${RENDER_DIR:-${RUN_DIR}/rendered}"',
    'NAMESPACE="${NAMESPACE:-xds-${ARCH_NAME}-${IMAGE_TAG:-local}}"',
  ].join("\n"), "sh");
  const rd = ps1.find((p) => p.key === "RENDER_DIR");
  if (!rd || rd.def !== "${RUN_DIR}/rendered" || !rd.dyn) throw new Error("嵌套默认值应完整捕获并标 dyn，得到 " + JSON.stringify(rd));
  const ns = ps1.find((p) => p.key === "NAMESPACE");
  if (!ns || ns.def !== "xds-${ARCH_NAME}-${IMAGE_TAG:-local}" || !ns.dyn) throw new Error("多层嵌套默认值应完整捕获，得到 " + JSON.stringify(ns));
  console.log("PASS: 嵌套 ${} 默认值配平捕获并标记 dyn");

  // ② 静态默认值照常识别为 def（供 placeholder 展示，不再预填/注入）且不标 dyn；含 $引用 / $() 命令替换的默认值标 dyn；:? 必填
  const ps2 = detect([
    'IMAGE_NAME="${IMAGE_NAME:-myapp}"',
    'RUN_DIR="${RUN_DIR:-/tmp/r-$(date +%s)}"',
    'REL="${REL:-$NAMESPACE}"',
    'REQ="${REQ:?必须填写}"',
    'echo "${BASH_SOURCE[0]} $HOME"',   // 内置变量不识别
  ].join("\n"), "sh");
  const img = ps2.find((p) => p.key === "IMAGE_NAME");
  if (!img || img.def !== "myapp" || img.dyn) throw new Error("静态默认值应识别为 def 且不标 dyn，得到 " + JSON.stringify(img));
  if (!ps2.find((p) => p.key === "RUN_DIR").dyn) throw new Error("含 $() 的默认值应标 dyn");
  if (!ps2.find((p) => p.key === "REL").dyn) throw new Error("含 $VAR 的默认值应标 dyn");
  const req = ps2.find((p) => p.key === "REQ");
  if (!req || !req.required || req.def !== "") throw new Error(":? 应标必填且无默认值，得到 " + JSON.stringify(req));
  if (ps2.find((p) => p.key === "BASH_SOURCE" || p.key === "HOME")) throw new Error("BASH_SOURCE/HOME 等内置变量不应识别为参数");
  console.log("PASS: 静态/动态默认值分类与内置变量过滤");

  // ③ 注释标签：对齐空格与「VAR = 说明」可识别；docker pull $IMAGE:$TAG 这类冒号文本不误识别
  const ps3 = detect([
    '# 位置参数 $1 = 模型架构名',
    '#   "docker pull $IMAGE_NAME:$IMAGE_TAG && docker run -d $IMAGE_NAME:$IMAGE_TAG"',
    '#   IMAGE_NAME      镜像名（主控「镜像名」输入框）',
    'echo "$1 $IMAGE_NAME"',
  ].join("\n"), "sh");
  const p1 = ps3.find((p) => p.kind === "pos" && p.key === "1");
  if (!p1 || p1.label !== "模型架构名") throw new Error("位置参数注释标签应识别，得到 " + JSON.stringify(p1));
  const im = ps3.find((p) => p.key === "IMAGE_NAME");
  if (!im || im.label !== "镜像名") throw new Error("对齐空格标签应识别为「镜像名」，且不应被 docker 行冒号污染，得到 " + JSON.stringify(im));
  console.log("PASS: 注释标签识别（分隔符收紧，$IMAGE:$TAG 不误判）");

  // ④ 标记为无位置参数的环境变量脚本，内部辅助函数的 $1/$2 不得生成页面参数。
  const ps4 = detect([
    '# pipeline: no-positional-args',
    'run_remote() { local host=$1 port=$2; echo "$host:$port"; }',
    'ACTION="${ACTION:-check-health}"',
  ].join("\n"), "sh");
  if (ps4.some((p) => p.kind === "pos")) throw new Error("no-positional-args 标记不应生成位置参数，得到 " + JSON.stringify(ps4));
  if (!ps4.find((p) => p.kind === "env" && p.key === "ACTION")) throw new Error("no-positional-args 不应影响环境变量识别，得到 " + JSON.stringify(ps4));
  console.log("PASS: no-positional-args 忽略内部位置参数");

  // 实际清理/检查脚本只能通过环境变量配置，不能把函数参数传给入口。
  for (const name of ["cleanup-env.sh", "check-env.sh", "bnt-standalone.sh"]) {
    const script = fs.readFileSync(require("path").join(__dirname, "..", "scripts", name), "utf8");
    const params = detect(script, "sh");
    if (params.some((p) => p.kind === "pos")) throw new Error(name + " 不应识别位置参数");
    if (!params.some((p) => p.kind === "env" && p.key === "ACTION")) throw new Error(name + " 必须保留环境变量识别");
    await context.execScript({ path: "/tmp/" + name, params, values: {} });
    const request = execRequests.pop();
    if (request.args.length !== 0) throw new Error(name + " 不应下发位置参数");
  }
  console.log("PASS: 清理/检查脚本实际调用均无位置参数");

  // ⑤ execScript：识别到的默认值（静态/动态一律）无显式值时不下发——静态默认不再注入 env（不压过运行级注入的
  //    同名变量，此处 IMAGE_NAME 由 rc.image 兜底），dyn 默认不注入（交由脚本自身 :- 展开）、位置参数留空传空串
  await context.execScript({
    path: "/tmp/t.sh",
    params: [
      { kind: "env", key: "RENDER_DIR", def: "${RUN_DIR}/rendered", dyn: true },
      { kind: "env", key: "IMAGE_NAME", def: "myapp", dyn: false },
      { kind: "pos", key: "1", def: "xds", dyn: false },
    ],
    values: {},
  });
  const req1 = execRequests[0];
  if ("RENDER_DIR" in req1.env) throw new Error("dyn 默认值不应注入 env，得到 " + JSON.stringify(req1.env.RENDER_DIR));
  if (req1.env.IMAGE_NAME !== "reg/xds") throw new Error("静态默认值不再下发，留空应由运行级注入的 IMAGE_NAME 兜底，得到 " + JSON.stringify(req1.env.IMAGE_NAME));
  if (req1.args[0] !== "") throw new Error("位置参数留空应传空串（${1:-...} 由脚本展开默认值），得到 " + JSON.stringify(req1.args));
  await context.execScript({
    path: "/tmp/t.sh",
    params: [
      { kind: "env", key: "RENDER_DIR", def: "${RUN_DIR}/rendered", dyn: true },
      { kind: "env", key: "IMAGE_NAME", def: "myapp", dyn: false },
    ],
    values: { RENDER_DIR: "/custom/rendered", IMAGE_NAME: "custom/img" },
  });
  if (execRequests[1].env.RENDER_DIR !== "/custom/rendered") throw new Error("dyn 参数显式值应正常注入，得到 " + JSON.stringify(execRequests[1].env.RENDER_DIR));
  if (execRequests[1].env.IMAGE_NAME !== "custom/img") throw new Error("静态默认参数的显式值应优先于运行级注入，得到 " + JSON.stringify(execRequests[1].env.IMAGE_NAME));
  console.log("PASS: execScript 识别默认值不下发、运行级注入兜底、显式值优先");
})().catch((e) => { console.error(e); process.exit(1); });
