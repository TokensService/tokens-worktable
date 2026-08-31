#!/usr/bin/env bash
# Follow the current Ray head pod and persist logs across head pod recreation.
set -euo pipefail

namespace=${1:-${NAMESPACE:-default}}
log_dir=${2:-${LOG_DIR:-"./logs/xds_head_follow_logs_${namespace}_$(date +%Y%m%d_%H%M%S)"}}
poll_interval_seconds=${POLL_INTERVAL_SECONDS:-5}
kubectl_bin=${KUBECTL_BIN:-kubectl}
last_head=""
follower_pid=""

mkdir -p "$log_dir"
printf '%s\n' "namespace=$namespace" >"$log_dir/metadata"
printf '%s\n' "started_at=$(date -Is)" >>"$log_dir/metadata"

stop_follower() {
  if [[ -n "$follower_pid" ]] && kill -0 "$follower_pid" 2>/dev/null; then
    kill "$follower_pid" 2>/dev/null || true
    wait "$follower_pid" 2>/dev/null || true
  fi
  follower_pid=""
}

trap 'stop_follower; printf "%s\n" "stopped_at=$(date -Is)" >>"$log_dir/metadata"' EXIT INT TERM

while "$kubectl_bin" get namespace "$namespace" >/dev/null 2>&1; do
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
