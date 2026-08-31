#!/usr/bin/env bash
# 拉取镜像：在多台指定机器上分别拉取同一个镜像
#
# 用法：
#   pull-images.sh "IP1 IP2 IP3" <镜像>
#   位置参数 $1 = 节点 IP 列表（空格或逗号分隔；为空时用注入的 TARGET_IP）
#   位置参数 $2 = 镜像名/完整镜像地址（默认 ${IMAGE_NAME} 注入值）
#
# 依赖：目标机 root 免密登录（或已配置 sshpass + TARGET_PASSWORD），目标机有 docker/nerdctl。
set -euo pipefail

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY 2>/dev/null || true

IPS="${1:-${TARGET_IP:-}}"
IMAGE="${2:-${IMAGE_NAME:-}}"

[ -n "$IPS" ] || { echo "错误: 未指定节点 IP 列表（\$1 或 TARGET_IP）" >&2; exit 1; }
[ -n "$IMAGE" ] || { echo "错误: 未指定镜像（\$2 或 IMAGE_NAME）" >&2; exit 1; }

# 兼容空格 / 逗号分隔
IPS="$(printf '%s' "$IPS" | tr ',' ' ')"

for ip in $IPS; do
  echo "[pull] $ip: docker pull $IMAGE"
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 "root@$ip" "docker pull $IMAGE"
done

echo "[pull] image $IMAGE pulled to: $IPS"