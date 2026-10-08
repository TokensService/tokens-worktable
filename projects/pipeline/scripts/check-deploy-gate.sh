#!/usr/bin/env bash
# check-deploy-gate.sh - 部署准入门禁：在拉取/渲染/部署阶段之前把关运行输入与目标机就绪状态。
# pipeline: no-positional-args
# 只读检查，不创建/删除任何资源；任一 FAIL 即非零退出，流水线在绑定位置被阻断。
# 绑成普通阶段（放在部署阶段之前）或在「设置」页选为环境检查脚本均可生效。
#
# 环境变量（流水线自动注入，或在阶段参数行覆盖；同名显式参数优先）：
#   IMAGE_NAME         镜像名（主控「镜像名」；与 DEPLOY_IMAGE 至少其一非空）
#   DEPLOY_IMAGE       完整部署镜像（可选，优先于 IMAGE_NAME:IMAGE_TAG）
#   IMAGE_TAG          本次运行 tag（仅日志展示）
#   TARGET_HOSTS       目标节点 JSON 数组 [{ip,user,pass}]（与 TARGET_IPS 均为空时只做执行机输入检查）
#   TARGET_IPS         全部目标 IP 的 JSON 数组（无 python3/jq 解析 TARGET_HOSTS 时的兜底）
#   TARGET_USER        兜底节点用户名（默认 root）
#   TARGET_PASSWORD    兜底节点密码（默认空；不要写默认值）
#   SSH_PORT           SSH 端口（默认 22）
#   MIN_GPU            每节点最少 GPU 卡数（留空自动取 PREFILL_GPU/DECODE_GPU 较大值，仍为空则 1；0=跳过 GPU 检查）
#   PREFILL_GPU        每个 Prefill 实例的 GPU 数（仅用于推导 MIN_GPU）
#   DECODE_GPU         每个 Decode 实例的 GPU 数（仅用于推导 MIN_GPU）
#   MIN_DISK_FREE_GIB  目标机运行目录所在盘最小剩余 GiB（默认 20）
#   TARGET_RUN_DIR     目标机运行目录（默认 /tmp/op-test-pipeline）
#   NAMESPACE          部署命名空间（可选；与 IMAGE_PULL_SECRETS 一起启用 Secret 检查）
#   IMAGE_PULL_SECRETS  逗号分隔的镜像凭证 Secret 列表（可选；命名空间内缺失判 FAIL）
#   LOG_FILE           检查日志文件（默认 /tmp/check-deploy-gate_<时间戳>.log）
#
# 控制节点为 TARGET_HOSTS 首节点（deploy-model.sh 契约）：kubectl/helm/curl 缺失在控制节点
# 判 FAIL，其余节点判 WARN。凭据只用于 SSH 登录，不打印；脚本输出 GATE_RESULT=PASS|FAIL 供下游引用。
set -uo pipefail

# ---------------- 全局 ----------------
LOG_PREFIX="[deploy-gate]"
LOG_FILE="${LOG_FILE:-/tmp/check-deploy-gate_$(date +%Y%m%d_%H%M%S).log}"
IMAGE_NAME="${IMAGE_NAME:-}"
DEPLOY_IMAGE="${DEPLOY_IMAGE:-}"
IMAGE_TAG="${IMAGE_TAG:-}"
TARGET_HOSTS="${TARGET_HOSTS:-}"
TARGET_IPS="${TARGET_IPS:-}"
TARGET_USER="${TARGET_USER:-root}"
TARGET_PASSWORD="${TARGET_PASSWORD:-}"
SSH_PORT="${SSH_PORT:-22}"
MIN_GPU="${MIN_GPU:-}"
PREFILL_GPU="${PREFILL_GPU:-}"
DECODE_GPU="${DECODE_GPU:-}"
MIN_DISK_FREE_GIB="${MIN_DISK_FREE_GIB:-20}"
TARGET_RUN_DIR="${TARGET_RUN_DIR:-/tmp/op-test-pipeline}"
NAMESPACE="${NAMESPACE:-}"
IMAGE_PULL_SECRETS="${IMAGE_PULL_SECRETS:-}"
REMOTE_EXECUTION="${REMOTE_EXECUTION:-0}"
GATE_ROLE="${GATE_ROLE:-worker}"
GATE_PASS=0
GATE_WARN=0
GATE_FAIL=0

log() {
    local ts; ts=$(date +'%Y-%m-%d %H:%M:%S')
    local line="[$ts] $LOG_PREFIX $*"
    echo "$line"
    echo "$line" >> "$LOG_FILE"
}
die() { log "ERROR: $*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

gate_result() {
    local level=$1 message=$2
    case "$level" in
        PASS) ((GATE_PASS++)) ;;
        WARN) ((GATE_WARN++)) ;;
        FAIL) ((GATE_FAIL++)) ;;
        *) die "未知门禁级别: $level" ;;
    esac
    log "[$level] $message"
}

# ---------------- 执行机：运行输入检查 ----------------
gate_inputs() {
    log "=== 部署准入门禁：运行输入 ==="
    if [[ -n "$DEPLOY_IMAGE" ]]; then
        gate_result PASS "部署镜像: $DEPLOY_IMAGE"
    elif [[ -n "$IMAGE_NAME" ]]; then
        gate_result PASS "部署镜像: $IMAGE_NAME:${IMAGE_TAG:-latest}"
    else
        gate_result FAIL "镜像名为空：IMAGE_NAME / DEPLOY_IMAGE 至少其一必须非空（拉取与渲染阶段必需）"
    fi
}

# ---------------- 目标机：就绪检查 ----------------
effective_min_gpu() {
    if [[ -n "$MIN_GPU" ]]; then
        [[ "$MIN_GPU" =~ ^[0-9]+$ ]] || die "MIN_GPU 必须为非负整数"
        echo "$MIN_GPU"; return
    fi
    local max=0 g
    for g in "$PREFILL_GPU" "$DECODE_GPU"; do
        if [[ "$g" =~ ^[0-9]+$ ]] && (( g > max )); then max=$g; fi
    done
    (( max > 0 )) || max=1
    echo "$max"
}

gate_tools() {
    local tool
    for tool in kubectl helm curl; do
        if have "$tool"; then
            gate_result PASS "部署工具可用: $tool"
        elif [[ "$GATE_ROLE" == control ]]; then
            gate_result FAIL "控制节点缺少 $tool（deploy-model.sh 契约要求控制节点安装 kubectl/helm/curl）"
        else
            gate_result WARN "工作节点缺少 $tool（仅控制节点必需）"
        fi
    done
}

gate_gpu() {
    local min_gpu; min_gpu=$(effective_min_gpu)
    if (( min_gpu == 0 )); then
        gate_result PASS "GPU 检查已跳过（MIN_GPU=0）"
        return
    fi
    if ! have nvidia-smi; then
        gate_result FAIL "未找到 nvidia-smi（本节点至少需要 $min_gpu 张 GPU）"
        return
    fi
    local count
    count=$(nvidia-smi -L 2>/dev/null | grep -c '^GPU ')
    count=${count:-0}
    if (( count >= min_gpu )); then
        gate_result PASS "GPU 数量: $count >= $min_gpu"
    else
        gate_result FAIL "GPU 数量不足: $count < $min_gpu（按 PREFILL_GPU/DECODE_GPU 推导，可用 MIN_GPU 覆盖）"
    fi
}

gate_disk() {
    [[ "$MIN_DISK_FREE_GIB" =~ ^[0-9]+$ ]] || die "MIN_DISK_FREE_GIB 必须为非负整数 GiB"
    local d="$TARGET_RUN_DIR"
    while [[ ! -d "$d" && "$d" != "/" ]]; do d="$(dirname "$d")"; done
    local avail
    avail=$(df -BG --output=avail "$d" 2>/dev/null | tail -n 1 | tr -dc '0-9')
    if [[ -z "$avail" ]]; then
        gate_result WARN "无法读取 $d 所在盘剩余空间"
    elif (( avail >= MIN_DISK_FREE_GIB )); then
        gate_result PASS "磁盘剩余: ${avail} GiB >= ${MIN_DISK_FREE_GIB} GiB（$d）"
    else
        gate_result FAIL "磁盘剩余不足: ${avail} GiB < ${MIN_DISK_FREE_GIB} GiB（$d，渲染产物同步目标）"
    fi
}

gate_secrets() {
    if [[ -z "$IMAGE_PULL_SECRETS" ]]; then
        gate_result PASS "未配置 IMAGE_PULL_SECRETS，跳过镜像凭证检查"
        return
    fi
    if [[ -z "$NAMESPACE" ]]; then
        gate_result WARN "已配置 IMAGE_PULL_SECRETS 但 NAMESPACE 为空，无法核实 Secret"
        return
    fi
    if [[ "$GATE_ROLE" != control ]]; then
        gate_result PASS "镜像凭证检查仅在控制节点执行"
        return
    fi
    if ! kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
        gate_result WARN "命名空间 $NAMESPACE 不存在（部署时由 helm --create-namespace 创建），请确保同步创建 Secret: $IMAGE_PULL_SECRETS"
        return
    fi
    local s
    local IFS=','
    for s in $IMAGE_PULL_SECRETS; do
        s="${s//[[:space:]]/}"
        [[ -n "$s" ]] || continue
        if kubectl -n "$NAMESPACE" get secret "$s" >/dev/null 2>&1; then
            gate_result PASS "镜像凭证存在: $NAMESPACE/$s"
        else
            gate_result FAIL "镜像凭证缺失: $NAMESPACE/$s（镜像拉取将 ImagePullBackOff）"
        fi
    done
}

gate_target() {
    log "=== 部署准入门禁：目标机（$GATE_ROLE）==="
    gate_tools
    gate_gpu
    gate_disk
    gate_secrets
}

gate_summary() {
    log "门禁检查完成: PASS=$GATE_PASS WARN=$GATE_WARN FAIL=$GATE_FAIL"
    if (( GATE_FAIL == 0 )); then
        echo "GATE_RESULT=PASS"
        return 0
    fi
    echo "GATE_RESULT=FAIL"
    return 1
}

# ---------------- 远端执行 ----------------
remote_run() {   # $1=ip $2=user $3=pass $4=role
    local ip="$1" user="${2:-root}" pass="$3" role="$4" self env_args
    self=$(readlink -f "$0" 2>/dev/null || echo "$0")
    local ssh_opts=(-p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10)
    local scp_opts=(-P "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
    printf -v env_args '%q ' \
        REMOTE_EXECUTION=1 GATE_ROLE="$role" \
        MIN_GPU="$MIN_GPU" PREFILL_GPU="$PREFILL_GPU" DECODE_GPU="$DECODE_GPU" \
        MIN_DISK_FREE_GIB="$MIN_DISK_FREE_GIB" TARGET_RUN_DIR="$TARGET_RUN_DIR" \
        NAMESPACE="$NAMESPACE" IMAGE_PULL_SECRETS="$IMAGE_PULL_SECRETS" \
        IMAGE_NAME="$IMAGE_NAME" DEPLOY_IMAGE="$DEPLOY_IMAGE" IMAGE_TAG="$IMAGE_TAG"
    log "推送门禁脚本到 ${user}@${ip}（$role）并执行"
    if [[ -n "$pass" ]]; then
        have sshpass || die "节点 $ip 使用密码认证但未找到 sshpass"
        SSHPASS="$pass" sshpass -e scp "${scp_opts[@]}" -q "$self" "${user}@${ip}:/tmp/check-deploy-gate.sh" </dev/null \
            || { gate_result FAIL "无法连接 $ip（scp 失败）"; return 1; }
        SSHPASS="$pass" sshpass -e ssh "${ssh_opts[@]}" "${user}@${ip}" \
            "env $env_args bash /tmp/check-deploy-gate.sh" </dev/null \
            || { gate_result FAIL "节点 $ip 门禁未通过或不可达（SSH 退出非零）"; return 1; }
    else
        scp "${scp_opts[@]}" -q "$self" "${user}@${ip}:/tmp/check-deploy-gate.sh" </dev/null \
            || { gate_result FAIL "无法连接 $ip（scp 失败）"; return 1; }
        ssh "${ssh_opts[@]}" "${user}@${ip}" \
            "env $env_args bash /tmp/check-deploy-gate.sh" </dev/null \
            || { gate_result FAIL "节点 $ip 门禁未通过或不可达（SSH 退出非零）"; return 1; }
    fi
}

do_targets() {
    local handled=0 role
    local runner="remote_run"
    if have python3; then
        while IFS=$'\t' read -r ip user pass; do
            [[ -n "$ip" ]] || continue
            role=worker; (( handled == 0 )) && role=control
            "$runner" "$ip" "${user:-$TARGET_USER}" "${pass:-$TARGET_PASSWORD}" "$role" || true
            ((handled += 1))
        done < <(python3 -c 'import json,sys
for h in json.loads(sys.argv[1]): print(h.get("ip",""), h.get("user",""), h.get("pass",""), sep="\t")' "$TARGET_HOSTS" 2>/dev/null)
    elif have jq; then
        while IFS=$'\t' read -r ip user pass; do
            [[ -n "$ip" ]] || continue
            role=worker; (( handled == 0 )) && role=control
            "$runner" "$ip" "${user:-$TARGET_USER}" "${pass:-$TARGET_PASSWORD}" "$role" || true
            ((handled += 1))
        done < <(jq -r '.[] | [.ip, (.user//""), (.pass//"")] | @tsv' <<<"$TARGET_HOSTS" 2>/dev/null)
    fi
    if (( handled == 0 )) && [[ -n "$TARGET_IPS" ]]; then
        # 兜底：无 python3/jq 时仅取 IP 列表 + 首节点凭据
        local ips="$TARGET_IPS"
        if have python3; then
            ips=$(python3 -c 'import json,sys; print(" ".join(json.loads(sys.argv[1])))' "$TARGET_IPS" 2>/dev/null || true)
        fi
        local ip
        for ip in $ips; do
            role=worker; (( handled == 0 )) && role=control
            "$runner" "$ip" "$TARGET_USER" "$TARGET_PASSWORD" "$role" || true
            ((handled += 1))
        done
    fi
    (( handled > 0 )) || gate_result WARN "TARGET_HOSTS 未解析出可用节点（已跳过目标机门禁）"
}

main() {
    [[ $# -eq 0 ]] || die "不支持命令行参数；请使用环境变量配置"
    if [[ "$REMOTE_EXECUTION" == 1 ]]; then
        gate_target
    else
        gate_inputs
        if [[ -z "$TARGET_HOSTS" && -z "$TARGET_IPS" ]]; then
            gate_result WARN "未注入目标节点（无目标节点运行）：仅执行输入检查"
        else
            if have ssh; then
                gate_result PASS "执行机 ssh 可用"
            else
                gate_result FAIL "执行机缺少 ssh（无法下发目标机门禁）"
            fi
            do_targets
        fi
    fi
    gate_summary
}
main "$@"
