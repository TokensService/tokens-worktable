#!/usr/bin/env bash
set -euo pipefail

PIPELINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$PIPELINE_DIR/scripts/build_vllm_image_ctr.sh"
export BUILD_REMOTE_HOST=''

test -x "$SCRIPT"
grep -Fq 'build_cmd=(buildctl' "$SCRIPT"
grep -Fq 'ctr -n' "$SCRIPT"
grep -Fq 'images import' "$SCRIPT"
grep -Fq 'images push' "$SCRIPT"
grep -Fq 'build_cmd=(nerdctl' "$SCRIPT"
grep -Fq 'build_cmd=(docker' "$SCRIPT"
grep -Fq 'docker buildx build' "$SCRIPT"
grep -Fq -- '--allow network.host' "$SCRIPT"
grep -Fq -- '--network "$BUILD_NETWORK"' "$SCRIPT"
grep -Fq 'ensure_buildx_builder' "$SCRIPT"
grep -Fq 'BUILDX_BUILDER' "$SCRIPT"
grep -Fq 'docker save' "$SCRIPT"
grep -Fq 'BUILD_MAX_JOBS' "$SCRIPT"
grep -Fq 'BUILD_CACHE_DIR' "$SCRIPT"
grep -Fq '/mnt/sfs_turbo' "$SCRIPT"
grep -Fq 'INDOCKER_PUSH_DIRECT' "$SCRIPT"
grep -Fq 'import-cache' "$SCRIPT"
grep -Fq 'export-cache' "$SCRIPT"
grep -Fq 'HTTP_PROXY' "$SCRIPT"
grep -Fq 'HTTPS_PROXY' "$SCRIPT"
grep -Fq 'PIP_INDEX_URL' "$SCRIPT"
grep -Fq 'UV_INDEX_URL' "$SCRIPT"
grep -Fq 'BUILD_PROXY_URL' "$SCRIPT"
grep -Fq 'BUILD_REMOTE_PROXY_FORWARD_PORT' "$SCRIPT"
grep -Fq -- '-R "127.0.0.1:${BUILD_REMOTE_PROXY_FORWARD_PORT}:127.0.0.1:${BUILD_REMOTE_PROXY_FORWARD_LOCAL_PORT}"' "$SCRIPT"
grep -Fq 'INDOCKER_RUNTIME' "$SCRIPT"
grep -Fq -- '--privileged' "$SCRIPT"

source_dir="$(mktemp -d)"
trap 'rm -rf "$source_dir"' EXIT
mkdir -p "$source_dir/docker"
printf 'FROM scratch\n' > "$source_dir/docker/Dockerfile"

output="$(VLLM_SOURCE_DIR="$source_dir" \
  GIT_URL=https://github.com/TokensService/vllm \
  VLLM_REF=v0.30.0 \
  IMAGE_NAME=myapp \
  SWR_REGISTRY=swr.example.com \
  SWR_REPOSITORY='' \
  IMAGE_TAG_MODE=explicit \
  IMAGE_TAG=test-tag \
  SWR_USERNAME=test-user \
  SWR_PASSWORD=test-password \
  "$SCRIPT" "" --dry-run 2>&1)"

grep -Fq 'buildctl --addr' <<<"$output"
grep -Fq 'ctr -n k8s.io images import' <<<"$output"
grep -Fq 'ctr -n k8s.io images push' <<<"$output"
grep -Fq 'swr.example.com/vllm:test-tag' <<<"$output"
grep -Fq '源码仓库: https://github.com/TokensService/vllm' <<<"$output"
grep -Fq '源码: '"$source_dir"'@v0.30.0' <<<"$output"
! grep -Fq 'test-password' <<<"$output"

indocker_output="$(VLLM_SOURCE_DIR="$source_dir" IMAGE_TAG_MODE=explicit IMAGE_TAG=test-tag SWR_USERNAME=test-user SWR_PASSWORD=test-password BUILD_ENGINE=indocker INDOCKER_RUNTIME=docker INDOCKER_REGISTRY_MIRROR=https://mirror.example INDOCKER_MAX_CONCURRENT_DOWNLOADS=6 "$SCRIPT" --dry-run 2>&1)"
grep -Fq 'docker run --rm --privileged' <<<"$indocker_output"
grep -Fq 'local/vllm-indocker-runner:latest' <<<"$indocker_output"
grep -Fq 'indocker 会在镜像构建完成后直接登录 SWR 并推送' <<<"$indocker_output"
grep -Fq -- '-e INDOCKER_PUSH_DIRECT -e SWR_REGISTRY -e SWR_USERNAME -e SWR_PASSWORD' <<<"$indocker_output"
grep -Fq -- '-e INDOCKER_REGISTRY_MIRROR -e INDOCKER_MAX_CONCURRENT_DOWNLOADS' <<<"$indocker_output"
grep -Fq 'Docker Hub 镜像源: https://mirror.example' <<<"$indocker_output"
! grep -Fq 'OUTPUT_ARCHIVE=' <<<"$indocker_output"
! grep -Fq '导入命令:' <<<"$indocker_output"
! grep -Fq 'test-password' <<<"$indocker_output"

default_remote_output="$(env -u BUILD_REMOTE_HOST -u INDOCKER_REGISTRY_MIRROR -u INDOCKER_MAX_CONCURRENT_DOWNLOADS \
  VLLM_SOURCE_DIR="$source_dir" IMAGE_TAG_MODE=explicit IMAGE_TAG=test-tag \
  SWR_USERNAME=test-user SWR_PASSWORD=test-password \
  "$SCRIPT" --dry-run 2>&1)"
grep -Fq '[预演] 远程编译主机: root@115.120.93.136:2222' <<<"$default_remote_output"
grep -Fq '构建器: indocker/docker' <<<"$default_remote_output"
grep -Fq 'Docker Hub 镜像源: https://docker.m.daocloud.io' <<<"$default_remote_output"
grep -Fq '镜像层下载并发: 6' <<<"$default_remote_output"
grep -Fq -- '-v /mnt/sfs_turbo/vllm-image-build:/output' <<<"$default_remote_output"
grep -Fq -- '-v /tmp/vllm-build-cache/dind:/var/lib/docker' <<<"$default_remote_output"
! grep -Fq 'test-password' <<<"$default_remote_output"

remote_proxy_forward_output="$(env -u BUILD_REMOTE_HOST -u INDOCKER_REGISTRY_MIRROR -u INDOCKER_MAX_CONCURRENT_DOWNLOADS \
  HTTP_PROXY=http://127.0.0.1:8118 HTTPS_PROXY=http://127.0.0.1:8118 \
  BUILD_REMOTE_PROXY_URL= BUILD_REMOTE_PROXY_FORWARD_PORT=18118 \
  VLLM_SOURCE_DIR="$source_dir" IMAGE_TAG_MODE=explicit IMAGE_TAG=test-tag \
  SWR_USERNAME=test-user SWR_PASSWORD=test-password "$SCRIPT" --dry-run 2>&1)"
grep -Fq '[预演] SSH 反向代理: 本机 127.0.0.1:8118 -> 远端 127.0.0.1:18118' <<<"$remote_proxy_forward_output"
! grep -Fq 'test-password' <<<"$remote_proxy_forward_output"

indocker_storage_output="$(VLLM_SOURCE_DIR="$source_dir" BUILD_STORAGE_ROOT=/mnt/sfs_turbo BUILD_REMOTE_EXEC=1 IMAGE_TAG_MODE=explicit IMAGE_TAG=test-tag SWR_USERNAME=test-user SWR_PASSWORD=test-password BUILD_ENGINE=indocker INDOCKER_RUNTIME=docker "$SCRIPT" --dry-run 2>&1)"
grep -Fq -- '-v /mnt/sfs_turbo/vllm-image-build:/output' <<<"$indocker_storage_output"
grep -Fq -- '-v /tmp/vllm-build-cache/dind:/var/lib/docker' <<<"$indocker_storage_output"

indocker_archive_output="$(VLLM_SOURCE_DIR="$source_dir" IMAGE_TAG_MODE=explicit IMAGE_TAG=test-tag SWR_USERNAME=test-user SWR_PASSWORD=test-password BUILD_ENGINE=indocker INDOCKER_RUNTIME=docker INDOCKER_PUSH_DIRECT=false "$SCRIPT" --dry-run 2>&1)"
grep -Fq 'ctr -n k8s.io images import' <<<"$indocker_archive_output"
grep -Fq 'ctr -n k8s.io images push' <<<"$indocker_archive_output"

echo 'PASS: vLLM BuildKit/ctr image build and push contract'
