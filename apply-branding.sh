#!/usr/bin/env bash
# apply-branding.sh —— 把 OPTEST web 品牌补丁应用到 deepseek-harness 子模块并重新构建
#
# 补丁（patches/optest-branding.patch，子模块的本地改动）内容：
#   - 侧边栏左上角品牌：OpTestMark「OP」徽章 + OPTEST 文字（SidebarRoot fallback）
#   - favicon：同款 OP 徽章（保留暗色模式变白适配）
#   - PWA manifest：name=op_test / short_name=OPTEST
#   - 配套测试与 vitest 快照同步更新
# 标签页标题不在补丁里：由 dsh.sh build 默认注入 DSH_CLIENT_TITLE=op_test（可覆盖）。
#
# 用法：
#   ./apply-branding.sh           应用补丁（幂等）→ ./dsh.sh build → web 在运行则重启
#   ./apply-branding.sh --check   只检查补丁应用状态，不改动任何文件
#
# 前提：已执行 ./install-deps.sh（构建工具链就绪）。补丁针对当前子模块 HEAD 生成；
# 子模块升级后若报冲突，需在新的代码上重做改动并重新生成补丁：
#   git -C deepseek-harness diff > patches/optest-branding.patch
set -euo pipefail

cd "$(dirname "$0")"
REPO=${DSH_REPO:-deepseek-harness}
PATCH="$(pwd)/patches/optest-branding.patch"

[ -f "$PATCH" ] || { echo "错误：未找到补丁 $PATCH" >&2; exit 1; }

# 输出补丁状态：未应用 / 已应用 / 冲突
state() {
  if git -C "$REPO" apply --check "$PATCH" 2>/dev/null; then
    echo 未应用
  elif git -C "$REPO" apply --reverse --check "$PATCH" 2>/dev/null; then
    echo 已应用
  else
    echo 冲突
  fi
}

case "${1:-}" in
  --check)
    echo "OPTEST 品牌补丁状态: $(state)"
    ;;
  "")
    case "$(state)" in
      未应用)
        git -C "$REPO" apply "$PATCH"
        echo "补丁已应用"
        ;;
      已应用)
        echo "补丁已应用过，跳过（幂等）"
        ;;
      *)
        echo "错误：补丁与子模块当前代码冲突（子模块可能已升级），" \
             "请在子模块新代码上重做改动后重新生成补丁（见脚本头部注释）" >&2
        exit 1
        ;;
    esac
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
