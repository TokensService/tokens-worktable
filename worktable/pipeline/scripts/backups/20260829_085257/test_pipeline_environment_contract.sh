#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pipeline="$script_dir/pipeline.sh"

[[ -x "$pipeline" ]] || { echo "pipeline.sh must exist and be executable" >&2; exit 1; }
grep -Fq 'bash "$SCRIPT_DIR/pull-image.sh"' "$pipeline"
grep -Fq 'bash "$SCRIPT_DIR/render-config.sh"' "$pipeline"
grep -Fq 'IMAGE_NAME' "$pipeline"
grep -Fq 'ARCH_NAME' "$pipeline"

for script in pull-image.sh render-config.sh deploy-model.sh register-model.sh model-health.sh; do
  if rg -n '^\s*(IMAGE|IMAGE_NAME|ARCH_NAME|MODEL_NAME|RUN_DIR|CHART_DIR|VALUES_FILE|ARCH_REQUEST_FILE|RESOURCE_MANIFEST|XDS_URL)=.*\$\{?1' "$script_dir/$script" ||
     rg -n '^\s*(case|shift\b|\[\[ \$#)' "$script_dir/$script"; then
    echo "$script must not use positional arguments for pipeline configuration" >&2
    exit 1
  fi
done

grep -Fq 'IMAGE_NAME="${IMAGE_NAME:?IMAGE_NAME is required}"' "$script_dir/pull-image.sh"
grep -Fq 'ARCH_NAME="${ARCH_NAME:?ARCH_NAME is required}"' "$script_dir/render-config.sh"
grep -Fq 'MODEL_NAME="${MODEL_NAME:-$ARCH_NAME}"' "$script_dir/register-model.sh"
grep -Fq 'TEMPLATE_VARS_JSON' "$script_dir/render-config.sh"
grep -Fq 'unresolved template placeholders' "$script_dir/render-config.sh"

echo "pipeline environment-contract tests passed"
