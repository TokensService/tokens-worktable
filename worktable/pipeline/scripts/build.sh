#!/usr/bin/env bash
# 构建脚本：构建镜像
# 位置参数 $1 = 镜像名（默认 myapp）
# 环境变量 VERSION = 版本号（默认 1.0.0），REGISTRY = 镜像仓库（有默认值）
set -e
IMAGE="${1:-myapp}"
VERSION="${VERSION:-1.0.0}"
REGISTRY="${REGISTRY:-registry.example.com}"
echo "[build] docker build -t $REGISTRY/$IMAGE:$VERSION ."
echo "[build] docker push $REGISTRY/$IMAGE:$VERSION"
echo "[build] done"
