#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/deploy-model.sh"

grep -Fq 'HEAD_LOG_ROOT="${HEAD_LOG_ROOT:-${RUN_DIR}/logs}"' "$script"
grep -Fq 'HEAD_LOG_DIR="${HEAD_LOG_DIR:-${HEAD_LOG_ROOT}/xds_head_follow_logs_${NAMESPACE}_$(date +%Y%m%d_%H%M%S)}"' "$script"

echo "deploy log-archive defaults tests passed"
