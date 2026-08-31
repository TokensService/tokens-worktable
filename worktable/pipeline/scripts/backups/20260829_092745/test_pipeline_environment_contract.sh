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
grep -Fq 'NODE_SELECTOR_KEY="${NODE_SELECTOR_KEY:-xds.optest}"' "$script_dir/render-config.sh"
grep -Fq 'node_selector_value = "node-" + "-".join' "$script_dir/render-config.sh"
grep -Fq 'NODE_LABELS_FILE' "$script_dir/render-config.sh"
grep -Fq 'NODE_LABELS_FILE' "$script_dir/deploy-model.sh"
grep -Fq '"$KUBECTL_BIN" label node' "$script_dir/deploy-model.sh"

collector="$script_dir/follow-xds-head-logs.sh"
[[ -x "$collector" ]] || { echo "follow-xds-head-logs.sh must exist and be executable" >&2; exit 1; }
grep -Fq 'logs -f "$head" -c ray-head --timestamps' "$collector"
grep -Fq 'HEAD_LOG_ROOT' "$script_dir/deploy-model.sh"
grep -Fq '"$SCRIPT_DIR/follow-xds-head-logs.sh" "$NAMESPACE" "$HEAD_LOG_DIR"' "$script_dir/deploy-model.sh"

helm_line="$(grep -nE '^wait_for_xds_api$' "$script_dir/deploy-model.sh" | cut -d: -f1)"
collector_line="$(grep -nF 'follow-xds-head-logs.sh' "$script_dir/deploy-model.sh" | tail -1 | cut -d: -f1)"
[[ "$collector_line" -lt "$helm_line" ]] || {
  echo "head log collector must start before XDS readiness wait" >&2
  exit 1
}

echo "pipeline environment-contract tests passed"
