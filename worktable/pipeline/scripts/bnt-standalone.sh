#!/bin/bash
# bnt-standalone.sh - BNT (GPU) 环境标准化 · 单文件零依赖入口
# pipeline: no-positional-args
# ============================================================================
# 把 wht_test_bnt 分支 xds_prechecker/bnt/ 下的全部标准化逻辑内联进一个
# 纯 bash 脚本: 不依赖 python3 / fastapi / bnt 包 / bnt_config.json / HTTP API。
# 只依赖目标机自带的: bash4+, kubectl/docker/ctr/nvidia-smi(按需, 缺则自动跳过)。
#
# 可放在任意 BNT(GPU) 机器上独立运行; 也可对远端机器批量执行(内置 SSH 推送+执行)。
#
# 环境变量:
#   ACTION=standardize       动作：standardize|check-health|clean-containers|kill-gpu|svc|hugepages
#   STEPS=                   standardize 清理步骤，逗号分隔；默认 crond,containers,gpu；完成后固定执行环境检查
#   CLEANUP_TIMEOUT_SECONDS=300 清理等待上限
#   CLEANUP_POLL_SECONDS=5     残留 Pod 检查间隔；统一等待满 15 秒后强制删除
#   DRY_RUN=0|1              仅预演
#   NODE=                    指定 Kubernetes nodeName
#   WHITELIST_NS=            白名单命名空间，空格分隔 glob
#   NO_CROND=0|1             standardize 时不停止 crond
#   SERVICE=                 svc 动作的服务名：kubelet 或 kube-proxy
#   HUGEPAGE_PATH=           hugepages 动作的 nr_hugepages 文件路径
#   TARGET_HOSTS=            逗号分隔 IP；也兼容 TARGET_HOSTS JSON 的 ip 字段
#   SSH_USER=root            远端 SSH 用户
#   SSH_PORT=22              远端 SSH 端口
#   SSH_PASSWORD=            远端密码（兼容 TARGET_PASSWORD）
#   LOG_FILE=                日志路径
#
# 用法示例:
#   DRY_RUN=1 bash bnt-standalone.sh
#   ACTION=check-health bash bnt-standalone.sh
#   STEPS=containers,gpu TARGET_HOSTS=192.0.2.10 bash bnt-standalone.sh
# ============================================================================

set -uo pipefail

# ---------------- 全局 ----------------
ACTION="${ACTION:-standardize}"
STEPS="${STEPS:-}"
DRY_RUN="${DRY_RUN:-0}"
LOG_PREFIX="[bnt]"
LOG_FILE="${LOG_FILE:-/tmp/bnt-standalone_$(date +%Y%m%d_%H%M%S).log}"
NODE="${NODE:-${K8S_NODE_NAME:-}}"
WHITELIST_NS="${WHITELIST_NS:-}"
NO_CROND="${NO_CROND:-0}"
SERVICE="${SERVICE:-}"
HUGEPAGE_PATH="${HUGEPAGE_PATH:-}"
TARGET_HOSTS="${TARGET_HOSTS:-}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
SSH_PASSWORD="${SSH_PASSWORD:-${TARGET_PASSWORD:-}}"
REMOTE_EXECUTION="${REMOTE_EXECUTION:-0}"
SSHD_PID=""
CLEANUP_TIMEOUT_SECONDS="${CLEANUP_TIMEOUT_SECONDS:-300}"
CLEANUP_POLL_SECONDS="${CLEANUP_POLL_SECONDS:-5}"
HEALTH_PASS=0
HEALTH_WARN=0
HEALTH_FAIL=0

DEFAULT_WHITELIST_NS=(
    default kube-flannel kube-system 'ems*' lws-system
    volcano-monitoring volcano-system gpu-operator nvidia-gpu-operator monitoring
)

log() {
    local ts; ts=$(date +'%Y-%m-%d %H:%M:%S')
    local line="[$ts] $LOG_PREFIX $*"
    echo "$line"
    echo "$line" >> "$LOG_FILE"
}
run() {
    if [[ "$DRY_RUN" == "1" ]]; then log "  [DRY_RUN] $*"; return 0; fi
    "$@"
}
die() { log "ERROR: $*"; exit 1; }

# 把 WHITELIST_NS 环境变量(空格分隔)解析成数组, 否则用默认
read_whitelist() {
    if [[ -n "${WHITELIST_NS:-}" ]]; then
        read -ra WHITELIST_NS_ARR <<< "$WHITELIST_NS"
    else
        WHITELIST_NS_ARR=("${DEFAULT_WHITELIST_NS[@]}")
    fi
}
is_whitelisted() {
    local ns=$1 pat
    for pat in "${WHITELIST_NS_ARR[@]}"; do
        # shellcheck disable=SC2053
        [[ "$ns" == $pat ]] && return 0
    done
    return 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------- k8s 探测 ----------------
probe_k8s() {
    HAS_KUBECTL=0
    if have kubectl && kubectl version --request-timeout=5s >/dev/null 2>&1; then
        HAS_KUBECTL=1
    else
        log "未找到可用 kubectl, 跳过 k8s 相关清理"
    fi
    HAS_HELM=0; have helm && HAS_HELM=1
    HAS_DOCKER=0; have docker && docker info >/dev/null 2>&1 && HAS_DOCKER=1
}

get_node_name() {
    if [[ -n "$NODE" ]]; then
        if kubectl get node "$NODE" >/dev/null 2>&1; then echo "$NODE"; return 0; fi
        log "K8S_NODE_NAME=$NODE 不存在, 回退自动解析"
    fi
    local h hl ips needle map name addrs cand
    h=$(hostname); hl=${h,,}
    for cand in "$h" "$hl"; do
        kubectl get node "$cand" >/dev/null 2>&1 && { echo "$cand"; return 0; }
    done
    ips=$(hostname -I 2>/dev/null || true)
    map=$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{range .status.addresses[*]}{.address}{","}{end}{"\n"}{end}' 2>/dev/null)
    while IFS='|' read -r name addrs; do
        [[ -z "$name" ]] && continue
        for needle in $h $hl $ips; do
            [[ -z "$needle" ]] && continue
            if [[ ",$addrs," == *",$needle,"* ]]; then echo "$name"; return 0; fi
        done
    done <<< "$map"
    return 1
}

# 顶层 owner 上溯 (kubectl only)
get_top_owner() {
    local ns=$1 kind=$2 name=$3 next_kind next_name depth=0
    while (( depth++ < 10 )); do
        next_kind=$(kubectl get "$kind" "$name" -n "$ns" -o jsonpath='{.metadata.ownerReferences[?(@.controller==true)].kind}' 2>/dev/null)
        next_name=$(kubectl get "$kind" "$name" -n "$ns" -o jsonpath='{.metadata.ownerReferences[?(@.controller==true)].name}' 2>/dev/null)
        if [[ -z "$next_kind" || -z "$next_name" ]]; then echo "${kind,,}/${name}"; return 0; fi
        kind=$next_kind; name=$next_name
    done
    echo "${kind,,}/${name}"
}

# 纯 bash 数 JSON 数组元素个数 (输入是 jsonpath 输出的 [{...},{...}] 或空)
# 原脚本用 python3 json.load; 这里数顶层 ",{ " 边界
json_array_len() {
    local s; s=$(cat)
    s="${s//[[:space:]]/}"
    [[ -z "$s" || "$s" == "[]" ]] && { echo 0; return; }
    # 去掉首尾 [ ] 后数 '},' 分隔 + 1
    s="${s#[}"; s="${s%]}"
    if [[ -z "$s" ]]; then echo 0; return; fi
    # 数 '{' 出现次数 (假设每个元素一个对象, 无嵌套对象被误数的风险可接受: workerGroupSpecs 元素是对象)
    local n; n=$(printf '%s' "$s" | grep -o '{' | wc -l)
    echo "$n"
}

# ---------------- STEP: crond 停 ----------------
step_crond() {
    log "=== 停 crond ==="
    run service crond stop 2>/dev/null || log "crond 已停或不存在"
}

# ---------------- STEP: clean-containers ----------------
handle_top_owner() {
    local ns=$1 ref=$2 kind=${2%%/*} name=${2#*/}
    case "$kind" in
        daemonset|ds)
            log "  WARN DaemonSet 无法 scale, 需手动 cordon/patch: $ref"; return ;;
        pod|node|"") return ;;
        raycluster)
            # 仅缩 Worker 会留下 Head，并可能被 autoscaler 恢复。
            log "  -> delete RayCluster $ns/$name (含 Head)"
            run kubectl delete raycluster "$name" -n "$ns" \
                --ignore-not-found --wait=false
            return $? ;;

    esac
    log "  try scale 0: $ref"
    if [[ "$DRY_RUN" == "1" ]]; then log "  [DRY_RUN] kubectl scale $ref -n $ns --replicas=0"; return; fi
    if kubectl scale "$ref" -n "$ns" --replicas=0 >/dev/null 2>&1; then log "    -> scaled"; return; fi
    log "  scale 不支持, delete: $ref"
    kubectl delete "$ref" -n "$ns" --ignore-not-found --wait=false || return 1
}

clean_namespace() {
    local ns=$1 pod owner res pod_names
    if [[ "$HAS_HELM" == "1" ]]; then
        local rels; rels=$(helm list -n "$ns" --all -q) || return 1
        if [[ -n "$rels" ]]; then
            log "[CLEAN] ns=$ns (Helm)"
            while read -r rel; do
                [[ -z "$rel" ]] && continue
                log "  helm uninstall $rel (ns=$ns)"
                [[ "$DRY_RUN" == "1" ]] && { log "  [DRY_RUN] helm uninstall $rel -n $ns"; continue; }
                helm uninstall "$rel" -n "$ns" --timeout="${CLEANUP_TIMEOUT_SECONDS}s" || {
                    log "ERROR: helm uninstall 失败: $ns/$rel"; return 1;
                }
            done <<< "$rels"
            wait_namespace_cleanup "$ns"
            return $?
        fi
    fi
    log "[CLEAN] ns=$ns"
    declare -A TOP=()
    pod_names=$(kubectl get pods -n "$ns" --field-selector "spec.nodeName=$NODE" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}') || return 1
    while read -r pod; do
        [[ -z "$pod" ]] && continue
        owner=$(get_top_owner "$ns" pod "$pod")
        [[ -n "$owner" ]] && TOP[$owner]=1
    done <<< "$pod_names"
    if (( ${#TOP[@]} > 0 )); then
        log "  顶层 owner (${#TOP[@]}): ${!TOP[*]}"
        for owner in "${!TOP[@]}"; do handle_top_owner "$ns" "$owner" || return 1; done
    fi
    pod_names=$(kubectl get pods -n "$ns" --field-selector "spec.nodeName=$NODE" -o name) || return 1
    while read -r res; do
        [[ -z "$res" ]] && continue
        log "  delete: $res"
        run kubectl delete "$res" -n "$ns" --ignore-not-found --wait=false || return 1
    done <<< "$pod_names"
    wait_namespace_cleanup "$ns"
}

# API 中 Pod 消失后才能继续；不能以删除命令已提交代替清理完成。
wait_namespace_cleanup() {
    local ns=$1 remaining deadline=$((SECONDS + CLEANUP_TIMEOUT_SECONDS))
    local force_at=$((SECONDS + 15)) forced=0 pause
    local -a remaining_pods
    [[ "$DRY_RUN" == 1 ]] && return 0
    while true; do
        remaining=$(kubectl get pods -n "$ns" --field-selector "spec.nodeName=$NODE" -o name) || return 1
        [[ -z "$remaining" ]] && { log "[CLEAN] $ns 节点 Pod 已清空"; return 0; }
        if (( SECONDS >= deadline )); then
            log "ERROR: $ns 清理超时，残留: $remaining"
            return 1
        fi
        if (( forced == 0 && SECONDS >= force_at )); then
            mapfile -t remaining_pods <<< "$remaining"
            log "[CLEAN] $ns 等待满 15 秒，强制删除残留 Pod: $remaining"
            kubectl delete "${remaining_pods[@]}" -n "$ns" \
                --grace-period=0 --force --ignore-not-found --wait=false || return 1
            forced=1
            continue
        fi
        log "等待 $ns 节点 Pod 退出: $remaining"
        pause=$CLEANUP_POLL_SECONDS
        if (( forced == 0 && SECONDS + pause > force_at )); then
            pause=$((force_at - SECONDS))
        fi
        (( SECONDS + pause <= deadline )) || pause=$((deadline - SECONDS))
        (( pause > 0 )) && sleep "$pause"

    done
}

clean_docker() {
    if [[ "$HAS_DOCKER" != "1" ]]; then log "docker 不可用, 跳过"; return; fi
    log "扫描 docker 容器 (跳过 k8s 容器)..."
    local all k8s targets cid name
    all=$(docker ps -q | sort -u)
    k8s=$(docker ps -q --filter "label=io.kubernetes.pod.name" | sort -u)
    [[ -z "$all" ]] && { log "  无运行中容器"; return; }
    targets=$(comm -23 <(echo "$all") <(echo "$k8s"))
    [[ -z "$targets" ]] && { log "  全是 k8s 容器"; return; }
    for cid in $targets; do
        name=$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null | sed 's#^/##')
        log "  docker kill $cid ($name)"
        run docker kill "$cid" >/dev/null 2>&1 || run docker stop -t 5 "$cid" >/dev/null 2>&1
    done
}

clean_containerd_naked() {
    have ctr || { log "ctr 不存在, 跳过裸 containerd"; return; }
    local ns cname labels tpid
    for ns in k8s.io default; do
        local cs; cs=$(ctr -n "$ns" containers list -q 2>/dev/null)
        [[ -z "$cs" ]] && continue
        log "扫描裸 containerd (ns=$ns)..."
        for cname in $cs; do
            labels=$(ctr -n "$ns" containers info "$cname" 2>/dev/null | grep -oE '"io\.kubernetes\.pod\.name"[^,]*' | head -1)
            [[ -n "$labels" ]] && continue
            tpid=$(ctr -n "$ns" tasks list 2>/dev/null | awk -v c="$cname" '$1==c {print $2}')
            if [[ -n "$tpid" ]]; then
                log "  ctr kill $cname (pid=$tpid, ns=$ns)"
                if [[ "$DRY_RUN" == "1" ]]; then log "    [DRY_RUN]"; else
                    ctr -n "$ns" tasks kill "$cname" --signal 9 --all >/dev/null 2>&1; sleep 1
                    ctr -n "$ns" tasks delete "$cname" >/dev/null 2>&1
                fi
            fi
            log "  ctr delete $cname (ns=$ns)"
            [[ "$DRY_RUN" == "1" ]] && { log "    [DRY_RUN]"; continue; }
            ctr -n "$ns" containers delete "$cname" >/dev/null 2>&1 || log "    WARN ctr delete 失败: $cname"
        done
    done
}

clean_terminating_pods() {
    [[ "$HAS_KUBECTL" == "1" ]] || return
    log "检查 Terminating pod..."
    local tp ns pod count=0
    tp=$(kubectl get pods -A --field-selector "spec.nodeName=$NODE" -o jsonpath='{range .items[?(@.status.phase=="Terminating")]}{.metadata.namespace}{" "}{.metadata.name}{"\n"}{end}' 2>/dev/null)
    [[ -z "$tp" ]] && { log "  无 Terminating pod"; return; }
    while IFS=' ' read -r ns pod; do
        [[ -z "$ns" || -z "$pod" ]] && continue
        if is_whitelisted "$ns"; then log "  [SKIP] $ns/$pod (白名单)"; continue; fi
        log "  force delete Terminating: $ns/$pod"
        if [[ "$DRY_RUN" == "1" ]]; then log "    [DRY_RUN]"; else
            kubectl delete pod "$pod" -n "$ns" --force --grace-period=0 --ignore-not-found >/dev/null 2>&1 || log "    WARN 失败: $ns/$pod"
        fi
        ((count++))
    done <<< "$tp"
    log "  force delete $count 个 Terminating pod"
}

step_containers() {
    log "=== 清理容器/工作负载 ==="
    read_whitelist
    probe_k8s
    SCALED_RECORD="/tmp/bnt-scaled-$$.log"
    if [[ "$HAS_KUBECTL" == "1" ]]; then
        NODE=$(get_node_name) || { log "无法解析 nodeName, 跳过 k8s 清理"; HAS_KUBECTL=0; }
    fi
    if [[ "$HAS_KUBECTL" == "1" ]]; then
        log "nodeName=$NODE (hostname=$(hostname)) DRY_RUN=$DRY_RUN"
        # 先固定命名空间清单，再逐个删除控制器，避免提前缩容改变发现结果。
        log "白名单 ns: ${WHITELIST_NS_ARR[*]}"
        local -a NS_LIST=()
        local namespace_names
        namespace_names=$(kubectl get pods -A --field-selector "spec.nodeName=$NODE" -o jsonpath='{range .items[*]}{.metadata.namespace}{"\n"}{end}') || return 1
        mapfile -t NS_LIST < <(printf '%s\n' "$namespace_names" | sed '/^$/d' | sort -u)
        [[ ${#NS_LIST[@]} -eq 0 ]] && log "节点上无 Pod" || log "节点上有 Pod 的 ns (${#NS_LIST[@]}): ${NS_LIST[*]}"
        for ns in "${NS_LIST[@]}"; do
            [[ -z "$ns" ]] && continue
            is_whitelisted "$ns" && { log "[SKIP] $ns (白名单)"; continue; }
            clean_namespace "$ns" || return 1
        done
    else
        log "跳过 k8s 工作负载清理"
    fi
    echo; clean_docker
    echo; clean_containerd_naked
    echo; clean_terminating_pods
    [[ -s "$SCALED_RECORD" ]] && { log "被缩容工作负载(需手动恢复):"; cat "$SCALED_RECORD"; }
    rm -f "$SCALED_RECORD" 2>/dev/null
}

# ---------------- STEP: kill-gpu ----------------
get_gpu_pids() {
    have nvidia-smi || { log "未找到 nvidia-smi"; return 1; }
    nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]+$' | sort -u
}
get_container_id() {
    local cg="/proc/$1/cgroup"; [[ -r "$cg" ]] || return 1
    grep -oE '[0-9a-f]{64}' "$cg" | head -n1
}
build_k8s_map() {
    [[ "$HAS_KUBECTL" == "1" ]] || return 0
    K8S_MAP_FILE=$(mktemp)
    kubectl get pods --all-namespaces -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{range .status.containerStatuses[*]}{.containerID}{"\n"}{end}{end}' 2>/dev/null \
      | awk -F'\t' 'NF>=3 {cid=$3; sub(/^[a-z]+:\/\//, "", cid); if (length(cid)>=64) print substr(cid,1,64), $1, $2}' > "$K8S_MAP_FILE" 2>/dev/null || true
    log "k8s 容器映射: $(wc -l < "$K8S_MAP_FILE" 2>/dev/null) 条"
}
lookup_pod_by_cid() { [[ -n "${K8S_MAP_FILE:-}" && -s "$K8S_MAP_FILE" ]] || return 1; awk -v c="$1" '$1==c {print $2, $3; exit}' "$K8S_MAP_FILE"; }

do_kill() {
    local pid=$1
    if [[ "$DRY_RUN" == "1" ]]; then log "  [DRY_RUN] kill $pid"; return; fi
    kill -15 "$pid" 2>/dev/null
    local i; for i in 1 2 3; do kill -0 "$pid" 2>/dev/null || return 0; sleep 1; done
    log "  SIGTERM 无效, SIGKILL"; kill -9 "$pid" 2>/dev/null
}

handle_k8s_pod_gpu() {
    local ns=$1 pod=$2 owner_ref owner_kind owner_name
    owner_ref=$(get_top_owner "$ns" pod "$pod"); owner_kind=${owner_ref%%/*}; owner_name=${owner_ref#*/}
    case "$owner_kind" in
        deployment) log "  -> Deployment $ns/$owner_name scale=0"; run kubectl scale deploy "$owner_name" -n "$ns" --replicas=0 ;;
        statefulset) log "  -> StatefulSet $ns/$owner_name scale=0"; run kubectl scale sts "$owner_name" -n "$ns" --replicas=0 ;;
        raycluster)
            log "  -> RayCluster $ns/$owner_name patch replicas=0"
            run kubectl patch raycluster "$owner_name" -n "$ns" --type=json -p '[{"op":"replace","path":"/spec/workerGroupSpecs/0/replicas","value":0}]' 2>/dev/null
            run kubectl patch raycluster "$owner_name" -n "$ns" --type=json -p '[{"op":"replace","path":"/spec/workerGroupSpecs","value":[]}]' 2>/dev/null
            ;;
        daemonset) log "  -> DaemonSet $ns/$owner_name 删 pod(会重建)"; run kubectl delete pod "$pod" -n "$ns" --grace-period=5 --force 2>/dev/null ;;
        job) log "  -> Job $ns/$owner_name delete"; run kubectl delete job "$owner_name" -n "$ns" --grace-period=5 ;;
        pod|"") log "  -> 裸 Pod $ns/$pod delete"; run kubectl delete pod "$pod" -n "$ns" --grace-period=5 --force 2>/dev/null ;;
        *) log "  -> 未知 owner $owner_kind, delete pod"; run kubectl delete pod "$pod" -n "$ns" --grace-period=5 --force 2>/dev/null ;;
    esac
}

handle_container_gpu() {
    local cid=$1 pid=$2
    if [[ "$HAS_KUBECTL" == "1" ]]; then
        local hit ns pod; hit=$(lookup_pod_by_cid "$cid" || true)
        if [[ -n "$hit" ]]; then
            ns=$(awk '{print $1}' <<<"$hit"); pod=$(awk '{print $2}' <<<"$hit")
            log "  -> k8s Pod $ns/$pod (${cid:0:12})"; handle_k8s_pod_gpu "$ns" "$pod"; return
        fi
    fi
    if [[ "$HAS_DOCKER" == "1" ]] && docker inspect "$cid" >/dev/null 2>&1; then
        log "  -> docker ${cid:0:12} kill"; run docker kill "$cid" >/dev/null 2>&1 || run docker stop -t 5 "$cid" >/dev/null 2>&1; return
    fi
    log "  -> 未匹配容器, 宿主 kill $pid"; do_kill "$pid"
}

kill_pid() {
    local pid=$1 cid comm="unknown"
    kill -0 "$pid" 2>/dev/null || { log "PID $pid 已退出"; return 0; }
    [[ -r /proc/$pid/comm ]] && comm=$(cat /proc/$pid/comm)
    cid=$(get_container_id "$pid" || true)
    if [[ -n "${cid:-}" ]]; then log "PID $pid ($comm) -> 容器 ${cid:0:12}"; handle_container_gpu "$cid" "$pid"
    else log "PID $pid ($comm) -> 宿主进程"; do_kill "$pid"; fi
}

step_kill_gpu() {
    log "=== 清理 GPU 占卡进程 ==="
    have nvidia-smi || { log "无 nvidia-smi, 跳过"; return 0; }
    probe_k8s
    local pids; pids=$(get_gpu_pids) || return 0
    if [[ -z "$pids" ]]; then log "无 GPU 占卡进程"; return 0; fi
    log "占卡 PID: $(echo $pids | tr '\n' ' ')"
    build_k8s_map
    local pid
    for pid in $pids; do kill_pid "$pid"; done
    [[ -n "${K8S_MAP_FILE:-}" ]] && rm -f "$K8S_MAP_FILE"
    sleep 2
    log "当前 GPU 进程:"; nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>/dev/null
}

# ---------------- STEP: kubelet / kube-proxy ----------------
step_svc() {
    local svc=$1
    log "=== 标准化 $svc ==="
    local chk before_en before_ac lines
    chk=$(ssh_local "systemctl is-enabled $svc 2>/dev/null; systemctl is-active $svc 2>/dev/null")
    lines=("${(@f)chk}") 2>/dev/null || read -ra lines <<< "$chk"
    # 简单解析: 两行
    local l1 l2; l1=$(echo "$chk" | sed -n '1p'); l2=$(echo "$chk" | sed -n '2p')
    before_en=$([[ "$l1" == "enabled" ]] && echo 1 || echo 0)
    before_ac=$([[ "$l2" == "active" ]] && echo 1 || echo 0)
    if [[ "$before_en" == "1" && "$before_ac" == "1" ]]; then log "$svc 已 enabled+active"; return 0; fi
    [[ "$before_en" != "1" ]] && run systemctl enable "$svc" 2>&1
    [[ "$before_ac" != "1" ]] && run systemctl start "$svc" 2>&1
    sleep 3
    local after; after=$(ssh_local "systemctl is-enabled $svc 2>/dev/null; systemctl is-active $svc 2>/dev/null")
    local a1 a2; a1=$(echo "$after" | sed -n '1p'); a2=$(echo "$after" | sed -n '2p')
    if [[ "$a1" == "enabled" && "$a2" == "active" ]]; then log "$svc 标准化成功"
    else log "$svc 标准化失败: enabled=$a1 active=$a2"; fi
}
ssh_local() { bash -c "$1"; }

# ---------------- STEP: hugepages ----------------
step_hugepages() {
    local nr="${1:-/sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages}"
    [[ "$nr" == /* ]] || die "nr_path 必须以 / 开头"
    log "=== 清大页 $nr ==="
    run sh -c "echo 0 > '$nr'"
    local v; v=$(cat "$nr" 2>/dev/null)
    [[ "$v" == "0" ]] && log "大页已清0" || log "大页清0后仍为 $v"
}

# ---------------- 只读环境健康检查 ----------------
health_result() {
    local level=$1 message=$2
    case "$level" in
        PASS) ((HEALTH_PASS++)) ;;
        WARN) ((HEALTH_WARN++)) ;;
        FAIL) ((HEALTH_FAIL++)) ;;
        *) die "未知健康检查级别: $level" ;;
    esac
    log "[$level] $message"
}

health_service() {
    local service=$1
    if ! have systemctl; then
        health_result WARN "运行时($service): systemctl 不可用"
    elif systemctl is-active --quiet "$service" 2>/dev/null; then
        health_result PASS "运行时($service): active"
    else
        health_result FAIL "运行时($service): 未处于 active"
    fi
}

health_cni() {
    local conf=/etc/cni/net.d/cni.conflist bin=/opt/cni/bin/vpc-router
    if [[ -r "$conf" ]] && grep -q '"type"[[:space:]]*:[[:space:]]*"vpc-router"' "$conf"; then
        health_result PASS "CNI: $conf 使用 vpc-router"
    elif [[ -r "$conf" ]]; then
        health_result WARN "CNI: $conf 未声明 vpc-router"
    else
        health_result FAIL "CNI: 未找到 $conf"
    fi
    if [[ -x "$bin" ]]; then
        health_result PASS "CNI 插件: $bin 可执行"
    else
        health_result FAIL "CNI 插件: $bin 不存在或不可执行"
    fi
}

health_api_network() {
    local kubeconfig=/opt/cloud/cce/kubernetes/kubelet/kubeconfig server hostport host port
    server=$(sed -n 's/^[[:space:]]*server:[[:space:]]*//p' "$kubeconfig" 2>/dev/null | head -n1)
    if [[ -z "$server" ]]; then
        health_result WARN "网络(API Server): 未从 $kubeconfig 获取 server"
        return
    fi
    hostport=${server#*://}
    hostport=${hostport%%/*}
    host=${hostport%:*}
    port=${hostport##*:}
    if [[ "$host" == "$port" ]]; then port=443; fi
    if have timeout && timeout 3 bash -c "</dev/tcp/$host/$port" 2>/dev/null; then
        health_result PASS "网络(API Server): $host:$port TCP 可达"
    else
        health_result FAIL "网络(API Server): $host:$port TCP 不可达"
    fi
}

health_dram() {
    local total available percent
    total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
    available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
    if [[ -z "$total" || -z "$available" || "$total" -eq 0 ]]; then
        health_result FAIL "DRAM: 无法读取 /proc/meminfo"
        return
    fi
    percent=$((available * 100 / total))
    if (( percent < 2 )); then
        health_result FAIL "DRAM: 可用 ${available}KiB (${percent}%)，低于 2%"
    elif (( percent < 10 )); then
        health_result WARN "DRAM: 可用 ${available}KiB (${percent}%)，低于 10%"
    else
        health_result PASS "DRAM: 总量 ${total}KiB，可用 ${available}KiB (${percent}%)"
    fi
}

health_hugepages() {
    local dir size nr free used
    shopt -s nullglob
    local dirs=(/sys/kernel/mm/hugepages/hugepages-*)
    shopt -u nullglob
    if (( ${#dirs[@]} == 0 )); then
        health_result WARN "HugePage: 未发现 hugepages sysfs 目录"
        return
    fi
    for dir in "${dirs[@]}"; do
        size=${dir##*/hugepages-}
        nr=$(cat "$dir/nr_hugepages" 2>/dev/null || echo '?')
        free=$(cat "$dir/free_hugepages" 2>/dev/null || echo '?')
        if [[ "$nr" =~ ^[0-9]+$ && "$free" =~ ^[0-9]+$ ]]; then
            used=$((nr - free))
            if (( nr > 0 && free == 0 )); then
                health_result WARN "HugePage($size): 配置=$nr，空闲=0，已用=$used"
            else
                health_result PASS "HugePage($size): 配置=$nr，空闲=$free，已用=$used"
            fi
        else
            health_result WARN "HugePage($size): 无法读取配置或空闲页"
        fi
    done
}

health_gpu() {
    if ! have nvidia-smi; then
        health_result WARN "GPU: 未找到 nvidia-smi"
        return
    fi
    local cards
    cards=$(nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || true)
    if [[ -z "$cards" ]]; then
        health_result FAIL "GPU: nvidia-smi 无法读取显卡状态"
    else
        health_result PASS "GPU: $(echo "$cards" | tr '\n' ';' | sed 's/;$//') MiB(卡号,已用,总量)"
    fi
}

check_health() {
    HEALTH_PASS=0; HEALTH_WARN=0; HEALTH_FAIL=0
    log "=== 环境健康检查 ==="
    health_service containerd
    health_service kubelet
    health_cni
    health_api_network
    health_dram
    health_hugepages
    health_gpu
    log "健康检查完成: PASS=$HEALTH_PASS WARN=$HEALTH_WARN FAIL=$HEALTH_FAIL"
    (( HEALTH_FAIL == 0 ))
}

# ---------------- 编排 ----------------
DEFAULT_STEPS="crond,containers,gpu"
VALID_STEPS="crond containers gpu kubelet kube-proxy hugepages"

do_standardize() {
    local steps="$STEPS"
    [[ -z "${steps// /}" ]] && steps="$DEFAULT_STEPS"
    # 支持逗号分隔
    steps=$(echo "$steps" | tr ',' ' ')
    log "==== BNT 标准化开始 steps=[$steps] dry=$DRY_RUN node=${NODE:-auto} ===="
    local s
    for s in $steps; do
        case "$s" in
            crond) [[ "${NO_CROND:-0}" == "1" ]] || step_crond ;;
            containers) step_containers || return 1 ;;
            gpu) step_kill_gpu ;;
            kubelet) step_svc kubelet ;;
            kube-proxy) step_svc kube-proxy ;;
            hugepages) step_hugepages ;;
            *) die "未知 step: $s (可选: $VALID_STEPS)";;
        esac
    done
    log "==== 清理完成，开始环境健康检查 ===="
    if ! check_health; then
        log "==== BNT 标准化失败：清理后环境检查未通过 (日志: $LOG_FILE) ===="
        return 1
    fi
    log "==== BNT 标准化完成，环境检查通过 (日志: $LOG_FILE) ===="
}

# ---------------- 远端执行 ----------------
remote_scp() {
    if [[ -n "$SSH_PASSWORD" ]]; then
        have sshpass || die "SSH_PASSWORD 已设置但未找到 sshpass"
        SSHPASS="$SSH_PASSWORD" sshpass -e scp "$@"
    else
        scp "$@"
    fi
}

remote_ssh() {
    if [[ -n "$SSH_PASSWORD" ]]; then
        have sshpass || die "SSH_PASSWORD 已设置但未找到 sshpass"
        SSHPASS="$SSH_PASSWORD" sshpass -e ssh "$@"
    else
        ssh "$@"
    fi
}

do_remote() {
    local ip="$1" target self remote_env pair key
    target="${SSH_USER}@${ip}"
    local self; self=$(readlink -f "$0" 2>/dev/null || echo "$0")
    log "推送脚本到 $target:$SSH_PORT 并执行 $ACTION"
    remote_scp -P "$SSH_PORT" -q "$self" "$target:/tmp/bnt-standalone.sh" || return 1

    remote_env=""
    for key in ACTION STEPS DRY_RUN NODE WHITELIST_NS NO_CROND SERVICE HUGEPAGE_PATH LOG_FILE CLEANUP_TIMEOUT_SECONDS CLEANUP_POLL_SECONDS; do
        printf -v pair '%q' "$key=${!key:-}"
        remote_env+=" $pair"
    done
    remote_ssh -p "$SSH_PORT" "$target" \
        "env REMOTE_EXECUTION=1 TARGET_HOSTS= $remote_env bash /tmp/bnt-standalone.sh"
}

target_ips() {
    local hosts="$TARGET_HOSTS"
    if [[ "$hosts" == \[* ]]; then
        printf '%s' "$hosts" | grep -oE '"ip"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/'
    else
        tr ',' '\n' <<<"$hosts" | sed '/^[[:space:]]*$/d; s/^[[:space:]]*//; s/[[:space:]]*$//'
    fi
}

do_targets() {
    local ip count=0
    while IFS= read -r ip; do
        [[ -z "$ip" ]] && continue
        do_remote "$ip" || return 1
        ((count += 1))
    done < <(target_ips)
    if (( count == 0 )); then
        die "TARGET_HOSTS 未包含可用 IP"
    fi
}

# ---------------- main ----------------
main() {
    [[ $# -eq 0 ]] || die "不支持命令行参数；请使用环境变量配置"
    [[ "$DRY_RUN" =~ ^[01]$ ]] || die "DRY_RUN 必须为 0 或 1"
    [[ "$CLEANUP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "CLEANUP_TIMEOUT_SECONDS 必须为正整数"
    [[ "$CLEANUP_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "CLEANUP_POLL_SECONDS 必须为正整数"
    if [[ -n "$TARGET_HOSTS" && "$REMOTE_EXECUTION" != "1" ]]; then
        do_targets
        return
    fi
    case "$ACTION" in
        standardize) do_standardize;;
        clean-containers) step_containers || return 1; log "完成 (日志 $LOG_FILE)";;
        kill-gpu) step_kill_gpu; log "完成 (日志 $LOG_FILE)";;
        check-health) check_health;;
        svc) [[ "$SERVICE" == "kubelet" || "$SERVICE" == "kube-proxy" ]] || die "SERVICE 必须为 kubelet 或 kube-proxy"; step_svc "$SERVICE";;
        hugepages) step_hugepages "$HUGEPAGE_PATH";;
        *) die "未知 ACTION: $ACTION";;
    esac
}

main "$@"
