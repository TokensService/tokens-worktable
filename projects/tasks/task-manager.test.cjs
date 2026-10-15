/* task-manager.html 静态契约：配色修复（浅色幽灵按钮可读 / color-scheme 随主题）、
   dsh-auth-gate 真实用户（/auth/status + /auth/users）、任务增删改走 /api/worktable/tasks
   服务端共享存储（不再 localStorage 假数据）；进展 / 标签 / 完成弹窗 AI 总结 / 文本导入。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "task-manager.html"), "utf8");

test("皮肤走工作台 dshell.css 模板", () => {
  assert.ok(html.includes('/api/worktable/template/dshell.css'));
});

test("配色修复：不再有浅色模式白字覆盖规则（幽灵/危险按钮白字不可读的根因）", () => {
  assert.ok(!/body\[data-theme="light"\]\s+\.dshell-btn\s*\{[^}]*color:\s*#fff/i.test(html),
    "浅色模式不得把 .dshell-btn 文字强制为 #fff");
});

test("配色修复：主题变量只挂 body[data-theme]，color-scheme 由 JS 随主题同步", () => {
  assert.ok(!/:root\s*,\s*body\[data-theme="dark"\]/.test(html),
    "不得把深色变量与 color-scheme 常驻 :root（浅色下 UA 控件仍按深色渲染的根因）");
  assert.ok(html.includes('documentElement.style.colorScheme'), "JS 应随主题设置 color-scheme");
  assert.ok(html.includes('body[data-theme="light"]'));
  assert.ok(html.includes('body[data-theme="dark"]'));
});

test("真实用户：取 /auth/status 当前身份与 /auth/users 用户列表", () => {
  assert.ok(html.includes("'/auth/status'") || html.includes('"/auth/status"'));
  assert.ok(html.includes("'/auth/users'") || html.includes('"/auth/users"'));
});

test("真实用户：不再内置假用户/假数据种子", () => {
  for (const fake of ["张三", "李四", "王五", "tm_tasks_v1", "tm_user_v1", "function seed("]) {
    assert.ok(!html.includes(fake), `不应再出现假数据痕迹：${fake}`);
  }
});

test("任务增删改走服务端共享存储 API", () => {
  assert.ok(html.includes("'/api/worktable/tasks'"), "应定义 tasks API 路径");
  assert.ok(html.includes("apiSend('POST'"), "新建应走 POST");
  assert.ok(html.includes("apiSend('PATCH'"), "编辑/状态/效果应走 PATCH");
  assert.ok(html.includes("apiSend('DELETE'"), "删除应走 DELETE");
  assert.ok(html.includes("setInterval("), "应有团队共享数据的定时刷新");
});

test("完成弹窗：多行录入任务结果，不再用单行 prompt()", () => {
  assert.ok(!html.includes('data-act="effect"'), "不应再有 data-act=effect 按钮");
  assert.ok(html.includes('id="doneMask"'), "应有完成专用弹窗");
  assert.ok(html.includes('id="doneEffect"'), "完成弹窗应含多行文本框");
  assert.ok(!/prompt\s*\(/.test(html), "完成录入不得再走单行 prompt()");
  assert.ok(html.includes("status: 'done', effect:"), "任务结果应随 status=done 一并提交");
  assert.ok(html.includes("doneCancelBtn"), "完成弹窗应有取消（取消=不标记完成）");
});

test("完成弹窗支持 AI 总结", () => {
  assert.ok(html.includes('id="doneAiBtn"'), "完成弹窗应有 AI 总结按钮");
  assert.ok(html.includes("AI 总结"), "应有 AI 总结文案");
  assert.ok(html.includes("aiChat("), "应有 AI 调用封装");
  assert.ok(html.includes("doneEffect.value"), "AI 总结结果应回填文本框");
});

test("任务支持添加进展（append-only，成员/ admin 均可）", () => {
  assert.ok(html.includes('data-act="progress"'), "卡片应有进展按钮");
  assert.ok(html.includes("addProgress:"), "进展应走 PATCH addProgress");
  assert.ok(html.includes('id="progMask"'), "应有进展弹窗");
  assert.ok(html.includes('id="progText"'), "进展弹窗应有内容输入");
  assert.ok(html.includes("taskProgress("), "应渲染进展列表");
});

test("任务编辑支持添加标签", () => {
  assert.ok(html.includes('id="fTagsInput"'), "编辑弹窗应有标签输入");
  assert.ok(html.includes("editTags"), "应有标签缓冲");
  assert.ok(html.includes("tags: editTags.slice()"), "保存应携带 tags");
  assert.ok(html.includes("tm-tag"), "卡片/弹窗应渲染标签");
});

test("支持 text 导入多个任务 + AI 分析导入", () => {
  assert.ok(html.includes('id="importMask"'), "应有导入弹窗");
  assert.ok(html.includes('id="importText"'), "应有文本输入");
  assert.ok(html.includes("parseImportLines"), "应有按行解析");
  assert.ok(html.includes('id="importAiBtn"'), "应有 AI 分析导入按钮");
  assert.ok(html.includes("apiSend('POST'"), "导入应走 POST 新建");
});

test("编辑弹窗含任务结果字段（admin 可随时修订；新建态隐藏）", () => {
  assert.ok(html.includes('id="fEffect"'), "弹窗应含任务结果输入框");
  assert.ok(html.includes("fEffectWrap"), "结果字段应按编辑态切换显隐");
});

test("权限 UI：admin 门控新建/导入按钮，成员仅自己任务可操作", () => {
  assert.ok(html.includes("isAdmin()"), "应有 admin 判定");
  assert.ok(html.includes("t.assignee === me.username"), "成员操作应限定自己的任务");
  assert.ok(html.includes("importBtn"), "应有导入按钮（admin 门控）");
});

test("AI 配置本地保存 + DSH 会话桥兜底", () => {
  assert.ok(html.includes("LS_AI") || html.includes("tm_ai_cfg_v1"), "AI 配置应落 localStorage");
  assert.ok(html.includes("__dshSendChatForResult"), "应支持 DSH 会话 AI 桥");
  assert.ok(html.includes('id="aiMask"'), "应有 AI 设置弹窗");
});
