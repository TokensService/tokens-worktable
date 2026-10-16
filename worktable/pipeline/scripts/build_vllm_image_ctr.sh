#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  build_vllm_image_ctr.sh [--dry-run]

环境变量：
  VLLM_REPO_URL       vLLM 仓库地址，默认 https://github.com/TokensService/vllm.git
  VLLM_REF            分支、标签或提交，默认 main
  VLLM_SOURCE_DIR     源码目录，默认 /tmp/vllm-build
  VLLM_UPDATE         源码目录存在时是否 fetch/checkout，默认 false
  DOCKERFILE          Dockerfile 路径，相对于源码目录，默认 docker/Dockerfile
  BUILD_CONTEXT       构建上下文，相对于源码目录，默认 .
  BUILD_PLATFORM      目标平台，默认 linux/amd64
  BUILD_NETWORK       docker-buildx RUN 网络，默认 host
  BUILD_PROXY_URL     构建步骤使用的可达代理，例如 http://192.168.1.46:8118；为空时沿用 HTTP_PROXY/HTTPS_PROXY
  BUILD_REMOTE_HOST   远程编译主机；设置后通过 SSH 在远端执行本脚本
  BUILD_REMOTE_PORT   远程 SSH 端口，默认 2222
  BUILD_REMOTE_USER   远程 SSH 用户，默认 root
  BUILD_REMOTE_PROXY_COMMAND SSH ProxyCommand，默认使用 192.168.10.6:3128 HTTP 代理
  BUILD_REMOTE_PROXY_URL  远程构建步骤使用的代理；为空时不转发本地回环代理
  BUILD_REMOTE_AUTO_TUNE  根据远端 CPU/内存自动选择 CUDA 并发，默认 true
  BUILD_MAX_JOBS      编译并发数，默认 1（CUDA 扩展内存占用较高）
  BUILD_NVCC_THREADS  每个 nvcc 编译进程的线程数，默认 2
  BUILD_CPUS          构建容器 CPU 配额，默认执行机 CPU 数的一半
  BUILD_ARGS          额外构建参数，每行一个 KEY=VALUE
  BUILD_ENGINE        构建器：auto、indocker、docker、buildctl、nerdctl 或 docker-buildx，默认 auto
  INDOCKER_RUNTIME    runner 外层运行时：auto、docker、nerdctl 或 ctr，默认 auto
  INDOCKER_RUNNER_IMAGE Docker-in-Docker runner 镜像，默认 local/vllm-indocker-runner:latest
  INDOCKER_OUTPUT_DIR runner 输出目录，默认 BUILD_OUTPUT_DIR
  INDOCKER_NETWORK    runner 网络，默认 host
  BUILDX_BUILDER      Docker Buildx builder 名称，默认 vllm-builder
  BUILDX_AUTO_CREATE  docker-buildx 分支是否自动创建/配置 builder，默认 true
  BUILDKIT_ADDR       BuildKit 地址，默认 unix:///run/buildkit/buildkitd.sock
  CTR_NAMESPACE       containerd 命名空间，默认 k8s.io
  SWR_REGISTRY        SWR registry，例如 swr.cn-southwest-2.myhuaweicloud.com
  SWR_REPOSITORY      SWR 仓库路径，例如 dataartsfabric/vllm
  IMAGE_TAG           镜像标签；branch-time 模式下由分支名和时间自动生成
  IMAGE_TAG_MODE      branch-time（默认）或 explicit；explicit 才使用 IMAGE_TAG
  SWR_USERNAME        SWR 用户名，非 dry-run 必填
  SWR_PASSWORD        SWR 密码或 Token，非 dry-run 必填
  BUILD_OUTPUT_DIR    OCI 临时包目录，默认 /tmp/vllm-image-build
  BUILD_CACHE_DIR     BuildKit 本地缓存目录，默认 /tmp/vllm-build-cache
  BUILD_CACHE         是否启用本地层缓存，默认 true
  BUILD_UV_CACHE_SHARING  uv 缓存挂载并发策略，private、locked 或 shared，默认 shared
  UV_INDEX_URL             Python 主索引，默认清华 PyPI 镜像
EOF
}

DRY_RUN=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while (($#)); do
  case "$1" in
    '') shift ;; # 工作台空参数表示未填写可选参数
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

VLLM_REPO_URL="${VLLM_REPO_URL:-${GIT_URL:-https://github.com/TokensService/vllm.git}}"
VLLM_REF="${VLLM_REF:-${GIT_BRANCH:-main}}"
VLLM_SOURCE_DIR="${VLLM_SOURCE_DIR:-/tmp/vllm-build}"
VLLM_UPDATE="${VLLM_UPDATE:-false}"
DOCKERFILE="${DOCKERFILE:-docker/Dockerfile}"
BUILD_CONTEXT="${BUILD_CONTEXT:-.}"
BUILD_PLATFORM="${BUILD_PLATFORM:-linux/amd64}"
BUILD_NETWORK="${BUILD_NETWORK:-host}"
BUILD_PROXY_URL="${BUILD_PROXY_URL:-}"
# 默认使用指定的远程编译机；设置 BUILD_REMOTE_HOST= 可显式关闭远程模式。
BUILD_REMOTE_HOST="${BUILD_REMOTE_HOST:-115.120.93.136}"
BUILD_REMOTE_PORT="${BUILD_REMOTE_PORT:-2222}"
BUILD_REMOTE_USER="${BUILD_REMOTE_USER:-root}"
BUILD_REMOTE_PROXY_COMMAND="${BUILD_REMOTE_PROXY_COMMAND:-ncat --proxy 192.168.10.6:3128 --proxy-type http %h %p}"
BUILD_REMOTE_PROXY_URL="${BUILD_REMOTE_PROXY_URL:-}"
BUILD_REMOTE_EXEC="${BUILD_REMOTE_EXEC:-0}"
BUILD_REMOTE_AUTO_TUNE="${BUILD_REMOTE_AUTO_TUNE:-true}"
BUILD_MAX_JOBS_WAS_SET="${BUILD_MAX_JOBS+x}"
BUILD_NVCC_THREADS_WAS_SET="${BUILD_NVCC_THREADS+x}"
BUILD_MAX_JOBS="${BUILD_MAX_JOBS:-1}"
BUILD_NVCC_THREADS="${BUILD_NVCC_THREADS:-2}"
BUILD_CPUS="${BUILD_CPUS:-}"
BUILD_ARGS="${BUILD_ARGS:-}"
BUILD_ENGINE="${BUILD_ENGINE:-auto}"
INDOCKER_RUNTIME="${INDOCKER_RUNTIME:-auto}"
INDOCKER_RUNNER_IMAGE="${INDOCKER_RUNNER_IMAGE:-local/vllm-indocker-runner:latest}"
INDOCKER_OUTPUT_DIR="${INDOCKER_OUTPUT_DIR:-}"
INDOCKER_NETWORK="${INDOCKER_NETWORK:-host}"
ALPINE_MIRROR="${ALPINE_MIRROR:-https://mirrors.aliyun.com/alpine}"
BUILDX_BUILDER="${BUILDX_BUILDER:-vllm-builder}"
BUILDX_AUTO_CREATE="${BUILDX_AUTO_CREATE:-true}"
BUILDKIT_ADDR="${BUILDKIT_ADDR:-unix:///run/buildkit/buildkitd.sock}"
CTR_NAMESPACE="${CTR_NAMESPACE:-k8s.io}"
SWR_REGISTRY="${SWR_REGISTRY:-swr.cn-southwest-2.myhuaweicloud.com}"
SWR_REPOSITORY="${SWR_REPOSITORY:-vllm}"
IMAGE_TAG_MODE="${IMAGE_TAG_MODE:-branch-time}"
case "$IMAGE_TAG_MODE" in
  branch-time|explicit) ;;
  *) die "IMAGE_TAG_MODE 必须是 branch-time 或 explicit: $IMAGE_TAG_MODE" ;;
esac
if [[ -n "${GIT_BRANCH:-}" || "$IMAGE_TAG_MODE" == branch-time ]]; then
  image_branch="${GIT_BRANCH:-$VLLM_REF}"
  image_branch="$(printf '%s' "$image_branch" | sed 's/[^A-Za-z0-9_.-]/-/g; s/^[.-]*//')"
  [[ -n "$image_branch" ]] || image_branch=main
  IMAGE_TAG="${image_branch}-$(date +%Y%m%d%H%M%S)"
elif [[ "$IMAGE_TAG_MODE" == explicit ]]; then
  IMAGE_TAG="${IMAGE_TAG:-}"
fi
SWR_USERNAME="${SWR_USERNAME:-}"
SWR_PASSWORD="${SWR_PASSWORD:-}"
BUILD_OUTPUT_DIR="${BUILD_OUTPUT_DIR:-/tmp/vllm-image-build}"
BUILD_CACHE_DIR="${BUILD_CACHE_DIR:-/tmp/vllm-build-cache}"
BUILD_CACHE="${BUILD_CACHE:-true}"
# 两个 Docker 构建阶段会并行安装相同的 Python 依赖。共享 uv 缓存可避免
# runtime/base 阶段重复下载；uv 自身会对缓存文件加锁。
BUILD_UV_CACHE_SHARING="${BUILD_UV_CACHE_SHARING:-shared}"
UV_INDEX_URL="${UV_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"

# 流水线可能不注入代理变量，但执行机通过 SSH/ssservice 暴露了本机代理。
# 仅在明确发现 127.0.0.1:8118 正在监听时自动启用，避免改变无代理环境。
if [[ -z "${HTTP_PROXY:-${http_proxy:-}}" ]] && command -v ss >/dev/null 2>&1 \
    && ss -ltn 2>/dev/null | grep -Eq '[[:space:]]127\.0\.0\.1:8118[[:space:]]'; then
  export HTTP_PROXY=http://127.0.0.1:8118
  export HTTPS_PROXY=http://127.0.0.1:8118
  export http_proxy="$HTTP_PROXY"
  export https_proxy="$HTTPS_PROXY"
  info_proxy_detected=true
fi

die() { echo "✗ $*" >&2; exit 1; }
info() { echo "[vllm-image] $*"; }

run_remote_build() {
  [[ "$BUILD_REMOTE_EXEC" == 0 ]] || return 0
  [[ -n "$BUILD_REMOTE_HOST" ]] || return 0
  [[ "$BUILD_REMOTE_PORT" =~ ^[1-9][0-9]*$ ]] || die "BUILD_REMOTE_PORT 必须是正整数: $BUILD_REMOTE_PORT"

  local remote_script remote_env remote_target
  remote_script="/tmp/build_vllm_image_ctr.$$.sh"
  remote_env="/tmp/build_vllm_image_ctr.$$.env"
  remote_target="${BUILD_REMOTE_USER}@${BUILD_REMOTE_HOST}"
  local -a ssh_cmd=(ssh -o BatchMode=yes
    -o "ProxyCommand=$BUILD_REMOTE_PROXY_COMMAND"
    -p "$BUILD_REMOTE_PORT" "$remote_target")

  local remote_probe remote_cpu remote_mem_mb
  remote_probe="$("${ssh_cmd[@]}" "awk '\''/MemAvailable:/ {mem=\$2} /MemTotal:/ {total=\$2} END {printf \"%s %s\\n\", total, mem}'\'' /proc/meminfo; nproc" 2>/dev/null)" \
    || die "无法通过 SSH 登录远程编译机: $remote_target"
  remote_mem_mb="$(awk 'NR==1 {print int($2 / 1024)}' <<<"$remote_probe")"
  remote_cpu="$(awk 'NR==2 {print $1}' <<<"$remote_probe")"
  info "远程资源: CPU=${remote_cpu:-unknown}，MemAvailable=${remote_mem_mb:-unknown}MiB"
  if [[ "$BUILD_REMOTE_AUTO_TUNE" == true && -z "$BUILD_MAX_JOBS_WAS_SET" && -z "$BUILD_NVCC_THREADS_WAS_SET" ]]; then
    if [[ "${remote_mem_mb:-0}" -lt 32768 ]]; then
      BUILD_MAX_JOBS=1
      BUILD_NVCC_THREADS=1
    elif [[ "${remote_mem_mb:-0}" -lt 65536 ]]; then
      BUILD_MAX_JOBS=1
      BUILD_NVCC_THREADS=2
    else
      BUILD_MAX_JOBS=2
      BUILD_NVCC_THREADS=2
    fi
    info "远端自动并发: max_jobs=$BUILD_MAX_JOBS，nvcc_threads=$BUILD_NVCC_THREADS"
  fi

  # 通过 stdin 传脚本和环境文件，避免凭据出现在 SSH 命令行中。
  local env_name env_value
  {
    for env_name in \
      VLLM_REPO_URL VLLM_REF VLLM_SOURCE_DIR VLLM_UPDATE DOCKERFILE BUILD_CONTEXT \
      BUILD_PLATFORM BUILD_NETWORK BUILD_PROXY_URL BUILD_MAX_JOBS BUILD_NVCC_THREADS \
      BUILD_CPUS BUILD_ARGS BUILD_ENGINE INDOCKER_RUNTIME INDOCKER_RUNNER_IMAGE \
      INDOCKER_OUTPUT_DIR INDOCKER_NETWORK ALPINE_MIRROR BUILDX_BUILDER \
      BUILDX_AUTO_CREATE BUILDKIT_ADDR CTR_NAMESPACE SWR_REGISTRY SWR_REPOSITORY \
      IMAGE_TAG IMAGE_TAG_MODE SWR_USERNAME SWR_PASSWORD BUILD_OUTPUT_DIR \
      BUILD_CACHE_DIR BUILD_CACHE BUILD_UV_CACHE_SHARING HTTP_PROXY HTTPS_PROXY \
      NO_PROXY http_proxy https_proxy no_proxy UV_INDEX_URL UV_EXTRA_INDEX_URL \
      PIP_INDEX_URL PIP_EXTRA_INDEX_URL; do
      if [[ -v "$env_name" ]]; then
        env_value="${!env_name}"
        if [[ "$env_name" == HTTP_PROXY || "$env_name" == HTTPS_PROXY ||
              "$env_name" == http_proxy || "$env_name" == https_proxy ]]; then
          if [[ -n "$BUILD_REMOTE_PROXY_URL" ]]; then
            env_value="$BUILD_REMOTE_PROXY_URL"
          elif [[ "$env_value" =~ ^https?://(127\.0\.0\.1|localhost)(:|/) ]]; then
            continue
          fi
        fi
        printf '%s=%q\n' "$env_name" "$env_value"
      fi
    done
  } >"$remote_env"

  info "远程编译主机: $remote_target"
  info "SSH ProxyCommand: $BUILD_REMOTE_PROXY_COMMAND"
  "${ssh_cmd[@]}" "mkdir -p /tmp && cat > '$remote_script' && chmod 700 '$remote_script'" <"$0"
  "${ssh_cmd[@]}" "cat > '$remote_env'" <"$remote_env"
  rm -f "$remote_env"
  set +e
  "${ssh_cmd[@]}" "set -a; . '$remote_env'; set +a; BUILD_REMOTE_HOST= BUILD_REMOTE_EXEC=1 IMAGE_TAG_MODE=explicit bash '$remote_script'; rc=\$?; rm -f '$remote_script' '$remote_env'; exit \$rc"
  local rc=$?
  set -e
  rm -f "$remote_env"
  return "$rc"
}

run_remote_build

[[ -n "$IMAGE_TAG" ]] || die "必须设置 IMAGE_TAG"
[[ "$SWR_REGISTRY" != */ ]] || SWR_REGISTRY="${SWR_REGISTRY%/}"
[[ "$SWR_REPOSITORY" != /* ]] || SWR_REPOSITORY="${SWR_REPOSITORY#/}"
IMAGE="${SWR_REGISTRY}/${SWR_REPOSITORY}:${IMAGE_TAG}"

quote_cmd() {
  local arg
  printf '%q ' "$@"
  printf '\n'
}

ensure_source() {
  if [[ -d "$VLLM_SOURCE_DIR/.git" ]]; then
    if [[ "$VLLM_UPDATE" == true ]]; then
      info "更新源码: $VLLM_SOURCE_DIR@$VLLM_REF"
      if git -C "$VLLM_SOURCE_DIR" fetch --tags --prune origin "$VLLM_REF"; then
        ref_commit="$(git -C "$VLLM_SOURCE_DIR" rev-parse --verify "${VLLM_REF}^{commit}" 2>/dev/null || true)"
        [[ -n "$ref_commit" ]] || ref_commit="$(git -C "$VLLM_SOURCE_DIR" rev-parse --verify FETCH_HEAD^{commit} 2>/dev/null || true)"
      else
        # 刷新远端引用仅用于诊断，不能将无效引用静默替换成默认分支。
        git -C "$VLLM_SOURCE_DIR" fetch --tags --prune origin || true
        ref_commit="$(git -C "$VLLM_SOURCE_DIR" rev-parse --verify "${VLLM_REF}^{commit}" 2>/dev/null || true)"
      fi
      [[ -n "$ref_commit" ]] || die "无法解析源码引用: $VLLM_REF（请使用存在的分支、标签或提交，例如 v0.30.0）"
      git -C "$VLLM_SOURCE_DIR" checkout --detach "$ref_commit"
    fi
  elif [[ -e "$VLLM_SOURCE_DIR" ]]; then
    die "源码目录不是 Git checkout: $VLLM_SOURCE_DIR"
  else
    info "克隆源码: $VLLM_REPO_URL@$VLLM_REF"
    mkdir -p "$(dirname "$VLLM_SOURCE_DIR")"
    git clone --depth 1 --branch "$VLLM_REF" "$VLLM_REPO_URL" "$VLLM_SOURCE_DIR"
  fi
}

ensure_buildx_builder() {
  [[ "$BUILDX_AUTO_CREATE" == true || "$BUILDX_AUTO_CREATE" == false ]] || die "BUILDX_AUTO_CREATE 必须是 true 或 false: $BUILDX_AUTO_CREATE"
  [[ "$BUILDX_AUTO_CREATE" == true ]] || return 0

  local inspect_output proxy_value expected_proxy
  expected_proxy="${BUILD_PROXY_URL:-${HTTPS_PROXY:-${https_proxy:-}}}"
  if docker buildx inspect "$BUILDX_BUILDER" >/dev/null 2>&1; then
    inspect_output="$(docker buildx inspect "$BUILDX_BUILDER" 2>/dev/null || true)"
    if [[ -n "$expected_proxy" ]] && ! grep -Fq 'env.https_proxy' <<<"$inspect_output"; then
      info "Buildx builder=$BUILDX_BUILDER 缺少代理配置，自动重建"
      docker buildx rm "$BUILDX_BUILDER" >/dev/null
    else
      docker buildx use "$BUILDX_BUILDER" >/dev/null
      return 0
    fi
  fi

  local create_args=(docker buildx create
    --name "$BUILDX_BUILDER"
    --driver docker-container
    --driver-opt network=host)
  proxy_value="${BUILD_PROXY_URL:-${HTTP_PROXY:-${http_proxy:-}}}"
  [[ -n "$proxy_value" ]] && create_args+=(--driver-opt "env.http_proxy=$proxy_value")
  proxy_value="${BUILD_PROXY_URL:-${HTTPS_PROXY:-${https_proxy:-}}}"
  [[ -n "$proxy_value" ]] && create_args+=(--driver-opt "env.https_proxy=$proxy_value")
  "${create_args[@]}" --use >/dev/null
  docker buildx inspect "$BUILDX_BUILDER" --bootstrap >/dev/null
  info "Buildx builder=$BUILDX_BUILDER 已就绪"
}

resolve_indocker_runtime() {
  case "$INDOCKER_RUNTIME" in
    auto)
      if command -v docker >/dev/null && docker info >/dev/null 2>&1; then INDOCKER_RUNTIME=docker
      elif command -v nerdctl >/dev/null && nerdctl -n "$CTR_NAMESPACE" info >/dev/null 2>&1; then INDOCKER_RUNTIME=nerdctl
      elif command -v ctr >/dev/null && command -v buildctl >/dev/null; then INDOCKER_RUNTIME=ctr
      else die "indocker 缺少可用外层运行时：需要 Docker、nerdctl 或 ctr+buildctl"; fi
      ;;
    docker|nerdctl|ctr) ;;
    *) die "INDOCKER_RUNTIME 必须是 auto、docker、nerdctl 或 ctr" ;;
  esac
  case "$INDOCKER_RUNTIME" in
    docker) command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "Docker daemon 不可用" ;;
    nerdctl) command -v nerdctl >/dev/null || die "缺少 nerdctl" ;;
    ctr) command -v ctr >/dev/null || die "缺少 ctr" ;;
  esac
}

ensure_indocker_runner() {
  local runner_context="$SCRIPT_DIR/indocker"
  local -a runner_build_args=(--network=host)
  local proxy_name proxy_value

  # The runner itself installs apk packages while it is being built.  Pass the
  # same proxy settings used by the inner dockerd; otherwise a localhost proxy
  # is lost at this outer Docker build boundary.
  for proxy_name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    proxy_value="${!proxy_name:-}"
    [[ -n "$proxy_value" ]] && runner_build_args+=(--build-arg "${proxy_name}=${proxy_value}")
  done
  runner_build_args+=(--build-arg "ALPINE_MIRROR=${ALPINE_MIRROR}")
  case "$INDOCKER_RUNTIME" in
    docker)
      if ! docker image inspect "$INDOCKER_RUNNER_IMAGE" >/dev/null 2>&1; then
        info "构建 indocker runner: $INDOCKER_RUNNER_IMAGE"
        docker build "${runner_build_args[@]}" -t "$INDOCKER_RUNNER_IMAGE" "$runner_context"
      fi
      ;;
    nerdctl)
      if ! nerdctl -n "$CTR_NAMESPACE" image inspect "$INDOCKER_RUNNER_IMAGE" >/dev/null 2>&1; then
        info "构建 indocker runner: $INDOCKER_RUNNER_IMAGE"
        nerdctl -n "$CTR_NAMESPACE" build "${runner_build_args[@]}" -t "$INDOCKER_RUNNER_IMAGE" "$runner_context"
      fi
      ;;
    ctr)
      ctr -n "$CTR_NAMESPACE" images ls -q | grep -Fxq "$INDOCKER_RUNNER_IMAGE" || die "ctr 模式找不到 runner 镜像，请先导入 $INDOCKER_RUNNER_IMAGE"
      ;;
  esac
}

indocker_build_args_text() {
  local i value=''
  for ((i=0; i<${#docker_build_args[@]}; i++)); do
    if [[ "${docker_build_args[i]}" == --build-arg && $((i+1)) -lt ${#docker_build_args[@]} ]]; then
      value+="${docker_build_args[i+1]}\n"
      ((i++))
    fi
  done
  printf '%b' "$value"
}

indocker_proxy_env_args() {
  local -a result=()
  local name value
  for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    value="${!name:-}"
    [[ -n "$value" ]] || continue
    result+=(-e "${name}=${value}")
  done
  ((${#result[@]})) || return 0
  printf '%q ' "${result[@]}"
}

build_args=()
nerdctl_build_args=()
docker_build_args=()
if [[ -n "$BUILD_ARGS" ]]; then
  while IFS= read -r build_arg; do
    [[ -z "$build_arg" ]] && continue
    [[ "$build_arg" == *=* ]] || die "BUILD_ARGS 每行必须是 KEY=VALUE: $build_arg"
    build_args+=("--opt" "build-arg:${build_arg}")
    nerdctl_build_args+=("--build-arg" "$build_arg")
    docker_build_args+=("--build-arg" "$build_arg")
  done <<< "$BUILD_ARGS"
fi

# 将执行机的网络与 Python 包源传入 Dockerfile 的 RUN 步骤（例如 uv 下载
# FlashInfer 和 uv 自身）。显式 BUILD_ARGS 优先，避免自动注入覆盖用户配置。
for build_env_name in \
  HTTP_PROXY HTTPS_PROXY NO_PROXY \
  PIP_INDEX_URL PIP_EXTRA_INDEX_URL UV_INDEX_URL UV_EXTRA_INDEX_URL; do
  build_env_lower="${build_env_name,,}"
  build_env_value="${!build_env_name:-${!build_env_lower:-}}"
  if [[ -n "$BUILD_PROXY_URL" && ( "$build_env_name" == HTTP_PROXY || "$build_env_name" == HTTPS_PROXY ) ]]; then
    build_env_value="$BUILD_PROXY_URL"
  fi
  if [[ "$build_env_name" == NO_PROXY && -n "$build_env_value" ]]; then
    # httpx/puccinialin 在 Rust wheel 构建时无法解析 NO_PROXY 中的
    # `[::1]`（会误报 Invalid port: ':1]'），使用无括号 IPv6 形式。
    build_env_value="${build_env_value//\[::1\]/::1}"
  fi
  [[ -n "$build_env_value" ]] || continue
  if ! printf '%s\n' "$BUILD_ARGS" | grep -Fq "${build_env_name}="; then
    build_args+=("--opt" "build-arg:${build_env_name}=${build_env_value}")
    nerdctl_build_args+=("--build-arg" "${build_env_name}=${build_env_value}")
    docker_build_args+=("--build-arg" "${build_env_name}=${build_env_value}")
  fi
done

cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1')"
if [[ -z "$BUILD_CPUS" ]]; then
  BUILD_CPUS=$((cpu_count / 2))
  ((BUILD_CPUS >= 1)) || BUILD_CPUS=1
fi
[[ "$BUILD_MAX_JOBS" =~ ^[1-9][0-9]*$ ]] || die "BUILD_MAX_JOBS 必须是正整数: $BUILD_MAX_JOBS"
[[ "$BUILD_NVCC_THREADS" =~ ^[1-9][0-9]*$ ]] || die "BUILD_NVCC_THREADS 必须是正整数: $BUILD_NVCC_THREADS"
[[ "$BUILD_CPUS" =~ ^[1-9][0-9]*$ ]] || die "BUILD_CPUS 必须是正整数: $BUILD_CPUS"
build_args+=("--opt" "build-arg:max_jobs=$BUILD_MAX_JOBS")
build_args+=("--opt" "build-arg:nvcc_threads=$BUILD_NVCC_THREADS")
nerdctl_build_args+=("--build-arg" "max_jobs=$BUILD_MAX_JOBS")
nerdctl_build_args+=("--build-arg" "nvcc_threads=$BUILD_NVCC_THREADS")
docker_build_args+=("--build-arg" "max_jobs=$BUILD_MAX_JOBS")
docker_build_args+=("--build-arg" "nvcc_threads=$BUILD_NVCC_THREADS")

build_cache_args=()
nerdctl_cache_args=()
docker_buildx_cache_args=()
if [[ "$BUILD_CACHE" == true ]]; then
  if [[ "$DRY_RUN" != true ]]; then
    mkdir -p "$BUILD_CACHE_DIR"
  fi
  build_cache_args+=("--import-cache" "type=local,src=$BUILD_CACHE_DIR"
    "--export-cache" "type=local,dest=$BUILD_CACHE_DIR,mode=max")
  nerdctl_cache_args+=("--cache-from" "type=local,src=$BUILD_CACHE_DIR"
    "--cache-to" "type=local,dest=$BUILD_CACHE_DIR,mode=max")
  docker_buildx_cache_args+=("--cache-from" "type=local,src=$BUILD_CACHE_DIR"
    "--cache-to" "type=local,dest=$BUILD_CACHE_DIR,mode=max")
elif [[ "$BUILD_CACHE" != false ]]; then
  die "BUILD_CACHE 必须是 true 或 false: $BUILD_CACHE"
fi

context_path="$VLLM_SOURCE_DIR/$BUILD_CONTEXT"
if [[ "$DRY_RUN" == true && "$BUILD_ENGINE" == auto ]]; then
  # 预演也按真实执行顺序选择构建器，方便确认是否会命中 Buildx 缓存。
  if command -v docker >/dev/null && docker info >/dev/null 2>&1 \
      && docker buildx version >/dev/null 2>&1; then BUILD_ENGINE=docker-buildx
  elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then BUILD_ENGINE=docker
  elif command -v buildctl >/dev/null; then BUILD_ENGINE=buildctl
  elif command -v nerdctl >/dev/null; then BUILD_ENGINE=nerdctl
  fi
fi
if [[ "$DRY_RUN" != true ]]; then
  [[ -n "$SWR_USERNAME" ]] || die "必须设置 SWR_USERNAME"
  [[ -n "$SWR_PASSWORD" ]] || die "必须设置 SWR_PASSWORD"
  command -v git >/dev/null || die "缺少 git"
  command -v ctr >/dev/null || die "缺少 ctr"
    case "$BUILD_ENGINE" in
    auto)
      # 优先使用 Buildx：它支持可持久化的本地 layer cache；只有 Buildx
      # 不可用时才回退到普通 Docker/indocker。显式指定 BUILD_ENGINE 仍优先。
      if command -v docker >/dev/null && docker info >/dev/null 2>&1 \
          && docker buildx version >/dev/null 2>&1; then BUILD_ENGINE=docker-buildx
      elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then BUILD_ENGINE=docker
      elif command -v buildctl >/dev/null; then BUILD_ENGINE=buildctl
      elif command -v nerdctl >/dev/null; then BUILD_ENGINE=nerdctl
      else die "缺少可用构建器：请安装 Docker（推荐含 Buildx）、buildctl+buildkitd 或 nerdctl+buildkitd"; fi
      ;;
    buildctl|nerdctl|docker) command -v "$BUILD_ENGINE" >/dev/null || die "缺少 $BUILD_ENGINE" ;;
    indocker) command -v docker >/dev/null || command -v nerdctl >/dev/null || command -v ctr >/dev/null || die "缺少 indocker 外层运行时" ;;
    docker-buildx)
      command -v docker >/dev/null || die "缺少 docker"
      docker buildx version >/dev/null 2>&1 || die "缺少 Docker Buildx，请安装 buildx 或改用可用的 BUILD_ENGINE"
      ;;
    *) die "BUILD_ENGINE 必须是 auto、docker、buildctl、nerdctl 或 docker-buildx" ;;
  esac
  if [[ "$BUILD_ENGINE" == docker || "$BUILD_ENGINE" == docker-buildx ]]; then
    docker info >/dev/null 2>&1 || die "docker 命令存在但 Docker daemon 不可用，请启动 Docker 或改用可用的 BUILD_ENGINE"
  fi
  if [[ "$BUILD_ENGINE" == docker-buildx ]]; then
    ensure_buildx_builder
  fi
  if [[ "$BUILD_ENGINE" == indocker ]]; then
    resolve_indocker_runtime
    ensure_indocker_runner
  fi
  ensure_source
  [[ -d "$context_path" ]] || die "构建上下文不存在: $context_path"
  [[ -f "$VLLM_SOURCE_DIR/$DOCKERFILE" ]] || die "Dockerfile 不存在: $VLLM_SOURCE_DIR/$DOCKERFILE"
  mkdir -p "$BUILD_OUTPUT_DIR"
fi
archive="$BUILD_OUTPUT_DIR/vllm-${IMAGE_TAG//[^A-Za-z0-9_.-]/_}.oci.tar"
build_dockerfile="$VLLM_SOURCE_DIR/$DOCKERFILE"
if [[ "$BUILD_UV_CACHE_SHARING" != private && "$BUILD_UV_CACHE_SHARING" != locked && "$BUILD_UV_CACHE_SHARING" != shared ]]; then
  die "BUILD_UV_CACHE_SHARING 必须是 private、locked 或 shared: $BUILD_UV_CACHE_SHARING"
elif [[ "$DRY_RUN" != true && "$BUILD_ENGINE" != indocker ]]; then
  # vLLM 的 base/runtime 阶段会并行执行 uv。默认 cache mount 是 shared，
  # 两个 uv 进程可能争用同一个 wheel lock，等待 300 秒后失败。仅生成
  # 构建副本并设置并发策略，不修改源码 checkout。
  build_dockerfile="$BUILD_OUTPUT_DIR/.vllm-Dockerfile-uv-$BUILD_UV_CACHE_SHARING"
  sed "s#--mount=type=cache,target=/opt/uv/cache#--mount=type=cache,target=/opt/uv/cache,sharing=$BUILD_UV_CACHE_SHARING#g" \
    "$VLLM_SOURCE_DIR/$DOCKERFILE" > "$build_dockerfile"
fi
if [[ -z "$INDOCKER_OUTPUT_DIR" ]]; then INDOCKER_OUTPUT_DIR="$BUILD_OUTPUT_DIR"; fi
mkdir -p "$INDOCKER_OUTPUT_DIR" 2>/dev/null || true
if [[ "$BUILD_ENGINE" == indocker ]]; then
  archive="$INDOCKER_OUTPUT_DIR/vllm-${IMAGE_TAG//[^A-Za-z0-9_.-]/_}.oci.tar"
fi
if [[ "$DRY_RUN" == true && "$BUILD_ENGINE" == indocker && "$INDOCKER_RUNTIME" == auto ]]; then
  if command -v docker >/dev/null; then INDOCKER_RUNTIME=docker
  elif command -v nerdctl >/dev/null; then INDOCKER_RUNTIME=nerdctl
  else INDOCKER_RUNTIME=ctr
  fi
fi

if [[ "$BUILD_ENGINE" == nerdctl ]]; then
  build_cmd=(nerdctl -n "$CTR_NAMESPACE" build
    --platform "$BUILD_PLATFORM"
    --file "$build_dockerfile"
    --tag "$IMAGE"
    "${nerdctl_build_args[@]}"
    "${nerdctl_cache_args[@]}"
    "$context_path")
elif [[ "$BUILD_ENGINE" == docker ]]; then
  build_cmd=(docker build
    --network "$BUILD_NETWORK"
    --cpu-period 100000
    --cpu-quota "$((BUILD_CPUS * 100000))"
    --platform "$BUILD_PLATFORM"
    --file "$build_dockerfile"
    --tag "$IMAGE"
    "${docker_build_args[@]}"
    "$context_path")
elif [[ "$BUILD_ENGINE" == docker-buildx ]]; then
  build_cmd=(docker buildx build --builder "$BUILDX_BUILDER"
    --allow network.host
    --network "$BUILD_NETWORK"
    --platform "$BUILD_PLATFORM"
    --file "$build_dockerfile"
    --tag "$IMAGE"
    "${docker_build_args[@]}"
    "${docker_buildx_cache_args[@]}"
    --output "type=oci,dest=$archive"
    "$context_path")
elif [[ "$BUILD_ENGINE" == indocker ]]; then
  indocker_args_text="$(indocker_build_args_text)"
  read -r -a indocker_proxy_args <<< "$(indocker_proxy_env_args)"
  case "$INDOCKER_RUNTIME" in
    docker)
      build_cmd=(docker run --rm --privileged --network "$INDOCKER_NETWORK"
        -v "$VLLM_SOURCE_DIR:/workspace/source:ro"
        -v "$INDOCKER_OUTPUT_DIR:/output"
        -v "$BUILD_CACHE_DIR/dind:/var/lib/docker"
        -e "IMAGE_REF=$IMAGE"
        -e "SOURCE_DIR=/workspace/source"
        -e "DOCKERFILE_PATH=/workspace/source/$DOCKERFILE"
        -e "BUILD_CONTEXT_PATH=/workspace/source/$BUILD_CONTEXT"
        -e "OUTPUT_ARCHIVE=/output/$(basename "$archive")"
        -e "BUILD_NETWORK=$BUILD_NETWORK"
        -e "BUILD_CPUS=$BUILD_CPUS"
        -e "BUILD_ARGS_TEXT=$indocker_args_text"
        "${indocker_proxy_args[@]}"
        "$INDOCKER_RUNNER_IMAGE")
      ;;
    nerdctl)
      build_cmd=(nerdctl -n "$CTR_NAMESPACE" run --rm --privileged --net-host
        -v "$VLLM_SOURCE_DIR:/workspace/source:ro"
        -v "$INDOCKER_OUTPUT_DIR:/output"
        -v "$BUILD_CACHE_DIR/dind:/var/lib/docker"
        -e "IMAGE_REF=$IMAGE" -e "SOURCE_DIR=/workspace/source"
        -e "DOCKERFILE_PATH=/workspace/source/$DOCKERFILE"
        -e "BUILD_CONTEXT_PATH=/workspace/source/$BUILD_CONTEXT"
        -e "OUTPUT_ARCHIVE=/output/$(basename "$archive")"
        -e "BUILD_NETWORK=$BUILD_NETWORK" -e "BUILD_CPUS=$BUILD_CPUS" -e "BUILD_ARGS_TEXT=$indocker_args_text"
        "${indocker_proxy_args[@]}"
        "$INDOCKER_RUNNER_IMAGE")
      ;;
    ctr)
      build_cmd=(ctr -n "$CTR_NAMESPACE" run --rm --privileged --net-host
        --mount "type=bind,src=$VLLM_SOURCE_DIR,dst=/workspace/source,options=rbind:ro"
        --mount "type=bind,src=$INDOCKER_OUTPUT_DIR,dst=/output,options=rbind:rw"
        --mount "type=bind,src=$BUILD_CACHE_DIR/dind,dst=/var/lib/docker,options=rbind:rw"
        --env "IMAGE_REF=$IMAGE" --env "SOURCE_DIR=/workspace/source"
        --env "DOCKERFILE_PATH=/workspace/source/$DOCKERFILE"
        --env "BUILD_CONTEXT_PATH=/workspace/source/$BUILD_CONTEXT"
        --env "OUTPUT_ARCHIVE=/output/$(basename "$archive")"
        --env "BUILD_NETWORK=$BUILD_NETWORK" --env "BUILD_CPUS=$BUILD_CPUS" --env "BUILD_ARGS_TEXT=$indocker_args_text"
        "${indocker_proxy_args[@]}"
        "$INDOCKER_RUNNER_IMAGE" vllm-indocker-runner)
      ;;
  esac
else
  build_cmd=(buildctl --addr "$BUILDKIT_ADDR" build
    --frontend dockerfile.v0
    --local "context=$context_path"
    --local "dockerfile=$VLLM_SOURCE_DIR"
    --opt "filename=$DOCKERFILE"
    --opt "platform=$BUILD_PLATFORM"
    "${build_args[@]}"
    "${build_cache_args[@]}"
    --output "type=oci,name=$IMAGE,dest=$archive")
fi
import_cmd=(ctr -n "$CTR_NAMESPACE" images import "$archive")
push_cmd=(ctr -n "$CTR_NAMESPACE" images push --user "${SWR_USERNAME}:***" "$IMAGE")

info "目标镜像: $IMAGE"
info "源码仓库: $VLLM_REPO_URL"
info "源码: $VLLM_SOURCE_DIR@$VLLM_REF"
info "Dockerfile: $DOCKERFILE"
info "构建器: $BUILD_ENGINE${BUILD_ENGINE:+/$INDOCKER_RUNTIME}，编译并发: $BUILD_MAX_JOBS，nvcc 线程: $BUILD_NVCC_THREADS"
info "编译缓存: $([[ "$BUILD_CACHE" == true ]] && printf '%s' "$BUILD_CACHE_DIR" || printf '关闭')"
[[ "$BUILD_ENGINE" != indocker ]] && info "uv 缓存并发: $BUILD_UV_CACHE_SHARING"
if [[ "$BUILD_ENGINE" == docker-buildx && -z "$BUILD_PROXY_URL" && "${HTTP_PROXY:-${http_proxy:-}}" =~ ^https?://(127\.0\.0\.1|localhost)(:|/) ]]; then
  info "警告：当前代理仅绑定宿主机回环地址，BuildKit RUN 可能无法访问；请设置 BUILD_PROXY_URL 为构建网络可达的代理地址"
fi
if [[ "$BUILD_ENGINE" == docker && "$BUILD_CACHE" == true ]]; then
  info "Docker Buildx 不可用，使用 Docker daemon 内置层缓存；如需 BUILD_CACHE_DIR，请安装 Buildx"
fi
info "构建命令: $(quote_cmd "${build_cmd[@]}")"
info "导入命令: $(quote_cmd "${import_cmd[@]}")"
info "推送命令: $(quote_cmd "${push_cmd[@]}")"

if [[ "$DRY_RUN" == true ]]; then
  exit 0
fi

info "开始在流水线执行机编译镜像"
"${build_cmd[@]}"
if [[ "$BUILD_ENGINE" == indocker ]]; then
  [[ -s "$archive" ]] || die "indocker 未生成 OCI/tar 包: $archive"
  info "导入 indocker 镜像归档: $archive"
  ctr -n "$CTR_NAMESPACE" images import "$archive"
  if ! ctr -n "$CTR_NAMESPACE" images ls -q | grep -Fxq "$IMAGE" \
      && ctr -n "$CTR_NAMESPACE" images ls -q | grep -Fxq "docker.io/$IMAGE"; then
    ctr -n "$CTR_NAMESPACE" images tag "docker.io/$IMAGE" "$IMAGE"
  fi
elif [[ "$BUILD_ENGINE" == buildctl || "$BUILD_ENGINE" == docker-buildx ]]; then
  [[ -s "$archive" ]] || die "BuildKit 未生成 OCI 包: $archive"
  info "导入镜像到 containerd namespace=$CTR_NAMESPACE"
  ctr -n "$CTR_NAMESPACE" images import --base-name "$IMAGE" "$archive"
elif [[ "$BUILD_ENGINE" == nerdctl ]]; then
  info "nerdctl 已直接将镜像写入 containerd namespace=$CTR_NAMESPACE"
else
  info "导出 Docker 镜像并导入 containerd namespace=$CTR_NAMESPACE"
  docker save "$IMAGE" | ctr -n "$CTR_NAMESPACE" images import -
fi
if ! ctr -n "$CTR_NAMESPACE" images ls -q | grep -Fxq "$IMAGE"; then
  ctr -n "$CTR_NAMESPACE" images ls -q | grep -Fxq "docker.io/$IMAGE" || die "镜像未成功导入: $IMAGE"
fi

info "推送镜像到 SWR: $SWR_REGISTRY"
ctr -n "$CTR_NAMESPACE" images push --user "$SWR_USERNAME:$SWR_PASSWORD" "$IMAGE"
info "镜像推送成功: $IMAGE"
