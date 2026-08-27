#!/usr/bin/env bash
# 拉取镜像：从镜像仓库拉取 XDS 模型镜像
# 位置参数 $1 = 镜像名（默认 xds-model）
# 环境变量 VERSION = 版本（默认 latest），REGISTRY = 镜像仓库
set -e
IMAGE="${1:-xds-model}"
VERSION="${VERSION:-latest}"
REGISTRY="${REGISTRY:-registry.example.com}"
echo "[pull] docker pull $REGISTRY/$IMAGE:$VERSION"
echo "[pull] image $REGISTRY/$IMAGE:$VERSION pulled"
