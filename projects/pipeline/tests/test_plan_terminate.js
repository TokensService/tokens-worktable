/* 「定时」页计划终止能力回归测试：
   计划触发后在服务端执行池运行/排队的执行，计划行显示「运行中/排队中」徽标与「终止」按钮，
   点击确认后经 cancelServerRun 走服务端取消；计划本身（周期/一次性）不被终止影响，仍由「取消」删除。
   权限按 planOwnerBy 剥掉 by 的「 ⏰」来源标记后走 canControlRun 署名比对。
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

/* planList 元素桩：querySelectorAll 按 innerHTML 里的 data-* 属性还原按钮并登记点击回调，
   用例经 handlers 触发等同于真实点击的链路（监听器 → terminatePlan/cancelPlan）。 */
function makePlanListEl() {
  const el = {
    innerHTML: '',
    handlers: {},
    querySelectorAll(sel) {
      const attr = sel === '[data-planstop]' ? 'data-planstop' : 'data-plandel';
      const re = new RegExp(attr + '="([^"]*)"', 'g');
      const out = [];
      let m;
      while ((m = re.exec(el.innerHTML))) {
        const id = m[1];
        out.push({
          getAttribute: name => (name === attr ? id : null),
          addEventListener: (_ev, fn) => { (el.handlers[attr] = el.handlers[attr] || {})[id] = fn; },
        });
      }
      return out;
    },
  };
  return el;
}

function makeContext() {
  const els = { planList: makePlanListEl(), planCount: { textContent: '' } };
  const calls = { alert: [], confirm: [], cancelServer: [], pushPlans: 0, renderQueue: 0 };
  const context = {
    console, Promise, Object, Array, JSON, Date, Error, String, Number, setImmediate,
    setTimeout, clearTimeout, setInterval, clearInterval,
    serverPlans: [],
    remoteQueueClients: [],
    _planActiveSig: '',
    currentUsername: 'tester',
    currentUserIsAdmin: false,
    esc: s => String(s),
    $: id => els[id] || null,
    alert: msg => { calls.alert.push(String(msg)); },
    confirm: msg => { calls.confirm.push(String(msg)); return context.__confirmResult !== false; },
    __confirmResult: true,
    cancelServerRun: async id => { calls.cancelServer.push(String(id)); return { ok: true, state: 'running' }; },
    pushPlans: () => { calls.pushPlans++; },
    renderQueue: () => { calls.renderQueue++; },
    applyRemoteQueuePreviewRefresh() {},
    pullRemoteQueueLog: async () => null,
    QCLIENT_ID: 'self',
    fetch: async () => ({ ok: false }),
  };
  vm.createContext(context);
  installFunctions(context, [
    'remoteRunsOf', 'canControlRun',
    'planOwnerBy', 'planActiveExec', 'planActiveSig',
    'renderPlanList', 'cancelPlan', 'terminatePlan',
    'pullRemoteQueue',
  ]);
  return { context, els, calls };
}

const PLAN_RUN = { id: 'p-run', pipelineName: '构建流水线', desc: '每 10 分钟', env: '10.0.0.1', branch: 'main', by: 'tester ⏰', createdAt: 0 };
const PLAN_QUEUE = { id: 'p-queue', pipelineName: '部署流水线', desc: '一次性', env: '10.0.0.2', branch: 'main', by: 'bob ⏰', createdAt: 0 };
const PLAN_IDLE = { id: 'p-idle', pipelineName: '巡检流水线', desc: '每 1 小时', env: '', branch: 'main', by: 'tester ⏰', createdAt: 0 };

function seedActivePlans(context) {
  context.serverPlans = [PLAN_RUN, PLAN_QUEUE, PLAN_IDLE];
  context.remoteQueueClients = [{
    id: 'server', label: '服务端',
    runs: [{ id: 'p-run', pipelineName: '构建流水线', by: 'tester ⏰' }],
    queue: [{ id: 'p-queue', pipelineName: '部署流水线', by: 'bob ⏰' }],
  }];
}

function rowHtml(el, planId) {
  return el.innerHTML.split('<tr>').find(row => row.includes('data-plandel="' + planId + '"')) || '';
}

test('renderPlanList：仅活动执行的计划显示状态徽标与「终止」按钮', () => {
  const { context, els } = makeContext();
  seedActivePlans(context);

  context.renderPlanList();

  const runRow = rowHtml(els.planList, 'p-run');
  assert.match(runRow, /运行中/);
  assert.match(runRow, /data-planstop="p-run"/);
  const queueRow = rowHtml(els.planList, 'p-queue');
  assert.match(queueRow, /排队中/);
  assert.match(queueRow, /data-planstop="p-queue"/);
  const idleRow = rowHtml(els.planList, 'p-idle');
  assert.doesNotMatch(idleRow, /data-planstop/);
  assert.doesNotMatch(idleRow, /运行中|排队中/);
  /* 每条计划都保留「取消」（删除计划）入口 */
  assert.deepEqual(Object.keys(els.planList.handlers['data-plandel'] || {}).sort(), ['p-idle', 'p-queue', 'p-run']);
});

test('renderPlanList：活动执行只认服务端权威池，他端浏览器的同 id 条目不误标', () => {
  const { context, els } = makeContext();
  context.serverPlans = [PLAN_IDLE];
  context.remoteQueueClients = [{ id: 'browser-1', label: 'Chrome·ab12', runs: [{ id: 'p-idle' }], queue: [] }];

  context.renderPlanList();

  assert.doesNotMatch(rowHtml(els.planList, 'p-idle'), /data-planstop/);
});

test('terminatePlan：确认后按计划 id 调用服务端取消并刷新列表', async () => {
  const { context, els, calls } = makeContext();
  seedActivePlans(context);
  context.renderPlanList();
  let renders = 0;
  const realRender = context.renderPlanList;
  context.renderPlanList = () => { renders++; realRender(); };

  els.planList.handlers['data-planstop']['p-run']();
  await flush();

  assert.deepEqual(calls.cancelServer, ['p-run']);
  assert.equal(calls.confirm.length, 1);
  assert.match(calls.confirm[0], /构建流水线/);
  assert.match(calls.confirm[0], /周期计划本身保留/);
  assert.equal(renders, 1);
  assert.deepEqual(calls.alert, []);
});

test('terminatePlan：执行人署名的「 ⏰」来源标记不影响本人/管理员的控制权判定', async () => {
  const { context, calls } = makeContext();
  seedActivePlans(context);

  /* 本人（by 带 ⏰ 后缀）可终止自己的定时运行 */
  context.currentUsername = 'tester';
  context.currentUserIsAdmin = false;
  await context.terminatePlan('p-run');
  await flush();
  assert.deepEqual(calls.cancelServer, ['p-run']);
  assert.deepEqual(calls.alert, []);

  /* 非管理员不能终止他人的定时运行 */
  calls.cancelServer.length = 0;
  await context.terminatePlan('p-queue');
  await flush();
  assert.deepEqual(calls.cancelServer, []);
  assert.equal(calls.alert.length, 1);
  assert.match(calls.alert[0], /无权限/);
  assert.match(calls.alert[0], /bob/);   // 提示中展示剥掉 ⏰ 的归属执行人

  /* 管理员全权 */
  calls.alert.length = 0;
  context.currentUserIsAdmin = true;
  await context.terminatePlan('p-queue');
  await flush();
  assert.deepEqual(calls.cancelServer, ['p-queue']);
  assert.deepEqual(calls.alert, []);
});

test('terminatePlan：计划无活动执行时提示且不触碰服务端', async () => {
  const { context, calls } = makeContext();
  seedActivePlans(context);

  await context.terminatePlan('p-idle');
  await flush();

  assert.deepEqual(calls.cancelServer, []);
  assert.equal(calls.alert.length, 1);
  assert.match(calls.alert[0], /没有正在运行或排队的执行/);
});

test('terminatePlan：取消确认时不发起终止', async () => {
  const { context, calls } = makeContext();
  seedActivePlans(context);
  context.__confirmResult = false;

  await context.terminatePlan('p-run');
  await flush();

  assert.deepEqual(calls.cancelServer, []);
});

test('cancelPlan：有活动执行时需确认且仅删计划，无活动时保持一键删除', () => {
  const { context, calls } = makeContext();
  seedActivePlans(context);

  /* 有活动执行：确认框说明「取消不终止当前执行」；取消确认则计划保留 */
  context.__confirmResult = false;
  context.cancelPlan('p-run');
  assert.equal(calls.confirm.length, 1);
  assert.match(calls.confirm[0], /取消计划不会终止/);
  assert.equal(context.serverPlans.length, 3);
  assert.equal(calls.pushPlans, 0);

  /* 确认后仅删除计划（当前执行由「终止」负责） */
  context.__confirmResult = true;
  context.cancelPlan('p-run');
  assert.deepEqual(context.serverPlans.map(p => p.id), ['p-queue', 'p-idle']);
  assert.equal(calls.pushPlans, 1);

  /* 无活动执行：维持原有静默直删行为 */
  const confirmCalls = calls.confirm.length;
  context.cancelPlan('p-idle');
  assert.equal(calls.confirm.length, confirmCalls);
  assert.deepEqual(context.serverPlans.map(p => p.id), ['p-queue']);
  assert.equal(calls.pushPlans, 2);
});

test('pullRemoteQueue：计划活动执行集合变化时重绘计划列表，无变化不重建', async () => {
  const { context, els, calls } = makeContext();
  context.serverPlans = [PLAN_RUN];
  let renders = 0;
  const realRender = context.renderPlanList;
  context.renderPlanList = () => { renders++; realRender(); };
  const snapshot = active => ({
    clients: [],
    server: { id: 'server', runs: active ? [{ id: 'p-run', pipelineName: '构建流水线', by: 'tester ⏰' }] : [], queue: [] },
  });
  let active = false;
  context.fetch = async () => ({ ok: true, json: async () => snapshot(active) });

  /* 计划开始执行（快照出现 p-run）：重绘一次 */
  active = true;
  await context.pullRemoteQueue();
  assert.equal(renders, 1);
  assert.match(rowHtml(els.planList, 'p-run'), /data-planstop="p-run"/);

  /* 快照不变：轮询不重建列表 */
  await context.pullRemoteQueue();
  assert.equal(renders, 1);

  /* 执行结束（快照移除 p-run）：再次重绘，「终止」消失 */
  active = false;
  await context.pullRemoteQueue();
  assert.equal(renders, 2);
  assert.doesNotMatch(rowHtml(els.planList, 'p-run'), /data-planstop/);
  assert.equal(calls.renderQueue, 3);
});

test('planOwnerBy / planActiveSig：剥 ⏰ 后缀与活动签名', () => {
  const { context } = makeContext();
  assert.equal(context.planOwnerBy({ by: 'tester ⏰' }), 'tester');
  assert.equal(context.planOwnerBy({ by: 'bob' }), 'bob');
  assert.equal(context.planOwnerBy(null), '');

  seedActivePlans(context);
  assert.equal(context.planActiveSig(), 'p-run:running,p-queue:queued');
  context.remoteQueueClients = [];
  assert.equal(context.planActiveSig(), '');
});
