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
[[ -n "$RUN_DIR" ]] || RUN_DIR="/tmp/${PIPELINE_NAME}-$(date +%Y%m%d_%H%M%S)"
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
  if [[ -n "$NAMESPACE_ARCH" && -n "$EXECUTOR" ]]; then
    NAMESPACE="xds-${NAMESPACE_ARCH}-${EXECUTOR}"
  else
    NAMESPACE="xds-${ARCH_NAME}"
  fi
fi
NAMESPACE="$(normalize_kubernetes_name "$NAMESPACE" 63)"
RELEASE_NAME="${RELEASE_NAME:-}"
contains_unexpanded_placeholder "$RELEASE_NAME" && RELEASE_NAME=""
[[ -n "$RELEASE_NAME" && "$RELEASE_NAME" != "$NAMESPACE" ]] || RELEASE_NAME="xds"
RELEASE_NAME="$(normalize_kubernetes_name "$RELEASE_NAME" 53)"
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
LMCACHE_L2_ENABLED="${LMCACHE_L2_ENABLED:-true}"
LMCACHE_L2_BASE_PATH="${LMCACHE_L2_BASE_PATH:-}"
[[ -n "$LMCACHE_L2_BASE_PATH" ]] || LMCACHE_L2_BASE_PATH="${LMCACHE_L2_HOST_PATH:-/mnt/paas/lmcache/lmcache-l2/shared}"
LMCACHE_L2_MAX_CAPACITY_GB="${LMCACHE_L2_MAX_CAPACITY_GB:-10240}"
LMCACHE_L2_NUM_WORKERS="${LMCACHE_L2_NUM_WORKERS:-64}"
# Platform inputs consumed by render-config.sh: the LMCache sidecar
# switch (default off), the sidecar OTLP tracing switch (default on), and
# its endpoint. An empty endpoint disables the tracing patch as well.
ENABLE_LMCACHE="${ENABLE_LMCACHE:-false}"
ENABLE_LMCACHE_TRACING="${ENABLE_LMCACHE_TRACING:-true}"
LMCACHE_OTLP_ENDPOINT="${LMCACHE_OTLP_ENDPOINT:-http://192.168.0.102:4320}"
# Registry credentials are supplied at invocation time. Keep them in the
# process environment for pull-image.sh only; do not serialize them into either
# pipeline environment file.
AK="${AK:-}"
LOGKEY="${LOGKEY:-${LOGIN_KEY:-}}"
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
  NODE_LABELS_FILE TARGET_HOSTS TARGET_NODE_IP_MAP XDS_URL HELM_BIN KUBECTL_BIN HELM_TIMEOUT \
  XDS_READY_TIMEOUT_SECONDS XDS_READY_POLL_SECONDS HEAD_LOG_ROOT \
  POLL_INTERVAL_SECONDS EMS_LOG_SYNC_INTERVAL_SECONDS EMS_LOG_SOURCE_DIR EMS_LOG_CONTAINER MOCK_HELM_DEPLOY \
  PIPELINE_ENV_FILE TARGET_RUN_DIR TARGET_RENDER_DIR \
  TARGET_PIPELINE_ENV_FILE SSH_PASSWORD MODEL_CACHE_HOST_PATH MOCK_DB \
  XDS_DATABASE_NAME XDS_DATABASE_PORT XDS_DATABASE_USERNAME XDS_DATABASE_PASSWORD \
  LMCACHE_L2_ENABLED LMCACHE_L2_BASE_PATH \
  LMCACHE_L2_MAX_CAPACITY_GB LMCACHE_L2_NUM_WORKERS \
  ENABLE_LMCACHE ENABLE_LMCACHE_TRACING LMCACHE_OTLP_ENDPOINT TEMPLATE_VARS_JSON \
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
        NAMESPACE RELEASE_NAME TARGET_HOSTS TARGET_NODE_IP_MAP TARGET_RUN_DIR TARGET_RENDER_DIR TARGET_PIPELINE_ENV_FILE \
        XDS_URL HELM_BIN KUBECTL_BIN HELM_TIMEOUT XDS_READY_TIMEOUT_SECONDS XDS_READY_POLL_SECONDS HEAD_LOG_ROOT \
        POLL_INTERVAL_SECONDS EMS_LOG_SYNC_INTERVAL_SECONDS EMS_LOG_SOURCE_DIR EMS_LOG_CONTAINER MOCK_HELM_DEPLOY \
        PIPELINE_ENV_FILE MODEL_CACHE_HOST_PATH MOCK_DB \
        XDS_DATABASE_NAME XDS_DATABASE_PORT XDS_DATABASE_USERNAME XDS_DATABASE_PASSWORD \
        LMCACHE_L2_ENABLED LMCACHE_L2_BASE_PATH \
        LMCACHE_L2_MAX_CAPACITY_GB LMCACHE_L2_NUM_WORKERS \
        ENABLE_LMCACHE ENABLE_LMCACHE_TRACING LMCACHE_OTLP_ENDPOINT; do
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
      for variable in \
        IMAGE_NAME DEPLOY_IMAGE ARCH_NAME EMS_NAMESPACE NAMESPACE_ARCH EXECUTOR PIPELINE_NAME NAMESPACE RELEASE_NAME \
        XDS_URL HELM_BIN KUBECTL_BIN HELM_TIMEOUT \
        XDS_READY_TIMEOUT_SECONDS XDS_READY_POLL_SECONDS HEAD_LOG_ROOT \
        POLL_INTERVAL_SECONDS EMS_LOG_SYNC_INTERVAL_SECONDS EMS_LOG_SOURCE_DIR EMS_LOG_CONTAINER MOCK_HELM_DEPLOY \
        TARGET_RUN_DIR TARGET_RENDER_DIR TARGET_PIPELINE_ENV_FILE \
        MODEL_CACHE_HOST_PATH MOCK_DB \
        XDS_DATABASE_NAME XDS_DATABASE_PORT XDS_DATABASE_USERNAME XDS_DATABASE_PASSWORD \
        LMCACHE_L2_ENABLED LMCACHE_L2_BASE_PATH \
        LMCACHE_L2_MAX_CAPACITY_GB LMCACHE_L2_NUM_WORKERS \
        ENABLE_LMCACHE ENABLE_LMCACHE_TRACING LMCACHE_OTLP_ENDPOINT; do
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
bash "$SCRIPT_DIR/pull-image.sh"
# pull-image.sh runs as a child process. Retain the resolved template outputs
# in this orchestration shell so both rendering and pipeline.env use them.
CHART_TEMPLATE_DIR="${CHART_TEMPLATE_DIR:-${RUN_DIR}/template/xds-cluster}"
VALUES_TEMPLATE="${VALUES_TEMPLATE:-${RUN_DIR}/template/values-16Node-je-cpp-bnt3.yaml}"
ARCH_FILE="${ARCH_FILE:-${RUN_DIR}/template/model_arch-lt-je-cpp-bnt3.json}"
export CHART_TEMPLATE_DIR VALUES_TEMPLATE ARCH_FILE
bash "$SCRIPT_DIR/render-config.sh"
write_pipeline_env
write_target_pipeline_env
sync_rendered_to_targets

# Rendered files are available on every target before the target image pull.
# This separates execution-host template preparation from target registry
# authentication and keeps a target pull failure from preventing rendering.
PULL_TARGET_IMAGES_ONLY=1 bash "$SCRIPT_DIR/pull-image.sh"

printf 'PIPELINE_ENV_FILE=%s\n' "$PIPELINE_ENV_FILE"
printf 'TARGET_PIPELINE_ENV_FILE=%s\n' "$TARGET_PIPELINE_ENV_FILE"
