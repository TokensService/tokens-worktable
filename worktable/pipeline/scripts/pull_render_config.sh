#!/usr/bin/env bash
# Prepare one deployment contract: pre-pull the image, then render templates.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
contains_unexpanded_placeholder() {
  [[ "${1:-}" == *'${'* || "${1:-}" == *'$('* ]]
}

normalize_kubernetes_name() {
  local value="$1" max_length="$2"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/-+/-/g; s/^-+//; s/-+$//')"
  value="${value:0:max_length}"
  value="${value%-}"
  [[ -n "$value" ]] || { echo "cannot derive a Kubernetes name from: $1" >&2; return 2; }
  printf '%s' "$value"
}

IMAGE_NAME="${IMAGE_NAME:-}"
DEPLOY_IMAGE="${DEPLOY_IMAGE:-}"
contains_unexpanded_placeholder "$IMAGE_NAME" && IMAGE_NAME=""
contains_unexpanded_placeholder "$DEPLOY_IMAGE" && DEPLOY_IMAGE=""
[[ -n "$IMAGE_NAME" ]] || IMAGE_NAME="${DEPLOY_IMAGE:-myapp}"
[[ -n "$DEPLOY_IMAGE" ]] || DEPLOY_IMAGE="$IMAGE_NAME"
# 架构名优先使用流水线 arch_name、DEPLOY_STRATEGY 和显式 ARCH_NAME；arch 作为运行时兼容别名。
resolved_arch_name="${arch_name:-}"
[[ -n "$resolved_arch_name" ]] || resolved_arch_name="${DEPLOY_STRATEGY:-}"
[[ -n "$resolved_arch_name" ]] || resolved_arch_name="${ARCH_NAME:-}"
[[ -n "$resolved_arch_name" ]] || resolved_arch_name="${arch:-}"
ARCH_NAME="${resolved_arch_name:-default}"
EMS_NAMESPACE="${EMS_NAMESPACE:-op-ems}"
PIPELINE_NAME="${PIPELINE_NAME:-}"
contains_unexpanded_placeholder "$PIPELINE_NAME" && PIPELINE_NAME=""
[[ -n "$PIPELINE_NAME" ]] || PIPELINE_NAME="xds-${ARCH_NAME}"
RUN_DIR="${RUN_DIR:-}"
contains_unexpanded_placeholder "$RUN_DIR" && RUN_DIR=""
# Match deploy-model.sh and the remote target so separate pipeline stages use
# the same execution-host rendered artifacts by default.
[[ -n "$RUN_DIR" ]] || RUN_DIR="/tmp/op-test-pipeline/${PIPELINE_NAME}"
RENDER_DIR="${RENDER_DIR:-}"
contains_unexpanded_placeholder "$RENDER_DIR" && RENDER_DIR=""
[[ -n "$RENDER_DIR" ]] || RENDER_DIR="${RUN_DIR}/rendered"
IMAGE_TAG="${IMAGE_TAG:-local}"
NAMESPACE_ARCH="${arch:-}"
[[ -n "$NAMESPACE_ARCH" ]] || NAMESPACE_ARCH="${DEPLOY_STRATEGY:-}"
EXECUTOR="${EXECUTOR:-}"
[[ -n "$EXECUTOR" ]] || EXECUTOR="${BY:-}"
NAMESPACE="${NAMESPACE:-}"
contains_unexpanded_placeholder "$NAMESPACE" && NAMESPACE=""
if [[ -z "$NAMESPACE" ]]; then
  namespace_base="${NAMESPACE_ARCH:-}"
  [[ -n "$namespace_base" ]] || namespace_base="$ARCH_NAME"
  if [[ -n "$EXECUTOR" ]]; then
    NAMESPACE="xds-${namespace_base}-${EXECUTOR}"
  else
    NAMESPACE="xds-${namespace_base}"
  fi
fi
NAMESPACE="$(normalize_kubernetes_name "$NAMESPACE" 63)"
RELEASE_NAME="${RELEASE_NAME:-}"
contains_unexpanded_placeholder "$RELEASE_NAME" && RELEASE_NAME=""
[[ -n "$RELEASE_NAME" && "$RELEASE_NAME" != "$NAMESPACE" ]] || RELEASE_NAME="xds"
RELEASE_NAME="$(normalize_kubernetes_name "$RELEASE_NAME" 53)"
ENABLE_PROFILING="${ENABLE_PROFILING:-false}"
PROFILING_PREFILL_DIR="${PROFILING_PREFILL_DIR:-/home/service/works/models_ssd/profile/prefill-64k}"
PROFILING_DECODE_DIR="${PROFILING_DECODE_DIR:-/home/service/works/models_ssd/profile/decode-64k}"
PROFILING_TIMESTAMP="${PROFILING_TIMESTAMP:-$(date +%Y%m%d_%H%M%S)}"
PROFILING_MAX_ITERATIONS="${PROFILING_MAX_ITERATIONS:-3}"
append_profiling_run_dir() {
  local base="$1" suffix="${NAMESPACE}/${PROFILING_TIMESTAMP}"
  case "$base" in
    */"$suffix") printf '%s\n' "$base" ;;
    *) printf '%s/%s\n' "${base%/}" "$suffix" ;;
  esac
}
PROFILING_PREFILL_DIR="$(append_profiling_run_dir "$PROFILING_PREFILL_DIR")"
PROFILING_DECODE_DIR="$(append_profiling_run_dir "$PROFILING_DECODE_DIR")"
CHART_DIR="${CHART_DIR:-}"
contains_unexpanded_placeholder "$CHART_DIR" && CHART_DIR=""
[[ -n "$CHART_DIR" ]] || CHART_DIR="${RENDER_DIR}/xds-cluster"
VALUES_FILE="${VALUES_FILE:-}"
contains_unexpanded_placeholder "$VALUES_FILE" && VALUES_FILE=""
[[ -n "$VALUES_FILE" ]] || VALUES_FILE="${RENDER_DIR}/values.rendered.yaml"
ARCH_REQUEST_FILE="${ARCH_REQUEST_FILE:-}"
contains_unexpanded_placeholder "$ARCH_REQUEST_FILE" && ARCH_REQUEST_FILE=""
[[ -n "$ARCH_REQUEST_FILE" ]] || ARCH_REQUEST_FILE="${RENDER_DIR}/architecture.request.json"
RESOURCE_MANIFEST="${RESOURCE_MANIFEST:-}"
contains_unexpanded_placeholder "$RESOURCE_MANIFEST" && RESOURCE_MANIFEST=""
[[ -n "$RESOURCE_MANIFEST" ]] || RESOURCE_MANIFEST="${RENDER_DIR}/resources.rendered.json"
NODE_LABELS_FILE="${NODE_LABELS_FILE:-}"
contains_unexpanded_placeholder "$NODE_LABELS_FILE" && NODE_LABELS_FILE=""
[[ -n "$NODE_LABELS_FILE" ]] || NODE_LABELS_FILE="${RENDER_DIR}/node-labels.json"
TARGET_HOSTS="${TARGET_HOSTS:-}"
TARGET_IP="${TARGET_IP:-}"
TARGET_IPS="${TARGET_IPS:-}"
DEFAULT_TARGET_NODE_IP_MAP='{"115.33.98.101:2224":"192.168.31.140","115.33.98.101:2225":"192.168.31.120","115.33.98.101:2226":"192.168.31.113","115.33.98.101:2227":"192.168.31.164","115.33.98.101:2228":"192.168.31.7","115.33.98.101:2229":"192.168.31.181"}'
TARGET_NODE_IP_MAP="${TARGET_NODE_IP_MAP:-}"
[[ -n "$TARGET_NODE_IP_MAP" ]] || TARGET_NODE_IP_MAP='{}'
if [[ -z "${NODE_PORT_MAP:-}" ]]; then
  NODE_PORT_MAP='{"192.168.31.59":31000,"192.168.31.125":31001,"192.168.31.18":31002,"192.168.31.127":31003,"192.168.31.190":31004,"192.168.31.104":31005,"192.168.31.197":31007,"192.168.31.175":31008,"192.168.31.17":31009,"192.168.31.238":31010,"192.168.31.163":31011,"192.168.31.70":31012,"192.168.31.214":31013,"192.168.31.111":31014,"192.168.31.65":31015,"192.168.31.96":31016,"192.168.31.105":31017,"192.168.31.89":31018,"192.168.31.140":31000,"192.168.31.120":31001,"192.168.31.113":31002,"192.168.31.164":31003,"192.168.31.7":31004,"192.168.31.181":31006,"192.168.0.243":31002,"192.168.0.128":31004,"192.168.0.215":31008,"192.168.0.55":31009,"192.168.0.126":31016,"192.168.0.237":31017,"192.168.47.35":31008,"192.168.47.181":31009,"192.168.47.115":31040,"192.168.47.3":31041,"192.168.47.71":31042,"192.168.47.44":31043,"192.168.47.214":31044,"192.168.47.92":31035,"192.168.47.148":31036,"192.168.47.4":32004,"192.168.47.109":32109,"192.168.47.112":32112,"192.168.47.201":32201,"192.168.47.85":32085,"192.168.47.141":32141,"192.168.47.90":32090,"192.168.47.15":32015,"192.168.47.32":32032,"192.168.47.246":32246}'
fi
TARGET_NODE_IP_MAP="$(python3 - "$DEFAULT_TARGET_NODE_IP_MAP" "$TARGET_NODE_IP_MAP" <<'PY'
import json
import sys

default_map, override_map = map(json.loads, sys.argv[1:])
if not isinstance(override_map, dict):
    raise SystemExit("TARGET_NODE_IP_MAP must be a JSON object")
default_map.update(override_map)
print(json.dumps(default_map, separators=(",", ":"), sort_keys=True))
PY
)"
TARGET_USER="${TARGET_USER:-root}"
TARGET_RUN_DIR="${TARGET_RUN_DIR:-}"
contains_unexpanded_placeholder "$TARGET_RUN_DIR" && TARGET_RUN_DIR=""
[[ -n "$TARGET_RUN_DIR" ]] || TARGET_RUN_DIR="/tmp/op-test-pipeline/${PIPELINE_NAME}"
TARGET_RENDER_DIR="${TARGET_RENDER_DIR:-}"
contains_unexpanded_placeholder "$TARGET_RENDER_DIR" && TARGET_RENDER_DIR=""
[[ -n "$TARGET_RENDER_DIR" ]] || TARGET_RENDER_DIR="${TARGET_RUN_DIR}/rendered"
TARGET_PIPELINE_ENV_FILE="${TARGET_PIPELINE_ENV_FILE:-}"
contains_unexpanded_placeholder "$TARGET_PIPELINE_ENV_FILE" && TARGET_PIPELINE_ENV_FILE=""
[[ -n "$TARGET_PIPELINE_ENV_FILE" ]] || TARGET_PIPELINE_ENV_FILE="${TARGET_RUN_DIR}/pipeline.env"
SSH_PASSWORD="${SSH_PASSWORD:-}"
[[ -n "$SSH_PASSWORD" ]] || SSH_PASSWORD="${TARGET_PASSWORD:-}"
XDS_URL="${XDS_URL:-}"
HELM_BIN="${HELM_BIN:-helm}"
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
HELM_TIMEOUT="${HELM_TIMEOUT:-10m}"
XDS_READY_TIMEOUT_SECONDS="${XDS_READY_TIMEOUT_SECONDS:-1800}"
XDS_READY_POLL_SECONDS="${XDS_READY_POLL_SECONDS:-5}"
HEAD_LOG_ROOT="${HEAD_LOG_ROOT:-./logs}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-5}"
EMS_LOG_SYNC_INTERVAL_SECONDS="${EMS_LOG_SYNC_INTERVAL_SECONDS:-30}"
EMS_LOG_SOURCE_DIR="${EMS_LOG_SOURCE_DIR:-/opt/cloud/logs/ems}"
EMS_LOG_CONTAINER="${EMS_LOG_CONTAINER:-ray-worker}"
TEMPLATE_VARS_JSON="${TEMPLATE_VARS_JSON:-}"
[[ -n "$TEMPLATE_VARS_JSON" ]] || TEMPLATE_VARS_JSON='{}'
MOCK_HELM_DEPLOY="${MOCK_HELM_DEPLOY:-}"
if [[ -z "$MOCK_HELM_DEPLOY" ]]; then
  MOCK_HELM_DEPLOY="$(python3 - "$TEMPLATE_VARS_JSON" <<'PY'
import json
import sys

try:
    variables = json.loads(sys.argv[1])
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid TEMPLATE_VARS_JSON: {error}")
if not isinstance(variables, dict):
    raise SystemExit("TEMPLATE_VARS_JSON must be an object")
value = variables.get("MOCK_HELM_DEPLOY", "false")
if isinstance(value, bool):
    value = str(value).lower()
if not isinstance(value, str) or value.lower() not in {"true", "false"}:
    raise SystemExit("TEMPLATE_VARS_JSON.MOCK_HELM_DEPLOY must be true or false")
print(value.lower())
PY
)"
fi
PIPELINE_ENV_FILE="${PIPELINE_ENV_FILE:-}"
MODEL_CACHE_HOST_PATH="${MODEL_CACHE_HOST_PATH:-}"
# Render inputs are retained in both pipeline environment contracts so the
# deployment stage can reproduce the configuration selected by the caller.
MOCK_DB="${MOCK_DB:-true}"
XDS_DATABASE_NAME="${XDS_DATABASE_NAME:-xds_db}"
XDS_DATABASE_PORT="${XDS_DATABASE_PORT:-31106}"
XDS_DATABASE_USERNAME="${XDS_DATABASE_USERNAME:-xds}"
XDS_DATABASE_PASSWORD="${XDS_DATABASE_PASSWORD:-XDS@2026}"
# LMCache 配置不再由本 step 暴露：上游 lmcache step（lmcache-config.sh）
# 存在即开启，变量经平台 env 直达 render-config.sh / render-lmcache.sh；
# 无该 step 时 lib/render-lmcache.sh defaults 兑底（缺失即关）。
# Registry credentials are supplied at invocation time. Keep them in the
# process environment for pull-image.sh only; do not serialize them into either
# pipeline environment file.
AK="${AK:-}"
LOGKEY="${LOGKEY:-}"
[[ -n "$LOGKEY" ]] || LOGKEY="${LOGIN_KEY:-}"
# Keep the legacy alias synchronized with the value selected for this run.
LOGIN_KEY="$LOGKEY"
# PROJECT is also used by some callers for the registry namespace (for example
# serverlessai). SWR authentication needs the region instead, so prefer the
# dedicated SWR_PROJECT and only accept PROJECT when it is a region name.
SWR_PROJECT="${SWR_PROJECT:-}"
if [[ -z "$SWR_PROJECT" && "${PROJECT:-}" == cn-* ]]; then
  SWR_PROJECT="$PROJECT"
fi
SWR_PROJECT="${SWR_PROJECT:-cn-southwest-2}"
REGISTRY="${REGISTRY:-swr.cn-southwest-2.myhuaweicloud.com}"
contains_unexpanded_placeholder "$PIPELINE_ENV_FILE" && PIPELINE_ENV_FILE=""
[[ -n "$PIPELINE_ENV_FILE" ]] || PIPELINE_ENV_FILE="${RUN_DIR}/pipeline.env"

# The UI historically provides TARGET_IP/TARGET_IPS, while deployment scripts
# consume TARGET_HOSTS.  Normalize once and keep an optional :port suffix for
# the SSH layer to split later.
TARGET_HOSTS="$(python3 - "$TARGET_HOSTS" "$TARGET_IPS" "$TARGET_IP" "$TARGET_USER" <<'PY'
import json
import sys

raw_hosts, raw_ips, fallback_ip, default_user = sys.argv[1:]

def parse_json_list(raw, name):
    if not raw or raw == '[]':
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise SystemExit(f"invalid {name}: {error}")
    if not isinstance(value, list):
        raise SystemExit(f"{name} must be a JSON array")
    return value

hosts = parse_json_list(raw_hosts, "TARGET_HOSTS")
if hosts:
    result = []
    for item in hosts:
        if not isinstance(item, dict) or not isinstance(item.get("ip"), str) or not item["ip"]:
            raise SystemExit("every TARGET_HOSTS entry must contain a non-empty ip")
        entry = {"ip": item["ip"], "user": item.get("user") or default_user}
        password = item.get("pass", item.get("password", ""))
        if password:
            if not isinstance(password, str):
                raise SystemExit("TARGET_HOSTS password must be a string when specified")
            entry["pass"] = password
        result.append(entry)
else:
    result = []
    for item in parse_json_list(raw_ips, "TARGET_IPS"):
        if isinstance(item, str) and item:
            result.append({"ip": item, "user": default_user})
        elif isinstance(item, dict) and isinstance(item.get("ip"), str) and item["ip"]:
            entry = {"ip": item["ip"], "user": item.get("user") or default_user}
            password = item.get("pass", item.get("password", ""))
            if password:
                if not isinstance(password, str):
                    raise SystemExit("TARGET_IPS password must be a string when specified")
                entry["pass"] = password
            result.append(entry)
        else:
            raise SystemExit("every TARGET_IPS entry must be a non-empty string or an object with ip")
    if not result and fallback_ip:
        result.append({"ip": fallback_ip, "user": default_user})

if not result:
    raise SystemExit("TARGET_HOSTS, TARGET_IPS, or TARGET_IP must provide at least one target")
print(json.dumps(result, separators=(",", ":")))
PY
)"

export IMAGE_NAME ARCH_NAME EMS_NAMESPACE NAMESPACE_ARCH EXECUTOR PIPELINE_NAME RUN_DIR RENDER_DIR DEPLOY_IMAGE \
  NAMESPACE RELEASE_NAME CHART_DIR VALUES_FILE ARCH_REQUEST_FILE RESOURCE_MANIFEST \
  NODE_LABELS_FILE TARGET_HOSTS TARGET_NODE_IP_MAP NODE_PORT_MAP ENABLE_PROFILING PROFILING_TIMESTAMP PROFILING_PREFILL_DIR PROFILING_DECODE_DIR PROFILING_MAX_ITERATIONS XDS_URL HELM_BIN KUBECTL_BIN HELM_TIMEOUT \
  XDS_READY_TIMEOUT_SECONDS XDS_READY_POLL_SECONDS HEAD_LOG_ROOT \
  POLL_INTERVAL_SECONDS EMS_LOG_SYNC_INTERVAL_SECONDS EMS_LOG_SOURCE_DIR EMS_LOG_CONTAINER MOCK_HELM_DEPLOY \
  PIPELINE_ENV_FILE TARGET_RUN_DIR TARGET_RENDER_DIR \
  TARGET_PIPELINE_ENV_FILE SSH_PASSWORD MODEL_CACHE_HOST_PATH MOCK_DB \
  XDS_DATABASE_NAME XDS_DATABASE_PORT XDS_DATABASE_USERNAME XDS_DATABASE_PASSWORD \
  TEMPLATE_VARS_JSON \
  AK LOGKEY LOGIN_KEY SWR_PROJECT REGISTRY

write_pipeline_env() {
  local variable
  mkdir -p "$(dirname "$PIPELINE_ENV_FILE")"
  (
    umask 077
    {
      printf '# Generated by pull_render_config.sh. Load before the next pipeline stage.\n'
      for variable in \
        IMAGE_NAME DEPLOY_IMAGE ARCH_NAME EMS_NAMESPACE NAMESPACE_ARCH EXECUTOR PIPELINE_NAME RUN_DIR RENDER_DIR \
        CHART_TEMPLATE_DIR VALUES_TEMPLATE ARCH_FILE CHART_DIR VALUES_FILE ARCH_REQUEST_FILE RESOURCE_MANIFEST NODE_LABELS_FILE \
        NAMESPACE RELEASE_NAME TARGET_HOSTS TARGET_NODE_IP_MAP NODE_PORT_MAP ENABLE_PROFILING PROFILING_TIMESTAMP PROFILING_PREFILL_DIR PROFILING_DECODE_DIR PROFILING_MAX_ITERATIONS TARGET_RUN_DIR TARGET_RENDER_DIR TARGET_PIPELINE_ENV_FILE \
        XDS_URL HELM_BIN KUBECTL_BIN HELM_TIMEOUT XDS_READY_TIMEOUT_SECONDS XDS_READY_POLL_SECONDS HEAD_LOG_ROOT \
        POLL_INTERVAL_SECONDS EMS_LOG_SYNC_INTERVAL_SECONDS EMS_LOG_SOURCE_DIR EMS_LOG_CONTAINER MOCK_HELM_DEPLOY \
        PIPELINE_ENV_FILE MODEL_CACHE_HOST_PATH MOCK_DB \
        XDS_DATABASE_NAME XDS_DATABASE_PORT XDS_DATABASE_USERNAME XDS_DATABASE_PASSWORD; do
        printf 'export %s=%q\n' "$variable" "${!variable}"
      done
    } >"$PIPELINE_ENV_FILE"
  )
}

write_target_pipeline_env() {
  local variable target_chart_dir target_values_file target_arch_request_file
  local target_resource_manifest target_node_labels_file
  target_chart_dir="${TARGET_RENDER_DIR}/xds-cluster"
  target_values_file="${TARGET_RENDER_DIR}/values.rendered.yaml"
  target_arch_request_file="${TARGET_RENDER_DIR}/architecture.request.json"
  target_resource_manifest="${TARGET_RENDER_DIR}/resources.rendered.json"
  target_node_labels_file="${TARGET_RENDER_DIR}/node-labels.json"
  (
    umask 077
    {
      printf '# Generated by pull_render_config.sh for target-host deployment.\n'
      printf 'export RUN_DIR=%q\n' "$TARGET_RUN_DIR"
      printf 'export RENDER_DIR=%q\n' "$TARGET_RENDER_DIR"
      printf 'export CHART_DIR=%q\n' "$target_chart_dir"
      printf 'export VALUES_FILE=%q\n' "$target_values_file"
      printf 'export ARCH_REQUEST_FILE=%q\n' "$target_arch_request_file"
      printf 'export RESOURCE_MANIFEST=%q\n' "$target_resource_manifest"
      printf 'export NODE_LABELS_FILE=%q\n' "$target_node_labels_file"
      printf 'export PIPELINE_ENV_FILE=%q\n' "$TARGET_PIPELINE_ENV_FILE"
      printf 'export TARGET_HOSTS=%q\n' "$TARGET_HOSTS"
      printf 'export TARGET_NODE_IP_MAP=%q\n' "$TARGET_NODE_IP_MAP"
    printf 'export ENABLE_PROFILING=%q\n' "$ENABLE_PROFILING"
    printf 'export PROFILING_TIMESTAMP=%q\n' "$PROFILING_TIMESTAMP"
    printf 'export PROFILING_PREFILL_DIR=%q\n' "$PROFILING_PREFILL_DIR"
    printf 'export PROFILING_DECODE_DIR=%q\n' "$PROFILING_DECODE_DIR"
    printf 'export PROFILING_MAX_ITERATIONS=%q\n' "$PROFILING_MAX_ITERATIONS"
      printf 'export NODE_PORT_MAP=%q\n' "$NODE_PORT_MAP"
      printf 'export ENABLE_PROFILING=%q\n' "$ENABLE_PROFILING"
      printf 'export PROFILING_TIMESTAMP=%q\n' "$PROFILING_TIMESTAMP"
      printf 'export PROFILING_PREFILL_DIR=%q\n' "$PROFILING_PREFILL_DIR"
      printf 'export PROFILING_DECODE_DIR=%q\n' "$PROFILING_DECODE_DIR"
      printf 'export PROFILING_MAX_ITERATIONS=%q\n' "$PROFILING_MAX_ITERATIONS"
      for variable in \
        IMAGE_NAME DEPLOY_IMAGE ARCH_NAME EMS_NAMESPACE NAMESPACE_ARCH EXECUTOR PIPELINE_NAME NAMESPACE RELEASE_NAME \
        XDS_URL HELM_BIN KUBECTL_BIN HELM_TIMEOUT \
        XDS_READY_TIMEOUT_SECONDS XDS_READY_POLL_SECONDS HEAD_LOG_ROOT \
        POLL_INTERVAL_SECONDS EMS_LOG_SYNC_INTERVAL_SECONDS EMS_LOG_SOURCE_DIR EMS_LOG_CONTAINER MOCK_HELM_DEPLOY \
        TARGET_RUN_DIR TARGET_RENDER_DIR TARGET_PIPELINE_ENV_FILE \
        MODEL_CACHE_HOST_PATH MOCK_DB \
        XDS_DATABASE_NAME XDS_DATABASE_PORT XDS_DATABASE_USERNAME XDS_DATABASE_PASSWORD; do
        printf 'export %s=%q\n' "$variable" "${!variable}"
      done
    } >"${RUN_DIR}/.target.pipeline.env"
  )
}

remote_ssh() {
  local target="$1" port="$2" password="$3"
  shift 3
  [[ -n "$password" ]] || password="$SSH_PASSWORD"
  if [[ -n "$password" ]]; then
    SSHPASS="$password" sshpass -e ssh -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 -o LogLevel=ERROR "$target" "$@"
  else
    ssh -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 -o LogLevel=ERROR "$target" "$@"
  fi
}

remote_quote() {
  local value="$1"
  value="${value//\'/\'\"\'\"\'}"
  printf "'%s'" "$value"
}

sync_remote_file() {
  local source="$1" destination="$2" target="$3" port="$4" password="${5:-}"
  local destination_dir
  destination_dir="$(dirname "$destination")"
  cat "$source" | remote_ssh "$target" "$port" "$password" \
    "mkdir -p $(remote_quote "$destination_dir") && umask 077 && cat > $(remote_quote "$destination")"
}

# TARGET_HOSTS describes the SSH endpoint used by the pipeline.  Kubernetes
# schedules against a node's InternalIP, which may be different when the node
# is reached through a jump/NAT address.  Prefer a mapping supplied by the UI,
# and resolve only missing entries from the target node itself.
resolve_target_node_ip_map() {
  local endpoint address port user target node_ip remote_command
  local -a resolved_entries=()
  local -a targets=()

  mapfile -t targets < <(python3 - "$TARGET_HOSTS" "$TARGET_NODE_IP_MAP" <<'PY'
import json
import re
import sys

hosts = json.loads(sys.argv[1])
node_map = json.loads(sys.argv[2])
if not isinstance(hosts, list) or not isinstance(node_map, dict):
    raise SystemExit("TARGET_HOSTS must be an array and TARGET_NODE_IP_MAP must be an object")
for host in hosts:
    endpoint = host.get("ip") if isinstance(host, dict) else None
    if not isinstance(endpoint, str) or not endpoint:
        raise SystemExit("every TARGET_HOSTS entry must contain a non-empty ip")
    if isinstance(node_map.get(endpoint), str) and node_map[endpoint]:
        continue
    match = re.fullmatch(r"([^:]+):(\d+)", endpoint)
    address, port = match.groups() if match else (endpoint, "22")
    password = host.get("pass", host.get("password", "")) or ""
    print(f'{endpoint}\t{host.get("user") or "root"}\t{address}\t{port}\t{password}')
PY
)

  for target_spec in "${targets[@]}"; do
    IFS=$'\t' read -r endpoint user address port password <<<"$target_spec"
    target="${user}@${address}"
    # Kubelet node names are not consistently the Linux hostname (some
    # clusters use InternalIP as metadata.name).  Match this host's local IPv4
    # addresses against the API's Node InternalIP values instead.
    remote_command='local_ips="$(hostname -I)"; kubectl get nodes -o json 2>/dev/null | python3 -c '\''import json,sys; local_ips=set(sys.argv[1].split()); nodes=json.load(sys.stdin).get("items", []); matches=[a.get("address") for n in nodes for a in n.get("status",{}).get("addresses",[]) if a.get("type")=="InternalIP" and a.get("address") in local_ips]; print(matches[0] if matches else "")'\'' "$local_ips"'
    node_ip="$(remote_ssh "$target" "$port" "$password" "$remote_command" || true)"
    node_ip="$(python3 - "$node_ip" <<'PY'
import ipaddress
import re
import sys
for value in re.split(r"\s+", sys.argv[1].strip()):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        continue
    if address.version == 4:
        print(address)
        break
PY
)"
    if [[ -z "$node_ip" ]]; then
      echo "cannot resolve Kubernetes InternalIP for SSH target $endpoint; set nodeIp in the worktable environment" >&2
      return 2
    fi
    echo "[pipeline] resolved SSH target $endpoint to Kubernetes InternalIP $node_ip"
    resolved_entries+=("${endpoint}"$'\t'"${node_ip}")
  done

  ((${#resolved_entries[@]})) || return 0
  TARGET_NODE_IP_MAP="$(python3 - "$TARGET_NODE_IP_MAP" "${resolved_entries[@]}" <<'PY'
import json
import sys

node_map = json.loads(sys.argv[1])
for entry in sys.argv[2:]:
    endpoint, node_ip = entry.split("\t", 1)
    node_map[endpoint] = node_ip
print(json.dumps(node_map, separators=(",", ":"), sort_keys=True))
PY
)"
  export TARGET_NODE_IP_MAP
}

first_target_host() {
  python3 - "$TARGET_HOSTS" <<'PY'
import json
import re
import sys

hosts = json.loads(sys.argv[1])
if not isinstance(hosts, list) or not hosts:
    raise SystemExit("TARGET_HOSTS must be a non-empty JSON array")
host = hosts[0]
if not isinstance(host, dict) or not isinstance(host.get("ip"), str) or not host["ip"]:
    raise SystemExit("every TARGET_HOSTS entry must contain a non-empty ip")
endpoint = host["ip"]
match = re.fullmatch(r"([^:]+):(\d+)", endpoint)
address, port = match.groups() if match else (endpoint, "22")
password = host.get("pass", host.get("password", "")) or ""
print(f'{host.get("user") or "root"}\t{address}\t{port}\t{endpoint}\t{password}')
PY
}

# Use the SSH endpoint supplied in TARGET_HOSTS by default. A mapped InternalIP
# is used only when REMOTE_RENDER_USE_NODE_IP=1 is explicitly requested.
select_target_connection() {
  local user="$1" host="$2" port="$3" endpoint="$4" password="$5"
  local original_host="$host" original_port="$port" mapped_host target
  if [[ "${REMOTE_RENDER_USE_NODE_IP:-0}" == "1" ]]; then
    mapped_host="$(python3 - "$TARGET_NODE_IP_MAP" "$endpoint" <<'PY'
import json
import sys
mapping = json.loads(sys.argv[1])
value = mapping.get(sys.argv[2], "")
print(value if isinstance(value, str) else "")
PY
)"
    if [[ -n "$mapped_host" && "$mapped_host" != "$host" ]]; then
      if [[ "$mapped_host" =~ ^([^:]+):([0-9]+)$ ]]; then
        host="${BASH_REMATCH[1]}"
        port="${BASH_REMATCH[2]}"
      else
        host="$mapped_host"
      fi
      target="${user}@${host}"
      if ! remote_ssh "$target" "$port" "$password" true >/dev/null 2>&1; then
        echo "[ssh] mapped target $endpoint via ${host}:${port} is unreachable; use ${original_host}:${original_port}" >&2
        host="$original_host"
        port="$original_port"
      fi
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$user" "$host" "$port" "$endpoint" "$password"
}

render_target_host() {
  local user host port endpoint password node_ip
  IFS=$'\t' read -r user host port endpoint password <<<"$(first_target_host)"
  select_target_connection "$user" "$host" "$port" "$endpoint" "$password"
}

write_remote_render_environment() {
  local environment_file="$1" target_run_dir="$2" target_render_dir="$3"
  local variable
  mkdir -p "$(dirname "$environment_file")"
  (
    umask 077
    {
      printf '# Generated for remote target rendering.\n'
      # Forward every exported pipeline variable. The explicit values below
      # are appended afterwards because target paths and rendered artifacts
      # intentionally differ from the execution host.
      while IFS= read -r -d '' variable; do
        variable_name="${variable%%=*}"
        variable_value="${variable#*=}"
        [[ "$variable_name" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || continue
        # Keep the target host's login-shell proxy configuration. Forwarding
        # the execution host's loopback proxy (for example 127.0.0.1:8118)
        # makes registry pulls fail on the target.
        [[ "$variable_name" =~ ^[A-Za-z_]*[Pp][Rr][Oo][Xx][Yy]$ ]] && continue
        printf 'export %s=%q\n' "$variable_name" "$variable_value"
      done < <(env -0)
      printf 'export RUN_DIR=%q\n' "$target_run_dir"
      printf 'export RENDER_DIR=%q\n' "$target_render_dir"
      printf 'export SKIP_CONTAINERD_CLEANUP=1\n'
      printf 'export CONTAINER_RUNTIME=ctr\n'
      for variable in \
        IMAGE_NAME DEPLOY_IMAGE TEMPLATE_IMAGE ARCH_NAME EMS_NAMESPACE NAMESPACE NAMESPACE_ARCH DEPLOY_STRATEGY BY arch EXECUTOR PIPELINE_NAME \
        TARGET_HOSTS TARGET_NODE_IP_MAP ENABLE_PROFILING PROFILING_TIMESTAMP PROFILING_PREFILL_DIR PROFILING_DECODE_DIR PROFILING_MAX_ITERATIONS \
        NUM_PREFILL NUM_DECODE PREFILL_GPU DECODE_GPU IMAGE_PULL_SECRETS IMAGE_PULL_SECRET \
        PREFILL_OVERRIDES_JSON DECODE_OVERRIDES_JSON REPLACE_MAP_JSON EQUAL_REPLACE_JSON YAML_REPLACE_JSON \
        TEMPLATE_VARS_JSON COLLECTOR_GATEWAY_URL MAPPED_COLLECTOR_GATEWAY_URL MODEL_CACHE_HOST_PATH MOCK_DB \
        DEPLOY_TEMPLATE_DIR FALLBACK_DEPLOY_TEMPLATE_DIR VALUES_TEMPLATE_SOURCE \
        AK LOGKEY LOGIN_KEY SWR_PROJECT REGISTRY IMAGE_PULL_PROJECT IMAGE_PULL_AK IMAGE_PULL_LOGIN_KEY; do
        printf 'export %s=%q\n' "$variable" "${!variable-}"
      done
    } >"$environment_file"
  )
}

render_on_first_target() {
  local user host port endpoint password target target_script_dir target_env_file
  local remote_command
  IFS=$'\t' read -r user host port endpoint password <<<"$(render_target_host)"
  target="${user}@${host}"
  target_script_dir="${TARGET_RUN_DIR}/scripts"
  target_env_file="${TARGET_RUN_DIR}/remote-render.env"
  echo "[render] target host: pull image and render templates on $endpoint"
  sync_remote_file "$SCRIPT_DIR/pull-image.sh" "${target_script_dir}/pull-image.sh" "$target" "$port" "$password"
  sync_remote_file "$SCRIPT_DIR/render-config.sh" "${target_script_dir}/render-config.sh" "$target" "$port" "$password"
  sync_remote_file "$SCRIPT_DIR/lib/render-lmcache.sh" "${target_script_dir}/lib/render-lmcache.sh" "$target" "$port" "$password"
  local local_env_file
  local_env_file="$(mktemp)"
  write_remote_render_environment "$local_env_file" "$TARGET_RUN_DIR" "$TARGET_RENDER_DIR"
  sync_remote_file "$local_env_file" "$target_env_file" "$target" "$port" "$password"
  rm -f "$local_env_file"

  printf -v remote_command '%s' \
    "set -e; source $(remote_quote "$target_env_file"); bash $(remote_quote "${target_script_dir}/pull-image.sh"); CHART_TEMPLATE_DIR=$(remote_quote "${TARGET_RUN_DIR}/template/xds-cluster") VALUES_TEMPLATE=$(remote_quote "${TARGET_RUN_DIR}/template/values-16Node-je-cpp-bnt3.yaml") ARCH_FILE=$(remote_quote "${TARGET_RUN_DIR}/template/model_arch-lt-je-cpp-bnt3.json") bash $(remote_quote "${target_script_dir}/render-config.sh"); rm -f $(remote_quote "$target_env_file")"
  remote_ssh "$target" "$port" "$password" "bash -lic $(remote_quote "$remote_command")"
}

pull_images_on_all_targets() {
  local endpoint user host port password mapped_host target target_script_dir remote_command image_pull_user pull_project pull_ak pull_login
  local -a target_specs=()
  mapfile -t target_specs < <(python3 - "$TARGET_HOSTS" <<'PY'
import json
import re
import sys
hosts = json.loads(sys.argv[1])
if not isinstance(hosts, list) or not hosts:
    raise SystemExit("TARGET_HOSTS must be a non-empty JSON array")
for item in hosts:
    endpoint = item.get("ip") if isinstance(item, dict) else None
    if not isinstance(endpoint, str) or not endpoint:
        raise SystemExit("every TARGET_HOSTS entry must contain a non-empty ip")
    match = re.fullmatch(r"([^:]+):(\d+)", endpoint)
    host, port = match.groups() if match else (endpoint, "22")
    password = item.get("pass", item.get("password", "")) or ""
    print(f'{endpoint}\t{item.get("user") or "root"}\t{host}\t{port}\t{password}')
PY
  )
  pull_project="${IMAGE_PULL_PROJECT:-${SWR_PROJECT:-cn-southwest-2}}"
  pull_ak="${IMAGE_PULL_AK:-${AK:-}}"
  pull_login="${IMAGE_PULL_LOGIN_KEY:-${LOGKEY:-${LOGIN_KEY:-}}}"
  image_pull_user="${pull_project}@${pull_ak}:${pull_login}"
  for target_spec in "${target_specs[@]}"; do
    IFS=$'\t' read -r endpoint user host port password <<<"$target_spec"
    IFS=$'\t' read -r user host port endpoint password <<<"$(select_target_connection "$user" "$host" "$port" "$endpoint" "$password")"
    [[ -n "$pull_ak" && -n "$pull_login" ]] || {
      echo "AK and LOGIN_KEY are required before pulling images on targets" >&2
      return 2
    }
    target="${user}@${host}"
    target_script_dir="${TARGET_RUN_DIR}/scripts"
    echo "[pull] target $endpoint: upload pull script and pull image with ctr"
    sync_remote_file "$SCRIPT_DIR/pull-image.sh" "${target_script_dir}/pull-image.sh" "$target" "$port" "$password"
    printf -v remote_command '%s' \
      "command -v ctr >/dev/null 2>&1 || { echo '[pull] target has no ctr' >&2; exit 2; }; if [ \"\$(id -u)\" -eq 0 ]; then ctr -n k8s.io images pull --user $(remote_quote "$image_pull_user") $(remote_quote "$IMAGE_NAME"); else sudo ctr -n k8s.io images pull --user $(remote_quote "$image_pull_user") $(remote_quote "$IMAGE_NAME"); fi"
    remote_ssh "$target" "$port" "$password" "bash -lic $(remote_quote "$remote_command")" || {
      echo "[pull] target $endpoint: image pull failed" >&2
      return 1
    }
  done
}

sync_rendered_from_first_target() {
  local user host port endpoint password target target_render_dir_q render_dir_q
  IFS=$'\t' read -r user host port endpoint password <<<"$(render_target_host)"
  target="${user}@${host}"
  printf -v target_render_dir_q '%q' "$TARGET_RENDER_DIR"
  printf -v render_dir_q '%q' "$RENDER_DIR"
  echo "[sync] $endpoint: copy remotely rendered files to $RENDER_DIR"
  mkdir -p "$RENDER_DIR"
  remote_ssh "$target" "$port" "$password" "tar -C $target_render_dir_q -cf - ." | tar -C "$render_dir_q" -xf -
}

sync_rendered_to_targets() {
  local endpoint host port user password target target_run_dir_q target_render_dir_q target_env_q
  local target_env_source="${RUN_DIR}/.target.pipeline.env"
  mapfile -t target_hosts < <(python3 - "$TARGET_HOSTS" <<'PY'
import json
import re
import sys

hosts = json.loads(sys.argv[1])
if not isinstance(hosts, list) or not hosts:
    raise SystemExit("TARGET_HOSTS must be a non-empty JSON array")
for host in hosts:
    if not isinstance(host, dict) or not isinstance(host.get("ip"), str) or not host["ip"]:
        raise SystemExit("every TARGET_HOSTS entry must contain a non-empty ip")
    endpoint = host["ip"]
    match = re.fullmatch(r"([^:]+):(\d+)", endpoint)
    if match:
        address, port = match.groups()
        if not 1 <= int(port) <= 65535:
            raise SystemExit(f"invalid TARGET_HOSTS port: {endpoint}")
    else:
        address, port = endpoint, "22"
    password = host.get("pass", host.get("password", "")) or ""
    print(f'{host.get("user") or "root"}\t{address}\t{port}\t{endpoint}\t{password}')
PY
)

  for target_host in "${target_hosts[@]}"; do
    IFS=$'\t' read -r user host port endpoint password <<<"$target_host"
    target="${user}@${host}"
    printf -v target_run_dir_q '%q' "$TARGET_RUN_DIR"
    printf -v target_render_dir_q '%q' "$TARGET_RENDER_DIR"
    printf -v target_env_q '%q' "$TARGET_PIPELINE_ENV_FILE"
    echo "[sync] $endpoint: copy rendered files to $TARGET_RENDER_DIR"
    tar -C "$RENDER_DIR" -cf - . | remote_ssh "$target" "$port" "$password" "mkdir -p $target_render_dir_q && tar -C $target_render_dir_q -xf -"
    cat "$target_env_source" | remote_ssh "$target" "$port" "$password" "mkdir -p $target_run_dir_q && umask 077 && cat > $target_env_q"
  done
}

resolve_target_node_ip_map
echo "[pipeline] image=$IMAGE_NAME arch=$ARCH_NAME run_dir=$RUN_DIR render_dir=$RENDER_DIR"
pull_images_on_all_targets
render_on_first_target
sync_rendered_from_first_target
# Keep the local pipeline contract pointing at the copied artifacts even
# though template extraction and rendering happened on the target host.
CHART_TEMPLATE_DIR="$RENDER_DIR/xds-cluster"
VALUES_TEMPLATE="$RENDER_DIR/values.rendered.yaml"
ARCH_FILE="$RENDER_DIR/architecture.request.json"
export CHART_TEMPLATE_DIR VALUES_TEMPLATE ARCH_FILE
write_pipeline_env
write_target_pipeline_env
sync_rendered_to_targets

# Rendered files are available on every target before the target image pull.
# This separates execution-host template preparation from target registry
# authentication and keeps a target pull failure from preventing rendering.
PULL_TARGET_IMAGES_ONLY=1 bash "$SCRIPT_DIR/pull-image.sh"

printf 'PIPELINE_ENV_FILE=%s\n' "$PIPELINE_ENV_FILE"
printf 'TARGET_PIPELINE_ENV_FILE=%s\n' "$TARGET_PIPELINE_ENV_FILE"
