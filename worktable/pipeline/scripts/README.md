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

每次执行脚本（含「先清理环境」的清理脚本）都会注入以下变量；**脚本或页面里显式配置的同名参数优先，不会被覆盖**：

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
2. `deploy-model.sh`：执行机选取 `TARGET_HOSTS[0]` 作为控制节点，通过 SSH 同步部署脚本和本轮渲染产物；随后在该目标机读取 Chart、values、架构注册请求和 P/D resource manifest，执行 Helm 安装并注册架构。
3. `register-model.sh [MODEL_NAME]`：使用本轮 resource manifest 注册模型。
4. `model-health.sh`：检查 XDS models 接口并发起一次真实 chat 请求。

目标机产物默认保存于 `/tmp/op-test-pipeline/<PIPELINE_NAME>/rendered`，并在同级写入 `pipeline.env` 供远程部署阶段加载；可通过 `TARGET_RUN_DIR`、`TARGET_RENDER_DIR` 覆盖。`deploy-model.sh` 在执行机不需要 `kubectl` 或 `helm`，但需要 `ssh`；使用密码认证时还需要 `sshpass`。控制目标机必须安装 `kubectl`、`helm` 和 `curl`。脚本通过 stdout 中的 `KEY=VALUE` 自动传递执行机运行目录和产物路径；阶段编辑器的「输出变量」可把捕获的 key 改名后下传给指定的环境变量（如 `IMAGE_URL=image`，与 URL 请求阶段一致），来源也可写 JSON 路径从 stdout / 响应体里的单行 JSON 取嵌套字段（如 `XDS_BRANCH=items.0.name`，数组支持 `[-1]` 倒数取末项，终点为对象/数组则整体序列化成 JSON 字符串；分页列表类接口 `{"items":[...]}` 的顶层标量提取拿不到数组内容，需用路径显式指定），或填 `*` / 留空把本阶段返回值全文整体赋给指定变量（如 `RESP=*`），下游参数值也可填 `${IMAGE_URL}` 显式引用。带「定时」标记的后缀阶段由服务端执行：变量池在定时分界处随计划快照带过，后缀各阶段间同样按上述规则累计/映射/注入（含 `${VAR}` 参数引用）。注意单个环境变量受内核 128KiB 上限约束，超大捕获值（如用 `*` 承接数千分支的完整响应体）不会注入并在阶段日志给出 `[warn]` 告警——这种场景应改用 JSON 路径截取所需字段（如 `XDS_BRANCH=items[-1].name`）。以下参数通常在阶段参数区配置：

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

运行启动时即按上述格式生成归档文件夹并快照到本次运行，再把 `ARCHIVE_DIR` / `ARCHIVE_FOLDER` / `ARCHIVE_PIPELINE` / `ARCHIVE_TAG` 注入到流水线的每个任务（脚本阶段、URL 请求阶段、「先清理环境」的清理脚本；任务内 `ARCHIVE_DIR` 与 `ARCHIVE_FOLDER` 均=本次运行归档文件夹，与归档脚本收到的根目录语义不同），脚本显式参数优先，方便各阶段把产物直接写入归档目录；`ARCHIVE_LOG_FILE` / `ARCHIVE_PROFILE_FILE` / `ARCHIVE_RESULT` 仅在末尾注入给归档脚本。

运行历史里选中某次运行后，可用标题行的「AI 日志分析 / Profiling 分析 / 性能诊断」新建 AI 会话分析：新会话工作目录取该次运行的归档目录，提示词只填入输入框（不自动提交，确认后手动发送），提示词模板在「设置」页维护。
