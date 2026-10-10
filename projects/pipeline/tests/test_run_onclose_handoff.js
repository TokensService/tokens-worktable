/* 浏览器关闭时本地运行移交服务端 —— 回归测试。
   场景：手动运行含「需本地运行」阶段的流水线（runPipeline 分流到 startSimRun），中途关闭浏览器。
   原行为：exec-stream 随连接断开被服务端杀掉，advance 不再推进，运行永久卡在当前阶段。
   新行为：pagehide 把在跑运行的剩余阶段（含非 sched）与本地队列整体登记为「立即执行一次」的服务端计划
   （keepalive POST 单条 upsert，unload 期间请求仍可送达），由服务端执行池继续跑完。
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
  const context = {
    console, Promise, Object, Array, JSON, URL, Date, Error, setImmediate, Math,
    setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
    alert(msg) { alerts.push(String(msg)); },
    serverPlans: [],
    renderPlanList() {},
    activeRuns: options.activeRuns || [],
    queue: options.queue || [],
    pendingLeaseStarts: options.pendingLeaseStarts || [],
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
  installFunctions(context, [
    'stageSeq',
    'runRepositorySnapshot',
    'registerStageTimers',
    'buildUnloadHandoffPlan',
    'currentStageIndex',
    'handoffRunsOnPageHide',
  ]);
  return { context, fetches, alerts, beacons };
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

test('pagehide 移交：在跑运行从当前阶段起全部剩余阶段（含需本地运行）登记为 keepalive 服务端计划', async () => {
  const rc = runningRc();
  rc.nodes.a.status = 'success'; rc.nodes.a.progress = 100;
  rc.nodes.b.status = 'running'; rc.nodes.b.progress = 40;
  const h = makeContext({ activeRuns: [rc] });
  h.context.handoffRunsOnPageHide();
  await flush();
  const posts = h.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/api/worktable/pipeline/plans'));
  assert.equal(posts.length, 1, '应向计划接口 POST 一条 upsert');
  assert.equal(posts[0].keepalive, true, 'unload 期间请求必须 keepalive 才能送达');
  const plan = posts[0].body && posts[0].body.plan;
  assert.ok(plan, 'POST 体应携带 {plan}');
  assert.equal(plan.kind, 'once');
  assert.equal(plan.id, 'stimer-pl-1-t1-unload', '卸载移交用独立 id，不与定时后缀 stimer-…-suffix 冲突');
  assert.deepEqual(plan.stages.map(s => s.id), ['b', 'c'], '从当前 running 阶段起（含该阶段重跑）到末尾全部移交');
  assert.equal(plan.stages[0].sched, undefined, '计划阶段去掉 sched 标记');
  assert.equal(plan.vars.A, '1', '上游变量随计划移交');
  assert.equal(plan.archive, '/arc/pl_p');
  assert.equal(plan.tag, 't1');
  assert.equal(plan.baseSeq, 1, 'baseSeq=移交起点之前的正式阶段数');
  assert.equal(plan.strategy, '3P1D', '部署策略随计划移交（否则服务端 DEPLOY_STRATEGY 丢失）');
  assert.deepEqual(plan.repository, {
    id: 'repo-1', name: 'demo-repo',
    url: 'https://git.example.com/dev/demo.git', user: 'u1', pass: 'p1',
  }, '代码仓快照随计划移交，否则 GIT_* 不注入、git 类脚本卡在凭据提示');
  assert.match(plan.desc, /浏览器关闭/);
});

test('pagehide 移交：含「需本地运行」阶段也一并移交（脚本在服务端跑；仅浏览器可达的 HTTP 目标可能失败，优于整条停住）', async () => {
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
  const plan = h.fetches.find(f => f.method === 'POST' && f.url.endsWith('/api/worktable/pipeline/plans')).body.plan;
  assert.deepEqual(plan.stages.map(s => s.id), ['a', 'b', 'c'], '非 sched 阶段必须进计划，不得只交定时后缀');
});

test('pagehide 移交：已结束/并行子上下文跳过；本地队列条目同样登记为 once 计划', async () => {
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
  const posts = h.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/api/worktable/pipeline/plans'));
  assert.equal(posts.length, 1, '已结束与并行子上下文不移交；只登记队列条目');
  const plan = posts[0].body.plan;
  assert.equal(plan.id, 'unload-q1');
  assert.equal(plan.pipelineId, 'pl-q');
  assert.deepEqual(plan.stages.map(s => s.id), ['x', 'y']);
  assert.equal(plan.repoId, 'r');
  assert.equal(plan.repository, null, '队列条目无 url 快照时只留 repoId，由服务端按配置补齐');
  assert.equal(plan.strategy, 'P-D', '队列条目的部署策略也要随计划移交');
  assert.match(plan.desc, /浏览器关闭/);
});

test('pagehide 移交：租约申请在途的排队项也移交；无剩余阶段不登记', async () => {
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
  const posts = h.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/api/worktable/pipeline/plans'));
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

test('buildUnloadHandoffPlan：跳过预设任务；baseSeq 按正式阶段序号', () => {
  const h = makeContext({});
  const rc = runningRc({
    stages: [
      { id: 'a', name: '本地A', kind: 'simulate', sched: null },
      { id: 'p', name: '清理', preset: true, pkey: 'cleanup', sched: {} },
      { id: 'b', name: '本地B', kind: 'simulate', sched: null },
    ],
  });
  rc.nodes.a.status = 'success';
  const plan = h.context.buildUnloadHandoffPlan(rc, 1);
  assert.equal(plan.stages.map(s => s.id).join(','), 'b', '预设任务是页面运行期概念，不进服务端计划');
  assert.equal(plan.baseSeq, 1);
});

test('registerStageTimers opts.includeLocal：把非 sched 阶段也写进计划（与卸载移交同口径）', async () => {
  const rc = runningRc();
  const h = makeContext({ activeRuns: [rc] });
  const ok = await h.context.registerStageTimers(rc, 0, { includeLocal: true });
  assert.equal(ok, true);
  const put = h.fetches.find(f => f.method === 'PUT' && f.url.endsWith('/api/worktable/pipeline/plans'));
  assert.ok(put);
  const plan = put.body.plans.find(p => p && p.id === 'stimer-pl-1-t1-suffix');
  assert.ok(plan);
  assert.deepEqual(plan.stages.map(s => s.id), ['a', 'b', 'c'], 'includeLocal 时本地阶段也进后缀计划');
  assert.deepEqual(plan.repository, {
    id: 'repo-1', name: 'demo-repo',
    url: 'https://git.example.com/dev/demo.git', user: 'u1', pass: 'p1',
  }, '定时后缀计划同样要带代码仓快照');
  assert.equal(plan.strategy, '3P1D', '定时后缀计划同样要带部署策略');
});

test('pagehide 移交后 beacon 批量释放本页节点租约：移交计划才不用等 TTL 才能拿到节点', async () => {
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
