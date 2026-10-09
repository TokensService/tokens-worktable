/* 编辑器保存竞态的客户端修复回归（bug 链：savePlForm push 新流水线 → pushPipelineOne 等前序全量 PUT
   → 全量 PUT 409 → pushState 自愈 loadServerState 整表替换把未落盘的新流水线冲掉 → 锁释放后
   findPipeline 失败、保存被回滚）：
   1) loadServerState 改按 id 三方合并（基线 serverConfigBase.pipelines / 本地 pipelines / 远端响应），
      本地未落盘新增保留、远端增删改照常同步（mergePipelinesFromServer；比对豁免顶层
      favoriteUsers/pinnedAt，与服务端 stripPipelineSharedMeta 同口径）；迁移链补齐 migratePromPreset。
   2) persistInFlight 串行锁改 Promise 链互斥，消除 while+await 的 check-then-set：
      两个并发等待者不再同时进入临界区，pushState 与 pushPipelineOne 严格按到达顺序逐个执行。 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function extractFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `pipeline.html 缺少函数 ${name}`);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`无法提取函数 ${name}`);
}

function tick() { return new Promise(resolve => setImmediate(resolve)); }

/* ---------- mergePipelinesFromServer：按 id 三方合并口径 ---------- */
function mergeFixture() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(extractFunction('stripPipelineSharedMeta') + '\n' + extractFunction('mergePipelinesFromServer'), ctx);
  return ctx;
}

test('三方合并：仅本地存在（基线/远端都无）的本地新增未落盘条目保留，追加在合并结果末尾', () => {
  const ctx = mergeFixture();
  const a = { id: 'pa', name: 'A', stages: [] };
  const localNew = { id: 'pl-new', name: '本地新增未落盘', stages: [{ id: 's1' }] };

  const merged = ctx.mergePipelinesFromServer([a], [a, localNew], [a]);

  assert.deepEqual(Array.from(merged.pipelines, item => item.id), ['pa', 'pl-new'], '远端顺序在前，仅本地条目维持本地相对顺序追加在后');
  assert.equal(merged.pipelines[1].name, '本地新增未落盘');
  assert.deepEqual(JSON.parse(JSON.stringify(merged.keptBaseEntries)), [], '本地新增基线本就无，无需补基线');
})

test('三方合并：比对豁免顶层 favoriteUsers/pinnedAt（与服务端 stripPipelineSharedMeta 同口径）', () => {
  const ctx = mergeFixture();
  const a = { id: 'pa', name: 'A', stages: [] };
  const favOnly = { id: 'pa', name: 'A', stages: [], favoriteUsers: ['alice'], pinnedAt: 123 };

  /* 本地仅收藏/置顶变化 = 内容未变：取远端（豁免字段不参与内容同一性比对，他人收藏/置顶不算本地改动） */
  const merged = ctx.mergePipelinesFromServer([a], [favOnly], [a]);
  assert.deepEqual(JSON.parse(JSON.stringify(merged.pipelines)), [a]);

  /* 双边内容都改且不一致：服务端为准取远端 */
  const both = ctx.mergePipelinesFromServer([a], [{ id: 'pa', name: '本地改', stages: [] }], [{ id: 'pa', name: '远端改', stages: [] }]);
  assert.equal(both.pipelines[0].name, '远端改');

  /* 远端未改、本地内容有改动：保留本地（在途修改不被重拉冲掉） */
  const localEdit = ctx.mergePipelinesFromServer([a], [{ id: 'pa', name: '本地改', stages: [] }], [a]);
  assert.equal(localEdit.pipelines[0].name, '本地改');
})

test('三方合并：基线有远端缺（远端已删除）——本地未变随远端删除；本地有改动保留并记下原基线条目', () => {
  const ctx = mergeFixture();
  const a = { id: 'pa', name: 'A', stages: [] };
  const b = { id: 'pb', name: 'B', stages: [] };

  const untouched = ctx.mergePipelinesFromServer([a, b], [a, JSON.parse(JSON.stringify(b))], [a]);
  assert.deepEqual(Array.from(untouched.pipelines, item => item.id), ['pa'], '本地与基线一致：随远端删除');
  assert.deepEqual(JSON.parse(JSON.stringify(untouched.keptBaseEntries)), []);

  const edited = { id: 'pb', name: 'B 本地改（保存在途）', stages: [] };
  const kept = ctx.mergePipelinesFromServer([a, b], [a, edited], [a]);
  assert.deepEqual(Array.from(kept.pipelines, item => item.id), ['pa', 'pb'], '本地相对基线有改动：删除可能正撞保存在途，保留本地');
  assert.equal(kept.pipelines[1].name, 'B 本地改（保存在途）');
  assert.deepEqual(JSON.parse(JSON.stringify(kept.keptBaseEntries)), [b], '原基线条目须补回新基线，防下次 save-one 因 baseOne=null 把他人已删条目静默重建');
})

test('三方合并：本地删除在途不被远端重拉复活（远端未改维持本地删除，远端也改则服务端为准）', () => {
  const ctx = mergeFixture();
  const a = { id: 'pa', name: 'A', stages: [] };
  const b = { id: 'pb', name: 'B', stages: [] };

  const stillDeleted = ctx.mergePipelinesFromServer([a, b], [a], [a, b]);
  assert.deepEqual(Array.from(stillDeleted.pipelines, item => item.id), ['pa']);

  const remoteEdited = { id: 'pb', name: 'B 远端改', stages: [] };
  const revived = ctx.mergePipelinesFromServer([a, b], [a], [a, remoteEdited]);
  assert.deepEqual(Array.from(revived.pipelines, item => item.id), ['pa', 'pb'], '删除与远端修改对撞：服务端为准恢复远端版');
  assert.equal(revived.pipelines[1].name, 'B 远端改');
})

/* ---------- loadServerState：整表替换 → 三方合并后的页面行为 ---------- */
function loadFixture(response, seeds) {
  const storage = {};
  const requests = [];
  const migrateCalls = { prom: 0 };
  const els = {};
  const ctx = {
    persistInFlight: null,
    stateFetchEpoch: 0,   /* 基线纪元（fetchPipelineStateFresh 过期重拉依据；无在途保存时行为与旧一致） */
    stateLoaded: false,
    serverConfigBase: seeds.base,
    pipelines: seeds.local,
    curPipelineId: seeds.curPipelineId || 'pa',
    DEFAULT_PIPELINE_ID: 'pl-xds',
    defaultPipeline: () => ({ id: 'pl-xds', name: '内置', builtIn: true, stages: [{ id: 's0' }] }),
    migrateGate: value => value, migrateStageUrl: value => value, migratePrefillDefaults: value => value,
    migratePipelineDefaults: value => value,
    migratePromPreset: value => { migrateCalls.prom += 1; return value; },
    normalizeEnv: value => value, normalizeRepo: value => value,
    environments: [], repositories: [], selectedEnvIds: null, curRepoId: '',
    scriptsDir: '/srv/scripts', scriptsDirIsFallback: true,
    maybeAdoptInstalledScriptsDir: () => {},
    themePref: 'auto', buildNo: 1,
    cleanupScript: null, checkScript: null, profilingScript: null,
    jenkins: {}, evaltok: {}, prom: {}, archiveDir: '', archiveScriptName: '', analysisPrompts: {},
    histClearedAt: 0, history: [],
    historyForPersist: () => [], historySyncSig: '',
    curPipeline: () => ({ stages: [{ id: 's1' }] }),
    $: id => els[id] || (els[id] = { value: '', checked: false, textContent: '', style: {}, dataset: {} }),
    renderCleanupParams: () => {}, renderCheckParams: () => {}, renderProfilingParams: () => {},
    renderAll: () => {}, migrateInlineLogs: () => {}, persistState: () => {},
    localStorage: { setItem: (key, value) => { storage[key] = String(value); } },
    fetch: async (url, options) => { requests.push({ url, options }); return typeof response === 'function' ? response(url, options) : response; },
    AbortController,
  };
  vm.createContext(ctx);
  vm.runInContext([
    'historyPersistSig', 'stripPipelineSharedMeta', 'mergePipelinesFromServer', 'fetchPipelineStateFresh', 'loadServerState',
  ].map(extractFunction).join('\n'), ctx);
  return { ctx, storage, requests, migrateCalls };
}

test('loadServerState：远端新增/修改/删除照常同步到页面与 localStorage（本地未改动条目），迁移链含 migratePromPreset', async () => {
  const a = { id: 'pa', name: 'A', stages: [] };
  const b = { id: 'pb', name: 'B', stages: [] };
  const c = { id: 'pc', name: 'C', stages: [] };
  const aRemote = { id: 'pa', name: 'A 远端改', stages: [] };
  const d = { id: 'pd', name: '他端新增', stages: [] };
  const f = loadFixture(
    { ok: true, status: 200, json: async () => ({ config: { pipelines: [aRemote, c, d] } }) },
    { base: { pipelines: [a, b, c] }, local: JSON.parse(JSON.stringify([a, b, c])) },
  );

  await f.ctx.loadServerState();

  assert.deepEqual(Array.from(f.ctx.pipelines, item => item.id), ['pl-xds', 'pa', 'pc', 'pd'],
    '内置默认仍居首；远端修改（pa）、删除（pb）、新增（pd）全部同步');
  assert.equal(f.ctx.pipelines[1].name, 'A 远端改');
  assert.equal(f.migrateCalls.prom, 4, 'loadServerState 迁移链与 loadPipelines 对齐，含 migratePromPreset');
  assert.equal(f.ctx.stateLoaded, true);
  const cached = JSON.parse(f.storage['pip-pipelines']);
  assert.deepEqual(Array.from(cached, item => item.id), ['pl-xds', 'pa', 'pc', 'pd'], 'localStorage 离线缓存同步合并结果');
  assert.deepEqual(Array.from(f.ctx.serverConfigBase.pipelines, item => item.id), ['pa', 'pc', 'pd'], '基线整份换为响应快照（无保留条目需补回）');
})

test('loadServerState：基线有远端缺而本地有改动的条目保留本地，原基线条目补回 serverConfigBase', async () => {
  const a = { id: 'pa', name: 'A', stages: [] };
  const b = { id: 'pb', name: 'B', stages: [] };
  const bEdited = { id: 'pb', name: 'B 本地改（保存在途）', stages: [] };
  const f = loadFixture(
    { ok: true, status: 200, json: async () => ({ config: { pipelines: [a] } }) },
    { base: { pipelines: [a, b] }, local: [JSON.parse(JSON.stringify(a)), bEdited] },
  );

  await f.ctx.loadServerState();

  assert.deepEqual(Array.from(f.ctx.pipelines, item => item.id), ['pl-xds', 'pa', 'pb'], '本地有改动的条目不被他人删除冲掉');
  assert.equal(f.ctx.pipelines[2].name, 'B 本地改（保存在途）');
  assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.serverConfigBase.pipelines)), [a, b],
    '新基线 = 响应快照 + 保留条目的原基线：下次 save-one 的 baseOne 非 null，与 diskOne(null) 不等必 409 由用户抉择，而非静默重建');
})

/* ---------- 竞态主场景：编辑器新增保存撞上 409 自愈重拉 ---------- */
function raceFixture() {
  const storage = {};
  const requests = [];
  const toasts = [];
  const els = {};
  const remoteBase = { id: 'pl-muzjbpsr', name: '基线版', stages: [{ id: 's1' }] };
  const remoteNew = { id: 'pl-muzjbpsr', name: '他端修改版', stages: [{ id: 's1' }] };
  const xds = { id: 'pl-xds', name: '内置', builtIn: true, stages: [{ id: 's0' }] };
  const test2 = { id: 'pl-test2', name: 'test2', stages: [{ id: 's1' }] };
  const ctx = {
    persistInFlight: null, persistTimer: null, stateLoaded: true,
    stateFetchEpoch: 0,   /* 基线纪元（fetchPipelineStateFresh 过期重拉依据） */
    serverConfigBase: { pipelines: [JSON.parse(JSON.stringify(remoteBase))] },
    pipelines: [JSON.parse(JSON.stringify(remoteBase)), JSON.parse(JSON.stringify(test2))],   // savePlForm 已把 test2 push 进全局列表
    curPipelineId: 'pl-muzjbpsr',
    findPipeline: id => ctx.pipelines.find(item => item.id === id),
    collectConfig: () => ({ pipelines: JSON.parse(JSON.stringify(ctx.pipelines)) }),
    historyForPersist: () => [], historySyncSig: '',
    toast: message => { toasts.push(String(message)); },
    renderPipelines: () => {},
    DEFAULT_PIPELINE_ID: 'pl-xds',
    defaultPipeline: () => JSON.parse(JSON.stringify(xds)),
    migrateGate: value => value, migrateStageUrl: value => value, migratePrefillDefaults: value => value,
    migratePipelineDefaults: value => value, migratePromPreset: value => value,
    normalizeEnv: value => value, normalizeRepo: value => value,
    environments: [], repositories: [], selectedEnvIds: null, curRepoId: '',
    scriptsDir: '/srv/scripts', scriptsDirIsFallback: false,
    maybeAdoptInstalledScriptsDir: () => {},
    themePref: 'auto', buildNo: 1,
    cleanupScript: null, checkScript: null, profilingScript: null,
    jenkins: {}, evaltok: {}, prom: {}, archiveDir: '', archiveScriptName: '', analysisPrompts: {},
    histClearedAt: 0, history: [],
    curPipeline: () => ({ stages: [{ id: 's1' }] }),
    $: id => els[id] || (els[id] = { value: '', checked: false, textContent: '', style: {}, dataset: {} }),
    renderCleanupParams: () => {}, renderCheckParams: () => {}, renderProfilingParams: () => {},
    renderAll: () => {}, migrateInlineLogs: () => {}, persistState: () => {},
    localStorage: { setItem: (key, value) => { storage[key] = String(value); } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/worktable/pipeline/save-one') {
        const sent = JSON.parse(options.body).pipeline;
        return { ok: true, status: 200, json: async () => ({ ok: true, config: { pipelines: [JSON.parse(JSON.stringify(xds)), remoteNew, sent] } }) };
      }
      if (options && options.method === 'PUT') {
        return { ok: false, status: 409, json: async () => ({ error: 'pipeline config conflict', conflicts: ['pl-muzjbpsr'] }) };
      }
      return { ok: true, status: 200, json: async () => ({ config: { pipelines: [remoteNew] } }) };   // 409 自愈重拉的 GET：远端无 test2
    },
    AbortController,
    setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext([
    'historyPersistSig', 'reconcilePipelinesAfterSave', 'stripPipelineSharedMeta', 'mergePipelinesFromServer',
    'fetchPipelineStateFresh', 'pushState', 'pushPipelineOne', 'loadServerState',
  ].map(extractFunction).join('\n'), ctx);
  return { ctx, storage, requests, toasts };
}

test('竞态主场景：本地新增条目 + 409 自愈重拉后仍在 pipelines 中，save-one 继续发出并保存成功', async () => {
  const f = raceFixture();

  const full = f.ctx.pushState();                        // 前序全量 PUT（持锁），将 409 触发自愈重拉
  const one = f.ctx.pushPipelineOne('pl-test2');         // 编辑器单条保存排队等锁（竞态入口）

  const fullResult = await full;
  assert.equal(fullResult.conflictHandled, true, '全量 PUT 409 走了 toast + 重拉自愈');

  const oneResult = await one;
  assert.equal(oneResult.ok, true, '自愈重拉后 test2 仍在 pipelines 中，save-one 正常发出并确认（旧版此处报「已不在本页列表」）');

  assert.deepEqual(Array.from(f.requests, r => (r.options && r.options.method) || 'GET'), ['PUT', 'GET', 'PUT'], '严格串行：全量 PUT → 自愈 GET → save-one');
  assert.equal(f.requests[2].url, '/api/worktable/pipeline/save-one');
  const saveOneBody = JSON.parse(f.requests[2].options.body);
  assert.equal(saveOneBody.pipeline.id, 'pl-test2');
  assert.equal(saveOneBody.basePipeline, null, '本地新增基线本就无：baseOne=null 与磁盘比对，磁盘也无即正常新增落盘');

  const ids = Array.from(f.ctx.pipelines, item => item.id);
  assert.ok(ids.includes('pl-test2'), 'test2 最终留在列表中');
  assert.ok(ids.includes('pl-muzjbpsr'), '他端修改版同步保留');
  assert.equal(f.ctx.pipelines[ids.indexOf('pl-muzjbpsr')].name, '他端修改版');
  assert.ok(JSON.parse(f.storage['pip-pipelines']).some(item => item.id === 'pl-test2'), 'localStorage 离线缓存含 test2');
  assert.ok(f.ctx.serverConfigBase.pipelines.some(item => item.id === 'pl-test2'), 'save-one 确认后基线前移含 test2');
  assert.equal(f.ctx.persistInFlight, null, '全部完成后串行锁清回 null');
})

/* ---------- 串行锁：Promise 链互斥 ---------- */
function lockFixture() {
  const requests = [];
  const resolvers = [];
  const ctx = {
    persistInFlight: null, persistTimer: null, stateLoaded: true,
    serverConfigBase: { pipelines: [{ id: 'p1', name: '基线', stages: [] }] },
    pipelines: [{ id: 'p1', name: '编辑后', stages: [] }],
    findPipeline: id => ctx.pipelines.find(item => item.id === id),
    collectConfig: () => ({ pipelines: JSON.parse(JSON.stringify(ctx.pipelines)) }),
    historyForPersist: () => [], historySyncSig: '',
    loadServerState: async () => {},
    renderPipelines: () => {}, toast: () => {},
    scriptsDir: '/srv/scripts',
    migrateGate: value => value, migrateStageUrl: value => value, migratePrefillDefaults: value => value,
    migratePipelineDefaults: value => value, migratePromPreset: value => value,
    localStorage: { setItem() {} },
    fetch: (url, options) => {   // 挂起直到测试逐个放行，记录调用顺序
      requests.push({ url, options });
      return new Promise(resolve => { resolvers.push(resolve); });
    },
    AbortController,
    setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext([
    'historyPersistSig', 'reconcilePipelinesAfterSave', 'pushState', 'pushPipelineOne',
  ].map(extractFunction).join('\n'), ctx);
  const respond = (index, name) => resolvers[index]({ ok: true, status: 200, json: async () => ({ ok: true, config: { pipelines: [{ id: 'p1', name, stages: [] }] } }) });
  return { ctx, requests, respond };
}

test('串行锁：pushState 与 pushPipelineOne 并发到达严格按顺序逐个执行，后序取前序确认后的新基线', async () => {
  const f = lockFixture();

  const first = f.ctx.pushState();                 // 持锁发出全量 PUT
  await tick();
  const second = f.ctx.pushPipelineOne('p1');      // 两个等待者排队
  const third = f.ctx.pushState();
  await tick(); await tick();
  assert.equal(f.requests.length, 1, '前序未确认前，两个等待者都不得发出请求（旧 check-then-set 会在前序释放后同进临界区）');

  f.respond(0, '第一次确认');
  await tick(); await tick(); await tick();
  assert.equal(f.requests.length, 2, '第一个放行后只有队首的 save-one 进入临界区');
  assert.equal(f.requests[1].url, '/api/worktable/pipeline/save-one');
  assert.equal(JSON.parse(f.requests[1].options.body).basePipeline.name, '第一次确认', 'save-one 拿到锁再取基线：用前序确认后的新基线');

  f.respond(1, '第二次确认');
  await tick(); await tick(); await tick();
  assert.equal(f.requests.length, 3, '第二个放行后第三个才进入临界区');
  assert.equal(f.requests[2].url, '/api/worktable/pipeline');
  assert.equal(JSON.parse(f.requests[2].options.body).baseConfig.pipelines[0].name, '第二次确认', '第三次保存基于第二次确认后的新基线');

  f.respond(2, '第三次确认');
  await first; await second; await third;
  assert.equal(f.ctx.persistInFlight, null, '链尾无人排队时清回 null');
})
