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

IPS="${1:-${TARGET_IPS:-${TARGET_IP:-127.0.0.1}}}"
IMAGE="${2:-${IMAGE_NAME:-${DEPLOY_IMAGE:-myapp}}}"
PULL_PROXY="${PULL_PROXY:-${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}}"

if [[ -n "$PULL_PROXY" ]]; then
  export http_proxy="$PULL_PROXY" https_proxy="$PULL_PROXY"
  export HTTP_PROXY="$PULL_PROXY" HTTPS_PROXY="$PULL_PROXY"
fi

# 兼容空格 / 逗号分隔
IPS="$(printf '%s' "$IPS" | tr ',' ' ')"

for ip in $IPS; do
  echo "[pull] $ip: docker pull $IMAGE"
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 "root@$ip" "docker pull $IMAGE"
done

echo "[pull] image $IMAGE pulled to: $IPS"
