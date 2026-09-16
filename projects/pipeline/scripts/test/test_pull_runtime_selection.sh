#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pull-image.sh"

# The pipeline execution host uses nerdctl's persisted registry login.
grep -q 'nerdctl --namespace k8s.io' "$script"
grep -q 'command -v nerdctl' "$script"
grep -q 'image inspect' "$script"
grep -Fq 'IMAGE_NAME="${IMAGE_NAME:-${DEPLOY_IMAGE:-myapp}}"' "$script"
grep -Fq 'VALUES_TEMPLATE_SOURCE="${VALUES_TEMPLATE_SOURCE:-}"' "$script"
grep -Fq 'execution host: pull' "$script"
grep -Fq 'nerdctl is required on the pipeline execution host' "$script"
grep -Fq 'nerdctl --namespace k8s.io create --net=none' "$script"
grep -Fq 'cp -a "$VALUES_TEMPLATE_SOURCE" "$source_dir/values-16Node-je-cpp-bnt3.yaml"' "$script"
grep -Fq 'if [[ -n "$VALUES_TEMPLATE_SOURCE" ]]; then' "$script"
grep -Fq 'DEPLOY_TEMPLATE_DIR="${DEPLOY_TEMPLATE_DIR:-/opt/deploy_template}"' "$script"
grep -Fq 'FALLBACK_DEPLOY_TEMPLATE_DIR="${FALLBACK_DEPLOY_TEMPLATE_DIR:-/opt/op_test}"' "$script"
grep -Fq 'copy_template_set "$DEPLOY_TEMPLATE_DIR" "$source_dir"' "$script"
grep -Fq 'copy_template_set "$FALLBACK_DEPLOY_TEMPLATE_DIR" "$source_dir"' "$script"
grep -Fq 'TEMPLATE_IMAGE="${TEMPLATE_IMAGE:-$IMAGE}"' "$script"
if grep -Eq 'docker (image|create|cp|rm)' "$script"; then
  echo 'pull and template export must not fall back to docker' >&2
  exit 1
fi

grep -Fq 'pull_target_images "$IMAGE"' "$script"
grep -Fq 'TARGET_NODE_IP_MAP' "$script"
grep -Fq 'command -v ctr >/dev/null 2>&1' "$script"
grep -Fq 'sudo ctr -n k8s.io images pull --user' "$script"
grep -Fq 'AK and LOGIN_KEY are required' "$script"
grep -Fq 'sudo ctr -n k8s.io images ls -q' "$script"
grep -Fq 'target image already exists' "$script"

echo "pull runtime-selection tests passed"
