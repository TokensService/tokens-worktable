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

echo 'target node-IP mapping injection tests passed'
