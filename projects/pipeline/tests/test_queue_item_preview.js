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
        el.attributes = Object.assign({}, el.attributes, { [attr]: valueMatch[1] });
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
    expandRunStages: (stages, presets) => { calls.expand.push({ stages, presets }); return stages.map(s => ({ ...s })); },
    focusRun: rc => { calls.focus.push(rc); context.viewRc = rc; },
  };
  vm.createContext(context);
  vm.runInContext(extract('function queuePreviewRc', '/* ---------- 运行队列跨浏览器可见'), context);
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

/* ---------- 队列区渲染（renderQueue：排队项可点击 + 预览自愈） ---------- */
function makeQueueContext() {
  const list = new FakeNode('div');
  const els = { queueList: list, queueCount: new FakeNode('span'), queueStatus: new FakeNode('span'), stopBtn: new FakeNode('button') };
  const calls = { cancel: [], abort: [], focusRun: [], focusQueueItem: [], renderPipelines: 0, publish: 0, drain: 0, syncView: 0, overall: [], archiveTip: 0, resetNodes: 0 };
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

test('renderQueue：其他浏览器的排队/在跑条目只读，不给点击查看', () => {
  const { context, list } = makeQueueContext();
  context.remoteQueueClients.push({
    id: 'c2', label: 'Chrome·xy12',
    runs: [{ by: 'eve', pipelineName: 'P1', source: 'manual', startedAt: 1 }],
    queue: [{ by: 'frank', pipelineName: 'P2', source: 'manual', queuedAt: 2 }],
  });
  context.renderQueue();
  assert.equal(list.children.length, 3);   // 分隔行 + 他端运行 + 他端排队
  assert.match(list.children[0].innerHTML, /其他浏览器/);
  assert.doesNotMatch(list.children[1].innerHTML, /data-qview|data-qfocus|data-qcancel|data-qabort/);
  assert.doesNotMatch(list.children[2].innerHTML, /data-qview|data-qfocus|data-qcancel|data-qabort/);
});

/* ---------- 异机并行调度（runPipeline / machineConflict / drainQueue 真实实现） ---------- */
function makeScheduleContext() {
  const calls = { start: [], alerts: [] };
  const context = {
    DEFAULT_IMAGE: 'myapp', GITURL: 'g', MAX_ACTIVE_RUNS: 4, QUEUE_CAP: 8,
    activeRuns: [], queue: [],
    findPipeline: id => ({ id, name: 'PL-' + id, stages: [{ id: 's1', name: '构建' }] }),
    curPipelineId: 'p1',
    curPipeline: () => ({ id: 'p1', name: 'PL-p1', stages: [{ id: 's1', name: '构建' }] }),
    resolvePipelineRunOptions: (pl, opts) => opts,
    pipelineDefaultRunIssue: () => null,
    $: id => ({ value: id === 'triggeredBy' ? 'tester' : '' }),
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
  for (let i = 0; i < 8; i++) context.queue.push({ id: 'q' + i, envs: [{ ip: 'X' + i }] });
  assert.equal(context.runPipeline({ pipelineId: 'p1', envs: [{ ip: 'Z' }], by: 'f' }), false, '队列达上限：拒绝入队');
  assert.equal(context.queue.length, 8);
});
