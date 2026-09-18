const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function extractFunction(name) {
  const marker = new RegExp(`function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `pipeline.html 缺少函数 ${name}`);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error(`无法提取函数 ${name}`);
}

function fakeClassList() {
  const values = new Set();
  return {
    add: value => values.add(value),
    remove: (...items) => items.forEach(item => values.delete(item)),
    toggle(value, force) {
      const enabled = force === undefined ? !values.has(value) : !!force;
      if (enabled) values.add(value); else values.delete(value);
      return enabled;
    },
  };
}

function styleFromAttribute(attrs) {
  const style = {};
  const match = /style="([^"]*)"/i.exec(attrs);
  if (!match) return style;
  match[1].split(';').forEach(part => {
    const at = part.indexOf(':');
    if (at < 0) return;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key) style[key] = value;
  });
  return style;
}

/* renderStageEditor 使用 innerHTML 组装任务卡；假 DOM 只解析本测试关心的 details/summary 可观察行为。 */
class StageRow {
  constructor(index) {
    this.dataset = { idx: String(index) };
    this.classList = fakeClassList();
    this.style = {};
    this.handlers = {};
    this.paramPanel = null;
  }
  set innerHTML(value) {
    this._innerHTML = String(value);
    const details = /<details\b([^>]*)>/i.exec(this._innerHTML);
    if (!details || !/\bdata-param-panel\b/i.test(details[1])) {
      this.paramPanel = null;
      return;
    }
    const summaryMatch = /<summary\b[^>]*data-param-summary[^>]*>([^<]*)<\/summary>/i.exec(this._innerHTML);
    const summary = { textContent: summaryMatch ? summaryMatch[1] : '' };
    this.paramPanel = {
      tagName: 'DETAILS',
      open: /(?:^|\s)open(?:\s|=|$)/i.test(details[1]),
      style: styleFromAttribute(details[1]),
      querySelector: selector => selector === '[data-param-summary]' ? summary : null,
    };
  }
  get innerHTML() { return this._innerHTML || ''; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  querySelector(selector) {
    if (selector === '[data-param-panel]') return this.paramPanel;
    return null;
  }
  querySelectorAll() { return []; }
  insertAdjacentHTML() {}
}

test('任务参数面板使用 details 且任务卡首次渲染时默认折叠', () => {
  const rows = [];
  const stageList = {
    children: rows,
    innerHTML: '',
    appendChild(row) { rows.push(row); },
  };
  const context = {
    editStages: [{ id: 'build', name: '构建', kind: 'shell', dur: 0, timeout: null, skip: false, parallel: false }],
    editFocusIdx: -1,
    editSelStage: null,
    plFormReadOnly: false,
    STAGE_KIND_LABEL: { simulate: '模拟', shell: 'Shell', python: 'Python', http: 'HTTP', evaltokens: 'EvalTokens' },
    $: id => id === 'plStageList' ? stageList : null,
    esc: String,
    secToMinInput: String,
    renderStageActionRow() {},
    renderStageParams() {},
    renderStageSched() {},
    applyPlFormReadOnly() {},
    applyEditSel() {},
    stageCardMouseDown() {},
    stageCardDragStart() {},
    stageCardDragOver() {},
    stageCardDrop() {},
    stageCardDragEnd() {},
    document: {
      createElement() {
        const row = new StageRow(rows.length);
        return row;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('renderStageEditor'), context);

  context.renderStageEditor();

  const panel = rows[0].querySelector('[data-param-panel]');
  assert.ok(panel, '普通任务卡应渲染任务参数折叠面板');
  assert.equal(panel.tagName, 'DETAILS');
  assert.equal(panel.open, false, '未设置 open，首次进入编辑器默认折叠');
});

function fakeElement(tagName = 'div') {
  const element = {
    tagName,
    children: [],
    attributes: {},
    style: {},
    className: '',
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(type, handler) { (this._handlers = this._handlers || {})[type] = handler; },
    querySelector(selector) {
      if (selector === 'input') return this.children.find(child => child.tagName === 'input') || null;
      return null;
    },
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return this._innerHTML || ''; },
    set(value) {
      this._innerHTML = String(value);
      this.children = [];
      if (this.tagName !== 'label' || !/<input\b/i.test(this._innerHTML)) return;
      const input = fakeElement('input');
      const key = /data-pkey="([^"]*)"/.exec(this._innerHTML);
      const val = /\bvalue="([^"]*)"/.exec(this._innerHTML);
      if (key) input.setAttribute('data-pkey', key[1]);
      input.value = val ? val[1] : '';
      this.appendChild(input);
    },
  });
  return element;
}

function renderParams(stage, initialDisplay, initialOpen = false) {
  const summary = { textContent: '旧标题' };
  const panel = {
    open: initialOpen,
    style: { display: initialDisplay },
    querySelector: selector => selector === '[data-param-summary]' ? summary : null,
  };
  const params = fakeElement();
  const row = {
    querySelector(selector) {
      if (selector === '[data-param-panel]') return panel;
      if (selector === '[data-params]') return params;
      return null;
    },
  };
  const context = {
    editStages: [stage],
    $: id => id === 'plStageList' ? { children: [row] } : null,
    esc: String,
    document: {
      createElement: tag => fakeElement(tag),
      createTextNode: text => ({ textContent: text }),
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('renderStageParams'), context);
  context.renderStageParams(0);
  return { panel, summary, params };
}

test('Shell 与 Python 任务有参数时显示面板并在标题标出参数数量', () => {
  for (const kind of ['shell', 'python']) {
    const stage = {
      kind,
      script: {
        values: {},
        params: [
          { key: '1', label: '位置参数 1', def: '', required: false },
          { key: 'IMAGE_NAME', label: '镜像名', def: 'demo:latest', required: false },
        ],
      },
    };

    const { panel, summary, params } = renderParams(stage, 'none');

    assert.equal(panel.style.display, '', `${kind} 识别到参数后显示折叠面板`);
    assert.equal(summary.textContent, '任务参数（2）');
    assert.equal(params.children.filter(child => child.tagName === 'label').length, 2);
  }
});

test('EvalTokens 任务输入参数复用折叠面板并显示参数数量', () => {
  const stage = {
    kind: 'evaltokens',
    evaltokens: {
      values: {},
      params: [{ key: 'model', label: 'model', def: 'qwen', required: false }],
    },
  };

  const { panel, summary } = renderParams(stage, 'none');

  assert.equal(panel.style.display, '');
  assert.equal(summary.textContent, '任务参数（1）');
});

test('无参数类型与空参数列表隐藏整个折叠面板', () => {
  const staleScript = {
    values: {},
    params: [{ key: 'OLD_PARAM', label: '旧参数', def: '', required: false }],
  };
  const cases = [
    ['切换为模拟后保留的旧脚本元数据', { kind: 'simulate', script: staleScript }],
    ['HTTP 保留的旧脚本元数据', { kind: 'http', script: staleScript }],
    ['Shell 空参数', { kind: 'shell', script: { values: {}, params: [] } }],
    ['Python 空参数', { kind: 'python', script: { values: {}, params: [] } }],
    ['EvalTokens 空参数', { kind: 'evaltokens', evaltokens: { values: {}, params: [] } }],
  ];

  for (const [label, stage] of cases) {
    const { panel, summary } = renderParams(stage, '');
    assert.equal(panel.style.display, 'none', label);
    assert.equal(summary.textContent, '任务参数（0）', label);
  }
});

test('参数字段重绘保留用户已经展开的面板状态', () => {
  const stage = {
    kind: 'shell',
    script: {
      values: {},
      params: [{ key: 'IMAGE_NAME', label: '镜像名', def: '', required: false }],
    },
  };

  const { panel } = renderParams(stage, '', true);

  assert.equal(panel.open, true);
});
