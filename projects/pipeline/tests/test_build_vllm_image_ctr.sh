#!/usr/bin/env bash
set -euo pipefail

PIPELINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$PIPELINE_DIR/scripts/build_vllm_image_ctr.sh"

test -x "$SCRIPT"
grep -Fq 'build_cmd=(buildctl' "$SCRIPT"
grep -Fq 'ctr -n' "$SCRIPT"
grep -Fq 'images import' "$SCRIPT"
grep -Fq 'images push' "$SCRIPT"
grep -Fq 'build_cmd=(nerdctl' "$SCRIPT"
grep -Fq 'build_cmd=(docker' "$SCRIPT"
grep -Fq 'docker save' "$SCRIPT"
grep -Fq 'BUILD_MAX_JOBS' "$SCRIPT"
grep -Fq 'BUILD_CACHE_DIR' "$SCRIPT"
grep -Fq 'import-cache' "$SCRIPT"
grep -Fq 'export-cache' "$SCRIPT"

source_dir="$(mktemp -d)"
trap 'rm -rf "$source_dir"' EXIT
mkdir -p "$source_dir/docker"
printf 'FROM scratch\n' > "$source_dir/docker/Dockerfile"

output="$(VLLM_SOURCE_DIR="$source_dir" \
  GIT_URL=https://github.com/TokensService/vllm \
  GIT_BRANCH=v0.30.0 \
  IMAGE_NAME=myapp \
  SWR_REGISTRY=swr.example.com \
  SWR_REPOSITORY='' \
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

echo 'PASS: vLLM BuildKit/ctr image build and push contract'
