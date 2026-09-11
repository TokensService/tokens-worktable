const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function functionMatch(name) {
  return new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
}

function extractFunction(name) {
  const match = functionMatch(name);
  assert.ok(match, 'pipeline.html 缺少函数 ' + name);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error('未闭合的函数 ' + name);
}

function installFunctions(context, names) {
  const bodies = names.filter(functionMatch).map(extractFunction);
  if (bodies.length) vm.runInContext(bodies.join('\n'), context);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function parallelThenAfter(peer) {
  return [
    { id: 'a', name: 'A', parallel: true, script: { name: 'a.sh', path: '/a.sh' } },
    peer || { id: 'b', name: 'B', parallel: true, script: { name: 'b.sh', path: '/b.sh' } },
    { id: 'after', name: 'After', script: { name: 'after.sh', path: '/after.sh' } },
  ];
}

function parallelContext(stages, options) {
  options = options || {};
  const started = [];
  const finished = [];
  const archived = [];
  const clearedTimers = [];
  const pendingScripts = [];
  let timerSeq = 0;
  const stopButton = { disabled: false };
  const context = {
    console,
    Promise,
    Object,
    Array,
    JSON,
    URL,
    Date,
    Error,
    AbortController,
    MAX_ACTIVE_RUNS: 4,
    setImmediate,
    setTimeout,
    clearTimeout,
    setInterval() { return { id: ++timerSeq }; },
    clearInterval(timer) { clearedTimers.push(timer); },
    taskPromFinalize() {},
    conflictsActive() { return false; },
    flashRunTip() {},
    runPresetStep() { throw new Error('preset executor must not run'); },
    skipStage() { throw new Error('skip executor must not run'); },
    stageUrlOf(stage) { return stage && stage.url ? stage.url.url || '' : ''; },
    runUrlStep() { throw new Error('URL executor must not run'); },
    runEvaltokensStep() { throw new Error('EvalTokens executor must not run'); },
    runScriptStep(child, index) {
      const stage = child.stages[index];
      child.nodes[stage.id] = { status: 'running', progress: 12, dur: 0.2, sub: {}, varsIn: plain(child.vars), varsOut: {} };
      child.scriptAbort = new AbortController();
      child.timer = context.setInterval(() => {}, 300);
      started.push({ child, index, kind: 'script' });
    },
    runStage(child, index) {
      const stage = child.stages[index];
      child.nodes[stage.id] = { status: 'running', progress: 23, dur: 0.3, sub: {}, varsIn: plain(child.vars), varsOut: {} };
      child.timer = context.setInterval(() => {}, 120);
      started.push({ child, index, kind: 'simulate' });
    },
    runSetSel(child, id) { child.selId = id; },
    rcRender() {},
    archiveStageLog(stage, seq, child) { archived.push({ id: stage.id, seq, child }); },
    stageSeq(_stages, index) { return index + 1; },
    activeRuns: [],
    syncRunState() {},
    $() { return stopButton; },
    viewActive() { return false; },
    refreshArchiveTip() {},
    rcOverall() {},
    buildNo: 0,
    history: [],
    curPipeline() { return { name: 'parallel-test' }; },
    fmtDur(value) { return String(value); },
    nowHM() { return '12:00'; },
    promSnapshotForRun() { return null; },
    collectRunLogs() { return []; },
    histPage: 0,
    selHistoryIdx: 0,
    renderHistory() {},
    renderStats() {},
    persistState() {},
    archiveRun(_rc, result) { finished.push(result); },
    renderDetail() {},
    drainQueue() {},
    renderQueue() {},
    archiveFolderFor() { return ''; },
    taskLogFile(_run, seq, name) { return 'run-' + seq + '-' + name + '.log'; },
    createClientStageLogSink() { return null; },
    mergeStageVars() { return {}; },
    applyOutVars() {},
    parseStageJson() { return null; },
    viewRc: null,
    selectedId: null,
    jenkins: { url: 'http://jenkins.local', user: '', token: '', mode: options.jenkinsMode || 'local' },
    btoa(value) { return Buffer.from(value).toString('base64'); },
  };
  if (options.fetch) context.fetch = options.fetch;
  vm.createContext(context);
  installFunctions(context, [
    'pipelineStageGroups',
    'pipelineStageGroupAt',
    'rootRunContext',
    'createParallelStageContext',
    'cancelParallelStage',
    'cancelParallelGroup',
    'disposeRunForReset',
    'settleParallelStage',
    'runParallelStageGroup',
    'startStageAt',
    'advance',
    'finish',
    'abortRun',
    'retryFromStage',
  ]);
  const rc = {
    id: 'parent', stages, nodes: {}, selId: null, timer: null, scriptAbort: null,
    over: false, token: 'parent-token', vars: { UPSTREAM: 'snapshot' }, parallelGroup: null,
    startTs: Date.now(), pipelineName: 'parallel-test', env: 'test', commit: '1234567890',
    by: 'tester', pipelineId: 'pl-test', repoId: null, branch: 'main', strategy: '', tag: 'test', archive: '',
  };
  context.activeRuns = [rc];
  context.viewRc = rc;

  if (options.realScript) {
    context.execScript = (script, _timeout, _env, _run, _onStream, signal) => new Promise(resolve => {
      pendingScripts.push({ name: script.name, signal, resolve });
    });
    installFunctions(context, [
      'createLiveOutputState',
      'appendLiveOutput',
      'liveOutputTailText',
      'liveOutputSnapshot',
      'boundedExecutionResult',
      'outputProbeNeedsFull',
      'outputProbeUtf8Size',
      'createOutputProbe',
      'consumeOutputProbeLine',
      'appendOutputProbe',
      'finishOutputProbe',
      'publishLiveOutput',
      'maybeRenderLiveDetail',
      'runScriptStep',
    ]);
    const runScriptStep = context.runScriptStep;
    context.runScriptStep = (child, index) => {
      const call = { child, index, kind: 'script', promise: null };
      started.push(call);
      call.promise = runScriptStep(child, index);
      return call.promise;
    };
  }

  if (options.realHttp) {
    installFunctions(context, [
      'createLiveOutputState',
      'appendLiveOutput',
      'liveOutputTailText',
      'liveOutputSnapshot',
      'createLiveLog',
      'appendLiveLogPart',
      'appendLiveLog',
      'appendLiveChunk',
      'finishLiveLog',
      'outputProbeNeedsFull',
      'outputProbeUtf8Size',
      'createOutputProbe',
      'consumeOutputProbeLine',
      'appendOutputProbe',
      'finishOutputProbe',
      'maybeRenderLiveDetail',
      'readBrowserResponseText',
      'jkIsUrl',
      'jkSubstUrl',
      'jkJobPath',
      'jkJobRef',
      'jkTriggerGet',
      'runUrlStep',
    ]);
    const runUrlStep = context.runUrlStep;
    context.runUrlStep = (child, index) => {
      const call = { child, index, kind: 'http', promise: null };
      started.push(call);
      call.promise = runUrlStep(child, index);
      return call.promise;
    };
  }

  return { context, rc, started, finished, archived, clearedTimers, pendingScripts, stopButton };
}

function retryContext() {
  const advanced = [];
  const stopButton = { disabled: true };
  const stages = parallelThenAfter();
  stages.forEach(stage => Object.assign(stage, {
    _out: { stdout: 'stale output' },
    _archiveStdout: 'stale archive',
    _archiveOutputParts: ['stale parts'],
    _logArchived: true,
    _serverLogPending: true,
    _serverLogFile: '/archive/stale.log',
    _promT0: 100,
    _promT1: 200,
    _promCollected: true,
    _promGroupCollected: true,
  }));
  const rc = {
    id: 'retry-parent', stages,
    nodes: {
      a: { status: 'success', varsIn: { UPSTREAM: 'snapshot' }, varsOut: { A: 'old' } },
      b: { status: 'failed', varsIn: { UPSTREAM: 'wrong-click-snapshot' }, varsOut: { B: 'old' } },
      after: { status: 'success', varsIn: { UPSTREAM: 'downstream' }, varsOut: { AFTER: 'old' } },
    },
    selId: 'b', timer: null, scriptAbort: null, over: true, token: 'retry-token',
    vars: { UPSTREAM: 'mutated', A: 'old' }, parallelGroup: null,
  };
  const context = {
    console, Object, Array,
    MAX_ACTIVE_RUNS: 4,
    viewRc: rc,
    activeRuns: [],
    conflictsActive() { return false; },
    flashRunTip() {},
    syncRunState() {},
    $() { return stopButton; },
    rcOverall() {},
    runSetSel(run, id) { run.selId = id; },
    rcRender() {},
    advance(_run, index) { advanced.push(index); },
  };
  vm.createContext(context);
  installFunctions(context, ['pipelineStageGroups', 'pipelineStageGroupAt', 'retryFromStage']);
  return { context, rc, advanced, stopButton };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function parallelPromContext(rc) {
  const calls = [];
  const context = {
    console,
    Object,
    Array,
    Date,
    Promise,
    taskPromCollect(_rc, stage, seq, startMs, endMs) {
      calls.push({ name: stage.name, seq, startMs, endMs });
      return Promise.resolve();
    },
    stageSeq(_stages, index) { return index + 1; },
  };
  vm.createContext(context);
  installFunctions(context, ['pipelineStageGroups', 'parallelPromCandidate', 'taskPromFinalize']);
  return { context, calls };
}

test('并行组只为运行时间最长的合格勾选任务采集一次', async () => {
  const rc = {
    stages: [
      { id: 'a', name: '短任务', parallel: true, promCollect: true, _promT0: 1000, _promT1: 4000 },
      { id: 'b', name: '最长任务', parallel: true, promCollect: true, _promT0: 1000, _promT1: 9000 },
      { id: 'c', name: '已取消', parallel: true, promCollect: true, _promT0: 1000, _promT1: 12000 },
      { id: 'after', name: '后续串行', promCollect: true, _promT0: 1000, _promT1: 2000 },
    ],
    nodes: { a: { status: 'success' }, b: { status: 'failed' }, c: { status: 'aborted' }, after: { status: 'running' } },
  };
  const { context, calls } = parallelPromContext(rc);
  const group = context.pipelineStageGroups(rc.stages)[0];
  const picked = context.parallelPromCandidate(rc, group);
  assert.equal(picked.stage, rc.stages[1]);
  assert.equal(picked.startMs, 1000);
  assert.equal(picked.endMs, 9000);

  context.taskPromFinalize(rc);
  context.taskPromFinalize(rc);
  await tick();

  assert.deepEqual(calls.map(call => call.name), ['最长任务']);
  assert.equal(rc.stages[0]._promCollected, true);
  assert.equal(rc.stages[1]._promCollected, true);
  assert.equal(rc.stages[2]._promCollected, true);
  assert.equal(rc.stages[0]._promGroupCollected, true);
});

test('并行普罗采集耗时相同时保留更早编排任务', async () => {
  const rc = {
    stages: [
      { id: 'a', name: '较早任务', parallel: true, promCollect: true, _promT0: 1000, _promT1: 5000 },
      { id: 'b', name: '较晚任务', parallel: true, promCollect: true, _promT0: 2000, _promT1: 6000 },
    ],
    nodes: { a: { status: 'success' }, b: { status: 'success' } },
  };
  const { context, calls } = parallelPromContext(rc);
  const group = context.pipelineStageGroups(rc.stages)[0];
  assert.equal(context.parallelPromCandidate(rc, group).stage, rc.stages[0]);
  context.taskPromFinalize(rc);
  await tick();
  assert.deepEqual(calls.map(call => call.name), ['较早任务']);
});

test('失败并行组在所有成员终态后仅采集失败成员的真实窗口', async () => {
  const rc = {
    stages: [
      { id: 'a', name: '失败任务', parallel: true, promCollect: true, _promT0: 1000, _promT1: 7000 },
      { id: 'b', name: '中止同伴', parallel: true, promCollect: true, _promT0: 1000, _promT1: 9000 },
    ],
    nodes: { a: { status: 'failed' }, b: { status: 'aborted' } },
  };
  const { context, calls } = parallelPromContext(rc);
  context.taskPromFinalize(rc);
  await tick();
  assert.deepEqual(calls, [{ name: '失败任务', seq: 1, startMs: 1000, endMs: 7000 }]);
});

test('并行任务同时启动并等待全组成功后才启动后续任务', async () => {
  const { context, rc, started } = parallelContext(parallelThenAfter());
  context.advance(rc, 0);
  assert.deepEqual(started.map(call => call.index), [0, 1]);
  started[1].child.nodes.b = { status: 'success', varsOut: { VALUE: 'b' } };
  context.advance(started[1].child, 2);
  await tick();
  assert.deepEqual(started.map(call => call.index), [0, 1]);
  started[0].child.nodes.a = { status: 'success', varsOut: { VALUE: 'a', A: '1' } };
  context.advance(started[0].child, 1);
  await tick();
  assert.deepEqual(started.map(call => call.index), [0, 1, 2]);
  assert.deepEqual(plain(rc.vars), { UPSTREAM: 'snapshot', VALUE: 'b', A: '1' });
});

test('首个脚本失败取消在途脚本同伴且不启动后续任务', async () => {
  const fixture = parallelContext(parallelThenAfter());
  fixture.context.advance(fixture.rc, 0);
  const failed = fixture.started[0].child;
  const peer = fixture.started[1].child;
  const peerSignal = peer.scriptAbort.signal;
  fixture.context.clearInterval(failed.timer); failed.timer = null; failed.scriptAbort = null;
  failed.nodes.a = { status: 'failed', progress: 100, varsIn: { UPSTREAM: 'snapshot' }, varsOut: { BAD: 'failure-output' } };
  fixture.context.finish(failed, 'failed');
  await tick();

  assert.equal(fixture.rc.nodes.a.status, 'failed');
  assert.equal(fixture.rc.nodes.b.status, 'aborted');
  assert.equal(peerSignal.aborted, true);
  assert.equal(peer.over, true);
  assert.deepEqual(fixture.started.map(call => call.index), [0, 1]);
  assert.deepEqual(fixture.finished, ['failed']);
  assert.equal(fixture.rc.over, true);
  assert.equal(fixture.archived.some(item => item.id === 'b'), true);
});

test('失败组不合并已成功成员输出并保留已完成终态', async () => {
  const fixture = parallelContext(parallelThenAfter());
  fixture.context.advance(fixture.rc, 0);
  const failed = fixture.started[0].child;
  const completed = fixture.started[1].child;
  completed.nodes.b = { status: 'success', progress: 100, varsIn: { UPSTREAM: 'snapshot' }, varsOut: { LEAK: 'must-not-merge' } };
  fixture.context.advance(completed, 2);
  failed.nodes.a = { status: 'failed', progress: 100, varsIn: { UPSTREAM: 'snapshot' }, varsOut: { BAD: 'must-not-merge' } };
  fixture.context.settleParallelStage(failed, 'failed');
  await tick();

  assert.equal(fixture.rc.nodes.a.status, 'failed');
  assert.equal(fixture.rc.nodes.b.status, 'success');
  assert.deepEqual(plain(fixture.rc.vars), { UPSTREAM: 'snapshot' });
  assert.deepEqual(fixture.started.map(call => call.index), [0, 1]);
  assert.deepEqual(fixture.finished, ['failed']);
});

test('脚本失败会清除在途模拟任务计时器且迟回推进不改写终态', async () => {
  const simulated = { id: 'b', name: 'B', parallel: true, dur: 30 };
  const fixture = parallelContext(parallelThenAfter(simulated));
  fixture.context.advance(fixture.rc, 0);
  const failed = fixture.started.find(call => call.index === 0).child;
  const peerCall = fixture.started.find(call => call.index === 1);
  const peerTimer = peerCall.child.timer;
  fixture.context.clearInterval(failed.timer); failed.timer = null; failed.scriptAbort = null;
  failed.nodes.a = { status: 'failed', progress: 100, varsIn: { UPSTREAM: 'snapshot' }, varsOut: {} };
  fixture.context.finish(failed, 'failed');
  await tick();

  assert.equal(fixture.clearedTimers.includes(peerTimer), true);
  assert.equal(peerCall.child.timer, null);
  assert.equal(fixture.rc.nodes.b.status, 'aborted');
  fixture.context.advance(peerCall.child, 2);
  await tick();
  assert.equal(fixture.rc.nodes.b.status, 'aborted');
  assert.deepEqual(fixture.finished, ['failed']);
  assert.deepEqual(fixture.started.map(call => call.index), [0, 1]);
});

test('并行取消后重试时旧脚本迟回不能恢复旧归档所有权', async () => {
  const fixture = parallelContext(parallelThenAfter(), { realScript: true });
  fixture.context.advance(fixture.rc, 0);
  const oldA = fixture.started.find(call => call.index === 0);
  const oldB = fixture.started.find(call => call.index === 1);
  fixture.pendingScripts[0].resolve({ code: 1, stdout: '', stderr: 'failed' });
  await oldA.promise;
  await tick();
  assert.equal(fixture.rc.nodes.b.status, 'aborted');

  fixture.context.retryFromStage('a');
  assert.deepEqual(fixture.started.map(call => call.index), [0, 1, 0, 1]);
  const stage = fixture.rc.stages[1];
  assert.equal(stage._serverLogPending, false);
  assert.equal(stage._serverLogFile, null);
  assert.equal(stage._logArchived, false);

  fixture.pendingScripts[1].resolve({
    code: 0, stdout: 'OLD=value', stderr: '', logFile: '/archive/old-b.log',
  });
  await oldB.promise;

  assert.equal(stage._serverLogPending, false);
  assert.equal(stage._serverLogFile, null);
  assert.equal(stage._logArchived, false);
  assert.equal(fixture.rc.nodes.b.status, 'running');
});

test('用户中止并行组会取消全部成员并只记录一次 aborted', async () => {
  const fixture = parallelContext(parallelThenAfter());
  fixture.context.advance(fixture.rc, 0);
  const signals = fixture.started.slice(0, 2).map(call => call.child.scriptAbort.signal);
  fixture.context.abortRun(fixture.rc);
  await tick();

  assert.deepEqual(signals.map(signal => signal.aborted), [true, true]);
  assert.equal(fixture.rc.nodes.a.status, 'aborted');
  assert.equal(fixture.rc.nodes.b.status, 'aborted');
  assert.equal(fixture.rc.over, true);
  assert.deepEqual(fixture.finished, ['aborted']);
  assert.equal(fixture.context.history.length, 1);
  assert.equal(fixture.context.history[0].status, 'aborted');
});

test('浏览器重置会释放全部并行子任务且迟回结果不归档也不记历史', async () => {
  const fixture = parallelContext(parallelThenAfter(), { realScript: true });
  fixture.context.advance(fixture.rc, 0);
  const children = fixture.started.slice(0, 2).map(call => call.child);
  const signals = children.map(child => child.scriptAbort.signal);
  const timers = children.map(child => child.timer);

  assert.equal(typeof fixture.context.disposeRunForReset, 'function', '缺少浏览器重置运行释放入口');
  fixture.context.disposeRunForReset(fixture.rc);

  const archivesAfterDispose = fixture.archived.length;
  assert.deepEqual(signals.map(signal => signal.aborted), [true, true]);
  assert.deepEqual(children.map(child => child.timer), [null, null]);
  assert.equal(timers.every(timer => fixture.clearedTimers.includes(timer)), true);
  assert.deepEqual(children.map(child => child.over), [true, true]);
  assert.equal(fixture.rc.over, true);
  assert.equal(fixture.context.history.length, 0);

  fixture.pendingScripts[0].resolve({ code: 0, stdout: 'LATE_A=1', stderr: '', logFile: '/archive/late-a.log' });
  fixture.pendingScripts[1].resolve({ code: 0, stdout: 'LATE_B=1', stderr: '', logFile: '/archive/late-b.log' });
  await Promise.all(fixture.started.slice(0, 2).map(call => call.promise));
  await tick();

  assert.deepEqual(plain(fixture.rc.vars), { UPSTREAM: 'snapshot' });
  assert.deepEqual(fixture.rc.stages.slice(0, 2).map(stage => stage._serverLogFile), [null, null]);
  assert.equal(fixture.archived.length, archivesAfterDispose);
  assert.equal(fixture.context.history.length, 0);
  assert.deepEqual(fixture.finished, []);
});

test('失败阶段重试从并行组首项开始并恢复组入口变量与运行状态', () => {
  const fixture = retryContext();
  fixture.context.retryFromStage('b');

  assert.deepEqual(fixture.advanced, [0]);
  assert.deepEqual(plain(fixture.rc.vars), { UPSTREAM: 'snapshot' });
  assert.equal(fixture.rc.over, false);
  assert.equal(fixture.stopButton.disabled, false);
  for (const stage of fixture.rc.stages) {
    assert.equal(fixture.rc.nodes[stage.id].status, 'idle', stage.id + ' 节点未复位');
    assert.equal(stage._out, null, stage.id + ' 输出未复位');
    assert.equal(stage._archiveStdout, null, stage.id + ' 归档全文未复位');
    assert.equal(stage._archiveOutputParts, null, stage.id + ' 归档分片未复位');
    assert.equal(stage._logArchived, false, stage.id + ' 归档标记未复位');
    assert.equal(stage._serverLogPending, false, stage.id + ' 服务端日志 pending 未复位');
    assert.equal(stage._serverLogFile, null, stage.id + ' 服务端日志路径未复位');
    assert.equal(stage._promT0, null, stage.id + ' 普罗开始时间未复位');
    assert.equal(stage._promT1, null, stage.id + ' 普罗结束时间未复位');
    assert.equal(stage._promCollected, false, stage.id + ' 普罗采集标记未复位');
    assert.equal(stage._promGroupCollected, false, stage.id + ' 普罗分组采集标记未复位');
  }
});

test('串行失败重试仍从点击阶段恢复且不扩大运行状态清理范围', () => {
  const fixture = retryContext();
  fixture.rc.stages.forEach(stage => { stage.parallel = false; });
  fixture.rc.nodes.b.varsIn = { SERIAL: 'entry' };
  fixture.rc.vars = { SERIAL: 'mutated' };
  const downstreamOutput = fixture.rc.stages[2]._out;
  const downstreamParts = fixture.rc.stages[2]._archiveOutputParts;

  fixture.context.retryFromStage('b');

  assert.deepEqual(fixture.advanced, [1]);
  assert.deepEqual(plain(fixture.rc.vars), { SERIAL: 'entry' });
  assert.equal(fixture.rc.nodes.a.status, 'success');
  assert.equal(fixture.rc.stages[2]._out, downstreamOutput);
  assert.equal(fixture.rc.stages[2]._archiveOutputParts, downstreamParts);
  assert.equal(fixture.rc.stages[2]._serverLogPending, true);
});

test('浏览器 HTTP 同伴在本地和远程模式都被组失败信号取消', async () => {
  for (const mode of ['local', 'remote']) {
    const signals = [];
    const fetch = (_url, init) => {
      signals.push(init && init.signal);
      return new Promise((resolve, reject) => {
        const signal = init && init.signal;
        if (!signal) return;
        const abort = () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); };
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
    };
    const fixture = parallelContext(parallelThenAfter({
      id: 'b', name: 'HTTP peer', parallel: true, kind: 'http', url: { url: 'http://service.local/hook' },
    }), { realHttp: true, jenkinsMode: mode, fetch });
    fixture.context.advance(fixture.rc, 0);
    const failed = fixture.started.find(call => call.index === 0).child;
    fixture.context.clearInterval(failed.timer); failed.timer = null; failed.scriptAbort = null;
    failed.nodes.a = { status: 'failed', progress: 100, varsIn: { UPSTREAM: 'snapshot' }, varsOut: {} };
    fixture.context.finish(failed, 'failed');
    await tick();

    assert.ok(signals[0], mode + ' HTTP 请求未收到 AbortSignal');
    assert.equal(signals[0].aborted, true, mode + ' HTTP 请求信号未中止');
    assert.equal(fixture.rc.nodes.b.status, 'aborted');
    assert.deepEqual(fixture.finished, ['failed']);
  }
});

test('取消后忽略不遵守 AbortSignal 的 HTTP 迟回结果', async () => {
  let releaseFetch;
  const fixture = parallelContext(parallelThenAfter({
    id: 'b', name: 'late HTTP', parallel: true, kind: 'http', url: { url: 'http://service.local/late' },
  }), {
    realHttp: true,
    fetch: () => new Promise(resolve => { releaseFetch = resolve; }),
  });
  fixture.context.advance(fixture.rc, 0);
  const failed = fixture.started.find(call => call.index === 0).child;
  const httpCall = fixture.started.find(call => call.index === 1);
  fixture.context.clearInterval(failed.timer); failed.timer = null; failed.scriptAbort = null;
  failed.nodes.a = { status: 'failed', progress: 100, varsIn: { UPSTREAM: 'snapshot' }, varsOut: {} };
  fixture.context.finish(failed, 'failed');
  await tick();
  const terminalOutput = fixture.rc.stages[1]._out.stdout;

  releaseFetch({ ok: true, status: 200, text: async () => 'LATE=value' });
  await httpCall.promise;
  await tick();

  assert.equal(fixture.rc.nodes.b.status, 'aborted');
  assert.equal(fixture.rc.stages[1]._out.stdout, terminalOutput);
  assert.deepEqual(plain(fixture.rc.vars), { UPSTREAM: 'snapshot' });
  assert.deepEqual(fixture.finished, ['failed']);
  assert.deepEqual(fixture.started.map(call => call.index), [0, 1]);
});

test('Jenkins 请求链在本地和远程模式都透传同一个 AbortSignal', async () => {
  for (const mode of ['local', 'remote']) {
    const calls = [];
    const context = {
      console, Promise, JSON, Error, AbortController,
      jenkins: { url: 'http://jenkins.local', user: 'user', token: 'token', mode },
      btoa(value) { return Buffer.from(value).toString('base64'); },
      fetch: async (url, init) => {
        calls.push({ url, init: init || {} });
        if (url === '/api/worktable/proxy') {
          const request = JSON.parse(init.body);
          if (request.url.includes('crumbIssuer')) return { json: async () => ({ status: 200, body: '{"crumbRequestField":"Jenkins-Crumb","crumb":"crumb"}' }) };
          if (request.url.includes('progressiveText')) return { json: async () => ({ status: 200, body: '', headers: { 'x-text-size': '0' } }) };
          if (request.url.endsWith('/api/json')) return { json: async () => ({ status: 200, body: '{}' }) };
          return { json: async () => ({ status: 200, body: 'console' }) };
        }
        if (String(url).includes('progressiveText')) return { ok: true, status: 200, headers: { get: name => name.toLowerCase() === 'x-text-size' ? '0' : null }, text: async () => '' };
        if (String(url).includes('crumbIssuer')) return { ok: true, status: 200, json: async () => ({ crumbRequestField: 'Jenkins-Crumb', crumb: 'crumb' }) };
        if (String(url).endsWith('/api/json')) return { ok: true, status: 200, json: async () => ({}) };
        return { ok: true, status: 200, text: async () => 'console' };
      },
    };
    vm.createContext(context);
    installFunctions(context, [
      'jkFetchJson', 'jkFetchCrumb', 'jkTriggerBuild', 'jkTriggerGet', 'jkGetText',
      'readBrowserResponseText', 'jkHeaderValue', 'jkGetProgressiveText', 'jkReadConsoleDelta',
    ]);
    const controller = new AbortController();
    const signal = controller.signal;
    await context.jkFetchJson(context.jenkins, 'http://jenkins.local/api/json', signal);
    await context.jkFetchCrumb(context.jenkins, {}, signal);
    await context.jkTriggerBuild('/job/demo/', {}, signal);
    await context.jkTriggerGet('http://jenkins.local/hook', signal);
    await context.jkGetText('/job/demo/1/consoleText', signal);
    await context.jkGetProgressiveText('/job/demo/1', 0, signal);
    await context.jkReadConsoleDelta('/job/demo/1', 0, true, signal);

    assert.ok(calls.length >= 8, mode + ' 请求链覆盖不足');
    assert.equal(calls.every(call => call.init.signal === signal), true, mode + ' 请求链没有一致透传 AbortSignal');
  }
});

test('HTTP 轮询等待可由 AbortSignal 立即取消', async () => {
  const context = { Promise, Error, setTimeout, clearTimeout };
  vm.createContext(context);
  installFunctions(context, ['abortablePipelineDelay']);
  assert.equal(typeof context.abortablePipelineDelay, 'function', '缺少可取消的轮询等待');
  const controller = new AbortController();
  const waiting = context.abortablePipelineDelay(10_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, error => error && error.name === 'AbortError');
});
