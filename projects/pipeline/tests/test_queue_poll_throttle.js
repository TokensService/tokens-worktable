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

test('queuePollSig：server.finished 内容纳入签名（新终态出现/TTL 消失/结束时间标签翻转均触发重绘）', () => {
  let label = '刚刚';
  const ctx = loadPullContext({ fmtRelative: () => label, _serverFinishedSeen: {} });
  const clients = [];
  const fin = [{ id: 'srv-1', pipelineId: 'p1', pipelineName: '发布', by: 'alice', source: 'manual', status: 'success', dur: 12, startedAt: 90, endedAt: 100, stages: [] }];
  const base = ctx.queuePollSig(clients, [], []);
  assert.equal(ctx.queuePollSig(clients, [], []), base, 'finished 空数组时签名稳定');
  assert.equal(ctx.queuePollSig(clients), base, 'finished 缺省按空数组处理（旧服务端降级）');
  const withFin = ctx.queuePollSig(clients, [], fin);
  assert.notEqual(withFin, base, '新终态出现触发重绘');
  assert.equal(ctx.queuePollSig(clients, [], JSON.parse(JSON.stringify(fin))), withFin, 'finished 内容相同时签名稳定');
  const changed = JSON.parse(JSON.stringify(fin)); changed[0].status = 'failure';
  assert.notEqual(ctx.queuePollSig(clients, [], changed), withFin, '终态内容变化触发重绘');
  label = '1分钟前';
  assert.notEqual(ctx.queuePollSig(clients, [], fin), withFin, 'endedAt 相对时间标签翻转触发重绘');
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
