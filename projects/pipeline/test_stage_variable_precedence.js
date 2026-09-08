const fs = require("fs");
const vm = require("vm");

const pipelineHtml = process.env.PIPELINE_HTML;
if (!pipelineHtml) throw new Error("PIPELINE_HTML is required");
const source = fs.readFileSync(pipelineHtml, "utf8");
const start = source.indexOf("function substRunVars(");   // execScript 依赖前置的 substRunVars（参数值 ${VAR} 引用替换）
const end = source.indexOf("async function runScriptStep", start);
if (start < 0 || end < 0) throw new Error("substRunVars/execScript not found");

let request;
const context = {
  __curRun: {
    vars: { RUN_DIR: "/run/from-pull" },
    envs: [{ ip: "192.0.2.10", user: "root", pass: "secret" }],
    image: "registry.example.com/xds",
    tag: "test",
    pipelineName: "contract-test",
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
  const result = await context.execScript({
    path: "/tmp/render-config.sh",
    params: [{ kind: "env", key: "RUN_DIR", def: "" }],
    values: {},
  });
  if (!request) throw new Error(`execution did not reach fetch: ${result.stderr}`);
  if (request.env.RUN_DIR !== "/run/from-pull") {
    throw new Error(`expected upstream RUN_DIR, got ${JSON.stringify(request.env.RUN_DIR)}`);
  }
  console.log("PASS: empty stage parameters do not override upstream variables");
})();
