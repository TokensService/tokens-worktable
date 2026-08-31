#!/usr/bin/env bash
# 注册模型：把 XDS 模型注册到模型仓库（POST /models/）并列出当前模型
# 节选自 deployments/78-lmcache-1p1d/register_glm52_mg39_lmcache_1p1d_78_gdr.sh
# 位置参数 $1 = 模型名（model_endpoint；默认 ${MODEL_NAME} 注入值，再默认 glm-5.2-nvfp4）
# 环境变量 XDS_URL = XDS 控制面网关地址（默认 http://192.168.0.78:30079/xds/v1，页面可覆盖）
# 环境变量 MODEL_NAME = 模型名/端点名，等价于位置参数 $1
# 环境变量 MODEL_PATH = 权重目录（默认 glm52 W4A4-MG39 实例路径，按目标机实际路径覆盖）
# 说明：
#   1. XDS_URL 是控制面/网关专用地址，不要用注入的 TARGET_IP 推导（TARGET_IP 是部署目标机，二者不一定相同）。
#   2. MODEL_PATH 与 MODEL_NAME 默认值来源不同，不互相推导，避免名实不符。
set -euo pipefail

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY 2>/dev/null || true

CURL_CMD="curl"
XDS_URL="${XDS_URL:-http://192.168.0.78:30079/xds/v1}"
MODEL_NAME="${MODEL_NAME:-${1:-glm-5.2-nvfp4}}"
MODEL_PATH="${MODEL_PATH:-/home/service/works/models_ssd/GLM-5.2-NVFP4-W4A4-MG39-BNT3/v1}"

echo ">>> register model ${MODEL_NAME} ..."
${CURL_CMD} --noproxy '*' -sS -X POST "${XDS_URL}/models/" \
  -H 'Content-Type: application/json' \
  --data-raw "{
    \"model\": \"${MODEL_NAME}\",
    \"model_endpoint\": \"${MODEL_NAME}\",
    \"arch_name\": \"${MODEL_NAME}\",
    \"version\": \"v1\",
    \"max_instance\": 1,
    \"min_instance\": 1,
    \"location\": \"local\",
    \"spec_package\": \"${MODEL_NAME}\",
    \"local_info\": {\"path\": \"${MODEL_PATH}\"},
    \"resource_list\": [
      {\"resource_id\": \"glm52-prefill-78\", \"resource_type\": \"prefill\", \"resource_status\": \"IDLE\", \"resource_bundles\": [\"127.0.0.1\"]},
      {\"resource_id\": \"glm52-decode-78\", \"resource_type\": \"decode\", \"resource_status\": \"IDLE\", \"resource_bundles\": [\"127.0.0.5\"]}
    ]
  }"
echo

echo ">>> current models:"
${CURL_CMD} --noproxy '*' -sS "${XDS_URL}/models/"
echo
echo "[register] model ${MODEL_NAME} registered"