#!/usr/bin/env bash
set -euo pipefail

# 输入变量（均可选）：
# - LMCACHE_UNITTEST_RUN_DIR：本轮运行目录；未设置时自动生成时间戳目录。
# - LMCACHE_UNITTEST_IMAGE：待拉取的单测镜像；未设置时使用脚本默认值。
# - LMCACHE_UNITTEST_CAP_ADD：容器所需 Linux capability；默认 SYS_NICE。
# - LMCACHE_NERDCTL_NAMESPACE、LMCACHE_UNITTEST_LOG_DIR、LMCACHE_UNITTEST_CONTAINER、
#   LMCACHE_UNITTEST_HTTP_PROXY、LMCACHE_UNITTEST_REMOVE_IMAGE：运行配置。
# - LMCACHE_UNITTEST_SWR_AK、LMCACHE_UNITTEST_SWR_PROJECT、
#   LMCACHE_UNITTEST_SWR_REGISTRY、LMCACHE_UNITTEST_SWR_LOGIN_KEY：SWR 拉取认证信息。
#   均为可选环境变量；LOGIN_KEY 绝不输出到 stdout 或阶段变量池。
# 本阶段末尾的 KEY=VALUE 输出会由工作台捕获并注入 rebuild 阶段。
# 第一阶段：准备后续编译和测试共用的镜像、运行目录及日志目录。
command -v nerdctl >/dev/null || { echo 'nerdctl is required' >&2; exit 2; }
# 工作台可显式指定运行目录；未指定时为本次单独执行生成时间戳目录。
RUN_DIR="${LMCACHE_UNITTEST_RUN_DIR:-/tmp/lmcache-unittest/$(date +%Y%m%d_%H%M%S)}"
LMCACHE_UNITTEST_IMAGE="${LMCACHE_UNITTEST_IMAGE:-lmcache-vllm-openai-0.5.4-unitest:latest}"
# SYS_NICE 是容器内 NUMA 相关操作所需的最小 Linux capability，可按需覆盖。
LMCACHE_UNITTEST_CAP_ADD="${LMCACHE_UNITTEST_CAP_ADD:-SYS_NICE}"
# 默认隔离 blocks-first CUDA 回归用例；定期诊断任务可设为 0，保留原始单进程全量执行。
LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST="${LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST:-1}"
[[ "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST" =~ ^[01]$ ]] || {
  echo 'LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST must be 0 or 1' >&2
  exit 2
}
ns="${LMCACHE_NERDCTL_NAMESPACE:-k8s.io}"
LMCACHE_UNITTEST_LOG_DIR="${LMCACHE_UNITTEST_LOG_DIR:-$RUN_DIR/logs}"
LMCACHE_UNITTEST_CONTAINER="${LMCACHE_UNITTEST_CONTAINER:-lmcache-unittest-$(basename "$RUN_DIR")}"
# 代理须传递给后续容器内的 Git、构建依赖和 pytest/Hugging Face 请求。
LMCACHE_UNITTEST_HTTP_PROXY="${LMCACHE_UNITTEST_HTTP_PROXY:-http://127.0.0.1:8889}"
# 成功完成测试后是否回收镜像；默认保留，便于复用和排障。
LMCACHE_UNITTEST_REMOVE_IMAGE="${LMCACHE_UNITTEST_REMOVE_IMAGE:-0}"
[[ "$LMCACHE_UNITTEST_REMOVE_IMAGE" =~ ^[01]$ ]] || {
  echo 'LMCACHE_UNITTEST_REMOVE_IMAGE must be 0 or 1' >&2
  exit 2
}
# SWR 凭据由工作台环境变量注入；不要使用 :?，避免平台要求人工必填。
AK="${LMCACHE_UNITTEST_SWR_AK:-}"
PROJECT="${LMCACHE_UNITTEST_SWR_PROJECT:-}"
REGISTRY="${LMCACHE_UNITTEST_SWR_REGISTRY:-}"
LOGIN_KEY="${LMCACHE_UNITTEST_SWR_LOGIN_KEY:-}"
mkdir -p "$LMCACHE_UNITTEST_LOG_DIR"

# 镜像已存在则复用；否则使用 SWR 的 project@AK:login-key 认证拉取到 k8s.io。
# REGISTRY 由镜像引用本身指定，保留该变量供工作台统一注入 SWR 配置。
nerdctl --namespace "$ns" image inspect "$LMCACHE_UNITTEST_IMAGE" >/dev/null 2>&1 || \
  sudo ctr -n "$ns" image pull --user "${PROJECT}@${AK}:${LOGIN_KEY}" "$LMCACHE_UNITTEST_IMAGE"

# 后续 clone、编译和测试均在此容器内执行。只挂载共享内存和宿主日志目录，
# 不挂载源码，避免把宿主网络/文件系统状态带入构建过程。
nerdctl --namespace "$ns" run -d --name "$LMCACHE_UNITTEST_CONTAINER" --net=host --gpus all \
  --cap-add "$LMCACHE_UNITTEST_CAP_ADD" -v /dev/shm:/dev/shm -v "$RUN_DIR:$RUN_DIR" \
  --entrypoint bash "$LMCACHE_UNITTEST_IMAGE" -lc 'exec sleep infinity' >/dev/null

# 工作台捕获 KEY=VALUE 输出并注入后续阶段；不要改为普通日志格式。
printf 'LMCACHE_UNITTEST_RUN_DIR=%s\n' "$RUN_DIR"
printf 'LMCACHE_UNITTEST_IMAGE=%s\n' "$LMCACHE_UNITTEST_IMAGE"
printf 'LMCACHE_UNITTEST_CAP_ADD=%s\n' "$LMCACHE_UNITTEST_CAP_ADD"
printf 'LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST=%s\n' "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST"
printf 'LMCACHE_UNITTEST_LOG_DIR=%s\n' "$LMCACHE_UNITTEST_LOG_DIR"
printf 'LMCACHE_UNITTEST_CONTAINER=%s\n' "$LMCACHE_UNITTEST_CONTAINER"
printf 'LMCACHE_UNITTEST_HTTP_PROXY=%s\n' "$LMCACHE_UNITTEST_HTTP_PROXY"
printf 'LMCACHE_UNITTEST_REMOVE_IMAGE=%s\n' "$LMCACHE_UNITTEST_REMOVE_IMAGE"
