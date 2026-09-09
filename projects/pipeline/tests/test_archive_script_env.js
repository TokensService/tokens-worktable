const fs = require("fs");
const vm = require("vm");

const pipelineHtml = process.env.PIPELINE_HTML || __dirname + "/../pipeline.html";
const source = fs.readFileSync(pipelineHtml, "utf8");
const start = source.indexOf("function substRunVars(");   // execScript 依赖前置的 substRunVars（参数值 ${VAR} 引用替换）
const end = source.indexOf("async function runScriptStep", start);
if (start < 0 || end < 0) throw new Error("substRunVars/execScript not found");

let request;
const context = {
  __curRun: {
    vars: {},
    envs: [{ ip: "192.0.2.10", user: "root", pass: "secret" }],
    image: "registry.example.com/xds",
    tag: "test",
    pipelineName: "contract-test",
    archive: "/var/log/op_test/contract-test_20260101_000000",   // 本次运行归档文件夹（启动时快照到 rc.archive）
  },
  fetch: async (_url, init) => {
    request = JSON.parse(init.body);
    return { json: async () => ({ code: 0, stdout: "", stderr: "" }) };
  },
  JSON,
};
vm.createContext(context);
vm.runInContext(
  `let curRun = globalThis.__curRun; let scriptsDir = "/tmp/scripts";\n${source.slice(start, end)}`,
  context,
);

(async () => {
  /* 回归：archiveRun 以 extraEnv 注入归档脚本 ARCHIVE_DIR=归档根目录（host 节点环境日志 <ip>.log/
     controller.log 落根目录，跨运行共享）；extraEnv 不得被 rc.archive 的运行级默认注入
     （ARCHIVE_DIR=本次运行文件夹）提前占位挡住，否则 host 日志会错写进单次运行文件夹。 */
  const folder = "/var/log/op_test/contract-test_20260101_000000";
  const result = await context.execScript(
    { path: "/tmp/collect_logs.sh", params: [], values: {} },
    120000,
    { ARCHIVE_DIR: "/var/log/op_test", ARCHIVE_FOLDER: folder, ARCHIVE_TAG: "test" },
  );
  if (!request) throw new Error(`execution did not reach fetch: ${result.stderr}`);
  if (request.env.ARCHIVE_DIR !== "/var/log/op_test") {
    throw new Error(`expected archive-root ARCHIVE_DIR, got ${JSON.stringify(request.env.ARCHIVE_DIR)}`);
  }
  if (request.env.ARCHIVE_FOLDER !== folder) {
    throw new Error(`expected run-folder ARCHIVE_FOLDER, got ${JSON.stringify(request.env.ARCHIVE_FOLDER)}`);
  }
  console.log("PASS: extraEnv ARCHIVE_DIR overrides the per-run archive folder default");
})();
