# 本目录 tokens-worktable 的本地改动

- 内置流水线（`pl-xds`「安装部署XDS」）视同可信：仅 admin 可编辑，其他人只读（仍可运行），删除全员禁止
  （`projects/pipeline/pipeline.html` + `src/index.ts`）。页面侧 `plEditable` 把 `builtIn` 并入 trusted
  分支（token 模式维持全权退化、探测在途保守只读）；admin 打开内置为「编辑流水线（内置·可信）」，非 admin
  为「查看流水线（内置·可信·只读）」，行内「内置」徽章旁补「可信」徽章，流程节点 title 同步；
  `deletePipeline` 内置分支前置为全员拦截（含 admin——内置是种子模板不允许删除），行内删除按钮对内置
  不渲染；`savePlForm` 内置硬拦截改为仅拦非 admin；「标记可信」菜单项对内置保持隐藏（内置天然可信无需
  切换）；复制内置仍产出 `builtIn=false` 普通副本。服务端 `trustedPipelineWriteDeny` 新增
  `BUILTIN_PIPELINE_ID='pl-xds'` 与 `isBuiltinPipelineEntry`（`builtIn===true` 或 id 命中即内置）：
  非 admin 改动/删除内置条目、翻转其 builtIn/trusted 标志、新建 `builtIn:true` 或 `id:'pl-xds'` 条目
  一律 403（`favoriteUsers` 豁免不变），防止伪造内置条目混入或抢先占位；种子合并「服务端内置条目优先于
  硬编码种子」路径验证无绕过，admin 编辑保存后各端重载即拿到编辑版。测试：页面侧
  `test_pipeline_trusted.js` / `test_pipeline_readonly.js` / `test_pipeline_owner_edit.js` 断言更新为
  新语义并新增内置矩阵 8 例，服务端 `tests/pipeline-trust.test.mjs` 扩至 16 例。

- 流水线新增「可信」标记：admin 可标记/取消可信，非 admin 对可信流水线只读（`projects/pipeline/pipeline.html`
  + `src/index.ts`）。流水线条目新增 `trusted` 字段（存 `worktable-pipeline.json`，三方合并原样透传）；
  页面侧：行内「⋯」菜单新增「标记可信 / 取消可信」项（`#plRowMenuTrusted`，仅 password 模式取得登录用户、
  `currentUserIsAdmin` 且非内置流水线时显示，token 模式不显示），切换经 `savePipelines({immediate:true})`
  即时落盘并 toast 反馈；可信流水线行名旁与编辑器标题加「可信」徽章，`plEditable` 对非 admin 判只读
  （级联查看按钮/编辑器只读/删除与流程拖拽禁用），admin 可编辑任意可信流水线（优先于「仅创建者可编辑」），
  运行不受限，复制出的副本自动清除 `trusted`；token 共享模式维持全权退化（trusted 不限制编辑）。
  服务端侧：`PUT /api/worktable/pipeline` 与 `/pipeline/save-one` 在三方合并之后、写盘之前强制校验
  （`resolveRequestAuth` / `trustedPipelineWriteDeny` 等，经 cordis `auth` 服务（dsh-auth-gate 提供）
  以 `dsh_auth` Cookie 或 Bearer 解析会话，每请求新鲜读 `$DSH_HOME/auth/users.yaml` 判 `role==='admin'`）：
  非 admin 改动/删除 trusted 条目或打标/摘标/新建 trusted 一律 403 `{error,message,pipelineIds}`
  （`favoriteUsers` 按用户收藏豁免；auth 服务缺失的 token 模式不校验，与页面退化语义一致）；页面保存链路
  （`pushState`/`pushPipelineOne`）捕获 403  toast 服务端 message 并重新拉取服务端状态同步（不再回退
  重试）。新增 `tests/pipeline-trust.test.mjs`（10 例）与
  `projects/pipeline/tests/test_pipeline_trusted.js`（20 例）。

- 流水线任务列表行内「⋯」更多菜单新增「运行历史」项（`projects/pipeline/pipeline.html`）：菜单项
  `#plRowMenuHistory` 为列表行形态，与置顶/收藏同款，title 随展开行动态标注目标流水线名；点击后
  按该流水线名精确过滤运行历史——`histFilter.pipeline` 取流水线名，同时清空关键字/状态筛选并回显
  `#histFilterKw`/`#histFilterStatus`，页码归首页，滚动到运行历史卡片（卡片新增 `id="histCard"`，
  smooth 滚动），并触发一次 `refreshHistoryFromServer(false)` 服务端拉取（在途去重），让他端/定时
  运行产生的记录即刻可见。实现为新增顶层函数 `showPipelineHistory(id)`；`openPlRowMenu` 元素查找
  /guard 同步纳入新菜单项；尾部绑定与置顶/收藏同款（先收起菜单再执行，复用 `plMenuOpenId`）。新增
  `projects/pipeline/tests/test_pipeline_row_history.js` 覆盖菜单项与卡片 id 静态断言、点击后筛选
  状态/输入框回显/渲染与拉取调用/滚动/菜单收起、既有筛选被清空、无效 id 无操作、菜单项 title
  动态设置。

- 运行历史「流水线」筛选改为可搜索过滤（`projects/pipeline/pipeline.html`）：原普通下拉
  `<select>` 换成「输入框 + 候选面板」组合（`#histFilterPipeline` 输入框 + `#histPipelinePanel`，
  容器 `#histPipelinePick`，交互与样式沿用分支/部署策略搜索面板）：聚焦或按方向键弹出全量候选，
  输入即时按名称子串过滤（大小写不敏感），点选 / Enter（含无高亮时提交与输入完全一致的候选）
  选中后仍按精确流水线名过滤历史（`filteredHistory` 匹配逻辑不变），方向键移动高亮、Esc / 点外
  关闭并回显已提交值，清空输入即时恢复「全部流水线」。候选名单继续从 history + pipelines 动态
  汇总去重并保留签名缓存（`_histFilterPipelineSig`，名单缓存进 `_histPipelineNames`）；输入框
  聚焦时 `renderHistFilterOptions` 不回写值，避免 3 秒自动刷新打断搜索输入；筛选名不在候选名单
  时输入框置空但不改写状态（沿用旧下拉语义）。持久化结构 `pip-histFilter` 不变，初始化、
  「清除筛选」与服务端/本地存储恢复路径均直接回显新控件。新增
  `projects/pipeline/tests/test_history_pipeline_search.js` 覆盖候选汇总与签名缓存、输入过滤、
  精确选中 / 清空 / Esc 回显 / 键盘导航、清除筛选与存储恢复回显。
- 运行历史表格去掉「环境」「Commit」两列展示（`projects/pipeline/pipeline.html`）：表头删去两列
  （10 列 → 8 列），`renderHistory` 行渲染同步删去对应 `<td>`、空态行 `colspan` 10 → 8；关键字
  筛选输入框占位文案改为「搜索 #/流水线/执行人」，`filteredHistory` 关键字 haystack 移除
  `h.env`/`h.commit` 两项。仅收窄展示与关键字匹配，数据模型不变：运行记录仍照常保存 `env`/`commit`，
  回放（`enterHistoryReplay`）、「↻ 重跑」按环境重跑、分析提示词 `{env}`/`{commit}` 占位符与运行
  详情/回放区展示均不受影响。新增 `projects/pipeline/tests/test_history_table_columns.js` 覆盖表头
  列数与文案、行渲染单元格数、空态 colspan 与关键字匹配行为。

- 流水线仅限创建者编辑/删除，他人只读可复制副本（`projects/pipeline/pipeline.html`）：为防止多人
  编辑同一条流水线的竞争，新增 `plEditable(p)` 归属判断，编辑器打开（`openPlForm` 只读置位与标题
  标注「创建者 @xx·只读」）、保存兜底（`savePlForm`）、删除（`deletePipeline`）、任务列表行按钮
  （`renderPipelines`：他人流水线显示「查看」并带创建者提示、不渲染「删除」；「复制」对所有行可用）、
  主视图拖拽改序（`flowDraggable`/`persistFlowOrder`）与节点 title 均按此分流。行为矩阵：本人创建
  →可编辑/可删除；他人创建→只读查看、可「复制」为自己的副本；未署名存量→全员可编辑、保存时按既有
  逻辑补署创建者；auth 探测在途（新增 `authReady` 标志）对署名流水线保守只读，探测结束仍无登录用户
  （token 共享模式/未装认证插件/探测失败）退化为全权；admin 无例外。`fillExecutorFromAuth` 无论成功/
  失败/提前返回都在 finally 置位 `authReady` 并无条件重绘任务列表（原先仅「我的/仅看收藏」筛选时重绘，
  行按钮文案依赖身份，探测到达后必须刷新）。新增 `projects/pipeline/tests/test_pipeline_owner_edit.js`
  覆盖 `plEditable` 全分支、`openPlForm` 只读/可编辑行为、`savePlForm`/`deletePipeline` 拦截与
  `authReady` 置位重绘；受影响既有测试补 `plEditable` 等价旧行为桩（`test_pipeline_readonly.js`、
  `test_pipeline_audit_trail.js`、`test_pipeline_save_consistency.js`、`test_parallel_stage_ui.js`、
  `test_pipeline_queue_counts.js`、`test_pipeline_row_run.js`、`test_pipeline_favorites.js`、
  `test_pipeline_pin.js`、`test_pipeline_pagination.js`、`test_stage_insert_select.js`、`test_cleanup_flow.js`）。

- 流水线编辑器保存改为只上传当前流水线（`projects/pipeline/pipeline.html`、`src/index.ts`）：
  在上一轮负载瘦身（baseConfig 仅 pipelines + 历史按签名按需携带，常规保存 70KB→17KB、慢链路
  ~19s→~4s）的基础上更进一步——新增服务端单条保存路由 `PUT /api/worktable/pipeline/save-one`，
  负载只有当前编辑的流水线 + 该条基线 + scriptsDir（约 1-2KB），慢上行链路保存进入秒级以内；
  同时编辑器保存不再把 Jenkins/EvalTokens/普罗/环境等其他配置字段卷入 last-wins 覆盖（此前整表
  PUT 会用本页旧快照覆盖他端对这些字段的并发修改）。服务端 `mergePipelineOneForWrite` 按 id 做
  三方合并：磁盘上的该条仍等于客户端基线才原位替换（新建追加末尾），他端已修改/删除同一条即
  409 冲突，页面走既有回滚与提示路径；路由不触碰历史与其他配置字段（磁盘历史原样保留）。
  客户端 `pushPipelineOne` 与 pushState 共用 persistInFlight 串行锁（基线快照等锁到手后再取），
  响应沿用 reconcilePipelinesAfterSave 把他端新增合回本页；旧服务端无此路由（404）时自动回退
  瘦身全量保存，新旧页面/服务端任意组合兼容。测试：`tests/pipeline-config-concurrency.test.mjs`
  新增单条合并四组回归（原位替换/追加/修改与删除冲突/路由不碰历史），
  `projects/pipeline/tests/test_pipeline_save_consistency.js` 新增 pushPipelineOne 负载形状、
  404 回退、409 形状、他端新增合入与缺条不发请求五组页面回归。

- 修复流水线编辑器「保存」长时间停留在「保存中…」（公网映射等慢上行链路下 10 秒级）的问题
  （`projects/pipeline/pipeline.html`）：显式保存须等服务端确认（并发三方合并，见既有
  test_pipeline_save_consistency.js），但确认请求此前携带全量负载——完整 config + 完整 baseConfig
  副本 + 全部运行历史（实测约 70KB），「保存中…」时长与上行字节数成正比（实测 70KB/7KB/s ≈ 10s），
  且同页 persistInFlight 串行锁会让保存排在前台任何一次全量后台同步之后，慢链路上用户易误判
  卡死而刷新页面。现对全部保存负载统一瘦身：baseConfig 只带 pipelines（服务端
  mergePipelineConfigForWrite 本就只按流水线 id 比对基线条目，其余基线字段从不读取）；历史正文
  改为按内容签名（双哈希）按需携带——首次加载/定时刷新以服务端内容整体替换本地历史时标记已同步，
  签名未变的保存一律不带历史（服务端 mergePipelineHistoryForWrite 对客户端未上报的记录按磁盘
  保留，不丢定时/他端/本页运行历史，该行为新增 tests/pipeline-config-concurrency.test.mjs 回归锁定），
  本地新增运行/清空/迁移改动签名后自动恢复携带。常规保存负载约减至 1/4（70KB→17KB），同一慢链路
  实测保存由 ~10s 降至 ~2.8s。另有两项韧性加固：保存超过 4 秒在编辑器底栏提示「网络较慢，仍在
  保存，请勿刷新或关闭页面…」（结束自动清除）；PUT 新增 60 秒看门狗，链路黑洞（连接在但无响应）
  时中止请求并返回明确错误，防止一次卡死的 PUT 长期占用 persistInFlight 串行锁、后续保存全部
  排队假死（合并写幂等，中止后重发安全）。服务端 src/index.ts 零改动，新旧页面/服务端任意组合兼容。
- 新增「用户使用统计」（`src/index.ts`、`src/client/index.tsx`、`src/client/locales.ts`、`src/client/styles.ts`）：
  服务端新增 `/api/worktable/usage` 路由（exact）——POST 采集事件（`sanitizeUsageEvent`：body 必须对象、
  kind 限 `/^[a-z][a-z0-9_-]{0,31}$/`、user 截 64 字符（空串=匿名）/detail 截 200 字符、at 恒取服务端时间；
  content-length 超 16KB 判 413），事件以 JSONL 追加落盘 `$DSH_HOME/storages/worktable-usage.jsonl`
  （`usageWriteChain` 串行写链防并发互踩；文件超 4MB 时保留尾部约 2MB 的完整行经 writeJsonAtomic 同款
  临时文件+rename 原子重写；写失败仅 logger.warn，绝不影响请求，POST 不等落盘即回 `{ok:true}`）；
  GET 全量读取（ENOENT=空）经 `parseUsageEvents`（坏行跳过）+ `aggregateUsageEvents`（乱序输入也可正确
  聚合）返回 `{total, users, daily, recent}`——users 含 visits/opens/活跃天数/首末时间（events 降序、
  并列 lastAt 降序），daily 为最近 30 个本地日历日（升序补零、users 当日去重），recent 为最新 30 条。
  客户端新增模块级 `reportUsage`（kind:detail 键 10 秒去重、超 200 项清空、全程静默）：用户名探测
  effect 成功后写入 `usageUsername` 并上报 visit（空用户名也报，服务端记匿名），`reportUsed`
  （卡片点击/打开项目统一入口）开头上报 open。设置弹窗版本行「更新历史」旁新增「使用统计」按钮，
  弹窗（复用 dsh-wt_hist 骨架，新增 `dsh-wt_usage*` 样式）展示摘要 chips（用户/总事件/今日事件）、
  用户表格（用户/访问/打开项目/总事件/活跃天数/最近活跃）与最近事件列表（kind 经 `usage.kind.<kind>`
  翻译、未知 kind 显示原文，空 user 显示「匿名」）；加载中/失败/空三态文案与更新历史弹窗同款，
  每次打开都重新拉取（仅防重入）。新增 `tests/usage-stats.test.mjs`：抽取测服务端
  sanitizeUsageEvent/parseUsageEvents/aggregateUsageEvents（含截断、坏行、30 日桶、recent 上限与排序、
  空输入）与客户端 parseUsageStats（正常解析 + 异常回退空结构）。
  `lib/index.js`/`lib/client.js`（+`.map`）已随本改动重建，`./dsh.sh plugins` 重装并 `./dsh.sh restart` 后刷新页面生效。

- 修复并行组内 EvalTokens 阶段被兄弟阶段失败连带中止时误停外部 run 的问题
  （`projects/pipeline/pipeline.html`、`src/index.ts`）：并行组 fail-fast 级联（某阶段失败 →
  `cancelParallelGroup` 中止兄弟阶段）此前与用户主动中止走同一出口，兄弟阶段的收尾逻辑看到
  「已中止 + run 在跑」即调用 `POST /api/v1/tasks/runs/<run_id>/stop`，导致一个阶段的启动请求
  抖动失败（如服务高负载下启动响应超过浏览器侧等待）把组内其余已启动的 EvalTokens 任务全部停掉。
  现区分中止来源：浏览器侧级联中止由 `cancelParallelStage` 给子上下文打 `_cascadeAbort` 标记，
  阶段 finally 见到标记即保留外部 run（阶段日志注明「未停止，仍在服务侧运行」并附报告链接）；
  服务端侧按中止原因码区分——执行池取消（用户中止/计划终止）带 `PIPELINE_RUN_CANCELLED` 码照常
  stop，兄弟失败的裸 abort 不再 stop。用户主动中止、重置与阶段超时停止外部 run 的行为不变。
  `projects/pipeline/tests/evaltokens-stage.test.mjs` 新增级联/用户中止两组页面回归，
  `tests/pipeline-run-api.test.mjs` 新增服务端级联回归并把两处取消用例的 abort 原因对齐执行池实现。
  注：Jenkins（HTTP）阶段的级联中止仍有同形问题，本次未改动。

- 修复 PR 检视台「构建历史 / 分支级构建设置」云端存储目录硬编码为 `/mnt/paas/storages` 的问题
  （`projects/codereview/code-review-prs.html`）：该路径只是旧部署的 DSH_HOME 值，DSH_HOME 不在
  /mnt/paas 的部署会把构建历史写到宿主数据目录之外，升级/迁移部署后如同丢失。现改为经
  `/api/worktable/health` 的 `home` 动态解析为 `$DSH_HOME/storages`（health 未到达前沿用旧路径兜底）；
  解析出的新目录与旧目录不同时，对两平台的构建历史与分支级构建设置共 4 个文件做一次性复制迁移
  （新目录已有不覆盖、旧文件保留不删）。所有云端读写入口先等目录解析（含迁移）完成，避免按旧目录
  读出空历史后误把本机 localStorage 迁移覆盖到新目录。新增 `tests/codereview-relstore-dir.test.mjs`
  覆盖目录解析、尾斜杠/空 home、选择性迁移、health 不可达兜底与目录未变化不迁移。

- 流水线运行编号计数器改从 0 起（`projects/pipeline/pipeline.html`）：此前 `buildNo` 初始化为 47
  （让开 4 条内置演示数据的 #43–46），首个真实运行即 #48，运行历史看起来像丢了 #1–47；演示数据本就不
  推送服务端、不占服务端编号空间，初始化为 0 后真实历史从 #1 开始。服务端已有更高编号时
  loadServerState/历史刷新仍按双方较大值回填，不会重号。新增
  `projects/pipeline/tests/test_buildno_init.js` 回归（buildNo 初值为 0、演示数据带 demo 标记且持久化剔除）。

- 修复终止流水线时只中止页面/服务端编排、未停止外部任务的问题（`projects/pipeline/pipeline.html`、
  `src/index.ts`）：Jenkins 触发后保存 queue `Location` 与最终构建号，终止时对排队项调用
  `POST /queue/cancelItem`、对已运行构建调用 `POST <build>/stop`，并为终止 POST 独立获取 crumb；
  EvalTokens 启动后保存 `run_id`，终止时调用 `POST /api/v1/tasks/runs/<run_id>/stop`。浏览器本地执行与
  服务端权威队列执行均覆盖；浏览器 Jenkins 也改为只按本次响应的 queue item 取得构建号，不再用
  `nextBuildNumber`/`lastBuild` 猜测，避免并发触发时误停他人构建。启动请求与流水线中止/阶段 deadline
  解耦出 10 秒清理宽限（crumb 等触发前准备仍立即中止，防止终止后才新建任务），避免标识响应迟回而
  遗留任务；Jenkins 整条终止链与 EvalTokens stop 各设 10 秒上限，失败会进入阶段日志并在
  页面提示。两种 Jenkins CORS 桥接配置显式暴露 `Location`/渐进日志响应头。新增 Jenkins 排队/运行取消、
  EvalTokens run 停止、启动响应竞态及页面协议回归测试。

- 流水线任务列表新增分页（`projects/pipeline/pipeline.html`）：分页栏提供与运行历史相同的
  `10 / 20 / 50 / 100` 条规格，但使用独立的页码、页大小和 `pip-plPageSize` 本地存储键，互不联动；
  关键字、创建者或收藏筛选变化及清除筛选时自动回到第一页，流水线刷新、新增或删除导致总页数减少时
  自动修正越界页码；从顶部下拉框选用、新建或复制页外流水线时，若目标仍命中当前筛选则自动翻到目标页，
  保持列表“当前”行与下拉选择同步。新增 `projects/pipeline/tests/test_pipeline_pagination.js` 覆盖规格、初始化恢复、
  切片、前后翻页、页大小独立保存、越界修正及页外选中，并扩充 `test_pipeline_favorites.js` 覆盖筛选后回首页。

- 「定时」页计划列表新增当前执行的终止能力（`projects/pipeline/pipeline.html`）：计划触发后在服务端执行池
  运行/排队的任务，此前只能去「运行队列」里找条目中止，定时页只有「取消」（仅删除计划、不动当前执行），
  且计划执行人署名带「 ⏰」后缀使按署名精确匹配的控制权判定永远失败，非管理员连自己的定时运行也无法中止。
  现计划行在当前执行存在时显示「运行中/排队中」徽标与「终止」按钮：确认后经既有
  `POST /api/worktable/pipeline/queue`（action=cancel）走服务端执行池取消——排队项直接移除、运行中
  AbortController 中止并杀掉脚本进程树，本次运行按「终止」计入历史；周期计划本身保留、下个周期仍触发
  （不再触发用「取消」删除计划）。新增 `planOwnerBy`：权限比对前剥掉 by 的「 ⏰」来源标记，非管理员可
  终止自己署名的定时运行、管理员全权（与运行队列同一 `canControlRun` 语义）。「取消」在计划有活动执行时
  增加确认提示（仅删计划、保留当前执行）；进入「定时」页改为重新拉取计划列表（`loadPlans`），其他浏览器的
  增删一并刷新；活动执行集合随 1s 队列快照轮询按签名变化才重绘，无变化不重建 DOM。新增
  `projects/pipeline/tests/test_plan_terminate.js` 覆盖徽标/按钮渲染、终止调用、权限边界（本人/他人/管理员）、
  取消确认与快照变化重绘；`test_queue_item_preview.js` 的 pullRemoteQueue 用例同步补新依赖桩。

- 修复流水线运行提交与多浏览器保存的一致性问题（`projects/pipeline/pipeline.html`、`src/index.ts`）：全部阶段可由
  服务端执行的流水线此前点击运行后，要等 POST 返回并拉到权威队列快照才切换编排区，网络请求、服务端两槽
  执行池/同节点串行和轮询等待期间看起来像“没有开始”；现点击后立即按本次参数展示「提交中…」只读预览，
  服务端 `runId` 出现后无缝切到排队/运行详情，失败或 15 秒未出现时清理预览。流水线编辑器此前点击保存只写
  本地并安排 400ms 异步 PUT，弹窗和草稿立即关闭，写入失败无提示；紧接着运行会让服务端按旧配置执行，旧标签页
  还可用整份配置覆盖新标签页。现显式保存立即等待服务端确认，确认前保留弹窗/草稿并禁用按钮，失败回滚本页
  状态且提示；确认在途冻结整个编辑器，初始服务端配置未加载时禁止进入编辑；同页 PUT 串行，失败只回滚本次
  流水线、保留等待期间合入的其他定义。客户端随 PUT 携带最近服务端基线，服务端
  在存储锁内按流水线 id 三方合并：不同流水线的并发修改同时保留，同一流水线被双方修改则返回 409 冲突、拒绝
  静默覆盖；升级前仍打开且未携带基线的旧页面只允许流水线定义未变化的写入，不能绕过冲突保护；合并结果同步
  回当前页，避免下一次保存误删他端新增项。新增
  `projects/pipeline/tests/test_pipeline_save_consistency.js`、`tests/pipeline-config-concurrency.test.mjs`，并扩充
  `test_run_autofocus.js`、`test_pipeline_readonly.js`。
- 「代码同步」项目页（`projects/code_trans/`，窗口1：两个代码仓 PR 双向同步）入库，PR 选择支持按目标分支筛选：
  源仓 PR 列表上方的「合入分支」chips 按各 PR 的 `targetBranch` 多选过滤（chips 带各分支 PR 计数与「全部 (N)」，
  默认不过滤；加载 PR / 切换同步方向后自动重置，已加载列表为空时整行隐藏），「全选」仅选中当前筛选结果，
  「使用说明」同步补充筛选说明。配套服务端脚本一并入库：`pr-fetch.py`（GitHub / GitLab / Gitee 仓信息与
  PR 列表抓取，归一化 `sourceBranch` / `targetBranch` 等字段，经 `/api/worktable/exec` 调用规避 CORS 与令牌暴露）、
  `pr-sync.py`（克隆目标仓 → 抓取源 PR 提交 → cherry-pick → push → 调 API 建 PR/MR，`@@PRSYNC@@` 事件流回显页面日志）。

- 修复未选择部署策略时 `DEPLOY_STRATEGY` 被当作「已解析的空值」参与替换的问题（`projects/pipeline/pipeline.html`）：
  `substRunVars` 取值池此前用 `rc.strategy!==undefined` 注入 `DEPLOY_STRATEGY`，而运行上下文一律把未选择的策略
  兜底为空串，条件恒真——未选策略（「（不使用）」）时 `${DEPLOY_STRATEGY}` 静默解析为空，普罗命名空间模板
  `${DEPLOY_STRATEGY}-${BY}` 随之解析成 `-<执行人>` 残段并当作有效值注入采集脚本（`NAMESPACE`/`XDS_NAMESPACE`，
  任务级采集与手动补采同源），与文档约定的「解析不出则不注入」及阶段 env、HTTP 阶段取值池、服务端
  `runStageScript` 等其余注入点的 truthy 语义不一致。现改为 truthy 检查：未选策略时 `${DEPLOY_STRATEGY}`
  保持未解析（复合引用占位符原样保留；整值单个引用按空值=继承上游/运行级同名变量），上游阶段 stdout
  产出的同名变量仍优先。同时新增 `substPromTemplate` 兜底：普罗 model/namespace 模板替换后仍残留未解析
  `${...}` 占位（未选策略、无执行人等）即按解析不出处理、不注入；`promSnapshotForRun`/`taskPromCollect`
  与服务端 `buildServerTaskPromEnv`（`src/index.ts`，定时计划/API 运行的任务级采集此前会注入字面
  `${DEPLOY_STRATEGY}-<执行人>` 残段）统一接入。新增 `projects/pipeline/tests/test_deploy_strategy_vars.js`，
  `tests/pipeline-run-api.test.mjs` 增补服务端采集环境用例，`test_cleanup_flow.js` 采集桩同步补
  `substPromTemplate`；`lib/index.js`（+ `.map`）已随本修复重建。

- 流水线任务列表的「▶」运行改为先确认本次运行参数（`projects/pipeline/pipeline.html`）：点击后不再立即
  启动，而是弹出「运行流水线」窗口，默认继承页面顶部「运行流水线」控件当前的环境、代码仓、分支/Tag、
  部署策略和预设任务；分支/Tag 与部署策略复用主控的可搜索选择面板并提升到页面浮层，避免被弹窗边界裁剪，用户可只为本次运行临时调整，确认后以显式参数进入既有本地/服务端调度流程，
  不改写流水线默认配置或主运行框。执行人仍统一取当前 dsh 登录用户，弹窗不提供执行人设置；无目标节点
  运行继续支持显式空环境，代码仓未选择时阻止提交。新增
  `projects/pipeline/tests/test_pipeline_run_dialog.js`，并更新 `test_pipeline_row_run.js` 覆盖点击只打开弹窗、
  默认值回显、临时参数提交、登录用户署名边界和空环境/代码仓校验。

- 服务端运行接口贯通「不选择任何节点」语义（`src/index.ts`）：`POST /api/worktable/pipeline/run/<id>` 此前
  对显式空 `environmentIds` 判 400（`environmentIds must not be empty`）、默认环境为空时回退首个环境，
  与页面「默认不选择任何节点」的新语义矛盾——运行框全不选时走服务端权威队列会静默改投默认/首个节点。
  现显式空 `environmentIds` 或默认环境保存为空列表即按无目标节点运行（执行池本就按纯 FIFO 处理无目标
  IP 的计划，`TARGET_*` 注入为空值）；首项兼容回退仅限从未保存过默认环境字段的旧流水线。页面
  `submitServerRun` 相应改为始终显式携带 `environmentIds`（空选择即空数组，不再省略回退默认环境），
  API 调用说明弹窗的空环境请求体同步展示显式空数组并更新警告文案，README 接口契约同步更新。
  `tests/pipeline-run-api.test.mjs` 移除旧 400 用例、新增显式空/默认空两例；`test_pipeline_api_ui.js`、
  `test_pipeline_defaults.js` 同步扩充。

- 流水线运行与编辑器「默认环境」支持不选择任何节点，且默认即不选择（`projects/pipeline/pipeline.html`）：
  主控「选择 IP」多选此前空选择时自动回写首个节点、勾选变更强制「至少保留一个」，无法表达「无目标节点
  运行」；现默认不选择任何节点（本地存储的空数组选择按显式空保留），允许全部取消勾选，按钮无选择时
  显示占位「选择 IP」。不选节点按既有无目标 IP 语义运行：跳过节点租约申请、页内调度与队列按同机串行
  处理（排队原因文案本就有「未选择目标节点的运行按串行处理」），脚本注入的 `TARGET_IP`/`TARGET_IPS`/
  `TARGET_HOSTS` 为空值/空数组。流水线编辑器「默认环境」同样默认不选择任何节点；`pipelineDefaultRunOptions`
  区分「编辑器显式保存的空环境列表」（= 不选择任何节点，不再改投首项）与「旧流水线从未保存过该字段」
  （维持回退首项兼容），失效引用仍由 `pipelineDefaultRunIssue` 阻断。定时页环境多选跟随主控，均未选择
  时同样按无目标节点处理。服务端权威队列路径的无目标节点语义由后续变更贯通（见上一条）。新增
  `projects/pipeline/tests/test_env_selection_default_none.js`。

- 流水线运行导入弹层增加第二步「按运行窗口挑选普罗标签」（`projects/diag_perf/index.html`）：运行记录的
  `prom.modelName`/`xdsNamespace` 是占位模板（`${MODEL_PATH}`/`${DEPLOY_STRATEGY}-${BY}`）在采集时点的解析
  快照，解析不出时只剩空串或 `-<操作人>` 残段，直接拿来当标签过滤查不到数据。现点选运行后进入第二步：
  按该运行起止的绝对时间窗口查询 Prometheus 当时实际存在的序列标签（`/api/v1/series?match[]=
  vllm:num_requests_running{exported_job=~".*vllmp.*"}&start=&end=`，与画板标签候选同口径），model_name 与
  xds_namespace 各给下拉挑选——运行记录值优先保留并默认选中，窗口内仅一个候选时自动选中，也可选「不过滤」；
  查询失败保留下拉中的运行记录值，导入后仍可在数据集卡片上调整。「应用导入」按所选标签 + 运行窗口 +
  归档日志目录落数据集，「返回重选运行」可回第一步。新增纯函数 `seriesLabelValues`/`importLabelChoices`
  及配套测试（`projects/diag_perf/index.test.cjs`）。

- 性能诊断页支持从流水线运行历史一键导入数据集（`projects/diag_perf/index.html`）：数据集 A/B 卡片各新增
  「从流水线运行导入」按钮，弹层经 `/api/worktable/pipeline/history` 拉取运行列表（旧版插件无此路由时回退
  全量 `/api/worktable/pipeline`），支持按编号/tag/流水线/环境/提交/操作人过滤、显示状态徽章与普罗采集标记，
  点选即把该运行的普罗标签（`prom.modelName`/`xdsNamespace`，仅非空覆盖）、运行起止转绝对时间窗口
  （`startTs`/`ts`，旧记录无 `startTs` 时按 `dur` 回推，再无耗时回退当前相对窗口）与归档目录（`archive`，
  内含 `run-<tag>.log` 汇总日志，作为日志证据目录）填充进数据集并立即生效；对比模式下 A 导入基线运行、
  B 导入劣化运行即构成 A/B 对比，无需手工抄标签与起止时间。新增纯函数 `parseRunDur`/`runImportWindow`/
  `runImportPatch`/`runMatchesFilter` 及配套测试（`projects/diag_perf/index.test.cjs`）。

- 点击「运行」后流水线编排与阶段详情自动跳到刚提交的那次任务（`projects/pipeline/pipeline.html`）：此前只有
  本地立即开跑会切编排区焦点，本地排队、节点租约在途（「申请节点中」）和提交服务端权威队列的任务都要用户
  自己到运行队列里点选才能看到。现三个运行入口（主控「运行流水线」、任务行 ▶、历史重跑）统一在提交后立即
  聚焦：本地入队/租约在途经 `focusQueueItem` 展示该次排队的只读编排与参数快照（启动后 `startSimRun` 照旧
  接过焦点，无租约环节同步启动时不覆盖回预览）；服务端提交按响应 `runId` 在每秒轮询的权威快照中等待出现
  （`pendingServerRunFocus`，15s 超时自动放弃，不抢占用户后续手动切换的视图），出现即经
  `focusRemoteQueueItem` 切到只读预览。配套修复服务端权威条目「排队→在跑」沿用同一 runId 时正在查看的
  排队预览被清空回空闲编排的问题：`refreshRemoteQueuePreviewRc` 先按同 id 续看，再按 `originQueueId`
  兼容旧浏览器在场条目的 q…→r… 换 id。新增 `projects/pipeline/tests/test_run_autofocus.js`（本地排队/
  满额拒绝/租约在途/同步启动、服务端立即可见/延迟可见/超时放弃/提交失败、两类排队→在跑跟随）。

- 恢复混合编排流水线手动运行的「定时分界移交」原设计（`projects/pipeline/pipeline.html`）：编排中同时存在
  「需本地运行」与「定时」阶段时，需本地运行的前缀在浏览器立即跑完，运行到达首个定时阶段（分界）即把
  后缀定时阶段整体登记为一条「立即执行一次」的服务端计划（归档文件夹/tag/baseSeq/上游变量快照随计划移交，
  服务端 15s 轮询到期执行，回显写入同一归档文件夹、任务日志编号连贯，计划出现在「定时」页可查看/取消），
  并弹窗告知；后缀各阶段在编排区标记为移交态（skipped 渲染），其执行结果由服务端「定时后缀」运行记录承载。
  登记接口不可达时弹窗告知后缀未执行、分界阶段标 failed（可从失败阶段重试）、运行按失败收尾——后缀不
  静默丢失，也不改在本地落地执行。此前 `registerStageTimers` 自始没有调用方（移交机制断线，服务端对
  `pl.archive/pl.tag/baseSeq/vars` 的支持一直在），本地执行分流恢复后混合编排被整次留在浏览器执行；本次
  把移交接入 `advance` 的定时分界（定时阶段在并行组起始同样移交）。新增
  `projects/pipeline/tests/test_sched_suffix_handoff.js`（移交计划内容/弹窗/失败收尾/纯本地不触碰计划接口），
  `test_execution_progress.js` 的混合 sched 用例同步改为断言分界移交。
- 修复流水线勾选「需本地运行，不支持定时」后，手动运行与历史重跑仍被提交到服务端执行的问题
  （`projects/pipeline/pipeline.html`）：只要编排中存在 `sched: null` 的普通阶段，整次运行就复用浏览器执行器，
  使浏览器可达、dsh 服务进程不可达的 Jenkins/HTTP 地址正常触发，并恢复本地脚本、环境清理等运行上下文；
  同机互斥、4 个浏览器并发槽位、16 条本地队列上限及排队/满额提示继续生效；节点租约申请在途会同时
  占用并发槽位并预留回队容量，避免异步申请期间超发或拒绝后溢出队列。全部普通阶段均支持定时时，
  手动运行仍提交服务端权威队列；预设标记不参与分流，服务端 API 与定时计划路径保持不变。扩充
  `test_queue_item_preview.js`、`test_pipeline_row_run.js`、`test_replay_executor_attribution.js`、
  `test_pipeline_defaults.js` 与 `test_node_lease.js`，覆盖本地/服务端分流、冲突排队、容量拒绝、租约竞态和
  三个运行入口的反馈。
- 修复流水线 HTTP 阶段在浏览器本地执行时构建状态轮询静默死循环（`projects/pipeline/pipeline.html`）：
  阶段 URL 含 `/job/` 的标准 Jenkins 任务路径在 GET 触发后会轮询构建结果，轮询目标固定为「Jenkins 服务
  配置」的地址 + 阶段 URL 路径，而轮询循环的 catch 吞掉一切错误且无限重试——服务配置地址不对、本地桥接
  未启动、跨域被浏览器拦截（CORS）、401/403 等持续性故障会让 `buildNum` 永远拿不到，阶段在默认「无超时」
  配置下没有任何兜底，永远卡在「已触发请求，等待执行…」，且运行日志里看不到任何错误原因，只能手动「中止」。
  现按连续失败计数：首次与每 15 次失败在运行日志回显原因与排查指引（检查服务配置地址/凭据/连接模式、
  目标需允许 CORS），连续 30 次（约 1 分钟）按阶段失败收尾，成功一次即清零；已确认任务存在（拿到
  nextBuildNumber）时 lastBuild 404 = 首次构建尚未开始，属合法排队等待，不计失败。
  新增 `projects/pipeline/tests/test_http_stage_poll_failure.js`，覆盖持续失败有界收尾与原因回显、
  排队中 404 豁免、瞬时故障恢复三个用例。
- 修复流水线服务端执行 EvalTokens 远程连接时误走系统代理（`src/index.ts`）：手动运行迁移到服务端权威队列后，
  EvalTokens 阶段此前无视设置页的「远程服务器端连接」语义，直接调用启用了 `NODE_USE_ENV_PROXY` 的全局
  `fetch`，内网请求会被送往 HTTP 代理并在约 135 秒后仅报 `fetch failed`。远程模式现与
  `/api/worktable/proxy` 共用显式独立 Agent 的内网直连传输，保持回环/RFC1918/链路本地目标限制，单次请求
  20 秒超时且完整传递运行取消；域名目标会校验全部 DNS 结果并把请求固定到已验证的内网地址，阻断解析污染与
  DNS 重绑定，响应前异常关闭也会立即失败而不会永久挂起。任务列表和本次 run 的状态轮询对网络错误、
  408/429/5xx 最多重试两次，有副作用的启动 POST 始终只调用一次。网络错误会带上请求阶段和底层错误码，
  并清洗 URL 凭据与常见敏感查询参数。`tests/pipeline-run-api.test.mjs` 新增真实本地 HTTP 服务、超时、取消竞态、
  DNS 校验与固定、提前断连、目标限制、GET 重试及 POST 单次调用测试；同时收紧 `/api/worktable/proxy`：直连域名
  复用 DNS 校验与固定，`useProxy:true` 因代理端会自行解析而仅接受内网 IP 字面量。
- 修复流水线脚本测试在 `dev` 上的既有回归：`render-config.sh` 恢复既定模型存储路径 `/mnt/xds/sfs`；
  `test_render_target_labels.sh` 同步此前已经调整的 LMCache 生产默认值和字符串化对齐值；
  `test_pipeline_contract.sh` 将需要 12/14 张 GPU 的夹具改为双节点，避免与单节点 8 卡容量保护互相矛盾。
- 流水线任务列表展示各流水线的运行队列数量（`projects/pipeline/pipeline.html`）：新增「运行队列」列，
  按稳定流水线 ID 汇总当前页面、节点租约申请中、服务端 API/定时任务以及其他浏览器的全部在跑与排队条目，
  分别显示「运行 N」「排队 M」，无活动时显示「—」；自定义运行没有流水线 ID，不按重名误归类。
  每秒队列同步只定向更新现有计数单元格，不重建任务表，保留筛选与行交互状态；兼容旧浏览器仅上报单条
  `running` 的快照。新增 `projects/pipeline/tests/test_pipeline_queue_counts.js`，并扩充
  `test_queue_item_preview.js`、`test_pipeline_row_run.js` 覆盖全来源聚合、列表展示、实时刷新与既有行操作。
- 修复运行历史刷新在旧版插件下报 HTTP 404（`projects/pipeline/pipeline.html`）：轻量历史接口
  `/api/worktable/pipeline/history` 是后加的服务端路由，而工作台经 `/api/worktable/site` 直接从源码目录
  托管页面时，前端可能新于正在运行的旧版插件（如 v1.1.2 发行包无此路由），手动与自动刷新均失败弹窗。
  首次收到 404 即永久降级为 `GET /api/worktable/pipeline` 全量存储接口（与旧版手动刷新同一载荷），
  清掉只对轻量接口有意义的 ETag，本次会话内不再请求缺失路由；新插件下行为不变。
  `projects/pipeline/tests/test_history_auto_refresh.js` 新增 404 降级与降级记忆回归用例。
- 流水线运行队列支持查看服务端最新日志，运行历史支持自动刷新（`src/index.ts` +
  `projects/pipeline/pipeline.html`）：服务端执行池为每条运行的各阶段维护独立、按 UTF-8 字节限制为最大 256 KiB 的日志尾窗，
  脚本 stdout/stderr 在进程结束前即增量写入；普通队列快照继续只含安全状态字段，页面仅在查看服务端
  运行时按 `runId + stageId` 单独拉取当前阶段日志，并随每秒队列轮询更新，切换运行/阶段后的迟到响应会
  被丢弃，日志版本未变化时以 304 避免重复传输。运行历史在初始状态加载完成后每 3 秒通过带 ETag 的
  轻量接口同步（后台标签页暂停，版本未变时不读取存储正文），手动刷新复用同一请求；列表更新保持筛选、
  页码、分析勾选及按稳定主键绑定的回放行，并沿用已加载的日志与 profile 校正缓存。清空版本同时约束
  客户端、服务端和刷新响应，避免防抖保存或旧标签页竞态复活已清记录。新增服务端日志尾窗/查询/实时输出测试及
  `projects/pipeline/tests/test_history_auto_refresh.js`，扩充队列详情与日志拉取回归测试。
- 运行历史「↻ 刷新」按钮移到筛选栏最前、关键字输入框之前（`projects/pipeline/pipeline.html`）：刷新从
  栏尾（清空之后）提前为筛选栏第一个控件，关键字 / 状态 / 流水线筛选与「清除筛选 / 重跑 / 清空」的相对
  顺序不变。`projects/pipeline/tests/test_history_toolbar_layout.js` 同步改为断言新排列。
- 流水线任务支持按用户收藏与收藏筛选（`projects/pipeline/pipeline.html`）：任务行「⋯」悬浮菜单新增
  「收藏 / 取消收藏」，列表名称区以「★ 收藏」标识当前用户的收藏；筛选栏新增「全部 / 仅看收藏」，
  可与关键字、创建者条件组合并在浏览器本地保留筛选选择。收藏关系以流水线 `favoriteUsers` 用户名数组
  保存，经既有 `savePipelines` / `persistState` 链路同步到服务端与导出文件，同一登录用户跨浏览器可见、
  不同用户互不影响；未获取登录用户名时拒绝写入，复制副本不继承任何用户的收藏。新增
  `projects/pipeline/tests/test_pipeline_favorites.js` 覆盖用户隔离、未登录保护、筛选状态、列表与菜单交互、
  保存链路及副本语义，并为既有置顶、行运行与署名测试补齐收藏状态依赖桩。
- 流水线编辑器任务参数支持折叠（`projects/pipeline/pipeline.html`）：Shell/Python 自动识别参数与 EvalTokens
  任务输入参数统一放入原生 `details` 面板，标题显示参数数量，首次渲染默认折叠；无参数的模拟、HTTP 或未识别到
  参数的任务隐藏整栏。展开后修改参数只重绘字段，不重建折叠容器；折叠标题加入任务卡拖拽手势保护，点击时正常
  展开/收起而不触发整卡拖拽。新增 `projects/pipeline/tests/test_stage_params_collapse.js`，并扩充
  `test_stage_drag_reorder.js` 覆盖默认折叠、按类型显示/隐藏、数量标题与折叠点击手势。
- 流水线脚本目录可在设置中配置，默认路径改为插件安装后的 scripts 路径（`projects/pipeline/pipeline.html` +
  `src/index.ts`）：「设置」页新增「脚本目录」卡片（Profiling 脚本与归档配置之间），可保存自定义目录、
  留空或点「重置为安装默认」恢复默认；自定义值随设置持久化到服务端（worktable-pipeline.json）并跨浏览器
  同步，「导出设置」文件同样携带。默认路径不再只靠页面 URL 嗅探：页面启动时经 `/api/worktable/health` 的
  `dir` 解析出安装默认 `<插件安装目录>/projects/pipeline/scripts`，凡未经任何设置配置（localStorage 与服务端
  设置文件都没有 scriptsDir，新增 `scriptsDirIsFallback` 标记）的生效值自动升级为该安装默认并落盘；已配置
  值（含「编辑流水线」弹窗与「导入设置」）一律不被覆盖。服务端执行器（定时任务 / API 触发 / 普罗收集脚本）
  经新增 `resolvePipelineScriptsDir` 同一规则解析——设置文件未配置 scriptsDir 时从原来的进程 cwd 相对路径
  改为兜底到安装默认 `DEFAULT_PIPELINE_SCRIPTS_DIR`（PLUGIN_DIR/projects/pipeline/scripts，tgz 包的 files 含
  projects 目录）。新增 `tests/pipeline-scripts-dir.test.mjs`（解析规则 + 普罗收集脚本路径 + 源码契约）与
  `projects/pipeline/tests/test_scripts_dir_default.js`（默认解析、fallback 升级、设置页保存/重置与回显）；
  `tests/pipeline-run-api.test.mjs` 的执行器 vm 上下文补注 `resolvePipelineScriptsDir` 与空串安装默认（保持
  既有用例语义）。`projects/pipeline/scripts/test/test_render_target_labels.sh` 在 dev 上即失败（既有问题，
  与本次改动无关）。
- PR 检视台「编译发行」新增「AI 生成发行说明」一键选项（`projects/codereview/code-review-prs.html`）：「🚀 构建并发行」
  按钮旁新增勾选框；勾选后点按钮一气呵成——先把「上一发行版 Tag … 当前分支」的提交送入右侧聊天窗由 AI 起草
  发行说明并自动回填（无新提交则跳过并沿用发行说明框现有内容；AI 生成失败即中止，此时尚未构建/打 Tag，可修正后
  重试），随后继续 编译构建 → 创建 Tag → 创建发行版 → 上传产物（发行说明取回填后的文本框内容）。发行步骤列表随
  勾选态动态在最前插入「AI 发行说明」步（`relStepNames` 按次重算，实时回显、「⏹ 停止」语义与构建历史归档与其余
  步骤一致）；勾选态作为 `autoNotes` 并入「仓库@分支」云端构建设置，选中分支自动填充。顺带把 GitHub upload_url
  去模板改写为 `fromCharCode(123)` 定位花括号，避免源码不配对字面花括号（测试按配对花括号切取函数体）。新增
  `tests/codereview-release-run.test.mjs`：覆盖 AI 先行顺序、五步编排与历史归档、无提交跳过、AI 失败中止发行、
  停止语义及 `genRelNotesForRun` 单元行为。
- 流水线运行队列改为整体倒序展示（`projects/pipeline/pipeline.html`）：本页不再把“运行中”和“排队中”
  各自倒序后按运行优先分段，而是按原编号从大到小排列，后开始/入队的流水线在上，最早的 `#1` 固定在
  列表底部；服务端与其他浏览器的队列同样先展示较新的排队项、再展示较早的在跑项。仅调整 DOM 呈现顺序，
  底层数组、编号与 FIFO 调度语义不变。同步更新 `projects/pipeline/tests/test_queue_item_preview.js` 的整体顺序、
  徽标、权限按钮、排队原因及整行点击回归。
- 流水线手动运行改由服务端权威队列持有（`src/index.ts` + `projects/pipeline/pipeline.html`）：浏览器只向
  `POST /api/worktable/pipeline/run/<pipelineId>` 提交环境、代码仓、分支、策略、预设任务、镜像和执行人等
  脱敏参数，脚本、HTTP/Jenkins、EvalTokens 与模拟任务统一在服务端执行；关闭、刷新或退出发起页面不再
  终止运行。`GET /api/worktable/pipeline/queue` 返回服务端在跑/排队任务及逐阶段状态，所有浏览器每秒同步并
  可查看同一份只读详情；有控制权的用户可跨浏览器“中止/取消”服务端条目，旧页面上报的在场快照继续兼容
  只读展示（非 admin 仍只能控制本人署名任务）。
  执行池保持原有有界并发、节点租约互斥和队列满拒绝语义，任务与队列在 dsh 进程生命周期内保存（服务重启
  后清空）；快照按白名单清洗，不下发环境/代码仓凭据、脚本参数、变量或日志。新增服务端执行池快照、取消、
  手动来源及阶段实时状态测试，并扩充页面提交、轮询、离场与跨浏览器取消回归测试。
- 流水线任务列表支持置顶（`projects/pipeline/pipeline.html`）：每行操作列末尾新增「⋯」按钮，
  点击调出全局悬浮菜单 `#plRowMenuPanel`——fixed 定位悬浮于最上层（z-index 1000，右缘对齐 ⋯ 按钮、
  下缘贴按钮底部），不被表格 overflow 容器裁剪、不占文档流因而不撑大流水线行高；菜单项为列表行形态
  （`.pl-row-menu-item` 纯文字行、悬停底色高亮，非圆边按钮）。开合只动悬浮层、不重渲染任务表；
  点 ⋯/置顶项收起，点菜单外任意处、页面或表格容器滚动、缩放窗口亦收起。置顶态记在流水线 `pinnedAt`
  时间戳上，随 config 经 persistState 上送服务端、随导出文件保存，各浏览器刷新后一致；任务列表与
  运行框选用下拉同一排序——已置顶排最前（多条按置顶时间新→旧），未置顶保持数组原序（内置经加载迁移
  居首），置顶行名称区显示「置顶」徽标；取消置顶清空 pinnedAt 恢复原序；复制副本 pinnedAt 清零不继承。
  新增 `projects/pipeline/tests/test_pipeline_pin.js`（排序/徽标/悬浮层定位与开合/置顶落盘/副本不继承）。
- 流水线运行历史「AI 日志分析 / Profiling 分析 / 性能诊断」统一按当前项目工作区新建会话
  （`projects/pipeline/pipeline.html` + `src/client/index.tsx`）：页面优先调用新增宿主桥
  `window.__dshNewChatSessionForCurrentProject(text, cwd)`，工作台从当前分栏项目读取
  `projects.workspaces[projectId]`；工作区有效时，若聊天列已关闭则先打开，再以该 `workspaceId`
  新建会话并把分析提示词填入草稿（不自动发送）。项目工作区未设置或已被删除时不再回退默认分组/
  归档 cwd 创建无分组会话，而是暂存本次请求并直接弹出该项目的工作区选择列表（工作台左栏折叠时
  先自动展开）；用户选定后自动继续原请求，关闭设置弹窗则取消暂存。提示词中的归档绝对路径保持
  不变；旧版工作台无新桥时继续沿用
  `__dshNewChatSessionAt` 兼容路径。新增 `tests/project-analysis-chat.test.mjs`，并扩充
  `projects/pipeline/tests/test_history_analysis_compare.js` 覆盖工作区门禁、会话框开合、续建与新旧桥优先级。
- 流水线任务列表不再展示运行状态、运行中可切换选用流水线（`projects/pipeline/pipeline.html`）：任务行去掉
  「运行中」徽标、「（查看中）」标记与「点击查看本次运行的阶段详情」行提示，在跑/排队信息统一在「运行队列」
  查看（点击队列条目看阶段详情）；整行点击与运行框下拉一律走 selectPipeline 选用——取消「目标有在跑运行则
  转为聚焦其运行」与「编排区展示在跑运行时禁止切换」两道拦截，切换时脱离运行/结果视图回到所选流水线的
  空闲编排（总状态徽标复位「未运行」、中止按钮禁用、归档目录提示同步刷新），在跑运行转后台继续。
  renderQueue 末尾按签名重建任务表的徽标联动（_plRunSig）与 runsOfPipeline/latestRunOfPipeline 一并移除。
  `test_pipeline_row_run.js` 行点击用例改为断言无运行徽标且一律选用；`test_queue_item_preview.js`、
  `test_node_lease.js`、`test_pipeline_audit_trail.js` 同步去掉 _plRunSig 与徽标辅助桩。
- 运行队列「查看中」高亮与运行历史选中行对齐（`projects/pipeline/pipeline.html`）：队列条目（在跑/
  排队预览/他端只读预览）的选中背景统一为与 `#historyTable tbody tr.sel td` 相同的
  rgba(79,142,247,.12)，去掉此前自定的 color-mix 背景与强调色边框，两处选中态观感一致。
- 运行队列条目整行可点选中（`projects/pipeline/pipeline.html`）：点击条目空白处等同于点击标题——
  在编排区查看该流水线的阶段详情（本页在跑/排队项与他端有阶段快照的条目一致生效，旧他端无快照
  条目仍不可点）；标题、「排队中/申请节点中」徽标、中止/取消按钮等自带行为的区域不重复触发。
  `test_queue_item_preview.js` 新增空白处点击选中与交互区域不重复触发用例。
- 运行队列「排队中/申请节点中」徽标支持点击查看排队原因（`projects/pipeline/pipeline.html`）：徽标改为
  可点击，按条目展开/收起一行「排队原因」——按当前调度状态即时推算并说明后续动作：节点被他端运行占用
  （含占用者与节点 IP，租约释放后自动启动）、同机有本页运行在跑（同节点串行）、同机排队任务排在前面
  （FIFO，含对方编号）、并发槽位已满（N/4）、未选择目标节点按串行处理、租约申请进行中，以及调度中
  即将启动的兜底说明；展开态按条目 id 记忆、重绘保留，取消排队时清理。`test_queue_item_preview.js`
  新增展开/收起与各原因分支用例，并固定「后加入的条目显示在上、先加入者仍是队列首部（#1）」的展示顺序。
- 运行队列条目状态徽标与展示顺序调整（`projects/pipeline/pipeline.html`）：未启动的排队条目补「排队中」
  徽标（本页与他端一致，与运行中的「运行中」徽标对应；节点租约申请中的暂态仍显示「申请节点中」）；
  正在编排区查看的条目（本页在跑/排队预览/他端只读预览）整框背景与边框按主题强调色高亮，呼应原有
  「（查看中）」文字标记；条目展示改为倒序——后开始/后加入的显示在上面，编号仍按开始/入队先后递增，
  先加入者仍是队列首部（#1），仅展示顺序变化，FIFO 调度语义不变。`test_queue_item_preview.js` 新增
  徽标、倒序编号与整框高亮用例。
- 流水线运行队列与任务定义列表分区，并支持跨浏览器查看阶段详情（`projects/pipeline/pipeline.html`、
  `src/index.ts`）：原先嵌在「流水线任务」卡片首行的运行队列拆为独立卡片，「流水线任务列表」只保留
  定义筛选、统计与管理操作；本页在跑/排队任务和其他浏览器同步来的条目均可点击，在既有编排与详情区
  查看各阶段状态、进度和耗时，他端在场快照每次轮询后继续更新当前预览。跨浏览器接口按白名单、数量和
  长度限制清洗阶段数据，只同步阶段名称、并行/跳过标记及运行状态，不传输日志、阶段变量、脚本参数或
  凭据；他端预览和本页排队预览均保持只读，不提供编辑、重试、中止或取消他端任务的入口。阶段快照协议
  增加版本标识与队列来源 id，正在查看的他端排队项启动后会无缝跟随到真实运行；节点租约申请期间的待启动项
  在本页列表和他端快照中都保持可见、可点击，进入真实运行后延续同一预览。旧来源页没有阶段快照时禁止无效
  点击并提示刷新来源页面，镜像与 Commit 等未同步字段明确显示“未同步”，不伪造本页默认值；远端阶段 id 与
  子阶段名按 DOM `dataset` 精确匹配，不拼接进 CSS selector，异常字符不会打断渲染轮询。新增
  `projects/pipeline/tests/test_queue_layout.js`、`tests/pipeline-queue-presence.test.mjs`，并扩充
  `projects/pipeline/tests/test_queue_item_preview.js` 覆盖分卡布局、安全快照、他端点击与轮询刷新。
- 流水线同一节点互斥运行（跨标签页/跨浏览器/API/定时统一生效）：同一节点（环境 IP）同一时间只跑
  一条流水线，多条流水线选中同一节点时后到者排队等待。服务端新增节点占用租约
  （`/api/worktable/pipeline/leases`，`createPipelineNodeLeases`：易失内存态、TTL 90 秒、持有方
  25 秒心跳续租、页面崩溃/断网到期自动释放，申请按全部目标 IP 原子占用）；API/定时共用的执行池
  `createPipelineExecutionQueue` 接入节点调度 hooks——与在跑计划同节点、或节点被池外（页面手动运行）
  租约占用的计划留在队列等待并按 5 秒周期重试，不同节点可越过同机等待者并行，无目标 IP 的计划保持
  旧版纯 FIFO 不变。页面 `startRun` 改为先申请租约再开跑：申请在途占一个并发槽位并参与机器冲突判定
  （防快速连续运行越过互斥），被他人占用则回队等待、队列条目标注「等待节点 <IP>（占用者 · 流水线）」
  并按 5 秒节流重试，拿到租约后周期续租，`finish`/中止/重置释放租约，pagehide 时 beacon 批量兜底
  释放，旧插件无此路由时降级为仅页内互斥的旧行为不阻断运行。新增
  `tests/pipeline-node-leases.test.mjs`（租约语义/池节点调度/路由全链路）与
  `projects/pipeline/tests/test_node_lease.js`（startRun 门控/降级/在途占槽、drainQueue 节流与
  同机 FIFO、finish 释放、队列等待标注）。
- mem_leak 页面补入 vLLM P/D 分离集群生产诊断手册（`projects/mem_leak/index.html`）：
  新增「P/D 实战手册」标签页，固化 8×H800 kubeRay/TENT 拓扑、cgroup v1 的
  anon/file/cache/shmem 分层方法、RssAnon/VmPin/线程/fd 判据、生产插桩红线、Xid 事故时间线、
  task_exec 九层 async generator 僵死链证据、修复三件套与 2026-09-11 上线验证；工具、泄漏模式和
  检查清单同步改成生产安全口径。在线采样不再把 RSS、cgroup 总量或 vLLM 约 95% GPU 预分配直接定性为
  泄漏：RSS 需最近两个固定 30 分钟窗口（每窗至少覆盖 27 分钟）均超过 50 MiB/h 才预警并要求拆 anon/file，
  cgroup 总量始终要求继续分层，
  GPU 上涨先排除预分配；诊断概览删除“显存 × 1.4”虚构 RSS，改为只展示实测要求；有效“待观察”原因不再误显示为
  “样本不足”，负斜率明确显示回落。审查后移除可直接复制的 `memory.force_empty` 命令并补强制回收红线，
  同时为多标签和长代码标识补窄屏适配。`projects/mem_leak/index.test.cjs` 新增固定双窗口、指标来源保守判定、
  待观察徽标、回落文案与生产安全边界回归。
- 流水线「执行人」展示去输入框化（`projects/pipeline/pipeline.html`）：右上角执行人由只读 `<input>`
  改为纯文本 `<span>`（初始「未登录」，探测成功替换为登录用户名），不再保留任何表单控件形态；
  逻辑读取点（运行/入队的 `by`、必填校验、API 说明、定时计划默认值、新建/复制/改序署名）统一改为
  直读已缓存的 `currentUsername`，与展示彻底解耦。相关测试桩同步由 `triggeredBy.value` 改为
  `currentUsername`（`test_pipeline_defaults.js` / `test_pipeline_api_ui.js` / `test_queue_item_preview.js`），
  `test_executor_auth_default.js` 改为断言展示文本。
- 流水线运行队列上限 8 → 16（`projects/pipeline/pipeline.html` 的 `QUEUE_CAP`）：并行槽位（4 个）占满后
  可排队等待的任务数放宽一倍，提示文案随变量联动；同步 `tests/test_queue_item_preview.js` 的边界用例
  （填满 16 个后拒绝入队）与 `tests/test_pipeline_row_run.js` 的容量提示断言。
- 流水线「执行人」改为只读、固定取 dsh 登录用户并移至页面右上角（`projects/pipeline/pipeline.html`）：
  执行人由主控区可编辑输入框改为标题行右侧（主题切换旁）的只读展示，每次加载都以 dsh-auth-gate
  `/auth/status` 当前登录用户为准并覆盖任何残留值；不再持久化/恢复执行人（localStorage `pip-by` 与
  服务端配置 `loc.by` 均停用，旧导出文件里的 `by` 导入时忽略），从根上消除共享配置把他人名字长期
  错署为执行人的可能。未装认证插件 / token 共享模式 / 未登录 / 探测失败时显示「未登录」占位，
  运行的必填拦截文案相应改为「未获取到当前登录用户」。`tests/test_executor_auth_default.js` 按
  新契约重写（覆盖残留值、必然探测、留空路径、「我的」筛选重绘），`test_config_import_export.js`
  同步去掉导出/恢复 `by` 的断言。
- 流水线运行队列支持点击排队任务查看详情（`projects/pipeline/pipeline.html`）：队列中的排队条目由纯展示
  改为可点击，编排区以只读快照预览该次排队的详情——阶段编排按入队时的阶段快照与「预设任务」勾选快照展开
  （与启动同一 `expandRunStages` 路径，并行组结构原样绘制），详情面板展示入队参数（环境/仓库/分支/策略/
  执行人），总状态徽标显示「排队中（预览）」，队列条目随焦点标「（查看中）」。预览上下文不进在跑集合、
  以 queuedPreview 标记且 over=true：引擎不感知，停止/阶段重试/归档目标均不指向它；该项被启动时焦点
  自动切给真实运行，被取消或启动失败时由 renderQueue 开头的自愈清回当前流水线空闲编排。他端浏览器
  上报的只读条目不挂点击。「运行队列」标签补 title 说明（异机并行、同机串行、点击查看详情）。新增
  `tests/test_queue_item_preview.js` 覆盖预览构建/聚焦去重/条目点击与「查看中」/出队自愈/他端只读，
  并用真实 machineConflict/drainQueue 固化异机并行调度语义（不相交立即并行、相交串行排队、
  不同机排队任务可越过同机等待者、并发槽位与队列上限）。
- 修复流水线「执行人」被历史记录作者长期错署（`projects/pipeline/pipeline.html`）：进入历史回放曾把
  `rec.by` 回填进「执行人」输入框（内置演示数据的 `release-manager` 即由此进入），该值随后随
  localStorage 与服务端配置持久化，使 `fillExecutorFromAuth` 因输入框非空而跳过 `/auth/status`
  探测，执行人（连同新建/复制流水线署名回退值）一直停留在历史记录作者。现回放不再回填执行人
  （原执行人仍在回放状态行展示），历史重跑也不再沿用记录作者——重跑是新运行，执行人取输入框当前值，
  留空由必填校验拦截且不再误报「已开始重跑」。新增 `tests/test_replay_executor_attribution.js` 回归。
- mem_leak 内存泄漏诊断页入库并新增「在线采样」（`projects/mem_leak/index.html` + `src/index.ts`）：
  页面原先仅存在于本地未跟踪文件，本次基线入库；新增首个标签页「在线采样」——输入目标机器的
  IP（可带 :端口）、用户名、密码后连接，经 `/api/worktable/gpu` 发现该机使用 GPU 的容器与进程
  （GPU 概览卡片 + 进程/容器表格：PID、进程、容器、显存、RSS、容器内存、已运行），勾选目标后按
  5/10/30/60s 间隔轮询采样，显存（按进程）与内存（RSS/容器）两张多序列时序曲线实时绘制，泄漏研判表
  复用页面最小二乘回归按序列给出速率（MiB/h）与「疑似泄漏/碎片化/健康」判定（按严重度排序），单条序列
  可一键载入「诊断概览」深入分析。采样用 setTimeout 链自排程避免请求重叠，改连机器以代次丢弃过期响应，
  新出现的 GPU 进程默认纳入；每序列上限 720 点；IP/用户名存 localStorage，密码不持久化。服务端
  `/api/worktable/gpu` 新增 `detail:true` 可选参数：探针追加三段（每进程显存 used_memory、/proc VmRSS、
  进程所属容器的 cgroup 内存占用——优先 v2 memory.current、回退 v1 memory.usage_in_bytes，不依赖
  docker/nerdctl CLI），一次 SSH 取回；响应 gpus[] 增 memTotal、procs[] 增 gpuMem/rss/cgMem（均 MiB，
  取不到为空串）；非 detail 调用响应与探针保持原样（pipeline 环境页不受影响）。新增
  `tests/gpu-detail.test.mjs`（detail 字段解析、非 detail 兼容、降级空串、parseHostPort）与
  `projects/mem_leak/index.test.cjs`（数值解析、序列落点/去重/上限、勾选过滤、泄漏判定）。
- 流水线任务支持显式并行执行（`projects/pipeline/pipeline.html` + `src/index.ts`）：普通任务可勾选“并行执行”，
  编排区直接绘制连续并行任务的分叉 / 汇合结构，阶段详情仅显示当前所选任务的独立日志；页面手动运行、API
  与定时运行统一按组并发并等待汇合，任一阻断失败会立即取消组内在途任务，同组任务读取相同入口变量快照且
  输出按编排顺序确定性合并。从并行组内失败任务重试会恢复入口变量并重跑整组；每组仅按最长的合格任务时段
  保存一份普罗数据，串行任务原有采集行为不变。
- 流水线任务署名审计（`projects/pipeline/pipeline.html`）：在既有「创建者」署名（createdBy）之上
  新增「最后修改人」（updatedBy），同样取 dsh-auth-gate `/auth/status` 当前登录用户（未取到时退回
  「执行人」输入框、再取不到则不署名）。编辑器每次保存、主视图拖拽改序都会刷新最后修改人；新建与
  复制流水线同时落创建者与最后修改人；存量数据经 migrate 补空字段，导出/导入随 JSON 原样保留。
  流水线任务列表行由「· @创建者」改为明示「· 创建 @某人 · 修改 @某人」，修改人与创建者相同不重复
  显示，内置与未署名流水线不显示。新增 `tests/test_pipeline_audit_trail.js` 覆盖迁移、新建/编辑/
  复制/改序署名与列表展示。
- 侧栏工作台标题缺省取 dsh 登录用户（`src/client/index.tsx`）：未自定义名称时，挂载经
  dsh-auth-gate `/auth/status` 探针（同源、只认会话 cookie）以当前登录用户名作为侧栏区块标题；
  未装认证插件（404 / SPA 兜底非 JSON）、token 共享模式（username 恒 null）、未登录或探测失败
  均回退默认「工作台」。用户自定义名优先级不变（设置面板改名仍生效），改名框初始值跟随当前
  显示标题；link: 本地编译安装时「（开发中）」后缀追加在缺省标题（登录用户名或「工作台」）之后。
  新增 `tests/auth-username-title.test.mjs` 覆盖探测裁剪、各回退路径与标题优先级（含后缀组合）。
- 工作台分栏让位观察器修复子像素误判（`src/client/split.tsx`）：better-sidebar 面板开合的过渡动画期间
  会话根逐帧缩放，applyMargin 写出子像素 margin（如 960.671875px），浏览器读回内联样式仅保留 3 位小数
  （960.672px），让位观察器的字符串比较把引擎自身写入误判为「外部接管」而关闭分栏——表现为点
  better-sidebar 右上角按钮开关侧栏时工作台项目页被一并关掉。改为数值容差比较（漂移 >0.01px 才视为
  外部改写），其他分栏引擎真正改写 margin 时仍正常让位。
- 流水线「打开归档目录」改为「关闭侧边会话窗 + better-sidebar 侧边窗打开」（`projects/pipeline/pipeline.html`
  + `src/client/index.tsx`）：点击后仍经 dsh-better-sidebar 侧边窗打开归档目录（文件夹窗口，文件树以
  归档目录为根，同目录复用同标签），打开成功后经新增宿主桥 `window.__dshCloseSideChat()` 关闭工作台
  侧边会话窗（聊天列）让出屏幕空间；better-sidebar 不可用时回退服务端系统文件管理器（回退路径不关
  会话窗），目录选取与存在性预检/回退归档根逻辑不变。新增「侧边窗打开成功后关闭会话窗」「回退系统
  文件管理器时不关会话窗」回归测试。
- 流水线「执行人」缺省取 dsh 登录用户（`projects/pipeline/pipeline.html`）：本地无执行人记录
  （首次使用或清过浏览器数据）时，自动以 dsh-auth-gate `/auth/status` 当前登录用户名填充主控
  「执行人」输入框，定时计划与 API 请求体沿用同一取值随之获得默认；token 共享模式（username 为空）、
  未登录或探测失败保持留空走原有「必填」拦截。localStorage 已保存值、导入恢复值与等待探测期间的
  手动输入均优先、不覆盖。新增 `tests/test_executor_auth_default.js` 覆盖填充、裁剪、不覆盖与失败兜底。
- 流水线大量日志 / 长时间任务二次性能加固（`projects/pipeline/pipeline.html` + `src/index.ts`）：
  浏览器实时输出由反复拼接字符串改为 256 KiB 分片尾窗，脚本、预设任务、Jenkins、HTTP 与 EvalTokens
  的终态也只保留尾窗；完整日志由服务端边执行边落盘，Jenkins / HTTP / EvalTokens 轮询日志通过
  `/write-stream?mode=append` 串行追加，并在下一轮拉取前等待落盘形成背压，避免浏览器长期持有全文或
  待写分片无界排队；追加请求中断会回滚本次字节，同一路径替换/追加串行化，运行汇总再由
  `/concat-stream` 直接流式拼接任务日志文件，浏览器不回读完整日志；脚本任务日志从打开到写完
  `[exit]` / `[aborted]` 全程持有源文件锁，汇总会等待关闭后再读取；页面请求发出前即记录预期日志路径，即使在
  建目录/打开文件期间、响应头到达前中止，汇总也会等待服务端写完中止标记，避免丢尾部或被页面尾窗覆盖。输出变量改为随 stdout / Jenkins 控制台
  增量提取，早期 `KEY=VALUE` 离开尾窗后仍可传给下游；`*=全文` 仅保留 128 KiB，超限时跳过并明确告警。
  浏览器直连正文和服务端 `/proxy` 均在读取过程中执行 20 MiB 硬上限，声明长度或 chunked 响应超限即
  中止上游；HTTP/Jenkins 阶段从进入阶段即启动 deadline，并把同一 `AbortSignal` 传到触发、crumb、
  状态轮询和控制台请求，停止或超时不会继续挂住网络连接；单次控制台响应超过 20 MiB 后禁用本阶段后续拉取并给出日志不完整告警，
  避免围绕同一 offset 反复下载超大响应。API/定时流水线的 Jenkins 最终控制台请求同样严格服从阶段 deadline，非超时读取失败保留真实构建终态并写入可见告警。
  页面增加 4 条活跃运行上限，API 与定时计划共用 2 槽 FIFO 执行池（最多排队 100 条）；
  队列满时 API 返回 503，计划任务保留触发点并在下个 tick 重试，不再返回成功或静默丢弃。
  服务端计划脚本由 `execFile` 全量缓冲改为 `spawn` 流式写任务日志、内存仅留 256 KiB 尾窗，汇总日志
  直接流式复制任务文件，EvalTokens HTML 报告也改走原始流上传而非 JSON 正文。历史裁剪由反复
  `JSON.stringify` 改为每条记录仅序列化一次；后台 Prom 收集
  强制走流式接口，手动收集日志 DOM / 文本有界（同时限制字符数和 DOM 节点数）；实时详情最多每
  250ms 物化一次尾窗。失败归档 Promise 会从在途集合清理，最近错误以
  最多 100 项的可消费映射保留。新增并发池、超大脚本落盘、代理超限、历史线性裁剪、追加归档、
  完整汇总、请求取消、早期变量保留与各类有界日志回归测试。
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
- 项目手动排序纳入服务端同步存储（`src/index.ts` + `src/client/index.tsx`）：侧边栏项目列表拖拽落序的
  order（项目 id 序列）从仅 localStorage 扩展为同步进 `/api/worktable/projects` 存储文件，跨浏览器固定顺序——
  客户端同步切片 `syncedSliceOf` 带上 order，落序后随既有「同步切片有变化才推送」比较自动 PUT，全量覆盖写
  last-write-wins 不变；服务端 GET/PUT 白名单新增 order 字段（仅接受字符串数组、过滤非字符串元素、缺省
  `[]`，1MB 上限与 tmp+rename 原子落盘不变）。启动合并时远端 order 非空则远端优先、本地独有 id 保相对序
  追加尾部（模块级纯函数 `mergeRemoteOrder`）；远端没存 order（旧存储文件）时保留本地序不动，避免空远端
  清掉本地序；合并结果与远端不一致（远端缺 order 或合并产生追加）时启动一次性回推完整同步切片自愈。
  localStorage 中 order 的读写不变，作离线/服务端不可用兜底。测试：`tests/projects-order-sync.test.mjs`
  新增（服务端 PUT 过滤落盘 / GET 返回与旧文件兜底、客户端远端优先合并与无远端序保留本地）。
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
    流读取和轮询日志改为分块收集、结束时仅合并一次；后续二次加固进一步把终态 stdout 改为有界尾窗，
    输出变量改在流到达时增量提取，完整回显直接落服务端任务日志（见本文件首条）。
  - 任务 / 汇总归档改为原始字符串分片，不再把大日志 `split` 成百万行后再 `join`；新增
    `/api/worktable/write-stream` 原始请求体接口，浏览器用 Blob 分片上传，服务端边读边写临时文件并原子
    替换（上限 256 MiB），避免完成时生成整份行数组和 JSON 转义副本；超限、客户端断开或原子替换失败
    均清理临时文件且不覆盖旧目标。变量 / JSON 提取也改为逐行扫描。
  - HTTP/Jenkins 与 EvalTokens 运行期间最初由页面保存完整原始分片；后续二次加固改为经服务端追加接口
    边轮询边落盘，页面的运行中 / 中止兜底也仅保留 256 KiB 尾窗，正常终态不再保留重复全文引用。
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
