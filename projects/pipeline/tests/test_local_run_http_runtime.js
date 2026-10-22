// test_local_run_http_runtime.js — 运行时侧「本地运行仅 http 任务类型支持」语义契约：
// 存量/分享导入数据里非 http 阶段（simulate/shell/python/evaltokens）残留 sched=null（旧版编辑器
// 「本地运行」勾选标记）时：
// 1) startSimRun 启动顺序校验不得把非 http 阶段误判为「需本地运行」而拦截（修复前：非 http 阶段
//    残留 sched=null 排在定时阶段之后 → alert「需本地运行却排在定时阶段之后」→ 直接失败、不启动、
//    beginRunHistory 未执行 → 运行历史零记录；复现见真机注入「定时阶段 + simulate 残留 sched=null」
//    流水线后运行）。
// 2) 混合编排 firstSched 分界扫描把非 http 阶段（即使 sched=null）按支持定时处理（不留本地前缀）。
// 3) buildSuffixPlan 收录非 http 阶段（即使 sched=null）进服务端计划，仅 http+sched=null 的
//    真「需本地运行」阶段被排除；handoffSchedSuffix 计数口径同 buildSuffixPlan。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = require('./_page-source.cjs').loadPageSource();

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

/* ---------- buildSuffixPlan：非 http 阶段（即使残留 sched=null）进服务端计划 ---------- */
function suffixCtx() {
  const ctx = {
    Object, Array, Date, console,
    stageSeq: () => 0,
    runRepositorySnapshot: () => null,
    runSettingsSnapshot: () => null,
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('buildSuffixPlan'), ctx);
  return ctx;
}

test('buildSuffixPlan：非 http 阶段残留 sched=null 也进服务端计划（跟随流水线定时计划）', () => {
  const ctx = suffixCtx();
  const rc = {
    stages: [
      { id: 'a', name: '残留本地', kind: 'simulate', sched: null },
      { id: 'b', name: '定时B', kind: 'simulate', sched: {} },
      { id: 'c', name: '本地HTTP', kind: 'http', sched: null, url: { url: 'http://intranet/x' } },
    ],
    nodes: { a: { status: 'success', dur: 5 } },
    vars: {},
    pipelineId: 'p1', pipelineName: 'p', env: '', envs: [], image: '', repoId: null, branch: 'main', strategy: '',
    by: 'tester', tag: 'T', archive: '/arc/p_x', baseSeq: 0,
  };
  const plan = JSON.parse(JSON.stringify(ctx.buildSuffixPlan(rc, 0)));
  assert.deepEqual(plan.stages.map(s => s.id), ['a', 'b'], '非 http（simulate）阶段即使残留 sched=null 也进服务端计划；仅 http+sched=null 的真需本地运行阶段被排除');
});

test('buildSuffixPlan：http 且 sched=null（真需本地运行）阶段不进服务端计划', () => {
  const ctx = suffixCtx();
  const rc = {
    stages: [
      { id: 'x', name: '本地HTTP', kind: 'http', sched: null, url: { url: 'http://intranet/x' } },
      { id: 'y', name: '定时Y', kind: 'simulate', sched: {} },
    ],
    nodes: {}, vars: {},
    pipelineId: 'p1', pipelineName: 'p', env: '', envs: [], image: '', repoId: null, branch: 'main', strategy: '',
    by: 'tester', tag: 'T', archive: '/arc/p_x', baseSeq: 0,
  };
  const plan = JSON.parse(JSON.stringify(ctx.buildSuffixPlan(rc, 0)));
  assert.deepEqual(plan.stages.map(s => s.id), ['y'], 'http+sched=null 需本地运行阶段不进服务端计划');
});

/* ---------- startSimRun 启动顺序校验与混合编排分界：非 http 阶段按支持定时处理 ---------- */
test('startSimRun 启动顺序校验：非 http 阶段残留 sched=null 不触发「需本地运行排在定时阶段之后」拦截', () => {
  const fn = extractFunction('startSimRun');
  const check = fn.slice(0, fn.indexOf('const commit='));
  /* has 判定：非 http 类型（kind!=='http'）一律视为支持定时（has=true），不再因 sched=null 残留被当「需本地运行」 */
  assert.match(check, /const has=!!stages\[i\]\.sched \|\| stages\[i\]\.kind!=='http'/, 'startSimRun 顺序校验须把非 http 阶段按支持定时处理（残留 sched=null 不得误判为需本地运行）');
  assert.match(check, /需本地运行却排在定时阶段之后/, 'http 真需本地运行阶段的顺序校验保留');
});

test('startSimRun 混合编排分界：非 http 阶段（即使残留 sched=null）按定时阶段参与 firstSched 扫描', () => {
  const fn = extractFunction('startSimRun');
  const seg = fn.slice(fn.indexOf('let firstSched='), fn.indexOf('advance(rc,0)'));
  assert.match(seg, /st\.sched \|\| st\.kind!=='http'/, 'firstSched 分界扫描须把非 http 阶段按支持定时处理，不留本地前缀');
  assert.match(seg, /hasLocalPrefix=true/, '仅 http+sched=null 的真需本地运行阶段才在分界前形成本地前缀');
});

/* ---------- handoffSchedSuffix 计数：与 buildSuffixPlan 收录口径一致 ---------- */
test('handoffSchedSuffix 计数：非 http 阶段（即使残留 sched=null）计入可移交定时阶段', () => {
  const fn = extractFunction('handoffSchedSuffix');
  assert.match(fn, /if\(st\.sched \|\| st\.kind!=='http'\) count\+\+/, 'handoffSchedSuffix 计数须与 buildSuffixPlan 收录口径一致（非 http 阶段计入移交）');
});