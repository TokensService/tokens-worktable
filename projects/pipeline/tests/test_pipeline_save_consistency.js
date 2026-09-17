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

function saveFixture(saveResult) {
  const oldPipeline = { id: 'p1', name: '旧名称', builtIn: false, stages: [{ id: 'old', name: '旧阶段' }] };
  let resolveSave;
  const pending = saveResult || new Promise(resolve => { resolveSave = resolve; });
  const alerts = [], calls = { clear: 0, render: 0, select: 0, immediate: null };
  const els = {
    plForm: { style: { display: 'flex' }, dataset: { editId: 'p1' }, inert: false },
    plName: { value: '新名称' },
    scriptsDir: { value: '/srv/scripts' },
    plSave: { disabled: false, textContent: '保存' },
  };
  const ctx = {
    alert: message => alerts.push(String(message)), confirm: () => true,
    PRESET_BY_NAME: {}, editStages: [{ id: 'new', name: '新阶段', kind: 'simulate', dur: 0 }],
    scriptsDir: '/srv/scripts', scriptsDirIsFallback: false,
    serverConfigBase: { pipelines: [JSON.parse(JSON.stringify(oldPipeline))] },
    $: id => els[id] || null,
    findPipeline: id => ctx.pipelines.find(item => item.id === id),
    pipelines: [oldPipeline], currentUsername: 'alice',
    stageIdFor: () => 'new', collectPipelineDefaultForm: () => ({ branch: 'main' }),
    saveScriptsDir: () => {},
    savePipelines: options => { calls.immediate = options; return pending; },
    clearPlDraft: () => { calls.clear += 1; },
    running: false, curPipelineId: 'p1',
    selectPipeline: () => { calls.select += 1; }, renderPipelines: () => { calls.render += 1; },
    plOwnerOf: pipeline => pipeline.createdBy || '',
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('savePlForm'), ctx);
  return { ctx, els, alerts, calls, oldPipeline, resolveSave };
}

test('点击保存立即走服务端确认，确认前不关闭编辑框也不清草稿', async () => {
  const f = saveFixture();
  const saving = f.ctx.savePlForm();

  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.immediate)), { immediate: true });
  assert.equal(f.els.plForm.style.display, 'flex');
  assert.equal(f.calls.clear, 0);
  assert.equal(f.els.plSave.disabled, true);
  assert.equal(f.els.plSave.textContent, '保存中…');
  assert.equal(f.els.plForm.inert, true, '慢请求期间冻结整个编辑表单，避免确认后清掉请求发出后的新输入');

  f.resolveSave({ ok: true });
  await saving;

  assert.equal(f.els.plForm.style.display, 'none');
  assert.equal(f.calls.clear, 1);
  assert.equal(f.els.plSave.disabled, false);
  assert.equal(f.els.plSave.textContent, '保存');
  assert.equal(f.els.plForm.inert, false);
})

test('并发冲突时恢复保存前定义、保留编辑框与草稿并提示刷新', async () => {
  const f = saveFixture(Promise.resolve({ ok: false, conflict: true, conflicts: ['p1'] }));

  await f.ctx.savePlForm();

  assert.equal(f.ctx.pipelines[0].name, '旧名称');
  assert.equal(f.ctx.pipelines[0].stages[0].id, 'old');
  assert.equal(f.els.plForm.style.display, 'flex');
  assert.equal(f.calls.clear, 0);
  assert.match(f.alerts[0], /其他浏览器.*修改.*刷新/);
})

test('网络保存失败时恢复保存前定义并保留编辑内容', async () => {
  const f = saveFixture(Promise.resolve({ ok: false, error: 'HTTP 500' }));

  await f.ctx.savePlForm();

  assert.equal(f.ctx.pipelines[0].name, '旧名称');
  assert.equal(f.els.plForm.style.display, 'flex');
  assert.equal(f.calls.clear, 0);
  assert.match(f.alerts[0], /保存失败.*HTTP 500/);
})

test('等待前序保存期间合入的其他流水线，在本次保存失败回滚时仍保留', async () => {
  const f = saveFixture();
  const saving = f.ctx.savePlForm();
  f.ctx.pipelines.push({ id: 'p2', name: '他端刚合入', stages: [] });
  f.resolveSave({ ok: false, conflict: true, conflicts: ['p1'] });

  await saving;

  assert.deepEqual(Array.from(f.ctx.pipelines, item => item.id), ['p1', 'p2']);
  assert.equal(f.ctx.pipelines[0].name, '旧名称');
  assert.equal(f.ctx.pipelines[1].name, '他端刚合入');
})

test('等待前序保存期间同一流水线基线前移，失败时恢复最新确认版而非更旧快照', async () => {
  const f = saveFixture();
  const saving = f.ctx.savePlForm();
  f.ctx.serverConfigBase = { pipelines: [{ id: 'p1', name: '期间已确认的远端版', builtIn: false, stages: [{ id: 'remote' }] }] };
  f.resolveSave({ ok: false, error: 'HTTP 500' });

  await saving;

  assert.equal(f.ctx.pipelines[0].name, '期间已确认的远端版');
  assert.equal(f.ctx.pipelines[0].stages[0].id, 'remote');
  assert.equal(f.calls.clear, 0, '用户本次编辑仍由草稿保留，刷新后可以重新应用');
})

function pushFixture(response) {
  const requests = [];
  const baseConfig = { pipelines: [{ id: 'p1', name: '基线', stages: [] }], theme: 'dark' };
  const clientConfig = { pipelines: [{ id: 'p1', name: '本页修改', stages: [] }], theme: 'dark' };
  const ctx = {
    stateLoaded: true,
    serverConfigBase: baseConfig,
    persistTimer: null,
    persistInFlight: null,
    collectConfig: () => ({ ...clientConfig, pipelines: JSON.parse(JSON.stringify(ctx.pipelines)) }),
    historyForPersist: () => [],
    loadServerState: async () => {},
    pipelines: JSON.parse(JSON.stringify(clientConfig.pipelines)),
    localStorage: { setItem() {} },
    migrateGate: value => value,
    migrateStageUrl: value => value,
    migratePrefillDefaults: value => value,
    migratePipelineDefaults: value => value,
    migratePromPreset: value => value,
    fetch: async (url, options) => { requests.push({ url, options }); return response; },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('reconcilePipelinesAfterSave') + '\n' + extractFunction('pushState'), ctx);
  return { ctx, requests, baseConfig, clientConfig };
}

test('配置 PUT 携带最近一次服务端基线，供服务端做三方合并', async () => {
  const merged = { pipelines: [{ id: 'p1', name: '本页修改', stages: [] }], theme: 'dark' };
  const f = pushFixture({ ok: true, status: 200, json: async () => ({ ok: true, config: merged }) });

  const result = await f.ctx.pushState();

  assert.equal(result.ok, true);
  assert.equal(f.requests.length, 1);
  const body = JSON.parse(f.requests[0].options.body);
  assert.deepEqual(body.baseConfig, f.baseConfig);
  assert.deepEqual(body.config, f.clientConfig);
})

test('配置 PUT 的 409 冲突返回可识别结果，不再静默当作保存成功', async () => {
  const f = pushFixture({
    ok: false, status: 409,
    json: async () => ({ error: 'pipeline config conflict', conflicts: ['p1'] }),
  });

  const result = await f.ctx.pushState();

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, conflict: true, conflicts: ['p1'], error: 'pipeline config conflict' });
})

test('不同流水线由其他浏览器新增后，保存响应会合并回本页而不是在下次保存时误删', async () => {
  const merged = {
    pipelines: [
      { id: 'p1', name: '本页修改', stages: [] },
      { id: 'p2', name: '他端新增', stages: [] },
    ],
    theme: 'dark',
  };
  const f = pushFixture({ ok: true, status: 200, json: async () => ({ ok: true, config: merged }) });

  await f.ctx.pushState();

  assert.deepEqual(Array.from(f.ctx.pipelines, item => item.id), ['p1', 'p2']);
  assert.equal(f.ctx.pipelines[1].name, '他端新增');
})

test('同一页面的重叠保存串行提交，后一次使用前一次确认后的新基线', async () => {
  let resolveFirst;
  const firstPending = new Promise(resolve => { resolveFirst = resolve; });
  const responses = [
    firstPending,
    Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, config: { pipelines: [{ id: 'p1', name: '第二次', stages: [] }], theme: 'dark' } }) }),
  ];
  const f = pushFixture(null);
  f.ctx.fetch = async (url, options) => {
    f.requests.push({ url, options });
    return responses.shift();
  };

  const first = f.ctx.pushState();
  await new Promise(resolve => setImmediate(resolve));
  f.ctx.pipelines[0].name = '第二次';
  const second = f.ctx.pushState();
  assert.equal(f.requests.length, 1, '首个请求未确认前不得并发发出第二个 PUT');

  resolveFirst({ ok: true, status: 200, json: async () => ({ ok: true, config: { pipelines: [{ id: 'p1', name: '本页修改', stages: [] }], theme: 'dark' } }) });
  await first;
  await second;

  assert.equal(f.requests.length, 2);
  const secondBody = JSON.parse(f.requests[1].options.body);
  assert.equal(secondBody.baseConfig.pipelines[0].name, '本页修改');
  assert.equal(secondBody.config.pipelines[0].name, '第二次');
})
