/* 定时计划显式携带预设勾选的回归测试。
   背景：服务端 execPlan 对「无 presets 字段」的旧定时计划回退为「配置了清理脚本即执行」。
   页面生成的计划（定时页新建 / 定时后缀 / 关页移交）若不携带 presets 字段，即便用户未勾选
   「环境清理」，服务端也会在运行开头多执行一次清理脚本，运行历史多出「环境清理」阶段。
   修复：定时页新建计划按「清理环境」勾选显式携带 presets（勾选=['cleanup']、未勾选=[]，
   空数组 = 不执行预设任务，与 API 触发语义一致）；移交类计划恒显式 presets:[]。
   沙盒函数提取方式同 test_sched_suffix_handoff.js。 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = require('./_page-source.cjs').loadPageSource();

function functionMatch(name) {
  return new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
}
function extractFunction(name) {
  const match = functionMatch(name);
  assert.ok(match, 'pipeline.html 缺少函数 ' + name);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error('未闭合的函数 ' + name);
}
function installFunctions(context, names) {
  const bodies = names.filter(functionMatch).map(extractFunction);
  if (bodies.length) vm.runInContext(bodies.join('\n'), context);
}

function planContext(cleanupChecked) {
  const alerts = [];
  const els = {
    runSched: { value: 'once' },
    schedBy: { value: 'tester', focus() {} },
    schedPipeline: { value: 'pl-1' },
    schedRepo: { value: 'repo-1' },
    schedBranch: { value: 'main' },
    schedStrategy: { value: '' },
    schedCleanupEnv: { checked: cleanupChecked },
    runSchedAt: { value: '2099-01-01T00:00' },
  };
  const context = {
    console, Object, Array, JSON, Date, Math, parseInt,
    alert(msg) { alerts.push(String(msg)); },
    serverPlans: [],
    DEFAULT_IMAGE: 'img',
    $(id) { return els[id] || null; },
    findPipeline(id) {
      return id === 'pl-1'
        ? { id: 'pl-1', name: 'p', stages: [{ id: 's1', name: '构建', kind: 'simulate', dur: 1 }] }
        : null;
    },
    curPipeline() { return { id: 'pl-1', name: 'p', stages: [] }; },
    schedEnvs() { return []; },
    pushPlans() {},
    renderPlanList() {},
  };
  vm.createContext(context);
  installFunctions(context, ['addPlan']);
  return { context, alerts };
}

test('定时页新建计划：勾选「清理环境」时显式携带 presets=[cleanup]，服务端按编排执行清理', () => {
  const h = planContext(true);
  h.context.addPlan();
  assert.equal(h.alerts.length, 0, '合法输入不应弹窗');
  assert.equal(h.context.serverPlans.length, 1);
  assert.deepEqual([...h.context.serverPlans[0].presets], ['cleanup']);   // 计划对象由 vm 沙盒内代码创建，[...] 摊平为当前域数组再比较（deepStrictEqual 校验原型）
});

test('定时页新建计划：未勾选「清理环境」时显式携带空 presets，服务端不再回退执行清理', () => {
  const h = planContext(false);
  h.context.addPlan();
  assert.equal(h.alerts.length, 0);
  assert.equal(h.context.serverPlans.length, 1);
  assert.deepEqual([...h.context.serverPlans[0].presets], [],
    '显式空数组 = 不执行预设任务（区别于无 presets 字段的旧计划：旧计划保持「配置了清理脚本即执行」兼容回退）');
});

test('移交类计划显式 presets:[] 静态契约：buildSuffixPlan / buildUnloadHandoffPlan 均携带该字段', () => {
  const suffix = extractFunction('buildSuffixPlan');
  const unload = extractFunction('buildUnloadHandoffPlan');
  assert.ok(/presets:\s*\[\s*\]/.test(suffix), 'buildSuffixPlan 必须携带显式 presets:[]（定时后缀不再触发服务端清理回退）');
  assert.ok(/presets:\s*\[\s*\]/.test(unload), 'buildUnloadHandoffPlan 必须携带显式 presets:[]（关页移交不再触发服务端清理回退）');
});
