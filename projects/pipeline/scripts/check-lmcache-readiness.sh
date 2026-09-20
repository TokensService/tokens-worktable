#!/usr/bin/env bash
# pipeline: no-positional-args
# LMCache sidecar 就绪检查（只读，不修改任何状态）：
#   1. 发现命名空间内所有带 lmcache-sidecar 容器的 Pod（NAMESPACE 留空时自动发现）
#   2. 轮询每个 sidecar 的 HTTP /status，直到 registered_gpu_ids 数量达到每 Pod
#      期望 GPU rank 数且整体 is_healthy=true（覆盖 L1/L2/store/prefetch 子系统）
#   3. worker_liveness.registration_grace_seconds>0 时输出回收风险提示
# 供 deploy-model.sh 在模型注册完成后调用；也可在打流前单独执行：
#   NAMESPACE=xds-xxx bash check-lmcache-readiness.sh
# 输出契约（stdout KEY=VALUE，供流水线下游阶段引用）：
#   LMCACHE_HEALTH=PASS|FAIL|DEGRADED
#   LMCACHE_SIDECAR_PODS=<参与检查的 sidecar Pod 数>
#   LMCACHE_GPU_WORKERS=<每 Pod 期望 GPU rank 数>
# 退出码：0=PASS；1=参数/依赖错误；2=FAIL（超时后仍无任何 GPU context 注册，
#   或始终未发现 sidecar Pod）；3=DEGRADED（部分注册或子系统不健康——缓存旁路
#   不影响推理服务，deploy-model 默认仅告警不阻塞，LMCACHE_STRICT=1 时升级为失败）
# 环境变量：NAMESPACE(留空=自动发现，多候选报错)、LMCACHE_GPU_WORKERS(0=默认4)、
#   LMCACHE_READY_TIMEOUT_SECONDS(默认1200)、LMCACHE_READY_POLL_SECONDS(默认15)、
#   SIDECAR_CONTAINER(默认lmcache-sidecar)、REQUEST_TIMEOUT_SECONDS(默认10)、
#   CONTRACT_OUTPUT(默认1：输出 KEY=VALUE 契约行；被 deploy-model 捕获时可设 0 避免重复)、
#   LOG_FILE
# 依赖：本机 kubectl + python3；sidecar 容器需自带 curl。
# 注意：/metrics 的 lmcache_mp_* 计数器在首次使用前不存在（懒注册），
#       不能作为就绪信号，必须用 /status。
set -uo pipefail

NAMESPACE="${NAMESPACE:-}"
LMCACHE_GPU_WORKERS="${LMCACHE_GPU_WORKERS:-0}"
TIMEOUT_SECONDS="${LMCACHE_READY_TIMEOUT_SECONDS:-1200}"
POLL_SECONDS="${LMCACHE_READY_POLL_SECONDS:-15}"
SIDECAR_CONTAINER="${SIDECAR_CONTAINER:-lmcache-sidecar}"
REQUEST_TIMEOUT_SECONDS="${REQUEST_TIMEOUT_SECONDS:-10}"
CONTRACT_OUTPUT="${CONTRACT_OUTPUT:-1}"
LOG_FILE="${LOG_FILE:-/tmp/check-lmcache-readiness_$(date +%Y%m%d_%H%M%S).log}"
LOG_PREFIX='[lmcache-check]'

log() {
    local ts line
    ts=$(date +'%Y-%m-%d %H:%M:%S')
    line="[$ts] $LOG_PREFIX $*"
    echo "$line"
    echo "$line" >>"$LOG_FILE"
}
die() {
    log "ERROR: $*"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $LOG_PREFIX ERROR: $*" >&2
    exit 1
}
# 只读发现类调用必须带请求超时；exec/status 探测由容器内 curl --max-time 兜底
KCTL() { kubectl --request-timeout="${REQUEST_TIMEOUT_SECONDS}s" "$@"; }

# 全集群扫描含 sidecar 容器的 pod，输出候选命名空间（每行一个，可能为空）
namespace_candidates() {
    KCTL get pods -A -o custom-columns='NS:.metadata.namespace,CONTAINERS:.spec.containers[*].name' --no-headers 2>/dev/null \
        | awk -v c=",$SIDECAR_CONTAINER," 'index(","$NF",", c){print $1}' | sort -u
}

# 输出带 sidecar 容器的 pod 名列表
sidecar_pod_list() {
    KCTL get pods -n "$NAMESPACE" -o custom-columns='NAME:.metadata.name,CONTAINERS:.spec.containers[*].name' --no-headers 2>/dev/null \
        | awk -v c=",$SIDECAR_CONTAINER," 'index(","$NF",", c){print $1}'
}

# sidecar HTTP 端口是动态租约，从容器 ports.env 读实际值（pod spec 的 containerPort 不准）
pod_http_port() {
    local pod=$1 port
    port=$(kubectl exec -n "$NAMESPACE" "$pod" -c "$SIDECAR_CONTAINER" -- \
        bash -c "grep -oE 'LMCACHE_HTTP_PORT=[0-9]+' /etc/lmcache-ports/ports.env | head -1 | cut -d= -f2" 2>/dev/null) || return 1
    [[ "$port" =~ ^[0-9]+$ ]] || return 1
    echo "$port"
}

# 拉取 sidecar /status JSON；失败（容器未就绪/curl 超时）返回非 0
pod_status_json() {
    local pod=$1 port
    port=$(pod_http_port "$pod") || return 1
    kubectl exec -n "$NAMESPACE" "$pod" -c "$SIDECAR_CONTAINER" -- \
        bash -c "curl -s --noproxy '*' --max-time 3 http://127.0.0.1:$port/status" 2>/dev/null || return 1
}

# 解析 /status：输出 "registered<TAB>healthy<TAB>grace"；解析失败返回非 0
parse_status() {
    python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
registered = data.get("registered_gpu_ids") or []
healthy = 1 if data.get("is_healthy") is True else 0
grace = (data.get("worker_liveness") or {}).get("registration_grace_seconds", 0)
try:
    grace = int(grace)
except (TypeError, ValueError):
    grace = 0
print(len(registered), healthy, grace, sep="\t")
'
}

# 探测单个 pod：成功时设置 PROBE_REGISTERED/PROBE_HEALTHY/PROBE_GRACE 并返回 0
probe_pod() {
    local pod=$1 parsed
    PROBE_REGISTERED=0 PROBE_HEALTHY=0 PROBE_GRACE=0
    parsed=$(pod_status_json "$pod" | parse_status) || return 1
    IFS=$'\t' read -r PROBE_REGISTERED PROBE_HEALTHY PROBE_GRACE <<<"$parsed"
    return 0
}

emit_contract() { # $1=health $2=pod 数
    [[ "$CONTRACT_OUTPUT" == 1 ]] || return 0
    printf 'LMCACHE_HEALTH=%s\n' "$1"
    printf 'LMCACHE_SIDECAR_PODS=%s\n' "$2"
    printf 'LMCACHE_GPU_WORKERS=%s\n' "$LMCACHE_GPU_WORKERS"
}

main() {
    [[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "LMCACHE_READY_TIMEOUT_SECONDS 必须为正整数: $TIMEOUT_SECONDS"
    [[ "$POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "LMCACHE_READY_POLL_SECONDS 必须为正整数: $POLL_SECONDS"
    [[ "$REQUEST_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "REQUEST_TIMEOUT_SECONDS 必须为正整数: $REQUEST_TIMEOUT_SECONDS"
    [[ "$LMCACHE_GPU_WORKERS" =~ ^[0-9]+$ ]] || die "LMCACHE_GPU_WORKERS 必须为非负整数: $LMCACHE_GPU_WORKERS"
    ((LMCACHE_GPU_WORKERS > 0)) || LMCACHE_GPU_WORKERS=4
    command -v kubectl >/dev/null 2>&1 || die '本机需要 kubectl'
    command -v python3 >/dev/null 2>&1 || die '本机需要 python3'

    log "LMCache sidecar 就绪检查: timeout=${TIMEOUT_SECONDS}s poll=${POLL_SECONDS}s 期望rank=${LMCACHE_GPU_WORKERS}/pod"

    local deadline=$((SECONDS + TIMEOUT_SECONDS))
    local found_any=false any_registered=0 grace_notified=false
    local -a pods=()
    local pod progress

    while ((SECONDS < deadline)); do
        if [[ -z "$NAMESPACE" ]]; then
            local candidates
            candidates=$(namespace_candidates)
            if (( $(wc -l <<<"${candidates:-""}") > 1 )); then
                die "多个命名空间存在 $SIDECAR_CONTAINER，请显式设置 NAMESPACE: $(echo $candidates | tr '\n' ' ')"
            fi
            [[ -n "$candidates" ]] && NAMESPACE=$candidates
        fi
        mapfile -t pods < <({ [[ -n "$NAMESPACE" ]] && sidecar_pod_list; })

        if ((${#pods[@]} == 0)); then
            log "未发现 $SIDECAR_CONTAINER Pod（部署可能仍在滚动），继续等待..."
        else
            found_any=true
            local ready_count=0
            progress=""
            for pod in "${pods[@]}"; do
                if probe_pod "$pod"; then
                    progress+="${pod##*worker-}:${PROBE_REGISTERED}/${LMCACHE_GPU_WORKERS}"
                    if ((PROBE_REGISTERED > 0)); then any_registered=1; fi
                    if ((PROBE_REGISTERED >= LMCACHE_GPU_WORKERS)) && ((PROBE_HEALTHY == 1)); then
                        progress+="✓ "
                        ready_count=$((ready_count + 1))
                    else
                        progress+="… "
                    fi
                    if ((PROBE_GRACE > 0)) && [[ "$grace_notified" == false ]]; then
                        grace_notified=true
                        log "提示: registration_grace_seconds=${PROBE_GRACE}>0——sidecar 静默超过该时长后 GPU context 会被回收且引擎不会重连；建议尽快打流，或渲染参数改为 --worker-registration-grace-seconds 0"
                    fi
                else
                    progress+="${pod##*worker-}:探活失败… "
                fi
            done
            log "进度 ${ready_count}/${#pods[@]} 就绪 | $progress"

            if ((ready_count == ${#pods[@]})); then
                log "LMCache 就绪: ${#pods[@]} 个 sidecar 全部注册 ${LMCACHE_GPU_WORKERS} rank 且健康"
                emit_contract PASS "${#pods[@]}"
                return 0
            fi
        fi
        sleep "$POLL_SECONDS"
    done

    if [[ "$found_any" != true ]]; then
        log "FAIL: ${TIMEOUT_SECONDS}s 内未发现 $SIDECAR_CONTAINER Pod；若本次部署未启用 LMCache，请在部署侧设 ENABLE_LMCACHE=false 跳过检查"
        emit_contract FAIL 0
        return 2
    fi
    if ((any_registered == 0)); then
        log "FAIL: 超时 ${TIMEOUT_SECONDS}s，所有 sidecar 的 GPU context 注册数仍为 0（引擎可能未连接 sidecar）"
        emit_contract FAIL "${#pods[@]}"
        return 2
    fi
    log "DEGRADED: 超时 ${TIMEOUT_SECONDS}s，部分 sidecar 未完成注册或子系统不健康；缓存旁路不影响推理服务"
    emit_contract DEGRADED "${#pods[@]}"
    return 3
}

main "$@"
