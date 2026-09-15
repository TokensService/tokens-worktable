const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function nearestCardId(elementId) {
  const target = source.search(new RegExp('\\bid="' + elementId + '"'));
  assert.ok(target >= 0, '缺少 #' + elementId);
  const stack = [];
  const tags = source.matchAll(/<\/?div\b[^>]*>/gi);
  for (const tag of tags) {
    if (tag.index >= target) break;
    if (tag[0].startsWith('</')) stack.pop();
    else if (!tag[0].endsWith('/>')) stack.push(tag[0]);
  }
  const card = [...stack].reverse().find(tag => /\bclass="[^"]*\bdshell-card\b/.test(tag));
  assert.ok(card, '#' + elementId + ' 应位于 dshell-card 内');
  return (card.match(/\bid="([^"]+)"/) || [])[1] || '';
}

test('运行队列与流水线任务列表使用两个独立卡片', () => {
  const queueCard = nearestCardId('queueList');
  const taskCard = nearestCardId('plTable');

  assert.equal(queueCard, 'queueCard');
  assert.equal(taskCard, 'pipelineTaskCard');
  assert.notEqual(queueCard, taskCard);
});
