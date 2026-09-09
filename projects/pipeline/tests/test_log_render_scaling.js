const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function loadLogBuilders() {
  const start = source.indexOf('function stageOutputLines(');
  const end = source.indexOf('/* ---------- 运行队列 + 调度 ---------- */', start);
  if (start < 0 || end < 0) throw new Error('buildLog not found');
  const context = {
    PRESET_DEF: {}, LOGS: {}, REGISTRY: '', GITURL: '', DEFAULT_IMAGE: '',
    stageUrlOf: () => '', fmtDur: String,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}
function loadBuildLog() { return loadLogBuilders().buildLog; }

function liveHelpersSource() {
  const start = source.indexOf('function createLiveOutputState(');
  const end = source.indexOf('async function execStreaming(', start);
  if (start < 0 || end < 0) throw new Error('live output helpers not found');
  return source.slice(start, end);
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

test('归档构建保留大日志原始分片，不按百万行拆成数组', () => {
  const { buildLogParts } = loadLogBuilders();
  assert.equal(typeof buildLogParts, 'function', '需要独立的归档分片构建器');
  const output = Array.from({ length: 20000 }, (_, i) => 'archive-' + i).join('\n');
  const stage = {
    id: 'heavy', name: '大日志',
    script: { name: 'heavy.sh', path: '/tmp/heavy.sh', params: [] },
    _out: { stdout: output, stderr: '', code: 0 },
  };
  const parts = buildLogParts(stage, {}, { status: 'success' });
  assert.ok(parts.length < 20, `归档分片数不应随日志行数增长，实际 ${parts.length}`);
  assert.ok(parts.includes(output), '应直接复用 stdout 字符串分片');
  const text = parts.join('');
  assert.match(text, /^\$ bash heavy\.sh/);
  assert.match(text, /archive-19999/);
  assert.match(text, /\[exit 0\]$/);
});

test('归档分片通过 Blob 原始流上传，不进入 JSON content', async () => {
  const start = source.indexOf('async function apiWriteParts(');
  const end = source.indexOf('/* 按目录跟踪完整归档任务', start);
  assert.ok(start >= 0 && end > start, 'apiWriteParts not found');
  let request = null;
  const context = {
    Blob, encodeURIComponent,
    trackArchiveWrite: (_folder, task) => task(),
    fetch: async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const parts = ['head\n', 'x'.repeat(1024 * 1024), '\ntail'];
  await context.apiWriteParts('/tmp/run.log', parts);
  assert.match(request.url, /\/api\/worktable\/write-stream\?path=/);
  assert.ok(request.options.body instanceof Blob);
  assert.equal(await request.options.body.text(), parts.join(''));
  assert.equal(request.options.headers['Content-Type'], 'text/plain; charset=utf-8');
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

test('实时尾窗达到上限后仍按输出修订号刷新', () => {
  const head = 'H'.repeat(24);
  const tail = 'T'.repeat(96);
  const middleLength = 256 * 1024 - head.length - tail.length;
  const first = head + 'A'.repeat(middleLength) + tail;
  const second = head + 'B'.repeat(middleLength) + tail;
  const { context, stage, buildCount } = renderFixture(first);
  stage._out._outputRevision = 1;
  context.renderDetail();
  assert.equal(buildCount(), 1);

  // 长度、头 24 字符、尾 96 字符都相同；只有明确修订号能避免指纹碰撞。
  stage._out.stdout = second;
  stage._out._outputRevision = 2;
  context.renderDetail();
  assert.equal(buildCount(), 2, '尾窗内容已更新时不得因采样指纹相同而停留在旧画面');
});

test('共用实时输出状态限制快照、递增修订号并保留分片全文', () => {
  const context = { Date };
  vm.createContext(context);
  vm.runInContext(liveHelpersSource(), context);
  const state = context.createLiveOutputState();
  const chunk = 'x'.repeat(200 * 1024);
  for (let i = 0; i < 6; i++) context.appendLiveOutput(state, 'out', chunk);
  const snapshot = context.liveOutputSnapshot(state, { code: null });
  assert.ok(snapshot.stdout.length <= 256 * 1024);
  assert.equal(snapshot._stdoutTruncated, true);
  assert.equal(snapshot._outputRevision, 6);

  const log = context.createLiveLog('start');
  for (let i = 0; i < 6; i++) context.appendLiveLog(log, chunk);
  assert.ok(context.liveOutputSnapshot(log.live).stdout.length <= 256 * 1024);
  assert.equal(context.finishLiveLog(log).length, 'start'.length + 6 * (chunk.length + 1), '全文只保留分片，结束时再合并');
});

test('预设脚本的实时快照与普通脚本同样有界', async () => {
  const start = source.indexOf('async function runPresetStep(rc, i)');
  const end = source.indexOf('/* ---------- 产物归档', start);
  const stage = { id: 'preset', name: '环境清理', preset: true, pkey: 'cleanup', script: { name: 'clean.sh', path: '/tmp/clean.sh' } };
  const rc = { id: 'run', stages: [stage], nodes: {}, timer: null, over: false, token: 1, vars: {}, tag: 'tag', archive: '/logs' };
  const chunk = 'p'.repeat(200 * 1024);
  const fullOutput = chunk.repeat(6);
  let maxLiveChars = 0;
  const context = {
    console, AbortController, setInterval: () => 1, clearInterval() {}, Date,
    PRESET_DEF: { cleanup: { name: '环境清理', block: false } }, viewRc: rc, selectedId: stage.id,
    runSetSel() {}, rcRender() {}, rcOverall() {}, renderDetail() {},
    archiveFolderFor: () => '/logs', taskLogFile: () => 'preset.log', archiveStageLog() {},
    normalizePipelineProm: value => value, dtLocalToMs: () => 0, buildPromCollectEnv: () => ({}),
    advance() {}, finish() {},
    async execScript(_script, _timeout, _env, _run, onStream) {
      for (let i = 0; i < 6; i++) {
        onStream({ type: 'out', text: chunk });
        maxLiveChars = Math.max(maxLiveChars, stage._out.stdout.length);
      }
      return { code: 0, stdout: fullOutput, stderr: '', logFile: '/logs/preset.log' };
    },
  };
  vm.createContext(context);
  vm.runInContext(liveHelpersSource() + '\n' + source.slice(start, end), context);
  await context.runPresetStep(rc, 0);
  assert.ok(maxLiveChars <= 256 * 1024, '预设脚本不得在页面快照内累积全量日志');
  assert.equal(stage._out.stdout.length, fullOutput.length, '结束后仍保留完整结果');
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
  vm.runInContext(liveHelpersSource() + '\n' + source.slice(start, end), context);

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
  vm.runInContext(liveHelpersSource() + '\n' + source.slice(start, end), context);
  await context.runScriptStep(rc, 0);
  assert.deepEqual(renderedAt, [1000, 1250]);
});
