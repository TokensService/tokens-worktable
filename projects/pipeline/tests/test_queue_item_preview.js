// 运行队列：排队任务点击查看详情预览；不同机器并行调度（machineConflict/drainQueue 真实实现）。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');
function extract(startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start);
  assert.ok(start >= 0 && end > start, startMark + ' not found');
  return source.slice(start, end);
}

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
  querySelectorAll(selector) {
    const attr = /^\[([^\]]+)\]$/.exec(selector)[1];
    const found = [];
    this.children.forEach(row => {
      const re = /<(span|button)\s+([^>]*)>/g;
      let match;
      while ((match = re.exec(row.innerHTML))) {
        const valueMatch = new RegExp(attr + '="([^"]+)"').exec(match[2]);
        if (!valueMatch) continue;
        const key = attr + ':' + valueMatch[1];
        row._els = row._els || {};
        const el = row._els[key] || new FakeNode(match[1]);
        const attributes = {};
        for (const item of match[2].matchAll(/([\w:-]+)="([^"]*)"/g)) attributes[item[1]] = item[2];
        el.attributes = Object.assign({}, el.attributes, attributes);
        el.getAttribute = name => (el.attributes || {})[name] || null;
        row._els[key] = el;
        found.push(el);
      }
    });
    return found;
  }
}

/* ---------- 排队项详情预览（queuePreviewRc / focusQueueItem） ---------- */
function makePreviewContext() {
  const calls = { expand: [], focus: [] };
  const context = {
    DEFAULT_IMAGE: 'myapp',
    GITURL: 'https://git.example.com/dev/myapp',
    viewRc: null,
    queue: [],
    pendingLeaseStarts: [],
    remoteQueueClients: [],
    expandRunStages: (stages, presets) => { calls.expand.push({ stages, presets }); return stages.map(s => ({ ...s })); },
    focusRun: rc => { calls.focus.push(rc); context.viewRc = rc; },
  };
  vm.createContext(context);
  const presenceStart = source.indexOf('function queueStagePresence');
  const presenceEnd = source.indexOf('function publishQueue', presenceStart);
  assert.ok(presenceStart >= 0 && presenceEnd > presenceStart, '缺少运行队列安全快照函数');
  vm.runInContext(source.slice(presenceStart, presenceEnd), context);
  vm.runInContext(extract('function localQueueItems', '/* ---------- 服务端权威运行队列实时同步'), context);
  vm.runInContext(extract('function remoteRunsOf', '/* ---------- 运行引擎'), context);
  return { context, calls };
}

const queueItem = {
  id: 'q1', pipelineId: 'p1', pipelineName: 'CI 构建', by: 'alice', source: 'manual', queuedAt: 111,
  env: '10.0.0.1', envs: [{ ip: '10.0.0.1' }], image: 'img', release: 'img',
  repoId: 'r1', repoName: 'myapp', branch: 'dev', strategy: 'rolling',
  presets: ['check'], stages: [{ id: 's1', name: '检出' }, { id: 's2', name: '构建' }],
};

test('queuePreviewRc：按入队快照构建只读预览 rc（阶段展开/节点 idle/over=true）', () => {
  const { context, calls } = makePreviewContext();
  const rc = context.queuePreviewRc(queueItem);
  assert.equal(rc.id, 'q1');
  assert.equal(rc.queuedPreview, true);
  assert.equal(rc.over, true, '预览不视作在跑运行（停止/重试/归档不指向它）');
  assert.equal(calls.expand.length, 1);
  assert.equal(calls.expand[0].stages, queueItem.stages, '阶段用入队时的快照');
  assert.deepEqual(calls.expand[0].presets, ['check'], '预设任务按入队勾选快照展开');
  assert.deepEqual(Object.keys(rc.nodes), ['s1', 's2']);
  assert.equal(rc.nodes.s1.status, 'idle');
  assert.equal(rc.selId, 's1');
  assert.equal(rc.overall.txt, '排队中（预览）');
  assert.equal(rc.overall.cls, 'dshell-badgeWait');
  assert.equal(rc.pipelineName, 'CI 构建');
  assert.equal(rc.env, '10.0.0.1');
  assert.equal(rc.repoName, 'myapp');
  assert.equal(rc.branch, 'dev');
  assert.equal(rc.strategy, 'rolling');
  assert.equal(rc.by, 'alice');
  assert.equal(rc.commit, '—', '排队项尚未分配 commit');
  assert.equal(rc.startTs, 111);
});

test('focusQueueItem：点击排队项聚焦其详情预览，重复点击/未知 id 不重复聚焦', () => {
  const { context, calls } = makePreviewContext();
  context.queue.push(queueItem);
  context.focusQueueItem('q1');
  assert.equal(calls.focus.length, 1);
  assert.equal(calls.focus[0].queuedPreview, true);
  assert.equal(calls.focus[0].id, 'q1');
  context.focusQueueItem('q1');   // 已在预览该项：不再重建
  assert.equal(calls.focus.length, 1);
  context.focusQueueItem('qX');   // 队列里不存在：忽略
  assert.equal(calls.focus.length, 1);
});

test('focusQueueItem：节点租约申请中的待启动项仍能聚焦详情', () => {
  const { context, calls } = makePreviewContext();
  context.pendingLeaseStarts.push({ queueItem });
  context.focusQueueItem('q1');
  assert.equal(calls.focus.length, 1);
  assert.equal(calls.focus[0].id, 'q1');
  assert.equal(calls.focus[0].queuedPreview, true);
});

test('remoteQueuePreviewRc：他端运行快照保留每个阶段的状态、进度和耗时', () => {
  const { context } = makePreviewContext();
  assert.equal(typeof context.remoteQueuePreviewRc, 'function', '应提供他端队列详情预览构造函数');
  const client = { id: 'c2', label: 'Chrome·xy12' };
  const item = {
    id: 'r2', pipelineId: 'p2', pipelineName: '远端部署', by: 'eve', source: 'manual', startedAt: 123,
    env: '10.0.0.2', repoName: 'app', branch: 'dev', strategy: 'rolling',
    stages: [{ id: 'checkout', name: '检出' }, { id: 'deploy', name: '部署' }],
    nodes: {
      checkout: { status: 'success', progress: 100, dur: 3.5, sub: {} },
      deploy: { status: 'running', progress: 42, dur: 7, sub: {} },
    },
  };

  const rc = context.remoteQueuePreviewRc(client, item, 'running');
  assert.equal(rc.remotePreview, true);
  assert.equal(rc.remoteClientId, 'c2');
  assert.equal(rc.remoteItemId, 'r2');
  assert.equal(rc.remoteKind, 'running');
  assert.equal(rc.over, true, '他端快照必须只读，不进入本页运行引擎');
  assert.equal(rc.overall.txt, '他端运行中（只读）');
  assert.equal(rc.nodes.checkout.status, 'success');
  assert.equal(rc.nodes.checkout.dur, 3.5);
  assert.equal(rc.nodes.deploy.status, 'running');
  assert.equal(rc.nodes.deploy.progress, 42);
  assert.equal(rc.pipelineName, '远端部署');
  assert.equal(rc.remoteClientLabel, 'Chrome·xy12');
  assert.equal(rc.image, '', '他端未同步镜像时不能伪造本页默认镜像');
  assert.equal(rc.release, '', '他端未同步 Release 时不能伪造本页默认值');
});

test('applyStatusClasses：远端异常阶段 id 与子阶段名不进入 CSS selector', () => {
  const stageId = 'build\"] [data-id="other';
  const subName = '子项\"] .other[';
  const classes = () => ({ values: new Set(), remove(...names) { names.forEach(name => this.values.delete(name)); }, add(name) { this.values.add(name); } });
  const bar = { style: {} };
  const meta = { textContent: '' };
  const sub = { dataset: { sub: subName }, className: '', classList: classes() };
  const node = {
    dataset: { id: stageId }, classList: classes(),
    querySelector(selector) {
      if (selector === '.pipeline-bar > i') return bar;
      if (selector === '.pipeline-nodeMeta') return meta;
      throw new Error('不应使用动态 selector: ' + selector);
    },
    querySelectorAll(selector) {
      assert.equal(selector, '.pipeline-sub span[data-sub]');
      return [sub];
    },
  };
  const context = {
    document: {
      querySelector() { throw new SyntaxError('异常 id 被拼入 selector'); },
      querySelectorAll(selector) { assert.equal(selector, '.pipeline-node[data-id]'); return [node]; },
    },
    flowStages: () => [{ id: stageId, name: '构建', sub: [subName] }],
    nodes: { [stageId]: { status: 'running', progress: 47, sub: { [subName]: 'success' } } },
    selectedId: stageId,
    metaFor: () => '47%',
  };
  vm.createContext(context);
  vm.runInContext(extract('function flowNodeElementById', 'function metaFor'), context);
  assert.doesNotThrow(() => context.applyStatusClasses());
  assert.equal(bar.style.width, '47%');
  assert.equal(node.classList.values.has('run'), true);
  assert.equal(node.classList.values.has('sel'), true);
  assert.equal(sub.classList.values.has('ok'), true);
});

test('focusRemoteQueueItem：他端在跑与排队条目都能聚焦，未知条目忽略', () => {
  const { context, calls } = makePreviewContext();
  assert.equal(typeof context.focusRemoteQueueItem, 'function', '应提供他端队列点击入口');
  context.remoteQueueClients.push({
    id: 'c2', label: 'Chrome·xy12',
    runs: [{ id: 'r2', pipelineName: 'P1', stages: [{ id: 's1', name: '构建' }], nodes: { s1: { status: 'running' } } }],
    queue: [{ id: 'q2', pipelineName: 'P2', stages: [{ id: 's2', name: '部署' }], nodes: { s2: { status: 'idle' } } }],
  });

  context.focusRemoteQueueItem('c2', 'r2', 'running');
  context.focusRemoteQueueItem('c2', 'q2', 'queued');
  context.focusRemoteQueueItem('c2', 'missing', 'queued');
  assert.equal(calls.focus.length, 2);
  assert.equal(calls.focus[0].remoteKind, 'running');
  assert.equal(calls.focus[1].remoteKind, 'queued');
});

test('refreshRemoteQueuePreviewRc：轮询后刷新阶段状态并保留当前选中阶段', () => {
  const { context } = makePreviewContext();
  assert.equal(typeof context.refreshRemoteQueuePreviewRc, 'function', '应提供他端预览刷新函数');
  context.remoteQueueClients.push({
    id: 'c2', label: 'Chrome·xy12',
    runs: [{
      id: 'r2', pipelineName: 'P1', stages: [{ id: 's1', name: '构建' }, { id: 's2', name: '部署' }],
      nodes: { s1: { status: 'success', progress: 100, dur: 2 }, s2: { status: 'running', progress: 80, dur: 8 } },
    }], queue: [],
  });
  const previous = { remotePreview: true, remoteClientId: 'c2', remoteItemId: 'r2', remoteKind: 'running', selId: 's2' };

  const refreshed = context.refreshRemoteQueuePreviewRc(previous);
  assert.equal(refreshed.selId, 's2');
  assert.equal(refreshed.nodes.s2.progress, 80);
  assert.equal(context.refreshRemoteQueuePreviewRc({ ...previous, remoteItemId: 'gone' }), null);
});

test('refreshRemoteQueuePreviewRc：他端排队项启动后按来源队列 id 跟随到运行快照', () => {
  const { context } = makePreviewContext();
  context.remoteQueueClients.push({
    id: 'c2', label: 'Chrome·xy12', queue: [],
    runs: [{
      id: 'r-new', originQueueId: 'q-old', pipelineName: 'P1',
      stages: [{ id: 's1', name: '构建' }, { id: 's2', name: '部署' }],
      nodes: { s1: { status: 'success', progress: 100 }, s2: { status: 'running', progress: 35 } },
    }],
  });
  const previous = {
    remotePreview: true, remoteClientId: 'c2', remoteItemId: 'q-old', remoteKind: 'queued', selId: 's2',
  };

  const refreshed = context.refreshRemoteQueuePreviewRc(previous);
  assert.equal(refreshed.remoteKind, 'running');
  assert.equal(refreshed.remoteItemId, 'r-new');
  assert.equal(refreshed.selId, 's2');
  assert.equal(refreshed.nodes.s2.progress, 35);
});

test('remoteRunsOf：新版 runs 为空时仍兼容旧版 running 单条快照', () => {
  const { context } = makePreviewContext();
  const legacy = { id: 'legacy-run' };
  assert.deepEqual(Array.from(context.remoteRunsOf({ runs: [], running: legacy })), [legacy]);
});

test('pullRemoteQueue：每次轮询把服务端权威队列与旧浏览器在场快照一起展示', async () => {
  let previews = 0, renders = 0;
  const server = { id: 'server', label: '服务端', schemaVersion: 3, runs: [{ id: 'r-server' }], queue: [{ id: 'q-server' }] };
  const context = {
    QCLIENT_ID: 'self', remoteQueueClients: [],
    fetch: async () => ({ ok: true, json: async () => ({ server, clients: [{ id: 'self' }, { id: 'legacy-other' }] }) }),
    applyRemoteQueuePreviewRefresh: () => { previews += 1; },
    renderQueue: () => { renders += 1; },
  };
  vm.createContext(context);
  vm.runInContext(extract('async function pullRemoteQueue', "$('queueRefresh')"), context);
  await context.pullRemoteQueue();
  assert.deepEqual(Array.from(context.remoteQueueClients, client => client.id), ['server', 'legacy-other']);
  assert.equal(previews, 1);
  assert.equal(renders, 1);
});

test('cancelServerRun：任一浏览器都可取消服务端排队或运行中的任务并立即刷新', async () => {
  const requests = [];
  let pulls = 0;
  const context = {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, state: 'running' }) };
    },
    pullRemoteQueue: async () => { pulls += 1; },
    alert: () => {},
  };
  vm.createContext(context);
  vm.runInContext(extract('async function cancelServerRun', 'async function pullRemoteQueue'), context);

  const result = await context.cancelServerRun('manual-1');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, state: 'running' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/worktable/pipeline/queue');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), { action: 'cancel', runId: 'manual-1' });
  assert.equal(pulls, 1);
});

test('页面离场不再清除服务端队列或释放服务端持有的节点租约', () => {
  const listeners = {};
  const beacons = [];
  const context = {
    window: { addEventListener: (type, listener) => { listeners[type] = listener; } },
    navigator: { sendBeacon: (...args) => { beacons.push(args); return true; } },
    $: () => ({ addEventListener() {}, disabled: false }),
    Blob, QCLIENT_ID: 'self', activeRuns: [{ leaseId: 'server-owned' }],
  };
  vm.createContext(context);
  vm.runInContext(extract("$('queueRefresh').addEventListener", '/* ---------- 运行定时'), context);
  if (listeners.pagehide) listeners.pagehide();
  assert.deepEqual(beacons, [], '浏览器离场不得改变服务端任务生命周期');
});

test('runPreviewReadOnly：本页排队预览和他端预览都禁止编辑或重试', () => {
  const start = source.indexOf('function runPreviewReadOnly');
  const end = source.indexOf('\n}', start) + 3;
  assert.ok(start >= 0 && end > start, '缺少运行预览只读判定');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.runPreviewReadOnly({ queuedPreview: true }), true);
  assert.equal(context.runPreviewReadOnly({ remotePreview: true }), true);
  assert.equal(context.runPreviewReadOnly({}), false);
  assert.equal(context.runPreviewReadOnly(null), false);
});

test('detailLogLinesFor：他端预览明确提示不传日志，本页详情仍使用真实日志构建器', () => {
  const start = source.indexOf('function detailLogLinesFor');
  const end = source.indexOf('\n}', start) + 3;
  assert.ok(start >= 0 && end > start, '缺少详情日志来源判定');
  const calls = [];
  const context = { DETAIL_LOG_LIMIT: { maxLines: 1 }, buildLog: (...args) => { calls.push(args); return ['本页日志']; } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const stage = { id: 's1', name: '构建' };
  const node = { status: 'running' };
  assert.deepEqual(Array.from(context.detailLogLinesFor(stage, { remotePreview: true }, node)), [
    '其他浏览器仅同步阶段状态、进度和耗时；运行日志、脚本参数和凭据不会跨浏览器传输。',
  ]);
  assert.deepEqual(Array.from(context.detailLogLinesFor(stage, { remotePreview: true, remoteClientId: 'server' }, node)), [
    '服务端队列仅同步阶段状态、进度和耗时；运行日志、脚本参数和凭据不会下发到浏览器。',
  ]);
  assert.deepEqual(Array.from(context.detailLogLinesFor(stage, {}, node)), ['本页日志']);
  assert.equal(calls.length, 1);
});

test('detailContextRows：他端详情把未同步的镜像和 Commit 明确标为未同步', () => {
  const context = { REGISTRY: 'registry.example.com', curPipeline: () => ({ name: '当前流水线' }) };
  vm.createContext(context);
  vm.runInContext(extract('function detailContextRows', 'function renderDetail'), context);
  const rows = Array.from(context.detailContextRows(
    { name: '构建' }, '进行中',
    { remotePreview: true, pipelineName: '远端流水线', branch: 'dev', strategy: '', by: 'alice', env: '10.0.0.1', image: '', tag: '—', commit: '—' },
  ), row => Array.from(row));
  assert.deepEqual(rows.find(row => row[0] === '镜像'), ['镜像', '未同步']);
  assert.deepEqual(rows.find(row => row[0] === 'Commit'), ['Commit', '未同步']);
  assert.equal(JSON.stringify(rows).includes('registry.example.com'), false);
});

/* ---------- 跨浏览器上报快照（只包含安全的阶段状态字段） ---------- */
function loadPresenceSnapshotContext() {
  const start = source.indexOf('function queueStagePresence');
  const end = source.indexOf('function publishQueue', start);
  assert.ok(start >= 0 && end > start, '缺少运行队列安全快照函数');
  const context = {
    expandRunStages: (stages, presets) => stages.concat((presets || []).map(key => ({ id: '__' + key, name: key, preset: true, pkey: key }))),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test('runningPresenceEntry：上报阶段状态但不携带日志、变量或脚本参数', () => {
  const context = loadPresenceSnapshotContext();
  const snap = context.runningPresenceEntry({
    id: 'r1', originQueueId: 'q1', pipelineId: 'p1', pipelineName: '发布', by: 'alice', env: '10.0.0.1', repoName: 'app', branch: 'dev', strategy: 'rolling', source: 'manual', startTs: 100,
    stages: [{ id: 's1', name: '构建', kind: 'shell', script: { values: { TOKEN: 'secret' } }, _out: { stdout: 'secret log' }, parallel: true, sub: ['a'] }],
    nodes: { s1: { status: 'running', progress: 35, dur: 4, varsIn: { TOKEN: 'secret' }, varsOut: { RESULT: 'secret' }, sub: { a: 'success' } } },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(snap)), {
    id: 'r1', originQueueId: 'q1', pipelineId: 'p1', pipelineName: '发布', by: 'alice', env: '10.0.0.1', repoName: 'app', branch: 'dev', strategy: 'rolling', source: 'manual', startedAt: 100,
    stages: [{ id: 's1', name: '构建', parallel: true, sub: ['a'] }],
    nodes: { s1: { status: 'running', progress: 35, dur: 4, sub: { a: 'success' } } },
  });
});

test('queuedPresenceEntry：排队快照展开预设阶段并全部标为未开始', () => {
  const context = loadPresenceSnapshotContext();
  const snap = context.queuedPresenceEntry({
    id: 'q1', pipelineId: 'p1', pipelineName: '发布', queuedAt: 200,
    stages: [{ id: 's1', name: '构建', script: { values: { TOKEN: 'secret' } } }], presets: ['check'],
  });

  assert.deepEqual(snap.stages.map(stage => stage.id), ['s1', '__check']);
  assert.equal(snap.nodes.s1.status, 'idle');
  assert.equal(snap.nodes.__check.status, 'idle');
  assert.equal(JSON.stringify(snap).includes('secret'), false);
});

test('publishQueue：上报声明可点击阶段快照协议版本', () => {
  const publishSource = extract('function publishQueue', '/* renderQueue 渲染很频繁');
  assert.match(publishSource, /schemaVersion\s*:\s*2/);
});

test('publishQueue：节点租约申请期间继续把待启动项作为可查看的排队快照上报', () => {
  const calls = [];
  const context = {
    activeRuns: [], queue: [],
    pendingLeaseStarts: [{ queueItem: { id: 'q-pending', queuedAt: 1, stages: [{ id: 's1', name: '构建' }], presets: [] } }],
    expandRunStages: stages => stages,
    _qPubSig: '', _qPubAt: 0, _qPubWarned: false,
    QCLIENT_ID: 'c1', browserTag: () => 'Chrome·c1',
    fetch: (url, options) => { calls.push({ url, options }); return Promise.resolve({}); },
    console,
  };
  vm.createContext(context);
  vm.runInContext(extract('function localQueueItems', 'function queuePreviewRc'), context);
  vm.runInContext(extract('function queueStagePresence', '/* renderQueue 渲染很频繁'), context);
  context.publishQueue(true);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.queue.length, 1);
  assert.equal(body.queue[0].id, 'q-pending');
  assert.equal(body.queue[0].stages[0].id, 's1');
});

/* ---------- 队列区渲染（renderQueue：排队项可点击 + 预览自愈） ---------- */
function makeQueueContext() {
  const list = new FakeNode('div');
  const els = { queueList: list, queueCount: new FakeNode('span'), queueStatus: new FakeNode('span'), stopBtn: new FakeNode('button') };
  const calls = { cancel: [], abort: [], cancelServer: [], focusRun: [], focusQueueItem: [], focusRemoteQueueItem: [], publish: 0, drain: 0, syncView: 0, overall: [], archiveTip: 0, resetNodes: 0 };
  const context = {
    document: { createElement: tag => new FakeNode(tag) },
    $: id => els[id] || new FakeNode('div'),
    queue: [], pendingLeaseStarts: [], activeRuns: [], viewRc: null, running: false, remoteQueueClients: [],
    queueReasonOpen: new Set(), MAX_ACTIVE_RUNS: 4,
    esc: String, sourceLabel: s => (s === 'manual' ? '手动' : s), fmtRelative: () => '刚刚',
    runInfoLine: () => '<div class="dshell-muted">info</div>',
    drainQueue: () => { calls.drain++; },
    cancelQueue: id => calls.cancel.push(id),
    abortRun: rc => calls.abort.push(rc),
    cancelServerRun: id => calls.cancelServer.push(id),
    canControlRun: () => true,   // 非 admin 控制权守卫：默认放行，使既有「按钮存在」断言成立；专门用例在下文覆盖
    focusRun: rc => calls.focusRun.push(rc),
    focusQueueItem: id => calls.focusQueueItem.push(id),
    focusRemoteQueueItem: (clientId, itemId, kind) => calls.focusRemoteQueueItem.push({ clientId, itemId, kind }),
    scheduleQueuePublish: () => { calls.publish++; },
    syncViewRun: () => { calls.syncView++; },
    applyRunOverall: rc => calls.overall.push(rc),
    refreshArchiveTip: () => { calls.archiveTip++; },
    resetNodes: () => { calls.resetNodes++; },
    console,
  };
  vm.createContext(context);
  vm.runInContext(extract('function localQueueItems', 'function queuePreviewRc'), context);
  vm.runInContext(extract('function remoteQueueDetailAvailable', 'function remoteQueuePreviewRc'), context);
  vm.runInContext(extract('function remoteQueueViewAttrs', 'function renderQueue(){'), context);
  vm.runInContext(extract('function renderQueue(){', '/* ---------- 运行引擎'), context);
  return { context, list, els, calls };
}

test('renderQueue：排队项标题可点击（data-qview）触发详情预览，取消按钮不受影响', () => {
  const { context, list, calls } = makeQueueContext();
  context.queue.push({ id: 'q1', by: 'alice', pipelineName: 'CI 构建', source: 'manual', queuedAt: 1 });
  context.renderQueue();
  const html = list.children[0].innerHTML;
  assert.match(html, /data-qview="q1"/);
  assert.match(html, /cursor:pointer/);
  assert.match(html, /点击查看该排队流水线的详情/);
  assert.doesNotMatch(html, /（查看中）/);
  const qview = list.querySelectorAll('[data-qview]');
  assert.equal(qview.length, 1);
  qview[0].handlers.click();
  assert.deepEqual(calls.focusQueueItem, ['q1']);
  const qcancel = list.querySelectorAll('[data-qcancel]');
  assert.equal(qcancel.length, 1);
  qcancel[0].handlers.click();
  assert.deepEqual(calls.cancel, ['q1']);
});

test('renderQueue：预览中的排队项带「查看中」标记；在跑运行保持 data-qfocus 聚焦与中止', () => {
  const { context, list, calls } = makeQueueContext();
  const rc = { id: 'r1', by: 'bob', pipelineName: '部署', source: 'manual' };
  context.activeRuns.push(rc);
  context.running = true;
  context.queue.push({ id: 'q1', by: 'alice', pipelineName: 'CI 构建', source: 'manual', queuedAt: 1 });
  context.viewRc = { id: 'q1', queuedPreview: true, over: true };
  context.renderQueue();
  assert.match(list.children[0].innerHTML, /（查看中）/);
  assert.match(list.children[1].innerHTML, /data-qfocus="r1"/);
  assert.match(list.children[1].innerHTML, /运行中/);
  list.querySelectorAll('[data-qfocus]')[0].handlers.click();
  assert.deepEqual(calls.focusRun, [rc]);
  list.querySelectorAll('[data-qabort]')[0].handlers.click();
  assert.deepEqual(calls.abort, [rc]);
});

test('renderQueue：非 admin 仅对自己的条目显示中止/取消按钮（他人条目按控制权隐藏）', () => {
  const { context, list } = makeQueueContext();
  context.canControlRun = by => by === 'tester';   // 非 admin：仅自己署名的条目可控
  context.activeRuns.push({ id: 'r-mine', by: 'tester', pipelineName: '我的', source: 'manual' });
  context.activeRuns.push({ id: 'r-other', by: 'bob', pipelineName: '他人', source: 'manual' });
  context.running = true;
  context.queue.push({ id: 'q-mine', by: 'tester', pipelineName: '排队-我的', source: 'manual', queuedAt: 1 });
  context.queue.push({ id: 'q-other', by: 'alice', pipelineName: '排队-他人', source: 'manual', queuedAt: 2 });
  context.renderQueue();
  // 整体按编号倒序：排队项在运行项上方，各自内部仍是后加入在上
  const qOther = list.children[0].innerHTML;
  const qMine = list.children[1].innerHTML;
  const runOther = list.children[2].innerHTML;
  const runMine = list.children[3].innerHTML;
  assert.doesNotMatch(runOther, /data-qabort/);   // 他人运行：无中止按钮
  assert.match(runMine, /data-qabort="r-mine"/);  // 自己运行：有中止按钮
  assert.doesNotMatch(qOther, /data-qcancel/);    // 他人排队：无取消按钮
  assert.match(qMine, /data-qcancel="q-mine"/);  // 自己排队：有取消按钮
});

test('renderQueue：预览的排队项已出队时自愈清回空闲编排', () => {
  const { context, els, calls } = makeQueueContext();
  context.viewRc = { id: 'qGone', queuedPreview: true, over: true };   // 已不在 queue（被取消/启动失败）
  context.renderQueue();
  assert.equal(context.viewRc, null);
  assert.equal(calls.syncView, 1);
  assert.deepEqual(calls.overall, [null]);
  assert.equal(els.stopBtn.disabled, true);
  assert.equal(calls.archiveTip, 1);
  assert.equal(calls.resetNodes, 1);
});

test('renderQueue：节点租约申请中的条目继续显示、可点击且不会误触发预览自愈', () => {
  const { context, list, els, calls } = makeQueueContext();
  const pending = { ...queueItem, id: 'q-pending', nodeWait: { until: 1, conflicts: [{ ip: '10.0.0.9', by: 'bob' }] } };
  context.pendingLeaseStarts.push({ queueItem: pending });
  context.viewRc = { id: 'q-pending', queuedPreview: true, over: true };
  context.renderQueue();
  assert.equal(els.queueCount.textContent, '(1 项)');
  assert.match(list.children[0].innerHTML, /data-qview="q-pending"/);
  assert.match(list.children[0].innerHTML, /申请节点中/);
  assert.doesNotMatch(list.children[0].innerHTML, /等待节点/, '重新申请期间不应同时展示上一次租约冲突');
  assert.match(list.children[0].innerHTML, /（查看中）/);
  assert.equal(list.querySelectorAll('[data-qcancel]').length, 0, '异步申请中的条目没有安全取消协议，不显示无效取消按钮');
  list.querySelectorAll('[data-qview]')[0].handlers.click();
  assert.deepEqual(calls.focusQueueItem, ['q-pending']);
  assert.equal(calls.resetNodes, 0, 'pending 仍属本地队列生命周期，不应把预览清回空闲编排');
});

test('renderQueue：其他浏览器同样让后入队条目显示在较早运行条目上方', () => {
  const { context, list, calls } = makeQueueContext();
  context.remoteQueueClients.push({
    id: 'c2', label: 'Chrome·xy12',
    runs: [{ id: 'r2', by: 'eve', pipelineName: 'P1', source: 'manual', startedAt: 1, stages: [{ id: 's1', name: '构建' }], nodes: { s1: { status: 'running' } } }],
    queue: [{ id: 'q2', by: 'frank', pipelineName: 'P2', source: 'manual', queuedAt: 2, stages: [{ id: 's2', name: '部署' }], nodes: { s2: { status: 'idle' } } }],
  });
  context.renderQueue();
  assert.equal(list.children.length, 3);   // 分隔行 + 他端排队 + 他端运行
  assert.match(list.children[0].innerHTML, /其他浏览器/);
  assert.match(list.children[1].innerHTML, /data-qremote-id="q2"/);
  assert.match(list.children[1].innerHTML, /点击查看该排队流水线的阶段详情/);
  assert.match(list.children[2].innerHTML, /data-qremote-id="r2"/);
  assert.match(list.children[2].innerHTML, /点击查看该运行的阶段详情/);
  const remote = list.querySelectorAll('[data-qremote-id]');
  assert.equal(remote.length, 2);
  remote.forEach(element => element.handlers.click());
  assert.deepEqual(calls.focusRemoteQueueItem, [
    { clientId: 'c2', itemId: 'q2', kind: 'queued' },
    { clientId: 'c2', itemId: 'r2', kind: 'running' },
  ]);
});

test('renderQueue：服务端运行与排队任务在任一浏览器显示中止/取消按钮', () => {
  const { context, list, calls } = makeQueueContext();
  context.remoteQueueClients.push({
    id: 'server', label: '服务端',
    runs: [{ id: 'r-server', by: 'eve', pipelineName: 'P1', source: 'manual', startedAt: 1, stages: [{ id: 's1', name: '构建' }], nodes: { s1: { status: 'running' } } }],
    queue: [{ id: 'q-server', by: 'frank', pipelineName: 'P2', source: 'manual', queuedAt: 2, stages: [{ id: 's2', name: '部署' }], nodes: { s2: { status: 'idle' } } }],
  });
  context.remoteQueueClients.push({
    id: 'legacy', label: '旧浏览器',
    runs: [{ id: 'r-legacy', by: 'old', pipelineName: '旧任务', stages: [{ id: 's3', name: '构建' }] }],
    queue: [],
  });
  context.renderQueue();

  const buttons = list.querySelectorAll('[data-qserver-cancel]');
  assert.equal(buttons.length, 2, '只给服务端权威任务提供跨浏览器取消入口');
  assert.match(list.children[1].innerHTML, />取消<\/button>/);
  assert.match(list.children[2].innerHTML, />中止<\/button>/);
  buttons.forEach(button => button.handlers.click());
  assert.deepEqual(calls.cancelServer, ['q-server', 'r-server']);
  assert.doesNotMatch(list.children[3].innerHTML, /data-qserver-cancel/);
});

test('renderQueue：非 admin 只能中止或取消自己署名的服务端任务', () => {
  const { context, list, calls } = makeQueueContext();
  context.canControlRun = by => by === 'tester';
  context.remoteQueueClients.push({
    id: 'server', label: '服务端',
    runs: [
      { id: 'r-mine', by: 'tester', pipelineName: '我的运行', stages: [{ id: 's1', name: '构建' }] },
      { id: 'r-other', by: 'bob', pipelineName: '他人运行', stages: [{ id: 's2', name: '部署' }] },
    ],
    queue: [
      { id: 'q-mine', by: 'tester', pipelineName: '我的排队', stages: [{ id: 's3', name: '测试' }] },
      { id: 'q-other', by: 'alice', pipelineName: '他人排队', stages: [{ id: 's4', name: '发布' }] },
    ],
  });
  context.renderQueue();

  const buttons = list.querySelectorAll('[data-qserver-cancel]');
  assert.deepEqual(buttons.map(button => button.getAttribute('data-qserver-cancel')), ['q-mine', 'r-mine']);
  buttons.forEach(button => button.handlers.click());
  assert.deepEqual(calls.cancelServer, ['q-mine', 'r-mine']);
});

test('renderQueue：旧浏览器快照缺少阶段数据时不可点击并提示刷新来源页面', () => {
  const { context, list, calls } = makeQueueContext();
  context.remoteQueueClients.push({
    id: 'legacy', label: '旧版浏览器',
    runs: [], running: { id: '', by: 'eve', pipelineName: '旧运行', stages: [] },
    queue: [{ id: '', by: 'frank', pipelineName: '旧排队', stages: [] }],
  });
  context.renderQueue();
  assert.equal(list.querySelectorAll('[data-qremote-id]').length, 0);
  assert.equal(calls.focusRemoteQueueItem.length, 0);
  assert.equal(list.children.filter(row => /来源页面需刷新，暂无阶段快照/.test(row.innerHTML)).length, 2);
});

test('renderQueue：排队项显示「排队中」徽标，运行项显示「运行中」徽标', () => {
  const { context, list } = makeQueueContext();
  context.activeRuns.push({ id: 'r1', by: 'bob', pipelineName: '部署', source: 'manual' });
  context.running = true;
  context.queue.push({ id: 'q1', by: 'alice', pipelineName: 'CI 构建', source: 'manual', queuedAt: 1 });
  context.renderQueue();
  assert.match(list.children[0].innerHTML, /<span class="dshell-badge dshell-badgeWait"[^>]*>排队中<\/span>/);
  assert.match(list.children[1].innerHTML, /<span class="dshell-badge dshell-badgeWait">运行中<\/span>/);
});

test('renderQueue：整个队列按编号倒序展示，最早的 #1 位于底部', () => {
  const { context, list } = makeQueueContext();
  context.activeRuns.push(
    { id: 'r1', by: 'bob', pipelineName: 'P1', source: 'manual' },
    { id: 'r2', by: 'cat', pipelineName: 'P2', source: 'manual' },
  );
  context.running = true;
  context.queue.push(
    { id: 'q1', by: 'alice', pipelineName: 'P3', source: 'manual', queuedAt: 1 },
    { id: 'q2', by: 'dave', pipelineName: 'P4', source: 'manual', queuedAt: 2 },
  );
  context.renderQueue();
  const order = list.children.map(row => {
    const m = row.innerHTML.match(/data-qfocus="([^"]+)"/) || row.innerHTML.match(/data-qview="([^"]+)"/);
    return m ? m[1] : '';
  });
  const numbers = list.children.map(row => Number((row.innerHTML.match(/#(\d+)</) || [])[1]));
  assert.deepEqual(order, ['q2', 'q1', 'r2', 'r1'], '整个队列从最新到最早展示，不按运行/排队状态分段打乱编号');
  assert.deepEqual(numbers, [4, 3, 2, 1], '编号应从顶部到底部严格递减');
  assert.match(list.children[0].innerHTML, /#4</, '最后入队的 #4 显示在顶部');
  assert.match(list.children[3].innerHTML, /#1</, '最早开始的 #1 显示在底部');
});

test('renderQueue：正在查看的条目整框高亮，未查看的保持默认背景', () => {
  const { context, list } = makeQueueContext();
  context.queue.push(
    { id: 'q1', by: 'alice', pipelineName: 'P1', source: 'manual', queuedAt: 1 },
    { id: 'q2', by: 'bob', pipelineName: 'P2', source: 'manual', queuedAt: 2 },
  );
  context.viewRc = { id: 'q1', queuedPreview: true, over: true };
  context.renderQueue();
  const viewingRow = list.children.find(row => /data-qview="q1"/.test(row.innerHTML));
  const otherRow = list.children.find(row => /data-qview="q2"/.test(row.innerHTML));
  assert.equal(viewingRow.style.background, 'rgba(79,142,247,.12)', '查看中的排队条目背景与运行历史选中行一致');
  assert.equal(viewingRow.style.borderColor || '', '', '与运行历史选中行一致：不额外改边框');
  assert.match(viewingRow.innerHTML, /（查看中）/);
  assert.equal(otherRow.style.background || '', '', '未查看的条目保持默认背景');
});

test('renderQueue：正在查看的运行条目同样整框高亮', () => {
  const { context, list } = makeQueueContext();
  const rc = { id: 'r1', by: 'bob', pipelineName: '部署', source: 'manual' };
  context.activeRuns.push(rc);
  context.running = true;
  context.viewRc = rc;
  context.renderQueue();
  assert.equal(list.children[0].style.background, 'rgba(79,142,247,.12)', '查看中的运行条目背景与运行历史选中行一致');
  assert.equal(list.children[0].style.borderColor || '', '');
});

test('renderQueue：他端排队条目显示「排队中」，查看中的他端条目整框高亮', () => {
  const { context, list } = makeQueueContext();
  context.remoteQueueClients.push({
    id: 'c2', label: 'Chrome·xy12', runs: [],
    queue: [
      { id: 'q2', by: 'frank', pipelineName: 'P2', source: 'manual', queuedAt: 1, stages: [{ id: 's2', name: '部署' }], nodes: {} },
      { id: 'q3', by: 'grace', pipelineName: 'P3', source: 'manual', queuedAt: 2, stages: [{ id: 's3', name: '测试' }], nodes: {} },
    ],
  });
  context.viewRc = { remotePreview: true, remoteClientId: 'c2', remoteItemId: 'q2', remoteKind: 'queued', over: true };
  context.renderQueue();
  const rows = list.children.slice(1);   // 跳过分隔行
  assert.equal(rows.length, 2);
  assert.match(rows[0].innerHTML, /data-qremote-id="q3"/, '他端后加入的排队条目显示在上面');
  assert.match(rows[1].innerHTML, /data-qremote-id="q2"/);
  rows.forEach(row => assert.match(row.innerHTML, /<span class="dshell-badge dshell-badgeWait">排队中<\/span>/));
  assert.equal(rows[1].style.background, 'rgba(79,142,247,.12)', '查看中的他端条目背景与运行历史选中行一致');
  assert.equal(rows[0].style.background || '', '');
});

test('renderQueue：点击「排队中」徽标展开/收起排队原因（他端租约占用）', () => {
  const { context, list } = makeQueueContext();
  context.queue.push({ id: 'q1', by: 'alice', pipelineName: 'CI 构建', source: 'manual', queuedAt: 1,
    envs: [{ ip: '10.0.0.1' }],
    nodeWait: { until: Date.now() + 60000, conflicts: [{ ip: '10.0.0.1', by: 'bob', label: '部署' }] } });
  context.renderQueue();
  assert.doesNotMatch(list.children[0].innerHTML, /排队原因：/, '默认收起排队原因');
  const reasonBtn = list.querySelectorAll('[data-qreason]')[0];
  assert.equal(reasonBtn.getAttribute('data-qreason'), 'q1');
  reasonBtn.handlers.click();
  assert.ok(context.queueReasonOpen.has('q1'));
  const html = list.children[0].innerHTML;   // 点击后已重绘
  assert.match(html, /排队原因：/);
  assert.match(html, /10\.0\.0\.1（bob · 部署）/);
  assert.match(html, /被他端运行占用/);
  list.querySelectorAll('[data-qreason]')[0].handlers.click();
  assert.equal(context.queueReasonOpen.has('q1'), false, '再次点击收起');
  assert.doesNotMatch(list.children[0].innerHTML, /排队原因：/);
});

test('renderQueue：排队原因——同机有本页运行在跑', () => {
  const { context, list } = makeQueueContext();
  context.activeRuns.push({ id: 'r1', by: 'bob', pipelineName: '部署', source: 'manual', envs: [{ ip: 'X' }] });
  context.running = true;
  context.queue.push({ id: 'q1', by: 'alice', pipelineName: 'CI', source: 'manual', queuedAt: 1, envs: [{ ip: 'X' }] });
  context.renderQueue();
  list.querySelectorAll('[data-qreason]')[0].handlers.click();
  assert.match(list.children[0].innerHTML, /节点 X 上正在运行「部署」（bob）/);
  assert.match(list.children[0].innerHTML, /同一节点同一时间只跑一条流水线/);
});

test('renderQueue：排队原因——同机排队任务排在前面（FIFO）', () => {
  const { context, list } = makeQueueContext();
  context.queue.push(
    { id: 'q1', by: 'alice', pipelineName: 'CI', source: 'manual', queuedAt: 1, envs: [{ ip: 'X' }] },
    { id: 'q2', by: 'bob', pipelineName: 'CD', source: 'manual', queuedAt: 2, envs: [{ ip: 'X' }] },
  );
  context.renderQueue();
  const btns = list.querySelectorAll('[data-qreason]');
  assert.equal(btns[0].getAttribute('data-qreason'), 'q2', '展示倒序：后加入的 q2 在第一行');
  assert.equal(btns[1].getAttribute('data-qreason'), 'q1');
  btns[0].handlers.click();
  assert.match(list.children[0].innerHTML, /同机任务「CI」（#1 · alice）排在前面/);
  assert.match(list.children[0].innerHTML, /先入先出/);
});

test('renderQueue：排队原因——并发槽位已满', () => {
  const { context, list } = makeQueueContext();
  ['A', 'B', 'C', 'D'].forEach((ip, i) => context.activeRuns.push({ id: 'r' + i, by: 'u' + i, pipelineName: 'P' + i, source: 'manual', envs: [{ ip }] }));
  context.running = true;
  context.queue.push({ id: 'q1', by: 'alice', pipelineName: 'CI', source: 'manual', queuedAt: 1, envs: [{ ip: 'Z' }] });
  context.renderQueue();
  list.querySelectorAll('[data-qreason]')[0].handlers.click();
  assert.match(list.children[0].innerHTML, /并发槽位已满（4\/4）/);
});

test('renderQueue：排队原因——未选择目标节点按串行处理', () => {
  const { context, list } = makeQueueContext();
  context.activeRuns.push({ id: 'r1', by: 'bob', pipelineName: '部署', source: 'manual' });
  context.running = true;
  context.queue.push({ id: 'q1', by: 'alice', pipelineName: 'CI', source: 'manual', queuedAt: 1 });
  context.renderQueue();
  list.querySelectorAll('[data-qreason]')[0].handlers.click();
  assert.match(list.children[0].innerHTML, /未选择目标节点的运行按串行处理/);
});

test('renderQueue：「申请节点中」徽标同样可点击查看原因', () => {
  const { context, list } = makeQueueContext();
  const pending = { id: 'qP', by: 'alice', pipelineName: 'CI', source: 'manual', queuedAt: 1, envs: [{ ip: 'X' }] };
  context.pendingLeaseStarts.push({ queueItem: pending });
  context.renderQueue();
  assert.match(list.children[0].innerHTML, /data-qreason="qP"[^>]*>申请节点中/);
  list.querySelectorAll('[data-qreason]')[0].handlers.click();
  assert.match(list.children[0].innerHTML, /正在向服务端申请节点租约/);
});

test('renderQueue：点击条目空白处等同点击标题选中流水线，交互区域不重复触发', () => {
  const { context, list, calls } = makeQueueContext();
  const rc = { id: 'r1', by: 'bob', pipelineName: '部署', source: 'manual' };
  context.activeRuns.push(rc);
  context.running = true;
  context.queue.push({ id: 'q1', by: 'alice', pipelineName: 'CI', source: 'manual', queuedAt: 1 });
  context.remoteQueueClients.push({ id: 'c2', label: 'Chrome·xy12', runs: [],
    queue: [{ id: 'q2', by: 'frank', pipelineName: 'P2', source: 'manual', queuedAt: 2, stages: [{ id: 's2', name: '部署' }], nodes: {} }] });
  context.renderQueue();
  const blank = () => ({ target: { closest: () => null } });
  const onTitle = { target: { closest: sel => (sel === '.dshell-listItemTitle' ? {} : null) } };
  const onReason = { target: { closest: sel => (sel === '[data-qreason]' ? {} : null) } };
  const onButton = { target: { closest: sel => (sel === 'button' ? {} : null) } };
  // 行序：[0]=排队 q1，[1]=运行 r1，[2]=分隔行，[3]=他端排队 q2
  list.children[1].handlers.click(blank());
  assert.deepEqual(calls.focusRun, [rc], '运行条目空白处点击选中该运行');
  list.children[1].handlers.click(onTitle);
  assert.equal(calls.focusRun.length, 1, '标题区域由标题自带点击处理，不重复触发');
  list.children[1].handlers.click(onButton);
  assert.equal(calls.focusRun.length, 1, '中止按钮区域不触发选中');
  list.children[0].handlers.click(blank());
  assert.deepEqual(calls.focusQueueItem, ['q1'], '排队条目空白处点击查看排队详情');
  list.children[0].handlers.click(onReason);
  assert.equal(calls.focusQueueItem.length, 1, '徽标区域只展开排队原因，不触发选中');
  assert.equal(typeof list.children[2].handlers.click, 'undefined', '分隔行不可点击');
  list.children[3].handlers.click(blank());
  assert.deepEqual(calls.focusRemoteQueueItem, [{ clientId: 'c2', itemId: 'q2', kind: 'queued' }], '他端条目空白处点击查看他端详情');
});

test('renderQueue：缺少阶段数据的旧他端条目空白处点击不触发查看', () => {
  const { context, list, calls } = makeQueueContext();
  context.remoteQueueClients.push({ id: 'legacy', label: '旧版浏览器', runs: [], running: null,
    queue: [{ id: '', by: 'frank', pipelineName: '旧排队', stages: [] }] });
  context.renderQueue();
  const row = list.children[1];
  if (row.handlers.click) row.handlers.click({ target: { closest: () => null } });
  assert.equal(calls.focusRemoteQueueItem.length, 0);
});

test('startRun：队列项启动时把原队列 id 传给运行上下文', () => {
  const calls = [];
  const context = {
    DEFAULT_IMAGE: 'myapp', GITURL: 'g', currentUsername: 'tester',
    findPipeline: id => ({ id, name: 'P1', stages: [] }), curPipeline: () => ({ id: 'p1', name: 'P1', stages: [] }),
    resolveEnv: ip => ({ ip }), curEnvs: () => [{ ip: 'A' }],
    resolveRepo: () => ({ id: 'repo1', name: 'repo1', url: '' }),
    $: () => ({ value: '' }), curStrategy: () => '', selectedPresetKeys: () => [],
    runIps: run => new Set((run.envs || []).map(env => env.ip).filter(Boolean)),
    startSimRun: (pl, runContext) => calls.push({ pl, runContext }),
  };
  vm.createContext(context);
  vm.runInContext(extract('function startRun(opts){', 'function startSimRun'), context);
  context.startRun({ id: 'q1', pipelineId: 'p1', envs: [{ ip: 'A' }], by: 'alice' });
  assert.equal(calls[0].runContext.originQueueId, 'q1');
});

/* ---------- 异机并行调度（runPipeline / machineConflict / drainQueue 真实实现） ---------- */
function makeScheduleContext() {
  const calls = { start: [], submit: [], alerts: [] };
  const context = {
    DEFAULT_IMAGE: 'myapp', GITURL: 'g', MAX_ACTIVE_RUNS: 4, QUEUE_CAP: 16,
    activeRuns: [], queue: [],
    findPipeline: id => ({ id, name: 'PL-' + id, stages: [{ id: 's1', name: '构建' }] }),
    curPipelineId: 'p1',
    curPipeline: () => ({ id: 'p1', name: 'PL-p1', stages: [{ id: 's1', name: '构建' }] }),
    resolvePipelineRunOptions: (pl, opts) => opts,
    pipelineDefaultRunIssue: () => null,
    $: id => ({ value: '' }),
    currentUsername: 'tester',   // 执行人只读、固定取登录用户后的唯一读取点
    curEnvs: () => [{ ip: '10.0.0.1' }],
    resolveEnv: ip => ({ ip }),
    resolveRepo: () => ({ id: 'repo1', name: 'repo1' }),
    curStrategy: () => '',
    selectedPresetKeys: () => [],
    startRun: item => { calls.start.push(item); context.activeRuns.push(item); return true; },
    submitServerRun: item => { calls.submit.push(item); },
    renderQueue() {},
    alert: msg => calls.alerts.push(msg),
    console,
  };
  vm.createContext(context);
  vm.runInContext(extract('function runPipeline(opts){', 'function cancelQueue'), context);
  return { context, calls };
}

const onIp = ip => ({ envs: [{ ip }] });

test('machineConflict：目标 IP 相交即冲突；任一方无目标 IP 按冲突（保持串行语义）', () => {
  const { context } = makeScheduleContext();
  assert.equal(context.machineConflict(onIp('A'), onIp('B')), false);
  assert.equal(context.machineConflict(onIp('A'), onIp('A')), true);
  assert.equal(context.machineConflict({ envs: [{ ip: 'A' }, { ip: 'B' }] }, onIp('B')), true);
  assert.equal(context.machineConflict({ envs: [] }, onIp('A')), true);
  assert.equal(context.machineConflict({}, {}), true);
});

test('runPipeline：浏览器不再本地调度，所有手动运行都提交服务端权威队列', () => {
  const { context, calls } = makeScheduleContext();
  assert.equal(context.runPipeline({ pipelineId: 'p1', envs: [{ ip: 'A' }], by: 'a' }), 'submitted');
  assert.equal(context.runPipeline({ pipelineId: 'p1', envs: [{ ip: 'B' }], by: 'b' }), 'submitted');
  assert.equal(context.runPipeline({ pipelineId: 'p1', envs: [{ ip: 'A' }], by: 'c' }), 'submitted');
  assert.equal(calls.submit.length, 3);
  assert.deepEqual(calls.submit.map(item => item.by), ['a', 'b', 'c']);
  assert.equal(calls.start.length, 0, '浏览器执行器不得启动');
  assert.equal(context.queue.length, 0);
});

test('drainQueue：不同机器的排队任务可越过同机等待者启动，同机保持先进先出', () => {
  const { context, calls } = makeScheduleContext();
  context.activeRuns.push({ id: 'rA', envs: [{ ip: 'A' }] });
  context.queue.push({ id: 'qA1', envs: [{ ip: 'A' }], stages: [] }, { id: 'qB1', envs: [{ ip: 'B' }], stages: [] });
  context.drainQueue();
  assert.deepEqual(calls.start.map(i => i.id), ['qB1'], 'B 机任务与在跑/前排排队均不冲突：立即并行启动');
  assert.deepEqual(context.queue.map(i => i.id), ['qA1'], 'A 机任务与在跑运行冲突：继续排队');
  context.activeRuns.length = 0;
  context.drainQueue();
  assert.deepEqual(calls.start.map(i => i.id), ['qB1', 'qA1'], '在跑清空后同机排队任务按序启动');
  assert.equal(context.queue.length, 0);
});

test('runPipeline：浏览器本地并发与队列容量不再拦截服务端提交', () => {
  const { context, calls } = makeScheduleContext();
  ['A', 'B', 'C', 'D'].forEach(ip => context.activeRuns.push({ envs: [{ ip }] }));   // 占满 4 个槽位
  for (let i = 0; i < 16; i++) context.queue.push({ id: 'q' + i, envs: [{ ip: 'X' + i }] });
  assert.equal(context.runPipeline({ pipelineId: 'p1', envs: [{ ip: 'Z' }], by: 'f' }), 'submitted');
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.start.length, 0);
  assert.equal(context.queue.length, 16);
});
