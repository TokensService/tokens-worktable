const fs = require("fs");
const vm = require("vm");

const pipelineHtml = process.env.PIPELINE_HTML || __dirname + "/../pipeline.html";
const source = fs.readFileSync(pipelineHtml, "utf8");

// 切片：parseStageVars / parseStageJson / jsonPathGet / mergeStageVars / applyOutVars / substRunVars
const s1 = source.indexOf("function forEachOutputLine(output, visit)");
const e1 = source.indexOf("async function execScript", s1);
if (s1 < 0 || e1 < 0) throw new Error("output parsers not found");

const context = {
  JSON, console,
};
vm.createContext(context);
vm.runInContext(source.slice(s1, e1), context);

// 切片 2：URL 请求阶段执行链（jkJobPath..runScriptStep，含 runUrlStep）
const s2 = source.indexOf("function jkJobPath(job)");
const e2 = source.indexOf("async function runScriptStep", s2);
if (s2 < 0 || e2 < 0) throw new Error("runUrlStep slice not found");

// ① parseStageJson：对象 / 数组单行 JSON，最后一处为准，坏行跳过
const o1 = context.parseStageJson('noise\n{"a":1}\ntrailer');
if (!o1 || o1.a !== 1) throw new Error("单行 JSON 对象应被提取");
const o2 = context.parseStageJson('{"a":1}\n[{"name":"x"}]\n{broken}');
if (!Array.isArray(o2) || o2[0].name !== "x") throw new Error("数组单行 JSON 应被提取且后写覆盖");
if (context.parseStageJson("no json here") !== null) throw new Error("无 JSON 行应返回 null");
if (context.parseStageJson("") !== null) throw new Error("空输出应返回 null");
console.log("PASS: parseStageJson 识别对象/数组单行 JSON（最后一处为准，坏行跳过）");

// ② jsonPathGet：点路径 / [N] / 负数下标 / 前导 $ / 数组根 / 异常路径
const doc = { total: 2, items: [{ name: "br-a" }, { name: "br-b" }], meta: { tag: "v1" } };
if (context.jsonPathGet(doc, "items.0.name") !== "br-a") throw new Error("点路径应可取数组元素字段");
if (context.jsonPathGet(doc, "items[1].name") !== "br-b") throw new Error("[N] 下标应可用");
if (context.jsonPathGet(doc, "$.items[-1].name") !== "br-b") throw new Error("前导 $ 与负数下标应可用");
if (context.jsonPathGet(doc, "meta.tag") !== "v1") throw new Error("嵌套对象字段应可取");
if (context.jsonPathGet(doc, "total") !== 2) throw new Error("数字标量应原样返回（序列化交给调用方）");
if (context.jsonPathGet([{ name: "r0" }], "[0].name") !== "r0") throw new Error("数组根路径应可用");
if (context.jsonPathGet(doc, "items.9.name") !== undefined) throw new Error("越界下标应为 undefined");
const itemsHit = context.jsonPathGet(doc, "items");
if (!Array.isArray(itemsHit) || itemsHit.length !== 2) throw new Error("终点为数组应原样返回（由 applyOutVars 序列化）");
const metaHit = context.jsonPathGet(doc, "meta");
if (!metaHit || metaHit.tag !== "v1") throw new Error("终点为对象应原样返回（由 applyOutVars 序列化）");
if (context.jsonPathGet(doc, "nope.deeper") !== undefined) throw new Error("不存在的路径应为 undefined");
if (context.jsonPathGet(doc, "items[-3].name") !== undefined) throw new Error("负数越界应为 undefined");
if (context.jsonPathGet(doc, "") !== undefined) throw new Error("空路径应为 undefined");
console.log("PASS: jsonPathGet 支持点路径/[N]/负数下标/前导 $，异常路径一律 undefined");

// ③ applyOutVars：普通改名不变；JSON 路径来源从 jsonCtx 取嵌套字段；变量池同名 key 优先
//    （多运行上下文改造后变量池挂在 rc.vars，applyOutVars 首参传 rc）
const rcV = { vars: { image: "reg/x:test", UP_VER: "1.2.3" } };
context.applyOutVars(rcV, "IMAGE_URL=image", {});
if (rcV.vars.IMAGE_URL !== "reg/x:test") throw new Error("普通改名映射应保持不变");
const varsOut = {};
context.applyOutVars(rcV, "XDS_BRANCH=items.0.name, LATEST=items[-1].name", varsOut, doc);
if (rcV.vars.XDS_BRANCH !== "br-a") throw new Error("JSON 路径来源应赋值给目标变量，得到 " + JSON.stringify(rcV.vars.XDS_BRANCH));
if (rcV.vars.LATEST !== "br-b") throw new Error("负数下标路径应可取末项");
if (varsOut.XDS_BRANCH !== "br-a" || varsOut.LATEST !== "br-b") throw new Error("路径来源的变量应体现在 varsOut 展示中");
context.applyOutVars(rcV, "SKIP=items.9.name, MISS=nope", {}, doc);
if ("SKIP" in rcV.vars || "MISS" in rcV.vars) throw new Error("路径/来源无值时不应产生变量");
rcV.vars["items.0.name"] = "pool-wins";
context.applyOutVars(rcV, "PICK=items.0.name", {}, doc);
if (rcV.vars.PICK !== "pool-wins") throw new Error("变量池已捕获同名 key 时应优先于 JSON 路径，得到 " + JSON.stringify(rcV.vars.PICK));
// 对象/数组终点整体序列化；* / 留空来源 = 返回值全文
context.applyOutVars(rcV, "BRANCHES=items", {}, doc);
if (rcV.vars.BRANCHES !== JSON.stringify(doc.items)) throw new Error("数组终点应整体序列化为 JSON 字符串，得到 " + JSON.stringify(rcV.vars.BRANCHES));
context.applyOutVars(rcV, "RESP=*, EMPTY_SRC=", {}, null, "line1\nline2\n");
if (rcV.vars.RESP !== "line1\nline2\n") throw new Error("* 来源应赋返回值全文，得到 " + JSON.stringify(rcV.vars.RESP));
if (rcV.vars.EMPTY_SRC !== "line1\nline2\n") throw new Error("留空来源应赋返回值全文，得到 " + JSON.stringify(rcV.vars.EMPTY_SRC));
context.applyOutVars(rcV, "NOPE=*", {}, null, undefined);
if ("NOPE" in rcV.vars) throw new Error("无返回值全文时 * 来源不应产生变量");
console.log("PASS: applyOutVars 普通改名不变，JSON 路径来源可取嵌套字段（容器整体序列化），* / 留空来源赋返回值全文");

// ④ runUrlStep 端到端：>64K 的分页列表响应（展示截断），「输出变量」JSON 路径仍应从完整响应体取到嵌套字段
const bigItems = [];
for (let i = 0; i < 2000; i++) bigItems.push({ type: "branch", name: "0" + String(i).padStart(4, "0") + "_dev_branch_padding" });
bigItems.push({ type: "branch", name: "0830_dev_bnt3" });
const bigBody = JSON.stringify({ total: bigItems.length, offset: 0, limit: bigItems.length, next_offset: null, items: bigItems });
if (bigBody.length <= 65536) throw new Error("测试响应体应超过 64K 截断阈值");
const ctx2 = {
  JSON, URL, Date, console, setTimeout, clearTimeout, setInterval, clearInterval,
  stageUrlOf: (s) => (s.url && s.url.url) || "",
  runSetSel: (rc, id) => { rc.selId = id; },   // 引擎层选中：写 rc.selId（viewRc!==rc 时不再回写视图层 selectedId）
  rcRender: () => {}, renderDetail: () => {}, archiveStageLog: () => {},
  stageSeq: (stg, i) => i + 1,   // 归档序号帮助函数（新签名：阶段数组 + 下标；预设任务改造后由 runUrlStep 调用）
  advance: () => {}, finish: () => {},
  jenkins: { url: "", user: "", token: "", mode: "local" },
  fetch: async () => ({ ok: true, text: async () => bigBody }),
};
vm.createContext(ctx2);
vm.runInContext(
  `let viewRc = null; let selectedId = "";
${source.slice(s1, e1)}
${source.slice(s2, e2)}`,
  ctx2,
);
// 运行上下文 rc：多运行并行改造后引擎函数不再读写 curRun/runStages/nodes/selectedId/timer 全局
const rc2 = {
  id: "run-test", token: 1, over: false, overall: null, timer: null, selId: "",
  stages: [{ id: "st-url", name: "拉取分支", dur: 60, kind: "url",
    url: { url: "http://xds.local/api/xds/code-refs/latest", outVars: "XDS_BRANCH=items[-1].name, TOTAL=total, RAW=*" } }],
  nodes: {}, vars: {},
  env: "", envs: null, image: "", release: "", commit: "", tag: "", startTs: Date.now(), by: "",
  source: "test", pipelineId: "", pipelineName: "", repoId: "", repoName: "", repoUrl: "",
  giturl: "", repoUser: "", repoPass: "", branch: "", strategy: "", prom: null, archive: "",
};
(async () => {
  await ctx2.runUrlStep(rc2, 0);
  if (rc2.vars.XDS_BRANCH !== "0830_dev_bnt3") throw new Error("截断展示的完整响应体仍应供 JSON 路径取值，得到 " + JSON.stringify(rc2.vars.XDS_BRANCH));
  if (rc2.vars.TOTAL !== String(bigItems.length)) throw new Error("被截断展示的响应体顶层标量也应从完整体捕获，得到 " + JSON.stringify(rc2.vars.TOTAL));
  if (rc2.vars.RAW !== bigBody) throw new Error("* 来源应把完整响应体（不截断）整体赋给变量，长度 " + String((rc2.vars.RAW || "").length));
  const outLog = rc2.stages[0]._out.stdout;
  if (!outLog.includes("…(截断，仅展示；变量捕获用完整响应体)")) throw new Error("超 64K 响应体在日志里应带截断标记");
  if (rc2.nodes["st-url"].varsOut.XDS_BRANCH !== "0830_dev_bnt3") throw new Error("路径取值应体现在 varsOut 展示中");
  if (rc2.selId !== "st-url") throw new Error("runSetSel 应把本阶段写入 rc.selId");
  console.log("PASS: runUrlStep 超 64K 分页响应——展示截断不影响变量捕获，JSON 路径正确赋值 XDS_BRANCH");
})().catch((e) => { console.error(e); process.exit(1); });
