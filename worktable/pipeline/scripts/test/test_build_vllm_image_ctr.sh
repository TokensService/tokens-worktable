#!/usr/bin/env bash
set -euo pipefail

# build_vllm_image_ctr.sh flashinfer wheelhouse 契约测试：
# 预下载复用、Dockerfile 本地安装改写、附加构建上下文注入、关闭开关与失败路径。

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/build_vllm_image_ctr.sh"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

make_source() {
  mkdir -p "$1/docker" "$1/.git"
  cp "$work_dir/Dockerfile.fixture" "$1/docker/Dockerfile"
}

make_wheel() {
  mkdir -p "$1"
  python3 - "$1/$2" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as zf:
    zf.writestr("metadata.txt", "fake-wheel")
PY
}

make_bins() {
  mkdir -p "$work_dir/bin"
  cat >"$work_dir/bin/buildctl" <<'CTL'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$BUILDCTL_LOG"
for argument in "$@"; do
  case "$argument" in
    *dest=*) printf x >"${argument##*dest=}" ;;
  esac
done
exit 0
CTL
  cat >"$work_dir/bin/ctr" <<'CTR'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CTR_LOG"
case "$*" in
  *"images ls"*) printf '%s\n' "$CTR_IMAGE" ;;
esac
exit 0
CTR
  chmod +x "$work_dir/bin/buildctl" "$work_dir/bin/ctr"
}

run_script() {
  : >"$work_dir/buildctl.log"
  : >"$work_dir/ctr.log"
  env \
    BUILDCTL_LOG="$work_dir/buildctl.log" \
    CTR_LOG="$work_dir/ctr.log" \
    CTR_IMAGE="swr.test/vllm:testtag" \
    PATH="$work_dir/bin:$PATH" \
    VLLM_SOURCE_DIR="$work_dir/source" \
    VLLM_UPDATE=false \
    BUILD_ENGINE=buildctl \
    IMAGE_TAG_MODE=explicit \
    IMAGE_TAG=testtag \
    SWR_REGISTRY=swr.test \
    SWR_REPOSITORY=vllm \
    SWR_USERNAME=u \
    SWR_PASSWORD=p \
    BUILD_OUTPUT_DIR="$work_dir/output" \
    BUILD_CACHE=false \
    "$@" \
    bash "$script" >"$work_dir/run.log" 2>&1
}

cat >"$work_dir/Dockerfile.fixture" <<'DOCKERFILE'
ARG CUDA_VERSION=13.0.3
FROM scratch AS base
RUN --mount=type=cache,target=/opt/uv/cache echo deps
# Install FlashInfer JIT cache (requires CUDA-version-specific index URL)
# https://docs.flashinfer.ai/installation.html
ARG FLASHINFER_VERSION=0.6.18.post1
RUN --mount=type=cache,target=/opt/uv/cache \
    if [ "${INSTALL_RUBIN_PRERELEASE}" != "true" ]; then \
        uv pip install --system flashinfer-jit-cache==${FLASHINFER_VERSION} \
            --index-url https://flashinfer.ai/whl/cu$(echo $CUDA_VERSION | cut -d. -f1,2 | tr -d '.'); \
    fi
DOCKERFILE

make_bins
make_source "$work_dir/source"
make_wheel "$work_dir/wheelhouse" \
  "flashinfer_jit_cache-0.6.18.post1+cu130-cp39-abi3-manylinux_2_28_x86_64.whl"

# 场景 A：wheel 已预下载 → 复用、改写 Dockerfile、注入附加构建上下文
run_script "FLASHINFER_WHEELHOUSE_DIR=$work_dir/wheelhouse"
grep -Fq -- "context:flashinfer-wheelhouse=$work_dir/wheelhouse" "$work_dir/buildctl.log"
grep -Fq -- "filename=.vllm-Dockerfile-uv-shared-flashinfer" "$work_dir/buildctl.log"
grep -Fq -- "dockerfile=$work_dir/output" "$work_dir/buildctl.log"
rewritten="$work_dir/output/.vllm-Dockerfile-uv-shared-flashinfer"
grep -Fq -- 'COPY --from=flashinfer-wheelhouse / /opt/flashinfer-wheelhouse' "$rewritten"
grep -Fq -- 'uv pip install --system /opt/flashinfer-wheelhouse/*.whl' "$rewritten"
! grep -Fq -- 'flashinfer-jit-cache==' "$rewritten"
grep -Fq -- 'if [ "${INSTALL_RUBIN_PRERELEASE}" != "true" ]; then \' "$rewritten"
grep -Fq -- 'sharing=shared' "$rewritten"
grep -Fq -- 'https://docs.flashinfer.ai/installation.html' "$rewritten"
! grep -Fq -- 'flashinfer.ai/whl' "$rewritten"
! grep -Fq -- 'COPY --from=flashinfer-wheelhouse' "$work_dir/source/docker/Dockerfile"
grep -Fq -- '--index-url https://flashinfer.ai/whl/cu' "$work_dir/source/docker/Dockerfile"
grep -Fq -- 'flashinfer wheelhouse 已就绪' "$work_dir/run.log"
grep -Fq -- "flashinfer wheelhouse: $work_dir/wheelhouse" "$work_dir/run.log"

# 场景 B：FLASHINFER_PREDOWNLOAD=false → 保留远程安装，不注入上下文
run_script "FLASHINFER_PREDOWNLOAD=false" "BUILD_OUTPUT_DIR=$work_dir/output-b"
! grep -Fq -- 'context:flashinfer-wheelhouse' "$work_dir/buildctl.log"
grep -Fq -- 'filename=.vllm-Dockerfile-uv-shared' "$work_dir/buildctl.log"
! grep -Fq -- 'filename=.vllm-Dockerfile-uv-shared-flashinfer' "$work_dir/buildctl.log"
[[ ! -e "$work_dir/output-b/.vllm-Dockerfile-uv-shared-flashinfer" ]]
grep -Fq -- '--index-url https://flashinfer.ai/whl/cu' "$work_dir/output-b/.vllm-Dockerfile-uv-shared"

# 场景 C：Dockerfile 无 flashinfer 安装步骤 → 跳过 wheelhouse，构建正常
mkdir -p "$work_dir/source-noflash/docker" "$work_dir/source-noflash/.git"
printf '%s\n' 'ARG CUDA_VERSION=13.0.3' 'FROM scratch AS base' 'RUN echo hello' \
  >"$work_dir/source-noflash/docker/Dockerfile"
run_script "VLLM_SOURCE_DIR=$work_dir/source-noflash" "BUILD_OUTPUT_DIR=$work_dir/output-c"
! grep -Fq -- 'context:flashinfer-wheelhouse' "$work_dir/buildctl.log"
grep -Fq -- '未找到 flashinfer-jit-cache' "$work_dir/run.log"

# 场景 D：wheel 缺失且下载失败 → 快速失败并给出回退提示
mkdir -p "$work_dir/empty-wh"
set +e
run_script "FLASHINFER_WHEELHOUSE_DIR=$work_dir/empty-wh" \
  "FLASHINFER_WHL_INDEX=http://127.0.0.1:1/simple" \
  "BUILD_OUTPUT_DIR=$work_dir/output-d"
rc=$?
set -e
[[ $rc -ne 0 ]]
grep -Eq -- 'flashinfer wheel 预下载失败|缺少 python3|缺少 pip' "$work_dir/run.log"

# 场景 E：BUILD_ARGS 覆盖 FLASHINFER_VERSION → wheelhouse 按覆盖版本匹配
make_wheel "$work_dir/wh-999" \
  "flashinfer_jit_cache-9.9.9+cu130-cp39-abi3-manylinux_2_28_x86_64.whl"
run_script "FLASHINFER_WHEELHOUSE_DIR=$work_dir/wh-999" \
  "BUILD_ARGS=FLASHINFER_VERSION=9.9.9" "BUILD_OUTPUT_DIR=$work_dir/output-e"
grep -Fq -- "context:flashinfer-wheelhouse=$work_dir/wh-999" "$work_dir/buildctl.log"
grep -Fq -- 'flashinfer wheelhouse 已就绪' "$work_dir/run.log"

# 场景 F：INSTALL_RUBIN_PRERELEASE=true → Dockerfile 跳过 flashinfer 安装，不注入
run_script "FLASHINFER_WHEELHOUSE_DIR=$work_dir/wheelhouse" \
  "BUILD_ARGS=INSTALL_RUBIN_PRERELEASE=true" "BUILD_OUTPUT_DIR=$work_dir/output-f"
! grep -Fq -- 'context:flashinfer-wheelhouse' "$work_dir/buildctl.log"
grep -Fq -- 'wheelhouse 未启用' "$work_dir/run.log"

# 场景 G：不完整 wheel（空文件）→ 删除后走下载；下载失败快速退出
: >"$work_dir/wheelhouse/flashinfer_jit_cache-0.6.18.post1+cu130-cp39-abi3-manylinux_2_28_x86_64.whl"
set +e
run_script "FLASHINFER_WHEELHOUSE_DIR=$work_dir/wheelhouse" \
  "FLASHINFER_WHL_INDEX=http://127.0.0.1:1/simple" \
  "BUILD_OUTPUT_DIR=$work_dir/output-g"
rc=$?
set -e
[[ $rc -ne 0 ]]
[[ ! -e "$work_dir/wheelhouse/flashinfer_jit_cache-0.6.18.post1+cu130-cp39-abi3-manylinux_2_28_x86_64.whl" ]]

echo "PASS: test_build_vllm_image_ctr"
