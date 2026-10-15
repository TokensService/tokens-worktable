#!/usr/bin/env bash
# pipeline: no-positional-args
# vLLM 原生部署 · 服务验证 step 主脚本（无参调用）。
#
# 用途：对部署完成的 vLLM 服务做端到端验证（在目标节点本机执行，Pod hostNetwork
# 直接监听宿主端口）：
#   ① GET  /v1/models（对外端口：pd=Proxy，standalone=Prefill 直听）返回 200 且模型列表非空；
#   ② POST /v1/completions 真实推理一次返回 200 且文本非空（首个请求偶有握手预热抖动，自动重试）；
#   ③ pd 模式：Decode /metrics 的 vllm:prompt_tokens_by_source_total{source="external_kv_transfer"}
#      计数 > 0 —— 证明 prompt 的 KV 确实由 Prefill 经 Mooncake 外部传输而来（而非 Decode 本地重算），
#      这是 P/D 通路生效的直接证据；另探测 Mooncake bootstrap /query 可达。
# 服务地址取目标节点的 Kubernetes InternalIP，经契约 VLLM_SERVICE_ADDR 输出供下游引用。
#
# 执行位置：平台注入 TARGET_HOSTS 时自动推送自身到【首个】目标节点执行（同 check step）；
# 未注入时在执行机本地运行（需本机有 curl，pd 模式还需 kubectl 解析节点 InternalIP）。
#
# 契约输出：VLLM_SERVICE_ADDR（InternalIP:端口）、VLLM_VERIFY=PASS。
# 退出码：0 验证通过；1 失败/环境错误。
# 单测：test/test_vllm_native_scripts.sh。
set -uo pipefail

SCRIPT_NAME='vllm-native-verify'

# ---- step 参数声明 ----
# DEPLOY_MODE = 部署模式：pd=P/D 分离，standalone=仅 Prefill 原生基线
DEPLOY_MODE="${DEPLOY_MODE:-pd}"
# VLLM_NAMESPACE = 部署命名空间
VLLM_NAMESPACE="${VLLM_NAMESPACE:-native-vllm}"
# VLLM_NODE = 目标 Kubernetes 节点名；留空 = 按本机 IP 自动匹配 InternalIP（服务地址取该节点 InternalIP）
VLLM_NODE="${VLLM_NODE:-}"
# VLLM_SERVED_MODEL_NAME = vLLM 对外服务模型名
VLLM_SERVED_MODEL_NAME="${VLLM_SERVED_MODEL_NAME:-GLM-5.2-NVFP4-W4A4C8-MG40-BNT3}"
# PROXY_PORT = 对外服务端口（pd=Proxy 端口；standalone=Prefill 直接监听）
PROXY_PORT="${PROXY_PORT:-8000}"
# DECODE_PORT = Decode 服务端口（pd 模式验证 KV 传输指标用）
DECODE_PORT="${DECODE_PORT:-8020}"
# MOONCAKE_BOOTSTRAP_PORT = Mooncake bootstrap 端口（pd 模式探测用）
MOONCAKE_BOOTSTRAP_PORT="${MOONCAKE_BOOTSTRAP_PORT:-8998}"
# VLLM_VERIFY_KV_XFER = pd 模式是否硬校验 KV 外部传输指标（1=计数不增判失败；0=仅 WARN）
VLLM_VERIFY_KV_XFER="${VLLM_VERIFY_KV_XFER:-1}"
# VLLM_VERIFY_PROMPT = 验证用 prompt
VLLM_VERIFY_PROMPT="${VLLM_VERIFY_PROMPT:-中国的首都是}"
# VLLM_VERIFY_MAX_TOKENS = 验证请求 max_tokens
VLLM_VERIFY_MAX_TOKENS="${VLLM_VERIFY_MAX_TOKENS:-8}"
# VLLM_VERIFY_TIMEOUT = 单次 HTTP 请求超时（秒；首次推理可能触发握手预热）
VLLM_VERIFY_TIMEOUT="${VLLM_VERIFY_TIMEOUT:-180}"

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
    for var in TARGET_IP TARGET_IPS DEPLOY_MODE VLLM_NAMESPACE VLLM_NODE VLLM_SERVED_MODEL_NAME \
               PROXY_PORT DECODE_PORT MOONCAKE_BOOTSTRAP_PORT \
               VLLM_VERIFY_KV_XFER VLLM_VERIFY_PROMPT VLLM_VERIFY_MAX_TOKENS VLLM_VERIFY_TIMEOUT; do
        printf -v quoted '%q' "${!var:-}"
        remote_env+=("$var=$quoted")
    done
    remote_run "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "env ${remote_env[*]} bash /tmp/$SCRIPT_NAME.sh"
}

# ---- 节点 InternalIP 解析（服务地址展示用；kubectl 不可用时回退本机首个非回环地址）----
node_internal_ip() {
    if have kubectl && have python3; then
        local nodes_json ip
        nodes_json="$(kubectl get nodes -o json --request-timeout=30s 2>/dev/null)" || true
        if [[ -n "$nodes_json" ]]; then
            ip="$(NODES_JSON="$nodes_json" python3 - "$VLLM_NODE" 2>/dev/null <<'PY'
import json
import os
import subprocess
import sys

want = sys.argv[1].strip()
nodes = json.loads(os.environ["NODES_JSON"]).get("items", [])


def internal_ip(item):
    for addr in item.get("status", {}).get("addresses", []):
        if addr.get("type") == "InternalIP":
            return addr.get("address", "")
    return ""


target = None
if want:
    target = next((item for item in nodes if item.get("metadata", {}).get("name") == want), None)
else:
    local = subprocess.run(["hostname", "-I"], capture_output=True, text=True).stdout.split()
    mine = set(filter(None, local))
    for item in nodes:
        if internal_ip(item) in mine:
            target = item
            break
if target is not None:
    print(internal_ip(target))
PY
)"
            if [[ -n "$ip" ]]; then
                printf '%s\n' "$ip"
                return
            fi
        fi
    fi
    hostname -I 2>/dev/null | awk '{print $1}'
}

http_code() { # <method> <url> [data]
    local method=$1 url=$2 data=${3:-}
    if [[ -n "$data" ]]; then
        curl -sS -o /dev/null -w '%{http_code}' --max-time "$VLLM_VERIFY_TIMEOUT" \
            -X "$method" -H 'Content-Type: application/json' -d "$data" "$url" 2>/dev/null
    else
        curl -sS -o /dev/null -w '%{http_code}' --max-time "$VLLM_VERIFY_TIMEOUT" -X "$method" "$url" 2>/dev/null
    fi
}

main() {
    [[ $# -eq 0 ]] || die '不支持命令行参数；请使用环境变量配置'
    if [[ -n "${platform_target_hosts:-}" && "${platform_target_hosts:-}" != '[]' ]]; then
        dispatch_to_target
        return
    fi

    have curl || die '需要 curl'
    have python3 || die '需要 python3'

    local base="http://127.0.0.1:$PROXY_PORT"
    echo "[$SCRIPT_NAME] 验证 $DEPLOY_MODE 部署（服务入口 $base）"

    # ---- ① /v1/models ----
    local models_body code model_ids
    models_body="$(curl -sS --max-time "$VLLM_VERIFY_TIMEOUT" "$base/v1/models" 2>/dev/null)" \
        || die "GET $base/v1/models 请求失败（服务未就绪？）"
    code="$(http_code GET "$base/v1/models")"
    [[ "$code" == '200' ]] || die "GET $base/v1/models 返回 HTTP $code（期望 200）"
    model_ids="$(python3 -c '
import json, sys
data = json.loads(sys.argv[1])
ids = [m.get("id", "") for m in data.get("data", [])]
print(",".join(i for i in ids if i))
' "$models_body" 2>/dev/null)" || die '解析 /v1/models 响应失败'
    [[ -n "$model_ids" ]] || die '/v1/models 返回的模型列表为空'
    echo "[$SCRIPT_NAME] /v1/models 200，模型列表：$model_ids"
    if [[ -n "$VLLM_SERVED_MODEL_NAME" && ",$model_ids," != *",$VLLM_SERVED_MODEL_NAME,"* ]]; then
        echo "[$SCRIPT_NAME] WARN: 期望的 served-model-name「$VLLM_SERVED_MODEL_NAME」不在列表中（以实际列表为准）" >&2
    fi

    # ---- ② 真实推理一次（/v1/completions；首个请求可能握手预热，最多重试 2 次）----
    local model_for_req="$VLLM_SERVED_MODEL_NAME"
    [[ -z "$model_for_req" ]] && model_for_req="${model_ids%%,*}"
    local payload attempt resp ok=0
    payload="$(python3 -c '
import json, sys
print(json.dumps({"model": sys.argv[1], "prompt": sys.argv[2],
                  "max_tokens": int(sys.argv[3]), "temperature": 0}))
' "$model_for_req" "$VLLM_VERIFY_PROMPT" "$VLLM_VERIFY_MAX_TOKENS")"
    for attempt in 1 2 3; do
        code="$(http_code POST "$base/v1/completions" "$payload")"
        if [[ "$code" == '200' ]]; then
            resp="$(curl -sS --max-time "$VLLM_VERIFY_TIMEOUT" -H 'Content-Type: application/json' -d "$payload" "$base/v1/completions" 2>/dev/null)"
            if python3 -c '
import json, sys
data = json.loads(sys.argv[1])
text = "".join(c.get("text", "") for c in data.get("choices", []))
sys.exit(0 if text.strip() else 1)
' "$resp" 2>/dev/null; then
                ok=1
                echo "[$SCRIPT_NAME] /v1/completions 200（第 $attempt 次尝试），模型输出：$(python3 -c '
import json, sys
data = json.loads(sys.argv[1])
print("".join(c.get("text", "") for c in data.get("choices", [])).strip()[:80])
' "$resp" 2>/dev/null)"
                break
            fi
        fi
        echo "[$SCRIPT_NAME] /v1/completions 第 $attempt 次尝试未通过（HTTP $code），重试…" >&2
        sleep 5
    done
    [[ "$ok" == "1" ]] || die "POST $base/v1/completions 连续 3 次未通过"

    # ---- ③ pd：KV 外部传输指标 + bootstrap 探测 ----
    if [[ "$DEPLOY_MODE" == 'pd' ]]; then
        local metrics xfer
        metrics="$(curl -sS --max-time 30 "http://127.0.0.1:$DECODE_PORT/metrics" 2>/dev/null)" \
            || die "GET Decode /metrics 失败（http://127.0.0.1:$DECODE_PORT）"
        xfer="$(grep -E '^vllm:prompt_tokens_by_source_total\{[^}]*source="external_kv_transfer"[^}]*\}' <<<"$metrics" \
                | awk '{s+=$NF} END {print s+0}')"
        echo "[$SCRIPT_NAME] Decode external_kv_transfer prompt tokens 累计：$xfer"
        if awk -v v="$xfer" 'BEGIN{exit !(v>0)}'; then
            echo "[$SCRIPT_NAME] KV 外部传输已生效（prompt 的 KV 由 Prefill 经 Mooncake 传输，而非 Decode 本地重算）"
        elif [[ "$VLLM_VERIFY_KV_XFER" == '1' ]]; then
            die "Decode 未观察到 external_kv_transfer 计数增长：P/D KV 传输未生效（检查 Mooncake/RDMA 与 Proxy 缓存的 engine_id 是否过期）"
        else
            echo "[$SCRIPT_NAME] WARN: 未观察到 external_kv_transfer 计数增长（VLLM_VERIFY_KV_XFER=0，降级为提示）" >&2
        fi
        code="$(http_code GET "http://127.0.0.1:$MOONCAKE_BOOTSTRAP_PORT/query")"
        if [[ "$code" == '200' ]]; then
            echo "[$SCRIPT_NAME] Mooncake bootstrap /query 200"
        else
            echo "[$SCRIPT_NAME] WARN: Mooncake bootstrap /query 返回 HTTP $code（不影响已验证的 P/D 通路，仅供排查参考）" >&2
        fi
    fi

    local svc_ip
    svc_ip="$(node_internal_ip)"
    echo "[$SCRIPT_NAME] 验证通过。服务地址：http://$svc_ip:$PROXY_PORT（POST /v1/completions、/v1/chat/completions）"
    echo "VLLM_SERVICE_ADDR=$svc_ip:$PROXY_PORT"
    echo "VLLM_VERIFY=PASS"
}

main "$@"
