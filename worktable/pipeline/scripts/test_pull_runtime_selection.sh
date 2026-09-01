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
grep -q 'sshpass -e ssh -o StrictHostKeyChecking=no' "$script"
grep -Fq 'export http_proxy=%q https_proxy=%q HTTP_PROXY=%q HTTPS_PROXY=%q' "$script"
grep -Fq 'IMAGE_NAME="${IMAGE_NAME:-${DEPLOY_IMAGE:-myapp}}"' "$script"
grep -Fq 'TARGET_HOSTS="${TARGET_HOSTS:-[]}"' "$script"
grep -Fq 'PULL_PROXY="${PULL_PROXY:-}"' "$script"
grep -Fq 'PULL_NO_PROXY="${PULL_NO_PROXY:-}"' "$script"
grep -Fq 'SSH_PASSWORD="${SSH_PASSWORD:-${TARGET_PASSWORD:-}}"' "$script"
grep -Fq 'CONTROL_HOST="${CONTROL_HOST:-}"' "$script"
grep -Fq 'select_control_target' "$script"
grep -Fq 'CONTROL_HOST must match an entry in TARGET_HOSTS' "$script"
grep -Fq 'remote_bash' "$script"
grep -Fq 'REGISTRY_USERNAME="${REGISTRY_USERNAME:-}"' "$script"
grep -Fq 'REGISTRY_PASSWORD="${REGISTRY_PASSWORD:-}"' "$script"
grep -Fq 'REGISTRY_SECRET_NAMESPACE="${REGISTRY_SECRET_NAMESPACE:-default}"' "$script"
grep -Fq 'REGISTRY_SECRET_NAME="${REGISTRY_SECRET_NAME:-xds-swr-credentials}"' "$script"
grep -Fq 'VALUES_TEMPLATE_SOURCE="${VALUES_TEMPLATE_SOURCE:-}"' "$script"
grep -Fq 'kubectl -n "$REGISTRY_SECRET_NAMESPACE" get secret "$REGISTRY_SECRET_NAME"' "$script"
grep -Fq 'env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY kubectl' "$script"
grep -Fq 'pull_image_on_target' "$script"
grep -Fq 'registry Secret $REGISTRY_SECRET_NAMESPACE/$REGISTRY_SECRET_NAME must contain non-empty username and password data keys' "$script"
if grep -Fq 'load_registry_credentials_from_secret' "$script"; then
  echo 'registry credentials must be read on target nodes' >&2
  exit 1
fi
grep -Fq 'write_remote_context' "$script"
grep -Fq 'PULL_NO_PROXY="${PULL_NO_PROXY:-}"' "$script"
grep -Fq 'remote_bash "$user@$ip"' "$script"
grep -Fq 'export_templates_from_control_target' "$script"
grep -Fq 'tar -C "$TEMPLATE_DIR" -xf -' "$script"
grep -Fq 'nerdctl --namespace k8s.io create --net=none' "$script"
grep -Fq 'cp -a "$VALUES_TEMPLATE_SOURCE" "$work_dir/values-16Node-je-cpp-bnt3.yaml"' "$script"
grep -Fq 'if [[ -n "$VALUES_TEMPLATE_SOURCE" ]]; then' "$script"
grep -q '/opt/op_test/xds_template/k8s/xds-cluster' "$script"
grep -q '/opt/op_test/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml' "$script"
grep -q '/opt/op_test/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json' "$script"
grep -Fq 'TEMPLATE_IMAGE="${TEMPLATE_IMAGE:-$IMAGE}"' "$script"
nerdctl_line="$(grep -n 'if command -v nerdctl' "$script" | head -n1 | cut -d: -f1)"
docker_line="$(grep -n 'elif command -v docker' "$script" | head -n1 | cut -d: -f1)"
[[ -n "$nerdctl_line" && -n "$docker_line" && "$nerdctl_line" -lt "$docker_line" ]]

echo "pull runtime-selection tests passed"
