// test_stage_meta_dur.js — 编排区阶段节点元信息（metaFor）耗时显示回归：
// 运行中节点经共享 tick 实时显示「百分比 · 已耗时」，到达终态后节点仍应保留本次运行耗时——
// 此前仅成功（✓ 耗时）带耗时，失败/中止只显示「✗ 错误」「⏏ 终止」，编排区看不出该阶段跑了多久；
// 本次把失败/中止补齐为「✗ 错误 · 耗时」「⏏ 终止 · 耗时」（dur 缺失时钳 0，与详情面板口径一致），
// 跳过（未执行）与未开始不显示耗时。
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

function makeCtx(nodeMap, stages) {
  const context = {
    Object, Array, JSON, console,
    nodes: nodeMap,
    activeStages: () => stages || [],
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('fmtDur') + '\n' + extractFunction('metaFor'), context);
  return context;
}

test('成功阶段节点显示耗时（既有行为回归）', () => {
  const ctx = makeCtx({ a: { status: 'success', progress: 100, dur: 75, sub: {} } });
  assert.equal(ctx.metaFor('a'), '✓ 1m15s');
});

test('失败阶段节点显示「✗ 错误 · 耗时」', () => {
  const ctx = makeCtx({ a: { status: 'failed', progress: 100, dur: 5, sub: {} } });
  assert.equal(ctx.metaFor('a'), '✗ 错误 · 5s');
});

test('失败阶段 dur 缺失时钳 0（不显示 NaN）', () => {
  const ctx = makeCtx({ a: { status: 'failed', progress: 100, sub: {} } });
  assert.equal(ctx.metaFor('a'), '✗ 错误 · 0s');
});

test('中止阶段节点显示「⏏ 终止 · 耗时」', () => {
  const ctx = makeCtx({ a: { status: 'aborted', progress: 40, dur: 62, sub: {} } });
  assert.equal(ctx.metaFor('a'), '⏏ 终止 · 1m2s');
});

test('运行中阶段节点显示「百分比 · 已耗时」（既有行为回归）', () => {
  const ctx = makeCtx({ a: { status: 'running', progress: 47, dur: 90, sub: {} } });
  assert.equal(ctx.metaFor('a'), '47% · 1m30s');
});

test('跳过/未开始阶段不显示耗时', () => {
  const ctx = makeCtx(
    { a: { status: 'skipped', progress: 0, dur: 0, sub: {} } },
    [{ id: 'b', name: 'B', skip: true }, { id: 'c', name: 'C' }]
  );
  assert.equal(ctx.metaFor('a'), '⏭ 跳过');
  assert.equal(ctx.metaFor('b'), '⊘ 不执行', '未运行但配置「不执行」');
  assert.equal(ctx.metaFor('c'), '', '未开始阶段无元信息');
});
