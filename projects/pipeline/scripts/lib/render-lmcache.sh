#!/usr/bin/env bash
# LMCache 渲染期逻辑（独立于 render-config.sh 主流程）：
#   defaults : 解析+校验全部 LMCache 入参，输出规范值（KEY=VALUE），供
#              lmcache-config step 契约输出与渲染主流程 fail-fast 校验；
#              校验失败 exit 2。
#   patch    : 渲染后对 values 做结构化写入（新版模板接口），并对 chart
#              副本注入 LMCACHE_EXTRA_ARGS 实验参数；含启用守卫与幂等。
# 环境变量（平台阶段参数透传）：
#   ENABLE_LMCACHE         sidecar 总开关（true/false，默认 false）
#   LMCACHE_OTLP_ENDPOINT  OTLP 上报地址：非空即开 tracing、显式置空即关
#                          （注意 - 非 :- 语义；缺省 http://192.168.10.6:4320）
#   LMCACHE_EXTRA_ARGS     实验钩子：额外 sidecar 命令行参数，渲染后注入
#                          chart（免改模板/免出镜像）。仅 alnum/空格/=:/.@,-
#                          允许；留空不注入。
# 新版模板接口（values 键驱动，chart 原生条件渲染，无 {LMCACHE_*} 占位符）：
#   lmcacheSidecar.enabled               sidecar 总开关（模板缺省 false）
#   lmcacheSidecar.tracing.otlpEndpoint  非空 → chart 渲染 --enable-tracing
#                                        --otlp-endpoint <值>
# 旧版占位符插值与 chart tracing 文本注入已随旧模板退役移除。
# 输出契约（stdout KEY=VALUE，会进入阶段输出变量）：
#   defaults: LMCACHE_SIDECAR_ENABLED / LMCACHE_OTLP_ENDPOINT / LMCACHE_EXTRA_ARGS
#   patch   : LMCACHE_VALUES_PATCHED=<变更列表>；LMCACHE_EXTRA_ARGS_PATCHED=<args>
#             或 ..._PATCH_SKIPPED=<原因>（stderr）
# 退出码：0 正常（含守卫跳过）；2 参数校验失败 / values 结构异常 / 模板漂移。
# 单测：test/test_render_lmcache.sh；集成：test/test_lmcache_config.sh。
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
  local extra_args="${LMCACHE_EXTRA_ARGS:-}"

  [[ "$enable_lmcache" == "true" || "$enable_lmcache" == "false" ]] \
    || die "ENABLE_LMCACHE must be true or false: $enable_lmcache"
  validate_extra_args

  printf 'LMCACHE_SIDECAR_ENABLED=%s\n' "$enable_lmcache"
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

# 渲染结果里 sidecar 是否启用（守卫以渲染+values patch 后的结果为准）
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
  local enabled
  validate_extra_args

  [[ -f "$values_file" ]] || die "values file not found: $values_file"
  patch_values "$values_file" || return $?
  enabled="$(sidecar_enabled "$values_file")" || die "failed to parse values file: $values_file"

  if [[ "$enabled" != "true" ]]; then
    # 平台意图关闭（ENABLE_LMCACHE=false）：values 已写入最终态，chart 无需注入。
    note "extra-args skipped: lmcacheSidecar.enabled=${enabled}"
    return 0
  fi

  # 骨架 chart（无 raycluster-cluster.yaml）不代表模板漂移：跳过 patch 仅告警。
  if [[ ! -f "$chart" ]]; then
    note "patch skipped: chart template missing: $chart"
    return 0
  fi

  patch_extra_args "$chart" || return $?
  return 0
}

# values 结构化写入（新版模板接口）：
# - ENABLE_LMCACHE 决定 lmcacheSidecar.enabled 最终态（显式写 true/false）
# - 开启且 LMCACHE_OTLP_ENDPOINT 非空 → 写 lmcacheSidecar.tracing.otlpEndpoint
#   （chart 原生条件渲染 --enable-tracing/--otlp-endpoint）；
#   显式置空 → 删除该键关闭 tracing；关闭 sidecar 时不写 tracing 键。
# 注意：整文件 yaml 重写（等价语义，注释会丢失）；values.rendered.yaml 为
# 机器产物、仅喂给 helm，可接受。
patch_values() {
  local values_file="$1"
  local enable="${ENABLE_LMCACHE:-false}"
  local endpoint="${LMCACHE_OTLP_ENDPOINT-http://192.168.10.6:4320}"
  python3 - "$values_file" "$enable" "$endpoint" <<'PY'
import pathlib
import sys

import yaml

path = pathlib.Path(sys.argv[1])
enable = sys.argv[2] == "true"
endpoint = sys.argv[3]
values = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
if not isinstance(values, dict):
    print("values file is not a mapping", file=sys.stderr)
    sys.exit(2)
sidecar = values.get("lmcacheSidecar")
if sidecar is None:
    sidecar = {}
    values["lmcacheSidecar"] = sidecar
elif not isinstance(sidecar, dict):
    print("values lmcacheSidecar is not a mapping", file=sys.stderr)
    sys.exit(2)
changes = ["enabled=%s" % ("true" if enable else "false")]
sidecar["enabled"] = enable
if enable:
    tracing = sidecar.get("tracing")
    if not isinstance(tracing, dict):
        tracing = {}
    if endpoint:
        tracing["otlpEndpoint"] = endpoint
        sidecar["tracing"] = tracing
        changes.append("tracing.otlpEndpoint=%s" % endpoint)
    elif "otlpEndpoint" in tracing or not isinstance(sidecar.get("tracing"), dict) or sidecar.get("tracing"):
        tracing.pop("otlpEndpoint", None)
        if tracing:
            sidecar["tracing"] = tracing
        else:
            sidecar.pop("tracing", None)
        changes.append("tracing.otlpEndpoint removed")
path.write_text(
    yaml.safe_dump(values, sort_keys=False, allow_unicode=True, width=10**6),
    encoding="utf-8",
)
print("LMCACHE_VALUES_PATCHED=" + ",".join(changes))
PY
}

# 实验钩子：LMCACHE_EXTRA_ARGS 单行注入 sidecar args（幂等）
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
