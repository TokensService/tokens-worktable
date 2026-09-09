/* 测试 EvalTokens 任务输入参数自动识别（detectEvaltokTaskParams）
   用法：PIPELINE_HTML=projects/pipeline/pipeline.html node projects/pipeline/test_evaltok_detect_params.js */
const fs = require("fs");
const vm = require("vm");

const pipelineHtml = process.env.PIPELINE_HTML || __dirname + "/pipeline.html";
const source = fs.readFileSync(pipelineHtml, "utf8");

// 切片：detectEvaltokTaskParams（紧随 evaltokFetchTasksCached 之后）
const s1 = source.indexOf("function detectEvaltokTaskParams(task)");
if (s1 < 0) throw new Error("detectEvaltokTaskParams not found");
// 截到下一个 async function（detectEvaltokStageParams 之前的闭合 }
const e1 = source.indexOf("async function detectEvaltokStageParams", s1);
if (e1 < 0) throw new Error("detectEvaltokStageParams not found");

// 需要的辅助：esc（渲染参数行时用到，但 detect 本身不依赖——仅测 detect）
const context = { JSON, console };
vm.createContext(context);
vm.runInContext(source.slice(s1, e1), context);

const detect = context.detectEvaltokTaskParams;

const tests = [];
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  tests.push({ label, pass: a === e, actual: a, expected: e });
  if (a !== e) console.error("FAIL:", label, "\n  got:", a, "\n  exp:", e);
  else console.log("PASS:", label);
}

// ① 任务无输入参数字段 → 空数组
eq(detect({ id: "t1", name: "任务1", status: "running" }), [], "无输入参数字段返回空");

// ② input 为对象 → 逐键提取
eq(
  detect({ id: "t2", input: { model: "qwen", batch: 8, dataset: "mmlu" } }),
  [
    { key: "model", label: "model", def: "qwen", required: false },
    { key: "batch", label: "batch", def: "8", required: false },
    { key: "dataset", label: "dataset", def: "mmlu", required: false },
  ],
  "input 对象逐键提取"
);

// ③ params 为数组（{name,value} 元素）→ 提取 name+value
eq(
  detect({
    id: "t3",
    params: [
      { name: "gpu", value: "A100" },
      { name: "count", value: 4 },
    ],
  }),
  [
    { key: "gpu", label: "gpu", def: "A100", required: false },
    { key: "count", label: "count", def: "4", required: false },
  ],
  "params 数组 {name,value} 提取"
);

// ④ config 为嵌套对象 → 值整体序列化
const r4 = detect({ id: "t4", config: { limits: { cpu: 2, mem: "4Gi" } } });
eq(
  r4.length,
  1,
  "config 嵌套对象序列化为一条"
);
eq(
  r4[0].key,
  "limits",
  "config 嵌套对象的 key 为顶层字段名"
);
eq(
  typeof r4[0].def,
  "string",
  "config 嵌套对象的值序列化为字符串"
);

// ⑤ inputs 为数组（裸值元素）→ key 为元素字面量
eq(
  detect({ id: "t5", inputs: ["alpha", "beta"] }),
  [
    { key: "alpha", label: "alpha", def: "", required: false },
    { key: "beta", label: "beta", def: "", required: false },
  ],
  "inputs 裸值数组 key 取元素字面量"
);

// ⑥ arguments 数组 {key, default} 元素 → def 取 default
eq(
  detect({
    id: "t6",
    arguments: [{ key: "lr", default: "1e-4" }],
  }),
  [{ key: "lr", label: "lr", def: "1e-4", required: false }],
  "arguments 数组 {key,default} 提取"
);

// ⑦ 去重：同名 key 只保留首次
eq(
  detect({
    id: "t7",
    input: { foo: "1", bar: "2" },
    params: [{ name: "foo", value: "3" }], // input 优先（先命中）
  }),
  [
    { key: "foo", label: "foo", def: "1", required: false },
    { key: "bar", label: "bar", def: "2", required: false },
  ],
  "input 字段优先于 params，同 key 不重复"
);

// ⑧ null / 非对象 → 空数组
eq(detect(null), [], "null 返回空");
eq(detect("string"), [], "非对象返回空");
eq(detect(undefined), [], "undefined 返回空");

const failed = tests.filter((t) => !t.pass);
if (failed.length) {
  console.error("\n" + failed.length + " test(s) FAILED");
  process.exit(1);
}
console.log("\nAll " + tests.length + " tests passed.");
