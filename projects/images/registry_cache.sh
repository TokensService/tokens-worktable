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
# 必须边跑边回显（tee）而不是用命令替换把 pull 输出整体缓冲：大镜像经公网 mirror 拉取可达
# 40 分钟以上（mirror 把 blob 302 到境外 CDN，实测仅 3~4MB/s），缓冲会让页面任务日志全程空白，
# 用户无法分辨是卡死还是在下载。失败归因需要完整输出，故同时落一份临时文件。
PULL_LOG="$(mktemp)"
PULL_START=$(date +%s)
docker pull "$SRC" 2>&1 | tee "$PULL_LOG"
PULL_CODE=${PIPESTATUS[0]}
PULL_ELAPSED=$(( $(date +%s) - PULL_START ))
echo "-- 拉取用时 ${PULL_ELAPSED}s（约 $((PULL_ELAPSED / 60)) 分 $((PULL_ELAPSED % 60)) 秒）"
if [ "$PULL_CODE" -ne 0 ]; then
  echo "[FAIL] docker pull 失败 (exit=$PULL_CODE, 用时 ${PULL_ELAPSED}s): $SRC" >&2
  # 与 login 失败同口径：给可操作的归因，而不是只有一句「失败」。
  # 匹配串取 docker 的完整错误措辞，不用裸 "503"/"EOF"——层 ID 是 12 位十六进制，会误命中。
  PULL_TEXT="$(cat "$PULL_LOG")"
  PULL_NET=0
  case "$PULL_TEXT" in
    *"manifest unknown"*|*"MANIFEST_UNKNOWN"*|*"not found"*)
      echo "       原因: 源仓库没有这个镜像或标签（核对镜像名/标签拼写；mirror 可能尚未缓存该 tag）" >&2 ;;
    *"no space left on device"*|*"disk quota exceeded"*)
      echo "       原因: 本机磁盘不足（docker 数据目录所在盘）——先看 docker system df，再 docker image prune 清理" >&2 ;;
    *"TLS handshake"*|*"x509"*|*"certificate signed by unknown authority"*)
      echo "       原因: TLS 握手/证书失败（代理 MITM 或系统时间偏差）" >&2 ;;
    *"proxyconnect"*|*"connection refused"*|*"no such host"*|*"i/o timeout"*|*"unexpected EOF"*|*"503 Service Unavailable"*|*"502 Bad Gateway"*|*"toomanyrequests"*|*"rate limit"*)
      echo "       原因: 网络或上游不可达（docker daemon 代理未运行、mirror 限流、CDN 5xx）——代理配置见 /etc/docker/daemon.json，稍后重试" >&2
      PULL_NET=1 ;;
    *"unauthorized"*|*"authentication required"*)
      echo "       原因: 源仓库需要认证——私有源要先在本机 docker login 源仓库" >&2 ;;
  esac
  echo "       提示: 重跑本任务即为续传——已下载完成的层 docker 会复用，不会从头下载。" >&2
  # 网络类失败或已经跑了很久才失败：多半是撞上页面超时，指路调大超时
  if [ "$PULL_NET" -eq 1 ] || [ "$PULL_ELAPSED" -ge 600 ]; then
    echo "       提示: 大镜像（数 GB 以上）经公网 mirror 拉取常超 1 小时，请把页面「超时（分钟）」调大或留空（不限时）。" >&2
  fi
  rm -f "$PULL_LOG"
  exit 10
fi
rm -f "$PULL_LOG"

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
