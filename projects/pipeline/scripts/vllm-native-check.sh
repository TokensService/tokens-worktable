#!/usr/bin/env bash
# pipeline: no-positional-args
# vLLM 原生部署 · 环境检查 step 主脚本（无参调用，fail-fast 门禁）。
#
# 用途：在部署前校验目标节点是否满足「原生 vLLM 部署配方」的全部前置条件
# （配方来源：native_vllm_deployment_from_xds.md 第 12 节；vLLM 代码基线
# TokensService/vllm 分支 v0.30.0.tokens）。任一 FAIL 即 exit 1 拦住下游；
# WARN 仅提示。本 step 全程只读，不创建/删除任何资源。
#
# 执行位置：平台注入 TARGET_HOSTS 时自动推送自身到【首个】目标节点上执行
# （vLLM 单节点部署，首节点即目标 GPU 节点；执行机需 ssh，密码认证需 sshpass）；
# 未注入时在执行机本地运行（手工独立运行场景，需本机有 kubectl）。
#
# 检查项：
#   ① kubectl + python3 可用、API 可达；
#   ② 节点解析：VLLM_NODE 显式指定，或按本机 IP 匹配 Kubernetes 节点 InternalIP（唯一命中）；
#   ③ RuntimeClass 存在（默认 dcgm-nvidia-runtime）；
#   ④ GPU：节点 allocatable 与「空闲量」（allocatable − 其它 Pod 已申请；本部署自有旧 Pod 计入可复用）
#      均须 ≥ 需求（pd=PREFILL_GPU+DECODE_GPU，standalone=PREFILL_GPU）；
#      并行度一致性：PP_LAYER_PARTITION 段数 == PREFILL_PP、PREFILL_GPU == VLLM_TP×PREFILL_PP、
#      DECODE_GPU == VLLM_TP×DECODE_DP；
#   ⑤ 模型路径：MODEL_PATH 必须位于容器挂载点 MODEL_MOUNT_PATH 之下，且宿主
#      MODEL_HOST_PATH/<相对路径>/ 下存在 config.json 与 tokenizer.json；
#   ⑥ pd 模式：/dev/infiniband 存在（Mooncake over RDMA 必需）；
#   ⑦ 端口空闲：hostNetwork  Pod 直接占用宿主端口（pd：PREFILL/DECODE/PROXY/BOOTSTRAP；
#      standalone：PROXY_PORT，由 Prefill 直接监听）；被占用按 WARN（deploy 会先删自有旧 Pod，
#      其它占用会在运行期冲突，请人工确认）；
#   ⑧ 代码基线溯源：注入 GIT_URL/GIT_BRANCH 时打印并与其中的版本号（如 v0.30.0）和
#      VLLM_IMAGE 镜像 tag 做一致性提示（不一致 WARN，不阻断）。
#
# 契约输出（stdout KEY=VALUE，注入下游 step）：VLLM_NODE（解析结果）、VLLM_MODE、VLLM_GATE=PASS。
#
# 退出码：0 通过（可有 WARN）；1 存在 FAIL 或环境错误。
# 单测：test/test_vllm_native_scripts.sh。
set -uo pipefail

SCRIPT_NAME='vllm-native-check'

# ---- step 参数声明（均留空/默认值 = 按下方默认配方；流水线注入的运行级同名变量优先于默认值）----
# DEPLOY_MODE = 部署模式：pd=P/D 分离（Prefill+Decode+Mooncake Proxy），standalone=仅 Prefill 原生基线
DEPLOY_MODE="${DEPLOY_MODE:-pd}"
# VLLM_NAMESPACE = 部署命名空间
VLLM_NAMESPACE="${VLLM_NAMESPACE:-native-vllm}"
# VLLM_NODE = 目标 Kubernetes 节点名；留空 = 按本机 IP 自动匹配 InternalIP
VLLM_NODE="${VLLM_NODE:-}"
# VLLM_IMAGE = vLLM 容器镜像
VLLM_IMAGE="${VLLM_IMAGE:-swr.cn-southwest-2.myhuaweicloud.com/dataartsfabric/xds:lmx_vllm-0.30.0-1011-wwx.20261013211805.BNT3.x86_64}"
# VLLM_RUNTIME_CLASS = 容器 RuntimeClass
VLLM_RUNTIME_CLASS="${VLLM_RUNTIME_CLASS:-dcgm-nvidia-runtime}"
# MODEL_PATH = 容器内模型路径（vllm serve 的第一个参数）
MODEL_PATH="${MODEL_PATH:-/home/service/works/models_ssd/GLM-5.2-NVFP4-W4A4C8-MG40-BNT3/v1}"
# MODEL_HOST_PATH = 宿主机模型仓库目录（hostPath 挂载源）
MODEL_HOST_PATH="${MODEL_HOST_PATH:-/mnt/xds/sfs}"
# MODEL_MOUNT_PATH = 模型仓库在容器内的挂载点
MODEL_MOUNT_PATH="${MODEL_MOUNT_PATH:-/home/service/works/models_ssd}"
# VLLM_SERVED_MODEL_NAME = vLLM 对外服务模型名
VLLM_SERVED_MODEL_NAME="${VLLM_SERVED_MODEL_NAME:-GLM-5.2-NVFP4-W4A4C8-MG40-BNT3}"
# VLLM_TP = 张量并行度（Prefill/Decode 共用）
VLLM_TP="${VLLM_TP:-1}"
# PREFILL_PP = Prefill 流水线并行度（须与 PP_LAYER_PARTITION 段数一致）
PREFILL_PP="${PREFILL_PP:-4}"
# DECODE_DP = Decode 数据并行度
DECODE_DP="${DECODE_DP:-4}"
# PREFILL_GPU = Prefill Pod 申请 GPU 数（须等于 VLLM_TP×PREFILL_PP）
PREFILL_GPU="${PREFILL_GPU:-4}"
# DECODE_GPU = Decode Pod 申请 GPU 数（须等于 VLLM_TP×DECODE_DP）
DECODE_GPU="${DECODE_GPU:-4}"
# PP_LAYER_PARTITION = PP 层切分（逗号分隔，段数须等于 PREFILL_PP）
PP_LAYER_PARTITION="${PP_LAYER_PARTITION:-22,20,20,16}"
# PREFILL_PORT = Prefill 服务端口
PREFILL_PORT="${PREFILL_PORT:-8010}"
# DECODE_PORT = Decode 服务端口
DECODE_PORT="${DECODE_PORT:-8020}"
# PROXY_PORT = 对外服务端口（pd=Proxy 端口；standalone=Prefill 直接监听）
PROXY_PORT="${PROXY_PORT:-8000}"
# MOONCAKE_BOOTSTRAP_PORT = Mooncake bootstrap 端口
MOONCAKE_BOOTSTRAP_PORT="${MOONCAKE_BOOTSTRAP_PORT:-8998}"

# 平台注入变量经 nameref 间接引用，避免被「识别参数」扫入参数面
declare -n platform_target_hosts='TARGET_HOSTS'

die() { echo "[$SCRIPT_NAME] ERROR: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

FAILS=0
WARNS=0
fail() { FAILS=$((FAILS+1)); echo "[$SCRIPT_NAME] FAIL: $*"; }
warn() { WARNS=$((WARNS+1)); echo "[$SCRIPT_NAME] WARN: $*"; }
pass() { echo "[$SCRIPT_NAME]   OK: $*"; }

# ---- 远程分发（注入 TARGET_HOSTS 时：推送到首个目标节点执行；vLLM 单节点部署，首节点即目标）----
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
    for var in TARGET_IP TARGET_IPS DEPLOY_MODE VLLM_NAMESPACE VLLM_NODE VLLM_IMAGE VLLM_RUNTIME_CLASS \
               MODEL_PATH MODEL_HOST_PATH MODEL_MOUNT_PATH VLLM_SERVED_MODEL_NAME \
               VLLM_TP PREFILL_PP DECODE_DP PREFILL_GPU DECODE_GPU PP_LAYER_PARTITION \
               PREFILL_PORT DECODE_PORT PROXY_PORT MOONCAKE_BOOTSTRAP_PORT GIT_URL GIT_BRANCH; do
        printf -v quoted '%q' "${!var:-}"
        remote_env+=("$var=$quoted")
    done
    remote_run "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "env ${remote_env[*]} bash /tmp/$SCRIPT_NAME.sh"
}

# ---- 节点解析：VLLM_NODE 显式值 → 校验存在；否则按本机 IP/主机名匹配节点 InternalIP（唯一命中）----
resolve_node() {
    local nodes_json
    nodes_json="$(kubectl get nodes -o json --request-timeout=30s 2>/dev/null)" || return 1
    NODES_JSON="$nodes_json" python3 - "$VLLM_NODE" <<'PY'
import json
import os
import sys

want = sys.argv[1].strip()
nodes = json.loads(os.environ["NODES_JSON"]).get("items", [])


def internal_ip(item):
    for addr in item.get("status", {}).get("addresses", []):
        if addr.get("type") == "InternalIP":
            return addr.get("address", "")
    return ""


if want:
    names = [item.get("metadata", {}).get("name", "") for item in nodes]
    if want not in names:
        raise SystemExit(f"指定的 VLLM_NODE={want} 不在集群节点列表中：{' '.join(names)}")
    print(want)
    raise SystemExit(0)

import subprocess

local = subprocess.run(["hostname", "-I"], capture_output=True, text=True).stdout.split()
local.append(subprocess.run(["hostname"], capture_output=True, text=True).stdout.strip())
mine = set(filter(None, local))
hits = [item for item in nodes if internal_ip(item) in mine or item.get("metadata", {}).get("name", "") in mine]
if len(hits) == 1:
    print(hits[0]["metadata"]["name"])
elif not hits and len(nodes) == 1:
    print(nodes[0]["metadata"]["name"])
elif not hits:
    raise SystemExit("按本机 IP/主机名未匹配到任何集群节点，请显式配置 VLLM_NODE")
else:
    names = ", ".join(item.get("metadata", {}).get("name", "") for item in hits)
    raise SystemExit(f"本机 IP/主机名命中多个节点（{names}），请显式配置 VLLM_NODE")
PY
}

main() {
    [[ $# -eq 0 ]] || die '不支持命令行参数；请使用环境变量配置'
    if [[ -n "${platform_target_hosts:-}" && "${platform_target_hosts:-}" != '[]' ]]; then
        dispatch_to_target
        return
    fi

    have kubectl || die '本机缺少 kubectl；本 step 通过 TARGET_HOSTS 自动分发到目标节点执行，手工运行请在有 kubectl 的主机上执行'
    have python3 || die '需要 python3'
    kubectl version --request-timeout=5s >/dev/null 2>&1 || die 'kubectl 无法访问 Kubernetes API'
    pass 'kubectl 与 API 可达'

    case "$DEPLOY_MODE" in
        pd|standalone) ;;
        *) die "DEPLOY_MODE 仅支持 pd / standalone，当前：$DEPLOY_MODE" ;;
    esac

    # ---- 并行度一致性 ----
    local pp_segments
    pp_segments="$(python3 -c 'import sys; print(len([s for s in sys.argv[1].split(",") if s.strip()]))' "$PP_LAYER_PARTITION")"
    [[ "$pp_segments" == "$PREFILL_PP" ]] || fail "PP_LAYER_PARTITION 段数（$pp_segments）!= PREFILL_PP（$PREFILL_PP）"
    [[ "$VLLM_TP" =~ ^[0-9]+$ && "$VLLM_TP" -ge 1 ]] || fail "VLLM_TP 须为正整数：$VLLM_TP"
    [[ $((VLLM_TP * PREFILL_PP)) == "$PREFILL_GPU" ]] || fail "PREFILL_GPU（$PREFILL_GPU）!= VLLM_TP×PREFILL_PP（$((VLLM_TP * PREFILL_PP))）"
    if [[ "$DEPLOY_MODE" == 'pd' ]]; then
        [[ $((VLLM_TP * DECODE_DP)) == "$DECODE_GPU" ]] || fail "DECODE_GPU（$DECODE_GPU）!= VLLM_TP×DECODE_DP（$((VLLM_TP * DECODE_DP))）"
    fi
    [[ "$FAILS" -eq 0 ]] && pass "并行度一致性：TP$VLLM_TP PP$PREFILL_PP($PP_LAYER_PARTITION) / DP$DECODE_DP，GPU $PREFILL_GPU+$DECODE_GPU"

    # ---- 节点解析与 RuntimeClass ----
    local node
    node="$(resolve_node)" || die "节点解析失败：$node"
    pass "目标节点：$node"
    if kubectl get runtimeclass "$VLLM_RUNTIME_CLASS" --request-timeout=15s >/dev/null 2>&1; then
        pass "RuntimeClass $VLLM_RUNTIME_CLASS 存在"
    else
        fail "RuntimeClass $VLLM_RUNTIME_CLASS 不存在（Pod GPU 注入依赖它）"
    fi

    # ---- GPU 余量（allocatable 与其它 Pod 已申请；自有旧 Pod 计入可复用）----
    local need_gpu=$PREFILL_GPU
    [[ "$DEPLOY_MODE" == 'pd' ]] && need_gpu=$((PREFILL_GPU + DECODE_GPU))
    local gpu_report
    gpu_report="$(python3 - "$node" "$VLLM_NAMESPACE" <<'PY'
import json
import subprocess
import sys

node, namespace = sys.argv[1], sys.argv[2]

node_obj = json.loads(subprocess.run(
    ["kubectl", "get", "node", node, "-o", "json", "--request-timeout=30s"],
    capture_output=True, text=True, check=True).stdout)
alloc = int(node_obj.get("status", {}).get("allocatable", {}).get("nvidia.com/gpu", "0"))

pods = json.loads(subprocess.run(
    ["kubectl", "get", "pods", "-A", "--field-selector", f"spec.nodeName={node}",
     "-o", "json", "--request-timeout=60s"],
    capture_output=True, text=True, check=True).stdout).get("items", [])

used = 0
ours = 0
for pod in pods:
    if pod.get("status", {}).get("phase") not in ("Pending", "Running"):
        continue
    amount = 0
    for container in pod.get("spec", {}).get("containers", []):
        amount += int(container.get("resources", {}).get("limits", {}).get("nvidia.com/gpu", "0"))
    if pod.get("metadata", {}).get("namespace") == namespace and \
       pod.get("metadata", {}).get("name", "") in ("vllm-prefill", "vllm-decode"):
        ours += amount
    else:
        used += amount
print(f"{alloc} {used} {ours}")
PY
)" || die "GPU 余量统计失败：$gpu_report"
    local alloc_gpu used_gpu ours_gpu free_gpu
    read -r alloc_gpu used_gpu ours_gpu <<<"$gpu_report"
    free_gpu=$((alloc_gpu - used_gpu))
    if [[ "$alloc_gpu" -lt "$need_gpu" ]]; then
        fail "节点 GPU allocatable=${alloc_gpu} < 需求 ${need_gpu}（${DEPLOY_MODE} 模式）"
    elif [[ "$free_gpu" -lt "$need_gpu" ]]; then
        fail "节点 GPU 空闲=${free_gpu}（allocatable ${alloc_gpu} − 其它 Pod 已申请 ${used_gpu}）< 需求 ${need_gpu}"
    else
        pass "节点 GPU：allocatable=${alloc_gpu}，其它 Pod 已申请=${used_gpu}，空闲=${free_gpu} ≥ 需求 ${need_gpu}"
    fi

    # ---- 模型路径：容器路径须位于挂载点之下；宿主侧须存在 config.json / tokenizer.json ----
    local rel=''
    case "$MODEL_PATH" in
        "$MODEL_MOUNT_PATH"/*) rel="${MODEL_PATH#"$MODEL_MOUNT_PATH"/}" ;;
        *) fail "MODEL_PATH（$MODEL_PATH）不在容器挂载点 MODEL_MOUNT_PATH（$MODEL_MOUNT_PATH）之下；请调整 MODEL_PATH 或 MODEL_MOUNT_PATH" ;;
    esac
    if [[ -n "$rel" ]]; then
        local host_model_dir="$MODEL_HOST_PATH/$rel"
        if [[ -f "$host_model_dir/config.json" ]]; then
            pass "模型 config.json 存在：$host_model_dir/config.json"
        else
            fail "模型文件缺失：$host_model_dir/config.json 不存在（宿主目录由 MODEL_HOST_PATH=$MODEL_HOST_PATH 挂载）"
        fi
        if [[ -f "$host_model_dir/tokenizer.json" || -f "$host_model_dir/tokenizer.model" ]]; then
            pass "模型 tokenizer 存在"
        else
            fail "模型 tokenizer 缺失：$host_model_dir/tokenizer.json（或 tokenizer.model）不存在"
        fi
    fi

    # ---- RDMA 设备（pd 模式 Mooncake 必需）----
    if [[ "$DEPLOY_MODE" == 'pd' ]]; then
        if [[ -d /dev/infiniband ]]; then
            pass '/dev/infiniband 存在（Mooncake over RDMA）'
        else
            fail '/dev/infiniband 不存在：pd 模式 Mooncake KV 传输需要 RDMA 设备（否则传输挂住）'
        fi
    fi

    # ---- hostNetwork 端口占用 ----
    local ports="$PROXY_PORT"
    if [[ "$DEPLOY_MODE" == 'pd' ]]; then
        ports="$PREFILL_PORT $DECODE_PORT $PROXY_PORT $MOONCAKE_BOOTSTRAP_PORT"
    fi
    local occupied
    occupied="$(python3 - $ports <<'PY'
import sys

listening = set()
for path in ("/proc/net/tcp", "/proc/net/tcp6"):
    try:
        with open(path) as handle:
            next(handle, None)
            for line in handle:
                parts = line.split()
                if len(parts) > 3 and parts[3] == "0A":
                    listening.add(int(parts[1].rsplit(":", 1)[1], 16))
    except OSError:
        pass
print(" ".join(str(port) for port in map(int, sys.argv[1:]) if port in listening))
PY
)"
    if [[ -n "$occupied" ]]; then
        warn "宿主端口已被监听：$occupied（deploy 会先删除本部署自有旧 Pod；若为其它进程占用请人工确认，否则 hostNetwork 起服务会端口冲突）"
    else
        pass "端口空闲：$ports"
    fi

    # ---- 命名空间与既有部署 ----
    if kubectl get namespace "$VLLM_NAMESPACE" --request-timeout=15s >/dev/null 2>&1; then
        local existing
        existing="$(kubectl get pods -n "$VLLM_NAMESPACE" --request-timeout=15s -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n' | grep -E '^vllm-(prefill|decode|pd-proxy)$' | tr '\n' ' ' || true)"
        if [[ -n "$existing" ]]; then
            warn "命名空间 $VLLM_NAMESPACE 已存在旧部署 Pod：$existing（deploy 将逐个先删后建）"
        else
            pass "命名空间 $VLLM_NAMESPACE 存在且无旧部署 Pod"
        fi
    else
        pass "命名空间 $VLLM_NAMESPACE 尚不存在（prepare 将创建）"
    fi

    # ---- 代码基线溯源（GIT_URL/GIT_BRANCH 由运行级注入；版本号与镜像 tag 一致性提示）----
    if [[ -n "${GIT_URL:-}${GIT_BRANCH:-}" ]]; then
        echo "[$SCRIPT_NAME] vLLM 代码基线：${GIT_URL:-<未注入>} @ ${GIT_BRANCH:-<未注入>}"
        local branch_ver=''
        branch_ver="$(grep -oE 'v[0-9]+\.[0-9]+(\.[0-9]+)?' <<<"${GIT_BRANCH:-}" | head -1 || true)"
        if [[ -n "$branch_ver" ]]; then
            local ver_naked="${branch_ver#v}"
            if [[ "$VLLM_IMAGE" == *"$ver_naked"* ]]; then
                pass "镜像 tag 含分支版本号 $ver_naked（$VLLM_IMAGE）"
            else
                warn "分支版本号 $branch_ver 与镜像 tag 不符（$VLLM_IMAGE）；镜像应构建自 $GIT_BRANCH 对应代码"
            fi
        fi
    else
        echo "[$SCRIPT_NAME] 未注入 GIT_URL/GIT_BRANCH（运行参数未选代码仓），跳过代码基线溯源"
    fi

    # ---- 汇总 ----
    if [[ "$FAILS" -gt 0 ]]; then
        echo "[$SCRIPT_NAME] 环境检查未通过：FAIL=$FAILS WARN=$WARNS" >&2
        exit 1
    fi
    echo "[$SCRIPT_NAME] 环境检查通过（WARN=$WARNS）：$DEPLOY_MODE 模式 → 节点 $node"
    echo "VLLM_NODE=$node"
    echo "VLLM_MODE=$DEPLOY_MODE"
    echo "VLLM_GATE=PASS"
}

main "$@"
