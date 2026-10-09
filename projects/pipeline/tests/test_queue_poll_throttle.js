// 队列轮询降耗：快照签名一致（内容未变）时跳过队列区重绘；页面隐藏暂停轮询、恢复可见立即补拉。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function extract(startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start);
  assert.ok(start >= 0 && end > start, startMark + ' not found');
  return source.slice(start, end);
}

/* 与 test_queue_item_preview.js 同一片段：注释行 → $('queueRefresh')，含 _queuePullSig/queuePollSig/pullRemoteQueue */
function loadPullContext(overrides) {
  const context = Object.assign({
    QCLIENT_ID: 'self', remoteQueueClients: [], viewRc: null,
    fetch: async () => ({ ok: false }),
    planActiveSig: () => '', _planActiveSig: '', renderPlanList: () => {},
    applyRemoteQueuePreviewRefresh: () => {}, pullRemoteQueueLog: async () => null, renderQueue: () => {},
  }, overrides || {});
  vm.createContext(context);
  vm.runInContext(extract('/* 拉取服务端权威队列及旧标签页', "$('queueRefresh')"), context);
  return context;
}

test('queuePollSig：seenAgo 每秒抖动不改变签名，快照内容变化才改变', () => {
  const ctx = loadPullContext();
  const base = [
    { id: 'server', label: '服务端', schemaVersion: 3, runs: [], queue: [] },
    { id: 'c1', label: 'Chrome·ab12', schemaVersion: 2, seenAgo: 1, running: null, runs: [], queue: [] },
  ];
  const jittered = JSON.parse(JSON.stringify(base));
  jittered[1].seenAgo = 9;
  const changed = JSON.parse(JSON.stringify(base));
  changed[1].queue = [{ id: 'q1', by: 'alice', queuedAt: 1 }];

  const sig = ctx.queuePollSig(base);
  assert.equal(ctx.queuePollSig(jittered), sig, 'seenAgo 页面不展示，不得触发重绘');
  assert.notEqual(ctx.queuePollSig(changed), sig, '队列条目增减必须触发重绘');
});

test('queuePollSig：相对时间标签翻转与查看焦点变化算内容变化', () => {
  let label = '刚刚';
  const ctx = loadPullContext({ fmtRelative: () => label, localQueueItems: () => [{ id: 'q1', queuedAt: 1 }] });
  const clients = [{ id: 'server', runs: [], queue: [{ id: 'q2', queuedAt: 5 }] }];
  const sig = ctx.queuePollSig(clients);

  assert.equal(ctx.queuePollSig(clients), sig, '输入不变时签名稳定');
  label = '1分钟前';
  assert.notEqual(ctx.queuePollSig(clients), sig, '远端条目的相对时间标签翻转触发重绘');

  ctx.viewRc = { id: 'q1', queuedPreview: true };
  assert.notEqual(ctx.queuePollSig(clients), sig, '查看焦点变化（「查看中」高亮）触发重绘');
  ctx.viewRc = null;
  label = '刚刚';
  assert.equal(ctx.queuePollSig(clients), sig, '焦点与标签还原后签名回到原值');
});

test('queuePollSig：本页有排队项等待节点时附加约 5 秒桶，保持 nodeWait 到点重试节奏', () => {
  let now = 100000;
  let items = [];
  const ctx = loadPullContext({
    Date: { now: () => now },
    fmtRelative: () => '刚刚',
    localQueueItems: () => items,
  });
  const idle = ctx.queuePollSig([]);

  items = [{ id: 'q1', queuedAt: 1, nodeWait: { until: 1, conflicts: [] } }];
  const waiting = ctx.queuePollSig([]);
  assert.notEqual(waiting, idle, '等待节点的排队项与空闲态签名不同');
  assert.equal(ctx.queuePollSig([]), waiting, '同一 5 秒桶内签名稳定');
  now += 5000;
  assert.notEqual(ctx.queuePollSig([]), waiting, '跨桶后签名翻转，驱动 renderQueue 自愈入口的 drainQueue 重试');
});

test('pullRemoteQueue：快照内容未变时跳过队列区重绘，日志通道与自动跟随每轮仍执行', async () => {
  let renders = 0, logPulls = 0, previews = 0, follows = 0;
  const payload = {
    clients: [{ id: 'other', label: 'Chrome·ab12', schemaVersion: 2, seenAgo: 1, running: null, runs: [], queue: [] }],
    server: { id: 'server', label: '服务端', schemaVersion: 3, runs: [], queue: [] },
  };
  const ctx = loadPullContext({
    fetch: async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(payload)) }),
    applyRemoteQueuePreviewRefresh: () => { previews += 1; },
    followPendingServerRun: () => { follows += 1; },
    pullRemoteQueueLog: async () => { logPulls += 1; },
    renderQueue: () => { renders += 1; },
  });

  await ctx.pullRemoteQueue();
  assert.equal(renders, 1, '首轮签名从无到有：正常重绘');
  assert.deepEqual(Array.from(ctx.remoteQueueClients, c => c.id), ['other']);
  assert.equal(previews, 1);

  payload.clients[0].seenAgo = 2;   // 仅 seenAgo 抖动（服务端每秒必变、页面不展示）
  await ctx.pullRemoteQueue();
  assert.equal(renders, 1, '内容未变时跳过 renderQueue 的 DOM 重建');
  assert.equal(logPulls, 2, '日志尾部拉取（自带 revision/304）不受签名跳过影响');
  assert.equal(follows, 2, '提交后自动跟随（含超时清理）每轮都执行');

  payload.server.runs = [{ id: 'r1', pipelineName: '部署', by: 'bob', startedAt: 7 }];
  await ctx.pullRemoteQueue();
  assert.equal(renders, 2, '快照内容变化时恢复重绘');
  assert.deepEqual(Array.from(ctx.remoteQueueClients, c => c.id), ['server', 'other'], '服务端有活动时排在他端之前');

  ctx.fetch = async () => { throw new Error('down'); };
  await ctx.pullRemoteQueue();
  assert.equal(renders, 2, '拉取失败不重绘（远端数据无更新，本地变化各有渲染入口）');
});

test('pullRemoteQueue：运行中阶段按 startedAt 实时折算 dur（每秒前进触发重绘），无 startedAt 不动', async () => {
  let now = 1759999900000;
  let renders = 0;
  const stageStartedAt = now - 10000;
  const mkPayload = () => ({
    clients: [],
    server: {
      id: 'server', label: '服务端', schemaVersion: 3,
      runs: [{
        id: 'r1', pipelineName: '部署', by: 'bob', startedAt: stageStartedAt,
        stages: [{ id: 's1', name: '构建' }, { id: 's2', name: '测试' }],
        nodes: {
          s1: { status: 'running', progress: 5, dur: 0, startedAt: stageStartedAt },
          s2: { status: 'running', progress: 40, dur: 33 },   // 旧数据无 startedAt：dur 保持原样
        },
      }],
      queue: [{ id: 'q1', pipelineName: '排队', by: 'alice', queuedAt: 1, stages: [{ id: 's3', name: '发布' }], nodes: { s3: { status: 'idle', progress: 0, dur: 0 } } }],
    },
  });
  const ctx = loadPullContext({
    Date: { now: () => now },
    fetch: async () => ({ ok: true, json: async () => mkPayload() }),
    renderQueue: () => { renders += 1; },
  });

  await ctx.pullRemoteQueue();
  assert.equal(renders, 1);
  const nodes = ctx.remoteQueueClients[0].runs[0].nodes;
  assert.equal(nodes.s1.dur, 10, '运行中阶段 dur 由 startedAt 折算为实时已耗时');
  assert.equal(nodes.s1.startedAt, stageStartedAt, 'startedAt 原样保留在快照节点上');
  assert.equal(nodes.s2.dur, 33, '无 startedAt 的运行中节点 dur 不被折算');
  assert.equal(ctx.remoteQueueClients[0].queue[0].nodes.s3.dur, 0, '排队条目的 idle 节点不受影响');

  /* 快照其余内容不变但 dur 每秒前进 → 签名变化 → 队列区/远端预览每秒刷出实时已耗时 */
  now += 1000;
  await ctx.pullRemoteQueue();
  assert.equal(renders, 2, '运行中阶段 dur 前进本身即内容变化，驱动逐秒重绘');
  assert.equal(ctx.remoteQueueClients[0].runs[0].nodes.s1.dur, 11);

  now += 60000;
  await ctx.pullRemoteQueue();
  assert.equal(ctx.remoteQueueClients[0].runs[0].nodes.s1.dur, 71);
  assert.equal(renders, 3);
});

/* 轮询定时器生命周期：文件尾部 const QUEUE_POLL_MS → visibilitychange 接线之前的三个函数 */
function loadPollLifecycle(overrides) {
  const calls = { pull: 0 };
  const intervals = [];
  let seq = 0;
  const context = Object.assign({
    document: { hidden: false },
    setInterval: (fn, ms) => { const h = { id: ++seq, fn, ms, cleared: false }; intervals.push(h); return h; },
    clearInterval: h => { const x = intervals.find(i => i === h); if (x) x.cleared = true; },
    pullRemoteQueue: () => { calls.pull += 1; },
  }, overrides || {});
  vm.createContext(context);
  vm.runInContext(extract('const QUEUE_POLL_MS', "document.addEventListener('visibilitychange'"), context);
  return { context, calls, intervals };
}

test('startQueuePolling/stopQueuePolling：每秒周期拉取幂等启动，隐藏 tick 早退兜底', () => {
  const { context, calls, intervals } = loadPollLifecycle();
  context.startQueuePolling();
  context.startQueuePolling();
  assert.equal(intervals.length, 1, '重复初始化不能注册多个定时器');
  assert.equal(intervals[0].ms, 1000);

  intervals[0].fn();
  assert.equal(calls.pull, 1);
  context.document.hidden = true;
  intervals[0].fn();
  assert.equal(calls.pull, 1, '页面隐藏时 tick 早退（可见性事件未触达的环境也不发请求）');

  context.stopQueuePolling();
  context.stopQueuePolling();
  assert.equal(intervals[0].cleared, true);
  assert.equal(intervals.length, 1, '重复停表不报错');
  context.startQueuePolling();
  assert.equal(intervals.length, 2, '停表后可重新启动');
});

test('syncQueuePolling：页面隐藏即停表不补拉，恢复可见立即补拉一次并重启周期拉取', () => {
  const { context, calls, intervals } = loadPollLifecycle();
  context.startQueuePolling();

  context.document.hidden = true;
  context.syncQueuePolling();
  assert.equal(intervals[0].cleared, true, '隐藏时停掉轮询定时器，后台零请求');
  assert.equal(calls.pull, 0, '隐藏时不补拉');

  context.document.hidden = false;
  context.syncQueuePolling();
  assert.equal(calls.pull, 1, '恢复可见立即补拉一次');
  assert.equal(intervals.length, 2, '并重启周期拉取');
  assert.equal(intervals[1].cleared, false);

  context.document.hidden = true;
  context.syncQueuePolling();
  assert.equal(intervals[1].cleared, true, '再次隐藏停掉新表');
});

test('页面启动接线：启动即拉一次 + 启动轮询，visibilitychange 驱动 syncQueuePolling', () => {
  assert.match(source, /document\.addEventListener\('visibilitychange',syncQueuePolling\)/);
  assert.match(source, /pullRemoteQueue\(\);\s*\n\s*startQueuePolling\(\);/);
  assert.equal(source.includes('setInterval(pullRemoteQueue, 1000)'), false, '旧的裸 1 秒轮询已移除');
});

test('进行中脉冲动画只动 opacity/transform（不再动画 box-shadow，每帧不触发 repaint）', () => {
  const start = source.indexOf('@keyframes pipPulse');
  const end = source.indexOf('@keyframes pipDot', start);
  assert.ok(start >= 0 && end > start, '缺少 pipPulse 动画定义');
  const keyframes = source.slice(start, source.indexOf('.pipeline-node.run', start));
  assert.ok(!/box-shadow/.test(keyframes), '关键帧不再动画 box-shadow');
  assert.match(keyframes, /opacity/);
  assert.match(keyframes, /transform:scale/);
  const block = source.slice(start, end);
  assert.match(block, /\.pipeline-node\.run::after[^}]*animation:pipPulse 1\.4s infinite/, '光环预绘在 ::after 上，脉冲落在合成器属性');
  assert.ok(!/\.pipeline-node\.run\s*\{[^}]*animation/.test(block), '节点本体不再直接挂动画');
});
