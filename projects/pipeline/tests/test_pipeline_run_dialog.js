// 流水线任务列表运行弹窗：按流水线默认值展示参数，确认后以临时参数运行。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function slice(startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start);
  assert.ok(start >= 0 && end > start, 'slice not found: ' + startMark);
  return source.slice(start, end);
}

function extractFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, 'function not found: ' + name);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error('function not closed: ' + name);
}

class FakeSelect {
  constructor() {
    this.options = [];
    this._value = '';
  }
  set innerHTML(value) {
    if (!value) {
      this.options = [];
      this._value = '';
    }
  }
  get innerHTML() { return ''; }
  appendChild(option) {
    this.options.push(option);
    if (this.options.length === 1) this._value = option.value;
  }
  set value(value) {
    this._value = this.options.some(option => option.value === value) ? value : '';
  }
  get value() { return this._value; }
}

class FakePanel {
  constructor() {
    this.style = { display: 'none' };
    this.innerHTML = '';
    this.handlers = [];
  }
  querySelectorAll(selector) {
    const attribute = selector === '[data-branch]' ? 'data-branch' : selector === '[data-strategy]' ? 'data-strategy' : null;
    if (!attribute) return [];
    const pattern = new RegExp(attribute + '="([^"]*)"', 'g');
    return Array.from(this.innerHTML.matchAll(pattern), match => ({
      getAttribute: name => name === attribute ? match[1] : null,
      addEventListener: (event, handler) => this.handlers.push({ event, handler, value: match[1] }),
    }));
  }
  querySelector() { return null; }
}

function makeContext(runResult = 'submitted') {
  const presetInputs = ['cleanup', 'check', 'profiling'].map(key => ({
    checked: false,
    getAttribute: name => name === 'data-pipelinerunpreset' ? key : null,
  }));
  const elements = {
    pipelineRunDialog: { style: { display: 'none' } },
    pipelineRunTitle: { textContent: '' },
    pipelineRunBranch: { value: '', focus() {} },
    pipelineRunBranchPanel: new FakePanel(),
    pipelineRunStrategy: { value: '', focus() {} },
    pipelineRunStrategyPanel: new FakePanel(),
    pipelineRunRepo: new FakeSelect(),
    pipelineRunPresets: { querySelectorAll: () => presetInputs },
    pipelineRunWarning: { textContent: '', style: { display: 'none' } },
    repoSel: new FakeSelect(),
    branchName: { value: 'main-control-branch' },
    deployStrategyName: { value: 'main-control-strategy' },
  };
  const body = {
    children: [],
    appendChild(node) {
      node.parentNode = this;
      this.children.push(node);
    },
  };
  const calls = { run: [], tips: [], alerts: [] };
  let envControl = null;
  const context = {
    console,
    environments: [
      { id: 'env-a', name: '开发', ip: '10.0.0.1' },
      { id: 'env-b', name: '生产', ip: '10.0.0.2' },
    ],
    repositories: [
      { id: 'repo-a', name: '仓库 A', url: 'a.git' },
      { id: 'repo-b', name: '仓库 B', url: 'b.git' },
    ],
    pipelines: [{
      id: 'pipe-2', name: '流水线二', stages: [{ id: 'build', name: '构建' }],
      defaults: {
        environmentIds: ['env-b'], repositoryId: 'repo-b', branch: 'release/2026.09',
        strategy: 'blue-green', presets: ['check', 'profiling'],
      },
    }],
    currentUsername: 'operator',
    curRepoId: 'repo-a',
    queue: [],
    $: id => elements[id] || null,
    document: { body, createElement: tag => ({ tag, value: '', textContent: '' }) },
    curEnvs: () => [context.environments[0]],
    curRepo: () => context.repositories.find(repo => repo.id === elements.repoSel.value) || context.repositories[0],
    curStrategy: () => elements.deployStrategyName.value,
    selectedPresetKeys: () => ['cleanup'],
    resolveRepo: id => context.repositories.find(repo => repo.id === id),
    esc: value => String(value),
    isJenkinsFetchMode: () => false,
    fetchModeLabel: () => '服务端',
    loadingDots: () => '...',
    findPipeline: id => context.pipelines.find(pipeline => pipeline.id === id),
    renderEnvMulti: options => { envControl = options; },
    loadDeployStrategies: () => Promise.resolve(),
    runPipeline: options => {
      calls.run.push(options);
      if (runResult === 'queued') context.queue.push(options);
      return runResult;
    },
    flashRunTip: text => calls.tips.push(text),
    alert: text => calls.alerts.push(String(text)),
    QUEUE_CAP: 16,
  };
  vm.createContext(context);
  vm.runInContext(slice(
    '/* ---------- 流水线默认运行参数 ---------- */',
    '/* ---------- 流水线默认运行参数结束 ---------- */',
  ), context);
  vm.runInContext(slice(
    '/* ---------- 流水线任务列表运行弹窗 ---------- */',
    '/* ---------- 流水线任务列表运行弹窗结束 ---------- */',
  ), context);
  return { context, elements, presetInputs, calls, body, getEnvControl: () => envControl };
}

const J = value => JSON.parse(JSON.stringify(value));

test('运行弹窗包含运行参数字段且不提供执行人设置', () => {
  const start = source.indexOf('<div id="pipelineRunDialog"');
  const end = source.indexOf('<!-- 单条流水线 API 调用说明', start);
  assert.ok(start >= 0 && end > start, '缺少流水线运行弹窗');
  const html = source.slice(start, end);
  ['pipelineRunEnvMultiBtn', 'pipelineRunRepo', 'pipelineRunBranch', 'pipelineRunBranchPanel', 'pipelineRunStrategy', 'pipelineRunStrategyPanel', 'pipelineRunPresets', 'pipelineRunSubmit']
    .forEach(id => assert.match(html, new RegExp('id="' + id + '"')));
  assert.doesNotMatch(html, /执行人|triggeredBy|pipelineRunBy/);
});

test('打开弹窗继承运行流水线当前值，不改动或启动当前流水线', () => {
  const { context, elements, presetInputs, calls, getEnvControl } = makeContext();
  context.openPipelineRunDialog('pipe-2');

  assert.equal(elements.pipelineRunDialog.style.display, 'flex');
  assert.equal(elements.pipelineRunTitle.textContent, '运行流水线：流水线二');
  assert.deepEqual(J(getEnvControl().getIds()), ['env-a']);
  assert.equal(elements.pipelineRunRepo.value, 'repo-a');
  assert.equal(elements.pipelineRunBranch.value, 'main-control-branch');
  assert.equal(elements.pipelineRunStrategy.value, 'main-control-strategy');
  assert.deepEqual(presetInputs.filter(input => input.checked).map(input => input.getAttribute('data-pipelinerunpreset')), ['cleanup']);
  assert.deepEqual(calls.run, []);
});

test('打开运行弹窗将分支与策略列表提升到 body 浮层', () => {
  const { context, elements, body } = makeContext();

  context.openPipelineRunDialog('pipe-2');

  assert.ok(body.children.includes(elements.pipelineRunBranchPanel));
  assert.ok(body.children.includes(elements.pipelineRunStrategyPanel));
});

test('运行弹窗的分支与策略面板使用弹窗输入和代码仓上下文', () => {
  const { context, elements } = makeContext();
  context.openPipelineRunDialog('pipe-2');
  vm.runInContext(extractFunction('pickCtx'), context);
  const runCtx = context.pickCtx('run');

  assert.equal(runCtx.inp, elements.pipelineRunBranch);
  assert.equal(runCtx.panel, elements.pipelineRunBranchPanel);
  assert.equal(runCtx.strategyInp, elements.pipelineRunStrategy);
  assert.equal(runCtx.strategyPanel, elements.pipelineRunStrategyPanel);
  elements.pipelineRunRepo.value = 'repo-b';
  assert.equal(runCtx.repo().id, 'repo-b');
  assert.equal(runCtx.branch(), 'main-control-branch');
});

test('运行弹窗点选分支与部署策略会回填弹窗字段', () => {
  const { context, elements } = makeContext();
  context.openPipelineRunDialog('pipe-2');
  context.repoBranches = { 'repo-a': { branches: ['feature/dialog'], tags: ['v2026.09'], error: '' } };
  context.deployStrategies = { 'repo-a|feature/dialog|u:strategy-url': { items: ['blue-green'], error: '' } };
  vm.runInContext(extractFunction('pickCtx'), context);
  vm.runInContext(extractFunction('renderBranchPanel'), context);
  vm.runInContext(extractFunction('strategySourceOf'), context);
  vm.runInContext(extractFunction('deployStrategyKey'), context);
  vm.runInContext(extractFunction('renderStrategyPanel'), context);
  context.repositories[0].strategyUrl = 'strategy-url';

  context.renderBranchPanel(true, 'run');
  const branchItem = elements.pipelineRunBranchPanel.querySelectorAll('[data-branch]')[0];
  branchItem.handlers = [];
  elements.pipelineRunBranchPanel.handlers[0].handler();
  assert.equal(elements.pipelineRunBranch.value, 'feature/dialog');

  context.renderStrategyPanel(true, 'run');
  const strategyItem = elements.pipelineRunStrategyPanel.querySelectorAll('[data-strategy]')
    .find(item => item.getAttribute('data-strategy') === 'blue-green');
  assert.ok(strategyItem);
  const strategyHandler = elements.pipelineRunStrategyPanel.handlers.find(entry => entry.value === 'blue-green');
  strategyHandler.handler();
  assert.equal(elements.pipelineRunStrategy.value, 'blue-green');
});

test('确认弹窗把临时参数显式交给运行流程，执行人仍由登录用户统一注入', () => {
  const { context, elements, presetInputs, calls, getEnvControl } = makeContext('submitted');
  context.openPipelineRunDialog('pipe-2');
  getEnvControl().setIds(['env-a']);
  elements.pipelineRunRepo.value = 'repo-a';
  elements.pipelineRunBranch.value = ' feature/dialog ';
  elements.pipelineRunStrategy.value = '';
  presetInputs.forEach(input => { input.checked = input.getAttribute('data-pipelinerunpreset') === 'cleanup'; });

  context.submitPipelineRunDialog();

  assert.deepEqual(J(calls.run), [{
    pipelineId: 'pipe-2', envs: [{ id: 'env-a', name: '开发', ip: '10.0.0.1' }],
    repoId: 'repo-a', branch: 'feature/dialog', strategy: '', presets: ['cleanup'],
  }]);
  assert.equal('by' in calls.run[0], false, '执行人必须继续由 runPipeline 读取当前登录用户');
  assert.equal('useDefaults' in calls.run[0], false, '确认后使用弹窗中的显式临时参数');
  assert.equal(elements.pipelineRunDialog.style.display, 'none');
  assert.deepEqual(calls.tips, ['已提交服务端运行队列']);
});

test('弹窗允许显式不选择环境；未选择代码仓时阻止运行并保持弹窗', () => {
  const { context, elements, calls, getEnvControl } = makeContext();
  context.openPipelineRunDialog('pipe-2');
  getEnvControl().setIds([]);
  elements.pipelineRunRepo.value = '';

  context.submitPipelineRunDialog();

  assert.deepEqual(calls.run, []);
  assert.match(calls.alerts[0], /请选择代码仓/);
  assert.equal(elements.pipelineRunDialog.style.display, 'flex');

  elements.pipelineRunRepo.value = 'repo-a';
  context.submitPipelineRunDialog();
  assert.deepEqual(J(calls.run[0].envs), []);
});

test('弹窗清空环境后，服务端运行不回退主运行框当前节点', () => {
  const { context, elements, getEnvControl } = makeContext();
  const submitted = [];
  context.pipelines[0].stages[0].sched = {};
  Object.assign(context, {
    Date, Math, DEFAULT_IMAGE: 'app', currentUsername: 'operator', curPipelineId: 'pipe-2',
    curPipeline: () => context.pipelines[0],
    curEnvs: () => [context.environments[0]],
    resolveRepo: id => context.repositories.find(repo => repo.id === id),
    curStrategy: () => 'main-control-strategy',
    selectedPresetKeys: () => ['profiling'],
    submitServerRun: item => submitted.push(item),
  });
  vm.runInContext(extractFunction('runPipeline'), context);
  context.openPipelineRunDialog('pipe-2');
  getEnvControl().setIds([]);
  elements.pipelineRunRepo.value = 'repo-b';

  context.submitPipelineRunDialog();

  assert.equal(submitted.length, 1);
  assert.deepEqual(J(submitted[0].envs), [], '显式空环境不得回退主运行框的 env-a');
  assert.equal(submitted[0].env, '');
  assert.equal(submitted[0].by, 'operator', '执行人由 runPipeline 取当前登录用户');
});

test('弹窗清空环境后，本地运行启动器仍保留空节点快照', () => {
  const { context, elements, getEnvControl } = makeContext();
  const started = [];
  Object.assign(context, {
    Date, Math, DEFAULT_IMAGE: 'app', currentUsername: 'operator', curPipelineId: 'pipe-2',
    curPipeline: () => context.pipelines[0],
    curEnvs: () => [context.environments[0]],
    resolveEnv: value => context.environments.find(env => env.id === value || env.ip === value),
    resolveRepo: id => context.repositories.find(repo => repo.id === id),
    curStrategy: () => 'main-control-strategy', selectedPresetKeys: () => ['profiling'],
    activeRuns: [], pendingLeaseStarts: [], MAX_ACTIVE_RUNS: 4,
    conflictsActive: () => false, machineConflict: () => false, renderQueue: () => {},
    startSimRun: (pipeline, runContext) => started.push({ pipeline, runContext }),
  });
  vm.runInContext(extractFunction('runIps'), context);
  vm.runInContext(extractFunction('startRun'), context);
  vm.runInContext(extractFunction('runPipeline'), context);
  context.openPipelineRunDialog('pipe-2');
  getEnvControl().setIds([]);
  elements.pipelineRunRepo.value = 'repo-b';

  context.submitPipelineRunDialog();

  assert.equal(started.length, 1);
  assert.deepEqual(J(started[0].runContext.envs), [], 'startRun 不得把空快照改成主运行框的 env-a');
  assert.equal(started[0].runContext.env, '');
});

test('弹窗打开后目标流水线被后台同步删除时阻止错跑当前流水线', () => {
  const { context, elements, calls } = makeContext();
  context.openPipelineRunDialog('pipe-2');
  context.pipelines = [];

  context.submitPipelineRunDialog();

  assert.deepEqual(calls.run, []);
  assert.match(calls.alerts[0], /流水线已不存在/);
  assert.equal(elements.pipelineRunDialog.style.display, 'none');
});

[
  { result: true, name: '本地立即运行成功', display: 'none', tips: [], alert: null },
  { result: 'queued', name: '加入本地队列', display: 'none', tips: ['已加入本地队列（第 1 位）'], alert: null },
  { result: false, name: '本地队列已满', display: 'flex', tips: [], alert: /本地队列已满/ },
  { result: 'no-by', name: '登录身份缺失', display: 'flex', tips: [], alert: null },
].forEach(entry => test('确认运行结果：' + entry.name, () => {
  const { context, elements, calls } = makeContext(entry.result);
  context.openPipelineRunDialog('pipe-2');

  context.submitPipelineRunDialog();

  assert.equal(calls.run.length, 1);
  assert.equal(elements.pipelineRunDialog.style.display, entry.display);
  assert.deepEqual(calls.tips, entry.tips);
  if (entry.alert) assert.match(calls.alerts[0], entry.alert);
  else assert.deepEqual(calls.alerts, []);
}));
