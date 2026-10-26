#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy-model.sh"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

run_deploy_expect_failure() {
  local expected_message="$1"
  shift
  local output status
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  ((status != 0)) || { echo "expected deploy-model.sh to fail" >&2; return 1; }
  grep -Fq "$expected_message" <<<"$output" || {
    printf 'expected message not found: %s\n%s\n' "$expected_message" "$output" >&2
    return 1
  }
}

mkdir -p "$work_dir/missing-v1"
run_deploy_expect_failure \
  'model weight v1 directory not found:' \
  env DEPLOY_ON_TARGET_HOST=1 MOCK_HELM_DEPLOY=true \
    MODEL_PATH="$work_dir/missing-v1/v1" MODEL_CONTAINER_ROOT="$work_dir" MODEL_CACHE_HOST_PATH="$work_dir" \
    RUN_DIR="$work_dir/run-missing-v1" RENDER_DIR="$work_dir/run-missing-v1/rendered" \
    bash "$script"

mkdir -p "$work_dir/bad-mode/v1"
printf 'weights\n' >"$work_dir/bad-mode/v1/model.bin"
chmod 0644 "$work_dir/bad-mode/v1/model.bin"
run_deploy_expect_failure \
  'model weight files must have mode 755:' \
  env DEPLOY_ON_TARGET_HOST=1 MOCK_HELM_DEPLOY=true \
    MODEL_PATH="$work_dir/bad-mode/v1" MODEL_CONTAINER_ROOT="$work_dir" MODEL_CACHE_HOST_PATH="$work_dir" \
    RUN_DIR="$work_dir/run-bad-mode" RENDER_DIR="$work_dir/run-bad-mode/rendered" \
    bash "$script"

echo "deploy model weight checks passed"
