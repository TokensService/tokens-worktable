#!/usr/bin/env bash
# 拉取镜像：在目标 IP 列表的每台机器上拉取指定的完整容器镜像
# 位置参数 $1 = 完整容器镜像（如 m.daocloud.io/vllm/vllm-openai:v0.26.0，必填）
# 环境变量 IP_LIST = 目标 IP 列表（逗号或空格分隔；默认取注入的 TARGET_IP）
# 环境变量 TARGET_USER / TARGET_PASSWORD = 目标机登录凭据（页面按选中节点注入）
set -euo pipefail

IMAGE="${1:?请传入完整容器镜像（如 registry.example.com/xds-model:latest）}"
IP_LIST="${IP_LIST:-${TARGET_IP:-}}"
if [ -z "$IP_LIST" ]; then
  echo "[pull] 未提供目标 IP 列表（IP_LIST 或注入的 TARGET_IP）" >&2
  exit 1
fi

# 归一化分隔符：逗号/分号/中文逗号、顿号/空白 -> 空格
IPS=$(echo "$IP_LIST" | tr ',;，、' '     ')
echo "[pull] 镜像: $IMAGE"
echo "[pull] 目标: $IPS"
for ip in $IPS; do
  echo "[pull] $ip: docker pull $IMAGE"
  if sshpass -p "${TARGET_PASSWORD:-}" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o LogLevel=ERROR "${TARGET_USER:-root}@$ip" "docker pull '$IMAGE'"; then
    echo "[pull] $ip: OK"
  else
    echo "[pull] $ip: 拉取失败" >&2
    exit 1
  fi
done
echo "[pull] 全部完成: $IMAGE -> $IPS"
