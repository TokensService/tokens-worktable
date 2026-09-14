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
SSH_PASSWORD="${SSH_PASSWORD:-${TARGET_PASSWORD:-}}"
TARGET_USER="${TARGET_USER:-root}"
TARGET_RUN_DIR="${TARGET_RUN_DIR:-}"
RUN_DIR="${LMCACHE_UNITTEST_RUN_DIR:-${TARGET_RUN_DIR:-/tmp/lmcache-unittest/$(date +%Y%m%d_%H%M%S)}}"
LMCACHE_UNITTEST_IMAGE="${LMCACHE_UNITTEST_IMAGE:-lmcache-vllm-openai-0.5.4-unitest:latest}"
LMCACHE_UNITTEST_CAP_ADD="${LMCACHE_UNITTEST_CAP_ADD:-SYS_NICE}"
LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST="${LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST:-1}"
LMCACHE_UNITTEST_LOG_DIR="${LMCACHE_UNITTEST_LOG_DIR:-$RUN_DIR/logs}"
LMCACHE_UNITTEST_CONTAINER="${LMCACHE_UNITTEST_CONTAINER:-lmcache-unittest-$(basename "$RUN_DIR")}"
LMCACHE_UNITTEST_HTTP_PROXY="${LMCACHE_UNITTEST_HTTP_PROXY:-http://127.0.0.1:8889}"
LMCACHE_UNITTEST_REMOVE_IMAGE="${LMCACHE_UNITTEST_REMOVE_IMAGE:-0}"
ns="${LMCACHE_NERDCTL_NAMESPACE:-k8s.io}"
AK="${AK:-}"
PROJECT="${PROJECT:-}"
LOGIN_KEY="${LOGIN_KEY:-}"

[[ "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST" =~ ^[01]$ ]] || { echo 'LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST must be 0 or 1' >&2; exit 2; }
[[ "$LMCACHE_UNITTEST_REMOVE_IMAGE" =~ ^[01]$ ]] || { echo 'LMCACHE_UNITTEST_REMOVE_IMAGE must be 0 or 1' >&2; exit 2; }
lmcache_remote_init

# Credentials are transmitted only as SSH stdin, never as an SSH argument or
# stage variable. The target invokes ctr only when the image is absent.
lmcache_remote bash -s <<EOF
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\${PATH:-}"
run_dir=$(printf '%q' "$RUN_DIR")
log_dir=$(printf '%q' "$LMCACHE_UNITTEST_LOG_DIR")
image=$(printf '%q' "$LMCACHE_UNITTEST_IMAGE")
container=$(printf '%q' "$LMCACHE_UNITTEST_CONTAINER")
cap_add=$(printf '%q' "$LMCACHE_UNITTEST_CAP_ADD")
namespace=$(printf '%q' "$ns")
ak=$(printf '%q' "$AK")
project=$(printf '%q' "$PROJECT")
login_key=$(printf '%q' "$LOGIN_KEY")
command -v nerdctl >/dev/null || { echo 'nerdctl is required on target host' >&2; exit 2; }
mkdir -p "\$log_dir"
if ! nerdctl --namespace "\$namespace" image inspect "\$image" >/dev/null 2>&1; then
  command -v ctr >/dev/null || { echo 'ctr is required on target host' >&2; exit 2; }
  sudo ctr -n "\$namespace" image pull --user "\${project}@\${ak}:\${login_key}" "\$image"
fi
nerdctl --namespace "\$namespace" run -d --name "\$container" --net=host --gpus all \\
  --cap-add "\$cap_add" -v /dev/shm:/dev/shm -v "\$run_dir:\$run_dir" \\
  --entrypoint bash "\$image" -lc 'exec sleep infinity' >/dev/null
EOF

printf 'LMCACHE_UNITTEST_RUN_DIR=%s\n' "$RUN_DIR"
printf 'LMCACHE_UNITTEST_IMAGE=%s\n' "$LMCACHE_UNITTEST_IMAGE"
printf 'LMCACHE_UNITTEST_CAP_ADD=%s\n' "$LMCACHE_UNITTEST_CAP_ADD"
printf 'LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST=%s\n' "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST"
printf 'LMCACHE_UNITTEST_LOG_DIR=%s\n' "$LMCACHE_UNITTEST_LOG_DIR"
printf 'LMCACHE_UNITTEST_CONTAINER=%s\n' "$LMCACHE_UNITTEST_CONTAINER"
printf 'LMCACHE_UNITTEST_HTTP_PROXY=%s\n' "$LMCACHE_UNITTEST_HTTP_PROXY"
printf 'LMCACHE_UNITTEST_REMOVE_IMAGE=%s\n' "$LMCACHE_UNITTEST_REMOVE_IMAGE"
printf 'LMCACHE_UNITTEST_TARGET_IP=%s\n' "$LMCACHE_UNITTEST_TARGET_IP"
printf 'LMCACHE_UNITTEST_TARGET_PORT=%s\n' "$LMCACHE_UNITTEST_TARGET_PORT"
printf 'LMCACHE_UNITTEST_TARGET_USER=%s\n' "$LMCACHE_UNITTEST_TARGET_USER"
