#!/usr/bin/env bash
# 健康检查脚本：探测目标服务
# 位置参数 $1 = 目标 IP（必填）
# 环境变量 PORT = 端口（默认 8080），FAIL = 置 1 时模拟失败（演示）
set -e
IP="${1:?需要目标 IP（位置参数 1）}"
PORT="${PORT:-8080}"
echo "[health] curl http://$IP:$PORT/healthz"
if [ "${FAIL:-0}" = "1" ]; then
  echo "[health] ERROR: health check failed on $IP:$PORT" >&2
  exit 1
fi
echo "[health] OK $IP:$PORT is healthy"
