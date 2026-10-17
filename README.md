# tokens-worktable（工作台）

> DeepSeek Harness 侧边栏的 agent 级项目容器（应用抽屉）。纯增量插件，不替换、不禁用任何官方插件。

## 是什么

- **侧边栏「工作台」区块**：收纳用户自建项目与入驻插件项目，支持改名/图标/排序/显示隐藏、项目 × 对话绑定、项目文件夹。
- **分栏工作区引擎（自研）**：声明式布局预设（左栏/顶行/主行 + 右侧对话窗），窗格可拖拽分割、标签页模型；内置 资源管理器 / 终端 / 浏览器 / 动画 / 自定义窗口。
- **控制室**：默认自带项目（固定首位、不可删除），项目卡片网格实时监控所有项目的状态（工作中/待你决定/已完成），零轮询零 Token。
- **自动挂载握手**：项目内 agent 完成窗口任务后写 widget-result.json，产物自动挂进对应窗口。
- **平台**：Windows 是当前完整验证平台；macOS 为实验性支持（核心文件路径代码已做跨平台适配，尚未真机端到端验证）。

## 技术底座

- Cordis 插件协议（客户端 bundle + 服务端路由 /api/worktable/*、终端 WebSocket）。
- 界面经 slot 座位协议注入侧边栏与 shell.overlay；对话窗复用宿主会话服务（sessions.open）。
- 状态监控为宿主会话运行时快照的事件订阅镜像；视图/项目/绑定状态存 localStorage；项目完善后可在管理列表点 ☁「发布」，转存服务端 `~/.dsh/storages/worktable-projects.json`，跨浏览器可见。
- 客户端：TypeScript + React（host externals）+ 原生 CSS；服务端：Node。

## 安装

方式 A（推荐，无需 Git）——直接安装 GitHub Release 的安装包：

    dsh plugin --profile web add "https://github.com/TokensService/tokens-worktable/releases/latest/download/tokens-worktable.tgz"

方式 B（想改源码用）——克隆仓库后用本地路径注册（`link:` 只接受本地路径，不要带空格）：

    dsh plugin --profile web add "link:<本目录的绝对路径>"

两种方式 `add` 都会把 `tokens-worktable` 注册进 profile 的 bundle 列表（写入 `~/.dsh`），安装完成后刷新页面即可生效；运行中的 dsh web 会通过 health 的版本/revision 变化提示刷新。

## 从源码构建

    cd tokens-worktable
    npm install
    npm run build   # lib/index.js + lib/client.js
    npm run check
    npm test        # 插件与 projects/ 的全部本地自动化测试

## 构建注意事项

- **必须在插件根目录下构建**：`build.mjs` 会把产物写到当前插件的 `lib/`。
- 客户端 bundle 保持 window.__ModuleLoader__.load 握手，react/@deepseek-ai/* 全部 external。
- **一键编译发行**：`scripts/build.sh` 是本仓的仓内构建脚本，供 PR 检视台（`projects/codereview`）「编译发行」页选用——依次完成版本一致性校验、构建、测试与 `npm pack` 打包，产出固定文件名 `dist/tokens-worktable.tgz`（对应方式 A 的 `releases/latest/download/tokens-worktable.tgz`）；发行页「产物路径」填 `dist/*.tgz` 即可随发行版上传，也可点「✦ AI 建议」分析所选代码仓/分支并同时自动回填构建脚本与产物路径；「✦ AI 生成」完成后会把发行说明直接回填。本机也可直接 `bash scripts/build.sh` 验证（可用环境变量见脚本头注释）。

## 内置项目

可直接挂载到工作台的项目页统一放在 `projects/`：

- `projects/pipeline/`：流水线工作台、阶段脚本、桥接工具与测试。
- `projects/codereview/`：PR 检视台及配套脚本。
- `projects/diag_perf/`：性能诊断页及测试。
- `projects/research_community/`：社区研究页（`community-research.html`）。添加社区链接（列表多选），
  写提示词后选 AI Code Agent（Kimi Code / MiMo Code / Codex / Claude Code）做持续对话式分析；
  CLI 非交互运行于本页目录 `.ai-community/`，续聊沿用同一服务端会话。
- `projects/tasks/`：团队任务管理页（`task-manager.html`）。任务数据走服务端共享存储
  `GET/POST/PATCH/DELETE /api/worktable/tasks`（落盘 `$DSH_HOME/storages/worktable-tasks.json`），
  全团队实时可见；用户身份取 dsh-auth-gate 真实用户（`/auth/status` 当前登录、
  `/auth/users` 负责人列表），admin 可新增/删除/批量导入（文本按行解析或 AI 分析）
  并在详情面板内联编辑全部字段，普通成员可更新分配给自己任务的状态、效果与进展（服务端强校验）。
  任务支持**多负责人**（`assignees: string[]`，兼容旧单值 `assignee`）与**开始 / 结束时间**
  （`startAt` / `endAt`）——起止时间**不提供手工填写**：点任务卡「开始」按钮（todo→doing）记开始时间、
  走「完成」录入结果（→done）记结束时间，由服务端状态推进落库（已有值不覆盖），详情面板在
  「创建 · 截止」行**只读展示**（未记录显示「未记录」）；主从双栏布局，
  点击任务卡在右侧详情面板**直接编辑保存**（无独立编辑按钮），进展可**行内添加**/编辑/删除
  （admin / 作者 / 任一任务负责人）；列表支持**状态 × 用户 × 标签**三维叠加筛选（标签 chip 可点快捷筛选）；
  完成时走多行弹窗录入结果（支持 AI 总结润色）；token 共享部署退化为全权本地模式
  （负责人自由文本）。AI 能力可配 OpenAI 兼容 API（页面「⚙ AI」）或复用 DSH 会话 AI。

`projects/package.json` 保留项目脚本的 CommonJS 运行方式；显式使用 `.mjs` 的测试仍按 ESM 执行。

`projects/` 会随 npm 安装包发布。`widget-result.json`、流水线 `runs/`、备份和指标汇总属于运行产物，不进入插件源码或发布包。

## 流水线启动 API

每条流水线都可通过服务端接口异步启动：

```http
POST /api/worktable/pipeline/run/<pipelineId>
Content-Type: application/json
```

请求体中的字段全部可选；未提供的字段使用该流水线在编辑器「默认环境」区域保存的默认值：

```json
{
  "environmentIds": ["env-prod"],
  "repositoryId": "repo-app",
  "repository": {
    "url": "https://git.example/app.git",
    "user": "ci-bot",
    "pass": "一次性访问令牌"
  },
  "branch": "release/2026",
  "strategy": "blue-green",
  "presets": ["cleanup", "check", "profiling"],
  "by": "jenkins"
}
```

- `environmentIds`：目标环境 ID 数组，可多选；传空数组即不选择任何节点（无目标节点运行，脚本注入的 `TARGET_*` 变量为空值）。
- `repositoryId`：代码仓 ID。
- `repository`：仅覆盖本次运行的代码仓 `name` / `url` / `user` / `pass`；适合传入不落盘的一次性访问令牌，未提供的字段继承所选代码仓。
- `branch`：分支或 Tag。
- `strategy`：部署策略，传空字符串可明确覆盖默认策略。
- `presets`：本次启用的预设任务（可选值 `cleanup` / `check` / `profiling`）；传空数组可明确关闭全部预设任务。普罗（Prometheus）数据采集不在预设任务中，改为在编辑器任务卡上按任务勾选「收集普罗数据」：该任务进入终态后按「任务开始→结束」时段采集，产物写入归档目录的 `{任务名}-{阶段序号}-普罗数据` 文件夹（服务端执行同样生效，结果标注在任务日志的 `[普罗采集]` 行）。
- `by`：触发方标识，默认 `api`。

接受请求后返回 HTTP `202`，响应含 `runId`、`pipelineId` 和 `pipelineName`；脚本、HTTP/Jenkins、EvalTokens 及所选预设任务均由服务端执行，运行结果写入流水线历史，可由 `runId` 关联。Jenkins 会依据触发响应的 queue `Location` 锁定本次构建号；远端 JSON / 正文读取上限分别为 2 MiB / 16 MiB。一次性代码仓凭据只存在于该次执行内，不写入配置或历史；仍应使用 HTTPS 调用接口，并避免让任务脚本回显凭据。

页面中的手动运行也使用此服务端执行池。运行与排队状态由 `GET /api/worktable/pipeline/queue` 返回，所有打开的浏览器每秒同步同一份阶段快照；关闭或刷新发起页面不会终止任务。有控制权的用户可在任一浏览器中止或取消服务端条目（非 admin 仅限本人署名任务）。状态仅保留在当前 dsh 进程内，服务重启后清空。

接口继承 dsh web 的登录守卫，命令行调用需携带有效登录凭据（会话 Cookie 或 `Authorization: Bearer <会话令牌>` 均可，令牌随会话长期有效、退出登录后失效）。非空请求体必须是 `application/json` 的 JSON 对象，最大 64 KiB；畸形 JSON、数组/标量、错误媒体类型和超限请求会分别被拒绝。显式空 `environmentIds`（或流水线默认环境保存为空列表）按不选择任何节点运行；传入不存在的 ID 会返回 `400`；流水线保存的默认环境/代码仓引用已失效时返回 `409`，不会静默改投配置首项。只有从未保存过默认环境字段的旧流水线才兼容回退首个环境/代码仓。流水线列表中的 `API` 按钮可直接查看并复制当前流水线的端点、默认请求体和 curl 示例：示例会把当前登录会话令牌的实际值直接内嵌进 `Authorization: Bearer` 头（弹窗打开时经 `GET /api/worktable/session` 实时取调用方自己的会话，响应含 `username` 与 `token`），复制即可在任意机器执行，无需手工导出 Cookie。

## 相关文档

- 更新日志：https://github.com/TokensService/tokens-worktable/blob/main/CHANGES.md
- 发布页面：https://github.com/TokensService/tokens-worktable/releases

## License

MIT

> 基于 dsh-worktable: https://github.com/Aisland-SJL/dsh-worktable
