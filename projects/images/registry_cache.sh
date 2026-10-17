#!/bin/bash
# 镜像仓库 · 远程镜像缓存任务脚本
# 用法: registry_cache.sh <源镜像> <目标仓库前缀> [标签]
# 例:   registry_cache.sh alpine:3.19 127.0.0.1:5000/library 3.19
# 流程: docker pull 源镜像 → (可选 retag) → docker login 目标仓库 → docker push → 清理本地临时 tag
set -u

# 中止语义：页面「■ 中止」断开 exec-stream → 服务端对进程组 SIGTERM（1s 后 SIGKILL）。
# 这里把 TERM 转成对前台 docker 子进程的 INT（docker 对 SIGINT 会立刻取消 pull/push/login），
# 避免 docker 客户端在 TERM 下可能忽略、留下半截任务；随后本脚本按 143 退出。
trap 'trap - TERM INT; kill -INT -$$ 2>/dev/null; exit 143' TERM INT
SRC="${1:-}"
PREFIX="${2:-}"
TAG="${3:-}"
if [ -z "$SRC" ] || [ -z "$PREFIX" ]; then
  echo "用法: registry_cache.sh <源镜像> <目标仓库前缀> [标签]" >&2
  exit 2
fi

# 目标仓库地址与凭证（环境变量注入）
REG_HOST="${REG_HOST:-}"
REG_USER="${REG_USER:-}"
REG_PASS="${REG_PASS:-}"

# 归一化：剥协议前缀与尾斜杠（docker login 只吃 host[:port]，带 scheme 会打到错端点）
REG_HOST="${REG_HOST#http://}"
REG_HOST="${REG_HOST#https://}"
REG_HOST="${REG_HOST%/}"
# 密码去尾随换行（echo/复制粘贴引入的 \n 会让 401）
REG_PASS="${REG_PASS%$'\n'}"
REG_PASS="${REG_PASS%$'\r'}"

# 若未提供标签，docker 会按默认 latest 处理（pull 后的 RepoTags 即含默认标签）
echo "== [1/4] 拉取源镜像: $SRC"
if ! docker pull "$SRC"; then
  echo "[FAIL] docker pull 失败: $SRC" >&2
  exit 10
fi

# 解析实际拉取到的引用（保留 digest 型源引用的可追溯性）
SRC_REPO="${SRC%%:*}"
SRC_TAG="${SRC##*:}"
if [ "$SRC_TAG" = "$SRC" ]; then SRC_TAG="latest"; fi
LOCAL_REF="$SRC_REPO:$SRC_TAG"

# 目标引用：标签缺省沿用源标签
if [ -z "$TAG" ]; then TAG="$SRC_TAG"; fi
if [ -z "$REG_HOST" ]; then
  echo "[FAIL] 未配置镜像仓库地址（设置页「仓库地址」为空）" >&2
  exit 11
fi
if [ -n "$REG_USER" ] && [ -n "$REG_PASS" ]; then
  echo "== [2/4] 登录目标仓库: $REG_HOST (用户 $REG_USER)"
  # stderr 不吞：docker login 的 daemon 报错（401 / TLS timeout / connection refused）直接进任务日志
  LOGIN_ERR="$( { printf '%s' "$REG_PASS" | docker login "$REG_HOST" -u "$REG_USER" --password-stdin 2>&1; } )"
  LOGIN_CODE=$?
  printf '%s\n' "$LOGIN_ERR"
  if [ "$LOGIN_CODE" -ne 0 ]; then
    echo "[FAIL] docker login 失败 (exit=$LOGIN_CODE): $REG_HOST" >&2
    case "$LOGIN_ERR" in
      *"401 Unauthorized"*) echo "       原因: 账号或密码不对（设置页「账号 / 密码」与仓库 htpasswd 不一致）" >&2 ;;
      *"TLS handshake"*)    echo "       原因: 该地址被 docker daemon 当作 HTTPS 访问——局域网 HTTP 仓库需在 /etc/docker/daemon.json 加 insecure-registries（见仓库 README）" >&2 ;;
      *"connection refused"*) echo "       原因: 地址/端口不可达（检查设置页「仓库地址」的端口，仓库需在运行）" >&2 ;;
      *"unauthorized"*)      echo "       原因: 目标是 Docker Hub 等公网仓库——设置页「仓库地址」可能为空（空地址会退到 registry-1.docker.io）" >&2 ;;
    esac
    exit 11
  fi
else
  echo "== [2/4] 未配置账号密码，跳过 docker login（目标需匿名可推或已登录态）"
fi

DST="$PREFIX:$TAG"
echo "== [3/4] 打 tag 并推送: $LOCAL_REF -> $DST"
docker tag "$LOCAL_REF" "$DST" || { echo "[FAIL] docker tag 失败" >&2; exit 12; }
if ! docker push "$DST"; then
  echo "[FAIL] docker push 失败: $DST" >&2
  exit 13
fi

echo "== [4/4] 完成，清理临时 tag"
docker rmi "$DST" >/dev/null 2>&1 || true
echo "CACHE_OK $DST"
