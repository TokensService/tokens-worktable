#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/deploy-model.sh"

# The execution-host collector is an archive artifact.  Its default must be
# rooted at ARCHIVE_DIR rather than the temporary RUN_DIR workspace.
grep -Fq 'ARCHIVE_DIR="${ARCHIVE_DIR:-${PWD}/archive}"' "$script"
grep -Fq 'HEAD_LOG_ROOT="${HEAD_LOG_ROOT:-${ARCHIVE_DIR}}"' "$script"
grep -Fq 'HEAD_LOG_DIR="${HEAD_LOG_DIR:-${HEAD_LOG_ROOT}/xds_head_follow_logs_${NAMESPACE}_$(date +%Y%m%d_%H%M%S)}"' "$script"
# A delegated deployment must retain the target-host collector from the
# backup while the execution host runs its own SSH-backed collector.
grep -Fq 'remote_head_log_root="${TARGET_RUN_DIR}/logs"' "$script"
grep -Fq 'sync_remote_file "$SCRIPT_DIR/follow-xds-head-logs.sh"' "$script"
grep -Fq 'export TARGET_HEAD_LOG_DIR=%q' "$script"
grep -Fq 'export TARGET_HEAD_LOG_COLLECTOR_PID=%q' "$script"

echo "deploy log-archive defaults tests passed"
