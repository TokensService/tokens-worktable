/* 混合编排历史拆分（本地执行 / 非本地执行各是一条记录）回归测试。
   背景：含「需本地运行」前缀 + 定时后缀的混合编排，此前服务端后缀经同 tag 合并进本地记录——
   本地与非本地任务一直挤在一条运行历史里，且记录身份（名称/执行人/来源/耗时）被后缀覆盖；
   本地完成、服务端未完成时单条记录的状态也不可能真实。现后缀计划带 histMode:'split'，
   服务端 execPlan 改写 tag+'-srv' 独立记录（启动即「进行中」、逐阶段刷新、结束落终态），
   页面本地记录只承载本地部分、不再被覆盖。本文件覆盖页面侧契约；服务端写入与清扫见
   ../../tests/pipeline-history-split-sweep.test.mjs。 */
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

test('buildSuffixPlan：后缀计划携带 histMode:\'split\'（激活与休眠预登记一致）', () => {
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
  assert.equal(active.histMode, 'split', '激活计划带 histMode:split，服务端据此写独立后缀记录');
  assert.equal(active.at > 0, true);
  assert.equal(active.tag, 'T1');
  const dormant = ctx.buildSuffixPlan(rc, 1, { activate: false });
  assert.equal(dormant.histMode, 'split', '休眠预登记同样带 histMode:split（激活时同 id 覆盖不丢标记）');
  assert.equal(dormant.at, 0);
});

test('finish：本地记录按 tag 原地落定终态、只承载本地阶段（后缀阶段由服务端独立记录承载）', () => {
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
  assert.equal(rec.status, 'success');
  assert.equal(rec.source, 'local', '本地记录来源保持 local，不再被服务端后缀覆盖成 schedule-suffix');
  assert.equal(rec.pipeline, 'test', '本地记录名称保持流水线原名，不带「· 定时后缀」尾巴');
  assert.equal(rec.by, 'lihaifeng');
  assert.deepEqual(JSON.parse(JSON.stringify(rec.logs.map(l => l.stage))), ['检出'], '本地记录只含本地阶段；后缀阶段由服务端 tag+\'-srv\' 记录承载');
  assert.equal(rec.logs[0].local, true, '本地执行阶段带 local:true 标识');
});

test('applyHistoryRefreshPayload：服务端拆分后缀记录（tag+\'-srv\'）并入列表，本地记录不被覆盖', () => {
  const ctx = load({
    console, Date, JSON, Object, Array, Map,
    history: [], histClearedAt: 0, buildNo: 10, activeRuns: [],
  }, ['historyPersistSig', 'historyForPersist', 'historyMarkSynced', 'applyHistoryRefreshPayload']);
  // 本页本地前缀已落定终态
  ctx.history = [
    { no: 10, tag: 'T1', pipeline: 'test', status: 'success', source: 'local', by: 'lihaifeng', dur: '6s', ts: 5000, logs: [{ stage: '检出', status: 'success', local: true }] },
  ];
  // 服务端快照：本地记录（同内容）+ 正在执行的后缀记录
  const remote = {
    config: { buildNo: 11, histClearedAt: 0 },
    history: [
      { no: 11, tag: 'T1-srv', pipeline: 'test · 定时后缀', status: 'running', source: 'schedule-suffix', by: 'lihaifeng ⏰', dur: '0s', ts: 6000, logs: [{ stage: '检出', status: 'success', local: true }] },
      { no: 10, tag: 'T1', pipeline: 'test', status: 'success', source: 'local', by: 'lihaifeng', dur: '6s', ts: 5000, logs: [{ stage: '检出', status: 'success', local: true }] },
    ],
  };
  const applied = ctx.applyHistoryRefreshPayload(remote, 0);
  assert.equal(applied, true);
  assert.equal(ctx.history.length, 2, '拆分后缀记录并入历史列表');
  const local = ctx.history.find(h => h.tag === 'T1');
  const srv = ctx.history.find(h => h.tag === 'T1-srv');
  assert.equal(local.status, 'success');
  assert.equal(local.pipeline, 'test', '本地记录身份不被后缀记录覆盖');
  assert.equal(srv.status, 'running', '后缀执行期间显示「进行中」（本地完成、非本地未完成时状态真实）');
  assert.equal(srv.pipeline, 'test · 定时后缀');
});

test('静态契约：buildSuffixPlan 写 histMode:split；finish/collectRunLogs 注释按拆分口径', () => {
  assert.ok(/histMode:'split'/.test(source), 'buildSuffixPlan 必须给后缀计划带 histMode:\'split\'');
  assert.ok(source.includes("tag+'-srv'"), '注释口径：服务端后缀写 tag+\'-srv\' 独立记录');
  assert.ok(!source.includes('同 tag 合并补齐真实状态'), ' collectRunLogs 旧「同 tag 合并」注释已更新');
});
