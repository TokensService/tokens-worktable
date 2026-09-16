#!/usr/bin/env bash
set -euo pipefail

# 第一阶段只在工作台解析目标并发起 SSH。镜像、容器、日志目录均创建在
# TARGET_HOSTS[0]（兼容 TARGET_IP）上，后续两个阶段复用同一远端状态。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lmcache-unittest-remote.sh
source "$SCRIPT_DIR/lmcache-unittest-remote.sh"

# 工作台参数：TARGET_HOSTS 优先，TARGET_IP 为兼容单节点调用；TARGET_RUN_DIR
# 是目标节点目录。显式声明也让工作台能够把这些运行变量注入脚本。
TARGET_HOSTS="${TARGET_HOSTS:-}"
TARGET_IP="${TARGET_IP:-}"
SSH_PASSWORD="${SSH_PASSWORD:-}"
[[ -n "$SSH_PASSWORD" ]] || SSH_PASSWORD="${TARGET_PASSWORD:-}"
TARGET_USER="${TARGET_USER:-root}"
TARGET_RUN_DIR="${TARGET_RUN_DIR:-}"
# RUN_DIR 属于执行机：脚本三将测试日志回传到这里。目标节点仍使用独立的
# LMCACHE_UNITTEST_RUN_DIR，避免混淆两台机器上的同名路径。
RUN_DIR="${RUN_DIR:-/tmp/LMCache仓-单元测试-$(date +%Y%m%d_%H%M%S)}"
LMCACHE_UNITTEST_RUN_DIR="${LMCACHE_UNITTEST_RUN_DIR:-}"
[[ -n "$LMCACHE_UNITTEST_RUN_DIR" ]] || LMCACHE_UNITTEST_RUN_DIR="$TARGET_RUN_DIR"
[[ -n "$LMCACHE_UNITTEST_RUN_DIR" ]] || LMCACHE_UNITTEST_RUN_DIR="/tmp/lmcache-unittest/$(date +%Y%m%d_%H%M%S)"
LMCACHE_UNITTEST_IMAGE="${LMCACHE_UNITTEST_IMAGE:-swr.cn-southwest-2.myhuaweicloud.com/serverlessai/lmcache-vllm-openai-0.5.4-unitest:v0.0.1_x86_64}"
LMCACHE_UNITTEST_CAP_ADD="${LMCACHE_UNITTEST_CAP_ADD:-SYS_NICE}"
LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST="${LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST:-1}"
LMCACHE_UNITTEST_LOG_DIR="${LMCACHE_UNITTEST_LOG_DIR:-$LMCACHE_UNITTEST_RUN_DIR/logs}"
# RUN_DIR 可包含中文，以便执行机日志目录可读；nerdctl 容器名只能使用 ASCII。
LMCACHE_UNITTEST_CONTAINER="${LMCACHE_UNITTEST_CONTAINER:-lmcache-unittest-$(date +%Y%m%d_%H%M%S)}"
# 128 节点通过该代理访问 GitCode/Hugging Face；调用方可按目标节点覆盖。
LMCACHE_UNITTEST_HTTP_PROXY="${LMCACHE_UNITTEST_HTTP_PROXY:-http://192.168.10.6:3128}"
LMCACHE_UNITTEST_REMOVE_IMAGE="${LMCACHE_UNITTEST_REMOVE_IMAGE:-0}"
# CPU-only 模式不向容器挂载 GPU；pytest 阶段会再筛选设备相关用例。
LMCACHE_UNITTEST_CPU_ONLY="${LMCACHE_UNITTEST_CPU_ONLY:-0}"
# GPU 模式下可指定 0,1 这类宿主机 GPU 编号；all 保持当前默认行为。
LMCACHE_UNITTEST_GPU_DEVICES="${LMCACHE_UNITTEST_GPU_DEVICES:-all}"
ns="${LMCACHE_NERDCTL_NAMESPACE:-k8s.io}"
# 私有镜像仓库认证 token；仅在目标节点本地缺镜像、需要拉取时校验。
IMAGE_PULL_TOKEN="${IMAGE_PULL_TOKEN:-}"

[[ "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST" =~ ^[01]$ ]] || { echo 'LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST must be 0 or 1' >&2; exit 2; }
[[ "$LMCACHE_UNITTEST_REMOVE_IMAGE" =~ ^[01]$ ]] || { echo 'LMCACHE_UNITTEST_REMOVE_IMAGE must be 0 or 1' >&2; exit 2; }
[[ "$LMCACHE_UNITTEST_CPU_ONLY" =~ ^[01]$ ]] || { echo 'LMCACHE_UNITTEST_CPU_ONLY must be 0 or 1' >&2; exit 2; }
[[ "$LMCACHE_UNITTEST_GPU_DEVICES" == all || "$LMCACHE_UNITTEST_GPU_DEVICES" =~ ^[0-9]+(,[0-9]+)*$ ]] || {
  echo 'LMCACHE_UNITTEST_GPU_DEVICES must be all or comma-separated GPU IDs such as 0,1' >&2
  exit 2
}
if [[ "$LMCACHE_UNITTEST_CPU_ONLY" == 1 && "$LMCACHE_UNITTEST_GPU_DEVICES" != all ]]; then
  echo 'LMCACHE_UNITTEST_CPU_ONLY=1 cannot be combined with LMCACHE_UNITTEST_GPU_DEVICES' >&2
  exit 2
fi
lmcache_remote_init

# Credentials are transmitted only as SSH stdin, never as an SSH argument or
# stage variable. The target invokes ctr only when the image is absent.
lmcache_remote bash -s <<EOF
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\${PATH:-}"
# 目标节点的镜像仓库访问经本地代理转发；ctr 会继承这两个环境变量。
export http_proxy=http://127.0.0.1:18118 https_proxy=http://127.0.0.1:18118
run_dir=$(printf '%q' "$LMCACHE_UNITTEST_RUN_DIR")
log_dir=$(printf '%q' "$LMCACHE_UNITTEST_LOG_DIR")
image=$(printf '%q' "$LMCACHE_UNITTEST_IMAGE")
container=$(printf '%q' "$LMCACHE_UNITTEST_CONTAINER")
cap_add=$(printf '%q' "$LMCACHE_UNITTEST_CAP_ADD")
namespace=$(printf '%q' "$ns")
image_pull_token=$(printf '%q' "$IMAGE_PULL_TOKEN")
cpu_only=$(printf '%q' "$LMCACHE_UNITTEST_CPU_ONLY")
gpu_devices=$(printf '%q' "$LMCACHE_UNITTEST_GPU_DEVICES")
command -v nerdctl >/dev/null || { echo 'nerdctl is required on target host' >&2; exit 2; }
mkdir -p "\$log_dir"
if nerdctl --namespace "\$namespace" image inspect "\$image" >/dev/null 2>&1; then
  echo '[lmcache-debug] image cache: hit; skipping pull'
else
  echo '[lmcache-debug] image cache: miss; pulling image'
  command -v ctr >/dev/null || { echo 'ctr is required on target host' >&2; exit 2; }
  [[ -n "\$image_pull_token" ]] || { echo 'IMAGE_PULL_TOKEN is required when pulling an uncached image' >&2; exit 2; }
  ctr -n "\$namespace" images pull --user "cn-southwest-2@\${image_pull_token}" "\$image"
  echo '[lmcache-debug] image pull: completed'
fi
echo "[lmcache-debug] container create: \$container"
gpu_args=(--gpus all)
if [[ "\$cpu_only" == 1 ]]; then
  gpu_args=()
  echo '[lmcache-debug] execution mode: cpu-only; GPU devices are not attached'
elif [[ "\$gpu_devices" == all ]]; then
  echo '[lmcache-debug] execution mode: gpu; GPU devices: all'
else
  gpu_args=(--gpus "device=\$gpu_devices")
  echo "[lmcache-debug] execution mode: gpu; GPU devices: \$gpu_devices"
fi
container_id="\$(nerdctl --namespace "\$namespace" run -d --name "\$container" --net=host "\${gpu_args[@]}" \\
  --cap-add "\$cap_add" -v /dev/shm:/dev/shm -v "\$run_dir:\$run_dir" \\
  --entrypoint bash "\$image" -lc 'exec sleep infinity')"
echo "[lmcache-debug] container id: \$container_id"
container_status="\$(nerdctl --namespace "\$namespace" inspect -f '{{.State.Status}}' "\$container")"
echo "[lmcache-debug] container status: \$container_status"
if [[ "\$container_status" != running ]]; then
  echo "[lmcache-debug] container inspect: \$(nerdctl --namespace "\$namespace" inspect "\$container" 2>&1 || true)" >&2
  nerdctl --namespace "\$namespace" logs "\$container" >&2 || true
  exit 1
fi
EOF

printf 'RUN_DIR=%s\n' "$RUN_DIR"
printf 'LMCACHE_UNITTEST_RUN_DIR=%s\n' "$LMCACHE_UNITTEST_RUN_DIR"
printf 'LMCACHE_UNITTEST_IMAGE=%s\n' "$LMCACHE_UNITTEST_IMAGE"
printf 'LMCACHE_UNITTEST_CAP_ADD=%s\n' "$LMCACHE_UNITTEST_CAP_ADD"
printf 'LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST=%s\n' "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST"
printf 'LMCACHE_UNITTEST_LOG_DIR=%s\n' "$LMCACHE_UNITTEST_LOG_DIR"
printf 'LMCACHE_UNITTEST_CONTAINER=%s\n' "$LMCACHE_UNITTEST_CONTAINER"
printf 'LMCACHE_UNITTEST_HTTP_PROXY=%s\n' "$LMCACHE_UNITTEST_HTTP_PROXY"
printf 'LMCACHE_UNITTEST_REMOVE_IMAGE=%s\n' "$LMCACHE_UNITTEST_REMOVE_IMAGE"
printf 'LMCACHE_UNITTEST_CPU_ONLY=%s\n' "$LMCACHE_UNITTEST_CPU_ONLY"
printf 'LMCACHE_UNITTEST_GPU_DEVICES=%s\n' "$LMCACHE_UNITTEST_GPU_DEVICES"
printf 'LMCACHE_UNITTEST_TARGET_IP=%s\n' "$LMCACHE_UNITTEST_TARGET_IP"
printf 'LMCACHE_UNITTEST_TARGET_PORT=%s\n' "$LMCACHE_UNITTEST_TARGET_PORT"
printf 'LMCACHE_UNITTEST_TARGET_USER=%s\n' "$LMCACHE_UNITTEST_TARGET_USER"
