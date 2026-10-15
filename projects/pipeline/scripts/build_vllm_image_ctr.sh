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
  BUILD_MAX_JOBS      编译并发数，默认执行机 CPU 数的一半
  BUILD_ARGS          额外构建参数，每行一个 KEY=VALUE
  BUILD_ENGINE        构建器：auto、buildctl、nerdctl、docker 或 docker-buildx，默认 auto
  BUILDKIT_ADDR       BuildKit 地址，默认 unix:///run/buildkit/buildkitd.sock
  CTR_NAMESPACE       containerd 命名空间，默认 k8s.io
  SWR_REGISTRY        SWR registry，例如 swr.cn-southwest-2.myhuaweicloud.com
  SWR_REPOSITORY      SWR 仓库路径，例如 dataartsfabric/vllm
  IMAGE_TAG           镜像标签，必填
  SWR_USERNAME        SWR 用户名，非 dry-run 必填
  SWR_PASSWORD        SWR 密码或 Token，非 dry-run 必填
  BUILD_OUTPUT_DIR    OCI 临时包目录，默认 /tmp/vllm-image-build
  BUILD_CACHE_DIR     BuildKit 本地缓存目录，默认 /tmp/vllm-build-cache
  BUILD_CACHE         是否启用本地层缓存，默认 true
EOF
}

DRY_RUN=false
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
BUILD_MAX_JOBS="${BUILD_MAX_JOBS:-}"
BUILD_ARGS="${BUILD_ARGS:-}"
BUILD_ENGINE="${BUILD_ENGINE:-auto}"
BUILDKIT_ADDR="${BUILDKIT_ADDR:-unix:///run/buildkit/buildkitd.sock}"
CTR_NAMESPACE="${CTR_NAMESPACE:-k8s.io}"
SWR_REGISTRY="${SWR_REGISTRY:-swr.cn-southwest-2.myhuaweicloud.com}"
SWR_REPOSITORY="${SWR_REPOSITORY:-vllm}"
IMAGE_TAG="${IMAGE_TAG:-}"
SWR_USERNAME="${SWR_USERNAME:-}"
SWR_PASSWORD="${SWR_PASSWORD:-}"
BUILD_OUTPUT_DIR="${BUILD_OUTPUT_DIR:-/tmp/vllm-image-build}"
BUILD_CACHE_DIR="${BUILD_CACHE_DIR:-/tmp/vllm-build-cache}"
BUILD_CACHE="${BUILD_CACHE:-true}"

die() { echo "✗ $*" >&2; exit 1; }
info() { echo "[vllm-image] $*"; }

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
      git -C "$VLLM_SOURCE_DIR" fetch --tags --prune origin
      git -C "$VLLM_SOURCE_DIR" checkout --detach "$VLLM_REF"
    fi
  elif [[ -e "$VLLM_SOURCE_DIR" ]]; then
    die "源码目录不是 Git checkout: $VLLM_SOURCE_DIR"
  else
    info "克隆源码: $VLLM_REPO_URL@$VLLM_REF"
    mkdir -p "$(dirname "$VLLM_SOURCE_DIR")"
    git clone --depth 1 --branch "$VLLM_REF" "$VLLM_REPO_URL" "$VLLM_SOURCE_DIR"
  fi
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

if [[ -z "$BUILD_MAX_JOBS" ]]; then
  cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1')"
  BUILD_MAX_JOBS=$((cpu_count / 2))
  ((BUILD_MAX_JOBS >= 1)) || BUILD_MAX_JOBS=1
fi
[[ "$BUILD_MAX_JOBS" =~ ^[1-9][0-9]*$ ]] || die "BUILD_MAX_JOBS 必须是正整数: $BUILD_MAX_JOBS"
build_args+=("--opt" "build-arg:max_jobs=$BUILD_MAX_JOBS")
nerdctl_build_args+=("--build-arg" "max_jobs=$BUILD_MAX_JOBS")
docker_build_args+=("--build-arg" "max_jobs=$BUILD_MAX_JOBS")

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
if [[ "$DRY_RUN" != true ]]; then
  [[ -n "$SWR_USERNAME" ]] || die "必须设置 SWR_USERNAME"
  [[ -n "$SWR_PASSWORD" ]] || die "必须设置 SWR_PASSWORD"
  command -v git >/dev/null || die "缺少 git"
  command -v ctr >/dev/null || die "缺少 ctr"
    case "$BUILD_ENGINE" in
    auto)
      if command -v buildctl >/dev/null; then BUILD_ENGINE=buildctl
      elif command -v docker >/dev/null && docker buildx version >/dev/null 2>&1; then BUILD_ENGINE=docker-buildx
      elif command -v docker >/dev/null; then BUILD_ENGINE=docker
      elif command -v nerdctl >/dev/null; then BUILD_ENGINE=nerdctl
      else die "缺少可用构建器：请安装 buildctl+buildkitd、Docker、Docker Buildx 或 nerdctl+buildkitd"; fi
      ;;
    buildctl|nerdctl|docker) command -v "$BUILD_ENGINE" >/dev/null || die "缺少 $BUILD_ENGINE" ;;
    docker-buildx)
      command -v docker >/dev/null || die "缺少 docker"
      docker buildx version >/dev/null 2>&1 || die "缺少 Docker Buildx，请安装 buildx 或改用可用的 BUILD_ENGINE"
      ;;
    *) die "BUILD_ENGINE 必须是 auto、buildctl、nerdctl、docker 或 docker-buildx" ;;
  esac
  if [[ "$BUILD_ENGINE" == docker || "$BUILD_ENGINE" == docker-buildx ]]; then
    docker info >/dev/null 2>&1 || die "docker 命令存在但 Docker daemon 不可用，请启动 Docker 或改用可用的 BUILD_ENGINE"
  fi
  ensure_source
  [[ -d "$context_path" ]] || die "构建上下文不存在: $context_path"
  [[ -f "$VLLM_SOURCE_DIR/$DOCKERFILE" ]] || die "Dockerfile 不存在: $VLLM_SOURCE_DIR/$DOCKERFILE"
  mkdir -p "$BUILD_OUTPUT_DIR"
fi
archive="$BUILD_OUTPUT_DIR/vllm-${IMAGE_TAG//[^A-Za-z0-9_.-]/_}.oci.tar"

if [[ "$BUILD_ENGINE" == nerdctl ]]; then
  build_cmd=(nerdctl -n "$CTR_NAMESPACE" build
    --platform "$BUILD_PLATFORM"
    --file "$VLLM_SOURCE_DIR/$DOCKERFILE"
    --tag "$IMAGE"
    "${nerdctl_build_args[@]}"
    "${nerdctl_cache_args[@]}"
    "$context_path")
elif [[ "$BUILD_ENGINE" == docker ]]; then
  build_cmd=(docker build
    --platform "$BUILD_PLATFORM"
    --file "$VLLM_SOURCE_DIR/$DOCKERFILE"
    --tag "$IMAGE"
    "${docker_build_args[@]}"
    "$context_path")
elif [[ "$BUILD_ENGINE" == docker-buildx ]]; then
  build_cmd=(docker buildx build
    --platform "$BUILD_PLATFORM"
    --file "$VLLM_SOURCE_DIR/$DOCKERFILE"
    --tag "$IMAGE"
    "${docker_build_args[@]}"
    "${docker_buildx_cache_args[@]}"
    --output "type=oci,dest=$archive"
    "$context_path")
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
info "构建器: $BUILD_ENGINE，编译并发: $BUILD_MAX_JOBS"
info "编译缓存: $([[ "$BUILD_CACHE" == true ]] && printf '%s' "$BUILD_CACHE_DIR" || printf '关闭')"
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
if [[ "$BUILD_ENGINE" == buildctl || "$BUILD_ENGINE" == docker-buildx ]]; then
  [[ -s "$archive" ]] || die "BuildKit 未生成 OCI 包: $archive"
  info "导入镜像到 containerd namespace=$CTR_NAMESPACE"
  ctr -n "$CTR_NAMESPACE" images import --base-name "$IMAGE" "$archive"
elif [[ "$BUILD_ENGINE" == nerdctl ]]; then
  info "nerdctl 已直接将镜像写入 containerd namespace=$CTR_NAMESPACE"
else
  info "导出 Docker 镜像并导入 containerd namespace=$CTR_NAMESPACE"
  docker save "$IMAGE" | ctr -n "$CTR_NAMESPACE" images import -
fi
ctr -n "$CTR_NAMESPACE" images ls -q "$IMAGE" | grep -Fxq "$IMAGE" || die "镜像未成功导入: $IMAGE"

info "推送镜像到 SWR: $SWR_REGISTRY"
ctr -n "$CTR_NAMESPACE" images push --user "$SWR_USERNAME:$SWR_PASSWORD" "$IMAGE"
info "镜像推送成功: $IMAGE"
