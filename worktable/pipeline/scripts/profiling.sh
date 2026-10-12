#!/usr/bin/env bash
set -euo pipefail
log() { printf '[profiling][%s] %s\n' "$(date '+%F %T')" "$*"; }
PROFILING_VERBOSE="${PROFILING_VERBOSE:-true}"
request_body_file="$(mktemp /tmp/profiling-response.XXXXXX)"
request_header_file="$(mktemp /tmp/profiling-headers.XXXXXX)"
cleanup_files() { rm -f "$request_body_file" "$request_header_file"; }
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
case "${PROFILING_SELF_TEST,,}" in true|false) ;; *) echo 'PROFILING_SELF_TEST must be true or false' >&2; exit 2 ;; esac
[[ "$PROFILING_MAX_REQUESTS" =~ ^[0-9]+$ ]] || { echo 'PROFILING_MAX_REQUESTS must be non-negative' >&2; exit 2; }
for value_name in PROFILING_CONNECT_TIMEOUT_SECONDS PROFILING_REQUEST_TIMEOUT_SECONDS PROFILING_RETRIES; do
  value="${!value_name}"; [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "$value_name must be a positive integer" >&2; exit 2; }
done
[[ "${PROFILING_SELF_TEST,,}" == false || -n "$PROFILING_MODEL_ENDPOINT" ]] || { echo 'PROFILING_MODEL_ENDPOINT is required for self-test' >&2; exit 2; }
base="${PROFILING_URL%/}"
log "resolved endpoint=${base}"
log "model_endpoint=${PROFILING_MODEL_ENDPOINT:-<unset>} self_test=${PROFILING_SELF_TEST,,} max_requests=${PROFILING_MAX_REQUESTS} interval=${PROFILING_INTERVAL_SECONDS}s connect_timeout=${PROFILING_CONNECT_TIMEOUT_SECONDS}s request_timeout=${PROFILING_REQUEST_TIMEOUT_SECONDS}s retries=${PROFILING_RETRIES}"
log "starting torch profiling: GET ${base}/OM/diagnose/get params=${PROFILING_PARAMS} filter=${PROFILING_FILTER:-<empty>}"
set +e
curl --silent --show-error --connect-timeout "$PROFILING_CONNECT_TIMEOUT_SECONDS" --max-time "$PROFILING_REQUEST_TIMEOUT_SECONDS" \
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
[[ "${PROFILING_SELF_TEST,,}" == true ]] || exit 0
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
  curl --silent --show-error --connect-timeout "$PROFILING_CONNECT_TIMEOUT_SECONDS" --max-time "$PROFILING_REQUEST_TIMEOUT_SECONDS" \
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
