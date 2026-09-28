#!/usr/bin/env bash
# pipeline: no-positional-args
# 热清理 XDS+LMCache 部署的三层缓存（无需重启服务，全部经 kubectl exec 完成，无需 SSH）：
#   L1  (DRAM)        : 每个带 lmcache-sidecar 的 pod 内 POST http://127.0.0.1:<动态端口>/cache/clear
#   HBM (prefix cache): XDS FE OM diagnose reset_prefix_cache（所有 prefill/decode actor 异步调度）
#   L2  (fs_native 磁盘): sidecar 容器内 find <base_path> -type f -delete（按 node:path 去重）
# 环境变量：DRY_RUN(默认1)、NAMESPACE(留空时自动发现，多个候选则报错)、
#   CLEAR_L1/CLEAR_HBM/CLEAR_L2(默认1)、FE_URL(留空自动从 NodePort 发现)、
#   SERVICE_NAME(默认ray-svc)、SIDECAR_CONTAINER(默认lmcache-sidecar)、
#   FRONTGROUP_PATTERN(默认frontgroup)、IDLE_CHECK(默认1)、IDLE_SECONDS(默认60)、
#   HBM_VERIFY(默认1：reset 后轮询引擎日志确认 success，而非仅确认已调度)、
#   HBM_RESET_PARAMS(默认"true true"：reset_running_requests reset_connector；
#     第二个 true 会连 connector 一起重置，可解开卡死的 KV transfer 会话——
#     "true false" 遇到 sidecar active_sessions 卡住不降时永远失败)，
#   TE_POD_PATTERN(默认'prefill|decode'：承载 vllm 引擎的 pod 名匹配)、
#   HBM_VERIFY_TIMEOUT_SECONDS(默认120)、HBM_POLL_SECONDS(默认3)、
#   VERIFY_TIMEOUT_SECONDS(默认30)、L2_DELETE_TIMEOUT(默认600)、
#   REQUEST_TIMEOUT_SECONDS(默认10)、LOG_FILE。
# 依赖：本机 kubectl（必须）与 curl（清 HBM 时）；sidecar 容器需自带 curl/find（官方镜像均含）。
# 注意：L2 的 l2_usage_bytes 指标是运行时记账，不感知外部删除，脚本以文件数归零为准。
set -uo pipefail

DRY_RUN="${DRY_RUN:-1}"
NAMESPACE="${NAMESPACE:-}"
CLEAR_L1="${CLEAR_L1:-1}"
CLEAR_HBM="${CLEAR_HBM:-1}"
CLEAR_L2="${CLEAR_L2:-1}"
FE_URL="${FE_URL:-}"
SERVICE_NAME="${SERVICE_NAME:-ray-svc}"
SIDECAR_CONTAINER="${SIDECAR_CONTAINER:-lmcache-sidecar}"
FRONTGROUP_PATTERN="${FRONTGROUP_PATTERN:-frontgroup}"
IDLE_CHECK="${IDLE_CHECK:-1}"
IDLE_SECONDS="${IDLE_SECONDS:-60}"
HBM_VERIFY="${HBM_VERIFY:-1}"
# reset_prefix_cache 的 OM 入参 "reset_running_requests reset_connector"。
# 默认 "true true"：连 connector 一起重置，能解开卡死会话（active_sessions 不归零、
# block 数不变的场景）；回退旧行为设 HBM_RESET_PARAMS="true false"。
HBM_RESET_PARAMS="${HBM_RESET_PARAMS:-true true}"
TE_POD_PATTERN="${TE_POD_PATTERN:-prefill|decode}"
HBM_VERIFY_TIMEOUT_SECONDS="${HBM_VERIFY_TIMEOUT_SECONDS:-120}"
HBM_POLL_SECONDS="${HBM_POLL_SECONDS:-3}"
VERIFY_TIMEOUT_SECONDS="${VERIFY_TIMEOUT_SECONDS:-30}"
L2_DELETE_TIMEOUT="${L2_DELETE_TIMEOUT:-600}"
REQUEST_TIMEOUT_SECONDS="${REQUEST_TIMEOUT_SECONDS:-10}"
LOG_FILE="${LOG_FILE:-/tmp/clear-lmcache-cache_$(date +%Y%m%d_%H%M%S).log}"
LOG_PREFIX='[clear-lmcache]'

log() {
    local ts line
    ts=$(date +'%Y-%m-%d %H:%M:%S')
    line="[$ts] $LOG_PREFIX $*"
    echo "$line"
    echo "$line" >> "$LOG_FILE"
}
die() {
    log "ERROR: $*"
    # 同时输出到 stderr：discover_namespace 等在 $( ) 命令替换中调用时，stdout 会被外层捕获吞掉
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $LOG_PREFIX ERROR: $*" >&2
    exit 1
}
run() {
    if [[ "$DRY_RUN" == 1 ]]; then
        log "[DRY_RUN] $*"
        return 0
    fi
    "$@"
}
have() { command -v "$1" >/dev/null 2>&1; }
# 所有 kubectl 只读发现类调用必须带请求超时，防止 API 卡住导致脚本挂死；
# exec 类调用（curl/清理）可能耗时较长，不设 --request-timeout，长操作由 timeout 命令兜底。
KCTL() { kubectl --request-timeout="${REQUEST_TIMEOUT_SECONDS}s" "$@"; }
now_epoch() { date -u +%s; }

# NAMESPACE 未设置时：全集群扫描含 sidecar 容器的 pod，候选唯一才继续
discover_namespace() {
    local ns candidates
    [[ -n "$NAMESPACE" ]] && { echo "$NAMESPACE"; return 0; }
    candidates=$(KCTL get pods -A -o custom-columns='NS:.metadata.namespace,CONTAINERS:.spec.containers[*].name' --no-headers 2>/dev/null \
        | awk -v c=",$SIDECAR_CONTAINER," 'index(","$NF",", c){print $1}' | sort -u)
    [[ -n "$candidates" ]] || die "未发现包含 $SIDECAR_CONTAINER 容器的 pod；请确认部署或设置 NAMESPACE"
    [[ $(wc -l <<< "$candidates") -eq 1 ]] || die "多个命名空间存在 $SIDECAR_CONTAINER，请显式设置 NAMESPACE: $(echo $candidates | tr '\n' ' ')"
    echo "$candidates"
}

# 输出 "pod<TAB>node" 行，仅含带 sidecar 容器的 pod
# 注意用默认 FS + $NF：custom-columns 输出多空格对齐，字符类 FS 会切出空字段
sidecar_pods() {
    KCTL get pods -n "$NAMESPACE" -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,CONTAINERS:.spec.containers[*].name' --no-headers 2>/dev/null \
        | awk -v c=",$SIDECAR_CONTAINER," 'index(","$NF",", c){print $1"\t"$2}'
}

# sidecar HTTP 端口是动态租约，必须从容器的 ports.env 读实际值（pod spec 里的 containerPort 是模板默认值，不准）
pod_http_port() {
    local pod=$1 port
    port=$(kubectl exec -n "$NAMESPACE" "$pod" -c "$SIDECAR_CONTAINER" -- bash -c "grep -oE 'LMCACHE_HTTP_PORT=[0-9]+' /etc/lmcache-ports/ports.env | head -1 | cut -d= -f2" 2>/dev/null) || return 1
    [[ "$port" =~ ^[0-9]+$ ]] || return 1
    echo "$port"
}

# L2 base_path 发现（两段式，均需本机 python3 解析 JSON）：
#   1) 运行时优先：sidecar 的 PID 1 是 exec 后的 lmcache server，/proc/1/cmdline 是 shell
#      展开后的真实 argv——新 chart 用变量+占位符+${LMCACHE_PORT_SLOT} 动态构造
#      --l2-adapter，静态 pod spec 里解析不到
#   2) 静态兜底：解析 pod spec 的 command/args（旧式单引号 JSON 直写）
# 注意不能只查 .args：模板可能把整段脚本放 command 或 args，两处都扫
pod_l2_path() {
    local pod=$1 path
    have python3 || die 'L2 base_path 发现依赖本机 python3（或设置 CLEAR_L2=0 跳过）'
    path=$(kubectl exec -n "$NAMESPACE" "$pod" -c "$SIDECAR_CONTAINER" -- bash -c "tr '\0' '\n' </proc/1/cmdline" 2>/dev/null | python3 -c '
import json, sys
argv = sys.stdin.read().split("\n")
for i, a in enumerate(argv[:-1]):
    if a == "--l2-adapter":
        try:
            print(json.loads(argv[i + 1])["base_path"])
        except Exception:
            sys.exit(1)
        sys.exit(0)
sys.exit(1)
') && [[ -n "$path" ]] && { echo "$path"; return 0; }
    KCTL get pod "$pod" -n "$NAMESPACE" -o json 2>/dev/null | python3 -c "
import json, re, sys
side = sys.argv[1]
try:
    pod = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for c in pod.get('spec', {}).get('containers', []):
    if c.get('name') != side:
        continue
    for a in c.get('args', []) + c.get('command', []):
        m = re.search(r\"--l2-adapter\s+'([^']+)'\", a)
        if m:
            print(json.loads(m.group(1))['base_path'])
            sys.exit(0)
sys.exit(1)
" "$SIDECAR_CONTAINER"
}

# frontgroup pod 最近一次 "get request" 的时间戳（UTC），无请求输出空
last_request_epoch() {
    local pod=$1 ts
    ts=$(kubectl exec -n "$NAMESPACE" "$pod" -- bash -c "grep 'get request' /opt/cloud/logs/xds/xds.log 2>/dev/null | tail -1 | grep -oE '\\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' | tr -d '['" 2>/dev/null) || return 0
    [[ -n "$ts" ]] || return 0
    date -u -d "$ts" +%s 2>/dev/null || return 0
}

# L2 删除是破坏性操作，必须先确认入口流量已停止（所有 frontgroup 最近请求早于 IDLE_SECONDS 前）
ensure_idle() {
    local pod epoch delta max_epoch=0 found=0
    while IFS=$'\t' read -r pod _; do
        [[ -n "$pod" ]] || continue
        found=1
        epoch=$(last_request_epoch "$pod")
        [[ "$epoch" =~ ^[0-9]+$ ]] && (( epoch > max_epoch )) && max_epoch=$epoch
    done < <(KCTL get pods -n "$NAMESPACE" -o custom-columns='NAME:.metadata.name' --no-headers 2>/dev/null | grep "$FRONTGROUP_PATTERN")
    (( found == 1 )) || { log "警告: 未发现匹配 '$FRONTGROUP_PATTERN' 的 pod，跳过流量空闲检查"; return 0; }
    (( max_epoch == 0 )) && { log "入口无历史请求记录，视为空闲"; return 0; }
    delta=$(( $(now_epoch) - max_epoch ))
    (( delta >= IDLE_SECONDS )) || die "流量未停止: 距最近请求仅 ${delta}s < ${IDLE_SECONDS}s；请先停止打流或调大 IDLE_SECONDS"
    log "流量已空闲 ${delta}s (>= ${IDLE_SECONDS}s)"
}

clear_l1() {
    local pod node port resp started value found=0
    log "== 清理 L1 (DRAM) =="
    while IFS=$'\t' read -r pod node; do
        [[ -n "$pod" ]] || continue
        found=1
        port=$(pod_http_port "$pod") || die "无法获取 $pod 的 LMCACHE_HTTP_PORT（sidecar 未就绪？）"
        log "L1 清理: $pod (node=$node, http_port=$port)"
        if [[ "$DRY_RUN" == 1 ]]; then
            run kubectl exec -n "$NAMESPACE" "$pod" -c "$SIDECAR_CONTAINER" -- curl -s --noproxy '*' -X POST "http://127.0.0.1:${port}/cache/clear" -H 'Content-Type: application/json' -d '{}'
            continue
        fi
        resp=$(kubectl exec -n "$NAMESPACE" "$pod" -c "$SIDECAR_CONTAINER" -- curl -s --noproxy '*' -X POST "http://127.0.0.1:${port}/cache/clear" -H 'Content-Type: application/json' -d '{}') \
            || die "L1 清理请求失败: $pod"
        [[ "$resp" == *'"ok"'* ]] || die "L1 清理响应异常: $pod => $resp"
        # lmcache 0.1.0 等版本的 /metrics 只有 prometheus 默认进程指标（无 lmcache_mp_*），
        # 先探测指标是否存在，不存在直接跳过归零验证，避免每 pod 空等 VERIFY_TIMEOUT_SECONDS
        if ! kubectl exec -n "$NAMESPACE" "$pod" -c "$SIDECAR_CONTAINER" -- curl -s --noproxy '*' "http://127.0.0.1:${port}/metrics" 2>/dev/null \
            | grep -q '^lmcache_mp_l1_memory_usage_bytes'; then
            log "提示: $pod 不导出 lmcache_mp_l1 指标，跳过归零验证（清理请求已被受理）"
            continue
        fi
        # 指标为异步记账，轮询确认归零
        started=$SECONDS
        while :; do
            value=$(kubectl exec -n "$NAMESPACE" "$pod" -c "$SIDECAR_CONTAINER" -- curl -s --noproxy '*' "http://127.0.0.1:${port}/metrics" 2>/dev/null \
                | awk '/^lmcache_mp_l1_memory_usage_bytes/ {print $2; exit}')
            [[ "$value" == 0.0 ]] && { log "L1 已归零: $pod"; break; }
            (( SECONDS - started < VERIFY_TIMEOUT_SECONDS )) || { log "警告: $pod L1 指标 ${value:-无} 未在 ${VERIFY_TIMEOUT_SECONDS}s 内归零（清理已受理，可能仍在异步回收）"; break; }
            sleep 2
        done
    done < <(sidecar_pods)
    # 空命名空间/未部署 LMCache 必须硬失败，禁止静默空跑后以 0 退出（假成功）
    (( found == 1 )) || die "L1 清理: $NAMESPACE 中未发现带 $SIDECAR_CONTAINER 容器的 pod（命名空间填错或未部署 LMCache？设 CLEAR_L1=0 可显式跳过）"
}

# FE 地址自动发现：Service NodePort + 任一 sidecar pod 所在节点 IP
discover_fe_url() {
    local node_port node ip
    node_port=$(KCTL get svc "$SERVICE_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null) \
        || die "未找到 Service $NAMESPACE/$SERVICE_NAME；请设置 FE_URL 或 SERVICE_NAME"
    [[ "$node_port" =~ ^[1-9][0-9]*$ ]] || die "Service $NAMESPACE/$SERVICE_NAME 无 NodePort；请直接设置 FE_URL"
    node=$(sidecar_pods | head -1 | cut -f2)
    [[ -n "$node" ]] || die "无法定位节点 IP；请直接设置 FE_URL"
    if [[ "$node" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        ip=$node
    else
        ip=$(KCTL get node "$node" -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null) || die "无法解析节点 $node 的 IP"
    fi
    echo "http://${ip}:${node_port}"
}

# HBM reset 的引擎侧结果标识（ray-worker 容器 /opt/cloud/logs/vllm/*.log，UTC 时间戳）：
#   prefill pod: TE 侧 prefix_cache.py「reset_prefix_cache async task done, success.」
#                + 引擎侧 block_pool.py「Successfully reset prefix cache」各一条
#   decode pod : 仅 block_pool.py「Successfully reset prefix cache」（每个 dp 引擎一条）
HBM_RESET_SUCCESS_RE='reset_prefix_cache async task done, success|Successfully reset prefix cache'

# 承载 vllm 引擎（TE actor）的 pod：reset 结果日志写在这些 pod 的 ray-worker 容器里
te_pods() {
    KCTL get pods -n "$NAMESPACE" -o custom-columns='NAME:.metadata.name' --no-headers 2>/dev/null | grep -E "$TE_POD_PATTERN"
}

# 引擎日志行数快照（"count filename" 行，wc 多文件时末尾有 total 行，调用方过滤）
hbm_log_wc() {
    kubectl exec -n "$NAMESPACE" "$1" -c ray-worker -- bash -c 'cd /opt/cloud/logs/vllm 2>/dev/null && wc -l *.log' 2>/dev/null || true
}

# reset 前快照：actor 收到调度后毫秒级就会写 success 日志，必须先记基线再发 reset
declare -A HBM_SNAP=()
hbm_snapshot() {
    local pod cnt fname
    HBM_SNAP=()
    for pod in $(te_pods); do
        while read -r cnt fname; do
            [[ "$fname" == *.log ]] || continue
            HBM_SNAP["${pod}|${fname}"]=$cnt
        done < <(hbm_log_wc "$pod")
    done
}

# 输出 pod 自快照后新增的引擎日志行（按行数差；文件轮转/重建 shrink 视为全量新增）
hbm_new_lines() {
    local pod=$1 cnt fname from
    while read -r cnt fname; do
        [[ "$fname" == *.log ]] || continue
        from=${HBM_SNAP["${pod}|${fname}"]:-0}
        (( cnt < from )) && from=0
        (( cnt > from )) || continue
        kubectl exec -n "$NAMESPACE" "$pod" -c ray-worker -- sed -n "$((from + 1)),${cnt}p" "/opt/cloud/logs/vllm/$fname" 2>/dev/null || true
    done < <(hbm_log_wc "$pod")
}

# 轮询每个引擎 pod 的新增日志：
#   任一 pod 出现 Traceback 或非 success 的 async task done → 立即失败（响亮报错优于静默漏清）
#   全部 pod 出现 success 标识 → 通过；超时仍缺 → 报错并列出未确认 pod
verify_hbm_reset() {
    local pods pod newlines started total
    pods=$(te_pods)
    [[ -n "$pods" ]] || die "未发现匹配 '$TE_POD_PATTERN' 的引擎 pod，无法验证 HBM reset（调整 TE_POD_PATTERN 或设 HBM_VERIFY=0）"
    total=$(wc -w <<< "$pods")
    local -A confirmed=()
    started=$SECONDS
    while :; do
        for pod in $pods; do
            [[ -n "${confirmed[$pod]+x}" ]] && continue
            newlines=$(hbm_new_lines "$pod")
            if grep -q 'Traceback (most recent call last)' <<< "$newlines"; then
                die "HBM reset 引擎侧异常(Traceback): $pod，缓存可能未清干净，请查引擎日志"
            fi
            if grep 'reset_prefix_cache async task done' <<< "$newlines" | grep -qv 'success'; then
                die "HBM reset 引擎侧失败: $pod（async task done 非 success）"
            fi
            if grep -qE "$HBM_RESET_SUCCESS_RE" <<< "$newlines"; then
                confirmed[$pod]=1
                log "HBM reset 引擎确认 success: $pod"
            fi
        done
        (( ${#confirmed[@]} == total )) && { log "HBM reset 全部引擎确认 success (${total} 个 pod)"; return 0; }
        (( SECONDS - started >= HBM_VERIFY_TIMEOUT_SECONDS )) && die "HBM reset 引擎 success 确认超时(${HBM_VERIFY_TIMEOUT_SECONDS}s)，未确认 pod: $(printf '%s\n' $pods | grep -vx -f <(printf '%s\n' "${!confirmed[@]}") | tr '\n' ' ')"
        sleep "$HBM_POLL_SECONDS"
    done
}

clear_hbm() {
    local url resp scheduled
    log "== 清理 HBM prefix cache =="
    if [[ -z "$FE_URL" ]]; then
        # die 在 $() 子 shell 内不会终止主脚本，必须在此处（主 shell）转成硬失败
        FE_URL=$(discover_fe_url) \
            || die "无法发现 FE URL（Service $NAMESPACE/$SERVICE_NAME 不存在？）；请检查 NAMESPACE 或设置 FE_URL"
    fi
    log "HBM 清理: POST $FE_URL/xds/v1/OM/diagnose/post (reset_prefix_cache)"
    if [[ "$DRY_RUN" == 1 ]]; then
        run curl -s --noproxy '*' -X POST "$FE_URL/xds/v1/OM/diagnose/post" -H 'Content-Type: application/json' \
            -d '{"cmd":"reset_prefix_cache","params":"'"$HBM_RESET_PARAMS"'","filter":""}'
        return 0
    fi
    # 快照必须先于 POST：调度是毫秒级异步的，晚记基线会漏掉 success 行
    if (( HBM_VERIFY )); then
        hbm_snapshot
    fi
    resp=$(curl -s --noproxy '*' -X POST "$FE_URL/xds/v1/OM/diagnose/post" -H 'Content-Type: application/json' \
        -d '{"cmd":"reset_prefix_cache","params":"'"$HBM_RESET_PARAMS"'","filter":""}') || die "HBM 清理请求失败: $FE_URL"
    # OM diagnose 返回非严格 JSON（多对象拼接），只能 grep 计数
    scheduled=$(grep -o 'reset_prefix_cache scheduled' <<< "$resp" | wc -l)
    log "HBM reset_prefix_cache 已调度到 $scheduled 个 actor"
    (( scheduled > 0 )) || die "HBM 清理无 actor 响应: $resp"
    if (( HBM_VERIFY )); then
        verify_hbm_reset
    else
        log "HBM_VERIFY=0：仅确认已调度，不验证引擎 success"
    fi
}

clear_l2() {
    local pod node path before after found=0
    declare -A seen=()
    log "== 清理 L2 (磁盘 fs_native) =="
    while IFS=$'\t' read -r pod node; do
        [[ -n "$pod" ]] || continue
        found=1
        path=$(pod_l2_path "$pod") || { log "警告: $pod 未配置 L2 (无 --l2-adapter base_path)，跳过"; continue; }
        [[ -n "$path" ]] || { log "警告: $pod L2 base_path 解析为空，跳过"; continue; }
        # 同节点多个 sidecar 共享同一 L2 目录（hostPath），按 node:path 去重只删一次
        [[ -n "${seen[${node}|${path}]+x}" ]] && continue
        seen["${node}|${path}"]=1
        before=$(kubectl exec -n "$NAMESPACE" "$pod" -c "$SIDECAR_CONTAINER" -- find "$path" -type f 2>/dev/null | wc -l)
        log "L2 清理: $pod (node=$node, path=$path, 当前 ${before} 个文件)"
        if [[ "$DRY_RUN" == 1 ]]; then
            run kubectl --request-timeout="${L2_DELETE_TIMEOUT}s" exec -n "$NAMESPACE" "$pod" -c "$SIDECAR_CONTAINER" -- find "$path" -type f -delete
            continue
        fi
        # exec 属长操作，用 kubectl 自带 --request-timeout 兜底（不用外置 timeout，便于测试与函数封装）
        kubectl --request-timeout="${L2_DELETE_TIMEOUT}s" exec -n "$NAMESPACE" "$pod" -c "$SIDECAR_CONTAINER" -- find "$path" -type f -delete \
            || die "L2 删除失败或超时(${L2_DELETE_TIMEOUT}s): $pod $path"
        after=$(kubectl exec -n "$NAMESPACE" "$pod" -c "$SIDECAR_CONTAINER" -- find "$path" -type f 2>/dev/null | wc -l)
        [[ "$after" == 0 ]] || die "L2 删除后仍有 ${after} 个文件: $pod $path"
        log "L2 已清空: $pod $path"
    done < <(sidecar_pods)
    (( found == 1 )) || die "L2 清理: $NAMESPACE 中未发现带 $SIDECAR_CONTAINER 容器的 pod（命名空间填错或未部署 LMCache？设 CLEAR_L2=0 可显式跳过）"
}

main() {
    [[ $# -eq 0 ]] || die '不支持命令行参数；请使用环境变量配置'
    local bool_vars=(DRY_RUN CLEAR_L1 CLEAR_HBM CLEAR_L2 IDLE_CHECK HBM_VERIFY)
    local int_vars=(IDLE_SECONDS VERIFY_TIMEOUT_SECONDS L2_DELETE_TIMEOUT REQUEST_TIMEOUT_SECONDS HBM_VERIFY_TIMEOUT_SECONDS HBM_POLL_SECONDS)
    local v
    for v in "${bool_vars[@]}"; do
        [[ "${!v}" =~ ^[01]$ ]] || die "$v 必须为 0 或 1"
    done
    for v in "${int_vars[@]}"; do
        [[ "${!v}" =~ ^[1-9][0-9]*$ ]] || die "$v 必须为正整数"
    done
    [[ "$HBM_RESET_PARAMS" =~ ^(true|false)[[:space:]]+(true|false)$ ]] \
        || die 'HBM_RESET_PARAMS 必须是 "reset_running_requests reset_connector" 两个 true/false（如 "true true"）'
    have kubectl || die '需要 kubectl'
    KCTL version >/dev/null 2>&1 || die 'kubectl 无法访问 Kubernetes API'
    (( CLEAR_HBM )) && ! have curl && die '清 HBM 需要本机安装 curl（或设置 CLEAR_HBM=0 跳过）'

    NAMESPACE=$(discover_namespace) || die 'NAMESPACE 自动发现失败'
    log "目标命名空间: $NAMESPACE (DRY_RUN=$DRY_RUN, L1=$CLEAR_L1 HBM=$CLEAR_HBM L2=$CLEAR_L2)"

    if (( CLEAR_L2 && IDLE_CHECK )); then
        ensure_idle
    fi
    # 阶段失败必须终止并返回非零：否则空命名空间会静默空跑后以 0 退出（假成功）
    if (( CLEAR_L1 )); then clear_l1 || exit 1; fi
    if (( CLEAR_HBM )); then clear_hbm || exit 1; fi
    if (( CLEAR_L2 )); then clear_l2 || exit 1; fi
    log "三层缓存清理流程完成 (DRY_RUN=$DRY_RUN)"
}

main "$@"
