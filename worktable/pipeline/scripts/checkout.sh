#!/usr/bin/env bash
# 检出脚本：拉取代码
# 位置参数 $1 = 分支/提交（默认 main）
# 环境变量 GIT_URL = 仓库地址（有默认值）
set -e
BRANCH="${1:-main}"
GIT_URL="${GIT_URL:-https://git.example.com/myapp.git}"
echo "[checkout] git clone $GIT_URL"
echo "[checkout] checkout branch/commit: $BRANCH"
echo "[checkout] done"
