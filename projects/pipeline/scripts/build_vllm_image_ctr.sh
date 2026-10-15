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
  BUILD_ARGS          额外构建参数，每行一个 KEY=VALUE
  BUILDKIT_ADDR       BuildKit 地址，默认 unix:///run/buildkit/buildkitd.sock
  CTR_NAMESPACE       containerd 命名空间，默认 k8s.io
  SWR_REGISTRY        SWR registry，例如 swr.cn-southwest-2.myhuaweicloud.com
  SWR_REPOSITORY      SWR 仓库路径，例如 dataartsfabric/vllm
  IMAGE_TAG           镜像标签，必填
  SWR_USERNAME        SWR 用户名，非 dry-run 必填
  SWR_PASSWORD        SWR 密码或 Token，非 dry-run 必填
  BUILD_OUTPUT_DIR    OCI 临时包目录，默认 /tmp/vllm-image-build
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
BUILD_ARGS="${BUILD_ARGS:-}"
BUILDKIT_ADDR="${BUILDKIT_ADDR:-unix:///run/buildkit/buildkitd.sock}"
CTR_NAMESPACE="${CTR_NAMESPACE:-k8s.io}"
SWR_REGISTRY="${SWR_REGISTRY:-swr.cn-southwest-2.myhuaweicloud.com}"
SWR_REPOSITORY="${SWR_REPOSITORY:-vllm}"
IMAGE_TAG="${IMAGE_TAG:-}"
SWR_USERNAME="${SWR_USERNAME:-}"
SWR_PASSWORD="${SWR_PASSWORD:-}"
BUILD_OUTPUT_DIR="${BUILD_OUTPUT_DIR:-/tmp/vllm-image-build}"

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
if [[ -n "$BUILD_ARGS" ]]; then
  while IFS= read -r build_arg; do
    [[ -z "$build_arg" ]] && continue
    [[ "$build_arg" == *=* ]] || die "BUILD_ARGS 每行必须是 KEY=VALUE: $build_arg"
    build_args+=("--opt" "build-arg:${build_arg}")
  done <<< "$BUILD_ARGS"
fi

context_path="$VLLM_SOURCE_DIR/$BUILD_CONTEXT"
if [[ "$DRY_RUN" != true ]]; then
  [[ -n "$SWR_USERNAME" ]] || die "必须设置 SWR_USERNAME"
  [[ -n "$SWR_PASSWORD" ]] || die "必须设置 SWR_PASSWORD"
  command -v git >/dev/null || die "缺少 git"
  command -v buildctl >/dev/null || die "缺少 buildctl"
  command -v ctr >/dev/null || die "缺少 ctr"
  ensure_source
  [[ -d "$context_path" ]] || die "构建上下文不存在: $context_path"
  [[ -f "$VLLM_SOURCE_DIR/$DOCKERFILE" ]] || die "Dockerfile 不存在: $VLLM_SOURCE_DIR/$DOCKERFILE"
  mkdir -p "$BUILD_OUTPUT_DIR"
fi
archive="$BUILD_OUTPUT_DIR/vllm-${IMAGE_TAG//[^A-Za-z0-9_.-]/_}.oci.tar"

build_cmd=(buildctl --addr "$BUILDKIT_ADDR" build
  --frontend dockerfile.v0
  --local "context=$context_path"
  --local "dockerfile=$VLLM_SOURCE_DIR"
  --opt "filename=$DOCKERFILE"
  --opt "platform=$BUILD_PLATFORM"
  "${build_args[@]}"
  --output "type=oci,name=$IMAGE,dest=$archive")
import_cmd=(ctr -n "$CTR_NAMESPACE" images import "$archive")
push_cmd=(ctr -n "$CTR_NAMESPACE" images push --user "${SWR_USERNAME}:***" "$IMAGE")

info "目标镜像: $IMAGE"
info "源码仓库: $VLLM_REPO_URL"
info "源码: $VLLM_SOURCE_DIR@$VLLM_REF"
info "Dockerfile: $DOCKERFILE"
info "构建命令: $(quote_cmd "${build_cmd[@]}")"
info "导入命令: $(quote_cmd "${import_cmd[@]}")"
info "推送命令: $(quote_cmd "${push_cmd[@]}")"

if [[ "$DRY_RUN" == true ]]; then
  exit 0
fi

info "开始使用 BuildKit 编译 OCI 镜像"
"${build_cmd[@]}"
[[ -s "$archive" ]] || die "BuildKit 未生成 OCI 包: $archive"

info "导入镜像到 containerd namespace=$CTR_NAMESPACE"
ctr -n "$CTR_NAMESPACE" images import --base-name "$IMAGE" "$archive"
ctr -n "$CTR_NAMESPACE" images ls -q "$IMAGE" | grep -Fxq "$IMAGE" || die "镜像未成功导入: $IMAGE"

info "推送镜像到 SWR: $SWR_REGISTRY"
ctr -n "$CTR_NAMESPACE" images push --user "$SWR_USERNAME:$SWR_PASSWORD" "$IMAGE"
info "镜像推送成功: $IMAGE"
