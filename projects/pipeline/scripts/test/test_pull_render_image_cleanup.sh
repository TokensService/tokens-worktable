#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pull_render_config.sh"

# Rendering is performed on the target host; the execution host must not pull,
# remove, or prune deployment images as part of this stage.
if grep -Fq 'cleanup_render_images' "$script"; then
  echo 'execution-host image cleanup must not be part of remote rendering' >&2
  exit 1
fi
if grep -Fq 'trap cleanup_render_images EXIT' "$script"; then
  echo 'remote rendering must not install a local image cleanup trap' >&2
  exit 1
fi
grep -Fq 'render_on_first_target()' "$script"
grep -Fq 'bash $(remote_quote "${target_script_dir}/pull-image.sh")' "$script"
grep -Fq 'bash $(remote_quote "${target_script_dir}/render-config.sh")' "$script"

echo "pull-render remote-render tests passed"
