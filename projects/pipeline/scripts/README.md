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
| `TARGET_USER` / `TARGET_PASSWORD` | 首个节点登录凭据 | `root` |
| `IMAGE_NAME` / `IMAGE_TAG` | 主控「镜像名」/ 本次运行 tag | `xds` / `1510-a1b2c` |
| `PIPELINE_NAME` | 流水线名 | `安装部署XDS` |
| `GIT_URL` / `GIT_BRANCH` | 主控选择的代码仓地址 / 分支 | `https://gitcode.com/org/repo.git` / `main` |
| `GIT_USER` / `GIT_PASSWORD` | 仓库访问令牌（来自「设置」页代码仓列表） | `oauth2` |
| `DEPLOY_STRATEGY` | 所选分支的部署策略（配置了部署策略 URL 时注入） | `low-latency` |

节点 IP / 用户名 / 密码来自「设置」页的节点环境列表（每个节点可配各自的用户名、密码）；主控「环境（可多选）」勾选哪些节点，注入的就是哪些。`template.sh` 开头会把上述全部变量连同 `ARCHIVE_*` 一起打印（未注入的显示 `<未注入>`），凭据类变量（`TARGET_PASSWORD` / `TARGET_HOSTS` / `GIT_PASSWORD`）会明文出现在阶段日志与归档日志中，注意脱敏。

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
/opt/op_test/xds_template/k8s/xds-cluster
/opt/op_test/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml
/opt/op_test/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json
```

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

运行历史里选中某次运行后，可用标题行的「AI 日志分析 / Profiling 分析 / 性能诊断」新建 AI 会话分析：新会话工作目录取该次运行的归档目录，提示词只填入输入框（不自动提交，确认后手动发送），提示词模板在「设置」页维护。

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

# 仅检查，不清理工作负载、不启停服务
bash check-env.sh
```

清理入口保留命名空间白名单、统一等待和 15 秒后强制删除残留 Pod 的逻辑，
清理完成即退出，不再自动进行健康检查。检查入口检查运行时、CNI、API 网络、
内存、大页和 GPU；有 FAIL 时返回非零。两种入口的远程失败均向上透传。

`bnt-standalone.sh` 保留为本地兼容转发入口：默认转到清理，
`ACTION=check-health` 转到检查；不再提供默认「清理后自动检查」行为。
若只复制一个脚本到目标机，应使用上述独立入口。页面已有保存的脚本选择不会自动改写，
可分别在两个脚本设置中选择新文件。页面是否因清理失败而中断，仍由流水线执行策略决定。


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
未设置或为空时，依次读取 `model_name`、`MODEL_NAME`、`ARCH_NAME`；模型名仍按
`/home/service/works/models_ssd/<模型名>/v1` 拼接，绝对路径沿用原样保留的逻辑。
也支持 `--model-path` 和原有 `--model-name` 参数；路径优先于模型名。

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
