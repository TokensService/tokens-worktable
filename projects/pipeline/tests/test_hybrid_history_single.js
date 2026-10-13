/* 混合编排历史合并为一条（本地执行 / 非本地执行同 tag 一条记录）回归测试。
   背景：含「需本地运行」前缀 + 定时后缀的混合编排，曾短暂拆成「本地记录 + tag+'-srv' 后缀记录」
   两条（PR #150）；现改回单条：后缀计划不再携带 histMode，服务端 execPlan 写同 tag 记录
   （appendPipelineHistory 同 tag 合并、保留页面首条记录身份），页面 finish 后由
   markHistorySuffixRunning 把记录保持「进行中」待服务端后缀落终态；分界移交成功的 alert 弹窗
   改为 toast 轻提示（不打断操作）。本文件覆盖页面侧契约；服务端写入与清扫见
   ../../tests/pipeline-history-merge-sweep.test.mjs。 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function functionSource(name) {
  let start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '缺少函数 ' + name);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
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

test('buildSuffixPlan：后缀计划不再携带 histMode（激活与休眠预登记一致），同 tag 合并为一条', () => {
  const ctx = load({
    console, Date, JSON, Object, Array,
    runRepositorySnapshot: () => null,
    runSettingsSnapshot: () => null,
    stageSeq: (stg, i) => { let n = 0; for (let j = 0; j <= i && j < stg.length; j++) { if (stg[j] && !stg[j].preset) n++; } return n; },
  }, ['buildSuffixPlan']);
  const rc = {
    pipelineId: 'pl-1', pipelineName: 'test', env: '', envs: [], image: '', repoId: null,
    branch: 'main', strategy: '', by: 'lihaifeng', tag: 'T1', archive: '/arc/test_x',
    stages: [
      { id: 'a', name: '检出', sched: null },
      { id: 'b', name: '校验', sched: {} },
      { id: 'c', name: '构建', sched: {} },
    ],
    nodes: { a: { status: 'success', dur: 6 } },
    vars: { K: 'V' },
  };
  const active = ctx.buildSuffixPlan(rc, 1);
  assert.equal('histMode' in active, false, '后缀计划不再携带 histMode 拆分标记，服务端写同 tag 记录');
  assert.equal(active.at > 0, true);
  assert.equal(active.tag, 'T1', '计划 tag 与本地运行同 tag（合并锚点）');
  assert.deepEqual(JSON.parse(JSON.stringify(active.prefixStages.map(p => p.name))), ['检出'], '本地前缀快照随计划携带（服务端补齐完整阶段）');
  const dormant = ctx.buildSuffixPlan(rc, 1, { activate: false });
  assert.equal('histMode' in dormant, false, '休眠预登记同样不带 histMode');
  assert.equal(dormant.at, 0);
});

test('finish：本地记录按 tag 原地落定终态、只承载本地阶段（后缀阶段由服务端同 tag 合并补齐）', () => {
  const calls = { persist: 0 };
  const ctx = load({
    console, Date, JSON, Object, Array,
    activeRuns: [], viewRc: null, history: [], histPage: 0, selHistoryIdx: -1, buildNo: 0,
    curPipeline: () => ({ name: 'test' }),
    nowHM: () => '10:00',
    fmtDur: s => String(s),
    promSnapshotForRun: () => null,
    archiveFolderFor: () => '/arc/test_x',
    historyEnvNodesOf: () => [],
    renderHistory: () => {}, renderStats: () => {}, persistState: () => { calls.persist++; },
    refreshArchiveTip: () => {}, rcOverall: () => {}, archiveRun: () => {}, renderDetail: () => {},
    drainQueue: () => {}, renderQueue: () => {}, syncRunState: () => {}, taskPromFinalize: () => {},
    releaseNodeLease: () => {}, clearInterval: () => {},
    $: () => ({ disabled: false }), viewActive: () => false,
    // 真实日志收集：验证 handoffFromIdx 后后缀阶段不进本地记录
    buildLogParts: () => [],
    taskLogFile: (rc, seq, name) => 'run-' + rc.tag + '-' + String(seq).padStart(2, '0') + '-' + name + '.log',
    stageSeq: (stg, i) => { let n = 0; for (let j = 0; j <= i && j < stg.length; j++) { if (stg[j] && !stg[j].preset) n++; } return n; },
  }, ['mergeStageLogsForHistory', 'collectRunLogs', 'finish']);
  const rc = {
    id: 'r1', stages: [
      { id: 'a', name: '检出', sched: null },
      { id: 'b', name: '校验', sched: {} },
    ],
    nodes: {
      a: { status: 'success', progress: 100, dur: 6, sub: {} },
      b: { status: 'skipped', progress: 100, dur: 0, sub: {} },   // 分界移交标记
    },
    handoffFromIdx: 1,   // 后缀起点：collectRunLogs 不写本地占位
    over: false, timer: null, leaseTimer: null, leaseId: null, leaseIps: [],
    pipelineName: 'test', env: '', commit: '1234567890', tag: 'T1', startTs: Date.now() - 6000,
    by: 'lihaifeng', pipelineId: 'pl-1', repoId: null, branch: 'main', strategy: '',
  };
  ctx.activeRuns = [rc];
  ctx.finish(rc, 'success');
  assert.equal(ctx.history.length, 1);
  const rec = ctx.history[0];
  assert.equal(rec.tag, 'T1');
  assert.equal(rec.status, 'success', 'finish 先落本地成功（移交场景随后由 markHistorySuffixRunning 保持「进行中」）');
  assert.equal(rec.source, 'local', '本地记录来源保持 local');
  assert.equal(rec.pipeline, 'test', '本地记录名称保持流水线原名，不带「· 定时后缀」尾巴');
  assert.equal(rec.by, 'lihaifeng');
  assert.deepEqual(JSON.parse(JSON.stringify(rec.logs.map(l => l.stage))), ['检出'], '本地记录只含本地阶段；后缀阶段由服务端同 tag 合并补齐');
  assert.equal(rec.logs[0].local, true, '本地执行阶段带 local:true 标识');
});

test('handoffSchedSuffix：移交成功 toast 轻提示（不再 alert 弹窗），历史记录保持「进行中」', async () => {
  const calls = { toast: [], alert: [], persist: 0, finish: [] };
  const rec = { no: 3, tag: 'T1', pipeline: 'test', status: 'running', by: 'lihaifeng', logs: [] };
  const ctx = load({
    console, Date, JSON, Object, Array, Promise,
    history: [rec],
    rcRender: () => {},
    registerStageTimers: async () => true,
    finish: (rc, result) => { calls.finish.push(result); rec.status = 'success'; },   // 本地前缀按成功落定
    rcOverall: () => {},
    renderHistory: () => {}, renderStats: () => {}, persistState: () => { calls.persist++; },
    toast: m => calls.toast.push(m),
    alert: m => calls.alert.push(m),
  }, ['markHistorySuffixRunning', 'handoffSchedSuffix']);
  const rc = {
    stages: [
      { id: 'a', name: '检出', sched: null },
      { id: 'b', name: '校验', sched: {} },
      { id: 'c', name: '构建', sched: {} },
    ],
    nodes: {}, vars: { K: 'V' }, over: false, tag: 'T1', suffixPlanHeld: true,
  };
  await ctx.handoffSchedSuffix(rc, 1);
  assert.equal(calls.alert.length, 0, '移交成功不再弹 alert 确认框');
  assert.equal(calls.toast.length, 1, '改为 toast 轻提示');
  assert.ok(calls.toast[0].includes('2 个定时阶段'), '提示后缀阶段数：' + calls.toast[0]);
  assert.deepEqual(calls.finish, ['success']);
  assert.equal(rc.suffixPlanHeld, false, '已激活：休眠计划不再清理');
  assert.equal(rec.status, 'running', '历史记录保持「进行中」待服务端后缀落终态（单条记录状态真实）');
  assert.ok(calls.persist >= 1, '翻转状态后持久化上送');
  assert.equal(rc.nodes.b.status, 'skipped', '后缀阶段编排区标记移交（skipped）');
  assert.equal(rc.handoffFromIdx, 1);
});

test('handoffSchedSuffix：移交失败仍 alert 弹窗告警并按失败收尾，历史不落「进行中」', async () => {
  const calls = { toast: [], alert: [], finish: [] };
  const rec = { no: 3, tag: 'T2', pipeline: 'test', status: 'running', logs: [] };
  const ctx = load({
    console, Date, JSON, Object, Array, Promise,
    history: [rec],
    rcRender: () => {},
    registerStageTimers: async () => false,
    finish: (rc, result) => { calls.finish.push(result); rec.status = result === 'success' ? 'success' : 'failed'; },
    rcOverall: () => {},
    renderHistory: () => {}, renderStats: () => {}, persistState: () => {},
    toast: m => calls.toast.push(m),
    alert: m => calls.alert.push(m),
  }, ['markHistorySuffixRunning', 'handoffSchedSuffix']);
  const rc = {
    stages: [ { id: 'a', name: '检出', sched: null }, { id: 'b', name: '校验', sched: {} } ],
    nodes: {}, vars: {}, over: false, tag: 'T2',
  };
  await ctx.handoffSchedSuffix(rc, 1);
  assert.equal(calls.toast.length, 0);
  assert.equal(calls.alert.length, 1, '移交失败是可操作错误，保留 alert');
  assert.deepEqual(calls.finish, ['failed']);
  assert.equal(rec.status, 'failed', '按失败落终态，不留「进行中」');
  assert.equal(rc.nodes.b.status, 'failed', '分界阶段标 failed（可从失败阶段重试）');
});

test('applyHistoryRefreshPayload：本地「进行中」记录不压服务端同 tag 进度，服务端终态收敛', () => {
  const ctx = load({
    console, Date, JSON, Object, Array, Map,
    history: [], histClearedAt: 0, buildNo: 10, activeRuns: [],
  }, ['historyPersistSig', 'historyForPersist', 'historyMarkSynced', 'applyHistoryRefreshPayload']);
  // 本页移交后保持「进行中」的本地记录（只含本地前缀阶段）
  ctx.history = [
    { no: 10, tag: 'T1', pipeline: 'test', status: 'running', source: 'local', by: 'lihaifeng', dur: '6s', ts: 5000, logs: [{ stage: '检出', status: 'success', local: true }] },
  ];
  // 服务端快照：同 tag 一条记录（前缀 + 后缀执行中），单条不再拆 tag+'-srv'
  const remote = {
    config: { buildNo: 10, histClearedAt: 0 },
    history: [
      { no: 10, tag: 'T1', pipeline: 'test', status: 'running', source: 'local', by: 'lihaifeng', dur: '8s', ts: 6000,
        logs: [{ stage: '检出', status: 'success', local: true }, { stage: '校验', status: 'success', dur: 2 }] },
    ],
  };
  const applied = ctx.applyHistoryRefreshPayload(remote, 0);
  assert.equal(applied, true);
  assert.equal(ctx.history.length, 1, '同 tag 只有一条记录');
  const rec = ctx.history[0];
  assert.equal(rec.ts, 6000, '本地 running 不压远端：直接采用服务端记录');
  assert.deepEqual(rec.logs.map(l => l.stage), ['检出', '校验'], '后缀阶段并入同一条记录');
  // 服务端落终态后刷新收敛
  const applied2 = ctx.applyHistoryRefreshPayload({
    config: { buildNo: 10, histClearedAt: 0 },
    history: [Object.assign({}, rec, { status: 'success', dur: '12s', ts: 9000 })],
  }, 0);
  assert.equal(applied2, true);
  assert.equal(ctx.history.length, 1);
  assert.equal(ctx.history[0].status, 'success', '服务端终态覆盖「进行中」，单条记录收敛');
});

test('静态契约：无 histMode 拆分标记；移交成功走 toast 且历史保持「进行中」', () => {
  const plan = functionSource('buildSuffixPlan');
  assert.ok(!/histMode/.test(plan), 'buildSuffixPlan 不再携带 histMode 拆分标记');
  assert.ok(!source.includes("tag+'-srv'"), '不再写 tag+\'-srv\' 独立记录');
  assert.ok(/function markHistorySuffixRunning\(/.test(source), '移交后保持「进行中」的辅助函数存在');
  assert.ok(/markHistorySuffixRunning\(rc\)/.test(source), 'handoffSchedSuffix 成功路径调用 markHistorySuffixRunning');
  const handoff = functionSource('handoffSchedSuffix');
  assert.ok(handoff.includes('toast('), '移交成功改 toast 轻提示');
  assert.ok(!/alert\('本地阶段已完成/.test(handoff), '移交成功的 alert 确认弹窗已移除');
});
