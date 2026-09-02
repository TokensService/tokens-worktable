#!/usr/bin/env bash
# upgrade-dsh.sh —— 一键升级 deepseek-harness 子模块并重打 patches/ 下的本地补丁
#
# 流程：
#   1. 检查子模块工作区：只允许 patches/*.patch 造成的改动，并先全部反向摘除
#   2. git submodule update --remote 拉取上游最新代码
#   3. 重新应用全部补丁（apply-branding.sh，内含构建与按需重启）
#
# 用法：
#   ./upgrade-dsh.sh    升级子模块到上游默认分支最新提交
#
# 子模块升级后若补丁冲突，脚本会在重新应用补丁处报错退出；此时需在子模块
# 新代码上重做改动并重新生成补丁（见 apply-branding.sh 头部注释）。
# 注意：profile 的插件（dsh-plugins/ 以 link: 注册，指向源目录）不受子模块
# 升级影响，无需重装。
set -euo pipefail

cd "$(dirname "$0")"
REPO=${DSH_REPO:-deepseek-harness}
PATCH_DIR="$(pwd)/patches"

git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || {
  echo "错误：未找到子模块 $REPO（先执行 git submodule update --init）" >&2; exit 1; }

shopt -s nullglob
PATCHES=("$PATCH_DIR"/*.patch)
[ ${#PATCHES[@]} -gt 0 ] || { echo "错误：$PATCH_DIR 下没有任何 .patch 文件" >&2; exit 1; }

# 1. 子模块工作区检查：只允许补丁造成的改动，先按相反顺序全部反向摘除再升级
if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  for ((i=${#PATCHES[@]}-1; i>=0; i--)); do
    p=${PATCHES[$i]}
    if git -C "$REPO" apply --reverse --check "$p" 2>/dev/null; then
      git -C "$REPO" apply --reverse "$p"
      echo "已反向摘除 $(basename "$p")"
    fi
  done
  leftover=$(git -C "$REPO" status --porcelain)
  if [ -n "$leftover" ]; then
    # 摘除补丁后仍有其他改动：恢复已摘除的补丁，只列出补丁之外的改动
    for p in "${PATCHES[@]}"; do
      git -C "$REPO" apply --check "$p" 2>/dev/null && git -C "$REPO" apply "$p"
    done
    echo "错误：子模块工作区除 patches/ 补丁外还有本地改动，请先手工处理：" >&2
    echo "$leftover" >&2
    exit 1
  fi
fi

# 2. 拉取上游最新
OLD=$(git -C "$REPO" rev-parse HEAD)
git submodule update --remote "$REPO"
NEW=$(git -C "$REPO" rev-parse HEAD)
if [ "$OLD" = "$NEW" ]; then
  echo "子模块已是最新（$OLD），仅重建并重打补丁"
else
  echo "子模块已升级：$OLD -> $NEW"
fi

# 3. 清理旧构建产物（跨版本升级后残留 lib/ 会导致 MISSING_EXPORT 等怪异错误），
#    重新应用全部补丁并构建（web 在运行则自动重启；冲突时此处报错退出）
if [ "$OLD" != "$NEW" ]; then
  (cd "$REPO" && CI=true pnpm run clean)
fi
./apply-branding.sh
