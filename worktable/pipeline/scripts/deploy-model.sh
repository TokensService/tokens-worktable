#!/usr/bin/env bash
# Deploy the rendered chart, then register its rendered architecture request.
set -euo pipefail

CHART_DIR="${CHART_DIR:?CHART_DIR is required}"
VALUES_FILE="${VALUES_FILE:?VALUES_FILE is required}"
ARCH_REQUEST_FILE="${ARCH_REQUEST_FILE:?ARCH_REQUEST_FILE is required}"
ARCH_NAME="${ARCH_NAME:?ARCH_NAME is required}"
NAMESPACE="${NAMESPACE:?NAMESPACE is required}"
RELEASE_NAME="${RELEASE_NAME:?RELEASE_NAME is required}"
NODE_LABELS_FILE="${NODE_LABELS_FILE:?NODE_LABELS_FILE is required}"
XDS_URL="${XDS_URL:?XDS_URL is required}"
HELM_BIN="${HELM_BIN:-helm}"
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
HELM_TIMEOUT="${HELM_TIMEOUT:-10m}"
XDS_READY_TIMEOUT_SECONDS="${XDS_READY_TIMEOUT_SECONDS:-1800}"
XDS_READY_POLL_SECONDS="${XDS_READY_POLL_SECONDS:-5}"
HEAD_LOG_ROOT="${HEAD_LOG_ROOT:-./logs}"
HEAD_LOG_DIR="${HEAD_LOG_DIR:-${HEAD_LOG_ROOT}/xds_head_follow_logs_${NAMESPACE}_$(date +%Y%m%d_%H%M%S)}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-5}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ -f "$CHART_DIR/Chart.yaml" ]] || { echo "Chart.yaml not found: $CHART_DIR" >&2; exit 2; }
[[ -f "$VALUES_FILE" ]] || { echo "values file not found: $VALUES_FILE" >&2; exit 2; }
[[ -f "$ARCH_REQUEST_FILE" ]] || { echo "architecture request not found: $ARCH_REQUEST_FILE" >&2; exit 2; }
[[ -f "$NODE_LABELS_FILE" ]] || { echo "node labels file not found: $NODE_LABELS_FILE" >&2; exit 2; }
[[ "$XDS_READY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid XDS_READY_TIMEOUT_SECONDS: $XDS_READY_TIMEOUT_SECONDS" >&2; exit 2; }
[[ "$XDS_READY_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid XDS_READY_POLL_SECONDS: $XDS_READY_POLL_SECONDS" >&2; exit 2; }

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

label_target_nodes
echo "[deploy] helm release=$RELEASE_NAME namespace=$NAMESPACE chart=$CHART_DIR"
"$HELM_BIN" upgrade --install "$RELEASE_NAME" "$CHART_DIR" \
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

echo "[deploy] register architecture=$ARCH_NAME url=$XDS_URL"
curl --noproxy '*' --fail-with-body -sS -X POST "${XDS_URL%/}/models/architectures" \
  -H 'Content-Type: application/json' \
  --data-binary "@$ARCH_REQUEST_FILE"
echo

printf 'CHART_DIR=%s\n' "$CHART_DIR"
printf 'VALUES_FILE=%s\n' "$VALUES_FILE"
printf 'ARCH_REQUEST_FILE=%s\n' "$ARCH_REQUEST_FILE"
printf 'ARCH_NAME=%s\n' "$ARCH_NAME"
printf 'NAMESPACE=%s\n' "$NAMESPACE"
printf 'RELEASE_NAME=%s\n' "$RELEASE_NAME"
printf 'NODE_LABELS_FILE=%s\n' "$NODE_LABELS_FILE"
printf 'XDS_URL=%s\n' "$XDS_URL"
printf 'HEAD_LOG_DIR=%s\n' "$HEAD_LOG_DIR"
