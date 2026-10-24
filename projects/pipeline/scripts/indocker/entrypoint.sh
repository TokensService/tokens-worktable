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
INDOCKER_PUSH_DIRECT="${INDOCKER_PUSH_DIRECT:-false}"

mkdir -p /var/lib/docker /var/run
INDOCKER_MAX_CONCURRENT_DOWNLOADS="${INDOCKER_MAX_CONCURRENT_DOWNLOADS:-6}"
[[ "$INDOCKER_MAX_CONCURRENT_DOWNLOADS" =~ ^[1-9][0-9]*$ ]] \
  || die "INDOCKER_MAX_CONCURRENT_DOWNLOADS must be a positive integer"
dockerd_args=(--host=unix:///var/run/docker.sock --data-root=/var/lib/docker
  --max-concurrent-downloads="$INDOCKER_MAX_CONCURRENT_DOWNLOADS")
if [[ -n "${INDOCKER_REGISTRY_MIRROR:-}" ]]; then
  dockerd_args+=(--registry-mirror="$INDOCKER_REGISTRY_MIRROR")
fi
echo '[indocker] starting inner dockerd'
dockerd "${dockerd_args[@]}" > /output/dockerd.log 2>&1 &
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
docker build --network="${BUILD_NETWORK:-host}" --provenance=false --sbom=false --file "$DOCKERFILE_PATH" --tag "$IMAGE_REF" "${build_args[@]}" "$BUILD_CONTEXT_PATH"
docker image inspect "$IMAGE_REF" >/dev/null || die "built image is missing"
if [[ "$INDOCKER_PUSH_DIRECT" == true ]]; then
  [[ -n "${SWR_REGISTRY:-}" ]] || die "SWR_REGISTRY is required for direct push"
  [[ -n "${SWR_USERNAME:-}" ]] || die "SWR_USERNAME is required for direct push"
  [[ -n "${SWR_PASSWORD:-}" ]] || die "SWR_PASSWORD is required for direct push"
  [[ "$IMAGE_REF" == "$SWR_REGISTRY/"* ]] || die "IMAGE_REF must use SWR_REGISTRY: $SWR_REGISTRY"
  printf '%s' "$SWR_PASSWORD" | docker login "$SWR_REGISTRY" --username "$SWR_USERNAME" --password-stdin
  docker push "$IMAGE_REF"
  printf '%s\n' "$IMAGE_REF" > "$OUTPUT_DIR/image-ref"
  echo "[indocker] pushed ${IMAGE_REF}"
  exit 0
fi
OUTPUT_ARCHIVE="${OUTPUT_ARCHIVE:-$OUTPUT_DIR/vllm-image.tar}"
docker save --output "$OUTPUT_ARCHIVE" "$IMAGE_REF"
[[ -s "$OUTPUT_ARCHIVE" ]] || die "docker save produced an empty archive"
printf '%s\n' "$IMAGE_REF" > "$OUTPUT_DIR/image-ref"
echo '[indocker] image archive ready'
