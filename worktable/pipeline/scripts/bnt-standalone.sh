#!/usr/bin/env bash
# 兼容旧入口：默认仅清理；ACTION=check-health 转发至只读检查脚本。
# 单文件远程执行请直接使用 cleanup-env.sh 或 check-env.sh。
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ACTION="${ACTION:-standardize}"
if [[ "$ACTION" == check-health ]]; then
    exec bash "$SCRIPT_DIR/check-env.sh" "$@"
else
    exec bash "$SCRIPT_DIR/cleanup-env.sh" "$@"
fi
