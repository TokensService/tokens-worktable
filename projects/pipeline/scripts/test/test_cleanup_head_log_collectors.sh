#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/cleanup-env.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
source <(sed '/^main "\$@"$/d' "$script")
LOG_FILE="$tmp/cleanup.log"
DRY_RUN=0

ps() {
  cat <<'PS'
  PID COMMAND
  101 bash /tmp/op-test-pipeline/demo/scripts/follow-xds-head-logs.sh xds-old /tmp/op-test-pipeline/demo/logs/xds_head_follow_logs_xds-old
  102 bash /opt/other.sh
  103 bash /tmp/op-test-pipeline/demo/scripts/follow-xds-head-logs.sh xds-other /tmp/op-test-pipeline/demo/logs/xds_head_follow_logs_xds-other
PS
}
kill() {
  printf '%s\n' "$*" >>"$tmp/kills"
  return 0
}
sleep() { :; }

stop_stale_head_log_collectors

grep -qx -- '-TERM 101' "$tmp/kills"
grep -qx -- '-TERM 103' "$tmp/kills"
if grep -q 102 "$tmp/kills"; then
  echo 'unrelated process was killed' >&2
  exit 1
fi
grep -Fq '停止历史 XDS Head 日志采集进程: pid=101' "$LOG_FILE"
grep -Fq '停止历史 XDS Head 日志采集进程: pid=103' "$LOG_FILE"
echo 'cleanup stale head-log collector test passed'
