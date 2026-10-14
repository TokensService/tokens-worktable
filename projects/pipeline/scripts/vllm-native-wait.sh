#!/usr/bin/env bash
# pipeline: no-positional-args
# vLLM 原生部署 · 等待服务就绪 step 主脚本（无参调用）。
#
# 用途：轮询等待部署的 vLLM Pod 进入服务态：pd 模式等待 vllm-prefill 与 vllm-decode
# 两个 Pod，standalone 模式只等 vllm-prefill。就绪判据 = Pod Running 且容器日志出现
# 「Application startup complete」；Pod 进入 Failed/Succeeded/Unknown 即判定失败并打印
# 日志末尾；超时判失败。模型加载通常约 6 分钟（冷启动更久），默认超时 40 分钟。
#
# 注意（pd）：本 step 不等待 Proxy——Proxy 只认启动时刻 P/D 的 engine_id，必须在 P/D
# 就绪后由「重建 Proxy」step 部署/重建（见 vllm-native-deploy.sh 的 proxy 角色说明）。
#
# 执行位置：平台注入 TARGET_HOSTS 时自动推送自身到【首个】目标节点执行（同 check step）；
# 未注入时在执行机本地运行（需本机有 kubectl）。
#
# 契约输出：VLLM_READY=1。
# 退出码：0 全部就绪；1 失败/超时/环境错误。
# 单测：test/test_vllm_native_scripts.sh。
set -uo pipefail

SCRIPT_NAME='vllm-native-wait'

# ---- step 参数声明 ----
# DEPLOY_MODE = 部署模式：pd=P/D 分离，standalone=仅 Prefill 原生基线
DEPLOY_MODE="${DEPLOY_MODE:-pd}"
# VLLM_NAMESPACE = 部署命名空间
VLLM_NAMESPACE="${VLLM_NAMESPACE:-native-vllm}"
# VLLM_NODE = 目标 Kubernetes 节点名（仅用于展示；留空自动解析）
VLLM_NODE="${VLLM_NODE:-}"
# VLLM_READY_TIMEOUT = 就绪等待总超时（秒）
VLLM_READY_TIMEOUT="${VLLM_READY_TIMEOUT:-2400}"
# VLLM_POLL_INTERVAL = 轮询间隔（秒）
VLLM_POLL_INTERVAL="${VLLM_POLL_INTERVAL:-10}"

# 平台注入变量经 nameref 间接引用，避免被「识别参数」扫入参数面
declare -n platform_target_hosts='TARGET_HOSTS'

die() { echo "[$SCRIPT_NAME] ERROR: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- 远程分发（注入 TARGET_HOSTS 时：推送到首个目标节点执行）----
remote_run() { # <user> <host> <port> <pass> <command>
    local user=$1 host=$2 port=$3 pass=$4 command=$5 ssh_base
    ssh_base='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15'
    if [[ -n "$pass" ]]; then
        have sshpass || die '目标节点配置了密码但执行机未安装 sshpass'
        SSHPASS="$pass" sshpass -e ssh $ssh_base -p "$port" "$user@$host" "$command"
    else
        ssh $ssh_base -p "$port" "$user@$host" "$command"
    fi
}

remote_scp() { # <user> <host> <port> <pass> <source> <destination>
    local user=$1 host=$2 port=$3 pass=$4 source=$5 destination=$6 ssh_base
    ssh_base='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR'
    if [[ -n "$pass" ]]; then
        have sshpass || die '目标节点配置了密码但执行机未安装 sshpass'
        SSHPASS="$pass" sshpass -e scp -P "$port" $ssh_base -q "$source" "$user@$host:$destination"
    else
        scp -P "$port" $ssh_base -q "$source" "$user@$host:$destination"
    fi
}

dispatch_to_target() {
    local self spec probe_user probe_host probe_port probe_pass='' quoted
    local -a remote_env=()

    have ssh || die '远程执行需要 ssh（执行机未安装）'
    have python3 || die '远程分发需要 python3（解析 TARGET_HOSTS）'

    spec="$(python3 - "${platform_target_hosts:-}" <<'PY'
import json
import re
import sys

try:
    hosts = json.loads(sys.argv[1])
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid TARGET_HOSTS: {error}")
if not isinstance(hosts, list) or not hosts:
    raise SystemExit("TARGET_HOSTS must be a non-empty JSON array")
host = hosts[0]
if not isinstance(host, dict) or not isinstance(host.get("ip"), str) or not host["ip"]:
    raise SystemExit("TARGET_HOSTS[0] must contain a non-empty ip")
endpoint = host["ip"]
match = re.fullmatch(r"([^:]+):(\d+)", endpoint)
address, port = match.groups() if match else (endpoint, "22")
password = host.get("pass", host.get("password", "")) or ""
print(f'{host.get("user") or "root"}\t{address}\t{port}\t{password}')
PY
)" || die '解析 TARGET_HOSTS 失败'
    IFS=$'\t' read -r probe_user probe_host probe_port probe_pass <<<"$spec"

    self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
    echo "[$SCRIPT_NAME] remote execution via $probe_user@$probe_host:$probe_port（首个目标节点 = 部署节点）"
    remote_scp "$probe_user" "$probe_host" "$probe_port" "$probe_pass" "$self" "/tmp/$SCRIPT_NAME.sh" \
        || die "推送脚本到 $probe_host 失败"

    remote_env=(TARGET_HOSTS=)
    for var in TARGET_IP TARGET_IPS DEPLOY_MODE VLLM_NAMESPACE VLLM_NODE VLLM_READY_TIMEOUT VLLM_POLL_INTERVAL; do
        printf -v quoted '%q' "${!var:-}"
        remote_env+=("$var=$quoted")
    done
    remote_run "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "env ${remote_env[*]} bash /tmp/$SCRIPT_NAME.sh"
}

pod_phase() { # <pod>
    kubectl -n "$VLLM_NAMESPACE" get pod "$1" --request-timeout=15s \
        -o jsonpath='{.status.phase}' 2>/dev/null
}

pod_log_has_ready_marker() { # <pod>
    kubectl -n "$VLLM_NAMESPACE" logs "$1" -c vllm --tail=2000 --request-timeout=30s 2>/dev/null \
        | grep -q 'Application startup complete'
}

dump_pod_log_tail() { # <pod>
    echo "[$SCRIPT_NAME] ---- Pod $1 日志末尾 ----" >&2
    kubectl -n "$VLLM_NAMESPACE" logs "$1" -c vllm --tail=80 --request-timeout=30s >&2 2>&1 || true
    echo "[$SCRIPT_NAME] ----" >&2
}

wait_one() { # <pod>；0 就绪，1 失败/超时
    local pod=$1 waited=0 phase
    while :; do
        phase="$(pod_phase "$pod")"
        case "$phase" in
            Running)
                if pod_log_has_ready_marker "$pod"; then
                    echo "[$SCRIPT_NAME] Pod $pod 就绪（Running + Application startup complete，已等待 ${waited}s）"
                    return 0
                fi
                ;;
            Failed|Succeeded|Unknown)
                echo "[$SCRIPT_NAME] ERROR: Pod $pod 进入终态 $phase，无法就绪" >&2
                dump_pod_log_tail "$pod"
                return 1
                ;;
            '') ;;   # Pod 尚未创建可见/查询失败：继续等
            *) ;;    # Pending / ContainerCreating 等：继续等
        esac
        if [[ "$waited" -ge "$VLLM_READY_TIMEOUT" ]]; then
            echo "[$SCRIPT_NAME] ERROR: 等待 Pod $pod 就绪超时（${VLLM_READY_TIMEOUT}s，当前 phase=${phase:-未知}）" >&2
            dump_pod_log_tail "$pod"
            return 1
        fi
        sleep "$VLLM_POLL_INTERVAL"
        waited=$((waited + VLLM_POLL_INTERVAL))
    done
}

main() {
    [[ $# -eq 0 ]] || die '不支持命令行参数；请使用环境变量配置'
    if [[ -n "${platform_target_hosts:-}" && "${platform_target_hosts:-}" != '[]' ]]; then
        dispatch_to_target
        return
    fi

    have kubectl || die '本机缺少 kubectl；本 step 通过 TARGET_HOSTS 自动分发到目标节点执行，手工运行请在有 kubectl 的主机上执行'
    kubectl version --request-timeout=5s >/dev/null 2>&1 || die 'kubectl 无法访问 Kubernetes API'
    [[ "$VLLM_READY_TIMEOUT" =~ ^[0-9]+$ && "$VLLM_POLL_INTERVAL" =~ ^[0-9]+$ && "$VLLM_POLL_INTERVAL" -ge 1 ]] \
        || die "VLLM_READY_TIMEOUT / VLLM_POLL_INTERVAL 须为正整数（秒）"

    local pods=(vllm-prefill)
    [[ "$DEPLOY_MODE" == 'pd' ]] && pods=(vllm-prefill vllm-decode)

    echo "[$SCRIPT_NAME] 等待就绪（模式 $DEPLOY_MODE）：${pods[*]}（超时 ${VLLM_READY_TIMEOUT}s，间隔 ${VLLM_POLL_INTERVAL}s）"
    local p
    for p in "${pods[@]}"; do
        wait_one "$p" || exit 1
    done

    if [[ "$DEPLOY_MODE" == 'pd' ]]; then
        if kubectl -n "$VLLM_NAMESPACE" get pod vllm-pd-proxy --request-timeout=15s >/dev/null 2>&1; then
            echo "[$SCRIPT_NAME] 提示：Proxy Pod 已存在但其缓存的 engine_id 属于旧 P/D 实例，下一 step（重建 Proxy）会先删后建"
        fi
    fi

    echo "[$SCRIPT_NAME] 全部服务就绪"
    echo "VLLM_READY=1"
}

main "$@"
