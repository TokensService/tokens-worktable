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
    remoteQueueClients: [],
    expandRunStages: (stages, presets) => { calls.expand.push({ stages, presets }); return stages.map(s => ({ ...s })); },
    focusRun: rc => { calls.focus.push(rc); context.viewRc = rc; },
  };
  vm.createContext(context);
  const presenceStart = source.indexOf('function queueStagePresence');
  const presenceEnd = source.indexOf('function publishQueue', presenceStart);
  assert.ok(presenceStart >= 0 && presenceEnd > presenceStart, '缺少运行队列安全快照函数');
  vm.runInContext(source.slice(presenceStart, presenceEnd), context);
  vm.runInContext(extract('function queuePreviewRc', '/* ---------- 运行队列跨浏览器可见'), context);
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

/* ---------- 队列区渲染（renderQueue：排队项可点击 + 预览自愈） ---------- */
function makeQueueContext() {
  const list = new FakeNode('div');
  const els = { queueList: list, queueCount: new FakeNode('span'), queueStatus: new FakeNode('span'), stopBtn: new FakeNode('button') };
  const calls = { cancel: [], abort: [], focusRun: [], focusQueueItem: [], focusRemoteQueueItem: [], renderPipelines: 0, publish: 0, drain: 0, syncView: 0, overall: [], archiveTip: 0, resetNodes: 0 };
  const context = {
    document: { createElement: tag => new FakeNode(tag) },
    $: id => els[id] || new FakeNode('div'),
    queue: [], activeRuns: [], viewRc: null, running: false, remoteQueueClients: [],
    esc: String, sourceLabel: s => (s === 'manual' ? '手动' : s), fmtRelative: () => '刚刚',
    runInfoLine: () => '<div class="dshell-muted">info</div>',
    drainQueue: () => { calls.drain++; },
    cancelQueue: id => calls.cancel.push(id),
    abortRun: rc => calls.abort.push(rc),
    focusRun: rc => calls.focusRun.push(rc),
    focusQueueItem: id => calls.focusQueueItem.push(id),
    focusRemoteQueueItem: (clientId, itemId, kind) => calls.focusRemoteQueueItem.push({ clientId, itemId, kind }),
    renderPipelines: () => { calls.renderPipelines++; },
    scheduleQueuePublish: () => { calls.publish++; },
    syncViewRun: () => { calls.syncView++; },
    applyRunOverall: rc => calls.overall.push(rc),
    refreshArchiveTip: () => { calls.archiveTip++; },
    resetNodes: () => { calls.resetNodes++; },
    _plRunSig: null,
    console,
  };
  vm.createContext(context);
  vm.runInContext(extract('function remoteQueueDetailAvailable', 'function remoteQueuePreviewRc'), context);
  vm.runInContext(extract('function remoteQueueViewAttrs', 'let _plRunSig'), context);
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
  assert.match(list.children[0].innerHTML, /data-qfocus="r1"/);
  assert.match(list.children[0].innerHTML, /运行中/);
  assert.match(list.children[1].innerHTML, /（查看中）/);
  list.querySelectorAll('[data-qfocus]')[0].handlers.click();
  assert.deepEqual(calls.focusRun, [rc]);
  list.querySelectorAll('[data-qabort]')[0].handlers.click();
  assert.deepEqual(calls.abort, [rc]);
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

test('renderQueue：其他浏览器的排队/在跑条目都可点击查看阶段详情', () => {
  const { context, list, calls } = makeQueueContext();
  context.remoteQueueClients.push({
    id: 'c2', label: 'Chrome·xy12',
    runs: [{ id: 'r2', by: 'eve', pipelineName: 'P1', source: 'manual', startedAt: 1, stages: [{ id: 's1', name: '构建' }], nodes: { s1: { status: 'running' } } }],
    queue: [{ id: 'q2', by: 'frank', pipelineName: 'P2', source: 'manual', queuedAt: 2, stages: [{ id: 's2', name: '部署' }], nodes: { s2: { status: 'idle' } } }],
  });
  context.renderQueue();
  assert.equal(list.children.length, 3);   // 分隔行 + 他端运行 + 他端排队
  assert.match(list.children[0].innerHTML, /其他浏览器/);
  assert.match(list.children[1].innerHTML, /data-qremote-id="r2"/);
  assert.match(list.children[1].innerHTML, /点击查看该运行的阶段详情/);
  assert.match(list.children[2].innerHTML, /data-qremote-id="q2"/);
  assert.match(list.children[2].innerHTML, /点击查看该排队流水线的阶段详情/);
  const remote = list.querySelectorAll('[data-qremote-id]');
  assert.equal(remote.length, 2);
  remote.forEach(element => element.handlers.click());
  assert.deepEqual(calls.focusRemoteQueueItem, [
    { clientId: 'c2', itemId: 'r2', kind: 'running' },
    { clientId: 'c2', itemId: 'q2', kind: 'queued' },
  ]);
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

test('startRun：队列项启动时把原队列 id 传给运行上下文', () => {
  const calls = [];
  const context = {
    DEFAULT_IMAGE: 'myapp', GITURL: 'g', currentUsername: 'tester',
    findPipeline: id => ({ id, name: 'P1', stages: [] }), curPipeline: () => ({ id: 'p1', name: 'P1', stages: [] }),
    resolveEnv: ip => ({ ip }), curEnvs: () => [{ ip: 'A' }],
    resolveRepo: () => ({ id: 'repo1', name: 'repo1', url: '' }),
    $: () => ({ value: '' }), curStrategy: () => '', selectedPresetKeys: () => [],
    startSimRun: (pl, runContext) => calls.push({ pl, runContext }),
  };
  vm.createContext(context);
  vm.runInContext(extract('function startRun(opts){', 'function startSimRun'), context);
  context.startRun({ id: 'q1', pipelineId: 'p1', envs: [{ ip: 'A' }], by: 'alice' });
  assert.equal(calls[0].runContext.originQueueId, 'q1');
});

/* ---------- 异机并行调度（runPipeline / machineConflict / drainQueue 真实实现） ---------- */
function makeScheduleContext() {
  const calls = { start: [], alerts: [] };
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

test('runPipeline：空闲立即运行；不同机器的运行并行启动，同一机器入队等待', () => {
  const { context, calls } = makeScheduleContext();
  assert.equal(context.runPipeline({ pipelineId: 'p1', envs: [{ ip: 'A' }], by: 'a' }), true);
  assert.equal(calls.start.length, 1);
  assert.equal(context.runPipeline({ pipelineId: 'p1', envs: [{ ip: 'B' }], by: 'b' }), true, '目标机器不相交：并行启动不入队');
  assert.equal(calls.start.length, 2);
  assert.equal(context.queue.length, 0);
  assert.equal(context.runPipeline({ pipelineId: 'p1', envs: [{ ip: 'A' }], by: 'c' }), 'queued', '与在跑运行同机：入队');
  assert.equal(context.queue.length, 1);
  assert.equal(calls.start.length, 2);
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

test('runPipeline：并发槽位占满仍可入队，队列满拒绝入队', () => {
  const { context, calls } = makeScheduleContext();
  ['A', 'B', 'C', 'D'].forEach(ip => context.activeRuns.push({ envs: [{ ip }] }));   // 占满 4 个槽位
  assert.equal(context.runPipeline({ pipelineId: 'p1', envs: [{ ip: 'E' }], by: 'e' }), 'queued', '槽位占满：即使机器不相交也入队');
  assert.equal(calls.start.length, 0);
  context.queue.length = 0;
  for (let i = 0; i < 16; i++) context.queue.push({ id: 'q' + i, envs: [{ ip: 'X' + i }] });
  assert.equal(context.runPipeline({ pipelineId: 'p1', envs: [{ ip: 'Z' }], by: 'f' }), false, '队列达上限（16）：拒绝入队');
  assert.equal(context.queue.length, 16);
});
