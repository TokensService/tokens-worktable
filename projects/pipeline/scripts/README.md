# 流水线脚本使用说明

流水线工作台（`../pipeline.html`）在「编辑流水线」中给阶段绑定本目录下的脚本；绑定时点「识别参数」会自动从脚本源码识别可配置项。运行到该阶段时通过 `/api/worktable/exec` 执行脚本，并自动注入运行上下文。

## 参数识别规则

脚本源码中出现以下写法会被识别为可配置参数，在阶段行里可填值覆盖：

- 位置参数：`$1`、`${1}`、`${1:-默认值}`、`${2:?必填提示}` …
- 环境变量：`$VAR`、`${VAR}`、`${VAR:-默认值}`、`${VAR:?必填提示}`（`PATH`/`HOME` 等 shell 内置变量除外）

若脚本只接受环境变量、但内部函数会使用 `$1`/`$2`，可在文件头单独加入
`# pipeline: no-positional-args`。识别器会忽略全部位置参数引用，但仍识别环境变量。

带 `:-默认值` 的参数，默认值只显示在输入框占位符（placeholder）中——**不预填、不随执行下发**（否则识别出的默认值会压过下方自动注入的同名运行级变量）；带 `:?` 的标记为必填。默认值含 `$变量`/`${...}`/`$(命令)` 的（如 `${RENDER_DIR:-${RUN_DIR}/rendered}`）属于**动态默认值**：嵌套表达式按花括号配平完整识别，同样仅以占位符展示原表达式（注入后 shell 不会二次展开，不能按字面值下发）。参数**留空 = 使用下方自动注入的运行级变量**（同名时注入值生效，未注入则由脚本自身的 `:-` 默认值兜底）；在参数行填入内容则视为显式覆盖，优先级最高。

## 自动注入的环境变量

每次执行脚本（含环境清理/环境检查/Profiling 等系统预设任务）都会注入以下变量；**脚本或页面里显式配置的同名参数优先，不会被覆盖**：

| 变量 | 内容 | 示例 |
|---|---|---|
| `TARGET_IP` | 首个目标节点 IP | `10.0.0.1` |
| `TARGET_IPS` | 全部目标 IP 的 JSON 数组 | `["10.0.0.1","10.0.0.2"]` |
| `TARGET_HOSTS` | 全部节点凭据的 JSON 数组 | `[{"ip":"10.0.0.1","user":"root","pass":"p1"}]` |
| `TARGET_NODE_IP_MAP` | SSH 地址 → 节点内网IP（Kubernetes InternalIP）的 JSON 映射（仅含填了内网IP的节点；无则整体不注入） | `{"115.33.98.101:2224":"192.168.31.175"}` |
| `TARGET_LLM_ADDR_MAP` | SSH 地址 → LLM服务地址（IP:端口）的 JSON 映射（仅含填了 LLM服务地址的节点；无则整体不注入） | `{"115.33.98.101:2224":"192.168.31.175:8000"}` |
| `TARGET_USER` / `TARGET_PASSWORD` | 首个节点登录凭据 | `root` |
| `IMAGE_NAME` / `IMAGE_TAG` | 主控「镜像名」/ 本次运行 tag | `xds` / `1510-a1b2c` |
| `PIPELINE_NAME` | 流水线名 | `安装部署XDS` |
| `GIT_URL` / `GIT_BRANCH` | 主控选择的代码仓地址 / 分支 | `https://gitcode.com/org/repo.git` / `main` |
| `GIT_USER` / `GIT_PASSWORD` | 仓库访问令牌（来自「设置」页代码仓列表） | `oauth2` |
| `DEPLOY_STRATEGY` | 所选分支的部署策略（代码仓配置了部署策略来源时注入） | `low-latency` |
| `MODEL_PATH` | 模型权重路径（主控「权重路径」可选填写，非空才注入；留空不注入，由脚本自身 `:-` 默认值兜底） | `/models/GLM-5.2/v1` |
| `PIPELINE_PRESETS` | 本次运行勾选的预设任务 key 的 JSON 数组（系统预设：`cleanup`/`check`/`profiling`，含自定义预设 key）；脚本可据此判断预设任务是否启用，如 `echo "$PIPELINE_PRESETS" \| grep -q profiling` | `["cleanup","profiling"]` |

节点 IP / 用户名 / 密码来自「设置」页的节点环境列表（每个节点可配各自的用户名、密码）；主控「环境（可多选）」勾选哪些节点，注入的就是哪些。`template.sh` 开头会把上述全部变量连同 `ARCHIVE_*` 一起打印（未注入的显示 `<未注入>`），凭据类变量（`TARGET_PASSWORD` / `TARGET_HOSTS` / `GIT_PASSWORD`）会明文出现在阶段日志与归档日志中，注意脱敏。

## 部署策略脚本（代码仓设置）

「设置」页代码仓的「部署策略」来源可选「策略·脚本」：主控/定时页选择分支后，工作台经 `/api/worktable/exec` 执行本目录中配置的脚本，取其 stdout 作为该分支支持的部署策略列表。约定：

- 注入环境变量：`GIT_BRANCH`（当前分支）、`GIT_URL`、`GIT_USER`、`GIT_PASSWORD`（代码仓凭据）；无运行上下文，TARGET_*/IMAGE_* 等运行级变量不注入；
- 输出契约：stdout **每行一个策略名**（去首尾空白、跳过空行、按序去重）；
- 非零退出 / 超时（30 秒）视为拉取失败，错误原因（含 stderr 摘要）显示在策略面板与「策略测试」提示中；
- 脚本不作为流水线阶段执行，参数识别规则不适用。

内置示例：`list_open_xds_archs.sh`（浅克隆 Open-XDS 仓读 JSON 架构文件）、
`list_vllm_model_archs.sh`（读 TokensService/vllm 仓 `model_arch.yaml` 的顶层
arch_name——github.com 地址推导 raw URL 秒级拉取，其他远端自动退化为浅克隆；
`MODEL_ARCH_PATH`/`MODEL_ARCH_URL` 可改数据源）。

## 快速开始

1. 复制模板：`cp template.sh my-step.sh`，按注释改掉 `deploy_one` 里的演示逻辑；
2. 编辑流水线 → 阶段的「脚本」框输入脚本名 → 点「识别参数」；
3. 需要覆盖注入值时在参数行直接填（同名优先）；留空则使用注入值；
4. 运行流水线，阶段详情里可看到脚本的完整 stdout/stderr 和退出码。

多节点部署参考 `template.sh`：优先解析 `TARGET_HOSTS` 按各节点凭据逐个部署（需本机有 `python3` 或 `jq`）；两者都没有时退化为 `TARGET_IPS` + 首节点凭据。

## XDS 部署阶段契约

XDS 流水线按以下顺序绑定脚本：

1. `pull_render_config.sh`：在流水线执行机拉取镜像、导出模板并渲染配置；随后将渲染产物同步到每个 `TARGET_HOSTS`。
2. `deploy-model.sh`：执行机选取 `TARGET_HOSTS[0]` 作为控制节点，通过 SSH 同步部署脚本和本轮渲染产物；随后在该目标机读取 Chart、values、架构注册请求和 P/D resource manifest，执行 Helm 安装并注册架构。成功后额外输出可供后续阶段引用的 `SERVICE_NAME`、`SERVICE_API`、`MODEL`、`MODEL_ENDPOINT`、`MODEL_VERSION`、`MODEL_API`；默认服务名为 `ray-svc`，可通过 `SERVICE_NAME` 覆盖。
3. `register-model.sh [MODEL_NAME]`：使用本轮 resource manifest 注册模型。
4. `model-health.sh`：检查 XDS models 接口并发起一次真实 chat 请求。

目标机产物默认保存于 `/tmp/op-test-pipeline/<PIPELINE_NAME>/rendered`，并在同级写入 `pipeline.env` 供远程部署阶段加载；可通过 `TARGET_RUN_DIR`、`TARGET_RENDER_DIR` 覆盖。`deploy-model.sh` 在执行机不需要 `kubectl` 或 `helm`，但需要 `ssh`；使用密码认证时还需要 `sshpass`。控制目标机必须安装 `kubectl`、`helm` 和 `curl`。脚本通过 stdout 中的 `KEY=VALUE` 自动传递执行机运行目录和产物路径；阶段编辑器的「输出变量」可把捕获的 key 改名后下传给指定的环境变量（如 `IMAGE_URL=image`，与 URL 请求阶段一致；多条映射用英文逗号分隔，如 `IMAGE_URL=image, XDS_BRANCH=items.0.name, RESP=*`，留空则捕获的 KEY=VALUE / 单行 JSON 顶层字段全部按原名下传），来源也可写 JSON 路径从 stdout / 响应体里的单行 JSON 取嵌套字段（如 `XDS_BRANCH=items.0.name`，数组支持 `[-1]` 倒数取末项，终点为对象/数组则整体序列化成 JSON 字符串；分页列表类接口 `{"items":[...]}` 的顶层标量提取拿不到数组内容，需用路径显式指定），或填 `*` / 留空把本阶段返回值全文整体赋给指定变量（如 `RESP=*`），下游参数值也可填 `${IMAGE_URL}` 显式引用。带「定时」标记的后缀阶段由服务端执行：变量池在定时分界处随计划快照带过，后缀各阶段间同样按上述规则累计/映射/注入（含 `${VAR}` 参数引用）。注意单个环境变量受内核 128KiB 上限约束，超大捕获值（如用 `*` 承接数千分支的完整响应体）不会注入并在阶段日志给出 `[warn]` 告警——这种场景应改用 JSON 路径截取所需字段（如 `XDS_BRANCH=items[-1].name`）。以下参数通常在阶段参数区配置：

- `ARCH_NAME`、`NUM_PREFILL`、`NUM_DECODE`、`PREFILL_GPU`、`DECODE_GPU`
- `XDS_URL`、`MODEL_PATH`、`NAMESPACE`、`RELEASE_NAME`
- `PREFILL_OVERRIDES_JSON`、`DECODE_OVERRIDES_JSON`
- `IMAGE_PULL_SECRETS`：逗号分隔的 Kubernetes 镜像凭证 Secret；默认
  `default-secret,swr-cn-southwest-2`。旧变量 `IMAGE_PULL_SECRET` 仍兼容且同样支持逗号分隔；
  `IMAGE_PULL_SECRETS` 优先。所有列出的 Secret 必须存在于本次部署 Namespace 中。

镜像必须包含以下模板路径，否则 `pull-image.sh` 会失败：

```text
/opt/deploy_template/xds_template/k8s/xds-cluster
/opt/deploy_template/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml
/opt/deploy_template/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json
```

缺少上述主目录时，脚本自动回退到 `/opt/op_test` 下相同的相对路径。

## LMCache 脚本族（按生命周期）

| 脚本 | 阶段 | 职责 |
|------|------|------|
| `lmcache-config.sh` | **step 主脚本**（pull_render_config 前） | 入参校验（fail-fast）+ 契约输出；step 存在即开启（`ENABLE_LMCACHE` 缺省 true） |
| `lib/render-lmcache.sh` | 渲染期（render-config 内部依赖） | 入参校验（`defaults`）与渲染后 values patch（`patch`：结构化写入 `lmcacheSidecar.enabled/tracing.otlpEndpoint` + `LMCACHE_EXTRA_ARGS` 实验注入，含启用守卫与幂等） |
| `check-lmcache-readiness.sh` | 部署期 | GPU context 就绪轮询（部署尾动态启用，输出 `LMCACHE_HEALTH` 契约） |
| `clear-lmcache-cache.sh` | 运行期 | 三层缓存热清理（见下节） |

**流水线接法**：要开 LMCache，在 pull_render_config 前加一个 `lmcache-config` step，参数即该 step 的环境变量（`LMCACHE_OTLP_ENDPOINT` / `LMCACHE_EXTRA_ARGS`，详见脚本头部）；契约输出经平台注入下游，渲染后由 values patch 点亮 sidecar（新版模板无占位符，旧模板残留占位符会被 unresolved 检查硬拦）。不加该 step 则默认全关，pull_render_config 自身不再暴露任何 LMCache 参数。

实验参数示例（免改模板/免出镜像）：

```bash
LMCACHE_EXTRA_ARGS=--worker-reap-timeout-seconds 60 --worker-registration-grace-seconds 60
```

单测：`test/test_lmcache_config.sh`（step 契约与下游点亮）、`test/test_render_lmcache.sh`（defaults/patch）；集成：`test/test_render_target_labels.sh`。

## LMCache 缓存热清理

`clear-lmcache-cache.sh` 在不重启服务的前提下清空 XDS+LMCache 部署的三层缓存，供打流前后复用同一基线：L1（DRAM，sidecar 内 `POST /cache/clear`）、HBM prefix cache（XDS OM diagnose `reset_prefix_cache`）、L2（`fs_native` 磁盘文件，sidecar 容器内 `find -delete`，按 node:path 去重）。全部操作经 `kubectl exec` 完成，无需 SSH；sidecar 端口从 `/etc/lmcache-ports/ports.env` 动态读取，L2 路径从 `--l2-adapter` 参数解析，FE 地址从 `ray-svc` NodePort 自动发现。执行机仅需 `kubectl`、`curl`（清 HBM 时）与 `python3`（发现 L2 路径时）。

```bash
DRY_RUN=0 bash clear-lmcache-cache.sh          # 默认全清三层
CLEAR_L2=0 DRY_RUN=0 bash clear-lmcache-cache.sh  # 只清 L1+HBM
```

`NAMESPACE` 留空时自动发现（全集群唯一含 `lmcache-sidecar` 容器的命名空间，多候选报错需显式指定）。清理 L2 前默认校验入口流量已停止（`IDLE_CHECK=1`，frontgroup 最近 `get request` 距今超过 `IDLE_SECONDS`，默认 60 秒，否则中止）。注意 `l2_usage_bytes` 指标是运行时记账不感知外部删除，脚本以 L2 目录文件数归零为完成依据。HBM reset 后默认轮询引擎日志确认每个引擎 success 才算清理成功（`HBM_VERIFY=1`，超时 `HBM_VERIFY_TIMEOUT_SECONDS` 默认 120 秒；设 0 则退回仅确认已调度）。`DRY_RUN=1`（默认）仅打印将执行的操作。单测：`test/test_clear_lmcache_cache.sh`。

## 归档与 AI 分析

主控填了「归档路径」后，每次运行结束会把产物写到 `<归档路径>/<流水线名称>_<YYYYMMDDhhmmss>/`：

- `run-<tag>.log` — 各阶段完整日志（脚本阶段含真实 stdout/stderr）
- `run-<tag>.profile.json` — 各阶段耗时/状态等 profiling 数据

「设置 → 归档配置 → 归档脚本」可配置一个在写完上述产物后执行的脚本（默认 `collect_logs.sh`，留空=不执行），用于收集节点/系统日志等额外产物。脚本缺失（如 `collect_logs.sh` 尚未创建）会自动跳过，执行失败也不影响运行结果。落盘约定：host 日志（`<ip>.log` / `controller.log`）是节点环境日志，写到归档路径根目录（跨运行共享，同名覆盖为最新环境快照），不进单次运行的归档文件夹；pod 日志等与本次运行相关的产物仍写进本次运行文件夹。除常规的 `TARGET_*`/`IMAGE_*`/`PIPELINE_NAME` 外，还会注入：

- `ARCHIVE_DIR` — 归档根目录（绝对路径；host 节点环境日志写到此处）
- `ARCHIVE_FOLDER` — 本次运行的归档文件夹（绝对路径）
- `ARCHIVE_LOG_FILE` / `ARCHIVE_PROFILE_FILE` — 归档内 `run-<tag>.log` / `run-<tag>.profile.json` 的绝对路径
- `ARCHIVE_PIPELINE` / `ARCHIVE_TAG` / `ARCHIVE_RESULT` — 流水线名 / 本次运行 tag / 运行结果（`success`/`failed`/`aborted`）

运行启动时即按上述格式生成归档文件夹并快照到本次运行，再把 `ARCHIVE_DIR` / `ARCHIVE_FOLDER` / `ARCHIVE_PIPELINE` / `ARCHIVE_TAG` 注入到流水线的每个任务（脚本阶段、URL 请求阶段和系统预设任务；任务内 `ARCHIVE_DIR` 与 `ARCHIVE_FOLDER` 均=本次运行归档文件夹，与归档脚本收到的根目录语义不同），脚本显式参数优先，方便各阶段把产物直接写入归档目录；`ARCHIVE_LOG_FILE` / `ARCHIVE_PROFILE_FILE` / `ARCHIVE_RESULT` 仅在末尾注入给归档脚本。

运行历史里选中某次运行后，可用标题行的「AI 日志分析 / Profiling 分析 / 性能诊断」新建 AI 会话分析：若侧边会话框已关闭会先打开，新会话归入流水线项目设置的工作区；项目未设置工作区时先弹出该项目的工作区选择，选定后自动继续。提示词保留本次运行归档目录/文件的绝对路径，只填入输入框（不自动提交，确认后手动发送），提示词模板在「设置」页维护。

## 收集普罗数据

「设置 → 普罗数据服务配置 → 收集脚本」可配置一个按时间段采集普罗（Prometheus）指标的脚本（在 scripts 目录按名选用，留空=不启用）。收集有两种方式：

- **任务级采集**：在「编辑流水线」的任务卡上勾选「收集普罗数据」，该任务进入终态（成功/失败）后即按「本任务开始→结束」时段后台调用收集脚本，产物写入本次运行归档目录的 `{任务名}-{阶段序号}-普罗数据` 文件夹（采集输出落该目录 `collect.log`；后台采集、失败不阻断流水线，未配置归档时落到 scripts 目录 `vllm-metrics/` 下同名子目录）。定时计划与 API（服务端）执行的流水线同样生效，采集结果标注在该任务日志的 `[普罗采集]` 行。
- **手动补采**：在运行历史选中某次运行（或运行中的流水线）后，点标题行的「📊 收集普罗数据」，弹出对话框按所选运行的起止时间采集（可在对话框里临时覆盖起止时间），指标产物写入归档目录的 `metrics` 子目录。

`model_name` 默认 `${MODEL_PATH}`（按上游 deploy 阶段产出的 `MODEL_PATH` 解析）、`xds_namespace` 默认 `${DEPLOY_STRATEGY}-${BY}`（按本次运行的部署策略与执行人解析），均在采集时点解析，解析不出则不注入。打开手动补采对话框时会先检测该运行是否已收集过普罗数据（产物目录下存在 `summary.json` 或 `snapshots/*/summary.json` 即视为已收集），并在状态行展示收集归档目录；采集成功后状态行同步刷新为已收集。手动补采经流式执行接口运行，输出实时回显。

除常规的 `PIPELINE_NAME` 外，「收集」时还会注入以下环境变量（同名时脚本自身参数优先）：

- `PROM_START` / `PROM_END` — 采集区间起止时间（ISO 8601 带 `Z`，如 `2026-09-05T10:30:00Z`）
- `VLLM_METRICS_START` / `VLLM_METRICS_END` — 同一起止时间的 Unix 秒（兼容旧脚本；`collect_vllm_metrics.py` 优先读取 `PROM_START`/`PROM_END`）
- `METRICS_ACTION` — 固定 `collect`（`collect_vllm_metrics.py` 默认 action 为 `start` 即后台采集；前台按段采集需 `collect`）
- `PROMETHEUS_URL` — 普罗数据服务配置的数据源地址
- `ARCH_NAME` / `MODEL_NAME` / `NAMESPACE` / `XDS_NAMESPACE` — 按上述默认占位在采集时点解析后注入（`collect_vllm_metrics.py` 的 `--model-name` 取 `ARCH_NAME`、`--namespace` 取 `NAMESPACE`，普通模型名会查询 `/home/service/works/models_ssd/<模型名>/v1` 标签值；以 `/` 开头的绝对路径原样使用；`MODEL_NAME` / `XDS_NAMESPACE` 为兼容其他脚本的同值副本）
- `ARCHIVE_FOLDER` — 本次运行（任务级采集）/ 选中运行（手动补采）的归档文件夹（绝对路径，便于把采集产物写入归档目录；未归档则不注入）
- `METRICS_OUTPUT_DIR` — 采集产物目录（任务级采集 = `ARCHIVE_FOLDER/{任务名}-{阶段序号}-普罗数据`，手动补采 = `ARCHIVE_FOLDER/metrics`；未归档则不注入，`collect_vllm_metrics.py` 默认落到执行目录下 `vllm-metrics`）。采集完成后脚本会打印「收集归档目录」

示例：`collect_vllm_metrics.py` 已按上述变量命名实现 —— 不传任何参数时，`--action` 取 `METRICS_ACTION=collect`、`--start`/`--end` 优先取 `PROM_START`/`PROM_END`（兼容 `VLLM_METRICS_START`/`VLLM_METRICS_END`）、`--prometheus-url` 取 `PROMETHEUS_URL`、`--namespace` 取 `NAMESPACE`、`--model-name` 取 `ARCH_NAME`，即可完成该时间段的指标采集；输出目录默认取 `METRICS_OUTPUT_DIR`，未设置时依次回退 `ARCHIVE_FOLDER/metrics`、`RUN_DIR/vllm-metrics`、执行目录下 `vllm-metrics`。



## 独立清理与环境检查

流水线设置中的「清理脚本」选择 `cleanup-env.sh`，「环境检查脚本」选择
`check-env.sh`。两者均可单独复制到目标机执行，支持原有 `TARGET_HOSTS`、
`SSH_USER`、`SSH_PORT`、`SSH_PASSWORD`（兼容 `TARGET_PASSWORD`）远程参数。

```bash
# 仅清理，默认 crond、containers、gpu；建议先预演确认范围
DRY_RUN=1 bash cleanup-env.sh
bash cleanup-env.sh

# 仅驱逐目标节点的 EMS Pod，确认退出后释放 2 MiB 大页；默认只预演
NODE=node-128 DRY_RUN=0 bash evict-ems-hugepages.sh

# 仅检查，不清理工作负载、不启停服务
bash check-env.sh
```

清理入口保留命名空间白名单、统一等待和 15 秒后强制删除残留 Pod 的逻辑，
清理完成即退出，不再自动进行健康检查。检查入口检查运行时、CNI、API 网络、
内存、大页和 GPU；有 FAIL 时返回非零。两种入口的远程失败均向上透传。

GPU 清理会先区分 Kubernetes/容器进程与宿主进程。宿主占卡进程会打印从
GPU Worker 到启动根的同进程组链，并终止整个进程组，防止残留的 EngineCore
或启动脚本再次拉起 Worker；若进程组与清理脚本自身相同，则回退为仅终止占卡 PID。

`bnt-standalone.sh` 保留为本地兼容转发入口：默认转到清理，
`ACTION=check-health` 转到检查；不再提供默认「清理后自动检查」行为。
若只复制一个脚本到目标机，应使用上述独立入口。页面已有保存的脚本选择不会自动改写，
可分别在两个脚本设置中选择新文件。页面是否因清理失败而中断，仍由流水线执行策略决定。

`evict-ems-hugepages.sh` 不需要命名空间参数：它查询目标节点的全部 Pod，以 EMS 容器或
`/dev/shm/ems` 挂载识别 EMS Pod；同一命名空间位于其他节点的 Pod 不会被删除。可用
`HUGEPAGE_PATH` 指定其他 `nr_hugepages` 路径，未设置时使用 2 MiB 默认路径。


### check-env.sh 深入检查（128 基准，2026-09-08）

检查依赖目标机 Python 3（仅标准库）、ip、iptables、sysctl、systemctl；容器内存
采样还需要 kubectl 访问节点 kubelet summary 的权限，不依赖 metrics-server。

- CNI：检查配置文件集合、JSON、版本 0.3.1、default-network、
  `vpc-router → portmap` 插件链、`10.0.0.0/16`、`phy_net1`、带宽和端口映射能力，
  并验证三个 CNI 可执行文件、ip_forward=1、all/default rp_filter=2、
  KUBE-MARK-MASQ 的 0x4000 规则、默认路由出口和 API Server DNS/直连 TCP。
  这些是当前 CCE/128 的环境基准，并非其他 Kubernetes 集群的通用标准。
- 跨节点通信：在本节点和另一个健康可调度节点创建临时普通 Pod，双向通过 Pod IP
  访问 HTTP 18080 并校验本次随机响应，显式绕过代理。默认复用各节点 Ready XDS Pod
  的镜像（必须包含 python3），不运行模型；启动等待最多60秒，单次请求最多5秒。
  无可用对端、启动或任一方向失败判 FAIL，finally 删除本次专属 Pod，清理失败也判 FAIL。
  需要 kubectl 的 pods get/list/create/delete、pods/exec 权限；探测不申请GPU、不挂载宿主机。
  默认命名空间为 default，只验证该命名空间的 Pod TCP/HTTP，不覆盖业务 NetworkPolicy、
  Service/DNS、RDMA。进程被强杀可能遗留探测对象，180秒 activeDeadlineSeconds 限制运行时间。
  `NETWORK_TEST_PEER` 可指定不同的对端节点，`NETWORK_TEST_IMAGE` 可指定含 python3 的镜像，
  `NETWORK_TEST_NAMESPACE` 可选择已有命名空间；参数会传入远端。
- RDMA：当 `TARGET_HOSTS` 至少包含两台主机时，执行机协调每个有序主机对的
  `rping` 双向探测，默认发现 `^roce_bond[0-9]+$` 的 UP IPv4 地址。任一路径失败判
  FAIL；少于两台主机判 WARN。`RDMA_RPING_ENABLED=false` 可关闭；
  `RDMA_RPING_COUNT`、`RDMA_RPING_CLIENT_TIMEOUT_SECONDS`、
  `RDMA_RPING_SERVER_TIMEOUT_SECONDS` 和 `RDMA_RPING_IFACE_PATTERN` 可覆盖默认值。
  每个 server 都以本次检查记录的 PID 回收，不会使用模式匹配杀进程。
- 代理：检查当前进程、containerd/kubelet 实际进程环境和 /etc/environment。
  非空 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY（大小写均识别）判 FAIL；128 的运行基准为
  无代理。日志仅打印变量名，不打印代理地址或认证信息。NO_PROXY 本身不代表开启代理。
- 内存：输出 MemTotal、MemAvailable、大页预留与已使用量。默认按二进制单位，
  大页预留达到 2048 GiB 时，MemAvailable 小于 700 GiB 判 FAIL，等于 700 GiB 通过。
  预留尚未分配给进程的大页也计算在内；不重复从 MemAvailable 扣除大页或容器工作集。
  仍保留普通内存可用比例低于 2% FAIL、低于 10% WARN。
- 容器：读取节点上的 xds-* Pod requests 和 kubelet workingSetBytes，分别打印、汇总；
  当前128采样参考约为 Prefill 1154 GiB、Decode 32 GiB，全部业务约1216 GiB。
  这是实际占用参考，不是将 requests 当作实测，也不是所有部署必须一致的硬门槛。
  没有权限或采样不可用会 WARN，不伪报实际内存为零。

可通过 `HEALTH_NODE` 指定节点名，否则按本机 IP 自动识别。
`HUGEPAGE_TRIGGER_GIB=2048`、`MIN_AVAILABLE_WITH_HUGEPAGES_GIB=700` 可覆盖大页规则，
这些参数会传入远端。CNI、代理或内存检查执行失败判 FAIL。

## 部署准入门禁（check-deploy-gate.sh）

`check-deploy-gate.sh` 是只读的部署前置检查：任一 FAIL 即非零退出，把流水线阻断在
绑定位置。绑成普通阶段（放在拉取/渲染/部署之前）或在「设置」页选为环境检查脚本均可生效。

- 执行机输入：`IMAGE_NAME` / `DEPLOY_IMAGE` 至少其一非空；有目标节点时检查执行机
  `ssh` 可用（节点配密码认证时还需 `sshpass`）。
- 目标机：经 SSH 把脚本逐节点下发执行（取 `TARGET_HOSTS` 各自凭据，首节点按
  `deploy-model.sh` 契约为控制节点）：
  - `kubectl` / `helm` / `curl`：控制节点缺失判 FAIL，工作节点仅 WARN；
  - GPU 数量：`MIN_GPU` 显式门槛；留空按 `PREFILL_GPU` / `DECODE_GPU` 较大值推导
    （仍为空则 1），`MIN_GPU=0` 跳过；
  - 磁盘：`TARGET_RUN_DIR`（默认 `/tmp/op-test-pipeline`）所在盘剩余空间不少于
    `MIN_DISK_FREE_GIB`（默认 20 GiB）；
  - 镜像凭证：同时配置 `NAMESPACE` 与 `IMAGE_PULL_SECRETS`（逗号分隔）时，在控制节点
    逐个核实 Secret 是否存在于该命名空间，缺失判 FAIL；命名空间本身不存在只 WARN
    （部署时由 helm 创建，提示需同步创建 Secret）。
- 无目标节点运行时只做执行机输入检查（WARN 提示，不判 FAIL）。
- 输出 `GATE_RESULT=PASS|FAIL` 供下游阶段引用；脚本只读，不创建/删除任何资源，
  凭据只用于 SSH 登录、不打印。

契约测试：`scripts/test/test_check_deploy_gate.sh`。

### 指定普罗数据采集时间

支持 ISO 8601 UTC 时间（含毫秒形式），例如：

```bash
PROM_START=2026-09-08T03:26:32.000Z \
PROM_END=2026-09-08T03:26:56.000Z \
python3 collect_vllm_metrics.py --action collect

# 也支持放在脚本名后：
python3 collect_vllm_metrics.py --action collect \
  PROM_START=2026-09-08T03:26:32.000Z \
  PROM_END=2026-09-08T03:26:56.000Z
```

命令行时间参数覆盖环境变量；命令行重复指定同一边界时最后一个生效。
时间未指定时仍保持原来的默认行为。

### 模型路径优先级

`model_path`（兼容 `MODEL_PATH`）有值时，直接作为 Prometheus 的 `model_name`
标签使用，保留原路径和末尾斜杠，不添加目录或版本后缀。
未设置或为空时，依次读取 `model_name`、`MODEL_NAME`、`MODELNAME`、
`VLLM_METRICS_MODEL_NAME`、`ARCH_NAME`；模型名仍按
`/home/service/works/models_ssd/<模型名>/v1` 拼接，绝对路径沿用原样保留的逻辑。
也支持 `--model-path`、`--model-name` 和兼容写法 `--modelname`；环境变量还兼容
`MODELNAME` 与 `VLLM_METRICS_MODEL_NAME`，路径优先于模型名。

```bash
model_path=/home/service/works/models_ssd/Qwen3.6-35B-A3B \
PROM_START=2026-09-08T03:26:32.000Z \
PROM_END=2026-09-08T03:26:56.000Z \
python3 collect_vllm_metrics.py --action collect
```

### render-config.sh 从 arch 继承资源

默认以选中的 arch 为准：每个 TE 的 CPU/GPU/内存取 `resources[0]`；
初始 P/D 实例数取各角色的 `default`，`min/max/default` 原样保留在架构请求中。
例如 P 的 default=3、D 的 default=1，就生成3个P和1个D的初始TE组。
`min/max` 是模型实例范围，不等于脚本自动扩缩 Kubernetes Pod；脚本只渲染初始数量。
TP、PP、DP保留 arch 配置，不再将 Decode DP 强制改为 GPU 数。

`NUM_PREFILL/NUM_DECODE/PREFILL_GPU/DECODE_GPU` 现在默认留空。
显式填写数量则覆盖相应角色的 min/max/default，显式填写 GPU 则覆盖 GPU 数；
角色 JSON overrides 先合并，显式数量/GPU变量最后覆盖。
每个角色当前支持一个 resources 条目，并检查 min <= default <= max。
旧流水线若保存过这些参数的显式值，需要清空才能继承 arch。

## EMS 实例巡检（ems-check.sh）

`ems-check.sh` 是 EMS（mfv-kv 内存池存储）的统一只读巡检 **step 主脚本**（无参调用，
类似 `lmcache-config.sh`）：在流水线中任意位置插入本 step，理论上无需配置任何
参数——目标节点由平台注入的 `TARGET_IP`/`TARGET_IPS` 提供。**执行位置**：平台
注入 `TARGET_HOSTS` 时自动推送自身到首个具备 kubectl 的目标节点上远程执行
（同 `evict-ems-hugepages.sh` 的自推送模式；工作台服务端所在主机不需要
kubectl，kubectl 视图是集群级的，任一节点结果一致；密码认证需执行机有
sshpass）；未注入时在执行机本地运行（手工独立运行场景，需本机有 kubectl）。
**跨 region（hd2 等）**：平台注入的 TARGET_IP/TARGET_IPS 可能是外网入口
endpoint（`ip:port` 形态，如 `115.33.98.101:2224`），与集群 InternalIP 对不上；
分发阶段会逐节点 SSH 采集内网身份（`hostname`/`hostname -I`）构建映射表随
小写 env 下传，目标定位按「直接命中（内网 IP/节点名）→ endpoint 身份映射 →
剥端口兜底」三级解析（gy1 内网标识行为不变；门禁 G-2 同样走该解析）。
输出三个部分：

1. **集群巡检**（精简版，团队设备口径）：团队设备上的健康实例为主体——每实例
   两行（实例名·chart 版本·运行时长；团队节点与大页已分配，按全部 pod 的
   `hugepages-2Mi` requests 汇总，非团队节点仅计数）；异常实例仅一行标注，
   非团队设备实例、空壳/遗留 ns 与孤儿 release 一行汇总（不展开）。团队设备
   清单内置（gy1：243/128/215/55/126/237；hd2：140/120/113/164/7，以
   tokens-devices 清单为准增减）；
2. **目标节点定位**：逐个检查 `TARGET_IP`/`TARGET_IPS` 的归属，命中实例则输出
   实例简报（chart 版本/运行时长/节点数，跨 region endpoint 经身份映射解析，
   非团队设备节点带标注）；未注入 TARGET_* 时回退识别本机（手工独立运行场景）；
3. **KEY=VALUE 契约**（注入下游 step）：`EMS_INSTANCE_COUNT`、`EMS_INSTANCES`、
   `EMS_HEALTHY_COUNT`、`EMS_UNHEALTHY`；注入目标时附 `EMS_TARGET_TOTAL`/
   `EMS_TARGET_MATCHED`，命中时附 `EMS_TARGET_INSTANCE/LABEL_KEY/NODES/`
   `CHART_VERSION/POD_HEALTH`（首个命中目标）。

```bash
bash ems-check.sh                     # 手工运行（回退本机识别）
TARGET_IP=192.168.0.215 bash ems-check.sh   # 指定目标节点（模拟平台注入）
TARGET_HOSTS='[{"ip":"192.168.0.128","user":"root"}]' TARGET_IP=192.168.0.128 bash ems-check.sh
                                      # 模拟平台完整注入：自推送到目标节点执行
```

**安装前门禁模式**（可选参数 `EMS_NAME` 激活，如 `ems8-8`）：在巡检输出后追加
五连检——名字格式 / label 占用 / 同名 ns·release 残留（含版本比对，健康同名安装
输出 `EMS_IDEMPOTENT=1` 幂等判定）/ **CPU·内存资源余量**（调度器 requests 口径：
每节点 ≥41C/41Gi，且至少一节点再余 12C/20Gi 供 controller+zk；不关心节点上跑着
什么业务，大页由 ems-hugepages step 另行保障）。任一不过即 exit 1 拦住下游
ems-deploy；通过时输出 `EMS_GATE=passed` 及 `EMS_NAME/EMS_LABEL_KEY/EMS_NODES/
EMS_IDEMPOTENT` 契约，供 ems-deploy 留空继承。可选参数 `EMS_RELEASE_NAMESPACES`
（逗号分隔 ns）仅在门禁通过时原样透传下游（ems-deploy S1 据此删除授权 ns）。

纯巡检模式（未填 `EMS_NAME`）无任何行为分支：异常实例只在报告与
`EMS_UNHEALTHY` 契约键中体现，不影响退出码。实际巡检节点需要 kubectl（可访问
集群）与 python3，helm 可选（缺失时版本信息降级为未知）；分发时执行机需要
ssh/scp（解析 TARGET_HOSTS 需 python3，密码认证还需 sshpass）。退出码：0 正常；
1 环境错误（门禁模式下含门禁不过）。单测：`test/test_ems_check.sh`。

## EMS 大页配置（ems-hugepages.sh）

`ems-hugepages.sh` 是 EMS 安装前置的大页准备 **step 主脚本**（零参数）：目标
2000Gi/节点（内部常量，1000Gi 规格已废弃）。三段式：①解析目标节点（平台注入
`TARGET_IP`/`TARGET_IPS`）；②逐节点配置大页——已达标跳过，未达标先做只读内存
预检（`MemAvailable` < 剩余需求+200Gi 余量即秒级失败并输出 Top 进程/shm 诊断到
stderr），再写入 `/sys/kernel/mm/hugepages/.../nr_hugepages`（多轮重试触发
direct compaction，840s 兜底）；③刷新 allocatable（按需重启 kubelet）+ 终验
（大页总量与 allocatable 双达标）。执行位置同 ems-check（TARGET_HOSTS 自推送
到首个有 kubectl 的目标节点）；**跨 region（hd2 等）**：TARGET_IPS 为外网入口
endpoint（ip:port）时，分发阶段采集内网身份映射（含该 endpoint 的登录凭据）
后三级解析（直接命中 → endpoint 映射 → 剥端口），**节点级 SSH 一律走集群内网
地址**（映射命中时取该节点 InternalIP，解析不到才退回 endpoint 地址）——这类
集群的外网入口在集群内不可路由（2026-10-15 实测 node 侧访问为 Network
unreachable）。节点凭据三级解析：凭据表按内网 IP / ip:port 命中 → 身份映射回退
（按内网身份反查 endpoint 的 user/pass，连接走内网 22——映射里的 port 是外网
NAT 端口）；先密钥认证（节点间通常 root 免密），失败且凭据带密码则走密码认证
（执行宿主有 sshpass 用 sshpass，没有则用 SSH_ASKPASS 喂密码——GPU 节点普遍
未装 sshpass）。执行宿主即目标节点时本地直执，gy1 内网行为不变。

**池账目口径（2026-10 批量超额复盘后确定）**：达标判据一律用 **Σ(per-NUMA
nr_hugepages)**（持久池），**不用 `HugePages_Total`**——后者 = 持久池 + surplus，
surplus 是「别人映射出的超额页」（上一轮实例未清 / 并发操作 / 其他大页负载），
拿它判到位会把池子顶到目标之上，之后内核还可能把 surplus 并进持久池（实测 2.0T
目标跑成 2.4~2.5T，单节点白占 400~600Gi）。因此：
- 起跑前 surplus 必须为 0（等 120s 后仍 >0 直接失败，不在地雷上开工）；
- 轮询/终验发现持久池 > 目标 → 只回收「每 NUMA 空闲页」把池子收回目标（在用页
  不动，实测秒级）；surplus > 0 时内核释放会卡死（已知行为）→ 不写、判失败；
- 收不回去 → **失败**（不再绿灯放行）：内核不能运行时收缩大页，需重启节点回收。

契约输出 `EMS_HUGEPAGES_OK/POOL_PAGES/RENEWED/KUBELET_RESTARTED/RECLAIMED/
SURPLUS`（`EMS_HUGEPAGES_OVERPROVISIONED` 为兼容保留，成功路径恒为空——真超额
现在直接失败）。退出码：0 正常；1 环境错误/预检失败/终验不达标/超额收不回。
单测：`test/test_ems_hugepages.sh`。

## EMS 安装（ems-deploy.sh）

`ems-deploy.sh` 是 EMS 部署执行 **step 主脚本**（参数 `EMS_NAME` 必填——显式
填写或经前置 ems-check 门禁契约继承；`EMS_RELEASE_NAMESPACES` 可选，授权后
S1 会删除这些 ns）。流程：S0 名字格式与节点数（≥1，单机可装）校验 + 盲装防线（同名
ns/release 存在且无 `EMS_IDEMPOTENT=1` 判定时拒绝）；S1 释放（删除授权 ns，
默认跳过）；S2 打 label（名字首段，如 ems8-8 → `ems8=true`）+ `helm install`
（release 名 = `EMS_NAME`，存放在首段 ns；**工作负载 ns 由 chart 自动创建为
release 名**）；S3 验证 pod 全 Running&Ready + 每节点大页分配达标（最长 900s）。
**跨 region（hd2 等）**：TARGET_IPS 为外网入口 endpoint（ip:port）时，分发阶段
采集内网身份映射后三级解析（直接命中 → endpoint 映射 → 剥端口），label 打在
解析出的集群节点名上，gy1 内网行为不变。
契约输出 `EMS_NAME/EMS_NAMESPACE/EMS_LABEL_KEY/EMS_NODES/EMS_CHART_VERSION/
EMS_POD_HEALTH/EMS_STATUS`。退出码：0 安装成功；1 环境错误/验证失败。

**chart 分发**：安装版本由与本脚本同目录的 `ems-chart/`（Chart.yaml 26.8.0-b6）
整体决定；**该目录不入 git**（含厂商证书私钥与密码，见 .gitignore），随部署
环境分发——平台机 scripts 目录、执行机需与本脚本同目录放置（自检缺失即报
`未找到仓内 chart` 拒跑）。升级 chart = 替换该目录后重跑（同名 release 版本
不一致由前置门禁拦截）。单测：`test/test_ems_deploy.sh`。

**推荐编排**（三段，平台已验证）：`ems-check`（EMS_NAME=新实例名，门禁）→
`ems-hugepages`（大页准备，幂等可单独重跑）→ `ems-deploy`（EMS_NAME/
EMS_RELEASE_NAMESPACES 留空，自动继承 check 契约；TARGET_IPS 留空用平台注入）。

## EMS 卸载（ems-uninstall.sh）

`ems-uninstall.sh` 是 EMS 完整卸载 **step 主脚本**（零参数：执行即卸载，2026-10-15
取消 dry-run；幂等可重跑——已卸干净的节点全跳过）。目标节点 = 平台注入的
`TARGET_IP`/`TARGET_IPS`（勾选环境即表达意图，支持跨 region endpoint 三级
解析）；**跨 region（hd2/NAT 类）**：TARGET_IPS 为外网入口 endpoint（ip:port）
时经分发阶段采集的身份映射三级解析，**节点级 SSH 一律走集群内网 InternalIP +
该 endpoint 的登录凭据**（外网入口在集群内不可路由，实测 Network unreachable；
凭据按内网身份回退，连接走内网 22），先密钥认证、失败后密码认证（无 sshpass
时走 SSH_ASKPASS）。脚本自动推导实例：目标节点 label 前缀（唯一性校验）+ 其上
EMS pod 的 ns 交叉；卸载范围 = 该 label 的**全部**节点（不止勾选的）。四段流程：

1. **[1/4]** `helm uninstall`（按 release 实际所在 ns——历史遗留 release 装在
   default 等非标准 ns 也能卸；不存在跳过）+ 删资源 ns（等待 + 超时强删 pod 兜底
   + 复活检测，kuberay/CI 自动重装 → 失败并提示人工协调）；
2. **[2/4]** 等待节点大页全 free（目标节点无 hugepages 请求 pod + 每节点
   `HugePages_Free==Total`）——这是大页还原的硬前提，被占用时缩减只会挂 surplus；
3. **[3/4]** 大页还原：per-NUMA `nr_hugepages` 写 0（nohup 后台写入 + 轮询归零，
   规避 sysfs 写入阻塞拖死主流程；surplus 释放卡住是内核已知行为，超时 die 并
   提示唯一回收途径 = 重启节点）+ 重启 kubelet 刷 allocatable（不刷则节点大页
   allocatable 虚高 2000Gi 误导后续调度）；
4. **[4/4]** 清 label（放最后：label 是幂等重入的节点定位依据）+ 终验 + 契约输出
   （`EMS_STATUS/EMS_NODES/EMS_RELEASE_REMOVED/EMS_NAMESPACE_REMOVED/
   EMS_HUGEPAGES_RELEASED/EMS_KUBELET_RESTARTED/EMS_LABEL_REMOVED`）。

边界语义：目标节点不属于任何实例 = 已卸干净，**幂等成功退出**（无操作）；
目标节点交叉多个实例（脏 label）→ die 拒卸请人工；无 pod/release 的纯 label
残留同样可清（仅清 label 与大页）。

退出码：0 卸载完成（或幂等退出）；1 失败。单测：`test/test_ems_uninstall.sh`。

```bash
# 卸载（幂等，可直接重跑；实例名由目标节点 label 自动推导）
TARGET_IPS='["192.168.0.243","192.168.0.128"]' bash ems-uninstall.sh
```

## vLLM 原生部署（vllm-native-*.sh）

`vllm-native-*` 脚本族是「原生 vLLM 部署」流水线的 step 主脚本族（配方来源：
`native_vllm_deployment_from_xds.md` 第 12 节；vLLM 代码基线
[TokensService/vllm](https://github.com/TokensService/vllm) 分支 `v0.30.0.tokens`）。
**全程不接 XDS 控制面**：Pod 内设 `VLLM_PLUGINS=""` 关闭全部 XDS 补丁，跑镜像内的
原生 vLLM；Decode 侧 DP>1 的上游 MoERunner bug（vllm-project/vllm #47982/#56759）
用节点准备 step 写入的自写修复文件解决（meta_path import hook，**只挂给 Decode**）。

内置流水线「部署vLLM（原生P/D）」（开箱即有的第二条内置流水线）按以下顺序绑定：

| 阶段 | 脚本 | 职责 |
|------|------|------|
| vLLM环境检查 | `vllm-native-check.sh` | 只读门禁：kubectl/RuntimeClass/节点解析（`VLLM_NODE` 留空按本机 IP 匹配 InternalIP）/GPU 余量/模型文件（`config.json`+tokenizer）/pd 必备 `/dev/infiniband`/宿主端口/并行度一致性（PP 切分段数=`PREFILL_PP`、`PREFILL_GPU`=`VLLM_TP`×`PREFILL_PP` 等）；契约输出 `VLLM_NODE`/`VLLM_GATE=PASS` |
| vLLM节点准备 | `vllm-native-prepare.sh` | 建命名空间（幂等）+ 写 MoERunner 修复文件到 `VLLM_MOEFIX_DIR`（幂等，内容一致跳过） |
| 部署Prefill(PP) | `vllm-native-deploy.sh`（`VLLM_ROLE=prefill`） | 渲染并先删后建 Prefill Pod（TP×PP、kv_producer、挂模型/RDMA/内存型 dshm） |
| 部署Decode(DP) | `vllm-native-deploy.sh`（`VLLM_ROLE=decode`） | Decode Pod（TP×DP + Ray、kv_consumer、挂 moefix 与 RDMA） |
| 等待服务就绪 | `vllm-native-wait.sh` | 轮询 Pod Running + 日志 `Application startup complete`（默认 40 分钟超时；Failed 终态带日志尾快速失败） |
| 重建PD-Proxy | `vllm-native-deploy.sh`（`VLLM_ROLE=proxy`） | Mooncake 代理（对外 `:8000`）。**必须在 P/D 就绪后部署/重建**——代理只在启动时查询一次 prefill bootstrap 并缓存 `engine_id`，P/D 重启后旧代理会「200 但流无数据」 |
| P/D联调验证 | `vllm-native-verify.sh` | `/v1/models` 200 + 真实 `/v1/completions`（最多 3 次重试）+ pd 硬校验 Decode `/metrics` 的 `external_kv_transfer` 计数 > 0（P/D KV 传输生效的直接证据）；契约输出 `VLLM_SERVICE_ADDR` |

编排外还有 `vllm-native-cleanup.sh`（默认 `VLLM_CLEANUP_DRY_RUN=1` 预演，设 0 正式删除
本部署全部 Pod；`VLLM_CLEANUP_MOEFIX=1` 连带删修复文件目录；不删命名空间），可按需
绑为阶段或在「设置 → 清理脚本」选用。

**模式**：`DEPLOY_MODE=pd`（默认）= Prefill + Decode + Proxy 的 P/D 分离；
`DEPLOY_MODE=standalone` = 仅 Prefill 原生基线（直听对外端口 `PROXY_PORT`，不接
Mooncake/Proxy，Decode/Proxy 阶段自动跳过），用于先验证模型与单机配方。

**部署策略选择（arch）**：代码仓设置把 vllm 仓库（`https://github.com/TokensService/vllm`）
的「部署策略」来源设为「策略·脚本」并选用 `list_vllm_model_archs.sh` 后，主控/定时页/
运行弹窗的「部署策略」下拉会按当前分支列出该分支 `model_arch.yaml` 注册的全部
arch_name（命名规则 `<model>-<quant>-<platform>-<n>P<m>D>`，如
`GLM-5.2-W4A4C8-MG40-BNT3-1P1D`），所选值随运行注入 `DEPLOY_STRATEGY`。
当前脚本族参数默认值对应 `GLM-5.2-W4A4C8-MG40-BNT3-1P1D`；按 `DEPLOY_STRATEGY`
切换引擎参数的多 arch 映射留待后续接入。

**执行位置**：与 ems-check 同一自推送模式——注入 `TARGET_HOSTS` 时推送到**首个**目标
节点（= 部署节点，vLLM 单节点部署）执行；执行机仅需 ssh（密码认证需 sshpass），目标
节点需 kubectl + python3。手工独立运行（不注入 TARGET_HOSTS）则在执行机本地跑。

**主要参数**（均为环境变量、阶段参数区可覆盖；脚本头注释逐条说明）：
`DEPLOY_MODE`、`VLLM_NAMESPACE`（默认 `native-vllm`）、`VLLM_NODE`、`VLLM_IMAGE`、
`VLLM_RUNTIME_CLASS`（默认 `dcgm-nvidia-runtime`）、`VLLM_IMAGE_PULL_SECRETS`、
`MODEL_PATH`（容器内模型路径，主控「权重路径」同名注入优先）/`MODEL_HOST_PATH`/
`MODEL_MOUNT_PATH`、`VLLM_SERVED_MODEL_NAME`、`VLLM_TP`/`PREFILL_PP`/`DECODE_DP`/
`PREFILL_GPU`/`DECODE_GPU`、`PP_LAYER_PARTITION`（默认 `22,20,20,16`）、
`PREFILL_PORT`/`DECODE_PORT`/`PROXY_PORT`/`MOONCAKE_BOOTSTRAP_PORT`（8010/8020/8000/8998）、
`VLLM_MAX_MODEL_LEN`、`PREFILL_MAX_NUM_SEQS`/`PREFILL_MAX_NUM_BATCHED_TOKENS`/
`PREFILL_GPU_MEM_UTIL`、`DECODE_MAX_NUM_SEQS`/`DECODE_MAX_NUM_BATCHED_TOKENS`/
`DECODE_GPU_MEM_UTIL`、`VLLM_BLOCK_SIZE`（默认 64，GLM-5.2 NVFP4 各 PP rank 页面须统一）、
`VLLM_SPECULATIVE_CONFIG`（默认 MTP3）、`VLLM_DSHM_SIZE`、`PREFILL_EXTRA_ARGS`/
`DECODE_EXTRA_ARGS`（追加到 `vllm serve` 的自由参数）。

**注意**：① 配方假设 Pod 内 `nvidia-smi` 可见容器分到的 GPU 并重编号为 `0..N-1`
（启动脚本自设 `CUDA_VISIBLE_DEVICES`，不要用 `NVIDIA_VISIBLE_DEVICES`）；② 不要给
Pod 加 `privileged: true`（会让 runtime 暴露全部节点 GPU）；③ P/D 输出与「Decode 直连」
可能措辞不同（异构并行数值差异，Prefill PP 与 Decode DP 专家布局不同），语义一致即正常；
④ 部署参数的镜像 tag 应与所选代码仓分支对应（check 阶段对 `GIT_BRANCH` 中的版本号与
镜像 tag 做一致性提示）。单测：`test/test_vllm_native_scripts.sh`。

## 参数 / 环境变量优先级（vllm-native-arch-deploy.sh）

容器 entry 的生效顺序：

```
set -a; . env-<role>.sh        ← ① arch 的 env 段 → ② 脚本内置运行期 env → ③ NATIVE_VLLM_EXTRA_ENV_{PREFILL,DECODE}
. apply-patches-<role>.sh
. args-<role>.sh               ← arch 的 engine 段渲染出的启动参数
. args-override-<role>.sh      ← 端口纠偏时生成（args 之后 source，后写覆盖）
exec vllm serve "${vllm_native_args[@]}"
```

| 想覆盖的东西 | 用什么 | 谁赢 |
|---|---|---|
| arch 里某角色的 **env**（如 `VLLM_PP_LAYER_PARTITION`、`VLLM_MOONCAKE_BOOTSTRAP_PORT`） | `NATIVE_VLLM_EXTRA_ENV_PREFILL` / `NATIVE_VLLM_EXTRA_ENV_DECODE` | **EXTRA_ENV 赢** ✓（写在同一 env 文件末尾，后写覆盖先写） |
| 脚本内置的运行期 env（`VLLM_ENGINE_READY_TIMEOUT_S`、`VLLM_USE_RUST_FRONTEND`、`VLLM_SERVER_DEV_MODE`、XCCL 变量） | 同上 | **EXTRA_ENV 赢** ✓ |
| arch 里某角色的**启动参数**（`--gpu-memory-utilization`、`--max-model-len`、`--kv-transfer-config` …） | — | **EXTRA_ENV 无效** ✗（vLLM 自身规则：命令行 > 环境变量）→ 只能改 arch 的 `engine` 段 |
| 引擎端口（被外部占用时） | 无需手工 | 脚本写 `args-override-<role>.sh`，在 args 之后 source → **override 赢** ✓ |

角色分流：`decode` / `decode_1` → `NATIVE_VLLM_EXTRA_ENV_DECODE`；`prefill` / `prefill_N` / `standalone` → `NATIVE_VLLM_EXTRA_ENV_PREFILL`。
