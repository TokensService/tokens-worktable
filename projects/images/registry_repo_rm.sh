#!/bin/bash
# 镜像仓库 · 清理空仓库目录
# 用法: registry_repo_rm.sh <仓库名>
#
# 为什么需要它：Registry v2 **没有「删除仓库」接口**。把某个仓库名下的 manifest 全删掉
# （删标签、或「改仓库名」按移动语义搬走旧仓）之后，该仓库仍会留在 /v2/_catalog 里，
# 页面上表现为一条「无标签」的幽灵条目，只能到存储层删目录才能真正移除（实测删完立即
# 从 _catalog 消失，registry 无需重启）。
#
# 安全约束（缺一不可，本脚本会对真实存储做 rm -rf）：
#   1) 仓库名只允许 [a-z0-9._/-]，且不得含 ..、不得以 / 开头或结尾——杜绝路径穿越与 shell 注入；
#   2) 删除前必须确认 _manifests/tags 为空（还有标签就拒绝）；
#   3) 删除前必须确认 _manifests/revisions 为空——只有 digest 引用、没有任何 tag 的仓库
#      同样返回 tags:null，但它仍可按 digest 拉取，误删就是真丢数据，必须显式拒绝。
set -u

REPO="${1:-}"
CONTAINER="${REG_CONTAINER:-registry}"
ROOT="/var/lib/registry/docker/registry/v2/repositories"

if [ -z "$REPO" ]; then
  echo "用法: registry_repo_rm.sh <仓库名>" >&2
  exit 2
fi

# 1) 名字合法性：字符集白名单 + 路径穿越 + 首尾斜杠
case "$REPO" in
  *[!a-z0-9._/-]*) echo "[FAIL] 仓库名含非法字符（只允许小写字母、数字与 . _ - /）: $REPO" >&2; exit 3 ;;
  *..*)            echo "[FAIL] 仓库名不得包含 ..（路径穿越）: $REPO" >&2; exit 3 ;;
  /*|*/)           echo "[FAIL] 仓库名不得以 / 开头或结尾: $REPO" >&2; exit 3 ;;
esac

DIR="$ROOT/$REPO"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "[FAIL] registry 容器「$CONTAINER」未在运行（docker ps 查不到）" >&2
  exit 4
fi
if ! docker exec "$CONTAINER" test -d "$DIR"; then
  echo "[FAIL] 仓库目录不存在，无需清理: $DIR" >&2
  exit 4
fi

# 2) 活标签必须为 0
#    注意：必须数 link 文件，不能数目录名。registry 的 DELETE 只摘掉 link，空目录会留在原地——
#    实测删完标签后 _manifests/revisions/sha256/<dgst>/ 目录仍在但里面已无 link，此时按 tag 和
#    按 digest 取 manifest 都是 404。按目录名计数会把这种无害残留误判成「还有活数据」，恰好堵死
#    「改名后清理旧仓」这个主要用途。
#    标签只数 current/link：每个标签另有 index/sha256/<dgst>/link，全数会把 3 个标签报成 6 个；
#    而 current/link 正是 registry 判断「该标签能否解析」的依据，与 tags/list 口径一致。
NTAG=$(docker exec "$CONTAINER" sh -c "find '$DIR/_manifests/tags' -path '*/current/link' 2>/dev/null | wc -l" | tr -d '[:space:]')
if [ "${NTAG:-1}" != "0" ]; then
  echo "[FAIL] 该仓库仍有 ${NTAG:-?} 个标签，拒绝删除。请先删标签，或用「改名」把它整体搬走。" >&2
  exit 5
fi

# 3) 按 digest 存在的 manifest（revision link）也必须为 0
NREV=$(docker exec "$CONTAINER" sh -c "find '$DIR/_manifests/revisions' -name link 2>/dev/null | wc -l" | tr -d '[:space:]')
if [ "${NREV:-0}" != "0" ]; then
  echo "[FAIL] 该仓库无标签但仍有 ${NREV} 个可按 digest 拉取的 manifest（revision link 存在），拒绝删除。" >&2
  echo "       这通常是「只按 digest 推送、从未打过 tag」的仓库，删了就真丢数据；确认要弃用请人工核对后手动处理。" >&2
  exit 6
fi

echo "== 清理空仓库目录: $REPO"
if ! docker exec "$CONTAINER" rm -rf "$DIR"; then
  echo "[FAIL] 删除目录失败: $DIR" >&2
  exit 7
fi

# 顺带清掉因删目录而变空的父目录（如 library/、m.daocloud.io/docker.io/），
# 否则 _catalog 里仍可能留下空壳路径。只删真正为空的目录，不碰任何有内容的层级。
docker exec "$CONTAINER" sh -c "find '$ROOT' -mindepth 1 -type d -empty -delete" 2>/dev/null || true

echo "REPO_RM_OK $REPO"
echo "提示：若该仓库曾独占某些 layer，磁盘要到「设置」页执行垃圾回收（GC）才会真正释放。"
exit 0
