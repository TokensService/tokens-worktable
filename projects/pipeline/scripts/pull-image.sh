#!/usr/bin/env bash
# Pull deployment images and export render templates.  By default this runs on
# the pipeline execution host; PULL_TARGET_IMAGES_ONLY=1 performs only the
# post-sync target-host image check/pull.
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
DEPLOY_TEMPLATE_DIR="${DEPLOY_TEMPLATE_DIR:-/opt/deploy_template}"
FALLBACK_DEPLOY_TEMPLATE_DIR="${FALLBACK_DEPLOY_TEMPLATE_DIR:-/opt/op_test}"
RUN_DIR="${RUN_DIR:-/tmp/op-test-pipeline-$(date +%Y%m%d_%H%M%S)}"
TEMPLATE_DIR="$RUN_DIR/template"
TARGET_HOSTS="${TARGET_HOSTS:-[]}"
TARGET_NODE_IP_MAP="${TARGET_NODE_IP_MAP:-}"
[[ -n "$TARGET_NODE_IP_MAP" ]] || TARGET_NODE_IP_MAP='{}'
# Use the SWR region in the registry username. IMAGE_PULL_PROJECT retains the
# explicit override, while SWR_PROJECT avoids collision with a deployment's
# registry namespace held in PROJECT.
IMAGE_PULL_PROJECT="${IMAGE_PULL_PROJECT:-${SWR_PROJECT:-cn-southwest-2}}"
IMAGE_PULL_AK="${IMAGE_PULL_AK:-${AK:-}}"
# LOGKEY is accepted for callers that use the older environment-variable name.
IMAGE_PULL_LOGIN_KEY="${IMAGE_PULL_LOGIN_KEY:-${LOGIN_KEY:-${LOGKEY:-}}}"

remote_quote() {
  printf '%q' "$1"
}

run_target() {
  local target="$1" port="$2" password="$3"
  shift 3
  if [[ -n "$password" ]]; then
    command -v sshpass >/dev/null 2>&1 || {
      echo "sshpass is required for password-authenticated target image pulls" >&2
      return 2
    }
    SSHPASS="$password" sshpass -e ssh -p "$port" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR -o ConnectTimeout=30 "$target" "$@"
  else
    ssh -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR -o ConnectTimeout=30 "$target" "$@"
  fi
}

pull_target_images() {
  local image="$1" target_line target_json endpoint user host port password target remote_command mapped_targets_text image_check_status
  local -a mapped_targets

  mapped_targets_text="$(python3 - "$TARGET_HOSTS" "$TARGET_NODE_IP_MAP" <<'PY'
import base64
import json
import re
import sys

hosts_text, mapping_text = sys.argv[1:]
try:
    hosts = json.loads(hosts_text)
    mapping = json.loads(mapping_text)
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid target image-pull configuration: {error}")
if not isinstance(hosts, list):
    raise SystemExit("TARGET_HOSTS must be a JSON array")
if not isinstance(mapping, dict):
    raise SystemExit("TARGET_NODE_IP_MAP must be a JSON object")
for item in hosts:
    if not isinstance(item, dict) or not isinstance(item.get("ip"), str) or not item["ip"]:
        raise SystemExit("every TARGET_HOSTS entry must contain a non-empty ip")
    endpoint = item["ip"]
    if endpoint not in mapping:
        continue
    match = re.fullmatch(r"([^:]+):(\d+)", endpoint)
    if match:
        host, port = match.groups()
        if not 1 <= int(port) <= 65535:
            raise SystemExit(f"invalid TARGET_HOSTS port: {endpoint}")
    else:
        host, port = endpoint, "22"
    payload = {"endpoint": endpoint, "host": host, "port": port,
               "user": item.get("user") or "root",
               "password": item.get("pass", item.get("password", "")) or ""}
    print(base64.b64encode(json.dumps(payload).encode()).decode())
PY
  )"
  [[ -n "$mapped_targets_text" ]] || return 0
  mapfile -t mapped_targets <<<"$mapped_targets_text"

  for target_line in "${mapped_targets[@]}"; do
    target_json="$(printf '%s' "$target_line" | base64 -d)"
    read -r endpoint user host port password < <(python3 - "$target_json" <<'PY'
import json
import sys
item = json.loads(sys.argv[1])
print(item["endpoint"], item["user"], item["host"], item["port"], item["password"])
PY
    )
    target="${user}@${host}"
    printf -v remote_command '%s' "command -v ctr >/dev/null 2>&1 || { echo '[pull] target has no ctr' >&2; exit 2; }; sudo ctr -n k8s.io images ls -q | grep -Fqx -- $(remote_quote "$image")"
    echo "[pull] target $endpoint: ensure image $image"
    if run_target "$target" "$port" "$password" "bash -lc $(remote_quote "$remote_command")"; then
      echo "[pull] target image already exists: $image"
      continue
    else
      image_check_status=$?
    fi
    if [[ "$image_check_status" -ne 1 ]]; then
      echo "[pull] target $endpoint: image-cache check failed (exit $image_check_status)" >&2
      return "$image_check_status"
    fi
    if [[ -z "$IMAGE_PULL_AK" || -z "$IMAGE_PULL_LOGIN_KEY" ]]; then
      echo "AK and LOGIN_KEY are required when the mapped target image is absent" >&2
      return 2
    fi
    printf -v remote_command '%s' "command -v ctr >/dev/null 2>&1 || { echo '[pull] target has no ctr' >&2; exit 2; }; sudo ctr -n k8s.io images pull --user $(remote_quote "${IMAGE_PULL_PROJECT}@${IMAGE_PULL_AK}:${IMAGE_PULL_LOGIN_KEY}") $(remote_quote "$image")"
    run_target "$target" "$port" "$password" "bash -lc $(remote_quote "$remote_command")"
  done
}

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
  local work_dir container_name source_dir
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
  copy_template_set() {
    local template_root=$1 output_dir=$2
    mkdir -p "$output_dir"
    nerdctl --namespace k8s.io cp "$container_name:$template_root/xds_template/k8s/xds-cluster" "$output_dir/xds-cluster" \
      && nerdctl --namespace k8s.io cp "$container_name:$template_root/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml" "$output_dir/values-16Node-je-cpp-bnt3.yaml" \
      && nerdctl --namespace k8s.io cp "$container_name:$template_root/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json" "$output_dir/model_arch-lt-je-cpp-bnt3.json"
  }
  source_dir="$work_dir/deploy-template"
  if ! copy_template_set "$DEPLOY_TEMPLATE_DIR" "$source_dir"; then
    [[ "$DEPLOY_TEMPLATE_DIR" != "$FALLBACK_DEPLOY_TEMPLATE_DIR" ]] || {
      echo "template export failed from $DEPLOY_TEMPLATE_DIR" >&2
      return 1
    }
    echo "[pull] template root $DEPLOY_TEMPLATE_DIR is unavailable; fallback to $FALLBACK_DEPLOY_TEMPLATE_DIR"
    source_dir="$work_dir/op-test-template"
    copy_template_set "$FALLBACK_DEPLOY_TEMPLATE_DIR" "$source_dir" || {
      echo "template export failed from fallback $FALLBACK_DEPLOY_TEMPLATE_DIR" >&2
      return 1
    }
  fi

  if [[ -n "$VALUES_TEMPLATE_SOURCE" ]]; then
    [[ -f "$VALUES_TEMPLATE_SOURCE" ]] || { echo "values template source does not exist: $VALUES_TEMPLATE_SOURCE" >&2; exit 2; }
    cp -a "$VALUES_TEMPLATE_SOURCE" "$source_dir/values-16Node-je-cpp-bnt3.yaml"
  fi

  cp -a "$source_dir/xds-cluster" "$TEMPLATE_DIR/xds-cluster"
  cp -a "$source_dir/values-16Node-je-cpp-bnt3.yaml" "$TEMPLATE_DIR/values-16Node-je-cpp-bnt3.yaml"
  cp -a "$source_dir/model_arch-lt-je-cpp-bnt3.json" "$TEMPLATE_DIR/model_arch-lt-je-cpp-bnt3.json"
}

if [[ "${PULL_TARGET_IMAGES_ONLY:-0}" == "1" ]]; then
  pull_target_images "$IMAGE"
  exit 0
fi

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
