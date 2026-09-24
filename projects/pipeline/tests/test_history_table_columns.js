// 运行历史表格不再展示「环境」「Commit」两列：表头 8 列、行渲染无对应单元格、
// 空态 colspan=8、关键字匹配不再命中 env/commit（数据模型保留，回放/重跑/分析不受影响）。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

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

const runA = {
  no: 101, pipeline: '部署', env: '10.0.0.1', by: '张三', commit: 'aaaa1111',
  status: 'success', dur: '1m20s', time: '09-08 10:00', tag: 'run-a',
};

function renderHistoryContext(view) {
  const rows = [];
  const elements = {
    historyTable: { querySelector: () => ({ innerHTML: '', appendChild: row => rows.push(row) }) },
    histFilterTip: { textContent: '' }, histPageInfo: { textContent: '' },
    histPrev: {}, histNext: {}, rowSelTip: { textContent: '' },
  };
  const ctx = {
    history: view, analysisHistoryKeys: [], selHistoryIdx: -1,
    histPage: 0, histPageSize: 10, histFilter: { kw: '', status: '', pipeline: '' },
    document: { createElement() {
      const listeners = {};
      const pick = { checked: false, addEventListener: (name, fn) => { listeners[name] = fn; } };
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
    selectedAnalysisHistory: () => [],
    toggleAnalysisHistory() { return true; },
    labelOf: status => status, fmtHistTime: rec => rec.time,
    esc: value => String(value === undefined ? '' : value),
    enterHistoryReplay() {}, exitHistoryReplay() {}, refreshArchiveTip() {},
  };
  vm.createContext(ctx);
  vm.runInContext(functionSource('renderHistory'), ctx);
  return { ctx, rows };
}

test('运行历史表头不再含「环境」「Commit」列，共 8 列', () => {
  const match = source.match(/<table class="dshell-table" id="historyTable">[\s\S]*?<\/thead>/);
  assert.ok(match, '缺少运行历史表格表头');
  const head = match[0];
  assert.equal((head.match(/<th[\s>]/g) || []).length, 8, '运行历史表头应为 8 列');
  assert.doesNotMatch(head, /<th>环境<\/th>/);
  assert.doesNotMatch(head, /<th>Commit<\/th>/);
  assert.match(head, /<th>执行人<\/th>/);
});

test('关键字输入框占位文案不再提及环境与 Commit', () => {
  const match = source.match(/<input id="histFilterKw"[^>]*>/);
  assert.ok(match, '缺少关键字输入框');
  assert.match(match[0], /placeholder="搜索 #\/流水线\/执行人"/);
  assert.doesNotMatch(match[0], /环境|Commit/);
});

test('运行历史行渲染不再输出环境与 Commit 单元格，每行 8 个单元格', () => {
  const { ctx, rows } = renderHistoryContext([runA]);
  ctx.renderHistory();

  assert.equal(rows.length, 1);
  const html = rows[0].innerHTML;
  assert.equal((html.match(/<td[\s>]/g) || []).length, 8, '每行应为 8 个单元格');
  assert.ok(html.indexOf('10.0.0.1') < 0, '行内不应展示环境');
  assert.ok(html.indexOf('aaaa1111') < 0, '行内不应展示 Commit');
  assert.ok(html.indexOf('#101') >= 0 && html.indexOf('部署') >= 0 && html.indexOf('张三') >= 0,
    '# / 流水线 / 执行人列仍应展示');
});

test('运行历史空态行 colspan=8', () => {
  const { ctx, rows } = renderHistoryContext([]);
  ctx.renderHistory();

  assert.equal(rows.length, 1);
  assert.match(rows[0].innerHTML, /colspan="8"/);
  assert.match(rows[0].innerHTML, /暂无运行历史/);
});

test('关键字筛选不再命中环境与 Commit，仍命中 # / 流水线 / 执行人', () => {
  const ctx = { history: [runA], histFilter: { kw: '', status: '', pipeline: '' } };
  vm.createContext(ctx);
  vm.runInContext(functionSource('filteredHistory'), ctx);

  ctx.histFilter.kw = '10.0.0.1';
  assert.equal(ctx.filteredHistory().length, 0, '关键字不应命中环境');
  ctx.histFilter.kw = 'aaaa1111';
  assert.equal(ctx.filteredHistory().length, 0, '关键字不应命中 Commit');
  ctx.histFilter.kw = 'AAAA';
  assert.equal(ctx.filteredHistory().length, 0, '大小写不敏感同样不得命中 Commit');

  ctx.histFilter.kw = '#101';
  assert.equal(ctx.filteredHistory().length, 1, '关键字仍应命中编号');
  ctx.histFilter.kw = '部署';
  assert.equal(ctx.filteredHistory().length, 1, '关键字仍应命中流水线名');
  ctx.histFilter.kw = '张三';
  assert.equal(ctx.filteredHistory().length, 1, '关键字仍应命中执行人');
});
