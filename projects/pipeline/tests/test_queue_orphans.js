// 运行队列孤儿中断：completed 终态登记（sessionStorage 持久化/60s prune/originQueueId 移交口径）、
// schemaVersion:3 上报、orphans 渲染分组与降级、dismiss 权限与请求、孤儿只读预览 rc、按快照参数重跑。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));   // vm 沙盒产物的原型链与主 realm 不同，深比较前先归一化
function extract(startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start);
  assert.ok(start >= 0 && end > start, startMark + ' not found');
  return source.slice(start, end);
}

/* 假 sessionStorage：记录写入内容，供持久化断言与「刷新后重载」模拟 */
function fakeSessionStorage() {
  const data = new Map();
  return {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: k => { data.delete(k); },
    _data: data,
  };
}

/* ---------- completed 终态登记（pip-qfinished） ---------- */
function loadFinishedRegistry(overrides) {
  const context = Object.assign({ sessionStorage: fakeSessionStorage() }, overrides || {});
  vm.createContext(context);
  vm.runInContext(extract('const QUEUE_FINISHED_TTL_MS', '/* 上报快照体'), context);
  return context;
}

test('终态登记：登记即同步写 sessionStorage，读取 prune 掉超过 60 秒的记录，上限 64 条', () => {
  let now = 1000000;
  const store = fakeSessionStorage();
  const ctx = loadFinishedRegistry({ Date: { now: () => now } , sessionStorage: store });
  ctx.queueFinishedNote('r1');
  ctx.queueFinishedNote('q1');
  assert.deepEqual(JSON.parse(store.getItem('pip-qfinished')).map(e => e.id), ['r1', 'q1'], '登记同步落 sessionStorage');
  assert.deepEqual(plain(ctx.queueFinishedIds()), ['r1', 'q1']);

  now += 61000;   // 超过 60 秒
  assert.deepEqual(plain(ctx.queueFinishedIds()), [], '超过约 60 秒的登记被 prune');

  for (let i = 0; i < 70; i++) ctx.queueFinishedNote('r' + i);
  assert.equal(ctx.queueFinishedIds().length, 64, '登记上限 64 条');
  assert.equal(JSON.parse(store.getItem('pip-qfinished')).length, 64);
});

test('终态登记：刷新后从 sessionStorage 恢复（同标签页 QCLIENT_ID 不变配合），过期条目读取时剔除', () => {
  const store = fakeSessionStorage();
  const now = 2000000;
  store.setItem('pip-qfinished', JSON.stringify([{ id: 'r-old', ts: now - 70000 }, { id: 'r-fresh', ts: now - 1000 }]));
  const ctx = loadFinishedRegistry({ Date: { now: () => now }, sessionStorage: store });
  assert.deepEqual(plain(ctx.queueFinishedIds()), ['r-fresh'], '刷新恢复登记，>60s 的旧记录不参与孤儿豁免');
  ctx.queueFinishedNote();   // 空 id 不登记
  ctx.queueFinishedNote('');
  assert.deepEqual(plain(ctx.queueFinishedIds()), ['r-fresh']);
});

test('终态登记：无 sessionStorage 环境（抽取沙盒）降级为纯内存，不报错', () => {
  const ctx = loadFinishedRegistry();
  delete ctx.sessionStorage;   // vm 全局里再无可访问的 sessionStorage
  ctx.queueFinishedNote('r1');   // 写入失败静默
  assert.deepEqual(plain(ctx.queueFinishedIds()), ['r1']);
});

/* ---------- publishQueue：schemaVersion:3 + completed（含 originQueueId 移交口径） ---------- */
function loadPublishContext(overrides) {
  const calls = [];
  const context = Object.assign({
    activeRuns: [], queue: [], pendingLeaseStarts: [],
    expandRunStages: stages => stages,
    _qPubSig: '', _qPubAt: 0, _qPubWarned: false,
    QCLIENT_ID: 'c1', browserTag: () => 'Chrome·c1',
    sessionStorage: fakeSessionStorage(),
    fetch: (url, options) => { calls.push({ url, options }); return Promise.resolve({}); },
    console,
  }, overrides || {});
  vm.createContext(context);
  vm.runInContext(extract('function localQueueItems', 'function queuePreviewRc'), context);
  vm.runInContext(extract('function queueStagePresence', '/* renderQueue 渲染很频繁'), context);
  return { context, calls };
}

test('publishQueue：PUT 体为 schemaVersion:3 且携带 completed（终态登记 + 在跑运行的 originQueueId 移交）', () => {
  const { context, calls } = loadPublishContext();
  context.activeRuns.push({ id: 'r9', originQueueId: 'q9', pipelineName: '发布', by: 'alice', startTs: 1, stages: [], nodes: {} });
  context.queueFinishedNote('r-done');   // 刚正常完成的运行
  context.publishQueue(true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'PUT');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.schemaVersion, 3);
  assert.equal(body.id, 'c1');
  assert.ok(Array.isArray(body.completed), 'PUT 体携带 completed 数组');
  assert.ok(body.completed.includes('r-done'), 'completed 含刚正常终态化的条目');
  assert.ok(body.completed.includes('q9'), '排队项启动转运行属正常移交：originQueueId 并入 completed，防服务端误判孤儿');
  assert.equal(body.runs[0].id, 'r9');
});

/* ---------- 孤儿预览 rc（orphanPreviewRc / focusOrphanQueueItem） ---------- */
function loadOrphanPreviewContext() {
  const calls = { focus: [] };
  const context = {
    GITURL: 'g', DEFAULT_IMAGE: 'img',
    viewRc: null,
    remoteOrphans: [],
    expandRunStages: stages => stages,
    focusRun: rc => { calls.focus.push(rc); context.viewRc = rc; },
    // applyOrphanPreviewRefresh 自愈所需全局
    syncViewRun: () => {}, applyRunOverall: () => {}, refreshArchiveTip: () => {}, resetNodes: () => { calls.reset = (calls.reset || 0) + 1; },
    $: () => ({ disabled: false }),
    console,
  };
  vm.createContext(context);
  vm.runInContext(extract('function queueStagePresence', '/* 最近正常终态登记'), context);   // queueStagePresence/queueNodePresence/queuePresenceEntry
  vm.runInContext(extract('function localQueueItems', '/* ---------- 服务端权威运行队列实时同步'), context);
  return { context, calls };
}

const orphanRun = {
  id: 'r1', ownerId: 'abc123', ownerLabel: 'Chrome·c123', kind: 'running', orphanedAt: 500,
  pipelineId: 'p1', pipelineName: '发布', by: 'alice', source: 'manual', startedAt: 100,
  env: '10.0.0.1', repoName: 'app', branch: 'dev', strategy: 'rolling',
  stages: [{ id: 's1', name: '构建' }, { id: 's2', name: '部署' }],
  nodes: { s1: { status: 'success', progress: 100, dur: 3 }, s2: { status: 'running', progress: 40, dur: 8 } },
};

test('orphanPreviewRc：阶段/节点来自最后已知快照，rc 带只读标记（remotePreview+orphanPreview+over）', () => {
  const { context } = loadOrphanPreviewContext();
  const rc = context.orphanPreviewRc(orphanRun);
  assert.equal(rc.remotePreview, true);
  assert.equal(rc.orphanPreview, true, '孤儿预览标记（applyRemoteQueuePreviewRefresh 据此跳过，preview 自愈由 applyOrphanPreviewRefresh 负责）');
  assert.equal(rc.over, true, '中断条目不进入本页运行引擎');
  assert.equal(rc.id, 'orphan:abc123:r1');
  assert.equal(rc.remoteClientId, 'abc123');
  assert.equal(rc.remoteItemId, 'r1');
  assert.equal(rc.remoteKind, 'running');
  assert.deepEqual(rc.stages.map(s => s.id), ['s1', 's2']);
  assert.equal(rc.nodes.s1.status, 'success');
  assert.equal(rc.nodes.s2.progress, 40);
  assert.equal(rc.selId, 's1');
  assert.equal(rc.startTs, 100, '运行中断条目取 startedAt');
  assert.match(rc.overall.txt, /已中断/);
  assert.match(rc.overall.txt, /只读/);
});

test('focusOrphanQueueItem：点击聚焦孤儿只读预览，重复点击不重建；applyOrphanPreviewRefresh 在条目消失时自愈回空闲编排', () => {
  const { context, calls } = loadOrphanPreviewContext();
  context.remoteOrphans.push(orphanRun);
  context.focusOrphanQueueItem('abc123', 'r1');
  assert.equal(calls.focus.length, 1);
  assert.equal(context.viewRc.orphanPreview, true);
  context.focusOrphanQueueItem('abc123', 'r1');   // 已在预览：不重复重建
  assert.equal(calls.focus.length, 1);
  context.focusOrphanQueueItem('abc123', 'missing');   // 不存在：忽略
  assert.equal(calls.focus.length, 1);

  context.applyOrphanPreviewRefresh();
  assert.equal(context.viewRc.orphanPreview, true, '孤儿仍在登记簿：预览保持');
  context.remoteOrphans.length = 0;   // 被 dismiss / 复活消失
  context.applyOrphanPreviewRefresh();
  assert.equal(context.viewRc, null, '孤儿消失后编排区自愈回空闲编排');
  assert.equal(calls.reset, 1);
});

test('detailLogLinesFor：孤儿预览的详情给出中断说明，不承诺拉取日志', () => {
  const start = source.indexOf('function detailLogLinesFor');
  const end = source.indexOf('\n}', start) + 3;
  assert.ok(start >= 0 && end > start);
  const context = { DETAIL_LOG_LIMIT: { maxLines: 10, maxChars: 1024 } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const lines = context.detailLogLinesFor({ id: 's1' }, { remotePreview: true, orphanPreview: true }, { status: 'running' });
  assert.match(lines[0], /执行中断/);
  assert.match(lines[0], /日志不可拉取/);
  assert.match(lines[0], /归档目录/);
});

/* ---------- dismiss / rerun 动作 ---------- */
function loadOrphanActionContext(overrides) {
  const calls = { fetch: [], pull: 0, alert: [], run: [], tip: [] };
  const context = Object.assign({
    remoteOrphans: [orphanRun],
    findPipeline: id => (id === 'p1' ? { id: 'p1', name: '发布', stages: [] } : null),
    environments: [{ id: 'e1', ip: '10.0.0.1', name: '节点1' }],
    runPipeline: opts => { calls.run.push(opts); return true; },
    flashRunTip: msg => { calls.tip.push(msg); },
    queue: [], QUEUE_CAP: 16,
    alert: msg => { calls.alert.push(msg); },
    fetch: (url, options) => { calls.fetch.push({ url, options }); return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, state: 'dismissed' }) }); },
    pullRemoteQueue: async () => { calls.pull += 1; },
    console,
  }, overrides || {});
  vm.createContext(context);
  vm.runInContext(extract('function localQueueItems', '/* ---------- 服务端权威运行队列实时同步'), context);   // orphanQueueItem 所在块
  vm.runInContext(extract('async function dismissOrphanQueueItem', 'async function cancelServerRun'), context);
  return { context, calls };
}

test('dismissOrphanQueueItem：POST dismiss 参数正确，成功/404 均重拉快照', async () => {
  const { context, calls } = loadOrphanActionContext();
  await context.dismissOrphanQueueItem('abc123', 'r1');
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, '/api/worktable/pipeline/queue');
  assert.equal(calls.fetch[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls.fetch[0].options.body), { action: 'dismiss', ownerId: 'abc123', id: 'r1' });
  assert.equal(calls.pull, 1);

  const missing = loadOrphanActionContext({
    fetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({ ok: false, state: 'missing' }) }),
  });
  const result = await missing.context.dismissOrphanQueueItem('abc123', 'r1');
  assert.equal(result.state, 'missing', '已被移除（404）按已了结处理，不报错');
  assert.equal(missing.calls.pull, 1);
  assert.equal(missing.calls.alert.length, 0);
});

test('rerunOrphanQueueItem：按孤儿快照参数重新发起运行（env 字符串映射回节点，匹配不到兜底），成功后顺手 dismiss', async () => {
  const { context, calls } = loadOrphanActionContext();
  context.remoteOrphans[0] = Object.assign({}, orphanRun, { env: '10.0.0.1，10.0.0.9' });
  context.rerunOrphanQueueItem('abc123', 'r1');
  assert.equal(calls.run.length, 1);
  const opts = calls.run[0];
  assert.equal(opts.pipelineId, 'p1');
  assert.equal(opts.pipelineName, '发布');
  assert.deepEqual(opts.stages, orphanRun.stages, 'stages 快照（已是预设任务展开后的编排）直接入队');
  assert.equal(opts.branch, 'dev');
  assert.equal(opts.strategy, 'rolling');
  assert.equal(opts.source, 'manual', '重跑是一次新的手动运行（执行人取当前登录用户）');
  assert.deepEqual(plain(opts.envs), [{ id: 'e1', ip: '10.0.0.1', name: '节点1' }, { id: '', ip: '10.0.0.9', name: '10.0.0.9' }],
    'env 按「，」拆 IP 精确匹配节点列表；匹配不到用 {id:\'\',ip,name:ip} 兜底');
  await Promise.resolve();
  await new Promise(r => setImmediate(r));
  assert.equal(calls.fetch.length, 1, '重跑成功后顺手 dismiss 该孤儿');
  assert.deepEqual(JSON.parse(calls.fetch[0].options.body), { action: 'dismiss', ownerId: 'abc123', id: 'r1' });
});

test('rerunOrphanQueueItem：流水线已删除则提示且不入队；队列满/未登录不入队也不 dismiss', async () => {
  const gone = loadOrphanActionContext({ findPipeline: () => null });
  gone.context.rerunOrphanQueueItem('abc123', 'r1');
  assert.equal(gone.calls.run.length, 0);
  assert.match(gone.calls.alert[0], /可能已删除/);
  assert.equal(gone.calls.fetch.length, 0, '未重跑成功不得 dismiss');

  const full = loadOrphanActionContext();
  full.context.runPipeline = opts => { full.calls.run.push(opts); return false; };   // 本地队列已满
  full.context.rerunOrphanQueueItem('abc123', 'r1');
  assert.equal(full.calls.run.length, 1);
  assert.match(full.calls.alert[0], /队列已满/);
  assert.equal(full.calls.fetch.length, 0, '入队失败不得 dismiss');
});

/* ---------- 孤儿分组渲染（renderQueue） ---------- */
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.handlers = {};
    this._html = '';
    this.className = '';
    this.title = '';
    this.textContent = '';
    this.disabled = false;
    this.style = {};
  }
  set innerHTML(value) { this._html = value; if (!value) this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(node) { this.children.push(node); }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  querySelectorAll(selector) {
    const attr = /^\[([^\]]+)\]$/.exec(selector)[1];
    const found = [];
    this.children.forEach(row => {
      const re = /<(span|button)\s+([^>]*)>/g;
      let match;
      while ((match = re.exec(row.innerHTML))) {
        const valueMatch = new RegExp(attr + '="([^"]+)"').exec(match[2]);
        if (!valueMatch) continue;
        const key = attr + ':' + valueMatch[1];
        row._els = row._els || {};
        const el = row._els[key] || new FakeNode(match[1]);   // 按行缓存：wiring 绑定与断言点击拿到同一元素
        const attributes = {};
        for (const item of match[2].matchAll(/([\w:-]+)="([^"]*)"/g)) attributes[item[1]] = item[2];
        el.attributes = Object.assign({}, el.attributes, attributes);
        el.getAttribute = name => (el.attributes || {})[name] || null;
        row._els[key] = el;
        found.push(el);
      }
    });
    return found;
  }
}

function makeQueueContext(overrides) {
  const list = new FakeNode('div');
  const els = { queueList: list, queueCount: new FakeNode('span'), queueStatus: new FakeNode('span'), stopBtn: new FakeNode('button') };
  const calls = { cancel: [], dismiss: [], rerun: [], focusOrphan: [], publish: 0, alert: [] };
  const context = Object.assign({
    document: {
      createElement: tag => new FakeNode(tag),
      querySelectorAll: () => [],
    },
    $: id => els[id] || new FakeNode('div'),
    queue: [], pendingLeaseStarts: [], activeRuns: [], viewRc: null, running: false, remoteQueueClients: [],
    remoteOrphans: [],
    queueReasonOpen: new Set(), MAX_ACTIVE_RUNS: 4,
    esc: String, sourceLabel: s => (s === 'manual' ? '手动' : s), fmtRelative: () => '刚刚',
    runInfoLine: () => '<div class="dshell-muted">info</div>',
    drainQueue: () => {}, cancelQueue: id => calls.cancel.push(id), abortRun: () => {}, cancelServerRun: () => {},
    canControlRun: () => true,
    focusRun: () => {}, focusQueueItem: () => {}, focusRemoteQueueItem: () => {},
    focusOrphanQueueItem: (owner, id) => calls.focusOrphan.push({ owner, id }),
    dismissOrphanQueueItem: (owner, id) => calls.dismiss.push({ owner, id }),
    rerunOrphanQueueItem: (owner, id) => calls.rerun.push({ owner, id }),
    orphanQueueItem: (owner, id) => context.remoteOrphans.find(o => o.ownerId === owner && o.id === id) || null,
    findPipeline: id => (id === 'p1' ? { id: 'p1' } : null),
    scheduleQueuePublish: () => { calls.publish++; },
    refreshPipelineQueueCounts: () => {},
    syncViewRun: () => {}, applyRunOverall: () => {}, refreshArchiveTip: () => {}, resetNodes: () => {},
    alert: msg => calls.alert.push(msg),
    console,
  }, overrides || {});
  vm.createContext(context);
  vm.runInContext(extract('function localQueueItems', 'function queuePreviewRc'), context);
  vm.runInContext(extract('function remoteQueueDetailAvailable', 'function remoteQueuePreviewRc'), context);
  vm.runInContext(extract('function remoteQueueViewAttrs', 'function renderQueue(){'), context);
  vm.runInContext(extract('function renderQueue(){', '/* ---------- 运行引擎'), context);
  return { context, list, els, calls };
}

test('renderQueue：orphans 渲染「已中断」分组（分隔行 + 徽标 + 计数），内容进头部状态', () => {
  const { context, list, els } = makeQueueContext();
  context.remoteOrphans.push(orphanRun, Object.assign({}, orphanRun, { id: 'q2', kind: 'queued', queuedAt: 200, ownerId: 'def456', ownerLabel: 'Edge·d456' }));
  context.renderQueue();
  assert.equal(els.queueCount.textContent, '(2 项)', '孤儿计入运行队列头部计数');
  assert.match(els.queueStatus.textContent, /已中断 2/);
  assert.equal(els.queueStatus.style.color, 'var(--st-err)', '有中断登记时头部徽标转错误色');
  assert.match(list.children[0].innerHTML, /已中断（页面刷新\/关闭）/);
  assert.match(list.children[0].innerHTML, /自己页面刷新或关闭导致中断的运行也会列在这里/);
  assert.match(list.children[1].innerHTML, /\[Chrome·c123\]/);
  assert.match(list.children[1].innerHTML, /alice · 发布/);
  assert.match(list.children[1].innerHTML, />已中断<\/span>/);
  assert.match(list.children[2].innerHTML, />排队中断<\/span>/, 'kind==queued 的孤儿文字为「排队中断」');
  assert.equal(list.style.display, '', '有孤儿时明细列表展开');
});

test('renderQueue：孤儿条目的查看/重跑/移除接线；流水线已删除时重跑置灰；无权限移除不发请求并提示', () => {
  const { context, list, calls } = makeQueueContext();
  context.remoteOrphans.push(orphanRun, Object.assign({}, orphanRun, { id: 'q-gone', pipelineId: 'p-gone' }));
  context.renderQueue();

  const views = list.querySelectorAll('[data-qorphan-view]');
  assert.equal(views.length, 2);
  views[0].handlers.click();
  assert.deepEqual(calls.focusOrphan, [{ owner: 'abc123', id: 'r1' }]);

  const reruns = list.querySelectorAll('[data-qorphan-rerun]');
  assert.equal(reruns.length, 2);
  reruns[0].handlers.click();
  assert.deepEqual(calls.rerun, [{ owner: 'abc123', id: 'r1' }]);
  const goneRow = list.children[2].innerHTML;
  assert.match(goneRow, /data-qorphan-rerun="q-gone"[^>]*disabled/, '流水线已删除的孤儿：重跑按钮置灰');
  assert.match(goneRow, /可能已删除|无法重跑/);

  const dismisses = list.querySelectorAll('[data-qorphan-dismiss]');
  assert.equal(dismisses.length, 2);
  dismisses[0].handlers.click();
  assert.deepEqual(calls.dismiss, [{ owner: 'abc123', id: 'r1' }]);

  // 无权限（非 admin 且非本人署名）：alert 提示且不发 dismiss
  const denied = makeQueueContext({ canControlRun: by => by === 'tester' });
  denied.context.remoteOrphans.push(orphanRun);   // by=alice
  denied.context.renderQueue();
  denied.list.querySelectorAll('[data-qorphan-dismiss]')[0].handlers.click();
  assert.equal(denied.calls.dismiss.length, 0, '无权限时不发请求');
  assert.match(denied.calls.alert[0], /无权限/);
});

test('renderQueue：orphans 为空/缺省时不渲染分组不报错（旧服务端优雅降级），且末尾恢复在场防抖上报', () => {
  const { context, list, els, calls } = makeQueueContext();
  context.renderQueue();
  assert.equal(list.children.length, 0);
  assert.equal(list.style.display, 'none');
  assert.equal(els.queueCount.textContent, '');
  assert.equal(els.queueStatus.textContent, '空闲');
  assert.equal(calls.publish, 1, 'renderQueue 末尾恢复 scheduleQueuePublish（队列/运行态每次重绘都可能变化）');
});

/* ---------- 轮询消费 orphans（pullRemoteQueue / queuePollSig） ---------- */
function loadPullContext(overrides) {
  const calls = { render: 0, orphanRefresh: 0 };
  const context = Object.assign({
    QCLIENT_ID: 'self', remoteQueueClients: [], remoteOrphans: [], viewRc: null,
    fetch: async () => ({ ok: false }),
    planActiveSig: () => '', _planActiveSig: '', renderPlanList: () => {},
    applyRemoteQueuePreviewRefresh: () => {}, applyOrphanPreviewRefresh: () => { calls.orphanRefresh += 1; },
    pullRemoteQueueLog: async () => null,
    renderQueue: () => { calls.render += 1; },
  }, overrides || {});
  vm.createContext(context);
  vm.runInContext(extract('/* 拉取服务端权威队列及旧标签页', "$('queueRefresh')"), context);
  return { context, calls };
}

test('pullRemoteQueue：orphans 入签名并入 remoteOrphans，内容变化触发重绘；缺键（旧服务端）跳过不报错', async () => {
  const payload = { clients: [], server: { id: 'server', label: '服务端', runs: [], queue: [] } };   // 无 orphans 键：旧服务端
  const { context, calls } = loadPullContext({
    fetch: async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(payload)) }),
  });
  await context.pullRemoteQueue();
  assert.equal(calls.render, 1, '首轮建立基线签名正常重绘（既有语义）');
  assert.deepEqual(context.remoteOrphans, [], '旧服务端无 orphans 键：保持空数组优雅降级');
  assert.equal(calls.orphanRefresh, 1);

  payload.orphans = [orphanRun];
  await context.pullRemoteQueue();
  assert.equal(calls.render, 2, 'orphans 出现触发重绘');
  assert.equal(context.remoteOrphans.length, 1);
  assert.equal(plain(context.remoteOrphans)[0].id, 'r1');
  assert.equal(calls.orphanRefresh, 2, '孤儿预览自愈每轮内容变化时执行');

  await context.pullRemoteQueue();
  assert.equal(calls.render, 2, 'orphans 内容未变时跳过重绘');

  payload.orphans = [];
  await context.pullRemoteQueue();
  assert.equal(calls.render, 3, 'orphans 清空（dismiss/复活）同样触发重绘');
  assert.deepEqual(plain(context.remoteOrphans), []);
});

test('queuePollSig：orphans 内容纳入签名（新增/消失均改变签名）', () => {
  const { context } = loadPullContext({ fmtRelative: () => '刚刚' });
  const clients = [];
  const base = context.queuePollSig(clients, []);
  assert.equal(context.queuePollSig(clients, []), base);
  assert.notEqual(context.queuePollSig(clients, [orphanRun]), base, '孤儿出现触发重绘');
  assert.notEqual(context.queuePollSig(clients, undefined) === base, false, 'orphans 缺省按空数组处理（旧服务端降级）');
});

/* ---------- 心跳与 pagehide 最终快照接线 ---------- */
test('在场保活心跳与 pagehide 最终快照接线：10s 心跳不随页面隐藏暂停，beacon 携带 completed', () => {
  const start = source.indexOf('const QUEUE_PRESENCE_HEARTBEAT_MS');
  assert.ok(start >= 0, '缺少在场保活心跳');
  const tail = source.slice(start);
  assert.match(tail, /setInterval\(\(\)=>\{ try\{ publishQueue\(false\); \}catch\(e\)\{\} \},QUEUE_PRESENCE_HEARTBEAT_MS\)/);
  assert.match(tail, /QUEUE_PRESENCE_HEARTBEAT_MS=10000/, '10 秒心跳兜底服务端 45 秒 TTL');
  const intervalBlock = tail.slice(0, tail.indexOf("window.addEventListener('pagehide'"));
  assert.ok(!/document\.hidden/.test(intervalBlock), '心跳不随 document.hidden 暂停（页面隐藏时执行仍在继续，停心跳会被误判失联）');
  assert.match(tail, /window\.addEventListener\('pagehide'/);
  assert.match(tail, /navigator\.sendBeacon\('\/api\/worktable\/pipeline\/queue', new Blob\(\[JSON\.stringify\(queuePublishBody\(\)\)\]/,
    'pagehide 用 sendBeacon 发最终快照（queuePublishBody 含 completed）');
});
