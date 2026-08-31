#!/usr/bin/env bash
# 一键安装 dsh-plugins/ 下的所有插件到 dsh profile（默认 web）：
# 每个插件依次执行 npm install → npm run build（如有 build 脚本）→
# dsh plugin --profile <profile> add "link:<插件绝对路径>"，
# 最后若 dsh web 正在运行则重启使插件生效。
# 幂等：已注册进 profile 的插件跳过 add（link: 指向源目录，重新构建 + 重启即更新）。
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PLUGINS_DIR=${DSH_PLUGINS_DIR:-$SCRIPT_DIR/dsh-plugins}
PROFILE=${DSH_PROFILE:-web}
DSH_HOME=${DSH_HOME:-/mnt/paas}
PROFILE_PKG="$DSH_HOME/profiles/$PROFILE/package.json"

# 读取插件 package.json 的字段（node 一定可用，dsh 本体依赖它）；$2 为点分路径，如 name、scripts.build
pkg_field() {
  node -e '
    const p = require(process.argv[1] + "/package.json");
    let v = p;
    for (const k of process.argv[2].split(".")) v = v == null ? v : v[k];
    process.stdout.write(v == null ? "" : String(v));
  ' "$1" "$2"
}

# 插件是否已注册进 profile（dependencies 或 dsh.profile.bundles 中出现名字）
is_registered() {
  [ -f "$PROFILE_PKG" ] && grep -q "\"$1\"" "$PROFILE_PKG"
}

total=0
added=0
shopt -s nullglob
for dir in "$PLUGINS_DIR"/*/; do
  [ -f "$dir/package.json" ] || continue
  name=$(pkg_field "$dir" name)
  if [ -z "$name" ]; then
    echo "跳过 $dir：package.json 缺少 name 字段" >&2
    continue
  fi
  echo "==> $name"
  (cd "$dir" && npm install --no-audit --no-fund)
  if [ -n "$(pkg_field "$dir" scripts.build)" ]; then
    (cd "$dir" && npm run build)
  fi
  abs=$(cd "$dir" && pwd)
  if is_registered "$name"; then
    echo "    已注册到 profile $PROFILE，跳过 add（link: 指向源目录，重启即生效）"
  else
    "$SCRIPT_DIR/dsh.sh" run plugin --profile "$PROFILE" add "link:$abs"
    added=$((added + 1))
  fi
  total=$((total + 1))
done

if [ "$total" -eq 0 ]; then
  echo "未在 $PLUGINS_DIR 下发现任何插件（需要有 package.json 的子目录）" >&2
  exit 1
fi
echo "完成：共 $total 个插件，新注册 $added 个"

# web 正在运行则重启，使新装 / 重新构建的插件生效
if "$SCRIPT_DIR/dsh.sh" status | grep -q 运行中; then
  "$SCRIPT_DIR/dsh.sh" restart
fi
