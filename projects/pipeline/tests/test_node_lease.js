// 节点占用租约（页面侧）：startRun 租约门控（成功才开跑/被拒回队等待/异常降级/无节点直启）、
// conflictsActive 在途占用、drainQueue nodeWait 节流与同机 FIFO、finish 释放租约、renderQueue 等待标注。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));   // vm 沙盒产物的原型链与主 realm 不同，深比较前先归一化
/* 按花括号配平精确抽取单个函数（所取函数体字符串内无花括号字面量） */
function extractFn(mark) {
  const start = source.indexOf(mark);
  assert.ok(start >= 0, mark + ' not found');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (!depth) return source.slice(start, i + 1); }
  }
  throw new Error(mark + ' 未闭合');
}
function extract(startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start);
  assert.ok(start >= 0 && end > start, startMark + ' not found');
  return source.slice(start, end);
}

/* ---------- startRun 租约门控 ---------- */
function makeStartRunContext(leaseResult) {
  const calls = { sim: [], leaseReq: [], render: 0 };
  const context = {
    DEFAULT_IMAGE: 'img', GITURL: 'g',
    findPipeline: () => null,
    curPipelineId: 'p1',
    curPipeline: () => ({ id: 'p1', name: 'PL', stages: [] }),
    curEnvs: () => [{ ip: '10.0.0.1' }],
    resolveEnv: ip => ({ ip }),
    resolveRepo: () => ({ id: 'r', name: 'r' }),
    $: () => ({ value: '' }),
    currentUsername: 'tester',
    curStrategy: () => '',
    selectedPresetKeys: () => [],
    startSimRun: (pl, c) => { calls.sim.push({ pl, c }); },
    queue: [],
    renderQueue: () => { calls.render++; },
    NODE_WAIT_RETRY_MS: 5000,
    pendingLeaseStarts: [],
    nodeLeaseRequest: async body => { calls.leaseReq.push(body); if (leaseResult instanceof Error) throw leaseResult; return leaseResult; },
    console,
  };
  vm.createContext(context);
  vm.runInContext(extractFn('function runIps(x){'), context);
  vm.runInContext(extractFn('function startRun(opts){'), context);
  return { context, calls };
}
const flush = () => new Promise(r => setImmediate(r));

test('startRun：租约申请成功才开跑，在途期间占调度槽位', async () => {
  const { context, calls } = makeStartRunContext({ ok: true });
  const item = { id: 'q1', envs: [{ ip: '10.0.0.1' }], by: 'alice', stages: [] };
  assert.equal(context.startRun(item), true);
  assert.equal(calls.sim.length, 0, '租约在途：尚未开跑');
  assert.equal(context.pendingLeaseStarts.length, 1, '在途占一个调度槽位');
  await flush();
  assert.equal(calls.sim.length, 1, '租约拿到后开跑');
  assert.equal(context.pendingLeaseStarts.length, 0, '在途槽位已排空');
  assert.equal(calls.leaseReq.length, 1);
  assert.equal(calls.leaseReq[0].action, 'acquire');
  assert.equal(calls.leaseReq[0].runId, 'q1');
  assert.deepEqual(plain(calls.leaseReq[0].ips), ['10.0.0.1']);
  assert.deepEqual(plain(calls.sim[0].c.leaseIps), ['10.0.0.1'], '运行上下文携带租约 IP 供续租/释放');
  assert.equal(calls.sim[0].c.leaseId, 'q1');
  assert.equal(calls.sim[0].c.originQueueId, 'q1', '异步拿到租约后仍保留队列来源 id，供他端详情连续跟随');
});

test('startRun：节点被他端占用时不开跑，回队等待并标注占用者', async () => {
  const denied = { ok: false, conflicts: [{ ip: '10.0.0.1', owner: 'r9', label: '部署', by: 'bob', since: 1 }] };
  const { context, calls } = makeStartRunContext(denied);
  const item = { id: 'q1', envs: [{ ip: '10.0.0.1' }], by: 'alice', stages: [] };
  context.startRun(item);
  await flush();
  assert.equal(calls.sim.length, 0, '租约被拒：不开跑');
  assert.equal(context.pendingLeaseStarts.length, 0, '在途槽位已排空');
  assert.equal(context.queue.length, 1, '回队等待');
  assert.equal(context.queue[0].id, 'q1');
  const wait = context.queue[0].nodeWait;
  assert.ok(wait && wait.until > Date.now() && wait.until <= Date.now() + 5000, 'nodeWait 带节流重试时间');
  assert.equal(wait.conflicts[0].by, 'bob', '占用者信息供队列区展示');
  assert.ok(calls.render >= 1, '回队后重绘队列区');
});

test('runPipeline：租约被拒回队时与在途容量预留合计不超过 16 项', async () => {
  let resolveLease;
  const leaseResult = new Promise(resolve => { resolveLease = resolve; });
  const { context } = makeStartRunContext(leaseResult);
  const pipeline = { id: 'p-local', name: '本地流水线', stages: [{ id: 's1', name: '构建', sched: null }] };
  Object.assign(context, {
    MAX_ACTIVE_RUNS: 4, QUEUE_CAP: 16, activeRuns: [],
    findPipeline: id => id === pipeline.id ? pipeline : null,
    curPipeline: () => pipeline, curPipelineId: pipeline.id,
    resolvePipelineRunOptions: (pl, opts) => opts,
    pipelineDefaultRunIssue: () => '',
    conflictsActive: undefined, machineConflict: undefined,
    submitServerRun: () => { throw new Error('本地阶段不得提交服务端'); },
  });
  vm.runInContext(extractFn('function machineConflict(a,b){'), context);
  vm.runInContext(extractFn('function conflictsActive(item){'), context);
  vm.runInContext(extractFn('function runPipeline(opts){'), context);

  assert.equal(context.runPipeline({ pipelineId: pipeline.id, envs: [{ ip: '10.0.0.1' }], by: 'first' }), true);
  assert.equal(context.pendingLeaseStarts.length, 1);
  context.activeRuns.push({ id: 'r1' }, { id: 'r2' }, { id: 'r3' });
  const results = Array.from({ length: 16 }, (_, i) => context.runPipeline({
    pipelineId: pipeline.id, envs: [{ ip: '10.0.1.' + i }], by: 'queued-' + i,
  }));
  assert.equal(results.filter(result => result === 'queued').length, 15);
  assert.equal(results.at(-1), false, '第 16 个新排队请求为租约在途项预留回队名额');

  resolveLease({ ok: false, conflicts: [{ ip: '10.0.0.1', by: 'other' }] });
  await flush();
  assert.equal(context.pendingLeaseStarts.length, 0);
  assert.equal(context.queue.length, 16, '租约拒绝项回队后仍不超过本地队列上限');
  assert.equal(context.queue[0].by, 'first', '先前已接受的租约申请失败后保留任务并回到队首');
});

test('startRun：租约服务不可达（旧插件无此路由）时降级直接开跑', async () => {
  const { context, calls } = makeStartRunContext(new Error('node lease http 404'));
  context.startRun({ id: 'q1', envs: [{ ip: '10.0.0.1' }], by: 'alice', stages: [] });
  await flush();
  assert.equal(calls.sim.length, 1, '降级为仅页内互斥的旧行为，不阻断运行');
  assert.equal(context.queue.length, 0);
  assert.equal(context.pendingLeaseStarts.length, 0);
});

test('startRun：无目标节点不申请租约、同步直接开跑', () => {
  const { context, calls } = makeStartRunContext({ ok: true });
  context.curEnvs = () => [{ name: 'no-ip' }];   // 节点无 IP：没有可互斥的目标
  context.startRun({ id: 'q1', by: 'alice', stages: [] });
  assert.equal(calls.sim.length, 1, '同步直接开跑');
  assert.equal(calls.leaseReq.length, 0, '不发租约请求');
  assert.equal(context.pendingLeaseStarts.length, 0);
});

/* ---------- conflictsActive：租约在途同样视为占用 ---------- */
function makeConflictContext(withPending) {
  const context = { activeRuns: [] };
  if (withPending) context.pendingLeaseStarts = [{ envs: [{ ip: 'X' }] }];
  vm.createContext(context);
  vm.runInContext(extractFn('function runIps(x){'), context);
  vm.runInContext(extractFn('function machineConflict(a,b){'), context);
  vm.runInContext(extractFn('function conflictsActive(item){'), context);
  return context;
}

test('conflictsActive：租约申请在途的启动同样视为机器占用；沙盒无该变量时按无在途处理', () => {
  const withPending = makeConflictContext(true);
  assert.equal(withPending.conflictsActive({ envs: [{ ip: 'X' }] }), true, '与在途启动同机：冲突');
  assert.equal(withPending.conflictsActive({ envs: [{ ip: 'Y' }] }), false, '异机不冲突');
  const bare = makeConflictContext(false);
  assert.equal(bare.conflictsActive({ envs: [{ ip: 'X' }] }), false, '无在途变量：按不冲突处理（旧语义）');
});

/* ---------- drainQueue：nodeWait 节流 ---------- */
function makeDrainContext() {
  const calls = { start: [] };
  const context = {
    DEFAULT_IMAGE: 'img', GITURL: 'g', MAX_ACTIVE_RUNS: 4, QUEUE_CAP: 16,
    activeRuns: [], queue: [], pendingLeaseStarts: [],
    findPipeline: id => ({ id, name: 'PL-' + id, stages: [] }),
    curPipelineId: 'p1',
    curPipeline: () => ({ id: 'p1', name: 'PL-p1', stages: [] }),
    resolvePipelineRunOptions: (pl, opts) => opts,
    pipelineDefaultRunIssue: () => null,
    $: () => ({ value: '' }),
    currentUsername: 'tester',
    curEnvs: () => [{ ip: '10.0.0.1' }],
    resolveEnv: ip => ({ ip }),
    resolveRepo: () => ({ id: 'repo1', name: 'repo1' }),
    curStrategy: () => '',
    selectedPresetKeys: () => [],
    startRun: item => { calls.start.push(item); context.activeRuns.push(item); return true; },
    renderQueue() {},
    alert: () => {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(extractFn('function runIps(x){'), context);
  vm.runInContext(extractFn('function machineConflict(a,b){'), context);
  vm.runInContext(extractFn('function conflictsActive(item){'), context);
  vm.runInContext(extractFn('function drainQueue(){'), context);
  return { context, calls };
}

test('drainQueue：等待节点的排队项在节流窗口内不重复申请，异机任务不受影响', () => {
  const { context, calls } = makeDrainContext();
  context.queue.push(
    { id: 'qW', envs: [{ ip: 'X' }], stages: [], nodeWait: { until: Date.now() + 60000, conflicts: [] } },
    { id: 'qB', envs: [{ ip: 'Y' }], stages: [] },
  );
  context.drainQueue();
  assert.deepEqual(calls.start.map(i => i.id), ['qB'], '异机任务正常启动');
  assert.deepEqual(context.queue.map(i => i.id), ['qW'], '节流窗口内留在队列');
  context.activeRuns.length = 0;
  context.queue[0].nodeWait.until = Date.now() - 1;   // 节流到期
  context.drainQueue();
  assert.deepEqual(calls.start.map(i => i.id), ['qB', 'qW'], '节流到期后重新尝试启动');
  assert.equal(context.queue.length, 0);
});

test('drainQueue：同机后来任务不越过等待节点中的前者（同机 FIFO）', () => {
  const { context, calls } = makeDrainContext();
  context.queue.push(
    { id: 'qW', envs: [{ ip: 'X' }], stages: [], nodeWait: { until: Date.now() + 60000, conflicts: [] } },
    { id: 'qX2', envs: [{ ip: 'X' }], stages: [] },
  );
  context.drainQueue();
  assert.deepEqual(calls.start.map(i => i.id), [], '同机后来者保持排队');
  assert.equal(context.queue.length, 2);
});

test('drainQueue：租约申请在途占满 4 个槽位后不再启动后续异机任务', () => {
  const { context, calls } = makeDrainContext();
  context.startRun = item => {
    calls.start.push(item);
    context.pendingLeaseStarts.push({ envs: item.envs, queueItem: item });
    return true;
  };
  ['A', 'B', 'C', 'D', 'E'].forEach(ip => context.queue.push({ id: 'q' + ip, envs: [{ ip }], stages: [] }));
  context.drainQueue();
  assert.deepEqual(calls.start.map(item => item.id), ['qA', 'qB', 'qC', 'qD']);
  assert.equal(context.pendingLeaseStarts.length, 4, '四个异步租约申请各占一个浏览器执行槽位');
  assert.deepEqual(context.queue.map(item => item.id), ['qE'], '第五个任务留在队列等待槽位');
});

/* ---------- finish：释放租约 ---------- */
function makeFinishContext() {
  const calls = { release: [], drain: 0, intervalsCleared: [] };
  const context = {
    activeRuns: [], viewRc: null,
    taskPromFinalize: () => {},
    syncRunState: () => {},
    $: () => ({ disabled: false }),
    viewActive: () => false,
    refreshArchiveTip: () => {},
    rcOverall: () => {},
    buildNo: 0,
    history: [], histPage: 0, selHistoryIdx: 0,
    renderHistory: () => {}, renderStats: () => {}, persistState: () => {},
    archiveRun: () => {}, renderDetail: () => {},
    drainQueue: () => { calls.drain++; }, renderQueue: () => {},
    fmtDur: () => '1s', nowHM: () => '10:00',
    promSnapshotForRun: () => null, collectRunLogs: () => [],
    archiveFolderFor: () => null,
    curPipeline: () => ({ name: 'PL' }),
    releaseNodeLease: (id, ips) => { calls.release.push({ id, ips }); },
    clearInterval: id => { calls.intervalsCleared.push(id); },
    console,
  };
  vm.createContext(context);
  vm.runInContext(extractFn('function finish(rc, result){'), context);
  return { context, calls };
}

test('finish：运行结束（含中止）释放节点租约并清理续租心跳', () => {
  const { context, calls } = makeFinishContext();
  const rc = { id: 'r1', over: false, timer: null, leaseTimer: 77, leaseId: 'q1', leaseIps: ['10.0.0.1'],
    stages: [], nodes: {}, startTs: Date.now() - 1000, by: 'alice', pipelineName: 'PL', env: '10.0.0.1',
    commit: 'abcdef123', tag: 't', vars: {} };
  context.activeRuns.push(rc);
  context.finish(rc, 'success');
  assert.deepEqual(calls.intervalsCleared, [77], '续租心跳已清理');
  assert.deepEqual(calls.release, [{ id: 'q1', ips: ['10.0.0.1'] }], '按 leaseId 释放节点租约');
  assert.equal(rc.leaseId, null);
  assert.equal(calls.drain, 1, '收尾后照常排空队列');
  assert.equal(context.activeRuns.length, 0);
});

test('finish：无租约的运行（无目标节点/旧行为）不触发释放', () => {
  const { context, calls } = makeFinishContext();
  const rc = { id: 'r2', over: false, timer: null, stages: [], nodes: {}, startTs: Date.now() - 1000,
    by: 'alice', pipelineName: 'PL', env: '', commit: 'abcdef123', tag: 't', vars: {} };
  context.activeRuns.push(rc);
  context.finish(rc, 'failed');
  assert.deepEqual(calls.release, []);
  assert.deepEqual(calls.intervalsCleared, []);
});

/* ---------- renderQueue：等待节点标注 ---------- */
class FakeNode {
  constructor(tag) {
    this.tag = tag; this.children = []; this.handlers = {}; this._html = '';
    this.className = ''; this.title = ''; this.textContent = ''; this.disabled = false; this.style = {};
  }
  set innerHTML(value) { this._html = value; if (!value) this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(node) { this.children.push(node); }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  querySelectorAll() { return []; }
}

test('renderQueue：等待节点的排队项展示占用节点与占用者', () => {
  const list = new FakeNode('div');
  const els = { queueList: list, queueCount: new FakeNode('span'), queueStatus: new FakeNode('span'), stopBtn: new FakeNode('button') };
  const context = {
    document: { createElement: tag => new FakeNode(tag) },
    $: id => els[id] || new FakeNode('div'),
    queue: [{ id: 'q1', by: 'alice', pipelineName: 'CI 构建', source: 'manual', queuedAt: 1,
      nodeWait: { until: Date.now() + 5000, conflicts: [{ ip: '10.0.0.1', by: 'bob', label: '部署' }] } }],
    pendingLeaseStarts: [], activeRuns: [], viewRc: null, running: false, remoteQueueClients: [],
    esc: String, sourceLabel: s => s, fmtRelative: () => '刚刚',
    runInfoLine: () => '<div class="dshell-muted">info</div>',
    drainQueue: () => {}, cancelQueue: () => {}, abortRun: () => {}, focusRun: () => {},
    canControlRun: () => true,   // 控制权守卫：本用例聚焦节点等待标注，放行使按钮按原行为渲染
    focusQueueItem: () => {}, renderPipelines: () => {}, scheduleQueuePublish: () => {},
    refreshPipelineQueueCounts: () => {},   // 本用例不挂载任务列表，只验证队列的节点等待文案
    syncViewRun: () => {}, applyRunOverall: () => {}, refreshArchiveTip: () => {}, resetNodes: () => {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(extract('function localQueueItems', 'function queuePreviewRc'), context);
  vm.runInContext(extract('function renderQueue(){', '/* ---------- 运行引擎'), context);
  context.renderQueue();
  assert.equal(list.children.length, 1);
  const html = list.children[0].innerHTML;
  assert.match(html, /等待节点/);
  assert.match(html, /10\.0\.0\.1/);
  assert.match(html, /bob · 部署/);
});
