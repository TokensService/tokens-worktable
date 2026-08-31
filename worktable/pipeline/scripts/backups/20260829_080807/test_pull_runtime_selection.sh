#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pull-image.sh"

# Hosts without Docker must pull into Kubernetes' containerd namespace.
grep -q 'nerdctl --namespace k8s.io' "$script"
grep -q 'command -v docker' "$script"
grep -q 'command -v nerdctl' "$script"
grep -q 'image inspect' "$script"
grep -q 'REGISTRY_SECRET_NAMESPACE' "$script"
grep -q 'REGISTRY_SECRET_NAME' "$script"
grep -q 'dockerconfigjson' "$script"
grep -q 'sshpass -e ssh -n' "$script"
grep -q 'IMAGE_NAME is required' "$script"
grep -q 'SSH_PASSWORD or TARGET_PASSWORD is required' "$script"
grep -q 'TARGET_HOSTS is required' "$script"
grep -q 'REGISTRY_SECRET_NAMESPACE is required' "$script"
if grep -q 'container_create' "$script"; then
  echo "image-only script must not create a container" >&2
  exit 1
fi
nerdctl_line="$(grep -n 'if command -v nerdctl' "$script" | head -n1 | cut -d: -f1)"
docker_line="$(grep -n 'elif command -v docker' "$script" | head -n1 | cut -d: -f1)"
[[ -n "$nerdctl_line" && -n "$docker_line" && "$nerdctl_line" -lt "$docker_line" ]]

echo "pull runtime-selection tests passed"
