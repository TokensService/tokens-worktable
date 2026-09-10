#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/cleanup-env.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
source <(sed '/^main "\$@"$/d' "$script")
LOG_FILE="$tmp/log"
DRY_RUN=0
CLEANUP_NAMESPACE='xds-current'
CLEANUP_SERVICE_NAME='ray-svc'
CLEANUP_NODE_PORT=31008
HAS_KUBECTL=1
HAS_HELM=0
have() { [[ "$1" == ss ]]; }
probe_k8s() { HAS_KUBECTL=1; HAS_HELM=0; }
kubectl() { printf '%s\n' "$*" >>"$tmp/kubectl"; }
ss() { [[ -e "$tmp/released" ]] || printf 'LISTEN 0 128 0.0.0.0:31008 0.0.0.0:* users:(("xds-old",pid=101,fd=7),("other",pid=202,fd=8))\n'; }
kill() { printf '%s\n' "$*" >>"$tmp/kill"; [[ "$1" == '-TERM' ]] && touch "$tmp/released"; }
sleep() { :; }

cleanup_current_release_resources

grep -Fxq 'delete service ray-svc -n xds-current --ignore-not-found --wait=true' "$tmp/kubectl"
grep -Fxq -- '-TERM 101' "$tmp/kill"
grep -Fxq -- '-TERM 202' "$tmp/kill"
grep -Fq '端口 31008 仍被监听' "$LOG_FILE" && { echo 'listener verification must observe release after TERM' >&2; exit 1; }

# Dry-run must show actions and never call kubectl or kill.
: >"$tmp/kubectl"; : >"$tmp/kill"; rm -f "$tmp/released"; DRY_RUN=1
cleanup_current_release_resources
grep -Fq '[DRY_RUN] kubectl delete service ray-svc -n xds-current' "$LOG_FILE"
grep -Fq '[DRY_RUN] kill -TERM 101' "$LOG_FILE"
[[ ! -s "$tmp/kubectl" && ! -s "$tmp/kill" ]]

echo 'current release service/port cleanup test passed'
