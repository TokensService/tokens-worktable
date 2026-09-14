#!/usr/bin/env bash
set -euo pipefail

# 上游输入（由 pull-image.sh 的 KEY=VALUE 输出自动注入；单独执行时必须提供）：
# - LMCACHE_UNITTEST_RUN_DIR、LMCACHE_UNITTEST_IMAGE、LMCACHE_UNITTEST_CONTAINER、LMCACHE_UNITTEST_CAP_ADD、LMCACHE_UNITTEST_LOG_DIR。
# 可选覆盖输入：LMCACHE_UNITTEST_REPO_DIR、LMCACHE_UNITTEST_GIT_URL、
# LMCACHE_UNITTEST_GIT_BRANCH、LMCACHE_UNITTEST_GIT_USER、LMCACHE_UNITTEST_GIT_TOKEN、
# LMCACHE_UNITTEST_HTTP_PROXY、LMCACHE_UNITTEST_REMOVE_IMAGE、LMCACHE_NERDCTL_NAMESPACE。
# Git 用户名和 token 必须成对传入；认证信息仅用于本次 clone，不写入 stdout 或变量池。
# 本阶段会输出容器名、源码目录和构建日志路径，供 run-tests 阶段及归档任务使用。
# 第二阶段：使用 pull 阶段下传的镜像，在 GPU 容器中重新编译 LMCache。
command -v nerdctl >/dev/null || { echo 'nerdctl is required' >&2; exit 2; }
# 不使用 Bash 的“变量为空即退出”展开：工作台会静态识别它并要求用户在编辑器中手填。
# 正常串行运行时变量池已自动注入；单独运行本阶段时仍在这里给出明确错误。
require_inherited() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf '%s is required; run pull stage first\n' "$name" >&2
    exit 2
  fi
}
require_inherited LMCACHE_UNITTEST_RUN_DIR
require_inherited LMCACHE_UNITTEST_IMAGE
require_inherited LMCACHE_UNITTEST_CONTAINER
require_inherited LMCACHE_UNITTEST_CAP_ADD
require_inherited LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST
require_inherited LMCACHE_UNITTEST_LOG_DIR
require_inherited LMCACHE_UNITTEST_REMOVE_IMAGE
RUN_DIR="$LMCACHE_UNITTEST_RUN_DIR"
mkdir -p "$LMCACHE_UNITTEST_LOG_DIR"
# 每次重建使用容器内的干净源码目录；不会在宿主机 clone 或挂载源码。
LMCACHE_UNITTEST_REPO_DIR="${LMCACHE_UNITTEST_REPO_DIR:-/workspace/LMCache}"; url="${LMCACHE_UNITTEST_GIT_URL:-https://gitcode.com/TokensService/LMCache.git}"; branch="${LMCACHE_UNITTEST_GIT_BRANCH:-dev}"
ns="${LMCACHE_NERDCTL_NAMESPACE:-k8s.io}"
# 该代理由容器所在节点本地提供；可用 LMCACHE_UNITTEST_HTTP_PROXY 覆盖。
http_proxy="${LMCACHE_UNITTEST_HTTP_PROXY:-http://127.0.0.1:8889}"
git_exec_env=(-e "http_proxy=$http_proxy" -e "https_proxy=$http_proxy" -e 'NO_PROXY=localhost,127.0.0.1' -e 'no_proxy=localhost,127.0.0.1')

# Git clone 在容器内进行。凭据经 stdin 传入，并仅在容器内转为临时 Git header，
# 防止 token 出现在 nerdctl 参数、日志和工作台变量池中。
if [[ -n "${LMCACHE_UNITTEST_GIT_USER:-}" || -n "${LMCACHE_UNITTEST_GIT_TOKEN:-}" ]]; then
  if [[ -z "${LMCACHE_UNITTEST_GIT_USER:-}" || -z "${LMCACHE_UNITTEST_GIT_TOKEN:-}" ]]; then
    echo 'set LMCACHE_UNITTEST_GIT_USER and LMCACHE_UNITTEST_GIT_TOKEN together' >&2
    exit 2
  fi
  printf '%s\n%s\n' "$LMCACHE_UNITTEST_GIT_USER" "$LMCACHE_UNITTEST_GIT_TOKEN" | \
    nerdctl --namespace "$ns" exec -i "${git_exec_env[@]}" "$LMCACHE_UNITTEST_CONTAINER" bash -lc '
      set -euo pipefail
      IFS= read -r git_user
      IFS= read -r git_token
      git_auth_b64="$(printf "%s:%s" "$git_user" "$git_token" | base64 | tr -d "\n")"
      rm -rf -- "$1"
      git -c "http.extraHeader=Authorization: Basic $git_auth_b64" clone --branch "$2" --single-branch "$3" "$1"
    ' _ "$LMCACHE_UNITTEST_REPO_DIR" "$branch" "$url"
else
  nerdctl --namespace "$ns" exec "${git_exec_env[@]}" "$LMCACHE_UNITTEST_CONTAINER" bash -lc '
    set -euo pipefail
    rm -rf -- "$1"
    git clone --branch "$2" --single-branch "$3" "$1"
  ' _ "$LMCACHE_UNITTEST_REPO_DIR" "$branch" "$url"
fi
LMCACHE_UNITTEST_BUILD_LOG="$LMCACHE_UNITTEST_LOG_DIR/build.log"
# 在同一容器内启用制备镜像的测试虚拟环境并编译；完整 stdout/stderr 写入宿主可归档日志。
nerdctl --namespace "$ns" exec "$LMCACHE_UNITTEST_CONTAINER" bash -lc \
  '. /opt/lmcache-test-venv/bin/activate && cd /workspace/LMCache && BUILD_WITH_CUDA=1 LMCACHE_CUDA_MAJOR=13 TORCH_CUDA_ARCH_LIST="9.0;10.0+PTX" ENABLE_CXX11_ABI=1 MAX_JOBS=8 pip install -v --no-build-isolation --no-deps -e . && python -c "import lmcache.cuda_ops; print(lmcache.cuda_ops.__file__)"' \
  >"$LMCACHE_UNITTEST_BUILD_LOG" 2>&1

# 保持 XDS 主流程的变量池契约，供 run-tests 和归档阶段消费。
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
