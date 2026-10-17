#!/bin/bash
# 镜像仓库 · 仓库连通性与垃圾回收脚本（设置页「测试连接」「执行垃圾回收」调用）
# 用法: registry_test.sh <mode> <registry_host> <user> <pass>
#   mode=test   → GET /v2/_catalog?n=1 探活（返回 HTTP 状态码与仓库数）
#   mode=gc     → 在 registry 容器内执行 garbage-collect
set -u
MODE="${1:-test}"
HOST="${2:-}"
USER_="${3:-}"
PASS="${4:-}"

if [ "$MODE" = "gc" ]; then
  echo "== 在 registry 容器内执行垃圾回收"
  if ! docker ps --format '{{.Names}}' | grep -qx 'registry'; then
    echo "[FAIL] registry 容器未运行" >&2
    exit 20
  fi
  docker exec registry registry garbage-collect /etc/docker/registry/config.yml
  code=$?
  echo "GC exit=$code"
  exit $code
fi

# test 模式
if [ -z "$HOST" ]; then
  echo "用法: registry_test.sh <test|gc> <registry_host> [user] [pass]" >&2
  exit 2
fi
URL="http://${HOST}/v2/_catalog?n=1"
echo "== 探活: $URL"
if [ -n "$USER_" ] && [ -n "$PASS" ]; then
  RESP=$(curl -sS -m 20 -u "${USER_}:${PASS}" -w '\n%{http_code}' "$URL" 2>&1)
else
  RESP=$(curl -sS -m 20 -w '\n%{http_code}' "$URL" 2>&1)
fi
CODE=$(printf '%s' "$RESP" | tail -n1)
BODY=$(printf '%s' "$RESP" | sed '$d')
echo "HTTP $CODE"
echo "$BODY"
if [ "$CODE" = "200" ]; then
  echo "REG_OK"
  exit 0
else
  echo "REG_FAIL HTTP $CODE" >&2
  exit 21
fi
