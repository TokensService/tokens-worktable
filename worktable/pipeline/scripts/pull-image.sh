#!/usr/bin/env bash
# Pre-pull one deployment image on target nodes and export render templates.
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-${DEPLOY_IMAGE:-myapp}}"
IMAGE="$IMAGE_NAME"
TEMPLATE_IMAGE="${TEMPLATE_IMAGE:-$IMAGE}"
TARGET_HOSTS="${TARGET_HOSTS:-[]}"
SSH_PASSWORD="${SSH_PASSWORD:-${TARGET_PASSWORD:-}}"
CONTROL_HOST="${CONTROL_HOST:-}"
REGISTRY_USERNAME="${REGISTRY_USERNAME:-}"
REGISTRY_PASSWORD="${REGISTRY_PASSWORD:-}"
REGISTRY_SECRET_NAMESPACE="${REGISTRY_SECRET_NAMESPACE:-default}"
REGISTRY_SECRET_NAME="${REGISTRY_SECRET_NAME:-xds-swr-credentials}"
RUN_DIR="${RUN_DIR:-/tmp/op-test-pipeline-$(date +%Y%m%d_%H%M%S)}"
TEMPLATE_DIR="$RUN_DIR/template"
CONTROL_TARGET_IP=""
CONTROL_TARGET_USER=""
PULL_PROXY="${PULL_PROXY:-}"
PULL_NO_PROXY="${PULL_NO_PROXY:-}"

select_control_target() {
  local selected
  selected="$(python3 - "$TARGET_HOSTS" "$CONTROL_HOST" <<'PY'
import json
import sys
hosts = json.loads(sys.argv[1])
control_host = sys.argv[2]
if not isinstance(hosts, list) or not hosts:
    raise SystemExit("TARGET_HOSTS must be a non-empty JSON array")
for host in hosts:
    if not isinstance(host, dict) or not isinstance(host.get("ip"), str) or not host["ip"]:
        raise SystemExit("every TARGET_HOSTS entry must contain a non-empty ip")
matches = [host for host in hosts if host["ip"] == control_host]
if control_host and len(matches) != 1:
    raise SystemExit("CONTROL_HOST must match an entry in TARGET_HOSTS")
selected = matches[0] if control_host else hosts[0]
print(selected["ip"])
print(selected.get("user") or "root")
PY
)" || exit $?
  mapfile -t control_fields <<<"$selected"
  CONTROL_TARGET_IP="${control_fields[0]:-}"
  CONTROL_TARGET_USER="${control_fields[1]:-root}"
}

remote_bash() {
  local target="$1"
  if [[ -n "$SSH_PASSWORD" ]]; then
    SSHPASS="$SSH_PASSWORD" sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 -o LogLevel=ERROR "$target" 'bash -s'
  else
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 -o LogLevel=ERROR "$target" 'bash -s'
  fi
}

write_remote_context() {
  printf 'IMAGE=%q\n' "$IMAGE"
  printf 'TEMPLATE_IMAGE=%q\n' "$TEMPLATE_IMAGE"
  printf 'REGISTRY_USERNAME=%q\n' "$REGISTRY_USERNAME"
  printf 'REGISTRY_PASSWORD=%q\n' "$REGISTRY_PASSWORD"
  printf 'REGISTRY_SECRET_NAMESPACE=%q\n' "$REGISTRY_SECRET_NAMESPACE"
  printf 'REGISTRY_SECRET_NAME=%q\n' "$REGISTRY_SECRET_NAME"
  if [[ -n "$PULL_PROXY" ]]; then
    printf 'export http_proxy=%q https_proxy=%q HTTP_PROXY=%q HTTPS_PROXY=%q\n' "$PULL_PROXY" "$PULL_PROXY" "$PULL_PROXY" "$PULL_PROXY"
  fi
  if [[ -n "$PULL_NO_PROXY" ]]; then
    printf 'export no_proxy=%q NO_PROXY=%q\n' "$PULL_NO_PROXY" "$PULL_NO_PROXY"
  fi
}

pull_image_on_target() {
  local ip="$1" user="$2"
  echo "[pull] $ip: pull $IMAGE"
  {
    write_remote_context
    cat <<'REMOTE'
set -euo pipefail
auth_dir=""
cleanup() { [[ -z "$auth_dir" ]] || rm -rf "$auth_dir"; }
trap cleanup EXIT
if [[ -n "$REGISTRY_USERNAME" || -n "$REGISTRY_PASSWORD" ]]; then
  [[ -n "$REGISTRY_USERNAME" && -n "$REGISTRY_PASSWORD" ]] || { echo "REGISTRY_USERNAME and REGISTRY_PASSWORD must be set together" >&2; exit 2; }
else
  command -v kubectl >/dev/null 2>&1 || { echo "kubectl is required to read registry credentials from Kubernetes" >&2; exit 2; }
  REGISTRY_USERNAME="$(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY kubectl -n "$REGISTRY_SECRET_NAMESPACE" get secret "$REGISTRY_SECRET_NAME" -o jsonpath='{.data.username}' | base64 -d)"
  REGISTRY_PASSWORD="$(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY kubectl -n "$REGISTRY_SECRET_NAMESPACE" get secret "$REGISTRY_SECRET_NAME" -o jsonpath='{.data.password}' | base64 -d)"
  [[ -n "$REGISTRY_USERNAME" && -n "$REGISTRY_PASSWORD" ]] || { echo "registry Secret $REGISTRY_SECRET_NAMESPACE/$REGISTRY_SECRET_NAME must contain non-empty username and password data keys" >&2; exit 2; }
fi
auth_dir="$(mktemp -d)"
umask 077
registry_host="${IMAGE%%/*}"
registry_auth="$(printf '%s:%s' "$REGISTRY_USERNAME" "$REGISTRY_PASSWORD" | base64 -w 0)"
printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$registry_host" "$registry_auth" >"$auth_dir/config.json"
if command -v nerdctl >/dev/null 2>&1; then
  nerdctl --namespace k8s.io image inspect "$IMAGE" >/dev/null 2>&1 || DOCKER_CONFIG="$auth_dir" nerdctl --namespace k8s.io pull "$IMAGE"
elif command -v ctr >/dev/null 2>&1; then
  ctr --namespace k8s.io images ls -q | grep -Fx -- "$IMAGE" >/dev/null 2>&1 || ctr --namespace k8s.io images pull --user "$REGISTRY_USERNAME:$REGISTRY_PASSWORD" "$IMAGE"
elif command -v docker >/dev/null 2>&1; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || DOCKER_CONFIG="$auth_dir" docker pull "$IMAGE"
else
  echo "neither nerdctl, ctr, nor docker is available" >&2
  exit 2
fi
REMOTE
  } | remote_bash "$user@$ip"
}

export_templates_from_control_target() {
  echo "[pull] $CONTROL_TARGET_IP: export render templates from $TEMPLATE_IMAGE"
  mkdir -p "$TEMPLATE_DIR"
  {
    write_remote_context
    cat <<'REMOTE'
set -euo pipefail
work_dir="$(mktemp -d)"
container_name="op-test-template-$$"
mount_dir=""
cleanup() {
  [[ -z "$mount_dir" ]] || ctr --namespace k8s.io images unmount "$mount_dir" >/dev/null 2>&1 || true
  [[ -z "$mount_dir" ]] || rmdir "$mount_dir" 2>/dev/null || true
  nerdctl --namespace k8s.io rm -f "$container_name" >/dev/null 2>&1 || true
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT
if command -v nerdctl >/dev/null 2>&1; then
  nerdctl --namespace k8s.io create --net=none --name "$container_name" "$TEMPLATE_IMAGE" >/dev/null
  nerdctl --namespace k8s.io cp "$container_name:/opt/op_test/xds_template/k8s/xds-cluster" "$work_dir/xds-cluster"
  nerdctl --namespace k8s.io cp "$container_name:/opt/op_test/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml" "$work_dir/values-16Node-je-cpp-bnt3.yaml"
  nerdctl --namespace k8s.io cp "$container_name:/opt/op_test/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json" "$work_dir/model_arch-lt-je-cpp-bnt3.json"
elif command -v ctr >/dev/null 2>&1; then
  mount_dir="$(mktemp -d)"
  ctr --namespace k8s.io images mount "$TEMPLATE_IMAGE" "$mount_dir" >/dev/null
  cp -a "$mount_dir/opt/op_test/xds_template/k8s/xds-cluster" "$work_dir/xds-cluster"
  cp -a "$mount_dir/opt/op_test/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml" "$work_dir/values-16Node-je-cpp-bnt3.yaml"
  cp -a "$mount_dir/opt/op_test/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json" "$work_dir/model_arch-lt-je-cpp-bnt3.json"
elif command -v docker >/dev/null 2>&1; then
  docker create --name "$container_name" "$TEMPLATE_IMAGE" >/dev/null
  docker cp "$container_name:/opt/op_test/xds_template/k8s/xds-cluster" "$work_dir/xds-cluster"
  docker cp "$container_name:/opt/op_test/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml" "$work_dir/values-16Node-je-cpp-bnt3.yaml"
  docker cp "$container_name:/opt/op_test/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json" "$work_dir/model_arch-lt-je-cpp-bnt3.json"
else
  echo "neither nerdctl, ctr, nor docker is available" >&2
  exit 2
fi
tar -C "$work_dir" -cf - xds-cluster values-16Node-je-cpp-bnt3.yaml model_arch-lt-je-cpp-bnt3.json
REMOTE
  } | remote_bash "$CONTROL_TARGET_USER@$CONTROL_TARGET_IP" | tar -C "$TEMPLATE_DIR" -xf -
}

select_control_target
declare -A seen_hosts=()
while IFS=$'\t' read -r ip user; do
  [[ -n "$ip" && -z "${seen_hosts[$ip]:-}" ]] || continue
  seen_hosts["$ip"]=1
  pull_image_on_target "$ip" "$user"
done < <(python3 -c 'import json,sys
for host in json.loads(sys.argv[1]): print(host.get("ip", ""), host.get("user", "root"), sep="\t")' "$TARGET_HOSTS")

if [[ -z "${CHART_TEMPLATE_DIR:-}" && -z "${VALUES_TEMPLATE:-}" && -z "${ARCH_FILE:-}" ]]; then
  export_templates_from_control_target
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
