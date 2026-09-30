#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pull_render_config.sh"

grep -Fq 'cleanup_render_images()' "$script"
grep -Fq 'nerdctl --namespace k8s.io image rm "$image"' "$script"

pull_line="$(grep -nF 'bash "$SCRIPT_DIR/pull-image.sh"' "$script" | head -1 | cut -d: -f1)"
cleanup_line="$(grep -nF 'cleanup_render_images' "$script" | tail -1 | cut -d: -f1)"
render_line="$(grep -nF 'bash "$SCRIPT_DIR/render-config.sh"' "$script" | head -1 | cut -d: -f1)"
[[ "$pull_line" -lt "$cleanup_line" ]]
[[ "$cleanup_line" -lt "$render_line" ]]

echo "pull-render image-cleanup tests passed"
