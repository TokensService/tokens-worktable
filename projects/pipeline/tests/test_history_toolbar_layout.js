const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function openingTag(markup, id) {
  const match = markup.match(new RegExp('<(?:button|div|table)[^>]*\\bid="' + id + '"[^>]*>'));
  assert.ok(match, '缺少 #' + id);
  return { tag: match[0], index: match.index };
}

function elementMarkup(markup, id) {
  const opening = openingTag(markup, id);
  const tagName = opening.tag.match(/^<([a-z][\w-]*)/i)[1];
  const tail = markup.slice(opening.index);
  const tags = tail.matchAll(new RegExp('<\\/?' + tagName + '\\b[^>]*>', 'gi'));
  let depth = 0;
  for (const tag of tags) {
    if (tag[0].startsWith('</')) depth -= 1;
    else if (!tag[0].endsWith('/>')) depth += 1;
    if (depth === 0) return tail.slice(0, tag.index + tag[0].length);
  }
  assert.fail('#' + id + ' 缺少闭合标签');
}

function directChildren(markup) {
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const children = [];
  const stack = [];
  for (const token of markup.matchAll(/<\/?([a-z][\w-]*)(?:\s[^<>]*?)?\s*\/?>/gi)) {
    const tagName = token[1].toLowerCase();
    if (token[0].startsWith('</')) {
      assert.equal(stack.pop(), tagName, 'HTML 标签嵌套错误：' + token[0]);
      continue;
    }
    if (stack.length === 1) {
      const id = token[0].match(/\bid="([^"]+)"/);
      children.push(tagName + (id ? '#' + id[1] : ''));
    }
    if (!voidTags.has(tagName) && !token[0].endsWith('/>')) stack.push(tagName);
  }
  assert.deepEqual(stack, [], '筛选栏 HTML 标签未闭合');
  return children;
}

test('运行历史「刷新」排在关键字之前，其余操作按清除筛选、重跑、清空排列', () => {
  const actionIds = ['histRefresh', 'histFilterClear', 'histRerun', 'histClear'];
  for (const id of actionIds) {
    assert.equal((source.match(new RegExp('\\bid="' + id + '"', 'g')) || []).length, 1, '#' + id + ' 应只出现一次');
  }
  const children = directChildren(elementMarkup(source, 'histFilterBar'));

  assert.equal(children[0], 'button#histRefresh', '刷新应是筛选栏的第一个直接子元素（位于关键字之前）');
  assert.ok(
    source.indexOf('id="histRefresh"') < source.indexOf('id="histFilterKw"'),
    '刷新按钮应出现在关键字输入框之前'
  );
  const clearFilterIndex = children.indexOf('button#histFilterClear');

  assert.notEqual(clearFilterIndex, -1, '清除筛选应是筛选栏的直接子元素');
  assert.deepEqual(children.slice(clearFilterIndex, clearFilterIndex + 3), [
    'button#histFilterClear',
    'button#histRerun',
    'button#histClear',
  ]);
});

test('清空运行历史使用危险操作样式', () => {
  const clearHistory = openingTag(source, 'histClear');

  assert.match(clearHistory.tag, /\bclass="[^"]*\bdshell-btnDanger\b[^"]*"/);
});
