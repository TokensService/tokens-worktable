#!/usr/bin/env bash
# 脚本模板：演示流水线注入变量的用法
# 在「编辑流水线」里给阶段绑定本脚本，点「识别参数」即可看到可配置项。
#
# 位置参数（识别为位置参数 1）：
#   $1 = 模型名（默认 xds）
#
# 注入的环境变量（流水线运行时自动注入；在此显式给出默认值=可被页面覆盖）：
#   TARGET_IP       首个目标节点 IP（默认 127.0.0.1）
#   TARGET_USER     首个节点用户名（默认 root）
#   TARGET_PASSWORD 首个节点密码（默认空；不要为它写默认值，演示用 :- 即可）
#   TARGET_IPS      全部目标 IP 的 JSON 数组（多选环境时注入）
#   IMAGE_NAME      镜像名（主控「镜像名」输入框）
#   IMAGE_TAG       本次运行 tag（如 1510-a1b2c）
#   PIPELINE_NAME   流水线名
set -e

MODEL="${1:-xds}"
TARGET_IP="${TARGET_IP:-127.0.0.1}"
TARGET_USER="${TARGET_USER:-root}"
TARGET_PASSWORD="${TARGET_PASSWORD:-}"
TARGET_IPS="${TARGET_IPS:-[]}"
IMAGE_NAME="${IMAGE_NAME:-myapp}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PIPELINE_NAME="${PIPELINE_NAME:-unknown}"

echo "[template] pipeline=$PIPELINE_NAME model=$MODEL"
echo "[template] image=$IMAGE_NAME:$IMAGE_TAG"
echo "[template] primary target: $TARGET_USER@$TARGET_IP"

# 多节点遍历：TARGET_IPS 是 JSON 数组，优先用 python/jq 解析，都没有则按简单格式拆分
IPS=""
if command -v python3 >/dev/null 2>&1; then
  IPS=$(python3 -c 'import json,sys; print(" ".join(json.loads(sys.argv[1])))' "$TARGET_IPS" 2>/dev/null || true)
elif command -v jq >/dev/null 2>&1; then
  IPS=$(jq -r 'join(" ")' <<<"$TARGET_IPS" 2>/dev/null || true)
fi
[ -z "$IPS" ] && IPS="$TARGET_IP"   # 兜底：只有单节点

for ip in $IPS; do
  echo "[template] -> deploy $IMAGE_NAME:$IMAGE_TAG to $TARGET_USER@$ip"
  # 示例：真实部署时取消注释（需要 sshpass 或免密）
  # sshpass -p "$TARGET_PASSWORD" ssh -o StrictHostKeyChecking=no "$TARGET_USER@$ip" \
  #   "docker pull $IMAGE_NAME:$IMAGE_TAG && docker run -d $IMAGE_NAME:$IMAGE_TAG"
done

echo "[template] done"
