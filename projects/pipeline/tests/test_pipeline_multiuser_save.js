/* 多用户并发保存的客户端修复：
   1) copyPipeline 改走单条保存（pushPipelineOne）——复制只新增一个条目，天然免疫无关条目的并发 409；
      旧服务端 404 回退全量；硬失败 toast + 防抖重试兜底，本地副本保留。
   2) pushState 的 409 非静默路径 toast 提示 + 重拉服务端状态自愈（基线前进，不再持续 409 锁死）；
      silentConflict（编辑器回退全量）维持原静默返回。 */
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

function copyFixture(saveOneResult) {
  const src = {
    id: 'p1', name: '构建流水线', builtIn: true, trusted: true, pinnedAt: 123,
    favoriteUsers: ['bob'], createdBy: 'bob', updatedBy: 'bob', stages: [{ id: 's1', name: '构建' }],
  };
  const toasts = [];
  const calls = { one: [], full: [], select: [], render: 0 };
  const ctx = {
    pipelines: [src],
    currentUsername: 'alice',
    running: false,
    findPipeline: id => ctx.pipelines.find(item => item.id === id),
    selectPipeline: id => { calls.select.push(id); },
    renderPipelines: () => { calls.render += 1; },
    pushPipelineOne: id => { calls.one.push(id); return Promise.resolve(saveOneResult); },
    savePipelines: options => { calls.full.push(options === undefined ? null : JSON.parse(JSON.stringify(options))); return Promise.resolve({ ok: true }); },
    toast: message => { toasts.push(String(message)); },
    localStorage: { setItem() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('uniqueCopyName') + '\n' + extractFunction('copyPipeline'), ctx);
  return { ctx, src, toasts, calls };
}

test('复制流水线：副本走单条保存（save-one），不触发全量保存；UI 不等保存结果', async () => {
  let resolveOne;
  const f = copyFixture(new Promise(resolve => { resolveOne = resolve; }));

  const saving = f.ctx.copyPipeline('p1');

  assert.equal(f.ctx.pipelines.length, 2);
  const clone = f.ctx.pipelines[1];
  assert.notEqual(clone.id, f.src.id);
  assert.equal(clone.name, '构建流水线（副本）');
  assert.equal(clone.createdBy, 'alice', '副本署名复制者');
  assert.equal(clone.builtIn, false, '内置流水线的副本为普通可编辑条目');
  assert.equal('trusted' in clone, false);
  assert.equal(clone.pinnedAt, 0);
  assert.deepEqual(Array.from(clone.favoriteUsers), []);
  assert.deepEqual(f.calls.one, [clone.id], '副本经 save-one 落盘：免疫其他条目的并发冲突');
  assert.deepEqual(f.calls.select, [clone.id], '保存确认前已切到副本（复制保持轻量，不走编辑器的 inert 等待）');

  resolveOne({ ok: true });
  await saving;

  assert.deepEqual(f.calls.full, [], '单条可用时不触发全量保存');
  assert.equal(f.toasts.length, 0);
})

test('复制流水线：save-one 返回 unsupported（旧服务端无单条路由）时回退全量保存', async () => {
  const f = copyFixture({ ok: false, unsupported: true });

  await f.ctx.copyPipeline('p1');

  assert.equal(f.calls.one.length, 1);
  assert.deepEqual(f.calls.full, [{ immediate: true }], '回退立即全量保存');
  assert.equal(f.toasts.length, 0);
})

test('复制流水线：save-one 硬失败时 toast 提示、本地副本保留、安排防抖重试兜底', async () => {
  const f = copyFixture({ ok: false, error: 'HTTP 500' });

  await f.ctx.copyPipeline('p1');

  assert.equal(f.ctx.pipelines.length, 2, '本地副本保留，不回滚');
  assert.equal(f.ctx.pipelines[1].name, '构建流水线（副本）');
  assert.equal(f.toasts.length, 1);
  assert.match(f.toasts[0], /副本保存失败.*HTTP 500/);
  assert.deepEqual(f.calls.full, [null], '安排一次无参 savePipelines() 防抖重试兜底');
})

test('复制流水线：save-one 被 403 可信拦截时不重复提示（pushPipelineOne 已 toast + 重拉）', async () => {
  const f = copyFixture({ ok: false, status: 403, trusted: true, error: 'trusted' });

  await f.ctx.copyPipeline('p1');

  assert.equal(f.toasts.length, 0, '可信拦截已由 pushPipelineOne 提示，不再补「副本保存失败」');
  assert.deepEqual(f.calls.full, [], '可信拦截不触发兜底重试');
})

function pushConflictFixture() {
  const toasts = [];
  const calls = { load: 0, render: 0 };
  const timers = [];
  const baseConfig = { pipelines: [{ id: 'p1', name: '基线', stages: [] }], theme: 'dark' };
  const clientConfig = { pipelines: [{ id: 'p1', name: '本页修改', stages: [] }], theme: 'dark' };
  const ctx = {
    stateLoaded: true,
    serverConfigBase: baseConfig,
    persistTimer: null,
    persistInFlight: null,
    collectConfig: () => ({ ...clientConfig, pipelines: JSON.parse(JSON.stringify(ctx.pipelines)) }),
    historyForPersist: () => [],
    historySyncSig: '',
    loadServerState: async () => { calls.load += 1; },
    renderPipelines: () => { calls.render += 1; },
    toast: message => { toasts.push(String(message)); },
    pipelines: JSON.parse(JSON.stringify(clientConfig.pipelines)),
    localStorage: { setItem() {} },
    migrateGate: value => value,
    migrateStageUrl: value => value,
    migratePrefillDefaults: value => value,
    migratePipelineDefaults: value => value,
    migratePromPreset: value => value,
    fetch: async () => ({ ok: false, status: 409, json: async () => ({ error: 'pipeline config conflict', conflicts: ['p1'] }) }),
    AbortController,
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('historyPersistSig') + '\n' + extractFunction('reconcilePipelinesAfterSave') + '\n' + extractFunction('pushState'), ctx);
  return { ctx, toasts, calls };
}

test('全量保存 409（非静默默认）：toast 提示 + 重拉服务端状态自愈，返回 conflictHandled 标记', async () => {
  const f = pushConflictFixture();

  const result = await f.ctx.pushState();

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false, conflict: true, conflicts: ['p1'], error: 'pipeline config conflict', conflictHandled: true,
  });
  assert.equal(f.toasts.length, 1);
  assert.match(f.toasts[0], /保存冲突/);
  assert.equal(f.calls.load, 1, '重拉服务端状态：本地未落盘改动让位、基线随之前进，后续保存不再持续 409');
  assert.equal(f.calls.render, 1);
  assert.equal(f.ctx.persistInFlight, null, '串行锁已释放');
})

test('全量保存 409（silentConflict，编辑器回退路径）：不提示不重拉，维持原静默返回', async () => {
  const f = pushConflictFixture();

  const result = await f.ctx.pushState({ silentConflict: true });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false, conflict: true, conflicts: ['p1'], error: 'pipeline config conflict',
  });
  assert.equal(f.toasts.length, 0, '编辑器冲突由 savePlForm 回滚 + alert 单独处理，不双重提示');
  assert.equal(f.calls.load, 0);
  assert.equal(f.calls.render, 0);
})
