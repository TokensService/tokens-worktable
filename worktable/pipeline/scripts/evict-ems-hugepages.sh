#!/usr/bin/env bash
# pipeline: no-positional-args
# 仅驱逐目标 Kubernetes 节点上的 EMS Pod，确认退出后释放大页。
# 环境变量：DRY_RUN(默认1)、NODE/K8S_NODE_NAME、HUGEPAGE_PATH、
# CLEANUP_TIMEOUT_SECONDS、CLEANUP_POLL_SECONDS、TARGET_HOSTS、SSH_USER、
# SSH_PORT、SSH_PASSWORD/TARGET_PASSWORD、LOG_FILE。
set -uo pipefail

DRY_RUN="${DRY_RUN:-1}"
NODE="${NODE:-${K8S_NODE_NAME:-}}"
HUGEPAGE_PATH="${HUGEPAGE_PATH:-}"
CLEANUP_TIMEOUT_SECONDS="${CLEANUP_TIMEOUT_SECONDS:-300}"
CLEANUP_POLL_SECONDS="${CLEANUP_POLL_SECONDS:-5}"
TARGET_HOSTS="${TARGET_HOSTS:-}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
SSH_PASSWORD="${SSH_PASSWORD:-${TARGET_PASSWORD:-}}"
LOG_FILE="${LOG_FILE:-/tmp/evict-ems-hugepages_$(date +%Y%m%d_%H%M%S).log}"
REMOTE_EXECUTION="${REMOTE_EXECUTION:-0}"
LOG_PREFIX='[evict-ems]'

log() {
    local ts line
    ts=$(date +'%Y-%m-%d %H:%M:%S')
    line="[$ts] $LOG_PREFIX $*"
    echo "$line"
    echo "$line" >> "$LOG_FILE"
}
die() { log "ERROR: $*"; exit 1; }
run() {
    if [[ "$DRY_RUN" == 1 ]]; then
        log "[DRY_RUN] $*"
        return 0
    fi
    "$@"
}
have() { command -v "$1" >/dev/null 2>&1; }

get_node_name() {
    if [[ -n "$NODE" ]]; then
        kubectl get node "$NODE" >/dev/null 2>&1 && { echo "$NODE"; return 0; }
        die "NODE/K8S_NODE_NAME=$NODE 不存在"
    fi
    local host host_lower ips node addresses token
    host=$(hostname); host_lower=${host,,}
    for token in "$host" "$host_lower"; do
        kubectl get node "$token" >/dev/null 2>&1 && { echo "$token"; return 0; }
    done
    ips=$(hostname -I 2>/dev/null || true)
    while IFS='|' read -r node addresses; do
        for token in $ips; do
            [[ ",$addresses," == *",$token,"* ]] && { echo "$node"; return 0; }
        done
    done < <(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{range .status.addresses[*]}{.address}{","}{end}{"\n"}{end}' 2>/dev/null)
    return 1
}

is_ems_pod() {
    local namespace=$1 pod=$2 signature
    signature=$(kubectl get pod "$pod" -n "$namespace" -o jsonpath='{range .spec.containers[*]}{.name}{","}{end}{"|"}{range .spec.containers[*].volumeMounts[*]}{.mountPath}{","}{end}' 2>/dev/null) || return 1
    [[ "${signature,,}" == *ems* || "$signature" == *'/dev/shm/ems'* ]]
}

target_node_ems_pods() {
    local node_name=$1 namespace pod pod_node
    while read -r namespace pod pod_node; do
        [[ -n "$namespace" && "$pod_node" == "$node_name" ]] || continue
        is_ems_pod "$namespace" "$pod" && printf '%s\t%s\n' "$namespace" "$pod"
    done < <(kubectl get pods -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,NODE:.spec.nodeName' --no-headers 2>/dev/null)
}

wait_ems_pod_exit() {
    local namespace=$1 pod=$2 started=$SECONDS forced=0 elapsed
    while kubectl get pod "$pod" -n "$namespace" >/dev/null 2>&1; do
        elapsed=$((SECONDS - started))
        if (( forced == 0 && elapsed >= 15 )); then
            log "EMS Pod 未在 15 秒内退出，强制删除: $namespace/$pod"
            run kubectl delete pod "$pod" -n "$namespace" --grace-period=0 --force --ignore-not-found || return 1
            forced=1
        fi
        (( elapsed < CLEANUP_TIMEOUT_SECONDS )) || die "等待 EMS Pod 退出超时: $namespace/$pod"
        sleep "$CLEANUP_POLL_SECONDS"
    done
}

release_hugepages() {
    local path="${HUGEPAGE_PATH:-/sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages}"
    [[ "$path" == /* ]] || die "HUGEPAGE_PATH 必须为绝对路径"
    log "释放大页: $path"
    run sh -c "echo 0 > '$path'"
    [[ "$DRY_RUN" == 1 ]] && return 0
    [[ "$(cat "$path" 2>/dev/null)" == 0 ]] || die "大页未释放为 0: $path"
    log "大页已清0"
}

remote_scp() {
    if [[ -n "$SSH_PASSWORD" ]]; then
        have sshpass || die 'SSH_PASSWORD 已设置但未找到 sshpass'
        SSHPASS="$SSH_PASSWORD" sshpass -e scp "$@"
    else
        scp "$@"
    fi
}
remote_ssh() {
    if [[ -n "$SSH_PASSWORD" ]]; then
        have sshpass || die 'SSH_PASSWORD 已设置但未找到 sshpass'
        SSHPASS="$SSH_PASSWORD" sshpass -e ssh "$@"
    else
        ssh "$@"
    fi
}
target_ips() {
    if [[ "$TARGET_HOSTS" == \[* ]]; then
        printf '%s' "$TARGET_HOSTS" | grep -oE '"ip"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/'
    else
        tr ',' '\n' <<< "$TARGET_HOSTS" | sed '/^[[:space:]]*$/d; s/^[[:space:]]*//; s/[[:space:]]*$//'
    fi
}
do_remote() {
    local endpoint=$1 host port target self pair key remote_env=''
    if [[ "$endpoint" =~ ^([^:]+):([1-9][0-9]*)$ ]]; then host=${BASH_REMATCH[1]}; port=${BASH_REMATCH[2]}; else host=$endpoint; port=$SSH_PORT; fi
    (( port <= 65535 )) || die "无效 SSH 端口: $endpoint"
    target="$SSH_USER@$host"
    self=$(readlink -f "$0" 2>/dev/null || echo "$0")
    log "推送脚本到 $target:$port"
    remote_scp -P "$port" -q "$self" "$target:/tmp/evict-ems-hugepages.sh" || return 1
    for key in DRY_RUN NODE K8S_NODE_NAME HUGEPAGE_PATH CLEANUP_TIMEOUT_SECONDS CLEANUP_POLL_SECONDS LOG_FILE; do
        printf -v pair '%q' "$key=${!key:-}"
        remote_env+=" $pair"
    done
    remote_ssh -p "$port" "$target" "env REMOTE_EXECUTION=1 TARGET_HOSTS= $remote_env bash /tmp/evict-ems-hugepages.sh"
}
do_targets() {
    local endpoint count=0
    while IFS= read -r endpoint; do
        [[ -n "$endpoint" ]] || continue
        do_remote "$endpoint" </dev/null || return 1
        ((count += 1))
    done < <(target_ips)
    (( count > 0 )) || die 'TARGET_HOSTS 未包含可用 IP'
}

main() {
    [[ $# -eq 0 ]] || die '不支持命令行参数；请使用环境变量配置'
    [[ "$DRY_RUN" =~ ^[01]$ ]] || die 'DRY_RUN 必须为 0 或 1'
    [[ "$CLEANUP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || die 'CLEANUP_TIMEOUT_SECONDS 必须为正整数'
    [[ "$CLEANUP_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || die 'CLEANUP_POLL_SECONDS 必须为正整数'
    if [[ -n "$TARGET_HOSTS" && "$REMOTE_EXECUTION" != 1 ]]; then do_targets; return; fi
    have kubectl || die '需要 kubectl'
    kubectl version --request-timeout=5s >/dev/null 2>&1 || die 'kubectl 无法访问 Kubernetes API'
    local node_name namespace pod found=0
    node_name=$(get_node_name) || die '无法解析目标节点；请设置 NODE 或 K8S_NODE_NAME'
    log "扫描节点 $node_name 上的 EMS Pod"
    while IFS=$'\t' read -r namespace pod; do
        [[ -n "$namespace" && -n "$pod" ]] || continue
        found=1
        log "发现目标节点 EMS Pod: $namespace/$pod"
        run kubectl delete pod "$pod" -n "$namespace" --wait=false || return 1
        [[ "$DRY_RUN" == 1 ]] || wait_ems_pod_exit "$namespace" "$pod"
    done < <(target_node_ems_pods "$node_name")
    (( found == 1 )) || log '目标节点未发现 EMS Pod'
    release_hugepages
}

main "$@"
