#!/usr/bin/env bash
set -euo pipefail
script="$(cd "$(dirname "$0")/.." && pwd)/lib/render-lmcache.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mk_chart() { # $1=目录 $2=模板内容(新式/无锚点)
  mkdir -p "$1/templates"
  printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$1/Chart.yaml"
  printf '%s\n' "$2" >"$1/templates/raycluster-cluster.yaml"
}

VALUES_OFF='{"lmcacheSidecar": {"enabled": false, "mpPortBase": 5555}}'   # 新模板缺省形态
VALUES_ON='{"lmcacheSidecar": {"enabled": true}}'
VALUES_TRACING='{"lmcacheSidecar": {"enabled": false, "tracing": {"otlpEndpoint": "http://stale:4320"}}}'
CHART_NEW='groupName: {{ $teGroupValues.name }}
{{- if $.Values.lmcacheSidecar.enabled }}
- name: lmcache-sidecar
  args:
    {{- if $isLmcacheL2 }}
                  --l2-store-policy default --l2-adapter "$l2_adapter_json" \
    {{- end }}
    {{- if $lmcacheTracingEnabled }}
                  --enable-tracing \
                  --otlp-endpoint {{ $lmcacheTracing.otlpEndpoint }}
    {{- end }}
{{- end }}'
CHART_NOANCHOR='groupName: {{ $teGroupValues.name }}'

read_values() { # $1=values 文件 $2=python 表达式
  python3 - "$1" "$2" <<'PY'
import sys
import yaml

values = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
print(eval(sys.argv[2], {}, {"values": values}))
PY
}

# --- defaults：默认值 / 开关映射 / 显式空 endpoint 保留 ---
out=$(bash "$script" defaults)
grep -Fq 'LMCACHE_SIDECAR_ENABLED=false' <<<"$out"
grep -Fq 'LMCACHE_OTLP_ENDPOINT=http://192.168.10.6:4320' <<<"$out"
grep -Fq 'LMCACHE_EXTRA_ARGS=' <<<"$out"
[[ $(bash "$script" defaults | wc -l) -eq 3 ]] || { echo 'defaults 行数不对' >&2; exit 1; }
out=$(ENABLE_LMCACHE=true bash "$script" defaults)
grep -Fq 'LMCACHE_SIDECAR_ENABLED=true' <<<"$out"
out=$(LMCACHE_OTLP_ENDPOINT= bash "$script" defaults)
grep -Fxq 'LMCACHE_OTLP_ENDPOINT=' <<<"$out" || { echo '显式空 endpoint 被默认值覆盖' >&2; exit 1; }

# --- defaults：参数校验失败 rc=2 ---
rc=0; ( ENABLE_LMCACHE=yes bash "$script" defaults ) >/dev/null 2>&1 || rc=$?
[[ $rc -eq 2 ]] || { echo "非法 ENABLE_LMCACHE 未报错: rc=$rc" >&2; exit 1; }
rc=0; ( LMCACHE_EXTRA_ARGS='--x "$(boom)"' bash "$script" defaults ) >/dev/null 2>&1 || rc=$?
[[ $rc -eq 2 ]] || { echo "危险 EXTRA_ARGS 未报错: rc=$rc" >&2; exit 1; }
rc=0; ( bash "$script" bogus ) >/dev/null 2>&1 || rc=$?
[[ $rc -eq 2 ]] || { echo '未知子命令未报错' >&2; exit 1; }

# --- patch：新模板（enabled 写死 false）+ 开启 → values 点亮 + tracing 写入 ---
mk_chart "$tmp/chart-new" "$CHART_NEW"
echo "$VALUES_OFF" >"$tmp/values-off.json"
out=$(ENABLE_LMCACHE=true \
  LMCACHE_EXTRA_ARGS='--worker-reap-timeout-seconds 60 --worker-registration-grace-seconds 60' \
  bash "$script" patch "$tmp/chart-new" "$tmp/values-off.json" 2>&1); rc=$?
[[ $rc -eq 0 ]] || { echo "新模板开启应成功: rc=$rc $out" >&2; exit 1; }
grep -Fq 'LMCACHE_VALUES_PATCHED=enabled=true,tracing.otlpEndpoint=http://192.168.10.6:4320' <<<"$out"
grep -Fq 'LMCACHE_EXTRA_ARGS_PATCHED=--worker-reap-timeout-seconds 60' <<<"$out"
[[ "$(read_values "$tmp/values-off.json" 'values["lmcacheSidecar"]["enabled"]')" == "True" ]] \
  || { echo 'enabled 未写入 true' >&2; exit 1; }
[[ "$(read_values "$tmp/values-off.json" 'values["lmcacheSidecar"]["tracing"]["otlpEndpoint"]')" == "http://192.168.10.6:4320" ]] \
  || { echo 'tracing.otlpEndpoint 未写入' >&2; exit 1; }
# 模板固化的其余键不被篡改
[[ "$(read_values "$tmp/values-off.json" 'values["lmcacheSidecar"]["mpPortBase"]')" == "5555" ]] \
  || { echo '模板固化键被篡改' >&2; exit 1; }
# EXTRA_ARGS 注入锚点前（同一 exec 命令内）
extra_no=$(grep -Fn -- '--worker-registration-grace-seconds 60 \' "$tmp/chart-new/templates/raycluster-cluster.yaml" | head -1 | cut -d: -f1)
anchor_no=$(grep -Fn -- '--l2-store-policy' "$tmp/chart-new/templates/raycluster-cluster.yaml" | head -1 | cut -d: -f1)
[[ -n "$extra_no" && -n "$anchor_no" && $((anchor_no - extra_no)) -le 3 ]] \
  || { echo 'extra args 未紧邻 L2 锚点' >&2; exit 1; }

# 幂等：二次 patch 只报 SKIPPED，不重复注入
out=$(ENABLE_LMCACHE=true \
  LMCACHE_EXTRA_ARGS='--worker-reap-timeout-seconds 60 --worker-registration-grace-seconds 60' \
  bash "$script" patch "$tmp/chart-new" "$tmp/values-off.json" 2>&1); rc=$?
[[ $rc -eq 0 ]] || { echo "幂等二次应 rc 0: rc=$rc" >&2; exit 1; }
grep -Fq 'LMCACHE_EXTRA_ARGS_PATCH_SKIPPED=already present' <<<"$out"
[[ $(grep -Fc -- '--worker-registration-grace-seconds 60' "$tmp/chart-new/templates/raycluster-cluster.yaml") -eq 1 ]] \
  || { echo 'extra args 重复注入' >&2; exit 1; }

# --- patch：关闭（缺省 ENABLE_LMCACHE）→ values 写回 false，chart 不注入 ---
mk_chart "$tmp/chart-off" "$CHART_NEW"
echo "$VALUES_TRACING" >"$tmp/values-tracing.json"
out=$(bash "$script" patch "$tmp/chart-off" "$tmp/values-tracing.json" 2>&1); rc=$?
[[ $rc -eq 0 ]] || { echo "关闭应 rc 0: rc=$rc" >&2; exit 1; }
grep -Fq 'LMCACHE_VALUES_PATCHED=enabled=false' <<<"$out"
grep -Fq 'extra-args skipped: lmcacheSidecar.enabled=false' <<<"$out"
[[ "$(read_values "$tmp/values-tracing.json" 'values["lmcacheSidecar"]["enabled"]')" == "False" ]] \
  || { echo 'enabled 未写回 false' >&2; exit 1; }
# 关闭时不动 tracing（sidecar 不渲染，模板残留值无副作用）
grep -Fq 'http://stale:4320' "$tmp/values-tracing.json" \
  || { echo '关闭时不应动 tracing 键' >&2; exit 1; }
! grep -Fq -- '--worker-reap' "$tmp/chart-off/templates/raycluster-cluster.yaml" \
  || { echo '关闭时不应注入 extra args' >&2; exit 1; }

# --- patch：endpoint 显式置空 + 开启 → 删除 tracing 键关 tracing ---
mk_chart "$tmp/chart-nootlp" "$CHART_NEW"
echo "$VALUES_TRACING" >"$tmp/values-stale.json"
out=$(ENABLE_LMCACHE=true LMCACHE_OTLP_ENDPOINT= \
  bash "$script" patch "$tmp/chart-nootlp" "$tmp/values-stale.json" 2>&1); rc=$?
[[ $rc -eq 0 ]] || { echo "空 endpoint 应成功: rc=$rc" >&2; exit 1; }
grep -Fq 'LMCACHE_VALUES_PATCHED=enabled=true,tracing.otlpEndpoint removed' <<<"$out"
[[ "$(read_values "$tmp/values-stale.json" '"otlpEndpoint" in values["lmcacheSidecar"].get("tracing", {})')" == "False" ]] \
  || { echo '置空后 otlpEndpoint 应被删除' >&2; exit 1; }

# --- patch：骨架 chart 缺模板文件 → values 照常写入，chart 侧跳过 rc 0 ---
mkdir -p "$tmp/chart-skel"; printf 'apiVersion: v2\nname: xds-test\n' >"$tmp/chart-skel/Chart.yaml"
echo "$VALUES_OFF" >"$tmp/values-skel.json"
out=$(ENABLE_LMCACHE=true bash "$script" patch "$tmp/chart-skel" "$tmp/values-skel.json" 2>&1); rc=$?
[[ $rc -eq 0 ]] || { echo "骨架 chart 应跳过: rc=$rc" >&2; exit 1; }
grep -Fq 'patch skipped: chart template missing' <<<"$out"
grep -Fq 'LMCACHE_VALUES_PATCHED=enabled=true,tracing.otlpEndpoint=http://192.168.10.6:4320' <<<"$out"

# --- patch：启用但缺锚点 → 模板漂移，硬报错 ---
mk_chart "$tmp/chart-noanchor" "$CHART_NOANCHOR"
echo "$VALUES_ON" >"$tmp/values-on.json"
rc=0; ENABLE_LMCACHE=true LMCACHE_EXTRA_ARGS='--flag-a 1' \
  bash "$script" patch "$tmp/chart-noanchor" "$tmp/values-on.json" >/dev/null 2>&1 || rc=$?
[[ $rc -ne 0 ]] || { echo '缺锚点未报错' >&2; exit 1; }

# --- patch：values 结构异常 → rc 2 ---
printf 'lmcacheSidecar: not-a-mapping\n' >"$tmp/values-bad.json"
rc=0; bash "$script" patch "$tmp/chart-new" "$tmp/values-bad.json" >/dev/null 2>&1 || rc=$?
[[ $rc -eq 2 ]] || { echo "lmcacheSidecar 非 mapping 应 rc 2: rc=$rc" >&2; exit 1; }
rc=0; bash "$script" patch "$tmp/chart-new" "$tmp/nope.json" >/dev/null 2>&1 || rc=$?
[[ $rc -eq 2 ]] || { echo "values 缺失应 rc 2: rc=$rc" >&2; exit 1; }

echo 'PASS: render-lmcache defaults, values patch, extra-args injection, idempotency'
