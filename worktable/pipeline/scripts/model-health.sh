#!/usr/bin/env bash
# 模型健康检查：探测模型服务是否就绪
# 环境变量 TARGET_IP = 目标主机（注入），PORT = 端口（默认 8080），FAIL = 置 1 模拟失败
set -e
TARGET_IP="${TARGET_IP:?需要 TARGET_IP（在环境配置里选择目标节点）}"
PORT="${PORT:-8080}"
echo "[health] curl http://$TARGET_IP:$PORT/healthz"
if [ "${FAIL:-0}" = "1" ]; then
  echo "[health] ERROR: model not healthy on $TARGET_IP:$PORT" >&2
  exit 1
fi
echo "[health] model is healthy on $TARGET_IP:$PORT"
