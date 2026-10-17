/* 代码仓（repositories）多用户并发保存修复的页面侧测试：
   - mergeRepositoriesFromServer：loadServerState 的按 id 三方合并（替代整表替换），
     本地未落盘新增/修改不被自愈重拉冲掉，他端增删改照常同步；
   - loadServerState：代码仓列表改走三方合并（服务端有非空 repositories 时）；
   - pushState：baseConfig 携带 repositories 基线供服务端按 id 合并；
     保存确认后按响应协调 repositories（他端并发新增合入、在途改动保留）。 */
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

const normalizeFetchMode = m => m === 'browser' ? 'browser' : (m === 'jenkins-server' ? 'jenkins-server' : ((m === 'jenkins' || m === 'jenkins-browser') ? 'jenkins-browser' : 'server'));
const normalizeRepo = r => ({ id: r.id, name: r.name, url: r.url || '', user: r.user || '', pass: r.pass || '', fetchMode: normalizeFetchMode(r.fetchMode), jenkinsJob: r.jenkinsJob || '', strategyUrl: r.strategyUrl || '', strategyMode: r.strategyMode === 'script' ? 'script' : 'url', strategyScript: r.strategyScript || '' });
const repo = (id, name, extra) => Object.assign({ id, name, url: 'https://git.example.com/' + name + '.git', user: '', pass: '', fetchMode: 'server', jenkinsJob: '', strategyUrl: '', strategyMode: 'url', strategyScript: '' }, extra);

/* ---------- mergeRepositoriesFromServer 单元口径 ---------- */
function mergeCtx() {
  const ctx = { normalizeRepo };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('sameRepoEntry') + '\n' + extractFunction('mergeRepositoriesFromServer'), ctx);
  return ctx;
}

test('mergeRepositoriesFromServer：本地未落盘新增保留（追加末尾），他端新增/修改/删除同步', () => {
  const ctx = mergeCtx();
  const base = [repo('r-1', '仓一'), repo('r-2', '仓二'), repo('r-3', '仓三')];
  const local = [repo('r-1', '仓一'), repo('r-2', '仓二'), repo('r-3', '仓三'), repo('r-new', '本页刚加未落盘')];
  const remote = [repo('r-1', '仓一-他端改名'), repo('r-3', '仓三'), repo('r-theirs', '他端新增')];   // 他端改 1、删 2、增 theirs

  const out = ctx.mergeRepositoriesFromServer(base, local, remote);

  assert.deepEqual(J(out).map(r => r.id), ['r-1', 'r-3', 'r-theirs', 'r-new'], '远端序在前，本地新增追加');
  assert.equal(out[0].name, '仓一-他端改名', '本地未改动条目以远端为准');
  assert.equal(out[3].name, '本页刚加未落盘', '本地未落盘新增不被冲掉');
});

test('mergeRepositoriesFromServer：远端已删而本地有改动（保存在途）的条目保留本地；在途删除不被远端旧值复活', () => {
  const ctx = mergeCtx();
  /* 远端删 r-2、本地恰好在改 r-2 → 保留本地 */
  const out1 = ctx.mergeRepositoriesFromServer(
    [repo('r-1', '一'), repo('r-2', '二')],
    [repo('r-1', '一'), repo('r-2', '二', { pass: 'changed' })],
    [repo('r-1', '一')],
  );
  assert.deepEqual(J(out1).map(r => r.id), ['r-1', 'r-2']);
  assert.equal(out1[1].pass, 'changed');

  /* 本地在途删除 r-1（本地列表已无）、远端仍是基线旧值 → 维持删除 */
  const out2 = ctx.mergeRepositoriesFromServer(
    [repo('r-1', '一'), repo('r-2', '二')],
    [repo('r-2', '二')],
    [repo('r-1', '一'), repo('r-2', '二')],
  );
  assert.deepEqual(J(out2).map(r => r.id), ['r-2'], '本地在途删除不被远端旧值复活');

  /* 本地在途删除、但远端已改 → 服务端为准恢复远端版 */
  const out3 = ctx.mergeRepositoriesFromServer(
    [repo('r-1', '一')],
    [],
    [repo('r-1', '一-他端改')],
  );
  assert.deepEqual(J(out3).map(r => [r.id, r.name]), [['r-1', '一-他端改']]);
});

test('mergeRepositoriesFromServer：双边都改且内容不一致取远端（服务端为准）；条目比对与键序/多余字段无关', () => {
  const ctx = mergeCtx();
  /* 双边都改且不一致 → 取远端 */
  const out1 = ctx.mergeRepositoriesFromServer(
    [repo('r-1', '原始')],
    [repo('r-1', '本地改')],
    [repo('r-1', '远端改')],
  );
  assert.equal(out1[0].name, '远端改', '双边都改取远端（同步语义下服务端为准）');

  /* 键序/多余字段不影响比对——视为未改动，取远端 */
  const out2 = ctx.mergeRepositoriesFromServer(
    [{ id: 'r-1', name: '仓一', url: 'u', user: '', pass: '', fetchMode: 'server', legacy: 'x' }],
    [{ pass: '', user: '', url: 'u', name: '仓一', id: 'r-1', fetchMode: 'server', strategyUrl: '', strategyMode: 'url', strategyScript: '', jenkinsJob: '' }],
    [repo('r-1', '远端改')],
  );
  assert.equal(out2[0].name, '远端改', '键序不同的等价条目视为未改动');
});

test('mergeRepositoriesFromServer：空 pass 的本地令牌——本地相对基线有改动（令牌填充）时保留本地（回填语义同在途修改）', () => {
  const ctx = mergeCtx();
  /* 基线 pass 为空、本地填了令牌、远端仍空 → 本地改动相对基线生效（保留本地令牌） */
  const out1 = ctx.mergeRepositoriesFromServer(
    [repo('r-1', '仓一')],                           // base: pass:''
    [repo('r-1', '仓一', { pass: 'local-token' })],  // local: 填了令牌
    [repo('r-1', '仓一', { pass: '' })],             // remote: 仍空
  );
  assert.equal(out1[0].pass, 'local-token', '本地相对基线的 pass 改动保留（远端未改）');

  /* 基线与本地同为令牌、远端空 → 本地未改取远端（空），交由 loadServerState 迁移回填 */
  const out2 = ctx.mergeRepositoriesFromServer(
    [repo('r-1', '仓一', { pass: 'local-token' })],  // base: 已有令牌
    [repo('r-1', '仓一', { pass: 'local-token' })],  // local: 未改
    [repo('r-1', '仓一', { pass: '' })],             // remote: 空
  );
  assert.equal(out2[0].pass, '', '本地未改取远端（空 pass），回填由 loadServerState 迁移逻辑做');
});

test('sameRepoEntry：规范字段（含 fetchMode/strategyUrl/strategyMode/strategyScript/jenkinsJob）全部参与比对', () => {
  const ctx = mergeCtx();
  const a = repo('r-1', '仓一');
  assert.ok(ctx.sameRepoEntry(a, repo('r-1', '仓一')), '同内容相等');
  assert.ok(!ctx.sameRepoEntry(a, repo('r-1', '仓一', { strategyUrl: 'http://x' })), 'strategyUrl 不同则不等');
  assert.ok(!ctx.sameRepoEntry(a, repo('r-1', '仓一', { strategyMode: 'script' })), 'strategyMode 不同则不等');
  assert.ok(!ctx.sameRepoEntry(a, repo('r-1', '仓一', { strategyScript: 's.sh' })), 'strategyScript 不同则不等');
  assert.ok(!ctx.sameRepoEntry(a, repo('r-1', '仓一', { fetchMode: 'browser' })), 'fetchMode 不同则不等');
  assert.ok(!ctx.sameRepoEntry(a, repo('r-1', '仓一', { jenkinsJob: 'job' })), 'jenkinsJob 不同则不等');
  assert.ok(!ctx.sameRepoEntry(a, repo('r-1', '仓一', { pass: 'tok' })), 'pass 不同则不等');
});

/* ---------- loadServerState：代码仓改走三方合并 ---------- */
function plXds() { return { id: 'pl-xds', name: '安装部署XDS', builtIn: true, stages: [{ id: 's0', name: '检出' }] }; }

function loadStateFixture(serverConfig, opts) {
  opts = opts || {};
  const storage = Object.assign({}, opts.storage);
  const calls = { persist: 0, renderAll: 0 };
  const els = {};
  const ctx = {
    persistInFlight: null, stateFetchEpoch: 0, stateLoaded: false,
    _migratedPersistDone: false,
    reposSeededByDefault: opts.reposSeeded || false,
    serverConfigBase: opts.base !== undefined ? opts.base : null,
    DEFAULT_PIPELINE_ID: 'pl-xds',
    defaultPipeline: plXds,
    regroupBuiltinPipelines: (list) => { const l = Array.isArray(list) ? list : []; return [l.find(p => p && p.builtIn && p.id === 'pl-xds') || plXds()].concat(l.filter(p => p && !p.builtIn)); },
    rebindBuiltinScriptPaths: () => { },
    builtinSeedOmittable: () => false,
    migrateGate: p => p, migrateStageUrl: p => p, migratePrefillDefaults: p => p, migratePipelineDefaults: p => p, migratePromPreset: p => p,
    pipelines: opts.localPipelines || [plXds()],
    environments: [], repositories: opts.localRepos || [],
    scriptsDir: '/srv/scripts', scriptsDirIsFallback: false,
    maybeAdoptInstalledScriptsDir: () => { },
    themePref: 'auto', buildNo: 1,
    cleanupScript: null, checkScript: null, profilingScript: null,
    jenkins: {}, evaltok: {}, prom: {}, archiveDir: '', archiveScriptName: '', analysisPrompts: {},
    histClearedAt: 0, history: [],
    historyMarkSynced: () => { },
    curPipelineId: opts.curPipelineId !== undefined ? opts.curPipelineId : 'pl-xds',
    selectedEnvIds: opts.selectedEnvIds !== undefined ? opts.selectedEnvIds : null,
    curRepoId: opts.curRepoId || '',
    schedEnvIds: opts.schedEnvIds !== undefined ? opts.schedEnvIds : null,
    histFilter: opts.histFilter || { kw: '', status: '', pipeline: '' },
    plFilter: opts.plFilter || { kw: '', owner: 'mine', favorite: 'all' },
    histPageSize: opts.histPageSize || 10, plPageSize: opts.plPageSize || 10,
    runStages: null, selectedId: null, nodes: {}, curRun: null,
    legacyLocalKeys: opts.legacy || {},
    $: id => els[id] || (els[id] = { value: '', checked: false, style: {}, textContent: '', dataset: {} }),
    renderCleanupParams: () => { }, renderCheckParams: () => { }, renderProfilingParams: () => { },
    renderAll: () => { calls.renderAll += 1; }, migrateInlineLogs: () => { },
    persistState: () => { calls.persist += 1; },
    localStorage: { getItem: k => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: k => { delete storage[k]; } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ config: JSON.parse(JSON.stringify(serverConfig)), history: [] }) }),
  };
  vm.createContext(ctx);
  vm.runInContext(['stripPipelineSharedMeta', 'mergePipelinesFromServer', 'mergeRepositoriesFromServer', 'fetchPipelineStateFresh',
    'normalizeFetchMode', 'normalizeEnv', 'normalizeRepo', 'sameRepoEntry', 'curPipeline', 'plOwnerFilterLabel', 'envConfigEditable', 'loadServerState',
    'loadServerBaseLS', 'markServerBaseConfirmed',
  ].map(extractFunction).join('\n'), ctx);
  return { ctx, calls, storage, els };
}

test('loadServerState：代码仓走三方合并——本地未落盘新增不被冲掉，他端改动同步进来', async () => {
  const f = loadStateFixture({
    pipelines: [plXds()],
    repositories: [repo('r-1', '仓一-他端改名'), repo('r-theirs', '他端新增')],
  }, {
    localRepos: [repo('r-1', '仓一'), repo('r-new', '本页刚加未落盘')],
    base: { repositories: [repo('r-1', '仓一')] },
  });
  await f.ctx.loadServerState();
  const repos = J(f.ctx.repositories);
  assert.deepEqual(repos.map(r => r.id), ['r-1', 'r-theirs', 'r-new'], '远端序在前 + 本地新增追加');
  assert.equal(repos[0].name, '仓一-他端改名', '本地未改动条目以远端为准');
  assert.equal(repos[2].name, '本页刚加未落盘', '本地未落盘新增不被冲掉');
});

test('loadServerState：服务端空令牌 + 本地有同 id 令牌 → 三方合并后回填迁移', async () => {
  const f = loadStateFixture({
    pipelines: [plXds()],
    repositories: [repo('r-1', '仓一', { pass: '' })],
  }, {
    localRepos: [repo('r-1', '仓一', { pass: 'local-token' })],
    base: { repositories: [repo('r-1', '仓一', { pass: 'local-token' })] },
  });
  await f.ctx.loadServerState();
  assert.equal(f.ctx.repositories[0].pass, 'local-token', '三方合并后空 pass 回填本地令牌');
  assert.equal(f.calls.persist, 1, 'pass 迁移标记 migrated → 回推一次');
});

test('loadServerState：旧版无 repositories 基线时（base 无键），三方合并保留双方条目（离线数据 + 服务端数据并集）', async () => {
  const f = loadStateFixture({
    pipelines: [plXds()],
    repositories: [repo('r-1', '服务端仓'), repo('r-2', '服务端仓二')],
  }, {
    localRepos: [repo('r-local', '本地未落盘')],
    base: {},   // 旧基线无 repositories 键 → prevBaseRepositories = []
  });
  await f.ctx.loadServerState();
  const repos = J(f.ctx.repositories);
  assert.deepEqual(repos.map(r => r.id).sort(), ['r-1', 'r-2', 'r-local'], '空基线三方合并 = 双方并集（离线数据不丢，服务端数据同步进来）');
});

/* ---------- pushState：baseConfig 携带 repositories 基线 + 保存确认后协调 repositories ---------- */
function pushStateFixture(opts) {
  opts = opts || {};
  const storage = {};
  const putBodies = [];
  const ctx = {
    persistInFlight: null, persistTimer: null,
    stateLoaded: opts.stateLoaded !== undefined ? opts.stateLoaded : true,
    stateFetchEpoch: 0,
    serverConfigBase: opts.base || null,
    historySyncSig: '',
    _migratedPersistDone: false,
    builtinSeedOmittable: () => false,
    pipelines: opts.pipelines || [plXds()],
    environments: opts.environments || [],
    repositories: opts.repositories || [],
    scriptsDir: '/srv/scripts', themePref: 'auto', buildNo: 1,
    cleanupScript: null, checkScript: null, profilingScript: null, customPresets: [],
    jenkins: {}, evaltok: {}, prom: {}, archiveDir: '', archiveScriptName: '', analysisPrompts: {}, histClearedAt: 0,
    schedEnvIds: [], histFilter: { kw: '', status: '', pipeline: '' }, plFilter: { kw: '', owner: 'mine', favorite: 'all' },
    histPageSize: 10, plPageSize: 10,
    history: [], historyForPersist: () => [],
    historyPersistSig: () => 'sig', historyMarkSynced: () => { },
    reconcilePipelinesAfterSave: (submitted, accepted, current) => {
      /* 简化版协调：submitted 与 current 一致（在途无改动）→ 取 accepted；否则保留 current */
      const s = JSON.stringify((submitted || []).map(x => x && x.id).sort());
      const c = JSON.stringify((current || []).map(x => x && x.id).sort());
      return s === c ? (accepted || []) : (current || []);
    },
    regroupBuiltinPipelines: list => list,
    migrateGate: p => p, migrateStageUrl: p => p, migratePrefillDefaults: p => p, migratePipelineDefaults: p => p, migratePromPreset: p => p,
    normalizeEnv: e => e, normalizeRepo: r => r,
    renderRepos: () => { }, renderRepoOptions: () => { },
    localStorage: { setItem: (k, v) => { storage[k] = String(v); }, getItem: k => storage[k] || null },
    $: () => ({ value: '', checked: false, style: {} }),
    loadServerState: async () => { ctx.stateLoaded = true; },
    fetch: async (url, options) => {
      if (options && options.method === 'PUT') {
        putBodies.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, config: opts.responseConfig || JSON.parse(options.body).config }) };
      }
      return { ok: true, status: 200, json: async () => ({ config: {}, history: [] }) };
    },
  };
  /* AbortController / setTimeout / clearTimeout 桩 */
  ctx.AbortController = class { constructor() { this.signal = {}; } abort() { } };
  ctx.setTimeout = (fn, ms) => 0;
  ctx.clearTimeout = () => { };
  vm.createContext(ctx);
  vm.runInContext(['collectConfig', 'historyForPersist', 'historyPersistSig', 'pushState', 'markServerBaseConfirmed'].map(extractFunction).join('\n'), ctx);
  return { ctx, putBodies, storage };
}

test('pushState：baseConfig 携带 repositories 基线（供服务端按 id 三方合并）', async () => {
  const baseRepos = [repo('r-1', '仓一')];
  const f = pushStateFixture({
    repositories: [repo('r-1', '仓一'), repo('r-2', '本端新增')],
    base: { pipelines: [], environments: [], repositories: baseRepos },
    responseConfig: { repositories: [repo('r-1', '仓一'), repo('r-2', '本端新增')] },
  });
  await f.ctx.pushState();
  assert.equal(f.putBodies.length, 1);
  assert.deepEqual(J(f.putBodies[0].baseConfig.repositories), J(baseRepos), 'baseConfig.repositories 携带共同基线');
});

/* ---------- 基线随会话持久化 + 在途改动重载保留（「刷新丢改动」修复） ---------- */

test('loadServerState：基线持久化——GET 应用后把 serverConfigBase 写入 localStorage（pip-server-base），供重载识别在途改动', async () => {
  const serverConfig = { pipelines: [plXds()], repositories: [repo('r-1', '仓一')] };
  const f = loadStateFixture(serverConfig, {});
  assert.equal(f.ctx.serverConfigBase, null, '启动时无基线');
  await f.ctx.loadServerState();
  assert.ok(f.storage['pip-server-base'], 'GET 应用后基线写入 localStorage');
  assert.deepEqual(JSON.parse(f.storage['pip-server-base']), serverConfig, '持久化内容 = 服务端确认快照');
  assert.equal(f.calls.persist, 0, '本地与服务端一致：不排写');
});

test('loadServerState：重载后（基线自 localStorage 恢复）在途修改保留 + 回推一次补送——刷新不再丢改动', async () => {
  /* 场景：上次会话编辑 r-1 令牌后保存失败（PUT 未落盘），页面重载；基线（旧确认快照）自 pip-server-base
     恢复 → 三方合并识别「本地≠基线而远端==基线」→ 保留本地改动并标记 migrated 回推一次。 */
  const f = loadStateFixture(
    { pipelines: [plXds()], repositories: [repo('r-1', '仓一')] },   // 服务端仍是旧值
    {
      localRepos: [repo('r-1', '仓一', { pass: 'edited-token' })],   // localStorage 离线缓存带在途修改
      base: { repositories: [repo('r-1', '仓一')] },                 // 重载时恢复的持久化基线
    });
  await f.ctx.loadServerState();
  assert.equal(f.ctx.repositories[0].pass, 'edited-token', '在途修改不被「双边都改取服务端」回滚');
  assert.equal(f.calls.persist, 1, '检测到未同步的本地改动：回推一次补送服务端');
  assert.ok(JSON.parse(f.storage['pip-repos'])[0].pass === 'edited-token', '离线缓存保留在途值（不被旧值覆盖）');
});

test('loadServerState：重载后在途新增（本地新增未落盘）保留 + 回推一次', async () => {
  const f = loadStateFixture(
    { pipelines: [plXds()], repositories: [repo('r-1', '仓一')] },
    {
      localRepos: [repo('r-1', '仓一'), repo('r-new', '离线新增未落盘')],
      base: { repositories: [repo('r-1', '仓一')] },
    });
  await f.ctx.loadServerState();
  assert.deepEqual(J(f.ctx.repositories).map(r => r.id), ['r-1', 'r-new'], '在途新增保留');
  assert.equal(f.calls.persist, 1, '服务端解释不了 r-new：回推一次');
});

test('loadServerState：基线在的旧条目被他端删除——本地未改动随远端删除，不复活不回推（持久化基线防复活）', async () => {
  const f = loadStateFixture(
    { pipelines: [plXds()], repositories: [repo('r-1', '仓一')] },   // 远端已无 r-2
    {
      localRepos: [repo('r-1', '仓一'), repo('r-2', '旧缓存')],      // 本地缓存仍有 r-2（==基线，未改动）
      base: { repositories: [repo('r-1', '仓一'), repo('r-2', '旧缓存')] },
    });
  await f.ctx.loadServerState();
  assert.deepEqual(J(f.ctx.repositories).map(r => r.id), ['r-1'], '基线有、远端无、本地未改 → 随远端删除');
  assert.equal(f.calls.persist, 0, '合并结果服务端全能解释：不排写');
});

test('loadServerState：本地与服务端完全一致（含基线）→ 零排写（不破坏「初始化不自动 PUT」口径）', async () => {
  const f = loadStateFixture(
    { pipelines: [plXds()], repositories: [repo('r-1', '仓一')] },
    {
      localRepos: [repo('r-1', '仓一')],
      base: { repositories: [repo('r-1', '仓一')] },
    });
  await f.ctx.loadServerState();
  assert.equal(f.calls.persist, 0, '无在途改动：loadServerState 不排写');
});

/* ---------- 演示种子（myapp）不再上送团队共享配置 ---------- */

test('loadServerState：种子态丢弃——新浏览器（无本地缓存）拉到服务端非空代码仓时，演示种子不进合并/上送', async () => {
  const f = loadStateFixture(
    { pipelines: [plXds()], repositories: [repo('r-1', '仓一')] },
    {
      reposSeeded: true,
      localRepos: [{ id: 'repo-1', name: 'myapp', url: 'https://git.example.com/dev/myapp.git', user: '', pass: '', fetchMode: 'server' }],
    });
  await f.ctx.loadServerState();
  assert.deepEqual(J(f.ctx.repositories).map(r => r.id), ['r-1'], '演示种子被丢弃，列表 = 服务端代码仓');
  assert.equal(f.ctx.reposSeededByDefault, false, '种子态清除');
  assert.equal(f.calls.persist, 0, '种子丢弃不触发回推（服务端快照解释了全部条目）');
});

test('loadServerState：服务端无代码仓（空/无键）时演示种子保留（首次体验）', async () => {
  const f = loadStateFixture({ pipelines: [plXds()] }, {   // config 无 repositories 键
    reposSeeded: true,
    localRepos: [{ id: 'repo-1', name: 'myapp', url: 'https://git.example.com/dev/myapp.git', user: '', pass: '', fetchMode: 'server' }],
  });
  await f.ctx.loadServerState();
  assert.deepEqual(J(f.ctx.repositories).map(r => r.id), ['repo-1'], '服务端无代码仓：种子保留');
  assert.equal(f.ctx.reposSeededByDefault, true, '种子态维持');
});

/* ---------- 基线读写助手 ---------- */

test('loadServerBaseLS：解析 localStorage 的持久化基线；坏值/缺失返回 null', () => {
  const ctx = { localStorage: { getItem: () => null } };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('loadServerBaseLS'), ctx);
  assert.equal(ctx.loadServerBaseLS(), null, '无存储 → null');
  ctx.localStorage.getItem = () => JSON.stringify({ repositories: [repo('r-1', '仓一')] });
  assert.equal(JSON.stringify(ctx.loadServerBaseLS().repositories), JSON.stringify([repo('r-1', '仓一')]), '有存储 → 解析对象（vm 上下文原型不同，按 JSON 比较）');
  ctx.localStorage.getItem = () => 'not-json';
  assert.equal(ctx.loadServerBaseLS(), null, '坏 JSON → null（容错不抛）');
  ctx.localStorage.getItem = () => JSON.stringify(['array']);
  assert.equal(ctx.loadServerBaseLS(), null, '非对象（数组）→ null');
});

test('源码契约：基线持久化接线——启动自 localStorage 装入、四处理基线前进点随行写入', () => {
  assert.match(source, /let serverConfigBase=loadServerBaseLS\(\);/, '启动时从 pip-server-base 恢复基线');
  const marks = source.match(/if\(typeof markServerBaseConfirmed==='function'\) markServerBaseConfirmed\(\)/g) || [];
  assert.equal(marks.length, 4, 'pushState 成功 / save-one 409 采纳 / save-one 成功 / loadServerState GET 四处基线前进点都持久化');
  assert.match(source, /localStorage\.setItem\('pip-server-base'/, '基线写入 localStorage');
});

