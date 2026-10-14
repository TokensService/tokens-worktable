#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { printf '[profiling][%s] %s\n' "$(date '+%F %T')" "$*"; }
PROFILING_VERBOSE="${PROFILING_VERBOSE:-true}"
traffic_pid=""
request_body_file="$(mktemp /tmp/profiling-response.XXXXXX)"
request_header_file="$(mktemp /tmp/profiling-headers.XXXXXX)"
traffic_log_file="${PROFILING_TRAFFIC_LOG_FILE:-/tmp/native-vllm-traffic.log}"
cleanup_files() {
  if [[ -n "$traffic_pid" ]] && kill -0 "$traffic_pid" 2>/dev/null; then
    kill "$traffic_pid" 2>/dev/null || true
    wait "$traffic_pid" 2>/dev/null || true
  fi
  rm -f "$request_body_file" "$request_header_file" "${request_body_file}.meta"
}
trap cleanup_files EXIT
# Start torch profiling through XDS and optionally generate self-test traffic.
PROFILING_URL="${PROFILING_URL:-${SERVICE_API:-${XDS_URL:-}}}"
if [[ -z "$PROFILING_URL" ]]; then
  host="${PROFILING_API_HOST:-${XDS_API_HOST:-}}"
  port="${PROFILING_API_PORT:-${XDS_API_PORT:-}}"
  [[ -n "$host" && -n "$port" ]] || { echo 'set PROFILING_URL, SERVICE_API, XDS_URL, or PROFILING_API_HOST/PROFILING_API_PORT' >&2; exit 2; }
  PROFILING_URL="http://${host}:${port}/xds/v1"
fi
# deploy-model.sh may export XDS_URL with /chat/completions; profiling uses the API root.
PROFILING_URL="${PROFILING_URL%/}"
PROFILING_URL="${PROFILING_URL%/chat/completions}"
PROFILING_PARAMS="${PROFILING_PARAMS:-start 10}"
PROFILING_START_DELAY_SECONDS="${PROFILING_START_DELAY_SECONDS:-45}"
PROFILING_FILTER="${PROFILING_FILTER:-}"
PROFILING_SELF_TEST="${PROFILING_SELF_TEST:-false}"
if [[ -z "${PROFILING_MODEL_ENDPOINT:-}" ]]; then
  PROFILING_MODEL_ENDPOINT="${MODEL_ENDPOINT:-${MODEL_NAME:-${MODEL:-}}}"
fi
PROFILING_INTERVAL_SECONDS="${PROFILING_INTERVAL_SECONDS:-0.5}"
PROFILING_MAX_REQUESTS="${PROFILING_MAX_REQUESTS:-0}"
PROFILING_CONNECT_TIMEOUT_SECONDS="${PROFILING_CONNECT_TIMEOUT_SECONDS:-5}"
PROFILING_REQUEST_TIMEOUT_SECONDS="${PROFILING_REQUEST_TIMEOUT_SECONDS:-180}"
PROFILING_RETRIES="${PROFILING_RETRIES:-0}"
PROFILING_COLLECT="${PROFILING_COLLECT:-true}"
PROFILING_NAMESPACE="${PROFILING_NAMESPACE:-${NAMESPACE:-}}"
# Use a stable, easy-to-find default. Callers can still override this with
# PROFILING_OUTPUT_DIR when several captures must be kept separately.
PROFILING_OUTPUT_DIR="${PROFILING_OUTPUT_DIR:-/tmp/glm-profiling}"
PROFILING_COLLECT_WAIT_SECONDS="${PROFILING_COLLECT_WAIT_SECONDS:-15}"
PROFILING_POD_REGEX="${PROFILING_POD_REGEX:-prefill|decode}"
PROFILING_POD_CONTAINER="${PROFILING_POD_CONTAINER:-ray-worker}"
PROFILING_KUBECTL_BIN="${PROFILING_KUBECTL_BIN:-kubectl}"
PROFILING_TRAFFIC_ENABLED="${PROFILING_TRAFFIC_ENABLED:-true}"
PROFILING_TRAFFIC_DURATION_SECONDS="${PROFILING_TRAFFIC_DURATION_SECONDS:-120}"
PROFILING_TRAFFIC_QPS="${PROFILING_TRAFFIC_QPS:-10}"
PROFILING_TRAFFIC_CONCURRENCY="${PROFILING_TRAFFIC_CONCURRENCY:-0}"
PROFILING_TRAFFIC_MAX_TOKENS="${PROFILING_TRAFFIC_MAX_TOKENS:-1}"
PROFILING_TRAFFIC_PROMPT_REPETITIONS="${PROFILING_TRAFFIC_PROMPT_REPETITIONS:-79988}"
PROFILING_TRAFFIC_URL="${PROFILING_TRAFFIC_URL:-}"
PROFILING_TRAFFIC_MODEL="${PROFILING_TRAFFIC_MODEL:-}"
# Profiling endpoints are RFC1918 addresses. Do not send them through the
# workstation's HTTP proxy, which can hang and eventually produce curl 52.
CURL_NO_PROXY_ARGS=(--noproxy '*')
case "${PROFILING_SELF_TEST,,}" in true|false) ;; *) echo 'PROFILING_SELF_TEST must be true or false' >&2; exit 2 ;; esac
case "${PROFILING_TRAFFIC_ENABLED,,}" in true|false) ;; *) echo 'PROFILING_TRAFFIC_ENABLED must be true or false' >&2; exit 2 ;; esac
[[ "$PROFILING_MAX_REQUESTS" =~ ^[0-9]+$ ]] || { echo 'PROFILING_MAX_REQUESTS must be non-negative' >&2; exit 2; }
for value_name in PROFILING_CONNECT_TIMEOUT_SECONDS PROFILING_REQUEST_TIMEOUT_SECONDS; do
  value="${!value_name}"; [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "$value_name must be a positive integer" >&2; exit 2; }
done
[[ "$PROFILING_RETRIES" =~ ^[0-9]+$ ]] || { echo "PROFILING_RETRIES must be non-negative" >&2; exit 2; }
[[ "$PROFILING_START_DELAY_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo 'PROFILING_START_DELAY_SECONDS must be a non-negative number' >&2; exit 2; }
[[ "${PROFILING_SELF_TEST,,}" == false || -n "$PROFILING_MODEL_ENDPOINT" ]] || { echo 'PROFILING_MODEL_ENDPOINT is required for self-test' >&2; exit 2; }
case "${PROFILING_COLLECT,,}" in true|false) ;; *) echo 'PROFILING_COLLECT must be true or false' >&2; exit 2 ;; esac
[[ "$PROFILING_COLLECT_WAIT_SECONDS" =~ ^[0-9]+$ ]] || { echo 'PROFILING_COLLECT_WAIT_SECONDS must be non-negative' >&2; exit 2; }
[[ "$PROFILING_TRAFFIC_DURATION_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo 'PROFILING_TRAFFIC_DURATION_SECONDS must be positive' >&2; exit 2; }
[[ "$PROFILING_TRAFFIC_CONCURRENCY" =~ ^[0-9]+$ ]] || { echo 'PROFILING_TRAFFIC_CONCURRENCY must be non-negative (0 means unlimited)' >&2; exit 2; }
[[ "$PROFILING_TRAFFIC_MAX_TOKENS" =~ ^[1-9][0-9]*$ ]] || { echo 'PROFILING_TRAFFIC_MAX_TOKENS must be positive' >&2; exit 2; }
[[ "$PROFILING_TRAFFIC_PROMPT_REPETITIONS" =~ ^[1-9][0-9]*$ ]] || { echo 'PROFILING_TRAFFIC_PROMPT_REPETITIONS must be positive' >&2; exit 2; }
base="${PROFILING_URL%/}"
[[ -n "$PROFILING_TRAFFIC_URL" ]] || PROFILING_TRAFFIC_URL="${base}/chat/completions"
[[ -n "$PROFILING_TRAFFIC_MODEL" ]] || PROFILING_TRAFFIC_MODEL="${PROFILING_MODEL_ENDPOINT:-}"
log "resolved endpoint=${base}"
log "model_endpoint=${PROFILING_MODEL_ENDPOINT:-<unset>} self_test=${PROFILING_SELF_TEST,,} traffic=${PROFILING_TRAFFIC_ENABLED,,} traffic_qps=${PROFILING_TRAFFIC_QPS} traffic_concurrency=${PROFILING_TRAFFIC_CONCURRENCY} traffic_duration=${PROFILING_TRAFFIC_DURATION_SECONDS}s start_delay=${PROFILING_START_DELAY_SECONDS}s connect_timeout=${PROFILING_CONNECT_TIMEOUT_SECONDS}s request_timeout=${PROFILING_REQUEST_TIMEOUT_SECONDS}s retries=${PROFILING_RETRIES}"
start_traffic() {
  [[ "${PROFILING_SELF_TEST,,}" == true && "${PROFILING_TRAFFIC_ENABLED,,}" == true ]] || return 0
  [[ -n "$PROFILING_TRAFFIC_MODEL" ]] || { log "PROFILING_TRAFFIC_MODEL or PROFILING_MODEL_ENDPOINT is required"; return 2; }
  log "starting stable traffic: url=${PROFILING_TRAFFIC_URL} model=${PROFILING_TRAFFIC_MODEL} qps=${PROFILING_TRAFFIC_QPS} concurrency=${PROFILING_TRAFFIC_CONCURRENCY} duration=${PROFILING_TRAFFIC_DURATION_SECONDS}s"
  mkdir -p "$PROFILING_OUTPUT_DIR"
  : >"$traffic_log_file"
  VLLM_URL="$PROFILING_TRAFFIC_URL" \
    MODEL_NAME="$PROFILING_TRAFFIC_MODEL" MODEL_ENDPOINT="$PROFILING_MODEL_ENDPOINT" \
    QPS="$PROFILING_TRAFFIC_QPS" CONCURRENCY="$PROFILING_TRAFFIC_CONCURRENCY" \
    DURATION_SECONDS="$PROFILING_TRAFFIC_DURATION_SECONDS" MAX_TOKENS="$PROFILING_TRAFFIC_MAX_TOKENS" \
    PROMPT_REPETITIONS="$PROFILING_TRAFFIC_PROMPT_REPETITIONS" \
    OUTPUT_CSV="${PROFILING_TRAFFIC_CSV:-${PROFILING_OUTPUT_DIR}/native-vllm-traffic.csv}" \
    python3 "$SCRIPT_DIR/native_vllm_traffic.py" >"$traffic_log_file" 2>&1 &
  traffic_pid=$!
  log "traffic pid=${traffic_pid} log=${traffic_log_file}"
}
start_traffic
if [[ ! "$PROFILING_START_DELAY_SECONDS" =~ ^0+([.]0+)?$ ]]; then
  log "waiting ${PROFILING_START_DELAY_SECONDS}s before profiling request"
  sleep "$PROFILING_START_DELAY_SECONDS"
fi
log "starting torch profiling: GET ${base}/OM/diagnose/get params=${PROFILING_PARAMS} filter=${PROFILING_FILTER:-<empty>}"
set +e
curl "${CURL_NO_PROXY_ARGS[@]}" --silent --show-error --connect-timeout "$PROFILING_CONNECT_TIMEOUT_SECONDS" --max-time "$PROFILING_REQUEST_TIMEOUT_SECONDS" \
  --retry "$PROFILING_RETRIES" --retry-delay 1 --get "${base}/OM/diagnose/get" \
  --dump-header "$request_header_file" --output "$request_body_file" \
  --write-out '%{http_code} %{time_total}' \
  --data-urlencode 'cmd=set_profiling' --data-urlencode "params=${PROFILING_PARAMS}" --data-urlencode "filter=${PROFILING_FILTER}" >"${request_body_file}.meta"
curl_rc=$?
set -e
curl_meta="$(cat "${request_body_file}.meta" 2>/dev/null || true)"
http_code="${curl_meta%% *}"; curl_time="${curl_meta#* }"
log "profiling response: curl_rc=${curl_rc} http_code=${http_code:-000} time=${curl_time:-unknown}s"
if [[ -s "$request_header_file" ]]; then log "response headers: $(tr '\r\n' ' ' < "$request_header_file" | head -c 1000)"; fi
if [[ -s "$request_body_file" ]]; then log "response body: $(head -c 2000 "$request_body_file")"; else log "response body: <empty>"; fi
if (( curl_rc != 0 )); then
  log "profiling request failed; endpoint may be unreachable, closed the connection, or rejected the request"
  exit "$curl_rc"
fi
if [[ "$http_code" != 2* && "$http_code" != 3* ]]; then
  log "profiling request returned non-success HTTP status"
  exit 1
fi
collect_profiling_files() {
  [[ "${PROFILING_COLLECT,,}" == true ]] || { log "profiling file collection disabled"; return 0; }
  [[ -n "$PROFILING_NAMESPACE" ]] || { log "skip file collection: set PROFILING_NAMESPACE or NAMESPACE"; return 0; }
  command -v "$PROFILING_KUBECTL_BIN" >/dev/null 2>&1 || { log "skip file collection: kubectl not found ($PROFILING_KUBECTL_BIN)"; return 0; }
  mkdir -p "$PROFILING_OUTPUT_DIR"
  log "waiting ${PROFILING_COLLECT_WAIT_SECONDS}s for profiling files"
  sleep "$PROFILING_COLLECT_WAIT_SECONDS"
  mapfile -t pods < <("$PROFILING_KUBECTL_BIN" get pods -n "$PROFILING_NAMESPACE" -o name 2>/dev/null | grep -E "$PROFILING_POD_REGEX" || true)
  [[ ${#pods[@]} -gt 0 ]] || { log "no profiling pods found in namespace=$PROFILING_NAMESPACE"; return 1; }
  local pod dest
  for pod in "${pods[@]}"; do
    pod="${pod#pod/}"; dest="$PROFILING_OUTPUT_DIR/$pod"; mkdir -p "$dest"
    log "collecting pod=$pod container=$PROFILING_POD_CONTAINER source=/home/service/works/models_ssd/profile"
    if "$PROFILING_KUBECTL_BIN" cp -n "$PROFILING_NAMESPACE" -c "$PROFILING_POD_CONTAINER" "$pod:/home/service/works/models_ssd/profile" "$dest" >/dev/null 2>&1; then
      find "$dest" -type f -printf '[profiling] %p (%s bytes)\n' 2>/dev/null || true
    else
      log "WARN failed to collect pod=$pod"
    fi
  done
  log "profiling files saved under $PROFILING_OUTPUT_DIR"
}

if [[ -n "$traffic_pid" ]]; then
  log "waiting for traffic to finish before collecting profiling files"
  set +e
  wait "$traffic_pid"
  traffic_rc=$?
  set -e
  traffic_pid=""
  tail -n 20 "$traffic_log_file" 2>/dev/null || true
  (( traffic_rc == 0 )) || { log "traffic exited with status $traffic_rc"; exit "$traffic_rc"; }
elif [[ "${PROFILING_SELF_TEST,,}" != true ]]; then
  collect_profiling_files
  exit 0
else
  i=0
  while [[ "$PROFILING_MAX_REQUESTS" == 0 || "$i" -lt "$PROFILING_MAX_REQUESTS" ]]; do
    i=$((i + 1)); nonce="$(date +%s%N)-$RANDOM-$i"
    body="$(python3 - "$PROFILING_MODEL_ENDPOINT" "$nonce" <<'PY'
import json,sys
model,nonce=sys.argv[1:]
content=f"请求编号 {nonce}。请详细解释菠萝和凤梨的区别，包括植物学分类、商品叫法、口感、产地、挑选方法和食用方式。为了测试 prefill，请先完整阅读这段唯一文本：" + " ".join([nonce]*10)
print(json.dumps({'model':model,'messages':[{'role':'user','content':content}],'max_tokens':10},ensure_ascii=False))
PY
)"
    log "self-test request ${i}: POST ${base}/chat/completions nonce=${nonce}"
    set +e
    curl "${CURL_NO_PROXY_ARGS[@]}" --silent --show-error --connect-timeout "$PROFILING_CONNECT_TIMEOUT_SECONDS" --max-time "$PROFILING_REQUEST_TIMEOUT_SECONDS" \
      "${base}/chat/completions" -H 'Content-Type: application/json' -H "model_endpoint: ${PROFILING_MODEL_ENDPOINT}" -d "$body" \
      --dump-header "$request_header_file" --output "$request_body_file" \
      --write-out '%{http_code} %{time_total}' >"${request_body_file}.meta"
    curl_rc=$?
    set -e
    curl_meta="$(cat "${request_body_file}.meta" 2>/dev/null || true)"
    http_code="${curl_meta%% *}"; curl_time="${curl_meta#* }"
    log "self-test response ${i}: curl_rc=${curl_rc} http_code=${http_code:-000} time=${curl_time:-unknown}s body=$(head -c 1000 "$request_body_file")"
    (( curl_rc == 0 )) || { log "self-test request failed"; exit "$curl_rc"; }
    printf '\n==========request finish %s==========\n' "$nonce"
    sleep "$PROFILING_INTERVAL_SECONDS"
  done
fi
collect_profiling_files

