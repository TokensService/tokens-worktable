#!/usr/bin/env bash
# Register a model using only the P/D resources rendered in this pipeline run.
set -euo pipefail

RUN_DIR="${RUN_DIR:?RUN_DIR must be produced by pull-image.sh}"
RESOURCE_MANIFEST="${RESOURCE_MANIFEST:?RESOURCE_MANIFEST must be produced by render-config.sh}"
ARCH_NAME="${ARCH_NAME:?ARCH_NAME must be produced by render-config.sh}"
XDS_URL="${XDS_URL:?XDS_URL is required}"
MODEL_NAME="${MODEL_NAME:-${1:-$ARCH_NAME}}"
MODEL_PATH="${MODEL_PATH:?MODEL_PATH is required}"
MODEL_VERSION="${MODEL_VERSION:-v1}"
MODEL_REQUEST_FILE="$RUN_DIR/rendered/model.request.json"
MODEL_ACTIVE_TIMEOUT_SECONDS="${MODEL_ACTIVE_TIMEOUT_SECONDS:-4800}"
MODEL_ACTIVE_POLL_SECONDS="${MODEL_ACTIVE_POLL_SECONDS:-10}"

[[ -f "$RESOURCE_MANIFEST" ]] || { echo "resource manifest not found: $RESOURCE_MANIFEST" >&2; exit 2; }
[[ "$MODEL_ACTIVE_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid MODEL_ACTIVE_TIMEOUT_SECONDS: $MODEL_ACTIVE_TIMEOUT_SECONDS" >&2; exit 2; }
[[ "$MODEL_ACTIVE_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid MODEL_ACTIVE_POLL_SECONDS: $MODEL_ACTIVE_POLL_SECONDS" >&2; exit 2; }

wait_for_model_active() {
  local deadline response
  deadline=$((SECONDS + MODEL_ACTIVE_TIMEOUT_SECONDS))
  echo "[register] wait for model ACTIVE: $MODEL_NAME"

  while (( SECONDS < deadline )); do
    response="$(curl --noproxy '*' -sS --connect-timeout 3 --max-time 10 "${XDS_URL%/}/models/${MODEL_NAME}" 2>&1 || true)"
    if printf '%s' "$response" | grep -q '"status":"ACTIVE"'; then
      echo "[register] model is ACTIVE: $MODEL_NAME"
      return 0
    fi
    if printf '%s' "$response" | grep -qE '"status":"(FAILED|ERROR)"'; then
      echo "[register] model entered terminal failure state: $response" >&2
      return 1
    fi
    echo "[register] model not active: $response"
    sleep "$MODEL_ACTIVE_POLL_SECONDS"
  done

  echo "[register] model ACTIVE wait timed out after ${MODEL_ACTIVE_TIMEOUT_SECONDS}s: $MODEL_NAME" >&2
  return 1
}

python3 - "$RESOURCE_MANIFEST" "$ARCH_NAME" "$MODEL_NAME" "$MODEL_PATH" "$MODEL_VERSION" >"$MODEL_REQUEST_FILE" <<'PY'
import json
import sys

manifest_file, arch_name, model_name, model_path, version = sys.argv[1:]
with open(manifest_file, encoding="utf-8") as source:
    manifest = json.load(source)
resources = []
for resource in manifest["resources"]:
    resources.append({key: resource[key] for key in (
        "resource_id", "resource_type", "resource_status", "resource_bundles"
    )})
payload = {
    "model": model_name,
    "model_endpoint": model_name,
    "arch_name": arch_name,
    "version": version,
    "max_instance": 1,
    "min_instance": 1,
    "location": "local",
    "spec_package": arch_name,
    "local_info": {"path": model_path},
    "resource_list": resources,
}
json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
sys.stdout.write("\n")
PY

echo "[register] model=$MODEL_NAME resources=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["resources"]))' "$RESOURCE_MANIFEST")"
curl --noproxy '*' --fail-with-body -sS -X POST "${XDS_URL%/}/models/" \
  -H 'Content-Type: application/json' \
  --data-binary "@$MODEL_REQUEST_FILE"
echo

wait_for_model_active

printf 'MODEL_NAME=%s\n' "$MODEL_NAME"
printf 'MODEL_REQUEST_FILE=%s\n' "$MODEL_REQUEST_FILE"
printf 'RESOURCE_MANIFEST=%s\n' "$RESOURCE_MANIFEST"
printf 'XDS_URL=%s\n' "$XDS_URL"
