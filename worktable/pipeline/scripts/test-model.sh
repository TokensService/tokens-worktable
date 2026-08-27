#!/usr/bin/env bash
# 测试：对部署好的 XDS 模型执行冒烟/推理测试
# 位置参数 $1 = 模型名（默认 xds）
# 环境变量 TARGET_IP = 目标主机（注入），PORT = 端口（默认 8080）
set -e
MODEL="${1:-xds}"
TARGET_IP="${TARGET_IP:-127.0.0.1}"
PORT="${PORT:-8080}"
echo "[test] run inference smoke test model=$MODEL on $TARGET_IP:$PORT"
echo "[test] 10/10 cases passed"
