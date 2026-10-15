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
docker build --network="${BUILD_NETWORK:-host}" --provenance=false --sbom=false --file "$DOCKERFILE_PATH" --tag "$IMAGE_REF" "${build_args[@]}" "$BUILD_CONTEXT_PATH"
docker image inspect "$IMAGE_REF" >/dev/null || die "built image is missing"
OUTPUT_ARCHIVE="${OUTPUT_ARCHIVE:-$OUTPUT_DIR/vllm-image.tar}"
docker save --output "$OUTPUT_ARCHIVE" "$IMAGE_REF"
[[ -s "$OUTPUT_ARCHIVE" ]] || die "docker save produced an empty archive"
printf '%s\n' "$IMAGE_REF" > "$OUTPUT_DIR/image-ref"
echo '[indocker] image archive ready'
