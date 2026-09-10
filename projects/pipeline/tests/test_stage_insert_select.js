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
  constructor(index) {
    this.dataset = { idx: String(index) };
    this.classList = new FakeClassList();
    this.insCount = 0;        // 当前挂载的「+」按钮数
    this.insertedHtml = [];   // insertAdjacentHTML 的历次内容
  }
  insertAdjacentHTML(position, html) {
    assert.equal(position, 'beforeend');
    this.insertedHtml.push(html);
    this.insCount += (html.match(/class="plstage-ins /g) || []).length;
  }
  querySelector(selector) { return selector === '.plstage-ins' && this.insCount > 0 ? { fake: true } : null; }
  querySelectorAll(selector) {
    if (selector !== '.plstage-ins') return [];
    const row = this;
    return Array.from({ length: row.insCount }, () => ({ remove() { row.insCount -= 1; } }));
  }
}

function loadSelContext(stages) {
  const rows = stages.map((_, index) => new FakeRow(index));
  const stageList = { children: rows };
  let renders = 0;
  const context = {
    editStages: stages,
    editSelStage: null,
    editFocusIdx: -1,
    $: id => (id === 'plStageList' ? stageList : null),
    renderStageEditor: () => { renders += 1; },
    Math,
    Number,
    parseInt,
  };
  vm.createContext(context);
  vm.runInContext(['newStage', 'applyEditSel', 'selectEditStage', 'insertEditStage'].map(extractFunction).join('\n'), context);
  return { context, rows, renderCount: () => renders };
}

test('选中任务卡后仅该卡高亮，并在上/下边框出现 + 按钮', () => {
  const stages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const { context, rows } = loadSelContext(stages);

  context.selectEditStage(1);
  assert.equal(context.editSelStage, stages[1]);
  assert.equal(rows[1].classList.contains('plstage-sel'), true);
  assert.equal(rows[1].insCount, 2);
  assert.ok(rows[1].insertedHtml[0].includes('plstage-ins-top'), '上边框 + 按钮');
  assert.ok(rows[1].insertedHtml[0].includes('plstage-ins-bottom'), '下边框 + 按钮');
  assert.ok(rows[1].insertedHtml[0].includes('data-act="insBefore"'));
  assert.ok(rows[1].insertedHtml[0].includes('data-act="insAfter"'));
  assert.equal(rows[0].classList.contains('plstage-sel'), false);
  assert.equal(rows[0].insCount, 0);
  assert.equal(rows[2].classList.contains('plstage-sel'), false);
  assert.equal(rows[2].insCount, 0);

  // 换选另一张卡：原卡高亮与 + 按钮移除，新卡出现
  context.selectEditStage(2);
  assert.equal(context.editSelStage, stages[2]);
  assert.equal(rows[1].classList.contains('plstage-sel'), false);
  assert.equal(rows[1].insCount, 0);
  assert.equal(rows[2].classList.contains('plstage-sel'), true);
  assert.equal(rows[2].insCount, 2);

  // 重复点击已选中卡：幂等，不重复挂载按钮
  context.selectEditStage(2);
  assert.equal(rows[2].insCount, 2);
});

test('点 + 在其上方/下方插入新阶段，新卡成为选中与焦点', () => {
  const stages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const { context, renderCount } = loadSelContext(stages);

  context.insertEditStage(1, false);   // b 上方
  assert.deepEqual(context.editStages.map(s => s.id), ['a', '', 'b', 'c']);
  assert.equal(context.editStages[1].name, '新阶段');
  assert.equal(context.editStages[1].kind, 'simulate');
  assert.equal(context.editSelStage, context.editStages[1]);
  assert.equal(context.editFocusIdx, 1);
  assert.equal(renderCount(), 1);

  context.insertEditStage(3, true);   // c（当前 index 3）下方 → 末尾
  assert.deepEqual(context.editStages.map(s => s.id), ['a', '', 'b', 'c', '']);
  assert.equal(context.editSelStage, context.editStages[4]);
  assert.equal(context.editFocusIdx, 4);
  assert.equal(renderCount(), 2);
});

test('插入位置越界时不动草稿也不重渲染', () => {
  const stages = [{ id: 'a' }];
  const { context, renderCount } = loadSelContext(stages);

  context.insertEditStage(-1, false);
  context.insertEditStage(5, true);
  assert.equal(context.editStages.length, 1);
  assert.equal(context.editSelStage, null);
  assert.equal(renderCount(), 0);
});

test('整表重渲染后选中卡恢复高亮与 + 按钮（含预设任务卡）', () => {
  const stageList = {
    children: [],
    innerHTML: '',
    appendChild(row) { this.children.push(row); },
  };
  const rows = [];
  const stages = [
    { id: 'normal', name: '构建', kind: 'simulate', dur: 5, skip: false },
    { id: 'preset', name: '环境清理', preset: true, pkey: 'cleanup' },
  ];
  const context = {
    editStages: stages,
    editFocusIdx: -1,
    editSelStage: stages[1],   // 预设任务卡同样可选中
    STAGE_KIND_LABEL: { simulate: '模拟', shell: 'Shell', python: 'Python', http: 'HTTP', evaltokens: 'EvalTokens' },
    $: id => (id === 'plStageList' ? stageList : null),
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
        row.style = {};
        row.handlers = {};
        row.addEventListener = function (type, handler) { this.handlers[type] = handler; };
        rows.push(row);
        return row;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(['renderStageEditor', 'applyEditSel'].map(extractFunction).join('\n'), context);
  context.renderStageEditor();

  assert.equal(stageList.children.length, 2);
  assert.equal(rows[0].classList.contains('plstage-sel'), false);
  assert.equal(rows[0].insCount, 0);
  assert.equal(rows[1].classList.contains('plstage-sel'), true);
  assert.equal(rows[1].insCount, 2);
});

test('重渲染后仅选中卡高亮：editFocusIdx 不再内联高亮（回归：移动/插入后不得出现两张显亮卡）', () => {
  const stageList = {
    children: [],
    innerHTML: '',
    appendChild(row) { this.children.push(row); },
  };
  const rows = [];
  const stages = [
    { id: 'a', name: '构建', kind: 'simulate', dur: 5, skip: false },
    { id: 'b', name: '部署', kind: 'simulate', dur: 5, skip: false },
  ];
  const context = {
    editStages: stages,
    editFocusIdx: 1,   // 移动/插入后的焦点序号：只负责聚焦滚动，不产生高亮
    editSelStage: stages[0],
    STAGE_KIND_LABEL: { simulate: '模拟', shell: 'Shell', python: 'Python', http: 'HTTP', evaltokens: 'EvalTokens' },
    $: id => (id === 'plStageList' ? stageList : null),
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
        row.style = {};
        row.handlers = {};
        row.addEventListener = function (type, handler) { this.handlers[type] = handler; };
        rows.push(row);
        return row;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(['renderStageEditor', 'applyEditSel'].map(extractFunction).join('\n'), context);
  context.renderStageEditor();

  // 选中卡高亮；焦点卡既无 plstage-sel 也不带内联 accent 边框/阴影，任意时刻只有一张显亮卡
  assert.equal(rows[0].classList.contains('plstage-sel'), true);
  assert.equal(rows[1].classList.contains('plstage-sel'), false);
  assert.equal(rows[1].insCount, 0);
  const focusCss = String(rows[1].style.cssText || '');
  assert.equal(focusCss.includes('accent-primary'), false, '焦点卡不得内联 accent 边框色');
  assert.equal(focusCss.includes('box-shadow'), false, '焦点卡不得内联阴影');
});

function loadOpenPlFormContext(overrides) {
  const els = {
    plForm: { style: {}, dataset: {} },
    scriptsDir: { value: '' },
    plFormTitle: { textContent: '' },
    plName: { value: '', focus() {} },
  };
  const pipeline = {
    id: 'p1',
    name: 'P',
    stages: [
      { id: 'a', name: 'A', kind: 'simulate', dur: 5, skip: false },
      { id: 'b', name: 'B', kind: 'simulate', dur: 5, skip: false },
      { id: 'c', name: 'C', kind: 'simulate', dur: 5, skip: false },
    ],
  };
  const context = Object.assign({
    editStages: [],
    editFocusIdx: -1,
    editSelStage: null,
    scriptsDir: '',
    $: id => els[id] || null,
    findPipeline: id => (id === 'p1' ? pipeline : null),
    curPipeline: () => pipeline,
    withPresetMarkers: list => list,
    normalizePipelineProm: value => value || {},
    normalizeStageKind: stage => stage,
    evaltokensStageConfig: value => value || {},
    loadPlDraft: () => null,
    loadScripts: () => Promise.resolve(),
    detectStageParams: () => Promise.resolve(),
    detectEvaltokStageParams: () => Promise.resolve(),
    renderStageEditor() {},
  }, overrides);
  vm.createContext(context);
  vm.runInContext(['newStage', 'openPlForm'].map(extractFunction).join('\n'), context);
  return { context, els, pipeline };
}

test('编排区双击进入编辑器：焦点阶段即选中卡（进入即见 plstage-sel 单通道高亮）', async () => {
  const { context, pipeline } = loadOpenPlFormContext();

  context.openPlForm('p1', 1);
  assert.equal(context.editFocusIdx, 1);
  assert.equal(context.editStages.length, 3);
  assert.equal(context.editSelStage, context.editStages[1]);
  assert.equal(context.editSelStage.id, 'b');
  assert.notEqual(context.editSelStage, pipeline.stages[1], '选中的是编辑器草稿副本而非源阶段');
  await new Promise(resolve => setTimeout(resolve, 0));
});

test('新建流水线或不带焦点序号进入：无选中卡', () => {
  const { context } = loadOpenPlFormContext();
  context.openPlForm('');
  assert.equal(context.editFocusIdx, -1);
  assert.equal(context.editSelStage, null);
  assert.equal(context.editStages.length, 3);   // 检出/校验/构建镜像

  const again = loadOpenPlFormContext();
  again.context.openPlForm('p1', 99);   // 焦点序号越界：不选中
  assert.equal(again.context.editFocusIdx, 99);
  assert.equal(again.context.editSelStage, null);
});

test('草稿恢复替换 editStages 后，选中引用指向恢复出的草稿卡', () => {
  const draftStages = [
    { id: 'x', name: 'X', kind: 'simulate' },
    { id: 'y', name: 'Y', kind: 'simulate' },
  ];
  const { context } = loadOpenPlFormContext({
    loadPlDraft: () => ({ editId: 'p1', stages: draftStages }),
  });
  context.openPlForm('p1', 1);
  assert.equal(context.editStages, draftStages);
  assert.equal(context.editSelStage, draftStages[1], '必须在草稿恢复之后按焦点序号取选中引用');
});
