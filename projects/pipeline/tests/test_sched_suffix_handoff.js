/* 定时分界移交（混合编排：需本地运行前缀 + 定时后缀）回归测试。
   原设计：手动运行时「需本地运行」阶段在浏览器立即跑完，到达首个定时阶段（分界）时把后缀整体登记为
   「立即执行一次」的服务端计划（归档上下文/变量快照随计划移交），弹窗告知；登记失败弹窗告知未执行、
   分界阶段标 failed 可从失败阶段重试，后缀不得静默丢失也不得改在本地执行。
   沙盒函数提取方式同 test_parallel_stage_execution.js。 */
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
const flush = async () => { for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r)); };

function handoffContext(stages, options) {
  options = options || {};
  const started = [];
  const alerts = [];
  const archived = [];
  const overalls = [];
  const fetches = [];
  let putBody = null;
  const stopButton = { disabled: false };
  const context = {
    console, Promise, Object, Array, JSON, URL, Date, Error, setImmediate,
    setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
    taskPromFinalize() {},
    alert(msg) { alerts.push(String(msg)); },
    serverPlans: [],
    renderPlanList() {},
    startStageAt(child, index) {   // 本地阶段即刻完成（调度行为不在本测试范围）
      const stage = child.stages[index];
      started.push(stage.id);
      child.nodes[stage.id] = { status: 'success', progress: 100, dur: 0.1, sub: {}, varsIn: Object.assign({}, child.vars), varsOut: {} };
      context.advance(child, index + 1);
    },
    runSetSel(child, id) { child.selId = id; },
    rcRender() {},
    activeRuns: [],
    syncRunState() {},
    $() { return stopButton; },
    viewActive() { return false; },
    refreshArchiveTip() {},
    rcOverall(child, txt, cls) { overalls.push({ child, txt, cls }); },
    buildNo: 0,
    history: [],
    curPipeline() { return { name: 'handoff-test' }; },
    fmtDur(v) { return String(v); },
    nowHM() { return '12:00'; },
    promSnapshotForRun() { return null; },
    collectRunLogs() { return []; },
    histPage: 0,
    selHistoryIdx: 0,
    renderHistory() {},
    renderStats() {},
    persistState() {},
    archiveRun(_rc, result) { archived.push(result); },
    renderDetail() {},
    drainQueue() {},
    renderQueue() {},
    archiveFolderFor() { return ''; },
    viewRc: null,
    selectedId: null,
    fetch: async (url, init) => {
      fetches.push({ url: String(url), method: (init && init.method) || 'GET' });
      if (String(url).endsWith('/api/worktable/pipeline/plans') && init && init.method === 'PUT') {
        putBody = JSON.parse(init.body);
        if (options.putFails) return { ok: false, status: 500 };
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ plans: [] }) };
    },
  };
  vm.createContext(context);
  installFunctions(context, [
    'pipelineStageGroups',
    'stageSeq',
    'registerStageTimers',
    'handoffSchedSuffix',
    'advance',
    'finish',
  ]);
  const rc = {
    id: 'rc-handoff', stages, nodes: {}, selId: null, timer: null, scriptAbort: null,
    over: false, token: 'tk', vars: { A: '1' }, parallelGroup: null,
    startTs: Date.now(), pipelineName: 'handoff-test', env: 'test', commit: '1234567890',
    by: 'tester', pipelineId: 'pl-test', repoId: null, branch: 'main', strategy: '',
    tag: 't1', archive: '/arc/pl_x', leaseId: null, leaseIps: [],
  };
  context.activeRuns = [rc];
  context.viewRc = rc;
  return { context, rc, started, alerts, archived, overalls, fetches, putBody: () => putBody };
}

test('混合编排：本地前缀跑完即在定时分界移交服务端（计划带归档上下文与变量快照）并弹窗告知', async () => {
  const stages = [
    { id: 'a', name: '本地A', kind: 'simulate', sched: null },
    { id: 'b', name: '定时B', kind: 'simulate', sched: {} },
    { id: 'c', name: '定时C', kind: 'simulate', sched: {} },
  ];
  const h = handoffContext(stages);
  h.context.advance(h.rc, 0);
  await flush();
  assert.deepEqual(h.started, ['a'], '只有本地前缀在浏览器执行，定时阶段不得在本地落地');
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /2 个定时阶段已移交服务端立即执行/);
  const plans = h.putBody() && h.putBody().plans;
  assert.ok(plans && plans.length === 1, '后缀应登记为一条服务端计划');
  const plan = plans[0];
  assert.deepEqual(plan.stages.map(s => s.id), ['b', 'c']);
  assert.equal(plan.stages[0].sched, undefined, '计划阶段不带 sched 标记');
  assert.equal(plan.kind, 'once');
  assert.equal(plan.archive, '/arc/pl_x', '归档文件夹随计划移交（服务端写入同一文件夹）');
  assert.equal(plan.tag, 't1');
  assert.equal(plan.baseSeq, 1, 'baseSeq=分界前正式阶段数（预设不占序号）');
  assert.equal(plan.vars.A, '1', '上游变量快照随计划注入后缀');
  assert.match(plan.by, /⏰/);
  assert.equal(h.rc.nodes.b.status, 'skipped', '后缀阶段标记为移交服务端（skipped 渲染）');
  assert.equal(h.rc.nodes.c.status, 'skipped');
  assert.equal(h.rc.over, true);
  assert.deepEqual(h.archived, ['success']);
  assert.equal(h.context.history[0].status, 'success');
  assert.match(h.overalls[h.overalls.length - 1].txt, /已移交服务端/);
});

test('登记失败：弹窗告知后缀未执行、分界阶段标 failed（可从失败阶段重试），运行按失败收尾', async () => {
  const stages = [
    { id: 'a', name: '本地A', kind: 'simulate', sched: null },
    { id: 'b', name: '定时B', kind: 'simulate', sched: {} },
    { id: 'c', name: '定时C', kind: 'simulate', sched: {} },
  ];
  const h = handoffContext(stages, { putFails: true });
  h.context.advance(h.rc, 0);
  await flush();
  assert.deepEqual(h.started, ['a']);
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /2 个阶段未执行/);
  assert.equal(h.rc.nodes.b.status, 'failed', '分界阶段标 failed 供「从本阶段重试」');
  assert.equal(h.rc.nodes.c.status, 'skipped');
  assert.equal(h.rc.over, true);
  assert.deepEqual(h.archived, ['failed']);
  assert.equal(h.context.history[0].status, 'failed');
});

test('纯本地编排（无定时阶段）：不登记计划、不弹窗，整次本地跑完', async () => {
  const stages = [
    { id: 'a', name: '本地A', kind: 'simulate', sched: null },
    { id: 'b', name: '本地B', kind: 'simulate', sched: null },
  ];
  const h = handoffContext(stages);
  h.context.advance(h.rc, 0);
  await flush();
  assert.deepEqual(h.started, ['a', 'b']);
  assert.equal(h.alerts.length, 0);
  assert.equal(h.fetches.filter(f => f.url.endsWith('/api/worktable/pipeline/plans')).length, 0, '无定时分界不得触碰计划接口');
  assert.equal(h.rc.over, true);
  assert.deepEqual(h.archived, ['success']);
  assert.equal(h.rc.nodes.a.status, 'success');
  assert.equal(h.rc.nodes.b.status, 'success');
});
