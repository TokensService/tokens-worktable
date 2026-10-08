/* 复制副本改名回归（端到端级复现）：从「列表复制 → 编辑器改名 → 保存」全链路出发，
   客户端用 pipeline.html 提取的真实函数（copyPipeline/pushPipelineOne/pushState/openPlForm/savePlForm
   /loadServerState/refreshPipelinesFromServer/reconcilePipelinesAfterSave/mergePipelinesFromServer 等），
   服务端用 src/index.ts 提取的真实合并函数（esbuild 去类型后载入）驱动内存磁盘假服务器
   （save-one / 全量 PUT / GET 三个路由语义对齐源码），定时器用可控假队列（400ms 防抖、4 秒慢提示、
   60 秒看门狗按需触发）。
   覆盖：
   a. 复制后立即改名保存：名称须落盘、不被回滚、不弹冲突告警；
   b. 复制后 400ms 防抖全量 PUT（selectPipeline 触发）先走完再改名：基线与磁盘一致，改名仍须落盘；
   c. 改名保存成功后手动刷新（loadServerState 三方合并）：新名须保留；
   d. 复制的 save-one 在途期间就改名保存（慢链路排队）：串行锁后名称仍须落盘；
   e. 真实生产数据（74 条）+ 非 admin：复制内置流水线后改名，全链路无 409/403；
   f. 首屏竞态：复制的 save-one 先于首屏 GET 响应完成时，过期快照不得冲掉副本/污染基线，改名落盘；
   g. 陈旧标签页（基线缺副本、磁盘有副本）改名：409 后基线须自愈，重试即成功（不再永久锁死）；
   h. 改名保存在途时点「↻ 刷新」：在途改名不得被刷新快照覆盖。 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const esbuild = require('esbuild');

const clientSource = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');
const serverSource = fs.readFileSync(process.env.WORKTABLE_SERVER_TS || __dirname + '/../../../src/index.ts', 'utf8');

function extractFunction(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `缺少函数 ${name}`);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`无法提取函数 ${name}`);
}
const extractClient = name => extractFunction(clientSource, name);
/* 修复引入的新函数在旧代码上不存在：可缺省提取（旧代码不引用它） */
function extractClientOptional(name) {
  return new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).test(clientSource) ? extractFunction(clientSource, name) : '';
}
/* src/index.ts 先整体去类型再做花括号提取（返回类型注解里的对象字面量花括号会干扰配对） */
const serverJs = esbuild.transformSync(serverSource, { loader: 'ts' }).code;
const extractServer = name => extractFunction(serverJs, name);

/* ---------- 服务端：src/index.ts 真实合并层 + 路由语义 ---------- */
function loadServerFns() {
  const js = [
    "const BUILTIN_PIPELINE_ID = 'pl-xds';",
    'stripPipelineSharedMeta', 'mergePipelineFavoriteUsers', 'mergePipelinePinnedAt', 'withPipelineSharedMeta',
    'mergePipelineConfigForWrite', 'mergePipelineOneForWrite', 'pipelineConfigDifferenceIds',
    'deepEqualIgnoring', 'isBuiltinPipelineEntry', 'trustedPipelineViolations',
  ].map(item => (item.startsWith('const') ? item : extractServer(item))).join('\n');
  const ctx = { JSON, Object, Array, Set, Map, Number, String };
  vm.createContext(ctx);
  vm.runInContext(js + '\nthis.__fns={stripPipelineSharedMeta,mergePipelineFavoriteUsers,mergePipelinePinnedAt,withPipelineSharedMeta,mergePipelineConfigForWrite,mergePipelineOneForWrite,pipelineConfigDifferenceIds,deepEqualIgnoring,isBuiltinPipelineEntry,trustedPipelineViolations};', ctx);
  return ctx.__fns;
}

/* 内存磁盘假服务器：写盘=JSON 往返（文件语义），withStoreLock=promise 链串行；
   caller 模拟 dsh-auth-gate 会话身份（resolveRequestAuth 的结果），驱动可信/内置写校验。
   deferNextGet：挡住下一次 GET 直至放行并返回指定快照（模拟「请求发出早于保存落盘、响应晚到」的过期快照）；
   deferNextSaveOne：挡住下一次 save-one 直至放行（模拟保存在途）。 */
function makeServer(initialDisk, caller) {
  const fns = loadServerFns();
  let disk = JSON.parse(JSON.stringify(initialDisk));
  let lock = Promise.resolve();
  const state = { getGate: null, deferSaveOne: false, saveOneRelease: null };
  const withLock = job => { const run = lock.then(job); lock = run.then(() => {}, () => {}); return run; };
  /* 与 trustedPipelineWriteDeny（src/index.ts:698）同口径：非 admin 命中违规即 403 */
  const deny = (stored, merged) => {
    if (!caller || caller.isAdmin) return null;
    const v = fns.trustedPipelineViolations(stored, merged);
    if (!v.edit.length && !v.mark.length && !v.builtinEdit.length && !v.builtinCreate.length) return null;
    return { message: '可信/内置流水线仅 admin 可编辑', pipelineIds: [...new Set([...v.builtinEdit, ...v.edit, ...v.builtinCreate, ...v.mark])] };
  };
  const writeDisk = (config, history) => { disk = JSON.parse(JSON.stringify({ config, history: Array.isArray(history) ? history : [] })); };
  return {
    disk: () => JSON.parse(JSON.stringify(disk)),
    /* 下一次 GET 挂起，release() 时返回指定（过期）快照；release 闭包持有 gate 本体（处理器会把 state.getGate 置空） */
    deferNextGet: snapshot => { const gate = { snapshot: JSON.parse(JSON.stringify(snapshot)), release: null }; state.getGate = gate; return () => { if (gate.release) gate.release(); }; },
    deferNextSaveOne: () => { state.deferSaveOne = true; return () => { if (state.saveOneRelease) state.saveOneRelease(); }; },
    async handle(url, options) {
      const body = options && options.body ? JSON.parse(options.body) : {};
      if (url === '/api/worktable/pipeline' && (!options || !options.method || options.method === 'GET')) {
        let snapshot;
        if (state.getGate) { const gate = state.getGate; state.getGate = null; await new Promise(resolve => { gate.release = resolve; }); snapshot = gate.snapshot; }
        else snapshot = JSON.parse(JSON.stringify(disk.config || {}));
        return { ok: true, status: 200, json: async () => ({ config: JSON.parse(JSON.stringify(snapshot)), history: [] }) };
      }
      if (url === '/api/worktable/pipeline' && options && options.method === 'PUT') {
        return withLock(async () => {
          const diskCfg = disk.config && typeof disk.config === 'object' ? JSON.parse(JSON.stringify(disk.config)) : {};
          const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const baseConfig = body.baseConfig && typeof body.baseConfig === 'object' && !Array.isArray(body.baseConfig) ? body.baseConfig : null;
          const merged = baseConfig ? fns.mergePipelineConfigForWrite(config, baseConfig, diskCfg) : { config, conflicts: fns.pipelineConfigDifferenceIds(config, diskCfg) };
          if (merged.conflicts.length) return { ok: false, status: 409, json: async () => ({ error: 'pipeline config conflict', conflicts: merged.conflicts, config: diskCfg }) };
          const denied = deny(diskCfg, merged.config);
          if (denied) return { ok: false, status: 403, json: async () => ({ error: 'trusted', message: denied.message, pipelineIds: denied.pipelineIds }) };
          writeDisk(merged.config, disk.history);
          return { ok: true, status: 200, json: async () => ({ ok: true, config: JSON.parse(JSON.stringify(merged.config)) }) };
        });
      }
      if (url === '/api/worktable/pipeline/save-one' && options && (options.method === 'PUT' || options.method === 'POST')) {
        if (state.deferSaveOne) { state.deferSaveOne = false; await new Promise(resolve => { state.saveOneRelease = resolve; }); }
        return withLock(async () => {
          const diskCfg = disk.config && typeof disk.config === 'object' ? JSON.parse(JSON.stringify(disk.config)) : {};
          const pipeline = body.pipeline && typeof body.pipeline === 'object' && !Array.isArray(body.pipeline) ? body.pipeline : null;
          const id = pipeline && typeof pipeline.id === 'string' && pipeline.id ? pipeline.id : '';
          if (!pipeline || !id) return { ok: false, status: 400, json: async () => ({ error: 'invalid pipeline' }) };
          const basePipeline = body.basePipeline && typeof body.basePipeline === 'object' && !Array.isArray(body.basePipeline) ? body.basePipeline : null;
          const merged = fns.mergePipelineOneForWrite(pipeline, basePipeline, diskCfg);
          if (merged.conflicts.length) return { ok: false, status: 409, json: async () => ({ error: 'pipeline config conflict', conflicts: merged.conflicts, config: diskCfg }) };
          const config = merged.config;
          if (typeof body.scriptsDir === 'string' && body.scriptsDir.trim()) config.scriptsDir = body.scriptsDir.trim();
          const denied = deny(diskCfg, config);
          if (denied) return { ok: false, status: 403, json: async () => ({ error: 'trusted', message: denied.message, pipelineIds: denied.pipelineIds }) };
          writeDisk(config, disk.history);
          return { ok: true, status: 200, json: async () => ({ ok: true, config: JSON.parse(JSON.stringify(config)) }) };
        });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
}

/* ---------- 客户端：pipeline.html 真实函数装入 vm ---------- */
const CLIENT_FUNCTIONS = [
  'uniqueCopyName', 'copyPipeline',
  'historyPersistSig', 'reconcilePipelinesAfterSave', 'stripPipelineSharedMeta', 'mergePipelinesFromServer',
  'persistState', 'pushState', 'pushPipelineOne', 'savePipelines',
  'plOwnerOf', 'plEditable', 'pipelineFavoriteUsers',
  'pipelineDefaultStringList', 'normalizePipelineDefaults',
  'cleanScriptValues',
  'migrateGate', 'migrateStageUrl', 'migratePrefillDefaults', 'migratePipelineDefaults', 'migratePromPreset',
  'curPipeline', 'findPipeline',
  'loadPlDraft', 'clearPlDraft', 'savePlDraft',
  'applyPlFormReadOnly', 'openPlForm', 'savePlForm',
  'loadServerState', 'applyPipelineRefreshPayload', 'refreshPipelinesFromServer',
];

function makeClient(server, options) {
  const opts = options || {};
  const username = opts.username === undefined ? 'alice' : opts.username;
  const timers = [];
  const calls = { alerts: [], toasts: [], renders: 0, selects: [], confirms: 0 };
  const store = {};
  const els = {
    plForm: { style: { display: 'none' }, dataset: {}, inert: false },
    plFormTitle: { textContent: '' },
    plName: { value: '', disabled: false, focus() {} },
    scriptsDir: { value: '' },
    plSave: { style: {}, disabled: false, textContent: '保存' },
    plDraftTip: { textContent: '', style: {} },
    plStageAdd: { style: {} },
    plStageList: { children: [] },
    pipelineRefresh: { disabled: false },
  };
  const diskConfig = server.disk().config;
  const initialPipelines = JSON.parse(JSON.stringify(opts.pipelines || diskConfig.pipelines || []));
  const ctx = {
    Object, Array, Promise, String, Number, JSON, Set, Map, Date, Math, AbortController, RegExp, Boolean,
    console,
    /* 初始状态：默认本地与磁盘一致（模拟加载完成后的页面）；boot:true 模拟首屏加载在途 */
    pipelines: initialPipelines,
    serverConfigBase: opts.boot ? null : JSON.parse(JSON.stringify(diskConfig)),
    stateLoaded: !opts.boot,
    stateFetchEpoch: 0,
    persistTimer: null, persistInFlight: null, historySyncSig: '',
    currentUsername: username, authReady: true, currentUserIsAdmin: !!opts.isAdmin,
    running: false, curPipelineId: initialPipelines[0] ? initialPipelines[0].id : '',
    scriptsDir: '/srv/scripts', scriptsDirIsFallback: false,
    editStages: [], editDefaults: null, editFocusIdx: -1, editSelStage: null, plFormReadOnly: false,
    plDraftTimer: null, plDraftTipTimer: null,
    runStages: null, selectedId: null, replayRec: null,
    environments: [], repositories: [], buildNo: 0, themePref: 'auto',
    cleanupScript: null, checkScript: null, profilingScript: null,
    jenkins: {}, evaltok: {}, prom: {}, archiveDir: '', archiveScriptName: '', analysisPrompts: {},
    histClearedAt: 0, history: [],
    PRESET_BY_NAME: {},
    PIPELINE_DEFAULT_PRESET_KEYS: ['cleanup', 'check', 'profiling'],
    DEFAULT_PIPELINE_ID: 'pl-xds',
    $: id => els[id] || (els[id] = { value: '', checked: false, disabled: false, style: {}, dataset: {}, textContent: '', querySelectorAll: () => [] }),
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    alert: message => { calls.alerts.push(String(message)); },
    confirm: () => { calls.confirms += 1; return true; },
    toast: message => { calls.toasts.push(String(message)); },
    renderPipelines: () => { calls.renders += 1; },
    selectPipeline: id => { calls.selects.push(id); ctx.curPipelineId = id; ctx.persistState(); },
    renderFlow: () => {}, renderDetail: () => {}, resetNodes: () => {},
    /* selectPipeline 由桩承担（真实实现带大量运行视图依赖），其保存语义（persistState 防抖全量 PUT）保留 */
    collectConfig: () => ({ pipelines: ctx.pipelines, scriptsDir: ctx.scriptsDir }),
    historyForPersist: () => [],
    fetch: (url, options) => server.handle(url, options),
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    /* loadServerState/刷新的周边依赖桩（本组用例的种子 config 不触及的字段按恒等/空桩注入） */
    defaultPipeline: () => ({ id: 'pl-xds', name: '安装部署XDS', builtIn: true, stages: [{ id: 's0', name: '检出' }] }),
    normalizeEnv: e => e, normalizeRepo: r => r,
    maybeAdoptInstalledScriptsDir: () => {},
    renderCleanupParams: () => {}, renderCheckParams: () => {}, renderProfilingParams: () => {},
    renderAll: () => {}, migrateInlineLogs: () => {},
    /* openPlForm/savePlForm 的周边依赖桩（同 test_pipeline_owner_edit.js 的口径） */
    normalizeStageKind: s => s,
    evaltokensStageConfig: et => Object.assign({}, et),
    normalizePipelineProm: p => p || {},
    currentPipelineDefaultSeed: () => ({}),
    newStage: name => ({ id: '', name }),
    withPresetMarkers: stages => stages,
    renderPipelineDefaultForm: () => {},
    loadScripts: () => ({ then(cb) { cb(); } }),
    renderStageEditor: () => {},
    detectStageParams: () => null,
    detectEvaltokStageParams: () => null,
    scriptByName: () => null,
    stageIdFor: name => name || null,
    collectPipelineDefaultForm: () => ({}),
    saveScriptsDir: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(CLIENT_FUNCTIONS.map(extractClient).join('\n') + '\n' + extractClientOptional('fetchPipelineStateFresh'), ctx);
  const fireTimers = ms => timers.slice().forEach(t => { if (t.ms === ms && timers.indexOf(t) >= 0) t.fn(); });
  const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); };
  return { ctx, els, calls, timers, fireTimers, flush };
}

/* ---------- 测试数据 ---------- */
/* 种子数据：defaults 用编辑器保存后的归一化形态（normalizePipelineDefaults 的输出形状，与生产一致——
   迁移对它不再产生内容差异，本地与基线才能做到内容相等，陈旧快照的「误判远端删除」分支才会真实触发） */
function seedDisk() {
  const defaults = { environmentIds: [], repositoryId: '', branch: 'main', strategy: '', presets: [] };
  return {
    config: {
      pipelines: [
        { id: 'pl-xds', name: '安装部署XDS', builtIn: true, stages: [{ id: 's0', name: '检出', dur: 5, skip: false, sub: [], kind: 'simulate' }], defaults: JSON.parse(JSON.stringify(defaults)), createdBy: '', updatedBy: '' },
        { id: 'pl-src', name: '构建流水线', builtIn: false, stages: [{ id: 's1', name: '构建', dur: 5, skip: false, sub: [], kind: 'simulate' }], defaults: JSON.parse(JSON.stringify(defaults)), createdBy: 'bob', updatedBy: 'bob' },
      ],
      scriptsDir: '/srv/scripts',
      buildNo: 3,
    },
    history: [],
  };
}
const cloneOf = ctx => ctx.pipelines.find(p => p.id !== 'pl-xds' && p.id !== 'pl-src');
const diskClone = server => server.disk().config.pipelines.find(p => p.id !== 'pl-xds' && p.id !== 'pl-src');

test('复制副本改名保存：新名落盘、列表不回滚、不弹冲突告警', async () => {
  const server = makeServer(seedDisk(), { username: 'alice', isAdmin: false });
  const f = makeClient(server);

  await f.ctx.copyPipeline('pl-src');
  const clone = cloneOf(f.ctx);
  assert.ok(clone, '复制后本地存在副本');
  assert.equal(clone.name, '构建流水线（副本）');
  assert.equal(diskClone(server).name, '构建流水线（副本）', '复制的 save-one 已把副本落盘');

  /* 真实路径：列表「编辑」→ openPlForm（副本归属复制者本人，可编辑）→ 改名 → 保存 */
  f.ctx.openPlForm(clone.id);
  assert.equal(f.ctx.plFormReadOnly, false, '副本对复制者本人可编辑');
  f.els.plName.value = '构建流水线-我的定制';
  await f.ctx.savePlForm();

  assert.deepEqual(f.calls.alerts, [], '保存不得弹出任何告警（冲突/拦截）');
  assert.equal(cloneOf(f.ctx).name, '构建流水线-我的定制', '本地列表保留新名，不回滚为「（副本）」');
  assert.equal(diskClone(server).name, '构建流水线-我的定制', '新名落盘');
  const baseClone = f.ctx.serverConfigBase.pipelines.find(p => p.id === clone.id);
  assert.equal(baseClone && baseClone.name, '构建流水线-我的定制', '基线随保存确认前进到新名');
});

test('复制后防抖全量 PUT（selectPipeline 触发）走完再改名：基线与磁盘一致，改名落盘', async () => {
  const server = makeServer(seedDisk(), { username: 'alice', isAdmin: false });
  const f = makeClient(server);

  await f.ctx.copyPipeline('pl-src');
  const clone = cloneOf(f.ctx);
  f.fireTimers(400);   /* selectPipeline 触发的 400ms 防抖全量 PUT */
  await f.flush();

  f.ctx.openPlForm(clone.id);
  f.els.plName.value = '改名A';
  await f.ctx.savePlForm();

  assert.deepEqual(f.calls.alerts, [], '不得弹出冲突/失败告警');
  assert.equal(cloneOf(f.ctx).name, '改名A');
  assert.equal(diskClone(server).name, '改名A');
});

test('改名保存成功后手动刷新（loadServerState 三方合并）：新名保留', async () => {
  const server = makeServer(seedDisk(), { username: 'alice', isAdmin: false });
  const f = makeClient(server);

  await f.ctx.copyPipeline('pl-src');
  const clone = cloneOf(f.ctx);
  f.fireTimers(400);
  await f.flush();
  f.ctx.openPlForm(clone.id);
  f.els.plName.value = '改名后刷新';
  await f.ctx.savePlForm();
  assert.equal(diskClone(server).name, '改名后刷新');

  await f.ctx.loadServerState();   /* 自愈/重拉场景 */
  assert.equal(cloneOf(f.ctx).name, '改名后刷新', '重拉后新名不得被旧名覆盖');

  await f.ctx.refreshPipelinesFromServer();   /* 用户点「↻ 刷新」 */
  assert.equal(cloneOf(f.ctx).name, '改名后刷新', '手动刷新后新名不得被旧名覆盖');
});

test('复制的 save-one 在途期间就改名保存（慢链路）：串行排队后新名仍落盘', async () => {
  const server = makeServer(seedDisk(), { username: 'alice', isAdmin: false });
  const f = makeClient(server);

  const copying = f.ctx.copyPipeline('pl-src');
  const clone = cloneOf(f.ctx);
  f.ctx.openPlForm(clone.id);
  f.els.plName.value = '在途改名';
  const saving = f.ctx.savePlForm();
  await copying;
  await saving;
  await f.flush();

  assert.deepEqual(f.calls.alerts, [], '慢链路排队保存不得告警');
  assert.equal(cloneOf(f.ctx).name, '在途改名');
  assert.equal(diskClone(server).name, '在途改名');
});

/* 生产形态种子：内置 + 多条他人/未署名流水线，阶段带脚本绑定与参数 values（驱动迁移链 cleanScriptValues）、
   defaults 带完整字段，另含 pinned/favorite 元数据——等价真实存储的数据形状（不写死生产数据）。 */
function realShapeDisk() {
  const mkStage = (id, name, extra) => Object.assign({ id, name, dur: 5, skip: false, sub: [], kind: 'shell', script: { name: name + '.sh', path: '/srv/scripts/' + name + '.sh', lang: 'sh', params: [{ key: 'IMAGE_NAME', label: '镜像', required: true, def: '' }], values: { IMAGE_NAME: 'registry/example:' + id } } }, extra || {});
  const mk = (id, name, owner, extra) => Object.assign({
    id, name, builtIn: false,
    stages: [mkStage(id + '-a', '检出'), mkStage(id + '-b', '构建镜像', { parallel: true }), mkStage(id + '-c', '部署', { parallel: true })],
    defaults: { environmentIds: ['env-a'], repositoryId: 'repo-a', branch: 'main', strategy: '', presets: ['cleanup'] },
    createdBy: owner, updatedBy: owner,
  }, extra || {});
  const pipelines = [
    { id: 'pl-xds', name: '安装部署XDS', builtIn: true, stages: [{ id: 'x0', name: '环境清理', preset: true, pkey: 'cleanup' }, mkStage('x1', '拉取镜像', { kind: 'simulate', script: undefined })], defaults: { environmentIds: [], repositoryId: '', branch: 'main', strategy: '', presets: [] }, createdBy: '', updatedBy: '' },
  ];
  for (let i = 0; i < 72; i += 1) pipelines.push(mk('pl-u' + i, '用户流水线' + i, i % 3 === 0 ? '' : 'user' + (i % 7)));
  pipelines.push(mk('pl-muzm30ij', 'test（副本 2）', 'lihaifeng'));
  return { config: { pipelines, scriptsDir: '/srv/scripts', buildNo: 100 }, history: [] };
}

test('真实数据形状（74 条）+ 非 admin：复制内置流水线后改名，全链路无 409/403', async () => {
  const server = makeServer(realShapeDisk(), { username: 'zhouying', isAdmin: false });
  const f = makeClient(server);

  await f.ctx.copyPipeline('pl-xds');   /* 与生产最新一条副本（安装部署XDS（副本））同路径：复制内置 */
  const clone = f.ctx.pipelines[f.ctx.pipelines.length - 1];
  assert.equal(clone.builtIn, false);
  f.fireTimers(400);   /* selectPipeline 触发的防抖全量 PUT（真实数据 + 非 admin 走可信校验） */
  await f.flush();
  assert.deepEqual(f.calls.toasts, [], '全量 PUT 不得被 403/409 拦截');

  f.ctx.openPlForm(clone.id);
  assert.equal(f.ctx.plFormReadOnly, false);
  f.els.plName.value = '安装部署XDS-我的副本';
  await f.ctx.savePlForm();

  assert.deepEqual(f.calls.alerts, [], '改名保存不得告警');
  const onDisk = server.disk().config.pipelines.find(p => p.id === clone.id);
  assert.equal(onDisk && onDisk.name, '安装部署XDS-我的副本');
  assert.equal(f.ctx.pipelines.find(p => p.id === clone.id).name, '安装部署XDS-我的副本');
});

test('首屏竞态：复制的 save-one 先于首屏 GET 响应完成时，过期快照不得冲掉副本/污染基线，改名落盘', async () => {
  const server = makeServer(seedDisk(), { username: 'alice', isAdmin: false });
  const releaseGet = server.deferNextGet(server.disk().config);   /* 首屏 GET 挂起：响应将是「复制前」的过期快照 */
  const f = makeClient(server, { boot: true });   /* 首屏加载在途：stateLoaded=false、基线未建立 */

  const loading = f.ctx.loadServerState();   /* 首屏 GET 发出（到达闸门） */
  await f.flush();

  await f.ctx.copyPipeline('pl-src');   /* 复制的 save-one 先落盘，响应已把基线推进到「含副本」 */
  const clone = cloneOf(f.ctx);
  assert.ok(clone, '复制后本地存在副本');
  assert.ok(diskClone(server), '副本已落盘');

  releaseGet();   /* 首屏 GET 响应晚到（过期快照） */
  await loading;
  assert.ok(cloneOf(f.ctx), '过期首屏快照不得把刚落盘的副本误判为「远端已删除」而冲掉');
  assert.ok(f.ctx.serverConfigBase.pipelines.some(p => p.id === clone.id), '基线不得被过期快照污染成「无副本」');

  await f.ctx.refreshPipelinesFromServer();   /* 用户点「↻ 刷新」 */
  f.ctx.openPlForm(clone.id);
  assert.equal(f.ctx.plFormReadOnly, false);
  f.els.plName.value = '首屏竞态改名';
  await f.ctx.savePlForm();

  assert.deepEqual(f.calls.alerts, [], '改名保存不得再弹 phantom 冲突告警');
  assert.equal(cloneOf(f.ctx).name, '首屏竞态改名', '新名不得被还原为「（副本）」');
  assert.equal(diskClone(server).name, '首屏竞态改名', '新名落盘');
});

test('陈旧标签页（基线缺副本、磁盘有副本）改名：409 后基线自愈，重试即成功（不再永久锁死）', async () => {
  const server = makeServer(seedDisk(), { username: 'alice', isAdmin: false });
  const f1 = makeClient(server);   /* 另一个标签页/设备：复制并落盘 */
  await f1.ctx.copyPipeline('pl-src');
  await f1.flush();
  const cloneId = cloneOf(f1.ctx).id;

  /* 本标签页：列表已含副本（刷新同步过），但共同基线停在复制之前（典型：另一标签页复制后，本页从未保存） */
  const f = makeClient(server);
  const srcBase = f.ctx.serverConfigBase.pipelines.find(p => p.id === 'pl-src');
  f.ctx.serverConfigBase = { pipelines: [JSON.parse(JSON.stringify(srcBase))] };
  const clone = f.ctx.pipelines.find(p => p.id === cloneId);
  assert.ok(clone, '本页列表含副本');

  f.ctx.openPlForm(cloneId);
  f.els.plName.value = '陈旧页改名';
  await f.ctx.savePlForm();   /* 首次：baseOne=null ≠ 磁盘副本 → 409（phantom） */
  assert.equal(f.calls.alerts.length, 1, '首次保存按冲突告警一次');
  assert.match(f.calls.alerts[0], /其他浏览器修改/);
  assert.ok(f.ctx.serverConfigBase.pipelines.some(p => p.id === cloneId),
    '409 响应携带磁盘真值：基线须采纳自愈，后续保存不再永久 409 锁死');

  await f.ctx.savePlForm();   /* 重试（编辑器仍打开、名称输入仍是新名） */
  assert.equal(f.calls.alerts.length, 1, '重试不得再告警');
  assert.equal(diskClone(server).name, '陈旧页改名', '新名落盘');
  assert.equal(f.ctx.pipelines.find(p => p.id === cloneId).name, '陈旧页改名');
});

test('改名保存在途时点「↻ 刷新」：在途改名不得被刷新快照覆盖', async () => {
  const server = makeServer(seedDisk(), { username: 'alice', isAdmin: false });
  const f = makeClient(server);
  await f.ctx.copyPipeline('pl-src');
  f.fireTimers(400);
  await f.flush();
  const clone = cloneOf(f.ctx);

  const release = server.deferNextSaveOne();   /* 挡住下一次 save-one：改名保存保持在途 */
  f.ctx.openPlForm(clone.id);
  f.els.plName.value = '在途改名防覆盖';
  const saving = f.ctx.savePlForm();
  await f.flush();   /* 让 save-one 抵达闸门 */

  await f.ctx.refreshPipelinesFromServer();   /* 刷新：GET 返回的还是改名前的磁盘 */
  release();
  await saving;
  await f.flush();

  assert.equal(cloneOf(f.ctx).name, '在途改名防覆盖', '刷新不得把在途改名冲掉（本地不得回退旧名）');
  assert.equal(diskClone(server).name, '在途改名防覆盖');
});
