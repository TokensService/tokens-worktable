# 本目录 dsh-worktable 的本地改动

- 修复「项目文件夹无法修改」（`src/client/index.tsx`）：
  宿主组合的是 browse 目录选择器时，`host.pickDirectory`（native）会以
  `directory-picker-unavailable` 失败，而旧代码静默吞掉异常，点「更改」无反应。
  现回退到应用内目录浏览弹窗（经宿主 browse 能力 `listDirectory` 逐层浏览 +
  面包屑 + 可手输路径），native 可用时仍优先弹系统选择框；
  「更改」/「选择位置…」起始定位到当前已设文件夹。
- 目录选择弹窗支持新建文件夹：当前目录下单层新建（宿主 browse 能力
  `createDirectory`），成功后刷新当前目录列表（新文件夹立即可见）并把
  确认目标（路径输入框）设为新文件夹——对齐宿主 DirectoryBrowser
  「创建后重列当前层 + 选中新目录」的交互；旧行为直接进入新目录导致
  列表变空，看起来像「创建文件夹没有生效」。重名/无权限等失败原因显示在列表区。
- 服务端新增 `POST /api/worktable/proxy` 代联路由（`src/index.ts`）：
  为工作台项目页（如「流水线」Jenkins 集成）提供经插件服务器的 HTTP 转发，
  浏览器只与本工作台同源交互，绕开浏览器 CORS 与 SSH 隧道可达性问题。
  安全约束：仅允许回环 / 内网（RFC1918 / 链路本地）目标，拒绝公网地址。
- 代联请求用 `node:http`/`node:https` 直连（不用内置 fetch），
  彻底忽略系统代理（NODE_USE_ENV_PROXY 下 undici 的 NO_PROXY 偶发失效），
  保证「本地访问不走代理」。
- `lib/client.js` 已随上述修复重建（`npm run build`）。
- 重建：`npm run build`（需 devDependencies：esbuild、xterm、markdown-it、highlight.js；esbuild 可复用仓库 pnpm store 的并设 ESBUILD_BINARY_PATH）。
- 服务端新增 `POST /api/worktable/git-remote` 代码仓联通性检测 + 远程分支/Tag 列举路由（`src/index.ts`）：
  服务端执行 `git -c protocol.ext.allow=never -c protocol.file.allow=never ls-remote --heads --tags <url>`，
  HTTP(S) 仓库凭据注入 URL（user:token@host），SSH 走服务端 ssh 配置；阻断 ext/file 传输防恶意 URL 触发任意命令执行 / 本地路径探测。
  返回 `{ok, branches[], tags[]}`（annotated tag 的 peeled ref `^{}` 已过滤）。
  供「流水线」工作台设置页代码仓「测试」按钮、控制区「分支/Tag」搜索面板调用。
- `lib/index.js` 已随上述新增重建；web profile 以 `file:` 依赖安装该插件（`/mnt/paas/profiles/web/node_modules/dsh-worktable` 为安装副本，非源码链接），
  故每次重建后需把 `lib/index.js`（+ `.map`）同步进该安装副本，再 `./dsh.sh restart` 并刷新页面生效。
- 服务端新增 `POST /api/worktable/exec` 流水线阶段脚本执行路由（`src/index.ts`）：
  供「流水线」工作台 `pipeline.html` 的 `execScript` 调用（此前该前端调用无对应服务端路由，返回 404）。
  按脚本扩展名选解释器：`.sh`→`bash`、`.py`→`python3`（其余按 `bash`）；透传前端组装的 `args`/`env`/`cwd`/`timeoutMs`，
  返回 `{code, stdout, stderr}`。`runStageScript`（定时计划执行）同步按扩展名选解释器，`.py` 走 `python3`；
  `execPlan` 对 `kind==='jenkins'` 阶段定时执行时跳过（Jenkins 触发仅前端运行期支持）。
- 「流水线」工作台阶段支持四种任务类型（`worktable/pipeline/pipeline.html`）：
  模拟 / Shell（绑 `.sh`）/ Python（绑 `.py`）/ Jenkins（绑 Jenkins 任务）。
  阶段编辑器加「类型」分段选择，按类型渲染绑定行；Shell/Python 复用 scripts 列表（现收 `.sh`+`.py`）与参数识别
  （Python 识别 `sys.argv[N]` 与 `os.environ/os.getenv`）；Jenkins 选任务（设置页「获取任务列表」填充 `jenkinsJobsList`）
  并拉取作业 `parameterDefinitions` 填参数表单。运行期 `advance` 按 `kind` 分发：Shell/Python 走 `/api/worktable/exec`，
  Jenkins 经 `buildWithParameters` 触发并轮询 `nextBuildNumber`→`building/result`→`consoleText`（本地直连 / 远程走 `/api/worktable/proxy`）。
  阶段模型加 `kind`/`script.lang`/`jenkins` 字段，旧数据（仅有 `script`）经 `normalizeStageKind` 兼容推断为 `shell`。
- `lib/index.js`（+ `.map`）已随上述新增重建并同步进源码与 web profile 安装副本。
- 周期性定时计划支持「开始时间」（`worktable/pipeline/pipeline.html` + `dsh-plugins/dsh-worktable/src/index.ts`）：
  定时页「周期性」方式新增「开始时间」选择（datetime-local，留空=立即按周期触发；
  填未来时间则写入计划 `startAt` 字段，定时计划列表「方式」列展示「· 自 YYYY-MM-DD HH:mm 起」）。
  服务端 `planTick` 周期性分支读 `startAt`：到达前不触发，到达后以 `startAt` 为首触发基准按
  `everyMin` 周期触发（无 `startAt` 时维持按 `createdAt` 的原行为，向后兼容）。
  `lib/index.js`（+`.map`）已重建并同步进 web profile 安装副本，`./dsh.sh restart` 后生效。
