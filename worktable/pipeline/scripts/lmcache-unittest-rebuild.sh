#!/usr/bin/env bash
set -euo pipefail

# 第二阶段：SSH 到 pull 阶段选择的第一个目标节点，在其中的容器内 clone 和重编译。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lmcache-unittest-remote.sh
source "$SCRIPT_DIR/lmcache-unittest-remote.sh"

# 与第一阶段相同的目标连接参数。TARGET_HOSTS 未再次注入时，会回退使用
# pull 阶段输出的 LMCACHE_UNITTEST_TARGET_IP/PORT/USER。
TARGET_HOSTS="${TARGET_HOSTS:-}"
TARGET_IP="${TARGET_IP:-}"
SSH_PASSWORD="${SSH_PASSWORD:-${TARGET_PASSWORD:-}}"
TARGET_USER="${TARGET_USER:-root}"
TARGET_RUN_DIR="${TARGET_RUN_DIR:-}"
require_inherited() {
  local name="$1"
  [[ -n "${!name:-}" ]] || { printf '%s is required; run pull stage first\n' "$name" >&2; exit 2; }
}
for variable in LMCACHE_UNITTEST_RUN_DIR LMCACHE_UNITTEST_IMAGE LMCACHE_UNITTEST_CONTAINER \
  LMCACHE_UNITTEST_CAP_ADD LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST LMCACHE_UNITTEST_LOG_DIR \
  LMCACHE_UNITTEST_REMOVE_IMAGE; do
  require_inherited "$variable"
done

RUN_DIR="$LMCACHE_UNITTEST_RUN_DIR"
LMCACHE_UNITTEST_REPO_DIR="${LMCACHE_UNITTEST_REPO_DIR:-/workspace/LMCache}"
url="${LMCACHE_UNITTEST_GIT_URL:-https://gitcode.com/TokensService/LMCache.git}"
branch="${LMCACHE_UNITTEST_GIT_BRANCH:-dev}"
# 默认代理适用于 128 节点；优先使用 pull 阶段或调用方显式注入的值。
http_proxy="${LMCACHE_UNITTEST_HTTP_PROXY:-http://192.168.10.6:3128}"
ns="${LMCACHE_NERDCTL_NAMESPACE:-k8s.io}"
LMCACHE_UNITTEST_BUILD_LOG="$LMCACHE_UNITTEST_LOG_DIR/build.log"
git_user="${LMCACHE_UNITTEST_GIT_USER:-}"
git_token="${LMCACHE_UNITTEST_GIT_TOKEN:-}"
if [[ -n "$git_user" || -n "$git_token" ]] && [[ -z "$git_user" || -z "$git_token" ]]; then
  echo 'set LMCACHE_UNITTEST_GIT_USER and LMCACHE_UNITTEST_GIT_TOKEN together' >&2
  exit 2
fi
lmcache_remote_init

lmcache_remote bash -s <<EOF
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\${PATH:-}"
namespace=$(printf '%q' "$ns")
container=$(printf '%q' "$LMCACHE_UNITTEST_CONTAINER")
repo_dir=$(printf '%q' "$LMCACHE_UNITTEST_REPO_DIR")
url=$(printf '%q' "$url")
branch=$(printf '%q' "$branch")
proxy=$(printf '%q' "$http_proxy")
build_log=$(printf '%q' "$LMCACHE_UNITTEST_BUILD_LOG")
git_user=$(printf '%q' "$git_user")
git_token=$(printf '%q' "$git_token")
mkdir -p "\$(dirname "\$build_log")"
git_env=(-e "http_proxy=\$proxy" -e "https_proxy=\$proxy" -e 'NO_PROXY=localhost,127.0.0.1' -e 'no_proxy=localhost,127.0.0.1')
if [[ -n "\$git_user" ]]; then
  printf '%s\n%s\n' "\$git_user" "\$git_token" | nerdctl --namespace "\$namespace" exec -i "\${git_env[@]}" "\$container" bash -lc '
    set -euo pipefail
    IFS= read -r git_user
    IFS= read -r git_token
    git_auth_b64="\$(printf "%s:%s" "\$git_user" "\$git_token" | base64 | tr -d "\\n")"
    rm -rf -- "\$1"
    git -c "http.extraHeader=Authorization: Basic \$git_auth_b64" clone --branch "\$2" --single-branch "\$3" "\$1"
  ' _ "\$repo_dir" "\$branch" "\$url"
else
  nerdctl --namespace "\$namespace" exec "\${git_env[@]}" "\$container" bash -lc '
    set -euo pipefail
    rm -rf -- "\$1"
    git clone --branch "\$2" --single-branch "\$3" "\$1"
  ' _ "\$repo_dir" "\$branch" "\$url"
fi
nerdctl --namespace "\$namespace" exec "\$container" bash -lc \
  '. /opt/lmcache-test-venv/bin/activate && cd /workspace/LMCache && BUILD_WITH_CUDA=1 LMCACHE_CUDA_MAJOR=13 TORCH_CUDA_ARCH_LIST="9.0;10.0+PTX" ENABLE_CXX11_ABI=1 MAX_JOBS=8 pip install -v --no-build-isolation --no-deps -e . && python -c "import lmcache.cuda_ops; print(lmcache.cuda_ops.__file__)"' \
  >"\$build_log" 2>&1
EOF

printf 'LMCACHE_UNITTEST_RUN_DIR=%s\n' "$RUN_DIR"
printf 'LMCACHE_UNITTEST_IMAGE=%s\n' "$LMCACHE_UNITTEST_IMAGE"
printf 'LMCACHE_UNITTEST_CAP_ADD=%s\n' "$LMCACHE_UNITTEST_CAP_ADD"
printf 'LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST=%s\n' "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST"
printf 'LMCACHE_UNITTEST_LOG_DIR=%s\n' "$LMCACHE_UNITTEST_LOG_DIR"
printf 'LMCACHE_UNITTEST_REPO_DIR=%s\n' "$LMCACHE_UNITTEST_REPO_DIR"
printf 'LMCACHE_UNITTEST_CONTAINER=%s\n' "$LMCACHE_UNITTEST_CONTAINER"
printf 'LMCACHE_UNITTEST_BUILD_LOG=%s\n' "$LMCACHE_UNITTEST_BUILD_LOG"
printf 'LMCACHE_UNITTEST_HTTP_PROXY=%s\n' "$http_proxy"
printf 'LMCACHE_UNITTEST_REMOVE_IMAGE=%s\n' "$LMCACHE_UNITTEST_REMOVE_IMAGE"
printf 'LMCACHE_UNITTEST_TARGET_IP=%s\n' "$LMCACHE_UNITTEST_TARGET_IP"
printf 'LMCACHE_UNITTEST_TARGET_PORT=%s\n' "$LMCACHE_UNITTEST_TARGET_PORT"
printf 'LMCACHE_UNITTEST_TARGET_USER=%s\n' "$LMCACHE_UNITTEST_TARGET_USER"
