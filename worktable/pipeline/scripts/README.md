# 流水线脚本使用说明

流水线工作台（`../pipeline.html`）在「编辑流水线」中给阶段绑定本目录下的脚本；绑定时点「识别参数」会自动从脚本源码识别可配置项。运行到该阶段时通过 `/api/worktable/exec` 执行脚本，并自动注入运行上下文。

## 参数识别规则

脚本源码中出现以下写法会被识别为可配置参数，在阶段行里可填值覆盖：

- 位置参数：`$1`、`${1}`、`${1:-默认值}`、`${2:?必填提示}` …
- 环境变量：`$VAR`、`${VAR}`、`${VAR:-默认值}`、`${VAR:?必填提示}`（`PATH`/`HOME` 等 shell 内置变量除外）

带 `:-默认值` 的参数在页面里预填默认值；带 `:?` 的标记为必填。

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

节点 IP / 用户名 / 密码来自「设置」页的节点环境列表（每个节点可配各自的用户名、密码）；主控「环境（可多选）」勾选哪些节点，注入的就是哪些。

## 快速开始

1. 复制模板：`cp template.sh my-step.sh`，按注释改掉 `deploy_one` 里的演示逻辑；
2. 编辑流水线 → 阶段的「脚本」框输入脚本名 → 点「识别参数」；
3. 需要覆盖注入值时在参数行直接填（同名优先）；留空则使用注入值；
4. 运行流水线，阶段详情里可看到脚本的完整 stdout/stderr 和退出码。

多节点部署参考 `template.sh`：优先解析 `TARGET_HOSTS` 按各节点凭据逐个部署（需本机有 `python3` 或 `jq`）；两者都没有时退化为 `TARGET_IPS` + 首节点凭据。

## XDS 部署阶段契约

XDS 流水线按以下顺序绑定脚本：

1. `pull-image.sh <完整镜像>`：在所有 `TARGET_HOSTS` 预拉镜像；在工作台本机从镜像导出 Chart、values 模板和架构库。
2. `render-config.sh <ARCH_NAME>`：基于只读架构库生成独立的 Chart、values、架构注册请求和 P/D resource manifest。
3. `deploy-model.sh`：使用渲染后的 Chart/values 执行 Helm 安装，并注册渲染后的架构请求。
4. `register-model.sh [MODEL_NAME]`：使用本轮 resource manifest 注册模型。
5. `model-health.sh`：检查 XDS models 接口并发起一次真实 chat 请求。

脚本通过 stdout 中的 `KEY=VALUE` 自动传递运行目录和产物路径。以下参数通常在阶段参数区配置：

- `ARCH_NAME`、`NUM_PREFILL`、`NUM_DECODE`、`PREFILL_GPU`、`DECODE_GPU`
- `XDS_URL`、`MODEL_PATH`、`NAMESPACE`、`RELEASE_NAME`
- `PREFILL_OVERRIDES_JSON`、`DECODE_OVERRIDES_JSON`

镜像必须包含以下模板路径，否则 `pull-image.sh` 会失败：

```text
/opt/op_test/xds_template/k8s/xds-cluster
/opt/op_test/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml
/opt/op_test/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json
```

## 归档与 AI 分析

主控填了「归档路径」后，每次运行结束会把产物写到 `<归档路径>/<流水线名称>_<YYYYMMDD>/`：

- `run-<tag>.log` — 各阶段完整日志（脚本阶段含真实 stdout/stderr）
- `run-<tag>.profile.json` — 各阶段耗时/状态等 profiling 数据

「设置 → 归档配置 → 归档脚本」可配置一个在写完上述产物后执行的脚本（默认 `collect_logs.sh`，留空=不执行），用于把节点/系统日志等额外产物收集进同一归档目录。脚本缺失（如 `collect_logs.sh` 尚未创建）会自动跳过，执行失败也不影响运行结果。除常规的 `TARGET_*`/`IMAGE_*`/`PIPELINE_NAME` 外，还会注入：

- `ARCHIVE_DIR` / `ARCHIVE_FOLDER` — 归档根目录 / 本次运行的归档文件夹（绝对路径）
- `ARCHIVE_LOG_FILE` / `ARCHIVE_PROFILE_FILE` — 归档内 `run-<tag>.log` / `run-<tag>.profile.json` 的绝对路径
- `ARCHIVE_PIPELINE` / `ARCHIVE_TAG` / `ARCHIVE_RESULT` — 流水线名 / 本次运行 tag / 运行结果（`success`/`failed`/`aborted`）

运行启动时即按上述格式生成归档文件夹并快照到本次运行，再把 `ARCHIVE_DIR` / `ARCHIVE_FOLDER` / `ARCHIVE_PIPELINE` / `ARCHIVE_TAG` 注入到流水线的每个任务（脚本阶段、Jenkins 阶段、「先清理环境」的清理脚本），脚本显式参数优先，方便各阶段把产物直接写入归档目录；`ARCHIVE_LOG_FILE` / `ARCHIVE_PROFILE_FILE` / `ARCHIVE_RESULT` 仅在末尾注入给归档脚本。

运行历史里选中某次运行后，可用标题行的「AI 日志分析 / Profiling 分析 / 性能诊断」新建 AI 会话分析，提示词模板在「设置」页维护。
