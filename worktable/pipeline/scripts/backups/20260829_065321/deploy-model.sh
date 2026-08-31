#!/usr/bin/env bash
# Deploy the rendered chart, then register its rendered architecture request.
set -euo pipefail

CHART_DIR="${CHART_DIR:?CHART_DIR must be produced by render-config.sh}"
VALUES_FILE="${VALUES_FILE:?VALUES_FILE must be produced by render-config.sh}"
ARCH_REQUEST_FILE="${ARCH_REQUEST_FILE:?ARCH_REQUEST_FILE must be produced by render-config.sh}"
ARCH_NAME="${ARCH_NAME:?ARCH_NAME must be produced by render-config.sh}"
NAMESPACE="${NAMESPACE:?NAMESPACE must be produced by render-config.sh}"
RELEASE_NAME="${RELEASE_NAME:?RELEASE_NAME must be produced by render-config.sh}"
XDS_URL="${XDS_URL:?XDS_URL is required}"
HELM_BIN="${HELM_BIN:-helm}"
HELM_TIMEOUT="${HELM_TIMEOUT:-10m}"

[[ -f "$CHART_DIR/Chart.yaml" ]] || { echo "Chart.yaml not found: $CHART_DIR" >&2; exit 2; }
[[ -f "$VALUES_FILE" ]] || { echo "values file not found: $VALUES_FILE" >&2; exit 2; }
[[ -f "$ARCH_REQUEST_FILE" ]] || { echo "architecture request not found: $ARCH_REQUEST_FILE" >&2; exit 2; }

echo "[deploy] helm release=$RELEASE_NAME namespace=$NAMESPACE chart=$CHART_DIR"
"$HELM_BIN" upgrade --install "$RELEASE_NAME" "$CHART_DIR" \
  --namespace "$NAMESPACE" --create-namespace --values "$VALUES_FILE" \
  --timeout "$HELM_TIMEOUT"

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
printf 'XDS_URL=%s\n' "$XDS_URL"
