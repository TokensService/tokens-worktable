// 运行历史自动刷新：保留分页、稳定选择与回放缓存，并避免后台标签页无效轮询。
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
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  assert.fail('函数 ' + name + ' 缺少闭合括号');
}

function loadHistoryFunctions(ctx, names) {
  vm.createContext(ctx);
  names.forEach(name => vm.runInContext(functionSource(name), ctx));
  return ctx;
}

const oldRun = {
  no: 7, tag: 'stable-run', pipeline: '部署', logs: [{ stage: '构建', logFile: '/old/build.log' }],
  _lc: { 构建: 'cached tail' }, _lm: { 构建: { truncated: true } }, _ll: { 构建: Promise.resolve() }, _profChecked: true,
};

test('rebindHistoryRefreshSelection：列表重排后按稳定主键保留选择、回放对象和懒加载缓存', () => {
  const refreshed = { no: 7, tag: 'stable-run', pipeline: '部署', logs: [{ stage: '构建', logFile: '/new/build.log' }] };
  const ctx = loadHistoryFunctions({
    history: [{ no: 8, tag: 'new-run' }, refreshed],
    selHistoryIdx: 0,
    replayRec: oldRun,
  }, ['analysisHistoryKey', 'preserveHistoryRuntimeCache', 'rebindHistoryRefreshSelection']);

  const rebound = ctx.rebindHistoryRefreshSelection(oldRun, true);

  assert.equal(rebound, refreshed);
  assert.equal(ctx.selHistoryIdx, 1);
  assert.equal(ctx.replayRec, refreshed);
  assert.equal(refreshed._lc, oldRun._lc);
  assert.equal(refreshed._lm, oldRun._lm);
  assert.equal(refreshed._ll, oldRun._ll);
  assert.equal(refreshed._profChecked, true);
});

test('refreshHistoryFromServer：自动刷新合并在途请求并保持页码、分析勾选和当前回放', async () => {
  let release;
  let fetches = 0;
  let renders = 0;
  let replayRenders = 0;
  const refreshed = { no: 7, tag: 'stable-run', pipeline: '部署', logs: [{ stage: '构建', logFile: '/new/build.log' }] };
  const response = new Promise(resolve => { release = resolve; });
  const ctx = loadHistoryFunctions({
    history: [oldRun], buildNo: 7, histClearedAt: 0,
    selHistoryIdx: 0, replayRec: oldRun, histPage: 3,
    analysisHistoryKeys: ['tag:stable-run'], _historyRefreshPromise: null, _historyRefreshNotifyError: false,
    _detailKey: 'cached-detail',
    fetch: () => { fetches += 1; return response; },
    renderHistory: () => { renders += 1; }, renderStats: () => { renders += 1; }, refreshArchiveTip: () => { renders += 1; },
    rebuildReplayNodes: rec => { assert.equal(rec, refreshed); replayRenders += 1; },
    renderFlow: () => { replayRenders += 1; }, renderDetail: () => { replayRenders += 1; },
    exitHistoryReplay: () => assert.fail('稳定记录仍存在时不应退出回放'),
    alert: () => assert.fail('成功刷新不应告警'),
  }, [
    'analysisHistoryKey', 'preserveHistoryRuntimeCache', 'rebindHistoryRefreshSelection',
    'applyHistoryRefreshPayload', 'refreshHistoryFromServer',
  ]);

  const first = ctx.refreshHistoryFromServer(false);
  const second = ctx.refreshHistoryFromServer(true);
  assert.equal(fetches, 1, '已有刷新在途时应复用同一请求');
  release({ ok: true, json: async () => ({ config: { buildNo: 8 }, history: [{ no: 8, tag: 'new-run' }, refreshed] }) });
  assert.equal(await first, true);
  assert.equal(await second, true);

  assert.equal(ctx.histPage, 3, '自动刷新不应把用户强制带回第一页');
  assert.deepEqual(Array.from(ctx.analysisHistoryKeys), ['tag:stable-run']);
  assert.equal(ctx.selHistoryIdx, 1);
  assert.equal(ctx.replayRec, refreshed);
  assert.equal(refreshed._lc, oldRun._lc);
  assert.equal(ctx._detailKey, '');
  assert.equal(renders, 3);
  assert.equal(replayRenders, 3);
});

test('startHistoryAutoRefresh：每 3 秒仅在页面可见时刷新，并由初始加载完成后启动', async () => {
  let intervalCalls = 0;
  let callback = null;
  let refreshes = 0;
  const ctx = loadHistoryFunctions({
    document: { hidden: true },
    HISTORY_REFRESH_MS: 3000, _historyRefreshTimer: null,
    setInterval(fn, ms) { intervalCalls += 1; callback = fn; assert.equal(ms, 3000); return 19; },
    refreshHistoryFromServer: async manual => { assert.equal(manual, false); refreshes += 1; },
  }, ['startHistoryAutoRefresh']);

  ctx.startHistoryAutoRefresh();
  ctx.startHistoryAutoRefresh();
  assert.equal(intervalCalls, 1, '重复初始化不能注册多个定时器');
  callback();
  assert.equal(refreshes, 0, '后台标签页暂停轮询');
  ctx.document.hidden = false;
  callback();
  assert.equal(refreshes, 1);
  assert.match(source, /loadServerState\(\)\.finally\(\(\)=>\{\s*scheduleGpuRefresh\(\);\s*startHistoryAutoRefresh\(\);\s*\}\)/);
});
