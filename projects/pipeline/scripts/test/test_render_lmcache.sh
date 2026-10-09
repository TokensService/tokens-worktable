#!/usr/bin/env bash
set -euo pipefail
script="$(cd "$(dirname "$0")/.." && pwd)/lib/render-lmcache.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mk_chart() { # $1=目录 $2=模板内容(旧式/原生/无锚点)
  mkdir -p "$1/templates"
  printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$1/Chart.yaml"
  printf '%s\n' "$2" >"$1/templates/raycluster-cluster.yaml"
}

VALUES_ON='{"lmcacheSidecar": {"enabled": true}}'
VALUES_OFF='{"lmcacheSidecar": {"enabled": false}}'
CHART_OLD='groupName: {{ $teGroupValues.name }}
{{- if $.Values.lmcacheSidecar.enabled }}
- name: lmcache-sidecar
  args:
    {{- if $isLmcacheL2 }}
                  --l2-store-policy default
    {{- end }}
{{- end }}'
CHART_NATIVE='groupName: {{ $teGroupValues.name }}
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

# --- defaults：默认值 / 开关映射 / 显式空 endpoint 保留 ---
out=$(bash "$script" defaults)
grep -Fq 'LMCACHE_SIDECAR_ENABLED=false' <<<"$out"
grep -Fq 'LMCACHE_LOG_LEVEL=INFO' <<<"$out"
grep -Fq 'LMCACHE_L2_ENABLED=true' <<<"$out"
grep -Fq 'LMCACHE_OTLP_ENDPOINT=http://192.168.10.6:4320' <<<"$out"
[[ $(bash "$script" defaults | wc -l) -eq 5 ]] || { echo 'defaults 行数不对' >&2; exit 1; }
out=$(ENABLE_LMCACHE=true LMCACHE_L2_ENABLED=false LMCACHE_LOG_LEVEL=DEBUG bash "$script" defaults)
grep -Fq 'LMCACHE_SIDECAR_ENABLED=true' <<<"$out"
grep -Fq 'LMCACHE_L2_ENABLED=false' <<<"$out"
grep -Fq 'LMCACHE_LOG_LEVEL=DEBUG' <<<"$out"
out=$(LMCACHE_OTLP_ENDPOINT= bash "$script" defaults)
grep -Fxq 'LMCACHE_OTLP_ENDPOINT=' <<<"$out" || { echo '显式空 endpoint 被默认值覆盖' >&2; exit 1; }

# --- defaults：参数校验失败 rc=2 ---
rc=0; ( ENABLE_LMCACHE=yes bash "$script" defaults ) >/dev/null 2>&1 || rc=$?
[[ $rc -eq 2 ]] || { echo "非法 ENABLE_LMCACHE 未报错: rc=$rc" >&2; exit 1; }
rc=0; ( LMCACHE_EXTRA_ARGS='--x "$(boom)"' bash "$script" defaults ) >/dev/null 2>&1 || rc=$?
[[ $rc -eq 2 ]] || { echo "危险 EXTRA_ARGS 未报错: rc=$rc" >&2; exit 1; }
rc=0; ( bash "$script" bogus ) >/dev/null 2>&1 || rc=$?
[[ $rc -eq 2 ]] || { echo "未知子命令未报错: rc=$rc" >&2; exit 1; }

# --- patch：sidecar 未启用 → 跳过且 rc 0 ---
mk_chart "$tmp/chart-old" "$CHART_OLD"
echo "$VALUES_OFF" >"$tmp/values-off.json"
out=$(bash "$script" patch "$tmp/chart-old" "$tmp/values-off.json" 2>&1); rc=$?
[[ $rc -eq 0 ]] || { echo "sidecar 未启用应 rc 0: rc=$rc" >&2; exit 1; }
grep -Fq 'tracing patch skipped: lmcacheSidecar.enabled=false' <<<"$out"
grep -Fq 'extra-args skipped' <<<"$out"

# --- patch：旧式 chart + 启用 → tracing 注入锚点前；EXTRA_ARGS 注入且幂等 ---
echo "$VALUES_ON" >"$tmp/values-on.json"
out=$(LMCACHE_EXTRA_ARGS='--worker-reap-timeout-seconds 60 --worker-registration-grace-seconds 60' \
  bash "$script" patch "$tmp/chart-old" "$tmp/values-on.json" 2>&1); rc=$?
[[ $rc -eq 0 ]] || { echo "启用+旧chart 应成功: rc=$rc $out" >&2; exit 1; }
grep -Fq 'LMCACHE_OTLP_PATCHED=http://192.168.10.6:4320' <<<"$out"
grep -Fq 'LMCACHE_EXTRA_ARGS_PATCHED=--worker-reap-timeout-seconds 60' <<<"$out"
rendered="$tmp/chart-old/templates/raycluster-cluster.yaml"
tracing_line=$(grep -Fn -- '--enable-tracing \' "$rendered" | head -1 | cut -d: -f1)
anchor_line=$(grep -Fn -- '--l2-store-policy' "$rendered" | head -1 | cut -d: -f1)
[[ -n "$tracing_line" && -n "$anchor_line" && $tracing_line -lt $anchor_line ]] \
  || { echo 'tracing 未注入在锚点前' >&2; exit 1; }
grep -Fq -- '--worker-reap-timeout-seconds 60 --worker-registration-grace-seconds 60 \' "$rendered"
# 幂等：二次 patch 只报 SKIPPED，不重复注入
out=$(LMCACHE_EXTRA_ARGS='--worker-reap-timeout-seconds 60 --worker-registration-grace-seconds 60' \
  bash "$script" patch "$tmp/chart-old" "$tmp/values-on.json" 2>&1); rc=$?
[[ $rc -eq 0 ]] || { echo "幂等二次应 rc 0: rc=$rc" >&2; exit 1; }
grep -Fq 'LMCACHE_OTLP_PATCH_SKIPPED=chart template already carries tracing args' <<<"$out"
grep -Fq 'LMCACHE_EXTRA_ARGS_PATCH_SKIPPED=already present' <<<"$out"
[[ $(grep -Fc -- '--enable-tracing' "$rendered") -eq 1 ]] || { echo 'tracing 重复注入' >&2; exit 1; }

# --- patch：原生模板 → tracing 跳过，EXTRA_ARGS 仍可注入 ---
mk_chart "$tmp/chart-native" "$CHART_NATIVE"
out=$(LMCACHE_EXTRA_ARGS='--worker-reap-timeout-seconds 0' \
  bash "$script" patch "$tmp/chart-native" "$tmp/values-on.json" 2>&1); rc=$?
[[ $rc -eq 0 ]] || { echo "原生模板应成功: rc=$rc" >&2; exit 1; }
grep -Fq 'LMCACHE_OTLP_PATCH_SKIPPED=chart template already carries tracing args' <<<"$out"
grep -Fq -- '--worker-reap-timeout-seconds 0 \' "$tmp/chart-native/templates/raycluster-cluster.yaml"

# --- patch：endpoint 显式置空 → 不注入 tracing，EXTRA_ARGS 照常 ---
mk_chart "$tmp/chart-old2" "$CHART_OLD"
out=$(LMCACHE_OTLP_ENDPOINT= LMCACHE_EXTRA_ARGS='--flag-a 1' \
  bash "$script" patch "$tmp/chart-old2" "$tmp/values-on.json" 2>&1); rc=$?
[[ $rc -eq 0 ]] || { echo "空 endpoint 应成功: rc=$rc" >&2; exit 1; }
! grep -Fq -- '--enable-tracing' "$tmp/chart-old2/templates/raycluster-cluster.yaml" \
  || { echo '空 endpoint 不应注入 tracing' >&2; exit 1; }
grep -Fq -- '--flag-a 1 \' "$tmp/chart-old2/templates/raycluster-cluster.yaml"

# --- patch：骨架 chart 缺模板文件 → 跳过 rc 0 ---
mkdir -p "$tmp/chart-skel"; printf 'apiVersion: v2\nname: xds-test\n' >"$tmp/chart-skel/Chart.yaml"
out=$(bash "$script" patch "$tmp/chart-skel" "$tmp/values-on.json" 2>&1); rc=$?
[[ $rc -eq 0 ]] || { echo "骨架 chart 应跳过: rc=$rc" >&2; exit 1; }
grep -Fq 'patch skipped: chart template missing' <<<"$out"

# --- patch：启用但缺锚点 → 模板漂移，硬报错 ---
mk_chart "$tmp/chart-noanchor" "$CHART_NOANCHOR"
rc=0; bash "$script" patch "$tmp/chart-noanchor" "$tmp/values-on.json" >/dev/null 2>&1 || rc=$?
[[ $rc -ne 0 ]] || { echo '缺锚点未报错' >&2; exit 1; }

# --- patch：values 文件不存在 → rc 2 ---
rc=0; bash "$script" patch "$tmp/chart-old" "$tmp/nope.json" >/dev/null 2>&1 || rc=$?
[[ $rc -eq 2 ]] || { echo "values 缺失应 rc 2: rc=$rc" >&2; exit 1; }

echo 'PASS: render-lmcache defaults, patch guards, tracing/extra injection, idempotency'
