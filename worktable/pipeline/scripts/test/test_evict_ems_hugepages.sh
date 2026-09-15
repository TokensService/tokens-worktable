#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/evict-ems-hugepages.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 加载真实函数，但不执行入口。
source <(sed '/^main "\$@"$/d' "$script")
LOG_FILE="$tmp/cleanup.log"
NODE=node-a
DRY_RUN=0
CLEANUP_TIMEOUT_SECONDS=30
CLEANUP_POLL_SECONDS=5
hugepage_file="$tmp/nr_hugepages"
printf '512\n' >"$hugepage_file"
HUGEPAGE_PATH="$hugepage_file"

# node-a 上只有 ems-a/ems-worker-0 是 EMS Pod；同节点普通 Pod 及 node-b 的
# EMS Pod 都绝不能被删除。
kubectl() {
  printf '%s\n' "$*" >>"$tmp/kubectl.log"
  if [[ "${1:-} ${2:-} ${3:-}" == 'get pods -A' ]]; then
    printf 'ems-a ems-worker-0 node-a\n'
    printf 'app-a app-worker-0 node-a\n'
    printf 'ems-b ems-worker-1 node-b\n'
    return 0
  fi
  if [[ "${1:-} ${2:-} ${3:-} ${4:-} ${5:-}" == 'get pod ems-worker-0 -n ems-a' && "$*" == *jsonpath* ]]; then
    printf 'ray-worker,ems-sidecar|/dev/shm/ems,/opt/cloud/logs\n'
    return 0
  fi
  if [[ "${1:-} ${2:-} ${3:-} ${4:-} ${5:-}" == 'get pod app-worker-0 -n app-a' && "$*" == *jsonpath* ]]; then
    printf 'ray-worker|/opt/cloud/logs\n'
    return 0
  fi
  if [[ "${1:-} ${2:-}" == 'delete pod' ]]; then
    [[ "${3:-}" == ems-worker-0 && "${5:-}" == ems-a ]] || return 91
    touch "$tmp/deleted"
    return 0
  fi
  if [[ "${1:-} ${2:-}" == 'get pod' && "${3:-}" == ems-worker-0 ]]; then
    [[ -e "$tmp/deleted" ]] && return 1
    return 0
  fi
  return 0
}
sleep() { :; }
docker() { return 0; }

main

grep -Fq 'delete pod ems-worker-0 -n ems-a --wait=false' "$tmp/kubectl.log"
if grep -Eq 'delete pod (app-worker-0|ems-worker-1)' "$tmp/kubectl.log"; then
  echo 'deleted a pod outside target-node EMS scope' >&2
  exit 1
fi
[[ "$(cat "$hugepage_file")" == 0 ]]
grep -Fq '发现目标节点 EMS Pod: ems-a/ems-worker-0' "$LOG_FILE"
echo 'PASS: evict-ems-hugepages only deletes EMS pods on target node before releasing hugepages'

# 该动作未显式设置 DRY_RUN 时必须预演；其它清理动作的既有默认值不受影响。
default_dry_run=$(env -u DRY_RUN bash -c '
  source <(sed '\''/^main "\$@"$/d'\'' "$1")
  printf "%s" "$DRY_RUN"
' bash "$script")
[[ "$default_dry_run" == 1 ]] || {
  echo "expected standalone script default DRY_RUN=1, got $default_dry_run" >&2
  exit 1
}
