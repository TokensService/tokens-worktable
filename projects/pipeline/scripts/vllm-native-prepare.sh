#!/usr/bin/env bash
# pipeline: no-positional-args
# vLLM 原生部署 · 节点准备 step 主脚本（无参调用）。
#
# 用途：① 确保命名空间存在（不存在则创建）；② 把自写 MoERunner 修复文件
# （vllm_native_moefix.py + zz_vllm_native_moefix.pth）写入目标节点的 VLLM_MOEFIX_DIR
# ——上游 vLLM 在 DP>1 时 MoERunner 的 permute scratch 未按 dp_size 放大
# （AssertionError: n_token <= self.max_num_tokens，见 vllm-project/vllm #47982/#56759），
# 修复经 meta_path import hook 实现，仅 Decode Pod 挂载加载（Prefill 不加载）。
# 本 step 幂等：命名空间已存在跳过创建；修复文件内容一致跳过写入。
#
# 执行位置：平台注入 TARGET_HOSTS 时自动推送自身到【首个】目标节点执行（同 check step）；
# 未注入时在执行机本地运行（需本机有 kubectl）。
#
# 契约输出：VLLM_NODE（解析结果）、VLLM_PREPARED=1。
# 退出码：0 正常；1 环境错误。
# 单测：test/test_vllm_native_scripts.sh。
set -uo pipefail

SCRIPT_NAME='vllm-native-prepare'

# ---- step 参数声明 ----
# DEPLOY_MODE = 部署模式：pd=P/D 分离，standalone=仅 Prefill 原生基线
DEPLOY_MODE="${DEPLOY_MODE:-pd}"
# VLLM_NAMESPACE = 部署命名空间（不存在则创建）
VLLM_NAMESPACE="${VLLM_NAMESPACE:-native-vllm}"
# VLLM_NODE = 目标 Kubernetes 节点名；留空 = 按本机 IP 自动匹配 InternalIP
VLLM_NODE="${VLLM_NODE:-}"
# VLLM_MOEFIX_DIR = MoERunner 修复文件在节点上的存放目录（Decode Pod 经 hostPath 挂载）
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
    for var in TARGET_IP TARGET_IPS DEPLOY_MODE VLLM_NAMESPACE VLLM_NODE VLLM_MOEFIX_DIR; do
        printf -v quoted '%q' "${!var:-}"
        remote_env+=("$var=$quoted")
    done
    remote_run "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "env ${remote_env[*]} bash /tmp/$SCRIPT_NAME.sh"
}

# ---- 节点解析（与 check step 同口径）----
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

# ---- MoERunner 修复文件（内容固定；与 native_vllm_deployment_from_xds.md 12.6 一致）----
# 注意：.pth 里只 import hook 模块本体，切忌直接 import vllm（会让 Ray 的 dashboard/raylet
# 等进程提前 import vllm，导致 ray.init() 后卡死）。
write_moefix() {
    local dir=$1
    mkdir -p "$dir" || die "创建 $dir 失败"

    local py="$dir/vllm_native_moefix.py" pth="$dir/zz_vllm_native_moefix.pth"
    local tmp_py tmp_pth
    tmp_py="$(mktemp)"; tmp_pth="$(mktemp)"

    cat >"$tmp_py" <<'MOEFIX_PY'
import sys, importlib.abc
_TARGET = "vllm.model_executor.layers.fused_moe.runner.moe_runner"

def _apply(module):
    MoERunner = getattr(module, "MoERunner", None)
    if MoERunner is None or getattr(MoERunner, "_native_moefix_applied", False):
        return
    _orig = MoERunner.__init__
    def _patched(self, *a, **k):
        _orig(self, *a, **k)
        cfg = getattr(self, "moe_config", None)
        pc = getattr(cfg, "moe_parallel_config", None) if cfg else None
        if pc is None:
            return
        scale = 1
        if getattr(self, "do_naive_dispatch_combine", False):
            scale *= max(1, int(getattr(pc, "dp_size", 1) or 1))
        if int(getattr(pc, "pcp_size", 1) or 1) > 1 and not getattr(pc, "use_all2all_kernels", False):
            scale *= int(getattr(pc, "pcp_size", 1) or 1)
        if scale > 1:
            cfg.max_num_tokens = cfg.max_num_tokens * scale
    MoERunner.__init__ = _patched
    MoERunner._native_moefix_applied = True

class _F(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname != _TARGET:
            return None
        spec = None
        for f in sys.meta_path:
            if f is self: continue
            try: spec = f.find_spec(fullname, path, target)
            except Exception: spec = None
            if spec is not None: break
        if spec is None or getattr(spec, "loader", None) is None:
            return spec
        loader = spec.loader; orig = loader.exec_module
        def exec_module(m):
            orig(m); _apply(m)
        try: loader.exec_module = exec_module
        except Exception: return spec
        return spec

if not any(isinstance(f, _F) for f in sys.meta_path):
    sys.meta_path.insert(0, _F())
MOEFIX_PY

    cat >"$tmp_pth" <<'MOEFIX_PTH'
import vllm_native_moefix
MOEFIX_PTH

    local changed=0
    if ! cmp -s "$tmp_py" "$py" 2>/dev/null; then
        cp "$tmp_py" "$py" && changed=1
    fi
    if ! cmp -s "$tmp_pth" "$pth" 2>/dev/null; then
        cp "$tmp_pth" "$pth" && changed=1
    fi
    rm -f "$tmp_py" "$tmp_pth"
    [[ -s "$py" && -s "$pth" ]] || die "MoERunner 修复文件写入失败：$dir"
    if [[ "$changed" == "1" ]]; then
        echo "[$SCRIPT_NAME] MoERunner 修复文件已写入 $dir（vllm_native_moefix.py + zz_vllm_native_moefix.pth）"
    else
        echo "[$SCRIPT_NAME] MoERunner 修复文件已是最新，跳过写入（$dir）"
    fi
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

    local node
    node="$(resolve_node)" || die "节点解析失败：$node"
    echo "[$SCRIPT_NAME] 目标节点：$node"

    if kubectl get namespace "$VLLM_NAMESPACE" --request-timeout=15s >/dev/null 2>&1; then
        echo "[$SCRIPT_NAME] 命名空间 $VLLM_NAMESPACE 已存在，跳过创建"
    else
        kubectl create namespace "$VLLM_NAMESPACE" --request-timeout=30s || die "创建命名空间 $VLLM_NAMESPACE 失败"
        echo "[$SCRIPT_NAME] 命名空间 $VLLM_NAMESPACE 已创建"
    fi

    write_moefix "$VLLM_MOEFIX_DIR"

    if [[ "$DEPLOY_MODE" == 'pd' && ! -d /dev/infiniband ]]; then
        echo "[$SCRIPT_NAME] WARN: /dev/infiniband 不存在：pd 模式 Mooncake KV 传输需要 RDMA 设备（deploy 的 Pod 会挂载该目录，缺失将传输挂住）" >&2
    fi

    echo "VLLM_NODE=$node"
    echo "VLLM_PREPARED=1"
}

main "$@"
