// 流水线任务列表：按流水线汇总运行队列中的全部来源，并区分运行/排队数量。
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

function loadQueueCountContext() {
  const cells = ['pipe-1', 'pipe-2'].map(pipelineId => ({
    innerHTML: '', title: '',
    getAttribute: name => name === 'data-plqueue' ? pipelineId : null,
  }));
  const context = {
    queue: [
      { id: 'q-local', pipelineId: 'pipe-1' },
      { id: 'q-custom', pipelineId: '' },
    ],
    pendingLeaseStarts: [{ queueItem: { id: 'q-pending', pipelineId: 'pipe-1' } }],
    activeRuns: [
      { id: 'r-local', pipelineId: 'pipe-1' },
      { id: 'r-custom', pipelineId: null },
    ],
    remoteQueueClients: [
      {
        id: 'server',
        runs: [{ id: 'r-server', pipelineId: 'pipe-1' }],
        queue: [{ id: 'q-server', pipelineId: 'pipe-1' }],
      },
      {
        id: 'modern-browser',
        runs: [{ id: 'r-modern', pipelineId: 'pipe-1' }],
        queue: [{ id: 'q-modern', pipelineId: 'pipe-1' }],
      },
      {
        id: 'legacy-browser',
        runs: [],
        running: { id: 'r-legacy', pipelineId: 'pipe-1' },
        queue: [{ id: 'q-legacy', pipelineId: 'pipe-1' }],
      },
    ],
    document: { querySelectorAll: selector => selector === '[data-plqueue]' ? cells : [] },
  };
  vm.createContext(context);
  vm.runInContext(extract('function localQueueItems', 'function queuePreviewRc'), context);
  vm.runInContext(extract('function remoteRunsOf', '/* ---------- 运行引擎'), context);
  const start = source.indexOf('function pipelineQueueCounts(){');
  if (start >= 0) {
    const end = source.indexOf('function renderQueue(){', start);
    assert.ok(end > start, 'pipeline queue count helpers end not found');
    vm.runInContext(source.slice(start, end), context);
  }
  return { context, cells };
}

test('任务列表按流水线汇总全部来源并分别显示运行与排队数量', () => {
  const { context, cells } = loadQueueCountContext();
  const counts = typeof context.pipelineQueueCounts === 'function' ? context.pipelineQueueCounts() : {};
  const count = counts['pipe-1'] || { running: 0, queued: 0 };

  assert.deepEqual([count.running, count.queued], [4, 5]);

  if (typeof context.refreshPipelineQueueCounts === 'function') context.refreshPipelineQueueCounts();
  assert.match(cells[0].innerHTML, /运行 4/);
  assert.match(cells[0].innerHTML, /排队 5/);
  assert.equal(cells[0].title, '运行 4 · 排队 5');
  assert.equal(cells[1].innerHTML, '—');
  assert.equal(cells[1].title, '当前无运行或排队任务');
});

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.handlers = {};
    this._html = '';
    this.className = '';
    this.title = '';
    this.textContent = '';
  }
  set innerHTML(value) { this._html = value; if (!value) this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(node) { this.children.push(node); }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  querySelectorAll() { return []; }
}

function loadPipelineTableContext() {
  const tbody = new FakeNode('tbody');
  const table = { querySelector: selector => selector === 'tbody' ? tbody : null };
  const fallback = new FakeNode('span');
  const context = {
    pipelines: [
      { id: 'pipe-1', name: '流水线一', stages: [{ name: '构建' }], builtIn: true },
      { id: 'pipe-2', name: '流水线二', stages: [{ name: '部署' }], builtIn: false },
    ],
    curPipelineId: 'pipe-1',
    activeRuns: [{ id: 'r-local', pipelineId: 'pipe-1' }],
    queue: [], pendingLeaseStarts: [],
    remoteQueueClients: [{
      id: 'server', runs: [], queue: [{ id: 'q-server', pipelineId: 'pipe-1' }],
    }],
    plFilter: { kw: '', owner: 'all', favorite: 'all' },
    plFilterMatch: () => true,
    renderPlFilterOptions: () => {},
    plOwnerOf: () => '', plUpdaterOf: () => '', isPipelineFavorite: () => false,
    currentUsername: '',
    document: { createElement: tag => new FakeNode(tag), querySelectorAll: () => [] },
    $: id => id === 'plTable' ? table : fallback,
    esc: String,
    renderPipelineSel: () => {},
  };
  vm.createContext(context);
  vm.runInContext(extract('function localQueueItems', 'function queuePreviewRc'), context);
  vm.runInContext(extract('function remoteRunsOf', '/* ---------- 运行引擎'), context);
  const countStart = source.indexOf('function pipelineQueueCounts(){');
  const countEnd = source.indexOf('function renderQueue(){', countStart);
  if (countStart >= 0 && countEnd > countStart) vm.runInContext(source.slice(countStart, countEnd), context);
  vm.runInContext(extract('function renderPipelines(){', '/* 运行框流水线下拉'), context);
  context.renderPipelines();
  return { tbody };
}

test('流水线任务列表为每条定义显示对应的运行队列计数', () => {
  const { tbody } = loadPipelineTableContext();

  assert.match(tbody.children[0].innerHTML, /data-plqueue="pipe-1"/);
  assert.match(tbody.children[0].innerHTML, /运行 1/);
  assert.match(tbody.children[0].innerHTML, /排队 1/);
  assert.match(tbody.children[1].innerHTML, /data-plqueue="pipe-2"[^>]*>—<\/td>/);
});
