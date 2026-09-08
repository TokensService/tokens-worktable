#!/bin/bash
# 构建 mooncake-wheel-builder 镜像（在 脚本目录 执行）
# 依赖：本机 docker 已持有 BNT3 底座镜像，且 127.0.0.1:8118 代理可达
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${TAG:-swr.cn-southwest-2.myhuaweicloud.com/dataartsfabric/xds:mooncake-wheel-builder.20260905.BNT3.x86_64}"
CTX="$(mktemp -d)"

docker build --network host \
    --build-arg http_proxy=http://127.0.0.1:8118 \
    --build-arg https_proxy=http://127.0.0.1:8118 \
    --build-arg no_proxy=localhost,127.0.0.1 \
    -t "${TAG}" \
    -f "${SCRIPT_DIR}/mooncake-wheel-builder.Dockerfile" \
    "${CTX}"

rm -rf "${CTX}"
echo "OK: ${TAG}"