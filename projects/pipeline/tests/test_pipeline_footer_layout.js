/* 流水线编辑弹窗（#plForm）冻结底栏布局契约：「+ 添加阶段」按钮固定在底栏最左（左下角），
   草稿提示 #plDraftTip 以 margin-right:auto 把「保存 / 取消」顶在右下角；底栏整栏冻结，不随阶段列表滚动。 */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

// 截取 #plForm 弹窗片段（到紧随其后的 pipelineRunDialog 弹窗为止）
function plFormSection() {
  const start = source.indexOf('id="plForm"');
  assert.ok(start >= 0, '缺少 #plForm 弹窗');
  const end = source.indexOf('id="pipelineRunDialog"', start);
  return source.slice(start, end >= 0 ? end : undefined);
}

// 截取冻结底栏 div 片段（#plForm 内 style 以 flex:0 0 auto 开头的 div 仅此一个）
function footerSection() {
  const section = plFormSection();
  const m = section.match(/<div style="flex:0 0 auto;[^"]*">[\s\S]*?<\/div>/);
  assert.ok(m, '缺少 #plForm 内的冻结底栏（flex:0 0 auto 的 div）');
  return m[0];
}

test('#plForm 冻结底栏同时容纳 添加阶段 / 保存 / 取消 三个按钮', () => {
  const footer = footerSection();
  assert.ok(footer.includes('id="plStageAdd"'), '冻结底栏内缺少「+ 添加阶段」按钮 #plStageAdd');
  assert.ok(footer.includes('id="plSave"'), '冻结底栏内缺少「保存」按钮 #plSave');
  assert.ok(footer.includes('id="plCancel"'), '冻结底栏内缺少「取消」按钮 #plCancel');
});

test('底栏内顺序：plStageAdd 在最左，其后依次为 plDraftTip / plSave / plCancel', () => {
  const footer = footerSection();
  const iAdd = footer.indexOf('id="plStageAdd"');
  const iTip = footer.indexOf('id="plDraftTip"');
  const iSave = footer.indexOf('id="plSave"');
  const iCancel = footer.indexOf('id="plCancel"');
  assert.ok(iAdd >= 0 && iTip >= 0 && iSave >= 0 && iCancel >= 0, '底栏内缺少应有的元素');
  assert.ok(iAdd < iTip, '「+ 添加阶段」应排在草稿提示 #plDraftTip 之前（底栏最左）');
  assert.ok(iTip < iSave, '草稿提示 #plDraftTip 应排在「保存」之前');
  assert.ok(iSave < iCancel, '「保存」应排在「取消」之前');
});

test('#plDraftTip 保留 margin-right:auto（保存 / 取消仍被顶在右下角）', () => {
  const footer = footerSection();
  const m = footer.match(/<span[^>]*id="plDraftTip"[^>]*>/);
  assert.ok(m, '底栏内缺少 #plDraftTip 的 span 标签');
  assert.ok(/margin-right\s*:\s*auto/.test(m[0]), '#plDraftTip 缺少 margin-right:auto（保存/取消会失去右对齐）');
});

test('「+ 添加阶段」不在包裹 #plStageList 的滚动容器内（验证冻结语义）', () => {
  const section = plFormSection();
  const scroll = section.match(/<div style="display:flex; flex-direction:column; gap:8px; overflow:auto;[^"]*">/);
  assert.ok(scroll, '缺少包裹 #plStageList 的滚动容器（overflow:auto 内容区）');
  const footerIdx = section.indexOf('<div style="flex:0 0 auto;');
  assert.ok(footerIdx > scroll.index, '冻结底栏应出现在滚动容器之后');
  // 滚动容器开口到底栏开口之间的片段 = 滚动区内容及其闭合标签
  const scrollBody = section.slice(scroll.index, footerIdx);
  assert.ok(scrollBody.includes('id="plStageList"'), '滚动容器内应包含 #plStageList');
  assert.ok(!scrollBody.includes('id="plStageAdd"'), '「+ 添加阶段」不得落在滚动容器内（须随底栏冻结）');
});
