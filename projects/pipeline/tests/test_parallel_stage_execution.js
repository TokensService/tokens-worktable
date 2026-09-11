const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function extractFunction(name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, 'pipeline.html 缺少函数 ' + name);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error('未闭合的函数 ' + name);
}

function parallelContext(stages) {
  const started = [];
  const context = {
    console,
    Promise,
    Object,
    Array,
    setImmediate,
    clearInterval() {},
    taskPromFinalize() {},
    finish(_rc, status) { throw new Error('unexpected finish: ' + status); },
    runPresetStep() { throw new Error('preset executor must not run'); },
    skipStage() { throw new Error('skip executor must not run'); },
    stageUrlOf() { return ''; },
    runUrlStep() { throw new Error('URL executor must not run'); },
    runEvaltokensStep() { throw new Error('EvalTokens executor must not run'); },
    runStage() { throw new Error('simulate executor must not run'); },
    runScriptStep(child, index) { started.push({ child, index }); },
  };
  vm.createContext(context);
  vm.runInContext([
    'pipelineStageGroups',
    'rootRunContext',
    'createParallelStageContext',
    'settleParallelStage',
    'runParallelStageGroup',
    'startStageAt',
    'advance',
  ].map(extractFunction).join('\n'), context);
  const rc = {
    id: 'parent', stages, nodes: {}, selId: null, timer: null, scriptAbort: null,
    over: false, token: 'parent-token', vars: {}, parallelGroup: null,
  };
  return { context, rc, started };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('并行任务同时启动并等待全组成功后才启动后续任务', async () => {
  const { context, rc, started } = parallelContext([
    { id: 'a', parallel: true, script: { path: '/a.sh' } },
    { id: 'b', parallel: true, script: { path: '/b.sh' } },
    { id: 'after', script: { path: '/after.sh' } },
  ]);
  context.advance(rc, 0);
  assert.deepEqual(started.map(call => call.index), [0, 1]);
  started[1].child.nodes.b = { status: 'success', varsOut: { VALUE: 'b' } };
  context.advance(started[1].child, 2);
  await tick();
  assert.deepEqual(started.map(call => call.index), [0, 1]);
  started[0].child.nodes.a = { status: 'success', varsOut: { VALUE: 'a', A: '1' } };
  context.advance(started[0].child, 1);
  await tick();
  assert.deepEqual(started.map(call => call.index), [0, 1, 2]);
  assert.deepEqual(JSON.parse(JSON.stringify(rc.vars)), { VALUE: 'b', A: '1' });
});
