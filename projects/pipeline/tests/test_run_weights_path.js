// 主控「权重路径」（可选 → MODEL_PATH 注入）与 PIPELINE_PRESETS（勾选预设任务的环境变量表示）契约测试：
//   1. execScript 运行级注入 MODEL_PATH/PIPELINE_PRESETS，优先级：阶段显式参数 > 上游阶段产出 > 运行级填写值；
//   2. substRunVars 参数值 ${MODEL_PATH}/${PIPELINE_PRESETS} 占位解析；
//   3. runPipeline 取数：默认读主控当前值，显式传参（含空串）优先并随队列/服务端提交快照；
//   4. 运行弹窗继承主控当前值、可逐项覆盖（含清空）。
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

/* execScript/substRunVars 沙盒：与 test_stage_variable_precedence.js 同一切片（substRunVars → runScriptStep 之前） */
function loadExecSandbox() {
  const start = source.indexOf('function substRunVars(v, rc)');
  const end = source.indexOf('async function runScriptStep(rc, i)', start);
  assert.ok(start >= 0 && end > start, 'substRunVars/execScript not found');
  const requests = [];
  const context = {
    JSON,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return { json: async () => ({ code: 0, stdout: '', stderr: '' }) };
    },
  };
  vm.createContext(context);
  vm.runInContext(`let curRun = null; let scriptsDir = "/tmp/scripts";\n${source.slice(start, end)}`, context);
  return { context, requests };
}

function makeRc(overrides) {
  return Object.assign({
    id: 'rc-w', stages: [], nodes: {}, selId: null, timer: null, over: false, overall: null, token: 'tk-w',
    vars: {}, env: '192.0.2.10', envs: [{ ip: '192.0.2.10', user: 'root', pass: 'secret' }],
    image: 'img', release: null, commit: null, tag: 't1', startTs: 0, by: 'tester', source: 'test',
    pipelineId: 'pl-w', pipelineName: 'weights-test', repoId: null, repoName: null, repoUrl: null, giturl: null,
    repoUser: null, repoPass: null, branch: 'main', strategy: '', weightsPath: '', presets: [], prom: null, archive: null,
  }, overrides || {});
}

test('execScript 注入运行级 MODEL_PATH 与 PIPELINE_PRESETS', async () => {
  const { context, requests } = loadExecSandbox();
  const rc = makeRc({ weightsPath: '/models/glm52', presets: ['cleanup', 'profiling'] });
  await context.execScript({ path: '/tmp/a.sh', params: [], values: {} }, 0, null, rc);
  const env = requests[0].env;
  assert.equal(env.MODEL_PATH, '/models/glm52', '主控「权重路径」作为 MODEL_PATH 注入');
  assert.equal(env.PIPELINE_PRESETS, '["cleanup","profiling"]', '勾选的预设任务 key 以 JSON 数组注入');
});

test('execScript：权重路径留空不注入 MODEL_PATH；未选预设时 PIPELINE_PRESETS 为空数组', async () => {
  const { context, requests } = loadExecSandbox();
  const rc = makeRc({ weightsPath: '', presets: [] });
  await context.execScript({ path: '/tmp/a.sh', params: [], values: {} }, 0, null, rc);
  const env = requests[0].env;
  assert.ok(!('MODEL_PATH' in env), '留空不注入，由脚本自身默认值兜底');
  assert.equal(env.PIPELINE_PRESETS, '[]');
});

test('execScript：阶段显式参数与上游阶段产出的同名变量优先于运行级权重路径', async () => {
  const { context, requests } = loadExecSandbox();
  const rc = makeRc({ weightsPath: '/models/run-level', vars: { MODEL_PATH: '/models/from-upstream' } });
  await context.execScript({ path: '/tmp/a.sh', params: [], values: {} }, 0, null, rc);
  assert.equal(requests[0].env.MODEL_PATH, '/models/from-upstream', '上游阶段产出优先');
  await context.execScript({ path: '/tmp/a.sh', params: [{ kind: 'env', key: 'MODEL_PATH', def: '' }], values: { MODEL_PATH: '/models/explicit' } }, 0, null, rc);
  assert.equal(requests[1].env.MODEL_PATH, '/models/explicit', '阶段显式参数最优先');
  const rc2 = makeRc({ weightsPath: '/models/run-level', presets: ['profiling'], vars: { PIPELINE_PRESETS: '["check"]' } });
  await context.execScript({ path: '/tmp/a.sh', params: [], values: {} }, 0, null, rc2);
  assert.equal(requests[2].env.PIPELINE_PRESETS, '["check"]', '上游同名变量优先于运行级预设注入');
});

test('substRunVars：${MODEL_PATH}/${PIPELINE_PRESETS} 按运行级填写值解析，未填写保持未解析', async () => {
  const { context } = loadExecSandbox();
  const rc = makeRc({ weightsPath: '/models/glm52', presets: ['profiling'] });
  assert.equal(context.substRunVars('${MODEL_PATH}', rc), '/models/glm52');
  assert.equal(context.substRunVars('${PIPELINE_PRESETS}', rc), '["profiling"]');
  const empty = makeRc({});
  assert.equal(context.substRunVars('${MODEL_PATH}', empty), '', '整值单个未定义引用按空值处理（继承上游同名变量）');
  assert.equal(context.substRunVars('img-${MODEL_PATH}', empty), 'img-${MODEL_PATH}', '非整值引用原样保留');
});

/* runPipeline 沙盒：全部阶段带 sched 标记时走 submitServerRun，直接捕获入队/提交快照 */
function loadRunPipeline(mainWeights) {
  const submitted = [];
  const elements = {
    repoSel: { value: 'repo-a' },
    branchName: { value: 'main-branch' },
    deployStrategyName: { value: '' },
    weightsPath: { value: mainWeights },
  };
  const context = {
    console, JSON, Date, Math, Array, Object, String, Set,
    DEFAULT_IMAGE: 'app', QUEUE_CAP: 16, MAX_ACTIVE_RUNS: 4,
    currentUsername: 'tester',
    pipelines: [{ id: 'pl-1', name: 'PL', stages: [{ id: 's1', name: '构建', sched: {} }] }],
    curPipelineId: 'pl-1',
    queue: [], activeRuns: [],
    $: id => elements[id] || null,
    findPipeline: id => context.pipelines.find(p => p.id === id),
    curPipeline: () => context.pipelines[0],
    curEnvs: () => [],
    resolveEnv: v => ({ id: '', name: String(v), ip: String(v) }),
    resolveRepo: () => ({ id: 'repo-a', name: 'A' }),
    curStrategy: () => elements.deployStrategyName.value,
    selectedPresetKeys: () => [],
    resolvePipelineRunOptions: (pl, opts) => opts,
    conflictsActive: () => true,   // 不纠缠本地并行判定：全部走「提交服务端」出口
    machineConflict: () => true,
    renderQueue: () => {},
    submitServerRun: item => submitted.push(item),
    alert: msg => { throw new Error('unexpected alert: ' + msg); },
  };
  vm.createContext(context);
  vm.runInContext(
    extractFunction('curWeightsPath') + '\n' + extractFunction('runPipeline'),
    context,
  );
  return { context, submitted, elements };
}

test('runPipeline 默认读取主控「权重路径」当前值', () => {
  const { context, submitted } = loadRunPipeline('/models/main-value');
  context.runPipeline({});
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].weightsPath, '/models/main-value');
});

test('runPipeline 显式传参优先（含空串覆盖主控当前值）', () => {
  const { context, submitted } = loadRunPipeline('/models/main-value');
  context.runPipeline({ weightsPath: ' /models/dialog-value ' });
  context.runPipeline({ weightsPath: '' });
  assert.equal(submitted[0].weightsPath, '/models/dialog-value', '弹窗覆盖值（去空白）');
  assert.equal(submitted[1].weightsPath, '', '显式空串=不注入，不回退主控当前值');
});

/* 运行弹窗沙盒：与 test_pipeline_run_dialog.js 同一双切片（默认运行参数 + 弹窗） */
function loadDialogSandbox(mainWeights) {
  const elements = {
    pipelineRunDialog: { style: { display: 'none' } },
    pipelineRunTitle: { textContent: '' },
    pipelineRunBranch: { value: '', focus() {} },
    pipelineRunBranchPanel: { style: { display: 'none' } },
    pipelineRunStrategy: { value: '', focus() {} },
    pipelineRunStrategyPanel: { style: { display: 'none' } },
    pipelineRunRepo: { innerHTML: '', value: '', appendChild(o) { if (!this.options) this.options = []; this.options.push(o); } },
    pipelineRunWeightsPath: { value: '' },
    pipelineRunPresets: { querySelectorAll: () => [] },
    pipelineRunWarning: { textContent: '', style: { display: 'none' } },
    repoSel: { value: 'repo-a' },
    branchName: { value: 'main-branch' },
    deployStrategyName: { value: '' },
    weightsPath: { value: mainWeights },
  };
  const context = {
    console, JSON, Array, Object, String,
    environments: [], pipelines: [{ id: 'pl-1', name: 'PL', stages: [{ id: 's1' }] }],
    repositories: [{ id: 'repo-a', name: 'A', url: 'a.git' }],
    currentUsername: 'tester',
    $: id => elements[id] || null,
    document: { body: { appendChild() {} }, createElement: () => ({ value: '', textContent: '' }) },
    curEnvs: () => [],
    curRepo: () => context.repositories[0],
    curStrategy: () => '',
    curWeightsPath: () => elements.weightsPath.value,
    selectedPresetKeys: () => [],
    resolveRepo: id => context.repositories.find(r => r.id === id),
    findPipeline: id => context.pipelines.find(p => p.id === id),
    renderEnvMulti: () => {},
    loadDeployStrategies: () => Promise.resolve(),
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
  return { context, elements };
}

test('运行弹窗继承主控「权重路径」当前值，可覆盖或清空', () => {
  const { context, elements } = loadDialogSandbox('/models/main-value');
  context.openPipelineRunDialog('pl-1');
  assert.equal(elements.pipelineRunWeightsPath.value, '/models/main-value', '打开弹窗继承主控当前值');
  elements.pipelineRunWeightsPath.value = ' /models/dialog-override ';
  assert.equal(context.collectPipelineRunDialogOptions().weightsPath, '/models/dialog-override', '弹窗覆盖值去空白后传给运行');
  elements.pipelineRunWeightsPath.value = '';
  assert.equal(context.collectPipelineRunDialogOptions().weightsPath, '', '弹窗清空=显式不注入');
});

test('运行行包含「权重路径」输入框（可选）且运行弹窗同名字段齐备', () => {
  assert.ok(/<input id="weightsPath"/.test(source), '主控缺少 weightsPath 输入框');
  assert.ok(/<input id="pipelineRunWeightsPath"/.test(source), '运行弹窗缺少 pipelineRunWeightsPath 输入框');
  assert.match(source, /localStorage\.setItem\('pip-weightsPath'/, '权重路径应仅本地持久化（pip-weightsPath）');
});
