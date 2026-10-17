// 混合编排运行历史：同 tag 只留一条、阶段日志按名并集（本地前缀 + 服务端后缀完整）、本地执行标识。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = require('./_page-source.cjs').loadPageSource();

/* node:vm 跨 realm 数组不能直接 assert.deepEqual（结构相同但引用不等）：统一转宿主数组再断言 */
const hostArr = (v) => Array.from(v || []);
const namesOf = (logs) => hostArr(logs).map(e => String(e && e.stage));

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

/* ---------- mergeStageLogsForHistory ---------- */

test('mergeStageLogsForHistory：按阶段名并集，本地前缀不被后缀冲掉', () => {
  const ctx = load({}, ['mergeStageLogsForHistory']);
  const prev = [
    { stage: '本地A', status: 'success', dur: 1, local: true, logFile: '/a/A.log' },
    { stage: '本地B', status: 'success', dur: 2, local: true },
    { stage: '定时C', status: 'skipped', dur: 0 },
  ];
  const next = [
    { stage: '定时C', status: 'failed', dur: 3, logFile: '/a/C.log' },
    { stage: '定时D', status: 'success', dur: 4 },
  ];
  const merged = ctx.mergeStageLogsForHistory(prev, next);
  assert.deepEqual(namesOf(merged), ['本地A', '本地B', '定时C', '定时D']);
  assert.equal(merged[0].local, true);
  assert.equal(merged[0].logFile, '/a/A.log');
  assert.equal(merged[1].local, true);
  assert.equal(merged[2].status, 'failed', '同名阶段后者（服务端）覆盖状态');
  assert.equal(merged[2].logFile, '/a/C.log');
  assert.equal(merged[3].status, 'success');
});

test('mergeStageLogsForHistory：保留任一侧 local 标记，补 logFile/dur 兜底', () => {
  const ctx = load({}, ['mergeStageLogsForHistory']);
  const merged = ctx.mergeStageLogsForHistory(
    [{ stage: 'S', status: 'success', local: true, logFile: '/x/s.log', dur: 1, log: 'old' }],
    [{ stage: 'S', status: 'failed', dur: 2 }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].local, true, 'local 标记不得被无 local 的一侧清掉');
  assert.equal(merged[0].logFile, '/x/s.log');
  assert.equal(merged[0].log, 'old');
  assert.equal(merged[0].status, 'failed');
});

test('mergeStageLogsForHistory：空/脏输入不抛错', () => {
  const ctx = load({}, ['mergeStageLogsForHistory']);
  assert.deepEqual(hostArr(ctx.mergeStageLogsForHistory(null, undefined)), []);
  assert.deepEqual(namesOf(ctx.mergeStageLogsForHistory([{ nos: 1 }, null], [{ stage: 'X' }])), ['X']);
});

/* ---------- collectRunLogs：local 标记 + 移交后缀不写占位 ---------- */

function collectCtx(overrides) {
  return Object.assign({
    stages: [
      { id: 'a', name: '本地A' },
      { id: 'b', name: '定时B' },
      { id: 'c', name: '定时C' },
    ],
    nodes: {
      a: { status: 'success', dur: 1.5 },
      b: { status: 'skipped', dur: 0 },
      c: { status: 'running', dur: 0 },
    },
  }, overrides || {});
}

test('collectRunLogs：浏览器执行阶段带 local:true，running 不入史', () => {
  const ctx = load({ archiveFolderFor: () => null, stageSeq: () => 1, taskLogFile: () => 'x.log', buildLogParts: () => [''] }, ['collectRunLogs']);
  const logs = ctx.collectRunLogs(collectCtx());
  assert.deepEqual(namesOf(logs), ['本地A', '定时B']);
  assert.equal(logs[0].local, true);
  assert.equal(logs[1].local, true);
});

test('collectRunLogs：handoffFromIdx 起的后缀不写本地占位（待服务端合并补齐）', () => {
  const ctx = load({ archiveFolderFor: () => null, stageSeq: () => 1, taskLogFile: () => 'x.log', buildLogParts: () => [''] }, ['collectRunLogs']);
  const logs = ctx.collectRunLogs(collectCtx(), 1);
  assert.deepEqual(namesOf(logs), ['本地A']);
  assert.equal(logs[0].local, true);
});

test('collectRunLogs：rc.handoffFromIdx 兜底生效', () => {
  const ctx = load({ archiveFolderFor: () => null, stageSeq: () => 1, taskLogFile: () => 'x.log', buildLogParts: () => [''] }, ['collectRunLogs']);
  const rc = collectCtx({ handoffFromIdx: 1 });
  const logs = ctx.collectRunLogs(rc);
  assert.deepEqual(namesOf(logs), ['本地A']);
});

/* ---------- isLocalExecStage / appendLocalExecBadge ---------- */

test('isLocalExecStage：历史条目 local / 阶段快照 local / 实时本地运行三口径', () => {
  const ctx = load({}, ['isLocalExecStage']);
  assert.equal(ctx.isLocalExecStage({}, { local: true }, {}), true);
  assert.equal(ctx.isLocalExecStage({ local: true }, {}, {}), true);
  assert.equal(ctx.isLocalExecStage({ local: true }, { local: false }, { remotePreview: true }), true, '阶段快照 local 优先');
  assert.equal(ctx.isLocalExecStage({}, {}, { remotePreview: true }), false, '远端只读预览默认非本地');
  assert.equal(ctx.isLocalExecStage({}, null, { id: 'r1', tag: 't', stages: [] }), true, '本页实时本地运行');
  assert.equal(ctx.isLocalExecStage({}, null, {}), false, '空闲态无运行不标本地');
});

test('appendLocalExecBadge：isLocal 时追加「本地执行」徽标', () => {
  const made = [];
  const badge = {
    appendChild(el) { made.push(el); },
  };
  const ctx = load({
    document: {
      createElement(tag) {
        return { tag, className: '', style: {}, textContent: '', title: '' };
      },
    },
  }, ['appendLocalExecBadge']);
  ctx.appendLocalExecBadge(badge, true);
  assert.equal(made.length, 1);
  assert.equal(made[0].textContent, '本地执行');
  ctx.appendLocalExecBadge(badge, false);
  assert.equal(made.length, 1);
});

/* ---------- applyReplayProfileStages：补齐缺失阶段 ---------- */

test('applyReplayProfileStages：profile 里有、logs 缺的阶段补进列表（含 local）', () => {
  const ctx = load({}, ['applyReplayProfileStages']);
  const rec = { logs: [{ stage: '定时C', status: 'failed', dur: 3 }] };
  ctx.applyReplayProfileStages(rec, [
    { name: '本地A', status: 'success', durSec: 1, local: true },
    { name: '定时C', status: 'success', durSec: 3 },
    { name: '定时D', status: 'failed', durSec: 2 },
  ]);
  assert.deepEqual(namesOf(rec.logs), ['定时C', '本地A', '定时D']);
  assert.equal(rec.logs[0].status, 'success', 'profile 校正已有条目状态');
  assert.equal(rec.logs[1].local, true);
  assert.equal(rec.logs[1].status, 'success');
  assert.equal(rec.logs[2].status, 'failed');
});

/* ---------- finish：同 tag 原地合并，只留一条 ---------- */

function finishCtx() {
  const calls = { persist: 0, render: 0, drain: 0 };
  const ctx = {
    activeRuns: [], history: [], histPage: 0, selHistoryIdx: -1, buildNo: 0,
    curPipeline: () => ({ name: 'PL' }),
    nowHM: () => '10:00',
    fmtDur: s => Math.round(s) + 's',
    promSnapshotForRun: () => null,
    archiveFolderFor: () => '/arc',
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
    releaseNodeLease: () => {},
    clearInterval: () => {},
    console,
  };
  load(ctx, ['mergeStageLogsForHistory', 'finish']);
  /* 不覆盖为真 collectRunLogs（真函数依赖 buildLogParts 等）：固定返回一条本地阶段 */
  ctx.collectRunLogs = () => [{ stage: '本地A', status: 'success', dur: 1, local: true }];
  return { ctx, calls };
}

test('finish：同 tag 已有记录时原地合并，不新增第二条（混合编排只留一条历史）', () => {
  const { ctx } = finishCtx();
  const existing = {
    no: 7, tag: 't-h', status: 'running',
    logs: [{ stage: '定时C', status: 'skipped', dur: 0 }],
  };
  ctx.history = [existing];
  const rc = {
    id: 'r1', over: false, timer: null, leaseTimer: null, leaseId: null, leaseIps: [],
    stages: [{ id: 'a', name: '本地A' }], nodes: { a: { status: 'success', dur: 1 } },
    startTs: Date.now() - 1000, by: 'alice', pipelineName: 'PL', env: '10.0.0.1',
    commit: 'abcdef123', tag: 't-h', vars: {}, handoffFromIdx: -1,
  };
  ctx.finish(rc, 'success');
  assert.equal(ctx.history.length, 1, '同 tag 只留一条');
  assert.equal(ctx.history[0], existing);
  assert.equal(existing.no, 7, '沿用原编号');
  assert.equal(existing.status, 'success');
  assert.equal(existing.source, 'local');
  const names = namesOf(existing.logs);
  assert.equal(names.includes('本地A') && names.includes('定时C') && names.length === 2, true, '本地 + 后缀阶段都在：' + names.join(','));
  assert.equal(existing.logs.find(e => e.stage === '本地A').local, true);
});

test('finish：无同 tag 时新增一条（纯本地路径）', () => {
  const { ctx } = finishCtx();
  const rc = {
    id: 'r2', over: false, timer: null, leaseTimer: null, leaseId: null, leaseIps: [],
    stages: [{ id: 'a', name: '本地A' }], nodes: { a: { status: 'success', dur: 1 } },
    startTs: Date.now() - 1000, by: 'bob', pipelineName: 'PL', env: '', commit: 'abcdef123', tag: 't-new', vars: {},
  };
  ctx.finish(rc, 'success');
  assert.equal(ctx.history.length, 1);
  assert.equal(ctx.history[0].no, 1);
  assert.equal(ctx.history[0].tag, 't-new');
});

/* ---------- 静态契约 ---------- */

test('静态契约：handoffSchedSuffix 设 handoffFromIdx，buildSuffixPlan 带 prefixStages', () => {
  assert.match(source, /rc\.handoffFromIdx\s*=\s*i/, 'handoffSchedSuffix 必须记录后缀起点');
  assert.match(source, /prefixStages/, 'buildSuffixPlan 必须携带本地前缀快照');
  assert.match(source, /appendLocalExecBadge/, '阶段详情必须有本地执行徽标');
  assert.match(source, /mergeStageLogsForHistory/, '同 tag 历史必须按阶段名合并');
  assert.match(source, /执行方式/, '阶段详情 KV 必须有执行方式行');
});
