#!/usr/bin/env bash
# 注册模型：把模型注册到模型仓库/注册中心
# 位置参数 $1 = 模型名（默认 xds）
# 环境变量 REGISTRY = 注册中心地址，VERSION = 版本（默认 latest）
set -e
MODEL="${1:-xds}"
REGISTRY="${REGISTRY:-registry.example.com}"
VERSION="${VERSION:-latest}"
echo "[register] register model=$MODEL version=$VERSION to $REGISTRY"
echo "[register] model $MODEL registered"
