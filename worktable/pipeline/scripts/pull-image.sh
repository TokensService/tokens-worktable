#!/usr/bin/env bash
# Pre-pull one deployment image on the controller and all target nodes.
# All settings, including the complete image reference, come from environment
# variables.
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-${DEPLOY_IMAGE:-myapp}}"
IMAGE="$IMAGE_NAME"
TEMPLATE_IMAGE="${TEMPLATE_IMAGE:-$IMAGE}"
TARGET_HOSTS="${TARGET_HOSTS:-[]}"
SSH_PASSWORD="${SSH_PASSWORD:-${TARGET_PASSWORD:-}}"
REGISTRY_USERNAME="${REGISTRY_USERNAME:-}"
REGISTRY_PASSWORD="${REGISTRY_PASSWORD:-}"
RUN_DIR="${RUN_DIR:-/tmp/op-test-pipeline-$(date +%Y%m%d_%H%M%S)}"
REGISTRY_AUTH_DIR=""
TEMPLATE_CONTAINER=""
TEMPLATE_DIR="$RUN_DIR/template"
TEMPLATE_MOUNT_DIR=""
CTR_REGISTRY_CREDENTIAL=""
PULL_PROXY="${PULL_PROXY:-${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}}"

if [[ -n "$PULL_PROXY" ]]; then
  export http_proxy="$PULL_PROXY" https_proxy="$PULL_PROXY"
  export HTTP_PROXY="$PULL_PROXY" HTTPS_PROXY="$PULL_PROXY"
fi

cleanup() {
  [[ -z "$TEMPLATE_CONTAINER" ]] || container_remove "$TEMPLATE_CONTAINER" || true
  [[ -z "$REGISTRY_AUTH_DIR" ]] || rm -rf "$REGISTRY_AUTH_DIR"
}

prepare_registry_auth() {
  if [[ -z "$REGISTRY_USERNAME" || -z "$REGISTRY_PASSWORD" ]]; then
    echo "[pull] registry credentials are incomplete; pulling without explicit credentials"
    return 0
  fi

  REGISTRY_AUTH_DIR="$(mktemp -d)"
  umask 077
  registry_host="${IMAGE%%/*}"
  registry_auth="$(printf '%s:%s' "$REGISTRY_USERNAME" "$REGISTRY_PASSWORD" | base64 -w 0)"
  printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$registry_host" "$registry_auth" >"$REGISTRY_AUTH_DIR/config.json"
  CTR_REGISTRY_CREDENTIAL="$REGISTRY_USERNAME:$REGISTRY_PASSWORD"
  echo "[pull] using registry credentials from environment for $registry_host"
}

container_with_auth() {
  if [[ -n "$REGISTRY_AUTH_DIR" ]]; then
    DOCKER_CONFIG="$REGISTRY_AUTH_DIR" "$@"
  else
    "$@"
  fi
}

if command -v nerdctl >/dev/null 2>&1; then
  # Kubernetes uses containerd's k8s.io namespace, not nerdctl's default one.
  container_pull() { container_with_auth nerdctl --namespace k8s.io pull "$1"; }
  container_image_exists() { nerdctl --namespace k8s.io image inspect "$1" >/dev/null 2>&1; }
  container_create() { nerdctl --namespace k8s.io create --name "$1" "$2" >/dev/null; }
  container_copy_from() { nerdctl --namespace k8s.io cp "$1:$2" "$3"; }
  container_remove() { nerdctl --namespace k8s.io rm -f "$1" >/dev/null 2>&1; }
elif command -v ctr >/dev/null 2>&1; then
  # ctr writes directly to the namespace used by Kubernetes on hosts without
  # nerdctl. Its pull path runs in the CLI process and honors proxy variables.
  container_pull() {
    if [[ -n "$CTR_REGISTRY_CREDENTIAL" ]]; then
      ctr --namespace k8s.io images pull --user "$CTR_REGISTRY_CREDENTIAL" "$1"
    else
      ctr --namespace k8s.io images pull "$1"
    fi
  }
  container_image_exists() { ctr --namespace k8s.io images ls -q | grep -Fx -- "$1" >/dev/null 2>&1; }
  container_create() {
    TEMPLATE_MOUNT_DIR="$(mktemp -d)"
    ctr --namespace k8s.io images mount "$2" "$TEMPLATE_MOUNT_DIR" >/dev/null
  }
  container_copy_from() { cp -a "$TEMPLATE_MOUNT_DIR$2" "$3"; }
  container_remove() {
    [[ -z "$TEMPLATE_MOUNT_DIR" ]] || ctr --namespace k8s.io images unmount "$TEMPLATE_MOUNT_DIR" >/dev/null 2>&1 || true
    [[ -z "$TEMPLATE_MOUNT_DIR" ]] || rmdir "$TEMPLATE_MOUNT_DIR" 2>/dev/null || true
    TEMPLATE_MOUNT_DIR=""
  }
elif command -v docker >/dev/null 2>&1; then
  container_pull() { container_with_auth docker pull "$1"; }
  container_image_exists() { docker image inspect "$1" >/dev/null 2>&1; }
  container_create() { docker create --name "$1" "$2" >/dev/null; }
  container_copy_from() { docker cp "$1:$2" "$3"; }
  container_remove() { docker rm -f "$1" >/dev/null 2>&1; }
else
  echo "neither docker nor nerdctl is available" >&2
  exit 2
fi

remote_ssh() {
  if [[ -n "$SSH_PASSWORD" ]]; then
    SSHPASS="$SSH_PASSWORD" sshpass -e ssh -n -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 -o LogLevel=ERROR "$@"
  else
    ssh -n -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 -o LogLevel=ERROR "$@"
  fi
}

prepare_registry_auth
trap cleanup EXIT

if container_image_exists "$IMAGE"; then
  echo "[pull] local: image already present"
else
  echo "[pull] local: pull $IMAGE"
  container_pull "$IMAGE"
fi

if [[ -z "${CHART_TEMPLATE_DIR:-}" && -z "${VALUES_TEMPLATE:-}" && -z "${ARCH_FILE:-}" ]]; then
  if container_image_exists "$TEMPLATE_IMAGE"; then
    echo "[pull] local template image already present"
  else
    echo "[pull] local: pull template image $TEMPLATE_IMAGE"
    container_pull "$TEMPLATE_IMAGE"
  fi
elif [[ -n "${CHART_TEMPLATE_DIR:-}" && -n "${VALUES_TEMPLATE:-}" && -n "${ARCH_FILE:-}" ]]; then
  echo "[pull] use caller-provided render templates"
else
  echo "CHART_TEMPLATE_DIR, VALUES_TEMPLATE, and ARCH_FILE must be set together" >&2
  exit 2
fi

if command -v python3 >/dev/null 2>&1; then
  while IFS=$'\t' read -r ip user; do
    [[ -n "$ip" ]] || continue
    echo "[pull] $ip: pull $IMAGE"
    remote_proxy_env=""
    for proxy_var in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY; do
      proxy_value="${!proxy_var:-}"
      [[ -n "$proxy_value" ]] || continue
      printf -v quoted_proxy_value '%q' "$proxy_value"
      remote_proxy_env+="${proxy_var}=${quoted_proxy_value} "
    done
    remote_auth_dir="/tmp/op-test-registry-auth-$$"
    remote_auth_setup=''
    remote_auth_cleanup=''
    remote_docker_pull="docker pull '$IMAGE'"
    remote_nerdctl_pull="nerdctl --namespace k8s.io pull '$IMAGE'"
    if [[ -n "$REGISTRY_AUTH_DIR" ]]; then
      auth_b64="$(base64 -w 0 "$REGISTRY_AUTH_DIR/config.json")"
      remote_auth_setup="umask 077; mkdir -p '$remote_auth_dir'; printf '%s' '$auth_b64' | base64 -d >'$remote_auth_dir/config.json'; "
      remote_auth_cleanup="; status=\$?; rm -rf '$remote_auth_dir'; exit \$status"
      remote_docker_pull="DOCKER_CONFIG='$remote_auth_dir' docker pull '$IMAGE'"
      remote_nerdctl_pull="DOCKER_CONFIG='$remote_auth_dir' nerdctl --namespace k8s.io pull '$IMAGE'"
    fi
    remote_pull="${remote_auth_setup}if command -v nerdctl >/dev/null 2>&1; then nerdctl --namespace k8s.io image inspect '$IMAGE' >/dev/null 2>&1 || $remote_nerdctl_pull; elif command -v docker >/dev/null 2>&1; then docker image inspect '$IMAGE' >/dev/null 2>&1 || $remote_docker_pull; else echo 'neither docker nor nerdctl is available' >&2; exit 2; fi${remote_auth_cleanup}"
    remote_ssh "$user@$ip" "${remote_proxy_env}${remote_pull}"
  done < <(python3 -c 'import json,sys
for host in json.loads(sys.argv[1]): print(host.get("ip", ""), host.get("user", "root"), sep="\t")' "$TARGET_HOSTS")
else
  echo "python3 is required to parse TARGET_HOSTS" >&2
  exit 2
fi

if [[ -z "${CHART_TEMPLATE_DIR:-}" ]]; then
  mkdir -p "$TEMPLATE_DIR"
  TEMPLATE_CONTAINER="op-test-template-$$"
  echo "[pull] export render templates from $TEMPLATE_IMAGE"
  container_create "$TEMPLATE_CONTAINER" "$TEMPLATE_IMAGE"
  container_copy_from "$TEMPLATE_CONTAINER" \
    /opt/op_test/xds_template/k8s/xds-cluster "$TEMPLATE_DIR/xds-cluster"
  container_copy_from "$TEMPLATE_CONTAINER" \
    /opt/op_test/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml \
    "$TEMPLATE_DIR/values-16Node-je-cpp-bnt3.yaml"
  container_copy_from "$TEMPLATE_CONTAINER" \
    /opt/op_test/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json \
    "$TEMPLATE_DIR/model_arch-lt-je-cpp-bnt3.json"
  container_remove "$TEMPLATE_CONTAINER"
  TEMPLATE_CONTAINER=""

  CHART_TEMPLATE_DIR="$TEMPLATE_DIR/xds-cluster"
  VALUES_TEMPLATE="$TEMPLATE_DIR/values-16Node-je-cpp-bnt3.yaml"
  ARCH_FILE="$TEMPLATE_DIR/model_arch-lt-je-cpp-bnt3.json"
fi

[[ -f "$CHART_TEMPLATE_DIR/Chart.yaml" ]] || { echo "chart export failed: $CHART_TEMPLATE_DIR" >&2; exit 2; }
[[ -f "$VALUES_TEMPLATE" ]] || { echo "values export failed: $VALUES_TEMPLATE" >&2; exit 2; }
[[ -f "$ARCH_FILE" ]] || { echo "architecture export failed: $ARCH_FILE" >&2; exit 2; }

printf 'RUN_DIR=%s\n' "$RUN_DIR"
printf 'CHART_TEMPLATE_DIR=%s\n' "$CHART_TEMPLATE_DIR"
printf 'VALUES_TEMPLATE=%s\n' "$VALUES_TEMPLATE"
printf 'ARCH_FILE=%s\n' "$ARCH_FILE"
printf 'DEPLOY_IMAGE=%s\n' "$IMAGE"
