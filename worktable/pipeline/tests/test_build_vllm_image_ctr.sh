#!/usr/bin/env bash
set -euo pipefail

PIPELINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$PIPELINE_DIR/scripts/build_vllm_image_ctr.sh"

test -x "$SCRIPT"
grep -Fq 'BUILD_REMOTE_PROXY_COMMAND="${BUILD_REMOTE_PROXY_COMMAND:-ncat --proxy 192.168.10.6:3128 --proxy-type http %h %p}"' "$SCRIPT"
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
grep -Fq 'INDOCKER_REGISTRY_MIRROR' "$SCRIPT"
grep -Fq 'INDOCKER_MAX_CONCURRENT_DOWNLOADS' "$SCRIPT"
grep -Fq 'BUILD_REMOTE_PASSWORD="${BUILD_REMOTE_PASSWORD:-}"' "$SCRIPT"
grep -Fq 'SWR_PASSWORD="${SWR_PASSWORD:-}"' "$SCRIPT"
grep -Fq -- '--privileged' "$SCRIPT"

source_dir="$(mktemp -d)"
trap 'rm -rf "$source_dir"' EXIT
mkdir -p "$source_dir/docker"
printf 'FROM scratch\n' > "$source_dir/docker/Dockerfile"

# 固定 buildctl 引擎：dry-run 不校验命令存在性，保证在任何执行机
# （包括装有 docker/buildx 的机器）都断言同一份构建命令契约。
# 用 VLLM_REF 而非 GIT_BRANCH：工作台注入的 GIT_BRANCH 非空时会强制
# branch-time 重算 IMAGE_TAG，显式 tag 契约必须绕开该路径。
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
  BUILD_ENGINE=buildctl \
  "$SCRIPT" "" --dry-run 2>&1)"

grep -Fq 'buildctl --addr' <<<"$output"
grep -Fq 'ctr -n k8s.io images import' <<<"$output"
grep -Fq 'ctr -n k8s.io images push' <<<"$output"
grep -Fq 'swr.example.com/serverlessai/vllm:test-tag' <<<"$output"
grep -Fq '源码仓库: https://github.com/TokensService/vllm' <<<"$output"
grep -Fq '源码: '"$source_dir"'@v0.30.0' <<<"$output"
! grep -Fq 'test-password' <<<"$output"

indocker_output="$(VLLM_SOURCE_DIR="$source_dir" IMAGE_TAG_MODE=explicit IMAGE_TAG=test-tag SWR_USERNAME=test-user SWR_PASSWORD=test-password BUILD_ENGINE=indocker INDOCKER_RUNTIME=docker "$SCRIPT" --dry-run 2>&1)"
grep -Fq 'docker run --rm --privileged' <<<"$indocker_output"
grep -Fq -- '-v /mnt/data:/mnt/data' <<<"$indocker_output"
grep -Fq 'local/vllm-indocker-runner:latest' <<<"$indocker_output"
grep -Fq 'SWR_CREDENTIALS_FILE=/output/.swr-credentials' <<<"$indocker_output"
grep -Fq 'indocker 推送: docker login' <<<"$indocker_output"
grep -Fq 'Docker Hub 镜像源: https://docker.m.daocloud.io' <<<"$indocker_output"
grep -Fq '镜像层下载并发: 6' <<<"$indocker_output"
grep -Fq -- '-e INDOCKER_REGISTRY_MIRROR=https://docker.m.daocloud.io' <<<"$indocker_output"
grep -Fq -- '-e INDOCKER_MAX_CONCURRENT_DOWNLOADS=6' <<<"$indocker_output"
grep -Fq '远程执行目标: root@115.120.93.136:2222' <<<"$indocker_output"
grep -Fq 'docker push swr.cn-southwest-2.myhuaweicloud.com/serverlessai/vllm:test-tag' <<<"$indocker_output"
! grep -Fq 'images import' <<<"$indocker_output"
! grep -Fq 'images push' <<<"$indocker_output"
! grep -Fq 'OUTPUT_ARCHIVE' <<<"$indocker_output"
! grep -Fq 'test-password' <<<"$indocker_output"

remote_proxy_output="$(HTTP_PROXY=http://127.0.0.1:8118 HTTPS_PROXY=http://127.0.0.1:8118 \
  BUILD_REMOTE_PROXY_URL= IMAGE_TAG_MODE=explicit IMAGE_TAG=test-tag \
  SWR_USERNAME=test-user SWR_PASSWORD=test-password BUILD_ENGINE=indocker \
  INDOCKER_RUNTIME=docker "$SCRIPT" --dry-run 2>&1)"
grep -Fq '[预演] SSH 反向代理: 本机 127.0.0.1:8118 -> 远端 127.0.0.1:18118' <<<"$remote_proxy_output"
! grep -Fq 'test-password' <<<"$remote_proxy_output"

echo 'PASS: vLLM BuildKit/ctr image build and push contract'
