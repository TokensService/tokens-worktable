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
  _profState: { checked: true, promise: null, stages: [{ name: '构建', status: 'success', durSec: 9.5 }] },
};

test('rebindHistoryRefreshSelection：列表重排后按稳定主键保留选择、回放对象和懒加载缓存', () => {
  const refreshed = { no: 7, tag: 'stable-run', pipeline: '部署', logs: [{ stage: '构建', logFile: '/new/build.log' }] };
  const ctx = loadHistoryFunctions({
    history: [{ no: 8, tag: 'new-run' }, refreshed],
    selHistoryIdx: 0,
    replayRec: oldRun,
  }, ['analysisHistoryKey', 'applyReplayProfileStages', 'preserveHistoryRuntimeCache', 'rebindHistoryRefreshSelection']);

  const rebound = ctx.rebindHistoryRefreshSelection(oldRun, true);

  assert.equal(rebound, refreshed);
  assert.equal(ctx.selHistoryIdx, 1);
  assert.equal(ctx.replayRec, refreshed);
  assert.equal(refreshed._lc, oldRun._lc);
  assert.equal(refreshed._lm, oldRun._lm);
  assert.equal(refreshed._ll, oldRun._ll);
  assert.equal(refreshed._profChecked, true);
  assert.equal(refreshed._profState, oldRun._profState);
  assert.equal(refreshed.logs[0].status, 'success', '已完成的 profile 校正应在第一次重绘前重放到新记录');
  assert.equal(refreshed.logs[0].dur, 9.5);
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
    analysisHistoryKeys: ['tag:stable-run'], _historyRefreshPromise: null, _historyRefreshNotifyError: false, _historyEtag: '', _historyLightApiMissing: false,
    _detailKey: 'cached-detail',
    fetch: (url, options) => {
      assert.equal(url, '/api/worktable/pipeline/history');
      assert.equal(Object.keys(options.headers).length, 0);
      fetches += 1; return response;
    },
    renderHistory: () => { renders += 1; }, renderStats: () => { renders += 1; }, refreshArchiveTip: () => { renders += 1; },
    rebuildReplayNodes: rec => { assert.equal(rec, refreshed); replayRenders += 1; },
    renderFlow: () => { replayRenders += 1; }, renderDetail: () => { replayRenders += 1; },
    loadReplayLogs: async () => {},
    exitHistoryReplay: () => assert.fail('稳定记录仍存在时不应退出回放'),
    alert: () => assert.fail('成功刷新不应告警'),
  }, [
    'analysisHistoryKey', 'applyReplayProfileStages', 'preserveHistoryRuntimeCache', 'rebindHistoryRefreshSelection',
    'historyPersistSig', 'historyMarkSynced', 'historyForPersist', 'applyHistoryRefreshPayload', 'refreshHistoryFromServer',
  ]);

  const first = ctx.refreshHistoryFromServer(false);
  const second = ctx.refreshHistoryFromServer(true);
  assert.equal(fetches, 1, '已有刷新在途时应复用同一请求');
  release({ ok: true, status: 200, headers: { get: name => name.toLowerCase() === 'etag' ? '"hist-8"' : null }, json: async () => ({ config: { buildNo: 8 }, history: [{ no: 8, tag: 'new-run' }, refreshed] }) });
  assert.equal(await first, true);
  assert.equal(await second, true);

  assert.equal(ctx.histPage, 3, '自动刷新不应把用户强制带回第一页');
  assert.deepEqual(Array.from(ctx.analysisHistoryKeys), ['tag:stable-run']);
  assert.equal(ctx.selHistoryIdx, 1);
  assert.equal(ctx.replayRec, refreshed);
  assert.equal(refreshed._lc, oldRun._lc);
  assert.equal(ctx._detailKey, '');
  assert.equal(ctx._historyEtag, '"hist-8"');
  assert.equal(renders, 3);
  assert.equal(replayRenders, 6, '刷新后先保留当前回放，再在 profile/日志缓存应用完成后校正重绘');
});

test('refreshHistoryFromServer：历史版本未变化时 304 不替换列表也不重绘', async () => {
  const current = { no: 7, tag: 'stable-run' };
  let renders = 0;
  const ctx = loadHistoryFunctions({
    history: [current], buildNo: 7, histClearedAt: 0, selHistoryIdx: -1, replayRec: null,
    _historyRefreshPromise: null, _historyRefreshNotifyError: false, _historyEtag: '"hist-7"', _historyLightApiMissing: false,
    fetch: async (url, options) => {
      assert.equal(url, '/api/worktable/pipeline/history');
      assert.equal(options.headers['If-None-Match'], '"hist-7"');
      return { ok: false, status: 304, headers: { get: () => '"hist-7"' } };
    },
    applyHistoryRefreshPayload: () => assert.fail('304 不应应用历史正文'),
    rebindHistoryRefreshSelection: () => assert.fail('304 不应重绑选择'),
    renderHistory: () => { renders += 1; }, renderStats: () => { renders += 1; }, refreshArchiveTip: () => { renders += 1; },
    alert: () => assert.fail('304 是正常未变化，不应告警'),
  }, ['refreshHistoryFromServer']);

  assert.equal(await ctx.refreshHistoryFromServer(false), true);
  assert.equal(ctx.history[0], current);
  assert.equal(renders, 0);
});

test('refreshHistoryFromServer：200 正文解析失败时不提交新 ETag，下一次仍请求正文', async () => {
  let calls = 0;
  const current = { no: 7, tag: 'stable-run' };
  const ctx = loadHistoryFunctions({
    history: [current], buildNo: 7, histClearedAt: 0, selHistoryIdx: -1, replayRec: null,
    _historyRefreshPromise: null, _historyRefreshNotifyError: false, _historyEtag: '"hist-7"', _historyLightApiMissing: false,
    fetch: async (_url, options) => {
      calls += 1;
      assert.equal(options.headers['If-None-Match'], '"hist-7"', '失败响应不得推进下次请求携带的版本');
      if(calls === 1) return {
        ok: true, status: 200, headers: { get: () => '"hist-8"' },
        json: async () => { throw new Error('truncated json'); },
      };
      return {
        ok: true, status: 200, headers: { get: () => '"hist-8"' },
        json: async () => ({ config: { buildNo: 8 }, history: [{ no: 8, tag: 'new-run' }] }),
      };
    },
    applyHistoryRefreshPayload: state => { ctx.history = state.history; return true; },
    rebindHistoryRefreshSelection: () => null,
    renderHistory: () => {}, renderStats: () => {}, refreshArchiveTip: () => {},
    alert: () => assert.fail('后台刷新解析失败不弹窗'),
  }, ['refreshHistoryFromServer']);

  assert.equal(await ctx.refreshHistoryFromServer(false), false);
  assert.equal(ctx._historyEtag, '"hist-7"');
  assert.equal(await ctx.refreshHistoryFromServer(false), true);
  assert.equal(ctx._historyEtag, '"hist-8"');
  assert.equal(ctx.history[0].tag, 'new-run');
});

test('refreshHistoryFromServer：清空版本保护拒绝正文时不提交该响应的 ETag', async () => {
  const ctx = loadHistoryFunctions({
    history: [], buildNo: 7, histClearedAt: 200, selHistoryIdx: -1, replayRec: null,
    _historyRefreshPromise: null, _historyRefreshNotifyError: false, _historyEtag: '"hist-7"', _historyLightApiMissing: false,
    fetch: async () => ({
      ok: true, status: 200, headers: { get: () => '"hist-stale"' },
      json: async () => ({ config: { buildNo: 8, histClearedAt: 100 }, history: [{ no: 8, tag: 'stale' }] }),
    }),
    applyHistoryRefreshPayload: () => false,
    rebindHistoryRefreshSelection: () => assert.fail('被拒绝的正文不应重绑选择'),
    renderHistory: () => assert.fail('被拒绝的正文不应重绘'),
    renderStats: () => {}, refreshArchiveTip: () => {}, alert: () => {},
  }, ['refreshHistoryFromServer']);

  assert.equal(await ctx.refreshHistoryFromServer(false), false);
  assert.equal(ctx._historyEtag, '"hist-7"');
});

test('refreshHistoryFromServer：轻量历史接口 404（旧版插件无此路由）时降级全量存储接口并记住降级', async () => {
  const current = { no: 7, tag: 'stable-run' };
  const requested = [];
  let renders = 0;
  const ctx = loadHistoryFunctions({
    history: [current], buildNo: 7, histClearedAt: 0, selHistoryIdx: -1, replayRec: null,
    _historyRefreshPromise: null, _historyRefreshNotifyError: false, _historyEtag: '"hist-7"', _historyLightApiMissing: false,
    fetch: async (url, options) => {
      requested.push(url);
      if (requested.length === 1) {
        assert.equal(url, '/api/worktable/pipeline/history');
        assert.equal(options.headers['If-None-Match'], '"hist-7"');
        return { ok: false, status: 404, headers: { get: () => null } };
      }
      assert.equal(url, '/api/worktable/pipeline', '降级后改走旧版插件也有的全量存储接口');
      assert.deepEqual(Object.keys(options.headers), [], '降级请求不携带轻量接口的 ETag');
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ config: { buildNo: 8 }, history: [{ no: 8, tag: 'new-run' }, current] }),
      };
    },
    applyHistoryRefreshPayload: state => { ctx.history = state.history; return true; },
    rebindHistoryRefreshSelection: () => null,
    renderHistory: () => { renders += 1; }, renderStats: () => {}, refreshArchiveTip: () => {},
    alert: () => assert.fail('404 降级是正常兼容路径，不应告警'),
  }, ['refreshHistoryFromServer']);

  assert.equal(await ctx.refreshHistoryFromServer(false), true);
  assert.equal(ctx._historyLightApiMissing, true);
  assert.equal(ctx._historyEtag, '', '全量接口没有 ETag，不得保留轻量接口的版本标识');
  assert.equal(ctx.history[0].tag, 'new-run');
  assert.equal(renders, 1);
  assert.deepEqual(requested, ['/api/worktable/pipeline/history', '/api/worktable/pipeline']);

  assert.equal(await ctx.refreshHistoryFromServer(false), true);
  assert.deepEqual(requested.slice(2), ['/api/worktable/pipeline'], '记住降级后不再请求缺失的轻量路由');
});

test('回放 profile 校正在历史刷新期间完成时，会同步应用到重新绑定的新记录', async () => {
  let releaseProfile;
  const profileResponse = new Promise(resolve => { releaseProfile = resolve; });
  const previous = {
    no: 7, tag: 'stable-run', archive: '/archive/run',
    logs: [{ stage: '构建', status: 'idle', dur: 0, logFile: '/archive/build.log' }],
  };
  const refreshed = {
    no: 7, tag: 'stable-run', archive: '/archive/run',
    logs: [{ stage: '构建', status: 'idle', dur: 0, logFile: '/archive/build.log' }],
  };
  const ctx = loadHistoryFunctions({
    history: [refreshed], selHistoryIdx: 0, replayRec: previous, selectedId: 'build',
    flowStages: () => [{ id: 'build', name: '构建' }],
    loadReplayLog: async () => {},
    fetch: () => profileResponse,
  }, [
    'analysisHistoryKey', 'preserveHistoryRuntimeCache', 'rebindHistoryRefreshSelection',
    'applyReplayProfileStages', 'loadReplayLogs',
  ]);

  const oldLoading = ctx.loadReplayLogs(previous);
  await new Promise(resolve => setImmediate(resolve));
  const rebound = ctx.rebindHistoryRefreshSelection(previous, true);
  const newLoading = ctx.loadReplayLogs(rebound);
  assert.equal(rebound._profState, previous._profState, '新旧记录应共享同一个 profile 加载状态');

  releaseProfile({ ok: true, text: async () => JSON.stringify({
    stages: [{ name: '构建', status: 'success', durSec: 12.5 }],
  }) });
  await Promise.all([oldLoading, newLoading]);

  assert.equal(refreshed.logs[0].status, 'success');
  assert.equal(refreshed.logs[0].dur, 12.5);
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
