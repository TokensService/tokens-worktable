#!/usr/bin/env bash
# watchdog-bridge.sh — jenkins-bridge 守护（幂等，可每分钟执行 / 开机自启）
# 逻辑：桥接端口 28081 未监听时，基于项目内的 jenkins-bridge.js 重新拉起。
set -u
DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
BRIDGE="$DIR/jenkins-bridge.js"
PIDFILE="$DIR/bridge.pid"
LOG="$DIR/bridge.log"
NODE="${NODE:-/usr/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node || true)"

# 端口探活（ss 优先，netstat 兜底）
port_alive() {
  { ss -tln 2>/dev/null || true; } | grep -q ':28081 ' && return 0
  { netstat -tln 2>/dev/null || true; } | grep -q ':28081 ' && return 0
  return 1
}

if port_alive; then exit 0; fi

# 端口不在：若记录的 pid 还存在则先清理，再重新拉起
if [ -f "$PIDFILE" ]; then
  OLD=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then kill "$OLD" 2>/dev/null; sleep 0.5; fi
  rm -f "$PIDFILE"
fi

BRIDGE_REWRITE="http://7.150.11.246:8080" nohup "$NODE" "$BRIDGE" >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
echo "[watchdog] $(date '+%F %T') bridge restarted pid=$!" >> "$LOG"