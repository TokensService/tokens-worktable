// 流水线任务行运行按钮：直接运行对应流水线，不切换当前选中项。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');
const start = source.indexOf('function renderPipelines(){');
const end = source.indexOf('/* 运行框流水线下拉', start);
assert.ok(start >= 0 && end > start, 'renderPipelines not found');

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.handlers = {};
    this._html = '';
    this.className = '';
    this.title = '';
  }
  set innerHTML(value) { this._html = value; if (!value) this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(node) { this.children.push(node); }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  querySelectorAll(selector) {
    const attr = /^\[([^\]]+)\]$/.exec(selector)[1];
    const buttons = [];
    this.children.forEach(row => {
      const re = /<button\s+([^>]*)>([^<]*)<\/button>/g;
      let match;
      while ((match = re.exec(row.innerHTML))) {
        const attrs = match[1];
        const valueMatch = new RegExp(attr + '="([^"]+)"').exec(attrs);
        if (!valueMatch) continue;
        const key = attr + ':' + valueMatch[1];
        row._buttons = row._buttons || {};
        const button = row._buttons[key] || new FakeNode('button');
        button.attributes = { [attr]: valueMatch[1] };
        button.textContent = match[2];
        const className = /class="([^"]*)"/.exec(attrs);
        const title = /title="([^"]*)"/.exec(attrs);
        const aria = /aria-label="([^"]*)"/.exec(attrs);
        button.className = className ? className[1] : '';
        button.title = title ? title[1] : '';
        button.ariaLabel = aria ? aria[1] : '';
        button.getAttribute = name => button.attributes[name] || null;
        row._buttons[key] = button;
        buttons.push(button);
      }
    });
    return buttons;
  }
}

function makeContext(runResult) {
  const tbody = new FakeNode('tbody');
  const table = { querySelector: selector => selector === 'tbody' ? tbody : null };
  const count = { textContent: '' };
  const calls = { run: [], api: [], select: [], tips: [], alerts: [], focus: [] };
  const queue = [];
  const context = {
    pipelines: [
      { id: 'pipe-1', name: '流水线一', stages: [{ name: '检出' }], builtIn: true },
      { id: 'pipe-2', name: '流水线二', stages: [{ name: '构建' }], builtIn: false },
    ],
    curPipelineId: 'pipe-1',
    activeRuns: [],
    viewRc: null,
    plFilter: { kw: '', owner: 'all' },   // 筛选状态桩：本测试只验证行内运行按钮，不关心筛选；用 all 让全部行进视图
    plFilterMatch: () => true,   // 筛选桩：所有流水线均命中（行运行测试不涉及筛选语义）
    renderPlFilterOptions: () => {},   // 下拉渲染桩：筛选控件不在本测试范围
    plOwnerOf: () => '',   // 创建者取值桩：行运行测试不涉及署名展示
    currentUsername: '',
    document: { createElement: tag => new FakeNode(tag) },
    $: id => id === 'plTable' ? table : count,
    esc: String,
    runPipeline: options => { calls.run.push(options); if (runResult === 'queued') queue.push(options); return runResult; },
    showPipelineApi: pipeline => calls.api.push(pipeline),
    findPipeline: id => context.pipelines.find(pipeline => pipeline.id === id),
    selectPipeline: id => calls.select.push(id),
    runsOfPipeline: pid => context.activeRuns.filter(rc => rc.pipelineId === pid),
    latestRunOfPipeline: pid => { const rs = context.activeRuns.filter(rc => rc.pipelineId === pid); return rs.length ? rs[rs.length - 1] : null; },
    focusRun: rc => calls.focus.push(rc),
    openPlForm() {}, copyPipeline() {}, deletePipeline() {}, renderPipelineSel() {},
    flashRunTip: text => calls.tips.push(text),
    alert: text => calls.alerts.push(text),
    QUEUE_CAP: 8,
    queue,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.renderPipelines();
  return { context, tbody, calls };
}

test('每条流水线的 ▶ 按钮运行对应流水线且不切换当前行', () => {
  const { tbody, calls } = makeContext('queued');
  const buttons = tbody.querySelectorAll('[data-plrun]');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[1].textContent.trim(), '▶');
  assert.match(buttons[1].className, /(^|\s)dshell-btnGhost(\s|$)/);
  assert.equal(buttons[1].title, '运行流水线「流水线二」');
  assert.equal(buttons[1].ariaLabel, '运行流水线「流水线二」');

  const event = { stopped: false, stopPropagation() { this.stopped = true; } };
  buttons[1].handlers.click(event);

  assert.equal(event.stopped, true);
  assert.equal(calls.run.length, 1);
  assert.equal(calls.run[0].pipelineId, 'pipe-2');
  assert.equal(calls.run[0].useDefaults, true, '列表直接运行必须使用该流水线保存的默认运行参数');
  assert.deepEqual(calls.select, []);
  assert.deepEqual(calls.tips, ['已加入队列（第 1 位）']);
});

test('▶ 直接启动时不显示入队或队列已满提示', () => {
  const { tbody, calls } = makeContext(true);
  const button = tbody.querySelectorAll('[data-plrun]')[0];
  button.handlers.click({ stopPropagation() {} });
  assert.deepEqual(calls.tips, []);
  assert.deepEqual(calls.alerts, []);
});

test('▶ 在队列已满时沿用现有容量提示', () => {
  const { tbody, calls } = makeContext(false);
  const button = tbody.querySelectorAll('[data-plrun]')[0];
  button.handlers.click({ stopPropagation() {} });
  assert.equal(calls.alerts.length, 1);
  assert.match(calls.alerts[0], /队列已满（上限 8）/);
});

test('每条流水线提供 API 按钮并打开对应流水线的调用说明', () => {
  const { tbody, calls } = makeContext(true);
  const buttons = tbody.querySelectorAll('[data-plapi]');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[1].textContent.trim(), 'API');
  const event = { stopped: false, stopPropagation() { this.stopped = true; } };
  buttons[1].handlers.click(event);
  assert.equal(event.stopped, true);
  assert.equal(calls.api.length, 1);
  assert.equal(calls.api[0].id, 'pipe-2');
  assert.deepEqual(calls.select, []);
});

test('行点击：有在跑运行的流水线聚焦其运行查看阶段详情，不切换选用', () => {
  const { context, tbody, calls } = makeContext(true);
  const rc = { id: 'r1', pipelineId: 'pipe-2' };
  context.activeRuns.push(rc);
  context.renderPipelines();

  const row = tbody.children[1];
  assert.match(row.innerHTML, /运行中/);
  assert.equal(row.title, '点击查看本次运行的阶段详情');
  row.handlers.click();

  assert.deepEqual(calls.focus, [rc]);
  assert.deepEqual(calls.select, []);
});

test('行点击：无在跑运行的流水线仍走选用，在跑行按最近启动聚焦并标记查看中', () => {
  const { context, tbody, calls } = makeContext(true);
  const rc1 = { id: 'r1', pipelineId: 'pipe-2' };
  const rc2 = { id: 'r2', pipelineId: 'pipe-2' };
  context.activeRuns.push(rc1, rc2);
  context.viewRc = rc1;
  context.renderPipelines();

  tbody.children[0].handlers.click();   // 流水线一无在跑运行：仍 selectPipeline
  assert.deepEqual(calls.select, ['pipe-1']);

  const row = tbody.children[1];
  assert.match(row.innerHTML, /（查看中）/);   // viewRc 是该流水线的在跑运行
  row.handlers.click();
  assert.deepEqual(calls.focus, [rc2]);   // 多个在跑运行取最近启动的一个
});
