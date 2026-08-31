#!/usr/bin/env bash
# install-deps.sh —— 安装本仓库各组成部分的依赖
#
# 依赖概览：
#   deepseek-harness/      pnpm workspaces 单仓（pnpm@11.7.0，Node ^22.19 || >=24）
#                          依赖全部由 pnpm install 按 pnpm-lock.yaml 安装
#   dsh-plugins/dsh-worktable/  独立 npm 工程（package-lock.json）
#                          构建期依赖：esbuild、highlight.js、markdown-it、xterm
#   tools/op_test_relay.py      零依赖，仅需 Python >= 3.6（标准库）
#   worktable/pipeline/         页面本身纯 HTML + Node 内置模块；但阶段脚本依赖
#                          系统工具 sshpass + ssh（openssh-client）做远程密码登录：
#                          pull-image.sh / collect_logs.sh / 78-lmcache 部署脚本等
#   dsh-plugins/dsh-worktable   服务端 GPU 远程探测路由在传密码时也调用 sshpass+ssh
#                          （src/index.ts，无密码时退回 ssh BatchMode 免密）
#
# 用法：
#   ./install-deps.sh            安装全部依赖
#   ./install-deps.sh --check    只检查环境（node/pnpm/python 版本），不安装

set -euo pipefail

cd "$(dirname "$0")"

NODE_MIN_MAJOR=22          # deepseek-harness 要求 Node ^22.19 || >=24
PNPM_VERSION=11.7.0        # 与 deepseek-harness/package.json 的 packageManager 字段一致
PYTHON_MIN="3.6"           # tools/op_test_relay.py 要求

log() { echo "[install-deps] $*"; }
err() { echo "[install-deps] 错误: $*" >&2; }

check_node() {
  command -v node >/dev/null 2>&1 || { err "未找到 node，请先安装 Node.js >= ${NODE_MIN_MAJOR}.19（建议 22 LTS 或 24+）"; return 1; }
  local major
  major=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
  if [ "$major" -lt "$NODE_MIN_MAJOR" ] || [ "$major" -eq 23 ]; then
    err "node 版本过低或不受支持: $(node -v)（要求 ^22.19 || >=24）"
    return 1
  fi
  log "node $(node -v) ✓"
}

check_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    log "pnpm $(pnpm -v) ✓"
  else
    log "未找到 pnpm，将安装 pnpm@${PNPM_VERSION}"
    return 1
  fi
}

check_python() {
  command -v python3 >/dev/null 2>&1 || { err "未找到 python3（tools/op_test_relay.py 需要 Python >= ${PYTHON_MIN}）"; return 1; }
  python3 -c "import sys; sys.exit(0 if sys.version_info >= (${PYTHON_MIN/./,}) else 1)" \
    || { err "python3 版本过低: $(python3 -V)（要求 >= ${PYTHON_MIN}）"; return 1; }
  log "$(python3 -V) ✓"
}

check_ssh_tools() {
  # sshpass + ssh 是流水线阶段脚本与工作台 GPU 远程探测的系统级依赖
  local missing=0
  if command -v ssh >/dev/null 2>&1; then
    log "ssh $(ssh -V 2>&1 | head -1) ✓"
  else
    err "未找到 ssh（openssh-client），流水线远程脚本需要它"
    missing=1
  fi
  if command -v sshpass >/dev/null 2>&1; then
    log "sshpass $(sshpass -V 2>/dev/null | head -1) ✓"
  else
    err "未找到 sshpass，pull-image.sh / collect_logs.sh / GPU 密码探测等需要它"
    missing=1
  fi
  return "$missing"
}

install_ssh_tools() {
  # 系统包安装，按可用包管理器选择；需要 root 或 sudo
  local sudo=""
  [ "$(id -u)" -ne 0 ] && sudo="sudo"
  if command -v apt-get >/dev/null 2>&1; then
    $sudo apt-get update && $sudo apt-get install -y openssh-client sshpass
  elif command -v dnf >/dev/null 2>&1; then
    $sudo dnf install -y openssh-clients sshpass
  elif command -v yum >/dev/null 2>&1; then
    $sudo yum install -y openssh-clients sshpass
  else
    err "未识别的包管理器，请手动安装 openssh-client 与 sshpass"
    return 1
  fi
}

install_pnpm() {
  # 优先用 corepack（Node 自带），失败则退回 npm 全局安装
  if command -v corepack >/dev/null 2>&1; then
    log "通过 corepack 启用 pnpm@${PNPM_VERSION}"
    corepack enable
    corepack prepare "pnpm@${PNPM_VERSION}" --activate
  else
    log "通过 npm 全局安装 pnpm@${PNPM_VERSION}"
    npm install -g "pnpm@${PNPM_VERSION}"
  fi
}

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

log "== 检查基础环境 =="
check_node
check_python
if [ "$CHECK_ONLY" -eq 1 ]; then
  check_pnpm || true
  check_ssh_tools || true
  log "检查完成（--check 模式，未安装任何依赖）"
  exit 0
fi

check_pnpm || install_pnpm
check_ssh_tools || install_ssh_tools

log "== 安装 deepseek-harness 依赖（pnpm install） =="
# CI=true：跳过 postinstall 里的 lefthook git 钩子安装（与 dsh.sh build 保持一致）
(cd deepseek-harness && CI=true pnpm install)

log "== 安装 dsh-plugins/dsh-worktable 依赖（npm install） =="
(cd dsh-plugins/dsh-worktable && npm install)

log "== tools/ 与 worktable/ =="
log "tools/op_test_relay.py 为零依赖脚本（Python 标准库），无需安装"
log "worktable/ 页面为纯 HTML/Node 内置模块；远程阶段脚本依赖的 sshpass/ssh 已在上面处理"

log "全部依赖安装完成。"
log "后续：编译子模块用 ./dsh.sh build；构建并安装工作台插件用 ./install-plugins.sh"
