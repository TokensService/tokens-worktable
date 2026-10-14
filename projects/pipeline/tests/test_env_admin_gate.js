/* 节点配置仅 admin（envConfigEditable 门禁）的页面侧测试：
   - 静态契约：节点页编辑表单行 id="envEditBar" 与只读提示 id="envAdminOnlyTip" 存在；renderEnvs 操作列经
     envConfigEditable 门禁；saveEnvForm/delEnv/copyEnv/applyEnvCredAll 带兜底拦截；fillExecutorFromAuth
     收尾调 applyEnvAdminGate；loadServerState 非 admin 整表替换 environments；applyImportedSettings 跳过环境。
   - envConfigEditable 矩阵：token 模式 / 探测在途 / 全局缺失退化全权；非 admin false；admin true。
   - renderEnvs 操作列：admin 见 编辑/复制/删除，非 admin 仅「分配」（只读查看）。
   - applyEnvAdminGate：编辑区显隐 + 非 admin 本地节点列表对齐服务端基线（丢弃未落盘分歧，防保存撞 403）。
   - 四个变更入口兜底：非 admin alert 拦截、environments 不变、不触发保存。
   - applyImportedSettings / importSettingsData：非 admin 跳过 environments 并提示「未导入」；admin 照常。
   - loadServerState：非 admin 整表替换（本地未落盘新增被丢弃）；admin 三方合并保留本地新增。 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');
const J = x => JSON.parse(JSON.stringify(x));   // vm 沙盒产物与主 realm 原型不同，深比较前先归一化

function extractFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `pipeline.html 缺少函数 ${name}`);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(match.index, i + 1); }
  }
  throw new Error(`无法提取函数 ${name}`);
}
/* 元素桩（与 test_node_reservations.js 同款） */
function elStub(tag) {
  const el = {
    tag: tag || 'div', style: {}, children: [], attributes: {}, _listeners: {},
    textContent: '', title: '', placeholder: '', value: '', type: '', className: '', autocomplete: '',
    checked: false, disabled: false,
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    fire(type, ev) { (this._listeners[type] || []).forEach(fn => fn(ev || { preventDefault() {}, stopPropagation() {} })); },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html || ''; },
    set(v) { this._html = v; this.children = []; },
  });
  return el;
}
const envOf = (id, name, extra) => Object.assign({ id, name, ip: '10.0.0.1', nodeIp: '', llmAddr: '', user: '', pass: '' }, extra || {});

/* ---------- 静态契约 ---------- */
test('静态契约：编辑区 id / 只读提示 / 各入口门禁接线存在', () => {
  assert.ok(source.includes('id="envEditBar"'), '节点页编辑表单行带 id=envEditBar');
  assert.ok(source.includes('id="envAdminOnlyTip"'), '非 admin 只读提示元素存在');
  assert.ok(extractFunction('renderEnvs').includes('envConfigEditable'), 'renderEnvs 操作列经 envConfigEditable 门禁');
  ['saveEnvForm', 'delEnv', 'copyEnv', 'applyEnvCredAll'].forEach(n => {
    assert.ok(extractFunction(n).includes('envConfigEditable'), n + ' 带非 admin 兜底拦截');
  });
  assert.ok(extractFunction('applyImportedSettings').includes('envConfigEditable'), '导入应用按 envConfigEditable 跳过节点环境');
  assert.ok(extractFunction('loadServerState').includes('envConfigEditable'), 'loadServerState 非 admin 整表替换 environments');
  assert.ok(extractFunction('fillExecutorFromAuth').includes('applyEnvAdminGate'), '身份探测收尾应用节点门禁');
  assert.ok(source.includes("if(typeof applyEnvAdminGate==='function') applyEnvAdminGate();"), 'finally 内 typeof 守卫调用');
});

/* ---------- envConfigEditable 矩阵 ---------- */
function loadEditable(globals) {
  const ctx = Object.assign({}, globals || {});
  vm.createContext(ctx);
  vm.runInContext(extractFunction('envConfigEditable'), ctx);
  return ctx;
}
test('envConfigEditable：仅「探测完成 + 有登录用户 + admin」以外一律放行或拦截符合约定', () => {
  assert.equal(loadEditable({ authReady: true, currentUsername: 'me', currentUserIsAdmin: true }).envConfigEditable(), true, 'admin 可配');
  assert.equal(loadEditable({ authReady: true, currentUsername: 'me', currentUserIsAdmin: false }).envConfigEditable(), false, '非 admin 只读');
  assert.equal(loadEditable({ authReady: true, currentUsername: '', currentUserIsAdmin: false }).envConfigEditable(), true, 'token 模式（无登录用户）退化全权');
  assert.equal(loadEditable({ authReady: false, currentUsername: 'me', currentUserIsAdmin: false }).envConfigEditable(), true, '探测在途先不拦（防加载前误灰）');
  assert.equal(loadEditable({}).envConfigEditable(), true, '测试桩全局缺失退化全权');
  assert.equal(loadEditable({ authReady: true, currentUsername: 'me' }).envConfigEditable(), false, 'admin 标记缺失按非 admin 保守处理');
});

/* ---------- renderEnvs 操作列门禁 ---------- */
function envTableFixture() {
  const ths = ['name', 'ip', 'user', 'gpu'].map(k => ({
    getAttribute: n => (n === 'data-sort' ? k : null),
    querySelector: () => ({ textContent: '' }),
  }));
  const tbody = elStub('tbody');
  const table = elStub('table');
  table.querySelector = sel => (sel === 'tbody' ? tbody : null);
  table.querySelectorAll = sel => (sel === 'th[data-sort]' ? ths : []);
  return { table, tbody };
}
function renderEnvsCtx(globals, envs) {
  const { table, tbody } = envTableFixture();
  const els = { envCount: elStub(), envTable: table };
  const ctx = Object.assign({
    environments: envs,
    nodeReservations: [],
    gpuStatus: {}, esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    gpuCellFull: () => 'GPUCELL',
    gpuBusy: () => false,
    envSort: { key: null, dir: 1 }, envFilterText: '',
    document: { createElement: tag => elStub(tag) },
    $: id => els[id] || null,
    authReady: true, currentUsername: 'me', currentUserIsAdmin: false,
    alert: () => {}, toast: () => {},
  }, globals || {});
  vm.createContext(ctx);
  vm.runInContext([
    'reservationsForNode', 'fmtResTime', 'envResSummaryHtml',
    'gpuBusy', 'envFilterMatch', 'envSortVal', 'envSortList', 'envConfigEditable', 'renderEnvs',
  ].map(extractFunction).join('\n'), ctx);
  return { ctx, els, tbody };
}
test('renderEnvs 操作列：admin 见 编辑/复制/删除；非 admin 仅「分配」（只读查看入口保留）', () => {
  const envs = [envOf('env-a', '生产')];
  const admin = renderEnvsCtx({ currentUserIsAdmin: true, currentUsername: 'ops' }, envs);
  admin.ctx.renderEnvs();
  let html = admin.tbody.children[0].innerHTML;
  assert.ok(html.includes('data-envres="env-a"'), 'admin 有「分配」');
  assert.ok(html.includes('data-envedit="env-a"'), 'admin 有「编辑」');
  assert.ok(html.includes('data-envcopy="env-a"'), 'admin 有「复制」');
  assert.ok(html.includes('data-envdel="env-a"'), 'admin 有「删除」');

  const plain = renderEnvsCtx(null, envs);
  plain.ctx.renderEnvs();
  html = plain.tbody.children[0].innerHTML;
  assert.ok(html.includes('data-envres="env-a"'), '非 admin 保留「分配」（只读查看预留）');
  assert.ok(!html.includes('data-envedit'), '非 admin 无「编辑」');
  assert.ok(!html.includes('data-envcopy'), '非 admin 无「复制」');
  assert.ok(!html.includes('data-envdel'), '非 admin 无「删除」');
});

/* ---------- applyEnvAdminGate：显隐 + 本地分歧对齐服务端基线 ---------- */
function gateCtx(globals) {
  const els = { envEditBar: elStub(), envAdminOnlyTip: elStub() };
  const storage = {};
  const ctx = Object.assign({
    environments: [], serverConfigBase: null,
    authReady: true, currentUsername: 'me', currentUserIsAdmin: false,
    $: id => els[id] || null,
    localStorage: { setItem: (k, v) => { storage[k] = String(v); } },
  }, globals || {});
  vm.createContext(ctx);
  vm.runInContext(['sameEnvEntry', 'normalizeEnv', 'envConfigEditable', 'applyEnvAdminGate'].map(extractFunction).join('\n'), ctx);
  return { ctx, els, storage };
}
test('applyEnvAdminGate：非 admin 隐藏编辑区/显示只读提示；admin 反之', () => {
  const plain = gateCtx();
  plain.ctx.applyEnvAdminGate();
  assert.equal(plain.els.envEditBar.style.display, 'none', '非 admin 隐藏编辑区');
  assert.equal(plain.els.envAdminOnlyTip.style.display, '', '非 admin 显示只读提示');

  const admin = gateCtx({ currentUserIsAdmin: true, currentUsername: 'ops' });
  admin.ctx.applyEnvAdminGate();
  assert.equal(admin.els.envEditBar.style.display, 'flex', 'admin 显示编辑区');
  assert.equal(admin.els.envAdminOnlyTip.style.display, 'none', 'admin 不显示只读提示');
});
test('applyEnvAdminGate：非 admin 把本地未落盘的节点分歧对齐服务端基线；admin 不动', () => {
  const base = [envOf('e1', '生产', { pass: 'srv' })];
  const local = [envOf('e1', '生产'), envOf('e2', '本地未落盘')];
  const plain = gateCtx({ environments: local.map(e => ({ ...e })), serverConfigBase: { environments: J(base) } });
  plain.ctx.applyEnvAdminGate();
  assert.deepEqual(J(plain.ctx.environments), J(base), '非 admin：本地新增被丢弃、内容对齐服务端基线');
  assert.deepEqual(JSON.parse(plain.storage['pip-envs']), J(base), '离线缓存同步纠正');

  const adminLocal = [envOf('e1', '生产'), envOf('e2', '本地新增')];
  const admin = gateCtx({ currentUserIsAdmin: true, currentUsername: 'ops', environments: adminLocal.map(e => ({ ...e })), serverConfigBase: { environments: J(base) } });
  admin.ctx.applyEnvAdminGate();
  assert.deepEqual(J(admin.ctx.environments), J(adminLocal), 'admin：本地未落盘新增保留（三方合并语义不变）');

  const same = gateCtx({ environments: J(base), serverConfigBase: { environments: J(base) } });
  same.ctx.applyEnvAdminGate();
  assert.deepEqual(J(same.ctx.environments), J(base), '本无分歧时不动作');
  assert.ok(!same.storage['pip-envs'], '无分歧不写离线缓存');
});

/* ---------- 变更入口兜底拦截 ---------- */
function mutatorCtx(globals) {
  const alerts = [];
  const saves = [];
  const ctx = Object.assign({
    environments: [envOf('e1', '生产')],
    authReady: true, currentUsername: 'me', currentUserIsAdmin: false,
    alert: m => alerts.push(String(m)),
    confirm: () => true,
    $: () => elStub(),
    saveEnvs: () => saves.push('saveEnvs'),
    renderEnvs: () => {}, renderEnvOptions: () => {},
  }, globals || {});
  vm.createContext(ctx);
  vm.runInContext(['envConfigEditable', 'saveEnvForm', 'delEnv', 'copyEnv', 'applyEnvCredAll'].map(extractFunction).join('\n'), ctx);
  return { ctx, alerts, saves };
}
test('saveEnvForm/delEnv/copyEnv/applyEnvCredAll：非 admin alert 拦截、列表不变、不落盘', () => {
  const { ctx, alerts, saves } = mutatorCtx();
  ctx.saveEnvForm();
  ctx.delEnv('e1');
  ctx.copyEnv('e1');
  ctx.applyEnvCredAll();
  assert.equal(alerts.length, 4, '四个入口各拦一次');
  assert.ok(alerts.every(m => m.includes('仅 admin')), '提示仅 admin 可配置');
  assert.equal(ctx.environments.length, 1, '节点列表未被改动');
  assert.equal(saves.length, 0, '未触发保存');
});
test('变更入口：admin 照常执行（以 delEnv 为例）', () => {
  const { ctx, alerts, saves } = mutatorCtx({ currentUserIsAdmin: true, currentUsername: 'ops' });
  ctx.delEnv('e1');
  assert.equal(alerts.length, 0, 'admin 不拦');
  assert.equal(ctx.environments.length, 1, '删除至空时回填默认节点（既有语义）');
  assert.equal(ctx.environments[0].id, 'env-1');
  assert.equal(saves.length, 1, '正常落盘');
});

/* ---------- 导入：非 admin 跳过节点环境 ---------- */
function importCtx(globals, confirmText) {
  const saved = [];
  const ctx = Object.assign({
    environments: [envOf('e-old', '旧节点')],
    authReady: true, currentUsername: 'me', currentUserIsAdmin: false,
    stateLoaded: true,
    confirm: m => { if (confirmText) confirmText.push(String(m)); return true; },
    loadServerState: async () => {},
    $: () => elStub(),
  }, globals || {});
  vm.createContext(ctx);
  vm.runInContext(['envConfigEditable', 'importSettingsData'].map(extractFunction).join('\n'), ctx);
  ctx.applyImportedSettings = cfg => {   /* 真实函数经 test_config_import_export 覆盖；此处只验证 importSettingsData 的判定与透传 */
    if (Array.isArray(cfg.environments) && ctx.envConfigEditable()) ctx.environments = cfg.environments.map(e => ({ ...e }));
  };
  return { ctx, saved };
}
test('importSettingsData：非 admin 导入含节点环境的设置 → 确认文案点名排除、返回 ok-noenvs、环境不变', async () => {
  const texts = [];
  const { ctx } = importCtx(null, texts);
  const data = { app: 'worktable-pipeline', kind: 'pipeline-settings', config: { environments: [envOf('e-new', '新节点')], scriptsDir: '/s' } };
  const r = await ctx.importSettingsData(data);
  assert.equal(r, 'ok-noenvs');
  assert.ok(!texts[0].includes('节点环境 /'), '确认文案不再承诺覆盖节点环境');
  assert.ok(texts[0].includes('节点环境仅 admin 可配置'), '确认文案点名节点环境不导入');
  assert.equal(ctx.environments[0].id, 'e-old', '节点环境未被导入覆盖');
});
test('importSettingsData：admin 导入 → 返回 ok、确认文案含节点环境、环境按文件覆盖', async () => {
  const texts = [];
  const { ctx } = importCtx({ currentUserIsAdmin: true, currentUsername: 'ops' }, texts);
  const data = { app: 'worktable-pipeline', kind: 'pipeline-settings', config: { environments: [envOf('e-new', '新节点')] } };
  const r = await ctx.importSettingsData(data);
  assert.equal(r, 'ok');
  assert.ok(texts[0].includes('节点环境 /'), 'admin 确认文案含节点环境');
  assert.equal(ctx.environments[0].id, 'e-new', 'admin 按文件覆盖节点环境');
});

/* ---------- loadServerState：非 admin 整表替换 environments ---------- */
function loadServerCtx(response, seeds, globals) {
  const storage = {};
  const els = {};
  const ctx = Object.assign({
    persistInFlight: null,
    stateFetchEpoch: 0,
    stateLoaded: false,
    serverConfigBase: seeds.base,
    pipelines: seeds.pipelines || [],
    curPipelineId: 'pa',
    DEFAULT_PIPELINE_ID: 'pl-xds',
    defaultPipeline: () => ({ id: 'pl-xds', name: '内置', builtIn: true, stages: [{ id: 's0' }] }),
    migrateGate: v => v, migrateStageUrl: v => v, migratePrefillDefaults: v => v,
    migratePipelineDefaults: v => v, migratePromPreset: v => v,
    normalizeRepo: v => v,
    environments: seeds.localEnvs || [],
    repositories: [], selectedEnvIds: null, curRepoId: '',
    scriptsDir: '/srv/scripts', scriptsDirIsFallback: true,
    maybeAdoptInstalledScriptsDir: () => {},
    themePref: 'auto', buildNo: 1,
    cleanupScript: null, checkScript: null, profilingScript: null,
    jenkins: {}, evaltok: {}, prom: {}, archiveDir: '', archiveScriptName: '', analysisPrompts: {},
    histClearedAt: 0, history: [],
    historyForPersist: () => [], historySyncSig: '',
    curPipeline: () => ({ stages: [{ id: 's1' }] }),
    $: id => els[id] || (els[id] = elStub()),
    renderCleanupParams: () => {}, renderCheckParams: () => {}, renderProfilingParams: () => {},
    renderAll: () => {}, migrateInlineLogs: () => {}, persistState: () => {},
    localStorage: { setItem: (k, v) => { storage[k] = String(v); } },
    fetch: async () => ({ ok: true, status: 200, json: async () => J(response) }),
    AbortController,
    authReady: true, currentUsername: 'me', currentUserIsAdmin: false,
  }, globals || {});
  vm.createContext(ctx);
  vm.runInContext([
    'historyPersistSig', 'stripPipelineSharedMeta', 'mergePipelinesFromServer', 'sameEnvEntry', 'mergeEnvironmentsFromServer',
    'normalizeEnv', 'envConfigEditable', 'fetchPipelineStateFresh', 'loadServerState',
  ].map(extractFunction).join('\n'), ctx);
  return { ctx, storage };
}
test('loadServerState：非 admin 节点列表以服务端为权威（本地未落盘新增被丢弃）；admin 三方合并保留', async () => {
  const srvEnv = envOf('e1', '生产', { pass: 'srv' });
  const baseEnv = envOf('e1', '生产');
  const response = { config: { pipelines: [{ id: 'pa', name: 'A', stages: [] }], environments: [srvEnv] }, history: [] };
  const seeds = { base: { pipelines: [{ id: 'pa', name: 'A', stages: [] }], environments: [baseEnv] }, localEnvs: [envOf('e1', '生产'), envOf('e-local', '本地未落盘')] };

  const plain = loadServerCtx(response, seeds, null);
  await plain.ctx.loadServerState();
  assert.deepEqual(J(plain.ctx.environments), J([srvEnv]), '非 admin：整表替换为服务端版本');
  assert.deepEqual(JSON.parse(plain.storage['pip-envs']), J([srvEnv]), '离线缓存同步为服务端版本');

  const admin = loadServerCtx(response, seeds, { currentUserIsAdmin: true, currentUsername: 'ops' });
  await admin.ctx.loadServerState();
  const ids = admin.ctx.environments.map(e => e.id);
  assert.ok(ids.includes('e1') && ids.includes('e-local'), 'admin：本地未落盘新增经三方合并保留');
  assert.equal(admin.ctx.environments.find(e => e.id === 'e1').pass, 'srv', 'admin：本地未改动条目以服务端为准');
});
