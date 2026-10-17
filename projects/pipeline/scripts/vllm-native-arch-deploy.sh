#!/usr/bin/env bash
# pipeline: no-positional-args
# vllm-native-arch-deploy 流水线 step 主脚本（shell step，无参调用）：arch 策略驱动、nerdctl 单机 P/D。
#
# 用法：在流水线中「拉取镜像」之后插入本 step。本 step 把一条部署策略
# （部署策略 = 代码仓里 model_arch.yaml 中以 arch_name 为键的记录）变成目标
# GPU 节点上真实跑起来的 native vLLM P/D 服务，全程 nerdctl 容器、不用 k8s：
#   1) 从代码仓取策略目录（model_arch.yaml + render_serve_config.py）
#   2) 渲染 prefill/decode（无 decode 角色时为 standalone）的 --config YAML 与 env
#      并做部署前环境预检（RDMA / GPU 数量与余量 / 端口 / 内存磁盘 / 运行时与权重）
#   3) 自推送本脚本 + 产物到目标节点，在目标节点用 nerdctl 起容器
#      （可选用 LMCache MP server；decode 侧可选注入 MoE scratch 补丁；可选开 vLLM profiler）
#   4) 在目标节点起 vllm-router 做 P/D 前端（不使用官方 mooncake proxy 脚本）
#   5) 校验 health 与 P/D 真实性（decode 侧 external_kv_transfer 增长）
#   6) stdout 输出契约变量，供下游 step 复用
#
# 运行形态：step 在流水线执行机（1.46）执行；本脚本会被推送到目标机，并以
# 位置参数 --remote 再跑一遍自身的「远端阶段」（不含该参数时为父阶段）。
#
# 依赖：执行机 git / python3（含 pyyaml）/ ssh（密码认证另需 sshpass）；
#       目标节点 nerdctl、vllm-router（在 PATH 中）、权重目录、nvidia runtime。
# 退出码：0 成功；1 部署或校验失败；2 入参缺失或环境不满足。
# 单测：test/test_vllm_native_deploy.sh。
set -uo pipefail

SCRIPT_NAME='vllm-native-arch-deploy'

# ---- step 参数声明（平台「识别参数」按声明与紧邻注释扫描）----
# NATIVE_VLLM_IMAGE = 容器镜像（留空=用平台注入的镜像名与标签）
NATIVE_VLLM_IMAGE="${NATIVE_VLLM_IMAGE:-}"
# MODEL_DIR = 目标机上的权重目录（指向含 config.json 的目录），必填
MODEL_DIR="${MODEL_DIR:-}"
# NATIVE_VLLM_PREFILL_GPUS = prefill 使用的卡（目标机物理序号，逗号分隔）
NATIVE_VLLM_PREFILL_GPUS="${NATIVE_VLLM_PREFILL_GPUS:-0,1,2,3}"
# NATIVE_VLLM_DECODE_GPUS = decode 使用的卡（逗号分隔）
NATIVE_VLLM_DECODE_GPUS="${NATIVE_VLLM_DECODE_GPUS:-4,5,6,7}"
# NATIVE_VLLM_MOEFIX = decode 侧注入 MoE scratch 补丁（DP>1 必需；1 开 0 关）
NATIVE_VLLM_MOEFIX="${NATIVE_VLLM_MOEFIX:-1}"
# NATIVE_VLLM_AUTOTUNE = flashinfer autotune（1=开 0=关），**仅对 decode 侧生效**；
# prefill（PP）/ standalone 侧一律强制关闭：PP + autotune 在 _profile_single_kernel 里要跨 rank
# all_reduce，两个 PP rank 调优进度一旦错开就永久死锁（2026-10-17 实测：PP1 早调完 → PP0 all_reduce 无人应答）。
NATIVE_VLLM_AUTOTUNE="${NATIVE_VLLM_AUTOTUNE:-0}"
# NATIVE_VLLM_DEV_MODE = vLLM 服务端 DEV 模式（1=开 0=关；对应 VLLM_SERVER_DEV_MODE=1）。开启后 vLLM 才暴露
#   /reset_prefix_cache、/reset_mm_cache、/sleep、/wake_up、/collective_rpc 等管理端点，可用于清 HBM/KV 缓存
NATIVE_VLLM_DEV_MODE="${NATIVE_VLLM_DEV_MODE:-0}"
# NATIVE_VLLM_PROFILER = vLLM profiler 开关（1=开 0=关），开启后两侧引擎追加 --profiler-config（torch，落盘 <工作目录>/profiles，start_profile 后跳 5 步、最多记 50 步）
NATIVE_VLLM_PROFILER="${NATIVE_VLLM_PROFILER:-0}"
# NATIVE_VLLM_XCCL_ENV_PREFILL = prefill 侧应用 XCCL 插件（xccl-vllm-turbo）的专属环境变量，逗号分隔（如 XCCL_TURBO_ENABLE_MOONCAKE=1,XCCL_TURBO_ENABLE_RMSNORM=1）；留空=不装插件
NATIVE_VLLM_XCCL_ENV_PREFILL="${NATIVE_VLLM_XCCL_ENV_PREFILL:-}"
# NATIVE_VLLM_XCCL_ENV_DECODE = decode 侧同上（留空=该侧不装插件）
NATIVE_VLLM_XCCL_ENV_DECODE="${NATIVE_VLLM_XCCL_ENV_DECODE:-}"
# NATIVE_VLLM_ENGINE_READY_TIMEOUT_SECONDS = 容器内引擎初始化等待上限（权重加载慢）
NATIVE_VLLM_ENGINE_READY_TIMEOUT_SECONDS="${NATIVE_VLLM_ENGINE_READY_TIMEOUT_SECONDS:-3600}"
# NATIVE_VLLM_EXTRA_ENV = 追加到两侧容器的环境变量（空格分隔的若干赋值）
NATIVE_VLLM_EXTRA_ENV="${NATIVE_VLLM_EXTRA_ENV:-}"
# NATIVE_VLLM_SERVICE_NAME = 契约输出的服务名
NATIVE_VLLM_SERVICE_NAME="${NATIVE_VLLM_SERVICE_NAME:-vllm-native}"
# NATIVE_VLLM_READY_TIMEOUT_SECONDS = 单实例就绪（health 200）等待上限
NATIVE_VLLM_READY_TIMEOUT_SECONDS="${NATIVE_VLLM_READY_TIMEOUT_SECONDS:-1800}"
LMCACHE_ENABLE="${LMCACHE_ENABLE:-0}"
LMCACHE_L1_SIZE_GB="${LMCACHE_L1_SIZE_GB:-128}"
LMCACHE_OTLP_ENDPOINT="${LMCACHE_OTLP_ENDPOINT:-http://192.168.10.6:4320}"

# ---- 内部常量与派生值（一律小写，避免被识别成入参）----
declare -n platform_target_hosts='TARGET_HOSTS' 2>/dev/null || true
declare -n platform_image_name='IMAGE_NAME' 2>/dev/null || true
declare -n platform_image_tag='IMAGE_TAG' 2>/dev/null || true
declare -n platform_git_url='GIT_URL' 2>/dev/null || true
declare -n platform_git_branch='GIT_BRANCH' 2>/dev/null || true
declare -n platform_git_user='GIT_USER' 2>/dev/null || true
declare -n platform_git_password='GIT_PASSWORD' 2>/dev/null || true
declare -n platform_native_mode='NATIVE_VLLM_MODE' 2>/dev/null || true
declare -n platform_native_arch_source='NATIVE_VLLM_ARCH_SOURCE' 2>/dev/null || true

# 取策略文件的隐藏开关：不占页面入参，需要时用同名环境变量注入（离线/换仓库/调试）
declare -n hidden_arch_dir='NATIVE_VLLM_ARCH_DIR' 2>/dev/null || true
declare -n hidden_arch_source_dir='NATIVE_VLLM_ARCH_SOURCE_DIR' 2>/dev/null || true
declare -n hidden_arch_url='NATIVE_VLLM_ARCH_URL' 2>/dev/null || true
declare -n hidden_arch_token='NATIVE_VLLM_ARCH_TOKEN' 2>/dev/null || true
declare -n hidden_arch_proxy='NATIVE_VLLM_ARCH_HTTP_PROXY' 2>/dev/null || true
declare -n hidden_arch_fetch='NATIVE_VLLM_ARCH_FETCH' 2>/dev/null || true

arch_dir="${hidden_arch_dir:-examples/disaggregated/tokens_native_pd}"
arch_source_dir="${hidden_arch_source_dir:-}"
arch_url="${hidden_arch_url:-}"
arch_token="${hidden_arch_token:-${platform_git_password:-}}"
arch_proxy="${hidden_arch_proxy:-}"
arch_fetch="${hidden_arch_fetch:-auto}"

# 平台注入值（策略名、目标节点 IP）：不占页面入参，直接吃平台注入
declare -n platform_native_target_ip='NATIVE_VLLM_TARGET_IP' 2>/dev/null || true
declare -n hidden_deploy_strategy='DEPLOY_STRATEGY' 2>/dev/null || true
# 行为开关：默认按部署习惯固定，不占页面入参（需要时用同名环境变量临时覆盖）
declare -n hidden_clean='NATIVE_VLLM_CLEAN' 2>/dev/null || true
declare -n hidden_verify='NATIVE_VLLM_VERIFY' 2>/dev/null || true
declare -n hidden_dry_run='NATIVE_VLLM_DRY_RUN' 2>/dev/null || true
declare -n hidden_skip_precheck='NATIVE_VLLM_SKIP_PRECHECK' 2>/dev/null || true
# Rust 前端默认关闭，且不进页面入参（Rust 前端下 response_format: json_schema 不强制、
# chat_template_kwargs 如 enable_thinking=false 不生效）；需要时用同名环境变量覆盖
declare -n hidden_use_rust_frontend='NATIVE_VLLM_USE_RUST_FRONTEND' 2>/dev/null || true

deploy_strategy="${hidden_deploy_strategy:-}"
target_ip_param="${platform_native_target_ip:-}"
clean_old="${hidden_clean:-1}"
verify_after="${hidden_verify:-1}"
dry_run="${hidden_dry_run:-0}"
skip_precheck="${hidden_skip_precheck:-0}"
use_rust_frontend="${hidden_use_rust_frontend:-0}"

# router 相关：不占页面入参（P/D 连接器默认 mooncake，与本路线已验证组合一致）
declare -n hidden_router_port='NATIVE_VLLM_ROUTER_PORT' 2>/dev/null || true
declare -n hidden_router_bin='NATIVE_VLLM_ROUTER_BIN' 2>/dev/null || true
declare -n hidden_router_policy='NATIVE_VLLM_ROUTER_POLICY' 2>/dev/null || true
declare -n hidden_router_kv='NATIVE_VLLM_KV_CONNECTOR' 2>/dev/null || true
declare -n hidden_router_version='NATIVE_VLLM_ROUTER_VERSION' 2>/dev/null || true
declare -n hidden_nerdctl_src='NATIVE_VLLM_NERDCTL_SRC' 2>/dev/null || true
declare -n hidden_xccl_wheel='NATIVE_VLLM_XCCL_WHEEL' 2>/dev/null || true
declare -n hidden_pip_index='NATIVE_VLLM_PIP_INDEX' 2>/dev/null || true

router_port="${hidden_router_port:-8000}"
router_bin="${hidden_router_bin:-vllm-router}"
# 目标机缺 vllm-router 时脚本自动补装：父阶段在执行机下 wheel（走国内镜像、缓存复用），随产物送到
# 目标机，远端离线装进下面这个专用 venv（目标机通常没有外网），并把 router_bin 指向它。
router_version="${hidden_router_version:-0.1.16}"
router_venv='/opt/vllm-router/venv'
router_wheels_cache="${HOME}/.cache/vllm-native/router-wheels-${router_version}"
# 目标机缺 nerdctl 时从执行机分发静态二进制（gy1-2/hd2 多台节点没装 nerdctl，但都在跑 containerd）
nerdctl_src="${hidden_nerdctl_src:-/usr/local/bin/nerdctl}"
# XCCL 插件（xccl-vllm-turbo）：whl 默认在执行机的仓 built/ 目录下（可用隐藏参数 NATIVE_VLLM_XCCL_WHEEL 指定）
xccl_wheel_src="${hidden_xccl_wheel:-}"
xccl_wheel_glob='/mnt/data/lichangsong/xccl-vllm-turbo/built/xccl_vllm_turbo-*.whl'
# pip 源：默认国内镜像（阿里云），可用 NATIVE_VLLM_PIP_INDEX 或 PIP_INDEX_URL 覆盖
pip_index="${hidden_pip_index:-${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple}}"
pip_trusted_host="${pip_index#*://}"
pip_trusted_host="${pip_trusted_host%%/*}"

# P/D 的 HTTP keep-alive：镜像默认 5s，而 router 复用同一连接的空闲间隔可能远超 5s
# （多 DP worker 轮转时尤其明显）→ 服务端先关空闲连接、router 再写请求体就撞 Broken pipe。
# 调长到 75s 消除该竞态；策略 env 或 NATIVE_VLLM_EXTRA_ENV 仍可覆盖。
declare -n hidden_http_keep_alive='NATIVE_VLLM_HTTP_KEEP_ALIVE_SECONDS' 2>/dev/null || true

http_keep_alive_seconds="${hidden_http_keep_alive:-75}"
router_policy="${hidden_router_policy:-round_robin}"
router_kv_connector="${hidden_router_kv:-mooncake}"

# 目标机工作目录：按平台惯例 /tmp/op-test-pipeline/<流水线名>/native 推导（与 XDS 脚本同约定）
declare -n platform_pipeline_name='PIPELINE_NAME' 2>/dev/null || true
declare -n platform_model_name='MODEL_NAME' 2>/dev/null || true
declare -n hidden_run_dir='NATIVE_VLLM_RUN_DIR' 2>/dev/null || true

native_run_dir="${hidden_run_dir:-/tmp/op-test-pipeline/${platform_pipeline_name:-vllm-native}/native}"

# LMCache 其他细节内部化（默认值即已验证配置；需要时用同名环境变量临时覆盖）
declare -n hidden_lmcache_mp_port='LMCACHE_MP_PORT' 2>/dev/null || true
declare -n hidden_lmcache_http_port='LMCACHE_HTTP_PORT' 2>/dev/null || true
declare -n hidden_lmcache_chunk_size='LMCACHE_CHUNK_SIZE' 2>/dev/null || true
declare -n hidden_lmcache_eviction='LMCACHE_EVICTION_POLICY' 2>/dev/null || true
declare -n hidden_lmcache_wm='LMCACHE_EVICTION_TRIGGER_WATERMARK' 2>/dev/null || true
declare -n hidden_lmcache_ratio='LMCACHE_EVICTION_RATIO' 2>/dev/null || true
declare -n hidden_lmcache_l1_init='LMCACHE_L1_INIT_SIZE_GB' 2>/dev/null || true
declare -n hidden_lmcache_ready_timeout='LMCACHE_READY_TIMEOUT_SECONDS' 2>/dev/null || true
declare -n hidden_lmcache_cpu_workers='LMCACHE_MAX_CPU_WORKERS' 2>/dev/null || true

lmcache_mp_port="${hidden_lmcache_mp_port:-6555}"
lmcache_http_port="${hidden_lmcache_http_port:-8090}"
# LMCache MP CPU 亲和池 worker 数（默认 8；可用隐藏变量 LMCACHE_MAX_CPU_WORKERS 覆盖）
lmcache_max_cpu_workers="${hidden_lmcache_cpu_workers:-8}"
lmcache_chunk_size="${hidden_lmcache_chunk_size:-1024}"
lmcache_eviction_policy="${hidden_lmcache_eviction:-LRU}"
# 驱逐触发水位 / 单次驱逐比例（lmcache server 默认 0.8 / 0.2）
lmcache_eviction_watermark="${hidden_lmcache_wm:-0.95}"
lmcache_eviction_ratio="${hidden_lmcache_ratio:-0.05}"
# lazy 模式下的初始 L1 大小（lmcache server 默认仅 20G，会从很低开始往上长）
lmcache_l1_init_size_gb="${hidden_lmcache_l1_init:-500}"
# LMCache 就绪等待：预钉初始 L1 很重（500G 实测 ~190s），默认给足；就绪即返回，超时给大无代价
lmcache_ready_timeout="${hidden_lmcache_ready_timeout:-600}"

container_prefix='vllm-native'
runtime_bin='/usr/bin/nvidia-container-runtime'
containerd_ns='k8s.io'
work_dir="$native_run_dir"
stage_dir=''
target_ip=''
target_port=''   # 目标机 SSH 端口（target 写成 host:port 时生效；只用于 ssh/scp，不进 URL/契约）
target_user='root'
target_pass=''
image_ref=''
mode='pd'
model_name=''
service_name="$NATIVE_VLLM_SERVICE_NAME"
arch_source='local'
roles=()
container_names=("${container_prefix}-prefill" "${container_prefix}-decode" "${container_prefix}-standalone" "${container_prefix}-lmcache")
# 本部署旧实例当前占用的端口（预检填充，供 port_check_and_fix 在清理前判定）
declare -A ours_port=()
script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
# 保活：跨 NAT/EIP 的长任务里链路空闲会被静默丢弃，没保活会导致 ssh 永远挂在 do_select（远端早完成、父进程等半小时）。
ssh_opts=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15 \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
log()  { printf '[%s] %s\n' "$SCRIPT_NAME" "$*"; }
warn() { printf '[%s][warn] %s\n' "$SCRIPT_NAME" "$*" >&2; }
die()  { printf '[%s][error] %s\n' "$SCRIPT_NAME" "$1" >&2; exit "${2:-1}"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令 $1（$2）" 2
}

target_ssh() {
  local -a port_args=()
  [[ -n "$target_port" ]] && port_args=(-p "$target_port")
  if [[ -n "$target_pass" ]]; then
    SSHPASS="$target_pass" sshpass -e ssh "${ssh_opts[@]}" ${port_args[@]+"${port_args[@]}"} "${target_user}@${target_ip}" "$@"
  else
    ssh "${ssh_opts[@]}" ${port_args[@]+"${port_args[@]}"} "${target_user}@${target_ip}" "$@"
  fi
}

target_scp() {
  local -a port_args=()
  [[ -n "$target_port" ]] && port_args=(-P "$target_port")
  if [[ -n "$target_pass" ]]; then
    SSHPASS="$target_pass" sshpass -e scp "${ssh_opts[@]}" ${port_args[@]+"${port_args[@]}"} -r "$1" "${target_user}@${target_ip}:$2"
  else
    scp "${ssh_opts[@]}" ${port_args[@]+"${port_args[@]}"} -r "$1" "${target_user}@${target_ip}:$2"
  fi
}

# 从目标节点列表（JSON 数组）解析目标机；显式指定 IP 优先
resolve_target() {
  local -a picked_lines=()
  mapfile -t picked_lines < <(python3 - "${platform_target_hosts:-[]}" "$target_ip_param" <<'PY'
import json
import sys


def split_host_port(value):
    """host:port → (host, port)；无端口时 port 为空串。"""
    text = str(value or "")
    host, sep, port = text.partition(":")
    return host, (port if sep else "")


raw, wanted = sys.argv[1], sys.argv[2]
try:
    hosts = json.loads(raw or "[]")
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid target host list: {error}")
if not isinstance(hosts, list):
    raise SystemExit("target host list must be a JSON array")
entry = None
if wanted:
    wanted_host, wanted_port = split_host_port(wanted)
    # ① 完整串（含端口）精确匹配 ② 主机名匹配
    for item in hosts:
        if isinstance(item, dict) and str(item.get("ip", "")) == wanted:
            entry = item
            break
    if entry is None:
        for item in hosts:
            if isinstance(item, dict) and split_host_port(item.get("ip"))[0] == wanted_host:
                entry = item
                break
    entry = entry or {"ip": wanted}
elif hosts:
    entry = hosts[0]
if not isinstance(entry, dict) or not entry.get("ip"):
    raise SystemExit("no usable target host: list empty and target IP unset")
host, port = split_host_port(entry["ip"])
if not port:
    _, port = split_host_port(wanted)   # 平台直接把 host:port 传进来时
user = str(entry.get("user") or "root")
password = entry.get("pass") or entry.get("password") or ""
# 逐行输出（port/password 可能为空；不能用 tab 分隔的 read——tab 是 IFS 空白符，空字段会被合并）
print(host)
print(port)
print(user)
print(password)
PY
)
  target_ip="${picked_lines[0]:-}"
  target_port="${picked_lines[1]:-}"
  target_user="${picked_lines[2]:-root}"
  target_pass="${picked_lines[3]:-}"
  [[ -n "$target_ip" ]] || die "未能确定目标节点 IP" 2
  [[ "$target_port" =~ ^[0-9]+$ ]] || target_port=''
  [[ -z "$target_port" ]] || log "目标机 SSH 端口：$target_port（host:port 形式）"
}

resolve_image() {
  [[ -n "$NATIVE_VLLM_IMAGE" ]] && { printf '%s' "$NATIVE_VLLM_IMAGE"; return 0; }
  local name="${platform_image_name:-}" tag="${platform_image_tag:-}"
  if [[ -n "$name" && -n "$tag" ]]; then
    printf '%s:%s' "$name" "$tag"
    return 0
  fi
  [[ -n "$name" ]] && { printf '%s' "$name"; return 0; }
  return 1
}

# ---------------------------------------------------------------------------
# 策略获取与渲染（父阶段）
# ---------------------------------------------------------------------------
# 在线取策略文件：按代码仓地址推导候选地址（raw / API），全部失败再回落 git 克隆
fetch_arch_file() {
  local dest="$1"
  local target="$dest/model_arch.yaml"
  local token="$arch_token"
  local proxy="$arch_proxy"
  local -a curl_args=(-fsSL --max-time 30 --retry 2 --retry-delay 2)
  [[ -n "$proxy" ]] && curl_args+=(--proxy "$proxy")
  [[ -n "$token" ]] && curl_args+=(-H "Authorization: Bearer $token")

  if [[ -n "$arch_source_dir" ]]; then
    if [[ -f "$arch_source_dir/$arch_dir/model_arch.yaml" ]]; then
      cp "$arch_source_dir/$arch_dir/model_arch.yaml" "$target" || die "复制本地策略文件失败"
    elif [[ -f "$arch_source_dir/model_arch.yaml" ]]; then
      cp "$arch_source_dir/model_arch.yaml" "$target" || die "复制本地策略文件失败"
    else
      die "本地策略目录里没有 model_arch.yaml：$arch_source_dir" 2
    fi
    arch_source='local'
    return 0
  fi

  if [[ "$arch_fetch" != 'git' ]]; then
    local urls url
    urls="$(python3 - "${platform_git_url:-}" "${platform_git_branch:-}" \
      "$arch_dir" 'model_arch.yaml' "$arch_url" <<'PY'
import sys

git_url, branch, arch_dir, arch_file, explicit = sys.argv[1:6]
if explicit:
    for key, value in {"branch": branch, "arch_dir": arch_dir, "arch_file": arch_file}.items():
        explicit = explicit.replace("{" + key + "}", value)
    print(explicit)

if git_url:
    raw = git_url.strip()
    if raw.startswith("git@"):
        host, _, rest = raw[4:].partition(":")
        scheme = "https"
    else:
        scheme, _, rest = raw.partition("://") if "://" in raw else ("https", "", raw)
        host, _, rest = rest.partition("/")
    repo = rest[:-4] if rest.endswith(".git") else rest
    path = f"{arch_dir.strip('/')}/{arch_file}"
    if host.endswith("github.com"):
        print(f"https://raw.githubusercontent.com/{repo}/{branch}/{path}")
        print(f"https://api.github.com/repos/{repo}/contents/{path}?ref={branch}")
    elif host.endswith("gitcode.com"):
        print(f"https://raw.gitcode.com/{repo}/raw/{branch}/{path}")
        print(f"https://api.gitcode.com/api/v5/repos/{repo}/contents/{path}?ref={branch}")
    elif host.endswith("gitee.com"):
        print(f"https://gitee.com/{repo}/raw/{branch}/{path}")
    else:
        print(f"{scheme}://{host}/{repo}/-/raw/{branch}/{path}")
PY
)" || die "生成策略地址候选失败" 2
    while IFS= read -r url; do
      [[ -n "$url" ]] || continue
      # 先按原文取（GitHub contents API 靠 Accept: raw 直接返回文件内容）
      if curl "${curl_args[@]}" -H 'Accept: application/vnd.github.raw' "$url" -o "$target" 2>/dev/null \
         && [[ -s "$target" ]] && ! head -c 1 "$target" | grep -q '{'; then
        arch_source="online:${url%%\?*}"
        log "在线获取策略文件成功：$url"
        return 0
      fi
      # 拿到的是 JSON（content 为 base64）时解码
      if [[ -s "$target" ]] && head -c 1 "$target" | grep -q '{' \
         && python3 - "$target" <<'PY' 2>/dev/null
import base64
import json
import sys

path = sys.argv[1]
data = json.load(open(path, encoding="utf-8"))
content = data.get("content")
if not isinstance(content, str):
    raise SystemExit(1)
open(path, "w", encoding="utf-8").write(base64.b64decode(content).decode("utf-8"))
PY
      then
        arch_source="online-api:${url%%\?*}"
        log "在线获取策略文件成功（API 解码）：$url"
        return 0
      fi
    done <<<"$urls"
    [[ "$arch_fetch" == 'online' ]] && die "在线获取策略文件失败（已尝试候选地址）" 1
    warn "在线获取策略文件失败，回落 git 克隆"
  fi

  local git_url="${platform_git_url:-}" git_branch="${platform_git_branch:-}"
  [[ -n "$git_url" ]] || die "策略文件获取失败，且缺少平台注入的代码仓地址" 2
  [[ -n "$git_branch" ]] || die "缺少平台注入的代码仓分支" 2
  local askpass="$dest/.git-askpass"
  # 用小写变量把凭据传给 askpass 子进程：大写名加冒号默认值的引用形态会被参数识别器扫成入参
  export git_cred_user="${platform_git_user:-}" git_cred_password="${platform_git_password:-}"
  cat >"$askpass" <<'ASKPASS'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' "$git_cred_user" ;;
  *Password*) printf '%s\n' "$git_cred_password" ;;
esac
ASKPASS
  chmod 700 "$askpass"
  export GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0
  local tmp_repo="$dest/.repo"
  if git -c credential.helper= clone --quiet --depth 1 --filter=blob:none --sparse \
       --branch "$git_branch" --single-branch "$git_url" "$tmp_repo" 2>/dev/null; then
    git -C "$tmp_repo" sparse-checkout set "$arch_dir" >/dev/null 2>&1 \
      || warn "sparse-checkout 设置失败，继续尝试读取已知路径"
  else
    log "部分克隆不可用，回退浅克隆整个仓库"
    rm -rf "$tmp_repo"
    git -c credential.helper= clone --quiet --depth 1 --branch "$git_branch" \
      --single-branch "$git_url" "$tmp_repo" || die "git 拉取代码仓失败：$git_url@$git_branch"
  fi
  local src="$tmp_repo/$arch_dir/model_arch.yaml"
  [[ -f "$src" ]] || die "分支 $git_branch 中不存在策略文件 $arch_dir/model_arch.yaml"
  cp "$src" "$target" || die "复制策略文件失败"
  rm -rf "$tmp_repo" "$askpass"
  arch_source="git:$git_branch"
}

# 角色渲染：从策略里取该角色的 engine/env，覆盖本路线必需项后写出 config YAML 与 env
render_role() {
  local arch_file="$stage_dir/model_arch.yaml"
  local role="$1"
  [[ -f "$arch_file" ]] || die "缺少策略文件：$arch_file"
  python3 - "$arch_file" "$deploy_strategy" "$role" "$stage_dir" "$MODEL_DIR" \
    "$NATIVE_VLLM_AUTOTUNE" "$LMCACHE_ENABLE" "$lmcache_mp_port" "$http_keep_alive_seconds" \
    "$NATIVE_VLLM_PROFILER" "$native_run_dir" <<'PY' \
    || die "$1 角色渲染失败"
import json
import shlex
import sys

import yaml

(
    arch_file,
    arch_name,
    role,
    out_dir,
    model_dir,
    autotune,
    lmcache_enable,
    lmcache_mp_port,
    http_keep_alive_seconds,
    profiler_enable,
    run_dir,
) = sys.argv[1:12]

with open(arch_file, encoding="utf-8") as handle:
    registry = yaml.safe_load(handle) or {}
if not isinstance(registry, dict) or arch_name not in registry:
    known = ", ".join(sorted(registry)) if isinstance(registry, dict) else ""
    raise SystemExit(f"策略 {arch_name!r} 不在注册表中；已登记：{known}")
strategy = registry[arch_name]
section = strategy.get(role) if isinstance(strategy, dict) else None
if not isinstance(section, dict):
    available = ", ".join(k for k in strategy if k in ("prefill", "decode", "standalone"))
    raise SystemExit(f"策略 {arch_name!r} 没有 {role} 角色；可用角色：{available}")
engine = section.get("engine")
if not isinstance(engine, dict) or not engine:
    raise SystemExit(f"策略 {arch_name!r} 的 {role} 角色缺少 engine 段")

# 与上游 render_serve_config.py 等价的自含实现：只需一份 model_arch.yaml 即可渲染
config = dict(engine)

# 权重目录与监听地址由编排层决定
config["model"] = model_dir
config["host"] = "0.0.0.0"

# 本地 DP（无 Ray）：策略若写 ray，这里改成 mp 并补 local 尺寸
dp_size = config.get("data-parallel-size")
if isinstance(dp_size, int) and dp_size > 1:
    config["data-parallel-backend"] = "mp"
    config["data-parallel-size-local"] = dp_size

# flashinfer autotune：只给 decode 侧（有 DP、无 PP）；prefill 强制关——PP + autotune 会跨 rank
# all_reduce，两 rank 进度错开即永久死锁（详见参数注释）。
kernel_config = config.get("kernel-config")
if not isinstance(kernel_config, dict):
    kernel_config = {}
kernel_config["enable_flashinfer_autotune"] = bool(int(autotune)) if role == "decode" else False
config["kernel-config"] = kernel_config

# 可选：prefill 的 PD 连接器外面再包一层 MultiConnector 接本地 LMCache
if int(lmcache_enable) == 1 and role == "prefill":
    kv_config = config.get("kv-transfer-config")
    if not isinstance(kv_config, dict):
        raise SystemExit("LMCACHE_ENABLE=1 需要策略里存在 kv-transfer-config")
    pd_connector = dict(kv_config)
    lmcache_connector = {
        "kv_connector": "LMCacheMPConnector",
        "kv_role": "kv_both",
        "kv_connector_extra_config": {
            "lmcache.mp.host": "tcp://127.0.0.1",
            "lmcache.mp.port": int(lmcache_mp_port),
        },
    }
    config["kv-transfer-config"] = {
        "kv_connector": "MultiConnector",
        "kv_role": kv_config.get("kv_role", "kv_producer"),
        # 顺序很重要：LMCacheMPConnector 在前、PD 连接器在后（先挂本地缓存层）
        "kv_connector_extra_config": {"connectors": [lmcache_connector, pd_connector]},
    }

# 可选：vLLM profiler（torch）。只有启动时带上 --profiler-config，引擎才会挂载
# /start_profile、/stop_profile；0.31 已移除环境变量入口，运行中无法临时开启。
# 落盘目录取工作目录下的 profiles/（容器把工作目录按同路径 bind 挂载，宿主机可直接取）。
if int(profiler_enable) == 1:
    config["profiler-config"] = {
        "profiler": "torch",
        "torch_profiler_dir": f"{run_dir}/profiles",
        "torch_profiler_with_stack": False,
        "torch_profiler_with_flops": True,
        "torch_profiler_record_shapes": True,
        "torch_profiler_with_memory": False,
        "torch_profiler_use_gzip": True,
        "torch_profiler_dump_cuda_time_total": True,
        "ignore_frontend": True,
        "detailed_trace_annotation": True,
        "delay_iterations": 5,
        "max_iterations": 50,
    }

with open(f"{out_dir}/config-{role}.yaml", "w", encoding="utf-8") as handle:
    yaml.safe_dump(config, handle, sort_keys=False, allow_unicode=True)


def to_cli_args(engine_config):
    """把 engine 段渲染成 `vllm serve` 的 CLI 参数列表。

    走 CLI 而不是 --config：本镜像里 --config 与 Rust 前端不兼容（引擎会把
    序列化后的 config 传给 Rust 前端，被其参数解析器拒绝）。CLI 形态与手工
    验证过的启动方式完全一致。
    """
    args = []
    for key, value in engine_config.items():
        flag = "--" + str(key)
        if isinstance(value, bool):
            # vLLM 布尔参数为 BooleanOptionalAction：True → --flag，False → --no-flag
            args.append(flag if value else flag.replace("--", "--no-", 1))
        elif isinstance(value, (dict, list)):
            args.extend([flag, json.dumps(value, ensure_ascii=False, separators=(",", ":"))])
        else:
            args.extend([flag, str(value)])
    return args


cli_args = to_cli_args(config)
with open(f"{out_dir}/args-{role}.sh", "w", encoding="utf-8") as handle:
    handle.write("vllm_native_args=(\n")
    for item in cli_args:
        handle.write(f"  {shlex.quote(item)}\n")
    handle.write(")\n")

with open(f"{out_dir}/env-{role}.sh", "w", encoding="utf-8") as handle:
    # 先写本路线默认的 keep-alive，策略 env 与 NATIVE_VLLM_EXTRA_ENV 后写可覆盖
    handle.write(
        "export VLLM_HTTP_TIMEOUT_KEEP_ALIVE="
        f"{shlex.quote(str(http_keep_alive_seconds))}\n"
    )
    for key, value in (section.get("env") or {}).items():
        handle.write(f"export {key}={shlex.quote(str(value))}\n")
PY
}

role_port() {
  python3 - "$stage_dir/config-$1.yaml" <<'PY'
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as handle:
    config = yaml.safe_load(handle) or {}
port = config.get("port")
if not isinstance(port, int):
    raise SystemExit(f"role config has no integer port: {sys.argv[1]}")
print(port)
PY
}

# 容器入口脚本：先 source 策略环境变量，必要时装 D 侧补丁，再 exec vllm serve
write_entry_scripts() {
  local role entry
  for role in "${roles[@]}"; do
    entry="$stage_dir/entry-$role.sh"
    {
      printf '#!/usr/bin/env bash\n'
      printf '# 由 %s 生成：%s 角色容器入口\n' "$SCRIPT_NAME" "$role"
      printf 'set -uo pipefail\n'
      printf 'set -a\n. "%s/env-%s.sh"\nset +a\n' "$work_dir" "$role"
      printf '. "%s/apply-patches-%s.sh"\n' "$work_dir" "$role"
      printf '. "%s/args-%s.sh"\n' "$work_dir" "$role"
      printf '# 运行期参数覆盖（预检自动纠偏端口时生成；在 args 之后追加，后写覆盖先写）\n'
      printf 'if [[ -f "%s/args-override-%s.sh" ]]; then . "%s/args-override-%s.sh"; fi\n' \
        "$work_dir" "$role" "$work_dir" "$role"
      printf '# XCCL 插件（xccl-vllm-turbo）：仅当本次部署该侧启用时随产物安装\n'
      printf 'if [[ -n "${VLLM_XCCL_TURBO_WHL:-}" && -f "$VLLM_XCCL_TURBO_WHL" ]]; then\n'
      printf '  if python3 -m pip install --no-index --no-deps --disable-pip-version-check --quiet "$VLLM_XCCL_TURBO_WHL"; then\n'
      printf '    echo "[entry] XCCL 插件已安装：$VLLM_XCCL_TURBO_WHL"\n'
      printf '  else\n'
      printf '    echo "[entry][warn] XCCL 插件安装失败：$VLLM_XCCL_TURBO_WHL"\n'
      printf '  fi\n'
      printf 'fi\n'
      printf 'exec vllm serve "${vllm_native_args[@]}"\n'
    } >"$entry"
    chmod 700 "$entry"
  done
}

# 容器内补丁装载脚本：D 侧 MoE scratch 补丁；P 侧（开 LMCache 时）MultiConnector 指标补丁
write_patch_appliers() {
  local role out
  for role in "${roles[@]}"; do
    out="$stage_dir/apply-patches-$role.sh"
    {
      printf '#!/usr/bin/env bash\n'
      printf 'site_packages=/usr/local/lib/python3.12/dist-packages\n'
      if [[ "$role" == "decode" && "$NATIVE_VLLM_MOEFIX" == "1" ]]; then
        printf 'if [[ -f "%s/moefix/vllm_native_moefix.py" ]]; then\n' "$work_dir"
        printf '  cp "%s/moefix/vllm_native_moefix.py" "%s/moefix/zz_vllm_native_moefix.pth" "$site_packages"/\n' "$work_dir" "$work_dir"
        printf 'fi\n'
      fi
      if [[ "$role" == "prefill" && "$LMCACHE_ENABLE" == "1" ]]; then
        printf 'if [[ -f "%s/vllm_native_metafix.py" ]]; then\n' "$work_dir"
        printf '  cp "%s/vllm_native_metafix.py" "%s/zz_vllm_native_metafix.pth" "$site_packages"/\n' "$work_dir" "$work_dir"
        printf 'fi\n'
      fi
    } >"$out"
    chmod 700 "$out"
  done
}

# LMCache(MultiConnector) 指标补丁：MultiKVConnectorPromMetrics.observe 会对 stats 里
# 出现但未注册的连接器 id 断言失败（如 MooncakeConnector），异常逃逸到
# AsyncLLM.output_handler → ASGI 优雅关停（表现为"发完第一个 chat 后 P 就没了"）。
# 这里把该 observe 换成容错版本，只跳过未注册的连接器指标。
write_metafix() {
  cat >"$stage_dir/vllm_native_metafix.py" <<'METAFIX'
import sys
import importlib.abc

_TARGET = "vllm.distributed.kv_transfer.kv_connector.v1.multi_connector"
_applied = False
_warned = set()


def _apply(module):
    global _applied
    if _applied:
        return
    cls = getattr(module, "MultiKVConnectorPromMetrics", None)
    if cls is None:
        return
    _orig = cls.observe

    def _patched(self, transfer_stats_data, engine_idx=0):
        known = getattr(self, "_prom_metrics", None) or {}
        for connector_id, stats_data in (transfer_stats_data or {}).items():
            prom = known.get(connector_id)
            if prom is None:
                if connector_id not in _warned:
                    _warned.add(connector_id)
                    print(
                        f"[native_metafix] 跳过未注册的连接器指标: {connector_id}"
                        f"（已注册: {list(known)}）",
                        flush=True,
                    )
                continue
            prom.observe(stats_data, engine_idx)

    cls.observe = _patched
    _applied = True


class _F(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname != _TARGET:
            return None
        spec = None
        for finder in sys.meta_path:
            if finder is self:
                continue
            try:
                spec = finder.find_spec(fullname, path, target)
            except Exception:
                spec = None
            if spec is not None:
                break
        if spec is None or getattr(spec, "loader", None) is None:
            return spec
        loader = spec.loader
        orig = loader.exec_module

        def exec_module(module):
            orig(module)
            _apply(module)

        try:
            loader.exec_module = exec_module
        except Exception:
            return spec
        return spec


if not any(isinstance(finder, _F) for finder in sys.meta_path):
    sys.meta_path.insert(0, _F())
METAFIX
  printf 'import vllm_native_metafix\n' >"$stage_dir/zz_vllm_native_metafix.pth"
  log "生成 MultiConnector 指标补丁（metafix）"
}

# D 侧 MoE scratch 补丁：DP>1 时 naive dispatch 聚合各 rank 的 batch，
# permute scratch 未按 dp_size 放大 → AssertionError: n_token <= max_num_tokens
write_moefix() {
  mkdir -p "$stage_dir/moefix"
  cat >"$stage_dir/moefix/vllm_native_moefix.py" <<'PY'
import sys
import importlib.abc

_TARGET = "vllm.model_executor.layers.fused_moe.runner.moe_runner"
_PRINTED = False


def _apply(module):
    MoERunner = getattr(module, "MoERunner", None)
    if MoERunner is None or getattr(MoERunner, "_native_moefix_applied", False):
        return
    _orig = MoERunner.__init__

    def _patched(self, *a, **k):
        _orig(self, *a, **k)
        cfg = getattr(self, "moe_config", None)
        pc = getattr(cfg, "moe_parallel_config", None) if cfg else None
        if pc is None:
            return
        scale = 1
        if getattr(self, "do_naive_dispatch_combine", False):
            scale *= max(1, int(getattr(pc, "dp_size", 1) or 1))
        if int(getattr(pc, "pcp_size", 1) or 1) > 1 and not getattr(pc, "use_all2all_kernels", False):
            scale *= int(getattr(pc, "pcp_size", 1) or 1)
        if scale > 1:
            global _PRINTED
            old = cfg.max_num_tokens
            cfg.max_num_tokens = old * scale
            if not _PRINTED:
                _PRINTED = True
                print(f"[native_moefix] scale={scale} max_num_tokens {old} -> {cfg.max_num_tokens}", flush=True)

    MoERunner.__init__ = _patched
    MoERunner._native_moefix_applied = True


class _F(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname != _TARGET:
            return None
        spec = None
        for finder in sys.meta_path:
            if finder is self:
                continue
            try:
                spec = finder.find_spec(fullname, path, target)
            except Exception:
                spec = None
            if spec is not None:
                break
        if spec is None or getattr(spec, "loader", None) is None:
            return spec
        loader = spec.loader
        orig = loader.exec_module

        def exec_module(module):
            orig(module)
            _apply(module)

        try:
            loader.exec_module = exec_module
        except Exception:
            return spec
        return spec


if not any(isinstance(finder, _F) for finder in sys.meta_path):
    sys.meta_path.insert(0, _F())
PY
  printf 'import vllm_native_moefix\n' >"$stage_dir/moefix/zz_vllm_native_moefix.pth"
}

# 父阶段把「各角色端口 + 所需卡数」落成纯 shell 变量文件，随产物推到目标机：
# 目标机因此不再需要 python3/PyYAML 成能解析渲染产物（远端只 . 这个文件）。
# 格式（每行一个赋值，可安全 source，变量是全局）：role_port_<role>=8010 / role_need_<role>=4
write_role_facts() {
  local role
  [[ ${#roles[@]} -gt 0 ]] || die "没有可渲染的角色" 2
  python3 - "$stage_dir" "${roles[@]}" >"$stage_dir/role-facts.env" <<'PY' \
    || die "生成 role-facts.env 失败" 2
import os
import sys

import yaml

stage = sys.argv[1]
for role in sys.argv[2:]:
    path = os.path.join(stage, f"config-{role}.yaml")
    if not os.path.exists(path):
        continue
    with open(path, encoding="utf-8") as handle:
        cfg = yaml.safe_load(handle) or {}
    need = (
        int(cfg.get("tensor-parallel-size", 1) or 1)
        * int(cfg.get("pipeline-parallel-size", 1) or 1)
        * int(cfg.get("data-parallel-size", 1) or 1)
    )
    print(f"role_port_{role}={int(cfg.get('port', 0) or 0)}")
    print(f"role_need_{role}={need}")
PY
  [[ -s "$stage_dir/role-facts.env" ]] || die "role-facts.env 为空（渲染产物异常）" 2
  for role in "${roles[@]}"; do
    grep -q "^role_need_$role=" "$stage_dir/role-facts.env" \
      || die "role-facts.env 缺少角色 $role" 2
  done
}

# 从 role-facts.env 取某角色「每实例卡数」（= tp×pp×dp）
role_need() {
  sed -n "s/^role_need_$1=//p" "$stage_dir/role-facts.env" | head -1
}

# 形态与卡数校验 + 摘要日志。约定：arch 名形如 <...>-<a>P<b>D[-<n>G]
#   a/b = P/D 实例数（当前只支持 1），n = 两侧卡数之和（总卡数）
# 事实源是 arch 结构（每角色 tp×pp×dp × instances），名字只是人读摘要：
# 带 -<n>G 但与结构算出来的不一致 → 直接失败（避免名字骗人）；
# 没带后缀只 warn（向后兼容现有 arch 名）。
check_topology_and_log() {
  local arch="$deploy_strategy" role gpus need have used inst total=0 label
  local -a parts=()
  local p_inst=1 d_inst=1 name_cards='' rest
  # 取「最后一个」xPyD token（名字里若残留旧的形态 token，以最靠后的为准）
  rest="$arch"
  while [[ "$rest" =~ ([0-9]+)P([0-9]+)D ]]; do
    p_inst="${BASH_REMATCH[1]}"
    d_inst="${BASH_REMATCH[2]}"
    rest="${rest#*"${BASH_REMATCH[0]}"}"
  done
  [[ "$arch" =~ -([0-9]+)G$ ]] && name_cards="${BASH_REMATCH[1]}"
  for role in "${roles[@]}"; do
    need="$(role_need "$role")"
    [[ -n "$need" && "$need" -gt 0 ]] || die "role-facts.env 缺 $role 的卡数（渲染产物异常）" 2
    if [[ "$role" == 'decode' ]]; then gpus="$NATIVE_VLLM_DECODE_GPUS"; else gpus="$NATIVE_VLLM_PREFILL_GPUS"; fi
    have="$(printf '%s' "$gpus" | awk -F, '{print NF}')"
    (( have >= need )) \
      || die "$role 的 GPU 不足：按 arch 并行度（tp×pp×dp）需要 $need 张，实际只给了 $have 张（$gpus）" 2
    (( have == need )) \
      || warn "$role 给了 $have 张、只需 $need 张：多出的卡不参与部署（远端会按需截断）"
    used="$gpus"
    (( have == need )) || used="$(printf '%s' "$gpus" | cut -d, -f1-"$need")"
    inst=1
    [[ "$role" == 'decode' ]] && inst="$d_inst"
    [[ "$mode" == 'pd' && "$role" == 'prefill' ]] && inst="$p_inst"
    total=$(( total + need * inst ))
    parts+=("$role×${inst}: 每实例 ${need} 卡 ← GPU $used")
  done
  if [[ "$mode" == 'pd' ]] && { [[ "$p_inst" != 1 ]] || [[ "$d_inst" != 1 ]]; }; then
    die "arch 名声明了 ${p_inst}P${d_inst}D，但当前脚本只支持每角色单实例（1P1D）：多实例形态尚未实现" 2
  fi
  label="${p_inst}P${d_inst}D"
  [[ "$mode" == 'standalone' ]] && label='standalone'
  log "形态：${label}${name_cards:+-${name_cards}G}（$(printf '%s；' "${parts[@]}")共 ${total} 卡）"
  if [[ -z "$name_cards" ]]; then
    warn "arch 名未带总卡数后缀：建议改名为 ${arch}-${total}G（本形态共 ${total} 卡）"
  elif [[ "$name_cards" != "$total" ]]; then
    die "arch 名的卡数后缀 -${name_cards}G 与按 arch 结构算出的 ${total} 卡不一致：$(printf '%s；' "${parts[@]}")；规范名应为 ${arch%-*G}-${total}G" 2
  fi
}

# ---------------------------------------------------------------------------
# 远端阶段（在目标 GPU 节点执行）
# ---------------------------------------------------------------------------
container_status() {
  nerdctl -n "$containerd_ns" ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null \
    | awk -v name="$1" '$1==name {print $2}'
}

# 在目标机上找一个从 start 开始递增的空闲端口（最多试 200 个）
free_port() {
  local candidate="$1" tries=0
  while (( tries < 200 )); do
    if ! ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${candidate}\$"; then
      printf '%s' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
    tries=$((tries + 1))
  done
  return 1
}

# 目标机通常没有外网：用父阶段随产物推送的 wheel 离线安装 vllm-router。
# ① 优先装进专用 venv（不污染系统 python）；部分节点缺 python3-venv、且无外网装不了 apt 包 →
# ② 回落用系统 pip 装到 /usr/local（--break-system-packages，与 237/164 现有方式一致）。
# 成功则把 router_bin 指向可执行文件（后续启动 router 就用它）。
install_router_from_wheels() {
  local wheels="$work_dir/router-wheels" bin_path
  local -a pip_args=(--no-index --find-links "$wheels" --disable-pip-version-check --quiet)
  [[ -d "$wheels" ]] || return 1
  log "  目标机缺 vllm-router：从随产物推送的 wheel 离线安装（$router_version）"
  if python3 -m venv "$router_venv" >"$work_dir/router-install.log" 2>&1 \
    && "$router_venv/bin/pip" install "${pip_args[@]}" "vllm-router==$router_version" >>"$work_dir/router-install.log" 2>&1 \
    && [[ -x "$router_venv/bin/vllm-router" ]]; then
    router_bin="$router_venv/bin/vllm-router"
    log "  已补装 vllm-router（venv）：$router_bin"
    return 0
  fi
  log "  venv 方式不可用（常见：节点缺 python3-venv），改用系统 pip 安装到 /usr/local"
  if python3 -m pip install "${pip_args[@]}" --break-system-packages \
    "vllm-router==$router_version" >>"$work_dir/router-install.log" 2>&1; then
    bin_path="$(command -v vllm-router 2>/dev/null || true)"
    [[ -n "$bin_path" ]] || bin_path='/usr/local/bin/vllm-router'
    if [[ -x "$bin_path" ]]; then
      router_bin="$bin_path"
      log "  已补装 vllm-router（系统）：$router_bin"
      return 0
    fi
  fi
  warn "离线安装失败，日志尾部："
  tail -8 "$work_dir/router-install.log" >&2
  return 1
}

# GPU 列表自动纠偏（直接改写全局 NATIVE_VLLM_*_GPUS，后续流程都用纠偏后的值）：
#   ① 丢弃越界序号 ② 给多则截断到需求张数
#   ③ pd：decode 与 prefill 重叠的项改派到本机空闲卡（保留 prefill 的原意）
#   ④ 纠偏后仍不够张数则报错（不臆造卡）
fix_gpu_lists() {
  local need_prefill="$1" need_decode="$2" gpu_total="$3"
  local -a pre=() dec=() pre_ok=() dec_ok=()
  local id index changed=0
  IFS=',' read -r -a pre <<<"$NATIVE_VLLM_PREFILL_GPUS"
  IFS=',' read -r -a dec <<<"$NATIVE_VLLM_DECODE_GPUS"
  for id in "${pre[@]}"; do
    [[ -n "$id" ]] || continue
    if (( id < gpu_total )); then pre_ok+=("$id"); else
      changed=1; log "  [GPU 纠偏] prefill 丢弃越界序号 $id（本机 0..$((gpu_total - 1))）"
    fi
  done
  for id in "${dec[@]}"; do
    [[ -n "$id" ]] || continue
    if (( id < gpu_total )); then dec_ok+=("$id"); else
      changed=1; log "  [GPU 纠偏] decode 丢弃越界序号 $id（本机 0..$((gpu_total - 1))）"
    fi
  done
  if (( ${#pre_ok[@]} > need_prefill )); then
    pre_ok=("${pre_ok[@]:0:need_prefill}")
    changed=1
    log "  [GPU 纠偏] prefill 给多了，截断为 ${pre_ok[*]}（需 $need_prefill 张）"
  fi
  if (( need_decode > 0 && ${#dec_ok[@]} > need_decode )); then
    dec_ok=("${dec_ok[@]:0:need_decode}")
    changed=1
    log "  [GPU 纠偏] decode 给多了，截断为 ${dec_ok[*]}（需 $need_decode 张）"
  fi
  if (( need_decode > 0 )); then
    local -A used=()
    for id in "${pre_ok[@]}"; do used["$id"]=1; done
    local -a dec_new=()
    for id in "${dec_ok[@]}"; do
      if [[ -n "${used[$id]:-}" ]]; then dec_new+=('__OVERLAP__'); else dec_new+=("$id"); used["$id"]=1; fi
    done
    id=0
    for index in "${!dec_new[@]}"; do
      [[ "${dec_new[$index]}" == '__OVERLAP__' ]] || continue
      while (( id < gpu_total )) && [[ -n "${used[$id]:-}" ]]; do id=$((id + 1)); done
      (( id < gpu_total )) \
        || die "GPU 不足：decode 与 prefill 有重叠且本机没有空闲卡可改派（需 $need_decode 张）" 1
      dec_new[$index]="$id"
      used["$id"]=1
      changed=1
      log "  [GPU 纠偏] decode 与 prefill 重叠项改派到空闲卡 $id"
      id=$((id + 1))
    done
    dec_ok=("${dec_new[@]}")
  fi
  (( ${#pre_ok[@]} == need_prefill )) \
    || die "prefill 可用 GPU 不足：需 $need_prefill 张，过滤越界后只剩 ${#pre_ok[@]} 张（请显式指定 NATIVE_VLLM_PREFILL_GPUS）" 1
  (( ${#dec_ok[@]} == need_decode )) \
    || die "decode 可用 GPU 不足：需 $need_decode 张，过滤重叠/越界后只剩 ${#dec_ok[@]} 张（请显式指定 NATIVE_VLLM_DECODE_GPUS）" 1
  if (( changed )); then
    NATIVE_VLLM_PREFILL_GPUS="$(IFS=,; printf '%s' "${pre_ok[*]}")"
    if (( need_decode > 0 )); then
      NATIVE_VLLM_DECODE_GPUS="$(IFS=,; printf '%s' "${dec_ok[*]}")"
    fi
    log "  [GPU 纠偏] 生效：prefill=$NATIVE_VLLM_PREFILL_GPUS decode=$NATIVE_VLLM_DECODE_GPUS"
  fi
}

# 端口占用处理：pre=清理前（本部署旧实例占用只提示，等清理回收）；post=清理后（任何占用都算外部）。
# 外部占用时自动纠偏：router / LMCache HTTP 直接改写运行期变量；引擎端口写
# args-override-<role>.sh（entry 脚本在 args 之后追加，argparse 后者覆盖前者）。
# LMCache MP 端口写在 arch 的 kv-transfer-config 里，改了会与引擎配置不一致 → 只报错不自动改。
port_check_and_fix() {
  local phase="$1" port line owner newport role pvar
  local -a ports=() rlist=()
  local -A role_of=() ours=()
  if [[ "$mode" == 'pd' ]]; then rlist=(prefill decode); else rlist=(standalone); fi
  for role in "${rlist[@]}"; do
    pvar="role_port_$role"
    port="${!pvar:-}"
    [[ -n "$port" && "$port" != '0' ]] || continue
    ports+=("$port")
    role_of["$port"]="$role"
  done
  [[ "$mode" == 'pd' ]] && ports+=("$router_port")
  if [[ "$LMCACHE_ENABLE" == '1' && "$mode" == 'pd' ]]; then
    ports+=("$lmcache_mp_port" "$lmcache_http_port")
  fi
  if [[ "$phase" == 'pre' ]]; then
    for port in "${!ours_port[@]}"; do ours["$port"]=1; done
  fi
  for port in "${ports[@]}"; do
    line="$(ss -ltnpH 2>/dev/null | awk -v p=":$port" '$4 ~ p"$"' | head -1)"
    [[ -n "$line" ]] || continue
    if [[ -n "${ours[$port]:-}" ]]; then
      log "  端口 $port 被本部署旧实例占用（随后的清理步骤会回收）"
      continue
    fi
    if [[ "$mode" == 'pd' && "$port" == "$router_port" ]]; then
      newport="$(free_port $((port + 1)) || true)"
      [[ -n "$newport" ]] || die "router 端口 $port 被外部占用，且其后 200 个端口都不空闲" 1
      log "  [端口纠偏] router $port → $newport（$port 被外部占用：$(printf '%s' "$line" | cut -c1-70)）"
      router_port="$newport"
    elif [[ "$LMCACHE_ENABLE" == '1' && "$port" == "$lmcache_mp_port" ]]; then
      die "LMCache MP 端口 $port 被外部占用：该端口写在 arch 的 kv-transfer-config 里，自动改会与引擎配置不一致；请释放 $port 或在 arch 策略里改端口" 1
    elif [[ "$LMCACHE_ENABLE" == '1' && "$port" == "$lmcache_http_port" ]]; then
      newport="$(free_port $((port + 1)) || true)"
      [[ -n "$newport" ]] || die "LMCache HTTP 端口 $port 被外部占用，且其后 200 个端口都不空闲" 1
      log "  [端口纠偏] LMCache HTTP $port → $newport（$port 被外部占用）"
      lmcache_http_port="$newport"
    else
      owner="${role_of[$port]:-}"
      [[ -n "$owner" ]] || die "端口 $port 被外部占用，但无法定位它属于哪个角色（渲染产物异常）" 1
      newport="$(free_port $((port + 1)) || true)"
      [[ -n "$newport" ]] || die "$owner 引擎端口 $port 被外部占用，且其后 200 个端口都不空闲" 1
      printf 'vllm_native_args+=(--port %s)\n' "$newport" >>"$work_dir/args-override-$owner.sh"
      printf -v "role_port_$owner" '%s' "$newport"
      role_of["$newport"]="$owner"
      log "  [端口纠偏] $owner 引擎 $port → $newport（$port 被外部占用：$(printf '%s' "$line" | cut -c1-70)）"
    fi
  done
}

# 部署前环境预检（在目标节点执行）：把"会让部署静默失败/挂住"的前置条件先拦掉。
# 覆盖：运行时与本地制品、RDMA 设备、GPU 数量与余量、端口占用、内存与磁盘余量、环境摘要。
# 失败即 die（exit 1）；确需绕过时用隐藏开关 NATIVE_VLLM_SKIP_PRECHECK=1。
remote_precheck() {
  local role entry needed gpus have gpu_total id st port line
  local primary_role='prefill'
  local all_gpus="$NATIVE_VLLM_PREFILL_GPUS"
  local -A role_port_map=()
  [[ "$mode" == 'standalone' ]] && primary_role='standalone'
  [[ "$mode" == 'pd' ]] && all_gpus="$all_gpus,$NATIVE_VLLM_DECODE_GPUS"
  log "环境预检：目标机 $target_ip（工作目录 $work_dir）"

  # ---- 1) 运行时与本地制品 ----
  [[ -x "$runtime_bin" ]] \
    || die "目标机缺少 nvidia 容器运行时：$runtime_bin（nerdctl --runtime 依赖它）" 1
  command -v nvidia-smi >/dev/null 2>&1 || die "目标机缺少 nvidia-smi（无法核验 GPU）" 1
  command -v python3 >/dev/null 2>&1 \
    || die "目标机缺少 python3（校验阶段构造请求与解析 LMCache 状态需要）" 1
  [[ -f "$work_dir/role-facts.env" ]] \
    || die "缺少渲染产物 role-facts.env（父阶段未生成：请更新 step 脚本后重跑，或清理旧产物目录）" 1
  # shellcheck disable=SC1090
  . "$work_dir/role-facts.env"
  nerdctl -n "$containerd_ns" image inspect "$image_ref" >/dev/null 2>&1 \
    || die "目标机本地没有镜像 $image_ref：请先跑「拉取镜像」步骤，或先在目标机 nerdctl pull" 1
  [[ -f "$MODEL_DIR/config.json" ]] || die "权重目录缺少 config.json：$MODEL_DIR" 1
  [[ -f "$MODEL_DIR/tokenizer.json" || -f "$MODEL_DIR/tokenizer.model" ]] \
    || warn "权重目录未见 tokenizer.json / tokenizer.model（$MODEL_DIR），若镜像自带词表可忽略"

  # ---- 1b) vllm-router（pd 模式的外层 P/D 前端）：存在、能跑、flags 兼容 ----
  if [[ "$mode" == 'pd' ]]; then
    local router_path router_help missing='' flag
    router_path="$(command -v "$router_bin" 2>/dev/null || true)"
    if [[ -z "$router_path" && -x /usr/local/bin/vllm-router ]]; then
      router_path='/usr/local/bin/vllm-router'
      router_bin="$router_path"
    fi
    if [[ -z "$router_path" && -x "$router_venv/bin/vllm-router" ]]; then
      router_path="$router_venv/bin/vllm-router"
      router_bin="$router_path"
    fi
    if [[ -z "$router_path" ]]; then
      # 离线补装；函数会把 router_bin 指向装好的可执行文件（venv 或系统 /usr/local/bin）
      install_router_from_wheels || true
      if [[ -n "$router_bin" && -x "$router_bin" ]]; then
        router_path="$router_bin"
      else
        router_path="$(command -v vllm-router 2>/dev/null || true)"
      fi
    fi
    [[ -n "$router_path" ]] \
      || die "pd 模式需要 vllm-router：$router_bin 不在 PATH 中，离线补装也不可用（产物里缺 router-wheels/）；请装官方 vllm-project/router，或用隐藏参数 NATIVE_VLLM_ROUTER_BIN 指绝对路径" 1
    if [[ -n "$router_path" ]]; then
      router_help="$(timeout 20 "$router_path" --help 2>&1 || true)"
      [[ -n "$router_help" ]] \
        || die "vllm-router 无法执行：$router_path（--help 无输出，可能装包不完整或缺依赖）" 1
      for flag in --policy --vllm-pd-disaggregation --kv-connector --prefill --decode --host --port --intra-node-data-parallel-size; do
        [[ "$router_help" == *"$flag"* ]] || missing="$missing $flag"
      done
      [[ -z "$missing" ]] \
        || die "vllm-router 版本不兼容：$router_path 不支持$missing（本路线需要官方 vllm-project/router；可用 NATIVE_VLLM_ROUTER_BIN 指定正确版本）" 1
      log "  router：$router_path（--help 与 8 个所需 flags 校验通过）"
    fi
  fi

  # ---- 2) RDMA：pd 模式的 Mooncake KV 传输依赖 RoCE/iWARP，缺失会挂住而不是报错 ----
  if [[ "$mode" == 'pd' ]]; then
    [[ -d /dev/infiniband ]] \
      || die "pd 模式需要 RDMA 设备 /dev/infiniband（Mooncake KV 传输依赖 RoCE/iWARP）" 1
  fi

  # ---- 3) GPU：按渲染产物核对数量（tp×pp×dp），并自动纠偏越界/给多/重叠 ----
  local -a role_list=()
  if [[ "$mode" == 'pd' ]]; then role_list=(prefill decode); else role_list=("$primary_role"); fi
  local need_prefill='' need_decode='0' nv pv
  for role in "${role_list[@]}"; do
    nv="role_need_$role"
    pv="role_port_$role"
    needed="${!nv:-}"
    port="${!pv:-}"
    [[ -n "$needed" && "$needed" -gt 0 ]] \
      || die "渲染产物里 $role 缺少并行度信息（role-facts.env 不完整）" 1
    if [[ "$role" == 'decode' ]]; then need_decode="$needed"; else need_prefill="$needed"; fi
    [[ "$port" == '0' || -z "$port" ]] || role_port_map["$role"]="$port"
  done
  gpu_total="$(nvidia-smi --query-gpu=index --format=csv,noheader 2>/dev/null | wc -l)"
  (( gpu_total > 0 )) || die "目标机 nvidia-smi 看不到 GPU" 1
  fix_gpu_lists "$need_prefill" "$need_decode" "$gpu_total"
  all_gpus="$NATIVE_VLLM_PREFILL_GPUS"
  [[ "$mode" == 'pd' ]] && all_gpus="$all_gpus,$NATIVE_VLLM_DECODE_GPUS"
  # 本部署旧实例状态（一次取全）：决定"端口/显存/内存被占"是该拦还是该等信息
  local ps_dump old_running=0 old_lmcache_up=0 name
  ps_dump="$(nerdctl -n "$containerd_ns" ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null || true)"
  for name in "${container_names[@]}"; do
    [[ "$ps_dump" == *"$name Up"* ]] && old_running=1
  done
  [[ "$ps_dump" == *"${container_prefix}-lmcache Up"* ]] && old_lmcache_up=1
  [[ "$mode" == 'pd' ]] && pgrep -f 'vllm::router' >/dev/null 2>&1 && old_running=1

  local vram_low
  vram_low="$(nvidia-smi --query-gpu=index,memory.free --format=csv,noheader -i "$all_gpus" 2>/dev/null \
    | awk -F', *' '$2+0 < 250000 {printf "GPU%s(%dMiB) ", $1, $2+0}')"
  vram_low="${vram_low% }"
  if [[ -n "$vram_low" ]]; then
    if (( old_running )); then
      log "  空闲显存偏低（$vram_low），但本部署旧实例仍在，清理后会释放"
    else
      warn "空闲显存偏低：$vram_low（低于 250000 MiB；卡可能被其它服务占用，高显存利用率下会 OOM）"
    fi
  fi

  # ---- 4) 端口占用：先记下本部署旧实例占用的端口，再交给 port_check_and_fix 处理 ----
  ours_port=()
  [[ "$ps_dump" == *"${container_prefix}-$primary_role Up"* ]] \
    && [[ -n "${role_port_map[$primary_role]:-}" ]] \
    && ours_port["${role_port_map[$primary_role]}"]=1
  [[ "$mode" == 'pd' && "$ps_dump" == *"${container_prefix}-decode Up"* ]] \
    && [[ -n "${role_port_map[decode]:-}" ]] \
    && ours_port["${role_port_map[decode]}"]=1
  if [[ "$LMCACHE_ENABLE" == '1' && "$old_lmcache_up" == '1' ]]; then
    ours_port["$lmcache_mp_port"]=1
    ours_port["$lmcache_http_port"]=1
  fi
  [[ "$mode" == 'pd' ]] && pgrep -f 'vllm::router' >/dev/null 2>&1 && ours_port["$router_port"]=1
  port_check_and_fix pre

  # ---- 5) 内存与磁盘余量 ----
  if [[ "$LMCACHE_ENABLE" == '1' && "$mode" == 'pd' ]]; then
    local avail need
    avail="$(awk '/^MemAvailable:/ {printf "%d", $2 / 1048576}' /proc/meminfo)"
    need=$(( LMCACHE_L1_SIZE_GB * 11 / 10 ))
    if (( avail >= need )); then
      log "  内存余量：可用 ${avail}G ≥ 需求 ${need}G（L1 预钉）"
    elif (( old_lmcache_up )); then
      log "  内存：可用 ${avail}G < 需求 ${need}G，但本部署旧 LMCache 仍在（占用≈L1），清理释放后应满足，跳过硬检查"
    else
      die "内存不足：LMCache L1=${LMCACHE_L1_SIZE_GB}G 需要宿主可用内存 ≥${need}G，当前仅 ${avail}G（调小 LMCACHE_L1_SIZE_GB 或换节点）" 1
    fi
  fi
  local dfree
  dfree="$(df -Pk "$work_dir" 2>/dev/null | awk 'NR==2 {printf "%d", $4 / 1048576}')"
  if [[ -n "$dfree" ]]; then
    (( dfree >= 5 )) || die "工作目录磁盘余量不足：$work_dir 仅剩 ${dfree}G" 1
    if (( dfree >= 20 )); then log "  磁盘余量：${dfree}G"; else warn "工作目录磁盘余量偏低：${dfree}G（开 profiler 时单个 trace 可达上百 GB）"; fi
  fi

  # ---- 6) 环境摘要（出问题时省一轮排查） ----
  # 注意：不能用 `hostname -I | awk '{print $1}'`——装了 docker 的节点会优先返回 docker0（如 172.17.0.1）
  local host_ip="${target_ip:-}"
  if [[ -z "$host_ip" ]]; then
    host_ip="$(ip -4 route get 1.1.1.1 2>/dev/null \
      | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}')"
  fi
  log "  目标机 $(hostname) / ${host_ip:-unknown}；内核 $(uname -r)"
  log "  运行时 $runtime_bin；containerd 命名空间 $containerd_ns；驱动 $(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)；GPU 数 $gpu_total"
  log "  镜像 $image_ref"
  log "环境预检通过 ✓"
  return 0
}

remote_clean() {
  local name pid_file pids
  for name in "${container_names[@]}"; do
    if [[ -n "$(container_status "$name")" ]]; then
      log "清理旧容器 $name"
      nerdctl -n "$containerd_ns" rm -f "$name" >/dev/null 2>&1
    fi
  done
  pids="$(pgrep -f 'vllm::router' 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    log "停止旧 router 进程"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}

# 上一实例退出可能滞后，显存没释放会导致新实例启动即崩，这里先等卡空闲
remote_wait_gpu_free() {
  local gpus="$1" waited=0 min_free=''
  while (( waited < 60 )); do
    min_free="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader -i "$gpus" 2>/dev/null \
      | tr -d ' MiB' | sort -n | head -1)"
    if [[ -n "$min_free" && "$min_free" -gt 250000 ]]; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  warn "GPU $gpus 空闲显存仅 ${min_free:-未知}，仍继续尝试启动"
  return 0
}

remote_run_container() {
  local name="$1" gpus="$2" entry="$3"
  nerdctl -n "$containerd_ns" run -d --name "$name" --network host \
    --runtime "$runtime_bin" --privileged --ipc=host \
    -v "$MODEL_DIR:$MODEL_DIR" -v "$work_dir:$work_dir" \
    -e "NVIDIA_VISIBLE_DEVICES=$gpus" -e "CUDA_VISIBLE_DEVICES=$gpus" \
    --entrypoint /bin/bash "$image_ref" -c "bash $work_dir/$entry"
}

# 并行等待多个实例就绪：任一容器退出立即失败，全部 health=200 才返回 0
remote_wait_instances() {
  local -a names=("${container_prefix}-$primary_role")
  local -a ports=("$primary_port")
  local -a ready=(0)
  if [[ "$mode" == 'pd' ]]; then
    names+=("${container_prefix}-decode")
    ports+=("$decode_port")
    ready+=(0)
  fi
  local start=$SECONDS deadline=$((SECONDS + NATIVE_VLLM_READY_TIMEOUT_SECONDS))
  local index code status pending
  while (( SECONDS < deadline )); do
    pending=0
    for index in "${!names[@]}"; do
      (( ready[index] )) && continue
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${ports[index]}/health" 2>/dev/null)"
      if [[ "$code" == '200' ]]; then
        ready[index]=1
        log "${names[index]} 就绪（端口 ${ports[index]}，等待 $((SECONDS - start))s）"
        continue
      fi
      status="$(container_status "${names[index]}")"
      if [[ "$status" == Exited* ]]; then
        warn "${names[index]} 启动失败（$status），日志尾部："
        nerdctl -n "$containerd_ns" logs --tail 40 "${names[index]}" 2>&1 | tail -40 >&2
        return 1
      fi
      pending=1
    done
    (( pending == 0 )) && return 0
    sleep 5
  done
  warn "等待 ${NATIVE_VLLM_READY_TIMEOUT_SECONDS}s 后仍未全部就绪"
  for index in "${!names[@]}"; do
    if (( ready[index] == 0 )); then
      warn "${names[index]} 未就绪，日志尾部："
      nerdctl -n "$containerd_ns" logs --tail 20 "${names[index]}" 2>&1 | tail -20 >&2
    fi
  done
  return 1
}

remote_start_lmcache() {
  local name="${container_prefix}-lmcache" waited=0
  if [[ -n "$LMCACHE_OTLP_ENDPOINT" ]]; then
    log "启动 LMCache MP server（L1=${LMCACHE_L1_SIZE_GB}G，初始 ${lmcache_l1_init_size_gb}G，端口 ${lmcache_mp_port}/${lmcache_http_port}，驱逐水位 ${lmcache_eviction_watermark}/比例 ${lmcache_eviction_ratio}，观测=开启：--otlp-endpoint $LMCACHE_OTLP_ENDPOINT --enable-tracing）"
  else
    log "启动 LMCache MP server（L1=${LMCACHE_L1_SIZE_GB}G，初始 ${lmcache_l1_init_size_gb}G，端口 ${lmcache_mp_port}/${lmcache_http_port}，驱逐水位 ${lmcache_eviction_watermark}/比例 ${lmcache_eviction_ratio}，观测=关闭）"
  fi
  nerdctl -n "$containerd_ns" run -d --name "$name" --network host \
    --runtime "$runtime_bin" --ipc=host \
    -e "NVIDIA_VISIBLE_DEVICES=$NATIVE_VLLM_PREFILL_GPUS" \
    -e "CUDA_VISIBLE_DEVICES=$NATIVE_VLLM_PREFILL_GPUS" \
    --entrypoint /bin/bash "$image_ref" \
    -c "exec lmcache server --host 0.0.0.0 --port $lmcache_mp_port --http-port $lmcache_http_port \
        --l1-size-gb $LMCACHE_L1_SIZE_GB --l1-init-size-gb $lmcache_l1_init_size_gb \
        --eviction-policy $lmcache_eviction_policy \
        --eviction-trigger-watermark $lmcache_eviction_watermark --eviction-ratio $lmcache_eviction_ratio \
        --chunk-size $lmcache_chunk_size --separate-object-groups --instance-id prefill \
        --max-cpu-workers "$lmcache_max_cpu_workers" \
        ${LMCACHE_OTLP_ENDPOINT:+--otlp-endpoint $LMCACHE_OTLP_ENDPOINT --enable-tracing}" \
    >/dev/null || return 1
  while (( waited < lmcache_ready_timeout )); do
    if curl -s --max-time 3 "http://127.0.0.1:$lmcache_http_port/healthcheck" | grep -q healthy; then
      log "LMCache server 就绪（等待 ${waited}s）"
      return 0
    fi
    if (( waited > 0 && waited % 30 == 0 )); then
      log "LMCache 仍在初始化…已等待 ${waited}s（初始 L1 ${lmcache_l1_init_size_gb}G 需预钉内存，上限 ${lmcache_ready_timeout}s）"
    fi
    sleep 3
    waited=$((waited + 3))
  done
  warn "LMCache 等待超过 ${lmcache_ready_timeout}s 仍未就绪，日志尾部："
  nerdctl -n "$containerd_ns" logs --tail 30 "$name" 2>&1 | tail -30 >&2
  return 1
}

# 设备 → 启动时使用的转发端口（脚本只负责在本机监听该端口并转发到 router）。
# 维护：新节点上线时在这里加一行「<内网IP> <端口>」。不在表中的节点自动跳过转发。
# 2026-10-17 用户提供的 gy1（含 gy1-2 47.x）+ hd2 首批 5 台。
exposed_port_for_ip() {
  local ip="$1"
  [[ -n "$ip" ]] || return 0
  sed -n "s/^${ip//./\\.} \\([0-9][0-9]*\\)$/\\1/p" <<'MAP'
192.168.0.156 8100
192.168.0.78 8101
192.168.0.243 8102
192.168.0.68 8103
192.168.0.128 8104
192.168.0.218 8105
192.168.0.102 8106
192.168.0.172 8107
192.168.47.35 8108
192.168.47.181 8109
192.168.0.126 8116
192.168.0.237 8117
192.168.47.137 8131
192.168.47.6 8132
192.168.47.200 8133
192.168.47.92 8135
192.168.47.148 8136
192.168.47.172 8137
192.168.47.236 8138
192.168.47.240 8139
192.168.47.115 8140
192.168.47.3 8141
192.168.47.71 8142
192.168.47.44 8143
192.168.47.214 8144
192.168.47.86 8145
# hd2（192.168.31.x）2026-10-17 首批 5 台
192.168.31.140 8100
192.168.31.120 8101
192.168.31.113 8102
192.168.31.164 8103
192.168.31.7 8104
MAP
}

# 自动端口转发：按设备IP查表得到对外端口 → socat 把该端口转发到本机 router。
# 表里没有的节点（如 hd2）自动跳过；重复部署会重建转发（幂等）。
remote_setup_port_forward() {
  local ip="$1" upstream_port="$2" port socat_bin code
  port="$(exposed_port_for_ip "$ip")"
  if [[ -z "$port" ]]; then
    log "端口转发：$ip 不在转发映射表中，跳过"
    return 0
  fi
  socat_bin="$(command -v socat 2>/dev/null || true)"
  [[ -n "$socat_bin" ]] || { [[ -x /usr/local/bin/socat ]] && socat_bin=/usr/local/bin/socat; }
  if [[ -z "$socat_bin" && -f "$work_dir/socat" ]]; then
    install -m 755 "$work_dir/socat" /usr/local/bin/socat && socat_bin=/usr/local/bin/socat
  fi
  if [[ -z "$socat_bin" ]]; then
    warn "端口转发跳过：目标机没有 socat 且产物里也没带"
    return 0
  fi
  pkill -f "socat TCP-LISTEN:${port}," 2>/dev/null || true
  sleep 1
  setsid nohup "$socat_bin" "TCP-LISTEN:${port},bind=0.0.0.0,reuseaddr,fork" "TCP:127.0.0.1:${upstream_port}" \
    >"$work_dir/socat-${port}.log" 2>&1 </dev/null &
  sleep 2
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${port}/v1/models" 2>/dev/null)"
  if [[ "$code" == '200' ]]; then
    log "端口转发就绪：127.0.0.1:${port} → 127.0.0.1:${upstream_port}（对外端口 ${port}）"
  else
    warn "端口转发校验未通过（http://127.0.0.1:${port}/v1/models → ${code:-无响应}）"
  fi
}

remote_start_router() {
  local prefill_port="$1" decode_port="$2" waited=0 code
  # ⚠️ 注释不能插在 nohup 的续行（\）中间——注释会终止续行，导致后面的参数被当成独立命令。
  # 引擎与 router 同机，必须用回环地址：target_ip 可能是外网映射入口（如 hd2 的 EIP），
  # 节点访问自己的 EIP 一般没有 hairpin，会让 router 卡在探测引擎上（表现为不监听对外端口）。
  log "启动 vllm-router（连接器 $router_kv_connector，对外端口 $router_port）"
  nohup "$router_bin" \
    --policy "$router_policy" \
    --vllm-pd-disaggregation \
    --kv-connector "$router_kv_connector" \
    --prefill "http://127.0.0.1:$prefill_port" \
    --decode "http://127.0.0.1:$decode_port" \
    --host 0.0.0.0 --port "$router_port" \
    --intra-node-data-parallel-size 1 \
    >"$work_dir/router.log" 2>&1 &
  while (( waited < 60 )); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
      "http://127.0.0.1:$router_port/v1/models" 2>/dev/null)"
    if [[ "$code" == '200' ]]; then
      log "router 就绪（等待 ${waited}s）"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  warn "router 未就绪，日志尾部："
  tail -20 "$work_dir/router.log" >&2
  return 1
}

# P/D 真实性：经 router 发一次请求，看 decode 侧 external_kv_transfer 是否增长
remote_verify_pd() {
  local decode_port="$1" before after payload
  metric_sum() {
    curl -s --max-time 8 "http://127.0.0.1:$decode_port/metrics" 2>/dev/null \
      | grep 'prompt_tokens_by_source_total' | grep 'external_kv_transfer' \
      | awk '{sum+=$2} END {print sum+0}'
  }
  lmcache_objects() {
    curl -s --max-time 5 "http://127.0.0.1:$lmcache_http_port/status" 2>/dev/null \
      | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["storage_manager"]["l1_manager"]["total_object_count"])' 2>/dev/null || echo 0
  }
  local lmcache_before lmcache_after
  before="$(metric_sum)"
  if [[ "$LMCACHE_ENABLE" == '1' ]]; then
    lmcache_before="$(lmcache_objects)"
  fi
  local verify_model="${model_name:-$MODEL_DIR}"
  payload="$(python3 - "$verify_model" <<'PY'
import json
import sys

prompt = "请阅读以下内容后回答问题：" + ("这是一段用于触发 P/D KV 传输的填充文本。" * 20) + "问题：1+1 等于几？"
print(json.dumps({
    "model": sys.argv[1],
    "messages": [{"role": "user", "content": prompt}],
    "max_tokens": 8,
    "temperature": 0,
}))
PY
)"
  curl -s --max-time 120 -o "$work_dir/verify.json" \
    -X POST "http://127.0.0.1:$router_port/v1/chat/completions" \
    -H 'Content-Type: application/json' -d "$payload" >/dev/null 2>&1
  sleep 2
  after="$(metric_sum)"
  if [[ "$LMCACHE_ENABLE" == '1' ]]; then
    lmcache_after="$(lmcache_objects)"
    log "LMCache L1 对象数：${lmcache_before} -> ${lmcache_after}"
  fi
  if (( after > before )); then
    log "P/D 真实性校验通过：decode external_kv_transfer ${before} -> ${after}"
    return 0
  fi
  warn "P/D 真实性校验失败：decode external_kv_transfer 未增长（${before} -> ${after}）"
  return 1
}

remote_main() {
  stage_dir="$work_dir"
  image_ref="$NATIVE_VLLM_IMAGE"
  service_name="$NATIVE_VLLM_SERVICE_NAME"
  mode="${platform_native_mode:-pd}"
  target_ip="${platform_native_target_ip:-}"
  model_name="${platform_model_name:-}"
  arch_source="${platform_native_arch_source:-remote}"
  log "远端阶段开始：目标机 $target_ip，工作目录 $work_dir"
  [[ -n "$image_ref" ]] || die "远端缺少镜像参数" 2
  [[ -f "$work_dir/config-prefill.yaml" || -f "$work_dir/config-standalone.yaml" ]] \
    || die "远端缺少渲染产物（$work_dir）" 2
  [[ -f "$work_dir/role-facts.env" ]] \
    || die "远端缺少 role-facts.env（父阶段未生成：请更新 step 脚本后重跑）" 2
  # shellcheck disable=SC1090
  . "$work_dir/role-facts.env"
  command -v nerdctl >/dev/null 2>&1 || {
    # 目标机缺 nerdctl：若产物里带了执行机的静态二进制就就地补装（gy1-2/hd2 多台节点如此）
    if [[ -x "$work_dir/nerdctl" ]]; then
      if install -m 755 "$work_dir/nerdctl" /usr/local/bin/nerdctl; then
        log "  已补装 nerdctl：/usr/local/bin/nerdctl（$(/usr/local/bin/nerdctl --version 2>/dev/null | head -1)）"
      else
        warn "nerdctl 补装失败（$work_dir/nerdctl → /usr/local/bin/nerdctl）"
      fi
    fi
    command -v nerdctl >/dev/null 2>&1 \
      || die "目标机缺少 nerdctl、且无随产物推送的二进制可补装（$work_dir/nerdctl）：若目标其实是入口/跳板机而非 GPU 节点，hd2 请填 外网入口:映射端口（如 115.33.98.101:2224）" 2
  }
  [[ -d "$MODEL_DIR" ]] || die "目标机权重目录不存在：$MODEL_DIR" 2
  # router 的存在性/补装/flag 兼容性统一由 remote_precheck 负责（缺 router 时会用父阶段推送的 wheel 离线补装），
  # 这里不再提前判定——否则会在补装之前先 die。
  if [[ "$skip_precheck" == '1' ]]; then
    warn "NATIVE_VLLM_SKIP_PRECHECK=1：跳过部署前环境预检"
  else
    remote_precheck || return 1
  fi

  [[ "$clean_old" == '1' ]] && remote_clean
  # 清理后再核一遍端口：此时旧实例已退，任何占用都是外部的 → 该纠偏就纠偏、该报错就报错
  port_check_and_fix post

  local primary_role='prefill' primary_port='' decode_port='' health_rc=0
  [[ "$mode" == 'standalone' ]] && primary_role='standalone'

  if [[ "$LMCACHE_ENABLE" == '1' && "$mode" == 'pd' ]]; then
    remote_wait_gpu_free "$NATIVE_VLLM_PREFILL_GPUS"
    remote_start_lmcache || return 1
  elif [[ "$LMCACHE_ENABLE" == '1' ]]; then
    warn "standalone 形态下 LMCACHE_ENABLE=1 不生效（LMCache 只接 prefill 角色）"
  fi

  # 等卡空闲（一次性判断，避免两个角色串行等待），然后两侧并行启动、并行等待
  remote_wait_gpu_free "$NATIVE_VLLM_PREFILL_GPUS"
  [[ "$mode" == 'pd' ]] && remote_wait_gpu_free "$NATIVE_VLLM_DECODE_GPUS"

  log "启动 $primary_role 容器（GPU $NATIVE_VLLM_PREFILL_GPUS）"
  remote_run_container "${container_prefix}-$primary_role" "$NATIVE_VLLM_PREFILL_GPUS" \
    "entry-$primary_role.sh" >/dev/null || return 1
  local pvar pport
  pvar="role_port_$primary_role"
  primary_port="${!pvar:-}"
  [[ -n "$primary_port" && "$primary_port" != '0' ]] \
    || die "渲染产物里 $primary_role 缺少端口（role-facts.env）" 1

  if [[ "$mode" == 'pd' ]]; then
    log "启动 decode 容器（GPU $NATIVE_VLLM_DECODE_GPUS）"
    remote_run_container "${container_prefix}-decode" "$NATIVE_VLLM_DECODE_GPUS" \
      "entry-decode.sh" >/dev/null || return 1
    pvar='role_port_decode'
    decode_port="${!pvar:-}"
    [[ -n "$decode_port" && "$decode_port" != '0' ]] \
      || die "渲染产物里 decode 缺少端口（role-facts.env）" 1
  fi

  log "两侧容器已并行启动，等待就绪（上限 ${NATIVE_VLLM_READY_TIMEOUT_SECONDS}s）"
  remote_wait_instances || health_rc=1
  if (( health_rc != 0 )); then
    warn "实例未全部就绪；容器保留供排障：nerdctl -n $containerd_ns logs <容器名>"
    return 1
  fi

  if [[ "$mode" == 'pd' ]]; then
    remote_start_router "$primary_port" "$decode_port" || return 1
    # 自动端口转发：对外暴露端口 → router（表里没有的节点会自动跳过）
    remote_setup_port_forward "$service_ip" "$router_port"
    if [[ "$verify_after" == '1' ]]; then
      remote_verify_pd "$decode_port" || return 1
    fi
  fi

  # 契约里的地址用目标机【小网 IP】：平台传的 target 可能是外网映射入口（如 hd2 的 EIP），
  # 小网内的调用方访问不到。取法：默认路由的源地址，兵底用 hostname -I 过滤掉回环/docker/link-local。
  local service_ip=''
  service_ip="$(ip -4 route get 1.1.1.1 2>/dev/null \
    | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}')"
  if [[ -z "$service_ip" ]]; then
    service_ip="$(hostname -I 2>/dev/null | tr ' ' '\n' \
      | grep -vE '^(127\.|172\.(1[7-9]|2[0-9]|3[01])\.|169\.254\.)' | head -1)"
  fi
  [[ -n "$service_ip" ]] || service_ip="$target_ip"
  log "契约地址使用目标机小网 IP：$service_ip（平台 target=$target_ip）"

  if [[ "$mode" == 'pd' ]]; then
    printf 'NATIVE_VLLM_API_BASE=http://%s:%s/v1\n' "$service_ip" "$router_port"
    printf 'SERVICE_API=http://%s:%s\n' "$service_ip" "$router_port"
    printf 'NATIVE_VLLM_PREFILL_PORT=%s\n' "$primary_port"
    printf 'NATIVE_VLLM_DECODE_PORT=%s\n' "$decode_port"
  else
    printf 'NATIVE_VLLM_API_BASE=http://%s:%s/v1\n' "$service_ip" "$primary_port"
    printf 'SERVICE_API=http://%s:%s\n' "$service_ip" "$primary_port"
    printf 'NATIVE_VLLM_STANDALONE_PORT=%s\n' "$primary_port"
  fi
  printf 'NATIVE_VLLM_DEPLOY=ok\n'
  printf 'NATIVE_VLLM_MODE=%s\n' "$mode"
  printf 'NATIVE_VLLM_ARCH=%s\n' "$deploy_strategy"
  printf 'NATIVE_VLLM_ARCH_SOURCE=%s\n' "$arch_source"
  printf 'NATIVE_VLLM_TARGET_IP=%s\n' "$service_ip"
  printf 'NATIVE_VLLM_IMAGE=%s\n' "$image_ref"
  printf 'NATIVE_VLLM_LMCACHE=%s\n' "$LMCACHE_ENABLE"
  printf 'NATIVE_VLLM_ROUTER_PORT=%s\n' "$router_port"
  printf 'NATIVE_VLLM_RUN_DIR=%s\n' "$work_dir"
  printf 'SERVICE_NAME=%s\n' "$service_name"
  printf 'MODEL_PATH=%s\n' "$MODEL_DIR"
  printf 'MODEL_NAME=%s\n' "$model_name"
  printf 'MODEL=%s\n' "$model_name"
  printf 'MODEL_ENDPOINT=%s\n' "$model_name"
}

# ---------------------------------------------------------------------------
# 父阶段（在流水线执行机运行）
# ---------------------------------------------------------------------------
parent_main() {
  need_cmd python3 "渲染策略与解析目标节点需要"
  need_cmd curl "在线获取策略文件需要"
  need_cmd ssh "推送到目标机需要"
  if [[ -z "$arch_source_dir" && "$arch_fetch" != 'online' ]]; then
    need_cmd git "在线获取失败时回落 git 需要"
  fi
  [[ -n "$MODEL_DIR" ]] || die "MODEL_DIR（权重目录）必填" 2
  [[ -n "$deploy_strategy" ]] || die "DEPLOY_STRATEGY（部署策略名）必填，通常由平台注入" 2
  python3 -c 'import yaml' 2>/dev/null || die "执行机 python3 缺少 pyyaml" 2

  image_ref="$(resolve_image)" || die "缺少镜像：请设置 NATIVE_VLLM_IMAGE 或由平台注入镜像名与标签" 2
  resolve_target
  [[ -n "$target_pass" ]] && need_cmd sshpass "目标机使用密码认证时需要" 2

  stage_dir="$(mktemp -d /tmp/vllm-native-arch.XXXXXX)" || die "创建临时目录失败" 2
  fetch_arch_file "$stage_dir" || exit $?
  log "策略来源：$arch_source；策略路径 $arch_dir/model_arch.yaml"

  local mode_probe mode_rc
  mode_probe="$(python3 - "$stage_dir/model_arch.yaml" "$deploy_strategy" <<'PY'
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as handle:
    registry = yaml.safe_load(handle) or {}
strategy = registry.get(sys.argv[2])
if not isinstance(strategy, dict):
    known = ", ".join(sorted(registry)) if isinstance(registry, dict) else ""
    print(f"策略 {sys.argv[2]!r} 不在注册表中；已登记：{known}")
    sys.exit(2)
if isinstance(strategy.get("decode"), dict):
    print("pd")
elif isinstance(strategy.get("standalone"), dict):
    print("standalone")
else:
    print(f"策略 {sys.argv[2]!r} 既无 decode 也无 standalone 角色")
    sys.exit(2)
PY
)"
  mode_rc=$?
  (( mode_rc == 0 )) || die "$mode_probe" 2
  mode="$mode_probe"
  if [[ "$mode" == 'pd' ]]; then
    roles=(prefill decode)
  else
    roles=(standalone)
  fi
  log "部署形态：$mode（角色：${roles[*]}）；镜像 $image_ref；目标机 ${target_ip}${target_port:+:$target_port}"
  [[ "$LMCACHE_ENABLE" == '1' ]] && log "LMCache：开启（L1=${LMCACHE_L1_SIZE_GB}G，端口 ${lmcache_mp_port}/${lmcache_http_port}）"
  [[ "$NATIVE_VLLM_PROFILER" == '1' ]] && log "Profiler：开启（torch，落盘 $native_run_dir/profiles；POST /start_profile 起、/stop_profile 停，delay 5 步、最多 50 步）"
  log "autotune：decode=${NATIVE_VLLM_AUTOTUNE}（仅 decode 生效），prefill/standalone=强制关闭（PP+autotune 会跨 rank 死锁）"

  local role
  for role in "${roles[@]}"; do
    render_role "$role"
  done
  write_role_facts
  check_topology_and_log

  # 策略 env 之外，本路线固定追加的运行期环境变量
  local item xccl_list xccl_item xccl_whl
  ensure_xccl_wheel
  for role in "${roles[@]}"; do
    {
      printf 'export VLLM_ENGINE_READY_TIMEOUT_S=%s\n' "$NATIVE_VLLM_ENGINE_READY_TIMEOUT_SECONDS"
      printf 'export VLLM_USE_RUST_FRONTEND=%s\n' "$use_rust_frontend"
      # DEV 模式：开启后 vLLM 才暴露 /reset_prefix_cache、/sleep、/wake_up 等管理端点（清 HBM/KV 缓存）
      [[ "$NATIVE_VLLM_DEV_MODE" == '1' ]] && printf 'export VLLM_SERVER_DEV_MODE=1\n'
      # XCCL 插件（xccl-vllm-turbo）：按角色传入逗号分隔的 KEY=VALUE；为空则该侧不装插件
      if [[ "$role" == 'decode' ]]; then xccl_list="$NATIVE_VLLM_XCCL_ENV_DECODE"; else xccl_list="$NATIVE_VLLM_XCCL_ENV_PREFILL"; fi
      if [[ -n "$xccl_list" ]]; then
        xccl_whl="$(ls "$stage_dir"/xccl/*.whl 2>/dev/null | head -1)"
        [[ -n "$xccl_whl" ]] && printf 'export VLLM_XCCL_TURBO_WHL=%s/xccl/%s\n' "$work_dir" "$(basename "$xccl_whl")"
        IFS=',' read -r -a xccl_items <<<"$xccl_list"
        for xccl_item in "${xccl_items[@]}"; do
          xccl_item="${xccl_item#"${xccl_item%%[![:space:]]*}"}"
          xccl_item="${xccl_item%"${xccl_item##*[![:space:]]}"}"
          [[ -n "$xccl_item" ]] || continue
          [[ "$xccl_item" == *=* ]] || { warn "XCCL 环境变量应为 KEY=VALUE，已忽略：$xccl_item"; continue; }
          printf 'export %s\n' "$xccl_item"
        done
      fi
      for item in $NATIVE_VLLM_EXTRA_ENV; do
        [[ -n "$item" ]] && printf 'export %s\n' "$item"
      done
    } >>"$stage_dir/env-$role.sh"
  done

  [[ "$NATIVE_VLLM_MOEFIX" == '1' ]] && write_moefix
  [[ "$LMCACHE_ENABLE" == '1' ]] && write_metafix
  write_entry_scripts
  write_patch_appliers

  model_name="$(python3 - "$stage_dir/config-${roles[0]}.yaml" "$MODEL_DIR" <<'PY'
import os
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as handle:
    config = yaml.safe_load(handle) or {}
name = config.get("served-model-name")
print(name if isinstance(name, str) and name else os.path.basename(sys.argv[2].rstrip("/")))
PY
)"

  if [[ "$dry_run" == '1' ]]; then
    log "DRY_RUN=1：以下为计划，未执行任何远端操作"
    log "  镜像 $image_ref；目标机 $target_ip（user=$target_user）；工作目录 $work_dir"
    for role in "${roles[@]}"; do
      if [[ "$role" == 'decode' ]]; then
        log "  [$role] GPU=$NATIVE_VLLM_DECODE_GPUS 端口=$(role_port "$role")"
      else
        log "  [$role] GPU=$NATIVE_VLLM_PREFILL_GPUS 端口=$(role_port "$role")"
      fi
      printf '\n---- config-%s.yaml ----\n' "$role"
      cat "$stage_dir/config-$role.yaml"
      printf '\n---- env-%s.sh ----\n' "$role"
      cat "$stage_dir/env-$role.sh"
    done
    log "  LMCache=$LMCACHE_ENABLE（L1=${LMCACHE_L1_SIZE_GB}G，端口 ${lmcache_mp_port}/${lmcache_http_port}）"
    [[ "$mode" == 'pd' ]] && log "  router=$router_kv_connector:$router_port"
    return 0
  fi

  log "推送产物到 $target_ip:$work_dir${target_port:+（SSH 端口 $target_port）}"
  ensure_router_wheels
  ensure_nerdctl_binary
  ensure_socat_binary
  target_ssh "mkdir -p '$work_dir'" || die "目标机创建目录失败：$work_dir"
  target_scp "$stage_dir/." "$work_dir/" || die "推送渲染产物失败"
  target_scp "$script_path" "$work_dir/${SCRIPT_NAME}.sh" || die "推送脚本失败"

  log "在目标机执行远端阶段"
  local remote_env=(
    "NATIVE_VLLM_IMAGE=$image_ref"
    "MODEL_DIR=$MODEL_DIR"
    "DEPLOY_STRATEGY=$deploy_strategy"
    "NATIVE_VLLM_TARGET_IP=$target_ip"
    "NATIVE_VLLM_RUN_DIR=$work_dir"
    "NATIVE_VLLM_MODE=$mode"
    "NATIVE_VLLM_ARCH_SOURCE=$arch_source"
    "NATIVE_VLLM_PREFILL_GPUS=$NATIVE_VLLM_PREFILL_GPUS"
    "NATIVE_VLLM_DECODE_GPUS=$NATIVE_VLLM_DECODE_GPUS"
    "NATIVE_VLLM_ROUTER_PORT=$router_port"
    "NATIVE_VLLM_ROUTER_BIN=$router_bin"
    "NATIVE_VLLM_ROUTER_POLICY=$router_policy"
    "NATIVE_VLLM_KV_CONNECTOR=$router_kv_connector"
    "NATIVE_VLLM_MOEFIX=$NATIVE_VLLM_MOEFIX"
    "NATIVE_VLLM_READY_TIMEOUT_SECONDS=$NATIVE_VLLM_READY_TIMEOUT_SECONDS"
    "NATIVE_VLLM_VERIFY=$verify_after"
    "NATIVE_VLLM_CLEAN=$clean_old"
    "NATIVE_VLLM_SERVICE_NAME=$service_name"
    "LMCACHE_ENABLE=$LMCACHE_ENABLE"
    "LMCACHE_L1_SIZE_GB=$LMCACHE_L1_SIZE_GB"
    "LMCACHE_L1_INIT_SIZE_GB=$lmcache_l1_init_size_gb"
    "LMCACHE_READY_TIMEOUT_SECONDS=$lmcache_ready_timeout"
    "LMCACHE_OTLP_ENDPOINT=$LMCACHE_OTLP_ENDPOINT"
    "LMCACHE_MP_PORT=$lmcache_mp_port"
    "LMCACHE_HTTP_PORT=$lmcache_http_port"
    "LMCACHE_CHUNK_SIZE=$lmcache_chunk_size"
    "LMCACHE_EVICTION_POLICY=$lmcache_eviction_policy"
    "LMCACHE_EVICTION_TRIGGER_WATERMARK=$lmcache_eviction_watermark"
    "LMCACHE_EVICTION_RATIO=$lmcache_eviction_ratio"
  )
  # 远端不需要目标节点列表（防递归）；模型名由父阶段解析后下发
  target_ssh "env $(printf '%q ' "${remote_env[@]}")MODEL_NAME='$model_name' bash '$work_dir/${SCRIPT_NAME}.sh' --remote"
}

# 目标机缺 nerdctl 时，把执行机的静态二进制放进产物目录（随产物推送），由远端阶段装到 /usr/local/bin。
# 只在目标机确实缺失时复制；执行机侧源路径可用隐藏参数 NATIVE_VLLM_NERDCTL_SRC 指定。
# XCCL 插件（xccl-vllm-turbo）：P/D 任一角色启用时，把 whl 放进产物目录（随产物推送），
# 再由对应角色的 entry 脚本在容器内 pip 安装（本地 wheel，--no-index --no-deps）。
ensure_xccl_wheel() {
  [[ -n "$NATIVE_VLLM_XCCL_ENV_PREFILL$NATIVE_VLLM_XCCL_ENV_DECODE" ]] || return 0
  local src="$xccl_wheel_src"
  [[ -n "$src" ]] || src="$(ls -1t $xccl_wheel_glob 2>/dev/null | head -1)"
  [[ -n "$src" && -f "$src" ]] \
    || die "启用了 XCCL 插件（NATIVE_VLLM_XCCL_ENV_*）但找不到 whl：$xccl_wheel_glob（可用隐藏参数 NATIVE_VLLM_XCCL_WHEEL 指定）" 2
  mkdir -p "$stage_dir/xccl"
  cp -f "$src" "$stage_dir/xccl/" || die "复制 XCCL whl 到产物目录失败" 2
  log "XCCL 插件：随产物推送 $(basename "$src")（$(du -h "$src" | cut -f1)）；prefill=$([[ -n "$NATIVE_VLLM_XCCL_ENV_PREFILL" ]] && echo 启用 || echo 关)，decode=$([[ -n "$NATIVE_VLLM_XCCL_ENV_DECODE" ]] && echo 启用 || echo 关)"
}

# 目标机在转发映射表中、且自身没有 socat 时，把执行机的 socat 推到产物目录（远端装到 /usr/local/bin）。
ensure_socat_binary() {
  [[ -n "$(exposed_port_for_ip "$target_ip")" ]] || return 0
  if target_ssh "command -v socat >/dev/null 2>&1 || [[ -x /usr/local/bin/socat ]]"; then
    return 0
  fi
  local src
  src="$(command -v socat 2>/dev/null || echo /usr/bin/socat)"
  [[ -x "$src" ]] \
    || die "目标机缺 socat（端口转发需要），且执行机上也找不到：$src" 2
  log "目标机没有 socat，从执行机分发：$src（端口转发用）"
  install -m 755 "$src" "$stage_dir/socat" || die "复制 socat 到产物目录失败" 2
}

ensure_nerdctl_binary() {
  if target_ssh "command -v nerdctl >/dev/null 2>&1 || [[ -x /usr/local/bin/nerdctl ]]"; then
    return 0
  fi
  [[ -x "$nerdctl_src" ]] \
    || die "目标机缺 nerdctl，但执行机上也找不到可分发源：$nerdctl_src（用隐藏参数 NATIVE_VLLM_NERDCTL_SRC 指定，或先在执行机装 nerdctl）" 2
  log "目标机没有 nerdctl，从执行机分发二进制：$nerdctl_src（$(du -h "$nerdctl_src" | cut -f1)）"
  install -m 755 "$nerdctl_src" "$stage_dir/nerdctl" || die "复制 nerdctl 到产物目录失败" 2
}

# pd 模式：目标机没有可用 vllm-router 时，在执行机下载 wheel（走国内镜像，含依赖，首次较慢、之后走缓存）
# 放进产物目录，随产物一起推送到目标机，由远端阶段离线安装（目标机通常没有外网）。
ensure_router_wheels() {
  [[ "$mode" == 'pd' ]] || return 0
  if target_ssh "command -v '$router_bin' >/dev/null 2>&1 || [[ -x '$router_venv/bin/vllm-router' ]]"; then
    return 0
  fi
  log "目标机没有可用的 vllm-router，准备离线安装包（版本 $router_version，源 $pip_index）"
  if [[ ! -f "$router_wheels_cache/.complete" ]]; then
    rm -rf "$router_wheels_cache"
    mkdir -p "$router_wheels_cache"
    log "  在执行机下载 wheel（缓存目录 $router_wheels_cache）"
    python3 -m pip download --only-binary=:all: -d "$router_wheels_cache" \
      -i "$pip_index" --trusted-host "$pip_trusted_host" \
      "vllm-router==$router_version" >"$router_wheels_cache/.download.log" 2>&1 \
      || {
        warn "wheel 下载失败，日志尾部："
        tail -5 "$router_wheels_cache/.download.log" >&2
        die "无法在执行机下载 vllm-router==$router_version（源 $pip_index；可用 NATIVE_VLLM_PIP_INDEX 换源，或用 NATIVE_VLLM_ROUTER_BIN 指已装好的绝对路径）" 2
      }
    : >"$router_wheels_cache/.complete"
  fi
  mkdir -p "$stage_dir/router-wheels"
  cp -f "$router_wheels_cache"/*.whl "$stage_dir/router-wheels/" \
    || die "复制 wheel 到产物目录失败" 2
  log "  已备好 $(find "$stage_dir/router-wheels" -name '*.whl' | wc -l) 个 wheel（$(du -sh "$stage_dir/router-wheels" 2>/dev/null | cut -f1)），随产物推送到目标机离线安装"
}

main() {
  case "${1:-}" in
    --remote) remote_main ;;
    *) parent_main ;;
  esac
}

main "$@"
