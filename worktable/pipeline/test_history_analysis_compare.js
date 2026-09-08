const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/pipeline.html', 'utf8');

function analysisContext(extra) {
  const start = source.indexOf('function analysisHistoryKey(');
  const end = source.indexOf('/* ---------- 历史 & 统计 ---------- */', start);
  assert.ok(start >= 0 && end > start, '缺少运行历史单双选分析实现');
  const ctx = Object.assign({
    analysisPrompts: {
      log: '日志 {summary} {logFile}',
      prof: '画像 {summary} {profileFile}',
      perf: '诊断 {summary} {archive}',
    },
    DEFAULT_PROMPTS: {},
    labelOf: status => ({ success: '已完成', failed: '错误', aborted: '终止' })[status] || status,
    archiveRootFolder: () => '/archive',
    history: [],
    analysisHistoryKeys: [],
    renderHistory() {},
    alert() {},
    window: { parent: {} },
  }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  return ctx;
}

const runA = {
  no: 101, pipeline: '部署', env: '10.0.0.1', by: '张三', commit: 'aaaa1111',
  status: 'success', dur: '1m20s', time: '09-08 10:00', tag: 'run-a', archive: '/archive/run-a',
};
const runB = {
  no: 102, pipeline: '部署', env: '10.0.0.2', by: '李四', commit: 'bbbb2222',
  status: 'failed', dur: '2m10s', time: '09-08 11:00', tag: 'run-b', archive: '/archive/run-b',
};
const runC = {
  no: 103, pipeline: '部署', env: '10.0.0.3', by: '王五', commit: 'cccc3333',
  status: 'aborted', dur: '30s', time: '09-08 12:00', tag: 'run-c', archive: '/archive/run-c',
};

function functionSource(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '缺少函数 ' + name);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  assert.fail('函数 ' + name + ' 缺少闭合括号');
}

test('分析目标最多选择两条，并保留勾选顺序', () => {
  const alerts = [];
  const ctx = analysisContext({ history: [runA, runB, runC], alert: text => alerts.push(text) });

  assert.equal(ctx.toggleAnalysisHistory(runB, true), true);
  assert.equal(ctx.toggleAnalysisHistory(runA, true), true);
  assert.deepEqual(Array.from(ctx.analysisHistoryKeys), ['tag:run-b', 'tag:run-a']);
  assert.equal(ctx.toggleAnalysisHistory(runC, true), false);
  assert.deepEqual(Array.from(ctx.analysisHistoryKeys), ['tag:run-b', 'tag:run-a']);
  assert.match(alerts[0], /最多选择 2 条/);

  assert.equal(ctx.toggleAnalysisHistory(runB, false), true);
  assert.deepEqual(Array.from(ctx.analysisHistoryKeys), ['tag:run-a']);
});

test('运行历史渲染独立的分析复选框，勾选不触发行回放', () => {
  const rows = [];
  const picks = [];
  const elements = {
    historyTable: { querySelector: () => ({ innerHTML: '', appendChild: row => rows.push(row) }) },
    histFilterTip: { textContent: '' }, histPageInfo: { textContent: '' },
    histPrev: {}, histNext: {}, rowSelTip: { textContent: '' },
  };
  const ctx = {
    history: [runA, runB], analysisHistoryKeys: ['tag:run-b'], selHistoryIdx: -1,
    histPage: 0, histPageSize: 10, histFilter: { kw: '', status: '', pipeline: '' },
    document: { createElement() {
      const listeners = {};
      const pick = { checked: false, addEventListener: (name, fn) => { listeners[name] = fn; } };
      picks.push({ pick, listeners });
      return {
        className: '', innerHTML: '', title: '',
        addEventListener(name, fn) { listeners['row-' + name] = fn; },
        querySelector(selector) { return selector === '[data-hist-analysis]' ? pick : null; },
      };
    } },
    $: id => elements[id] || null,
    filteredHistory: () => ctx.history,
    renderHistFilterOptions() {}, analysisHistoryKey: rec => 'tag:' + rec.tag,
    pruneAnalysisHistory() {},
    selectedAnalysisHistory: () => [runB],
    toggleAnalysisHistory() { return true; },
    labelOf: status => status, fmtHistTime: rec => rec.time,
    esc: value => String(value === undefined ? '' : value),
    enterHistoryReplay() {}, exitHistoryReplay() {}, refreshArchiveTip() {},
  };
  vm.createContext(ctx);
  vm.runInContext(functionSource('renderHistory'), ctx);

  ctx.renderHistory();

  assert.equal(rows.length, 2);
  assert.match(rows[0].innerHTML, /data-hist-analysis/);
  assert.equal(picks[0].pick.checked, false);
  assert.equal(picks[1].pick.checked, true);
  assert.equal(typeof picks[0].listeners.click, 'function');
  let stopped = false;
  picks[0].listeners.click({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
});

test('单选沿用对应分析模板并以该次归档目录为工作目录', () => {
  const ctx = analysisContext();
  const request = ctx.buildAnalysisRequest('log', [runA]);

  assert.equal(request.cwd, '/archive/run-a');
  assert.equal(request.text, '日志 #101 流水线「部署」 环境 10.0.0.1 · 执行人 张三 · 状态 已完成 · 耗时 1m20s · 09-08 10:00 · commit aaaa1111 /archive/run-a/run-run-a.log');
});

test('双选生成 A/B 对比提示并以共同归档根目录为工作目录', () => {
  const ctx = analysisContext();
  const request = ctx.buildAnalysisRequest('prof', [runA, runB]);

  assert.equal(request.cwd, '/archive');
  assert.match(request.text, /运行 A（基准）/);
  assert.match(request.text, /运行 B（对比）/);
  assert.match(request.text, /#101 流水线「部署」/);
  assert.match(request.text, /\/archive\/run-a\/run-run-a\.profile\.json/);
  assert.match(request.text, /#102 流水线「部署」/);
  assert.match(request.text, /\/archive\/run-b\/run-run-b\.profile\.json/);
  assert.match(request.text, /耗时占比|瓶颈/);
  assert.match(request.text, /改善|退化/);
});

test('创建双运行分析会话时把对比提示和共同目录交给工作台桥', async () => {
  const calls = [];
  const ctx = analysisContext({
    window: { parent: { __dshNewChatSessionAt: async (text, cwd) => calls.push({ text, cwd }) } },
  });

  await ctx.createAnalysisChat('perf', [runA, runB]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, '/archive');
  assert.match(calls[0].text, /运行 A（基准）/);
  assert.match(calls[0].text, /运行 B（对比）/);
});
