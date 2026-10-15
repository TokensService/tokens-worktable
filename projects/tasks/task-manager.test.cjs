/* task-manager.html 静态契约：配色修复（浅色幽灵按钮可读 / color-scheme 随主题）、
   dsh-auth-gate 真实用户（/auth/status + /auth/users）、任务增删改走 /api/worktable/tasks
   服务端共享存储（不再 localStorage 假数据）。 */
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

test("无独立「录入效果」按钮：点「完成」时弹输入框，结果随 status=done 一并 PATCH", () => {
  assert.ok(!html.includes('data-act="effect"'), "不应再有 data-act=effect 按钮");
  assert.ok(html.includes("录入任务结果"), "完成时应提示录入任务结果");
  assert.ok(html.includes("status: 'done', effect:"), "任务结果应随 status=done 一并提交");
  assert.ok(html.includes("v === null"), "取消输入应中止完成操作");
});

test("编辑弹窗含任务结果字段（admin 可随时修订；新建态隐藏）", () => {
  assert.ok(html.includes('id="fEffect"'), "弹窗应含任务结果输入框");
  assert.ok(html.includes("fEffectWrap"), "结果字段应按编辑态切换显隐");
});

test("权限 UI：admin 门控新建按钮，成员仅自己任务可操作", () => {
  assert.ok(html.includes("isAdmin()"), "应有 admin 判定");
  assert.ok(html.includes("t.assignee === me.username"), "成员操作应限定自己的任务");
});
