#!/usr/bin/env bash
# LMCache 渲染期逻辑（独立于 render-config.sh 主流程）：
#   defaults : 解析+校验全部 LMCache 入参，输出占位符默认值（KEY=VALUE），
#              供主渲染脚本并入 template_vars；校验失败 exit 2。
#   patch    : 渲染后对 chart 副本打 patch —— tracing 参数（旧式 chart 兜底）
#              与 LMCACHE_EXTRA_ARGS 实验注入；含 sidecar 启用守卫与幂等。
# 环境变量（平台阶段参数透传）：
#   ENABLE_LMCACHE           sidecar 总开关（true/false，默认 false）
#   LMCACHE_OTLP_ENDPOINT    OTLP 上报地址：有值即开 tracing、显式置空即关
#                            （注意 - 非 :- 语义；开发环境默认 http://192.168.10.6:4320）
#   LMCACHE_L2_ENABLED       L2 开关（默认 true）
#   LMCACHE_EXTRA_ARGS       实验钩子：额外 sidecar 命令行参数，渲染后注入
#                            chart（免改模板/免出镜像）。仅 alnum/空格/=:/.@,-
#                            允许；留空不注入。
# 输出契约（stdout KEY=VALUE，会进入阶段输出变量）：
#   defaults: LMCACHE_SIDECAR_ENABLED / LMCACHE_LOG_LEVEL / LMCACHE_L2_ENABLED / LMCACHE_OTLP_ENDPOINT
#   patch   : LMCACHE_OTLP_PATCHED=<endpoint> 或 LMCACHE_OTLP_PATCH_SKIPPED=<原因>（stderr）
#             LMCACHE_EXTRA_ARGS_PATCHED=<args> 或 ..._PATCH_SKIPPED=<原因>（stderr）
# 退出码：0 正常（含守卫跳过）；2 参数校验失败 / chart 模板漂移。
# 单测：test/test_render_lmcache.sh；集成：test/test_render_target_labels.sh。
set -uo pipefail

SCRIPT_NAME='render-lmcache'

die() {
  echo "[$SCRIPT_NAME] ERROR: $*" >&2
  exit 2
}

note() {
  echo "[$SCRIPT_NAME] $*" >&2
}

# ---------- defaults ----------

cmd_defaults() {
  local enable_lmcache="${ENABLE_LMCACHE:-false}"
  local otlp_endpoint="${LMCACHE_OTLP_ENDPOINT-http://192.168.10.6:4320}"
  local l2_enabled="${LMCACHE_L2_ENABLED:-true}"
  local log_level="${LMCACHE_LOG_LEVEL:-INFO}"
  local extra_args="${LMCACHE_EXTRA_ARGS:-}"

  [[ "$enable_lmcache" == "true" || "$enable_lmcache" == "false" ]] \
    || die "ENABLE_LMCACHE must be true or false: $enable_lmcache"
  [[ "$l2_enabled" == "true" || "$l2_enabled" == "false" ]] \
    || die "LMCACHE_L2_ENABLED must be true or false: $l2_enabled"
  validate_extra_args

  printf 'LMCACHE_SIDECAR_ENABLED=%s\n' "$enable_lmcache"
  printf 'LMCACHE_LOG_LEVEL=%s\n' "$log_level"
  printf 'LMCACHE_L2_ENABLED=%s\n' "$l2_enabled"
  printf 'LMCACHE_OTLP_ENDPOINT=%s\n' "$otlp_endpoint"
  printf 'LMCACHE_EXTRA_ARGS=%s\n' "$extra_args"
}

validate_extra_args() {
  local extra="${LMCACHE_EXTRA_ARGS:-}"
  [[ -z "$extra" ]] && return 0
  [[ "$extra" =~ ^[A-Za-z0-9\ =:/.@,-]+$ ]] \
    || die "LMCACHE_EXTRA_ARGS contains unsafe characters (allowed: alnum space = : / . @ , -): $extra"
}

# ---------- patch ----------

# 渲染结果里 sidecar 是否启用（守卫以渲染结果为准，而非上游意图）
sidecar_enabled() {
  python3 - "$1" <<'PY'
import sys

import yaml

values = yaml.safe_load(open(sys.argv[1], encoding="utf-8")) or {}
sidecar = values.get("lmcacheSidecar")
print("true" if isinstance(sidecar, dict) and sidecar.get("enabled") is True else "false")
PY
}

cmd_patch() {
  local chart_dir="$1" values_file="$2"
  local chart="$chart_dir/templates/raycluster-cluster.yaml"
  local enabled endpoint
  validate_extra_args

  [[ -f "$values_file" ]] || die "values file not found: $values_file"
  enabled="$(sidecar_enabled "$values_file")" || die "failed to parse values file: $values_file"
  endpoint="${LMCACHE_OTLP_ENDPOINT-http://192.168.10.6:4320}"

  if [[ "$enabled" != "true" ]]; then
    # 非 LMCache 部署（含 ENABLE_LMCACHE=false 或模板未启用 sidecar 的 arch）：
    # 旧 chart 本就没有 sidecar args 锚点，不属于模板漂移，不应让渲染失败。
    note "tracing patch skipped: lmcacheSidecar.enabled=${enabled}, endpoint=${endpoint}"
    note "extra-args skipped: lmcacheSidecar.enabled=${enabled}"
    return 0
  fi

  # 骨架 chart（无 raycluster-cluster.yaml）不代表模板漂移：跳过 patch 仅告警。
  if [[ ! -f "$chart" ]]; then
    note "patch skipped: chart template missing: $chart"
    return 0
  fi

  patch_tracing "$chart" "$endpoint" || return $?
  patch_extra_args "$chart" || return $?
  return 0
}

# tracing 参数注入（旧式 chart 兜底）：
# - 新式模板已原生携带 tracing args（lmcacheSidecar.tracing.*）→ 跳过
# - endpoint 留空即关（什么都不注入）
patch_tracing() {
  local chart="$1" endpoint="$2"
  [[ -n "$endpoint" ]] || return 0
  python3 - "$chart" "$endpoint" <<'PY'
import pathlib
import sys

chart = pathlib.Path(sys.argv[1])
endpoint = sys.argv[2]
text = chart.read_text(encoding="utf-8")
if "--enable-tracing" in text:
    print("LMCACHE_OTLP_PATCH_SKIPPED=chart template already carries tracing args", file=sys.stderr)
    sys.exit(0)
anchor = '{{- if $isLmcacheL2 }}\n                  --l2-store-policy'
if anchor not in text:
    raise SystemExit("LMCache sidecar args anchor not found in chart template")
patch = "--enable-tracing \\\n                  --otlp-endpoint %s \\\n" % endpoint
chart.write_text(text.replace(anchor, patch + anchor, 1), encoding="utf-8")
print("LMCACHE_OTLP_PATCHED=%s" % endpoint)
PY
}

# 实验钩子：LMCACHE_EXTRA_ARGS 单行注入 sidecar args（锚点同 tracing，幂等）
patch_extra_args() {
  local chart="$1" extra="${LMCACHE_EXTRA_ARGS:-}"
  [[ -n "$extra" ]] || return 0
  python3 - "$chart" "$extra" <<'PY'
import pathlib
import sys

chart = pathlib.Path(sys.argv[1])
extra = sys.argv[2]
text = chart.read_text(encoding="utf-8")
if extra in text:
    print("LMCACHE_EXTRA_ARGS_PATCH_SKIPPED=already present", file=sys.stderr)
    sys.exit(0)
anchor = '{{- if $isLmcacheL2 }}\n                  --l2-store-policy'
if anchor not in text:
    raise SystemExit("LMCache sidecar args anchor not found in chart template")
patch = "%s \\\n" % extra
chart.write_text(text.replace(anchor, patch + anchor, 1), encoding="utf-8")
print("LMCACHE_EXTRA_ARGS_PATCHED=%s" % extra)
PY
}

# ---------- 入口 ----------

command="${1:-}"
[[ "$command" == "defaults" ]] && { shift; cmd_defaults "$@"; exit $?; }
[[ "$command" == "patch" ]] && {
  shift
  [[ $# -eq 2 ]] || die "usage: render-lmcache.sh patch <CHART_DIR> <VALUES_FILE>"
  cmd_patch "$1" "$2"
  exit $?
}
die "usage: render-lmcache.sh <defaults|patch> ..."
