/* 浏览器关闭时本地运行「关页即失败」+ 排队条目移交服务端 —— 回归测试。
   场景：手动运行含「需本地运行」阶段的流水线（runPipeline 分流到 startSimRun），中途关闭浏览器。
   当前行为：pagehide 把在跑运行按失败落史（keepalive POST /api/worktable/pipeline/history/fail-run，
   当前在跑任务标记 failed、后续未开始阶段 skipped、中断原因 closeError 随记录落史，运行历史立即
   体现「错误」）；排队中的本地队列条目（尚未开始执行）仍登记为「立即执行一次」的服务端计划移交。
   未送达时由在场 TTL 孤儿登记 + 「进行中」历史清扫判死兜底。
   沙盒函数提取方式同 test_sched_suffix_handoff.js。 */
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

function makeContext(options) {
  options = options || {};
  const fetches = [];
  const alerts = [];
  const beacons = [];
  const finishedNotes = [];
  const context = {
    console, Promise, Object, Array, JSON, URL, Date, Error, setImmediate, Math,
    setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
    alert(msg) { alerts.push(String(msg)); },
    serverPlans: [],
    renderPlanList() {},
    activeRuns: options.activeRuns || [],
    queue: options.queue || [],
    pendingLeaseStarts: options.pendingLeaseStarts || [],
    queueFinishedNote(id) { finishedNotes.push(String(id)); },
    /* buildCloseFailRecord 的周边函数桩：无归档目录（archiveFolderFor=null → 内联日志路径） */
    archiveFolderFor() { return null; },
    navigator: {
      sendBeacon(url, body) {
        beacons.push({ url: String(url), text: String(body) });
        return true;
      },
    },
    fetch: async (url, init) => {
      const entry = { url: String(url), method: (init && init.method) || 'GET', keepalive: !!(init && init.keepalive), body: null };
      if (init && init.body) {
        try { entry.body = JSON.parse(String(init.body)); } catch { entry.body = String(init.body); }
      }
      fetches.push(entry);
      if (options.fetchFail) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ plans: options.existingPlans || [] }) };
    },
  };
  vm.createContext(context);
  /* CLOSE_FAIL_TEXT 常量与函数一并进沙盒 */
  const constMatch = /const CLOSE_FAIL_TEXT=[^;]+;/.exec(source);
  assert.ok(constMatch, 'pipeline.html 缺少 CLOSE_FAIL_TEXT 常量');
  vm.runInContext(constMatch[0], context);
  installFunctions(context, [
    'stageSeq',
    'runRepositorySnapshot',
    'buildSuffixPlan',
    'upsertServerPlan',
    'registerStageTimers',
    'buildUnloadHandoffPlan',
    'currentStageIndex',
    'collectRunLogs',
    'historyEnvNodesOf',
    'buildCloseFailRecord',
    'handoffRunsOnPageHide',
  ]);
  return { context, fetches, alerts, beacons, finishedNotes };
}

function runningRc(overrides) {
  const stages = (overrides && overrides.stages) || [
    { id: 'a', name: '本地A', kind: 'simulate', sched: null },
    { id: 'b', name: '本地B', kind: 'simulate', sched: null },
    { id: 'c', name: '定时C', kind: 'simulate', sched: {} },
  ];
  const nodes = {};
  stages.forEach(s => { nodes[s.id] = { status: 'idle', progress: 0, dur: 0, sub: {} }; });
  return Object.assign({
    id: 'r1', stages, nodes, selId: stages[0].id, timer: null, scriptAbort: null, over: false, token: 'tk',
    vars: { A: '1' }, startTs: Date.now(), pipelineName: 'p', pipelineId: 'pl-1',
    env: '10.0.0.1', envs: [{ id: 'e1', ip: '10.0.0.1' }], image: 'img',
    commit: 'abcdef1', tag: 't1', by: 'tester', repoId: 'repo-1', repoName: 'demo-repo',
    repoUrl: 'https://git.example.com/dev/demo.git', repoUser: 'u1', repoPass: 'p1',
    branch: 'main', strategy: '3P1D',
    archive: '/arc/pl_p', leaseId: 'L1', leaseIps: ['10.0.0.1'], parallelParent: null,
  }, overrides && overrides.rc);
}

function failPosts(h) {
  return h.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/api/worktable/pipeline/history/fail-run'));
}
function planPosts(h) {
  return h.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/api/worktable/pipeline/plans'));
}

test('pagehide 关页即失败：在跑运行按 failed 落史（keepalive fail-run），不再登记服务端移交计划', async () => {
  const rc = runningRc();
  rc.nodes.a.status = 'success'; rc.nodes.a.progress = 100;
  rc.nodes.b.status = 'running'; rc.nodes.b.progress = 40; rc.nodes.b.dur = 12;
  const h = makeContext({ activeRuns: [rc] });
  h.context.handoffRunsOnPageHide();
  await flush();
  assert.equal(planPosts(h).length, 0, '在跑运行不再移交服务端续跑');
  const posts = failPosts(h);
  assert.equal(posts.length, 1, '应向 fail-run 路由 POST 一次');
  assert.equal(posts[0].keepalive, true, 'unload 期间请求必须 keepalive 才能送达');
  const records = posts[0].body && posts[0].body.records;
  assert.ok(Array.isArray(records) && records.length === 1, 'POST 体应携带 {records:[...]}');
  const rec = records[0];
  assert.equal(rec.status, 'failed', '终态为失败');
  assert.equal(rec.tag, 't1');
  assert.equal(rec.pipeline, 'p');
  assert.equal(rec.by, 'tester', '执行人保持原样（不加 ⏰、不改写身份）');
  assert.equal(rec.source, 'local');
  assert.ok(rec.closeError && /浏览器页面已关闭/.test(rec.closeError), '中断原因随记录落史');
  const byStage = {};
  (rec.logs || []).forEach(l => { byStage[l.stage] = l; });
  assert.equal(byStage['本地A'] && byStage['本地A'].status, 'success', '已完成阶段保留真实状态');
  assert.equal(byStage['本地B'] && byStage['本地B'].status, 'failed', '当前在跑阶段标记失败');
  assert.equal(byStage['本地B'] && byStage['本地B'].dur, 12, '失败阶段保留已跑耗时');
  assert.ok(/浏览器页面已关闭/.test(byStage['本地B'].log || ''), '无归档文件时中断原因内联进失败阶段日志');
  assert.equal(byStage['定时C'] && byStage['定时C'].status, 'skipped', '未开始阶段标记跳过（未执行）');
});

test('pagehide 关页即失败：含「需本地运行」HTTP 阶段同样直接失败落史（不移交服务端报错重跑）', async () => {
  const rc = runningRc({
    stages: [
      { id: 'a', name: '本地A', kind: 'simulate', sched: null },
      { id: 'b', name: '本地HTTP', kind: 'http', sched: null, url: { url: 'http://intranet/job/x' } },
      { id: 'c', name: '定时C', kind: 'simulate', sched: {} },
    ],
  });
  rc.nodes.a.status = 'running';
  const h = makeContext({ activeRuns: [rc] });
  h.context.handoffRunsOnPageHide();
  await flush();
  assert.equal(planPosts(h).length, 0);
  const rec = failPosts(h)[0].body.records[0];
  const statuses = (rec.logs || []).map(l => l.stage + ':' + l.status);
  assert.deepEqual(statuses, ['本地A:failed', '本地HTTP:skipped', '定时C:skipped'],
    '当前阶段 failed，其余未开始阶段 skipped，全部随记录落史');
});

test('pagehide：已结束/并行子上下文不落史不移交；本地队列条目仍登记为 once 计划移交服务端', async () => {
  const doneRc = runningRc(); doneRc.over = true;
  const parallelChild = runningRc(); parallelChild.parallelParent = runningRc();
  const queued = {
    id: 'q1', pipelineId: 'pl-q', pipelineName: '排队流水线', stages: [
      { id: 'x', name: '排队X', kind: 'simulate', sched: null },
      { id: 'y', name: '排队Y', kind: 'simulate', sched: {} },
    ],
    env: '10.0.0.2', envs: [{ id: 'e2', ip: '10.0.0.2' }], image: 'img', repoId: 'r', branch: 'dev', strategy: 'P-D',
    by: 'tester', presets: [], queuedAt: 1, source: 'manual',
  };
  const h = makeContext({ activeRuns: [doneRc, parallelChild], queue: [queued] });
  h.context.handoffRunsOnPageHide();
  await flush();
  assert.equal(failPosts(h).length, 0, '已结束与并行子上下文不产生失败落史');
  const posts = planPosts(h);
  assert.equal(posts.length, 1, '只登记队列条目的移交计划');
  const plan = posts[0].body.plan;
  assert.equal(plan.id, 'unload-q1');
  assert.equal(plan.pipelineId, 'pl-q');
  assert.deepEqual(plan.stages.map(s => s.id), ['x', 'y']);
  assert.equal(plan.repoId, 'r');
  assert.equal(plan.repository, null, '队列条目无 url 快照时只留 repoId，由服务端按配置补齐');
  assert.equal(plan.strategy, 'P-D', '队列条目的部署策略也要随计划移交');
  assert.deepEqual(plan.presets && [...plan.presets], [], '队列条目移交显式携带空 presets，不触发服务端清理回退');
  assert.match(plan.desc, /浏览器关闭/);
});

test('pagehide：租约申请在途的排队项也移交；无剩余阶段的在跑运行只了结不落史', async () => {
  const empty = runningRc();
  empty.nodes.a.status = 'success'; empty.nodes.b.status = 'success'; empty.nodes.c.status = 'success';
  const pendingItem = {
    id: 'q2', pipelineId: 'pl-p2', pipelineName: '租约中', stages: [{ id: 'z', name: 'Z', kind: 'simulate', sched: null }],
    env: '', envs: [], image: 'img', repoId: null, branch: 'main', strategy: '', by: 'tester', queuedAt: 1,
  };
  const h = makeContext({
    activeRuns: [empty],
    pendingLeaseStarts: [{ envs: [], queueItem: pendingItem }],
  });
  h.context.handoffRunsOnPageHide();
  await flush();
  assert.equal(failPosts(h).length, 0, '无剩余阶段（本地已跑完）不是失败');
  const posts = planPosts(h);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.plan.id, 'unload-q2');
  assert.deepEqual(posts[0].body.plan.stages.map(s => s.id), ['z']);
});

test('currentStageIndex：优先 running，否则首个未终态；全部终态返回 -1', () => {
  const h = makeContext({});
  const rc = runningRc();
  assert.equal(h.context.currentStageIndex(rc), 0);
  rc.nodes.a.status = 'success';
  rc.nodes.b.status = 'running';
  assert.equal(h.context.currentStageIndex(rc), 1);
  rc.nodes.b.status = 'failed';
  assert.equal(h.context.currentStageIndex(rc), 2, '失败后指向下一未终态');
  rc.nodes.c.status = 'skipped';
  assert.equal(h.context.currentStageIndex(rc), -1);
  assert.equal(h.context.currentStageIndex(null), -1);
});

test('buildUnloadHandoffPlan（队列条目）：跳过预设任务、剥 sched 标记、携带代码仓与策略快照', () => {
  const h = makeContext({});
  const item = {
    id: 'q7', pipelineId: 'pl-q', pipelineName: '排队流水线', stages: [
      { id: 'p', name: '清理', preset: true, pkey: 'cleanup', sched: {} },
      { id: 'x', name: '排队X', kind: 'simulate', sched: null },
    ],
    env: '10.0.0.2', envs: [{ id: 'e2', ip: '10.0.0.2' }], image: 'img', branch: 'dev', strategy: 'P-D',
    by: 'tester', repoId: 'repo-1', repoName: 'demo-repo',
    repoUrl: 'https://git.example.com/dev/demo.git', repoUser: 'u1', repoPass: 'p1',
  };
  const plan = JSON.parse(JSON.stringify(h.context.buildUnloadHandoffPlan(item)));   // 直接调 vm 域函数：JSON 往返归一到宿主域再比较
  assert.equal(plan.stages.map(s => s.id).join(','), 'x', '预设任务是页面运行期概念，不进服务端计划');
  assert.equal(plan.stages[0].sched, undefined, '计划阶段去掉 sched 标记');
  assert.deepEqual(plan.presets && [...plan.presets], [], '显式空 presets：服务端按 API 语义不执行任何预设任务');
  assert.deepEqual(plan.repository, {
    id: 'repo-1', name: 'demo-repo',
    url: 'https://git.example.com/dev/demo.git', user: 'u1', pass: 'p1',
  }, '代码仓快照随计划移交，否则 GIT_* 不注入、git 类脚本卡在凭据提示');
  assert.equal(plan.strategy, 'P-D');
  assert.equal(plan.tag, null, '排队条目无运行 tag：服务端执行时自建历史记录');
});

test('buildSuffixPlan 只收 sched（定时）阶段：「需本地运行」阶段不进服务端后缀计划', () => {
  const h = makeContext({});
  const rc = runningRc();
  const plan = JSON.parse(JSON.stringify(h.context.buildSuffixPlan(rc, 0, { activate: false })));   // vm 域对象 JSON 往返归一
  assert.deepEqual([...plan.stages.map(s => s.id)], ['c'], '非 sched 阶段不进后缀计划（includeLocal 已随关页移交移除）');
  assert.equal(plan.at, 0, 'activate:false 生成休眠计划');
});

test('pagehide 收尾后 beacon 批量释放本页节点租约：移交计划才不用等 TTL 才能拿到节点', async () => {
  const rc = runningRc();
  rc.nodes.a.status = 'running';
  const queued = {
    id: 'q9', pipelineId: 'pl-q', pipelineName: '排队', stages: [{ id: 'z', name: 'Z', kind: 'simulate', sched: null }],
    env: '', envs: [], image: 'img', repoId: null, branch: 'main', strategy: '', by: 'tester', queuedAt: 1,
  };
  const h = makeContext({
    activeRuns: [rc],
    queue: [queued],
    pendingLeaseStarts: [{ envs: [], queueItem: { id: 'q8', stages: [{ id: 'p', name: 'P', kind: 'simulate', sched: null }], repoId: null, branch: 'main', by: 'tester' } }],
  });
  h.context.handoffRunsOnPageHide();
  await flush();
  assert.equal(h.beacons.length, 1, '应发一条租约批量释放 beacon');
  assert.equal(h.beacons[0].url, '/api/worktable/pipeline/leases');
  const body = JSON.parse(h.beacons[0].text);
  assert.equal(body.action, 'release');
  assert.deepEqual(body.runIds, ['L1', 'q9', 'q8'], '在跑运行 leaseId + 队列/租约在途排队项 id 一并释放');
});

test('pagehide 无租约可释放时不发 beacon', async () => {
  const rc = runningRc({ rc: { leaseId: null } });
  rc.nodes.a.status = 'success'; rc.nodes.b.status = 'success'; rc.nodes.c.status = 'success';
  const h = makeContext({ activeRuns: [rc] });
  h.context.handoffRunsOnPageHide();
  await flush();
  assert.equal(h.beacons.length, 0);
});

test('pagehide 收尾返回已了结条目 id：失败落史的运行/队列移交/无剩余阶段/并行子上下文均列入（供最终快照豁免孤儿）', async () => {
  const running = runningRc(); running.nodes.a.status = 'running';
  const done = runningRc({ rc: { id: 'r-done' } });
  done.nodes.a.status = 'success'; done.nodes.b.status = 'success'; done.nodes.c.status = 'success';
  const child = runningRc({ rc: { id: 'r-child', parallelParent: runningRc() } });
  child.nodes.a.status = 'running';
  const queued = {
    id: 'q1', pipelineId: 'pl-q', pipelineName: '排队流水线', stages: [
      { id: 'x', name: '排队X', kind: 'simulate', sched: null },
    ],
    env: '10.0.0.2', envs: [{ id: 'e2', ip: '10.0.0.2' }], image: 'img', repoId: null, branch: 'main', strategy: '',
    by: 'tester', presets: [], queuedAt: 1, source: 'manual',
  };
  const h = makeContext({ activeRuns: [running, done, child], queue: [queued] });
  const concluded = [...h.context.handoffRunsOnPageHide()].sort();
  await flush();
  assert.deepEqual(concluded, ['q1', 'r-child', 'r-done', 'r1'],
    '失败落史的运行 r1、无剩余阶段 r-done、并行子 r-child、队列 q1 均为「已了结」');
  assert.deepEqual([...h.finishedNotes].sort(), ['q1', 'r-child', 'r-done', 'r1'],
    '已了结条目同步登记 queueFinishedNote（completed 豁免孤儿，跨同标签页刷新存活）');
  assert.equal(planPosts(h).length, 1, '只有排队条目 q1 登记服务端计划');
  assert.equal(failPosts(h).length, 1, '在跑运行 r1 经 fail-run 落史');
});

test('pagehide：全预设队列条目 buildUnloadHandoffPlan 返回 null 时仍计入已了结（不登记计划）', async () => {
  const onlyPreset = {
    id: 'q3', pipelineId: 'pl-p3', pipelineName: '全预设', stages: [
      { id: 'p', name: '清理', preset: true, pkey: 'cleanup', sched: {} },
    ],
    env: '', envs: [], image: 'img', repoId: null, branch: 'main', strategy: '', by: 'tester', queuedAt: 1,
  };
  const h = makeContext({ queue: [onlyPreset] });
  const concluded = [...h.context.handoffRunsOnPageHide()];
  await flush();
  assert.deepEqual(concluded, ['q3'], '无业务阶段可移交也已了结：不是失联中断');
  assert.deepEqual([...h.finishedNotes], ['q3']);
  assert.equal(planPosts(h).length, 0, '无阶段不登记计划');
});

test('buildCloseFailRecord：内联日志超 4096 截尾（keepalive 64KB 上传体限制），归档阶段不内联覆盖', () => {
  const h = makeContext({});
  const rc = runningRc();
  rc.nodes.a.status = 'running';
  const rec = h.context.buildCloseFailRecord(rc);
  assert.equal(rec.status, 'failed');
  assert.ok(rec.closeError);
  /* 有归档目录时失败阶段保留 logFile、不写内联 log（中断行由服务端追加进归档文件） */
  const rc2 = runningRc();
  rc2.nodes.a.status = 'running';
  const ctx2 = makeContext({});
  ctx2.context.archiveFolderFor = () => '/arc/run1';
  ctx2.context.taskLogFile = (rc_, seq, name) => 'run-t1-0' + seq + '-' + name + '.log';
  const rec2 = vm.runInContext('buildCloseFailRecord', ctx2.context)(rc2);
  const entryA = (rec2.logs || []).find(l => l.stage === '本地A');
  assert.ok(entryA && entryA.logFile && entryA.logFile.indexOf('/arc/run1/') === 0, '有归档时失败阶段带 logFile');
  assert.equal(entryA.log, undefined, '有归档文件时不内联覆盖（由服务端 fail-run 路由追加中断行进归档日志）');
});

test('静态契约：pagehide 监听调用 handoffRunsOnPageHide；fail-run 路由存在；在跑运行不再向 plans 登记移交', () => {
  assert.ok(/addEventListener\('pagehide',\(\)=>\{[\s\S]*?handoffRunsOnPageHide\(\)/.test(source), 'pagehide 监听应调用 handoffRunsOnPageHide');
  assert.ok(source.includes("'/api/worktable/pipeline/history/fail-run'"), '应存在 fail-run 路由路径');
  assert.ok(!source.includes('includeLocal'), 'includeLocal 选项已随在跑运行关页移交一并移除');
  assert.ok(source.includes('const CLOSE_FAIL_TEXT='), '应有关页失败文案常量');
  assert.ok(/closeError/.test(source), '历史记录应携带 closeError 中断原因');
});
