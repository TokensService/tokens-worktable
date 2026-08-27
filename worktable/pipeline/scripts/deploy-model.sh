#!/usr/bin/env bash
# 部署模型：把 XDS 模型部署到目标主机
# 位置参数 $1 = 模型名（默认 xds）
# 环境变量 TARGET_IP / TARGET_USER / TARGET_PASSWORD = 目标机连接信息（注入）
set -e
MODEL="${1:-xds}"
TARGET_IP="${TARGET_IP:?需要 TARGET_IP（在环境配置里选择目标节点）}"
TARGET_USER="${TARGET_USER:-root}"
echo "[deploy] ssh $TARGET_USER@$TARGET_IP deploy model=$MODEL"
echo "[deploy] model $MODEL deployed on $TARGET_IP"
