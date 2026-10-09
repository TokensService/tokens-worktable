// server.finished（服务端执行池终态权威下发，完成≠失联）的客户端消费回归测试：
// ① pullRemoteQueue 解析 server.finished 存 remoteServerFinished，内容进签名（变化必重绘）；
// ② 新终态条目记入 completed 终态登记（孤儿抑制：绝不计入孤儿）+ 立即触发历史刷新（按 id 去重幂等）；
// ③ 队列区渲染短暂终态行（成功/失败/取消样式区分，随 TTL 消失）；④ 正在查看的服务端运行进入
// finished 后优雅收尾（终态徽标 + 阶段节点收尾 + 停止日志轮询 + 与快照脱钩粘住）；
// ⑤ 合规回归：历史/孤儿重跑在阶段全为服务端可执行时确实走 submitServerRun（非本地执行），source 语义透传。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));   // vm 沙盒产物的原型链与主 realm 不同，深比较前先归一化
function extract(startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start);
  assert.ok(start >= 0 && end > start, startMark + ' not found');
  return source.slice(start, end);
}

const finEntry = (id, status, extra) => Object.assign({
  id, pipelineId: 'p1', pipelineName: '发布', by: 'alice', source: 'manual',
  status, dur: 12, startedAt: 90, endedAt: 100,
  stages: [{ stage: '构建', status: status === 'success' ? 'success' : 'failed', dur: 9 }, { stage: '部署', status: 'idle', dur: 0 }],
}, extra || {});

function fakeSessionStorage() {
  const data = new Map();
  return {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: k => { data.delete(k); },
    _data: data,
  };
}

/* ---------- ①② pullRemoteQueue 消费 server.finished ---------- */
function loadPullContext(overrides) {
  const calls = { render: 0, history: 0, noted: [] };
  const context = Object.assign({
    QCLIENT_ID: 'self', remoteQueueClients: [], remoteOrphans: [], remoteServerFinished: [], _serverFinishedSeen: {}, viewRc: null,
    fetch: async () => ({ ok: false }),
    planActiveSig: () => '', _planActiveSig: '', renderPlanList: () => {},
    applyRemoteQueuePreviewRefresh: () => {}, applyOrphanPreviewRefresh: () => {},
    pullRemoteQueueLog: async () => null,
    renderQueue: () => { calls.render += 1; },
    queueFinishedNote: id => calls.noted.push(id),
    refreshHistoryFromServer: () => { calls.history += 1; return Promise.resolve(true); },
    followPendingServerRun: () => {},
    console,
  }, overrides || {});
  vm.createContext(context);
  vm.runInContext(extract('/* 拉取服务端权威队列及旧标签页', "$('queueRefresh')"), context);
  return { context, calls };
}

test('pullRemoteQueue：server.finished 入状态入签名；新终态登记 completed + 历史即刷（按 id 去重）', async () => {
  const payload = { clients: [], server: { id: 'server', label: '服务端', runs: [], queue: [], finished: [finEntry('srv-1', 'success')] } };
  const { context, calls } = loadPullContext({
    fetch: async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(payload)) }),
  });
  await context.pullRemoteQueue();
  assert.equal(calls.render, 1, '首轮建立基线签名正常重绘');
  assert.equal(context.remoteServerFinished.length, 1, 'finished 存 remoteServerFinished');
  assert.equal(plain(context.remoteServerFinished)[0].id, 'srv-1');
  assert.deepEqual(calls.noted, ['srv-1'], '新终态记入 completed 终态登记（完成≠失联，豁免孤儿判定）');
  assert.equal(calls.history, 1, '新终态立即触发一次历史刷新（不等 3s 轮询）');

  await context.pullRemoteQueue();
  assert.equal(calls.render, 1, '快照内容未变跳过重绘');
  assert.deepEqual(calls.noted, ['srv-1'], '同一 id 在服务端 TTL 窗口内不重复登记');
  assert.equal(calls.history, 1, '同一 id 不重复刷历史');

  payload.server.finished.unshift(finEntry('srv-2', 'failure'));   // 最新在前
  await context.pullRemoteQueue();
  assert.equal(calls.render, 2, 'finished 新增触发重绘');
  assert.deepEqual(calls.noted, ['srv-1', 'srv-2']);
  assert.equal(calls.history, 2);

  payload.server.finished = [];   // 服务端 TTL 消失
  await context.pullRemoteQueue();
  assert.equal(calls.render, 3, 'finished 清空（TTL 消失）同样触发重绘');
  assert.deepEqual(plain(context.remoteServerFinished), []);

  delete payload.server.finished;   // 旧服务端无此键：优雅降级不报错
  await context.pullRemoteQueue();
  assert.equal(calls.render, 3, '旧服务端缺键不再改变签名');
});

test('noteServerFinished 与真实 queueFinishedNote 组合：登记进 completed（pip-qfinished），窗口内幂等', () => {
  const calls = { history: 0 };
  const context = {
    sessionStorage: fakeSessionStorage(), _serverFinishedSeen: {},
    refreshHistoryFromServer: () => { calls.history += 1; },
    console,
  };
  vm.createContext(context);
  vm.runInContext(extract('const QUEUE_FINISHED_TTL_MS', '/* 上报快照体'), context);   // queueFinishedNote/queueFinishedIds
  vm.runInContext(extract('/* 拉取服务端权威队列及旧标签页', "$('queueRefresh')"), context);   // noteServerFinished

  context.noteServerFinished([finEntry('srv-1', 'success'), finEntry('srv-2', 'cancelled')]);
  assert.deepEqual(plain(context.queueFinishedIds()), ['srv-1', 'srv-2'], '终态 id 进入 completed 登记（随上报豁免孤儿判定）');
  assert.equal(calls.history, 1, '同批多个新终态只触发一次历史刷新');

  context.noteServerFinished([finEntry('srv-1', 'success'), finEntry('srv-2', 'cancelled')]);
  assert.deepEqual(plain(context.queueFinishedIds()), ['srv-1', 'srv-2'], '窗口内重复下发不重复登记');
  assert.equal(calls.history, 1, '无新终态不再刷历史');
});

/* ---------- ③ renderQueue 终态行渲染 ---------- */
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.handlers = {};
    this._html = '';
    this.className = '';
    this.title = '';
    this.textContent = '';
    this.disabled = false;
    this.style = {};
  }
  set innerHTML(value) { this._html = value; if (!value) this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(node) { this.children.push(node); }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  querySelectorAll() { return []; }
}

function makeQueueContext(overrides) {
  const list = new FakeNode('div');
  const els = { queueList: list, queueCount: new FakeNode('span'), queueStatus: new FakeNode('span'), stopBtn: new FakeNode('button') };
  const context = Object.assign({
    document: { createElement: tag => new FakeNode(tag), querySelectorAll: () => [] },
    $: id => els[id] || new FakeNode('div'),
    queue: [], pendingLeaseStarts: [], activeRuns: [], viewRc: null, running: false, remoteQueueClients: [],
    remoteOrphans: [], remoteServerFinished: [],
    queueReasonOpen: new Set(), MAX_ACTIVE_RUNS: 4,
    esc: String, sourceLabel: s => (s === 'manual' ? '手动' : s), fmtRelative: () => '刚刚', fmtDur: s => Math.round(s) + 's',
    runInfoLine: () => '<div class="dshell-muted">info</div>',
    drainQueue: () => {}, cancelQueue: () => {}, abortRun: () => {}, cancelServerRun: () => {},
    canControlRun: () => true,
    focusRun: () => {}, focusQueueItem: () => {}, focusRemoteQueueItem: () => {},
    focusOrphanQueueItem: () => {}, dismissOrphanQueueItem: () => {}, rerunOrphanQueueItem: () => {},
    orphanQueueItem: () => null,
    findPipeline: () => null,
    scheduleQueuePublish: () => {},
    refreshPipelineQueueCounts: () => {},
    syncViewRun: () => {}, applyRunOverall: () => {}, refreshArchiveTip: () => {}, resetNodes: () => {},
    alert: () => {},
    console,
  }, overrides || {});
  vm.createContext(context);
  vm.runInContext(extract('function localQueueItems', 'function queuePreviewRc'), context);
  vm.runInContext(extract('function remoteQueueDetailAvailable', 'function remoteQueuePreviewRc'), context);
  vm.runInContext(extract('function remoteQueueViewAttrs', 'function renderQueue(){'), context);
  vm.runInContext(extract('function renderQueue(){', '/* ---------- 运行引擎'), context);
  return { context, list, els };
}

test('renderQueue：server.finished 渲染「服务端最近完成」终态行（成功/失败/取消样式区分），不计入头部计数', () => {
  const { context, list, els } = makeQueueContext();
  context.remoteServerFinished.push(finEntry('srv-1', 'success'), finEntry('srv-2', 'failure', { by: 'bob', pipelineName: '测试' }), finEntry('srv-3', 'cancelled'));
  context.renderQueue();

  assert.equal(els.queueCount.textContent, '', '终态行不计入运行队列头部计数（非待办项）');
  assert.equal(els.queueStatus.textContent, '空闲', '终态行不改变头部状态徽标');
  assert.equal(list.style.display, '', '仅有终态行时明细列表展开');
  assert.match(list.children[0].innerHTML, /— 服务端最近完成 —/);
  assert.match(list.children[1].innerHTML, /alice · 发布/);
  assert.match(list.children[1].innerHTML, />成功<\/span>/);
  assert.match(list.children[1].innerHTML, /var\(--st-ok\)/, '成功徽标用 --st-ok');
  assert.match(list.children[1].innerHTML, /耗时 12s/);
  assert.match(list.children[2].innerHTML, />失败<\/span>/);
  assert.match(list.children[2].innerHTML, /var\(--st-err\)/, '失败徽标用 --st-err');
  assert.match(list.children[3].innerHTML, />已取消<\/span>/);
  assert.match(list.children[3].innerHTML, /var\(--st-idle\)/, '取消徽标用 --st-idle');

  context.remoteServerFinished.length = 0;   // 服务端 TTL 消失
  context.renderQueue();
  assert.equal(list.children.length, 0, 'TTL 消失后不再渲染终态行');
  assert.equal(list.style.display, 'none');
});

test('renderQueue：无 server.finished（旧服务端）保持原行为不报错', () => {
  const { context, list, els } = makeQueueContext();
  delete context.remoteServerFinished;   // vm 全局缺省：typeof 兜底
  context.renderQueue();
  assert.equal(list.children.length, 0);
  assert.equal(list.style.display, 'none');
  assert.equal(els.queueStatus.textContent, '空闲');
});

/* ---------- ④ 正在查看的服务端运行进入 finished 后优雅收尾 ---------- */
function loadPreviewContext() {
  const context = {
    GITURL: 'g', DEFAULT_IMAGE: 'img',
    viewRc: null,
    remoteServerFinished: [],
    remoteQueueClients: [{
      id: 'server', label: '服务端', queue: [],
      runs: [{
        id: 'r1', pipelineId: 'p1', pipelineName: '发布', by: 'alice', source: 'manual', startedAt: 100,
        stages: [{ id: 's1', name: '构建' }, { id: 's2', name: '部署' }],
        nodes: { s1: { status: 'running', progress: 40, dur: 8 }, s2: { status: 'idle', progress: 0, dur: 0 } },
      }],
    }],
    expandRunStages: stages => stages,
    console,
  };
  vm.createContext(context);
  vm.runInContext(extract('function queueStagePresence', '/* 最近正常终态登记'), context);   // queueStagePresence/queueNodePresence
  vm.runInContext(extract('function remoteQueueDetailAvailable(item){', 'function applyRemoteQueuePreviewRefresh(){'), context);
  vm.runInContext(extract('function remoteRunsOf', '/* ---------- 运行引擎'), context);
  return context;
}

test('refreshRemoteQueuePreviewRc：runId 进入 finished 后收尾为终态预览（阶段按名称对应收尾），并与快照脱钩粘住', () => {
  const context = loadPreviewContext();
  const client = context.remoteQueueClients[0];
  const previous = context.remoteQueuePreviewRc(client, client.runs[0], 'running');
  assert.equal(previous.nodes.s1.status, 'running');

  context.remoteQueueClients[0].runs = [];   // 运行从快照消失
  context.remoteServerFinished = [finEntry('r1', 'failure')];
  const terminal = context.refreshRemoteQueuePreviewRc(previous);
  assert.ok(terminal, 'id 出现在 server.finished：不得按失联清空预览');
  assert.equal(terminal.remoteFinished.status, 'failure');
  assert.equal(terminal.over, true);
  assert.match(terminal.overall.txt, /已结束：失败/);
  assert.equal(terminal.nodes.s1.status, 'failed', '运行中节点按终态条目收尾（stage 字段是阶段名）');
  assert.equal(terminal.nodes.s1.dur, 9);
  assert.equal(terminal.nodes.s2.status, 'idle', '未开始节点保持原样');

  context.remoteServerFinished = [];   // 终态条目 TTL 消失
  const sticky = context.refreshRemoteQueuePreviewRc(terminal);
  assert.equal(sticky, terminal, '已终态预览与快照脱钩：TTL 消失不再重置视图，直到用户切换');

  /* 旧服务端无 finished 数据：维持原消失即重置（返回 null 由调用方回空闲编排） */
  const legacy = context.refreshRemoteQueuePreviewRc(previous);
  assert.equal(legacy, null);
});

test('pullRemoteQueueLog：已进入终态的预览停止日志轮询（不再发请求）', async () => {
  let fetches = 0;
  const context = {
    viewRc: { remotePreview: true, remoteFinished: { id: 'r1', status: 'success', endedAt: 1 }, remoteClientId: 'server', remoteKind: 'running', remoteItemId: 'r1', remoteLogs: {} },
    selectedId: 's1',
    fetch: async () => { fetches += 1; return { ok: true, json: async () => ({ text: 'x', revision: 1 }) }; },
    renderDetail: () => {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(extract('/* 当前详情的服务端日志独立于普通队列快照拉取', '/* 拉取服务端权威队列及旧标签页'), context);
  const skipped = await context.pullRemoteQueueLog();
  assert.equal(skipped, null);
  assert.equal(fetches, 0, 'remoteFinished 标记后直接返回，不再轮询该 run 的日志');

  context.viewRc = { remotePreview: true, remoteClientId: 'server', remoteKind: 'running', remoteItemId: 'r1', remoteLogs: {} };
  const log = await context.pullRemoteQueueLog();
  assert.equal(fetches, 1, '运行中的服务端预览仍按原通道拉取日志');
  assert.equal(log.text, 'x');
});

/* ---------- ⑤ 合规回归：历史/孤儿重跑在阶段全为服务端可执行时走 submitServerRun ---------- */
function loadRerunContext(overrides) {
  const calls = { fetch: [], startRun: [], dismiss: [], alerts: [], tips: [] };
  const context = Object.assign({
    console,
    queue: [], activeRuns: [], pendingLeaseStarts: [], remoteQueueClients: [], remoteOrphans: [],
    MAX_ACTIVE_RUNS: 4, QUEUE_CAP: 16, DEFAULT_IMAGE: 'myapp', GITURL: 'https://git.example.com/dev/myapp',
    currentUsername: 'tester', curPipelineId: 'pipe-1', viewRc: null,
    pipelines: [
      { id: 'pipe-local', name: '本地流水线', stages: [{ id: 's1', name: '构建' }] },   // 无 sched：本地执行
      { id: 'pipe-server', name: '服务端流水线', stages: [{ id: 's2', name: '部署', sched: '0 2 * * *' }] },   // 全 sched：服务端执行
    ],
    findPipeline: id => context.pipelines.find(p => p.id === id),
    curPipeline: () => context.pipelines[0],
    resolvePipelineRunOptions: (pl, opts) => opts,
    curEnvs: () => [{ id: 'e1', ip: '10.0.0.1', name: '节点1' }],
    resolveEnv: env => ({ id: 'e1', ip: String(env || '') }),
    resolveRepo: () => ({ id: 'repo-1', name: 'myapp' }),
    repositories: [{ id: 'repo-1', name: 'myapp' }],
    environments: [{ id: 'e1', ip: '10.0.0.1', name: '节点1' }],
    $: id => ({ value: id === 'branchName' ? 'main' : 'repo-1' }),
    curStrategy: () => '',
    selectedPresetKeys: () => [],
    expandRunStages: stages => stages,
    conflictsActive: () => false,
    machineConflict: () => false,
    startRun: item => { calls.startRun.push(item); return true; },
    renderQueue: () => {},
    focusQueueItem: () => {},
    focusRun: () => {},
    pullRemoteQueue: async () => {},
    queueStagePresence: s => ({ id: String(s && s.id || ''), name: String(s && s.name || '') }),
    queueNodePresence: n => ({ status: String(n && n.status || 'idle'), progress: 0, dur: 0, sub: {} }),
    fetch: async (url, opts) => {
      calls.fetch.push({ url, opts });
      return { ok: true, json: async () => ({ ok: true, accepted: true, runId: 'srv-1' }) };
    },
    alert: msg => { calls.alerts.push(String(msg)); },
    flashRunTip: msg => { calls.tips.push(String(msg)); },
    dismissOrphanQueueItem: async () => { calls.dismiss.push(1); },
  }, overrides || {});
  vm.createContext(context);
  vm.runInContext(extract('function localQueueItems(){', 'function queuePreviewRc'), context);
  vm.runInContext(extract('function queuePreviewRc(item){', 'function focusQueueItem(id){'), context);
  vm.runInContext(extract('function remoteQueueDetailAvailable(item){', 'function applyRemoteQueuePreviewRefresh(){'), context);
  vm.runInContext(extract('function orphanQueueItem', '/* ---------- 服务端权威运行队列实时同步'), context);
  vm.runInContext(extract('function remoteRunsOf', '/* ---------- 运行引擎'), context);
  vm.runInContext(extract('async function submitServerRun(item){', 'function runPipeline(opts){'), context);
  vm.runInContext(extract('function runPipeline(opts){', '/* 机器占用判定'), context);
  vm.runInContext(extract('function rerunOrphanQueueItem', '/* 取消服务端权威任务'), context);
  vm.runInContext(extract('function rerunFromHistory(rec){', "$('histRerun')"), context);
  return { context, calls };
}

async function flush() { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); }

test('历史重跑：阶段全为服务端可执行（全 sched）时确实提交 submitServerRun，含本地阶段时走本地执行', async () => {
  const { context, calls } = loadRerunContext();
  context.rerunFromHistory({ pipelineId: 'pipe-server', pipeline: '服务端流水线', env: '10.0.0.1', branch: 'dev', strategy: '', repoId: null, no: 7 });
  await flush();
  assert.equal(calls.fetch.length, 1, '全 sched 流水线重跑应提交服务端执行池');
  assert.match(calls.fetch[0].url, /\/api\/worktable\/pipeline\/run\/pipe-server$/);
  assert.equal(JSON.parse(calls.fetch[0].opts.body).source, 'manual', '重跑是一次新的手动运行（执行人取当前登录用户）');
  assert.equal(calls.startRun.length, 0, '不得走浏览器本地执行');
  assert.match(calls.tips[0] || '', /已提交服务端重跑/);

  const local = loadRerunContext();
  local.context.rerunFromHistory({ pipelineId: 'pipe-local', pipeline: '本地流水线', env: '10.0.0.1', branch: 'dev', strategy: '', repoId: null, no: 8 });
  await flush();
  assert.equal(local.calls.startRun.length, 1, '含「需本地运行」阶段（sched=null）的重跑维持本地执行（行为不变）');
  assert.equal(local.calls.fetch.length, 0, '本地执行不得提交服务端');
});

test('孤儿重跑：流水线阶段全为服务端可执行时确实提交 submitServerRun 并顺手 dismiss', async () => {
  const { context, calls } = loadRerunContext({
    remoteOrphans: [{
      id: 'r1', ownerId: 'abc123', ownerLabel: 'Chrome·c123', kind: 'running', orphanedAt: 500,
      pipelineId: 'pipe-server', pipelineName: '服务端流水线', by: 'alice', source: 'manual', startedAt: 100,
      env: '10.0.0.1', branch: 'dev', strategy: '',
      stages: [{ id: 's2', name: '部署' }],   // 快照无 sched（白名单字段）：不得据此分流，必须用流水线完整定义
      nodes: {},
    }],
  });
  context.rerunOrphanQueueItem('abc123', 'r1');
  await flush();
  assert.equal(calls.fetch.length, 1, '按流水线当前完整定义（全 sched）应提交服务端执行池');
  assert.match(calls.fetch[0].url, /\/api\/worktable\/pipeline\/run\/pipe-server$/);
  assert.equal(calls.startRun.length, 0);
  assert.equal(calls.dismiss.length, 1, '重跑成功顺手 dismiss 孤儿登记');
  assert.match(calls.tips[0] || '', /已提交服务端运行队列/);
});

test('submitServerRun：source 透传（schedule 系来源保留语义；缺省仍为 manual）', async () => {
  const { context, calls } = loadRerunContext();
  context.runPipeline({ pipelineId: 'pipe-server', source: 'schedule:pipe-server' });
  await flush();
  assert.equal(JSON.parse(calls.fetch[0].opts.body).source, 'schedule:pipe-server', 'schedule 系来源经 runPipeline 分流到服务端时保留来源语义');

  const manual = loadRerunContext();
  manual.context.runPipeline({ pipelineId: 'pipe-server' });
  await flush();
  assert.equal(JSON.parse(manual.calls.fetch[0].opts.body).source, 'manual', '缺省来源仍为 manual');
});
