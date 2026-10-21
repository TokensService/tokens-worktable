#!/usr/bin/env bash
set -Eeuo pipefail

OUTPUT_DIR=/output
mkdir -p "$OUTPUT_DIR"
LOG_FILE="$OUTPUT_DIR/build.log"
exec > >(tee -a "$LOG_FILE") 2>&1

die() { echo "[indocker] ERROR: $*" >&2; exit 1; }

IMAGE_REF="${IMAGE_REF:?IMAGE_REF is required}"
SOURCE_DIR="${SOURCE_DIR:-/workspace/source}"
DOCKERFILE_PATH="${DOCKERFILE_PATH:-$SOURCE_DIR/docker/Dockerfile}"
BUILD_CONTEXT_PATH="${BUILD_CONTEXT_PATH:-$SOURCE_DIR}"
DOCKERD_TIMEOUT_SECONDS="${DOCKERD_TIMEOUT_SECONDS:-120}"
BUILD_CPUS="${BUILD_CPUS:-}"
SWR_REGISTRY="${SWR_REGISTRY:?SWR_REGISTRY is required}"
SWR_CREDENTIALS_FILE="${SWR_CREDENTIALS_FILE:-/output/.swr-credentials}"

mkdir -p /var/lib/docker /var/run
echo '[indocker] starting inner dockerd'
dockerd --host=unix:///var/run/docker.sock --data-root=/var/lib/docker > /output/dockerd.log 2>&1 &
dockerd_pid=$!
trap 'kill "$dockerd_pid" 2>/dev/null || true' EXIT

ready=0
for ((i=1; i<=DOCKERD_TIMEOUT_SECONDS; i++)); do
  if docker info >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
((ready == 1)) || { cat /output/dockerd.log >&2 || true; die "inner dockerd not ready"; }

build_args=()
while IFS= read -r arg; do
  [[ -z "$arg" ]] && continue
  [[ "$arg" == *=* ]] || die "invalid BUILD_ARGS_TEXT entry"
  build_args+=(--build-arg "$arg")
done <<< "${BUILD_ARGS_TEXT:-}"

echo "[indocker] building ${IMAGE_REF}"
cpu_args=()
if [[ "$BUILD_CPUS" =~ ^[1-9][0-9]*$ ]]; then
  cpu_args=(--cpu-period=100000 --cpu-quota=$((BUILD_CPUS * 100000)))
fi
docker build --network="${BUILD_NETWORK:-host}" "${cpu_args[@]}" --provenance=false --sbom=false --file "$DOCKERFILE_PATH" --tag "$IMAGE_REF" "${build_args[@]}" "$BUILD_CONTEXT_PATH"
docker image inspect "$IMAGE_REF" >/dev/null || die "built image is missing"

[[ -r "$SWR_CREDENTIALS_FILE" ]] || die "SWR credentials file is missing"
mapfile -t swr_credentials < "$SWR_CREDENTIALS_FILE"
((${#swr_credentials[@]} == 2)) || die "SWR credentials file must contain username and password"
SWR_USERNAME="${swr_credentials[0]}"
SWR_PASSWORD="${swr_credentials[1]}"
[[ -n "$SWR_USERNAME" && -n "$SWR_PASSWORD" ]] || die "SWR username/password must not be empty"
unset swr_credentials

rm -f "$OUTPUT_DIR/push-success"
echo "[indocker] logging in to ${SWR_REGISTRY}"
printf '%s' "$SWR_PASSWORD" | docker login "$SWR_REGISTRY" --username "$SWR_USERNAME" --password-stdin
unset SWR_PASSWORD
echo "[indocker] pushing ${IMAGE_REF}"
docker push "$IMAGE_REF"
docker logout "$SWR_REGISTRY" >/dev/null 2>&1 || true
printf '%s\n' "$IMAGE_REF" > "$OUTPUT_DIR/push-success"
echo "[indocker] image pushed: ${IMAGE_REF}"
