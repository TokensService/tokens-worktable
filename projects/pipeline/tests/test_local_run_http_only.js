// test_local_run_http_only.js — 「本地执行」（需本地运行）仅 http 任务类型支持，其余类型一律跟随定时计划：
// 1) renderStageSched 只对 http 阶段渲染「本地运行」勾选框，simulate/shell/python/evaltokens 渲染说明文案；
// 2) normalizeStageKind 对非 http 阶段强制 sched={}（旧数据/分享导入带 sched=null 一并归一）；
// 3) setStageKind 切到非 http 类型时恢复 sched={}（防 http 勾选「本地运行」后切走留下脏标记）；
// 4) updateStageFromEditor 的 sched 事件对非 http 阶段不改 sched（旧 DOM/外部触发兜底）；
// 5) savePlForm 序列化对非 http 阶段强制恢复支持定时（防旧草稿 sched=null 残留入库）。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = require('./_page-source.cjs').loadPageSource();

/* vm 跨 realm 的普通对象原型与宿主不同，deepStrictEqual 会误失败；统一走 JSON 序列化比较（与 evaltokens-stage.test.mjs 的 jsonEqual 同口径） */
function jsonEqual(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

function extractFunction(name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, 'pipeline.html 缺少函数 ' + name);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error('未闭合的函数 ' + name);
}

function install(ctx, ...names) {
  vm.createContext(ctx);
  names.forEach((name) => vm.runInContext(extractFunction(name), ctx));
  return ctx;
}

/* ---------- renderStageSched ---------- */
function schedBoxFor(stage) {
  const box = { innerHTML: '' };
  const row = { querySelector: (sel) => (sel === '[data-sched]' ? box : null) };
  const wrap = { children: [row] };
  const ctx = {
    editStages: [stage],
    $: (id) => (id === 'plStageList' ? wrap : null),
  };
  install(ctx, 'renderStageSched');
  ctx.renderStageSched(0);
  return box;
}

test('renderStageSched：http 阶段渲染「本地运行」勾选框（sched=null 勾选、sched={} 不勾选）', () => {
  const local = schedBoxFor({ name: 'A', kind: 'http', sched: null, url: {} });
  assert.match(local.innerHTML, /data-f="sched"/, 'http 本地执行须提供 data-f="sched" 勾选框');
  assert.match(local.innerHTML, /本地运行/);
  assert.match(local.innerHTML, /checked/);

  const scheduled = schedBoxFor({ name: 'B', kind: 'http', sched: {}, url: {} });
  assert.match(scheduled.innerHTML, /data-f="sched"/);
  assert.doesNotMatch(scheduled.innerHTML, /\schecked/, '支持定时的 http 阶段勾选框不得勾选');
});

test('renderStageSched：simulate/shell/python/evaltokens 一律不渲染勾选框，只渲染跟随定时说明', () => {
  for (const kind of ['simulate', 'shell', 'python', 'evaltokens']) {
    const box = schedBoxFor({ name: 'S', kind, sched: null });   // 即使草稿残留 sched=null 也不给本地运行选项
    assert.doesNotMatch(box.innerHTML, /data-f="sched"/, kind + ' 不得渲染本地运行勾选框');
    assert.match(box.innerHTML, /跟随流水线定时计划执行/, kind + ' 应提示跟随定时计划');
    assert.match(box.innerHTML, /不支持本地运行/, kind + ' 应明示本类型不支持本地运行');
  }
});

/* ---------- normalizeStageKind ---------- */
function normCtx() {
  return install({ Object, Array, JSON, console }, 'normalizeStageKind', 'evaltokensStageConfig');
}

test('normalizeStageKind：非 http 阶段 sched 强制归为 {}（含旧数据 sched=null 残留）', () => {
  const ctx = normCtx();
  jsonEqual(ctx.normalizeStageKind({ name: 'A', kind: 'simulate', sched: null }).sched, {});
  jsonEqual(ctx.normalizeStageKind({ name: 'B', kind: 'simulate', sched: {} }).sched, {});
  jsonEqual(ctx.normalizeStageKind({ name: 'C', kind: 'simulate', sched: { mode: 1 } }).sched, {}, '旧 true/{mode...} 一律归一为 {}');
  jsonEqual(ctx.normalizeStageKind({ name: 'D', kind: 'shell', script: { path: 'x.sh', lang: 'sh' }, sched: null }).sched, {});
  jsonEqual(ctx.normalizeStageKind({ name: 'E', kind: 'python', sched: null }).sched, {});
  jsonEqual(ctx.normalizeStageKind({ name: 'F', kind: 'evaltokens', evaltokens: { taskId: 't' }, sched: null }).sched, {});
  jsonEqual(ctx.normalizeStageKind({ name: 'G', script: { path: 'x.sh', lang: 'sh' }, sched: null }).sched, {}, '未带 kind 按 script 推断为 shell 同样强制支持定时');
});

test('normalizeStageKind：http 阶段保留 sched 语义（null=本地执行，有值归一为 {}）', () => {
  const ctx = normCtx();
  assert.equal(ctx.normalizeStageKind({ name: 'A', kind: 'http', url: { url: 'x' }, sched: null }).sched, null);
  jsonEqual(ctx.normalizeStageKind({ name: 'B', kind: 'http', url: { url: 'x' }, sched: {} }).sched, {});
  jsonEqual(ctx.normalizeStageKind({ name: 'C', kind: 'http', url: { url: 'x' }, sched: { mode: 1 } }).sched, {});
  assert.equal(ctx.normalizeStageKind({ name: 'D', kind: 'url', url: { url: 'x' }, sched: null }).sched, null, '旧 kind:url 迁为 http 保留本地执行');
});

/* ---------- setStageKind ---------- */
function kindCtx(stage) {
  const row = { querySelectorAll: () => [] };   // 类型按钮同步桩：无 .jk-modeBtn
  const wrap = { children: [row] };
  const ctx = {
    editStages: [stage],
    $: (id) => (id === 'plStageList' ? wrap : null),
    renderStageActionRow() {},
    renderStageParams() {},
    renderStageSched() {},
    evaltokensStageConfig: (et) => (et || {}),   // setStageKind 切到 evaltokens 时会调用
  };
  install(ctx, 'setStageKind');
  return ctx;
}

test('setStageKind：http 勾选「本地运行」（sched=null）后切到非 http 类型，sched 恢复 {}', () => {
  const stage = { name: 'A', kind: 'http', sched: null, url: { url: 'x' } };
  const ctx = kindCtx(stage);
  for (const kind of ['simulate', 'shell', 'python', 'evaltokens']) {
    ctx.setStageKind(0, kind);
    jsonEqual(stage.sched, {}, '切到 ' + kind + ' 应恢复支持定时');
  }
});

test('setStageKind：切到 http 不影响 sched（默认 {} 支持定时，用户可再勾本地运行）', () => {
  const stage = { name: 'A', kind: 'shell', sched: {}, script: null };
  const ctx = kindCtx(stage);
  ctx.setStageKind(0, 'http');
  jsonEqual(stage.sched, {}, 'shell → http 保持支持定时');
  assert.ok(stage.url, '切到 http 应初始化 url 占位');
});

/* ---------- updateStageFromEditor（sched 事件守卫） ---------- */
function updateCtx(stage) {
  const renders = [];
  const ctx = {
    editStages: [stage],
    $: () => null,
    renderStageSched(i) { renders.push(i); },
    schedulePlDraftSave() {},
  };
  install(ctx, 'updateStageFromEditor');
  return { ctx, renders };
}

test('updateStageFromEditor：非 http 阶段收到 sched 事件不改 sched（旧 DOM/外部触发兜底）', () => {
  const stage = { name: 'A', kind: 'shell', sched: {}, script: null };
  const { ctx } = updateCtx(stage);
  const evt = {
    target: {
      getAttribute: (k) => (k === 'data-f' ? 'sched' : null),
      checked: true,
      closest: () => ({ dataset: { idx: '0' } }),
    },
  };
  ctx.updateStageFromEditor(evt);
  jsonEqual(stage.sched, {}, '非 http 阶段收到「需本地运行」勾选不得置空 sched');
});

test('updateStageFromEditor：http 阶段 sched 事件正常切换本地运行/支持定时', () => {
  const stage = { name: 'A', kind: 'http', sched: {}, url: { url: 'x' } };
  const { ctx } = updateCtx(stage);
  ctx.updateStageFromEditor({ target: { getAttribute: (k) => (k === 'data-f' ? 'sched' : null), checked: true, closest: () => ({ dataset: { idx: '0' } }) } });
  assert.equal(stage.sched, null, '勾选「需本地运行」置空 sched');
  ctx.updateStageFromEditor({ target: { getAttribute: (k) => (k === 'data-f' ? 'sched' : null), checked: false, closest: () => ({ dataset: { idx: '0' } }) } });
  jsonEqual(stage.sched, {}, '取消勾选恢复支持定时');
});

/* ---------- savePlForm 序列化（非 http 阶段强制恢复支持定时） ---------- */
class FakeNode {
  constructor() { this.children = []; this.style = {}; this.dataset = {}; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function saveCtx(stage, pipeline) {
  const stageList = new FakeNode();
  const form = { dataset: { editId: 'pl-1' }, style: {} };
  const ctx = {
    editStages: [stage], editFocusIdx: -1, plFormReadOnly: false, editSelStage: null, scriptsDir: '/scripts',
    currentUsername: 'tester', plOwnerOf: () => '', plEditable: () => true,
    $: (id) => ({ plStageList: stageList, plForm: form, plFormTitle: { textContent: '' }, plName: { value: '流水线' }, scriptsDir: { value: '/scripts' }, plSave: null, plDraftTip: null }[id] || null),
    document: { createElement: () => new FakeNode() }, esc: String, secToMinInput: (s) => String((s || 0) / 60),
    STAGE_KIND_LABEL: { simulate: '模拟', shell: 'Shell', python: 'Python', http: 'HTTP', evaltokens: 'EvalTokens' },
    stageCardMouseDown() {}, stageCardDragStart() {}, stageCardDragOver() {}, stageCardDrop() {}, stageCardDragEnd() {},
    renderStageActionRow() {}, renderStageParams() {}, renderStageSched() {}, applyEditSel() {}, applyPlFormReadOnly() {},
    findPipeline: (id) => (id === 'pl-1' ? pipeline : null), PRESET_BY_NAME: {}, scriptByName: () => null, confirm: () => true, alert: (msg) => { throw new Error(msg); },
    scriptLangOf: () => 'sh', stageIdFor: () => 'build', evaltokensStageConfig: (x) => x, saveScriptsDir() {}, collectPipelineDefaultForm: () => ({}),
    pushPipelineOne() {}, savePipelines() {}, clearPlDraft() {}, schedulePlDraftSave() {}, running: false, curPipelineId: 'other', pipelines: [pipeline], renderPipelines() {}, renderFlow() {}, renderDetail() {}, selectPipeline() {},
    normalizePipelineDefaults: (x) => x || {}, normalizeStageKind: (x) => x, withPresetMarkers: (x) => x, currentPipelineDefaultSeed: () => ({}), loadPlDraft: () => null,
    renderPipelineDefaultForm() {}, loadScripts: () => Promise.resolve(),
    setTimeout: () => 0, clearTimeout() {},
  };
  install(ctx, 'savePlForm');
  return ctx;
}

test('savePlForm：非 http 阶段即便草稿带 sched=null，保存也强制恢复支持定时', async () => {
  const stage = { id: 'build', name: '构建', dur: 0, timeout: null, skip: false, parallel: false, sub: [], kind: 'shell', script: null, url: null, evaltokens: null, sched: null };
  const pipeline = { id: 'pl-1', name: '流水线', stages: [] };
  const ctx = saveCtx(stage, pipeline);
  await ctx.savePlForm();
  jsonEqual(pipeline.stages[0].sched, {}, '非 http 阶段保存后须为支持定时（sched={}）');
});

test('savePlForm：http 阶段勾选本地运行（sched=null）保存后不带 sched 标记（维持本地执行语义）', async () => {
  const stage = { id: 'build', name: '构建', dur: 0, timeout: null, skip: false, parallel: false, sub: [], kind: 'http', url: { url: 'https://x/y', outVars: '' }, script: null, evaltokens: null, sched: null };
  const pipeline = { id: 'pl-1', name: '流水线', stages: [] };
  const ctx = saveCtx(stage, pipeline);
  await ctx.savePlForm();
  assert.equal(pipeline.stages[0].sched, undefined, 'http 本地执行阶段不得写入 sched 标记');
});