#!/usr/bin/env bash
# pipeline: no-positional-args
# vLLM 原生部署 · 清理 step 主脚本（无参调用；默认预演，DRY_RUN=0 才真正删除）。
#
# 用途：删除本部署在命名空间内的全部 Pod（vllm-prefill / vllm-decode / vllm-pd-proxy，
# 按 DEPLOY_MODE 裁剪范围）；可选删除节点上的 MoERunner 修复文件目录。
# 不删除命名空间本身（可能被其它部署共享）。
#
# 推荐两段式：先默认预演看清单 → VLLM_CLEANUP_DRY_RUN=0 正式清理。
# 可在流水线末尾绑定为普通阶段（记得把 VLLM_CLEANUP_DRY_RUN 显式填 0），
# 或复制到目标机手工执行。
#
# 执行位置：平台注入 TARGET_HOSTS 时自动推送自身到【首个】目标节点执行（同 check step）；
# 未注入时在执行机本地运行（需本机有 kubectl）。
#
# 契约输出：VLLM_CLEANED=1（预演模式为 VLLM_CLEANED=DRY_RUN）。
# 退出码：0 正常；1 环境错误。
# 单测：test/test_vllm_native_scripts.sh。
set -uo pipefail

SCRIPT_NAME='vllm-native-cleanup'

# ---- step 参数声明 ----
# DEPLOY_MODE = 部署模式：pd=P/D 分离，standalone=仅 Prefill 原生基线
DEPLOY_MODE="${DEPLOY_MODE:-pd}"
# VLLM_NAMESPACE = 部署命名空间
VLLM_NAMESPACE="${VLLM_NAMESPACE:-native-vllm}"
# VLLM_CLEANUP_DRY_RUN = 1=仅打印将删除的对象（默认）；0=正式删除
VLLM_CLEANUP_DRY_RUN="${VLLM_CLEANUP_DRY_RUN:-1}"
# VLLM_CLEANUP_MOEFIX = 1=同时删除节点上的 MoERunner 修复文件目录（默认 0 保留，供下次部署复用）
VLLM_CLEANUP_MOEFIX="${VLLM_CLEANUP_MOEFIX:-0}"
# VLLM_MOEFIX_DIR = MoERunner 修复文件目录
VLLM_MOEFIX_DIR="${VLLM_MOEFIX_DIR:-/tmp/vllm_xds_fix}"

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
    for var in TARGET_IP TARGET_IPS DEPLOY_MODE VLLM_NAMESPACE VLLM_CLEANUP_DRY_RUN VLLM_CLEANUP_MOEFIX VLLM_MOEFIX_DIR; do
        printf -v quoted '%q' "${!var:-}"
        remote_env+=("$var=$quoted")
    done
    remote_run "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "env ${remote_env[*]} bash /tmp/$SCRIPT_NAME.sh"
}

main() {
    [[ $# -eq 0 ]] || die '不支持命令行参数；请使用环境变量配置'
    if [[ -n "${platform_target_hosts:-}" && "${platform_target_hosts:-}" != '[]' ]]; then
        dispatch_to_target
        return
    fi

    have kubectl || die '本机缺少 kubectl；本 step 通过 TARGET_HOSTS 自动分发到目标节点执行，手工运行请在有 kubectl 的主机上执行'
    kubectl version --request-timeout=5s >/dev/null 2>&1 || die 'kubectl 无法访问 Kubernetes API'

    local pods=(vllm-prefill)
    [[ "$DEPLOY_MODE" == 'pd' ]] && pods=(vllm-prefill vllm-decode vllm-pd-proxy)

    local existing=() p
    for p in "${pods[@]}"; do
        if kubectl -n "$VLLM_NAMESPACE" get pod "$p" --request-timeout=15s >/dev/null 2>&1; then
            existing+=("$p")
        fi
    done

    if [[ "$VLLM_CLEANUP_DRY_RUN" != '0' ]]; then
        echo "[$SCRIPT_NAME] 预演（VLLM_CLEANUP_DRY_RUN=0 正式删除）："
        if [[ "${#existing[@]}" -eq 0 ]]; then
            echo "[$SCRIPT_NAME]   命名空间 $VLLM_NAMESPACE 内无本部署 Pod（${pods[*]}），无需清理"
        else
            for p in "${existing[@]}"; do echo "[$SCRIPT_NAME]   将删除 Pod：$VLLM_NAMESPACE/$p"; done
        fi
        if [[ "$VLLM_CLEANUP_MOEFIX" == '1' && -d "$VLLM_MOEFIX_DIR" ]]; then
            echo "[$SCRIPT_NAME]   将删除 MoERunner 修复目录：$VLLM_MOEFIX_DIR"
        fi
        echo "VLLM_CLEANED=DRY_RUN"
        return 0
    fi

    if [[ "${#existing[@]}" -eq 0 ]]; then
        echo "[$SCRIPT_NAME] 命名空间 $VLLM_NAMESPACE 内无本部署 Pod，幂等退出"
    else
        for p in "${existing[@]}"; do
            kubectl -n "$VLLM_NAMESPACE" delete pod "$p" --wait=true --timeout=180s --request-timeout=60s \
                || die "删除 Pod $p 失败"
            echo "[$SCRIPT_NAME] Pod $p 已删除"
        done
    fi

    if [[ "$VLLM_CLEANUP_MOEFIX" == '1' ]]; then
        if [[ -d "$VLLM_MOEFIX_DIR" ]]; then
            rm -rf "$VLLM_MOEFIX_DIR" || die "删除 $VLLM_MOEFIX_DIR 失败"
            echo "[$SCRIPT_NAME] MoERunner 修复目录已删除：$VLLM_MOEFIX_DIR"
        fi
    fi

    echo "[$SCRIPT_NAME] 清理完成"
    echo "VLLM_CLEANED=1"
}

main "$@"
