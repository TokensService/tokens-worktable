const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/pipeline.html', 'utf8');

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

test('运行历史操作紧跟清除筛选并按重跑、清空、刷新排列', () => {
  const actionIds = ['histFilterClear', 'histRerun', 'histClear', 'histRefresh'];
  for (const id of actionIds) {
    assert.equal((source.match(new RegExp('\\bid="' + id + '"', 'g')) || []).length, 1, '#' + id + ' 应只出现一次');
  }
  const children = directChildren(elementMarkup(source, 'histFilterBar'));
  const clearFilterIndex = children.indexOf('button#histFilterClear');

  assert.notEqual(clearFilterIndex, -1, '清除筛选应是筛选栏的直接子元素');
  assert.deepEqual(children.slice(clearFilterIndex, clearFilterIndex + 4), [
    'button#histFilterClear',
    'button#histRerun',
    'button#histClear',
    'button#histRefresh',
  ]);
});

test('清空运行历史使用危险操作样式', () => {
  const clearHistory = openingTag(source, 'histClear');

  assert.match(clearHistory.tag, /\bclass="[^"]*\bdshell-btnDanger\b[^"]*"/);
});
