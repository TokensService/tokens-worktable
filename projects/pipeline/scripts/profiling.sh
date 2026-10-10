#!/usr/bin/env bash
set -euo pipefail
# Start torch profiling through XDS and optionally generate self-test traffic.
PROFILING_URL="${PROFILING_URL:-}"
if [[ -z "$PROFILING_URL" ]]; then
  host="${PROFILING_API_HOST:-${XDS_API_HOST:-}}"
  port="${PROFILING_API_PORT:-${XDS_API_PORT:-}}"
  [[ -n "$host" && -n "$port" ]] || { echo 'set PROFILING_URL or PROFILING_API_HOST/PROFILING_API_PORT' >&2; exit 2; }
  PROFILING_URL="http://${host}:${port}/xds/v1"
fi
PROFILING_URL="${PROFILING_URL%/}"
PROFILING_PARAMS="${PROFILING_PARAMS:-start 10}"
PROFILING_FILTER="${PROFILING_FILTER:-}"
PROFILING_SELF_TEST="${PROFILING_SELF_TEST:-false}"
if [[ -z "${PROFILING_MODEL_ENDPOINT:-}" ]]; then
  PROFILING_MODEL_ENDPOINT="${MODEL_ENDPOINT:-${MODEL_NAME:-${MODEL:-}}}"
fi
PROFILING_INTERVAL_SECONDS="${PROFILING_INTERVAL_SECONDS:-0.5}"
PROFILING_MAX_REQUESTS="${PROFILING_MAX_REQUESTS:-0}"
case "${PROFILING_SELF_TEST,,}" in true|false) ;; *) echo 'PROFILING_SELF_TEST must be true or false' >&2; exit 2 ;; esac
[[ "$PROFILING_MAX_REQUESTS" =~ ^[0-9]+$ ]] || { echo 'PROFILING_MAX_REQUESTS must be non-negative' >&2; exit 2; }
[[ "${PROFILING_SELF_TEST,,}" == false || -n "$PROFILING_MODEL_ENDPOINT" ]] || { echo 'PROFILING_MODEL_ENDPOINT is required for self-test' >&2; exit 2; }
base="${PROFILING_URL%/}"
echo "starting profiling at ${base}"
curl --fail-with-body --silent --show-error --get "${base}/OM/diagnose/get" \
  --data-urlencode 'cmd=set_profiling' --data-urlencode "params=${PROFILING_PARAMS}" --data-urlencode "filter=${PROFILING_FILTER}"
printf '\n'
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
  curl --fail-with-body --silent --show-error "${base}/chat/completions" -H 'Content-Type: application/json' -H "model_endpoint: ${PROFILING_MODEL_ENDPOINT}" -d "$body"
  printf '\n==========request finish %s==========\n' "$nonce"
  sleep "$PROFILING_INTERVAL_SECONDS"
done
