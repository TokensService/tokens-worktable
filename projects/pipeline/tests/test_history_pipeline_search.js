// 运行历史「流水线」筛选：输入框 + 候选面板支持搜索（子串、大小写不敏感），选中后仍按精确名过滤。
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

function unescapeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.handlers = {};
    this._html = '';
    this.style = {};
    this.value = '';
  }
  set innerHTML(value) { this._html = String(value); }
  get innerHTML() { return this._html; }
  addEventListener(type, handler) { (this.handlers[type] = this.handlers[type] || []).push(handler); }
  dispatch(type, event) { (this.handlers[type] || []).forEach(handler => handler(event)); }
  querySelectorAll(selector) {
    if (selector !== '[data-histpl]') return [];
    if (this._histplCache && this._histplCache.html === this._html) return this._histplCache.items;
    const items = [];
    const re = /<div data-histpl="([^"]*)"/g;
    let match;
    while ((match = re.exec(this._html))) {
      const el = new FakeNode('div');
      const value = unescapeHtml(match[1]);
      el.getAttribute = name => (name === 'data-histpl' ? value : null);
      items.push(el);
    }
    this._histplCache = { html: this._html, items };   /* 与真实 DOM 一致：innerHTML 未变时重查返回同一批节点 */
    return items;
  }
  contains() { return false; }
}

/* 载入控件相关片段：状态/函数块（_histFilterPipelineSig … pickHistPipeline）+ 历史筛选事件绑定 */
function loadSearchable(opts) {
  opts = opts || {};
  const nodes = {
    histFilterPipeline: new FakeNode('input'),
    histPipelinePanel: new FakeNode('div'),
    histPipelinePick: new FakeNode('span'),
    histFilterKw: new FakeNode('input'),
    histFilterStatus: new FakeNode('select'),
    histFilterClear: new FakeNode('button'),
  };
  nodes.histPipelinePanel.style.display = 'none';
  const docHandlers = {};
  const saved = [];
  const renderCalls = [];
  const context = {
    history: opts.history || [],
    pipelines: opts.pipelines || [],
    histFilter: opts.histFilter || { kw: '', status: '', pipeline: '' },
    histPage: opts.histPage || 0,
    document: {
      activeElement: null,
      addEventListener(type, handler) { (docHandlers[type] = docHandlers[type] || []).push(handler); },
    },
    localStorage: { setItem(key, value) { saved.push([key, value]); }, getItem() { return null; } },
    $: id => nodes[id],
    esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    renderHistory() { renderCalls.push('renderHistory'); },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('saveHistFilter'), context);
  const fnStart = source.indexOf('let _histFilterPipelineSig');
  const fnEnd = source.indexOf('function renderHistory(){', fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart, '流水线搜索控件函数块未找到');
  vm.runInContext(source.slice(fnStart, fnEnd), context);
  const bindStart = source.indexOf('/* 历史筛选：');
  const bindEnd = source.indexOf('/* 流水线任务筛选：', bindStart);
  assert.ok(bindStart >= 0 && bindEnd > bindStart, '历史筛选事件绑定未找到');
  vm.runInContext(source.slice(bindStart, bindEnd), context);
  return { context, nodes, docHandlers, saved, renderCalls };
}

function panelValues(nodes) {
  return nodes.histPipelinePanel.querySelectorAll('[data-histpl]').map(el => el.getAttribute('data-histpl'));
}

test('流水线过滤控件为可搜索输入框 + 候选面板（不再是无搜索的下拉框）', () => {
  assert.ok(/<input[^>]*\bid="histFilterPipeline"/.test(source), '#histFilterPipeline 应为输入框');
  assert.ok(!/<select[^>]*\bid="histFilterPipeline"/.test(source), '#histFilterPipeline 不应再是下拉框');
  assert.ok(/id="histPipelinePick"/.test(source), '缺少定位容器 #histPipelinePick');
  assert.ok(/id="histPipelinePanel"/.test(source), '缺少候选面板 #histPipelinePanel');
});

test('候选名单从 history + pipelines 汇总去重，并按签名缓存', () => {
  const { context } = loadSearchable({
    history: [{ pipeline: '构建' }, { pipeline: '部署' }, { pipeline: '构建' }, {}],
    pipelines: [{ name: '部署' }, { name: '冒烟' }],
  });
  const raw = () => vm.runInContext('_histPipelineNames', context);   /* let 绑定需经脚本读取 */
  const names = () => Array.from(raw());   /* 转成宿主域数组再比较 */
  context.renderHistFilterOptions();
  assert.deepEqual(names(), ['构建', '部署', '冒烟']);
  const cached = raw();
  context.history.push({ pipeline: '构建' });   // 同名集变化 → 签名命中，缓存数组复用
  context.renderHistFilterOptions();
  assert.strictEqual(raw(), cached);
  context.pipelines.push({ name: '压测' });     // 名单真变化 → 缓存更新
  context.renderHistFilterOptions();
  assert.deepEqual(names(), ['构建', '部署', '冒烟', '压测']);
});

test('聚焦弹出全量候选，输入即时按子串过滤（大小写不敏感）', () => {
  const { context, nodes } = loadSearchable({
    history: [{ pipeline: 'deploy-dev' }, { pipeline: 'Build-Prod' }],
    pipelines: [{ name: 'DEV 冒烟' }],
  });
  context.renderHistFilterOptions();
  nodes.histFilterPipeline.dispatch('focus');
  assert.equal(nodes.histPipelinePanel.style.display, 'block');
  assert.deepEqual(panelValues(nodes), ['', 'deploy-dev', 'Build-Prod', 'DEV 冒烟'], '首项应为「全部流水线」');
  nodes.histFilterPipeline.value = 'dev';
  nodes.histFilterPipeline.dispatch('input', { target: nodes.histFilterPipeline });
  assert.deepEqual(panelValues(nodes), ['', 'deploy-dev', 'DEV 冒烟']);
  nodes.histFilterPipeline.value = 'PROD';
  nodes.histFilterPipeline.dispatch('input', { target: nodes.histFilterPipeline });
  assert.deepEqual(panelValues(nodes), ['', 'Build-Prod']);
  nodes.histFilterPipeline.value = '不存在';
  nodes.histFilterPipeline.dispatch('input', { target: nodes.histFilterPipeline });
  assert.match(nodes.histPipelinePanel.innerHTML, /无匹配候选/);
});

test('点选候选后按精确名提交过滤并持久化', () => {
  const { context, nodes, saved, renderCalls } = loadSearchable({
    history: [{ pipeline: 'deploy-dev' }, { pipeline: 'deploy-dev-2' }],
    histPage: 2,
  });
  context.renderHistFilterOptions();
  nodes.histFilterPipeline.dispatch('focus');
  const items = nodes.histPipelinePanel.querySelectorAll('[data-histpl]');
  items[1].dispatch('click');
  assert.equal(context.histFilter.pipeline, 'deploy-dev');
  assert.equal(nodes.histFilterPipeline.value, 'deploy-dev');
  assert.equal(nodes.histPipelinePanel.style.display, 'none');
  assert.equal(context.histPage, 0, '条件变化归首页');
  assert.deepEqual(renderCalls, ['renderHistory']);
  assert.ok(saved.some(([key, value]) => key === 'pip-histFilter' && JSON.parse(value).pipeline === 'deploy-dev'));
});

test('filteredHistory 保持精确匹配语义（子串/大小写差异不匹配）', () => {
  const context = {
    histFilter: { kw: '', status: '', pipeline: 'deploy-dev' },
    history: [{ pipeline: 'deploy-dev' }, { pipeline: 'deploy-dev-2' }, { pipeline: 'Deploy-Dev' }, {}],
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('filteredHistory'), context);
  assert.deepEqual(context.filteredHistory().map(h => h.pipeline), ['deploy-dev']);
});

test('清空输入即时恢复全部流水线；Esc 关闭面板并回显已提交值', () => {
  const { context, nodes } = loadSearchable({
    history: [{ pipeline: 'Alpha' }, { pipeline: 'Beta' }],
    histFilter: { kw: '', status: '', pipeline: 'Beta' },
  });
  context.renderHistFilterOptions();
  assert.equal(nodes.histFilterPipeline.value, 'Beta', '初始化回显已选流水线');
  nodes.histFilterPipeline.dispatch('focus');
  nodes.histFilterPipeline.value = '';
  nodes.histFilterPipeline.dispatch('input', { target: nodes.histFilterPipeline });
  assert.equal(context.histFilter.pipeline, '', '清空输入 = 全部流水线');
  context.pickHistPipeline('Beta');
  nodes.histFilterPipeline.dispatch('focus');
  assert.deepEqual(panelValues(nodes), ['', 'Alpha', 'Beta'], '聚焦始终显示全量候选（不按已选值过滤）');
  nodes.histFilterPipeline.value = 'zz';
  nodes.histFilterPipeline.dispatch('input', { target: nodes.histFilterPipeline });
  assert.match(nodes.histPipelinePanel.innerHTML, /无匹配候选/);
  nodes.histFilterPipeline.dispatch('keydown', { key: 'Escape', target: nodes.histFilterPipeline, preventDefault() {} });
  assert.equal(nodes.histPipelinePanel.style.display, 'none');
  assert.equal(nodes.histFilterPipeline.value, 'Beta', 'Esc 丢弃未提交文本，回显已提交值');
});

test('键盘导航：方向键移动高亮，Enter 选中；无高亮时 Enter 提交精确输入', () => {
  const { context, nodes } = loadSearchable({ history: [{ pipeline: 'Alpha' }, { pipeline: 'Beta' }] });
  context.renderHistFilterOptions();
  nodes.histFilterPipeline.dispatch('focus');
  const key = k => nodes.histFilterPipeline.dispatch('keydown', { key: k, target: nodes.histFilterPipeline, preventDefault() {} });
  key('ArrowDown');
  key('ArrowDown');
  key('Enter');
  assert.equal(context.histFilter.pipeline, 'Alpha', '两次 ArrowDown 越过「全部流水线」高亮首个候选');
  assert.equal(nodes.histPipelinePanel.style.display, 'none');
  nodes.histFilterPipeline.value = 'Beta';
  nodes.histFilterPipeline.dispatch('input', { target: nodes.histFilterPipeline });
  key('Enter');   // 面板展开但无高亮：输入与候选完全一致时直接提交
  assert.equal(context.histFilter.pipeline, 'Beta');
  assert.equal(nodes.histPipelinePanel.style.display, 'none', '选中后面板关闭');
});

test('清除筛选重置新控件；存储恢复路径仍回显 #histFilterPipeline', () => {
  const { context, nodes } = loadSearchable({
    history: [{ pipeline: 'Alpha' }],
    histFilter: { kw: 'x', status: 'failed', pipeline: 'Alpha' },
  });
  context.renderHistFilterOptions();
  assert.equal(nodes.histFilterPipeline.value, 'Alpha');
  nodes.histFilterClear.dispatch('click');
  assert.deepEqual({ ...context.histFilter }, { kw: '', status: '', pipeline: '' });   /* vm 域对象展开后再比较 */
  assert.equal(nodes.histFilterPipeline.value, '');
  assert.ok(source.includes("$('histFilterPipeline').value=histFilter.pipeline;"), '存储恢复路径应回显输入框');
});

test('筛选名不在候选名单时输入框置空但不改写状态；聚焦时不回写打断输入', () => {
  const { context, nodes } = loadSearchable({
    history: [{ pipeline: 'Alpha' }],
    histFilter: { kw: '', status: '', pipeline: '已删除流水线' },
  });
  context.renderHistFilterOptions();
  assert.equal(nodes.histFilterPipeline.value, '', '名单外的筛选名回显置空（沿用旧下拉语义）');
  assert.equal(context.histFilter.pipeline, '已删除流水线', '筛选状态本身不被改写');
  nodes.histFilterPipeline.value = 'Al';
  context.document.activeElement = nodes.histFilterPipeline;   // 模拟搜索输入中（聚焦）
  context.renderHistFilterOptions();
  assert.equal(nodes.histFilterPipeline.value, 'Al', '聚焦时定时刷新不得回写打断输入');
});
