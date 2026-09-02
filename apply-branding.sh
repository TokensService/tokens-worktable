#!/usr/bin/env bash
# apply-branding.sh —— 把 patches/ 下的本地补丁应用到 deepseek-harness 子模块并重新构建
#
# 补丁（patches/*.patch，子模块的本地改动，按文件名序依次应用）：
#   - optest-branding.patch   OPTEST web 品牌：
#       · 侧边栏左上角品牌：OpTestMark「OP」徽章 + OPTEST 文字（SidebarRoot fallback）
#       · favicon：同款 OP 徽章（保留暗色模式变白适配）
#       · PWA manifest：name=op_test / short_name=OPTEST
#       · 配套测试与 vitest 快照同步更新
#   - webserver-guard.patch   webserver 前置守卫（registerGuard / WebGuard，
#       在路由匹配与 upgrade 协商前统一拦截 HTTP 与 WebSocket，供 dsh-auth 等认证插件使用）
# 标签页标题不在补丁里：由 dsh.sh build 默认注入 DSH_CLIENT_TITLE=op_test（可覆盖）。
#
# 用法：
#   ./apply-branding.sh           应用全部补丁（幂等）→ ./dsh.sh build → web 在运行则重启
#   ./apply-branding.sh --check   只检查各补丁应用状态，不改动任何文件
#
# 前提：已执行 ./install-deps.sh（构建工具链就绪）。补丁针对当前子模块 HEAD 生成；
# 子模块升级后若报冲突，需在新的代码上重做改动并重新生成补丁：
#   git -C deepseek-harness diff > patches/<名字>.patch
set -euo pipefail

cd "$(dirname "$0")"
REPO=${DSH_REPO:-deepseek-harness}
PATCH_DIR="$(pwd)/patches"

shopt -s nullglob
PATCHES=("$PATCH_DIR"/*.patch)
[ ${#PATCHES[@]} -gt 0 ] || { echo "错误：$PATCH_DIR 下没有任何 .patch 文件" >&2; exit 1; }

# 输出单个补丁状态：未应用 / 已应用 / 冲突
state() {
  if git -C "$REPO" apply --check "$1" 2>/dev/null; then
    echo 未应用
  elif git -C "$REPO" apply --reverse --check "$1" 2>/dev/null; then
    echo 已应用
  else
    echo 冲突
  fi
}

case "${1:-}" in
  --check)
    for p in "${PATCHES[@]}"; do
      echo "$(basename "$p"): $(state "$p")"
    done
    ;;
  "")
    failed=0
    for p in "${PATCHES[@]}"; do
      case "$(state "$p")" in
        未应用)
          git -C "$REPO" apply "$p"
          echo "$(basename "$p"): 补丁已应用"
          ;;
        已应用)
          echo "$(basename "$p"): 已应用过，跳过（幂等）"
          ;;
        *)
          echo "错误：$(basename "$p") 与子模块当前代码冲突（子模块可能已升级），" \
               "请在子模块新代码上重做改动后重新生成补丁（见脚本头部注释）" >&2
          failed=1
          ;;
      esac
    done
    [ "$failed" -eq 0 ] || exit 1
    ./dsh.sh build
    if ./dsh.sh status | grep -q 运行中; then
      ./dsh.sh restart
    else
      echo "web 未在运行；如需启动：./dsh.sh start"
    fi
    ;;
  *)
    echo "用法: $(basename "$0") [--check]" >&2
    exit 1
    ;;
esac
