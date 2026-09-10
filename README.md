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

两种方式 `add` 都会把 `tokens-worktable` 注册进 profile 的 bundle 列表（写入 `~/.dsh`），装完重启 dsh web、刷新界面生效。

## 从源码构建

    cd tokens-worktable
    npm install
    npm run build   # lib/index.js + lib/client.js
    npm run check
    npm test        # 插件与 projects/ 的全部本地自动化测试

## 构建注意事项

- **必须在插件根目录下构建**：`build.mjs` 会把产物写到当前插件的 `lib/`。
- 客户端 bundle 保持 window.__ModuleLoader__.load 握手，react/@deepseek-ai/* 全部 external。

## 内置项目

可直接挂载到工作台的项目页统一放在 `projects/`：

- `projects/pipeline/`：流水线工作台、阶段脚本、桥接工具与测试。
- `projects/codereview/`：PR 检视台及配套脚本。
- `projects/diag_perf/`：性能诊断页及测试。

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
  "presets": ["cleanup", "check", "profiling", "promCollect"],
  "by": "jenkins"
}
```

- `environmentIds`：目标环境 ID 数组，可多选。
- `repositoryId`：代码仓 ID。
- `repository`：仅覆盖本次运行的代码仓 `name` / `url` / `user` / `pass`；适合传入不落盘的一次性访问令牌，未提供的字段继承所选代码仓。
- `branch`：分支或 Tag。
- `strategy`：部署策略，传空字符串可明确覆盖默认策略。
- `presets`：本次启用的预设任务；传空数组可明确关闭全部预设任务。
- `by`：触发方标识，默认 `api`。

接受请求后返回 HTTP `202`，响应含 `runId`、`pipelineId` 和 `pipelineName`；脚本、HTTP/Jenkins、EvalTokens 及所选预设任务均由服务端执行，运行结果写入流水线历史，可由 `runId` 关联。Jenkins 会依据触发响应的 queue `Location` 锁定本次构建号；远端 JSON / 正文读取上限分别为 2 MiB / 16 MiB。一次性代码仓凭据只存在于该次执行内，不写入配置或历史；仍应使用 HTTPS 调用接口，并避免让任务脚本回显凭据。

接口继承 dsh web 的登录守卫，命令行调用需携带有效登录 Cookie。非空请求体必须是 `application/json` 的 JSON 对象，最大 64 KiB；畸形 JSON、数组/标量、错误媒体类型和超限请求会分别被拒绝。显式传入空 `environmentIds` 或不存在的 ID 会返回 `400`；流水线保存的默认环境/代码仓引用已失效时返回 `409`，不会静默改投配置首项。只有没有保存默认引用的旧流水线才兼容回退首个环境/代码仓。流水线列表中的 `API` 按钮可直接查看并复制当前流水线的端点、默认请求体和 curl 示例。

## 相关文档

- 更新日志：https://github.com/TokensService/tokens-worktable/blob/main/CHANGES.md
- 发布页面：https://github.com/TokensService/tokens-worktable/releases

## License

MIT

> 基于 dsh-worktable: https://github.com/Aisland-SJL/dsh-worktable
