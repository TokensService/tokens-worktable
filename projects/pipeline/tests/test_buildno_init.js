// 运行编号计数器从 0 起：首个真实运行即 #1，演示数据（demo:true）不占服务端编号空间。
// 回归保护：buildNo 曾初始化为 47，导致真实运行历史从 #48 开始，看起来像丢了 #1–47。
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

test('buildNo 初始化为 0（真实运行从 #1 编号）', () => {
  const m = /let buildNo = (\d+);/.exec(source);
  assert.ok(m, 'pipeline.html 缺少 buildNo 初始化');
  assert.equal(Number(m[1]), 0, 'buildNo 必须从 0 起，否则真实历史编号不从 #1 开始');
});

test('演示数据带 demo 标记且持久化时被剔除', () => {
  const demos = source.match(/\{ no:\d+, pipeline:[^\n]*?demo:true \}/g) || [];
  assert.ok(demos.length > 0, '缺少内置演示数据（demo:true）');
  assert.ok(/history\.filter\(h=>!h\.demo\)/.test(source), 'historyForPersist 必须剔除演示数据，不占用服务端编号空间');
});
