/* task-manager.html 静态契约：配色修复（浅色幽灵按钮可读 / color-scheme 随主题）、
   dsh-auth-gate 真实用户（/auth/status + /auth/users）、任务增删改走 /api/worktable/tasks
   服务端共享存储（不再 localStorage 假数据）；进展 / 标签 / 完成弹窗 AI 总结 / 文本导入；
   主从双栏布局——左侧紧凑任务列表 + 右侧详情面板（点击卡片切换，不再是详情弹窗），
   详情内联编辑保存（无独立编辑按钮）+ 行内添加进展；
   多负责人（assignees）、起止时间只由「开始 / 完成」动作记录（不可手填、详情只读展示）、
   状态×用户×标签三维筛选；AI 个人总结。 */
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

test("详情面板内联编辑任务结果（无独立编辑按钮 / 编辑弹窗）", () => {
  assert.ok(html.includes('id="dEffect"'), "详情表单应含任务结果输入框");
  assert.ok(html.includes('id="dSaveBtn"'), "详情应有保存按钮");
  assert.ok(html.includes('id="dResetBtn"'), "详情应有还原按钮");
  assert.ok(!html.includes('data-act="edit"'), "卡片不应再有独立编辑按钮");
  assert.ok(!html.includes('id="fEffect"'), "新建弹窗不应再含结果字段（编辑在详情内联）");
});

test("权限 UI：admin 门控新建/导入按钮，成员仅自己任务可操作", () => {
  assert.ok(html.includes("isAdmin()"), "应有 admin 判定");
  assert.ok(html.includes("taskHasAssignee(t, me.username)"), "成员操作应限定自己的任务（多负责人命中）");
  assert.ok(html.includes("importBtn"), "应有导入按钮（admin 门控）");
});

test("AI 配置本地保存 + DSH 会话桥兜底", () => {
  assert.ok(html.includes("LS_AI") || html.includes("tm_ai_cfg_v1"), "AI 配置应落 localStorage");
  assert.ok(html.includes("__dshSendChatForResult"), "应支持 DSH 会话 AI 桥");
  assert.ok(html.includes('id="aiMask"'), "应有 AI 设置弹窗");
});

test("主从双栏布局：点击任务卡在右侧详情面板展示并编辑详情（不再是弹窗）", () => {
  assert.ok(html.includes('class="tm-split"'), "应有主从分栏容器");
  assert.ok(html.includes('id="detailPanel"'), "应有右侧详情面板");
  assert.ok(html.includes('id="detailEmpty"'), "未选中时应有占位提示");
  assert.ok(!html.includes('id="detailMask"'), "详情不应再走弹窗");
  assert.ok(html.includes("selectTask("), "点击卡片应选中任务");
  assert.ok(html.includes("renderDetail()"), "应按选中状态渲染详情");
  assert.ok(html.includes('id="detailTitle"'), "详情应展示标题");
  assert.ok(html.includes('id="dTagsBox"'), "详情表单应含标签输入");
  assert.ok(html.includes('id="dDesc"'), "详情表单应含描述");
  assert.ok(html.includes('id="dEffect"'), "详情表单应含结果");
  assert.ok(html.includes('id="detailProgress"'), "详情应展示进展列表");
  assert.ok(html.includes('id="detailProgCount"'), "详情应展示进展条数");
  assert.ok(html.includes("clearSelection"), "面板应有取消选中（×）入口");
});

test("详情面板随数据刷新：轮询重绘 + 选中任务被删回到占位", () => {
  assert.ok(html.includes("selectedId"), "应以 selectedId 记录当前选中任务");
  assert.ok(html.includes("所选任务已不存在"), "所选任务被删后应提示并回到占位");
  assert.ok(html.includes("renderDetail();"), "render 应联动重绘详情面板");
});

test("详情面板行内编辑进展不被轮询打断；窄窗口纵向堆叠", () => {
  assert.ok(html.includes("progEditingId"), "行内编辑期间轮询重绘应让行（守卫）");
  assert.ok(html.includes("@media (max-width:860px)"), "窄窗口应切换纵向堆叠");
  assert.ok(html.includes("scrollIntoView"), "窄窗口选中任务时应把详情面板滚进视野");
  assert.ok(html.includes("tm-taskSel"), "选中任务卡应有高亮样式");
});

test("进展可编辑、删除（PATCH updateProgress / deleteProgress）", () => {
  assert.ok(html.includes("updateProgress:"), "应支持更新进展");
  assert.ok(html.includes("deleteProgress:"), "应支持删除进展");
  assert.ok(html.includes("data-prog-act"), "进展条目应有编辑/删除操作");
  assert.ok(html.includes("canEditProgEntry"), "应按作者/admin 裁剪进展操作");
});

test("标签输入兼容输入法：组词期的 Enter/Process 键放行给 IME，不误加标签", () => {
  assert.ok(html.includes("e.isComposing || e.keyCode === 229 || e.key === 'Process'"),
    "keydown 应先识别组词键（Safari isComposing / Chrome Process+229）直接放行");
});

test("标签输入支持全角逗号分隔（与导入解析 [,，、] 口径一致）", () => {
  assert.ok(html.includes("e.key !== '，'"), "全角逗号应与半角一样作为分隔键");
  assert.ok(html.includes("replace(/[,，]+$/, '')"), "收尾逗号（含全角）应剥掉再入库");
});

test("任务列表加载失败不得清空现有列表", () => {
  assert.ok(!html.includes("r.ok ? r.json() : { tasks: [] }"), "非 2xx 不得回落成空列表把已见任务抹掉");
  assert.ok(html.includes("err.http") && html.includes("任务列表加载失败"),
    "HTTP 层错误应提示一次，网络抖动仍静默保留旧数据");
});

test("任务列表支持按用户筛选（多选，任一命中；与状态 tab / 标签叠加）", () => {
  assert.ok(html.includes('id="userPickSearch"'), "应有用户筛选搜索框（多选筛选入口）");
  assert.ok(html.includes('id="userOptions"'), "应有用户候选多选框区");
  assert.ok(html.includes('id="userPickChips"'), "应有已选用户 chips");
  assert.ok(html.includes("var userFilters"), "应有多用户筛选状态（数组）");
  assert.ok(html.includes("!userFilters.some("), "visibleTasks 应按任一负责人命中过滤（多选）");
  assert.ok(html.includes("syncUserFilter();"), "render 应联动同步用户选项");
  assert.ok(html.includes("knownAssignees()"), "选项应取 启用用户 ∪ 任务负责人（共享模式兜底）");
  assert.ok(html.includes("data-user-chip"), "已选用户 chip 应可点击移除");
});

test("用户筛选支持搜索：按用户名子串过滤候选，选项集合变化才重建（15s 轮询不打断）", () => {
  assert.ok(html.includes("userPickSearchEl.addEventListener('input', drawUserOptions)"), "输入应实时过滤用户候选");
  assert.ok(html.includes("String(n).toLowerCase().indexOf(q) >= 0"), "应按用户名子串匹配");
  assert.ok(html.includes("无匹配用户"), "无匹配时应给占位提示");
  assert.ok(html.includes("userSelSig"), "应以选项签名跳过无变化轮次");
  assert.ok(html.includes("userFilters = userFilters.filter"), "已选用户从选项消失应自动剔除");
});

test("负责人多选支持搜索（新建弹窗 / 详情面板）", () => {
  assert.ok(html.includes('id="fAssigneeSearch"'), "新建弹窗应有负责人搜索框");
  assert.ok(html.includes('id="dAssigneeSearch"'), "详情面板应有负责人搜索框");
  assert.ok(html.includes("renderAssigneeChecks(box, selected, disabled, query)"), "负责人渲染应支持搜索词");
  assert.ok(html.includes("已选用户始终保留在列表中"), "已选用户不应被搜索词过滤掉");
  assert.ok(html.includes("fAssigneeSearchEl"), "新建弹窗搜索框应绑定输入监听");
  assert.ok(html.includes("dAssigneeSearchEl"), "详情面板搜索框应绑定输入监听");
});

test("新建任务兼容历史服务端：同时提交 assignee 与 assignees", () => {
  assert.ok(html.includes("assignee: assignees[0]"), "新建 POST 应同时携带首负责人（兼容只认单值的历史服务端）");
  assert.ok(html.includes("assignees: assignees"), "新建 POST 应携带多负责人数组");
  assert.ok(html.includes("assignee: assignees[0] || ''"), "详情 PATCH 同样应携带兼容字段");
});

test("任务列表支持按标签筛选（与状态 tab / 用户叠加）", () => {
  assert.ok(html.includes('id="tagSel"'), "应有标签筛选下拉");
  assert.ok(html.includes('var tagFilter'), "应有标签筛选状态");
  assert.ok(html.includes("taskTags(t).indexOf(tagFilter) < 0"), "visibleTasks 应按标签过滤");
  assert.ok(html.includes("syncTagFilter();"), "render 应联动同步标签选项");
  assert.ok(html.includes("knownTags()"), "选项应取全部任务标签");
  assert.ok(html.includes("data-tag-filter"), "任务卡标签 chip 可点快捷筛选");
});

test("任务支持多负责人（assignees 数组 + 详情/新建多选）", () => {
  assert.ok(html.includes("function taskAssignees(t)"), "应有负责人列表归一函数");
  assert.ok(html.includes("id=\"dAssignees\""), "详情应有多选负责人");
  assert.ok(html.includes("id=\"fAssignees\""), "新建弹窗应有多选负责人");
  assert.ok(html.includes("assignees:"), "保存应携带 assignees");
  assert.ok(html.includes("renderAssigneeChecks("), "应渲染负责人复选框");
});

test("起止时间不可手填：只由「开始」按钮 / 完成动作记录，详情只读展示", () => {
  /* 手工输入口全部撤掉（详情面板 + 新建弹窗） */
  assert.ok(!html.includes('id="dStartAt"'), "详情不应再有开始时间输入框");
  assert.ok(!html.includes('id="dEndAt"'), "详情不应再有结束时间输入框");
  assert.ok(!html.includes('id="fStartAt"'), "新建弹窗不应再有开始时间输入框");
  assert.ok(!html.includes('id="fEndAt"'), "新建弹窗不应再有结束时间输入框");
  /* 前端不再提交起止字段：新建 POST 与详情保存 PATCH 都不得携带 */
  assert.ok(!/startAt:\s*(st|body\.startAt)/.test(html), "保存不应再携带手工 startAt");
  assert.ok(!/endAt:\s*(en|body\.endAt)/.test(html), "保存不应再携带手工 endAt");
  assert.ok(!html.includes("data.startAt"), "详情保存不应再写入 startAt");
  assert.ok(!html.includes("data.endAt"), "详情保存不应再写入 endAt");
  /* 截止时间仍可手填（datetime-local 只剩这一处 + 个人总结的自定义区间 date） */
  assert.ok(html.includes('id="dDeadline"') && html.includes('id="fDeadline"'), "截止时间输入应保留");
  /* 只读展示：详情「创建 · 截止」行追加 开始 / 结束 */
  assert.ok(html.includes("function fmtTs("), "应有起止时间只读格式化函数");
  assert.ok(/fmtTs\(ts\)\s*\{[\s\S]{0,120}未记录/.test(html), "未记录时应给「未记录」占位而非「无截止」");
  assert.ok(html.includes("' · 开始 ' + fmtTs(t.startAt) + ' · 结束 ' + fmtTs(t.endAt)"),
    "详情应只读展示开始 / 结束时间");
  /* 记录来源：点「开始」→ PATCH status=doing；完成弹窗确认 → PATCH status=done + effect
     （服务端据此自动补记 startAt / endAt） */
  assert.ok(html.includes("apiSend('PATCH', { id: t.id, status: 'doing' })"),
    "「开始」按钮应只推进状态，由服务端记开始时间");
  assert.ok(html.includes("status: 'done', effect:"), "完成应随状态提交结果，由服务端记结束时间");
});

test("详情面板内联添加进展（不再依赖弹窗）", () => {
  assert.ok(html.includes('id="addProgBox"'), "详情应有行内添加进展区");
  assert.ok(html.includes('id="addProgText"'), "应有进展输入框");
  assert.ok(html.includes('id="addProgBtn"'), "应有添加进展按钮");
  assert.ok(html.includes("addProgress:"), "应走 PATCH addProgress");
});

test("详情表单未保存改动时不被 15s 轮询冲掉（detailEditing 守卫）", () => {
  assert.ok(html.includes("detailEditing"), "应有详情编辑中守卫");
  assert.ok(html.includes("markDetailDirty"), "字段改动应标记脏");
});

test("AI 个人总结：选用户 + 时间段（周/月/年/自定义）生成", () => {
  assert.ok(html.includes('id="summaryBtn"'), "应有个人总结入口按钮");
  assert.ok(html.includes('id="summaryMask"'), "应有总结弹窗");
  assert.ok(html.includes('id="sumUser"'), "应可选用户");
  assert.ok(html.includes('value="week"') && html.includes('value="month"') && html.includes('value="year"') && html.includes('value="custom"'),
    "时间段应支持本周 / 本月 / 今年 / 自定义");
  assert.ok(html.includes('id="sumFrom"') && html.includes('id="sumTo"'), "自定义区间应有起止日期输入");
  assert.ok(html.includes("sumRangeStartEnd"), "应计算时间段起止");
  assert.ok(html.includes("taskInSumRange"), "应按创建 / 截止 / 任一进展时间命中区间");
  assert.ok(html.includes("sumMatched()"), "应实时统计匹配任务数并展示");
  assert.ok(html.includes("buildSummaryPrompt"), "应组装个人总结提示词");
  assert.ok(html.includes("aiChat("), "应复用 AI 调用封装");
  assert.ok(html.includes('id="sumOut"'), "应有总结输出区");
  assert.ok(html.includes("mdLite("), "输出应经安全 Markdown 渲染（先 esc 再组 DOM）");
});
