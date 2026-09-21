#!/usr/bin/env bash
# distribute-clear-lmcache.sh - 把 clear-lmcache-cache.sh 分发到 gy1 各节点的 /opt/op-test/bin/
# 供打流平台（云启）LMCache 清理作业等在节点本地引用，脱离个人共享存储路径。
# 用法：
#   bash distribute-clear-lmcache.sh                 # 分发到全部 gy1 节点
#   GY1_NODES="128 237" bash distribute-clear-lmcache.sh   # 只分发指定短号节点
#   DEST_DIR=/opt/op-test/bin bash ...               # 覆盖目标目录
# 依赖：本机到各节点 root SSH 免密（gy1 集群互通）。脚本升级后重跑一遍即可全量刷新。
# pipeline: no-positional-args
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${SOURCE:-$SCRIPT_DIR/clear-lmcache-cache.sh}"
DEST_DIR="${DEST_DIR:-/opt/op-test/bin}"
DEST_FILE="$DEST_DIR/clear-lmcache-cache.sh"
# gy1 region 全部节点（IP 末段短号）；清单来源：tokens-devices skill，节点增减后更新此处
GY1_NODES="${GY1_NODES:-102 125 126 128 156 162 215 218 237 243 55 68 78 83}"

[[ -f "$SOURCE" ]] || { echo "ERROR: source script not found: $SOURCE" >&2; exit 2; }
source_md5="$(md5sum "$SOURCE" | awk '{print $1}')"
echo "[distribute] source=$SOURCE md5=$source_md5"
echo "[distribute] dest=${DEST_FILE} nodes=$GY1_NODES"

local_ips="$(hostname -I 2>/dev/null || true)"
ok=0; fail=0
for short in $GY1_NODES; do
  ip="192.168.0.$short"
  ssh_opts=(-o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
  if [[ " $local_ips " == *" $ip "* ]]; then
    mkdir -p "$DEST_DIR" && install -m 0755 "$SOURCE" "$DEST_FILE" || { echo "[distribute] FAIL(local) $ip"; fail=$((fail+1)); continue; }
    echo "[distribute] OK(local) $ip md5=$(md5sum "$DEST_FILE" | awk '{print $1}')"
    ok=$((ok+1)); continue
  fi
  if ! ssh "${ssh_opts[@]}" "root@$ip" "mkdir -p '$DEST_DIR'" \
     || ! scp -q "${ssh_opts[@]}" "$SOURCE" "root@$ip:$DEST_FILE" \
     || ! ssh "${ssh_opts[@]}" "root@$ip" "chmod 0755 '$DEST_FILE' && md5sum '$DEST_FILE'"; then
    echo "[distribute] FAIL $ip"
    fail=$((fail+1))
    continue
  fi
  ok=$((ok+1))
done
echo "[distribute] done: ok=$ok fail=$fail"
((fail == 0))
