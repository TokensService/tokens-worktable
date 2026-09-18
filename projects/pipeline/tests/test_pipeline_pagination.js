// 流水线任务列表分页：独立于运行历史保存页大小，规格同为 10/20/50/100。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function extractFunction(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `pipeline.html 缺少函数 ${name}`);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`无法提取函数 ${name}`);
}

function pageSizeOptions(id) {
  const match = new RegExp('<select[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)<\\/select>').exec(source);
  assert.ok(match, '缺少 #' + id + ' 每页条数选择器');
  return Array.from(match[1].matchAll(/<option\s+value="(\d+)"/g), item => Number(item[1]));
}

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.handlers = {};
    this._html = '';
    this.className = '';
    this.title = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
  }
  set innerHTML(value) { this._html = value; if (!value) this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(node) { this.children.push(node); }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  querySelectorAll(selector) {
    const attrMatch = /^\[([^\]]+)\]$/.exec(selector);
    if (!attrMatch) return [];
    const attr = attrMatch[1];
    const buttons = [];
    this.children.forEach(row => {
      const re = /<button\s+([^>]*)>([^<]*)<\/button>/g;
      let match;
      while ((match = re.exec(row.innerHTML))) {
        const valueMatch = new RegExp(attr + '="([^"]+)"').exec(match[1]);
        if (!valueMatch) continue;
        const button = new FakeNode('button');
        button.attributes = { [attr]: valueMatch[1] };
        button.getAttribute = name => button.attributes[name] || null;
        buttons.push(button);
      }
    });
    return buttons;
  }
}

function loadPagination(total = 23) {
  const tbody = new FakeNode('tbody');
  const table = { querySelector: selector => selector === 'tbody' ? tbody : null };
  const nodes = {
    plTable: table,
    plCount: new FakeNode('span'),
    plFilterTip: new FakeNode('span'),
    plPageSize: new FakeNode('select'),
    plPageInfo: new FakeNode('span'),
    plPrev: new FakeNode('button'),
    plNext: new FakeNode('button'),
  };
  const store = {};
  const context = {
    pipelines: Array.from({ length: total }, (_, index) => ({
      id: 'pipe-' + (index + 1),
      name: '流水线 ' + (index + 1),
      stages: [{ name: '构建' }],
      builtIn: false,
      pinnedAt: 0,
    })),
    curPipelineId: 'pipe-1',
    plFilter: { kw: '', owner: 'all', favorite: 'all' },
    plPage: 0,
    plPageSize: 10,
    localStorage: { setItem(key, value) { store[key] = value; } },
    renderPlFilterOptions() {},
    plFilterMatch: () => true,
    plOwnerOf: () => '',
    plUpdaterOf: () => '',
    isPipelineFavorite: () => false,
    pipelineQueueCounts: () => ({}),
    pipelineQueueCountHtml: () => '—',
    currentUsername: '',
    document: { createElement: tag => new FakeNode(tag) },
    $: id => nodes[id] || new FakeNode('span'),
    esc: String,
    findPipeline: id => context.pipelines.find(item => item.id === id),
    openPipelineRunDialog() {},
    showPipelineApi() {},
    selectPipeline() {},
    openPlForm() {},
    copyPipeline() {},
    deletePipeline() {},
    renderPipelineSel() {},
  };
  vm.createContext(context);
  const renderStart = source.indexOf('function renderPipelines(){');
  const renderEnd = source.indexOf('/* 运行框流水线下拉', renderStart);
  const bindStart = source.indexOf('/* 流水线任务分页 */');
  const bindEnd = source.indexOf('/* 历史筛选：', bindStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart, 'renderPipelines 未找到');
  assert.ok(bindStart >= 0 && bindEnd > bindStart, '流水线任务分页事件绑定未找到');
  vm.runInContext(source.slice(renderStart, renderEnd), context);
  vm.runInContext(source.slice(bindStart, bindEnd), context);
  context.renderPipelines();
  return { context, nodes, tbody, store };
}

test('任务列表每页规格与运行历史一致，但使用独立选择器', () => {
  assert.deepEqual(pageSizeOptions('plPageSize'), [10, 20, 50, 100]);
  assert.deepEqual(pageSizeOptions('plPageSize'), pageSizeOptions('histPageSize'));
});

test('任务页大小从独立本地存储恢复，缺省值为 10', () => {
  const start = source.indexOf('let plPage=0;');
  const end = source.indexOf('\n', source.indexOf('let plPageSize=', start));
  assert.ok(start >= 0 && end > start, '流水线任务分页状态初始化未找到');

  const reads = [];
  const restored = { lsGet(key, fallback) { reads.push([key, fallback]); return '50'; } };
  vm.createContext(restored);
  vm.runInContext(source.slice(start, end), restored);
  assert.equal(vm.runInContext('plPageSize', restored), 50);
  assert.deepEqual(reads, [['pip-plPageSize', '10']]);

  const defaults = { lsGet() { return ''; } };
  vm.createContext(defaults);
  vm.runInContext(source.slice(start, end), defaults);
  assert.equal(vm.runInContext('plPageSize', defaults), 10);
});

test('任务列表按页切片并可前后翻页', () => {
  const { context, nodes, tbody } = loadPagination();
  assert.equal(tbody.children.length, 10);
  assert.match(tbody.children[0].innerHTML, /流水线 1/);
  assert.match(tbody.children[9].innerHTML, /流水线 10/);
  assert.equal(nodes.plPageInfo.textContent, '第 1/3 页 · 共 23 条');
  assert.equal(nodes.plPrev.disabled, true);
  assert.equal(nodes.plNext.disabled, false);

  nodes.plNext.handlers.click();
  assert.equal(context.plPage, 1);
  assert.equal(tbody.children.length, 10);
  assert.match(tbody.children[0].innerHTML, /流水线 11/);
  assert.match(tbody.children[9].innerHTML, /流水线 20/);

  nodes.plNext.handlers.click();
  assert.equal(context.plPage, 2);
  assert.equal(tbody.children.length, 3);
  assert.equal(nodes.plNext.disabled, true);
  nodes.plPrev.handlers.click();
  assert.equal(context.plPage, 1);
});

test('任务页大小独立保存并在变更后回到第一页', () => {
  const { context, nodes, tbody, store } = loadPagination(55);
  nodes.plNext.handlers.click();
  assert.equal(context.plPage, 1);

  nodes.plPageSize.handlers.change({ target: { value: '20' } });
  assert.equal(context.plPageSize, 20);
  assert.equal(context.plPage, 0);
  assert.equal(tbody.children.length, 20);
  assert.equal(store['pip-plPageSize'], '20');
  assert.equal(store['pip-histPageSize'], undefined, '任务页大小不得改写运行历史设置');
});

test('刷新、新增或删除后自动修正越界页码', () => {
  const { context, nodes, tbody } = loadPagination();
  nodes.plNext.handlers.click();
  nodes.plNext.handlers.click();
  assert.equal(context.plPage, 2);

  context.pipelines.splice(8);
  context.renderPipelines();
  assert.equal(context.plPage, 0);
  assert.equal(tbody.children.length, 8);
  assert.equal(nodes.plPageInfo.textContent, '第 1/1 页 · 共 8 条');
});

test('从下拉框、新建或复制选中页外流水线时跳到目标所在页', () => {
  const calls = [];
  const context = {
    pipelines: Array.from({ length: 23 }, (_, index) => ({ id: 'pipe-' + (index + 1), pinnedAt: 0 })),
    plPage: 0,
    plPageSize: 10,
    plFilterMatch: () => true,
    curPipelineId: 'pipe-1',
    localStorage: { setItem() {} },
    exitHistoryReplay() {},
    persistState() {},
    syncViewRun() {},
    applyRunOverall() {},
    refreshArchiveTip() {},
    resetNodes() {},
    renderPipelines: () => calls.push('pipelines'),
    renderFlow: () => calls.push('flow'),
    renderDetail: () => calls.push('detail'),
    $: () => ({ disabled: false }),
    viewRc: null,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('selectPipeline'), context);

  context.selectPipeline('pipe-23');
  assert.equal(context.curPipelineId, 'pipe-23');
  assert.equal(context.plPage, 2, '选中第 23 条后应显示第 3 页的当前行');
  assert.deepEqual(calls, ['pipelines', 'flow', 'detail']);

  context.plPage = 1;
  context.plFilterMatch = pipeline => pipeline.id !== 'pipe-23';
  context.selectPipeline('pipe-23');
  assert.equal(context.plPage, 1, '筛选排除目标时保持当前任务页，由筛选结果自行修正边界');
});
