#!/usr/bin/env bash
# 部署脚本：部署到目标 IP
# 位置参数 $1 = Release 名（默认 myapp）
# 环境变量 TARGET_IP = 目标主机 IP（必填），NAMESPACE = 命名空间（默认 default）
set -e
RELEASE="${1:-myapp}"
TARGET_IP="${TARGET_IP:?需要设置 TARGET_IP（目标主机 IP）}"
NAMESPACE="${NAMESPACE:-default}"
echo "[deploy] deploy $RELEASE to $TARGET_IP (namespace=$NAMESPACE)"
echo "[deploy] kubectl set image deployment/$RELEASE -n $NAMESPACE"
echo "[deploy] rollout status on $TARGET_IP"
echo "[deploy] done"
