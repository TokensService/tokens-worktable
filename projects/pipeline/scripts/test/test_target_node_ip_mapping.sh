#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
page="$repo_root/projects/pipeline/pipeline.html"
server="$repo_root/lib/index.js"
[[ -f "$page" ]] || page="$repo_root/worktable/pipeline/pipeline.html"
[[ -f "$server" ]] || server="$repo_root/dsh-plugins/dsh-worktable/lib/index.js"

# Every selected environment can provide a Kubernetes InternalIP distinct from
# its SSH endpoint, and both browser and server-stage execution inject it.
grep -Fq 'nodeIp:e.nodeIp||' "$page"
grep -Fq 'TARGET_NODE_IP_MAP' "$page"
grep -Fq 'TARGET_NODE_IP_MAP' "$server"
grep -Fq 'if (e.ip && e.nodeIp) nodeIpMap[e.ip] = e.nodeIp;' "$server"
grep -Fq 'resolve_target_node_ip_map()' "$repo_root/worktable/pipeline/scripts/pull_render_config.sh" 2>/dev/null || grep -Fq 'resolve_target_node_ip_map()' "$repo_root/projects/pipeline/scripts/pull_render_config.sh"

scripts_root="$repo_root/projects/pipeline/scripts"
[[ -d "$scripts_root" ]] || scripts_root="$repo_root/worktable/pipeline/scripts"
render_script="$scripts_root/pull_render_config.sh"
image_script="$scripts_root/pull-image.sh"
grep -Fq 'PULL_TARGET_IMAGES_ONLY=1 bash "$SCRIPT_DIR/pull-image.sh"' "$render_script"
grep -Fq 'if [[ "${PULL_TARGET_IMAGES_ONLY:-0}" == "1" ]]; then' "$image_script"

echo 'target node-IP mapping injection tests passed'
