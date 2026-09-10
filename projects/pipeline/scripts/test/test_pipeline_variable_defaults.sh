#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pull_render_config.sh"

for variable in PIPELINE_NAME RUN_DIR RENDER_DIR DEPLOY_IMAGE NAMESPACE RELEASE_NAME \
  CHART_DIR VALUES_FILE ARCH_REQUEST_FILE RESOURCE_MANIFEST NODE_LABELS_FILE \
  TARGET_RUN_DIR TARGET_RENDER_DIR TARGET_PIPELINE_ENV_FILE PIPELINE_ENV_FILE; do
  grep -Fq "${variable}=\"\${${variable}:-}\"" "$script"
done

if grep -Eq '=\"\$\{[A-Z_][A-Z0-9_]*:-[^}]*\$\{' "$script"; then
  echo 'pipeline entrypoint must not use nested parameter defaults' >&2
  exit 1
fi

grep -Fq 'contains_unexpanded_placeholder' "$script"
grep -Fq '|| RUN_DIR="/tmp/${PIPELINE_NAME}-$(date +%Y%m%d_%H%M%S)"' "$script"
grep -Fq '|| RENDER_DIR="${RUN_DIR}/rendered"' "$script"

config="$(sed -n '/^contains_unexpanded_placeholder()/,/^export IMAGE_NAME/{ /^export IMAGE_NAME/q; p; }' "$script")"
resolved="$(ARCH_NAME='test-arch' \
  PIPELINE_NAME='${PIPELINE_NAME' \
  RUN_DIR='/tmp/${PIPELINE_NAME' \
  RENDER_DIR='${RUN_DIR' \
  TARGET_RUN_DIR='/tmp/${PIPELINE_NAME' \
  TARGET_RENDER_DIR='${TARGET_RUN_DIR' \
  TARGET_PIPELINE_ENV_FILE='${TARGET_RUN_DIR' \
  PIPELINE_ENV_FILE='${RUN_DIR' \
  bash -c "$config
printf 'PIPELINE_NAME=%s\\nRUN_DIR=%s\\nRENDER_DIR=%s\\nTARGET_RUN_DIR=%s\\nTARGET_RENDER_DIR=%s\\nTARGET_PIPELINE_ENV_FILE=%s\\nPIPELINE_ENV_FILE=%s\\n' \"\$PIPELINE_NAME\" \"\$RUN_DIR\" \"\$RENDER_DIR\" \"\$TARGET_RUN_DIR\" \"\$TARGET_RENDER_DIR\" \"\$TARGET_PIPELINE_ENV_FILE\" \"\$PIPELINE_ENV_FILE\"")"
if grep -Fq '${' <<<"$resolved"; then
  echo 'unexpanded placeholder was not normalized' >&2
  exit 1
fi
grep -Fq 'PIPELINE_NAME=xds-test-arch' <<<"$resolved"
grep -Fq 'TARGET_RUN_DIR=/tmp/op-test-pipeline/xds-test-arch' <<<"$resolved"
grep -Fq 'TARGET_RENDER_DIR=/tmp/op-test-pipeline/xds-test-arch/rendered' <<<"$resolved"

namespace_resolved="$(ARCH_NAME='glm-5.2-nvfp4-one-node' \
  IMAGE_TAG='1043.ec96f' \
  bash -c "$config
printf 'NAMESPACE=%s\\nRELEASE_NAME=%s\\n' \"\$NAMESPACE\" \"\$RELEASE_NAME\"")"
grep -Fq 'NAMESPACE=xds-glm-5-2-nvfp4-one-node-1043-ec96f' <<<"$namespace_resolved"
grep -Fq 'RELEASE_NAME=xds-glm-5-2-nvfp4-one-node-1043-ec96f' <<<"$namespace_resolved"

# Both `arch` and EXECUTOR select a descriptive namespace. When either is
# absent, preserve the legacy ARCH_NAME behavior.
namespace_from_arch_executor="$(arch='runtime-arch' EXECUTOR='executor-a' ARCH_NAME='test-arch' IMAGE_TAG='1000.tag' bash -c "$config
printf 'NAMESPACE=%s\nRELEASE_NAME=%s\n' \"\$NAMESPACE\" \"\$RELEASE_NAME\"")"
grep -Fq 'NAMESPACE=xds-runtime-arch-executor-a-1000-tag' <<<"$namespace_from_arch_executor"
grep -Fq 'RELEASE_NAME=xds-runtime-arch-executor-a-1000-tag' <<<"$namespace_from_arch_executor"

namespace_without_arch="$(EXECUTOR='executor-a' ARCH_NAME='test-arch' IMAGE_TAG='1000.tag' bash -c "$config
printf 'NAMESPACE=%s\nRELEASE_NAME=%s\n' \"\$NAMESPACE\" \"\$RELEASE_NAME\"")"
grep -Fq 'NAMESPACE=xds-test-arch-1000-tag' <<<"$namespace_without_arch"

echo "pipeline variable-default tests passed"
