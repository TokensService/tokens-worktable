#!/usr/bin/env bash
# Deploy the rendered chart, then register its rendered architecture request.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ON_TARGET_HOST="${DEPLOY_ON_TARGET_HOST:-0}"
RUN_DIR="${RUN_DIR:-/tmp/op-test-pipeline}"
RENDER_DIR="${RENDER_DIR:-${RUN_DIR}/rendered}"
ARCH_NAME="${ARCH_NAME:-default}"
PIPELINE_NAME="${PIPELINE_NAME:-xds-${ARCH_NAME}}"
NAMESPACE="${NAMESPACE:-xds-${ARCH_NAME}-local}"
RELEASE_NAME="${RELEASE_NAME:-${NAMESPACE}}"
CHART_DIR="${CHART_DIR:-${RENDER_DIR}/xds-cluster}"
VALUES_FILE="${VALUES_FILE:-${RENDER_DIR}/values.rendered.yaml}"
DEPLOY_VALUES_FILE="${DEPLOY_VALUES_FILE:-${RUN_DIR}/values.deploy.yaml}"
ARCH_REQUEST_FILE="${ARCH_REQUEST_FILE:-${RENDER_DIR}/architecture.request.json}"
RESOURCE_MANIFEST="${RESOURCE_MANIFEST:-${RENDER_DIR}/resources.rendered.json}"
NODE_LABELS_FILE="${NODE_LABELS_FILE:-${RENDER_DIR}/node-labels.json}"
TARGET_HOSTS="${TARGET_HOSTS:-[]}"
TARGET_RUN_DIR="${TARGET_RUN_DIR:-/tmp/op-test-pipeline/${PIPELINE_NAME}}"
TARGET_RENDER_DIR="${TARGET_RENDER_DIR:-${TARGET_RUN_DIR}/rendered}"
TARGET_PIPELINE_ENV_FILE="${TARGET_PIPELINE_ENV_FILE:-${TARGET_RUN_DIR}/pipeline.env}"
XDS_URL="${XDS_URL:-}"
XDS_URL_EXPLICIT=false
[[ -n "$XDS_URL" ]] && XDS_URL_EXPLICIT=true
XDS_API_HOST=""
SERVICE_NAME="${SERVICE_NAME:-ray-svc}"
MODEL_NAME="${MODEL_NAME:-$ARCH_NAME}"
MODEL_ENDPOINT="${MODEL_ENDPOINT:-$MODEL_NAME}"
MODEL_VERSION="${MODEL_VERSION:-v1}"
MODEL_PATH_INPUT="${MODEL_PATH:-/home/service/works/models_ssd/GLM-5.2-NVFP4-W4A4-MG39-BNT3/v1}"
MODEL_CONTAINER_ROOT="${MODEL_CONTAINER_ROOT:-/home/service/works/models_ssd}"
MODEL_WEIGHT_NAME="${MODEL_WEIGHT_NAME:-}"
HELM_BIN="${HELM_BIN:-helm}"
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
HELM_TIMEOUT="${HELM_TIMEOUT:-10m}"
RELEASE_CLEANUP_TIMEOUT_SECONDS="${RELEASE_CLEANUP_TIMEOUT_SECONDS:-300}"
RELEASE_CLEANUP_POLL_SECONDS="${RELEASE_CLEANUP_POLL_SECONDS:-5}"
XDS_READY_TIMEOUT_SECONDS="${XDS_READY_TIMEOUT_SECONDS:-1800}"
XDS_READY_POLL_SECONDS="${XDS_READY_POLL_SECONDS:-5}"
TASK_EXECUTOR_READY_TIMEOUT_SECONDS="${TASK_EXECUTOR_READY_TIMEOUT_SECONDS:-900}"
TASK_EXECUTOR_READY_POLL_SECONDS="${TASK_EXECUTOR_READY_POLL_SECONDS:-5}"
SLOT_CONFIG_NAMESPACE="${SLOT_CONFIG_NAMESPACE:-default}"
HEAD_LOG_ROOT="${HEAD_LOG_ROOT:-${RUN_DIR}/logs}"
HEAD_LOG_DIR="${HEAD_LOG_DIR:-${HEAD_LOG_ROOT}/xds_head_follow_logs_${NAMESPACE}_$(date +%Y%m%d_%H%M%S)}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-5}"
NODE_PORT_MAP="${NODE_PORT_MAP:-{\"192.168.31.59\":31000,\"192.168.31.125\":31001,\"192.168.31.18\":31002,\"192.168.31.127\":31003,\"192.168.31.190\":31004,\"192.168.31.104\":31005,\"192.168.31.197\":31007,\"192.168.31.175\":31008,\"192.168.31.17\":31009,\"192.168.31.238\":31010,\"192.168.31.163\":31011,\"192.168.31.70\":31012,\"192.168.31.214\":31013,\"192.168.31.111\":31014,\"192.168.31.65\":31015,\"192.168.31.96\":31016,\"192.168.31.105\":31017,\"192.168.31.89\":31018}}"

resolve_container_model_path() {
  local input="${MODEL_PATH_INPUT%/}" weight_name
  [[ -n "$input" && "$input" != "/" ]] || { echo "MODEL_PATH must identify a model weight directory" >&2; return 2; }

  if [[ -n "$MODEL_WEIGHT_NAME" ]]; then
    weight_name="$MODEL_WEIGHT_NAME"
  else
    weight_name="${input##*/}"
    [[ "$weight_name" == "v1" ]] && weight_name="${input%/*}" && weight_name="${weight_name##*/}"
  fi

  [[ "$weight_name" =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo "MODEL_WEIGHT_NAME must be a single weight directory name: $weight_name" >&2
    return 2
  }
  MODEL_WEIGHT_NAME="$weight_name"
  MODEL_PATH="${MODEL_CONTAINER_ROOT%/}/${MODEL_WEIGHT_NAME}/v1"
}

resolve_container_model_path

remote_quote() {
  printf '%q' "$1"
}

run_remote() {
  local target="$1" port="$2"
  shift 2
  if [[ -n "${REMOTE_SSH_PASSWORD:-}" ]]; then
    SSHPASS="$REMOTE_SSH_PASSWORD" sshpass -e ssh \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR -o ConnectTimeout=30 -p "$port" "$target" "$@"
  else
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR -o ConnectTimeout=30 -p "$port" "$target" "$@"
  fi
}

sync_remote_file() {
  local source="$1" destination="$2" target="$3" port="$4"
  local destination_dir
  destination_dir="$(dirname "$destination")"
  cat "$source" | run_remote "$target" "$port" \
    "mkdir -p $(remote_quote "$destination_dir") && cat > $(remote_quote "$destination")"
}

deploy_from_target_host() {
  local parsed target_ip target_port target_user safe_target_hosts target remote_script_dir remote_script
  local remote_env remote_xds_url remote_head_log_root remote_command

  command -v ssh >/dev/null 2>&1 || { echo "ssh is required on the pipeline execution host" >&2; return 2; }
  parsed="$(python3 - "$TARGET_HOSTS" "${TARGET_PASSWORD:-}" <<'PY'
import json
import sys

try:
    hosts = json.loads(sys.argv[1])
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid TARGET_HOSTS: {error}")
if not isinstance(hosts, list) or not hosts:
    raise SystemExit("TARGET_HOSTS must be a non-empty JSON array")
host = hosts[0]
if not isinstance(host, dict) or not isinstance(host.get("ip"), str) or not host["ip"]:
    raise SystemExit("TARGET_HOSTS[0].ip must be a non-empty string")
endpoint = host["ip"]
import re
match = re.fullmatch(r"([^:]+):(\d+)", endpoint)
if match:
    target_ip, target_port = match.groups()
    if not 1 <= int(target_port) <= 65535:
        raise SystemExit(f"invalid TARGET_HOSTS[0] port: {endpoint}")
else:
    target_ip, target_port = endpoint, "22"
user = host.get("user") or "root"
password = host.get("pass", host.get("password", sys.argv[2]))
if not isinstance(user, str) or not user:
    raise SystemExit("TARGET_HOSTS[0].user must be a string when specified")
if password is None:
    password = ""
if not isinstance(password, str):
    raise SystemExit("TARGET_HOSTS[0].pass must be a string when specified")
safe_hosts = []
for item in hosts:
    if isinstance(item, dict) and isinstance(item.get("ip"), str) and item["ip"]:
        safe_hosts.append({"ip": item["ip"], "user": item.get("user") or "root"})
print(target_ip, target_port, user, password, json.dumps(safe_hosts, separators=(",", ":")), sep="\t")
PY
)"
  IFS=$'\t' read -r target_ip target_port target_user REMOTE_SSH_PASSWORD safe_target_hosts <<<"$parsed"
  target="${target_user}@${target_ip}"
  remote_script_dir="${TARGET_RUN_DIR}/scripts"
  remote_script="${remote_script_dir}/deploy-model.sh"
  remote_xds_url="${XDS_URL:-}"
  remote_head_log_root="${TARGET_RUN_DIR}/logs"
  remote_env="$(mktemp)"

  {
    printf 'export RUN_DIR=%q\n' "$TARGET_RUN_DIR"
    printf 'export RENDER_DIR=%q\n' "$TARGET_RENDER_DIR"
    printf 'export ARCH_NAME=%q\nexport PIPELINE_NAME=%q\n' "$ARCH_NAME" "$PIPELINE_NAME"
    printf 'export NAMESPACE=%q\nexport RELEASE_NAME=%q\n' "$NAMESPACE" "$RELEASE_NAME"
    printf 'export CHART_DIR=%q\n' "${TARGET_RENDER_DIR}/xds-cluster"
    printf 'export VALUES_FILE=%q\n' "${TARGET_RENDER_DIR}/values.rendered.yaml"
    printf 'export DEPLOY_VALUES_FILE=%q\n' "${TARGET_RUN_DIR}/values.deploy.yaml"
    printf 'export ARCH_REQUEST_FILE=%q\n' "${TARGET_RENDER_DIR}/architecture.request.json"
    printf 'export RESOURCE_MANIFEST=%q\n' "${TARGET_RENDER_DIR}/resources.rendered.json"
    printf 'export NODE_LABELS_FILE=%q\n' "${TARGET_RENDER_DIR}/node-labels.json"
    printf 'export TARGET_HOSTS=%q\n' "$safe_target_hosts"
    if [[ -n "$remote_xds_url" ]]; then
      printf 'export XDS_URL=%q\n' "$remote_xds_url"
    fi
    printf 'export SERVICE_NAME=%q\nexport MODEL_NAME=%q\nexport MODEL_ENDPOINT=%q\nexport MODEL_VERSION=%q\nexport MODEL_PATH=%q\n' \
      "$SERVICE_NAME" "$MODEL_NAME" "$MODEL_ENDPOINT" "$MODEL_VERSION" "$MODEL_PATH"
    printf 'export HELM_BIN=%q\nexport KUBECTL_BIN=%q\nexport HELM_TIMEOUT=%q\n' "$HELM_BIN" "$KUBECTL_BIN" "$HELM_TIMEOUT"
    printf 'export RELEASE_CLEANUP_TIMEOUT_SECONDS=%q\nexport RELEASE_CLEANUP_POLL_SECONDS=%q\n' "$RELEASE_CLEANUP_TIMEOUT_SECONDS" "$RELEASE_CLEANUP_POLL_SECONDS"
    printf 'export XDS_READY_TIMEOUT_SECONDS=%q\nexport XDS_READY_POLL_SECONDS=%q\n' "$XDS_READY_TIMEOUT_SECONDS" "$XDS_READY_POLL_SECONDS"
    printf 'export TASK_EXECUTOR_READY_TIMEOUT_SECONDS=%q\nexport TASK_EXECUTOR_READY_POLL_SECONDS=%q\n' "$TASK_EXECUTOR_READY_TIMEOUT_SECONDS" "$TASK_EXECUTOR_READY_POLL_SECONDS"
    printf 'export SLOT_CONFIG_NAMESPACE=%q\nexport HEAD_LOG_ROOT=%q\nexport POLL_INTERVAL_SECONDS=%q\n' "$SLOT_CONFIG_NAMESPACE" "$remote_head_log_root" "$POLL_INTERVAL_SECONDS"
  } >"$remote_env"

  echo "[deploy] execution host delegates deployment to target host: ${target_ip}:${target_port}"
  run_remote "$target" "$target_port" "mkdir -p $(remote_quote "$TARGET_RUN_DIR") $(remote_quote "$remote_script_dir")"
  tar -C "$RENDER_DIR" -cf - . | run_remote "$target" "$target_port" \
    "rm -rf $(remote_quote "$TARGET_RENDER_DIR") && mkdir -p $(remote_quote "$TARGET_RENDER_DIR") && tar -C $(remote_quote "$TARGET_RENDER_DIR") -xf -"
  sync_remote_file "$SCRIPT_DIR/deploy-model.sh" "$remote_script" "$target" "$target_port"
  sync_remote_file "$SCRIPT_DIR/follow-xds-head-logs.sh" "${remote_script_dir}/follow-xds-head-logs.sh" "$target" "$target_port"
  sync_remote_file "$SCRIPT_DIR/register-model.sh" "${remote_script_dir}/register-model.sh" "$target" "$target_port"
  sync_remote_file "$remote_env" "$TARGET_PIPELINE_ENV_FILE" "$target" "$target_port"
  run_remote "$target" "$target_port" "chmod +x $(remote_quote "$remote_script") $(remote_quote "${remote_script_dir}/follow-xds-head-logs.sh") $(remote_quote "${remote_script_dir}/register-model.sh")"

  remote_command="set -e; source $(remote_quote "$TARGET_PIPELINE_ENV_FILE"); export DEPLOY_ON_TARGET_HOST=1; exec bash $(remote_quote "$remote_script")"
  if ! run_remote "$target" "$target_port" "$remote_command"; then
    rm -f "$remote_env"
    return 1
  fi
  rm -f "$remote_env"
  printf 'DEPLOY_EXECUTION_HOST=%s\n' "$target_ip"
}

if [[ "$DEPLOY_ON_TARGET_HOST" != "1" ]]; then
  deploy_from_target_host
  exit $?
fi

[[ -f "$CHART_DIR/Chart.yaml" ]] || { echo "Chart.yaml not found: $CHART_DIR" >&2; exit 2; }
[[ -f "$VALUES_FILE" ]] || { echo "values file not found: $VALUES_FILE" >&2; exit 2; }
[[ -f "$ARCH_REQUEST_FILE" ]] || { echo "architecture request not found: $ARCH_REQUEST_FILE" >&2; exit 2; }
[[ -f "$RESOURCE_MANIFEST" ]] || { echo "resource manifest not found: $RESOURCE_MANIFEST" >&2; exit 2; }
[[ -f "$NODE_LABELS_FILE" ]] || { echo "node labels file not found: $NODE_LABELS_FILE" >&2; exit 2; }
[[ "$XDS_READY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid XDS_READY_TIMEOUT_SECONDS: $XDS_READY_TIMEOUT_SECONDS" >&2; exit 2; }
[[ "$XDS_READY_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid XDS_READY_POLL_SECONDS: $XDS_READY_POLL_SECONDS" >&2; exit 2; }
[[ "$RELEASE_CLEANUP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid RELEASE_CLEANUP_TIMEOUT_SECONDS: $RELEASE_CLEANUP_TIMEOUT_SECONDS" >&2; exit 2; }
[[ "$RELEASE_CLEANUP_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid RELEASE_CLEANUP_POLL_SECONDS: $RELEASE_CLEANUP_POLL_SECONDS" >&2; exit 2; }
[[ "$TASK_EXECUTOR_READY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid TASK_EXECUTOR_READY_TIMEOUT_SECONDS: $TASK_EXECUTOR_READY_TIMEOUT_SECONDS" >&2; exit 2; }
[[ "$TASK_EXECUTOR_READY_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid TASK_EXECUTOR_READY_POLL_SECONDS: $TASK_EXECUTOR_READY_POLL_SECONDS" >&2; exit 2; }

if [[ -z "$XDS_URL" ]]; then
  target_ip="$(python3 - "$NODE_LABELS_FILE" <<'PY'
import json
import sys

try:
    labels = json.load(open(sys.argv[1], encoding="utf-8"))
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid node labels file: {error}")

hosts = labels.get("hosts", [])
if not isinstance(hosts, list) or not hosts:
    raise SystemExit("node labels file must contain at least one target node IP when XDS_URL is unset")
first_host = hosts[0]
if not isinstance(first_host, dict) or not isinstance(first_host.get("ip"), str) or not first_host["ip"]:
    raise SystemExit("node labels file host must contain a non-empty IP when XDS_URL is unset")
print(first_host["ip"])
PY
)"
  XDS_API_HOST="$target_ip"
fi

resolve_xds_url_from_service() {
  local node_port

  [[ "$XDS_URL_EXPLICIT" == false ]] || return 0
  node_port="$("$KUBECTL_BIN" -n "$NAMESPACE" get svc "$SERVICE_NAME" -o json | python3 -c '
import json
import sys

service = json.load(sys.stdin)
for port in service.get("spec", {}).get("ports", []):
    if isinstance(port.get("nodePort"), int):
        print(port["nodePort"])
        break
else:
    raise SystemExit("service does not expose a NodePort")
' 2>/dev/null)" || {
    echo "failed to resolve NodePort from service $SERVICE_NAME" >&2
    return 1
  }
  [[ "$node_port" =~ ^[0-9]+$ ]] || {
    echo "invalid service NodePort: $node_port" >&2
    return 1
  }
  XDS_URL="http://${XDS_API_HOST}:${node_port}/xds/v1"
  echo "[deploy] resolved XDS API URL from $SERVICE_NAME: $XDS_URL"
}

wait_for_xds_api() {
  local deadline response
  deadline=$((SECONDS + XDS_READY_TIMEOUT_SECONDS))
  echo "[deploy] wait for XDS API readiness: ${XDS_URL%/}/models/"

  while (( SECONDS < deadline )); do
    response="$(curl --noproxy '*' -sS --connect-timeout 3 --max-time 5 "${XDS_URL%/}/models/" 2>&1 || true)"
    if [[ "$response" == \[* ]]; then
      echo "[deploy] XDS API is ready"
      return 0
    fi
    echo "[deploy] XDS API not ready: $response"
    sleep "$XDS_READY_POLL_SECONDS"
  done

  echo "[deploy] XDS API readiness timed out after ${XDS_READY_TIMEOUT_SECONDS}s" >&2
  return 1
}

wait_for_task_executors() {
  local deadline expected_groups_output pods_file
  local -a expected_groups task_pods
  expected_groups_output="$(python3 - "$RESOURCE_MANIFEST" <<'PY'
import json
import sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
groups = []
for resource in manifest.get("resources", []):
    group = resource.get("task_executor_group")
    if isinstance(group, str) and group and group not in groups:
        groups.append(group)
if not groups:
    raise SystemExit("resource manifest does not define task_executor_group values")
print(*groups, sep="\n")
PY
 )" || return $?
  mapfile -t expected_groups <<<"$expected_groups_output"
  deadline=$((SECONDS + TASK_EXECUTOR_READY_TIMEOUT_SECONDS))
  pods_file="$(mktemp)"
  echo "[deploy] wait for ${#expected_groups[@]} task executor pods to become Ready"

  while (( SECONDS < deadline )); do
    "$KUBECTL_BIN" -n "$NAMESPACE" get pods \
      -l "ray.io/cluster=${RELEASE_NAME}-kuberay" -o json >"$pods_file" 2>/dev/null || printf '{"items":[]}' >"$pods_file"
    mapfile -t task_pods < <(python3 - "$pods_file" "${expected_groups[@]}" <<'PY'
import json
import sys

try:
    pods = json.load(open(sys.argv[1], encoding="utf-8")).get("items", [])
except (OSError, json.JSONDecodeError):
    pods = []
expected = set(sys.argv[2:])
seen = {}
for pod in pods:
    labels = pod.get("metadata", {}).get("labels", {})
    group = labels.get("ray.io/group")
    name = pod.get("metadata", {}).get("name")
    if group in expected and isinstance(name, str) and name:
        seen[group] = name
for group in sys.argv[2:]:
    if group in seen:
        print(f"pod/{seen[group]}")
PY
)
    if [[ "${#task_pods[@]}" -eq "${#expected_groups[@]}" ]]; then
      local all_ready=true pod
      for pod in "${task_pods[@]}"; do
        if ! "$KUBECTL_BIN" -n "$NAMESPACE" wait --for=condition=Ready "$pod" --timeout=5s >/dev/null 2>&1; then
          all_ready=false
          break
        fi
      done
      if [[ "$all_ready" == true ]]; then
        rm -f "$pods_file"
        echo "[deploy] all task executor pods are Ready"
        return 0
      fi
    fi
    echo "[deploy] task executor pods are not ready: found ${#task_pods[@]}/${#expected_groups[@]}"
    sleep "$TASK_EXECUTOR_READY_POLL_SECONDS"
  done

  "$KUBECTL_BIN" -n "$NAMESPACE" get pods -l "ray.io/cluster=${RELEASE_NAME}-kuberay" -o wide >&2 || true
  rm -f "$pods_file"
  echo "[deploy] task executor readiness timed out after ${TASK_EXECUTOR_READY_TIMEOUT_SECONDS}s" >&2
  return 1
}

prepare_available_node_ports() {
  local services_file port_plan changed
  services_file="$(mktemp)"
  "$KUBECTL_BIN" get svc -A -o json >"$services_file"
  port_plan="$(python3 - "$VALUES_FILE" "$services_file" "$NODE_PORT_MAP" <<'PY'
import json
import sys

import yaml

values_path, services_path, node_port_map_text = sys.argv[1:]
values = yaml.safe_load(open(values_path, encoding="utf-8")) or {}
services = json.load(open(services_path, encoding="utf-8"))
node_port_map = json.loads(node_port_map_text)
if not isinstance(node_port_map, dict) or any(type(port) is not int for port in node_port_map.values()):
    raise SystemExit("NODE_PORT_MAP must be a JSON object with integer ports")
fixed_ports = set(node_port_map.values())

requested = []
def collect(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "nodePort" and isinstance(item, int):
                requested.append(item)
            else:
                collect(item)
    elif isinstance(value, list):
        for item in value:
            collect(item)

collect(values)
used = {
    port.get("nodePort")
    for service in services.get("items", [])
    for port in service.get("spec", {}).get("ports", [])
    if isinstance(port.get("nodePort"), int)
}
plan = []
for port in requested:
    candidate = port
    if candidate in used and candidate in fixed_ports:
        raise SystemExit(f"required NodePort {candidate} is already used by another Service")
    while candidate in used:
        candidate += 10
    if candidate > 32767:
        raise SystemExit(f"no available NodePort after {port}; candidate {candidate} exceeds 32767")
    plan.append({"requested": port, "selected": candidate})
    used.add(candidate)
print(json.dumps(plan, separators=(",", ":")))
PY
)"
  rm -f "$services_file"
  changed="$(python3 - "$port_plan" <<'PY'
import json
import sys

print(str(any(item["requested"] != item["selected"] for item in json.loads(sys.argv[1]))).lower())
PY
)"
  [[ "$changed" == true ]] || return 0

  if [[ "$DEPLOY_VALUES_FILE" != "$VALUES_FILE" ]]; then
    cp "$VALUES_FILE" "$DEPLOY_VALUES_FILE"
  fi
  python3 - "$DEPLOY_VALUES_FILE" "$port_plan" <<'PY'
import json
import sys

import yaml

path, raw_plan = sys.argv[1:]
plan = iter(json.loads(raw_plan))
values = yaml.safe_load(open(path, encoding="utf-8")) or {}

def replace(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "nodePort" and isinstance(item, int):
                value[key] = next(plan)["selected"]
            else:
                replace(item)
    elif isinstance(value, list):
        for item in value:
            replace(item)

replace(values)
with open(path, "w", encoding="utf-8") as stream:
    yaml.safe_dump(values, stream, allow_unicode=True, sort_keys=False)
PY
  VALUES_FILE="$DEPLOY_VALUES_FILE"
  python3 - "$port_plan" <<'PY'
import json
import sys

for item in json.loads(sys.argv[1]):
    if item["requested"] != item["selected"]:
        print(f"[deploy] NodePort {item['requested']} is allocated; back off to {item['selected']}")
PY
}

label_target_nodes() {
  local inventory labels
  inventory="$(mktemp)"
  labels="$(mktemp)"
  trap 'rm -f "$inventory" "$labels"' RETURN
  "$KUBECTL_BIN" get nodes -o json >"$inventory"

  python3 - "$NODE_LABELS_FILE" "$inventory" >"$labels" <<'PY'
import json
import sys

labels_file, inventory_file = sys.argv[1:]
labels = json.load(open(labels_file, encoding="utf-8"))
inventory = json.load(open(inventory_file, encoding="utf-8"))
key = labels["key"]
value = labels["value"]
by_ip = {}
for node in inventory.get("items", []):
    name = node.get("metadata", {}).get("name")
    for address in node.get("status", {}).get("addresses", []):
        if address.get("type") == "InternalIP" and name:
            by_ip[address.get("address")] = name
missing = [host["ip"] for host in labels.get("hosts", []) if host["ip"] not in by_ip]
if missing:
    raise SystemExit("target node IPs do not match Kubernetes InternalIP: " + ", ".join(missing))
for host in labels["hosts"]:
    print(by_ip[host["ip"]], f"{key}={value}", sep="\t")
PY

  while IFS=$'\t' read -r node label; do
    [[ -n "$node" && -n "$label" ]] || continue
    echo "[deploy] label node=$node $label"
    "$KUBECTL_BIN" label node "$node" "$label" --overwrite
  done <"$labels"
}

wait_for_release_cleanup() {
  local deadline selector pending
  local -a selectors
  local -a stale_pods
  selectors=(
    "ray.io/cluster=${RELEASE_NAME}-kuberay"
    "app=frontend-executor,xds-component=frontend"
  )
  for selector in "${selectors[@]}"; do
    mapfile -t stale_pods < <("$KUBECTL_BIN" -n "$NAMESPACE" get pods -l "$selector" -o name 2>/dev/null || true)
    if ((${#stale_pods[@]})); then
      echo "[deploy] force delete ${#stale_pods[@]} stale pods for selector: $selector"
      "$KUBECTL_BIN" -n "$NAMESPACE" delete "${stale_pods[@]}" --grace-period=0 --force --wait=false
    fi
  done

  deadline=$((SECONDS + RELEASE_CLEANUP_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    pending=0
    for selector in "${selectors[@]}"; do
      mapfile -t stale_pods < <("$KUBECTL_BIN" -n "$NAMESPACE" get pods -l "$selector" -o name 2>/dev/null || true)
      pending=$((pending + ${#stale_pods[@]}))
    done
    if ((pending == 0)); then
      echo "[deploy] previous Ray pods are removed"
      return 0
    fi
    echo "[deploy] waiting for $pending stale release pods to disappear"
    sleep "$RELEASE_CLEANUP_POLL_SECONDS"
  done

  for selector in "${selectors[@]}"; do
    "$KUBECTL_BIN" -n "$NAMESPACE" get pods -l "$selector" -o wide >&2 || true
  done
  echo "[deploy] release cleanup timed out after ${RELEASE_CLEANUP_TIMEOUT_SECONDS}s" >&2
  return 1
}

prepare_ctrl_slot_capacity() {
  local ctrl_replicas current_limit existing_limit new_limit holders_json holder_count
  local holder_namespace holder_pod
  local -a target_ips holders

  mapfile -t target_ips < <(python3 - "$NODE_LABELS_FILE" <<'PY'
import json
import sys

labels = json.load(open(sys.argv[1], encoding="utf-8"))
for host in labels.get("hosts", []):
    ip = host.get("ip") if isinstance(host, dict) else None
    if isinstance(ip, str) and ip:
        print(ip)
PY
)

  read -r ctrl_replicas current_limit < <(python3 - "$VALUES_FILE" <<'PY'
import sys
import yaml

values = yaml.safe_load(open(sys.argv[1], encoding="utf-8")) or {}
ctrl = values.get("workerGroups", {}).get("ctrlGroup")
if not isinstance(ctrl, dict):
    print("0 0")
    raise SystemExit
replicas = ctrl.get("minReplicas", ctrl.get("replicas", 0))
limit = ctrl.get("annotations", {}).get("max_count_on_node", 0)
try:
    replicas = int(replicas)
    limit = int(limit)
except (TypeError, ValueError):
    raise SystemExit("ctrlGroup minReplicas and max_count_on_node must be integers")
print(replicas, limit)
PY
)

  ((ctrl_replicas > 0)) || return 0
  existing_limit=0
  for ip in "${target_ips[@]}"; do
    holders_json="$("$KUBECTL_BIN" -n "$SLOT_CONFIG_NAMESPACE" get configmap "ctrlgroup-${ip//./-}-slot-cm" -o json 2>/dev/null || printf '{}')"
    mapfile -t holders < <(python3 - "$holders_json" <<'PY'
import json
import sys

try:
    config_map = json.loads(sys.argv[1])
    holders = json.loads(config_map.get("data", {}).get("holders", "[]"))
except (json.JSONDecodeError, TypeError):
    holders = []
for holder in holders if isinstance(holders, list) else []:
    if isinstance(holder, str) and "/" in holder:
        print(holder)
PY
)
    holder_count=0
    for holder in "${holders[@]}"; do
      holder_namespace="${holder%%/*}"
      holder_pod="${holder#*/}"
      if "$KUBECTL_BIN" -n "$holder_namespace" get pod "$holder_pod" -o name >/dev/null 2>&1; then
        holder_count=$((holder_count + 1))
      fi
    done
    ((holder_count > existing_limit)) && existing_limit=$holder_count
  done

  new_limit=$((existing_limit + ctrl_replicas))
  ((new_limit > current_limit)) || new_limit=$current_limit
  if [[ "$DEPLOY_VALUES_FILE" != "$VALUES_FILE" ]]; then
    cp "$VALUES_FILE" "$DEPLOY_VALUES_FILE"
  fi
  echo "[deploy] set ctrlGroup max_count_on_node: ${current_limit} -> ${new_limit} (active holders=${existing_limit}, requested ctrl pods=${ctrl_replicas})"
  python3 - "$DEPLOY_VALUES_FILE" "$new_limit" <<'PY'
import sys
import yaml

path, limit = sys.argv[1:]
with open(path, encoding="utf-8") as stream:
    values = yaml.safe_load(stream) or {}
annotations = values.setdefault("workerGroups", {}).setdefault("ctrlGroup", {}).setdefault("annotations", {})
annotations["max_count_on_node"] = str(int(limit))
with open(path, "w", encoding="utf-8") as stream:
    yaml.safe_dump(values, stream, allow_unicode=True, sort_keys=False)
PY
  VALUES_FILE="$DEPLOY_VALUES_FILE"
}

label_target_nodes
echo "[deploy] helm release=$RELEASE_NAME namespace=$NAMESPACE chart=$CHART_DIR"
"$HELM_BIN" uninstall "$RELEASE_NAME" --namespace "$NAMESPACE" \
  --wait --timeout "$HELM_TIMEOUT" 2>/dev/null || true
wait_for_release_cleanup
prepare_available_node_ports
prepare_ctrl_slot_capacity
"$HELM_BIN" install "$RELEASE_NAME" "$CHART_DIR" \
  --namespace "$NAMESPACE" --create-namespace --values "$VALUES_FILE" \
  --timeout "$HELM_TIMEOUT"
resolve_xds_url_from_service

mkdir -p "$HEAD_LOG_DIR"
nohup env KUBECTL_BIN="$KUBECTL_BIN" POLL_INTERVAL_SECONDS="$POLL_INTERVAL_SECONDS" \
  "$SCRIPT_DIR/follow-xds-head-logs.sh" "$NAMESPACE" "$HEAD_LOG_DIR" \
  >"$HEAD_LOG_DIR/launcher.log" 2>&1 < /dev/null &
HEAD_LOG_COLLECTOR_PID=$!
printf 'HEAD_LOG_COLLECTOR_PID=%s\nHEAD_LOG_DIR=%s\n' \
  "$HEAD_LOG_COLLECTOR_PID" "$HEAD_LOG_DIR"

wait_for_xds_api
wait_for_task_executors

echo "[deploy] register architecture=$ARCH_NAME url=$XDS_URL"
curl --noproxy '*' --fail-with-body -sS -X POST "${XDS_URL%/}/models/architectures" \
  -H 'Content-Type: application/json' \
  --data-binary "@$ARCH_REQUEST_FILE"
echo

echo "[deploy] register model=$MODEL_NAME path=$MODEL_PATH"
RUN_DIR="$RUN_DIR" \
  RENDER_DIR="$RENDER_DIR" \
  RESOURCE_MANIFEST="$RESOURCE_MANIFEST" \
  ARCH_REQUEST_FILE="$ARCH_REQUEST_FILE" \
  ARCH_NAME="$ARCH_NAME" \
  MODEL_NAME="$MODEL_NAME" \
  MODEL_ENDPOINT="$MODEL_ENDPOINT" \
  MODEL_VERSION="$MODEL_VERSION" \
  MODEL_PATH="$MODEL_PATH" \
  XDS_URL="$XDS_URL" \
  bash "$SCRIPT_DIR/register-model.sh"

printf 'CHART_DIR=%s\n' "$CHART_DIR"
printf 'VALUES_FILE=%s\n' "$VALUES_FILE"
printf 'ARCH_REQUEST_FILE=%s\n' "$ARCH_REQUEST_FILE"
printf 'ARCH_NAME=%s\n' "$ARCH_NAME"
printf 'NAMESPACE=%s\n' "$NAMESPACE"
printf 'RELEASE_NAME=%s\n' "$RELEASE_NAME"
printf 'NODE_LABELS_FILE=%s\n' "$NODE_LABELS_FILE"
printf 'XDS_URL=%s\n' "$XDS_URL"
printf 'SERVICE_NAME=%s\n' "$SERVICE_NAME"
printf 'SERVICE_API=%s\n' "${XDS_URL%/}"
printf 'MODEL_NAME=%s\n' "$MODEL_NAME"
printf 'MODEL=%s\n' "$MODEL_NAME"
printf 'MODEL_ENDPOINT=%s\n' "$MODEL_ENDPOINT"
printf 'MODEL_VERSION=%s\n' "$MODEL_VERSION"
printf 'MODEL_API=%s/models/%s\n' "${XDS_URL%/}" "$MODEL_ENDPOINT"
printf 'MODEL_PATH=%s\n' "$MODEL_PATH"
printf 'HEAD_LOG_DIR=%s\n' "$HEAD_LOG_DIR"
