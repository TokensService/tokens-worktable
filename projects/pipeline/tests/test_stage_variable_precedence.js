const fs = require("fs");
const vm = require("vm");

const pipelineHtml = process.env.PIPELINE_HTML || __dirname + "/../pipeline.html";
const source = fs.readFileSync(pipelineHtml, "utf8");
const start = source.indexOf("function substRunVars(v, rc)");   // execScript 依赖前置的 substRunVars（参数值 ${VAR} 引用替换）
const end = source.indexOf("async function runScriptStep(rc, i)", start);
if (start < 0 || end < 0) throw new Error("substRunVars/execScript not found");

/* 多运行上下文并行重构后：execScript(sc, timeoutMs, extraEnv, runCtx, …) 第 4 参显式接收运行上下文 rc，
   substRunVars(v, rc) 亦同；全局 curRun 仅是视图别名回退（runCtx||curRun），这里置 null 验证被测路径不依赖它。 */
const rc = {
  id: "rc-contract",
  stages: [],
  nodes: {},
  selId: null,
  timer: null,
  over: false,
  overall: null,
  token: "tk-contract",
  vars: { RUN_DIR: "/run/from-pull" },
  env: "192.0.2.10",
  envs: [{ ip: "192.0.2.10", user: "root", pass: "secret" }],
  image: "registry.example.com/xds",
  release: null,
  commit: null,
  tag: "test",
  startTs: Date.now(),
  by: "tester",
  source: "test",
  pipelineId: "pl-contract",
  pipelineName: "contract-test",
  repoId: null,
  repoName: null,
  repoUrl: null,
  giturl: null,
  repoUser: null,
  repoPass: null,
  branch: null,
  strategy: null,
  prom: null,
  archive: null,
};

let request;
const context = {
  fetch: async (_url, init) => {
    request = JSON.parse(init.body);
    return { json: async () => ({ code: 0, stdout: "", stderr: "" }) };
  },
  JSON,
};
vm.createContext(context);
vm.runInContext(
  `let curRun = null; let scriptsDir = "/tmp/scripts";\n${source.slice(start, end)}`,
  context,
);

(async () => {
  const result = await context.execScript(
    {
      path: "/tmp/render-config.sh",
      params: [{ kind: "env", key: "RUN_DIR", def: "" }],
      values: {},
    },
    0,
    null,
    rc,
  );
  if (!request) throw new Error(`execution did not reach fetch: ${result.stderr}`);
  if (request.env.RUN_DIR !== "/run/from-pull") {
    throw new Error(`expected upstream RUN_DIR, got ${JSON.stringify(request.env.RUN_DIR)}`);
  }
  console.log("PASS: empty stage parameters do not override upstream variables");
})();
