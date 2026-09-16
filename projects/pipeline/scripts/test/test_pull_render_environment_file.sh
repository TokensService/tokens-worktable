#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pull_render_config.sh"

grep -Fq '|| PIPELINE_ENV_FILE="${RUN_DIR}/pipeline.env"' "$script"
grep -Fq 'write_pipeline_env()' "$script"
grep -Fq 'export %s=%q' "$script"

for variable in IMAGE_NAME DEPLOY_IMAGE ARCH_NAME PIPELINE_NAME RUN_DIR RENDER_DIR CHART_DIR VALUES_FILE ARCH_REQUEST_FILE RESOURCE_MANIFEST NODE_LABELS_FILE NAMESPACE RELEASE_NAME PIPELINE_ENV_FILE MOCK_DB XDS_DATABASE_NAME XDS_DATABASE_PORT XDS_DATABASE_USERNAME XDS_DATABASE_PASSWORD LMCACHE_L2_ENABLED LMCACHE_L2_HOST_PATH LMCACHE_L2_MOUNT_PATH LMCACHE_L2_MAX_CAPACITY_GB LMCACHE_L2_NUM_WORKERS LMCACHE_L2_USE_ODIRECT; do
  grep -qw "$variable" "$script"
done

echo "pull-render environment-file tests passed"
