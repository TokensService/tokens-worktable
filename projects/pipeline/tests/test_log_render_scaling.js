const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function loadBuildLog() {
  const start = source.indexOf('function stageOutputLines(');
  const end = source.indexOf('/* ---------- 运行队列 + 调度 ---------- */', start);
  if (start < 0 || end < 0) throw new Error('buildLog not found');
  const context = {
    PRESET_DEF: {}, LOGS: {}, REGISTRY: '', GITURL: '', DEFAULT_IMAGE: '',
    stageUrlOf: () => '', fmtDur: String,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context.buildLog;
}

function renderFixture(output) {
  const stage = {
    id: 'heavy', name: '大量输出',
    script: { name: 'heavy.sh', path: '/tmp/heavy.sh', params: [] },
    _out: { stdout: output, stderr: '', code: null },
  };
  const makeContainer = () => ({
    style: {}, children: [], innerHTML: '', textContent: '',
    appendChild(node) {
      if (node && Array.isArray(node.children) && node.isFragment) this.children.push(...node.children);
      else this.children.push(node);
    },
  });
  const elements = {
    detailTitle: makeContainer(), detailBadge: makeContainer(), detailKv: makeContainer(),
    detailBar: makeContainer(), detailBarWrap: makeContainer(), detailLog: makeContainer(),
  };
  Object.assign(elements.detailLog, { scrollTop: 0, clientHeight: 480, scrollHeight: 1000 });
  const context = {
    replayRec: null, selectedId: stage.id, nodes: { [stage.id]: { status: 'running', progress: 10, varsIn: {}, varsOut: {} } },
    curRun: { commit: 'abc', env: 'dev', branch: 'dev', image: 'image', release: 'image', tag: 'tag', by: 'tester', pipelineName: 'P' },
    flowStages: () => [stage], curPipeline: () => ({ name: 'P' }), viewActive: () => true,
    $: id => elements[id], PRESET_DEF: {}, LOGS: {}, REGISTRY: '', GITURL: '', DEFAULT_IMAGE: '',
    stageUrlOf: () => '', fmtDur: String, esc: value => String(value == null ? '' : value),
    document: {
      createElement: () => ({ style: {}, className: '', textContent: '', innerHTML: '', children: [], appendChild(node) { this.children.push(node); }, addEventListener() {} }),
      createDocumentFragment: () => ({ isFragment: true, children: [], appendChild(node) { this.children.push(node); } }),
    },
  };
  const renderStart = source.indexOf("let _detailKey='';");
  const renderEnd = source.indexOf('/* 日志行着色分类', renderStart);
  const logStart = source.indexOf('function logClass(', renderEnd);
  const logEnd = source.indexOf('/* ---------- 运行队列 + 调度 ---------- */', logStart);
  vm.createContext(context);
  vm.runInContext(source.slice(renderStart, renderEnd) + '\n' + source.slice(logStart, logEnd), context);
  const buildLog = context.buildLog;
  let buildCount = 0;
  context.buildLog = (...args) => { buildCount++; return buildLog(...args); };
  return { context, elements, stage, buildCount: () => buildCount };
}

test('阶段详情限制超大日志行数，归档调用仍可取得完整内容', () => {
  const buildLog = loadBuildLog();
  const output = Array.from({ length: 20000 }, (_, i) => 'line-' + String(i).padStart(5, '0')).join('\n');
  const stage = {
    id: 'heavy', name: '大量输出',
    script: { name: 'heavy.sh', path: '/tmp/heavy.sh', params: [] },
    _out: { stdout: output, stderr: '', code: 0 },
  };

  const display = buildLog(stage, {}, { status: 'success' }, { maxLines: 1000, maxChars: 256 * 1024 });
  assert.ok(display.length <= 1003, '详情最多创建约 1000 个日志行节点');
  assert.match(display.join('\n'), /仅显示.*末尾/);
  assert.doesNotMatch(display.join('\n'), /line-00000/);
  assert.match(display.join('\n'), /line-19999/);

  const archived = buildLog(stage, {}, { status: 'success' });
  assert.match(archived.join('\n'), /line-00000/);
  assert.match(archived.join('\n'), /line-19999/);
  assert.ok(archived.length > 20000, '未指定展示限制时必须保留完整日志');
});

test('EvalTokens 长轮询回显也使用同一详情窗口', () => {
  const buildLog = loadBuildLog();
  const output = Array.from({ length: 5000 }, (_, i) => 'poll-' + String(i).padStart(5, '0')).join('\n');
  const stage = { id: 'eval', name: '评测', kind: 'evaltokens', evaltokens: { taskId: 'task' }, _out: { stdout: output, stderr: '', code: null, done: false } };
  const display = buildLog(stage, {}, { status: 'running' }, { maxLines: 1000, maxChars: 256 * 1024 });
  const text = display.join('\n');
  assert.ok(display.length <= 1003);
  assert.match(text, /仅显示.*末尾/);
  assert.doesNotMatch(text, /poll-00000/);
  assert.match(text, /poll-04999/);
});

test('详情面板实际使用有界日志窗口', () => {
  const output = Array.from({ length: 20000 }, (_, i) => 'line-' + String(i).padStart(5, '0')).join('\n');
  const { context, elements } = renderFixture(output);
  context.renderDetail();
  const text = elements.detailLog.children.map(node => node.textContent).join('\n');
  assert.ok(elements.detailLog.children.length <= 1002, '详情 DOM 节点数必须保持有界');
  assert.match(text, /仅显示.*末尾/);
  assert.doesNotMatch(text, /line-00000/);
  assert.match(text, /line-19999/);
});

test('长任务只有进度变化时不重复构建日志，新增输出后刷新', () => {
  const { context, stage, buildCount } = renderFixture('first\nsecond');
  context.renderDetail();
  assert.equal(buildCount(), 1);

  context.nodes.heavy.progress = 30;
  context.renderDetail();
  assert.equal(buildCount(), 1, '进度 tick 不应重新拆分未变化的日志');

  stage._out.stdout += '\nthird';
  context.renderDetail();
  assert.equal(buildCount(), 2, '新增输出必须让详情重新构建');
});

test('流式运行的实时快照保持有界，最终 stdout 契约仍完整', async () => {
  const start = source.indexOf('async function runScriptStep(rc, i)');
  const end = source.indexOf('function runStage(rc, i)', start);
  if (start < 0 || end < 0) throw new Error('runScriptStep not found');
  const stage = { id: 'heavy', name: '大量输出', script: { name: 'heavy.sh', path: '/tmp/heavy.sh', params: [] } };
  const rc = {
    id: 'run', stages: [stage], nodes: {}, selId: null, timer: null, over: false, token: 1, vars: {},
    env: '', envs: [], image: 'image', tag: 'tag', pipelineName: 'P', archive: '/logs',
  };
  const chunk = 'x'.repeat(200 * 1024);
  const fullOutput = chunk.repeat(6);
  let maxLiveChars = 0;
  let sawTruncated = false;
  const context = {
    console, AbortController, setInterval: () => 1, clearInterval() {},
    viewRc: rc, selectedId: stage.id,
    runSetSel(run, id) { run.selId = id; context.selectedId = id; }, rcRender() {}, renderDetail() {},
    archiveFolderFor: () => '/logs', taskLogFile: () => 'stage.log',
    mergeStageVars: () => ({}), applyOutVars() {}, parseStageJson: () => null, archiveStageLog() {}, stageSeq: () => 1,
    advance() {}, finish() {},
    async execScript(_script, _timeout, _env, _run, onStream) {
      onStream({ type: 'log', logFile: '/logs/stage.log' });
      for (let i = 0; i < 6; i++) {
        onStream({ type: 'out', text: chunk });
        maxLiveChars = Math.max(maxLiveChars, stage._out.stdout.length);
        sawTruncated = sawTruncated || !!stage._out._stdoutTruncated;
      }
      return { code: 0, stdout: fullOutput, stderr: '', logFile: '/logs/stage.log' };
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  await context.runScriptStep(rc, 0);
  assert.ok(maxLiveChars <= 256 * 1024, '实时预览不得复制完整 stdout');
  assert.equal(sawTruncated, true, '详情需知道前部内容已省略');
  assert.equal(stage._out.stdout.length, fullOutput.length, '阶段完成后仍保留完整 stdout 供变量传递');
});

test('持续输出期间详情刷新最多每 250ms 一次', async () => {
  const start = source.indexOf('async function runScriptStep(rc, i)');
  const end = source.indexOf('function runStage(rc, i)', start);
  const stage = { id: 'heavy', name: '大量输出', script: { name: 'heavy.sh', path: '/tmp/heavy.sh', params: [] } };
  const rc = { id: 'run', stages: [stage], nodes: {}, timer: null, over: false, token: 1, vars: {}, envs: [], image: 'image', tag: 'tag', pipelineName: 'P' };
  let now = 1000;
  const renderedAt = [];
  const context = {
    console, AbortController, Date: { now: () => now }, setInterval: () => 1, clearInterval() {},
    viewRc: rc, selectedId: stage.id, runSetSel() {}, rcRender() {}, renderDetail() { renderedAt.push(now); },
    archiveFolderFor: () => null, taskLogFile: () => 'stage.log', mergeStageVars: () => ({}),
    applyOutVars() {}, parseStageJson: () => null, archiveStageLog() {}, stageSeq: () => 1, advance() {}, finish() {},
    async execScript(_script, _timeout, _env, _run, onStream) {
      for (const at of [1000, 1100, 1249, 1250]) { now = at; onStream({ type: 'out', text: 'line\n' }); }
      return { code: 0, stdout: 'line\n'.repeat(4), stderr: '' };
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.runScriptStep(rc, 0);
  assert.deepEqual(renderedAt, [1000, 1250]);
});
