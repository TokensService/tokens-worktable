/* startStageAt 脚本路径按名回填：内置种子/分享导入/旧数据的脚本绑定 path 可能留空——
   rebindBuiltinScriptPaths 只补内置流水线，自定义阶段 path 留空时本地运行会落入模拟分支
   静默跳过（脚本根本没跑却显示成功）。修复后按 scriptByName 解析当前 scripts 目录同名脚本。 */
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = require('./_page-source.cjs').loadPageSource();

function extractFunction(name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, 'pipeline 页面缺少函数 ' + name);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error('未闭合的函数 ' + name);
}

function loadStartStageAt(options) {
  const dispatched = [];
  const context = {
    console,
    Object,
    scriptByName: options.scriptByName,
    runPresetStep() { dispatched.push('preset'); },
    skipStage() { dispatched.push('skip'); },
    stageUrlOf(stage) { return stage && stage.url ? stage.url.url || '' : ''; },
    runUrlStep() { dispatched.push('url'); },
    runEvaltokensStep() { dispatched.push('evaltokens'); },
    runScriptStep(rc, i) { dispatched.push('script'); },
    runStage(rc, i) { dispatched.push('simulate'); },
  };
  if (options.noScriptByName) delete context.scriptByName;
  vm.createContext(context);
  vm.runInContext(extractFunction('startStageAt'), context);
  return { startStageAt: context.startStageAt, dispatched };
}

test('startStageAt：script.name 有值但 path 留空时按名回填后走脚本执行', () => {
  const { startStageAt, dispatched } = loadStartStageAt({
    scriptByName(name) {
      return name === 'deploy.sh' ? { name: 'deploy.sh', path: '/scripts/deploy.sh', lang: 'sh' } : null;
    },
  });
  const stage = { id: 's1', name: '部署', kind: 'shell', script: { name: 'deploy.sh', path: '', lang: 'sh', params: [], values: {}, outVars: '' } };
  startStageAt({ stages: [stage], nodes: {}, vars: {} }, 0);
  assert.deepEqual(dispatched, ['script']);
  assert.equal(stage.script.path, '/scripts/deploy.sh', '回填后的 path 应指向当前 scripts 目录同名文件');
});

test('startStageAt：script.path 已填时不回填（尊重显式路径）', () => {
  const { startStageAt, dispatched } = loadStartStageAt({
    scriptByName() { throw new Error('path 已填不应查 scripts 列表'); },
  });
  const stage = { id: 's1', name: '部署', kind: 'shell', script: { name: 'deploy.sh', path: '/abs/deploy.sh', lang: 'sh' } };
  startStageAt({ stages: [stage], nodes: {}, vars: {} }, 0);
  assert.deepEqual(dispatched, ['script']);
  assert.equal(stage.script.path, '/abs/deploy.sh');
});

test('startStageAt：scripts 列表查不到同名脚本时维持模拟兜底（不编造路径）', () => {
  const { startStageAt, dispatched } = loadStartStageAt({
    scriptByName() { return null; },
  });
  const stage = { id: 's1', name: '部署', kind: 'shell', script: { name: 'gone.sh', path: '', lang: 'sh' } };
  startStageAt({ stages: [stage], nodes: {}, vars: {} }, 0);
  assert.deepEqual(dispatched, ['simulate']);
  assert.equal(stage.script.path, '', '查不到时 path 保持留空（列表不可用期间不破坏原数据）');
});

test('startStageAt：无 script 绑定（留空=模拟）与提取沙盒缺 scriptByName 时行为不变', () => {
  /* 无 script：仍走本地模拟 */
  const a = loadStartStageAt({ scriptByName() { return null; } });
  a.startStageAt({ stages: [{ id: 's1', name: '纯模拟', kind: 'shell' }], nodes: {}, vars: {} }, 0);
  assert.deepEqual(a.dispatched, ['simulate']);
  /* 旧版抽取沙盒未注入 scriptByName：typeof 守卫跳过回填，path 留空阶段照旧模拟（不抛 ReferenceError） */
  const b = loadStartStageAt({ noScriptByName: true });
  b.startStageAt({ stages: [{ id: 's1', name: '部署', kind: 'shell', script: { name: 'deploy.sh', path: '', lang: 'sh' } }], nodes: {}, vars: {} }, 0);
  assert.deepEqual(b.dispatched, ['simulate']);
});
