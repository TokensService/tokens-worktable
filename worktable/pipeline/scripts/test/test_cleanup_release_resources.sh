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

grep -Fxq 'delete service/ray-svc -n xds-current --ignore-not-found --wait=true' "$tmp/kubectl"
grep -Fxq -- '-TERM 101' "$tmp/kill"
grep -Fxq -- '-TERM 202' "$tmp/kill"
grep -Fq '端口 31008 仍被监听' "$LOG_FILE" && { echo 'listener verification must observe release after TERM' >&2; exit 1; }

# Dry-run must show actions and never call kubectl or kill.
: >"$tmp/kubectl"; : >"$tmp/kill"; rm -f "$tmp/released"; DRY_RUN=1
cleanup_current_release_resources
grep -Fq '[DRY_RUN] kubectl delete service/ray-svc -n xds-current' "$LOG_FILE"
grep -Fq '[DRY_RUN] kill -TERM 101' "$LOG_FILE"
! grep -q '^delete ' "$tmp/kubectl"
[[ ! -s "$tmp/kill" ]]

echo 'current release service/port cleanup test passed'

# Standardize derives the release namespace and chooses ports on the target node:
# mapped InternalIP uses its assigned NodePort; other nodes use 31365.
CLEANUP_NAMESPACE=''
CLEANUP_NODE_PORT=''
DEPLOY_ARCH='glm-5.3-nvfp4-ems-one-node'
DEPLOY_EXECUTOR='alice'
DEPLOY_IMAGE_TAG='1334.77c8b'
hostname() { [[ "$1" == '-I' ]] && printf '192.168.31.175\n'; }
[[ "$(resolved_cleanup_node_port)" == '31008' ]]
hostname() { [[ "$1" == '-I' ]] && printf '192.168.0.128\n'; }
[[ "$(resolved_cleanup_node_port)" == '31365' ]]
[[ "$(derive_cleanup_namespace; printf '%s' "$CLEANUP_NAMESPACE")" == 'xds-glm-5-3-nvfp4-ems-one-node-alice-1334-77c8b' ]]

echo 'mapped/default NodePort and namespace derivation test passed'

# Strict target-only mode must not query or delete Services cluster-wide.
FORCE_STALE_NODEPORT_CLEAN=1
CLEANUP_CONFLICTING_NODEPORT=1
STEPS=release-resources
CLEANUP_NAMESPACE=xds-current
CLEANUP_SERVICE_NAME=ray-svc
CLEANUP_NODE_PORT=31001
DEPLOY_ARCH=current
DEPLOY_EXECUTOR=alice
DEPLOY_IMAGE_TAG=1334
: >"$tmp/kubectl"
kubectl() {
    printf '%s\n' "$*" >>"$tmp/kubectl"
    if [[ "$*" == 'get service -A -o json' ]]; then
        printf '%s\n' '{"items":[{"metadata":{"namespace":"xds-old","name":"ray-svc","labels":{"app.kubernetes.io/instance":"xds"}},"spec":{"type":"NodePort","ports":[{"nodePort":31001}]}}]}'
    fi
}
do_standardize
grep -Fq 'get service -A -o json' "$tmp/kubectl"
grep -Fq '[DRY_RUN] kubectl delete service ray-svc -n xds-old' "$LOG_FILE"
! grep -Fq 'helm uninstall' "$tmp/kubectl"
! grep -Fq 'delete raycluster' "$tmp/kubectl"
echo 'target-only cleanup deletes only the selected port Service'
