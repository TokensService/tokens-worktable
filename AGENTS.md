# AGENTS.md

op_test —— 自动化测试与优化工具。本仓库是一个「宿主工程」：以 git 子模块形式嵌入 DeepSeek Harness（`dsh`，插件化 agent harness），在其上运行自研的工作台插件、工作台项目页（流水线 / PR 检视）和命令中转工具。仓库根没有统一构建系统，各组成部分各有独立的工具链，见下文。

## 目录结构

```
deepseek-harness/   git 子模块（github.com/deepseek-ai/deepseek-harness），dsh 本体
dsh.sh              dsh 编译 / 安装 / 运行 / Web 后台管理脚本（本仓库的主入口）
install-plugins.sh  一键安装 dsh-plugins/ 下所有插件（构建 → plugin add link: → 重启 web，幂等）
dsh-plugins/
  dsh-worktable/    工作台插件的本地副本（含本仓库自有改动，见其中 CHANGES.md）
worktable/          工作台项目页与配套脚本（由插件经 /api/worktable/* 提供访问）
  pipeline/         流水线工作台：pipeline.html + 阶段脚本 + Jenkins CORS 桥接
  codereview/       PR 检视台：code-review-prs.html（拉取 GitCode 组织 PR 并新建 AI 会话）
tools/
  op_test_relay.py  单文件 Python 命令中转工具（server/agent/ctl 三模式）
skills/             预留的技能目录（当前为空）
widget-result.json  工作台「自动挂载握手」的产物标记（agent 写、工作台读）
dsh-web.log / dsh-web.pid   dsh web 后台进程的运行日志与 pid（已 gitignore，属运行时产物）
```

## deepseek-harness（子模块）

- 技术栈：TypeScript（strict、全 ESM `"type": "module"`）、pnpm 11 workspaces 单仓（Node `^22.19 || >=24`），架构上「一切皆插件」，运行在 vendored Cordis 之上。
- 布局：`apps/`（`cli`、`web` 两个应用）、`packages/<group>/<pkg>/`（约 50 个 `@deepseek-ai/dsh-*` 能力包）、`vendor/`（Cordis 源码副本）、`python/`（Python SDK）、`native/`、`website/`（VitePress 文档站）。
- 编译产物：`apps/cli/lib/bin.js`（tsc 产出 `lib/types`，tsdown 打运行时 bundle）。
- **该目录有自己的 `AGENTS.md`（`deepseek-harness/AGENTS.md`，约 150 行强制约定；`CLAUDE.md` 是它的符号链接）。在子模块内做任何改动前必读它**，其中规定了测试策略（vitest 单测、`test:coverage` 每文件 100% 覆盖门禁、keyless 快照测试、e2e 需 `DEEPSEEK_API_KEY`）、插件开发范式、JSDoc / 文档门禁等。
- 常用命令（在 `deepseek-harness/` 下执行）：`pnpm install`、`pnpm run build`、`pnpm run test`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run test:e2e`（无 key 自动跳过）、`pnpm run test:snapshot`。

## dsh.sh（本仓库主入口）

根目录的 bash 脚本，封装子模块的构建与 dsh web 后台管理：

```bash
./dsh.sh build      # pnpm install + pnpm run build（设 CI=true 跳过 lefthook 钩子安装）
./dsh.sh install    # 在 pnpm 全局 bin 生成 dsh 包装脚本，指向仓库编译产物
./dsh.sh run ...    # 前台运行 dsh，参数透传
./dsh.sh all ...    # build + install + run
./dsh.sh start      # 后台启动 dsh web（setsid nohup，默认端口 3051，幂等）
./dsh.sh stop / restart / status / log
```

关键环境变量：`DSH_REPO`（子模块路径）、`DSH_HOME`（dsh 数据目录，默认 `/mnt/paas`）、`DSH_WORKDIR`（web 新会话默认工作目录，默认脚本所在目录）、`DSH_WEB_PORT`（默认 3051）、`DSH_LOG_DIR`、`DEEPSEEK_API_KEY`（存在 `$DSH_REPO/.env` 时自动加载）。

运行态要点：

- web profile 位于 `$DSH_HOME/profiles/web/`（即 `/mnt/paas/profiles/web/`），其 `package.json` 的 `dsh.profile.bundles` 组合了 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-worktable`、`dshmarket`、`dsh-better-sidebar`；其中 `dsh-worktable` 以 `file:` 依赖指向本仓库的 `dsh-plugins/dsh-worktable`。
- profile 的用户覆写层是 `profiles/web/cordis.patch.yml`（目录选择器主目录跟随 `DSH_WORKDIR`）；不要直接改 `cordis.yml`。
- 端口被占时 web 启动失败报 `EADDRINUSE 127.0.0.1:3051`，用 `./dsh.sh stop` 清理后再启动。

## dsh-plugins/dsh-worktable（工作台插件）

dsh web 侧边栏的 agent 级项目容器（应用抽屉），纯增量插件，不替换官方插件。本仓库副本相对上游有本地改动，**全部记录在 `dsh-plugins/dsh-worktable/CHANGES.md`**（目录选择器回退、新建文件夹、`POST /api/worktable/proxy` 内网代联路由、绕过系统代理等），改动插件时同步更新该文件。

- 技术栈：客户端 TypeScript + React（宿主 externals）+ 原生 CSS；服务端 Node。Cordis 插件协议，服务端路由 `/api/worktable/*`，终端走 WebSocket。
- 构建（注意：用 npm 而非 pnpm，独立 `package-lock.json`）：

  ```bash
  cd dsh-plugins/dsh-worktable
  npm install
  npm run build    # node build.mjs，用 esbuild 产出 lib/index.js + lib/client.js
  npm run check    # node --check 两个产物
  ```

- 必须在本目录下构建（产物写入本目录 `lib/`）；客户端 bundle 保持 `window.__ModuleLoader__.load` 握手，`react` / `@deepseek-ai/*` 全部 external。
- 装/卸载走 `dsh plugin --profile web add "link:<本目录绝对路径>"`，改完需 `./dsh.sh restart` 并刷新页面生效；也可直接用根目录 `./install-plugins.sh` 一键完成「构建 → add → 重启」。

## worktable/（工作台项目页）

由工作台插件托管的 HTML 项目页与配套脚本，页面通过 `/api/worktable/template/dshell.css` 获得工作台皮肤：

- `worktable/pipeline/` —— K8s/通用流水线可视化工作台（`pipeline.html`）。阶段绑定 `scripts/` 下的 shell 脚本，经 `/api/worktable/exec` 执行；参数识别规则与自动注入的环境变量（`TARGET_IPS`、`TARGET_HOSTS`、`IMAGE_NAME` 等）见 `worktable/pipeline/scripts/README.md`。Jenkins 集成有两种 CORS 桥接方式：`jenkins-bridge.js`（Node 本地桥接，默认 28081 → 28080，由 `watchdog-bridge.sh` 守护拉起）和 `jenkins-cors.nginx.conf`（nginx 反代方案，二选一）。
- `worktable/codereview/` —— PR 检视台（`code-review-prs.html`）：拉取 GitCode 组织（TokensService）下仓库的 PR，点击进入 AI 检视并新建 dsh 会话。
- 项目内 agent 完成窗口任务后写 `widget-result.json`（如 `{"window":"窗口1","path":"...","kind":"html"}`），工作台据此把产物自动挂进对应窗口。

## tools/op_test_relay.py（命令中转工具）

单文件、零依赖（Python 3.6+）的 TCP + JSON Lines 命令中转：`server`（默认 agent 端口 9001、ctl 端口 9002）、`agent`（长连接注册唯一名字、断线 3 秒重连、shell 执行收到的命令）、`ctl`（按名字下发命令，退出码透传远端返回码）。完整协议与用法见 `tools/README.md`。

## 约定

- 文档与注释主要使用中文；本仓库（不含子模块）的代码注释、提交说明沿用中文。
- 子模块内的改动遵守 `deepseek-harness/AGENTS.md` 的英文文档与门禁约定，两套规范不要混用。
- 不要提交 `dsh-web.log`、`dsh-web.pid`、`__pycache__/`、`*.pyc`（已在 `.gitignore`）。
- 工作区状态文件（`widget-result.json`、`worktable/*/*.html` 的运行数据等）会被 agent 和后台进程实时改写，编辑前注意可能并非静止内容。

## 安全注意事项

- `DEEPSEEK_API_KEY` 放在 `deepseek-harness/.env`，`dsh.sh` 自动加载；**任何凭据都不得提交进仓库**。
- `op_test_relay.py` 的 agent 会以 shell 执行收到的任意命令，仅在受信网络中使用。
- 工作台 `/api/worktable/proxy` 代联路由仅允许回环 / 内网（RFC1918 / 链路本地）目标，修改时不得放开到公网。
- `jenkins-bridge.js` 默认绑 `0.0.0.0:28081` 且对所有来源返回 `Access-Control-Allow-Origin: *`；仅面向本机/内网场景设计，不要直接暴露到公网。
