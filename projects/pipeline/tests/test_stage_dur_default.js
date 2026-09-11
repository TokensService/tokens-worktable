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
    this.insCount = 0;
    this.innerHTML = '';
    this.style = {};
    this.handlers = {};
  }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  insertAdjacentHTML(position, html) {
    assert.equal(position, 'beforeend');
    this.insCount += (html.match(/class="plstage-ins /g) || []).length;
  }
  querySelector(selector) { return selector === '.plstage-ins' && this.insCount > 0 ? { fake: true } : null; }
  querySelectorAll(selector) {
    if (selector !== '.plstage-ins') return [];
    const row = this;
    return Array.from({ length: row.insCount }, () => ({ remove() { row.insCount -= 1; } }));
  }
}

function loadEditorContext(stages) {
  const stageList = {
    children: [],
    innerHTML: '',
    appendChild(row) { this.children.push(row); },
  };
  const rows = [];
  const context = {
    editStages: stages,
    editFocusIdx: -1,
    editSelStage: null,
    plFormReadOnly: false,
    applyPlFormReadOnly() {},
    STAGE_KIND_LABEL: { simulate: '模拟', shell: 'Shell', python: 'Python', http: 'HTTP', evaltokens: 'EvalTokens' },
    $: id => (id === 'plStageList' ? stageList : null),
    esc: String,
    secToMinInput: value => String(value / 60),
    normalizePipelineProm: value => value || {},
    renderStageActionRow() {},
    renderStageParams() {},
    renderStageSched() {},
    stageCardMouseDown() {},
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
  return { context, rows, stageList };
}

test('新建阶段默认耗时 0（0=不设置耗时）', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(extractFunction('newStage'), context);
  const stage = context.newStage('构建');
  assert.equal(stage.dur, 0);
  assert.equal(stage.kind, 'simulate');
});

test('编辑器耗时输入框保留 0 不回退默认 5 秒，且保留已设非零值', () => {
  const { rows } = loadEditorContext([
    { id: 'a', name: '构建', kind: 'simulate', dur: 0, skip: false },
    { id: 'b', name: '部署', kind: 'simulate', dur: 120, skip: false },
  ]);
  const html0 = rows[0].innerHTML;
  assert.ok(/data-f="dur"[^>]*min="0"/.test(html0), '耗时输入框允许填 0');
  assert.ok(/data-f="dur"[^>]*value="0"/.test(html0), 'dur=0 的阶段编辑时仍显示 0（不得回退 5 秒）');
  assert.ok(/data-f="dur"[^>]*value="2"/.test(rows[1].innerHTML), 'dur=120 秒仍按分钟显示为 2');
});

function loadRunContext(stage, calls) {
  const rc = { stages: [stage], nodes: {}, vars: {}, timer: null };
  const context = {
    finish() {},
    runSetSel() {},
    viewRc: null,
    renderFlow() {},
    renderDetail() {},
    archiveStageLog(...args) { calls.archived.push(args); },
    stageSeq: (stages, i) => i + 1,
    rcRender() {},
    advance(rcArg, i) { calls.advance.push(i); },
    setInterval() { calls.intervals += 1; return 1; },
    clearInterval() { calls.cleared += 1; },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('runStage'), context);
  return { context, rc };
}

test('耗时 0 的本地模拟阶段不等待、运行即结束', () => {
  const calls = { advance: [], archived: [], intervals: 0, cleared: 0 };
  const { context, rc } = loadRunContext({ id: 'a', name: '构建', dur: 0, sub: ['编译'] }, calls);
  context.runStage(rc, 0);
  assert.equal(rc.nodes.a.status, 'success');
  assert.equal(rc.nodes.a.progress, 100);
  assert.equal(rc.nodes.a.sub['编译'], 'success');
  assert.deepEqual(calls.advance, [1], '立即推进到下一阶段');
  assert.equal(calls.intervals, 0, '耗时 0 不再启动计时器空转等待');
  assert.equal(calls.archived.length, 1, '回显归档与计时路径一致');
});

test('耗时非 0 的本地模拟阶段仍按计时器推进（回归）', () => {
  const calls = { advance: [], archived: [], intervals: 0, cleared: 0 };
  const { context, rc } = loadRunContext({ id: 'a', name: '构建', dur: 5, sub: [] }, calls);
  context.runStage(rc, 0);
  assert.equal(rc.nodes.a.status, 'running');
  assert.equal(calls.intervals, 1, '耗时非 0 仍启动计时器按耗时等待');
  assert.deepEqual(calls.advance, []);
});
