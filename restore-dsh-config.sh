#!/usr/bin/env bash
# 从 configs/ 下的备份恢复 dsh 配置（backup-dsh-config.sh 的逆操作）
#
# 用法：./restore-dsh-config.sh <备份目录名或路径>
#   例：./restore-dsh-config.sh dsh-config-20260828-173222
#       ./restore-dsh-config.sh configs/dsh-config-20260828-173222
#
# 恢复前会：
#   1. 检查 dsh web 是否在运行（在运行则要求先 ./dsh.sh stop）
#   2. 把当前配置快照到 configs/pre-restore-<时间戳>/，防止误覆盖
#
# 恢复内容：settings.yaml、profiles/web/ 配置文件、env.backup（还原为 .env，权限 600）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-/mnt/paas}"
DSH_REPO="${DSH_REPO:-$SCRIPT_DIR/deepseek-harness}"
PROFILE_DIR="$DSH_HOME/profiles/web"

usage() {
  cat <<EOF
用法：$(basename "$0") <备份目录名或路径>

从 configs/ 下的备份恢复 dsh 配置（backup-dsh-config.sh 的逆操作）。

参数：
  备份目录   configs/ 下的目录名（如 dsh-config-20260828-173222）或完整路径

选项：
  -h, --help 显示本帮助

环境变量：
  DSH_HOME   dsh 数据目录（默认 /mnt/paas）
  DSH_REPO   deepseek-harness 子模块路径（默认 脚本所在目录/deepseek-harness）

恢复前会先确认 dsh web 已停止（./dsh.sh stop），并把当前配置快照到
configs/pre-restore-<时间戳>/ 以便回滚。恢复后执行 ./dsh.sh start 生效。
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac
[[ $# -eq 1 ]] || { usage >&2; exit 1; }
backup="$1"
[[ -d "$backup" ]] || backup="$SCRIPT_DIR/configs/$1"
[[ -d "$backup" ]] || { echo "错误：备份目录不存在：$1" >&2; exit 1; }
[[ -f "$backup/MANIFEST.txt" ]] || { echo "错误：$backup 缺少 MANIFEST.txt，不是有效备份" >&2; exit 1; }

echo "将从以下备份恢复："
cat "$backup/MANIFEST.txt"

# dsh web 在运行时拒绝恢复（cordis.yml 等可能被进程回写）
pid_file="$SCRIPT_DIR/dsh-web.pid"
if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  echo "错误：dsh web 正在运行（pid $(cat "$pid_file")），请先执行 ./dsh.sh stop" >&2
  exit 1
fi

read -r -p "确认恢复？将覆盖当前配置 [y/N] " ans
[[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "已取消"; exit 0; }

# 覆盖前留现场快照
"$SCRIPT_DIR/backup-dsh-config.sh" "pre-restore-$(date +%Y%m%d-%H%M%S)"

count=0
restore_file() { # restore_file <备份中的文件> <目标路径>
  local src="$1" dst="$2"
  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp -p "$src" "$dst"
    echo "  + $src -> $dst"
    count=$((count + 1))
  fi
}

restore_file "$backup/settings.yaml" "$DSH_HOME/settings.yaml"
if [[ -d "$backup/profiles/web" ]]; then
  for f in "$backup/profiles/web"/*; do
    [[ -f "$f" ]] && restore_file "$f" "$PROFILE_DIR/$(basename "$f")"
  done
fi
if [[ -f "$backup/env.backup" ]]; then
  restore_file "$backup/env.backup" "$DSH_REPO/.env"
  chmod 600 "$DSH_REPO/.env"
fi

echo "完成：共恢复 $count 个文件。执行 ./dsh.sh start 重新启动 dsh web 后生效。"
