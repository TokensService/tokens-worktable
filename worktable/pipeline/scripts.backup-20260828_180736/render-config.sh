#!/usr/bin/env bash
# 模型部署配置渲染：根据模板与目标环境生成部署配置
# 位置参数 $1 = 模型名（默认 xds）
# 环境变量 TARGET_IP = 目标主机（注入），NAMESPACE = 命名空间（默认 default）
set -e
MODEL="${1:-xds}"
TARGET_IP="${TARGET_IP:-127.0.0.1}"
NAMESPACE="${NAMESPACE:-default}"
echo "[render] render deploy config for model=$MODEL target=$TARGET_IP ns=$NAMESPACE"
echo "[render] generated: deploy-$MODEL.yaml"
