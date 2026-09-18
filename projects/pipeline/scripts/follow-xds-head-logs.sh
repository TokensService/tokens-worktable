#!/usr/bin/env bash
# Follow the current Ray head pod and persist logs across head pod recreation.
set -euo pipefail

namespace=${1:-${NAMESPACE:-default}}
log_dir=${2:-${LOG_DIR:-"./logs/xds_head_follow_logs_${namespace}_$(date +%Y%m%d_%H%M%S)"}}
poll_interval_seconds=${POLL_INTERVAL_SECONDS:-5}
ems_log_sync_interval_seconds=${EMS_LOG_SYNC_INTERVAL_SECONDS:-30}
ems_log_source_dir=${EMS_LOG_SOURCE_DIR:-/opt/cloud/logs/ems}
ems_log_container=${EMS_LOG_CONTAINER:-ray-worker}
kubectl_bin=${KUBECTL_BIN:-kubectl}
last_head=""
follower_pid=""
next_ems_sync=0
declare -A known_ems_pods=()

[[ "$poll_interval_seconds" =~ ^[1-9][0-9]*$ ]] || { echo "invalid POLL_INTERVAL_SECONDS: $poll_interval_seconds" >&2; exit 2; }
[[ "$ems_log_sync_interval_seconds" =~ ^[1-9][0-9]*$ ]] || { echo "invalid EMS_LOG_SYNC_INTERVAL_SECONDS: $ems_log_sync_interval_seconds" >&2; exit 2; }

mkdir -p "$log_dir"
mkdir -p "$log_dir/ems"
printf '%s\n' "namespace=$namespace" >"$log_dir/metadata"
printf '%s\n' "started_at=$(date -Is)" >>"$log_dir/metadata"
printf '%s\n' "ems_log_source_dir=$ems_log_source_dir" >>"$log_dir/metadata"
printf '%s\n' "ems_log_container=$ems_log_container" >>"$log_dir/metadata"

list_ems_pods() {
  local pods_file status
  pods_file="$(mktemp)"
  if ! "$kubectl_bin" -n "$namespace" get pods -o json >"$pods_file" 2>/dev/null; then
    unlink "$pods_file"
    return 1
  fi
  python3 - "$pods_file" "$ems_log_container" <<'PY'
import json
import sys

pods_file, container_name = sys.argv[1:]
try:
    pods = json.load(open(pods_file, encoding="utf-8")).get("items", [])
except (AttributeError, OSError, json.JSONDecodeError):
    pods = []
for pod in pods:
    metadata = pod.get("metadata", {})
    group = metadata.get("labels", {}).get("ray.io/group", "")
    name = metadata.get("name", "")
    containers = pod.get("spec", {}).get("containers", [])
    container_names = {item.get("name") for item in containers if isinstance(item, dict)}
    if "prefill" in group.lower() and name and container_name in container_names:
        print(name)
PY
  status=$?
  unlink "$pods_file"
  return "$status"
}

sync_ems_logs() {
  local pod pod_log_dir timestamp
  local -a ems_pods=()
  mapfile -t ems_pods < <(list_ems_pods || true)
  for pod in "${ems_pods[@]}"; do
    pod_log_dir="$log_dir/ems/$pod"
    mkdir -p "$pod_log_dir"
    timestamp="$(date -Is)"
    if "$kubectl_bin" -n "$namespace" exec "$pod" -c "$ems_log_container" -- \
        tar -C "$ems_log_source_dir" -cf - . 2>>"$log_dir/ems-sync.log" \
        | tar --no-same-owner --no-same-permissions -C "$pod_log_dir" -xf - 2>>"$log_dir/ems-sync.log"; then
      printf '%s ems_pod=%s status=synced destination=%s\n' "$timestamp" "$pod" "$pod_log_dir" \
        >>"$log_dir/ems-sync.log"
      if [[ -z "${known_ems_pods[$pod]+x}" ]]; then
        known_ems_pods["$pod"]=1
        printf '%s\n' "ems_pod=$pod source=$ems_log_container:$ems_log_source_dir destination=$pod_log_dir" \
          >>"$log_dir/metadata"
      fi
    else
      printf '%s ems_pod=%s status=sync_failed\n' "$timestamp" "$pod" >>"$log_dir/ems-sync.log"
    fi
  done
}

stop_follower() {
  if [[ -n "$follower_pid" ]] && kill -0 "$follower_pid" 2>/dev/null; then
    kill "$follower_pid" 2>/dev/null || true
    wait "$follower_pid" 2>/dev/null || true
  fi
  follower_pid=""
}

trap 'stop_follower; printf "%s\n" "stopped_at=$(date -Is)" >>"$log_dir/metadata"' EXIT INT TERM

while "$kubectl_bin" get namespace "$namespace" >/dev/null 2>&1; do
  if ((SECONDS >= next_ems_sync)); then
    sync_ems_logs
    next_ems_sync=$((SECONDS + ems_log_sync_interval_seconds))
  fi

  head=$("$kubectl_bin" -n "$namespace" get pod -l ray.io/node-type=head \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

  if [[ -z "$head" ]]; then
    sleep "$poll_interval_seconds"
    continue
  fi

  if [[ "$head" != "$last_head" ]] || \
      { [[ -n "$follower_pid" ]] && ! kill -0 "$follower_pid" 2>/dev/null; }; then
    stop_follower
    last_head="$head"
    log_file="$log_dir/${head}.follow.log"
    printf '%s\n' "head=$head started_at=$(date -Is) log_file=$log_file" \
      | tee -a "$log_dir/metadata"
    "$kubectl_bin" -n "$namespace" logs -f "$head" -c ray-head --timestamps \
      >>"$log_file" 2>&1 &
    follower_pid=$!
    printf '%s\n' "$follower_pid" >"$log_dir/follower.pid"
  fi

  sleep "$poll_interval_seconds"
done
