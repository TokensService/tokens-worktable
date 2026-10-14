// test_stage_start_time.js — 阶段「开始时间」回归：
// 每个阶段进入 running 时在节点上打点 startedAt（纪元毫秒），终态/中止/关页重建节点对象时沿用；
// 随在场快照透传（queueNodePresence 白名单已有）、collectRunLogs 落入运行历史 logs 条目，
// 实时详情与历史回放详情都展示「开始时间」行；未开始/跳过（从未启动）的阶段不展示。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function extractFunction(name) {
  const marker = new RegExp(`function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `pipeline.html 缺少函数 ${name}`);
  let start = match.index;
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;   // 保留 async 前缀
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`未闭合的函数 ${name}`);
}

/* ---------- 静态契约 ---------- */

test('静态契约：5 个阶段执行入口（脚本/HTTP/EvalTokens/模拟/预设）进入 running 时打点 startedAt', () => {
  const writes = source.match(/rc\.nodes\[s\.id\]=\{status:'running'[\s\S]*?startedAt:Date\.now\(\)\};/g) || [];
  assert.equal(writes.length, 5, '全部 5 个执行入口都应在 running 节点上打点 startedAt（当前 ' + writes.length + ' 处）');
});

test('静态契约：终态/中止/关页重建节点以 Object.assign 合并旧节点沿用开始时间', () => {
  const merges = source.match(/Object\.assign\(\{\},\s*(rc\.nodes\[s\.id\]|rc\.nodes\[st\.id\]|n|node),\s*\{status:'(success|failed|aborted)'/g) || [];
  // 关页 failed、并行级联 aborted、HTTP 成功/失败/异常、EvalTokens finalNode/异常、脚本成功/失败、预设成功/失败、中止 aborted
  assert.ok(merges.length >= 11, '终态合并旧节点的沿用点不足（当前 ' + merges.length + ' 处）');
});

test('静态契约：实时详情与历史回放详情都渲染「开始时间」行', () => {
  const liveBody = extractFunction('renderDetail');
  assert.ok(liveBody.includes("['开始时间', fmtStageStart("), 'renderDetail（实时）应渲染「开始时间」行');
  assert.ok(liveBody.includes("n.status!=='idle'"), 'renderDetail（实时）未开始阶段不展示开始时间');
  const replayBody = extractFunction('renderReplayDetail');
  assert.ok(replayBody.includes("['开始时间', fmtStageStart("), 'renderReplayDetail（回放）应渲染「开始时间」行');
});

/* ---------- fmtStageStart ---------- */

function fmtCtx() {
  const ctx = { Date, Number, String };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('fmtStageStart'), ctx);
  return ctx;
}

test('fmtStageStart：纪元毫秒 → 紧凑本地「MM-DD HH:MM:SS」', () => {
  const ctx = fmtCtx();
  const ts = new Date(2026, 9, 14, 15, 4, 5).getTime();   // 本地时区 2026-10-14 15:04:05
  assert.equal(ctx.fmtStageStart(ts), '10-14 15:04:05');
  const midnight = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.equal(ctx.fmtStageStart(midnight), '01-02 03:04:05', '月日时分秒均两位补齐');
});

test('fmtStageStart：缺省/非法输入返回空串（调用方据此不展示）', () => {
  const ctx = fmtCtx();
  for (const bad of [undefined, null, 0, -5, NaN, 'abc', Infinity]) {
    assert.equal(ctx.fmtStageStart(bad), '', '输入 ' + String(bad) + ' 应返回空串');
  }
});

/* ---------- Object.assign 合并旧节点：终态沿用 startedAt ---------- */

test('终态合并：Object.assign({}, 旧节点, {终态字段}) 沿用 startedAt，未打点不携带', () => {
  const merged = Object.assign({}, { status: 'running', progress: 40, dur: 2, sub: {}, startedAt: 1760457600000 }, { status: 'success', progress: 100, dur: 12, sub: {} });
  assert.equal(merged.startedAt, 1760457600000, '旧节点已打点则沿用');
  assert.equal(merged.status, 'success');
  const fresh = Object.assign({}, { status: 'running', progress: 0, dur: 0, sub: {} }, { status: 'skipped', progress: 100, dur: 0, sub: {} });
  assert.equal(fresh.startedAt, undefined, '旧节点未打点（跳过路径）不携带');
});

/* ---------- collectRunLogs：开始时间随历史条目落盘 ---------- */

function collectCtx(nodeMap) {
  const ctx = {
    Object, Array, JSON, Number, console,
    archiveFolderFor: () => null,   // 无归档目录 → 走内嵌兜底分支，专注字段契约
    buildLogParts: () => [''],
    stageSeq: () => 1,
    taskLogFile: () => 'run-t-01-x.log',
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('collectRunLogs'), ctx);
  ctx.__nodes = nodeMap;
  return ctx;
}

test('collectRunLogs：节点带 startedAt 时历史条目携带，未打点（跳过/未开始）不携带', () => {
  const ctx = collectCtx({
    a: { status: 'success', progress: 100, dur: 12, sub: {}, startedAt: 1760457600000 },
    b: { status: 'skipped', progress: 100, dur: 0, sub: {} },
    c: { status: 'failed', progress: 100, dur: 3, sub: {}, startedAt: 1760457601000 },
    d: { status: 'running', progress: 40, dur: 1, sub: {}, startedAt: 1760457602000 },   // 运行中不入历史
  });
  const rc = { stages: [{ id: 'a', name: '阶段A' }, { id: 'b', name: '阶段B' }, { id: 'c', name: '阶段C' }, { id: 'd', name: '阶段D' }], nodes: ctx.__nodes, vars: {} };
  const logs = ctx.collectRunLogs(rc, -1);
  assert.equal(logs.length, 3, '运行中阶段不入历史');
  assert.equal(logs[0].startedAt, 1760457600000, '成功阶段携带开始时间');
  assert.equal(logs[1].startedAt, undefined, '跳过（从未启动）阶段无开始时间');
  assert.equal(logs[2].startedAt, 1760457601000, '失败阶段携带开始时间');
});

/* ---------- mergeStageLogsForHistory（页面版）：合并时任一侧的开始时间保留 ---------- */

test('mergeStageLogsForHistory：同名阶段合并保留任一侧 startedAt，新值优先', () => {
  const ctx = { Object, Array, String };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('mergeStageLogsForHistory'), ctx);
  const merged = ctx.mergeStageLogsForHistory(
    [{ stage: '构建', status: 'running', dur: 0, startedAt: 1760457600000 }, { stage: '部署', status: 'success', dur: 5, startedAt: 1760457601000 }],
    [{ stage: '构建', status: 'success', dur: 8 }, { stage: '部署', status: 'success', dur: 6, startedAt: 1760457609000 }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].status, 'success');
  assert.equal(merged[0].startedAt, 1760457600000, '后者缺省时保留前侧 startedAt');
  assert.equal(merged[1].startedAt, 1760457609000, '后者携带时以后者为准');
});

/* ---------- rebuildReplayNodes：回放节点回填 startedAt ---------- */

test('rebuildReplayNodes：历史条目 startedAt 回填回放节点（旧记录无该字段不填）', () => {
  const ctx = {
    Object, Array, Number,
    flowStages: () => [{ id: 's1', name: '构建' }, { id: 's2', name: '部署' }, { id: 's3', name: '健康检查' }],
  };
  vm.createContext(ctx);
  vm.runInContext('let nodes=null; let runStages=[1];\n' + extractFunction('rebuildReplayNodes') + '\nfunction __nodes(){ return nodes; }', ctx);
  ctx.rebuildReplayNodes({ logs: [
    { stage: '构建', status: 'success', dur: 5, startedAt: 1760457600000 },
    { stage: '部署', status: 'failed', dur: 2 },
  ] });
  const nodes = ctx.__nodes();
  assert.equal(nodes.s1.startedAt, 1760457600000, '有记录的阶段回填开始时间');
  assert.equal(nodes.s2.startedAt, undefined, '旧记录无 startedAt 字段不填');
  assert.equal(nodes.s3.startedAt, undefined, '无记录（未开始）阶段不填');
});

/* ---------- applyReplayProfileStages：profile 校正回填 startedAt ---------- */

test('applyReplayProfileStages：profile 携带的 startedAt 回填历史条目（不覆盖已有值）', () => {
  const ctx = { Object, Array, Number };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('applyReplayProfileStages'), ctx);
  const rec = { logs: [
    { stage: '构建', status: 'idle', dur: 0 },
    { stage: '部署', status: 'idle', dur: 0, startedAt: 1760457600000 },
  ] };
  ctx.applyReplayProfileStages(rec, [
    { name: '构建', status: 'success', durSec: 5, startedAt: 1760457610000 },
    { name: '部署', status: 'success', durSec: 6, startedAt: 1760457620000 },
    { name: '测试', status: 'failed', durSec: 1, startedAt: 1760457630000 },   // logs 缺的阶段补进列表
  ]);
  assert.equal(rec.logs[0].status, 'success');
  assert.equal(rec.logs[0].startedAt, 1760457610000, '缺失时回填');
  assert.equal(rec.logs[1].startedAt, 1760457600000, '已有值不被覆盖');
  assert.equal(rec.logs[2].stage, '测试');
  assert.equal(rec.logs[2].startedAt, 1760457630000, '补进列表的阶段携带开始时间');
});

/* ---------- remoteFinishedPreviewRc：终态摘要的 startedAt 补进预览节点 ---------- */

test('remoteFinishedPreviewRc：终态条目携带 startedAt 时预览节点补开始时间', () => {
  const ctx = { Object, Array, String, Number };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('remoteFinishedPreviewRc'), ctx);
  const prev = {
    stages: [{ id: 's1', name: '构建' }],
    nodes: { s1: { status: 'running', progress: 60, dur: 0, sub: {} } },
  };
  const next = ctx.remoteFinishedPreviewRc(prev, { id: 'r1', status: 'success', endedAt: 1760457700000, stages: [{ stage: '构建', status: 'success', dur: 8, startedAt: 1760457692000 }] });
  assert.equal(next.nodes.s1.status, 'success');
  assert.equal(next.nodes.s1.dur, 8);
  assert.equal(next.nodes.s1.startedAt, 1760457692000, '终态摘要的开始时间补进预览节点');
});
