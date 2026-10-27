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

# Even when release arguments are complete, standardize must also remove an
# orphaned XDS NodePort outside the current release namespace.  This is the
# regression for "required NodePort ... is already used by another Service".
DRY_RUN=0
FORCE_STALE_NODEPORT_CLEAN=1
STEPS=release-resources
CLEANUP_NAMESPACE=xds-current
CLEANUP_SERVICE_NAME=ray-svc
CLEANUP_NODE_PORT=31001
DEPLOY_ARCH='current'
DEPLOY_EXECUTOR='alice'
DEPLOY_IMAGE_TAG='1334'
WHITELIST_NS=''
read_whitelist
kubectl() {
    printf '%s\n' "$*" >>"$tmp/kubectl"
    if [[ "$*" == 'get service -A -o json' ]]; then
        cat <<'JSON'
{"items":[{"metadata":{"namespace":"xds-old","name":"renamed-service","labels":{}},"spec":{"type":"NodePort","ports":[{"nodePort":31001}]}}]}
JSON
    elif [[ "$*" == 'get service -n xds-current -o name' ]]; then
        echo service/ray-svc
    fi
}
have() { [[ "$1" == ss ]]; }
ss() { :; }
do_standardize
grep -Fxq 'delete service renamed-service -n xds-old --ignore-not-found --wait=true' "$tmp/kubectl"

echo 'explicit release cleanup also removes stale NodePort services'

# A live old XDS release on another node must be removed through Helm/Ray,
# otherwise deleting only the Service allows it to be recreated and the next
# deployment still gets "required NodePort ... already used".
CLEANUP_CONFLICTING_NODEPORT=1
CLEANUP_NAMESPACE=xds-current
CLEANUP_NODE_PORT=31001
HAS_KUBECTL=1
HAS_HELM=1
old_ns='xds-old-live'
old_deleted="$tmp/old-deleted"
probe_k8s() { HAS_KUBECTL=1; HAS_HELM=1; }
helm() {
    printf 'helm %s\n' "$*" >>"$tmp/kubectl"
    if [[ "$1" == list ]]; then printf 'xds\n'; fi
}
kubectl() {
    printf '%s\n' "$*" >>"$tmp/kubectl"
    if [[ "$*" == 'get service -A -o json' ]]; then
        cat <<JSON
{"items":[{"metadata":{"namespace":"$old_ns","name":"ray-svc","labels":{"app.kubernetes.io/name":"ray"}},"spec":{"type":"NodePort","ports":[{"nodePort":31001}]}}]}
JSON
    elif [[ "$*" == "get service ray-svc -n $old_ns" ]]; then
        [[ -e "$old_deleted" ]] && return 1
        return 0
    elif [[ "$*" == "delete service ray-svc -n $old_ns --ignore-not-found --wait=true" ]]; then
        touch "$old_deleted"
    fi
}
cleanup_conflicting_nodeport_services
grep -Fxq 'helm uninstall xds -n xds-old-live --timeout=300s' "$tmp/kubectl"
grep -Fxq 'delete raycluster xds-kuberay -n xds-old-live --ignore-not-found --wait=false' "$tmp/kubectl"
grep -Fxq 'delete service ray-svc -n xds-old-live --ignore-not-found --wait=true' "$tmp/kubectl"
grep -Fq '已释放 NodePort 31001' "$LOG_FILE"
echo 'live conflicting XDS release cleanup passed'
