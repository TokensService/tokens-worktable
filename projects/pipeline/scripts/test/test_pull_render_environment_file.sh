#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pull_render_config.sh"

grep -Fq '|| PIPELINE_ENV_FILE="${RUN_DIR}/pipeline.env"' "$script"
grep -Fq 'write_pipeline_env()' "$script"
grep -Fq 'export %s=%q' "$script"

grep -Fq 'AK="${AK:-}"' "$script"
grep -Fq 'LOGKEY="${LOGKEY:-${LOGIN_KEY:-}}"' "$script"
grep -Fq 'SWR_PROJECT="${SWR_PROJECT:-}"' "$script"
grep -Fq 'SWR_PROJECT="${SWR_PROJECT:-cn-southwest-2}"' "$script"
grep -Fq 'REGISTRY="${REGISTRY:-swr.cn-southwest-2.myhuaweicloud.com}"' "$script"
grep -Fq 'AK LOGKEY LOGIN_KEY SWR_PROJECT REGISTRY' "$script"

# Registry credentials must remain process-only and never be written to either
# environment file consumed by later pipeline stages.
if sed -n '/write_pipeline_env()/,/^}/p; /write_target_pipeline_env()/,/^}/p' "$script" | grep -Eq 'AK|LOGKEY|LOGIN_KEY|SWR_PROJECT|REGISTRY'; then
  echo 'registry credentials must not be serialized into pipeline environment files' >&2
  exit 1
fi

for variable in IMAGE_NAME DEPLOY_IMAGE ARCH_NAME PIPELINE_NAME RUN_DIR RENDER_DIR CHART_DIR VALUES_FILE ARCH_REQUEST_FILE RESOURCE_MANIFEST NODE_LABELS_FILE NAMESPACE RELEASE_NAME PIPELINE_ENV_FILE MOCK_DB XDS_DATABASE_NAME XDS_DATABASE_PORT XDS_DATABASE_USERNAME XDS_DATABASE_PASSWORD EMS_LOG_SYNC_INTERVAL_SECONDS EMS_LOG_SOURCE_DIR EMS_LOG_CONTAINER; do
  grep -qw "$variable" "$script"
done

echo "pull-render environment-file tests passed"

# Template export is performed by a child script, so the execution-host
# contract must retain those paths. Both contracts retain target paths.
local_writer="$(sed -n '/write_pipeline_env()/,/^}/p' "$script")"
target_writer="$(sed -n '/write_target_pipeline_env()/,/^}/p' "$script")"
for variable in CHART_TEMPLATE_DIR VALUES_TEMPLATE ARCH_FILE; do
  grep -qw "$variable" <<<"$local_writer" || {
    echo "$variable missing from local pipeline environment" >&2
    exit 1
  }
done
for variable in TARGET_RUN_DIR TARGET_RENDER_DIR TARGET_PIPELINE_ENV_FILE MOCK_DB XDS_DATABASE_NAME XDS_DATABASE_PORT XDS_DATABASE_USERNAME XDS_DATABASE_PASSWORD EMS_LOG_SYNC_INTERVAL_SECONDS EMS_LOG_SOURCE_DIR EMS_LOG_CONTAINER; do
  grep -qw "$variable" <<<"$local_writer" || {
    echo "$variable missing from local pipeline environment" >&2
    exit 1
  }
  grep -qw "$variable" <<<"$target_writer" || {
    echo "$variable missing from target pipeline environment" >&2
    exit 1
  }
done
