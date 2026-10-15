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
DEPLOY_TEMPLATE_DIR="${DEPLOY_TEMPLATE_DIR:-/data/zcx/open-xds-runtime-release-wheels/deploy/xds/A3}"
FALLBACK_DEPLOY_TEMPLATE_DIR="${FALLBACK_DEPLOY_TEMPLATE_DIR:-/opt/op_test}"
RUN_DIR="${RUN_DIR:-/tmp/op-test-pipeline-$(date +%Y%m%d_%H%M%S)}"
TEMPLATE_DIR="$RUN_DIR/template"
PULL_RETRIES="${PULL_RETRIES:-2}"
PULL_RETRY_DELAY_SECONDS="${PULL_RETRY_DELAY_SECONDS:-5}"
SKIP_CONTAINERD_CLEANUP="${SKIP_CONTAINERD_CLEANUP:-0}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-auto}"
TARGET_HOSTS="${TARGET_HOSTS:-[]}"
TARGET_NODE_IP_MAP="${TARGET_NODE_IP_MAP:-}"
[[ -n "$TARGET_NODE_IP_MAP" ]] || TARGET_NODE_IP_MAP='{}'
# Use the SWR region in the registry username. IMAGE_PULL_PROJECT retains the
# explicit override, while SWR_PROJECT avoids collision with a deployment's
# registry namespace held in PROJECT.
IMAGE_PULL_PROJECT="${IMAGE_PULL_PROJECT:-${SWR_PROJECT:-cn-southwest-2}}"
IMAGE_PULL_AK="${IMAGE_PULL_AK:-${AK:-}}"
# LOGKEY is the pipeline input.  Prefer it over the legacy LOGIN_KEY so a stale
# inherited LOGIN_KEY cannot override credentials supplied for the current run.
IMAGE_PULL_LOGIN_KEY="${IMAGE_PULL_LOGIN_KEY:-${LOGKEY:-${LOGIN_KEY:-}}}"
# Registry access uses the target/runtime configuration as-is. Do not modify
# proxy variables or inject any additional pull configuration.

resolve_container_runtime() {
  case "$CONTAINER_RUNTIME" in
    nerdctl|ctr) command -v "$CONTAINER_RUNTIME" >/dev/null 2>&1 || {
      echo "container runtime '$CONTAINER_RUNTIME' is not installed" >&2
      return 2
    } ;;
    auto)
      if command -v nerdctl >/dev/null 2>&1; then
        CONTAINER_RUNTIME=nerdctl
      elif command -v ctr >/dev/null 2>&1; then
        CONTAINER_RUNTIME=ctr
      else
        echo "nerdctl or ctr is required on the execution host" >&2
        return 2
      fi
      ;;
    *) echo "unsupported CONTAINER_RUNTIME: $CONTAINER_RUNTIME (expected auto, nerdctl, or ctr)" >&2; return 2 ;;
  esac
}

cleanup_unused_containerd_resources() {
  [[ "$SKIP_CONTAINERD_CLEANUP" == "1" ]] && return 0
  command -v nerdctl >/dev/null 2>&1 || return 0
  echo "[pull][gc] reclaim unused containers, images, snapshots, and build cache"
  # Do not remove running containers or named images still referenced by a
  # container.  -a is intentional: repeated render pulls leave unreferenced
  # tagged and <none> image records behind, not just dangling layers.
  nerdctl --namespace k8s.io system prune -a -f >/dev/null 2>&1 || \
    echo "[pull][gc] warning: system prune did not complete" >&2
  nerdctl --namespace k8s.io image prune -a -f >/dev/null 2>&1 || \
    echo "[pull][gc] warning: image prune did not complete" >&2
  nerdctl --namespace k8s.io snapshot prune >/dev/null 2>&1 || \
    echo "[pull][gc] warning: snapshot prune did not complete" >&2
}

print_storage_diagnostics() {
  echo "[pull] containerd storage after failed pull:" >&2
  df -h /var/lib/containerd 2>&1 || true
  df -i /var/lib/containerd 2>&1 || true
  if command -v ctr >/dev/null 2>&1; then
    ctr -n k8s.io images ls 2>&1 || true
  elif command -v nerdctl >/dev/null 2>&1; then
    # Some installed nerdctl versions do not implement `system df`; listing
    # images is portable and still shows the containerd records involved.
    nerdctl --namespace k8s.io images ls 2>&1 || true
  fi
}

remote_quote() {
  local value="$1"
  value="${value//\'/\'\"\'\"\'}"
  printf "'%s'" "$value"
}

run_target() {
  local target="$1" port="$2" password="$3"
  local -a ssh_options
  shift 3
  ssh_options=(-p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=30)
  if [[ -n "$password" ]]; then
    command -v sshpass >/dev/null 2>&1 || {
      echo "sshpass is required for password-authenticated target image pulls" >&2
      return 2
    }
    SSHPASS="$password" sshpass -e ssh "${ssh_options[@]}" "$target" "$@"
  else
    ssh "${ssh_options[@]}" "$target" "$@"
  fi
}

pull_target_images() {
  local image="$1" target_line target_json endpoint user host port password target remote_command mapped_targets_text image_check_status pull_status mapped_target
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
    match = re.fullmatch(r"([^:]+):(\d+)", endpoint)
    if match:
        host, port = match.groups()
        if not 1 <= int(port) <= 65535:
            raise SystemExit(f"invalid TARGET_HOSTS port: {endpoint}")
    else:
        host, port = endpoint, "22"
    # Missing entries are direct/non-mapped targets and still need a remote pull.
    mapped_ip = mapping.get(endpoint, host)
    if not isinstance(mapped_ip, str) or not mapped_ip:
        raise SystemExit(f"TARGET_NODE_IP_MAP value must be a non-empty IP for target endpoint: {endpoint}")
    payload = {"endpoint": endpoint, "host": host, "port": port,
               "user": item.get("user") or "root",
               "password": item.get("pass", item.get("password", "")) or "",
               "mapped": mapped_ip != host}
    print(base64.b64encode(json.dumps(payload).encode()).decode())
PY
  )"
  [[ -n "$mapped_targets_text" ]] || return 0
  mapfile -t mapped_targets <<<"$mapped_targets_text"

  for target_line in "${mapped_targets[@]}"; do
    target_json="$(printf '%s' "$target_line" | base64 -d)"
    read -r endpoint user host port password mapped_target < <(python3 - "$target_json" <<'PY'
import json
import sys
item = json.loads(sys.argv[1])
password = item["password"] or "-"
print(item["endpoint"], item["user"], item["host"], item["port"], password, int(item["mapped"]))
PY
    )
    [[ "$password" == "-" ]] && password=""
    target="${user}@${host}"
    if [[ "$mapped_target" != 1 ]]; then
      if [[ -z "$IMAGE_PULL_AK" || -z "$IMAGE_PULL_LOGIN_KEY" ]]; then
        echo "AK and LOGIN_KEY are required for non-mapped target image pulls" >&2
        return 2
      fi
      printf -v remote_command '%s' "command -v ctr >/dev/null 2>&1 || { echo '[pull] target has no ctr' >&2; exit 2; }; if [ \"\$(id -u)\" -eq 0 ]; then ctr -n k8s.io images pull --user $(remote_quote "${IMAGE_PULL_PROJECT}@${IMAGE_PULL_AK}:${IMAGE_PULL_LOGIN_KEY}") $(remote_quote "$image"); else sudo ctr -n k8s.io images pull --user $(remote_quote "${IMAGE_PULL_PROJECT}@${IMAGE_PULL_AK}:${IMAGE_PULL_LOGIN_KEY}") $(remote_quote "$image"); fi"
      echo "[pull] target $endpoint (non-mapped): pull image $image with ctr"
      if run_target "$target" "$port" "$password" "bash -lc $(remote_quote "$remote_command")"; then
        :
      else
        pull_status=$?
        echo "[pull] target $endpoint: non-mapped registry pull failed (exit $pull_status)" >&2
        return "$pull_status"
      fi
      continue
    fi
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
    printf -v remote_command '%s' "command -v ctr >/dev/null 2>&1 || { echo '[pull] target has no ctr' >&2; exit 2; }; if [ \"\$(id -u)\" -eq 0 ]; then ctr -n k8s.io images pull --user $(remote_quote "${IMAGE_PULL_PROJECT}@${IMAGE_PULL_AK}:${IMAGE_PULL_LOGIN_KEY}") $(remote_quote "$image"); else sudo ctr -n k8s.io images pull --user $(remote_quote "${IMAGE_PULL_PROJECT}@${IMAGE_PULL_AK}:${IMAGE_PULL_LOGIN_KEY}") $(remote_quote "$image"); fi"
    if run_target "$target" "$port" "$password" "bash -lc $(remote_quote "$remote_command")"; then
      continue
    else
      pull_status=$?
    fi

    echo "[pull] target $endpoint: registry pull failed (exit $pull_status); import image from execution host" >&2
    printf -v remote_command '%s' "command -v ctr >/dev/null 2>&1 || { echo '[pull] target has no ctr' >&2; exit 2; }; sudo ctr -n k8s.io images import -"
    resolve_container_runtime
    if [[ "$CONTAINER_RUNTIME" == nerdctl ]]; then
      nerdctl --namespace k8s.io save "$image" \
        | run_target "$target" "$port" "$password" "bash -lc $(remote_quote "$remote_command")"
    else
      ctr -n k8s.io images export - "$image" \
        | run_target "$target" "$port" "$password" "bash -lc $(remote_quote "$remote_command")"
    fi
    if [[ "${PIPESTATUS[0]}" -ne 0 || "${PIPESTATUS[1]}" -ne 0 ]]; then
      echo "[pull] target $endpoint: streamed image import failed" >&2
      return 1
    fi

    printf -v remote_command '%s' "sudo ctr -n k8s.io images ls -q | grep -Fqx -- $(remote_quote "$image")"
    if ! run_target "$target" "$port" "$password" "bash -lc $(remote_quote "$remote_command")"; then
      echo "[pull] target $endpoint: imported archive does not contain the expected image reference: $image" >&2
      return 1
    fi
    echo "[pull] target $endpoint: target image import completed"
  done
}

pull_image() {
  local image="$1" registry_host attempt pull_status
  registry_host="${image%%/*}"
  resolve_container_runtime

  echo "[pull] execution host: pull $image"
  if [[ "$CONTAINER_RUNTIME" == nerdctl ]] && nerdctl --namespace k8s.io image inspect "$image" >/dev/null 2>&1; then
    echo "[pull] image already exists: $image"
    return 0
  fi
  if [[ "$CONTAINER_RUNTIME" == ctr ]] && ctr -n k8s.io images ls -q | grep -Fqx -- "$image"; then
    echo "[pull] image already exists: $image"
    return 0
  fi

  [[ "$PULL_RETRIES" =~ ^[0-9]+$ && "$PULL_RETRIES" -ge 1 ]] || PULL_RETRIES=2
  for ((attempt = 1; attempt <= PULL_RETRIES; attempt++)); do
    # Reclaim stale failed-extraction snapshots before every attempt.  This is
    # also what removes the accumulated <none>:<none> image records.
    cleanup_unused_containerd_resources
    echo "[pull] image pull attempt $attempt/$PULL_RETRIES: $image"
    if [[ "$CONTAINER_RUNTIME" == nerdctl ]]; then
      if nerdctl --namespace k8s.io pull "$image"; then
        return 0
      else
        pull_status=$?
      fi
    else
      [[ -n "$IMAGE_PULL_AK" && -n "$IMAGE_PULL_LOGIN_KEY" ]] || {
        echo "AK and LOGIN_KEY are required for ctr image pulls" >&2
        return 2
      }
      if ctr -n k8s.io images pull --user "${IMAGE_PULL_PROJECT}@${IMAGE_PULL_AK}:${IMAGE_PULL_LOGIN_KEY}" "$image"; then
        return 0
      else
        pull_status=$?
      fi
    fi
    echo "[pull] image pull attempt $attempt failed (exit $pull_status)" >&2
    cleanup_unused_containerd_resources
    if (( attempt < PULL_RETRIES )); then
      sleep "$PULL_RETRY_DELAY_SECONDS"
    fi
  done
  print_storage_diagnostics
  echo "image pull failed after $PULL_RETRIES attempts; authenticate the execution user's nerdctl/ctr runtime for $registry_host" >&2
  return "$pull_status"
}

export_templates_nerdctl() {
  local work_dir container_name source_dir probe_output probe_status
  work_dir="$(mktemp -d)"
  container_name="op-test-template-$$"
  cleanup() {
    nerdctl --namespace k8s.io rm -f "$container_name" >/dev/null 2>&1 || true
    rm -rf "$work_dir"
  }
  trap cleanup RETURN

  echo "[pull] execution host: export render templates from $TEMPLATE_IMAGE"
  mkdir -p "$TEMPLATE_DIR"
  nerdctl --namespace k8s.io create --net=none --entrypoint /bin/sh --name "$container_name" \
    --env OP_TEST_DEPLOY_TEMPLATE_DIR="$DEPLOY_TEMPLATE_DIR" \
    --env OP_TEST_FALLBACK_DEPLOY_TEMPLATE_DIR="$FALLBACK_DEPLOY_TEMPLATE_DIR" \
    "$TEMPLATE_IMAGE" -c '
      set -eu
      chart=""
      values=""
      architecture=""
      for root in "$OP_TEST_DEPLOY_TEMPLATE_DIR" "$OP_TEST_FALLBACK_DEPLOY_TEMPLATE_DIR"; do
        if [ -z "$chart" ] && [ -f "$root/xds_template/k8s/xds-cluster/Chart.yaml" ]; then
          chart="$root/xds_template/k8s/xds-cluster"
        fi
        if [ -z "$values" ] && [ -f "$root/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml" ]; then
          values="$root/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml"
        fi
        if [ -z "$architecture" ] && [ -f "$root/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json" ]; then
          architecture="$root/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json"
        fi
        if [ -z "$architecture" ] && [ -f "$root/xds_template/k8s/xds-cluster/model_arch/model_arch-lt-je-cpp-bnt3.json" ]; then
          architecture="$root/xds_template/k8s/xds-cluster/model_arch/model_arch-lt-je-cpp-bnt3.json"
        fi
      done
      [ -n "$chart" ] || chart_file="$(find / -xdev -type f -path "*/xds_template/k8s/xds-cluster/Chart.yaml" -print -quit 2>/dev/null || true)"
      [ -n "$chart" ] || chart="${chart_file%/Chart.yaml}"
      [ -n "$values" ] || values="$(find / -xdev -type f -name values-16Node-je-cpp-bnt3.yaml -print -quit 2>/dev/null || true)"
      [ -n "$architecture" ] || architecture="$(find / -xdev -type f -name model_arch-lt-je-cpp-bnt3.json -print -quit 2>/dev/null || true)"
      if [ -z "$chart" ] || [ -z "$values" ] || [ -z "$architecture" ]; then
        echo "unable to locate the xds chart, values template, and architecture file in the image" >&2
        exit 3
      fi
      printf "%s\n%s\n%s\n" "$chart" "$values" "$architecture"
    ' >/dev/null
  copy_template_set() {
    local template_root=$1 output_dir=$2
    rm -rf "$output_dir"
    mkdir -p "$output_dir"
    nerdctl --namespace k8s.io cp "$container_name:$template_root/xds_template/k8s/xds-cluster" "$output_dir/xds-cluster" \
      && nerdctl --namespace k8s.io cp "$container_name:$template_root/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml" "$output_dir/values-16Node-je-cpp-bnt3.yaml" \
      && nerdctl --namespace k8s.io cp "$container_name:$template_root/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json" "$output_dir/model_arch-lt-je-cpp-bnt3.json"
  }
  copy_discovered_template_set() {
    local output_dir=$1 chart_path=$2 values_path=$3 architecture_path=$4
    rm -rf "$output_dir"
    mkdir -p "$output_dir"
    nerdctl --namespace k8s.io cp "$container_name:$chart_path" "$output_dir/xds-cluster" \
      && nerdctl --namespace k8s.io cp "$container_name:$values_path" "$output_dir/values-16Node-je-cpp-bnt3.yaml" \
      && nerdctl --namespace k8s.io cp "$container_name:$architecture_path" "$output_dir/model_arch-lt-je-cpp-bnt3.json"
  }
  source_dir="$work_dir/deploy-template"
  if copy_template_set "$DEPLOY_TEMPLATE_DIR" "$source_dir" 2>/dev/null; then
    :
  elif [[ "$DEPLOY_TEMPLATE_DIR" != "$FALLBACK_DEPLOY_TEMPLATE_DIR" ]] \
    && copy_template_set "$FALLBACK_DEPLOY_TEMPLATE_DIR" "$source_dir" 2>/dev/null; then
    echo "[pull] template root $DEPLOY_TEMPLATE_DIR is unavailable; using $FALLBACK_DEPLOY_TEMPLATE_DIR"
  else
    echo "[pull] configured template roots are unavailable; discovering template files in the image"
    probe_status=0
    probe_output="$(nerdctl --namespace k8s.io start -a "$container_name")" || probe_status=$?
    if [[ "$probe_status" -ne 0 && -z "$probe_output" ]]; then
      echo "template discovery failed in $TEMPLATE_IMAGE" >&2
      return 1
    fi
    mapfile -t discovered_paths <<<"$probe_output"
    if [[ "${#discovered_paths[@]}" -ne 3 ]] \
      || [[ -z "${discovered_paths[0]}" || -z "${discovered_paths[1]}" || -z "${discovered_paths[2]}" ]]; then
      echo "template discovery returned an invalid result from $TEMPLATE_IMAGE" >&2
      return 1
    fi
    printf '[pull] discovered chart=%s values=%s architecture=%s\n' \
      "${discovered_paths[0]}" "${discovered_paths[1]}" "${discovered_paths[2]}"
    copy_discovered_template_set "$source_dir" \
      "${discovered_paths[0]}" "${discovered_paths[1]}" "${discovered_paths[2]}" || {
      echo "template export failed from discovered image paths" >&2
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

export_templates_ctr() {
  local work_dir mount_dir source_dir chart_path values_path architecture_path
  work_dir="$(mktemp -d)"
  mount_dir="$work_dir/image-root"
  source_dir="$work_dir/deploy-template"
  mkdir -p "$mount_dir"
  cleanup() {
    ctr -n k8s.io images unmount "$mount_dir" >/dev/null 2>&1 || true
    rm -rf "$work_dir"
  }
  trap cleanup RETURN

  echo "[pull] execution host: export render templates from $TEMPLATE_IMAGE with ctr"
  ctr -n k8s.io images mount "$TEMPLATE_IMAGE" "$mount_dir" >/dev/null
  chart_path="$mount_dir$DEPLOY_TEMPLATE_DIR/xds_template/k8s/xds-cluster"
  values_path="$mount_dir$DEPLOY_TEMPLATE_DIR/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml"
  architecture_path="$mount_dir$DEPLOY_TEMPLATE_DIR/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json"
  if [[ ! -f "$chart_path/Chart.yaml" || ! -f "$values_path" || ! -f "$architecture_path" ]]; then
    chart_path="$mount_dir$FALLBACK_DEPLOY_TEMPLATE_DIR/xds_template/k8s/xds-cluster"
    values_path="$mount_dir$FALLBACK_DEPLOY_TEMPLATE_DIR/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml"
    architecture_path="$mount_dir$FALLBACK_DEPLOY_TEMPLATE_DIR/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json"
  fi
  if [[ ! -f "$chart_path/Chart.yaml" || ! -f "$values_path" || ! -f "$architecture_path" ]]; then
    echo "[pull] configured template roots are unavailable; discovering template files in the image"
    chart_file="$(find "$mount_dir" -xdev -type f -path '*/xds_template/k8s/xds-cluster/Chart.yaml' -print -quit 2>/dev/null || true)"
    values_path="$(find "$mount_dir" -xdev -type f -name values-16Node-je-cpp-bnt3.yaml -print -quit 2>/dev/null || true)"
    architecture_path="$(find "$mount_dir" -xdev -type f -name model_arch-lt-je-cpp-bnt3.json -print -quit 2>/dev/null || true)"
    chart_path="${chart_file%/Chart.yaml}"
  fi
  if [[ -z "$chart_path" || ! -f "$chart_path/Chart.yaml" || -z "$values_path" || -z "$architecture_path" ]]; then
    echo "unable to locate the xds chart, values template, and architecture file in the image" >&2
    return 3
  fi
  printf '[pull] discovered chart=%s values=%s architecture=%s\n' \
    "${chart_path#$mount_dir}" "${values_path#$mount_dir}" "${architecture_path#$mount_dir}"
  rm -rf "$source_dir"
  mkdir -p "$source_dir"
  cp -a "$chart_path" "$source_dir/xds-cluster"
  cp -a "$values_path" "$source_dir/values-16Node-je-cpp-bnt3.yaml"
  cp -a "$architecture_path" "$source_dir/model_arch-lt-je-cpp-bnt3.json"
  if [[ -n "$VALUES_TEMPLATE_SOURCE" ]]; then
    [[ -f "$VALUES_TEMPLATE_SOURCE" ]] || { echo "values template source does not exist: $VALUES_TEMPLATE_SOURCE" >&2; return 2; }
    cp -a "$VALUES_TEMPLATE_SOURCE" "$source_dir/values-16Node-je-cpp-bnt3.yaml"
  fi
  mkdir -p "$TEMPLATE_DIR"
  cp -a "$source_dir/xds-cluster" "$TEMPLATE_DIR/xds-cluster"
  cp -a "$source_dir/values-16Node-je-cpp-bnt3.yaml" "$TEMPLATE_DIR/values-16Node-je-cpp-bnt3.yaml"
  cp -a "$source_dir/model_arch-lt-je-cpp-bnt3.json" "$TEMPLATE_DIR/model_arch-lt-je-cpp-bnt3.json"
}

export_templates() {
  resolve_container_runtime
  if [[ "$CONTAINER_RUNTIME" == ctr ]]; then
    export_templates_ctr
  else
    export_templates_nerdctl
  fi
  # RETURN traps are process-global in bash; clear the helper's cleanup trap
  # before this dispatcher itself returns, otherwise its local variables are
  # already out of scope when the inherited trap fires a second time.
  trap - RETURN
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
