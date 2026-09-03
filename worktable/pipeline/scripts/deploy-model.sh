#!/usr/bin/env bash
# Deploy the rendered chart, then register its rendered architecture request.
set -euo pipefail

RUN_DIR="${RUN_DIR:-/tmp/op-test-pipeline}"
RENDER_DIR="${RENDER_DIR:-${RUN_DIR}/rendered}"
ARCH_NAME="${ARCH_NAME:-default}"
NAMESPACE="${NAMESPACE:-xds-${ARCH_NAME}-local}"
RELEASE_NAME="${RELEASE_NAME:-${NAMESPACE}}"
CHART_DIR="${CHART_DIR:-${RENDER_DIR}/xds-cluster}"
VALUES_FILE="${VALUES_FILE:-${RENDER_DIR}/values.rendered.yaml}"
DEPLOY_VALUES_FILE="${DEPLOY_VALUES_FILE:-${RUN_DIR}/values.deploy.yaml}"
ARCH_REQUEST_FILE="${ARCH_REQUEST_FILE:-${RENDER_DIR}/architecture.request.json}"
RESOURCE_MANIFEST="${RESOURCE_MANIFEST:-${RENDER_DIR}/resources.rendered.json}"
NODE_LABELS_FILE="${NODE_LABELS_FILE:-${RENDER_DIR}/node-labels.json}"
TARGET_HOSTS="${TARGET_HOSTS:-[]}"
XDS_URL="${XDS_URL:-}"
MODEL_NAME="${MODEL_NAME:-$ARCH_NAME}"
MODEL_PATH="${MODEL_PATH:-/home/service/works/models_ssd/GLM-5.2-NVFP4-W4A4-MG39-BNT3/v1}"
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
HEAD_LOG_ROOT="${HEAD_LOG_ROOT:-./logs}"
HEAD_LOG_DIR="${HEAD_LOG_DIR:-${HEAD_LOG_ROOT}/xds_head_follow_logs_${NAMESPACE}_$(date +%Y%m%d_%H%M%S)}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-5}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
  target_ip="$(python3 - "$TARGET_HOSTS" <<'PY'
import json
import sys

try:
    target_hosts = json.loads(sys.argv[1])
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid TARGET_HOSTS: {error}")

if not isinstance(target_hosts, list) or not target_hosts:
    raise SystemExit("TARGET_HOSTS must be a non-empty JSON array when XDS_URL is unset")
first_host = target_hosts[0]
if not isinstance(first_host, dict) or not isinstance(first_host.get("ip"), str) or not first_host["ip"]:
    raise SystemExit("TARGET_HOSTS[0].ip must be a non-empty string when XDS_URL is unset")
print(first_host["ip"])
PY
)"
  XDS_URL="http://${target_ip}:30079/xds/v1"
fi

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

label_target_nodes() {
  local inventory
  inventory="$(mktemp)"
  trap 'rm -f "$inventory"' RETURN
  "$KUBECTL_BIN" get nodes -o json >"$inventory"

  while IFS=$'\t' read -r node label; do
    [[ -n "$node" && -n "$label" ]] || continue
    echo "[deploy] label node=$node $label"
    "$KUBECTL_BIN" label node "$node" "$label" --overwrite
  done < <(python3 - "$NODE_LABELS_FILE" "$inventory" <<'PY'
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
    raise SystemExit("target host IPs do not match Kubernetes InternalIP: " + ", ".join(missing))
for host in labels["hosts"]:
    print(by_ip[host["ip"]], f"{key}={value}", sep="\t")
PY
)
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

  mapfile -t target_ips < <(python3 - "$TARGET_HOSTS" <<'PY'
import json
import sys

hosts = json.loads(sys.argv[1])
for host in hosts:
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
prepare_ctrl_slot_capacity
"$HELM_BIN" install "$RELEASE_NAME" "$CHART_DIR" \
  --namespace "$NAMESPACE" --create-namespace --values "$VALUES_FILE" \
  --timeout "$HELM_TIMEOUT"

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
printf 'MODEL_NAME=%s\n' "$MODEL_NAME"
printf 'MODEL_PATH=%s\n' "$MODEL_PATH"
printf 'HEAD_LOG_DIR=%s\n' "$HEAD_LOG_DIR"
