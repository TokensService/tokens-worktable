- 调整**Profiling 页「Perfetto打开」入口：从概览卡移到「Profiling 列表」卡标题行「清空本地」之后，并按选中条目资格启停**（`projects/profiling/index.html`、`projects/profiling/index.test.cjs`）：问题背景——入口按钮原先在概览卡标题行、按条目资格条件渲染（非 trace 条目整个不渲染按钮），位置随概览刷新重建，且用户要打开 trace 时视线要先跳到右栏概览卡；列表卡标题行是更稳定的操作区。解决方案——按钮改为静态 markup 固定在列表卡标题行「清空本地」之后，改名「Perfetto打开」，默认 disabled；`renderOverview` 开头统一刷新 `disabled = !(cur && perfettoEligible(cur.item))`（无选中/非 trace/二进制报告均禁用），点击仍走 `openPerfettoForCurrent`（空选/非 trace 有 toast 兜底）；概览卡内的条件注入与事后绑定移除。改动点——`index.html`（列表卡标题行静态按钮、renderOverview 资格启停、静态 addEventListener 绑定、移除概览卡注入）；`index.test.cjs`（静态契约改静态绑定断言，新增位置契约：Perfetto打开 位于 清空本地 之后、旧注入已移除、默认禁用与启停赋值）。测试——`index.test.cjs` 21 例全过；全量 npm test 477（tests）+ 875（projects JS）+ shell + python 0 失败；Playwright 实测（lihaifeng 登录、worktree 页面经 /api/worktable/site 直开）33/33：按钮位于「清空本地」之后且默认禁用、本地 plain/gzip、服务端文件、弹出窗口、非 trace 条目在场但禁用、不可达超时降级与重试、全程无页面 JS 错误，截图复核。影响范围——仅 profiling 页入口按钮的位置/文案/启停形态；打开链路（握手、取数、2GiB 上限与下载兜底、超时降级）全部不变；插件服务端零改动。

- 新增**流水线运行行可选「权重路径」设置框（注入 MODEL_PATH）+ 预设任务勾选状态经 PIPELINE_PRESETS 环境变量下发**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——部署/注册类脚本（`deploy-model.sh`/`register-model.sh` 等）的模型权重路径此前只能写死在脚本 `:-` 默认值或逐个阶段参数里，同一条流水线换一套权重就要改脚本/改阶段；另外脚本侧无法得知本次运行是否勾选了 Profiling 等预设任务（此前没有任何环境变量表示预设勾选状态）。解决方案——① 主控「运行流水线」行新增可选「权重路径」输入框（留空=不注入，由脚本自身默认值兜底）：非空时作为 `MODEL_PATH` 环境变量注入本次运行每个任务，优先级沿用既有约定「阶段显式参数 > 上游阶段产出 > 运行级填写值」；取值仅本地 localStorage（`pip-weightsPath`，与分支/策略同通道）持久化，导入导出 local 块携带，运行历史记录新增 `weightsPath` 字段、历史重跑按记录重放；「流水线任务」列表运行弹窗默认继承主控当前值、可逐项覆盖（含清空），运行 API 请求体新增可选 `weightsPath` 字段（非字符串 400），流水线 API 说明弹窗的请求体/curl 按运行框当前值动态携带；② 新增 `PIPELINE_PRESETS` 环境变量：本次运行勾选的预设任务 key 的 JSON 数组（如 `["cleanup","profiling"]`，含自定义预设 key），脚本可据此判断预设任务是否启用（如 `echo "$PIPELINE_PRESETS" | grep -q profiling`）；页面本地执行（`execScript`）与服务端执行（`runStageScript`/`serverRunVariables`）双端同形注入，`${MODEL_PATH}`/`${PIPELINE_PRESETS}` 占位符在脚本参数值与 HTTP 阶段 URL 中同样可解析；页面提交的定时后缀计划随计划携带 `weightsPath`，服务端 `PIPELINE_PRESETS` 取实际进入编排序列的预设 key（旧计划无 presets 字段的回退模式不注入）。改动点——`projects/pipeline/pipeline.html`（主控运行行 `weightsPath` 输入框与 `curWeightsPath()`、运行弹窗 `pipelineRunWeightsPath` 继承/覆盖、`runPipeline`/`startRun`/`startSimRun` 透传快照、`execScript`/`substRunVars`/`runUrlStep` 注入与占位池、`submitServerRun`/`buildSuffixPlan` 上送服务端、历史记录与重放、`saveRunSelLS` 持久化与状态缓存回写、导入导出 local 块、设置页说明与 API 弹窗文案）；`src/index.ts`（API `weightsPath` 校验与计划携带、`execPlan` runCtx/historyRecordFor、`runStageScript` 取值池与环境注入、`serverRunVariables`）；`projects/pipeline/scripts/README.md`（自动注入变量表补 `MODEL_PATH`/`PIPELINE_PRESETS` 两行）。测试——新增 `projects/pipeline/tests/test_run_weights_path.js` 8 例（execScript 注入与三级优先级、substRunVars 解析与未解析形态、runPipeline 取数/显式空串覆盖、运行弹窗继承与覆盖、静态契约）；`tests/pipeline-run-api.test.mjs` 新增 2 例（API weightsPath 传递/缺省/空串/非法 400、runStageScript 注入与优先级）并扩展拒绝矩阵；`test_pipeline_run_dialog.js`/`test_pipeline_api_ui.js`/`test_config_import_export.js`/`test_settings_server_keys.js` 同步 weightsPath 期望，`test_node_lease.js`/`test_node_reservations.js`/`test_pipeline_defaults.js`/`test_queue_finished.js`/`test_queue_item_preview.js`/`test_run_autofocus.js`/`test_run_settings_snapshot.js` 沙盒补 curWeightsPath 桩与 submitServerRun 请求体期望；全量 npm test 477（tests）+ 883（projects JS）+ shell + python 0 失败；Playwright headless 实测（lihaifeng 登录、link 安装 worktree 构建并重启、测后恢复原安装与运行现场）18/18：登录、运行行输入框与可选占位、预设勾选按钮文案、pip-weightsPath 仅本地持久化、本地链路点「▶ 运行流水线」print-env 阶段归档日志含 `MODEL_PATH=/models/e2e-weights` 与 `PIPELINE_PRESETS=["profiling"]`、运行弹窗继承与覆盖、API 弹窗请求体携带、服务端链路（sched 阶段经 submitServerRun/execPlan）归档日志同样含两个注入、测后共享配置清理无残留、全程无页面 JS 错误，截图复核排版。影响范围——流水线运行参数链路：主控运行行、运行弹窗、运行 API（新增可选字段，旧调用方不传行为完全不变）、运行历史记录（新增 weightsPath 字段，旧记录无此字段按不注入处理）与导入导出 local 块（旧文件无 weightsPath 键保持当前值）；阶段显式参数/上游产出优先语义不变，未填写权重路径与未勾选预设时注入行为与此前完全一致（MODEL_PATH 不注入、PIPELINE_PRESETS 为 `[]`）；定时页表单未加该字段（页面登记的定时计划不带 weightsPath，如需另行扩展）。

- 改进**Profiling 页 Perfetto 大 trace：内嵌上限 1GiB→2GiB（实测 1.3GB 全链路可开），超限给「下载到本地拖入 Perfetto」兜底；`/api/worktable/file` 新增 raw=1 流式**（`projects/profiling/index.html`、`src/index.ts`、`tests/file-tail.test.mjs`、`projects/profiling/index.test.cjs`）：问题背景——用户实测 1.29GB trace 点「在 Perfetto 中打开」报「trace 超过 1GiB…建议降采样或切分」：1GiB 是初版的保守上限，且服务端 /file 全量读另有 256MB 上限（413 file too large），大 trace 实际受两道拦截；另发现读取失败后晚到的握手 PONG 会把错误状态覆盖成「握手完成，传输 trace…」并永远停住（假进行中）。解决方案——①实证放宽上限：本地 File 直读 1.3GB（820 万事件）实测 postMessage 投递 + trace_processor_memory64 解析 + 时间线渲染全程约 52s 无错误，上限放宽到 2GiB；本地非压缩文件按 File.size 前置拦截（免整份读入内存再报错）；②超限兜底：报「trace 超过 2GiB…」错误并点亮「下载到本地」按钮——本地 File 直接给 blob URL、服务端路径走 /file raw=1 同源下载，点击后自动打开 ui.perfetto.dev 窗口并提示拖入（Perfetto 本地文件打开不经 postMessage，无多份内存拷贝，支持 .gz）；③服务端 /file 新增 raw=1 流式模式（createReadStream 背压输出、服务端不整份驻留内存、不受 256MB 全量读上限约束，保留 content-length 与 x-worktable-file-size 响应头），api.fileBuffer 与下载链接同走 raw=1；④读取失败即 dispose 握手会话并置 perf.failed 守卫，晚到 PONG 不再覆盖错误状态；⑤「已发送」状态对 >512MB 大文件附「解析可能需要数分钟」提示。改动点——`index.html`（PERFETTO_MAX_BYTES 放宽 2GiB、perfOversizeError 与本地 File 前置拦截、perfDownloadBtn 按钮 markup 与下载+开窗引导、api.fileBuffer 走 raw=1、perf.failed 守卫与失败 dispose、大文件解析提示、页头说明补 2GiB 口径）；`src/index.ts`（/file 路由 raw=1 流式分支）；`tests/file-tail.test.mjs`（vm 上下文补 createReadStream/fsStat，新增 2 例：raw=1 绕过 256MB 上限且不经过 readLocalFile、目录路径 404）；`index.test.cjs`（静态契约补 2GiB/oversize 标记/下载按钮/raw=1/perf.failed 断言）。测试——单测 profiling 21 例 + file 路由 6 例全过；全量 npm test 477（tests）+ 866（projects JS）+ shell + python 0 失败；Playwright 实测（lihaifeng 登录，link 安装 worktree 构建并重启，测后恢复原 link 与运行现场）：1.3GB 本地文件全链路（载入 1.0s → 投递 8.6s → canvas 渲染 33.2s，帧标题含 trace 名与 1396 MB）、1.3GB 服务端文件经 raw=1 全链路（汇总 19s → 投递 27.2s → 渲染 52.3s）、超限兜底 11/11（页内构造 2.06GiB File 前置拦截报超限、下载按钮出现、点击触发下载与弹出 Perfetto 窗口、引导文案、12s 后状态不被晚到 PONG 覆盖）、既有 30 项回归全过；curl 实测 raw=1 下载 1.3GB 约 1s 完成且与磁盘字节级一致、非 raw 仍 413。影响范围——/file 新增 raw=1 opt-in 参数（默认路径与 256MB 上限不变）；profiling 页 Perfetto 内嵌传输上限 1GiB→2GiB、超限时从纯报错变为报错+下载兜底引导；页面其余功能与其余 API 行为不变。

- 改进**环境多选面板：可用节点排最前（预留给自己 → 未分配 → 预留给他人）+ 筛选行（预留给我/未分配、GPU 空闲）+ 面板宽高自适应**（`projects/pipeline/pipeline.html`）：问题背景——运行流水线选择环境时，候选节点按登记原序平铺：预留给他人（不可选）的节点与可用节点混排，节点一多要先翻过不可用节点找可用的；只能靠肉眼分辨预留徽标，没有「只看可用 / 只看 GPU 空闲」的过滤手段；且面板固定 min-width:230px / max-height:230px，节点名 + IP + GPU 卡数 + 预留徽标一行放不下，换行或截断后关键信息（预留给谁、到几点）看不全。解决方案——① 候选列表按可用分组稳定排序（`envAvailGroup`/`envMultiAvailSort`：当前生效预留含我=0 → 无生效预留=1 → 预留给他人=2，组内保持节点原序；无预留函数/登录全局的 vm 桩环境按未分配退化，与 `envReservedForOthers` 的守卫口径一致），预留给自己的与未分配的永远排最前；② 搜索框下新增筛选行（同属 sticky 置顶区）：「预留给我 / 未分配」「GPU 空闲」两个复选框可单独或同时勾选（同时勾选取交集；`envMultiListFilterMatch`/`envMultiGpuIdle`，GPU 空闲严格取「已查询、未失败、无占用」，未查询/查询失败不列入），只过滤候选列表、不动已选区与勾选态；筛选状态按面板实例隔离（`envMultiListFilter`）、与搜索词同为会话内状态不持久化；搜索 input 的行显隐判定叠加筛选谓词；③ 四处环境多选面板（主控/定时页/编辑器默认环境/运行弹窗）统一改为 `width:max-content;max-width:min(92vw,880px)`（候选行 `white-space:nowrap`，一个节点的名称/IP/GPU/预留徽标一行显示全，超出上限横向滚动）+ `max-height:min(60vh,560px)`（原 230px）。改动点——`projects/pipeline/pipeline.html`（四处面板 style、`envMultiListFilter` 状态与 `envAvailGroup`/`envMultiAvailSort`/`envMultiGpuIdle`/`envMultiListFilterMatch` 新增、`renderEnvMulti` 筛选行渲染与候选列表排序/过滤/行 nowrap、搜索 handler 叠加筛选、注释更新）。测试——新增 `projects/pipeline/tests/test_env_multi_avail_first.js` 8 例（四处面板宽高与筛选行静态契约、三分组语义与守卫退化、GPU 空闲五态、分组排序与徽标保留、筛选行默认不勾选/勾选过滤/取消恢复/不写勾选态、GPU 空闲筛选与空提示、两筛选交集、搜索×筛选叠加、筛选按面板实例隔离）；`test_env_selection_default_none.js`/`test_node_reservations.js` 的 vm 抽取清单与上下文补新函数与 `envMultiListFilter` 桩；全量 npm test（tests + projects JS 875 + shell + python）0 失败；Playwright headless 实测（lihaifeng 登录，worktree 页面经 /api/worktable/site 直开，添加 __avail_a__/b/c 三节点 + reservations API 铺 a→lihaifeng/b→demo/c 不预留，测后清理无残留）21/21：候选序与独立核算期望序逐一一致、铺数节点相对序 a（我）<c（未分配）<b（他人）、预留给他人带徽标、筛选行两框在场、avail/gpuIdle/交集/取消恢复各态与期望集一致、未查询节点不进 GPU 空闲、面板 max-height≥400px、行 nowrap、scrollWidth≤clientWidth 不裁剪、宽度随内容>300px、运行弹窗面板同规格、全程无页面 JS 错误，截图复核。影响范围——四处环境多选面板的候选排序/筛选与面板宽高；勾选/取消/已选区排序调序/按钮文案与 ids 写回、TARGET_IP/TARGET_IPS 注入顺序、预留拦截（`envReservedForOthers`）与徽标、运行门禁与服务端 API 均不变；无预留数据或无登录身份部署行为不变（全部按未分配排序）；筛选状态不持久化，刷新页面即复位。

- 改进**Profiling 页 Perfetto 打开：握手等待期间状态栏逐秒计时提示，消除「读取 trace…」假卡死**（`projects/profiling/index.html`、`projects/profiling/index.test.cjs`）：问题背景——「在 Perfetto 中打开」点击后，trace 读取（本地小文件毫秒级）很快完成，但随后 PING/PONG 握手要等 ui.perfetto.dev 首载完成（其消息处理器需 document.readyState=complete 含全部子资源、且 checkHttpRpcConnection 探测结束后才注册），慢网/代理下实测首载 49s、WASM 引擎再 71s，期间状态栏一直停在「读取 trace：xxx（199 B）…」——199 字节文件「读」了近一分钟，没有任何等待提示，用户误以为卡死。解决方案——新增握手等待计时（`perfWaitBegin`/`perfWaitStop`）：投递完成但握手未就绪时，状态栏改为「等待 Perfetto UI 就绪… 已等待 Ns（首次加载需下载数十 MB 前端资源，慢网/代理下可能超过 1 分钟；若失败可点「重试」）」并逐秒刷新；握手完成/投递成功/超时失败/关闭模态框各路径即时停止计时；状态栏同步挂 title，单行省略显示时悬停可见完整文案。计时文案刻意避开「超时」字样（真实超时错误「等待 Perfetto UI 响应超时…」独占该词），等待中不被误判为失败态。改动点——`index.html`（`perfStatus` 挂 title；新增 `perfWaitBegin`/`perfWaitStop`；`openPerfettoForCurrent` 的 onState ready/send/error 三态、`perfettoSendCurrent` 投递后未就绪接线、`closePerfetto` 停止计时）；`index.test.cjs`（静态契约补 perfWaitBegin/perfWaitStop/等待计时文案/投递后接线断言）。测试——`index.test.cjs` 21 例全过（PERFETTO-BRIDGE 自包含段未改动，既有握手会话用例不受影响）；全量 npm test 475（tests）+ 866（projects JS）+ shell + python 0 失败；Playwright 实测：真实网络（无镜像路由）8/8——状态从「读取 trace…」进入「等待 Perfetto UI 就绪… 已等待 0s」并逐秒递增（0s→3s）、握手+投递成功、Perfetto 帧时间线 canvas 渲染、Esc 关闭、无页面 JS 错误；本地镜像路由回归 30/30（本地 plain/gzip、服务端文件经 api.fileBuffer、弹出窗口独立投递、非 trace 无按钮、路由 abort 模拟不可达→「响应超时」降级→重试复用字节缓存成功、全程无页面 JS 错误），截图复核。影响范围——仅 profiling 页 Perfetto 模态框的状态栏文案与计时；握手协议、取数链路、90s 超时阈值、重试/弹出/Esc 行为均不变；插件服务端代码与 API 零改动。

- 改进**节点预留分配弹窗：已结束（已经过）的时段整行置灰 + 首行「（已结束）」标识**（`projects/pipeline/pipeline.html`）：问题背景——节点页「预留」列此前已对已过时段整行置灰并在备注格后缀「（已结束）」，但「分配」弹窗里的时段列表不做区分：已经结束的历史时段与生效中/未来时段长得一模一样，管理员打开弹窗管理预留时只能靠逐个看日期分辨哪些已过，节点多、时段多时容易误改历史时段。解决方案——`renderNodeResWindows` 为每个时段行按「end ≤ 当前时刻」（`Date.parse` 该行结束输入框的 datetime-local 本地值；未填/非法不置灰）判定已结束：命中则整行 `opacity:.55` 置灰、首行「结束」旁显示 muted「（已结束）」标识（`data-res-past`）、行悬停提示「该时段已结束」，与「预留」列的已结束置灰同一视觉语言；开始/结束输入框的 change 事件即时重估（原地改样式，不整行重绘、不打断编辑）；只读形态（非 admin）同样置灰（纯展示语义）；生效中/未来/新建空时段不置灰。改动点——`projects/pipeline/pipeline.html`（`renderNodeResWindows` 新增 `pastTag` 标识与 `applyPastStyle` 重估、mkTime 的 change 接线、函数注释更新）。测试——`projects/pipeline/tests/test_node_reservations.js`：静态契约补 renderNodeResWindows 含 `data-res-past`/置灰/「（已结束）」断言；新增功能用例 1 例（已结束整行置灰 + 标识 + 悬停提示，生效中/未来/未填三态不置灰，结束改为已过即时置灰、改回未来即时恢复）；全量 npm test 475（tests）+ 866（projects JS）+ shell + python 0 失败。Playwright headless 实测（lihaifeng 登录，worktree 页面经 /api/worktable/site 直开，reservations API 铺设 已结束/生效中/未来 三时段、测后恢复原样）15/15：弹窗已结束行 opacity 0.55 +「（已结束）」可见 + 悬停提示，生效中/未来行正常，结束改为已过即时置灰且为同一行元素原地更新（无重绘）、改回未来即时恢复，「预留」列已结束置灰/生效中高亮/未来普通三态回归不变，测后恢复，全程无页面 JS 错误，截图复核置灰效果。影响范围——仅节点预留分配弹窗的时段行展示；预留数据结构、保存校验（历史时段仍可编辑/删除）、读写 API、「预留」列展示、环境多选面板徽标与运行门禁均不变；存量预留数据无需迁移。

- 新增**节点环境可选字段「LLM服务地址（IP:端口）」，节点页「K8s InternalIP」改名「内网IP」**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——节点环境的「K8s InternalIP」用词偏实现侧（用户心智是「内网 IP」，日常沟通与工单都这么叫）；且各节点上 LLM 服务的访问地址（IP:端口）没有登记处，评估/诊断/压测类脚本要访问已部署服务只能把地址硬编码进脚本参数或翻部署产物，换节点就要改脚本。解决方案——① 节点页表单占位、列表表头、校验提示与说明行里的「K8s InternalIP」统一改名「内网IP」（title 与说明行仍注明即 Kubernetes 节点 InternalIP；数据键 `nodeIp` 不变，存量配置零迁移）；② 节点新增可选字段 `llmAddr`（LLM服务地址，IPv4:端口 校验，如 192.168.31.175:8000）：添加/编辑表单输入框、节点列表新列（内网IP 列之后）、编辑回填、复制携带、节点页筛选与环境多选面板搜索均可按其命中；与 nodeIp 同范式进入 `normalizeEnv` 规范字段与 `sameEnvEntry`/服务端 `sameEnvironmentContent` 三方合并比对（仅改 llmAddr 也算本端改动，多浏览器并发保存与自愈重拉不丢、他端修改照常同步）；运行时与 `TARGET_NODE_IP_MAP` 同口径自动生成 **`TARGET_LLM_ADDR_MAP`**（SSH 地址 → LLM服务地址 的 JSON 映射，仅含填了的节点、全部未填则整体不注入、脚本显式同名参数优先），页面本地执行（`execScript`）与服务端执行（`runStageScript`）双端同形注入，scripts/README.md 自动注入变量表同步补两行。顺带修复：节点「复制」副本此前丢 `nodeIp`（现连同 `llmAddr` 一起携带）。改动点——`projects/pipeline/pipeline.html`（表单 `envLlmAddr` 输入框与校验、表头/说明/筛选占位改名与新列、`normalizeEnv`/`sameEnvEntry`/`envFilterMatch`/`envMultiFilterMatch`/`renderEnvs`/`startEnvEdit`/`resetEnvForm`/`saveEnvForm`/`copyEnv`、`execScript` 注入）；`src/index.ts`（`sameEnvironmentContent` 规范字段 +`llmAddr`、`runStageScript` 注入）；`projects/pipeline/scripts/README.md`（注入变量表补 `TARGET_NODE_IP_MAP`/`TARGET_LLM_ADDR_MAP`）。测试——新增 `projects/pipeline/tests/test_env_llm_addr.js` 9 例（静态契约、归一/比对含 llmAddr、表单校验四态、编辑回填与复制携带、筛选与面板搜索命中、行渲染、注入与显式参数优先）；`test_env_server_merge.js` 新增 llmAddr 三方合并 1 例；`tests/pipeline-config-concurrency.test.mjs` 新增 llmAddr 规范字段敏感性 1 例 + `runStageScript` 注入源码契约 1 例；`test_config_import_export.js`（导入导出保留 llmAddr）、`test_env_info_refresh.js`/`test_refresh_spin.js`（normalizeEnv 桩同步）、`test_env_selection_default_none.js`（面板搜索补内网IP/LLM 命中）、`test_node_reservations.js`（pageNode 契约含 `envLlmAddr` 与新表头）同步；全量 npm test 475（tests）+ 852（projects JS）+ shell + python 0 失败。Playwright headless 实测（lihaifeng 登录、link 安装 worktree 构建并重启、测后恢复原安装与运行现场）22/22：表头/占位/说明文案、非法地址 alert 拦截两态、添加-行渲染-服务端落盘、仅改 llmAddr 编辑经三方合并落盘、副本携带、节点筛选与多选面板搜索命中、测后清理无残留、全程无页面 JS 错误，截图复核排版。影响范围——节点环境的展示文案与可选元数据；`nodeIp` 仅 UI 改名（数据键与 `TARGET_NODE_IP_MAP` 语义不变）；未填 llmAddr 的节点行为与此前完全一致（不注入 `TARGET_LLM_ADDR_MAP`）；运行历史 `envNodes` 契约（name/ip/nodeIp）与预留、租约、运行门禁均不变；存量配置与导入导出文件无需迁移。

- 新增**Profiling 页「在 Perfetto 中打开」：trace 一键内嵌 ui.perfetto.dev 交互式时间线**（`projects/profiling/index.html`、`projects/profiling/index.test.cjs`）：问题背景——Profiling 页对 Chrome/PyTorch trace 只有聚合表/瀑布/ECharts 静态视图与内核三表分析，缺少交互式时间线（缩放、选中 slice、SQL 查询、按流/线程分轨），深挖单段抖动或跨流时序只能把 trace 文件下载再手动拖到 ui.perfetto.dev。解决方案——按 Perfetto 官方 deep-linking 协议（`post_message_handler.ts`）集成 iframe 内嵌打开：概览卡对 trace 条目（非二进制报告、已解析出 traceEvents 或文件名形如 *.trace.json[.gz]）出现「在 Perfetto 中打开」按钮，点击弹近全屏模态框加载 ui.perfetto.dev iframe，页面周期 PING、UI 就绪回 PONG 后 postMessage 投递 `{perfetto:{buffer,title,fileName,keepApiOpen:true}}`——trace 仅经 postMessage 进浏览器内存，不上传任何服务器，天然绕开 `/api/worktable/file` 的认证/CORS 问题（页面同源自取字节再投递）。握手超时 90s（Perfetto 的消息处理器要等 readyState=complete 含全部子资源、且 checkHttpRpcConnection 探测结束后才注册，慢网/代理首载实测需 20s+，PING 持续重试不受影响）。trace 取数三态：本地 File 直读原始字节（条目新增 `file` 引用）、服务端经新增 `api.fileBuffer` 原始字节（跳过文本解码）、仅有内存数据时重建 JSON；gzip 自动解压并剥 .gz 后缀；>1GiB 拦截提示降采样；非回环地址访问时提示 Perfetto 侧会弹 "Open trace?" 信任确认（isTrustedOrigin 仅豁免 localhost/127.0.0.1/[::1]）；中文标题经 pfAscii 预清洗（Perfetto sanitizeString 会把非 ASCII 逐个洗成空格）。模态框支持 Esc/关闭按钮、失败重试（保留已读字节缓存只重建 iframe+握手）、弹出到新窗口（独立握手会话复用字节）。改动点——`index.html`（==PERFETTO-BRIDGE== 自包含段：PERFETTO_ORIGIN / isPerfettoTraceName / perfettoEligible / pfAscii / buildPerfettoTraceMessage / perfettoNeedsTrustHint / createPerfettoSession；perfModal 模态框 markup 与 pf-modal 样式；api.fileBuffer；本地条目保留 File 引用；renderOverview 入口按钮与接线；openPerfettoForCurrent / perfettoSendCurrent / perfettoTraceBuffer / closePerfetto 与关闭/重试/弹出/Esc 绑定；页头说明补 Perfetto）；`index.test.cjs`（新增 6 例）。测试——`index.test.cjs` 21 例全过（新增：trace 名判定与条目资格（含二进制报告排除）、pfAscii/信任提示/消息体形态、握手会话 PING 立即+周期与 PONG 来源/origin/数据三重过滤、send 握手前排队+就绪补投+同会话多次投递、超时 error 自清理与 dispose 后拒发、静态契约）；全量 npm test 473（tests）+ 846（projects JS）+ shell + python 0 失败；Playwright 实测 30/30（lihaifeng 登录、worktree 页面经 /api/worktable/site 直开；ui.perfetto.dev 静态资源经本地镜像回放——本机代理对 WASM 流式加载偶有截断，镜像只替代静态托管、仍跑真实 Perfetto UI 代码）：本地 plain/gzip（自动解压剥 .gz）与服务端文件（trace_summary.py 汇总 + api.fileBuffer 原始字节）三条链路握手投递成功、Perfetto 帧标题变为 trace 名且时间线 canvas 渲染、无信任弹窗与崩溃弹窗、Esc 关闭、Esc 后换条目重开、弹出窗口独立投递、非 trace 条目无按钮、路由 abort 模拟不可达时 90s 超时降级 + 重试复用字节缓存成功、全程无页面 JS 错误；截图复核模态框与弹出窗口的时间线渲染。影响范围——仅 profiling 项目页；流水线 JSON / nsys·ncu 二进制 / 日志文本路径不变；插件服务端代码与 API 零改动；ui.perfetto.dev 不可达时仅该入口降级（超时提示 + 重试），页面其余功能不受影响。

- 修复**阶段详情「🔍 AI 分析」提示词的日志路径指向运行级归档文件夹而非本阶段日志文件**，并将该按钮提示词纳入设置页「分析配置」（`projects/pipeline/pipeline.html`）：问题背景——阶段详情「日志文件」行展示的是本阶段归档日志文件（`run-<tag>-NN-阶段名.log`），但行内「🔍 AI 分析」复用运行历史标题行的运行级 `log` 模板，提示词给 AI 的是「完整日志文件夹：{archive}」——从阶段详情发起分析时 AI 拿到整次运行的目录，定位不到本阶段日志（路径与详情行展示的不一致），且该入口的提示词形态在设置页没有独立配置项。解决方案——阶段详情按钮改为**阶段级分析**：新增 `stage` 提示词模板（`DEFAULT_PROMPTS.stage`，占位符含 `{summary}`/`{archive}` 等运行级变量与新增的 `{stage}` 阶段名、`{stageLogFile}` 本阶段归档日志文件路径；文件不存在时引导改读归档文件夹下汇总日志与其它任务日志）；`buildAnalysisPrompt(kind, rec, extra)` 支持调用方注入额外占位符（可覆盖同名内置变量），`buildAnalysisRequest`/`createAnalysisChat` 透传（仅单运行分析生效，双运行对比不注入）；`appendStageLogRow(kv, stage, path, rec)` 收阶段对象，点击把当前阶段与「日志文件」行展示路径交给 `stageDetailAnalysis` 注入模板（无路径时 `{stageLogFile}` 降级为「（未归档）」）；会话 cwd 仍取该次运行归档目录（AI 可读同目录其它任务日志）；按钮 title 同步为阶段级口径。设置页「分析配置」新增「阶段日志分析」编辑框（#cfgPromptStage），`fillCfgForm`/`cfgSave`/`cfgReset` 接线，`analysisPrompts` 落 localStorage 与服务端配置的通道复用既有合并逻辑（`Object.assign({}, DEFAULT_PROMPTS, …)`，旧配置无 `stage` 键自动回落内置默认，无需迁移）；卡片标题/说明与占位符文档同步。改动点——`projects/pipeline/pipeline.html`（`DEFAULT_PROMPTS.stage`、`buildAnalysisPrompt`/`buildAnalysisRequest`/`createAnalysisChat` 增 extra 透传、`appendStageLogRow` 签名与按钮 title、`stageDetailAnalysis` 改 stage 模板 + extra、`renderDetail`/`renderReplayDetail` 两调用点、分析配置卡片与三个接线函数）。测试——`projects/pipeline/tests/test_stage_detail_log_row.js`：`stageDetailAnalysis` 用例改断言 `(stage,[rec],{stage,stageLogFile})` 三参发起、无路径降级「（未归档）」、无记录仍 alert 不发起；`appendStageLogRow` 三调用点签名更新，新增「点击把当前阶段与展示路径交给 stageDetailAnalysis」用例；新增静态契约（`DEFAULT_PROMPTS.stage` 含 `{stage}`/`{stageLogFile}`、#cfgPromptStage 编辑框与回填/收集接线）。`projects/pipeline/tests/test_history_analysis_compare.js` 新增 4 例（extra 占位符注入与 cwd 仍取运行归档目录、extra 缺省时占位符原样保留、双运行对比不注入 extra、extra 覆盖同名内置变量）。全量 npm test 473（tests）+ 849（projects JS）+ shell + python 0 失败；Playwright headless 实测（lihaifeng 登录，worktree 页面经 /api/worktable/site 直开，父页新桥桩捕获会话文本）21/21：回放态阶段详情点「🔍 AI 分析」提示词含本阶段日志文件绝对路径与「分析阶段：检出」、cwd 为运行归档目录、历史标题行入口回归仍为运行级提示词、设置页「阶段日志分析」编辑框默认填入内置模板、自定义模板保存后服务端配置/localStorage/内存三处生效并实际作用于按钮、「恢复默认」回到内置模板且原 log/prof/perf 内容不受破坏、全程无页面 JS 错误。影响范围——阶段详情「日志文件」行「🔍 AI 分析」按钮生成的提示词从运行级变为阶段级（含本阶段日志文件路径）；运行历史标题行三个分析按钮与 A/B 对比、会话创建桥、归档写入路径均不变；`analysisPrompts` 配置新增 `stage` 键，旧页面读写该配置时忽略此键（保存时按三个编辑框重建会丢弃 `stage` 自定义，语义等价回落默认）。

- 改进**快捷时段推次日规则：当天该时段结束已过才推次日**（`projects/pipeline/pipeline.html`）：问题背景——PR #174 的快捷时段在「未填开始日期」时按「当天该时段开始时间已过」推次日：上午 10 点点 9~14 也会给明天，但当天 9~14 要到 14 点才结束，该时段仍覆盖当前时刻，是有效的进行中预留，推次日反而违背直觉（想预留「现在到 14 点」还得手工改回今天）。解决方案——`quickResRange` 回滚判定从「开始已过」改为「结束已过」：未填日期时仅当 `now >= 当天该时段结束时刻`（含跨零点时段的次日结束时刻）才推次日；开始已过但结束未过仍给当天（时段覆盖当前）。22~9 的结束恒在次日 09:00，「当天」视角下永不推次日（如 23 点点 22~9 给当天 22:00 ~ 次日 09:00，正是当前夜班时段）。按钮 title 文案同步为「当天该时段已结束才取次日」。改动点——`projects/pipeline/pipeline.html`（`quickResRange` 判定 + 注释、快捷按钮 title）。测试——`projects/pipeline/tests/test_node_reservations.js` 的 quickResRange 用例更新到新规则并扩到 9 断言（15:30 点 9~14 推次日、10:00 点 9~14 仍给当天、14:00 整点边界（T==end 不覆盖）推次日、23 点点 22~9 给当天跨零点等）；全量 npm test 473（tests）+ 842（projects JS）+ shell + python 0 失败；Playwright headless 实测（lihaifeng 登录，worktree 页面直开）10/10：固定日期四档回填不变、未填日期点 9~14 按「当天结束已过才推次日」回填（实测上午点给当天）、22~9 恒给当天 22:00 ~ 次日 09:00、无页面 JS 错误。影响范围——仅快捷时段按钮在未填开始日期时的默认日期选择；已填日期的覆盖行为、四档整点口径、保存校验与预留读写均不变。

- 新增**节点预留分配弹窗的 4 个快捷时段（9~14 / 14~19 / 19~22 / 22~9）**（`projects/pipeline/pipeline.html`）：问题背景——分配节点预留时最常见的诉求就是「今天白班/下午班/晚班/夜班到明早」这类整点时段，但此前只能逐个手填开始/结束两个 datetime-local（选日期、选时间，点好几下），重复且易错。解决方案——时段行「开始/结束」旁新增「快捷」按钮组 9~14 / 14~19 / 19~22 / 22~9，一键回填该行的开始与结束。纯函数 `quickResRange(baseStart, sh, eh, nowMs)` 统一口径：整点取整（sh:00 ~ eh:00）；22~9 跨零点、结束落次日 09:00；已填开始日期时保留该日期仅覆盖时间；未填开始日期取今天、当天该时段开始时间已过则推到次日，保证给出的总是将来时段。点击后整行重绘回填输入框；只读形态（非 admin）无快捷按钮。改动点——`projects/pipeline/pipeline.html`（新增 `quickResRange`；`renderNodeResWindows` 第一行「结束」后插入快捷按钮组 `data-res-quick`）。测试——`projects/pipeline/tests/test_node_reservations.js` 新增 2 例：`quickResRange` 纯函数 7 断言（四档整点、跨零点次日、未填日期当天已过/未过两态、23 点点 22~9 的双重次日、已填日期保留）与弹窗交互（只读无快捷按钮、admin 四档齐全按序、点 22~9 回填次日、点 9~14 回填同日）；全量 npm test 473（tests）+ 842（projects JS）+ shell + python 0 失败。Playwright headless 实测（lihaifeng 登录，worktree 页面直开，无预留节点纯本地弹窗交互、不保存不写服务端）9/9：四档按钮齐全按序、固定日期逐档回填精确值（含 22~9 结束次日）、未填日期点 22~9 按「今天已过则次日」规则回填、取消关闭、无页面 JS 错误，截图复核按钮组排版。影响范围——仅预留分配弹窗时段行的填充交互（按钮回填输入框，等价于手填）；预留数据结构、保存校验、读写 API、「预留」列展示与运行门禁均不变；存量数据无需迁移。

- 改进**节点预留分配弹窗：用户选择从全量复选列表改为「搜索框 + 标签」**（`projects/pipeline/pipeline.html`）：问题背景——分配弹窗每个时段行把 /auth/users 的全部用户名平铺成复选框，用户一多整屏都是勾选项，找人要靠肉眼扫；且另有独立的「手动添加用户」行把候选外用户名加入候选，两种添加入口并存。解决方案——时段行的用户选择改为标签输入：已选用户显示为可删标签（×），搜索框输入即时过滤候选下拉（候选 =（/auth/users 缓存 || 回退集）∪ 该行已选，已选不再重复出现），点击候选/回车选中；逗号（半角/全角，含分号）即时把前段提交为标签，一次可逗号分隔输入多个；候选外的用户名直接输入即可提交（原「手动添加用户」行随之移除）；添加/选中只做局部 DOM 追加、不整行重绘，输入框焦点保持可连续添加；失焦提交框内剩余输入防直接点保存丢失。只读形态只展示标签、无搜索框与移除按钮。改动点——`projects/pipeline/pipeline.html`（`renderNodeResWindows` 第二行复选列表 → chipsWrap 标签 + `data-res-user-search` 搜索框 + `data-res-candidate` 下拉；弹窗底栏移除 `nodeResManualUser`/`nodeResManualAdd` 行与其尾部绑定；`nodeResEdit` 去 `manualUsers` 字段；回退提示文案同步）。测试——`projects/pipeline/tests/test_node_reservations.js`：静态契约改断言搜索框/候选/标签三件套在场且无复选框与手动添加行；只读弹窗改断言标签展示 + 无搜索框/移除按钮；保存用例改走搜索框（回车选中 u2、全角逗号即时提交 u3、末段留框继续编辑、失焦提交 u4、标签 × 移除）并校验 PUT body users；回退用例改断言已选为标签、不重复进候选、候选含当前用户、候选外用户名可直接输入添加；全量 npm test 473（tests）+ 840（projects JS）+ shell + python 0 失败。Playwright headless 实测（lihaifeng 登录，worktree 页面直开，无预留节点全程真实操作、测后清空恢复）17/17：弹窗无复选框与手动添加行、新时段默认当前用户标签、聚焦出候选、子串过滤、点选加标签且焦点保持、逗号一次提交多个（含候选外）、× 移除、保存后预留列显示所选用户与备注、无页面 JS 错误，截图复核弹窗排版。影响范围——仅节点预留分配弹窗的用户选择交互；预留数据结构、读写 API、base/409 并发语义、「预留」列展示、多选面板徽标与运行门禁均不变；存量预留数据无需迁移。

- 改进**节点页「预留」列：去掉「预留中」文字前缀（生效中仅整行高亮），时间段/用户/备注三列网格对齐**（`projects/pipeline/pipeline.html`）：问题背景——上一轮逐时段明细里生效中行带「预留中 · 」文字前缀，把该行的时间段顶得比其他行靠右，各行左缘不齐；且「时间段 · 用户 · 备注」用 · 拼接成一行文字，用户名单长短不一时各行的用户/备注起点对不齐，扫读费劲。解决方案——① 生效中时段去掉文字前缀，仅整行高亮（st-run 色 + 600 字重，title 仍注明「当前生效的预留时段」），各行左缘恢复对齐；② 每时段从单行文本改为三列网格（`display:grid; grid-template-columns:auto auto 1fr`，列间隙 10px）：时间段列 | 用户列 | 备注列，列宽取该列最宽格，跨行竖向对齐；已结束时段整行置灰、（已结束）后缀移到备注格。改动点——`projects/pipeline/pipeline.html`（`envResSummaryHtml` 行结构 div 文本行 → 网格三格 span，去前缀，注释更新）。测试——`projects/pipeline/tests/test_node_reservations.js` 两个预留列用例同步为三列结构断言（生效中三格整行高亮且无「预留中」文案、时间段/用户/备注格内容、未来时段两时段 × 三格普通样式、已结束整行三格置灰 + 备注格后缀、升序、无预留 —、分配按钮在位）；全量 npm test 473（tests）+ 840（projects JS）+ shell + python 0 失败；Playwright headless 实测（lihaifeng 登录，worktree 页面经 /api/worktable/site 直开，reservations API 铺设 已结束/生效中/未来 三时段、测后恢复）16/16：3 行 × 3 格、时间段格式、升序、无「预留中」前缀、已结束三格置灰带后缀、生效中三格 st-run 高亮含多用户与备注、未来行普通样式、**时间段列/用户列/备注列跨行左缘 x 坐标逐列一致**、分配按钮在位、测后恢复、无页面 JS 错误，截图复核 BNT120（三时段）与 BNT140（存量两时段）列对齐效果。影响范围——仅节点页「预留」列的展示结构（文本行 → 三列网格）与生效中标识方式（文字前缀 → 纯高亮）；预留读写 API、分配弹窗、多选面板徽标、运行门禁均不变；存量数据无需迁移。

- 改进**节点页「预留」列逐时段一行展示（时间段 · 用户 · 备注）**（`projects/pipeline/pipeline.html`）：问题背景——「预留」列此前只给摘要：生效中显示「预留中：名单 · 至 结束时间」（取最早结束的合并视图），非生效中折叠为「N 个时段」——一个节点挂了多个时段时，看不到每段的完整起止、各段分别分给谁、备注写的用途，要知道细节只能逐个打开「分配」弹窗。解决方案——`envResSummaryHtml` 改为逐时段一行：每条预留记录一行 `MM-DD HH:mm ~ MM-DD HH:mm · 用户列表 · 备注`（按开始时间升序，`reservationsForNode` 既有排序），生效中时段整行醒目（st-run 色 + 600 字重）并前缀「预留中 ·」，已结束时段置灰并后缀「（已结束）」，未来时段普通样式；逐行 `white-space:nowrap` 保证一个时段一行（长内容经表格外层 overflow 横向滚动）；无预留仍显示 —，行尾「分配」按钮不变。用户名/备注等注入字段一律 esc 转义。改动点——`projects/pipeline/pipeline.html`（`envResSummaryHtml` 重写为逐时段行 + 注释更新；`envReservationInfo` 仍服务环境多选面板徽标与运行校验，不动）。测试——`projects/pipeline/tests/test_node_reservations.js` 预留列用例重写为逐时段断言（生效中行含 预留中 · 时间段 · 用户 · 备注 与醒目样式、两个未来时段各一行各带用户、不再折叠为时段数、无预留 —、分配按钮在位）并新增「已结束置灰 +（已结束）后缀 + 多时段升序排列 + 备注随行」用例；全量 npm test 473（tests）+ 840（projects JS）+ shell + python 0 失败；Playwright headless 实测（lihaifeng 登录，worktree 页面经 /api/worktable/site 直开，经 reservations API 给无预留节点铺设 已结束/生效中/未来 三个时段、测后恢复原样）12/12：逐时段一行共 3 行、每行时间段格式、升序、已结束置灰带后缀与备注、生效中带前缀且 st-run 醒目含多用户与备注、未来行普通样式、分配按钮在位、测后恢复、全程无页面 JS 错误，截图复核排版。影响范围——仅节点页节点表「预留」列的展示形态（摘要 → 逐时段明细）；预留的读写 API、分配弹窗、环境多选面板徽标、运行门禁校验均不变；存量预留数据无需迁移。

- 改进**流水线页刷新按钮点击旋转反馈 + 节点页筛选框左移**（`projects/pipeline/pipeline.html`）：问题背景——页面级刷新按钮（流水线任务/运行队列/运行历史的「↻ 刷新」、节点页「↻ 刷新节点信息」「⟳ 设备状态」）点击后只在途禁用，没有进行中的视觉反馈：请求快时像没点上，慢时（设备状态逐节点 SSH 探测、慢服务器拉取）又看不出还在转，用户容易重复点击或误以为卡死；节点页标题行用两端对齐把筛选框单独顶到最右，与左侧的标题/刷新按钮隔很远，视线来回跳。解决方案——① 新增共用的在途旋转反馈：按钮内 ↻/⟳ 图标包裹 `<span class="rf-ico">`，在途期间按钮挂 `rf-busy` 类，CSS `@keyframes pipSpin` 只旋转图标（transform 合成器属性）、文字不动；`beginRefreshSpin(btn)` 返回 stop 句柄，各处理器 try/finally 收尾摘除，最短展示 500ms 防快请求一闪而过，计数挂在按钮元素上保证重叠在途（含最短展示尾窗内再次触发）只在全部落定后摘除，无 classList 的测试桩环境静默跳过；② 「⟳ 设备状态」顺带补上在途禁用（此前连点无反馈也不禁用；逐节点行内 ⟳ 不受影响仍可单点）；③ 节点页标题行取消两端对齐，筛选框 `#envFilter` 收进 h2 紧跟「⟳ 设备状态」按钮左侧排列（DOM id 不变，筛选逻辑零改动）。改动点——`projects/pipeline/pipeline.html`（`<style>` 增 pipSpin/rf-ico/rf-busy 规则；五个按钮图标包裹 rf-ico；新增 `beginRefreshSpin`；`refreshEnvsFromServer`/`refreshPipelinesFromServer`/queueRefresh/histRefresh 绑定/`refreshGpuAll` 五处接线 spin，refreshGpuAll 改 Promise.all 等待全部节点落定并在途禁用；节点页标题行结构调整）。测试——新增 `projects/pipeline/tests/test_refresh_spin.js` 7 例（五个按钮图标包裹与 CSS 规则静态契约、五处 beginRefreshSpin/stop 接线契约、筛选框左移位置与取消两端对齐契约、beginRefreshSpin 生命周期含最短 500ms 展示与重叠在途计数、refreshGpuAll 在途禁用+旋转+全部落定恢复、refreshEnvsFromServer 在途旋转与落定 toast）；`test_env_info_refresh.js` 按钮文案断言同步 rf-ico 包裹、`test_pipeline_copy_rename.js` 与 `tests/pipeline-config-refresh.test.mjs` 的 vm 抽取清单补 beginRefreshSpin；全量 npm test 473（tests）+ 839（projects JS）+ shell + python 0 失败；Playwright headless 实测（lihaifeng 登录，worktree 页面经 /api/worktable/site 直开，路由延迟 1.2s 制造确定性在途窗口）21/21：节点页标题行 标题→刷新节点信息→设备状态→筛选框 依次向左排列且筛选框不再顶到右缘、rf-busy 时图标计算样式 animationName=pipSpin、五个按钮逐一点击均在途挂 rf-busy+图标旋转+禁用、落定后摘除恢复、全程无页面 JS 错误。影响范围——五个页面级刷新按钮的点击反馈与节点页标题行布局；各刷新路径的请求/合并/渲染逻辑不变；逐节点 ⟳ 行内按钮、导入导出弹窗的「刷新」（服务端备份列表）与分支/策略面板的 ⟳ 重新拉取不在本次范围（各有在途文案或面板级反馈）；服务端 API 零改动。

- 新增**流水线「节点」独立页签 + 节点预留（按用户 + 日期时间段分配节点）**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——节点环境管理此前混在「设置」页首张卡片，与代码仓/清理脚本/服务配置挤在一页；且节点对所有用户全时可用：某台机器要留给指定人做专项测试或占用保障时，没有任何机制能把它在一段时间内分给指定用户，其他用户照常能选能跑、只能靠口头协调，也不存在「谁能把节点分配给谁」的权限边界。解决方案——①「节点环境」卡片整体迁出设置页，成为独立页签「**节点**」（导航位于「定时」与「设置」之间；卡片 DOM id 全部不变、JS 引用零改动，设置页专注代码仓与脚本/服务配置）；②节点预留：独立服务端存储 + admin 维护 + 全员可见 + 三层运行门禁。存储为 `storages/worktable-pipeline-reservations.json`（`RESERVATIONS_STORE`，与 `PLANS_STORE` 同目录）：一条记录 = 一个节点的一个时间段（`users` 数组多用户共享时段；一个节点多条记录即多个时间段），`start`/`end` 统一 ISO UTC 落盘，覆盖判定 `Date.parse(start) <= T < Date.parse(end)`（T==start 覆盖、T==end 不覆盖）。可用性唯一口径（模块级纯函数 `reservationConflictsForEnvs`）：节点无覆盖当前时刻的预留即全员可用；有覆盖则仅名单内用户与 admin 可用（admin 全权旁路，与 owner/trusted 守卫同范式）；无 auth 服务（`resolveRequestAuth` 返回 undefined，token 共享模式）一律不强制，客户端同口径不拦截（无登录身份不误灰）。API：`GET /api/worktable/pipeline/reservations` 全量下发（不设身份门槛，认证面由 auth-gate 统一拦截）；`PUT /api/worktable/pipeline/reservations/<nodeId>`（body `{windows:[{start,end,users,note?}], base?}`）仅 admin 可写（非 admin/无会话 403，无 auth 服务放行）——nodeId 不在 environments 404、windows 非法 400（≤50 条、start<end 且可 `Date.parse`、users 非空去重 ≤50、note ≤200）、`base`（打开编辑弹窗时的窗口快照）与当前窗口规范不一致 409 回服务端全量不写盘（乐观并发，客户端据此刷新重开弹窗）、写盘时清挂已删除节点的记录、未变窗口保留原 id/createdBy/createdAt；整个读-改-写在 `withStoreLock` 内原子落盘。三层运行门禁：① 运行 API（`registerPipelineRunApi` 在 `buildPipelineApiRun` 成功后、`deps.execute` 前查 `plan.envs`，冲突 403 `{error:'reserved', message, conflicts}`；deps 新增可选 `ctx`/`readReservations` 注入，缺省不校验，旧调用方与既有抽取测试不受影响）；② 节点租约 acquire（页面本地运行 `startRun` 前必经：`ips` 按 ip 字段映射回环境节点查冲突，命中 403；页面侧 `nodeLeaseRequest` 对 403 reserved 不再抛错（抛错会被当「服务端不可达」降级照跑），改返回 `{ok:false,reserved:true}`，`startRun` alert 服务端明细并按启动失败收尾——不进入运行、不回队等待；release 等其它 action 不校验）；③ `execPlan` 兜底（定时/关页移交/已入池计划在执行开始前按计划署名 `pl.by` + `readAuthAdminUsers` 判 admin（`hasAuthService` 探测无 auth 服务跳过、envs 为空跳过），冲突则本次运行按失败落史、histLogs 带明细，不执行任何阶段；执行池 pump 的 acquire hook 排队等待语义不动）。客户端（pipeline.html）：节点表新增「预留」列（生效中醒目显示「预留中：名单 · 至 时间」、否则显示时段数或 —）与「分配」按钮；预留弹窗 `nodeResDialog`——admin 可编辑（时段增删、datetime-local 起止、`/auth/users` 复选名单 + 手动添加用户、备注，保存带 base 快照，409 自动刷新重开、403 提示），非 admin 同弹窗只读（输入全禁用、底栏只留「关闭」、标题旁注明）；四处环境多选面板（主控/定时/编辑器默认环境/运行弹窗）对被预留给他人的节点未选中态禁用并附「预留中」徽标（已选中的保留可取消勾选；admin 不拦但显示徽标；登录态探测在途不拦防误灰）；运行校验体验层（`pipelineDefaultRunIssue`/`runPipeline`/`submitPipelineRunDialog`/`addPlan`）拦截并 alert 明细，真正门禁在服务端；预留数据首屏预取 + 进「节点」页刷新 + 身份到达后重绘节点表与面板。改动点——`src/index.ts`（预留纯函数区 `normalizeReservationWindows`/`sameReservationWindow`/`reservationConflictsForEnvs`/`reservationConflictMessage`/`hasAuthService`、`RESERVATIONS_STORE`、GET/PUT 路由块、三处强制点与 deps 注入）；`projects/pipeline/pipeline.html`（导航 `navNode` 与 `switchPage` node 分支、`pageNode` 容器承接节点环境卡片、「预留」列与 `envResSummaryHtml`、`nodeResDialog` 弹窗、节点预留区块 `loadNodeReservations`/`reservationsForNode`/`envReservationInfo`/`envReservedForOthers`/`envReservationIssue`/`fmtResTime`/`isoToLocalInput`/`openNodeResDialog`/`renderNodeResWindows`/`saveNodeResDialog`、`renderEnvMulti` 拦截与徽标、四处运行校验接入、`nodeLeaseRequest` 403 形态、`fillExecutorFromAuth` 重绘与首屏预取）。测试——新增 `tests/pipeline-reservations.test.mjs` 14 例（GET 两态、PUT 非 admin/无会话 403 与无 auth 放行、admin 写盘 ISO 规范化与 users 去重、400 校验矩阵、404、base 409 回全量/一致成功/未变窗口保 id、清挂、run API 与 leases 403/放行两态、execPlan 冲突落 failed 不执行阶段、纯函数覆盖/并集/admin/边界时刻）与 `projects/pipeline/tests/test_node_reservations.js` 25 例（静态契约 navNode 顺序/pageNode 归属/TDZ 安全、预留信息数学（覆盖/并集/最早 until/边界）、admin 旁路/本人可用/他人拦截/探测在途与无登录身份不拦、运行校验明细、预留列摘要与只读弹窗、面板禁用与徽标、弹窗保存 payload 与 409/403 分支）；全量 `node --test tests/*.test.mjs` 473 例 + `npm --prefix projects test`（JS 832 例 + shell + python）0 失败；Playwright headless 实测（lihaifeng admin + 临时非 admin 用户 tmp-resv-a/tmp-resv-b，link 安装 worktree 构建，测后临时用户已禁用、预留已清空）22/22：节点标签位于设置之前与页面归属迁移、admin 分配落盘（多用户共享时段）与预留列/徽标展示、被预留本人可勾选且弹窗只读、其他用户面板禁用 + run API/租约/PUT 预留三个 403、admin 旁路可用、过期时段自动恢复可选、清空预留生效、全程无页面 JS 错误。影响范围——新增独立「节点」页签（设置页不再含节点环境卡片，节点 CRUD/设备状态/刷新节点信息功能不变）；节点预留仅 admin 可写、全员可见；处于他人预留时段的节点对其他用户在全部运行入口（页面选择/运行 API/节点租约/定时与移交计划兜底）不可用，时段外与无预留节点行为完全不变；预留数据独立存储，不进共享配置、不随「导入导出」传递、不参与 environments 三方合并；无 auth 服务（token 共享）部署行为不变；节点删除后其预留记录在下一次预留写盘时清挂。

- 修复流水线日志回显导致浏览器 CPU 冲高：脚本、预设、Jenkins/HTTP、EvalTokens 的实时详情刷新统一从 250ms 节流到 1000ms，保留服务端日志持续归档与阶段进度的轻量更新；新增高频输出节流回归测试。

- 修复**流水线队列轮询在慢服务器上堆积并发 fetch，导致日志界面 CPU 尖峰与偶尔卡顿**（`projects/pipeline/pipeline.html` `pullRemoteQueue`，对应 GitHub Issue「日志界面占用大量 CPU，开关差约 20%，偶尔系统卡顿」）：每秒 `setInterval` 触发的 `pullRemoteQueue` 此前无在途请求守卫——快照签名（`queuePollSig`）只省 `renderQueue` 的 DOM 重建、不省 `fetch` 本身，服务器响应慢于 1 秒时重叠 tick 各发新请求，N 个 `/api/worktable/pipeline/queue` 并发在途，JSON 解析与签名计算随之堆积成 CPU/连接尖峰。现照 `refreshHistoryFromServer` 的 `_historyRefreshPromise` 写法给 `pullRemoteQueue` 加 `_queuePullPromise` 在途守卫：在途时直接复用 pending Promise 不再发新 fetch，请求结束（含失败）在 `finally` 清空、下一次 tick 恢复正常轮询。`pullRemoteQueueLog`（已有 `_remoteLogPullPromise`+revision/304）与历史刷新（已有 `_historyRefreshPromise`+ETag/304）不受影响；可见性停表/补拉、签名跳过重绘等既有降耗保持不变。测试：`projects/pipeline/tests/test_queue_poll_throttle.js` 新增「在途请求复用，慢服务器上重叠 tick 不堆积并发 fetch」用例（并发 3 次 tick 只发 1 个 fetch、在途清空后恢复正常轮询）。
- 修复**多用户/多浏览器并发下「节点环境」添加的节点被他人整表保存静默覆盖丢失**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——节点环境列表随共享配置落 `worktable-pipeline.json`，保存走全量 PUT，而服务端 `mergePipelineConfigForWrite` 只对 pipelines 按 id 三方合并，environments 整表 last-write-wins：两个浏览器同时打开设置页，A 添加节点落盘后，B（页面仍是旧列表快照）添加另一个节点，B 的整表保存把 A 刚加的节点覆盖丢失（Playwright 双浏览器上下文实测复现：A 添加的节点在 B 保存后从服务端消失，A 重载页面也看不到）；页面侧 `loadServerState` 与「↻ 刷新节点信息」对 environments 同样是整表替换，409 自愈重拉会把本页刚添加未落盘的节点一并冲掉。解决方案——environments 引入与 pipelines 同范式的**按 id 三方合并**（条目级，不落 409）：① 服务端 `mergePipelineConfigForWrite` 在客户端 baseConfig 携带 environments 基线时按 id 合并（新增 `sameEnvironmentContent` 只认 name/ip/nodeIp/user/pass 规范字段，键序/历史多余字段不判 phantom 偏离）——本端未改动的条目以磁盘为准（他端并发新增/修改/删除照常保留）、本端相对基线改动的条目以本端为准、仅单边独有的条目同时保留；同 id 双边都改按「后写赢」取本端（节点是简单凭据记录，不报 409 锁死），本端在途修改被他端删除撞车时按本端复活；旧页面 baseConfig 不带 environments 键时维持整表 last-write-wins 旧行为，向后兼容；② 页面 `pushState` 的 baseConfig 增带 environments 基线（负载增量 KB 级），保存确认后按响应协调 environments 合回本页（复用通用 id 协调 `reconcilePipelinesAfterSave`，请求在途期间本页继续添加/编辑的节点不被响应覆盖）并同步 localStorage 离线缓存；③ `loadServerState` 与「↻ 刷新节点信息」对 environments 改走新增的 `mergeEnvironmentsFromServer`（口径同流水线 `mergePipelinesFromServer`：本地未落盘新增保留、他端增删改同步、双边都改取远端），409 自愈重拉不再冲掉本页刚添加的节点；手动刷新同时把基线 `serverConfigBase.environments` 推进到刚拉到的服务端快照，防后续保存按旧基线误判偏离。改动点——`src/index.ts`（`sameEnvironmentContent`、`mergePipelineConfigForWrite` 的 environments 合并段与 JSDoc）；`projects/pipeline/pipeline.html`（新增 `sameEnvEntry`/`mergeEnvironmentsFromServer`，`pushState` baseConfig 增带 environments 与保存确认协调，`loadServerState` 环境合并，`refreshEnvsFromServer` 合并 + 基线推进，注释更新）。测试——`tests/pipeline-config-concurrency.test.mjs` 新增 7 例（双端新增都保留且磁盘序在前/他端改删同步生效/本端删改生效/同 id 双边改后写赢 + 在途修改不被他端删除吞掉/旧页面无基线整表 LWW 兼容/规范字段比对免疫键序与多余字段/不影响流水线 409 判定）；新增 `projects/pipeline/tests/test_env_server_merge.js` 6 例（合并单元口径三例、loadServerState 自愈重拉保留本地未落盘新增、pushState 基线上送与响应协调、在途改动不被响应覆盖）；`test_env_info_refresh.js` 重写为合并语义（成功路径：他端增改同步 + 本地未落盘新增保留 + 基线推进；新增远端删除/在途改动保留用例；失败三态与 TDZ 静态契约保留）；`test_pipeline_save_consistency.js`（baseConfig 契约增 environments）、`test_init_no_autoput.js`/`test_loadserverstate_merge_local_add.js`（vm 抽取清单补新函数）同步；全量 npm test 459（tests）+ 805（projects JS）+ shell + python 0 失败；Playwright headless 实测（lihaifeng 登录、link 安装 worktree 构建）双浏览器上下文并发添加节点：修复前 A 的节点被 B 覆盖丢失，修复后双方节点都保留、A 重载后两个节点均可见。影响范围——设置页「节点环境」的添加/编辑/删除与手动刷新在多用户并发下不再互相覆盖（同 id 同时编辑为条目级后写赢）；单浏览器单用户操作路径行为不变；流水线单条保存（save-one）、导入导出、运行历史等其余写路径不变；代码仓（repositories）仍是整表 last-write-wins（本次未改，如需同等保护另行处理）；旧版页面（baseConfig 无 environments 键）连新服务端时维持原整表覆盖行为。
- 修复**混合编排（本地执行 + 服务端执行）运行历史恢复为一条记录，移交服务端的确认弹窗改为轻提示**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——含「需本地运行」前缀 + 定时后缀的混合编排运行一次会在运行历史里出现两条记录（本地前缀一条 + 服务端后缀 `tag+'-srv'` 一条，PR #150 的拆分口径），同一次运行的阶段、构建号、统计被切开，用户看成跑了两次；且本地前缀跑完把后缀移交服务端时弹 `alert` 确认框（「本地阶段已完成，后续 N 个定时阶段已在服务端开始执行」），必须手动点掉才能继续操作。解决方案——**回到同 tag 一条记录 + 身份保护 + 轻提示**：① 后缀计划（`buildSuffixPlan`）不再携带拆分标记，服务端 `execPlan` 把后缀写进同 tag 历史记录（启动即「进行中」、逐阶段刷新、结束落终态的既有能力保留），`appendPipelineHistory` 同 tag 合并时保留首条记录的运行身份（名称 / 执行人 / commit / 来源不被后缀计划的「· 定时后缀 / ⏰ / 随机 commit / schedule-suffix」覆盖）并按整条运行起止（首条记录 `startTs`）重算耗时，阶段日志按名并集补齐（`local` 标识与日志文件路径保留）；② 页面 `finish` 先落本地前缀终态，新增 `markHistorySuffixRunning` 把该记录保持「进行中」直到服务端后缀落终态——否则刷新合并（本地终态优先于远端 running）会压住服务端进度，后缀执行期间误显「已完成」；③ 移交成功的 `alert` 确认框改为页面级 `toast` 轻提示（底部浮层约 4 秒自动消隐，不打断操作）；移交失败（计划接口不可达、后缀未执行）仍保留 `alert` 告警并按失败收尾。失联判死（`sweepStaleRunningHistory`）口径不变：活动计划（at>0）直接保护同 tag 记录（不再需要 `-srv` 派生 tag），休眠计划/孤儿证据/兜底宽限逻辑不动。改动点——`projects/pipeline/pipeline.html`（`buildSuffixPlan` 去拆分标记、新增 `markHistorySuffixRunning`、`handoffSchedSuffix` 成功路径 alert→toast、`finish`/`collectRunLogs`/`mergeStageLogsForHistory` 注释按单条口径更新）；`src/index.ts`（`execPlan` 移除拆分标记读取与 `tag+'-srv'` 派生、`appendPipelineHistory` 同 tag 合并保留首条身份 + 耗时按 `prev.startTs` 重算、`sweepStaleRunningHistory` 不再向活动计划集合加 `-srv` 派生 tag）。测试——`projects/pipeline/tests/test_hybrid_history_split.js` 重写为 `test_hybrid_history_single.js` 6 例（计划不带拆分标记、finish 本地记录形态、移交成功 toast+历史保持「进行中」、移交失败仍 alert 告警、刷新合并本地 running 不压服务端进度且终态收敛、静态契约无拆分标记）；`tests/pipeline-history-split-sweep.test.mjs` 重写为 `tests/pipeline-history-merge-sweep.test.mjs` 9 例（同 tag 写入全序列、旧版拆分标记计划兼容合并、真实落盘下身份/编号/整条耗时/阶段并集保留、判死与活动计划同 tag 保护、静态契约）；`test_sched_suffix_handoff.js` 成功路径断言改 toast 且历史保持「进行中」；`pipeline-history-tag-replace`/`pipeline-history-log-merge` harness 补 `durText` 桩；全量 npm test 0 失败；Playwright headless 实测（lihaifeng 登录、link 安装 worktree 构建）混合编排整跑一条记录（进行中→终态、阶段齐全、身份不变、无弹窗）。影响范围——混合编排手动运行的历史呈现：一次运行重新只留一条记录（成功率/总构建计数恢复按一条计），后缀执行期间该条记录显示「进行中」、服务端落终态后收敛；移交成功反馈从确认弹窗变为自动消隐轻提示；纯本地/纯服务端/定时/API 运行路径不变；新旧页面与服务端交错部署时均退化为同 tag 合并（新服务端对旧页面的拆分标记不再读取、仍一条；旧服务端对新页面按原同 tag 合并，但无身份保护，记录身份可能被后缀覆盖——升级前窗口期的已知降级）；此前已落盘的 `tag+'-srv'` 历史记录原样保留，不再新增。
- 修复**Profiling 页 trace 分析 CPU/GPU 混算、串行与可重叠不分**（`projects/profiling/index.html`、`projects/profiling/trace_summary.py`、`projects/profiling/index.test.cjs`）：问题背景——trace 的「阶段耗时」视图把全部 ph=X 事件混在一起聚合：`aten::*`（cpu_op）、`cudaLaunchKernel`/`cudaStreamSynchronize`（cuda_runtime host 侧 API）、阶段注释（user_annotation）与 GPU 内核（kernel/gpu_memcpy/gpu_memset）同表求和排占比——host 墙钟与设备执行是两个时域（host 时间与 GPU 执行交叠），混排的占比与「瓶颈」定性没有物理意义（例如 decode 注释窗口会被算成「占全程 78% 的严重瓶颈」）；GPU 空闲只报占比、不回答「为什么空」；重叠机会不区分同流串行与异流重叠——单流 trace 里内核全部 100% 暴露，「尝试重叠」建议刷屏但同流内核硬件级串行、根本不可能重叠。解决方案——**CPU/GPU 分侧 + 串行/重叠口径**：①阶段视图分侧聚合（`traceEventSide`：cat 含 kernel 或 gpu_ 前缀 → GPU 设备侧，其余 → CPU host 侧），「阶段耗时」拆成 GPU 设备事件表与 CPU·Host 事件表两张（各自本侧累计作占比分母，CPU 表头注明 host 墙钟与 GPU 执行交叠勿相加），瀑布图与 ECharts 占比图只画 GPU 侧，trace 总耗时改取 wall 跨度（混合累计无物理意义），概览 meta 增「GPU 事件累计 / CPU/Host 事件累计」；②瓶颈分析分侧（`analyzeSide`）：GPU 侧照常找占比瓶颈与离群，CPU 侧只做 host 同步/搬运开销提示（cudaStreamSynchronize/aten::item/Memcpy 等占 CPU 侧 >20% 时提示），不再把 host 事件定名为「全程瓶颈」；③内核三表补串行口径：GPU 口径增「串行(单流)时间」（忙碌并集 − 跨流重叠），仅 1 条活跃流时给出「单流串行执行」提示（同流内核不可能互相重叠，重叠类建议需引入额外 stream/PDL 才成立），多流但零重叠同样提示；④GPU 空闲归因到 host 同步点：扫描线收集 ≥1µs 空闲段，TOP 3 空闲段对齐 host 同步事件（cudaStreamSynchronize/cudaDeviceSynchronize/cudaEventSynchronize/cudaStreamWaitEvent/cudaMemcpy/aten::item/_local_scalar_dense）计数展示，空闲占比发现附最大空闲段与同步名（无同步调用时提示疑似调度气泡/CPU 派发瓶颈）；⑤µs 级时长显示修复（fmtDur 对 <1ms 委托 fmtUs，此前阶段表/图表把 160µs 显示为 0ms）。改动点——`index.html`（traceEventSide、aggregateTraceEvents 分侧累计并出 topGpu/topCpu、normalizeTrace 分侧视图 hasSideSplit/sideTotals/总耗时取 wall、阶段卡双表（stageGpuHead/stageTableCpu）、瀑布与图表只画 GPU 侧、analyzeStages 分侧 + analyzeSide、analyzeTraceKernels 增串行 serial/空闲段 idleGaps/host 同步采集、kernelFindings 单流提示与空闲归因、renderKernelAnalysis 串行统计与 gpuNoteLine 提示行、buildPrompt 分侧表格与串行/归因行、fmtDur 亚毫秒委托 fmtUs、kernelCard 口径说明补串行约定）；`trace_summary.py`（同款分侧聚合 gpuTotalUs/cpuTotalUs/topGpu/topCpu 与内核分析 serial/idleGaps 移植，仅标准库）；`index.test.cjs`（fixture 增 cudaStreamSynchronize 事件，EXPECT_GPU 增 serial/idleGaps 精确值）。测试——单测 15 例全过（新增：traceEventSide 分侧、aggregateTraceEvents 分侧累计与 topGpu/topCpu、normalizeTrace 分侧视图与旧输出回退、analyzeStages 分侧不再把 CPU 注释定名为瓶颈且流水线路径行为不变、单流 trace serial=busy/重叠 0/单流提示、空闲段归因 TOP3 精确值；对拍扩展 serial/idleGaps JS↔Python 一致）；全量 npm test exit 0；Playwright 实测 38/38（本地+服务端两路径：分侧表 GPU 不含 host 事件/CPU 表不含内核、meta 分侧累计、串行(单流) 377µs、空闲归因含 cudaStreamSynchronize、瓶颈带 GPU 侧标签且不再把 decode 注释定为瓶颈、AI 提示词分侧表格与串行/归因行、主题三态、无 JS 错误），截图复核 µs 显示修复。影响范围——仅 profiling 项目页 trace 展示与分析链路；流水线 JSON / 二进制报告 / 日志文本路径不变（非分侧走原单表与原瓶颈逻辑）；trace_summary.py 输出向后兼容（新增 gpuTotalUs/cpuTotalUs/topGpu/topCpu 与 kernelAnalysis.gpu.serial/idleGaps，旧字段保留）；插件服务端代码与 API 零改动。
- 修复**流水线本地执行的任务未跑完时关闭浏览器：任务直接判失败报错，并立即体现在运行状态**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——含「需本地运行」阶段的运行由浏览器编排，此前 pagehide 时把在跑运行整体移交服务端续跑（PR #116 系列）：当前任务实际已被杀（exec-stream 断开即终止进程）却被静默重跑，「需本地运行」语义本来就是目标只保证浏览器可达、服务端重跑只会报错；且历史记录被服务端接管后身份被改写（名称变「· 关页移交」、执行人带 ⏰、来源变 schedule-suffix），用户看不到「任务因关页失败」的真实结果；移交未送达（进程被杀/断网）时记录又永久挂「进行中」，要等在场 TTL + 3 分钟宽限后才被清扫判死。解决方案——**关页即失败**：pagehide 时不再移交在跑运行，改为把 failed 终态记录经 keepalive POST 直送新增的 `POST /api/worktable/pipeline/history/fail-run` 路由（`buildCloseFailRecord`：当前在跑阶段标 failed、后续未开始阶段标 skipped、已完成阶段保留真实状态，记录携带中断原因 `closeError`「浏览器页面已关闭，本地任务未执行完，本次运行按失败结束」）；服务端把同 tag「进行中」记录原地终态化（保留启动编号、阶段日志按名并集合并、status 服务端强制 failed、已终态记录不覆盖），把中断行追加进失败阶段的归档日志文件（限该次运行归档目录内路径），并按 tag 清掉混合编排的休眠后缀计划（at<=0，运行已失败后缀不得再触发）；回放详情 KV 新增「中断原因」行。排队中的本地队列条目尚未开始执行、不属于「没执行完的任务」，仍按原语义登记「立即执行一次」的服务端计划移交（`buildUnloadHandoffPlan` 相应简化为仅队列条目形态，`buildSuffixPlan` 移除已无调用方的 includeLocal 选项）；fail-run 未送达（进程被杀/断网）时由在场 TTL 孤儿登记 + `sweepStaleRunningHistory` 判死兜底（判死文案同步更新）。改动点——`projects/pipeline/pipeline.html`（`handoffRunsOnPageHide` 在跑运行改走 fail-run、新增 `CLOSE_FAIL_TEXT`/`buildCloseFailRecord`、`buildUnloadHandoffPlan` 仅保留队列条目形态、`buildSuffixPlan` 删 includeLocal、`renderReplayDetail` 增「中断原因」行、注释更新）；`src/index.ts`（新增模块级 `cleanCloseFailRecord` 清洗（tag 必填、status 强制 failed、envNodes 剥凭据、logs 白名单截断）与 fail-run 路由：原地终态化/插入兜底/归档日志追加中断行/休眠计划清理）。测试——重写 `projects/pipeline/tests/test_run_onclose_handoff.js` 13 例（关页即失败落史与阶段状态、不登记移交计划、队列条目仍移交、租约释放、已了结集合、失败记录细节与静态契约）；新增 `tests/pipeline-history-fail-run.test.mjs` 8 例（原地终态化保编号、无记录插入兜底、已终态不覆盖、休眠计划清理与活动/他人计划保留、归档日志追加与目录外拒写、校验 400/405、清洗白名单、与 sweep 共存契约）；`tests/pipeline-history-split-sweep.test.mjs` 判死文案断言同步；全量 npm test 452（tests）+ 792（projects JS）+ shell + python 0 失败；Playwright headless 实测（lihaifeng 登录、worktree 页面直开 + link 安装 worktree 构建）四场景 18 项断言全过：在跑关页→历史即「错误」+ 中断原因 KV/归档日志红字可见 + 阶段 成功/失败/跳过 各就其位 + 无移交计划无孤儿；在跑+排队关页→在跑失败、排队移交服务端跑完；混合编排关页→前缀失败落史、休眠后缀计划清除；不关页正常跑完不受影响。影响范围——浏览器编排（含「需本地运行」阶段）的运行在页面关闭/刷新时不再移交服务端续跑，按失败落史（可从失败阶段重试/重跑）；排队条目移交、定时后缀、服务端定时/API 运行路径不变；旧页面 + 新服务端（仍走移交计划）与新页面 + 旧服务端（fail-run 404，退化为孤儿登记 + 清扫判死）组合均向后兼容。
- 新增**Profiling 页 GPU 内核三表分析（归因 / 重叠机会 / 融合候选）**（`projects/profiling/index.html`、`projects/profiling/trace_summary.py`、`projects/profiling/index.test.cjs`、`projects/package.json`）：问题背景——Profiling 页对 PyTorch/Chrome trace 只按 (cat,name) 聚合出「阶段耗时」平铺视图，看不出内核属于哪个算子族、来自哪个 CPU 算子，也没有 GPU 忙碌/空闲/跨流重叠的时间口径，更谈不上「该往哪优化」：重叠机会（通信暴露尾、被遮住的低 ROI 内核）与融合候选（哪些拆分算子可融合、哪些融合实现已在跑）都要人工翻原始事件。解决方案——参考 llm-torch-profiler-analysis skill（BBuf/AI-Infra-Auto-Driven-SKILLS）在页面内新增内核三表分析器并双端同形落地：①**内核归因表**——canonical 名归一（0x 地址归一、CUTLASS 模板参数剥离）+ skill 算子族模式表分类（attention/gemm/moe/norm/rope/activation/quantize/communication/memory 等，含 copy/fill 弱信号的 compute 提示否决）+ External id → cpu_op 归属，按 GPU 时间排序展示启动次数与 decode/prefill 阶段标注；②**GPU 时间口径**——扫描线算各流内核区间并集（busy）、内核累计（sum）、窗口（wall）与空闲/跨流重叠/最大并发流，明示「重叠时累计>忙碌，占比≠可消除延迟」；③**重叠机会**——每内核 hidden（被异流遮住）/exclusive（暴露）切分，headroom（暴露≥45%、总时长≥5µs、份额≥1%）按类别加权排序给 P1（通信→尝试重叠，其余→尝试融合）/P2（依赖风险→检查依赖），低 ROI 隐藏（elementwise/memory 隐藏≥65%）标 P4 跳过，依赖风险按同流紧邻 gap ≤ max(2,min(20,dur×0.15))µs + 类别依赖对判定，compute 类整体降级为 fallback 段；④**融合候选**——12 条模式注册表（fused_add_rmsnorm / silu_and_mul / QK norm+RoPE / RoPE+KV cache / MoE router+topk / MoE act+quant / RMSNorm+quant / allreduce+RMSNorm(需 TP≥2) / MoE sum+all-reduce / attention+quant / MLA 融合投影 / FP8 scaled-MM 气泡），active 关键词命中或 split 组共现达阈分别标 Confirmed/Candidate 并列证据内核。主 rank 选择（kernel 时长最大 pid，TP0 优先）避免多 rank trace 混算；user_annotation 的 decode/prefill 注释窗口给内核打阶段标。浏览器内分析器（index.html 自包含 KERNEL-ANALYZER 标记段，本地文件）与服务端汇总器（trace_summary.py，大文件）同款逻辑同形输出；瓶颈发现新增「GPU 空闲占比 / 通信内核暴露 / 累计>忙碌口径提醒 / 融合模式统计」，AI 深度分析提示词自动携带 GPU 口径 + 三表。改动点——`index.html`（KERNEL-ANALYZER 分析器段、kernelCard 卡片与三表渲染 renderKernelAnalysis、kernelFindings 并入瓶颈发现与提示词、buildPrompt 三表段落、normalize/normalizeTrace 透传 kernelAnalysis、页头说明）；`trace_summary.py`（同款分析器 Python 移植，kernelAnalysis 附入汇总 JSON，分析失败不阻断旧汇总输出）；新增 `index.test.cjs`；`projects/package.json` test:js 登记 `profiling/*.test.cjs`。测试——`projects/profiling/index.test.cjs` 11 例（算子族分类 16 条模式、canonical 名归一、合成 trace GPU 口径精确值（窗口 780µs/忙碌 407µs/累计 437µs/空闲 373µs/重叠 30µs/并发 2 流）、主 rank 选择、headroom 排序与 compute 降级、low-roi-hidden、融合 Confirmed/Candidate 阈值、空形态、normalizeTrace 透传、kernelFindings 派生、静态契约、trace_summary.py 子进程对拍（GPU 口径/内核表顺序/重叠机会/融合候选与浏览器内完全一致）及旧行为兼容）；全量 npm test（tests + projects JS + shell + python）0 失败；Playwright 实测（lihaifeng 登录、worktree 页面直开）：本地文件上传（浏览器内聚合）与服务端文件（trace_summary.py）两条路径共 27 项断言全过——GPU 口径数字、归因表首行与算子族/CPU 算子、阶段拆分、P1/P4 行、融合 Confirmed、瓶颈发现、AI 提示词三表段落、主题三态、无页面 JS 错误。影响范围——仅 profiling 项目页的 PyTorch/Chrome trace 展示与分析链路；流水线 JSON / nsys·ncu 二进制 / 日志文本路径不变；trace_summary.py 输出向后兼容（新增可选 kernelAnalysis 字段，旧页面忽略）；插件服务端代码与 API 零改动。
- 修复**混合编排运行历史：本地/服务端任务拆成两条记录、服务端执行期间状态实时可见、页面失联的卡死「进行中」判死为错误**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——含「需本地运行」前缀 + 定时后缀的混合编排此前由「同 tag 一条记录」承载（PR #146）：① 本地执行没完成时后缀无法提交服务端（结构上只能等分界/关页激活），若页面崩溃/断网且 pagehide 移交未送达，记录永久挂「进行中」、后缀休眠计划（at=0）永不触发，错误在运行历史中无从体现；② 本地完成、非本地未完成时单条记录的状态不可能真实——分界移交路径下本地一跑完就显示「已完成」（服务端后缀还没开始），关页移交路径下服务端执行全程显示「进行中」且 logs 为空、耗时冻结在 0s；③ 本地与非本地执行的任务一直显示在同一条记录里，且服务端收尾把记录身份整体覆盖（名称变「xx · 定时后缀」、执行人带 ⏰、来源变 schedule-suffix、commit 换随机值、耗时只剩后缀段）。解决方案——**拆分两条记录 + 服务端执行期逐阶段刷新 + 失联判死**：后缀计划（`buildSuffixPlan`）携带 `histMode:'split'`，服务端 `execPlan` 据此把后缀写进 `tag+'-srv'` 独立历史记录（启动即「进行中」、每阶段完成即刷新、结束落终态），页面 `finish` 落定的本地前缀记录（原名/执行人/来源 local/本地耗时/各阶段 local 标识）不再被覆盖；关页移交（`buildUnloadHandoffPlan`，不带 histMode）与旧版页面计划沿用原 tag 原地合并（接管语义不变，且同样享受逐阶段「进行中」刷新——服务端执行期间他端能看到真实进度）；新增服务端「进行中」历史清扫 `sweepStaleRunningHistory`（30s 间隔）：无任何活体信号（新鲜在场快照同 tag 运行 / 活动计划含拆分后缀派生 tag）且最近活体证据（在场 seenAt / 孤儿 orphanedAt）超 3 分钟宽限，或从未有信号且记录超 30 分钟，即把记录标记 failed 并补一条「（系统）本地执行中断：页面失联且未移交服务端，后续阶段未提交服务端执行」日志，同时清掉该 tag 的休眠后缀计划；ts 刷新到当前防旧页面迟到的 stale running 上行盖回，页面若其实仍在跑（网络分区误伤）由 finish 终态 PUT 按 ts 较新自愈、分界激活经 registerStageTimers 回退全量重新登记。改动点——`projects/pipeline/pipeline.html`（`buildSuffixPlan` 携带 `histMode:'split'`，`finish`/`collectRunLogs`/`mergeStageLogsForHistory`/`handoffSchedSuffix` 注释按拆分口径更新）；`src/index.ts`（`execPlan` 新增 `splitHistory`/`histTag`/`liveHistory`/`historyRecordFor`/`writeLiveHistory`：页面起源运行（计划带 tag）启动即写「进行中」、`recordStageResult` 逐阶段刷新、终态统一走 `historyRecordFor(status)` 且拆分模式写 `tag+'-srv'`；新增纯函数 `planStaleHistorySweep`（模块层，供清扫调用与测试抽取）与 `sweepStaleRunningHistory` 清扫器（30s 定时器 + ctx.effect 清理））。测试——新增 `projects/pipeline/tests/test_hybrid_history_split.js` 4 例（计划带 split 标记、finish 本地记录身份与只含本地阶段、刷新合并拆分记录不覆盖本地记录、静态契约）与 `tests/pipeline-history-split-sweep.test.mjs` 8 例（拆分记录 running→终态全序列、接管模式同 tag 原地更新、无 tag 计划不写「进行中」、真实落盘下本地记录不被覆盖、判死/活动计划保护/-srv 派生保护/兜底宽限/静态契约）；Playwright headless 实测（混合编排整跑两条记录各自状态真实、关页移交记录逐阶段刷新收敛、崩溃判死为错误）；全量 npm test 1218 例 0 失败。影响范围——混合编排手动运行的历史呈现：一次运行分「本地」与「定时后缀」两条记录（成功率/总构建计数相应按两条计）；关页移交运行历史上享受逐阶段进度可见；失联本地运行的历史记录不再永久「进行中」（判死后可被状态筛选、可重跑）；纯本地/纯服务端/定时/API 运行路径行为不变（无 tag 计划仍只落终态一条）；旧页面 + 新服务端或新页面 + 旧服务端组合均回退同 tag 合并旧行为（向后兼容）。
- 修复**未勾选「环境清理」的运行经服务端移交执行后历史多出「环境清理」阶段**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——混合编排（本地前缀 + 定时后缀）或关页移交的运行，页面在启动时已按主控「预设任务」勾选展开执行项、并有意不带预设进服务端计划（预设是页面运行期概念）；但移交计划（`buildSuffixPlan` / `buildUnloadHandoffPlan`）不带 `presets` 字段，服务端 `execPlan` 把无该字段的计划一律当作「预设机制之前的旧定时计划」，落入兼容回退「配置了清理脚本即执行」——于是只要设置页配置了环境清理脚本，未勾选「环境清理」的移交运行也会多执行一次清理（且在后缀起点重复执行），同 tag 合并后运行历史多出一个「环境清理」阶段（脚本已失效时还显示为失败）。定时页新建计划同理：「清理环境」勾选框（与主控同一开关）此前不下发，服务端只看脚本配置，勾选形同虚设。解决方案——页面生成的计划一律携带**显式 `presets`**：移交类计划（定时后缀 / 关页移交，含休眠预登记与激活覆盖）恒为 `[]`（显式空数组 = 不执行预设任务，同 API 触发语义；预设已在本地前缀按勾选执行过，后缀不得重跑）；定时页新建计划按「清理环境」勾选携带 `['cleanup']` 或 `[]`，勾选框对服务端定时执行真正生效。服务端逻辑不变：`execPlan` 对显式 `presets` 走 `materializeServerPipelineStages`（空数组即不展开任何预设），仅无 `presets` 字段的更旧计划保持兼容回退。改动点——`projects/pipeline/pipeline.html`（`buildSuffixPlan` / `buildUnloadHandoffPlan` 计划对象增 `presets:[]` 及注释、`addPlan` 按 `$('schedCleanupEnv').checked` 下发 `presets` 并更新注释）；`src/index.ts`（仅更新 `execPlan` 回退分支注释，说明页面生成的计划已携带显式 presets，回退只面向更旧的计划）。测试——新增 `projects/pipeline/tests/test_sched_plan_presets.js` 3 例（定时页勾选/未勾选的 presets 下发、两个移交构建函数的 `presets:[]` 静态契约）；`test_sched_suffix_handoff.js` / `test_run_onclose_handoff.js` 补计划 `presets:[]` 断言；`tests/pipeline-run-api.test.mjs` 新增 3 例（显式 `presets:[]` 不触发清理且历史无环境清理阶段、无 `presets` 旧计划保持回退执行清理、`presets:['cleanup']` 计划在阶段最前执行清理）；Playwright 实测混合编排未勾选环境清理的运行，同 tag 历史记录不再出现环境清理阶段。影响范围——定时后缀 / 关页移交 / 定时页新建计划的服务端执行：未勾选环境清理不再多跑清理、历史不再多出该阶段；存量无 `presets` 字段的旧定时计划行为不变（保持「配置了清理脚本即执行」）；API 触发与页面本地编排路径不变。
- 修复**流水线页整页不渲染（TDZ：Cannot access '$' before initialization）**（`projects/pipeline/pipeline.html`）：问题背景——「↻ 刷新节点信息」按钮的点击绑定 `$('envInfoRefresh').addEventListener('click', refreshEnvsFromServer)`（69101b1 引入）写在「节点信息手动刷新」小节末尾的顶层语句（约 2314 行），而 `const $` 声明在约 3985 行；顶层顺序执行到该行时 `$` 仍处于暂时性死区，抛 `ReferenceError: Cannot access '$' before initialization` 中断整段主脚本——其后的全部初始化（流水线/环境/代码仓渲染、事件接线、服务端数据加载）都不再执行，页面只剩静态框架：流水线任务列表、流水线编排、运行历史全空，执行人恒显示「未登录」。既有 `test_env_info_refresh.js` 用 vm 切片 + 预置 `$` 桩执行，覆盖不到真实整页加载的顶层顺序，故测试全绿但页面实际打不开。解决方案——点击绑定移到脚本尾部统一初始化区（与 `$('gpuRefreshAll')` 等绑定并列），`refreshEnvsFromServer` 函数本体留在原小节（`function` 声明提升不受位置影响）；原位置补注释说明不得在此处顶层执行 `$()`。改动点——`projects/pipeline/pipeline.html`（删除小节末尾的顶层绑定行、初始化区补绑定行、注释）。测试——新增 `projects/pipeline/tests/test_script_init_order.js` 2 例（`const $` 声明前无列 0 顶层 `$(` 语句的防 TDZ 守卫、`envInfoRefresh` 绑定位于声明之后的顺序契约）；更新 `test_env_info_refresh.js`（按钮绑定移出 vm 抽取切片，改由静态顺序契约覆盖）；修复后经 headless 浏览器实测确认整页正常渲染（流水线列表/编排/历史齐全、执行人显示登录用户）、点「↻ 刷新节点信息」toast 正常；全量 npm test 432（tests）+ 774（projects JS）+ shell + python 0 失败。影响范围——仅「↻ 刷新节点信息」按钮的绑定位置；功能、交互与服务端 API 不变；修复同时恢复了被 TDZ 中断的整页全部功能。
- 改进**运行流水线启动即写入运行历史（状态「进行中」）**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——运行历史原先只在 `finish()` 收尾时才写入，点「运行流水线」后历史列表看不到本次运行，要等整条跑完才出现；跨浏览器/定时刷新也看不到在跑记录，阶段详情「AI 分析」在运行结束前一直禁用（提示「运行结束后自动生成」）。解决方案——**启动即入史**：`startSimRun` 经新增 `beginRunHistory` 按 `rc.tag` 写入 `status:'running'` 记录（展示「进行中」徽标，耗时按 `startTs` 实时计算）并立即 `persistState`，他端历史刷新即可见；`finish` 按 tag **原地更新**为终态（沿用启动编号，不再 `buildNo++` 新增第二条）；重置（`disposeRunForReset`）撤回「进行中」条目（不计入历史语义不变）；服务端 `appendPipelineHistory` 对同 tag 记录原地替换（关页移交后服务端写终态时不留「进行中 + 已完成」两条）；历史自动刷新（`applyHistoryRefreshPayload`）本地终态优先于远端滞后 running、本页仍在跑的 running 在远端缺失时补回，防 3s 轮询冲掉刚写入的条目。状态筛选下拉新增「进行中」；点击在跑历史行不进回放（logs 尚不齐全）而切回该次运行实时编排视图。改动点——`pipeline.html`（`beginRunHistory`、`finish` 按 tag 原地更新、`disposeRunForReset` 撤回、`labelOf`/筛选/徽标/耗时、`applyHistoryRefreshPayload` 合并、`renderStats` 不计进行中、`startSimRun` 接线）、`src/index.ts`（`appendPipelineHistory` 同 tag 替换）。测试——新增 `projects/pipeline/tests/test_history_running_on_start.js` 12 例（启动写入/幂等/finish 原地更新/兜底新增/重置撤回/labelOf 与静态契约/刷新合并三态）、`tests/pipeline-history-tag-replace.test.mjs` 3 例（同 tag 替换不占号、无 tag 新增、旧路径），更新 `test_stage_detail_log_row.js` 文案断言，全量 npm test 1152 例 0 失败。影响范围——本地浏览器编排的运行（含「需本地运行」阶段）启动后历史立即可见「进行中」；历史统计（成功率/均耗时）不计入进行中记录；阶段详情 AI 分析对在跑运行即可发起（按当前已归档日志）；服务端定时/API 独立运行路径行为不变（无同 tag 时仍新增）；旧版页面无启动记录时 finish 仍走新增兜底。
- 改进**「运行流水线」环境多选支持搜索与选中节点排序**（`projects/pipeline/pipeline.html`）：问题背景——运行流水线设置里的环境多选面板（主控「环境」、定时页、流水线编辑器「默认环境」、任务列表运行弹窗共用 `renderEnvMulti`）只平铺全部节点复选框：节点一多就难找，且选中顺序固定跟随节点列表原序，无法按名称/IP/设备状态排列或手动调整；而 `TARGET_IP`（首个）/`TARGET_IPS` 的注入顺序正取决于选中顺序，顺序不可控会直接影响脚本的目标机语义。解决方案——面板升级为「搜索 + 已选节点排序」：顶部搜索框按名称 / SSH 地址 / 用户名 / K8s InternalIP 子串过滤下方节点列表（已选区不受过滤影响；输入只切换列表行显隐、不整树重绘，避免丢焦点；搜索词按面板实例隔离）；已选节点独立成区，支持「名称 / IP / 设备」排序（点一次升序、再点降序，排序结果写回 ids）与 ↑↓ 手动调序、× 取消选中；`curEnvs`/`schedEnvs` 改为按 `selectedEnvIds`/`schedEnvIds` 顺序返回（原先按 `environments` 原序），按钮文案与 `TARGET_IP`/`TARGET_IPS` 注入顺序一致跟随选中/排序结果。交互控件改走 `createElement`（不再拼 innerHTML），避免注入并便于测试挂钩。改动点——`projects/pipeline/pipeline.html`（`curEnvs` 按选中顺序、`schedEnvs` 同口径、`envMultiSearch`/`envMultiSelSort` 面板级状态、`envMultiFilterMatch`/`envMultiSortVal`/`envMultiSortList` 新增、`renderEnvMulti` 搜索框 + 已选区排序/调序/取消 + 全部节点列表重写）。测试——`projects/pipeline/tests/test_env_selection_default_none.js` 扩展为 11 例（原有默认不选/允许全空/编辑器默认环境/定时跟随 6 例保留，新增：curEnvs 按选中顺序、搜索按名称/IP/用户名过滤与空提示、IP 排序升/降写回 ids、↑↓ 手动调序、× 取消选中与搜索词按面板隔离），全量 npm test 735 例 JS + shell + python 0 失败。影响范围——四处环境多选面板（主控运行流水线、定时页、流水线编辑器默认环境、任务列表运行弹窗）的交互；`TARGET_IP`/`TARGET_IPS` 注入顺序从「节点列表原序」变为「选中/排序顺序」（未手动排序时与勾选先后一致，已持久化的 `pip-envSel`/`schedEnvIds` 数组顺序原样生效）；服务端注入契约、运行历史 `envNodes` 字段语义不变。
- 改进**运行流水线设置按运行级隔离：一运行一份设置副本**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——设置页配置（脚本目录 / Jenkins / EvalTokens / 普罗 / 归档 / 预设脚本）此前由各阶段执行时读全局变量或服务端当前配置：运行中途或下一次运行前的修改会渗进已经开跑/排队的流水线（改 `scriptsDir` 导致后续阶段 cwd 漂移、换 Jenkins 令牌/地址、换普罗收集脚本、改归档脚本名等）；阶段定义在 `runPipeline` 入队时只做浅拷贝（`{...s}`），编辑流水线的 `script`/`url`/`evaltokens`/`sub` 嵌套字段同样会渗进在跑副本。服务端 API 运行只提交配置引用（`environmentIds`/`repositoryId`/…），`execPlan` 执行时才读 `worktable-pipeline.json` 当前配置——排队中的计划会吃进提交后的设置修改。解决方案——在既有「用户隔离」（运行行临时配置仅浏览器本地 / 视图态按登录用户分槽）之上叠加**运行级隔离**：一次运行在入队/启动/提交时深拷贝一份设置快照（`runSettingsSnapshot` → `rc.settings` / 队列项 `settings` / 服务端 `plan.settings`），本次运行各阶段只读快照，下一次运行才取新设置。阶段定义同步改深拷贝（`expandRunStages` 的 `cloneStage`、`runPipeline` 入队的 `JSON` 克隆），不再与流水线定义共享嵌套对象。客户端 `execScript`/`runUrlStep`/`runEvaltokensStep`/`taskPromCollect`/归档脚本与 `jkTriggerBuild`/`jkTriggerGet`/`jkGetText` 全部改读 `rc.settings`（无快照的旧队列项/历史回放回落当前设置）；定时后缀（`buildSuffixPlan`）与关页移交（`buildUnloadHandoffPlan`）计划携带 `settings`。服务端新增 `snapshotPipelineRunSettings`/`resolvePlanRunSettings`：`buildPipelineApiRun` 把设置快照写入 plan，`execPlan` 经 `runCfg` 执行（`materializeServerPipelineStages`/HTTP/EvalTokens/普罗采集/归档脚本均走 `runCfg`）；旧计划无 `settings` 字段时回落执行开始时的配置快照（行为不回退）。顺带对齐归档脚本名口径：服务端改读 `archiveScriptName`（客户端 `collectConfig` 上送字段），兼容旧 `archiveScript`。改动点——`projects/pipeline/pipeline.html`（`runSettingsSnapshot`/`runSettingsOf`/`runScriptsDir`/`runJenkinsCfg`/`runEvaltokCfg`/`runPromCfg`/`runArchiveDir`/`runArchiveScriptName`，`expandRunStages` 深拷贝，`startRun`/`startSimRun`/`runPipeline` 写 `settings`，`execScript`/`runUrlStep`/`runEvaltokensStep`/`taskPromCollect`/归档收尾/`buildSuffixPlan`/`buildUnloadHandoffPlan` 按快照取值，`jkTriggerBuild`/`jkTriggerGet`/`jkGetText` 增可选 Jenkins 配置参数）；`src/index.ts`（`snapshotPipelineRunSettings`/`resolvePlanRunSettings`，`buildPipelineApiRun` 写 `settings`，`execPlan` 起 `runCfg` 并替换执行路径的 `cfg`）。测试——新增 `projects/pipeline/tests/test_run_settings_snapshot.js` 5 例（快照深拷贝、run* 优先读快照、阶段深拷贝、静态契约、`runPipeline` 入队项带快照），`tests/pipeline-run-settings-snapshot.test.mjs` 4 例（服务端快照深拷贝、`archiveScript` 兼容、`resolvePlanRunSettings` 优先/补齐/回落、源码契约）；`tests/pipeline-scripts-dir.test.mjs` 契约改断言 `runCfg`；全量 tests 427 + projects JS 760 + shell + python 0 失败。影响范围——运行中/排队中的流水线对设置页与流水线编辑的后续修改免疫；下一次运行才生效新设置；无 `settings` 的旧计划/旧队列项保持「启动瞬间定格」兼容行为；设置页、配置 API、用户隔离语义不变。
- 修复**混合编排（本地执行 + 服务端执行）运行历史拆成两条、远端详情缺本地阶段**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——一条流水线同时含「需本地运行」前缀与定时/服务端后缀时，浏览器 `finish` 先写一条本地历史（后缀被标 skipped）、服务端 `appendPipelineHistory` 再 unshift 一条只有后缀阶段的记录，运行历史里同一次运行出现两条、且任一条详情都缺对方阶段；跨浏览器/远端查看该次运行（历史回放、服务端 finished/队列预览）只见后缀阶段，本地执行阶段无从分辨。解决方案——同 tag 记录**按阶段名并集合并**（不再任一侧整条覆盖）：客户端 `mergeStageLogsForHistory` + `finish` 同 tag 原地合并、服务端 `appendPipelineHistory` 同 tag 原地合并、PUT 路径 `mergePipelineHistoryForWrite` 同 tag 双边合并（顶层取 ts 较新一侧终态，阶段日志并集，保留任一侧 `local` 标记）；`buildSuffixPlan` 随计划携带 `prefixStages` 本地前缀快照，服务端 `execPlan` 写入同 tag 历史与运行快照/finished stages，远端详情展示完整阶段；浏览器执行阶段写 `local:true`（`collectRunLogs`），阶段详情徽标旁展示「**本地执行**」、KV 增「执行方式」行，队列/finished 白名单透传 `local`；`handoffSchedSuffix` 记 `handoffFromIdx`，后缀不再写本地 skipped 占位（待服务端合并补齐）；`applyReplayProfileStages` 兜底把 profile 里有、logs 缺的阶段补进列表。改动点——`pipeline.html`（`mergeStageLogsForHistory`、`collectRunLogs` local/handoffFromIdx、`finish` 同 tag 合并、`buildSuffixPlan` prefixStages、`isLocalExecStage`/`appendLocalExecBadge`、`detailContextRows`/`renderDetail`/`renderReplayDetail` 执行方式、`applyReplayProfileStages` 补齐、`queueStagePresence`/`remoteFinishedPreviewRc`/`cleanFinishedEntry`/`cleanQueueStage` 透传 local、`sourceLabel`）、`src/index.ts`（`mergeStageLogsForHistory`、`appendPipelineHistory` 同 tag 合并、`mergePipelineHistoryForWrite` 同 tag 并集、`execPlan` prefixStages 入史与 setStages、finished/队列白名单 `local`）。测试——新增 `projects/pipeline/tests/test_hybrid_history_stages.js` 12 例（合并并集/local 保留、collectRunLogs local 与 handoffFromIdx、徽标、profile 补齐、finish 同 tag 一条/无 tag 新增、静态契约）、`tests/pipeline-history-log-merge.test.mjs` 5 例（服务端合并、PUT 同 tag 并集、append 同 tag 不占号/无 tag 新增），`test_queue_item_preview.js` 抽取起点改 `isLocalExecStage`，6 个抽取 `mergePipelineHistoryForWrite` 的测试补 `mergeStageLogsForHistory`，全量 npm test 424（tests）+ 746（projects）+ shell + python 24 例 0 失败。影响范围——混合编排手动运行的运行历史与详情（只留一条、阶段完整、本地执行有标识）；纯本地 / 纯服务端 / 定时运行路径行为不变（无同 tag 仍新增）；旧记录无 `local` 字段不展示本地徽标（执行方式按判定口径显示）；服务端 finished/队列快照契约新增可选 `local` 字段，旧客户端忽略不受影响。
- 新增**跨浏览器可终止自己提交的流水线**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——运行队列「服务端队列 / 其他浏览器」分组里，只有服务端权威任务（`id==='server'`）提供「取消/中止」按钮；他端浏览器在场条目（含自己署名的）整行只读，换一个浏览器就终止不了自己刚提交的本地编排任务，只能回到来源标签页操作，来源页关掉后更是无从下手。解决方案——引入**取消信箱**：他端可控条目（`canControlRun`，本人署名 / admin）同样渲染「取消/中止」，点击 POST `action:'cancel-presence'` 把 `{clientId,itemId}` 暂存服务端；来源页 `pullRemoteQueue` 每秒认领目标为自己 `QCLIENT_ID` 的请求，本地 `cancelQueue`/`abortRun` 真正终止（进行中的脚本进程照常杀掉、按「终止」计入历史）。服务端条目继续走既有 `cancelServerRun`（执行池 `cancel`），两条通路并存。信箱条目在来源页下一次 PUT 不再携带该条目时出箱，另有 60s TTL / 50 条上限防堆积。改动点——`src/index.ts`（`queueCancelRequests` + `pruneQueueCancelRequests`、POST `cancel-presence` 入箱、GET 下发 `cancelRequests`、PUT 不再携带该条目即出箱）；`projects/pipeline/pipeline.html`（`remoteCancelBtn` 统一渲染：服务端 `data-qserver-cancel`、他端 `data-qremote-cancel`+`data-qremote-cancel-id`，`cancelRemotePresence` 提交信箱、`applyPresenceCancelRequests` 每轮轮询认领并本地中止/取消）。测试——`projects/pipeline/tests/test_queue_item_preview.js` 新增 4 例（他端条目用取消信箱按钮并与服务端区分、非 admin 可终止自己他端条目且不可终止他人、`cancelRemotePresence` POST 形态、`applyPresenceCancelRequests` 只认领本页条目且排队取消/在跑中止），既有服务端按钮用例改断言服务端走 `data-qserver-cancel`；`tests/pipeline-queue-presence.test.mjs` 新增取消信箱入箱/下发/出箱 1 例。全量 npm test 1154 例 0 失败。影响范围——运行队列「其他浏览器」分组的自己署名（或 admin 可控）条目新增跨浏览器「取消/中止」；实际终止由来源页执行（约 1s 内认领），来源页已关闭的条目仍走「已中断」孤儿路径不受影响；服务端执行池取消、本页本地队列中止/取消行为不变；旧页面不下发/不认领 `cancelRequests` 向后兼容。
- 新增**设置页「节点环境」手动刷新节点信息**（`projects/pipeline/pipeline.html`）：问题背景——节点环境列表随共享配置持久化到服务端（`worktable-pipeline.json`），其他浏览器添加/修改/删除节点后，本页没有手动重拉入口：「流水线任务 / 运行队列 / 运行历史」都有「↻ 刷新」，节点环境只在首次加载、保存冲突自愈或整页刷新时才同步，标题行仅有「⟳ 设备状态」（GPU/设备占用，不更新节点定义本身），节点一多时看不到他端刚加的机器只能刷新整页。解决方案——标题行新增「**↻ 刷新节点信息**」按钮（`envInfoRefresh`），点击经 `fetchPipelineStateFresh()` 从服务端重拉配置，有非空 `environments` 即与 `loadServerState` 同口径整体替换本地列表（环境条目整表 last-write-wins，与 `saveEnvs` 上送语义一致，不做流水线那套三方合并），同步 `localStorage` 离线缓存后 `renderEnvs()`+`renderEnvOptions()` 重渲染表格与四处环境多选面板；失败（拉取失败/服务端暂无环境）`alert` 且不改本地列表，按钮在途禁用、结束恢复。只覆盖共享的节点环境定义，不动本页设备状态缓存（`gpuStatus`/`sessionStorage`）与运行行临时选择（`selectedEnvIds` 等）；「⟳ 设备状态」保持独立。改动点——`projects/pipeline/pipeline.html`（标题行 `envInfoRefresh` 按钮、「节点信息手动刷新」小节 `refreshEnvsFromServer` + 绑定）。测试——新增 `projects/pipeline/tests/test_env_info_refresh.js` 4 例（静态契约按钮/绑定/函数齐备、成功路径整体替换+写离线缓存+重渲染+toast、失败/空环境/null 三态 alert 且不改本地、按钮点击接线），既有 `test_gpu_manual_refresh.js`/`test_env_selection_default_none.js` 不受影响；全量 npm test 423（tests）+ 755（projects JS）+ shell + python 0 失败。影响范围——设置页「节点环境」标题行新增「↻ 刷新节点信息」，与既有「⟳ 设备状态」并列、职责分离（前者拉节点定义列表，后者查 GPU/设备占用）；服务端配置 API 与环境数据结构不变；不点按钮行为与此前一致（不会自动刷新节点列表）。
- 改进**流水线任务列表 / 运行历史筛选与页大小按登录用户隔离同步**（`src/index.ts`、`projects/pipeline/pipeline.html`）：问题背景——`histFilter`/`plFilter`/`histPageSize`/`plPageSize` 是个人浏览偏好，此前落在共享配置顶层随 `worktable-pipeline.json` 全团队共享，一人改筛选（如「仅失败」「拥有者=某人」）全团队跟着变、互相覆盖。解决方案——服务端改为 `config.userViewStates[username]` 按登录用户隔离：同用户跨浏览器跟随，互不覆盖他人；API 形态不变（GET 按请求用户把其槽位展开为顶层键，PUT 收回写入该用户槽位），客户端 `collectConfig`/`loadServerState` 契约与既有测试保持一致。无 auth（token 共享模式）/ 未登录走共享桶 `''`，维持旧行为；磁盘遗留顶层视图键作为无槽位用户的初值（升级迁移，首写清出共享配置）；槽位映射上限 100 个用户防无界增长。`schedEnvIds` 定时环境选择仍团队共享；「运行流水线」行临时配置仍仅存浏览器本地。改动点——`src/index.ts`（`VIEW_STATE_KEYS`/`extractViewState`/`omitViewStateKeys`/`sanitizeViewState`/`viewStateUserKey`/`mergeUserViewStates`/`resolveViewStateForUser`，`/api/worktable/pipeline` GET 展开、PUT 收回写入用户槽位并清出共享配置顶层视图键；save-one 从 `{...disk}` 出发不碰 `userViewStates`）、`projects/pipeline/pipeline.html`（注释同步「按登录用户隔离」口径）。测试——新增 `tests/pipeline-view-state-per-user.test.mjs` 12 例（助手清洗/合并/上限、PUT 收视图态进用户槽位、GET 按用户展开且互不覆盖、无 auth 共享桶、遗留顶层迁移、未登录不落具名槽位、save-one 不丢槽位），`pipeline-trust`/`pipeline-owner-guard`/`pipeline-copy-rename`/`pipeline-config-preserve-keys` 路由抽取清单补视图态助手，全量 npm test 1149 例 0 失败。影响范围——多用户场景下两列表筛选与页大小改为按人隔离（此前团队共享一份）；单人 / token 共享模式行为不变；客户端无需改动（API 顶层键形态不变）。
- 改进**服务端在跑阶段日志尾窗收紧为最后 20 行**（`src/index.ts`、`projects/pipeline/pipeline.html`）：问题背景——实时详情原先按 `DETAIL_LOG_LIMIT` 最多回显 1000 行 / 256KiB，与历史回放的「最后 20 行」不一致；长输出阶段点击服务端任务时即便有 sinceEnd 增量，首屏与 replace 回退仍拉整段尾窗、DOM 也要渲上千行。解决方案——传输与回显同限到与历史回放一致的 **最后 20 行**：队列日志查询新增 `tailLines` 参数（`log()` 全量/替换回退时只回末尾 N 行，`endLen`/`baseLen` 仍是完整逻辑流位置，不挡 sinceEnd 续传；append 路径不裁），客户端 `pullRemoteQueueLog` 恒带 `tailLines=20`，本地缓存同样只留末尾 20 行（split 尾部空串不计入内容行），`detailLogLinesFor` 服务端预览分支改用 `LIVE_LOG_TAIL_LIMIT`（20 行），完整内容仍走归档文件 / 历史回放。改动点——`src/index.ts`（`clipTailLines`、`log()` tailLines、队列 GET 校验）、`projects/pipeline/pipeline.html`（`LIVE_LOG_TAIL_LINES`/`LIVE_LOG_TAIL_LIMIT`、`pullRemoteQueueLog` 请求与缓存裁剪、`detailLogLinesFor` 回显）。测试——`tests/pipeline-run-api.test.mjs` tailLines 全量裁剪 2 例、`tests/pipeline-queue-presence.test.mjs` 非法 tailLines 400、`projects/pipeline/tests/test_queue_item_preview.js` 请求串含 tailLines=20 与缓存 20 行裁剪 1 例，全量 npm test 1137 例 0 失败。影响范围——点击查看服务端在跑阶段日志的传输体积与回显行数（1000→20）；历史回放、归档日志与本页实时运行（`buildLog`，仍 1000 行）不变。
- 优化**服务端阶段日志按 sinceEnd 后缀增量拉取，点击查看不再每秒全量重传尾窗**（`src/index.ts`、`projects/pipeline/pipeline.html`）：问题背景——点击查看服务端流水线任务的阶段日志时，`pullRemoteQueueLog` 随每秒队列轮询按 `revision` 拉取，revision 每次写日志都变，持续输出阶段每次都全量重传最多 256KiB 尾窗（JSON 解析 + `stageOutputLines` 全量拆行），是「一边跑一边看」时的主要带宽与前端 CPU 开销；服务端 `liveLogLimit=256KiB` 触顶后每次追加都会截尾，若只按「纯追加」判定做增量会永远退不出全量。解决方案——引入逻辑日志流末尾偏移增量：服务端日志条目维护 `baseLen`（text 之前已丢弃的字符数，触顶截尾时累加）与 `lastReplaceRev`（最近一次 `replaceLog` 的 revision）；`log(runId, stageId, sinceRevision, sinceEnd)` 在「自 sinceRevision 起无 replace、sinceEnd 仍落在当前窗口内」时只回 `{append, baseLen, endLen, truncated, revision}` 后缀，窗口滑过客户端位置或 replace 后才退回全量 `{text, ...}`。截尾只推 `baseLen`、不挡增量——触顶后每次追加仍可续传，这是与「纯追加判定」的关键差别。客户端 `pullRemoteQueueLog` 带 `revision` + `sinceEnd`（缓存的 `endLen`）请求，回 `append` 时拼接后缀（本地展示缓存同样按 256KiB 截尾防无界增长），回 `text` 时覆盖缓存；`endLen` 单独记账，与展示截断无关。旧客户端不传 `sinceEnd` 恒得全量，向后兼容。改动点——`src/index.ts`（`writeLog` 记账 `baseLen`/`lastReplaceRev`、`log()` 支持 sinceEnd 后缀增量、队列 GET 解析 `sinceEnd` 并校验非法值、代际管理器透传）、`projects/pipeline/pipeline.html`（`pullRemoteQueueLog` 请求 `sinceEnd`、处理 `append`/`text` 两态与本地缓存截尾）。测试——`tests/pipeline-run-api.test.mjs` 新增「按 sinceEnd 后缀增量返回，replace 后退回全量、触顶截尾仍可续传」（含触顶后增量续传关键路径）、原日志尾窗用例补 `baseLen`/`endLen` 断言；`tests/pipeline-queue-presence.test.mjs` 新增 sinceEnd 透传与非法值 400；`projects/pipeline/tests/test_queue_item_preview.js` 断言 sinceEnd 请求串、新增 append 拼接与全量覆盖两态，全量 npm test 1136 例 0 失败。影响范围——服务端运行队列阶段日志查询通道（`GET /api/worktable/pipeline/queue?runId&stageId`）与点击服务端任务查看日志的传输形态；历史回放（`/api/worktable/file` tailBytes）与归档日志路径不变；不带 `sinceEnd` 的旧页面行为不变。
- 改进**手动流水线不再等关页/分界才移交服务端**（`projects/pipeline/pipeline.html`）：问题背景——含「需本地运行」阶段的手动流水线整条由浏览器编排，定时后缀要等本地前缀跑完（分界）或关浏览器（pagehide）才登记服务端计划，移交过程多次出问题（缺代码仓/策略上下文、keepalive 丢包、孤儿条目、节点租约空等 TTL 等，PR #116/#128/#129 连续修复）。解决方案——混合编排（本地前缀 + 定时后缀）改为**启动即预登记**：`startSimRun` 把后缀阶段整体以休眠计划（`kind:'once'` 且 `at:0`，服务端 `planTick` 对 at 非正数不触发）POST 上送服务端，阶段定义/代码仓快照/归档上下文/strategy 等重负载在页面健康时落盘；本地前缀跑完只做「激活」（同 id 覆盖、补当前 `vars` 快照 + `at:now`），关页同理复用预登记 id 替换激活，不再走重型移交登记。**没有本地任务时（后缀前无「需本地运行」阶段）不留休眠计划，启动即以 `at:now` 登记为可执行服务端任务**，避免休眠计划与分界激活竞态、一直挂到关页才触发；预登记请求完成后再查 `suffixPlanHeld`，若分界已激活则补发激活覆盖，防后到休眠体把计划打回 `at:0`。全阶段支持服务端执行（全 sched）的手动运行维持既有行为：点击即 `submitServerRun` 进服务端执行池；纯本地（无 sched 阶段）仍浏览器编排 + 关页移交兜底（「本地运行的除外」）。运行失败/中止/重置且后缀从未激活时 `discardHeldSuffixPlan` 清掉休眠计划，定时页不残留永不触发的占位。`registerStageTimers` 改经新增 `buildSuffixPlan` + `upsertServerPlan`（POST 单条 upsert，与关页移交同通道，不再 GET 合并再全量 PUT）。改动点——`pipeline.html`（`buildSuffixPlan`/`upsertServerPlan`/`preRegisterSchedSuffix`/`discardHeldSuffixPlan` 新增，`registerStageTimers` 改 POST upsert，`handoffSchedSuffix` 改激活语义，`startSimRun` 按有无本地前缀分流预登记/立即激活，`buildUnloadHandoffPlan` 复用 `suffixPlanId`，`finish`/`disposeRunForReset` 清理休眠计划）。测试——`test_sched_suffix_handoff.js` 改 POST 断言并新增 5 例（启动预登记 at:0 + 分界同 id 激活补 vars、无本地任务立刻 at:now、预登记竞态后到休眠体不覆盖激活、休眠计划按 id 清理不影响他人、已激活不触碰接口），`test_run_onclose_handoff.js` 新增 2 例（关页复用 suffixPlanId、纯本地沿用 unload- id）并改 includeLocal 用例为 POST 断言，全量 npm test 1126 例 0 失败。影响范围——混合编排手动运行的后缀执行路径；无本地任务的后缀启动即进服务端执行池（不再有休眠窗口）；「定时」页混合运行启动后短暂「已预登记（待本地阶段完成）」计划可手动取消；纯本地与全 sched 手动运行行为不变；旧版页面无 `suffixPlanId` 时关页仍走 unload- 独立计划，向后兼容。
- 修复**跨浏览器查看任务日志路径不对**（`projects/pipeline/pipeline.html`）：问题背景——从其他浏览器查看正在运行/排队的任务详情时，「日志文件」行显示的路径完全错误（形如 `/var/log/op_test/流水线名_当前时间戳/run-—-01-阶段名.log`），与实际归档路径无关；含预设任务的流水线在运行历史中记录的 `logFile` 也与实际落盘文件名不一致。根因有二：① 跨浏览器只读预览（`remoteQueuePreviewRc`/`orphanPreviewRc`）构建的 rc 无 `archive` 字段且 `tag` 为占位符 `—`，`stageLogFileFor` 落入 `archiveFolderFor` 的现算分支（用本页 `archiveDir` + `nowCompact()` 生成全新目录名），拼出假日志路径；② `runScriptStep` 的任务日志序号用 `i+1`（阶段下标+1），与 `collectRunLogs`/`archiveStageLog` 的 `stageSeq`（预设任务固定 00、正式阶段从 01 起）不一致——含预设任务时实际日志文件名与历史 `logFile` 对不上。解决方案——① 队列在场快照白名单（`queuePresenceEntry`）增加 `archive` 与 `tag` 透传（归档目录与构建 tag 是服务端路径/标识符，非凭据），`remoteQueuePreviewRc`/`orphanPreviewRc` 显式取用并置 `archive:null` 兜底，`stageLogFileFor` 对 `remotePreview` 且无 `archive` 时返回 null（不再拼假日志路径，UI 显示「—」）；② `runScriptStep` 序号改走 `stageSeq(rc.stages,i)`，与 `collectRunLogs`/`archiveStageLog`/`runEvaltokensStep` 统一。改动点——`projects/pipeline/pipeline.html`（`queuePresenceEntry` 白名单 +`archive`/`tag`、`remoteQueuePreviewRc`/`orphanPreviewRc`/`queuePreviewRc` 显式 `archive`/`tag` 字段、`stageLogFileFor` remotePreview 守卫、`runScriptStep` logFile 序号改 `stageSeq`）。测试——`projects/pipeline/tests/test_stage_detail_log_row.js` 新增 3 例（remotePreview 无 archive 返回 null、带 archive/tag 拼正确路径、静态契约 `runScriptStep` 不得用 `i+1`）、`projects/pipeline/tests/test_queue_item_preview.js` 新增 3 例（runningPresenceEntry 透传 archive/tag、无字段不补、remoteQueuePreviewRc 取用与兜底）。影响范围——跨浏览器查看运行队列任务详情的「日志文件」路径展示与「📄 打开日志」按钮；含预设任务流水线的历史日志路径一致性；本页实时运行态与历史回放路径解析逻辑不变。
- 修复**归档日志路径生成与跨浏览器查看不一致**（`projects/pipeline/pipeline.html`、`src/index.ts`）：问题背景——归档日志路径的序号生成与跨浏览器展示均有问题：① 浏览器侧 runScriptStep 用 i+1 计算任务日志序号，与 collectRunLogs/archiveStageLog 的 stageSeq（预设任务固定 00、正式阶段从 01 起）不一致，含预设任务时实际文件名与历史 logFile 对不上；② 服务端 execPlan 用 baseSeq+index+1 同样不区分预设；③ 跨浏览器查看他端任务时 stageLogFileFor 落入 archiveFolderFor 现算分支拼出假日志路径。解决方案——①② 统一走 stageSeq 约定（浏览器侧改 stageSeq(rc.stages,i)，服务端新增 serverStageSeq）；③ 任务日志路径作为属性同步：queueStagePresence 将每个任务的 _serverLogFile/_serverLogExpectedFile 提取为 logFile 属性随队列快照同步，其他浏览器直接读属性，stageLogFileFor 优先读 logFile、remotePreview 无属性时返回 null。测试——test_stage_detail_log_row.js 新增 3 例、test_queue_item_preview.js 新增 1 例，全量 npm test 1126 例 0 失败。
- 修复**EvalTokens 状态轮询被 `NODE_USE_ENV_PROXY` 全局代理劫持导致连续失败**（`src/index.ts`）：dsh 进程环境含 `NODE_USE_ENV_PROXY=1` + `http_proxy=http://127.0.0.1:8118` 且 `no_proxy` 不含内网段时，`stagePollFetch` 用全局 `fetch` 发出的内网请求（如 `http://192.168.1.101:9000`）会被送进本地代理、到不了目标，每次轮询都 `fetch failed` 连续计失败。任务启动/列表请求因走 `/api/worktable/proxy`（`serverDirectFetch` 自建 Agent 绕代理）不受影响，表现为「任务能启动但轮询全挂」。现 `stagePollFetch` 改用 `http.request` + 自建 `reqLib.Agent()`（与 `serverDirectFetch` 同款绕过全局代理劫持），并经可注入的 `stagePollReqLib` 解析 http/https 模块（生产走动态 import，测试经 `globalThis.__stagePollReqLib` 注入）。测试：`tests/pipeline-stage-poll.test.mjs` 的 vm context 注入 `__stagePollReqLib`。
- 修复**EvalTokens 状态轮询长任务被误判失败**（`src/index.ts`、`projects/pipeline/pipeline.html`）：问题背景——流水线 EvalTokens 阶段轮询经服务端 stage-poll 每 3 秒全量拉 `/api/open/v1/tasks/runs?task_id=` 列表接口，而该接口原样返回每条 run 的 `error` 字段（完整 Python traceback，单条 63KB~634KB），响应随失败 run 累积线性膨胀（实测 deepswe 任务 15 条 run 已达 616KB），逼近 `STAGE_POLL_JSON_LIMIT`（2MB）或拖慢接口超过 `STAGE_POLL_FETCH_TIMEOUT`（10s）时每次查询都计失败；且旧判负逻辑是「连续 30 次失败（约 90 秒）即永久判负」，数小时长任务中途短暂的网络/服务抖动会把仍在正常运行的评测误判为失败（实测两例 15 次 `status=running` 后突然 `已兜底判败`，任务本身仍 3% 正常跑）。解决方案——三管齐下：① 轮询改走新增的轻量状态端点 `GET /api/open/v1/tasks/runs/<runId>/status`（只回 `run_id/status/started_at/finished_at`，实测 141B vs 列表接口 616KB，缩小 4372 倍），旧版 evalscope 无该端点（404）时自动回退列表端点并日志留痕；② 判负兜底从「连续 30 次计数」改为「持续失败 60 分钟」时间窗（`STAGE_POLL_FAIL_GIVE_UP_MS`，var 可测试覆盖），成功一次即清零重新计时；③ 客户端轮询回显失败计数（`# run xxx status=running（连续失败 N 次）`），不再静默掩盖查询通道故障。改动点——`src/index.ts`（stage-poll EvalTokens 段支持单条 `{run_id,status}` 响应与 `statusEndpointMissing` 回退信号、`stagePollShouldGiveUp` 时间窗判负替代 `STAGE_POLL_FAIL_CAP` 计数、Jenkins 段同步）、`projects/pipeline/pipeline.html`（`runEvaltokensStep` 轮询 URL 改 `/runs/<runId>/status` 首选 + 列表端点回退、`statusEndpointMissing` 切换逻辑、失败计数回显、错误文案改时间口径）、`tests/pipeline-stage-poll.test.mjs`（轻量单条响应 3 例、statusEndpointMissing 1 例、时间窗判负 2 例、成功清零 1 例）、`projects/pipeline/tests/test_stage_poll_client.js`（状态端点 URL 断言、判负文案、statusEndpointMissing 切换回退 1 例）。影响范围——EvalTokens / Jenkins 阶段的服务端 stage-poll 轮询路径；需配合 evalscope 侧新增 `GET /api/open/v1/tasks/runs/<runId>/status` 端点（`task_store.get_run` + `TaskRunStatus` 模型），旧版 evalscope 经 404 回退仍可用；执行池 `executeServerEvaltokensStage` 的服务端路径不变。
- 修复**关页移交后运行队列残留「已中断」本地条目**（`projects/pipeline/pipeline.html`）：pagehide 把在跑运行与本地队列移交服务端执行后，最终在场快照（`queuePublishBody`）仍原样携带这些 runs/queue 条目上报——页面随即销毁、在场 TTL（45s）过期清扫时 `sweepQueuePresence` 把它们登记成失联孤儿，运行队列显示「已中断」，但任务其实已由服务端计划继续执行（双重展示）。现 `handoffRunsOnPageHide` 把已移交 / 无剩余阶段 / 并行子上下文随父移交的条目统一记为「已了结」（返回 id 列表并 `queueFinishedNote` 写入 completed 豁免登记，跨同标签页刷新存活），pagehide 最终 beacon 经 `queuePublishBody({excludeIds})` 从 runs/queue 剔除这些条目并强制并入 completed：消失检测与 TTL 过期清扫均不再误登记孤儿。心跳 / PUT 路径不传 excludeIds 时行为不变。测试：`test_run_onclose_handoff.js` 新增 2 例（已了结 id 覆盖移交中/无剩余/并行子/队列四类、全预设无阶段仍了结）并补 `queueFinishedNote` 桩，`test_queue_orphans.js` 新增 2 例（excludeIds 剔除并入 completed、缺省全量上报不变）并更新 pagehide beacon 接线断言。
- 修复**EvalTokens 状态轮询长任务被误判失败**（`src/index.ts`、`projects/pipeline/pipeline.html`）：问题背景——流水线 EvalTokens 阶段轮询经服务端 stage-poll 每 3 秒全量拉 `/api/open/v1/tasks/runs?task_id=` 列表接口，而该接口原样返回每条 run 的 `error` 字段（完整 Python traceback，单条 63KB~634KB），响应随失败 run 累积线性膨胀（实测 deepswe 任务 15 条 run 已达 616KB），逼近 `STAGE_POLL_JSON_LIMIT`（2MB）或拖慢接口超过 `STAGE_POLL_FETCH_TIMEOUT`（10s）时每次查询都计失败；且旧判负逻辑是「连续 30 次失败（约 90 秒）即永久判负」，数小时长任务中途短暂的网络/服务抖动会把仍在正常运行的评测误判为失败（实测两例 15 次 `status=running` 后突然 `已兜底判败`，任务本身仍 3% 正常跑）。解决方案——三管齐下：① 轮询改走新增的轻量状态端点 `GET /api/open/v1/tasks/runs/<runId>/status`（只回 `run_id/status/started_at/finished_at`，实测 141B vs 列表接口 616KB，缩小 4372 倍），旧版 evalscope 无该端点（404）时自动回退列表端点并日志留痕；② 判负兜底从「连续 30 次计数」改为「持续失败 60 分钟」时间窗（`STAGE_POLL_FAIL_GIVE_UP_MS`，var 可测试覆盖），成功一次即清零重新计时；③ 客户端轮询回显失败计数（`# run xxx status=running（连续失败 N 次）`），不再静默掩盖查询通道故障。改动点——`src/index.ts`（stage-poll EvalTokens 段支持单条 `{run_id,status}` 响应与 `statusEndpointMissing` 回退信号、`stagePollShouldGiveUp` 时间窗判负替代 `STAGE_POLL_FAIL_CAP` 计数、Jenkins 段同步）、`projects/pipeline/pipeline.html`（`runEvaltokensStep` 轮询 URL 改 `/runs/<runId>/status` 首选 + 列表端点回退、`statusEndpointMissing` 切换逻辑、失败计数回显、错误文案改时间口径）、`tests/pipeline-stage-poll.test.mjs`（轻量单条响应 3 例、statusEndpointMissing 1 例、时间窗判负 2 例、成功清零 1 例）、`projects/pipeline/tests/test_stage_poll_client.js`（状态端点 URL 断言、判负文案、statusEndpointMissing 切换回退 1 例）。影响范围——EvalTokens / Jenkins 阶段的服务端 stage-poll 轮询路径；需配合 evalscope 侧新增 `GET /api/open/v1/tasks/runs/<runId>/status` 端点（`task_store.get_run` + `TaskRunStatus` 模型），旧版 evalscope 经 404 回退仍可用；执行池 `executeServerEvaltokensStage` 的服务端路径不变。
- 修复**关页移交后运行队列残留「已中断」本地条目**（`projects/pipeline/pipeline.html`）：pagehide 把在跑运行与本地队列移交服务端执行后，最终在场快照（`queuePublishBody`）仍原样携带这些 runs/queue 条目上报——页面随即销毁、在场 TTL（45s）过期清扫时 `sweepQueuePresence` 把它们登记成失联孤儿，运行队列显示「已中断」，但任务其实已由服务端计划继续执行（双重展示）。现 `handoffRunsOnPageHide` 把已移交 / 无剩余阶段 / 并行子上下文随父移交的条目统一记为「已了结」（返回 id 列表并 `queueFinishedNote` 写入 completed 豁免登记，跨同标签页刷新存活），pagehide 最终 beacon 经 `queuePublishBody({excludeIds})` 从 runs/queue 剔除这些条目并强制并入 completed：消失检测与 TTL 过期清扫均不再误登记孤儿。心跳 / PUT 路径不传 excludeIds 时行为不变。测试：`test_run_onclose_handoff.js` 新增 2 例（已了结 id 覆盖移交中/无剩余/并行子/队列四类、全预设无阶段仍了结）并补 `queueFinishedNote` 桩，`test_queue_orphans.js` 新增 2 例（excludeIds 剔除并入 completed、缺省全量上报不变）并更新 pagehide beacon 接线断言。fix/evaltokens-long-task-poll-capfix/evaltokens-long-task-poll-cap
- 修复**手动流水线关浏览器后移交计划仍卡住阶段**（`projects/pipeline/pipeline.html`、`src/index.ts`）：PR #116 的 pagehide 移交只登记了阶段列表，没把运行上下文带上——移交计划缺 `repository`（url/user/pass）与 `strategy`，服务端 `execPlan`/`runStageScript` 注入不到 `GIT_URL`/`GIT_USER`/`GIT_PASSWORD`/`DEPLOY_STRATEGY`，git 类脚本会卡在凭据交互提示上（阶段无超时 = 永久卡住）；且 pagehide 未释放节点租约，移交计划要等死页面租约 TTL（90s）才拿得到节点。现：① `buildUnloadHandoffPlan`/`registerStageTimers` 经新增 `runRepositorySnapshot` 随计划携带代码仓快照与 `strategy`（队列条目无 url 快照时只留 `repoId`）；② 服务端新增 `resolvePlanRepository`：计划未带 url 的 repository 时按 `repoId` 从配置仓库补齐（带 url 的运行期快照优先，配置可能在移交后被改）；③ `handoffRunsOnPageHide` 收尾用 `sendBeacon` 批量释放本页节点租约（`POST /api/worktable/pipeline/leases` 的 `runIds` 形态，服务端早已支持、此前页面没接），移交计划立即可拿节点，不再空等 TTL。测试：`test_run_onclose_handoff.js` 补 repository/strategy 断言与 2 例租约释放 beacon，`test_sched_suffix_handoff.js` 补 repository/strategy 断言，`tests/pipeline-plans-upsert.test.mjs` 新增 `resolvePlanRepository` 1 例。
- 改进**单个流水线分享不再携带预设任务**（`projects/pipeline/pipeline.html`）：行「⋯」菜单「分享」的 `kind:'pipeline-share'` 载荷此前原样带出 `stages` 里的预设标记行与 `defaults.presets` 默认勾选，而预设脚本在各端设置页配置、自定义预设 key 也因端而异，带过去对不上本端配置。现 `buildPipelineShare` 只导出业务阶段（`filter(s=>!s.preset)`）且 `defaults.presets` 恒为空；`parsePipelineShare` 对旧版分享 / 手写 JSON 里的预设标记行与默认勾选同样剥掉（仅剩预设行视为非法），导入后由本端 `withPresetMarkers` 按本地设置补齐标记行、默认勾选为空由用户在编辑器自选。批量「导出流水线」备份口径不变（仍含预设）。测试：更新 `projects/pipeline/tests/test_pipeline_share_import.js`（载荷剥除预设、剪贴板不带预设、解析剥除与仅预设行判非法、导入后 `editDefaults.presets` 为空）。
- 新增**流水线拥有者服务端写保护**（`src/index.ts`）：多用户场景下非 admin 仅可更新/删除自己拥有的流水线，堵住页面侧 `plEditable` 被绕过（旧标签页全量 PUT、save-one、直接调 API）时误改/误删他人流水线的口子；同时覆盖「删除后被其他用户提交恢复」——他人已删条目不得经全量 PUT / save-one 以新增形态写回（owner 仍指向原拥有者时拒绝）。归属口径与页面 `plOwnerOf` 一致（owner 优先、存量回退 createdBy，双空白按未署名全员可写）；`favoriteUsers` / `pinnedAt` 为共享元数据不触发拦截；admin 全权；无认证服务（token 共享模式）维持旧行为。校验挂在全量 PUT 与 `save-one` 两条写路径（`ownerPipelineWriteDeny`，与 `trustedPipelineWriteDeny` 并列），违规整体不写盘、返回 403 `{error:'owner', message, pipelineIds}`（客户端按既有 403 分支 toast 服务端 message 并重拉状态）。测试：新增 `tests/pipeline-owner-guard.test.mjs`（11 例：删/改/复活/伪造 owner、save-one 同口径、收藏置顶豁免、admin 与 token 模式、violations 单元）；`tests/pipeline-trust.test.mjs` 抽取清单同步补上新助手。
- 改进**「运行流水线」行的临时配置改为仅存浏览器本地**（`projects/pipeline/pipeline.html`、`src/index.ts`）：主控运行行（流水线选择 / 环境多选 / 代码仓 / 分支·Tag / 部署策略 / 预设任务勾选）此前随 `collectConfig()` 上送服务端 `worktable-pipeline.json` 并被他人浏览器 `loadServerState()` 覆盖，一人临时调整运行参数会影响全团队。现这些字段只写 localStorage（`saveEnvSel` / `saveRepoSel` / `saveRunSelLS` / `selectPipeline` 不再 `persistState`），`collectConfig` 不再携带 `curPipelineId`/`selectedEnvIds`/`curRepoId`/`branch`/`strategy`/`cleanupEnabled`/`checkEnabled`/`profilingEnabled`，`loadServerState` 不再从服务端应用/迁移这些键；视图状态（`schedEnvIds`/`histFilter`/`plFilter`/`histPageSize`/`plPageSize`）与定时页环境选择保持服务端共享。导入导出：运行行临时配置只在 `local` 块输出/恢复（旧版导出文件里这些键在 config，`pick` 仍兼容）；`legacyLocalKeys` 迁移快照同步收窄到视图状态键。服务端旧定时计划（无 `presets` 数组）的清理行为回退为「配置了清理脚本即执行」（原先读全局 `cleanupEnabled`）。测试：`test_settings_server_keys.js` 重写 collectConfig / loadServerState / 导出 roundtrip 断言（运行行临时配置不上送、不被服务端覆盖），`test_config_import_export.js` 同步 local 块形状（含预设勾选）。
- 移除**流水线主控「运行流水线」旁的「⏹ 中止」工具栏按钮**（`projects/pipeline/pipeline.html`）：编排区主控只保留「▶ 运行流水线」与「重置」，避免与运行队列条目上的「中止」双入口并存；`canStopViewRun` / `updateStopBtn` 及各处 `stopBtn` 可用态维护、点击处理一并删除，`abortRun` 保留供运行队列 / 定时计划「终止」复用，队列内中止/取消入口与权限守卫均不变。阶段超时说明文案改为指向运行队列的「中止」。测试：`test_queue_item_preview.js` 去掉预览自愈用例的 `stopBtn` 断言，`test_queue_item_preview.js` / `test_queue_orphans.js` / `test_node_lease.js` / `test_queue_finished.js` / `test_replay_executor_attribution.js` 的页面桩不再注入 `stopBtn`。
- 调整**升级 / 回退命令改用固定文件名 release 资产**（`src/client/index.tsx` 的 `upgradeCmd`、`release.mjs` 发行说明）：升级卡与升级 / 回退 AI 提示词里的安装命令从 `releases/download/<tag>/tokens-worktable-<版本号>.tgz` 改为 `releases/download/<tag>/tokens-worktable.tgz`（命令仍为 `dsh plugin --profile web add`），与 README 安装地址、`dist/tokens-worktable.tgz` 发行产物命名一致；release 仍同时上传带版本号文件名的资产。测试：`tests/client-live-upgrade.test.mjs` 新增「升级命令按 tag 取固定文件名 tokens-worktable.tgz」用例。`lib/client.js`（+`.map`）已随本改动重建，刷新页面生效。
- 改进**「从分享导入」按钮移至底栏左侧并改为 textarea 弹窗输入**（`projects/pipeline/pipeline.html`）：「新建流水线」冻结底栏的「从分享导入」从右侧（保存/取消旁）移到左侧（「+ 添加阶段」旁）；点击后不再静默读剪贴板 / `prompt` 兜底，改为弹出 textarea 对话框（`#plShareImportDialog`，与「从剪贴板导入」同款式）手动粘贴分享 JSON——解析成功覆盖表单（名称/阶段/默认运行参数）并关弹窗存草稿，非法内容在弹窗内给 ✗ 提示并保留粘贴内容供修正（`openPipelineShareImport` / `applyPipelineShareText`，`importPipelineShare` 改为只负责打开弹窗）。测试：更新 `projects/pipeline/tests/test_pipeline_share_import.js`（弹窗开关、textarea 导入填表、非法提示、编辑/只读不打开、UI wiring 含按钮左侧顺序）与 `test_pipeline_footer_layout.js`（底栏顺序契约改为 添加阶段 / 从分享导入 在左，草稿提示 / 保存 / 取消 在右）。
- 新增**导入导出剪贴板通路**（`projects/pipeline/pipeline.html`）：右上角「⤓⤒ 导入导出」菜单在「本地文件」「服务端备份」之外新增「剪贴板」一节——「⤓ 复制设置到剪贴板」「⤓ 复制流水线到剪贴板」把与本地下载同源的导出 JSON（`buildSettingsExport` / `buildPipelinesExport`，含节点密码与访问令牌明文）序列化后经 `copyText` 写入剪贴板；「⤋ 从剪贴板导入…」弹 textarea 对话框粘贴导出 JSON（不调 `clipboard.readText`，避免权限弹窗，粘贴内容以用户手动粘贴为准），按 `app`+`kind` 自动识别设置 / 流水线并走与文件 / 服务端导入完全相同的校验、确认与恢复逻辑（`importSettingsData` / `importPipelinesData`）。坏 JSON / 数组 / 非本页备份 / kind 对但内容非法时在对话框内给 ✗ 提示并保留粘贴内容供修正，成功才关对话框并在菜单给 ✓ 提示；用户取消确认框不追加提示。测试：`projects/pipeline/tests/test_config_import_export.js` 新增 3 例（复制 payload 与本地下载同源、粘贴导入 kind 自动分流、坏 JSON / 非本页 / 校验失败 / 取消分支），页面元素清单同步补剪贴板入口与对话框控件。
- 修复**手动流水线关浏览器后永久卡在当前阶段**（`projects/pipeline/pipeline.html`、`src/index.ts`）：含「需本地运行」阶段的手动运行由浏览器编排（`runPipeline` → `startSimRun` → `advance`），关页后 `exec-stream` 随连接断开被服务端杀掉、`advance` 不再推进，运行停在当前阶段（此前「失联孤儿登记簿」只把中断展示出来，并不继续执行）。现 `pagehide` 时把在跑运行的剩余阶段（含非 sched 的「需本地运行」阶段——脚本仍在服务端跑，仅浏览器可达的 HTTP 目标可能失败，优于整条停住）与本地队列 / 租约在途条目整体登记为「立即执行一次」的服务端计划（`handoffRunsOnPageHide` + `buildUnloadHandoffPlan`，id 形如 `stimer-…-unload` / `unload-<队列 id>`，携带归档上下文 / tag / baseSeq / 变量快照，与定时后缀同口径），由服务端执行池继续跑完。登记走新增的 `POST /api/worktable/pipeline/plans` 单条 upsert（按 id 替换、保留他人计划，`keepalive:true` 保证 unload 期间请求仍可送达；不再 GET 合并再全量 PUT，避免卸载竞态冲掉并发改动）。顺带加固服务端轮询上界：`serverStageDeadline` 在阶段「超时(分钟)」留空时按 6 小时兜底（原先 deadline=0，Jenkins 排队/构建与 EvalTokens 任务轮询无上界，阶段可永久卡住并占住执行池槽位；显式 timeout 仍优先、上限 1 小时）。测试：新增 `projects/pipeline/tests/test_run_onclose_handoff.js`（7 例：running 起移交全量剩余阶段 / 含需本地运行一并移交 / 跳过已结束与并行子上下文 / 队列与租约在途移交 / currentStageIndex / 预设不进计划与 baseSeq / registerStageTimers includeLocal）与 `tests/pipeline-plans-upsert.test.mjs`（3 例：upsert 替换与保留他人 / 裸 plan 体与非法体 400 / 默认 deadline）。
- 修复**流水线任务列表「拥有者」筛选无法点选拥有者**（`projects/pipeline/pipeline.html`）：拥有者筛选原为 `input+datalist` 组合框，输入框预填「我的（含预置）」后浏览器原生 datalist 下拉会按当前文本过滤候选（且部分浏览器 `autocomplete="off"` 直接不弹候选），用户点不到其他拥有者；`<datalist>` 若包在 `<label>` 内，点选候选还会触发 label 激活把焦点拉回输入框。现改为与运行历史「流水线」筛选同一套自定义候选面板（input + `#plOwnerPanel`）：聚焦即展开全量候选（我的（含预置）/全部/仅预置/未署名/各拥有者用户名），输入即时子串过滤（大小写不敏感），点选或回车可靠提交，Esc/点外收起并回显已提交值；label 改 `for="plFilterOwner"` 且面板移出 label，点选候选 `preventDefault` 避免 label 激活重开面板。候选项 `data-plowner` 存模式键/用户名（非显示标签），`plOwnerOptions()` 按 `{key,label}` 维护并签名去重。筛选语义（mine/all/builtin/unknown / 精确用户名 / 子串搜索）与 localStorage 旧值兼容均不变。测试：更新 `projects/pipeline/tests/test_pipeline_owner_filter.js`（11 例：HTML 结构不再是 select/datalist、映射回显、点选/输入提交、匹配语义、候选名单与签名去重、回显幂等、旧值兼容），`test_pipeline_favorites.js` / `test_history_view_pipeline.js` 去掉 datalist 形态桩。
- 修复**流水线脚本测试与现行脚本行为脱节导致的 8 处失败**（只改测试，不改脚本本体——脚本由上游 op_test 同步）：① `test_bnt_standalone_env.sh` 默认步骤期望补上 `uncordon`（PR #104 起 `cleanup-env.sh` 的 `DEFAULT_STEPS` 已含 uncordon）；② `test_mapped_environment_defaults.sh` 提取 `NODE_PORT_MAP` 默认值允许前导空白（e4fda69 起默认值写在 `if [[ -z ]]` 块内缩进）；③ `test_pipeline_environment_contract.sh` 位置参数禁令从「任何行首 `case`」收窄为「`case` 分派位置参数（`case "$1"` 等）」，render-config.sh 的 `ENABLE_PROFILING` 布尔校验不再误伤；④ `test_pipeline_variable_defaults.sh` 嵌套默认值禁令放行两处有意嵌套（`LOGKEY` 回退 `LOGIN_KEY` 凭据别名、模板路径派生自 `RUN_DIR`），命名空间/发行名期望更新为现行行为（namespace 不再嵌入 IMAGE_TAG、未设置的 RELEASE_NAME 归一为固定 `xds`，即 b85da26 同步 op_test 后的实际语义）；⑤ `test_remote_target_stdin.py` 远程遍历用例注入 `RDMA_RPING_ENABLED=false`（27b3610 引入 RDMA rping 检查后桩环境无 roce_bond 接口恒 FAIL，与 test_bnt_standalone_env.sh 的处理一致）。另注：`pull_render_config.sh` 的 `write_target_pipeline_env` 中 `ENABLE_PROFILING`/`PROFILING_PREFILL_DIR`/`PROFILING_DECODE_DIR` 被重复 export 两次（值相同、后者覆盖前者，功能无害），留待上游修复。
- 修复**流水线列表整页不渲染（TDZ：Cannot access 'PRESET_DEF' before initialization）**（`projects/pipeline/pipeline.html`）：`bfa75c7` 起 `normalizePipelineDefaults` 的 `presets` 过滤改经 `presetDefOf` 判定，而 `const PRESET_DEF` / `presetDefOf` 声明在 `loadPipelines()` 之后（约 2000 行后）；顶层 `let pipelines = loadPipelines()` 执行时访问尚未初始化的 `PRESET_DEF` 抛暂时性死区错误，整个脚本中断、`renderPipelines()` 不会执行，表现为流水线列表全空。现把 `cleanScriptValues` / `normalizeCustomPresets` / `customPresets` 与 `PRESET_DEF`/`PRESET_ORDER`/`PRESET_BY_NAME`/`presetDefOf`/`presetOrderAll`/`rebuildPresetNameMap` 整块上移到 `loadPipelines()`（及 `normalizePipelineDefaults`）之前，保证顶层初始化顺序安全；`test_cleanup_flow.js` 的 vm 抽取起点随声明位置调整（拆成预设定义段 + 编排渲染段两次 load）。回归由 headless 浏览器复现确认（v1.1.22 页面 `pageerror: Cannot access 'PRESET_DEF' before initialization`、列表 0 行；修复后无错误并正常列出流水线）。
- 修复**升级/回退 AI 提示词的执行产物缺少版本信息**（`src/client/index.tsx` 的 `upgradeAiPrompt`/`rollbackAiPrompt`）：原提示词只让执行方「执行命令、完成后刷新页面」，粘贴到 AI 会话跑完升级后，结果里没有版本信息，无法确认实际装上的版本；现提示词指明目标版本（升级后应为 <tag> / 回退后应为 v<版本>），并要求执行方完成后核对实际安装的版本（可用 `dsh plugin --profile web list` 或查询 `/api/worktable/health` 复核）、在结果中明确给出升级前后/回退后的版本号，收尾提醒（刷新页面即可）不变。测试：`tests/client-live-upgrade.test.mjs` 新增「升级提示词要求执行结果携带版本信息」用例，`tests/version-history.test.mjs` 回退提示词用例同步补「版本号」断言。`lib/client.js`（+`.map`）已随本改动重建，刷新页面生效。
- 新增**流水线分享 / 从分享导入**（`projects/pipeline/pipeline.html`）：
  - 流水线任务行「⋯」菜单新增「分享」：把该流水线定义（名称 / 阶段 / 默认运行参数）序列化为
    `kind:'pipeline-share'` 的 pretty JSON 复制到剪贴板（`buildPipelineShare` + `sharePipeline`），
    不含 id、内置、置顶、收藏、可信与署名等实例元数据；载荷含阶段脚本参数值（可能含敏感信息），仅在可信渠道传递。
  - 「新建流水线」编辑器底栏新增「从分享导入」（仅新建时显示，编辑/查看已有流水线不提供）：
    优先读剪贴板，读不到或内容非法时弹框粘贴（`parsePipelineShare` 兼容 envelope 与裸流水线对象）；
    解析成功后覆盖当前表单（名称 / 阶段 / 默认运行参数）并存草稿，由用户确认后点「保存」生成新流水线
    （`importPipelineShare`；阶段经 `editStagesFromStored` 归一并补齐预设标记行）。
  - 测试：新增 `projects/pipeline/tests/test_pipeline_share_import.js`（6 例：载荷形状、剪贴板复制、
    解析合法/非法、导入填表、只读/编辑态不导入、UI wiring）。
- 流水线「设置」全部配置改为服务端持久化，升级后老配置不丢（`projects/pipeline/pipeline.html`、`src/index.ts`）：此前代码仓访问令牌、运行选择（当前流水线/环境多选/当前代码仓/分支/部署策略）、定时计划环境选择与视图状态（历史/列表筛选、分页大小）只存浏览器 localStorage，换浏览器/清缓存即丢。现随 `collectConfig()` 全部上送服务端 `worktable-pipeline.json`（新增 `curPipelineId`/`selectedEnvIds`/`curRepoId`/`branch`/`strategy`/`schedEnvIds`/`histFilter`/`plFilter`/`histPageSize`/`plPageSize` 十个键，`repositories` 条目保留 `pass`；令牌明文落服务端存储，页面 title 与「仅存本地」旧文案同步修正，导出文件照常携带且标注勿外传），`loadServerState()` 按键应用（键存在含空值一律以服务端为准）；localStorage 仍作离线缓存，服务端不可达时行为不变。编辑器草稿 `pip-plDraft` 按原设计保持仅本地。升级迁移：服务端缺某键而启动时 localStorage 有旧值（`legacyLocalKeys` 启动快照，避免二次重拉把自己刚写的缓存误判为旧值）即采用本地值并合并为一次 `persistState()` 回推，仓库 `pass` 服务端为空而本地持有时同样回填回推；导入导出携带新键且旧版导出文件（键只在 `local` 块/缺键）照常导入。服务端 PUT 合并新增 `preserveDiskOnlyConfigKeys`：磁盘配置中客户端未携带的键按磁盘值保留（三方合并与无 baseConfig 旧页面两条路径都覆盖；客户端显式发送的空串/false/空数组仍是有效清除），旧版页面/旧客户端在升级窗口期的一次保存不再抹掉新版写入的新键；save-one 与历史追加等其余写盘路径核查确认本就不丢键。测试：新增 `tests/pipeline-config-preserve-keys.test.mjs`（8 例：保留/显式清除/409 不写盘/save-one 确认）与 `projects/pipeline/tests/test_settings_server_keys.js`（7 例：collectConfig 新键与 pass、迁移回推、令牌回填、不可达门控、导入导出 roundtrip），更新 `test_config_import_export.js` 等三处 fixture。
- 修复工作台升级期间服务端流水线代际丢失：旧 supervisor 已开始 drain 时，新插件实例继续复用同一 manager；清理只删除本次捕获的旧 generation，不会清空升级后新建的 generation。同步修正队列快照把对象误判为数组导致旧代排队项消失的问题。
- 改进**流水线编排区失败/中止阶段节点也显示运行耗时**（`projects/pipeline/pipeline.html` `metaFor`）：编排区阶段节点的元信息行此前只有成功（`✓ 耗时`）与运行中（`百分比 · 已耗时`，500ms 共享 tick 实时刷新）显示耗时，失败/中止只显示「✗ 错误」「⏏ 终止」，看不出该阶段实际跑了多久；现补齐为「✗ 错误 · 耗时」「⏏ 终止 · 耗时」（`fmtDur(n.dur||0)` 钳 0 防 NaN，与阶段详情面板同口径；各失败/中止收尾路径本就已回填 `dur`），跳过（未执行）与未开始阶段不显示耗时。历史回放经同一 `metaFor` 渲染，回放里失败/中止节点同样带出耗时。测试：新增 `projects/pipeline/tests/test_stage_meta_dur.js`（成功/失败/失败 dur 缺失钳 0/中止/运行中回归/跳过与未开始共 6 例）。
- 修复**「打开归档目录」经 better-sidebar 原生侧边栏打开文件夹报 "is a directory"**（`src/client/index.tsx`）：根因是 better-sidebar ≥0.19 的原生面转发 editor 打开时丢弃 openTab 的 meta（0.24.1 仍如此，其自身 agent-opens 的 folder 推送同病），EditorHost 拿不到 meta.dir 把目录当文件 fsRead；`openFolderInSidebar` 改为三级回退——先绕过 betterSidebar 服务直调宿主 `sidebarRight.openResource`（会话作用域文件地址 + mounted 会话快照，以 `params.meta.dir` 经 navigation.params 透传目录语义），失败回退 better-sidebar 底部工作台（`openTab target:'bottom'`，meta 不丢），再失败返回 false 由页面回退系统文件管理器。测试：新增 `tests/open-folder-in-sidebar.test.mjs`（10 例）。
- 修复**流水线阶段详情「打开日志」改为打开日志文件本身**（`projects/pipeline/pipeline.html`、`src/client/index.tsx`）：原「📂 打开日志」只打开日志文件所在目录，与「📂 打开归档目录」效果雷同；现改为「📄 打开日志」——先等日志落盘，经 `/api/worktable/file`（tailBytes=1024）轻量预检文件是否已生成（404 视为尚未生成/已清理，回退 openFolderWithFeedback 打开所在目录，此时效果同「📂 打开归档目录」；探测失败按存在处理不阻断），文件存在时优先走新增的 `__dshOpenFileInSidebar` 桥（better-sidebar editor 标签不带 meta.dir 即打开文件本身，同 better-sidebar 自身 sidebar-file 的 openTab 形态，path 相同按 dedupeKey 复用标签，成功后经 `__dshCloseSideChat` 关闭侧边会话窗让出空间），桥不可用/拒绝时回退 `window.open` 新浏览器标签页打开同源文件路由（.log 按 text/plain 直出；弹窗被拦截则提示行改放 DOM 构建的可点击链接，避免拼 innerHTML 注入）。「📂 打开归档目录」打开文件夹的行为不变。测试：更新 `projects/pipeline/tests/test_stage_detail_log_row.js`（打开日志改为文件行为：侧边栏桥打开/新标签页回退/弹窗拦截链接/404 回退目录/空路径与坏路径共 6 例，静态契约同步换新文案与 `openStageLogFile` 函数名，`test_execution_progress.js` 切片边界不变）。
- 修复**流水线主控预置任务无法勾选**：旧版浏览器状态中预置脚本参数 `params` 偶尔以非数组形态持久化时，首屏参数渲染会因 `.forEach` 抛错，导致后续预置任务 checkbox 与按钮事件无法注册；清理、检查、Profiling 三处参数渲染现仅接受数组，损坏数据按无参数处理并继续完成主控初始化。新增对应回归测试。
- 新增**流水线「任务是否完成」的服务端权威判定与下发**（`src/index.ts`）：① 执行池终态发布——已开始运行的 run 到达终态（成功/失败/取消）即记录 FinishedEntry（白名单清洗，含 generation 透传），池内环形缓冲上限 20 条 / TTL 120s 惰性 prune，多代际 manager 聚合存活代与退役簿后由 GET `/api/worktable/pipeline/queue` 以 `server.finished` 下发，客户端不再靠「条目从快照消失」推断完成；排队即取消的条目不记录。② 新增 `POST /api/worktable/pipeline/stage-poll/jenkins` 与 `POST /api/worktable/pipeline/stage-poll/evaltokens` 两个阶段完成轮询端点：长轮询窗口（默认 20s、上限 25s）内由服务端轮询上游（Jenkins queue/build 含 progressiveText 增量控制台续传、EvalTokens runs），语义镜像原浏览器轮询（30 连败按 key 跨请求累计、判负后短路 10 分钟）；目标复用 `/api/worktable/proxy` 同款内网白名单（403），headers 透传剔除逐跳头，客户端断开即中止上游轮询。测试：新增 `tests/pipeline-finished-runs.test.mjs`（4 例）与 `tests/pipeline-stage-poll.test.mjs`（15 例），更新 presence/run-api/node-leases 三处快照断言（server 对象新增 finished 键）。
- 改进**流水线页面全面接入服务端权威状态**（`projects/pipeline/pipeline.html`）：Jenkins/EvalTokens 阶段的完成轮询从浏览器 while 循环改为串行调用服务端 stage-poll 端点（控制台增量经 offset 续传，保持原回显节奏；触发/中止动作与令牌守卫不变，finally 仍走 `jkCancelExecution`），端点 404（旧服务端）/403（非公网白名单目标）时单次回退浏览器直连轮询并告警；队列轮询消费 `server.finished`——新终态记入 completed 上报（完成≠失联，不再误入孤儿登记）、立即刷新历史、队列区新增「服务端最近完成」分组（三态徽标+耗时+结束时间，随 TTL 消失）、在看的运行预览按终态优雅收尾并停止日志轮询，finished 纳入队列快照签名（变化必重绘）。合规修复：孤儿重跑改传 `pipelineId` 用流水线完整定义分流（原先传 stages 白名单快照恒退化为本地纯模拟运行，全 sched 时现确实提交服务端执行池）；`submitServerRun` 透传 `item.source||'manual'` 保留触发来源语义；本地运行任务（含「需本地运行」阶段）行为一律不变。测试：新增 `test_stage_poll_client.js`（10 例）、`test_queue_finished.js`（9 例），更新 stage-poll 失败兜底/queue 孤儿/轮询降耗/jenkins 变量/evaltokens 五处既有测试。
- 流水线**运行历史记录新增结构化环境节点 `envNodes`**（`src/index.ts`）：服务端 `execPlan` 写入历史
  （`appendPipelineHistory`）时给记录附加 `envNodes` 字段——本次运行选中环境节点的快照数组
  `{name,ip,nodeIp}`（name 为节点名可为空串；ip 为 SSH 地址，为空时依次以 nodeIp、id 兜底；nodeIp 为
  K8s InternalIP，无则空串；name 与 ip 均空的条目丢弃，最多 50 条），优先由 `runCtx.envs` 数组映射，
  旧计划无 `envs` 快照时回退把 `env` 字符串按中文/英文逗号拆成 `[{name:'',ip}]`，结果总是数组
  （无选中节点时写 `[]`）；只映射上述三字段，**user/pass 等凭据绝不落历史**。`cleanPipelineHistory`
  （写盘前清洗）对 `envNodes` 做防御性清洗：非数组整体剔除，条目只留对象且只保留三字段（单字段限长
  128）、空条目丢弃、截到 50；`mergePipelineHistoryForWrite`（页面 PUT 上送历史合并）对记录原样保留，
  无 `envNodes` 的遗留记录不报错、不补字段。HTTP 响应结构不变（记录自然多字段）。
  测试：新增 `tests/pipeline-history-env-nodes.test.mjs`（7 例：API 运行路径落盘记录的 envNodes 字段
  值与三字段契约、历史 JSON 不含节点口令/user、plan 凭据不落存储文件任何位置、未选节点写 `[]`、
  env 字符串回退与 50 条封顶、merge 往返兼容遗留记录、clean 防御清洗）；
  `tests/pipeline-run-api.test.mjs` 的 execPlan 抽取同步补上 `pipelineHistoryEnvNodes`。
- 流水线**运行历史表新增「环境节点」列**（`projects/pipeline/pipeline.html`，表头位于「流水线」列之后，
  行渲染/空态 colspan 同步为 9 列）：展示历史记录 `envNodes`（`{name,ip,nodeIp}`）——节点名以「、」连接、
  超过 2 个折叠为「A、B 等N个」，悬停 title 逐行「节点名（ip）」（name/ip 为空时省略对应部分，如
  「（192.168.1.1）」或「生产」）；无 `envNodes` 的遗留记录回退解析 `rec.env`（中文/英文逗号拆分，IP 串或
  环境名字符串都直接展示），两者皆空显示「—」。本地运行的 `finish()` 组装历史记录时同步写入 `envNodes`：
  由运行上下文 `rc.envs` 映射（name 与 ip 均为空的条目丢弃、最多 50 条、绝不含 user/pass），无选中节点时
  空数组；`rec.env`（中文逗号 IP 串）保持原语义不变，回放/重跑的环境回填不受影响。历史自动刷新
  （`applyHistoryRefreshPayload`）按整条记录替换、无字段白名单，新字段随记录自然往返。
  测试：新增 `projects/pipeline/tests/test_history_env_nodes.js`（单元格文本/title 折叠与逐行提示、
  遗留记录回退、finish 写入映射与截断/脱敏断言）；更新 `test_history_table_columns.js`（9 列表头/行/
  colspan 断言），`test_history_analysis_compare.js`、`test_parallel_stage_execution.js`、
  `test_sched_suffix_handoff.js`、`test_node_lease.js` 的沙盒函数清单同步补充新辅助函数。
- 流水线设置页新增**「预设任务设置」专区**（`projects/pipeline/pipeline.html`，Profiling 脚本卡片之后、
  脚本目录卡片之前）：可添加/编辑/删除**自定义预设任务**——每项配置名称（非空、不与系统预设及其他
  自定义同名）、脚本（按名从 scripts 目录选用，支持「识别参数」与参数值覆盖，语义同环境清理脚本）、
  「失败阻断」（脚本非零退出阻断后续阶段）、「默认位置」（最前=环境检查之后 / 最后=Profiling 之前，
  仅未编排过位置的流水线生效，已编排的标记保持原位）、「默认勾选」。自定义预设与系统预设（环境清理/
  环境检查/Profiling）同一机制：主控「预设任务」多选勾选启用（面板系统三项后动态列出自定义项）、
  流水线编辑器中 🔒 预设任务（自定义）行仅可排序、运行到编排位置时执行脚本（注入 TARGET_*/IMAGE_*/
  PIPELINE_NAME 与 ARCHIVE_* 环境变量）、日志归档固定 00 号任务日志；仅页面运行支持，不进服务端定时
  计划。实现上预设定义统一经 `presetDefOf` 查询（系统 `PRESET_DEF` + 自定义 `customPresets` 派生）；
  `customPresets` 随服务端配置（worktable-pipeline.json）跨浏览器同步并镜像 localStorage
  `pip-customPresets`，导出/导入设置文件同样携带；`withPresetMarkers` 过滤已失效 pkey 的预设标记
  （自定义被删除或旧 promCollect 行）并按 pos 补默认位置；流水线默认运行参数、阶段同名拦截、历史回放
  序号识别（`isPreStage`）同步支持自定义预设。
  测试：新增 `projects/pipeline/tests/test_custom_preset_tasks.js`（12 例：归一化清洗、定义查询、
  枚举顺序、名称表重建、勾选判定、默认位置/失效标记过滤、运行展开与快照隔离、默认参数双模式）。
- 流水线运行中阶段节点与阶段详情显示实时耗时（`projects/pipeline/pipeline.html`）：编排区运行中节点的进度文本由纯百分比（如 47%）改为「百分比 · 已耗时」（如 47% · 1m30s），metaFor 与共享 tick 轻量直改（stageTickPaint）同口径，500ms tick 内仍只直改文本不触发全量渲染；阶段详情运行中同样新增「耗时」行（终态显示不变）。同步更新 `projects/pipeline/tests/test_stage_tick.js` 断言并新增 1m30s 用例。
- 新增**服务端流水线运行的阶段级实时已耗时数据通路**（供远端预览编排区展示运行中阶段的实时耗时；此前服务端
  只在阶段开始时写 `{status:'running',progress:5,dur:0}`、结束时才回填最终 dur，运行期 dur 恒为 0，其他
  浏览器看不到已耗时）。服务端（`src/index.ts`）：执行器在阶段进入 running 时把该阶段开始时间戳
  `startedAt`（服务端纪元毫秒）随 `updateStage` 落入执行池节点（后续进度/终态更新沿用该值，终态 dur 仍是
  服务端结算值）；队列快照白名单 `cleanQueueNode` 透传节点的 `startedAt`（仅正数，非法值丢弃；run 级快照
  结构不变）。客户端（`projects/pipeline/pipeline.html`）：`queueNodePresence` 镜像透传 `startedAt`；
  远端预览构建（`remoteQueuePreviewRc`）与每秒队列轮询（`pullRemoteQueue`）对 `status==='running'` 且带
  `startedAt` 的节点把 `dur` 按本地时钟实时折算为 `max(0,(Date.now()-startedAt)/1000)`（时钟偏差折出负值
  钳到 0，与 run 级 startedAt 经 fmtRelative 用本地时钟展示的既有口径一致）；轮询处折算使 dur 每秒前进、
  快照签名随之变化，队列区与远端预览因而逐秒刷出实时已耗时（无运行中阶段的静态快照仍享签名降耗）。
  无 `startedAt` 的旧服务端/旧浏览器数据保持原 dur 不动（滚动升级兼容）；孤儿中断条目是冻结的最后已知
  状态，不做实时折算。测试：`tests/pipeline-queue-presence.test.mjs` 补 startedAt 透传与非法值丢弃断言；
  `tests/pipeline-run-api.test.mjs` 补执行池节点 startedAt 落快照、后续更新保留与执行器启动更新携带
  startedAt 断言；客户端 `projects/pipeline/tests/test_queue_item_preview.js` 新增 queueNodePresence
  透传/丢弃与 remoteQueuePreviewRc 实时折算（含时钟偏差钳 0）用例，`test_queue_poll_throttle.js` 新增
  轮询折算驱动逐秒重绘用例。
- 流水线 EvalTokens 阶段**适配服务端同步执行的 /run**（任务跑完才返回启动响应）：此前代连（remote 模式）
  的 /run 走 `/api/worktable/proxy` 硬编码 20s 上游超时，长任务一律在 20s 被判 `request timeout` 失败
  （任务实际仍在 EvalTokens 服务端正常跑完）。改动：`/api/worktable/proxy` 支持按请求 `timeoutMs`
  （缺省 20s 不变，夹取 1s~24h——上限只兜「服务彻底假死」的极端情况，阶段「超时(分钟)」留空即等效
  不限时）；`pipeline.html` 的 `evaltokRequestJson` / `evaltokStartRun` 新增超时透传，运行器按
  「阶段超时（留空 24h 兜底）+30s 宽限」计算 `startTimeoutMs`
  传给 /run 调用——宽限保证阶段自身超时先于代理超时生效，超时文案与清理路径不变。拿到 run_id 后
  首轮轮询即确认终态，输出变量捕获、报告归档、中止/级联中止语义均不变；local（浏览器直连）模式本就
  无 20s 限制，无需改动；服务端执行池路径（`executeServerEvaltokensStage`）无阶段超时时本就不限时，
  无需改动。
  测试：新增 `tests/proxy-timeout.test.mjs`（缺省值与 1s~24h 夹取规则）。
- 阶段详情新增**「日志文件」行**（`projects/pipeline/pipeline.html`，实时运行与历史回放两个渲染路径
  均有，DOM 行 `#stageLogRow`）：值为该阶段归档日志文件路径（`run-<tag>-NN-任务名.log`），优先取
  服务端实际写完的 `_serverLogFile` / 预期路径 `_serverLogExpectedFile`，否则按归档目录 + `taskLogFile`
  规则推算；路径过长以省略号截断，无路径显示「—」。行右侧两个 mini 按钮：「🔍 AI 分析」效果同
  运行历史标题行的「AI 日志分析」——对该阶段所属运行新建 AI 会话并填入日志分析提示词草稿（不自动
  发送），实时运行从历史记录按 tag 匹配，运行中尚未写入历史时禁用并提示；「📂 打开日志」效果同
  「📂 打开归档目录」——打开日志文件所在目录（优先 dsh-better-sidebar 侧边栏文件夹窗口并收起会话窗，
  未装或桥不可用时回退服务端系统文件管理器 `xdg-open`/`gio`/`open`；先等待该目录归档写落盘，目录
  不存在时回退父目录），状态反馈显示在行内提示。「打开归档目录」的原有实现抽出公共函数
  `openFolderWithFeedback` 复用，行为与文案不变。行仅在「当前运行存在（实时）/ 回放历史」时渲染，
  避免空页面噪音；按钮按路径存在性与可分析态自动禁用。动机：在阶段详情里就能直接看到本阶段日志
  文件位置，一键 AI 分析所属运行、一键打开日志目录，不必回运行历史标题行操作。
  测试：新增 `projects/pipeline/tests/test_stage_detail_log_row.js`（契约与行为断言）。
- 使用统计弹窗新增**「当前在线」人数显示**：客户端每标签页生成随机 client id，根组件挂载即向新端点
  `POST /api/worktable/usage/heartbeat` 上报一次心跳、之后每 30 秒一次（body `{ user, client }`，
  静默失败不打扰交互；首跳时用户名可能尚未探测到，后续心跳自动带上）；服务端把心跳按 key upsert
  进纯内存在线表——登录用户按 `u:<用户名>` 归一（同一用户多标签页算 1 人），匿名按 `c:<client>`
  计（每个客户端实例 1 人），90 秒（`ONLINE_TTL_MS`）无心跳的条目在 touch / count 时懒清理，
  不落盘、重启清零。`GET /api/worktable/usage` 响应新增顶层 `online` 字段；弹窗摘要 chips 行
  最前面新增带绿点的「当前在线 N」chip（zh「当前在线」/ en「Online」），chips 行改为数据加载
  即显示（即使暂无使用记录，在线人数仍有意义），空态提示保留在 chips 行下方原位置。心跳端点
  仅活内存表，不写盘、不记使用事件；body 超 16KB → 413、client 缺失 → 400、非 POST → 405。
  测试：新增 `tests/online-count.test.mjs`（13 例：sanitizeHeartbeat 清洗、key 归一规则、
  TTL 过期懒清理、路由接线文本断言、客户端 online 解析契约）；`tests/usage-stats.test.mjs`
  空结构期望同步补 `online: 0`。
- 流水线**新增「拥有者」属性，任务列表筛选与署名展示改用拥有者、支持搜索用户**（`projects/pipeline/pipeline.html`）：
  流水线现在有三个署名属性——`createdBy` 创建者（创建时定死的历史署名，不再参与权限判定）、`owner`
  拥有者（拥有编辑/删除权限；新建与复制时署为当前用户；存量流水线无 `owner` 字段时经 `plOwnerOf` 回退按
  `createdBy` 计）、`updatedBy` 最近修改者（每次保存/拖拽改序刷新）。`migratePipelineDefaults` 增加
  `owner` 归一化；`plEditable` 权限判定、编辑/删除守卫、编辑器只读标题与 alert 口径全部由「创建者」改为
  「拥有者」（新增 `plCreatorOf` 取历史创建者）；编辑存量未署名流水线时创建者与拥有者各自空白才补署当前用户。
  任务列表筛选栏「创建者」下拉换成可搜索输入框（`input#plFilterOwner` + `datalist#plOwnerList`）：特殊项
  （我的（含预置）/全部/仅预置/未署名）以中文标签选择，用户名原样输入；匹配口径为——输入等于某已知拥有者
  用户名时精确匹配（防「ali」波及「alicia」），否则按子串大小写不敏感搜索拥有者；localStorage `pip-plFilter`
  旧值（mine/all/builtin/unknown/旧用户名）加载后照常生效并正确回显。行内署名 `· 创建 @x` 改为 `· 拥有 @x`
  （修改人不同仍附 `· 修改 @y`；创建者与拥有者不同时署名行悬停提示「创建者 @z」）；编排区节点只读提示与
  帮助文本同步为拥有者口径。测试：新增 `projects/pipeline/tests/test_pipeline_owner_filter.js`（标签↔模式键
  映射与回显、用户名精确匹配、子串大小写不敏感搜索、datalist 填充与聚焦不打扰、localStorage 旧值兼容，11 例）；
  `test_pipeline_owner_edit.js` 扩充 owner≠createdBy 权限矩阵、存量无 owner 回退、`migratePipelineDefaults`
  owner 归一化与 savePlForm 三态补署用例；`test_pipeline_audit_trail.js` 等既有测试同步更新。
- 调整**流水线编辑器「+ 添加阶段」按钮移至冻结底栏最左边**（`projects/pipeline/pipeline.html`
  的 `#plForm` 弹窗）：该按钮原先与「保存 / 取消」一起靠右排列在弹窗底部冻结行右端，阶段较多
  需滚动时添加入口远离编辑起点。现将其移到该冻结行的最左边；草稿提示 `#plDraftTip`
  （保留 `margin-right:auto`）紧随其后，「保存 / 取消」仍固定在右下角。底栏保持冻结、
  不随阶段列表滚动；只读模式下隐藏添加阶段按钮的逻辑不变。
  测试：新增 `projects/pipeline/tests/test_pipeline_footer_layout.js`（底栏按钮顺序与冻结位置契约断言）。
- 流水线编辑页**阶段定时配置行的勾选标签精简为「本地运行」**（`projects/pipeline/pipeline.html`）：
  原勾选标签「需本地运行，不支持定时」精简为「本地运行」，标签后新增 ⓘ 信息注释
  （悬停提示「本地运行任务不支持定时任务」），把「不支持定时」的说明从标签正文移入悬停提示。
  纯文案/提示改动，勾选行为不变。
- 客户端支持运行中插件代际更新提示：轮询 `/api/worktable/health` 的版本/revision，检测到变化时提示刷新页面即可加载新资源；保留旧服务端无 revision 时的兼容行为。升级与回退 AI 提示词不再要求重启 dsh web。
- 新增流水线执行池代际生命周期：`stopAccepting`、`drain`、`dispose` 与 generation 绑定；升级切换后旧代排队/运行计划、节点租约和子进程继续自然完成，新代接收后续计划；队列快照、取消和日志查询保留代际信息，插件退出时清理计划 tick 与队列资源。
- 补强热替换桥接：通过全局 supervisor 共享代际 manager 与节点租约，引用归零时等待可 await 的 disposer，并为 HMR 立即重挂载保留可取消的短暂清理窗口；same-id generation 替换会正确回收旧池，health 返回当前 generation 与 draining 代。
- 改进**设置弹层底部「版本信息 / 历史 / 用量 / 检查更新 / 自动检查更新」行冻结为 sticky 页脚**
  （`src/client/styles.ts`，DOM 结构不变）：该版本行原先只是设置弹层（`.dsh-wt_manage.dsh-wt_pop.dsh-wt_settings`，
  `max-height:min(540px,…)`、`overflow:auto` 的滚动弹层）末尾的普通一行，随内容滚动——设置项较多、
  内容超过一屏时会被滚出视野，版本号与「检查更新 / 自动检查更新」入口需手动滚到底才能看到。现
  `.dsh-wt_versionRow` 改为 `position:sticky;bottom:0` 吸附在面板可见区底部最后一行：
  `z-index:1` + 不透明背景 `var(--dsw-alias-bg-base,#0b0e14)`（与 `.dsh-wt_manage` 面板底色一致）
  遮住滚过的内容；`margin:8px -6px -6px` 负边距抵消面板 6px padding 做全宽出血，使顶部
  `border-top` 分隔线横贯面板；`padding:8px 6px 6px` 补偿使行内内容视觉位置与改动前一致。
  版本行仍是设置面板最后一个子元素；内容不足一屏时 sticky 不产生位移，无行为变化。
  测试：新增 `tests/settings-version-sticky.test.mjs`（3 例契约断言）。
- 新增**流水线运行状态查看工具** `projects/pipeline/tools/pipeline_status.py`（单文件、仅标准库、Python 3.6+，
  本机执行、无需登录——`/api/worktable/pipeline/queue` 在 dsh-auth-gate 之后且会话 token 落盘只存 sha256
  无法复用）。三个数据源取并集：① dsh web 进程树（pid 文件自动从脚本位置向上查找，失效则按
  `bin.js web` 扫描）中 `pipeline/scripts/*.sh` 脚本进程为正在跑的直接证据；② 归档目录
  `<archiveDir>/<流水线名>_<14位时间戳>/` 下 `run-*.log` 的活跃写入（默认 300s 阈值，`ACTIVE_SECONDS`
  可调），覆盖 HTTP / Jenkins / EvalTokens 等不产本地进程的阶段；③ 历史存储按 run tag 判终态（
  `worktable-pipeline.json` 的 history 命中即已结束），避免把远端静默长阶段误报为在跑——静默且无终态的
  归入「疑似在跑」单独列出（`SILENT_SECONDS` 窗口默认 6h）。scriptsDir / archiveDir 从
  `$DSH_HOME/storages/worktable-pipeline.json` 读取（`WT_ARCHIVE_ROOT` 等环境变量可覆盖）；
  `follow-xds-head-logs.sh` 会 daemonize 脱离 web 进程树，工具按归档目录归属把在跑运行的这类进程挂回
  运行条目（附属进程），其余游离进程列为「残留进程」并标注对应运行终态。设置 `DSH_AUTH_TOKEN`
  （auth-gate 会话 token）可附带查询服务端执行池 / 排队 / 各客户端上报 / 失联孤儿条目；`--json`
  输出机器可读结果。用法：`python3 projects/pipeline/tools/pipeline_status.py [--json]`。测试：
  新增 `projects/pipeline/tools/test/test_pipeline_status.py`（12 例：日志/目录正则、时长格式化、
  目标机与归档目录提取含空格转义前缀对齐、history 终态索引、归档扫描三态分类、进程证据覆盖静默、
  daemonize 附属进程归属、pid 文件优先与失效回退），接入 `projects/package.json` 的 `test:python`。
- 修复**流水线「运行队列」刷新即丢与跨用户不可见**（页面驱动的本地执行——含「需本地运行」阶段的流水线——刷新/
  关闭页面后正在执行的任务从运行队列彻底消失、找不到最后执行状态；且自 ac756d3「运行队列改由服务端持有」起
  renderQueue 的 `scheduleQueuePublish()` 调用被摘、publishQueue 成死代码，页面运行从不向服务端上报，其他登录者
  完全看不到别人页面驱动的流水线）。服务端修复（`src/index.ts`）：`/api/worktable/pipeline/queue` 新增「失联孤儿
  登记簿」——schemaVersion 3 客户端的 runs/queue 条目在新快照中消失且不在 `completed` 列表、或在场记录 45 秒
  TTL 过期时，不再静默清除而是转入孤儿簿（条目=白名单清洗快照 + ownerId/ownerLabel/kind/orphanedAt；同 owner
  重新上报同 id 复活出簿，completed 补报出簿；orphanedAt 超 24h 丢弃、总量上限 100）；孤儿簿持久化到
  `storages/worktable-pipeline-orphans.json`（防抖 300ms 原子写，dsh web 重启不丢，启动异步加载、损坏按空簿）；
  POST 新增 `action:'dismiss'`（ownerId+id，200 dismissed / 404 missing）；GET 响应新增顶层 `orphans` 数组
  （恒存在，旧客户端无感知）；schemaVersion 1/2 旧页面保持静默清除语义不进簿（滚动升级兼容）。客户端修复
  （`projects/pipeline/pipeline.html`）：恢复 renderQueue 末尾的 `scheduleQueuePublish()` 上报（防抖 500ms）；
  PUT 体升级 schemaVersion 3 并携带 `completed`——「最近终态」登记（finish/abortRun/cancelQueue/重置全部登记点）
  随 sessionStorage（pip-qfinished，>60s prune、上限 64）跨刷新存活，刷新后首帧上报即豁免刷新前已正常完成的
  条目；当前 activeRuns 的 originQueueId 一并并入 completed（排队项启动转运行是正常移交而非消失）；
  新增不随 document.hidden 暂停的 10 秒心跳（页面隐藏时执行仍在继续，停心跳会被误判失联）与 pagehide
  sendBeacon 最终快照；队列区新增「已中断（页面刷新/关闭）」分组展示孤儿条目（[来源浏览器] 执行人 · 流水线 ·
  时间 + 「已中断/排队中断」徽标，计入头部计数），点击只读预览最后已知阶段/节点快照（明确提示执行已中断、
  日志不可拉取），支持「重跑」（pipelineId + env 字符串按「，」/、拆 IP 映射回环境列表 + branch/strategy 经
  runPipeline 本地队列分流，成功后顺手 dismiss；流水线已删除则置灰）与「移除」（POST dismiss，canControlRun
  权限口径同服务端队列按钮）；旧服务端无 orphans 键时特性探测降级不渲染。测试：服务端新增
  `tests/pipeline-queue-orphans.test.mjs`（9 例：消失入簿/completed 豁免/TTL 过期入簿/复活/dismiss 三态/v1v2
  兼容/持久化重载/保留策略），`pipeline-queue-presence.test.mjs` 沙盒注入同步新外层符号；客户端新增
  `projects/pipeline/tests/test_queue_orphans.js`（16 例：PUT 体契约、登记持久化与 prune、分组渲染与旧服务端
  降级、dismiss 参数与权限拦截、预览 rc 形状与自愈、重跑 env 映射兜底、心跳/pagehide 接线），
  `test_queue_item_preview.js` 断言同步 schemaVersion 3。
- 修复**流水线「复制」副本改名被永久锁死**（编辑器改名保存报「该流水线已被其他浏览器修改」并回滚为
  「（副本）」，刷新/重试均无效，只能整页重载；高发于复制紧贴页面打开、慢链路或多标签页场景；生产存储中
  17 条「（副本）」后缀条目从未改名成功）。根因是共同基线滞后于磁盘与条目比对键序敏感的叠加：
  ① 首屏/手动刷新的 GET 快照在「请求发出后、应用前」被复制副本的 save-one 反超（大存储 + 公网慢链路下
  窗口长达数秒），三方合并把刚落盘的副本误判为「远端已删除」从页面冲掉且基线被污染回退；
  ② 手动刷新整表替换 pipelines 且从不推进基线，在途改名也被快照冲掉（改名后一刷新即还原）；
  ③ 基线缺条目而磁盘有条目时每次单条保存都 phantom 409（baseOne=null ≠ 磁盘条目），409 响应携带的
  磁盘真值又被客户端丢弃，锁死永不自愈；④ 服务端合并层对条目内容同一性用 JSON.stringify 比对（键序
  敏感），同一条目经编辑器重建阶段对象/旧版客户端/导入等不同键序字节落盘后，内容未变也被判「偏离基线」。
  客户端修复（`projects/pipeline/pipeline.html`）：新增基线纪元 `stateFetchEpoch` 与
  `fetchPipelineStateFresh`（GET 在途期间被保存反超即判快照过期并重拉，上限 2 次防活锁；loadServerState
  与手动刷新统一走该通道）；手动刷新 `applyPipelineRefreshPayload` 改与 loadServerState 同口径（按 id
  三方合并保留本页在途改动 + 新鲜快照推进共同基线，含 keptBaseEntries 补回，迁移链补 migratePromPreset）；
  `pushPipelineOne` 409 分支采纳响应携带的磁盘真值为新基线并合回本页（phantom 冲突一次自愈，编辑器回滚
  按既有 baseAdvanced 逻辑取最新确认版，重试保存即成功；真实并发冲突语义不变）。服务端修复
  （`src/index.ts`）：`mergePipelineConfigForWrite` / `mergePipelineOneForWrite` 的条目比对改剥离
  favoriteUsers/pinnedAt 后的**键序无关深比较**（新增 `samePipelineContent`，复用 deepEqualIgnoring，
  数组顺序仍算内容）；save-one 对「客户端基线缺失但上送内容与磁盘一致」的保存（如确认丢失后的重试）按
  幂等成功处理并随响应自愈基线，内容真实偏离仍 409 防静默覆盖。测试：客户端新增
  `projects/pipeline/tests/test_pipeline_copy_rename.js`（8 例端到端级：真实客户端函数 × 服务端真实
  合并层 × 内存磁盘假服务器，含首屏竞态/陈旧标签页/在途改名抗刷新 3 例修复前验证失败的复现用例）；
  服务端新增 `tests/pipeline-copy-rename.test.mjs`（5 例，含键序重排 phantom 409 复现、幂等重试与
  内容偏离仍 409）；既有测试桩同步新全局/提取（test_init_no_autoput、
  test_loadserverstate_merge_local_add、test_pipeline_multiuser_save、test_pipeline_save_consistency、
  pipeline-config-concurrency、pipeline-trust、pipeline-config-refresh）。已知遗留：陈旧标签页首次
  保存仍会按冲突告警一次（无法与真实并发冲突区分），但基线已自愈、重试即成功；pushState 的
  silentConflict 409 路径（仅旧服务端回退路径）未做磁盘真值采纳。
- 修复**流水线编辑器保存的浏览器端竞态**（多人共用环境下新建/编辑流水线保存偶发失败，报「流水线已不在
  本页列表中（可能被其他浏览器删除）」）：保存链路 savePlForm 先把新流水线 push 进页面全局列表、
  pushPipelineOne 再排等前序全量 PUT；前序 PUT 若 409，pushState 自愈分支的 loadServerState 会**整表
  替换** pipelines，把还没落盘的新流水线冲掉（localStorage 一并重写），锁释放后 findPipeline 找不到
  目标 → alert 报错并回滚删除，保存彻底失败。修复口径（仅 `projects/pipeline/pipeline.html`，服务端
  src/index.ts 不动）：① persistInFlight 串行锁从 `while(await)` 的 check-then-set（两个并发等待者
  会在前序释放后同时通过检查、同进临界区）改为 **Promise 链互斥**——读链尾与挂链尾之间无 await、同步
  原子，pushState/pushPipelineOne 严格按到达顺序逐个放行，「拿到锁再取基线快照」语义不变（参考服务端
  withStoreLock 的链式写法）；② loadServerState 的流水线应用改**按 id 三方合并**（新函数
  mergePipelinesFromServer：共同基线 serverConfigBase.pipelines / 本地 pipelines / 远端响应
  cfg.pipelines）——仅本地存在（基线/远端都无）的未落盘新增保留（维持本地相对顺序、追加合并结果末尾）；
  基线有远端无（远端已删除）本地与基线一致随删、本地有改动（删除可能正撞保存在途）保留本地；本地==基线
  取远端、远端==基线留本地、双边都改且不一致取远端（同步语义下服务端为准）；比对豁免顶层
  favoriteUsers/pinnedAt（新增页面侧 stripPipelineSharedMeta，与服务端合并层同口径）；新基线以响应
  快照为准，「基线有远端缺而保留」的条目把原基线条目补回（防 baseOne 回退成 null 后与 diskOne(null)
  相等，下次 save-one 把他人已删条目静默重建——本应 409 由用户抉择）；远端新增/修改/删除照常同步页面
  与 localStorage；③ loadServerState 迁移链补齐 migratePromPreset（与 loadPipelines 对齐）。
  测试：新增 `projects/pipeline/tests/test_loadserverstate_merge_local_add.js`（8 例：三方合并口径 ×4、
  loadServerState 远端同步/基线补回 ×2、竞态主场景「本地新增 + 409 自愈重拉后条目仍在、save-one 照常
  发出并成功」、串行锁两个并发保存严格按序且后序取前序确认后的新基线）。
- 修复流水线页**每次打开都自动发起一次全量 PUT 保存**（`projects/pipeline/pipeline.html`）：触发源是
  `applyTheme()` 末尾一次无条件 `persistState()`——它随 `renderAll()` 在首屏初始化、`loadServerState`
  成功重渲染、409/403 自愈重拉时被反复调用，400ms 防抖后合成一次整表 PUT；本地相对刚应用的服务端
  快照并无任何实际变化，多人在场时每个访客的这次自动写都是潜在 409 冲突源（409 自愈重拉放大保存
  竞态）。修复：渲染与持久化分离——`applyTheme()` 只应用主题到 DOM 与 localStorage，主题下拉
  change 监听器（用户真实改选）显式 `persistState()`，系统深浅色翻转不改 `themePref`（collectConfig
  无差异）不写。三个正当写路径保持原样：服务端 config 为空时迁移本地默认状态上去、内嵌日志迁移
  确有变更后回写、脚本目录兜底确实改写值（`maybeAdoptInstalledScriptsDir`）。未采用「与服务端快照
  深比较闸门」方案：旧客户端写出的 config 缺新字段会深比较假脏、重新引入每访客一次自动 PUT，且首屏
  renderAll 先于 GET 完成时基线为空判断失效。测试：新增 `tests/test_init_no_autoput.js`（7 例——
  一致时首屏+加载全程零写、自愈重拉零写、两个正当写路径不破、applyTheme/自愈块源码契约；已对
  修复前源码验证前 3 例如期失败）。
- 跟进修复**「编译发行」版本 bump 回推遇网络抖动即失败**（同一 v1.1.10 发行重跑时，克隆/构建/测试均过，
  死在仓内 `scripts/build.sh` 的 `git push origin HEAD:main`，报错还误导为「凭据无推送权限」）：回推改
  `GIT_PUSH_RETRIES`（默认 3）次自动重试、递增退避（`sleep $((i*5))`）；远端地址含克隆凭据，失败输出先经
  `push_mask` 脱敏再回显；末次失败区分诊断——连接类错误（`Failed to connect`/`Connection timed out` 等）
  报「对端不可达/一次性网络抖动，与凭据无关」，其余保留原「凭据无推送权限或分支有新提交」指引。
  冒烟验证：stub git 三场景（抖动后成功 / 持续断网 / 权限拒绝）行为与脱敏均正确。
- 修复**「编译发行」遇一次性网络抖动即整流程失败**（2026-10-08 v1.1.10 发行构建因
  `Failed to connect to github.com port 443` 一次性连接超时直接失败）：页面内嵌三段脚本与仓内参考脚本
  统一加自动重试与连接失败诊断。① `code-review-prs.html` 的 `BUILD_WRAP_SCRIPT`（构建包装）与
  `PUSH_TAG_SCRIPT`（Tag 兜底推送）的浅克隆改 `GIT_CLONE_RETRIES`（默认 3）次重试——每次失败脱敏回显 +
  诊断、清半截克隆目录、递增退避（`sleep $((i*5))`），末次才 fail；推送步骤同加重试（不清目录）。
  ② `UPLOAD_ASSETS_SCRIPT`（GitCode 产物上传）的 GET upload_url / PUT 直传 OBS 两个 curl 加逐文件
  `UPLOAD_RETRIES`（默认 3）次重试。③ 三段脚本各自的 `net_hint` 在 CONNECT tunnel 分支外新增识别
  `Failed to connect`/`Couldn't connect`/`Connection timed out`/`Connection refused`/`Operation timed out`，
  提示对端不可达/网络抖动（与凭据无关）、已自动重试、可在设置页换「构建网络代理」直连/自定义。
  ④ `projects/codereview/scripts/build.sh`（参考构建脚本）同步加克隆重试与同款 net_hint 分支。
  测试：新增 `tests/codereview-build-clone-retry.test.mjs`（5 例，含 net_hint 的 bash 实跑行为断言与整脚本
  `bash -n`）与 `tests/codereview-tagpush-upload-retry.test.mjs`（5 例）；参考脚本经本地 bare 仓正常路径 +
  不可达地址重试路径两次冒烟验证。
- 修复宿主 0.2.0-rc.1 升级后工作台「页面修改」✏️ 等会话桥全面失效（`src/client/index.tsx`，修复
  「编辑项目按钮用不了」）：① 0.2.0 起 `sessions.binding/scope` 仅对已 retain 的会话代际可解析，
  新建会话后 `fillSessionDraft` 永远轮询不到 binding（报 `no fill path`）——新增
  `retainSessionRef`/`releaseSessionRef`，`fillSessionDraft`/`promptIntoSession`/`waitForSessionAssistant`
  操作期间保留会话作用域（旧宿主无 retain 时原路径不变）；② `sessions.open` 被删（导航归视图属主）——
  新增 `openSessionInUi`（优先 `ctx.uiWorkspace.openSession`，旧宿主回退 `sessions.open`），14 处
  新建/联动/回切与 `__dshOpenSession` 导出统一切换；③ 列表快照 `current` 字段删除——新增
  `currentSessionIdOf`（旧读 `snap.current`，新推导 `byId` 行 `retainedBy.mainView>0`），
  ensureSessionModel/fetchSessionGroups/syncSessionScope/openSplit/openConsole 五处切换（项目↔会话
  联动的「切会话关项目/回切」随之恢复）。sessionBridge 初始化补 `uiWorkspace`（`ctx.get` 软探测，
  规避 cordis 未 inject 服务属性访问抛错）。测试：新增 `tests/session-bridge-retain.test.mjs`
  （15 例），`tests/ai-chat-result.test.mjs` 的 vm 提取器改健壮配对并注入新助手。
  已知遗留（0.2.0 适配后续项，本次未动）：byId 行 `pendingInteraction`/`completed` 迁至
  `ctx.uiSession.sessionStatus`、`subagentsByParent`→`projectionsBySession[].values.subagentCatalog`、
  `jobsBySession`→`ctx.jobs.watchRows`、`hostApi`（connection.api 已删）→`ctx.remote`——
  项目卡提醒点/运行时长/新会话模型兜底修复暂退化，待后续适配。
- 修复**多用户登录下「复制/编辑后的流水线无法保存」**（phantom conflict，已用真实函数复现定位）：
  `favoriteUsers`（各用户收藏）与 `pinnedAt`（置顶）这类非内容字段存在共享流水线条目上，却参与服务端三方合并的
  JSON 全字段同一性比对——他端一次收藏/置顶即让该条「偏离基线」：编辑走 save-one 被 409 拒绝；全量 PUT
  （复制/删除/设置等）任一无关条目双边分歧即整批 409 且客户端静默、基线不前进，后续保存持续锁死。
  服务端（`src/index.ts`）：`mergePipelineConfigForWrite` / `mergePipelineOneForWrite` 的变更与冲突判定改为
  剥离 `favoriteUsers`/`pinnedAt` 后的内容比对，两个字段一律按三方规则合入结果（favoriteUsers 集合合并
  `(client ∩ disk) ∪ (client − base) ∪ (disk − base)`，并发收藏不丢、取消收藏生效；pinnedAt 标量三方取
  客户端相对基线的变化方；形状归一：空收藏/零置顶省略键）；`trustedPipelineViolations` 豁免键扩为
  `['favoriteUsers','pinnedAt']`（与守卫本就豁免 favoriteUsers 的语义对齐，置顶属视图排序元数据）。
  客户端（`projects/pipeline/pipeline.html`）：`copyPipeline` 改走 save-one 单条保存（副本只新增一个条目，
  天然免疫无关条目并发冲突；旧服务端回退全量），硬失败 toast 提示且本地副本保留并防抖重试；`pushState`
  全量 PUT 409 在非编辑器路径下 toast「已被他人修改，已刷新为最新状态」并 `loadServerState()` 重拉自愈
  （编辑器与可信标记路径自带回滚 + alert，经 `silentConflict` 保持单处提示）。测试：服务端
  `tests/pipeline-config-concurrency.test.mjs` 新增 9 例（收藏/置顶并发合并、真冲突仍 409、守卫豁免、形状归一），
  客户端新增 `projects/pipeline/tests/test_pipeline_multiuser_save.js` 6 例；既有 `pipeline-trust` 两处断言随形状归一
  改为校验键省略。fix/session-bridge-0.2.0
- 流水线归属编辑限制新增 **admin 例外**（`projects/pipeline/pipeline.html` 的 `plEditable`，修复「编辑按钮用不了」
  类问题）：原规则「非可信流水线仅创建者可编辑/删除，admin 无例外」会使创建者账号注销/改名后的流水线对所有人
  （含 admin）永久只读——行内「编辑」变「查看」、编辑器整体只读。现 admin 可编辑/删除任意非可信流水线；
  内置/可信「仅 admin」、非 admin「仅创建者」、未署名全员可编辑、token 模式退化全权等其余规则不变；
  行按钮/编辑器只读/保存与删除兜底/主视图拖拽均经 `plEditable` 级联一致（服务端本就只对可信/内置做写校验，
  无创建者归属校验，无需改动）。编排区说明文案与相关注释同步更新；测试翻转
  `test_pipeline_owner_edit.js` / `test_pipeline_trusted.js` 中「admin 无例外」断言，新增
  `tests/test_pipeline_admin_edit.js`（9 例覆盖完整权限矩阵）。
- 流水线页浏览器 CPU 降耗（`projects/pipeline/pipeline.html`，用户可见行为不变；实测开关页面 CPU 差约
  20% 的场景针对优化）：① 阶段详情日志改**增量渲染**（`syncDetailLogLines`）——日志增长只追加新增行
  （DocumentFragment 一次挂载），触顶窗口平移带逐行校验、中部替换原位插入、外部改写回退全量重建，
  消灭每次刷新对日志区的全量 DOM 重建；滚动语义不变（贴底跟随、上翻保持）；② 各阶段进度定时器
  合并为全页面唯一 500ms tick（五个执行器改为登记进度任务、摘除即停表；页面 hidden 停表、恢复可见
  立即补刷新；tick 内只直改进度条/耗时文本，不再每 tick 全量扫节点与重绘详情；`rc.over`/`rc.token`
  迟回守卫语义不变）；③ 运行队列轮询按页面可见性暂停（恢复时立即补拉），响应内容签名未变跳过
  重绘；进行中脉冲动画由 box-shadow 扩散改为 opacity/transform 合成器属性。新增
  `tests/test_stage_tick.js`、`tests/test_queue_poll_throttle.js`，扩充 `test_log_render_scaling.js`，
  调整 `test_plan_terminate.js`（快照未变时不再强制重绘即目标行为）。
- 新增「友商 Tokens API 性能对比」项目页（`projects/friend-perf.html`）及其服务端中转路由
  `POST /api/worktable/llm`（`src/index.ts`）：对智谱 / 百炼 / 混元 / 硅基流动 / 七牛云等 OpenAI 兼容
  chat/completions 接口做手动 / 定时流式压测，横向对比 TTFT（首 token 延迟）与 TPOT（每 token 耗时），
  含概览柱状图、趋势折线、分桶统计（提供商 × 输入长度 × 设定缓存命中率，nearest-rank 分位数）、
  综合排名与记录页（失败原因可展开），结果经 `/api/worktable/write` 落盘项目文件夹
  `friend-perf-results.json`、localStorage 仅作缓存兜底；提示词按「缓存命中率」拼装跨轮固定前缀 +
  每轮随机后缀以触发厂商 prompt 缓存，真实缓存命中取 usage 回传的 cached_tokens /
  prompt_cache_hit_tokens。中转路由安全边界：仅 https 目标、复用 `isLocalTarget` 反向拒绝回环/内网
  （不成为 SSRF 出口）、仅放行 `/models` 与 `/chat/completions`，密钥由调用方自带、服务端不落地，
  响应带背压逐 chunk 透传。计时口径修正两处：**提示词构造移出计时窗口**（`buildPrompt` 早于 `t0`，
  本地构词开销不再计入 TTFT/总耗时；`genText` 由每轮 `join` 重算全长的 O(n²) 改为增量计长 O(n)——
  实测旧代码在 110k tokens 输入下浏览器侧开销首轮 ~27s、之后每轮 ~2s，修复后降至 ~15ms）；
  **流收尾解析残余 buffer**（`done` 时冲刷 TextDecoder 并解析未被换行终止的最后一段，厂商把 usage
  块放在流末尾且无尾换行时不再整块丢失导致 outTokens 退回粗估、cached_tokens 丢失、TPOT 失真）。
  新增**双口径 TTFT**：中继等到上游首个 body chunk 再回写响应头，经 `x-worktable-llm-ttfb` 回传
  「服务端→厂商首 chunk 耗时」，页面记录表新增「服务端TTFT」列（`rec.serverTtft`）——浏览器感知
  TTFT 含浏览器→服务端上行链路（大提示词经慢上行链路时会被上传耗时 1:1 抬高，实测 514KB 请求体在
  64KB/s 上行下 TTFT 被抬高 ~8s），服务端口径不含该段、更接近厂商真实水平。**提示词构造整体移至
  服务端**：页面只上传 `promptSpec={inputLen, cacheHit, outputLen}` 参数（几百字节），中继经
  `buildBenchPrompt`（与页面旧版同算法，固定前缀为纯确定性函数，跨轮/跨重启逐字节一致，已验证与
  页面旧实现产出完全相同，厂商侧缓存连续性不受影响；随机后缀每轮换新保持命中率语义）构造 messages
  并覆盖 payload，浏览器→服务端不再有大 body 上传，两个 TTFT 口径在正常链路下应趋于一致；
  页面侧 `buildPrompt`/`genText`/`getPrefix` 全数移除，`estTokens` 仅留作 TPOT 兜底估算。
  SSE 行解析抽为纯函数 `parseSseLines`（content / reasoning_content 兼容、[DONE] 与坏行容错）；
  测试：`projects/friend-perf.test.cjs` 9 例 + `tests/llm-relay.test.mjs` 7 例（ttfb 头与字节序、
  无 body、安全边界、构造器前缀确定性/后缀随机/非法 spec、promptSpec 覆盖 messages 且前缀跨轮一致、
  无 promptSpec 时 messages 原样透传）。
- 修复 EMS 两个 step 契约测试在新鲜克隆上必挂的问题
  （`projects/pipeline/scripts/test/test_ems_{check,deploy}.sh`）：厂商 chart `scripts/ems-chart/`
  不入 git（含证书私钥），而 `ems-check.sh` dispatch 模式与 `ems-deploy.sh` 都要读仓内
  `ems-chart/Chart.yaml`（前者取门禁期望版本转发远程，后者打包分发并读版本/名称），新鲜克隆上
  ems-check 的 `ems_chart_expected` 转发断言必挂、ems-deploy 直接「未找到仓内 chart」退出——此前
  仅在本地留有真实 chart 的机器上能跑过。现两个测试在 Chart.yaml 缺失时自建最小等价 fixture
  （`name: ems` / `version: 26.8.0-b6`，与 mock helm 及契约断言口径一致），已存在真实 chart 的
  部署/开发机原样保留不动，退出时仅清理测试自建的目录。
- 新增服务端路由 `POST /api/worktable/llm`（`src/index.ts`）：LLM 接口中转，供「友商 Tokens API 性能对比」
  项目页（`projects/friend-perf.html`）使用。请求体 `{baseURL, endpoint, apiKey, payload}`，服务端代发并
  流式透传响应（带背压），保住页面侧 TTFT 语义；安全边界：仅 https 目标、复用 `isLocalTarget` 反向拒绝
  回环/内网主机（不成为 SSRF 出口，与 `/api/worktable/proxy` 的内网白名单互不放开）、仅放行 `/models`
  与 `/chat/completions` 两个 OpenAI 兼容路径，密钥由调用方自带、服务端不落地。页面侧 `llmFetch` 初版为
  「直连失败自动回退中转」，后改为**统一走服务端中转**：各家厂商同一出口发起请求，规避浏览器 CORS 差异与
  本机网络差异，横向可比；早期直连记录带 `relay` 标记，记录页模型列对老直连记录显示「·直连」；
  「获取模型」同样统一走中转。
- 流水线页用户可见的「内置」字样去掉（`projects/pipeline/pipeline.html`，行为完全不变）：行内名称旁的
  「内置」小灰徽章删除（保留「可信」徽章，title 与可信流水线文案对齐）；编辑器标题「（内置·可信）/
  （内置·可信·只读）」→「（可信）/（可信·只读）」；创建者筛选「我的（含内置）/仅内置」→「我的（含预置）/
  仅预置」（`value` 与过滤逻辑不变）；编排区说明、流程节点 title、`savePlForm`/`deletePipeline` 拦截
  告警、导出/导入按钮 title 及「内置演示数据」相关用户可见文案统一改述为「预置」/「可信」；`p.builtIn`
  字段与代码标识符不动，「标记可信」对内置隐藏、admin 可编辑、删除全员禁止等行为均不变。同步更新
  `test_pipeline_trusted.js` / `test_pipeline_readonly.js` 断言（含「无内置徽章」反向断言）。
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
- 新增 EMS（mfv-kv 内存池存储）安装部署三段流水线 step（`projects/pipeline/scripts/`）：
  `ems-deploy.sh`（安装执行：盲装防线/释放授权 ns/打 label/helm install/pod+大页终验）与
  `ems-hugepages.sh`（大页准备：只读内存预检/多轮 direct compaction 写入/allocatable 刷新/
  双达标终验，2000Gi 固定）为新增；`ems-check.sh` 增加安装前门禁模式（可选参数 `EMS_NAME`
  激活）：名字格式/label 占用/同名 ns·release 残留（含版本比对与 `EMS_IDEMPOTENT` 幂等
  判定）/**CPU·内存资源余量**（调度器 requests 口径，每节点 ≥41C/41Gi 且单节点再余
  12C/20Gi 供 controller+zk；不判业务占用——业务共存由余量说话，大页归 ems-hugepages
  step，门禁不重复判），任一不过即 exit 1 拦下游。契约链：check 输出
  `EMS_NAME/EMS_LABEL_KEY/EMS_NODES/EMS_IDEMPOTENT/EMS_GATE`（及
  `EMS_RELEASE_NAMESPACES` 预授权透传），deploy 留空继承。三段编排已在平台机
  （192.168.1.46 执行宿主）实测跑通（ems8-8 @ 126/237）。厂商 chart `scripts/ems-chart/`
  **不入 git**（含证书私钥与密码，已加 .gitignore），随部署环境分发；README 补三脚本
  章节与 chart 分发说明。单测：`test/test_ems_{check,deploy,hugepages}.sh`。
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
- 新增部署准入门禁脚本 `check-deploy-gate.sh`（`projects/pipeline/scripts/`）：在拉取/渲染/部署阶段之前
  把关，任一 FAIL 即非零退出、流水线阻断在绑定位置。执行机侧校验 `IMAGE_NAME`/`DEPLOY_IMAGE` 至少其一
  非空与 ssh 可用性（密码认证还需 sshpass）；有目标节点时经 SSH 把脚本逐节点下发执行（取 `TARGET_HOSTS`
  各自凭据，首节点按 `deploy-model.sh` 契约为控制节点）：kubectl/helm/curl（控制节点缺失判 FAIL、
  工作节点仅 WARN）、GPU 数量（`MIN_GPU` 显式门槛，留空按 `PREFILL_GPU`/`DECODE_GPU` 较大值推导、
  0=跳过）、`TARGET_RUN_DIR` 所在盘剩余空间（`MIN_DISK_FREE_GIB` 默认 20 GiB）、命名空间内镜像凭证
  （同配 `NAMESPACE` 与 `IMAGE_PULL_SECRETS` 时逐个核实 Secret，缺失判 FAIL，命名空间不存在仅 WARN）。
  无目标节点运行仅做执行机输入检查；脚本只读、不创建/删除资源、不打印凭据，输出
  `GATE_RESULT=PASS|FAIL` 供下游阶段引用。用法：流水线编辑器绑成普通阶段（放在部署阶段之前）或在
  「设置」页选为环境检查脚本；参数识别走既有 `${VAR:-默认值}` + 对齐注释约定（已验证识别 18 个参数、
  无位置参数）。新增契约测试 `projects/pipeline/scripts/test/test_check_deploy_gate.sh`（输入检查、
  GPU/磁盘/工具控制与工作节点分级、Secret、逐节点凭据与角色下发共 9 组用例），
  `projects/pipeline/scripts/README.md` 增补「部署准入门禁」章节。
- 「代码同步」项目页（`projects/code_trans/`）cherry-pick 冲突支持 AI 解冲突：同步页新增「冲突处理」
  下拉（`index.html`，持久化 `state.resolver`，仅接受已知值），可选 Claude Code / Codex / Kimi；
  `pr-sync.py` 在 cherry-pick 冲突时于克隆目录调用所选 CLI（`claude -p` / `codex exec` / `kimi`，
  prompt 令其读取冲突文件、删除冲突标记后不执行任何 git 命令），随后校验无残留冲突标记再
  `git add` + `cherry-pick --continue`；解失败、工具未安装或未选则维持原行为——中止该 PR、
  继续其余。AI 输出透传到页面日志（同时刷新停滞超时），进度经 `pr_resolve` 事件上报；
  远程执行时对应 CLI 需装在远程服务器。
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
