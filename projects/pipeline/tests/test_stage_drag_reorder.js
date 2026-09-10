const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function extractFunction(name) {
  const marker = new RegExp(`function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `pipeline.html 缺少函数 ${name}`);
  const start = match.index;
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`无法提取函数 ${name}`);
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  toggle(value, force) {
    const on = force === undefined ? !this.values.has(value) : !!force;
    if (on) this.values.add(value); else this.values.delete(value);
    return on;
  }
  contains(value) { return this.values.has(value); }
}

class FakeRow {
  constructor(index, rect = { top: 0, height: 100 }) {
    this.dataset = { idx: String(index) };
    this.style = {};
    this.classList = new FakeClassList();
    this.handlers = {};
    this.rect = rect;
    this.innerHTML = '';
  }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  getBoundingClientRect() { return this.rect; }
  querySelector() { return null; }
}

function loadDragContext(stages) {
  const rows = stages.map((_, index) => new FakeRow(index));
  const stageList = { children: rows };
  let renders = 0;
  const context = {
    editStages: stages,
    editFocusIdx: -1,
    stageDragFrom: -1,
    $: id => id === 'plStageList' ? stageList : null,
    renderStageEditor: () => { renders += 1; },
    schedulePlDraftSave: () => {},
    Math,
    parseInt,
  };
  vm.createContext(context);
  vm.runInContext([
    'moveEditStage',
    'stageDropTarget',
    'clearStageDragMarks',
    'stageCardDragStart',
    'stageCardDragOver',
    'stageCardDrop',
    'stageCardDragEnd',
  ].map(extractFunction).join('\n'), context);
  return { context, rows, renderCount: () => renders };
}

test('统一重排函数支持向前、向后移动并返回最终序号', () => {
  const { context } = loadDragContext([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);

  assert.equal(context.moveEditStage(0, 2), 2);
  assert.deepEqual(context.editStages.map(stage => stage.id), ['b', 'c', 'a', 'd']);
  assert.equal(context.moveEditStage(3, 1), 1);
  assert.deepEqual(context.editStages.map(stage => stage.id), ['b', 'd', 'c', 'a']);
});

test('拖到目标卡片上半区或下半区时计算正确的最终插入位置', () => {
  const { context } = loadDragContext([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);

  assert.equal(context.stageDropTarget(0, 2, false), 1, '向后拖到 C 上半区：插到 C 前');
  assert.equal(context.stageDropTarget(0, 2, true), 2, '向后拖到 C 下半区：插到 C 后');
  assert.equal(context.stageDropTarget(3, 1, false), 1, '向前拖到 B 上半区：插到 B 前');
  assert.equal(context.stageDropTarget(3, 1, true), 2, '向前拖到 B 下半区：插到 B 后');
});

test('整卡拖拽到目标下半区后重排任务并聚焦移动项', () => {
  const { context, rows, renderCount } = loadDragContext([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  const data = {};
  const dataTransfer = {
    effectAllowed: '',
    dropEffect: '',
    setData(type, value) { data[type] = value; },
  };

  context.stageCardDragStart({ currentTarget: rows[0], dataTransfer });
  let prevented = false;
  context.stageCardDragOver({ currentTarget: rows[2], clientY: 80, dataTransfer, preventDefault() { prevented = true; } });
  context.stageCardDrop({ currentTarget: rows[2], clientY: 80, preventDefault() { prevented = true; } });

  assert.equal(dataTransfer.effectAllowed, 'move');
  assert.equal(data['text/plain'], '0');
  assert.equal(prevented, true);
  assert.deepEqual(context.editStages.map(stage => stage.id), ['b', 'c', 'a']);
  assert.equal(context.editFocusIdx, 2);
  assert.equal(context.stageDragFrom, -1);
  assert.equal(renderCount(), 1);
});

test('普通任务卡和系统预设任务卡都注册整卡拖拽事件', () => {
  const stageList = {
    children: [],
    innerHTML: '',
    appendChild(row) { this.children.push(row); },
  };
  const rows = [];
  const context = {
    editStages: [
      { id: 'normal', name: '构建', kind: 'simulate', dur: 5, skip: false },
      { id: 'preset', name: '环境清理', preset: true, pkey: 'cleanup' },
    ],
    editFocusIdx: -1,
    editSelStage: null,
    STAGE_KIND_LABEL: { simulate: '模拟', shell: 'Shell', python: 'Python', http: 'HTTP', evaltokens: 'EvalTokens' },
    $: id => id === 'plStageList' ? stageList : null,
    esc: String,
    secToMinInput: value => String(value / 60),
    normalizePipelineProm: value => value || {},
    renderStageActionRow() {},
    renderStageParams() {},
    renderStageSched() {},
    stageCardDragStart() {},
    stageCardDragOver() {},
    stageCardDrop() {},
    stageCardDragEnd() {},
    document: {
      createElement() {
        const row = new FakeRow(rows.length);
        rows.push(row);
        return row;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(['renderStageEditor', 'applyEditSel'].map(extractFunction).join('\n'), context);
  context.renderStageEditor();

  assert.equal(rows.length, 2);
  rows.forEach(row => {
    assert.equal(row.draggable, true);
    assert.deepEqual(Object.keys(row.handlers).sort(), ['dragend', 'dragover', 'dragstart', 'drop']);
  });
});
