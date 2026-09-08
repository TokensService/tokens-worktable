#!/usr/bin/env bash
# pipeline: no-positional-args
# 兼容旧入口：默认仅清理；ACTION=check-health 转发至只读检查脚本。
# 单文件远程执行请直接使用 cleanup-env.sh 或 check-env.sh。
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ACTION="${ACTION:-standardize}"
if [[ "$ACTION" == check-health ]]; then
    ENTRY_SCRIPT="$SCRIPT_DIR/check-env.sh"
else
    ENTRY_SCRIPT="$SCRIPT_DIR/cleanup-env.sh"
fi
# 子入口负责多目标遍历；三份脚本应一起更新，避免继续使用旧版清理逻辑。
[[ -f "$ENTRY_SCRIPT" ]] || { echo "ERROR: 缺少 $ENTRY_SCRIPT，请同步更新 bnt-standalone.sh、cleanup-env.sh、check-env.sh" >&2; exit 1; }
# 入口不接收 stdin 数据，防止远程命令继承调用方的目标列表。
exec bash "$ENTRY_SCRIPT" "$@" </dev/null
