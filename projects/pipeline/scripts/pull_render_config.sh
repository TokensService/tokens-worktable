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
# 架构名优先使用流水线 arch_name，其次 DEPLOY_STRATEGY；兼容旧 ARCH_NAME。
ARCH_NAME="${arch_name:-${DEPLOY_STRATEGY:-${ARCH_NAME:-default}}}"
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
# When both are supplied by the environment, use the requested architecture
# and executor in the namespace. Keep the established ARCH_NAME fallback for
# existing callers that omit either value.
NAMESPACE_ARCH="${arch:-}"
EXECUTOR="${EXECUTOR:-}"
NAMESPACE="${NAMESPACE:-}"
contains_unexpanded_placeholder "$NAMESPACE" && NAMESPACE=""
if [[ -z "$NAMESPACE" ]]; then
  if [[ -n "$NAMESPACE_ARCH" && -n "$EXECUTOR" ]]; then
    NAMESPACE="xds-${NAMESPACE_ARCH}-${EXECUTOR}-${IMAGE_TAG}"
  else
    NAMESPACE="xds-${ARCH_NAME}-${IMAGE_TAG}"
  fi
fi
NAMESPACE="$(normalize_kubernetes_name "$NAMESPACE" 63)"
RELEASE_NAME="${RELEASE_NAME:-}"
contains_unexpanded_placeholder "$RELEASE_NAME" && RELEASE_NAME=""
[[ -n "$RELEASE_NAME" ]] || RELEASE_NAME="$NAMESPACE"
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
PIPELINE_ENV_FILE="${PIPELINE_ENV_FILE:-}"
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
        result.append({"ip": item["ip"], "user": item.get("user") or default_user})
else:
    result = []
    for item in parse_json_list(raw_ips, "TARGET_IPS"):
        if isinstance(item, str) and item:
            result.append({"ip": item, "user": default_user})
        elif isinstance(item, dict) and isinstance(item.get("ip"), str) and item["ip"]:
            result.append({"ip": item["ip"], "user": item.get("user") or default_user})
        else:
            raise SystemExit("every TARGET_IPS entry must be a non-empty string or an object with ip")
    if not result and fallback_ip:
        result.append({"ip": fallback_ip, "user": default_user})

if not result:
    raise SystemExit("TARGET_HOSTS, TARGET_IPS, or TARGET_IP must provide at least one target")
print(json.dumps(result, separators=(",", ":")))
PY
)"

export IMAGE_NAME ARCH_NAME NAMESPACE_ARCH EXECUTOR PIPELINE_NAME RUN_DIR RENDER_DIR DEPLOY_IMAGE \
  NAMESPACE RELEASE_NAME CHART_DIR VALUES_FILE ARCH_REQUEST_FILE RESOURCE_MANIFEST \
  NODE_LABELS_FILE TARGET_HOSTS XDS_URL HELM_BIN KUBECTL_BIN HELM_TIMEOUT \
  XDS_READY_TIMEOUT_SECONDS XDS_READY_POLL_SECONDS HEAD_LOG_ROOT \
  POLL_INTERVAL_SECONDS PIPELINE_ENV_FILE TARGET_RUN_DIR TARGET_RENDER_DIR \
  TARGET_PIPELINE_ENV_FILE SSH_PASSWORD

write_pipeline_env() {
  local variable
  mkdir -p "$(dirname "$PIPELINE_ENV_FILE")"
  (
    umask 077
    {
      printf '# Generated by pull_render_config.sh. Load before the next pipeline stage.\n'
      for variable in \
        IMAGE_NAME DEPLOY_IMAGE ARCH_NAME NAMESPACE_ARCH EXECUTOR PIPELINE_NAME RUN_DIR RENDER_DIR \
        CHART_DIR VALUES_FILE ARCH_REQUEST_FILE RESOURCE_MANIFEST NODE_LABELS_FILE \
        NAMESPACE RELEASE_NAME TARGET_HOSTS XDS_URL HELM_BIN KUBECTL_BIN HELM_TIMEOUT \
        XDS_READY_TIMEOUT_SECONDS XDS_READY_POLL_SECONDS HEAD_LOG_ROOT \
        POLL_INTERVAL_SECONDS PIPELINE_ENV_FILE; do
        printf 'export %s=%q\n' "$variable" "${!variable}"
      done
    } >"$PIPELINE_ENV_FILE"
  )
}

write_target_pipeline_env() {
  local variable target_chart_dir target_values_file target_arch_request_file
  local target_resource_manifest target_node_labels_file safe_target_hosts
  target_chart_dir="${TARGET_RENDER_DIR}/xds-cluster"
  target_values_file="${TARGET_RENDER_DIR}/values.rendered.yaml"
  target_arch_request_file="${TARGET_RENDER_DIR}/architecture.request.json"
  target_resource_manifest="${TARGET_RENDER_DIR}/resources.rendered.json"
  target_node_labels_file="${TARGET_RENDER_DIR}/node-labels.json"
  safe_target_hosts="$(python3 - "$TARGET_HOSTS" <<'PY'
import json
import re
import sys

hosts = json.loads(sys.argv[1])
if not isinstance(hosts, list):
    raise SystemExit("TARGET_HOSTS must be a JSON array")
safe_hosts = []
for host in hosts:
    if not isinstance(host, dict) or not isinstance(host.get("ip"), str) or not host["ip"]:
        raise SystemExit("every TARGET_HOSTS entry must contain a non-empty ip")
    safe_hosts.append({"ip": host["ip"], "user": host.get("user") or "root"})
print(json.dumps(safe_hosts, separators=(",", ":")))
PY
)"

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
      printf 'export TARGET_HOSTS=%q\n' "$safe_target_hosts"
      for variable in \
        IMAGE_NAME DEPLOY_IMAGE ARCH_NAME NAMESPACE_ARCH EXECUTOR PIPELINE_NAME NAMESPACE RELEASE_NAME \
        XDS_URL HELM_BIN KUBECTL_BIN HELM_TIMEOUT \
        XDS_READY_TIMEOUT_SECONDS XDS_READY_POLL_SECONDS HEAD_LOG_ROOT \
        POLL_INTERVAL_SECONDS TARGET_RUN_DIR TARGET_RENDER_DIR TARGET_PIPELINE_ENV_FILE; do
        printf 'export %s=%q\n' "$variable" "${!variable}"
      done
    } >"${RUN_DIR}/.target.pipeline.env"
  )
}

remote_ssh() {
  local target="$1" port="$2"
  shift 2
  if [[ -n "$SSH_PASSWORD" ]]; then
    SSHPASS="$SSH_PASSWORD" sshpass -e ssh -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 -o LogLevel=ERROR "$target" "$@"
  else
    ssh -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 -o LogLevel=ERROR "$target" "$@"
  fi
}

sync_rendered_to_targets() {
  local endpoint host port user target target_run_dir_q target_render_dir_q target_env_q
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
    print(f'{host.get("user") or "root"}\t{address}\t{port}\t{endpoint}')
PY
)

  for target_host in "${target_hosts[@]}"; do
    IFS=$'\t' read -r user host port endpoint <<<"$target_host"
    target="${user}@${host}"
    printf -v target_run_dir_q '%q' "$TARGET_RUN_DIR"
    printf -v target_render_dir_q '%q' "$TARGET_RENDER_DIR"
    printf -v target_env_q '%q' "$TARGET_PIPELINE_ENV_FILE"
    echo "[sync] $endpoint: copy rendered files to $TARGET_RENDER_DIR"
    tar -C "$RENDER_DIR" -cf - . | remote_ssh "$target" "$port" "mkdir -p $target_render_dir_q && tar -C $target_render_dir_q -xf -"
    cat "$target_env_source" | remote_ssh "$target" "$port" "mkdir -p $target_run_dir_q && umask 077 && cat > $target_env_q"
  done
}

echo "[pipeline] image=$IMAGE_NAME arch=$ARCH_NAME run_dir=$RUN_DIR render_dir=$RENDER_DIR"
bash "$SCRIPT_DIR/pull-image.sh"
bash "$SCRIPT_DIR/render-config.sh"
write_pipeline_env
write_target_pipeline_env
sync_rendered_to_targets
printf 'PIPELINE_ENV_FILE=%s\n' "$PIPELINE_ENV_FILE"
printf 'TARGET_PIPELINE_ENV_FILE=%s\n' "$TARGET_PIPELINE_ENV_FILE"
