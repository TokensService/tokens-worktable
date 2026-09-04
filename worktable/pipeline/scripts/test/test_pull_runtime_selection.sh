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
grep -Fq 'cp -a "$VALUES_TEMPLATE_SOURCE" "$work_dir/values-16Node-je-cpp-bnt3.yaml"' "$script"
grep -Fq 'if [[ -n "$VALUES_TEMPLATE_SOURCE" ]]; then' "$script"
grep -q '/opt/op_test/xds_template/k8s/xds-cluster' "$script"
grep -q '/opt/op_test/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml' "$script"
grep -q '/opt/op_test/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json' "$script"
grep -Fq 'TEMPLATE_IMAGE="${TEMPLATE_IMAGE:-$IMAGE}"' "$script"
if grep -Eq 'sshpass|ssh |TARGET_HOSTS|command -v (ctr|docker)|ctr --namespace|docker (image|create|cp|rm)' "$script"; then
  echo 'pull and template export must run locally without remote or runtime fallbacks' >&2
  exit 1
fi

echo "pull runtime-selection tests passed"
