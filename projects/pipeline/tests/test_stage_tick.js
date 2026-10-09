// test_stage_tick.js — 阶段进度共享 tick 回归：
// 合并前每个执行中阶段各起一个 setInterval（脚本/预设 300ms、HTTP 500ms、EvalTokens 1000ms、本地模拟 120ms），
// 每个 tick 都 rcRender 全量重绘，并行阶段定时器成倍、页面切后台仍空转；
// 合并后全页面唯一 500ms interval 统一推进所有 running 阶段，tick 内只直改进度条宽度/进度文本/详情进度条，
// 页面隐藏停表、恢复可见立即补一次 tick 再走表，终态/中止任务由驱动器摘除、全部摘除即停表。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function extractFunction(name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, 'pipeline.html 缺少函数 ' + name);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error('未闭合的函数 ' + name);
}

/* 共享 tick 块整段切片（store/ensure/run/paint + visibilitychange 监听注册） */
function tickBlock() {
  const start = source.indexOf('function stageTickStore(');
  const end = source.indexOf('function createParallelStageContext(', start);
  assert.ok(start >= 0 && end > start, '共享 tick 块切片标记丢失');
  return source.slice(start, end);
}

function makeCtx() {
  let now = 100000;
  const intervals = [];
  const cleared = [];
  const listeners = {};
  const detailBar = { style: {} };
  const flowNodes = {};   // stageId -> { bar, meta, el }
  const calls = { rcRender: [], renderDetail: 0, renderFlow: 0, advance: [], archived: [], finish: [] };
  const context = {
    Object, Array, JSON, console,
    Date: { now: () => now },
    setInterval(fn, ms) { const h = { fn, ms }; intervals.push(h); return h; },
    clearInterval(h) { cleared.push(h); },
    document: {
      hidden: false,
      addEventListener(type, fn) { listeners[type] = fn; },
    },
    $: id => (id === 'detailBar' ? detailBar : null),
    viewRc: null,
    rootRunContext: rc => (rc && rc.parallelParent) || rc,
    flowNodeElementById: id => (flowNodes[id] ? flowNodes[id].el : null),
    runSetSel(rc, id) { rc.selId = id; },
    rcRender(rc) { calls.rcRender.push(rc); },
    renderDetail() { calls.renderDetail += 1; },
    renderFlow() { calls.renderFlow += 1; },
    archiveStageLog(...args) { calls.archived.push(args); },
    stageSeq: (_stg, i) => i + 1,
    advance(rc, i) { calls.advance.push([rc, i]); },
    finish(rc, r) { calls.finish.push([rc, r]); },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('fmtDur') + '\n' + tickBlock() + '\n' + extractFunction('runStage'), context);
  return { context, calls, intervals, cleared, listeners, detailBar, flowNodes,
    getNow: () => now, addNow: d => { now += d; } };
}

function makeRc(id, stages) {
  return { id, stages, nodes: {}, selId: null, timer: null, over: false, overall: null, token: 1, vars: {} };
}

function fakeFlowNode(stageId) {
  const bar = { style: {} };
  const meta = { textContent: '' };
  const el = { dataset: { id: stageId }, querySelector: sel => (sel === '.pipeline-bar > i' ? bar : (sel === '.pipeline-nodeMeta' ? meta : null)) };
  return { bar, meta, el };
}

test('多个运行/阶段注册进度任务只创建一个共享 interval（合并去重）', () => {
  const h = makeCtx();
  const rcA = makeRc('ra', [{ id: 'a', name: 'A', dur: 5 }]);
  const rcB = makeRc('rb', [{ id: 'b', name: 'B', dur: 8 }]);
  h.context.runStage(rcA, 0);
  h.context.runStage(rcB, 0);
  assert.equal(h.intervals.length, 1, '两个运行各注册一个进度任务，但只允许一个共享 interval');
  assert.equal(h.intervals[0].ms, 500);
  assert.equal(typeof rcA.timer, 'string', 'rc.timer 改存进度任务键作在途标记');
  assert.equal(typeof rcB.timer, 'string');
  assert.notEqual(rcA.timer, rcB.timer);
  const T = h.context.stageTickStore();
  assert.deepEqual(Object.keys(T.tasks).sort(), [rcA.timer, rcB.timer].sort());
});

test('tick 内只直改进度条宽度/进度文本/详情进度条，不触发全量渲染', () => {
  const h = makeCtx();
  const rc = makeRc('r1', [{ id: 'a', name: 'A', dur: 30 }]);
  rc.selId = 'a';
  h.context.viewRc = rc;
  h.flowNodes.a = fakeFlowNode('a');
  rc.nodes.a = { status: 'running', progress: 0, dur: 0, sub: {} };
  const T = h.context.stageTickStore();
  T.tasks.k1 = { rc, stageId: 'a', t0: h.getNow() - 1000, last: h.getNow() - 500, rate: 2 / 300 };   // 脚本/预设阶段节奏（原 300ms 每 tick +2）
  h.context.stageTickRun();
  const n = rc.nodes.a;
  assert.ok(Math.abs(n.progress - 500 * (2 / 300)) < 1e-9, '按真实经过时间等比推进，得到 ' + n.progress);
  assert.equal(n.dur, 1);
  assert.equal(h.flowNodes.a.bar.style.width, n.progress + '%', '编排节点进度条直改宽度');
  assert.equal(h.flowNodes.a.meta.textContent, '3% · 1s', '节点进度文本直改（百分比 · 已耗时）');
  assert.equal(h.detailBar.style.width, n.progress + '%', '选中阶段的详情进度条直改宽度');
  assert.equal(h.calls.renderDetail, 0, 'tick 不得触发详情区全量渲染');
  assert.equal(h.calls.rcRender.length, 0, 'tick 不得走 rcRender');
  assert.ok(T.tasks.k1, '任务未结束应保留在表');
});

test('运行中节点进度文本的耗时按 fmtDur 显示（1m30s 格式）', () => {
  const h = makeCtx();
  const rc = makeRc('r1', [{ id: 'a', name: 'A', dur: 30 }]);
  rc.selId = 'a';
  h.context.viewRc = rc;
  h.flowNodes.a = fakeFlowNode('a');
  rc.nodes.a = { status: 'running', progress: 47, dur: 0, sub: {} };
  h.context.stageTickStore().tasks.k1 = { rc, stageId: 'a', t0: h.getNow() - 90000, last: h.getNow() - 500, rate: 2 / 300 };
  h.context.stageTickRun();
  const n = rc.nodes.a;
  assert.equal(n.dur, 90, '已运行 90 秒');
  assert.equal(h.flowNodes.a.meta.textContent, Math.round(n.progress) + '% · 1m30s', '耗时 ≥60s 显示为 NmNs 样式');
});

test('非当前展示运行的任务 tick 只推进数据，不落 DOM', () => {
  const h = makeCtx();
  const rc = makeRc('r1', [{ id: 'a', name: 'A', dur: 30 }]);
  const other = makeRc('r2', []);
  rc.selId = 'a';
  h.context.viewRc = other;   // 编排区展示的是别的运行
  h.flowNodes.a = fakeFlowNode('a');
  rc.nodes.a = { status: 'running', progress: 10, dur: 0, sub: {} };
  h.context.stageTickStore().tasks.k1 = { rc, stageId: 'a', t0: h.getNow() - 500, last: h.getNow() - 500, rate: 2 / 300 };
  h.context.stageTickRun();
  assert.ok(rc.nodes.a.progress > 10, '后台运行的进度数据仍推进');
  assert.equal(h.flowNodes.a.bar.style.width, undefined, '非展示运行不落 DOM');
  assert.equal(h.flowNodes.a.meta.textContent, '');
});

test('页面隐藏时停表，恢复可见时立即补一次 tick 再走表', () => {
  const h = makeCtx();
  const rc = makeRc('r1', [{ id: 'a', name: 'A', dur: 30 }]);
  rc.selId = 'a';
  h.context.viewRc = rc;
  h.flowNodes.a = fakeFlowNode('a');
  h.context.runStage(rc, 0);
  assert.equal(h.intervals.length, 1);
  const T = h.context.stageTickStore();
  h.context.document.hidden = true;
  h.listeners.visibilitychange();
  assert.equal(T.timer, null, '隐藏后共享 interval 应停表');
  assert.equal(h.cleared.length, 1);
  h.addNow(3000);
  assert.equal(rc.nodes.a.progress, 0, '隐藏期间 tick 已停，进度不推进');
  h.context.document.hidden = false;
  h.listeners.visibilitychange();
  assert.equal(rc.nodes.a.progress, 10, '恢复可见应立即补一次 tick（按真实经过时间补齐 3s/30s=10%）');
  assert.equal(h.intervals.length, 2, '恢复可见后重新走表');
  h.addNow(3000);
  h.intervals[1].fn();   // 走表回调驱动 stageTickRun
  assert.equal(rc.nodes.a.progress, 20, '走表回调应驱动共享 tick');
});

test('页面隐藏期间注册的任务不起表，恢复可见后补 tick 再走表', () => {
  const h = makeCtx();
  h.context.document.hidden = true;
  const rc = makeRc('r1', [{ id: 'a', name: 'A', dur: 5 }]);
  h.context.runStage(rc, 0);
  assert.equal(h.intervals.length, 0, '隐藏时注册不创建 interval');
  assert.equal(rc.nodes.a.progress, 0);
  h.addNow(1500);
  h.context.document.hidden = false;
  h.listeners.visibilitychange();
  assert.equal(h.intervals.length, 1, '恢复可见后起表');
  assert.equal(rc.nodes.a.progress, 30, '恢复可见立即补一次 tick（1.5s/5s=30%）');
});

test('终态/中止任务由驱动器摘除，全部摘除后停表（不泄漏）', () => {
  const h = makeCtx();
  const rc = makeRc('r1', [{ id: 'a', name: 'A', dur: 30 }]);
  rc.selId = 'a';
  h.context.viewRc = rc;
  h.flowNodes.a = fakeFlowNode('a');
  h.context.runStage(rc, 0);
  const T = h.context.stageTickStore();
  const key = rc.timer;
  assert.ok(T.tasks[key], '注册后任务在表');
  /* 阶段收尾路径保持原样（clearInterval + timer=null），驱动器下一 tick 摘除注册项 */
  h.context.clearInterval(rc.timer); rc.timer = null;
  rc.nodes.a = { status: 'success', progress: 100, dur: 1, sub: {} };
  h.context.stageTickRun();
  assert.equal(T.tasks[key], undefined, '终态任务应被摘除');
  assert.equal(T.timer, null, '全部摘除后共享 interval 应停表');
  assert.equal(h.cleared.length, 2, '收尾清在途标记一次 + 停表一次');
  const width = h.flowNodes.a.bar.style.width;
  h.context.stageTickRun();
  assert.equal(h.flowNodes.a.bar.style.width, width, '摘除后 tick 不再触碰该节点');
  /* 中止/重置（over=true）同样摘除 */
  const rc2 = makeRc('r2', [{ id: 'b', name: 'B', dur: 30 }]);
  h.context.runStage(rc2, 0);
  rc2.over = true;
  h.context.stageTickRun();
  assert.equal(Object.keys(T.tasks).length, 0, 'over 的任务应被摘除');
  assert.equal(T.timer, null);
});

test('本地模拟阶段经共享 tick 按真实耗时推进：子阶段翻牌补渲染、到点归档收尾并 advance', () => {
  const h = makeCtx();
  const rc = makeRc('r1', [{ id: 'sim', name: '构建', dur: 10, sub: ['编译', '测试'] }]);
  rc.selId = 'sim';
  h.context.viewRc = rc;
  h.flowNodes.sim = fakeFlowNode('sim');
  h.context.runStage(rc, 0);
  const T = h.context.stageTickStore();
  const key = rc.timer;
  const detailBase = h.calls.renderDetail;   // runStage 启动时渲染一次（非 tick 触发），此处只锁 tick 行为
  /* 有子阶段时分母为 total×1.2=12s；翻牌阈值 p>50·(idx+1)（与原 120ms 定时器同公式） */
  h.addNow(3000); h.context.stageTickRun();   // p=25：跨 25% 日志档位 → 补一次全量渲染
  assert.equal(h.calls.rcRender.length, 1, '跨 25% 日志档位应补一次 rcRender');
  assert.equal(rc.nodes.sim.sub['编译'], 'running');
  h.addNow(3500); h.context.stageTickRun();   // p≈54：子阶段「编译」翻牌 → 补渲染
  assert.equal(rc.nodes.sim.sub['编译'], 'success');
  assert.equal(h.calls.rcRender.length, 2, '子阶段翻牌应补一次 rcRender');
  h.addNow(500); h.context.stageTickRun();    // p≈58：未跨档未翻牌 → 只轻量直改
  assert.equal(h.calls.rcRender.length, 2, '无档位/翻牌变化时不得全量渲染');
  assert.equal(h.flowNodes.sim.bar.style.width, rc.nodes.sim.progress + '%');
  assert.equal(h.calls.renderDetail, detailBase, 'tick 自身不得直接调 renderDetail');
  h.addNow(6100); h.context.stageTickRun();   // p=100：到点收尾
  assert.equal(rc.nodes.sim.status, 'success');
  assert.equal(rc.nodes.sim.progress, 100);
  assert.equal(rc.timer, null, '到点收尾清在途标记');
  assert.equal(T.tasks[key], undefined, '到点收尾摘除任务');
  assert.equal(T.timer, null, '全部摘除即停表');
  assert.equal(h.calls.archived.length, 1, '本地模拟阶段的回显同样归档');
  assert.deepEqual(h.calls.advance, [[rc, 1]], '到点推进到下一阶段');
  assert.equal(rc.nodes.sim.sub['测试'], 'running', '末尾子阶段不到 100% 阈值不翻牌（与原定时器行为一致）');
});

test('同运行同阶段重注册去重（中止/重置后立即重试不留双任务）', () => {
  const h = makeCtx();
  const rc = makeRc('r1', [{ id: 'a', name: 'A', dur: 30 }]);
  h.context.runStage(rc, 0);
  const first = rc.timer;
  h.context.runStage(rc, 0);
  const T = h.context.stageTickStore();
  assert.notEqual(rc.timer, first);
  assert.equal(Object.keys(T.tasks).length, 1, '旧任务键应被去重');
  assert.ok(T.tasks[rc.timer]);
});
