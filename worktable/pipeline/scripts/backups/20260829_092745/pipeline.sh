#!/usr/bin/env bash
# Prepare one deployment contract: pre-pull the image, then render templates.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${IMAGE_NAME:?IMAGE_NAME is required}"
ARCH_NAME="${ARCH_NAME:?ARCH_NAME is required}"
PIPELINE_NAME="${PIPELINE_NAME:-xds-${ARCH_NAME}}"
RUN_DIR="${RUN_DIR:-/tmp/${PIPELINE_NAME}-$(date +%Y%m%d_%H%M%S)}"
DEPLOY_IMAGE="${DEPLOY_IMAGE:-$IMAGE_NAME}"

export IMAGE_NAME ARCH_NAME PIPELINE_NAME RUN_DIR DEPLOY_IMAGE

echo "[pipeline] image=$IMAGE_NAME arch=$ARCH_NAME run_dir=$RUN_DIR"
bash "$SCRIPT_DIR/pull-image.sh"
bash "$SCRIPT_DIR/render-config.sh"
