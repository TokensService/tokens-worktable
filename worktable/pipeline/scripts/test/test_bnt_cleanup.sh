#!/usr/bin/env bash
set -euo pipefail
script="$(cd "$(dirname "$0")/.." && pwd)/cleanup-env.sh"
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
# 使用虚拟时间验证 15 秒边界，避免测试实际等待。
sleep() { SECONDS=$((SECONDS + $1)); }
HELM_RC=1
if clean_namespace old-ns; then echo '卸载失败被吞掉' >&2; exit 1; fi
HELM_RC=0
RESIDUAL=1
if clean_namespace old-ns; then echo '残留 Pod 未阻止成功' >&2; exit 1; fi
RESIDUAL=0
clean_namespace old-ns
if grep -q -- '--wait' "$tmp/helm"; then echo 'Helm 不应重复等待' >&2; exit 1; fi
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
# 正常退出不能触发强删；15 秒仍残留才升级，之后仍需确认消失。
: >"$tmp/kubectl"
SECONDS=0
CLEANUP_TIMEOUT_SECONDS=30
CLEANUP_POLL_SECONDS=5
kubectl() {
    printf '%s %s\n' "$SECONDS" "$*" >>"$tmp/kubectl"
    if [[ "$1 $2" == 'get pods' && ! -f "$tmp/forced" ]]; then echo pod/stale; fi
    if [[ "$1 $2" == 'delete pod/stale' ]]; then
        [[ "$SECONDS" -ge 15 ]] || return 1
        [[ " $* " == *' --force '* && " $* " == *' --grace-period=0 '* ]] || return 1
        touch "$tmp/forced"
    fi
}
wait_namespace_cleanup old-ns
[[ -f "$tmp/forced" ]]
# Bash SECONDS 同时受真实时间影响，允许测试执行跨过一秒边界。
awk '$2 == "delete" && $3 == "pod/stale" && $1 >= 15 && $1 <= 20 {ok=1} END {exit !ok}' "$tmp/kubectl"
# 命名空间 NotFound 不得被忽略成成功；竞态下 Pod 已消失则允许成功。
for mode in orphan raced; do
    SECONDS=0
    rm -f "$tmp/delete-attempted"
    kubectl() {
        if [[ "$1 $2" == 'get pods' ]]; then
            [[ "$mode" == raced && -e "$tmp/delete-attempted" ]] || echo pod/stale
        elif [[ "$1" == delete ]]; then
            touch "$tmp/delete-attempted"
            if [[ " $* " == *' --ignore-not-found '* ]]; then return 0; fi
            return 1
        fi
        return 0
    }
    if [[ "$mode" == orphan ]]; then
        if wait_namespace_cleanup orphan-ns; then echo '孤立Pod被当作成功' >&2; exit 1; fi
        grep -q '命名空间 orphan-ns 已不存在' "$LOG_FILE"
        (( SECONDS < CLEANUP_TIMEOUT_SECONDS ))
    else
        wait_namespace_cleanup raced-ns
    fi
done
step_containers() { return 1; }
step_kill_gpu() { touch "$tmp/gpu-ran"; }
STEPS=containers,gpu
if do_standardize; then echo '标准化吞掉清理失败' >&2; exit 1; fi
[[ ! -e "$tmp/gpu-ran" ]]
do_remote() { return 1; }
TARGET_HOSTS=192.0.2.1
if do_targets; then echo '远端清理失败被吞掉' >&2; exit 1; fi
echo 'PASS: cleanup failures, residual pods, dry-run, Ray head and step propagation'
