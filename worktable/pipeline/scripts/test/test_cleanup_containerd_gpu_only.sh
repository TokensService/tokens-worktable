#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/cleanup-env.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
source <(sed '/^main "\$@"$/d' "$script")

LOG_FILE="$tmp/log"
DRY_RUN=0
ctr() {
  local ns=""
  if [[ "$1" == "-n" ]]; then ns="$2"; shift 2; fi
  case "$*" in
    'containers list -q')
      [[ "$ns" != 'k8s.io' ]] || printf 'cpu-only\ngpu-used\nkube-pod\n'
      return 0
      ;;
    'containers info kube-pod')
      printf '"io.kubernetes.pod.name":"system-pod"\n'
      ;;
    'containers info cpu-only'|'containers info gpu-used') : ;;
    'tasks list')
      [[ "$ns" != 'k8s.io' ]] || printf 'NAME PID STATUS\ncpu-only 101 RUNNING\ngpu-used 201 RUNNING\nkube-pod 301 RUNNING\n'
      return 0
      ;;
    'tasks ps cpu-only') printf 'PID INFO\n101 {}\n' ;;
    'tasks ps gpu-used') printf 'PID INFO\n201 {}\n202 {}\n' ;;
    'tasks kill gpu-used'*|'tasks delete gpu-used'|'containers delete gpu-used') printf '%s\n' "$ns $*" >>"$tmp/ctr-actions" ;;
    'tasks kill cpu-only'*|'tasks delete cpu-only'|'containers delete cpu-only')
      printf '%s\n' "$ns $*" >>"$tmp/ctr-actions"
      ;;
  esac
}
nvidia-smi() {
  [[ "$*" == *'--query-compute-apps=pid'* ]] && printf '202\n'
}
sleep() { :; }

clean_containerd_naked

grep -Fq 'tasks kill gpu-used' "$tmp/ctr-actions"
grep -Fq 'containers delete gpu-used' "$tmp/ctr-actions"
if grep -Fq 'cpu-only' "$tmp/ctr-actions"; then
  echo 'CPU-only naked ctr container must not be killed or deleted' >&2
  exit 1
fi
if grep -Fq 'kube-pod' "$tmp/ctr-actions"; then
  echo 'Kubernetes-managed container must not be touched' >&2
  exit 1
fi
grep -Fq '[SKIP] ctr cpu-only: no GPU compute process' "$LOG_FILE"
echo 'containerd GPU-only cleanup test passed'
