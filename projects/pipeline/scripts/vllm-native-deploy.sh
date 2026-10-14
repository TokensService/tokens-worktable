#!/usr/bin/env bash
# pipeline: no-positional-args
# vLLM 原生部署 · Pod 部署 step 主脚本（按 VLLM_ROLE 部署单个角色，无命令行参数）。
#
# 用途：按「原生 vLLM 部署配方」（native_vllm_deployment_from_xds.md 第 12 节；
# vLLM 代码基线 TokensService/vllm 分支 v0.30.0.tokens）在目标节点部署一个角色：
#   VLLM_ROLE=prefill  Prefill Pod（TP×PP，kv_producer；standalone 模式直接对外服务）
#   VLLM_ROLE=decode   Decode Pod（TP×DP + Ray，kv_consumer；挂载节点准备 step 写入的
#                      MoERunner 修复文件；standalone 模式本角色跳过）
#   VLLM_ROLE=proxy    Mooncake Proxy Pod（转发 Prefill/Decode；仅在 P/D 就绪后部署/重建——
#                      代理仅启动时查询一次 prefill bootstrap 并缓存 engine_id，P/D 每次重启后
#                      engine_id 变化，必须重建代理；standalone 模式本角色跳过）
# Pod 规格不可变，本脚本一律先删后建（delete --ignore-not-found --wait 再 apply），幂等可重跑。
#
# 执行位置：平台注入 TARGET_HOSTS 时自动推送自身到【首个】目标节点执行（同 check step）；
# 未注入时在执行机本地运行（需本机有 kubectl 与 python3）。
#
# 契约输出：VLLM_NODE、VLLM_ROLE 对应的 VLLM_PREFILL_POD / VLLM_DECODE_POD / VLLM_PROXY_POD。
# 退出码：0 正常（含 standalone 跳过）；1 环境错误。
# 单测：test/test_vllm_native_scripts.sh。
set -uo pipefail

SCRIPT_NAME='vllm-native-deploy'

# ---- step 参数声明 ----
# VLLM_ROLE = 部署角色：prefill / decode / proxy（必填；仓库约定流水线脚本不声明 :? 必填变量，
#             改运行期显式校验，缺失即 fail-fast）
VLLM_ROLE="${VLLM_ROLE:-}"
[[ -n "$VLLM_ROLE" ]] || { echo "[$SCRIPT_NAME] ERROR: 必须指定 VLLM_ROLE=prefill|decode|proxy" >&2; exit 1; }
# DEPLOY_MODE = 部署模式：pd=P/D 分离，standalone=仅 Prefill 原生基线
DEPLOY_MODE="${DEPLOY_MODE:-pd}"
# VLLM_NAMESPACE = 部署命名空间
VLLM_NAMESPACE="${VLLM_NAMESPACE:-native-vllm}"
# VLLM_NODE = 目标 Kubernetes 节点名；留空 = 按本机 IP 自动匹配 InternalIP
VLLM_NODE="${VLLM_NODE:-}"
# VLLM_IMAGE = vLLM 容器镜像
VLLM_IMAGE="${VLLM_IMAGE:-swr.cn-southwest-2.myhuaweicloud.com/dataartsfabric/xds:lmx_vllm-0.30.0-1011-wwx.20261013211805.BNT3.x86_64}"
# VLLM_RUNTIME_CLASS = 容器 RuntimeClass
VLLM_RUNTIME_CLASS="${VLLM_RUNTIME_CLASS:-dcgm-nvidia-runtime}"
# VLLM_IMAGE_PULL_SECRETS = 镜像凭证 Secret（逗号分隔；留空 = 不配置）
VLLM_IMAGE_PULL_SECRETS="${VLLM_IMAGE_PULL_SECRETS:-}"
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
# PREFILL_GPU = Prefill Pod 申请 GPU 数
PREFILL_GPU="${PREFILL_GPU:-4}"
# DECODE_GPU = Decode Pod 申请 GPU 数
DECODE_GPU="${DECODE_GPU:-4}"
# PP_LAYER_PARTITION = PP 层切分（逗号分隔，经 env VLLM_PP_LAYER_PARTITION 下发）
PP_LAYER_PARTITION="${PP_LAYER_PARTITION:-22,20,20,16}"
# PREFILL_PORT = Prefill 服务端口（pd 模式）
PREFILL_PORT="${PREFILL_PORT:-8010}"
# DECODE_PORT = Decode 服务端口
DECODE_PORT="${DECODE_PORT:-8020}"
# PROXY_PORT = 对外服务端口（pd=Proxy 端口；standalone=Prefill 直接监听）
PROXY_PORT="${PROXY_PORT:-8000}"
# MOONCAKE_BOOTSTRAP_PORT = Mooncake bootstrap 端口
MOONCAKE_BOOTSTRAP_PORT="${MOONCAKE_BOOTSTRAP_PORT:-8998}"
# VLLM_MAX_MODEL_LEN = 最大上下文长度
VLLM_MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-1048576}"
# PREFILL_MAX_NUM_SEQS = Prefill 最大并发序列数
PREFILL_MAX_NUM_SEQS="${PREFILL_MAX_NUM_SEQS:-8}"
# PREFILL_MAX_NUM_BATCHED_TOKENS = Prefill 单步最大 batch token 数
PREFILL_MAX_NUM_BATCHED_TOKENS="${PREFILL_MAX_NUM_BATCHED_TOKENS:-32768}"
# PREFILL_GPU_MEM_UTIL = Prefill 显存利用率
PREFILL_GPU_MEM_UTIL="${PREFILL_GPU_MEM_UTIL:-0.90}"
# DECODE_MAX_NUM_SEQS = Decode 最大并发序列数
DECODE_MAX_NUM_SEQS="${DECODE_MAX_NUM_SEQS:-32}"
# DECODE_MAX_NUM_BATCHED_TOKENS = Decode 单步最大 batch token 数
DECODE_MAX_NUM_BATCHED_TOKENS="${DECODE_MAX_NUM_BATCHED_TOKENS:-128}"
# DECODE_GPU_MEM_UTIL = Decode 显存利用率
DECODE_GPU_MEM_UTIL="${DECODE_GPU_MEM_UTIL:-0.94}"
# VLLM_BLOCK_SIZE = KV cache block 大小（GLM-5.2 NVFP4 各 PP rank 页面须统一为 64）
VLLM_BLOCK_SIZE="${VLLM_BLOCK_SIZE:-64}"
# VLLM_SPECULATIVE_CONFIG = 投机采样配置 JSON（默认 MTP3；bash 双引号默认值内层引号须转义）
VLLM_SPECULATIVE_CONFIG="${VLLM_SPECULATIVE_CONFIG:-{\"method\":\"mtp\",\"num_speculative_tokens\":3}}"
# VLLM_DSHM_SIZE = Pod /dev/shm 内存卷大小
VLLM_DSHM_SIZE="${VLLM_DSHM_SIZE:-32Gi}"
# VLLM_MOEFIX_DIR = MoERunner 修复文件在节点上的目录（Decode Pod 经 hostPath 挂载，仅 pd）
VLLM_MOEFIX_DIR="${VLLM_MOEFIX_DIR:-/tmp/vllm_xds_fix}"
# VLLM_PY_DIST_PACKAGES = 镜像内 Python dist-packages 目录（moefix 挂载目标）
VLLM_PY_DIST_PACKAGES="${VLLM_PY_DIST_PACKAGES:-/usr/local/lib/python3.12/dist-packages}"
# VLLM_PROXY_SCRIPT = 镜像内 Mooncake 代理脚本路径
VLLM_PROXY_SCRIPT="${VLLM_PROXY_SCRIPT:-/vllm-workspace/examples/disaggregated/mooncake_connector/mooncake_connector_proxy.py}"
# PREFILL_EXTRA_ARGS = 追加到 Prefill vllm serve 的额外参数（原样拼接；勿含单引号/$/反引号）
PREFILL_EXTRA_ARGS="${PREFILL_EXTRA_ARGS:-}"
# DECODE_EXTRA_ARGS = 追加到 Decode vllm serve 的额外参数（原样拼接；勿含单引号/$/反引号）
DECODE_EXTRA_ARGS="${DECODE_EXTRA_ARGS:-}"

# 平台注入变量经 nameref 间接引用，避免被「识别参数」扫入参数面
declare -n platform_target_hosts='TARGET_HOSTS'

# 渲染 Pod YAML 的子进程（python3）经环境变量读取配置：显式导出全部部署参数
export DEPLOY_MODE VLLM_NAMESPACE VLLM_IMAGE VLLM_RUNTIME_CLASS VLLM_IMAGE_PULL_SECRETS \
       MODEL_PATH MODEL_HOST_PATH MODEL_MOUNT_PATH VLLM_SERVED_MODEL_NAME \
       VLLM_TP PREFILL_PP DECODE_DP PREFILL_GPU DECODE_GPU PP_LAYER_PARTITION \
       PREFILL_PORT DECODE_PORT PROXY_PORT MOONCAKE_BOOTSTRAP_PORT \
       VLLM_MAX_MODEL_LEN PREFILL_MAX_NUM_SEQS PREFILL_MAX_NUM_BATCHED_TOKENS PREFILL_GPU_MEM_UTIL \
       DECODE_MAX_NUM_SEQS DECODE_MAX_NUM_BATCHED_TOKENS DECODE_GPU_MEM_UTIL \
       VLLM_BLOCK_SIZE VLLM_SPECULATIVE_CONFIG VLLM_DSHM_SIZE \
       VLLM_MOEFIX_DIR VLLM_PY_DIST_PACKAGES VLLM_PROXY_SCRIPT \
       PREFILL_EXTRA_ARGS DECODE_EXTRA_ARGS

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
    for var in TARGET_IP TARGET_IPS VLLM_ROLE DEPLOY_MODE VLLM_NAMESPACE VLLM_NODE VLLM_IMAGE \
               VLLM_RUNTIME_CLASS VLLM_IMAGE_PULL_SECRETS \
               MODEL_PATH MODEL_HOST_PATH MODEL_MOUNT_PATH VLLM_SERVED_MODEL_NAME \
               VLLM_TP PREFILL_PP DECODE_DP PREFILL_GPU DECODE_GPU PP_LAYER_PARTITION \
               PREFILL_PORT DECODE_PORT PROXY_PORT MOONCAKE_BOOTSTRAP_PORT \
               VLLM_MAX_MODEL_LEN PREFILL_MAX_NUM_SEQS PREFILL_MAX_NUM_BATCHED_TOKENS PREFILL_GPU_MEM_UTIL \
               DECODE_MAX_NUM_SEQS DECODE_MAX_NUM_BATCHED_TOKENS DECODE_GPU_MEM_UTIL \
               VLLM_BLOCK_SIZE VLLM_SPECULATIVE_CONFIG VLLM_DSHM_SIZE \
               VLLM_MOEFIX_DIR VLLM_PY_DIST_PACKAGES VLLM_PROXY_SCRIPT \
               PREFILL_EXTRA_ARGS DECODE_EXTRA_ARGS; do
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

# ---- Pod YAML 渲染（python3 直写，避免 shell 对 JSON/正则类参数值的转义问题）----
render_pod_yaml() { # <role> <out-file>
    local role=$1 out=$2
    python3 - "$role" >"$out" <<'PY'
import os
import sys

role = sys.argv[1]
e = os.environ

mode = e.get("DEPLOY_MODE", "pd")
ns = e["VLLM_NAMESPACE"]
node = e["VLLM_NODE"]
image = e["VLLM_IMAGE"]
rtc = e["VLLM_RUNTIME_CLASS"]
model_path = e["MODEL_PATH"]
model_host = e["MODEL_HOST_PATH"]
model_mount = e["MODEL_MOUNT_PATH"]
served = e["VLLM_SERVED_MODEL_NAME"]
tp = e["VLLM_TP"]
pp = e["PREFILL_PP"]
dp = e["DECODE_DP"]
p_gpu = e["PREFILL_GPU"]
d_gpu = e["DECODE_GPU"]
pp_layers = e["PP_LAYER_PARTITION"]
p_port = e["PREFILL_PORT"]
d_port = e["DECODE_PORT"]
x_port = e["PROXY_PORT"]
boot_port = e["MOONCAKE_BOOTSTRAP_PORT"]
max_len = e["VLLM_MAX_MODEL_LEN"]
p_seqs = e["PREFILL_MAX_NUM_SEQS"]
p_batched = e["PREFILL_MAX_NUM_BATCHED_TOKENS"]
p_util = e["PREFILL_GPU_MEM_UTIL"]
d_seqs = e["DECODE_MAX_NUM_SEQS"]
d_batched = e["DECODE_MAX_NUM_BATCHED_TOKENS"]
d_util = e["DECODE_GPU_MEM_UTIL"]
block = e["VLLM_BLOCK_SIZE"]
spec = e["VLLM_SPECULATIVE_CONFIG"]
dshm = e["VLLM_DSHM_SIZE"]
moefix_dir = e["VLLM_MOEFIX_DIR"]
dist_packages = e["VLLM_PY_DIST_PACKAGES"]
proxy_script = e["VLLM_PROXY_SCRIPT"]
p_extra = e.get("PREFILL_EXTRA_ARGS", "").strip()
d_extra = e.get("DECODE_EXTRA_ARGS", "").strip()
pull_secrets = [s.strip() for s in e.get("VLLM_IMAGE_PULL_SECRETS", "").split(",") if s.strip()]

# standalone：Prefill 直接监听对外端口，不接 Mooncake
prefill_listen_port = p_port if mode == "pd" else x_port

pull_secrets_yaml = ""
if pull_secrets:
    pull_secrets_yaml = "  imagePullSecrets:\n" + "".join(f"  - name: {s}\n" for s in pull_secrets)


def serve_script(lines):
    """把 vllm serve 参数行拼成容器启动脚本（反斜杠续行 + 6 空格缩进，贴合 YAML 块标量）。"""
    body = "NGPU=$(nvidia-smi -L | wc -l)\n" \
           "export CUDA_VISIBLE_DEVICES=$(seq -s, 0 $((NGPU-1)))\n"
    joined = " \\\n".join(lines)
    return body + joined + "\n"


def pod(name, container_script, gpu, env_lines, mounts_extra, volumes_extra):
    env_yaml = "".join(
        f"    - name: {k}\n      value: {v}\n" for k, v in env_lines)
    env_section = f"    env:\n{env_yaml}" if env_yaml else ""
    indented_script = "\n".join("      " + line for line in container_script.splitlines())
    # gpu=="0"（proxy）：不要 GPU runtimeClass / 卷挂载（纯 HTTP 转发 Pod）
    rtc_line = f"  runtimeClassName: {rtc}\n" if gpu != "0" else ""
    mounts = ""
    volumes = ""
    if gpu != "0":
        mounts = (f"    - name: model-store\n      mountPath: {model_mount}\n"
                  "    - name: dshm\n      mountPath: /dev/shm\n") + mounts_extra
        volumes = (f"  - name: model-store\n    hostPath:\n      path: {model_host}\n      type: Directory\n"
                   f"  - name: dshm\n    emptyDir:\n      medium: Memory\n      sizeLimit: {dshm}\n") + volumes_extra
    mounts_section = f"    volumeMounts:\n{mounts}" if mounts else ""
    volumes_section = f"  volumes:\n{volumes}" if volumes else ""
    return f"""apiVersion: v1
kind: Pod
metadata:
  name: {name}
  namespace: {ns}
  labels:
    app: {name}
    app.kubernetes.io/managed-by: tokens-worktable-pipeline
spec:
  hostNetwork: true
  dnsPolicy: ClusterFirstWithHostNet
{rtc_line}  restartPolicy: Never
  nodeName: {node}
{pull_secrets_yaml}  containers:
  - name: vllm
    image: {image}
    imagePullPolicy: IfNotPresent
{env_section}    command: ["/bin/bash", "-lc"]
    args:
    - |
{indented_script}
    resources:
      limits:
        nvidia.com/gpu: "{gpu}"
{mounts_section}
{volumes_section}"""


if role == "prefill":
    env_lines = [("VLLM_PLUGINS", "\"\""),
                 ("VLLM_PP_LAYER_PARTITION", f"\"{pp_layers}\""),
                 ("XCCL_TURBO_PREFILL_MLA_HEAD_PADDING", "\"64\"")]
    flags = [
        f"vllm serve {model_path}",
        f"--host 0.0.0.0 --port {prefill_listen_port} --served-model-name {served}",
        f"--tensor-parallel-size {tp} --pipeline-parallel-size {pp} --distributed-executor-backend mp",
        f"--block-size {block} --max-model-len {max_len} --max-num-seqs {p_seqs} --max-num-batched-tokens {p_batched}",
        f"--gpu-memory-utilization {p_util} --enable-prefix-caching --kv-cache-dtype fp8",
        f"--speculative-config '{spec}'",
        "--compilation-config '{\"cudagraph_mode\":\"NONE\"}'",
        "--kernel-config '{\"enable_flashinfer_autotune\": false}'",
    ]
    mounts_extra = ""
    volumes_extra = ""
    if mode == "pd":
        env_lines.append(("VLLM_MOONCAKE_BOOTSTRAP_PORT", f"\"{boot_port}\""))
        flags.append("--kv-transfer-config '{\"kv_connector\":\"MooncakeConnector\",\"kv_role\":\"kv_producer\"}'")
        mounts_extra += "    - name: infiniband\n      mountPath: /dev/infiniband\n"
        volumes_extra += "  - name: infiniband\n    hostPath:\n      path: /dev/infiniband\n"
    if p_extra:
        flags.append(p_extra)
    print(pod("vllm-prefill", serve_script(["exec " + flags[0]] + flags[1:]), p_gpu, env_lines, mounts_extra, volumes_extra))

elif role == "decode":
    env_lines = [("VLLM_PLUGINS", "\"\""),
                 ("RAY_EXPERIMENTAL_NOSET_CUDA_VISIBLE_DEVICES", "\"1\"")]
    flags = [
        f"vllm serve {model_path}",
        f"--host 0.0.0.0 --port {d_port} --served-model-name {served}",
        f"--tensor-parallel-size {tp} --data-parallel-size {dp} --data-parallel-backend ray --distributed-executor-backend mp",
        f"--block-size {block} --max-model-len {max_len} --max-num-seqs {d_seqs} --max-num-batched-tokens {d_batched}",
        f"--gpu-memory-utilization {d_util} --enable-prefix-caching --kv-cache-dtype fp8 --async-scheduling",
        f"--speculative-config '{spec}'",
        "--compilation-config '{\"cudagraph_mode\":\"NONE\"}'",
        "--kernel-config '{\"enable_flashinfer_autotune\": false}'",
        "--kv-transfer-config '{\"kv_connector\":\"MooncakeConnector\",\"kv_role\":\"kv_consumer\"}'",
    ]
    if d_extra:
        flags.append(d_extra)
    mounts_extra = ("    - name: infiniband\n      mountPath: /dev/infiniband\n"
                    f"    - name: moefix\n      mountPath: {dist_packages}/vllm_native_moefix.py\n      subPath: vllm_native_moefix.py\n"
                    f"    - name: moefix\n      mountPath: {dist_packages}/zz_vllm_native_moefix.pth\n      subPath: zz_vllm_native_moefix.pth\n")
    volumes_extra = ("  - name: infiniband\n    hostPath:\n      path: /dev/infiniband\n"
                     f"  - name: moefix\n    hostPath:\n      path: {moefix_dir}\n      type: Directory\n")
    print(pod("vllm-decode", serve_script(["exec " + flags[0]] + flags[1:]), d_gpu, env_lines, mounts_extra, volumes_extra))

elif role == "proxy":
    env_lines = []
    script = f"exec python3 {proxy_script} --prefill http://127.0.0.1:{p_port} {boot_port} --decode http://127.0.0.1:{d_port} --host 0.0.0.0 --port {x_port}\n"
    print(pod("vllm-pd-proxy", script, "0", env_lines, "", ""))

else:
    raise SystemExit(f"unknown role: {role}")
PY
}

deploy_one() { # <role> <pod-name>
    local role=$1 pod=$2 node=$3 yaml
    yaml="$(mktemp --suffix=.yaml)"
    VLLM_NODE="$node" render_pod_yaml "$role" "$yaml" || { rm -f "$yaml"; die "渲染 $role Pod YAML 失败"; }
    echo "[$SCRIPT_NAME] ---- $role Pod YAML（$yaml）----"
    cat "$yaml"
    echo "[$SCRIPT_NAME] ---- YAML 结束 ----"
    kubectl -n "$VLLM_NAMESPACE" delete pod "$pod" --ignore-not-found --wait=true --timeout=180s \
        || { rm -f "$yaml"; die "删除旧 Pod $pod 失败"; }
    kubectl apply -f "$yaml" --request-timeout=60s || { rm -f "$yaml"; die "创建 Pod $pod 失败"; }
    rm -f "$yaml"
    kubectl -n "$VLLM_NAMESPACE" get pod "$pod" -o wide --request-timeout=30s || true
}

main() {
    [[ $# -eq 0 ]] || die '不支持命令行参数；请使用环境变量配置'
    if [[ -n "${platform_target_hosts:-}" && "${platform_target_hosts:-}" != '[]' ]]; then
        dispatch_to_target
        return
    fi

    case "$VLLM_ROLE" in
        prefill|decode|proxy) ;;
        *) die "VLLM_ROLE 仅支持 prefill / decode / proxy，当前：$VLLM_ROLE" ;;
    esac

    if [[ "$DEPLOY_MODE" == 'standalone' && "$VLLM_ROLE" != 'prefill' ]]; then
        echo "[$SCRIPT_NAME] DEPLOY_MODE=standalone：仅部署 Prefill，跳过角色 $VLLM_ROLE"
        exit 0
    fi

    have kubectl || die '本机缺少 kubectl；本 step 通过 TARGET_HOSTS 自动分发到目标节点执行，手工运行请在有 kubectl 的主机上执行'
    have python3 || die '需要 python3'
    kubectl version --request-timeout=5s >/dev/null 2>&1 || die 'kubectl 无法访问 Kubernetes API'
    kubectl get namespace "$VLLM_NAMESPACE" --request-timeout=15s >/dev/null 2>&1 \
        || die "命名空间 $VLLM_NAMESPACE 不存在（请先运行节点准备 step）"

    if [[ "$VLLM_ROLE" == 'decode' ]]; then
        [[ -f "$VLLM_MOEFIX_DIR/vllm_native_moefix.py" && -f "$VLLM_MOEFIX_DIR/zz_vllm_native_moefix.pth" ]] \
            || die "MoERunner 修复文件缺失：$VLLM_MOEFIX_DIR（请先运行节点准备 step）"
    fi

    local node
    node="$(resolve_node)" || die "节点解析失败：$node"
    echo "[$SCRIPT_NAME] 目标节点：$node，角色：$VLLM_ROLE，模式：$DEPLOY_MODE"

    local pod="vllm-$VLLM_ROLE"
    [[ "$VLLM_ROLE" == 'proxy' ]] && pod='vllm-pd-proxy'
    deploy_one "$VLLM_ROLE" "$pod" "$node"

    echo "[$SCRIPT_NAME] $VLLM_ROLE 已提交（Pod $pod，命名空间 $VLLM_NAMESPACE）"
    echo "VLLM_NODE=$node"
    case "$VLLM_ROLE" in
        prefill) echo "VLLM_PREFILL_POD=$pod" ;;
        decode)  echo "VLLM_DECODE_POD=$pod" ;;
        proxy)   echo "VLLM_PROXY_POD=$pod" ;;
    esac
}

main "$@"
