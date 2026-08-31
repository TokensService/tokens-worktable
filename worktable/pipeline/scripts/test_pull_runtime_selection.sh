#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pull-image.sh"

# Hosts without Docker must pull into Kubernetes' containerd namespace.
grep -q 'nerdctl --namespace k8s.io' "$script"
grep -q 'command -v ctr' "$script"
grep -q 'ctr --namespace k8s.io images pull' "$script"
grep -q 'command -v docker' "$script"
grep -q 'command -v nerdctl' "$script"
grep -q 'image inspect' "$script"
grep -q 'REGISTRY_USERNAME' "$script"
grep -q 'REGISTRY_PASSWORD' "$script"
grep -q 'sshpass -e ssh -n' "$script"
grep -q 'http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY' "$script"
grep -Fq 'IMAGE_NAME="${IMAGE_NAME:-${DEPLOY_IMAGE:-myapp}}"' "$script"
grep -Fq 'TARGET_HOSTS="${TARGET_HOSTS:-[]}"' "$script"
grep -Fq 'SSH_PASSWORD="${SSH_PASSWORD:-${TARGET_PASSWORD:-}}"' "$script"
grep -Fq 'REGISTRY_USERNAME="${REGISTRY_USERNAME:-}"' "$script"
grep -Fq 'REGISTRY_PASSWORD="${REGISTRY_PASSWORD:-}"' "$script"
grep -Fq '[pull] registry credentials are incomplete; pulling without explicit credentials' "$script"
grep -q 'container_create' "$script"
grep -q 'container_copy_from' "$script"
grep -q '/opt/op_test/xds_template/k8s/xds-cluster' "$script"
grep -q '/opt/op_test/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml' "$script"
grep -q '/opt/op_test/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json' "$script"
grep -Fq 'TEMPLATE_IMAGE="${TEMPLATE_IMAGE:-$IMAGE}"' "$script"
grep -Fq 'container_create "$TEMPLATE_CONTAINER" "$TEMPLATE_IMAGE"' "$script"
nerdctl_line="$(grep -n 'if command -v nerdctl' "$script" | head -n1 | cut -d: -f1)"
docker_line="$(grep -n 'elif command -v docker' "$script" | head -n1 | cut -d: -f1)"
[[ -n "$nerdctl_line" && -n "$docker_line" && "$nerdctl_line" -lt "$docker_line" ]]

echo "pull runtime-selection tests passed"
