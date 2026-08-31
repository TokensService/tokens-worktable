#!/usr/bin/env bash
# Verify the XDS API and execute one real non-streaming chat request.
set -euo pipefail

XDS_URL="${XDS_URL:-http://127.0.0.1:30079/xds/v1}"
MODEL_NAME="${MODEL_NAME:-${ARCH_NAME:-default}}"
MAX_TOKENS="${MAX_TOKENS:-1}"

echo "[health] check models at ${XDS_URL%/}/models/"
curl --noproxy '*' --fail-with-body -sS "${XDS_URL%/}/models/" >/dev/null

echo "[health] chat model=$MODEL_NAME"
curl --noproxy '*' --fail-with-body -sS -X POST "${XDS_URL%/}/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "model_endpoint: $MODEL_NAME" \
  --data-raw "{\"model\":\"$MODEL_NAME\",\"messages\":[{\"role\":\"user\",\"content\":\"health check\"}],\"max_tokens\":$MAX_TOKENS,\"temperature\":0,\"stream\":false}" \
  >/dev/null
echo "[health] model is healthy: $MODEL_NAME"
