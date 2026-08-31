#!/usr/bin/env bash
# dsh 编译 / 安装 / 运行 / Web 后台管理脚本，详见 help 子命令
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=${DSH_REPO:-$SCRIPT_DIR/deepseek-harness}
CLI_DIR="$REPO/apps/cli"
CLI_BIN="$CLI_DIR/lib/bin.js"
export DSH_HOME=${DSH_HOME:-/mnt/paas}
# Node 内置 fetch 默认忽略 http_proxy/https_proxy，开启后走系统代理
export NODE_USE_ENV_PROXY=1

# 新会话的默认工作目录：web 宿主进程的 cwd 即缺省会话 cwd（apiproxy 取 process.cwd()）
# 默认取本脚本所在目录，可用 DSH_WORKDIR 覆盖；导出给 web 进程，目录选择器主目录
# （/mnt/paas/profiles/web/cordis.patch.yml 的 directory-picker home）也读它
WORKDIR=${DSH_WORKDIR:-$SCRIPT_DIR}
export DSH_WORKDIR="$WORKDIR"
PORT=${DSH_WEB_PORT:-3051}
# 日志与 pid 文件放在脚本所在目录（可用 DSH_LOG_DIR 覆盖）
LOG_DIR=${DSH_LOG_DIR:-$SCRIPT_DIR}
LOG="$LOG_DIR/dsh-web.log"
PIDFILE="$LOG_DIR/dsh-web.pid"

# 真实模型调用需要 DEEPSEEK_API_KEY，存在根 .env 时加载
if [ -f "$REPO/.env" ]; then
  set -a
  . "$REPO/.env"
  set +a
fi

usage() {
  cat <<EOF
dsh 编译 / 安装 / 运行 / Web 后台管理脚本

用法: $(basename "$0") <命令> [参数...]

构建与运行:
  build               安装依赖并编译 deepseek-harness
                      （pnpm install + pnpm run build）
  install             在 pnpm 全局 bin 目录安装 dsh 包装脚本
                      （指向仓库编译产物；未编译时自动先执行 build）
  run [dsh 参数...]   前台运行 dsh，参数原样透传
                      优先使用全局已安装的 dsh，否则用仓库编译产物
  all [dsh 参数...]   依次执行 build、install、run

Web 后台管理:
  start               后台启动 dsh web（--no-open），重复执行幂等
  stop                停止后台 dsh web（按进程组停止，含派生子进程）
  restart             重启后台 dsh web
  status              查看运行状态（pid 与访问地址）
  log                 跟踪 web 日志（tail -f，Ctrl-C 退出）

  help, -h, --help    显示本帮助

环境变量:
  DSH_REPO            deepseek-harness 仓库路径（默认: 脚本所在目录/deepseek-harness）
  DSH_HOME            dsh 数据目录（默认: /mnt/paas）
  DSH_WORKDIR         web 新会话的默认工作目录（默认: 脚本所在目录）
  DSH_WEB_PORT        web 服务端口（默认: 3051）
  DSH_LOG_DIR         web 日志与 pid 文件目录（默认: 脚本所在目录）
  DSH_CLIENT_TITLE    web 品牌标题（默认: op_test，build 时内联进产物）
  DEEPSEEK_API_KEY    真实模型调用密钥；存在 \$DSH_REPO/.env 时自动加载

文件:
  日志    \$DSH_LOG_DIR/dsh-web.log
  pid     \$DSH_LOG_DIR/dsh-web.pid

示例:
  $(basename "$0") all                          # 编译、安装并以前台方式运行 dsh
  $(basename "$0") run --profile headless "任务"  # 透传参数运行 dsh
  DSH_WEB_PORT=8080 $(basename "$0") start      # 在 8080 端口后台启动 web
  $(basename "$0") restart && $(basename "$0") status
EOF
}

build() {
  cd "$REPO"
  # CI=true 跳过 lefthook git 钩子安装（开发用，且子模块 common config 中的
  # core.worktree 会让其报错）；export 是因为 pnpm run build 前会自动再跑一次
  # pnpm install 校验依赖；不影响依赖安装与编译
  export CI=true
  # 本仓库的 web 品牌：构建期内联为浏览器标签页标题（vite 替换 <title>、
  # DocumentTitle 运行时也读它）；可用同名环境变量覆盖
  export DSH_CLIENT_TITLE=${DSH_CLIENT_TITLE:-op_test}
  pnpm install
  pnpm run build
  [ -f "$CLI_BIN" ] || { echo "编译失败：未生成 $CLI_BIN" >&2; exit 1; }
  echo "编译完成：$CLI_BIN"
}

install() {
  [ -f "$CLI_BIN" ] || build
  # pnpm link --global 无法处理 workspace: 依赖（离开 workspace 根后解析失败），
  # 改为在 pnpm 全局 bin 目录生成 dsh 包装脚本，直接执行仓库编译产物
  local global_bin="${PNPM_HOME:-$HOME/.local/share/pnpm}/bin"
  mkdir -p "$global_bin"
  local target="$global_bin/dsh"
  cat >"$target" <<EOF
#!/usr/bin/env bash
# 由 dsh.sh install 生成，指向 deepseek-harness 编译产物
exec node "$CLI_BIN" "\$@"
EOF
  chmod +x "$target"
  echo "安装完成：$target"
  case ":$PATH:" in
    *":$global_bin:"*) ;;
    *) echo "提示：$global_bin 不在 PATH 中，请加入 PATH（或执行 pnpm setup）后直接使用 dsh 命令" >&2 ;;
  esac
}

# dsh 启动命令：优先已安装的 dsh（PATH 或 pnpm 全局 bin 目录），否则用仓库编译产物
dsh_cmd() {
  local installed="${PNPM_HOME:-$HOME/.local/share/pnpm}/bin/dsh"
  if command -v dsh >/dev/null 2>&1; then
    echo dsh
  elif [ -x "$installed" ]; then
    echo "$installed"
  else
    [ -f "$CLI_BIN" ] || build
    echo "node $CLI_BIN"
  fi
}

run() {
  exec $(dsh_cmd) "$@"
}

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

start() {
  if is_running; then
    echo "已在运行 (pid $(cat "$PIDFILE"))"
    return 0
  fi
  mkdir -p "$DSH_HOME" "$WORKDIR" "$LOG_DIR"
  cd "$WORKDIR"
  setsid nohup $(dsh_cmd) web --no-open --port "$PORT" >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  echo "已启动 (pid $(cat "$PIDFILE"), 端口 $PORT), 日志: $LOG"
}

stop() {
  if ! is_running; then
    echo "未在运行"
    rm -f "$PIDFILE"
    return 0
  fi
  # setsid 使记录 pid 成为进程组组长，负号按组停止，连同派生的 node 子进程
  kill -- -"$(cat "$PIDFILE")" 2>/dev/null || kill "$(cat "$PIDFILE")"
  rm -f "$PIDFILE"
  echo "已停止"
}

case "${1:-}" in
  build) build ;;
  install) install ;;
  run) shift; run "$@" ;;
  all) shift; build; install; run "$@" ;;
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status)
    if is_running; then echo "运行中 (pid $(cat "$PIDFILE"), http://127.0.0.1:$PORT)"
    else echo "未运行"; fi
    ;;
  log) tail -f "$LOG" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 1 ;;
esac
