// 运行历史「环境节点」列：优先展示记录 envNodes（{name,ip,nodeIp}），无该字段的遗留记录
// 回退解析 rec.env（中文/英文逗号拆分，IP 串/环境名字符串都直接展示），两者皆空显示 —；
// 文本超 2 个折叠「A、B 等N个」，title 逐行「节点名（ip）」；finish() 写入侧按运行上下文
// rc.envs 映射 envNodes（丢 name/ip 均空条目、截 50 条、绝不含 user/pass）。
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

function loadCell() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(functionSource('historyEnvNodesCell'), ctx);
  return ctx.historyEnvNodesCell;
}

/* ---------- 展示侧：historyEnvNodesCell ---------- */

test('1 个节点：文本为节点名，title 为「节点名（ip）」', () => {
  const cell = loadCell();
  const r = cell({ envNodes: [{ name: '生产', ip: '192.168.1.1', nodeIp: '10.244.0.7' }] });
  assert.equal(r.text, '生产');
  assert.equal(r.title, '生产（192.168.1.1）');
});

test('2 个节点：文本以「、」连接，title 逐行', () => {
  const cell = loadCell();
  const r = cell({ envNodes: [{ name: '生产', ip: '10.0.0.1' }, { name: '灾备', ip: '10.0.0.2' }] });
  assert.equal(r.text, '生产、灾备');
  assert.equal(r.title, '生产（10.0.0.1）\n灾备（10.0.0.2）');
});

test('3 个及以上节点：文本折叠为「A、B 等N个」，title 仍逐行全量', () => {
  const cell = loadCell();
  const envNodes = [
    { name: '生产', ip: '10.0.0.1' }, { name: '灾备', ip: '10.0.0.2' }, { name: '测试', ip: '10.0.0.3' },
  ];
  const r = cell({ envNodes });
  assert.equal(r.text, '生产、灾备 等3个');
  assert.equal(r.title, '生产（10.0.0.1）\n灾备（10.0.0.2）\n测试（10.0.0.3）');
  const many = cell({ envNodes: envNodes.concat([{ name: '预发', ip: '10.0.0.4' }]) });
  assert.equal(many.text, '生产、灾备 等4个');
});

test('节点 name 为空时文本回退 ip，title 省略节点名部分', () => {
  const cell = loadCell();
  const r = cell({ envNodes: [{ name: '', ip: '192.168.1.1', nodeIp: '' }] });
  assert.equal(r.text, '192.168.1.1');
  assert.equal(r.title, '（192.168.1.1）');
});

test('name 与 ip 均为空的 envNodes 条目被丢弃；丢空后无剩余显示 —', () => {
  const cell = loadCell();
  const r = cell({ envNodes: [{ name: '', ip: '', nodeIp: '10.244.0.1' }] });
  assert.equal(r.text, '—');
  assert.equal(r.title, '');
  const r2 = cell({ envNodes: [{ name: '', ip: '', nodeIp: '' }, { name: '生产', ip: '10.0.0.1' }] });
  assert.equal(r2.text, '生产');
  assert.equal(r2.title, '生产（10.0.0.1）');
});

test('遗留记录无 envNodes：回退解析 env 的 IP 串（兼容中文/英文逗号）', () => {
  const cell = loadCell();
  const r = cell({ env: '10.0.0.1，10.0.0.2' });
  assert.equal(r.text, '10.0.0.1、10.0.0.2');
  assert.equal(r.title, '10.0.0.1\n10.0.0.2');
  const r2 = cell({ env: '10.0.0.1,10.0.0.2' });
  assert.equal(r2.text, '10.0.0.1、10.0.0.2');
});

test('遗留记录无 envNodes：回退解析 env 的环境名字符串', () => {
  const cell = loadCell();
  const r = cell({ env: 'prod' });
  assert.equal(r.text, 'prod');
  assert.equal(r.title, 'prod');
});

test('envNodes 为空数组或 env 为空串：显示 —', () => {
  const cell = loadCell();
  const cases = [{ envNodes: [] }, { env: '' }, {}];
  for (const c of cases) {
    const r = cell(c);
    assert.equal(r.text, '—', JSON.stringify(c));
    assert.equal(r.title, '', JSON.stringify(c));
  }
});

/* ---------- 展示侧：经 renderHistory 渲染的行内单元格 ---------- */

function renderRows(view) {
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
      const pick = { checked: false, addEventListener() {} };
      return {
        className: '', innerHTML: '', title: '',
        addEventListener() {},
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
    esc: value => String(value === undefined ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    enterHistoryReplay() {}, exitHistoryReplay() {}, refreshArchiveTip() {},
  };
  vm.createContext(ctx);
  vm.runInContext(functionSource('historyEnvNodesCell') + '\n' + functionSource('renderHistory'), ctx);
  ctx.renderHistory();
  return rows.map(row => row.innerHTML);
}

test('行内单元格：envNodes 3 节点折叠展示，title 逐行（换行原样进属性）', () => {
  const [html] = renderRows([{
    no: 7, pipeline: '部署', by: 'alice', status: 'success', dur: '1m', time: '今天 10:00',
    envNodes: [{ name: 'A', ip: '1.1.1.1' }, { name: 'B', ip: '2.2.2.2' }, { name: 'C', ip: '3.3.3.3' }],
  }]);
  assert.ok(html.indexOf('A、B 等3个') >= 0, '单元格文本折叠');
  assert.ok(html.indexOf('title="A（1.1.1.1）\nB（2.2.2.2）\nC（3.3.3.3）"') >= 0, 'title 逐行');
});

test('行内单元格：遗留记录按 env 回退展示；皆空显示 —（无 title 属性）', () => {
  const [legacy] = renderRows([{ no: 6, pipeline: '部署', by: 'alice', status: 'success', dur: '1m', time: '今天 10:00', env: '10.0.0.1，10.0.0.2' }]);
  assert.ok(legacy.indexOf('>10.0.0.1、10.0.0.2</td>') >= 0, '遗留 IP 串回退展示');
  assert.ok(legacy.indexOf('title="10.0.0.1\n10.0.0.2"') >= 0, '遗留记录 title 逐行');
  const [empty] = renderRows([{ no: 5, pipeline: '部署', by: 'alice', status: 'failed', dur: '1m', time: '今天 10:00' }]);
  assert.ok(empty.indexOf('<td class="dshell-muted">—</td>') >= 0, '皆空显示 — 且不带 title');
});

/* ---------- 写入侧：finish() 组装 rec.envNodes ---------- */

function makeFinishContext() {
  const context = {
    activeRuns: [], viewRc: null,
    taskPromFinalize: () => {},
    syncRunState: () => {},
    $: () => ({ disabled: false }),
    viewActive: () => false,
    refreshArchiveTip: () => {},
    rcOverall: () => {},
    buildNo: 0,
    history: [], histPage: 0, selHistoryIdx: 0,
    renderHistory: () => {}, renderStats: () => {}, persistState: () => {},
    archiveRun: () => {}, renderDetail: () => {},
    drainQueue: () => {}, renderQueue: () => {},
    fmtDur: () => '1s', nowHM: () => '10:00',
    promSnapshotForRun: () => null, collectRunLogs: () => [],
    archiveFolderFor: () => null,
    curPipeline: () => ({ name: 'PL' }),
    releaseNodeLease: () => {},
    clearInterval: () => {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(functionSource('historyEnvNodesOf') + '\n' + functionSource('finish'), context);
  return context;
}

function makeRc(extra) {
  return Object.assign({
    id: 'r1', over: false, timer: null, stages: [], nodes: {},
    startTs: Date.now() - 1000, by: 'alice', pipelineName: 'PL',
    env: '10.0.0.1，10.0.0.2', commit: 'abcdef123', tag: 't', vars: {},
  }, extra);
}

test('finish()：带选中节点的运行产出 envNodes（丢空条目、含 nodeIp、不含 user/pass）', () => {
  const ctx = makeFinishContext();
  const rc = makeRc({ envs: [
    { id: 'e1', name: '生产', ip: '10.0.0.1', nodeIp: '192.168.1.1', user: 'root', pass: 'secret' },
    { id: 'e2', name: '', ip: '10.0.0.2', nodeIp: '', user: 'u2', pass: 'p2' },
    { id: 'e3', name: '', ip: '', nodeIp: '10.244.0.9', user: 'u3', pass: 'p3' },   // name/ip 均空 → 丢弃
  ] });
  ctx.activeRuns.push(rc);
  ctx.finish(rc, 'success');

  assert.equal(ctx.history.length, 1);
  const rec = ctx.history[0];
  assert.equal(JSON.stringify(rec.envNodes), JSON.stringify([
    { name: '生产', ip: '10.0.0.1', nodeIp: '192.168.1.1' },
    { name: '', ip: '10.0.0.2', nodeIp: '' },
  ]));
  const serialized = JSON.stringify(rec.envNodes);
  for (const leak of ['secret', 'root', 'u2', 'p2', 'u3', 'p3']) {
    assert.ok(serialized.indexOf(leak) < 0, 'envNodes 不得包含凭据：' + leak);
  }
  assert.equal(rec.env, '10.0.0.1，10.0.0.2', 'rec.env 保持中文逗号 IP 串不回填改写');
});

test('finish()：无选中节点（envs 缺省或空数组）产出空数组 envNodes', () => {
  const ctx1 = makeFinishContext();
  ctx1.activeRuns.push(makeRc({}));
  ctx1.finish(ctx1.activeRuns[0], 'success');
  assert.equal(ctx1.history[0].envNodes.length, 0, 'envs 缺省时为空数组');
  assert.ok(Array.isArray(ctx1.history[0].envNodes));

  const ctx2 = makeFinishContext();
  const rc2 = makeRc({ envs: [] });
  ctx2.activeRuns.push(rc2);
  ctx2.finish(rc2, 'failed');
  assert.equal(ctx2.history[0].envNodes.length, 0, 'envs 空数组时为空数组');
  assert.ok(Array.isArray(ctx2.history[0].envNodes));
});

test('finish()：envNodes 超过 50 条截断', () => {
  const ctx = makeFinishContext();
  const envs = [];
  for (let i = 0; i < 55; i += 1) envs.push({ id: 'e' + i, name: '节点' + i, ip: '10.0.0.' + i, nodeIp: '', user: 'u', pass: 'p' });
  const rc = makeRc({ envs });
  ctx.activeRuns.push(rc);
  ctx.finish(rc, 'success');
  assert.equal(ctx.history[0].envNodes.length, 50, '最多 50 条');
  assert.equal(ctx.history[0].envNodes[49].name, '节点49');
});
