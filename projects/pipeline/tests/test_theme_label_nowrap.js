/* 标题行「主题」标签：窄空间下「主」「题」两个汉字不得在 label 内断成两行，
   label 需带 white-space:nowrap——与「每页」分页标签等其余控件的既有约定一致。 */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

test('「主题」label 带 white-space:nowrap，二字不断行', () => {
  const m = source.match(/<label[^>]*>\s*主题[\s\S]*?<select[^>]*\bid="theme"/);
  assert.ok(m, '缺少包裹 #theme 下拉框的「主题」label');
  assert.ok(/white-space\s*:\s*nowrap/.test(m[0]), '主题 label 缺少 white-space:nowrap（窄屏下「主」「题」会断成两行）');
});
