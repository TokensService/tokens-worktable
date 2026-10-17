/* 流水线页脚本拆分（projects/pipeline/js/*.js）的结构护栏。

   页面脚本原为 pipeline.html 里单个 11236 行内联 <script>，现按「两阶段」拆成同目录 classic
   script，由页面按序 <script src> 加载：
     阶段一 01-*.js … 25-*.js      只含顶层 function 声明，按功能域分组；
     阶段二 99-state-and-boot.js   其余全部顶层语句（状态 let/const、事件绑定、启动渲染），严格保序。

   为什么必须两阶段：本页引导期（顶层 let 初始化器、事件绑定、启动渲染）会调用散布在各功能域的
   437 个函数。原单内联脚本靠 673 个函数声明整体提升成立；拆成多个 classic script 后，第 k 个文件
   执行时第 k+1..N 个尚未实例化，跨文件提升消失 → ReferenceError。故所有声明必须先于任何执行代码加载。

   本测试锁住这些不变量，防止后续改动悄悄破坏（尤其是「往阶段一分片里塞执行代码」与「重排加载顺序」）。 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { loadPageHtml, loadPageSource, listPageScripts, PIPELINE_DIR } = require('./_page-source.cjs');

const html = loadPageHtml();
const scripts = listPageScripts();
const jsDir = path.join(PIPELINE_DIR, 'js');
const source = loadPageSource();
const read = (rel) => fs.readFileSync(path.join(PIPELINE_DIR, rel), 'utf8');

const BOOT_RE = /^js\/99-/;
const phase1 = scripts.filter((s) => !BOOT_RE.test(s));
const boot = scripts.filter((s) => BOOT_RE.test(s));

/** 单个分片的体量上限（行）。拆分后最大分片约 1000 行，留出增长余量。 */
const MAX_CHUNK_LINES = 1600;
/** pipeline.html 内允许的内联脚本体量上限（行）——只留给防闪烁主题这类首屏必需的小片段。 */
const MAX_INLINE_LINES = 60;

/** 去掉注释后的列首行：阶段一分片只允许出现 function 声明、闭括号与空行 */
function col0Lines(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').trimEnd())
    .filter((l) => l.length > 0 && !/^\s/.test(l));
}

test('① 分片按 01..NN 后接 99-*（阶段二）加载，且与 js/ 目录一一对应', () => {
  assert.ok(phase1.length >= 20, `阶段一分片数异常（${phase1.length}）`);
  assert.equal(boot.length, 1, `应恰好有 1 个阶段二分片，实际 ${boot.length}`);
  assert.equal(scripts[scripts.length - 1], boot[0], '阶段二分片必须最后加载（所有声明就位后才执行引导代码）');
  phase1.forEach((rel, i) => {
    const expected = String(i + 1).padStart(2, '0');
    assert.ok(rel.slice(3).startsWith(expected + '-'), `第 ${i + 1} 个阶段一分片应以 ${expected}- 开头，实际 ${rel}`);
  });
  const onDisk = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(onDisk, scripts.map((r) => r.slice(3)).sort(), 'js/ 目录内容与 pipeline.html 引用不一致（孤儿分片或悬空引用）');
});

test('② 每个分片都是 classic script（无顶层 import/export），共享同一全局作用域', () => {
  for (const rel of scripts) {
    const noComment = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(noComment, /^(import|export)[\s{*]/m, `${rel} 含顶层 import/export：分片必须是 classic script，改成 ES module 会失去共享全局作用域`);
  }
});

test('③ 阶段一分片只含 function 声明（不得出现加载期执行代码）', () => {
  for (const rel of phase1) {
    for (const line of col0Lines(read(rel))) {
      const ok = /^(async\s+)?function\b/.test(line) || /^[})\];,]/.test(line) || /^\*/.test(line);
      assert.ok(ok, `${rel} 阶段一分片出现列首非函数声明语句：${JSON.stringify(line.slice(0, 100))}\n` +
        '阶段一必须只放 function 声明；状态/绑定/启动代码请放进 99-state-and-boot.js，' +
        '否则该分片加载时就会执行代码，跨分片函数提升不再覆盖，会 ReferenceError');
    }
  }
});

test('④ 阶段二分片不含顶层 function 声明（阶段划分未被破坏）', () => {
  for (const line of col0Lines(read(boot[0]))) {
    assert.doesNotMatch(line, /^(async\s+)?function\b/, `99 分片出现顶层函数声明：${JSON.stringify(line.slice(0, 100))}\n函数声明应放进对应功能域的阶段一分片`);
  }
});

test(`⑤ pipeline.html 不再含大段内联脚本（单个内联 <script> ≤ ${MAX_INLINE_LINES} 行）`, () => {
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(inline.length >= 1, '未找到任何内联 <script>（防闪烁主题脚本应保留）');
  for (const body of inline) {
    const n = body.split('\n').length;
    assert.ok(n <= MAX_INLINE_LINES, `pipeline.html 内联脚本 ${n} 行，超过 ${MAX_INLINE_LINES} 行上限——新代码请放进 js/ 分片`);
  }
});

test(`⑥ 单个分片体量 ≤ ${MAX_CHUNK_LINES} 行`, () => {
  for (const rel of scripts) {
    const n = read(rel).split('\n').length;
    assert.ok(n <= MAX_CHUNK_LINES, `${rel} 已 ${n} 行，超过 ${MAX_CHUNK_LINES} 行上限，请按功能域再拆`);
  }
});

test('⑦ 内联回单文件视图后，既有测试依赖的关键标记仍在', () => {
  // 这些标记被 projects/pipeline/tests 与 tests/ 下大量用例用作 indexOf 切片锚点，
  // 改动分节标题或函数名会让那批测试静默取到空片段——先在这里给出明确报错。
  const marks = [
    'function scanShellRefs(src)',
    '/* ---------- 结构化阶段编辑器',
    'function parseStageVars(stdout)',
    'async function execScript',
    'function jkJobPath(job)',
    '/* ---------- 详情面板 ---------- */',
    '/* ---------- 流水线任务手动刷新 ---------- */',
    '/* ---------- 流水线任务管理（多条流水线） ---------- */',
    'const PIPELINE_DEFAULT_PRESET_KEYS=',
    'nodeIp:e.nodeIp||',
    'TARGET_NODE_IP_MAP',
  ];
  for (const m of marks) assert.ok(source.includes(m), `单文件视图缺少既有测试的切片标记: ${m}`);
});

test('⑧ 加载期即被调用的核心工具函数位于阶段一（不依赖跨分片提升）', () => {
  // lsGet 被顶层 let 初始化器在引导期立即调用（curPipelineId / curRepoId / archiveDir 等）；
  // $ 被引导期的事件绑定大量调用。两者都必须在阶段一/阶段二的正确位置，不能被挪到 boot 之后。
  const all = scripts.map((rel) => ({ rel, text: read(rel) }));
  for (const name of ['function lsGet(', 'const $ = id =>']) {
    const hits = all.filter((f) => f.text.includes(name));
    assert.equal(hits.length, 1, `${name} 应恰好出现 1 次，实际 ${hits.length} 次（${hits.map((h) => h.rel).join(', ')}）`);
  }
  assert.ok(phase1.some((rel) => read(rel).includes('function lsGet(')), 'lsGet 应在阶段一分片里（引导期立即调用，必须先于 boot 定义）');
});
