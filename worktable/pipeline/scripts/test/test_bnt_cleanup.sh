#!/usr/bin/env bash
set -euo pipefail
script="$(cd "$(dirname "$0")/.." && pwd)/bnt-standalone.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# 隔离函数加载，所有集群操作均使用模拟命令。
source <(sed '/^main "\$@"$/d' "$script")
LOG_FILE="$tmp/log"
SCALED_RECORD="$tmp/scaled"
HAS_HELM=1
NODE=node-128
CLEANUP_TIMEOUT_SECONDS=1
CLEANUP_POLL_SECONDS=1
helm() {
    printf '%s\n' "$*" >>"$tmp/helm"
    if [[ "$1" == list ]]; then echo old-release; else return "${HELM_RC:-0}"; fi
}
kubectl() {
    printf '%s\n' "$*" >>"$tmp/kubectl"
    [[ "${API_FAIL:-0}" == 0 ]] || return 1
    if [[ "$1 $2" == 'get pods' && "${RESIDUAL:-0}" == 1 ]]; then echo pod/stale; fi
}
HELM_RC=1
if clean_namespace old-ns; then echo '卸载失败被吞掉' >&2; exit 1; fi
HELM_RC=0
RESIDUAL=1
if clean_namespace old-ns; then echo '残留 Pod 未阻止成功' >&2; exit 1; fi
RESIDUAL=0
clean_namespace old-ns
grep -q -- '--wait' "$tmp/helm"
API_FAIL=1
if clean_namespace old-ns; then echo 'API 失败被当作清理成功' >&2; exit 1; fi
API_FAIL=0
DRY_RUN=1
RESIDUAL=1
clean_namespace old-ns
DRY_RUN=0
handle_top_owner old-ns raycluster/old-ray
grep -q 'delete raycluster old-ray' "$tmp/kubectl"
if grep -q 'patch raycluster' "$tmp/kubectl"; then exit 1; fi
step_containers() { return 1; }
step_kill_gpu() { touch "$tmp/gpu-ran"; }
STEPS=containers,gpu
if do_standardize; then echo '标准化吞掉清理失败' >&2; exit 1; fi
[[ ! -e "$tmp/gpu-ran" ]]
do_remote() { return 1; }
TARGET_HOSTS=192.0.2.1
if do_targets; then echo '远端清理失败被吞掉' >&2; exit 1; fi
echo 'PASS: cleanup failures, residual pods, dry-run, Ray head and step propagation'
