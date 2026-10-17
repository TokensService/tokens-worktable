/* 节点环境（environments）多用户并发保存修复的页面侧测试：
   - mergeEnvironmentsFromServer：loadServerState 的按 id 三方合并（替代整表替换），
     本地未落盘新增/修改不被自愈重拉冲掉，他端增删改照常同步；
   - loadServerState：环境列表改走三方合并（服务端有非空 environments 时）；
   - pushState：baseConfig 携带 environments 基线供服务端按 id 合并；
     保存确认后按响应协调 environments（他端并发新增合入、在途改动保留）。 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = require('./_page-source.cjs').loadPageSource();

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
const J = x => JSON.parse(JSON.stringify(x));

const env = (id, name, extra) => Object.assign({ id, name, ip: '10.0.0.1', nodeIp: '', llmAddr: '', user: '', pass: '' }, extra);
const normalizeEnv = e => ({ id: e.id, name: e.name, ip: e.ip, nodeIp: e.nodeIp || '', llmAddr: e.llmAddr || '', user: e.user || '', pass: e.pass || '' });

/* ---------- mergeEnvironmentsFromServer 单元口径 ---------- */
function mergeCtx() {
  const ctx = { normalizeEnv };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('sameEnvEntry') + '\n' + extractFunction('mergeEnvironmentsFromServer'), ctx);
  return ctx;
}

test('mergeEnvironmentsFromServer：本地未落盘新增保留（追加末尾），他端新增/修改/删除同步', () => {
  const ctx = mergeCtx();
  const base = [env('env-1', '节点一'), env('env-2', '节点二'), env('env-3', '节点三')];
  const local = [env('env-1', '节点一'), env('env-2', '节点二'), env('env-3', '节点三'), env('env-new', '本页刚加未落盘')];
  const remote = [env('env-1', '节点一-他端改名'), env('env-3', '节点三'), env('env-theirs', '他端新增')];   // 他端改 1、删 2、增 theirs

  const out = ctx.mergeEnvironmentsFromServer(base, local, remote);

  assert.deepEqual(J(out).map(e => e.id), ['env-1', 'env-3', 'env-theirs', 'env-new'], '远端序在前，本地新增追加');
  assert.equal(out[0].name, '节点一-他端改名', '本地未改动条目以远端为准');
  assert.equal(out[3].name, '本页刚加未落盘', '本地未落盘新增不被冲掉');
  assert.deepEqual(out[3], local[3], '本地新增保持本地条目对象形态（未经 normalizeEnv 改写）');
});

test('mergeEnvironmentsFromServer：远端已删而本地有改动（保存在途）的条目保留本地；在途删除不被远端旧值复活', () => {
  const ctx = mergeCtx();
  /* 远端删 env-2、本地恰好在改 env-2 → 保留本地 */
  const out1 = ctx.mergeEnvironmentsFromServer(
    [env('env-1', '一'), env('env-2', '二')],
    [env('env-1', '一'), env('env-2', '二', { pass: 'changed' })],
    [env('env-1', '一')],
  );
  assert.deepEqual(J(out1).map(e => e.id), ['env-1', 'env-2']);
  assert.equal(out1[1].pass, 'changed');

  /* 本地在途删除 env-1（本地列表已无）、远端仍是基线旧值 → 维持删除 */
  const out2 = ctx.mergeEnvironmentsFromServer(
    [env('env-1', '一'), env('env-2', '二')],
    [env('env-2', '二')],
    [env('env-1', '一'), env('env-2', '二')],
  );
  assert.deepEqual(J(out2).map(e => e.id), ['env-2'], '本地在途删除不被远端旧值复活');

  /* 本地在途删除、但远端已改 → 服务端为准恢复远端版 */
  const out3 = ctx.mergeEnvironmentsFromServer(
    [env('env-1', '一')],
    [],
    [env('env-1', '一-他端改')],
  );
  assert.deepEqual(J(out3).map(e => [e.id, e.name]), [['env-1', '一-他端改']]);
});

test('mergeEnvironmentsFromServer：双边都改且内容不一致取远端（服务端为准）；条目比对与键序/多余字段无关', () => {
  const ctx = mergeCtx();
  const out = ctx.mergeEnvironmentsFromServer(
    [env('env-1', '原始')],
    [env('env-1', '本地改')],
    [{ pass: '', user: 'root', ip: '10.0.0.1', name: '远端改', id: 'env-1', nodeIp: '', extra: 'drop' }],   // 键序打乱 + 多余字段
  );
  assert.deepEqual(J(out).map(e => [e.id, e.name]), [['env-1', '远端改']]);
  assert.ok(!('extra' in out[0]), '远端条目经 normalizeEnv 归一，多余字段剔除');
  assert.equal(out[0].nodeIp, '');
  assert.equal(out[0].llmAddr, '', '缺省 llmAddr 归一为空串');
});

test('mergeEnvironmentsFromServer：仅 llmAddr 改动也算本端改动（条目比对含 llmAddr），自愈重拉不丢', () => {
  const ctx = mergeCtx();
  /* 基线 == 远端（他端未动），本地仅给 env-1 填了 LLM服务地址 → 保留本地 */
  const out = ctx.mergeEnvironmentsFromServer(
    [env('env-1', '节点一')],
    [env('env-1', '节点一', { llmAddr: '10.0.0.1:8000' })],
    [env('env-1', '节点一')],
  );
  assert.equal(out[0].llmAddr, '10.0.0.1:8000', '本地在途 llmAddr 修改不被重拉冲掉');

  /* 反向：他端改 llmAddr、本地未改 → 取远端 */
  const out2 = ctx.mergeEnvironmentsFromServer(
    [env('env-1', '节点一')],
    [env('env-1', '节点一')],
    [env('env-1', '节点一', { llmAddr: '10.0.0.1:9000' })],
  );
  assert.equal(out2[0].llmAddr, '10.0.0.1:9000', '他端 llmAddr 修改照常同步');
});

/* ---------- loadServerState：环境列表按 id 三方合并（替代整表替换） ---------- */
function loadStateFixture(serverConfig, seeds) {
  const storage = {};
  const ctx = {
    persistInFlight: null, stateFetchEpoch: 0, stateLoaded: false,
    serverConfigBase: seeds.base,
    DEFAULT_PIPELINE_ID: 'pl-xds',
    defaultPipeline: () => ({ id: 'pl-xds', name: '内置', builtIn: true, stages: [{ id: 's0' }] }),
    /* 内置注册表重组/脚本路径回填桩：本组用例不验证多内置重组（专项见 test_pipeline_builtin_vllm.js），按单内置口径处理 */
    regroupBuiltinPipelines: (list) => { const l = Array.isArray(list) ? list : []; return [l.find(p => p && p.builtIn && p.id === 'pl-xds') || { id: 'pl-xds', name: '内置', builtIn: true, stages: [{ id: 's0' }] }].concat(l.filter(p => p && !p.builtIn)); },
    rebindBuiltinScriptPaths: () => {},
    migrateGate: p => p, migrateStageUrl: p => p, migratePrefillDefaults: p => p, migratePipelineDefaults: p => p, migratePromPreset: p => p,
    normalizeEnv, normalizeRepo: r => r,
    pipelines: [], environments: seeds.localEnvs || [], repositories: [],
    scriptsDir: '/srv/scripts', scriptsDirIsFallback: false,
    maybeAdoptInstalledScriptsDir: () => {},
    themePref: 'auto', buildNo: 1,
    cleanupScript: null, checkScript: null, profilingScript: null,
    jenkins: {}, evaltok: {}, prom: {}, archiveDir: '', archiveScriptName: '', analysisPrompts: {},
    histClearedAt: 0, history: [],
    historyMarkSynced: () => {},
    curPipelineId: 'pl-xds', selectedEnvIds: null, curRepoId: '',
    schedEnvIds: null, histFilter: { kw: '', status: '', pipeline: '' },
    plFilter: { kw: '', owner: 'mine', favorite: 'all' },
    histPageSize: 10, plPageSize: 10,
    runStages: null, selectedId: null, legacyLocalKeys: {},
    $: id => ({ value: '', checked: false, style: {}, textContent: '', dataset: {} }),
    renderCleanupParams: () => {}, renderCheckParams: () => {}, renderProfilingParams: () => {},
    renderAll: () => {}, migrateInlineLogs: () => {}, persistState: () => {},
    curPipeline: () => ({ stages: [{ id: 's0' }] }),
    localStorage: { getItem: () => null, setItem: (k, v) => { storage[k] = String(v); }, removeItem: k => { delete storage[k]; } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ config: J(serverConfig), history: [] }) }),
  };
  vm.createContext(ctx);
  vm.runInContext(['stripPipelineSharedMeta', 'mergePipelinesFromServer', 'sameEnvEntry', 'mergeEnvironmentsFromServer',
    'sameRepoEntry', 'mergeRepositoriesFromServer',
    'fetchPipelineStateFresh', 'normalizeEnv', 'normalizeRepo', 'curPipeline', 'plOwnerFilterLabel', 'envConfigEditable', 'loadServerState',
  ].map(extractFunction).join('\n'), ctx);
  return { ctx, storage };
}

test('loadServerState：409 自愈重拉不再冲掉本地刚添加未落盘的节点；他端新增同步进来', async () => {
  const f = loadStateFixture(
    { pipelines: [{ id: 'pl-xds', name: '内置', builtIn: true, stages: [{ id: 's0' }] }],
      environments: [env('env-1', '节点一'), env('env-theirs', '他端新增')] },
    { base: { pipelines: [], environments: [env('env-1', '节点一')] },
      localEnvs: [env('env-1', '节点一'), env('env-mine', '本页刚加未落盘')] },
  );

  await f.ctx.loadServerState();

  assert.deepEqual(J(f.ctx.environments).map(e => e.id), ['env-1', 'env-theirs', 'env-mine'], '他端新增同步 + 本地未落盘新增保留');
  assert.deepEqual(J(f.ctx.serverConfigBase.environments).map(e => e.id), ['env-1', 'env-theirs'], '基线整份换为响应快照');
  assert.deepEqual(J(JSON.parse(f.storage['pip-envs'])).map(e => e.id), ['env-1', 'env-theirs', 'env-mine'], '离线缓存同步合并结果');
});

/* ---------- pushState：environments 基线上送 + 保存确认后协调 ---------- */
function pushFixture(response, opts) {
  const requests = [];
  const timers = [];
  const baseConfig = { pipelines: [], environments: [env('env-1', '节点一')], theme: 'dark' };
  const ctx = {
    stateLoaded: true,
    serverConfigBase: baseConfig,
    persistTimer: null,
    persistInFlight: null,
    stateFetchEpoch: 0,
    collectConfig: () => ({ pipelines: [], environments: ctx.environments, theme: 'dark' }),
    historyForPersist: () => [],
    historySyncSig: '',
    loadServerState: async () => {},
    normalizeEnv,
    pipelines: [],
    environments: (opts && opts.localEnvs) || [env('env-1', '节点一'), env('env-mine', '本端新增')],
    localStorage: { setItem: (k, v) => { (ctx.__storage = ctx.__storage || {})[k] = String(v); } },
    migrateGate: v => v, migrateStageUrl: v => v, migratePrefillDefaults: v => v, migratePipelineDefaults: v => v, migratePromPreset: v => v,
    regroupBuiltinPipelines: (list) => list,   /* 内置重组桩：本组用例不涉内置（专项见 test_pipeline_builtin_vllm.js） */
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (opts && opts.mutateDuringFlight) opts.mutateDuringFlight(ctx);
      return response;
    },
    AbortController,
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('historyPersistSig') + '\n' + extractFunction('reconcilePipelinesAfterSave') + '\n' + extractFunction('pushState'), ctx);
  return { ctx, requests, baseConfig };
}

test('pushState：baseConfig 携带 environments 基线；保存确认后他端新增合入本页并同步离线缓存', async () => {
  const merged = { pipelines: [], environments: [env('env-1', '节点一'), env('env-theirs', '他端新增'), env('env-mine', '本端新增')], theme: 'dark' };
  const f = pushFixture({ ok: true, status: 200, json: async () => ({ ok: true, config: J(merged) }) });

  const result = await f.ctx.pushState();

  assert.equal(result.ok, true);
  const body = JSON.parse(f.requests[0].options.body);
  assert.deepEqual(J(body.baseConfig), { pipelines: [], environments: [env('env-1', '节点一')], repositories: [] }, 'environments/repositories 基线随保存上送（供服务端按 id 三方合并）');
  assert.deepEqual(J(f.ctx.environments).map(e => e.id), ['env-1', 'env-theirs', 'env-mine'], '服务端合并结果（含他端并发新增）合回本页');
  assert.deepEqual(J(JSON.parse(f.ctx.__storage['pip-envs'])).map(e => e.id), ['env-1', 'env-theirs', 'env-mine'], '离线缓存同步');
  assert.deepEqual(J(f.ctx.serverConfigBase.environments).map(e => e.id), ['env-1', 'env-theirs', 'env-mine'], '基线随保存确认前进');
});

test('pushState：请求在途期间本页继续添加的节点不被保存响应覆盖', async () => {
  const merged = { pipelines: [], environments: [env('env-1', '节点一'), env('env-mine', '本端新增')], theme: 'dark' };
  const f = pushFixture(
    { ok: true, status: 200, json: async () => ({ ok: true, config: J(merged) }) },
    { mutateDuringFlight: ctx => { ctx.environments = ctx.environments.concat([env('env-inflight', '在途新增')]); } },
  );

  const result = await f.ctx.pushState();

  assert.equal(result.ok, true);
  assert.deepEqual(J(f.ctx.environments).map(e => e.id), ['env-1', 'env-mine', 'env-inflight'], '在途改动（合并后新增）保留在合并结果末尾');
});
