#!/usr/bin/env bash
# Pre-pull deployment images and export render templates on the pipeline execution host.
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-${DEPLOY_IMAGE:-myapp}}"
if [[ -n "${DEPLOY_IMAGE:-}" ]]; then
  IMAGE="$DEPLOY_IMAGE"
elif [[ -n "${IMAGE_TAG:-}" ]]; then
  IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
else
  IMAGE="$IMAGE_NAME"
fi
TEMPLATE_IMAGE="${TEMPLATE_IMAGE:-$IMAGE}"
VALUES_TEMPLATE_SOURCE="${VALUES_TEMPLATE_SOURCE:-}"
RUN_DIR="${RUN_DIR:-/tmp/op-test-pipeline-$(date +%Y%m%d_%H%M%S)}"
TEMPLATE_DIR="$RUN_DIR/template"

pull_image() {
  local image="$1" registry_host
  registry_host="${image%%/*}"

  command -v nerdctl >/dev/null 2>&1 || {
    echo "nerdctl is required on the pipeline execution host; install it and run nerdctl login $registry_host" >&2
    exit 2
  }

  echo "[pull] execution host: pull $image"
  if ! nerdctl --namespace k8s.io image inspect "$image" >/dev/null 2>&1 && ! nerdctl --namespace k8s.io pull "$image"; then
    echo "image pull failed; run nerdctl --namespace k8s.io login $registry_host as the pipeline execution user" >&2
    exit 1
  fi
}

export_templates() {
  local work_dir container_name
  work_dir="$(mktemp -d)"
  container_name="op-test-template-$$"
  cleanup() {
    nerdctl --namespace k8s.io rm -f "$container_name" >/dev/null 2>&1 || true
    rm -rf "$work_dir"
  }
  trap cleanup RETURN

  echo "[pull] execution host: export render templates from $TEMPLATE_IMAGE"
  mkdir -p "$TEMPLATE_DIR"
  nerdctl --namespace k8s.io create --net=none --name "$container_name" "$TEMPLATE_IMAGE" >/dev/null
  nerdctl --namespace k8s.io cp "$container_name:/opt/op_test/xds_template/k8s/xds-cluster" "$work_dir/xds-cluster"
  nerdctl --namespace k8s.io cp "$container_name:/opt/op_test/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml" "$work_dir/values-16Node-je-cpp-bnt3.yaml"
  nerdctl --namespace k8s.io cp "$container_name:/opt/op_test/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json" "$work_dir/model_arch-lt-je-cpp-bnt3.json"

  if [[ -n "$VALUES_TEMPLATE_SOURCE" ]]; then
    [[ -f "$VALUES_TEMPLATE_SOURCE" ]] || { echo "values template source does not exist: $VALUES_TEMPLATE_SOURCE" >&2; exit 2; }
    cp -a "$VALUES_TEMPLATE_SOURCE" "$work_dir/values-16Node-je-cpp-bnt3.yaml"
  fi

  cp -a "$work_dir/xds-cluster" "$TEMPLATE_DIR/xds-cluster"
  cp -a "$work_dir/values-16Node-je-cpp-bnt3.yaml" "$TEMPLATE_DIR/values-16Node-je-cpp-bnt3.yaml"
  cp -a "$work_dir/model_arch-lt-je-cpp-bnt3.json" "$TEMPLATE_DIR/model_arch-lt-je-cpp-bnt3.json"
}

pull_image "$IMAGE"
[[ "$TEMPLATE_IMAGE" == "$IMAGE" ]] || pull_image "$TEMPLATE_IMAGE"

if [[ -z "${CHART_TEMPLATE_DIR:-}" && -z "${VALUES_TEMPLATE:-}" && -z "${ARCH_FILE:-}" ]]; then
  export_templates
  CHART_TEMPLATE_DIR="$TEMPLATE_DIR/xds-cluster"
  VALUES_TEMPLATE="$TEMPLATE_DIR/values-16Node-je-cpp-bnt3.yaml"
  ARCH_FILE="$TEMPLATE_DIR/model_arch-lt-je-cpp-bnt3.json"
elif [[ -n "${CHART_TEMPLATE_DIR:-}" && -n "${VALUES_TEMPLATE:-}" && -n "${ARCH_FILE:-}" ]]; then
  echo "[pull] use caller-provided render templates"
else
  echo "CHART_TEMPLATE_DIR, VALUES_TEMPLATE, and ARCH_FILE must be set together" >&2
  exit 2
fi

[[ -f "$CHART_TEMPLATE_DIR/Chart.yaml" ]] || { echo "chart export failed: $CHART_TEMPLATE_DIR" >&2; exit 2; }
[[ -f "$VALUES_TEMPLATE" ]] || { echo "values export failed: $VALUES_TEMPLATE" >&2; exit 2; }
[[ -f "$ARCH_FILE" ]] || { echo "architecture export failed: $ARCH_FILE" >&2; exit 2; }
printf 'RUN_DIR=%s\n' "$RUN_DIR"
printf 'CHART_TEMPLATE_DIR=%s\n' "$CHART_TEMPLATE_DIR"
printf 'VALUES_TEMPLATE=%s\n' "$VALUES_TEMPLATE"
printf 'ARCH_FILE=%s\n' "$ARCH_FILE"
printf 'DEPLOY_IMAGE=%s\n' "$IMAGE"
