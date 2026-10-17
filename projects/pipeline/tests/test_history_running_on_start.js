// 运行历史「进行中」：点「运行流水线」启动即写入运行历史（status:'running'），
// finish 按 tag 原地更新为终态；重置撤回该条；服务端 appendPipelineHistory 同 tag 原地替换。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = require('./_page-source.cjs').loadPageSource();

function functionSource(name) {
  let start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '缺少函数 ' + name);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  assert.fail('函数 ' + name + ' 缺少闭合括号');
}

function load(ctx, names) {
  vm.createContext(ctx);
  names.forEach(n => vm.runInContext(functionSource(n), ctx));
  return ctx;
}

function baseCtx(overrides) {
  const calls = { persist: 0, render: 0, release: [], drain: 0 };
  const ctx = Object.assign({
    activeRuns: [], viewRc: null, history: [], histPage: 0, selHistoryIdx: -1, buildNo: 0,
    curPipeline: () => ({ name: 'PL' }),
    nowHM: () => '10:00',
    fmtDur: s => (s < 60 ? Math.round(s) + 's' : Math.floor(s / 60) + 'm' + Math.round(s % 60) + 's'),
    promSnapshotForRun: () => null,
    collectRunLogs: () => [{ stage: '构建', status: 'success', dur: 1, logFile: '/a/1.log' }],
    archiveFolderFor: () => '/archive/pl',
    historyEnvNodesOf: () => [],
    renderHistory: () => { calls.render++; },
    renderStats: () => { calls.render++; },
    persistState: () => { calls.persist++; },
    refreshArchiveTip: () => {},
    rcOverall: () => {},
    archiveRun: () => {},
    renderDetail: () => {},
    drainQueue: () => { calls.drain++; },
    renderQueue: () => {},
    syncRunState: () => {},
    taskPromFinalize: () => {},
    releaseNodeLease: (id, ips) => { calls.release.push({ id, ips }); },
    clearInterval: () => {},
    $: () => ({ disabled: false }),
    viewActive: () => false,
    console,
  }, overrides || {});
  return { ctx, calls };
}

/* ---------- beginRunHistory ---------- */

test('beginRunHistory：启动即写入「进行中」记录并占编号', () => {
  const { ctx, calls } = baseCtx();
  load(ctx, ['beginRunHistory']);
  const rc = {
    tag: 't-1', pipelineName: '部署', env: '10.0.0.1', commit: 'abcdef12', by: 'alice',
    startTs: Date.now(), pipelineId: 'p1', repoId: 'r1', branch: 'main', strategy: 'blue', envs: [],
  };
  const rec = ctx.beginRunHistory(rc);
  assert.equal(rec.status, 'running');
  assert.equal(rec.no, 1);
  assert.equal(rec.tag, 't-1');
  assert.equal(rec.pipeline, '部署');
  assert.equal(rec.archive, '/archive/pl');
  assert.equal(rec.logs.length, 0, '终态前 logs 尚不齐全');
  assert.equal(ctx.history.length, 1);
  assert.equal(ctx.history[0], rec);
  assert.equal(ctx.buildNo, 1);
  assert.equal(ctx.selHistoryIdx, 0);
  assert.equal(calls.persist, 1, '启动即持久化，他端历史刷新可见「进行中」');
});

test('beginRunHistory：同 tag 幂等，不重复占号', () => {
  const { ctx } = baseCtx();
  load(ctx, ['beginRunHistory']);
  const rc = { tag: 't-1', pipelineName: 'P', env: '', commit: 'abc', by: 'a', startTs: Date.now() };
  const first = ctx.beginRunHistory(rc);
  const second = ctx.beginRunHistory(rc);
  assert.equal(second, first);
  assert.equal(ctx.history.length, 1);
  assert.equal(ctx.buildNo, 1);
});

/* ---------- finish：按 tag 原地更新 ---------- */

function finishCtx() {
  const { ctx, calls } = baseCtx();
  load(ctx, ['mergeStageLogsForHistory', 'historyEnvNodesOf', 'beginRunHistory', 'finish']);
  return { ctx, calls };
}

test('finish：已有「进行中」记录时按 tag 原地更新为终态，不新增第二条', () => {
  const { ctx } = finishCtx();
  const rc = {
    id: 'r1', over: false, timer: null, leaseTimer: null, leaseId: null, leaseIps: [],
    stages: [], nodes: {}, startTs: Date.now() - 5000, by: 'alice', pipelineName: 'PL', env: '10.0.0.1',
    commit: 'abcdef123', tag: 't-1', vars: {},
  };
  ctx.activeRuns.push(rc);
  ctx.beginRunHistory(rc);
  assert.equal(ctx.history.length, 1);
  assert.equal(ctx.history[0].status, 'running');
  const no = ctx.history[0].no;

  ctx.finish(rc, 'success');

  assert.equal(ctx.history.length, 1, '不得新增第二条');
  assert.equal(ctx.history[0].status, 'success');
  assert.equal(ctx.history[0].no, no, '沿用启动时分配的编号');
  assert.equal(ctx.history[0].tag, 't-1');
  assert.equal(ctx.history[0].logs.length, 1, '终态补齐阶段日志元数据');
  assert.equal(ctx.buildNo, 1, 'finish 不再额外占号');
});

test('finish：无启动记录时（旧路径兜底）仍新增终态记录', () => {
  const { ctx } = finishCtx();
  const rc = {
    id: 'r2', over: false, timer: null, stages: [], nodes: {}, startTs: Date.now() - 1000,
    by: 'alice', pipelineName: 'PL', env: '', commit: 'abcdef123', tag: 't-2', vars: {},
  };
  ctx.activeRuns.push(rc);
  ctx.finish(rc, 'failed');
  assert.equal(ctx.history.length, 1);
  assert.equal(ctx.history[0].status, 'failed');
  assert.equal(ctx.history[0].no, 1);
});

/* ---------- disposeRunForReset：撤回「进行中」记录 ---------- */

test('disposeRunForReset：重置撤回「进行中」历史（不计入历史）', () => {
  const { ctx } = baseCtx({ cancelParallelGroup: () => {}, discardHeldSuffixPlan: () => {} });
  load(ctx, ['disposeRunForReset']);
  ctx.history = [{ no: 1, tag: 't-1', status: 'running' }, { no: 2, tag: 't-0', status: 'success' }];
  ctx.selHistoryIdx = 0;
  ctx.disposeRunForReset({ tag: 't-1', over: false });
  assert.equal(ctx.history.length, 1);
  assert.equal(ctx.history[0].tag, 't-0');
  assert.equal(ctx.selHistoryIdx, -1);
});

test('disposeRunForReset：不撤回已终态记录', () => {
  const { ctx } = baseCtx({ cancelParallelGroup: () => {}, discardHeldSuffixPlan: () => {} });
  load(ctx, ['disposeRunForReset']);
  ctx.history = [{ no: 1, tag: 't-1', status: 'success' }];
  ctx.disposeRunForReset({ tag: 't-1', over: true });
  assert.equal(ctx.history.length, 1);
});

/* ---------- labelOf / 筛选 / 徽标静态契约 ---------- */

test('labelOf 含「进行中」；状态筛选下拉含 running 选项', () => {
  const ctx = load({}, ['labelOf']);
  assert.equal(ctx.labelOf('running'), '进行中');
  assert.equal(ctx.labelOf('success'), '已完成');
  assert.match(source, /<option value="running">进行中<\/option>/);
  assert.match(source, /function beginRunHistory/);
});

test('历史行徽标对 running 使用 dshell-badgeWait，耗时按 startTs 实时计算', () => {
  assert.match(source, /h\.status==='running'\?'dshell-badgeWait':'/);
  assert.match(source, /h\.status==='running'&&Number\(h\.startTs\)>0\)\?fmtDur\(/);
});

test('startSimRun 启动路径调用 beginRunHistory', () => {
  const m = /function startSimRun\(pl, c\)\{[\s\S]*?beginRunHistory\(rc\);/.exec(source);
  assert.ok(m, 'startSimRun 应在启动后调用 beginRunHistory 写入「进行中」历史');
});

/* ---------- applyHistoryRefreshPayload：本地在跑/终态记录优先 ---------- */

test('applyHistoryRefreshPayload：本地终态不被远端滞后 running 覆盖', () => {
  const local = { no: 1, tag: 't-1', status: 'success', dur: '3s', logs: [1] };
  const ctx = load({
    history: [local], histClearedAt: 0, buildNo: 1, historySyncSig: 'x', activeRuns: [],
    historyForPersist: () => [],
    historyPersistSig: () => 'sig',
    historyMarkSynced: () => { ctx.marked = true; },
  }, ['historyPersistSig', 'historyMarkSynced', 'historyForPersist', 'applyHistoryRefreshPayload']);
  const ok = ctx.applyHistoryRefreshPayload({
    config: { buildNo: 1, histClearedAt: 0 },
    history: [{ no: 1, tag: 't-1', status: 'running', dur: '0s', logs: [] }],
  }, 0);
  assert.equal(ok, true);
  assert.equal(ctx.history[0].status, 'success', '本地终态优先于远端 running');
  assert.equal(ctx.history[0].logs.length, 1);
  assert.equal(ctx.historySyncSig, '', '有本地覆盖时强制下次 persist 携带历史');
  assert.equal(ctx.marked, undefined);
});

test('applyHistoryRefreshPayload：本页仍在跑的 running 记录在远端缺失时补回', () => {
  const live = { no: 2, tag: 'live-1', status: 'running', startTs: Date.now() };
  const ctx = load({
    history: [live], histClearedAt: 0, buildNo: 2, historySyncSig: '',
    activeRuns: [{ tag: 'live-1' }],
    historyForPersist: () => [],
    historyPersistSig: () => 'sig',
    historyMarkSynced: () => { ctx.marked = true; },
  }, ['historyPersistSig', 'historyMarkSynced', 'historyForPersist', 'applyHistoryRefreshPayload']);
  const ok = ctx.applyHistoryRefreshPayload({
    config: { buildNo: 2, histClearedAt: 0 },
    history: [{ no: 1, tag: 'other', status: 'success' }],
  }, 0);
  assert.equal(ok, true);
  assert.equal(ctx.history.length, 2);
  assert.equal(ctx.history[0].tag, 'live-1');
  assert.equal(ctx.history[0].status, 'running');
  assert.equal(ctx.historySyncSig, '');
});

test('applyHistoryRefreshPayload：无本地覆盖时照常标记已同步', () => {
  const ctx = load({
    history: [{ no: 1, tag: 'a', status: 'success' }],
    histClearedAt: 0, buildNo: 1, historySyncSig: 'old', activeRuns: [],
  }, ['historyPersistSig', 'historyMarkSynced', 'historyForPersist', 'applyHistoryRefreshPayload']);
  ctx.applyHistoryRefreshPayload({
    config: { buildNo: 1, histClearedAt: 0 },
    history: [{ no: 1, tag: 'a', status: 'success' }],
  }, 0);
  assert.notEqual(ctx.historySyncSig, 'old', '无本地覆盖时应调用 historyMarkSynced 推进签名');
  assert.equal(typeof ctx.historySyncSig, 'string');
  assert.ok(ctx.historySyncSig.length > 0);
});
