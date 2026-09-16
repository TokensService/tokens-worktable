// 点击「运行」后自动跟随：本地排队/租约在途/服务端排队或在跑，编排区与阶段详情都切到刚提交的那次任务。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function slice(startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start);
  assert.ok(start >= 0 && end > start, 'slice not found: ' + startMark);
  return source.slice(start, end);
}

const SLICES = [
  slice('function localQueueItems(){', 'function queuePreviewRc'),   // localQueueItems + isPendingQueueItem
  slice('function remoteQueueDetailAvailable(item){', 'function applyRemoteQueuePreviewRefresh(){'),   // 远端预览 + 自动跟随助手
  slice('function remoteRunsOf', '/* ---------- 运行引擎'),
  slice('async function submitServerRun(item){', 'function runPipeline(opts){'),
  slice('function runPipeline(opts){', '/* 机器占用判定'),
];

function makeContext(overrides) {
  const calls = { focusQueue: [], focusRun: [], renderQueue: [], alerts: [], fetch: [], pullQueue: [], startRun: [] };
  const context = {
    console,
    queue: [], activeRuns: [], pendingLeaseStarts: [], remoteQueueClients: [],
    MAX_ACTIVE_RUNS: 4, QUEUE_CAP: 16, DEFAULT_IMAGE: 'myapp', GITURL: 'https://git.example.com/dev/myapp',
    currentUsername: 'tester', curPipelineId: 'pipe-1', viewRc: null,
    pipelines: [
      { id: 'pipe-1', name: '流水线一', stages: [{ id: 's1', name: '构建' }] },   // 无 sched：本地执行路径
      { id: 'pipe-2', name: '流水线二', stages: [{ id: 's2', name: '部署', sched: '0 2 * * *' }] },   // 全 sched：服务端执行路径
    ],
    findPipeline: id => context.pipelines.find(p => p.id === id),
    curPipeline: () => context.pipelines[0],
    resolvePipelineRunOptions: (pl, opts) => opts,
    curEnvs: () => [{ id: 'env-1', ip: '10.0.0.1' }],
    resolveEnv: env => ({ id: 'env-1', ip: String(env || '') }),
    resolveRepo: () => ({ id: 'repo-1', name: 'myapp' }),
    $: id => ({ value: id === 'branchName' ? 'main' : 'repo-1' }),
    curStrategy: () => 'serial',
    selectedPresetKeys: () => [],
    conflictsActive: () => false,
    machineConflict: () => false,
    startRun: item => { calls.startRun.push(item); return true; },
    renderQueue: () => { calls.renderQueue.push(1); },
    focusQueueItem: id => { calls.focusQueue.push(id); },
    focusRun: rc => { calls.focusRun.push(rc); context.viewRc = rc; },
    pullRemoteQueue: async () => { calls.pullQueue.push(1); },
    pullRemoteQueueLog: () => {},
    queueStagePresence: s => ({ id: String(s && s.id || ''), name: String(s && s.name || '') }),
    queueNodePresence: n => ({ status: String(n && n.status || 'idle'), progress: 0, dur: 0, sub: {} }),
    fetch: async (url, opts) => {
      calls.fetch.push({ url, opts });
      return { ok: true, json: async () => ({ ok: true, accepted: true, runId: 'api-xyz', pipelineId: 'pipe-2', pipelineName: '流水线二' }) };
    },
    alert: msg => { calls.alerts.push(String(msg)); },
  };
  Object.assign(context, overrides || {});
  vm.createContext(context);
  SLICES.forEach(code => vm.runInContext(code, context));
  return { context, calls };
}

async function flush() { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); }

function serverSnapshotQueued(runId) {
  return [{ id: 'server', queue: [{ id: runId, pipelineId: 'pipe-2', pipelineName: '流水线二', stages: [{ id: 's2', name: '部署' }], nodes: {}, queuedAt: Date.now() }] }];
}

test('本地排队：入队后立即把编排区/阶段详情切到该次排队预览', () => {
  const { context, calls } = makeContext({ conflictsActive: () => true });
  const r = context.runPipeline({ pipelineId: 'pipe-1' });
  assert.equal(r, 'queued');
  assert.equal(context.queue.length, 1);
  assert.equal(context.queue[0].pipelineName, '流水线一');
  assert.deepEqual(calls.focusQueue, [context.queue[0].id]);
  assert.equal(calls.renderQueue.length, 1);
  assert.deepEqual(calls.alerts, []);
});

test('本地队列已满：拒绝排队且不切换视图', () => {
  const queue = Array.from({ length: 16 }, (_, i) => ({ id: 'q-old-' + i }));
  const { context, calls } = makeContext({ conflictsActive: () => true, queue });
  const r = context.runPipeline({ pipelineId: 'pipe-1' });
  assert.equal(r, false);
  assert.equal(queue.length, 16);
  assert.deepEqual(calls.focusQueue, []);
});

test('本地立即启动但节点租约在途：先给该次任务的排队预览', () => {
  const { context, calls } = makeContext({
    startRun: item => { calls.startRun.push(item); context.pendingLeaseStarts.push({ envs: item.envs, queueItem: item }); return true; },
  });
  const r = context.runPipeline({ pipelineId: 'pipe-1' });
  assert.equal(r, true);
  assert.equal(calls.startRun.length, 1);
  assert.deepEqual(calls.focusQueue, [calls.startRun[0].id]);
});

test('本地立即启动（无租约环节）：焦点由 startSimRun 负责，不覆盖回排队预览', () => {
  const { context, calls } = makeContext();
  const r = context.runPipeline({ pipelineId: 'pipe-1' });
  assert.equal(r, true);
  assert.equal(calls.startRun.length, 1);
  assert.deepEqual(calls.focusQueue, []);
});

test('服务端提交成功即跟随：快照刷新后立即可见', async () => {
  const holder = {};
  const { context, calls } = makeContext();
  holder.calls = calls;
  context.pullRemoteQueue = async () => { calls.pullQueue.push(1); context.remoteQueueClients = serverSnapshotQueued('api-xyz'); };
  const r = context.runPipeline({ pipelineId: 'pipe-2' });
  assert.equal(r, 'submitted');
  await flush();
  assert.match(calls.fetch[0].url, /\/api\/worktable\/pipeline\/run\/pipe-2$/);
  assert.equal(calls.focusRun.length, 1);
  assert.equal(calls.focusRun[0].remoteItemId, 'api-xyz');
  assert.equal(calls.focusRun[0].remoteKind, 'queued');
  assert.equal(vm.runInContext('pendingServerRunFocus', context), null);
});

test('服务端提交：runId 延迟出现时跨轮询等待，出现后跟随', async () => {
  const { context, calls } = makeContext();   // pullRemoteQueue 桩不写入快照 → runId 暂不可见
  const r = context.runPipeline({ pipelineId: 'pipe-2' });
  assert.equal(r, 'submitted');
  await flush();
  assert.deepEqual(calls.focusRun, []);
  assert.ok(vm.runInContext('pendingServerRunFocus', context), 'runId 未出现时应保留待跟随状态');

  context.remoteQueueClients = serverSnapshotQueued('api-xyz');   // 模拟下一次轮询快照
  vm.runInContext('followPendingServerRun()', context);
  assert.equal(calls.focusRun.length, 1);
  assert.equal(calls.focusRun[0].remoteItemId, 'api-xyz');
  assert.equal(vm.runInContext('pendingServerRunFocus', context), null);
});

test('服务端提交：runId 始终不出现时超时自动放弃', async () => {
  const { context, calls } = makeContext();
  context.runPipeline({ pipelineId: 'pipe-2' });
  await flush();
  vm.runInContext('pendingServerRunFocus && (pendingServerRunFocus.until = Date.now() - 1000)', context);
  vm.runInContext('followPendingServerRun()', context);
  assert.equal(vm.runInContext('pendingServerRunFocus', context), null);
  assert.deepEqual(calls.focusRun, []);
});

test('服务端提交失败：弹窗提示且不进入自动跟随', async () => {
  const { context, calls } = makeContext({
    fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: 'pipeline execution queue full' }) }),
  });
  const r = context.runPipeline({ pipelineId: 'pipe-2' });
  assert.equal(r, 'submitted');
  await flush();
  assert.equal(calls.alerts.length, 1);
  assert.match(calls.alerts[0], /提交服务端运行失败/);
  assert.equal(vm.runInContext('pendingServerRunFocus', context), null);
  assert.deepEqual(calls.focusRun, []);
});

test('排队→在跑跟随：服务端权威条目同 runId 直接续看', () => {
  const { context } = makeContext();
  context.remoteQueueClients = [{
    id: 'server', queue: [],
    runs: [{ id: 'api-xyz', pipelineId: 'pipe-2', stages: [{ id: 's2', name: '部署' }], nodes: { s2: { status: 'running', progress: 40, dur: 5 } }, startedAt: Date.now() }],
  }];
  context.__prev = { remotePreview: true, remoteClientId: 'server', remoteItemId: 'api-xyz', remoteKind: 'queued', stages: [{ id: 's2', name: '部署' }], selId: 's2', remoteLogs: {} };
  const next = vm.runInContext('refreshRemoteQueuePreviewRc(__prev)', context);
  assert.ok(next, '排队项启动后预览不应被清空');
  assert.equal(next.remoteKind, 'running');
  assert.equal(next.remoteItemId, 'api-xyz');
  assert.equal(next.selId, 's2');
});

test('排队→在跑跟随：旧浏览器在场条目仍按 originQueueId 关联', () => {
  const { context } = makeContext();
  context.remoteQueueClients = [{
    id: 'c9', queue: [],
    running: { id: 'r9', originQueueId: 'q9', stages: [{ id: 's2', name: '部署' }], nodes: {} },
  }];
  context.__prev = { remotePreview: true, remoteClientId: 'c9', remoteItemId: 'q9', remoteKind: 'queued', stages: [{ id: 's2', name: '部署' }], selId: 's2', remoteLogs: {} };
  const next = vm.runInContext('refreshRemoteQueuePreviewRc(__prev)', context);
  assert.ok(next);
  assert.equal(next.remoteKind, 'running');
  assert.equal(next.remoteItemId, 'r9');
});
