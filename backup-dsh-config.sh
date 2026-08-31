#!/usr/bin/env bash
# 备份当前 dsh 配置到 configs/ 目录
#
# 备份内容：
#   $DSH_HOME/settings.yaml            dsh 全局设置
#   $DSH_HOME/profiles/web/            web profile 配置（cordis.yml / cordis.patch.yml /
#                                      package.json / pnpm-lock.yaml / pnpm-workspace.yaml，
#                                      不含 node_modules 与 .dsh-market 缓存）
#   $DSH_REPO/.env                     若存在则一并备份（含密钥，权限设为 600）
#
# 不备份：.credentials.yaml（凭据）、node_modules、会话数据等运行时产物。
#
# 用法：./backup-dsh-config.sh [备份名]
#   默认备份到 configs/dsh-config-<时间戳>/，可用第一个参数自定义目录名。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-/mnt/paas}"
DSH_REPO="${DSH_REPO:-$SCRIPT_DIR/deepseek-harness}"
PROFILE_DIR="$DSH_HOME/profiles/web"

usage() {
  cat <<EOF
用法：$(basename "$0") [选项] [备份名]

把当前 dsh 配置备份到 configs/ 目录。

参数：
  备份名     可选，备份目录名；默认 dsh-config-<时间戳>

选项：
  -h, --help 显示本帮助

环境变量：
  DSH_HOME   dsh 数据目录（默认 /mnt/paas）
  DSH_REPO   deepseek-harness 子模块路径（默认 脚本所在目录/deepseek-harness）

备份内容：settings.yaml、profiles/web/ 文本配置（不含 node_modules）、.env（若有）。
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 1; }

name="${1:-dsh-config-$(date +%Y%m%d-%H%M%S)}"
dest="$SCRIPT_DIR/configs/$name"

if [[ -e "$dest" ]]; then
  echo "错误：备份目录已存在：$dest" >&2
  exit 1
fi
mkdir -p "$dest/profiles/web"

count=0
copy_file() { # copy_file <源文件> <目标目录>
  local src="$1" dst_dir="$2"
  if [[ -f "$src" ]]; then
    cp -p "$src" "$dst_dir/"
    echo "  + $src"
    count=$((count + 1))
  fi
}

echo "备份 dsh 配置到 $dest"

# 全局设置
copy_file "$DSH_HOME/settings.yaml" "$dest"

# web profile 配置文件（只拷文本配置，跳过 node_modules / .dsh-market）
if [[ -d "$PROFILE_DIR" ]]; then
  for f in "$PROFILE_DIR"/*.yml "$PROFILE_DIR"/*.yaml "$PROFILE_DIR"/*.json; do
    [[ -f "$f" ]] && copy_file "$f" "$dest/profiles/web"
  done
else
  echo "警告：profile 目录不存在：$PROFILE_DIR" >&2
fi

# 子模块 .env（含 DEEPSEEK_API_KEY，属敏感信息）
if [[ -f "$DSH_REPO/.env" ]]; then
  cp -p "$DSH_REPO/.env" "$dest/env.backup"
  chmod 600 "$dest/env.backup"
  echo "  + $DSH_REPO/.env（已存为 env.backup，权限 600，注意勿提交）"
  count=$((count + 1))
fi

# 清单文件
cat > "$dest/MANIFEST.txt" <<EOF
备份时间: $(date '+%Y-%m-%d %H:%M:%S')
主机:     $(hostname)
DSH_HOME: $DSH_HOME
DSH_REPO: $DSH_REPO
文件数:   $count
EOF

echo "完成：共备份 $count 个文件 -> $dest"
