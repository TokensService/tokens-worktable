# 本目录 dsh-worktable 的本地改动

- 去掉聊天列 ✕ 关闭按钮，聊天图标改绿色 CSS 气泡（`src/client/split.tsx` + `index.tsx` + `styles.ts`）：
  回退上一条的聊天列 ✕ 浮钮（关闭会话窗只保留分栏标题栏 💬 与项目行 💬 两处入口）；
  聊天图标由 emoji 💬 改为 CSS 绘制的对话气泡（`.dsh-wt_chatGlyph`：圆角描边泡体 + 左下
  实心三角尾，颜色随 `currentColor`——emoji 无法染色，CSS 绘制才能绿色化并随关态
  `grayscale` 置灰），常态绿色 `#3fb950`（同绑定按钮「完成」绿）；分栏标题栏 💬 开关与
  项目行 💬 按钮同款替换，视觉一致。
  `lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh restart` 后生效。

- ~~聊天列左上角新增 ✕ 关闭按钮（`src/client/split.tsx` + `styles.ts`）~~（已回退，见上一条）：
  会话窗打开时，聊天列左上角浮一个 ✕（fixed 定位，`left = chatX + 6`，与标题栏同排），
  点击即 `setChatClosed(true)` 关闭会话窗——与分栏标题栏 💬 / 项目行 💬 同一 `chatClosed` 状态，
  关闭后可由这两处 💬 恢复；按钮半透明底色（`--dsw-alias-fill-l1`），压在深/浅会话内容上都可读，
  会话窗关闭或列宽为 0 时不渲染。
  `lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh restart` 后生效。

- 每个项目行新增 💬 聊天按钮（`src/client/index.tsx` + `split.tsx` + `locales.ts` + `styles.ts`）：
  「工作台」控制室行与每个布局项目行在绑定按钮左侧新增 💬 按钮，点击打开/关闭该项目的
  会话窗口——项目未打开时先打开再切换；开/关状态即分栏引擎的 `chatClosed`，随布局条目
  持久化（`dsh.worktable.split.v2`），与分栏标题栏 💬 开关同一状态、双向同步。
  按钮态：当前打开项目读引擎实时状态（`splitStore.subscribe` → `activeChatClosed`），
  未打开项目读持久化存档（split.tsx 新导出 `peekChatClosed(layoutId)`）；已关闭时按钮
  降透明度 + 去色（同标题栏 💬 关态）。hover 气泡复用绑定按钮的 body 级气泡
  （事件委托选择器扩为 `.dsh-wt_bindBtn,.dsh-wt_chatBtn`）。
  `lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh restart` 后生效。

- 修复 `/api/worktable/proxy` 代联在 Node 24 + `NODE_USE_ENV_PROXY=1` 环境下超时（`src/index.ts`）：
  Node 24 起 `NODE_USE_ENV_PROXY=1` 时 `node:http`/`node:https` 同样会走系统代理（原注释
  「node:http 直连彻底忽略系统代理」在旧 Node 成立、Node 24 失效），dsh web 进程带
  `http_proxy=127.0.0.1:8118` 时，代联部分内网目标（如 192.168.10.6:25889）经代理不通，
  挂起至路由自带 20s 超时返回 `{"error":"Error: timeout"}`。
  修复：代联请求显式传入独立 `Agent`（`agent: new reqLib.Agent()`），实测可彻底绕过环境代理直连。
  同时新增调用方可选 `useProxy:true`：不注入 Agent、按进程环境走系统代理
  （需 NODE_USE_ENV_PROXY=1 才生效）——供页面「走系统代理」开关选择，默认仍直连。
  `lib/index.js`（+`.map`）已重建，`./dsh.sh restart` 后生效。

- 分栏标题栏新增「会话窗口」开关按钮 💬（`src/client/split.tsx` + `locales.ts` + `styles.ts`）：
  点击关闭右侧（或左侧）会话窗口——会话视图区整体 `display:none`（含输入框），内容窗
  （含顶部通栏行）占满整宽，聊天分隔线与 ⇄ 换位按钮随关隐藏；再次点击恢复。
  状态经 `chatClosed` 字段随布局条目持久化（`dsh.worktable.split.v2`，旧存档无该字段默认
  打开，向后兼容），重开布局时恢复上次的开/关状态；`close()` / `syncAnchor()` 重锚定时
  恢复旧视图区 `display`，避免关窗状态泄漏到新会话根。
  `lib/client.js`（+`.map`）已随本改动重建。
- pipeline.html「📂 打开归档目录」新建会话改为「关项目、只留会话聊天 + 文件夹浏览」的独立窗口
  （`src/client/index.tsx` + `worktable/pipeline/pipeline.html`）：
  window 桥新增 `__dshNewChatSessionAtFolder(text, cwd, folder)`（`newChatSessionWithFolder`）——
  与 `newChatInProject` 相反，刻意不做 `markPluginSessionOpen`，让「切会话关项目」联动生效：
  项目分栏随切换关闭，新窗口只含会话聊天与文件夹浏览；folder 非空时在切换落定后重开
  better-sidebar 文件夹窗口（会话切换会刷新侧边栏，项目页内先开的会被刷掉，故立即 + 400ms +
  1200ms 延时各开一次，`openTab` 按 dedupeKey 复用同一标签，幂等）；text 非空才填输入框草稿。
  原 `__dshOpenFolderInSidebar` 桥实现抽为模块级 `openFolderInSidebar`（经新增的模块级
  `applyCtx` 取 better-sidebar 服务），供两条桥复用，行为不变。
- 修复「页面修改」✏️ 等新建空会话后聊天窗不被挤压、hero 居中输入框被内容窗挡住（`src/client/split.tsx`）：
  宿主会话根 `data-phase` 有三态（settling/hero/active），新建空会话在发出首条消息前一直停在 hero；
  分栏引擎原三处锚定判定只认 `active`，对 hero 永远「保持等待」→ 新会话视图全宽铺在项目内容窗
  下面，输入框不可见。现改为只等 `settling` 过渡态，hero 立即锚定并施加 margin 挤压
  （ResizeObserver 回调 / body 级 MutationObserver 兜底 / `syncAnchor` 三处同步放宽）。
  配套：`syncAnchor` 重锚定后把让位观察器（yieldObserver）转挂到新视图区（原观察对象随旧会话根
  卸载，切一次会话后外部改写 margin 不再触发让位）；`refreshGeom` 在 header 为 display:none
  （空白 hero 会话）时 geom.top 回退到会话根顶，避免内容窗从视口 y=0 起算向上越界。
- pipeline.html「📂 打开归档目录」优先经 dsh-better-sidebar 侧边栏「文件」面板打开归档目录
  （`src/client/index.tsx` + `worktable/pipeline/pipeline.html`）：
  新增 `window.__dshOpenFolderInSidebar(path)` 桥（暴露给 iframe 项目页），调用 better-sidebar 服务的
  `openTab({ type:'editor', path, meta:{ dir:true } })` 开一个以归档目录为根的文件夹窗口
  （同 better-sidebar agent-opens 推送的 folder 分支；path 相同按 dedupeKey 复用同一标签，
  内容型打开自动展开所在面板）；未装 better-sidebar 或打开抛错时返回 false，
  页面回退到原服务端系统文件管理器（xdg-open/gio/open）路径。
  顺带修复：运行启动即预建归档文件夹（`ensureArchiveFolder`，此前要等首个任务日志落盘才建目录，
  运行初期点按钮报「✗ 目录不存在」）；系统文件管理器助手脚本在目标目录不存在时回退打开其父目录
  （归档根）并回显实际打开目录，连归档根都不存在才报错。
- 流水线运行历史「AI 日志分析 / Profiling 分析 / 性能诊断」改为填草稿不提交、工作目录跟随归档目录
  （`src/client/index.tsx` + `worktable/pipeline/pipeline.html`）：
  `newChatInProject` 新增 `cwd` 参数（未分组时以 `{ cwd }` 建会话，优先级：workspaceId > cwd > 默认），
  window 桥新增 `__dshNewChatSessionAt(text, cwd)`；pipeline.html `createAnalysisChat` 优先走该桥——
  新会话工作目录 = 选中行的 `archive` 归档目录，提示词经 `fillSessionDraft` 只填输入框、不自动发送，
  旧版插件无此桥时退化为原 `__dshPromptIntoSession` 自动发送路径（退化路径建会话同样带 `cwd`）。
  按钮悬停提示、「分析配置」说明与 `scripts/README.md` 同步更新。
- 项目设置新增「工作区（会话分组）」选择（`src/client/index.tsx` + `src/index.ts`）：
  绑定弹窗在「项目文件夹」与「绑定对话」之间新增工作区行，点击弹出宿主工作区列表
  （与对话列表弹层互斥、同一定位/样式），选中即记、✕ 清除；`ProjectsState` 新增
  `workspaces: Record<projectId, workspaceId>`（随 folders 同款规则：本地项目落 localStorage，
  已发布项目走服务端 `/api/worktable/projects` 同步切片，服务端路由同步放行该字段）。
  生效点：「页面修改」✏️ 新建会话时带 `{ workspaceId }`，新会话落进项目选定的分组
  （未设置 = 未分组，行为不变）。
  修复：初版在模块级 `startPageEdit` 里误引组件内的 `projectsRef`（esbuild 不做未定义名校验，
  运行期 ReferenceError 导致点 ✏️ 无反应）；改为由组件调用侧读 `projects.workspaces[id]` 传入。
  「管理项目」列表每行新增 ⚙ 按钮（`manage.settings`），直接打开该项目的设置弹窗
  （文件夹 / 工作区 / 绑定对话），不再只能从项目卡片的 ◎ 绑定图标进入。
- 「页面修改」新建会话改为只填输入框、不自动提交（`src/client/index.tsx`）：
  新增 `fillSessionDraft`，经宿主 `conversation.input`（SessionInputResolver.for +
  sessions.binding(sessionId).ctx）把提示词写入新会话输入机草稿；`newChatInProject`
  （管理项目 ✏️ 按钮与 window.__dshNewChatSession 桥共用）由 `promptIntoSession`（自动发送）
  改为 `fillSessionDraft`，用户确认内容后自己按发送；facade 不可用时直接报错，
  不退化为自动发送。✏️ 按钮悬停提示与设置弹窗说明文案同步更新（`src/client/locales.ts`）。
  「AI 日志分析」与「自定义窗口新建会话」维持自动发送不变。
- 修复流水线环境变量未正确传入任务脚本（`src/index.ts` `runStageScript` + `worktable/pipeline/pipeline.html` `execScript`）：
  参数的 `:-默认值` 由识别器存入 `p.def`，旧逻辑在用户未显式填值时也把 `p.def` 当显式值下发，`env[key]` 被占位后
  运行级注入（`TARGET_IP`/`TARGET_IPS`/`TARGET_HOSTS`/`IMAGE_NAME`/`IMAGE_TAG`/`PIPELINE_NAME` 等）因「同名已存在」被跳过，
  脚本只能拿到源码里的兜底默认值（如 `TARGET_IP` 恒为 `127.0.0.1`），与「留空则使用注入值」的约定相悖。
  现改为：env 参数仅在用户显式配置（`values[key]` 存在且替换后非空）时下发；未配置则不下发，
  运行级注入优先生效，未注入时脚本自身 `:-` 默认兜底；位置参数保留 def 兜底。
  阶段/清理脚本参数表单同步改为只回显显式值（留空=注入值，默认值退为 placeholder 提示），阶段详情 `# env:` 预览与实际下发一致。
  定时计划（服务端 `execPlan`/`runStageScript`）注入集同步对齐前端：补 `TARGET_IPS`/`TARGET_HOSTS`/`IMAGE_NAME`/`IMAGE_TAG`/`PIPELINE_NAME`/`GIT_BRANCH`/`DEPLOY_STRATEGY`
  （`runCtx` 增带 `image`/`branch`/`strategy`），`TARGET_IP` 改为优先取首个节点 IP。
  `lib/index.js`（+ `.map`）已随本修复重建。

- 「流水线」定时执行的任务回显逐任务归档（`src/index.ts` `execPlan`）：
  每个任务（环境清理 00 / 各阶段 01…，含审批门、Jenkins 跳过、模拟阶段）的回显都按页面约定
  写入归档文件夹的独立日志文件 `run-<tag>-NN-任务名.log`，并写/合并汇总 `run-<tag>.log`
  与 `run-<tag>.profile.json`；阶段定时后缀沿用页面登记的 `pl.archive`/`pl.tag`/`baseSeq`
  （回显落进本地前缀同一归档文件夹、编号连贯），独立定时计划自建
  「<流水线名>_<年月日时分秒>」文件夹（`archiveDir`，为空时回退 `scriptsDir` 旁 `runs/`，同页面保底）。
  `runStageScript` 同步注入 `ARCHIVE_DIR/ARCHIVE_FOLDER/ARCHIVE_PIPELINE/ARCHIVE_TAG`（与前端 execScript 一致）；
  归档目录已显式配置时追加执行归档脚本（如 collect_logs.sh，注入 `ARCHIVE_LOG_FILE` 等）；
  历史记录带 `archive`/`tag` 字段。归档失败只告警、不影响定时执行。
- 「流水线」页面侧配套（`worktable/pipeline/pipeline.html`）：
  `registerStageTimers` 把本次运行的归档上下文（`archive`/`tag`/`baseSeq`）随计划交给服务端；
  点「中止」时先把被中断任务的当前回显即时归档为独立任务日志，`archiveRun` 兜底也补归档
  「有回显但被中止」的阶段；Jenkins 阶段构建中/被中止时 buildLog 输出已轮询到的部分回显。

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
- 代联请求用 `node:http`/`node:https` + 显式独立 `Agent` 直连（不用内置 fetch），
  彻底忽略系统代理（NODE_USE_ENV_PROXY 下 undici 的 NO_PROXY 偶发失效；
  且 Node 24 起 NODE_USE_ENV_PROXY=1 时 node:http 也会走环境代理，仅靠「不用 fetch」不够），
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
- GPU 探针 `GPU_PROBE`（`src/index.ts`）容器清单段兼容无 docker 的 K8s 节点：
  原仅 `docker ps`，在纯 containerd 节点（无 docker CLI）上恒为空，导致流水线环境页
  GPU 占用进程的「容器」列始终无匹配。现改为顺序输出 `docker ps` + `nerdctl --namespace k8s.io ps`
  + `nerdctl ps`（各自 `2>/dev/null`，缺命令不影响其他段），K8s Pod 容器以
  `k8s://<ns>/<pod>/<container>` 命名展示；cgroup 64 位 ID 与 12 位短 ID 的前缀匹配逻辑不变。
  段尾补 `true` 兜底：ssh 退出码取远程末条命令，目标机缺 nerdctl（或 docker）时末条命令 127
  会让 execFile 整体判失败、丢掉已采到的全部 GPU 数据（如有 docker 无 nerdctl 的节点）。
  `lib/index.js`（+`.map`）已重建并同步进 web profile 安装副本，`./dsh.sh restart` 后生效。
- GPU 探针 ssh 调用加固（`src/index.ts` `queryGpu`）：加 `UserKnownHostsFile=/dev/null` +
  `LogLevel=ERROR`——首次登录的 yes/no 确认、重装后指纹变更（`REMOTE HOST IDENTIFICATION HAS CHANGED`）
  均不再阻塞查询（内网受信前提，不校验主机指纹）；密码路径加
  `PreferredAuthentications=password,keyboard-interactive` + `PubkeyAuthentication=no`（跳过公钥尝试，
  避免 ssh-agent 密钥过多触发 `Too many authentication failures`）+ `NumberOfPasswordPrompts=1`
  （密码错误一次即失败，不把错密码重试 3 遍触发账户锁定）。
  `lib/index.js`（+`.map`）已重建并同步进 web profile 安装副本，`./dsh.sh restart` 后生效。
- GPU 探针远程执行与登录 shell 解耦（`src/index.ts` `queryGpu`）：远程命令改为
  `echo <base64(GPU_PROBE)> | base64 -d | bash`。原样直发探针时，登录 shell 为 zsh 的节点
  （如 192.168.1.99 这类 BMS 节点）上 `echo ===` 触发 zsh 的 `=word` 等号展开（报
  `zsh:1: == not found`），且 zsh 默认不对 `$(...)` 结果做单词拆分导致 for 循环失效，
  整段探针无一幸存。base64 管道形式只含 POSIX 通用语法，zsh/bash/sh 登录均可正确落到 bash 执行。
- GPU 探针执行超时 20s→60s（`src/index.ts` `execText`）：远程探针含 ssh 握手 + 3 次
  nvidia-smi + nerdctl 列容器，繁忙节点实测 ~10.5s，20s 余量不足，偶发超时被 execFile
  终止后 stderr 为空、页面只显示 "Command failed: sshpass ..." 难以定位；超时分支补充
  「（执行超过 60s 被终止）」可读原因。
  `lib/index.js`（+`.map`）已重建并同步进 web profile 安装副本，`./dsh.sh restart` 后生效。
- 周期性定时计划支持多周期单位（`worktable/pipeline/pipeline.html` + `dsh-plugins/dsh-worktable/src/index.ts`）：
  定时页「周期性」方式由固定「每 N 分钟」改为「每 N + 单位下拉」（分钟/小时/天/周/月/年），
  计划对象新增 `every` + `everyUnit` 字段；固定单位（分钟/小时/天/周）仍写 `everyMin` 兼容旧服务端，
  月/年无固定分钟数不写。服务端 `planTick` 周期性分支按单位调度：固定单位按毫秒步长取整推进，
  month/year 按日历步进（每月/每年同日触发，重启后漏触发的周期自动补齐到下一个日历点）；
  仅有 `everyMin` 的旧计划归一为分钟单位，行为不变（`startAt` 首触发语义保持：到达即在 `startAt` 首触发）。
  `lib/index.js`（+`.map`）已重建并同步进 web profile 安装副本，`./dsh.sh restart` 后生效。
- 服务端新增 `POST /api/worktable/exec-stream` 流式执行路由（`src/index.ts`）：参数与 `/api/worktable/exec`
  一致，但改用 `spawn` 边执行边把 stdout/stderr 以 NDJSON 逐块回传
  （`{"type":"out"|"err","text":…}` / `{"type":"done","code":N}` / `{"type":"error","message":…}`），
  Content-Type 为 `application/x-ndjson`。子进程 detached 独立进程组，客户端断开（中止/刷新）时
  连同子进程一起 SIGTERM 终止，超时同样生效（超时 SIGKILL 并回传 error）。
  供「流水线」`pipeline.html` 脚本阶段「执行中实时回显」使用：`execScript` 新增 `onStream`/`signal` 参数，
  默认走 `/api/worktable/exec-stream` 边执行边把输出实时追加到「阶段详情」日志框（快速输出 ~100ms 节流重建），
  接口不可用（旧插件构建）自动降级为一次性 `/api/worktable/exec`；「中止/重置」经 AbortController
  断开会话、服务端终止子进程。Jenkins 阶段轮询期间增量拉取控制台输出（按长度差分，只追加新增部分）。
  `lib/index.js`（+`.map`）已重建并同步进 web profile 安装副本，`./dsh.sh restart` 后生效。
- 「流水线」阶段「审批门」改为「是否执行」选择（`worktable/pipeline/pipeline.html` + `src/index.ts`）：
  阶段编辑器中的「审批门」复选框替换为「不执行」勾选框（默认不勾=执行）；
  阶段模型 `gate` 字段由 `skip` 取代，运行时 `advance` 对 `skip` 阶段经 `skipStage` 直接标记
  `skipped`（节点虚线置灰、详情徽标「跳过」、日志输出跳过说明）并推进下一阶段，脚本 / Jenkins / 模拟阶段一视同仁；
  原「等待审批」状态、批准/拒绝按钮（showGate）及其样式一并移除。
  兼容：localStorage / 服务端配置加载（`migrateGate`）与文本导入（`parseStagesText`）把旧 `gate:true` 迁移为 `skip:true`；
  服务端定时执行（`execPlan`）对 `skip`（及旧 `gate`）阶段记 `skipped` 跳过，不再「审批门自动通过」。
  `lib/index.js`（+`.map`）已重建，合并后需同步进 web profile 安装副本并 `./dsh.sh restart` 生效。
- 内容页 → 右侧聊天窗桥 `__dshNewChatSession`（`src/client/index.tsx`）：
  供 iframe 项目页（如「流水线」pipeline.html 的「页面修改」按钮）在项目内新建 AI 会话并发送提示词。
  此前内容页直接调 `__dshSessions.create` + `__dshOpenSession`，未标记插件发起切换，
  触发「项目打开期间切到非绑定会话 → 自动关项目」联动，项目分栏被关掉、整屏跳到新会话。
  新桥 `newChatInProject` 复用 `analyzeLogInSession` 的会话创建模式（预设/模型修复 +
  `markPluginSessionOpen`），项目保持打开，新会话出现在右侧聊天窗。
  `lib/client.js`（+`.map`）已随上述新增重建并同步进 web profile 安装副本，`./dsh.sh restart` 后生效。
- 「页面修改」入口迁入插件设置弹窗（`src/client/index.tsx` + `locales.ts` + `styles.ts`，配套 `worktable/pipeline/pipeline.html` 移除页内旧入口）：
  设置弹窗「管理项目」列表每个布局项目行新增 ✏️「页面修改」按钮（仅当能从布局窗口 iframe 标签
  `/api/worktable/site/<编码路径>` 推出页面文件绝对路径时显示），点击按提示词模板 + 项目页面路径
  经 `newChatInProject` 在右侧聊天窗新建 AI 会话修改该页面；设置弹窗底部新增「页面修改」提示词
  模板编辑区（`{page}` 替换为页面路径、`{name}` 替换为项目名，存 localStorage
  `dsh.worktable.pageEditPrompt.v1`，清空保存即恢复默认模板）。
  pipeline.html 侧移除页头「页面修改」按钮、设置页「页面修改配置」卡片及其配置存取
  （`pageEditPrompt` 不再进服务端配置 / 离线缓存；旧 `pip-pageEditPrompt` localStorage 键废弃不再读取）。
  `lib/client.js`（+`.map`）已随上述新增重建并同步进 web profile 安装副本，`./dsh.sh restart` 后生效。
- 设置弹窗新增「开发 dsh-worktable」区（`src/client/index.tsx` + `src/index.ts` + `locales.ts` + `styles.ts`）：
  「页面修改」区下方新增提示词模板编辑区（`{dsh_worktable}` 替换为插件项目目录，存 localStorage
  `dsh.worktable.devPrompt.v1`，清空保存即恢复默认模板）与 🛠「新建开发会话」按钮；
  点击经 `newChatInProject` 新建 AI 会话（cwd = 插件项目目录），开发提示词只填输入框、不自动发送。
  插件项目目录由服务端健康路由 `/api/worktable/health` 新增 `dir` 字段上报
  （`import.meta.url` 的 realpath 上一级；link: 安装时即源码目录），客户端 `fetchPluginDir` 取一次后缓存。
  `lib/index.js` / `lib/client.js`（+`.map`）已随上述新增重建，`./dsh.sh restart` 后生效。
