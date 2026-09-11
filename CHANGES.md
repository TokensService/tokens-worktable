# 本目录 tokens-worktable 的本地改动

- PR 检视台「编译发行」新增 AI 配置建议与结果自动回填（`projects/codereview/code-review-prs.html`、
  `src/client/index.tsx`）：构建脚本行新增「✦ AI 建议」，在右侧聊天窗分析当前代码仓/分支后以受标记约束的
  JSON 同时返回构建脚本和匹配的产物路径；页面校验仓内相对路径、自动回填，并沿用现有分支级云端设置保存。
  发行说明「✦ AI 生成」改为等待会话完成后直接提取标记内 Markdown 回填文本框，不再要求手工复制。
  新增 `window.__dshSendChatForResult(text)` 宿主桥：新建并打开右侧会话、自动发送提示，同时订阅真实会话运行态
  与公开 `eventSource` 事件窗，完成后读取最后一条 AI 文本返回 iframe；当前选中会话不带 `completed` 提醒标志，
  故以 `running` 停止、`turn/end` 为正常完成且事件窗已有未中止回答为完成条件。生成期间切换平台/仓库/分支/
  发行信息会尽早停止旧任务；结构化结果字段类型、危险路径或标记解析失败均保留原表单值。新增
  `tests/ai-chat-result.test.mjs`、`tests/codereview-ai-suggestions.test.mjs` 覆盖结果等待、
  结构化解析、安全校验、双字段/发行说明回填及过期结果保护。
- 项目管理行「✏️ 页面修改」点击后强制打开会话窗（`src/client/index.tsx` 的 `startPageEdit`）：此前会话窗被 💬
  关闭时（内容窗全宽、会话视图区 display:none）点 ✏️ 只在后台建好新会话并填好草稿，用户看不到任何反馈；
  现在建会话前先 `splitStore.setChatClosed(false)`——不管会话窗当前是开是关，都打开会话窗再新建会话填入提示词；
  分栏未打开（无项目在项目视图里）时不受影响（全宽会话视图本就可见），调用失败静默忽略。
- 代码仓「部署策略」配置新增脚本来源（`projects/pipeline/pipeline.html`）：代码仓表单在「部署策略 URL」前加
  「策略·URL / 策略·脚本」来源切换——URL 模式沿用原有按分支（`{branch}` 占位）拉取分页 JSON；脚本模式按主控
  当前分支经 `/api/worktable/exec` 执行 scripts 目录中的脚本（注入 `GIT_BRANCH` 与 `GIT_URL`/`GIT_USER`/
  `GIT_PASSWORD`，30 秒超时），stdout 每行解析为一个策略名（去空白、跳过空行、按序去重），脚本缺失 / 非零退出 /
  空输出视为失败。仓库模型新增 `strategyMode`/`strategyScript` 字段（`normalizeRepo` 归一化，旧数据缺省 URL 模式），
  「部署策略」列与「策略测试」按来源展示/分流，策略缓存 key 含来源（改配置后旧缓存自动失效），主控与定时页策略
  面板头部标注来源类型。文档（`projects/pipeline/scripts/README.md` 新增「部署策略脚本」契约）与测试
  （`projects/pipeline/tests/test_strategy_script.js`：配置归一化 / 来源解析 / 缓存 key / 输出解析 / 执行拉取的
  成功与失败分支）同步更新。
- pipeline.html「📂 打开归档目录」修复目标目录不存在时的打开行为（`projects/pipeline/pipeline.html`）：
  打开前新增目录存在性预检（`resolveExistingFolder`，经 `/api/worktable/fs` 探测），目标归档目录
  不存在时（历史归档已清理、归档路径改过等）统一回退打开其父目录（归档根），连归档根都不存在才报
  「✗ 目录不存在（含归档根目录）」——此前回退逻辑只存在于系统文件管理器助手脚本路径，better-sidebar
  侧边栏主路径不预检，会以不存在目录为根开出空文件树；探测请求本身失败（网络/服务端异常）按存在
  处理、不阻断打开。侧边栏与文件管理器两条路径的回退提示统一为「✓ 目标目录不存在，已回退打开 …」。
  按钮悬停提示同步重写为现行真实行为（原地经侧边栏/文件管理器打开、保持当前页面与会话、不新建
  会话），移除已下线的「新建 AI 会话并切入其窗口」旧描述。测试：`test_execution_progress.js` 新增
  目标不存在回退 / 根不存在报错 / 探测失败放行三例，「打开目录前等待写入」fetch 桩兼顾预检请求。
- 新增仓内构建脚本 `scripts/build.sh`（供 PR 检视台「编译发行」页选用，也可本机直接执行）：在克隆出的仓库根目录
  依次执行「RELEASE_TAG 与 package.json / dsh.plugin.json 版本一致性校验（`SKIP_VERSION_CHECK=1` 可跳过）→
  依赖就绪（本仓 node_modules 已随 git 跟踪，浅克隆即可用，缺失时才 `npm ci`）→ 构建（默认 `node build.mjs`，
  注入 `BUILD_CMD` 时改跑自定义命令）→ `node --check` 产物语法校验 → 测试（默认插件 node 用例，
  `FULL_TESTS=1` 跑完整 `npm test`，`SKIP_TESTS=1` 跳过）→ `npm pack` 打包并重命名为
  `dist/tokens-worktable.tgz`（文件名固定，对应 README 安装地址 `releases/latest/download/tokens-worktable.tgz`；
  发行页「产物路径」配置 `dist/*.tgz` 即随发行版上传）」。README「构建注意事项」同步补充说明。
- 流水线普罗数据采集改为任务粒度（`projects/pipeline/pipeline.html` + `src/index.ts`）：「收集普罗数据」从系统预设任务
  中下线（主控「预设任务」多选、流水线默认运行参数、阶段列表 promCollect 预设标记行、预设任务内 model/namespace/起止
  时间配置、服务端 API `presets` 的 `promCollect` 值一并移除；旧流水线/导入数据经 `migratePromPreset` 与服务端
  materialize 自动过滤遗留标记行与旧顶层 `prom` 配置），改为编辑器任务卡上的「收集普罗数据」开关（`data-f="promCollect"`，
  随阶段持久化）。勾选的任务进入终态（成功/失败）后，按「本任务开始→结束」时段调用「设置 → 普罗数据服务配置」的收集
  脚本采集普罗指标：页面运行经 `advance`/`finish` 的 `taskPromFinalize` 后台采集（不阻断流水线，输出落产物目录
  `collect.log`，失败仅告警；「从失败阶段重试」复位标记后重采），定时计划与 API 服务端执行（`execPlan`）同步采集并把
  结果标注到该任务日志的 `[普罗采集]` 行。产物目录统一为归档文件夹下 `{任务名}-{阶段序号}-普罗数据`（未配置归档时落到
  scripts 目录 `vllm-metrics/` 同名子目录）；`model_name` / `xds_namespace` 不再随流水线配置，统一按默认占位
  `${MODEL_PATH}` / `${DEPLOY_STRATEGY}-${BY}` 在采集时点解析（解析不出则不注入），手动「📊 收集普罗数据」补采同源。
  文档（`README.md`、`projects/pipeline/scripts/README.md`）与测试（`tests/pipeline-run-api.test.mjs`、
  `projects/pipeline/tests/test_cleanup_flow.js`、`test_config_import_export.js`、`test_execution_progress.js`）同步更新。
- 内置（默认）流水线只读查看（`projects/pipeline/pipeline.html`）：内置流水线在「流水线任务」列表的操作
  由「编辑」改为「查看」，打开的是只读模式编辑器——名称 / 脚本目录 / 默认环境与阶段卡内全部编辑控件禁用，
  保存 / 添加阶段入口隐藏，任务卡禁止拖拽、选中卡不再出现「+」插入按钮，仅保留「关闭 / 取消」退出；只读
  模式不恢复编辑草稿（展示内置定义真值），阶段参数异步重识别后重新应用禁用。`savePlForm` 与
  `persistFlowOrder` 兜底拦截一切写回内置定义的路径；主视图（编排区）对内置流水线同样禁止拖拽改序
  （`flowDraggable` 统一守卫），节点提示改为「双击查看」。需要调整内置流水线时仍在列表「复制」为可编辑副本。
  新增 `projects/pipeline/tests/test_pipeline_readonly.js`（只读标志 / 标题 / 草稿跳过、控件禁用与恢复、
  保存与拖拽落盘兜底、选中卡插入按钮）。
- 流水线「API」弹窗的请求体与 curl 示例改为按运行框当前填写的运行参数动态生成
  （`projects/pipeline/pipeline.html` 的 `pipelineApiSpec`）：环境多选、代码仓、分支、部署策略、
  执行人、预设任务均取主控运行栏当前值（与点「▶ 运行流水线」取数一致），不再读取流水线保存的
  默认参数；分支留空回退 `main`、执行人留空回退 `api`（服务端缺省），空策略 / 空预设作为显式值
  逐项覆盖默认配置。当前无有效环境 / 代码仓选择时省略对应字段（显式空数组 / 空串会被服务端判
  400，省略则调用时回退流水线默认配置）并在弹窗内给出警告。配套更新
  `projects/pipeline/tests/test_pipeline_api_ui.js`。
- PR 检视台「编译发行」分支级构建设置云端保存与自动填充（`projects/codereview/code-review-prs.html`）：构建脚本 /
  构建命令 / 超时 / 产物路径 / 预发布按「owner/repo@branch」为键存入服务端云端文件
  `$DSH_HOME/storages/dsh-codereview-relcfg-{gc|gh}.json`（经 `/api/worktable/file|write|mkdir` 读写，按平台分桶，
  所有浏览器共享，与云端构建历史同目录同模式）。字段改动或启动一次发行即 upsert 本地镜像并防抖 600ms 写回；
  选中仓库 / 分支、进入发行页、拉取仓库列表、切换平台时按当前键从云端镜像自动填充，无记录的键保留表单现值。
  拉取 / 填充均带代次与键复核（在途旧平台拉取、填充等待期间切换仓库分支均丢弃），写云端前先确保镜像已拉取，
  避免按空缓存覆盖丢其他分支设置；构建脚本行新增云端状态提示（保存中 / 已保存 / 已自动填充 / 写回失败 toast）。
  本机 `relcfg`（localStorage）仍只记「上次所选仓库 / 分支」，行为不变。
- 流水线支持按条目通过 API 启动（`src/index.ts` + `projects/pipeline/pipeline.html`）：新增
  `POST /api/worktable/pipeline/run/<pipelineId>`，请求异步接受并返回 `runId`；可设置目标环境 ID、代码仓 ID、
  分支、部署策略、预设任务和触发方，任一字段未传时逐项采用该流水线默认值。API 复用服务端计划执行器，
  按流水线中的预设任务位置展开执行，将代码仓 / 分支 / 策略注入脚本环境，并把 `runId`、流水线 ID、
  代码仓 ID 等关联信息写入历史。编辑器「载入脚本」下方旧说明已移除，新增「默认环境」配置区，可保存
  多个目标环境、代码仓、分支、部署策略和预设任务；顶部运行框参数仍作为显式覆盖，列表 `▶` 直接运行
  使用该条流水线默认值。每行新增 `API` 按钮，展示可复制的端点、完整 JSON 请求体和 curl 示例；接口沿用
  dsh web 登录守卫。旧流水线、服务端刷新及导入数据自动补齐默认结构，编辑草稿、复制、导入导出与服务端
  持久化均保留这些默认值。启动接口使用 64 KiB 上限的严格 JSON 对象解析，畸形/错误媒体类型/超限请求不再
  退化为默认部署；显式空环境以及失效的默认环境/代码仓会直接拒绝，不会静默改投首项。HTTP/Jenkins 与
  EvalTokens 阶段现可在 API 服务端真实执行并传递输出变量；普罗采集预设注入 `METRICS_ACTION=collect`、运行
  时间窗、服务地址、模型/命名空间及归档目录。另支持请求内用 `repository` 一次性覆盖代码仓地址和凭据，
  仅进入本次执行，不写入服务端配置或历史。Jenkins 触发后跟随响应中的 queue `Location` 等待该队列项实际
  分配的构建号，避免并发触发串号；EvalTokens 终态按明确成功值及失败优先级判定；远端 JSON / 正文读取分别
  限制为 2 MiB / 16 MiB。新增服务端 API / 执行器测试及客户端默认值、覆盖、预设快照和 API 弹窗测试。

- 流水线阶段「耗时」默认 0 并在编辑时保留原值（`projects/pipeline/pipeline.html`）：`newStage` 默认
  `dur:5` 改为 `dur:0`，0 表示不设置耗时——本地模拟阶段不再空转等待，运行即结束（`runStage` 对
  `dur<=0` 走即时完成路径，sub 阶段标记、回显归档、渲染推进与计时路径一致，也不再启动计时器）。
  原先编辑器三处把 0/空值回退成 5 秒（输入框 `s.dur||5`、change 处理 `Math.max(1,…||5)`、保存
  `Math.max(1,parseInt(s.dur)||5)`），导致已设为 0 的阶段一编辑就被改回 5 秒；现统一改为保留原值
  （`s.dur||0` / `Math.max(0,…||0)`），输入框 `min` 放开到 0，留空即 0。编辑器「模拟」类型提示与
  阶段说明同步标注「0=不等待」。新增 `projects/pipeline/tests/test_stage_dur_default.js`（新建阶段
  默认 0、编辑器保留 0/非零值、dur=0 即时完成不启动计时器、dur>0 仍按计时器推进）。
- 流水线多运行并行时支持点击查看阶段详情，运行队列条目展示完整运行信息（`projects/pipeline/pipeline.html`）：
  - 「流水线任务」行内对有在跑运行的流水线显示「运行中」徽标（焦点运行另标「（查看中）」）；点击该行
    （或运行框下拉选中）不再弹「暂不能切换」，而是聚焦其最近一次启动的运行，编排区/阶段详情即切换到
    该次运行的实时视图（同一流水线并行多个运行时队列条目仍可各自精确聚焦）。新增 `runsOfPipeline` /
    `latestRunOfPipeline` 助手；`selectPipeline` 在有在跑运行时一律转为 `focusRun`。
  - 运行队列（本页在跑 / 排队 / 其他浏览器在场快照）每个条目在标题行下新增运行信息行：环境、代码仓、
    分支、部署策略（执行人、来源在标题行）。排队项入队时快照 `repoName`（`runPipeline`）；跨浏览器在场
    快照 `publishQueue` 的 runs/queue 同步携带 repoName/branch/strategy，远端旧客户端缺字段按 — 占位。
  - 「流水线任务」表的运行徽标经 `renderQueue` 末尾按签名（在跑运行集 + 焦点运行）联动刷新，避免 5 秒
    轮询无谓重建表格打断行点击。
  - `test_pipeline_row_run.js` 补齐新助手/焦点上下文，新增回归测试（行点击聚焦在跑运行不切换选用、
    无运行行仍走选用、多运行取最近启动、「运行中/查看中」徽标）。
- 修复流水线编辑器出现两张任务卡同时显亮（`projects/pipeline/pipeline.html`）：`renderStageEditor`
  原先除选中卡的 `plstage-sel` 高亮外，还按 `editFocusIdx` 给焦点卡内联 accent 边框/阴影，两套通道
  互不知晓——上移/下移/序号/拖拽移动未选中卡，或插入新卡后再点选其他卡，内联样式随 DOM 一直留存到
  下次整表重渲染，页面上便有两张卡同时显亮。现移除内联高亮，`editFocusIdx` 只保留聚焦滚动，高亮
  统一由 `applyEditSel` 按 `editSelStage` 切换 `plstage-sel`，任意时刻仅一张卡显亮。作为配套，
  `openPlForm` 在编排区双击阶段带焦点序号进入编辑器时把焦点阶段置为选中卡（在草稿恢复之后按
  `editFocusIdx` 取引用，恢复会整组替换 `editStages`），进入即见该卡的 `plstage-sel` 高亮与「+」
  插入按钮；另修正同函数注释里 `${RUN_DIR` 缺失 `}` 的笔误（会使按花括号配对提取函数的测试
  工具无法截取 `openPlForm`）。
  `test_stage_insert_select.js` 新增回归测试（重渲染后焦点卡不内联高亮、仅选中卡带 `plstage-sel`；
  进入编辑器焦点阶段即选中卡、新建/焦点越界不选中、草稿恢复后选中引用指向草稿卡）。
- 流水线编辑器任务卡支持「选中插入」（`projects/pipeline/pipeline.html`）：点击任务卡上任意处（含卡内
  输入框/按钮）即选中，选中卡 accent 高亮（`plstage-sel`），上/下边框中点各出现一个圆形「+」按钮
  （`plstage-ins-top/bottom`，仅选中卡挂载），点击分别在其上方/下方插入新阶段，新卡自动选中并聚焦滚动到
  可见（沿用 editFocusIdx 通道）。选中态以对象引用记录（`editSelStage`），拖拽/序号/上下移调序后仍跟随
  同一张卡，删除选中卡时自动清除，打开编辑器重建草稿时重置；选中刷新只原地切换 class 与按钮
  （`applyEditSel`，不重渲染、不打断卡内输入；选中委托先于 data-act 动作委托注册，保证点「+」先完成
  选中幂等判断再执行插入）。`#plStageList` 增加 9px 上下内边距，给半跨边框的「+」按钮留出空间。
  新增 `projects/pipeline/tests/test_stage_insert_select.js`（选中高亮与按钮挂载/移除/幂等、上/下插入
  位置与新卡焦点、越界保护、重渲染后含预设卡恢复选中态）；`test_stage_drag_reorder.js` /
  `test_cleanup_flow.js` 补齐选中态上下文（FakeClassList.toggle、editSelStage、applyEditSel 加载）。

- 修复流水线大量日志 / 长时间任务导致页面与 web 服务卡死（`src/index.ts` +
  `projects/pipeline/pipeline.html`）：
  - `/api/worktable/exec-stream` 原先忽略 `ServerResponse.write()` 背压，浏览器处理稍慢时仍持续读取
    子进程 stdout/stderr，HTTP 待发送缓冲与异步日志写入队列会随输出无界增长。现分别以 1 MiB 为
    HTTP / 磁盘积压水位，任一路达到后都暂停两路子进程输出，响应触发 `drain`、磁盘队列降到低水位后
    再恢复；一次性 `/exec` 的磁盘日志队列也使用同一限制。客户端在背压期间断开时立即废弃 HTTP
    `drain` 条件，待磁盘降到低水位后继续排空已终止进程的管道，确保写入 `[aborted]` 并关闭日志文件。
    阶段超时和进程组终止语义不变。
  - 阶段详情对脚本 / HTTP / EvalTokens 回显统一只渲染末尾 1000 行且最多 256 KiB，省略时提示查看
    运行归档。日志 DOM 改经 `DocumentFragment` 批量挂载；普通 / 预设脚本、HTTP/Jenkins 与
    EvalTokens 共用有界实时快照和 250ms 刷新节流，不再在各路径分别无界拼接。
  - Jenkins 控制台轮询改用 `logText/progressiveText?start=<offset>`，每次只传输服务端新增内容；旧版
    Jenkins 返回 404/405，或直连 CORS 未暴露 `X-Text-Size`（无法可靠取得原始日志 offset）时自动降级到
    `consoleText`。原始控制台分片在实时回显与中止归档中均逐字连续，不额外插入换行；长任务的网络传输
    与临时字符串分配由重复下载全文的平方级增长降为线性增长。
  - 详情内容指纹改在 `buildLog` 前计算：长任务只有进度变化、没有新输出时只更新进度条，不再每
    300ms 拆分完整 stdout；有界尾窗用递增 `_outputRevision` 标记真实更新，避免等长采样指纹碰撞。
    流读取和轮询日志改为分块收集、结束时仅合并一次；阶段完成后的完整 stdout 与输出变量契约保持不变。
  - 任务 / 汇总归档改为原始字符串分片，不再把大日志 `split` 成百万行后再 `join`；新增
    `/api/worktable/write-stream` 原始请求体接口，浏览器用 Blob 分片上传，服务端边读边写临时文件并原子
    替换（上限 256 MiB），避免完成时生成整份行数组和 JSON 转义副本；超限、客户端断开或原子替换失败
    均清理临时文件且不覆盖旧目标。变量 / JSON 提取也改为逐行扫描。
  - HTTP/Jenkins 与 EvalTokens 运行期间把完整原始分片挂到阶段归档状态；用户在异步轮询返回前中止时，
    `abortRun` 也能归档已被 256 KiB 实时尾窗淘汰的早期内容。正常终态合并后释放重复分片引用。
  - 新增慢客户端 8 MiB 输出、背压后断连、慢归档磁盘 4 MiB 输出的背压 / 完整性测试，以及详情窗口、修订缓存、
    预设 / Jenkins / EvalTokens 实时快照、刷新节流、分片归档与流式写入失败清理测试；实测 32 MiB
    输出且客户端暂停读取时，服务端 HTTP 积压由约 30.4 MiB 降至约 1.01 MiB，恢复读取后继续执行并完整落盘。

- 流水线 EvalTokens 阶段任务输入参数支持设置与识别刷新（`projects/pipeline/pipeline.html`）：编辑器参数区由只读改为
  可编辑——识别到的任务原值填入框中（未改动时弱化色展示、不下发），修改后作为显式覆盖存入 `evaltokens.values`
  随流水线持久化（`evaltokensStageConfig` 携带 values；`params` 仍为瞬态，不持久化）；动作行新增「识别参数」按钮
  （清空任务列表 15s 缓存后重新拉取识别），重新识别 / 打开编辑器自动识别均只刷新参数定义与任务原值，已设置的
  参数值保留不刷新；清空或改回与任务原值一致即取消覆盖（恢复不覆盖语义）。换选任务或手改任务 ID 时清空原任务
  已设值。运行时把已设参数值（支持 ${VAR} 引用上游产出，替换为空的不下发）作为 `{input:{...}}` 随 run 启动请求体
  下发（未设置时保持空体 `{}` 不变），并在阶段日志打印实际下发的覆盖。`projects/pipeline/tests/evaltokens-stage.test.mjs`
  新增 6 个用例：values 持久化与 normalizeStageKind 透传、commitEvaltokParamValue 提交规则、参数区可编辑渲染与
  change 写入/删除、「识别参数」按钮强制重识别、重新识别保留已设值（含 keepOnError/任务未命中路径）、run 请求体
  携带 input 覆盖。

- 流水线编辑器 EvalTokens 阶段选中任务后显示任务标题而非任务 ID（`projects/pipeline/pipeline.html`）：
  任务选择输入框 `etTaskId` 的回显值由 `taskId` 改为优先取 `taskName`（无标题时回退 `taskId`），并移除
  原本紧随输入框重复展示标题的 `· taskName` 辅助 span（标题已并入输入框，避免冗余）。底层 `taskId`/
  `taskName` 数据与运行时匹配逻辑不变：选中任务仍回填 `taskId=真实 ID`、`taskName=标题`，运行时按
  `taskId`（优先）或 `taskName` 匹配任务；手动输入仍走 `change` 事件清空 `taskName` 后异步识别参数。
  `./dsh.sh plugins` 重装并 `./dsh.sh restart` 后刷新页面生效。

- 流水线编辑器支持整张任务卡拖拽调序（`projects/pipeline/pipeline.html`）：普通阶段与系统预设阶段均可拖动，
  拖到目标卡上半区 / 下半区时以强调色边线提示插入到目标前 / 后；松开后只更新编辑草稿，继续由原「保存」
  动作统一持久化。原序号输入、上移、下移操作保留，并与拖拽复用同一重排函数。
  新增 `projects/pipeline/tests/test_stage_drag_reorder.js` 覆盖前后移动、插入位置计算、整卡拖放与两类任务卡事件注册。

- pipeline 导入导出支持服务端备份（`src/index.ts` + `projects/pipeline/pipeline.html`）：「⤓⤒ 导入导出」
  菜单新增「服务端备份」区——「导出设置 / 流水线到服务端…」（与浏览器本地下载同一份 payload，POST 落盘）
  与「从服务端导入…」（面板列出服务端备份文件：目录 / 文件名 / 修改时间 / 大小，逐个导入，按文件内容
  kind 自动识别设置 / 流水线，复用与文件导入完全相同的校验、确认与恢复逻辑——importSettingsFile/
  importPipelinesFile 重构出 importSettingsData/importPipelinesData 数据入口，本地文件与服务端共用）。
  服务端新增三条路由：GET `/api/worktable/pipeline/io/list`（按 mtime 倒序、上限 200）、POST
  `/api/worktable/pipeline/io/save`、POST `/api/worktable/pipeline/io/load`；备份文件固定在
  `<DSH_HOME>/storages/pipeline-exports/` 下，文件名白名单校验（禁路径分隔符 / `..` / 前导点、
  必须 `.json` 结尾、≤120 字，客户端 `ioSrvNormalizeName` 与服务端 `pipelineIoName` 同一套规则），
  不提供任意路径读写，写入走 writeJsonAtomic 原子落盘，单文件上限 64MB。新增
  `tests/pipeline-io.test.mjs` 4 个路由测试（往返 / 白名单 / 方法与参数校验 / 排序与过滤）与
  `projects/pipeline/tests/test_config_import_export.js` 6 个客户端契约测试。`lib/index.js`
  （+`.map`）已随本改动重建，`./dsh.sh plugins` 重装并 `./dsh.sh restart` 后刷新页面生效。
- 本地编译安装（link:）时侧栏默认标题显示「工作台（开发中）」（`src/index.ts` + `src/client/index.tsx`
  + `src/client/locales.ts`）：服务端新增 `isLocalDevInstall` 判定——lib/ 目录 realpath 不在标准安装布局
  `<home>/profiles/<profile>/node_modules/<pkg>/lib` 内即为本地编译安装（link:/junction 安装 realpath 落在
  源码树；release tgz 副本安装落在 profile 的 node_modules 内），健康路由 `/api/worktable/health` 新增
  `dev` 字段上报；客户端挂载时随健康路由取一次（与「插件项目目录」共用同一缓存），命中则默认标题
  「工作台」追加 locale 后缀「（开发中）」（新增 zh/en 键 `title.devSuffix`，「工作台」本字未改）；
  用户自定义名不受影响，设置面板改名框仍显示/提交无后缀名（避免失焦提交把后缀固化成自定义名）。
  新增 `tests/dsh-home.test.mjs` 判定测试（release 副本 / 源码树 / link: 符号链接三种形态）。
  `lib/index.js`/`lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh plugins` 重装并 `./dsh.sh restart` 后刷新页面生效。

- pipeline 项目新增设置 / 流水线导入导出（`projects/pipeline/pipeline.html`）：标题区右上角
  「⤓⤒ 导入导出」菜单，设置与流水线分开备份恢复——导出设置=设置页全部配置（服务端部分
  剔除流水线、补回仅存本浏览器的代码仓访问令牌）+ 本地运行选择（当前流水线/环境/代码仓、
  分支/部署策略/执行人、历史筛选与分页），导出流水线=全部流水线定义（含内置流水线上的编辑）；
  导入按文件内容整体恢复（文件为权威，缺省键保持当前值），复用 loadServerState 同一套归一化
  与旧数据迁移，导入后统一落 localStorage 并推服务端持久化；运行历史不参与导入导出。
  导出文件含密码/令牌明文（菜单内已标注勿提交仓库）。新增
  `projects/pipeline/tests/test_config_import_export.js` 7 个契约测试。

- 工作台名称可编辑（`src/client/index.tsx` + `src/client/locales.ts`）：侧栏区块标题「工作台」
  支持自定义——设置面板（视图选项 ⚙）顶部新增「名称」栏，复用项目管理改名的 RenameInput 交互
  （失焦/回车提交），清空即恢复默认「工作台」；自定义名存 `ViewState.title`（localStorage
  `dsh.worktable.view.v1`，本机偏好，不推服务端），侧栏标题按 自定义名 → locale 默认 回退显示。
  `lib/client.js`（+`.map`）已随本改动重建，刷新页面生效。

- 升级命令的 tarball 文件名带版本号（`src/client/index.tsx`）：v1.0.5 发布验证发现 `dsh plugin add`
  按资产文件名缓存 tarball——各版本 URL 路径虽不同，文件名却恒为 `tokens-worktable.tgz`，缓存命中即装回旧版
  （部署机装 v1.0.5 实际装回 v1.0.4）。现改为 `releases/download/<tag>/tokens-worktable-<版本号>.tgz`，
  每次发布文件名唯一，缓存必然失效；release 同时保留不带版本号的 `tokens-worktable.tgz` 兼容旧版客户端的升级命令。
  `lib/client.js`（+`.map`）已随本改动重建。

- 自带项目入口页改名换标：codereview「PR 检视台 · TokensService」🩺 →「代码版本」🪲（图标改用瓢虫，
  与 bug 定位语义一致）、diag_perf「大模型推理性能诊断」→「性能诊断」、pipeline「流水线工作台」→「流水线」
  （仅改各入口页 `<title>` / `<meta worktable-icon>`，新导入的项目按自报名称与图标显示；
  已导入的布局不受影响，需删除后重新导入生效）。

- 项目入口页自报名称与侧栏图标，导入时自动带上（`src/index.ts` + `src/client/index.tsx`）：
  `/api/worktable/scan-projects` 扫描时读入口页文件头 64KB，提取 `<title>`（折叠空白，最长 60 字符）
  与 `<meta name="worktable-icon" content="🚀">`（属性顺序不限，最长 16 字符），随扫描结果带 `title`/`icon` 字段；
  `runImport` 建新布局时采用——名称优先级：删除时转存的用户改名 > 页面 `<title>` > 目录名/文件名，
  图标优先级：删除时转存的用户覆盖 > 页面自声明 > 默认 🧱；已导入/已发布的布局不受影响（认回路径原样继承布局本体）。
  插件自带三个项目导入后即显示真实名称与图标：pipeline「流水线工作台」🚀、
  diag_perf「大模型推理性能诊断」🔍、codereview「PR 检视台 · TokensService」🩺（各自入口页 `<head>` 已声明图标）。
  `lib/index.js`/`lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh restart` 后重新导入项目生效。

- 图标选择器 bug 定位组新增瓢虫 🐞（`src/client/index.tsx`）：EMOJI_SET 由 45 个扩至 46 个，
  布局/快捷方式/入驻项目换图标时可直接选用。
  `lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh restart` 后刷新页面生效。

- 更新提示的升级命令改用带版本号的固定 release URL（`src/client/index.tsx`）：原提示词与更新卡片里的
  升级命令固定为 `releases/latest/download/tokens-worktable.tgz`，该 URL 永不变化，包管理器按 URL
  缓存 tarball，重复执行可能装回旧版（部署机曾因此停在 1.0.0，页面版本号不随发布走）。现改为按
  更新检查拿到的原始 tag 拼 `releases/download/<tag>/tokens-worktable.tgz`（`UpdateInfo` 新增 `tag`
  字段存原始 tag_name），更新卡片展示的命令与「✦ AI 生成」复制的提示词同步使用。
  `lib/client.js`（+`.map`）已随本改动重建，随 v1.0.3 发版部署后生效。

- 「管理项目」设置弹窗加宽 280→400px（`src/client/index.tsx`）：长项目名/路径不再拥挤换行。
- 图标选择器新增 IT 主题 emoji（`src/client/index.tsx`）：EMOJI_SET 由 18 个扩至 45 个，新增
  代码检视（🔍👀🧐✅）、bug 定位（🐛🪲🔎🎯）、流水线（🏭🔗⛓️🔄🔧）、性能诊断（📈📊⏱️🩺🚀）、
  通用研发（🖥️💻⌨️🗄️📡☁️🔒🧰🗂️💾）五组，布局/快捷方式/入驻项目的图标点击可换时直接选用；
  弹层加高后的下缘夹取余量 316→372px，贴底锚点时弹层不再溢出视口。
  `lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh restart` 后刷新页面生效。

- 「从文件夹导入所有项目」认回原有项目并继承其布局名称与 logo（`src/client/index.tsx`）：
  此前导入只按「文件夹映射 + 精确页面路径」去重，路径形式差异（尾斜杠/重复斜杠）、入口文件变化、
  服务端已发布但本地尚未合并、删除后再导入等情形都会失配，被当成新项目重复导入——新布局用
  文件夹名 + 默认 🧱 图标，看起来就是「没有继承原有项目的布局名称与布局的 logo」。现改为：
  - 路径归一加强：`\`→`/`、折叠重复斜杠、去尾斜杠后再比较；新增「托管页面所在目录」键做目录级匹配
    （子目录项目整个目录算一个项目；扫描根下的散装单页仍按精确页面匹配，同根多页互不相挡）。
  - 认回服务端已发布布局：导入时 GET `/api/worktable/projects` 同场匹配，本地尚未合并的远端布局
    命中同目录/同页面时直接并入（原 id/title/icon/窗口内容随布局本体继承），不再新建默认布局。
  - 认回已删除布局：`removeLayout` 删除布局本体时把显示名与图标转存进 nameOverrides/iconOverrides
    （folders 映射原本就留存）；同目录再导入时沿用原布局 id——排序、会话分组、绑定对话、分栏存档、
    布局名称与 logo 一并继承，且修复了「删除布局后同目录永远被跳过、导不回来」的问题。
  - 顺带修复批量导入的布局 id 撞车：`buildLayout` 的 id 只精确到毫秒，同一毫秒内导入的多个布局
    会同 id（渲染/folders 映射错乱）；导入循环内补序号后缀保证互不相同。
  已发布（sync）布局的认回并入走原有服务端同步切片，localStorage 不落 sync 条目。
  `lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh restart` 后刷新页面生效。

- 服务端存储路径与宿主 DSH home 对齐（`src/index.ts`）：原先全部硬编码 `os.homedir() + '/.dsh'`，
  在 home 被重定向的部署（如 DSH_HOME=/mnt/paas）下会写错位置、读不到宿主的 workspace.json。
  新增 DSH_HOME 解析，优先级 = 模块位置推断（标准安装位于 <home>/profiles/<profile>/node_modules/<pkg>/lib，
  宿主从这里加载即证明该 home 活跃；scoped 包多上溯一层 @scope）→ DSH_HOME 环境变量（空白 = 未设，支持 ~ 展开，
  与宿主 @deepseek-ai/dsh-home-paths 同规则）→ 默认 ~/.dsh。worktable-projects/pipeline/plans/logs 四个存储文件、
  workspace.json 只读路由、loadPkg 的 profiles 兜底目录全部改用解析结果；健康路由新增 home 字段便于部署核对。
  需构建插件并重启 web 后生效（原 /root/.dsh/storages 下的存量文件不自动迁移）。

- 「+」添加面板新增「批量导入」：一键导入某个文件夹里的所有项目（`src/index.ts` + `src/client/index.tsx` 配套）：
  - 新增路由 `POST /api/worktable/scan-projects`：扫描所选目录的一层，每个「含 .html 页面」的子目录算一个项目
    （入口择优 index.html → 与目录同名 .html → 字母序首个），目录下散装 .html 算单页项目，隐藏项跳过。
  - 添加面板底部「从文件夹导入所有项目…」：经「选择位置…」弹窗选定文件夹（起始目录默认插件自带 `projects/`，
    路径取自健康路由上报的插件目录），扫描后为每个项目建单窗布局（目录级托管 iframe 页面，项目文件夹 = 子目录）；
    项目文件夹或页面路径已在工作台里的自动跳过，面板内显示「已导入 N 个（跳过 M 个）」。新增 zh/en 词典与路由测试。
    需构建插件并重启 web 后刷新页面生效。

- 节点环境支持「IP:端口」指定 SSH 端口（`projects/pipeline/pipeline.html` + `src/index.ts` / `lib/index.js` 配套）：
  - 设置页「节点环境」IP 输入框可填纯 IP（默认 22 端口）或「IP:端口」（如 `115.33.98.101:2222`）：placeholder/tooltip 更新、
    `saveEnvForm` 增加端口格式校验（单个冒号时其后须为数字端口；多冒号 IPv6 或无冒号原样保留）、IP 表头排序先去掉「:端口」再按段数值排。
    节点 `ip` 字段整体存「host:port」，注入的 `TARGET_IP`/`TARGET_IPS`/`TARGET_HOSTS` 均含端口，由脚本自行解析。
  - 服务端 `queryGpu` 解析「IP:端口」：本机判定与 ssh target 均用 host（不含端口），端口经 `ssh -p <port>` 传入
    （ssh 不支持 `host:port` 形式的 target），设备状态查询因此能连非 22 端口的节点。无端口时行为与原先完全一致。
    需构建插件并重启 web 后刷新页面生效。

- 本地文件读取路由 `/api/worktable/file` 新增可选 `tailBytes` 参数：流水线历史回放只需日志末尾时，
  服务端以有界随机读取返回最多 4 MiB 的文件尾部，并通过响应头返回原文件大小与截尾状态；
  不带参数的资源管理器等旧调用仍保持完整文件响应，超过 256 MiB 的原有保护不变。
- 流水线历史回放改为只加载当前选中阶段日志，切换阶段时再按需请求并缓存；详情框请求日志末尾
  64 KiB、继续只渲染最后 20 行，避免进入一条历史记录时并发全量读取所有阶段日志。
- 页面上送历史及服务端 GET/PUT/定时追加三处统一剔除 `_lc`/`_lm`/`_ll`/`_profChecked`
  回放临时字段，避免读过的日志全文被误写进 `worktable-pipeline.json`、导致状态文件持续膨胀；
  存量缓存会在下次历史写入时自动清除。

- 流水线运行队列跨浏览器可见 + 队列/运行历史手动刷新（`src/index.ts` + `projects/pipeline/pipeline.html` 配套）：
  - 新增路由 `/api/worktable/pipeline/queue`：各 pipeline.html 标签页把自己「正在运行 + 排队中」的快照 PUT 到服务端内存
    `Map`（`{id, label, running, queue, seenAt}`，seenAt 用服务端收到时间防客户端时钟偏差；上限 100 个客户端，超出淘汰最旧
    seenAt；running/queue 条目逐字段白名单清洗，by/pipelineName/env/source 截 200 字符，startedAt/queuedAt 取有限数值），
    页面再轮询 GET 拉取其他标签页的快照（GET 先剔除 45 秒未上报的过期在场，跳过无活动的空闲客户端）。在场信息是易失数据，
    存内存不落盘，重启即清；POST 与 PUT 同逻辑，供页面 pagehide 时 navigator.sendBeacon 清态（beacon 只能 POST）。
  - 页面侧（pipeline.html）：sessionStorage 持久化随机短 id（`pip-qclient`）+ `browserTag()`（userAgent 粗判浏览器拼 id 后 4 位，
    如 `Chrome·a1b2`）；`renderQueue()` 末尾经 500ms 防抖上报本页在场快照（仅签名变化或距上次超 10 秒心跳时真正发请求）；
    每 5 秒轮询拉取其他标签页快照，在本地队列条目之后只读渲染（「— 其他浏览器 —」分隔行 + muted 客户端标签前缀，无取消按钮），
    本地空闲但有远端活动时徽标显示「空闲 · 他端 N 运行」（样式保持灰）；「运行队列」行新增 ↻ 按钮（立即上报+拉取）；
    pagehide 时 sendBeacon 清掉自己的在场信息。
  - 「运行历史」标题行新增「↻ 刷新」按钮：GET `/api/worktable/pipeline` 重新拉取历史（其他浏览器与服务端定时运行产生的记录
    一并合并进来）；buildNo/histClearedAt 取双方较大值回填（防另一浏览器跑过后本地 buildNo 回退重号），历史非空整体替换、
    空但 histClearedAt 非零则置空（语义同 loadServerState）；有选中行时先退出历史回放再清选中（回放基于行下标，列表变了必须退出）。
    需构建插件并重启 web 后刷新页面生效。

- 脚本阶段日志改为执行服务端直接落盘（`src/index.ts` + `projects/pipeline/pipeline.html`）：
  - `/api/worktable/exec-stream` 接受可选 `logFile`，执行前递归创建日志目录，stdout/stderr 按到达顺序实时写入，关闭文件后才发送包含 `logFile` 的 `done`；`log` 事件提前确认日志归属。日志保留命令、原始输出及退出码；中止/断网保留已写内容和 `[aborted]`，超时保留原因。
  - `/api/worktable/exec` 同样支持实时执行端归档（含环境清理），关闭文件后再响应；写文件失败返回 `logError`，不改变脚本退出码，也不重跑脚本。未传 `logFile` 的旧调用保持原协议。响应头先声明日志归属，无法确认归属的断流不触发覆盖上传。
  - 页面使用原有 `run-<tag>-NN-任务名.log` 路径；服务端接管后不再逐阶段发送 `mkdir` / `write`，防止中止时用浏览器局部输出覆盖文件。旧插件正常完成但未返回归档路径、或服务端报告写入失败时，页面仍兜底归档。
  - HTTP / EvalTokens / 模拟阶段及汇总日志、profiling 仍由页面归档；服务端定时计划原有直接归档不变。新增真实 HTTP/子进程测试及页面协议回归测试；需构建插件并重启 web 后刷新页面生效。

- 流水线阶段类型「URL请求」改名「HTTP」并新增「EvalTokens」阶段类型（projects/pipeline/pipeline.html + src/index.ts / lib/index.js 配套）：
  - 「URL请求」阶段类型改名为「HTTP」——`STAGE_KIND_LABEL` 的 `url:'URL请求'` 改为 `http:'HTTP'`，内部 `kind` 值
    `url`→`http`，按现有 `jenkins→url` 迁移风格兼容旧数据：`migrateStageUrl`/`normalizeStageKind` 把旧 `kind:'jenkins'`/`'url'`
    归为 `'http'`；运行期分发（`runStep` advance / `buildLog`）保留对旧 `url`/`jenkins` 的兼容判断；`runUrlStep` 节点显示
    `URL请求 · raw`→`HTTP · raw`、结果标记 `[URL result]`→`[HTTP result]`、设置页 / 编辑器 / 脚本 README 说明文案同步更新。
  - 新增 `EvalTokens` 阶段类型（`kind:'evaltokens'`，`STAGE_KIND_LABEL.evaltokens='EvalTokens'`）：阶段持有
    `evaltokens{taskId,taskName,outVars}`；编辑器动作行提供「任务」输入 +「选择」按钮（拉取 `GET /api/open/v1/tasks`
    内联下拉回填 id/name）+「输出变量」（`mkOutVarHelp('任务字段')`）；运行期 `runEvaltokensStep` 复用「设置」页
    EvalTokens 服务配置（地址 / Bearer 令牌 / 本地直连或服务端 `/api/worktable/proxy` 代连），周期拉取任务列表匹配
    该任务并等待其到终态（`evaltokStatusKind` 按 status 子串归类成功 / 失败 / 运行中），任务对象顶层标量字段按
    KEY=VALUE / 单行 JSON 规则累计为输出变量（`mergeStageVars`/`applyOutVars`，与 HTTP / 脚本阶段一致），并附
    「查看报告」链接；阶段超时 / 中止 / 迟回令牌守卫与 `runUrlStep` 同规则；`buildLog` 增加 EvalTokens 分支展示轮询回显。
  - 服务端定时执行（`execPlan`）跳过条件同步扩展 `kind:'http'`/`'evaltokens'`（兼容旧计划 `url`/`jenkins`）：HTTP /
    EvalTokens 阶段仅前端运行期支持，定时触发暂跳过。`lib/index.js` 已随本改动与 `src/index.ts` 同步手改（条件 + 跳过提示文案）。

- 修复项目创建时「选择位置…」报错 `listDirectory unavailable`（`src/client/index.tsx`）：
  目录选择能力（`listDirectory`/`pickDirectory`/`createDirectory`）在宿主 `uiWorkspace`
  服务（`@deepseek-ai/dsh-client-ui-workspace` 的 `UiWorkspaceService`）上，不在 `ctx.workspaces`
  （`IWorkspaces` 工作区控制器，仅有 `list`/`create`/`archiveSession` 等）；原 `dirPickLoad`/
  `dirPickCreate`/`pickFolder` 误读 `sessionBridge.workspaces` 取这些方法，恒为 `undefined`
  → 能力判定直接失败、弹出「listDirectory unavailable」。现改为经 `applyCtx.get('uiWorkspace')`
  懒取宿主目录能力（与现有 `betterSidebar` 同款惰性查找，不进 `inject`、不阻塞插件激活），
  并在不可用时回退到插件自身路由：`POST /api/worktable/fs`（列目录，仅保留子目录并按路径推面包屑，
  与资源管理器窗同源）+ `POST /api/worktable/mkdir`（建目录）；`createCustomSession` 与
  `createWorkspaceDir` 的建目录同样改为「宿主优先 + 插件兜底」。即：宿主组合了 directory-picker
  （browse/native）时走宿主能力并尊重其作用域，远程无桌面 / 未组合时回退插件自身路由，项目创建
  选目录始终可用。`lib/client.js` 已随本改动重建，`./dsh.sh restart` 后刷新页面生效。

- 流水线历史记录与日志分离存储 + 运行状态机竞态修复（`src/index.ts` + projects/pipeline/pipeline.html 配套）：
  全量日志进历史记录导致 worktable-pipeline.json 单条记录可达数 MB（页面加载全量 GET + 每次保存全量回写，
  页面明显变慢）。现改为：归档文件（run-*.log）仍是全量日志唯一实体、永不截断；历史条目只存元数据 +
  logFile 路径（`collectRunLogs`/`runCleanupBefore`/服务端 `execPlan` 的 `pushHist` 统一），无归档目录时内嵌全文兜底；
  回放历史按需经 `/api/worktable/file` 拉取日志缓存到 `rec._lc`（`loadReplayLogs`，失败下次进入重试）；
  存量内嵌 logs 的记录加载后后台迁移（`migrateInlineLogs`：补齐归档文件——已有同名文件不覆盖——再改存路径，
  完成后自动保存）；AI 分析提示词原本就走 {archive}/{logFile} 文件路径，无需内嵌日志。
  配套修复（页面加载慢的根因之外的同组 bug）：
  - `runUrlStep` 收尾段与 catch 补运行令牌校验（此前中止后迟回的触发/拉控制台结果会把旧阶段变量、
    归档日志、失败状态写进新运行，甚至把新运行判失败）；
  - 全局 `timer` 清理移到令牌校验之后（`runScriptStep`/`runUrlStep` 轮询守卫）：此前旧运行迟回会清新运行
    的 timer，模拟阶段永久挂起；
  - `loadServerState` 拉取失败不再打开写入门（stateLoaded 保持 false，`pushState` 写前重试加载，
    仍失败则放弃保存）：此前服务端暂不可达时任何一次保存都会用本地默认值+空历史覆盖服务端全部数据；
  - 服务端 PUT `/api/worktable/pipeline` 由全量覆盖改为在写互斥锁（`withStoreLock`，与
    `appendPipelineHistory` 串行）内与磁盘合并：页面未知的磁盘记录（页面加载后定时运行产出的）按 tag/ts
    键保留，buildNo/histClearedAt 取双方较大值防回退；「清空」经 config.histClearedAt 表达，
    清空点之前的磁盘记录不因合并复活，且清空后刷新不再复活内置演示数据；页面历史上限 200→500 与服务端对齐；
  - 服务端定时历史记录补 `ts` 字段（参与合并排序与清空判定）；
  - `/api/worktable/file` 读取上限 20MB→256MB（全量归档日志可能超 20MB，回放按需读取不得 413）。
  `lib/index.js` 已随本改动重建，`./dsh.sh restart` 后生效。

- 阶段超时改为「留空=无超时」并修复定时路径超时失效（`src/index.ts` + projects/pipeline/pipeline.html 配套）：
  此前编辑器「超时(分钟)」留空时脚本阶段默认 2 分钟、URL 请求阶段默认 5 分钟，且服务端定时路径
  `runStageScript` 硬编码 `timeout: 120000` 完全无视阶段配置——长任务（如大镜像拉取）到点被杀，
  日志戛然而止且无 stderr 说明，看起来就像「日志被截断」。现统一改为：留空=无超时（不限制执行时长，
  可经「中止」手动停止；填写后仍夹取 1s~1h 上限）：页面 runScriptStep/runUrlStep（Jenkins 轮询 deadline=0
  不启用）与 execScript 默认值、服务端 exec-stream 与一次性 exec 路由（timeoutMs=0 不挂 kill 定时器 /
  execFile timeout:0）、定时路径 runStageScript（execPlan 随计划带入 s.timeout）全部对齐；编辑器输入框
  placeholder 改「不限」、设置页说明同步更新。「环境清理」脚本无编辑器超时字段，保留原 120s 隐式上限
  防挂死阻塞启动；归档脚本调用方显式传的 120s 不变。另：进程因超时（SIGTERM）或输出超 256MB 缓冲
  （ENOBUFS）被杀时，在 stderr 追加原因说明（对齐 exec-stream 的 'exec timed out' 提示），日志里能直接
  看到是被超时终止而非截断。
  `lib/index.js` 已随本改动重建，`./dsh.sh restart` 后生效。

- 流水线日志全量保留、一律不截断（`src/index.ts` + projects/pipeline/pipeline.html 配套）：
  服务端定时路径（`execPlan` 定时计划/定时后缀）此前经 `truncLog` 把每个任务的回显截到 8192 字符后再写归档，
  长输出任务（如镜像拉取进度条）的独立任务日志 run-<tag>-NN-任务名.log 与汇总 run-<tag>.log 都被切断在
  8192 字符 + 「…(截断)」，丢失后续输出与 [exit] 行；页面侧「环境清理」日志（runCleanupBefore）也有同款
  8192 截断且同时喂给归档与历史。现全部移除：独立任务日志 / 汇总 run-<tag>.log / 历史记录均保全量。
  配套防线（保日志不丢）：
  - `runStageScript` 与一次性 `/api/worktable/exec` 的 execFile maxBuffer 4MB → 256MB
    （超限会 ENOBUFS 杀进程丢输出；页面流式 exec-stream 本就无缓冲上限）；
  - `/api/worktable/write` 内容上限 20MB → 256MB（全量归档日志单文件可能超 20MB，不得拒绝写入）；
  - URL 请求阶段响应体超 64K 只截断「展示」，归档改用全量副本 `_archiveStdout`（archiveStageLog 优先使用，
    「从失败阶段重试」复位该副本）；
  - 历史存储 worktable-pipeline.json 20MB 整体超限时，PUT `/api/worktable/pipeline` 与
    `appendPipelineHistory` 改为丢最旧记录直至放得下（此前分别 413 整批拒绝 / 静默丢弃新记录；
    老记录的全量日志仍在归档文件夹，不丢内容）。
  `lib/index.js` 已随本改动重建，`./dsh.sh restart` 后生效。

- 新增「右侧聊天窗 + 自动发送」桥 `window.__dshSendChatInProject(text)`（`src/client/index.tsx`）：
  供 iframe 内容页「一键 AI 生成」类按钮（如 code-review-prs.html 发行说明「✦ AI 生成」）调用。
  与既有 `__dshNewChatSession`（newChatInProject）相同地新建会话、`markPluginSessionOpen` 标记插件
  发起的切换使项目分栏保持打开、会话出现在右侧聊天窗；区别在于提示词经 `promptIntoSession` 直接
  自动发送，不经输入框草稿（`fillSessionDraft`），「一键生成」场景无需用户再点发送。
  分组/目录优先级与 newChatInProject 一致（项目分组 > 指定 cwd > 设置面板默认分组 > 未分组）。
  `lib/client.js` 已随本改动重建，`./dsh.sh restart` 后生效。

- 流水线页脚本参数默认值不再预填/下发（`src/index.ts` + projects/pipeline/pipeline.html 配套）：
  此前识别到的静态 `:-默认值` 会预填进参数输入框并作为显式值随执行注入，压过运行级自动注入的同名变量
  （如脚本 `IMAGE_NAME="${IMAGE_NAME:-myapp}"` 的 `myapp`、`TARGET_IP` 的 `127.0.0.1` 盖掉主控镜像名与节点环境 IP）。
  改为：识别到的默认值（静态/动态 dyn 一律）只在输入框 placeholder 展示，不预填、不随执行下发；
  留空=运行级注入值/上游同名变量兜底，都未注入时由脚本自身 `:-` 展开；填入=显式覆盖，优先级最高。
  服务端定时路径 `runStageScript` 同步改为无显式值即不下发（`hasVal ? values[key] : ''`）。
  存量数据迁移：页面 `loadPipelines` 新增 `migratePrefillDefaults`（复用 `cleanScriptValues`），
  清掉 values 中与识别默认值相同的旧版预填产物；`detectStageParams`/`detectCleanupParams` 重新识别时同样丢弃。
  `lib/index.js` 已随本改动重建，`./dsh.sh restart` 后生效。

- 项目设置弹窗支持按项目自定义「页面修改」提示词（`src/client/index.tsx` + `src/client/locales.ts`
  + `src/client/styles.ts` + `src/index.ts` 配套）：
  「管理项目」行 ⚙ 弹窗在「绑定对话」框后新增「自定义提示词」框（仅该项目有页面文件、✏️ 可用时显示），
  textarea 即输即存（复用 `dsh-wt_pageEditPrompt` 主题变量样式，浅色/深色自适应；弹窗内紧凑变体
  `dsh-wt_bindPrompt`），留空/「清除」即回到设置面板的全局模板；`{page}`/`{name}` 占位符与全局模板同规则。
  存取走 `ProjectsState.prompts`（项目 id → 模板，localStorage 持久化；`startPageEdit` 第四参传入，
  非空覆盖全局模板；删除项目时随 folders 一并清理）。已发布（sync）布局的提示词映射随
  folders/workspaces 同切片走服务端 `/api/worktable/projects` 同步（GET/PUT 均加白名单 `prompts` 字段），
  localStorage 不落 sync 条目。
  `lib/index.js` / `lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh restart` 后生效。

- 定时后缀阶段间变量传递修复（`src/index.ts` + projects/pipeline/pipeline.html 配套）：
  阶段 stdout 的 KEY=VALUE / 单行 JSON / 「输出变量」映射此前只在页面运行期累计进 `curRun.vars`，
  而带「定时」标记的后缀阶段交给服务端 `execPlan` 执行，页面 `registerStageTimers` 登记计划时又不带
  变量快照，导致后缀第一个脚本阶段起就收不到上游产出（如「拉取分支」URL 阶段 `XDS_BRANCH=*` 捕获的
  结果在下游 template.sh 里打印为空）。
  修复：页面登记后缀计划时随计划带 `vars`（`curRun.vars` 快照）；服务端 `execPlan` 引入与页面同规则的
  变量池（`parseStageVars`/`parseStageJson`/`jsonPathGet`/`applyOutVars`），逐脚本阶段捕获 stdout 产出、
  按阶段 `outVars` 映射改名/JSON 路径/全文赋值，`runStageScript` 按「脚本显式参数 > 上游变量 > 运行级默认」
  注入并支持参数值 `${VAR}` 引用替换（`substRunVars`，与页面对齐）；变量池随归档 profile 的 `vars` 合并持久化。
  另修一个随之暴露的隐患：单个环境变量受内核 MAX_ARG_STRLEN（128KiB）限制，超大捕获值（如 2880 个分支的
  完整响应体 ~165KB）会让 spawn/execFile 直接抛 E2BIG——`dropOversizeEnv` 在 `/api/worktable/exec`、
  `/api/worktable/exec-stream`、`runStageScript` 三处统一剔除超限变量并在 stderr/阶段日志补 `[warn]` 告警，
  提示改用「输出变量」JSON 路径截取所需字段。
  `lib/index.js` 已随本改动重建，`./dsh.sh restart` 后生效。

- 定时后缀计划丢失修复（`src/index.ts` + projects/pipeline/pipeline.html 配套）：
  页面 `registerStageTimers` 的后缀计划 id 由稳定值 `stimer-<流水线id>-suffix` 改为带本次运行 tag 的
  逐次唯一值——旧稳定 id 下，重跑同一条流水线会以同 id 替换待执行计划（前一次运行后缀永不执行），
  且服务端 once 计划执行完的 `finally` 按 id 移除会把执行期间新登记的同 id 计划一并误删，
  两种情形都导致该次运行的定时后缀不执行、归档文件夹缺失每任务独立日志（run-<tag>-NN-任务名.log）。
  服务端 `planTick` 移除条件同步收紧为 id+createdAt 双条件（仅移除本次执行的那一份登记），
  旧版页面（稳定 id）重登记的新计划也不再被误删。
  `lib/index.js` 已随本改动重建，`./dsh.sh restart` 后生效。

- 流水线页 Jenkins 阶段改为「URL 请求」阶段（`src/index.ts` 配套）：
  projects/pipeline/pipeline.html 阶段类型 `kind:'jenkins'` 改为 `kind:'url'`（标签「URL请求」），
  去掉「拉取参数」（`detectJenkinsParams` 与 params/values 参数表单），参数改由 URL 的
  `{GIT_BRANCH}` 等 `{变量名}` 占位符传递（运行时用注入的环境变量/上游产出替换，URL 编码后
  对完整地址 GET 触发）；旧数据经 `migrateStageUrl`/`normalizeStageKind` 迁移
  （`jenkins.job`→`url.url`），阶段仍填旧 fullName（非 URL）时按 `buildWithParameters` POST
  兼容触发。`execPlan` 定时执行跳过条件同步扩展 `kind:'url'`（URL 触发仅前端运行期支持，
  兼容旧计划中的 `kind:'jenkins'`）。
  `lib/index.js` 已随本改动重建，`./dsh.sh restart` 后生效。

- 设置面板新增「工作区（默认会话分组）」设置项（`src/client/index.tsx` + `src/client/locales.ts`）：
  视图选项弹层在「排序方式」与「管理项目」之间新增工作区下拉（复用 `dsh-wt_consoleSelect`
  主题变量样式，浅色/深色自适应），列出宿主已配置的工作区供选择，选「未分组」即清除；
  存 `ViewState.workspace`（localStorage 视图态切片，随 persistView 落盘；仅本机偏好，不走服务端同步）。
  生效点：项目未单独设置会话分组时，「页面修改」✏️ / `window.__dshNewChatSession` 桥 /
  AI 日志分析（postMessage）等无显式目录的新建会话统一落进该默认分组
  （`newChatInProject` 内兜底 + `analyzeLogInSession` 显式取用；分组/目录优先级：
  项目分组 > 指定目录 > 默认分组 > 未分组）；带指定目录的会话（归档目录分析、开发会话、
  打开归档目录）保持 cwd 行为不变。所选工作区被删除后按未设置处理
  （`defaultWorkspaceId` 校验存活；下拉显示「已删除」占位项便于改选/清除）。
  `lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh restart` 后生效。

- 定时执行（服务端 runStageScript）脚本参数下发规则与前端新 execScript 对齐（`src/index.ts`）：
  流水线页参数识别改版后（静态 `:-默认值` 预填为显式值并照常下发，动态默认值——含 `$引用`/`$(命令)` 的
  脚本表达式，标 `dyn`——不下发字面值、留空由脚本自身 `:-` 展开），服务端定时路径同步改为
  `p.dyn ? '' : p.def || ''`，避免动态表达式被当字面值注入（shell 不会二次展开），
  也不再挡住同名的运行级注入（TARGET_IP/TARGET_USER 等）。
  `lib/index.js` 已随本改动重建，`./dsh.sh restart` 后生效。

- 修复会话窗关闭（内容全宽）时标题栏 💬/✕ 与其他插件按钮重叠（`src/client/split.tsx`）：
  会话窗打开时标题栏右端到聊天列左缘即止，不存在冲突；关闭会话窗后标题栏横跨整页，
  💬/✕ 落在页面右上角，与其他插件注入在该区域的按钮重叠。
  修复：`chatClosed` 时标题栏 `paddingRight` 预留 `BAR_RIGHT_RESERVE = 160`px 空区
  （常量，宽不够可调），💬/✕ 随之左移；栏体背景与底边仍横跨整页，视觉不断裂。
  `lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh restart` 后生效。

- 聊天图标颜色再调为主题次级灰（`src/client/styles.ts`）：
  主题强调色（亮蓝）实机仍显突兀；改为 `var(--dsw-alias-label-secondary, #9aa4b2)`——
  与绑定按钮常态、⇄/✕ 按钮同色系，最克制耐看；hover 恢复主色（`--dsw-alias-label-primary`），
  关窗态仍降透明度 + `grayscale` 置灰。分栏标题栏 💬 与项目行 💬 一并替换。
  `lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh restart` 后生效。

- 聊天图标颜色由饱和绿 `#3fb950` 改为主题强调色（`src/client/styles.ts`）：
  `#3fb950` 在整体灰蓝色调中突兀；改用 `var(--dsw-alias-state-accent-primary, #4f8ef7)`——
  项目卡片选中描边 / 激活态同款主题变量，浅色/深色主题自适应，与整套 dshell 视觉同源；
  分栏标题栏 💬 开关与项目行 💬 按钮一并替换，关窗态仍随 `grayscale` 置灰。
  `lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh restart` 后生效。

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
  （`src/client/index.tsx` + `projects/pipeline/pipeline.html`）：
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
  （`src/client/index.tsx` + `projects/pipeline/pipeline.html`）：
  新增 `window.__dshOpenFolderInSidebar(path)` 桥（暴露给 iframe 项目页），调用 better-sidebar 服务的
  `openTab({ type:'editor', path, meta:{ dir:true } })` 开一个以归档目录为根的文件夹窗口
  （同 better-sidebar agent-opens 推送的 folder 分支；path 相同按 dedupeKey 复用同一标签，
  内容型打开自动展开所在面板）；未装 better-sidebar 或打开抛错时返回 false，
  页面回退到原服务端系统文件管理器（xdg-open/gio/open）路径。
  顺带修复：运行启动即预建归档文件夹（`ensureArchiveFolder`，此前要等首个任务日志落盘才建目录，
  运行初期点按钮报「✗ 目录不存在」）；系统文件管理器助手脚本在目标目录不存在时回退打开其父目录
  （归档根）并回显实际打开目录，连归档根都不存在才报错。
- 流水线运行历史「AI 日志分析 / Profiling 分析 / 性能诊断」改为填草稿不提交、工作目录跟随归档目录
  （`src/client/index.tsx` + `projects/pipeline/pipeline.html`）：
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
- 修复流水线环境变量未正确传入任务脚本（`src/index.ts` `runStageScript` + `projects/pipeline/pipeline.html` `execScript`）：
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
- 「流水线」页面侧配套（`projects/pipeline/pipeline.html`）：
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
- 「流水线」工作台阶段支持四种任务类型（`projects/pipeline/pipeline.html`）：
  模拟 / Shell（绑 `.sh`）/ Python（绑 `.py`）/ Jenkins（绑 Jenkins 任务）。
  阶段编辑器加「类型」分段选择，按类型渲染绑定行；Shell/Python 复用 scripts 列表（现收 `.sh`+`.py`）与参数识别
  （Python 识别 `sys.argv[N]` 与 `os.environ/os.getenv`）；Jenkins 选任务（设置页「获取任务列表」填充 `jenkinsJobsList`）
  并拉取作业 `parameterDefinitions` 填参数表单。运行期 `advance` 按 `kind` 分发：Shell/Python 走 `/api/worktable/exec`，
  Jenkins 经 `buildWithParameters` 触发并轮询 `nextBuildNumber`→`building/result`→`consoleText`（本地直连 / 远程走 `/api/worktable/proxy`）。
  阶段模型加 `kind`/`script.lang`/`jenkins` 字段，旧数据（仅有 `script`）经 `normalizeStageKind` 兼容推断为 `shell`。
- `lib/index.js`（+ `.map`）已随上述新增重建并同步进源码与 web profile 安装副本。
- 周期性定时计划支持「开始时间」（`projects/pipeline/pipeline.html` + `src/index.ts`）：
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
- 周期性定时计划支持多周期单位（`projects/pipeline/pipeline.html` + `src/index.ts`）：
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
- 「流水线」阶段「审批门」改为「是否执行」选择（`projects/pipeline/pipeline.html` + `src/index.ts`）：
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
- 「页面修改」入口迁入插件设置弹窗（`src/client/index.tsx` + `locales.ts` + `styles.ts`，配套 `projects/pipeline/pipeline.html` 移除页内旧入口）：
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
