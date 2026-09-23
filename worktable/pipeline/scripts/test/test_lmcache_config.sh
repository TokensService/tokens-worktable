#!/usr/bin/env bash
set -euo pipefail
script="$(cd "$(dirname "$0")/.." && pwd)/lmcache-config.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --- 无参+空环境：step 存在即开启，输出契约五件套 ---
out=$(bash "$script"); rc=$?
[[ $rc -eq 0 ]] || { echo "空环境应成功: rc=$rc" >&2; exit 1; }
grep -Fxq 'ENABLE_LMCACHE=true' <<<"$out" || { echo '缺省应 ENABLE_LMCACHE=true' >&2; exit 1; }
grep -Fxq 'LMCACHE_OTLP_ENDPOINT=http://192.168.10.6:4320' <<<"$out"
grep -Fxq 'LMCACHE_L2_ENABLED=true' <<<"$out"
grep -Fxq 'LMCACHE_LOG_LEVEL=INFO' <<<"$out"
grep -Fxq 'LMCACHE_EXTRA_ARGS=' <<<"$out" || { echo 'EXTRA_ARGS 缺省应为空行' >&2; exit 1; }
! grep -q '^LMCACHE_SIDECAR_ENABLED=' <<<"$out" \
  || { echo '内部占位符 LMCACHE_SIDECAR_ENABLED 不应进契约' >&2; exit 1; }
[[ $(wc -l <<<"$out") -eq 5 ]] || { echo "契约行数应为 5: $(wc -l <<<"$out")" >&2; exit 1; }

# --- step 参数透传 + 显式 false ---
out=$(ENABLE_LMCACHE=false LMCACHE_L2_ENABLED=false LMCACHE_LOG_LEVEL=DEBUG \
  LMCACHE_EXTRA_ARGS='--worker-reap-timeout-seconds 60' bash "$script")
grep -Fxq 'ENABLE_LMCACHE=false' <<<"$out"
grep -Fxq 'LMCACHE_L2_ENABLED=false' <<<"$out"
grep -Fxq 'LMCACHE_LOG_LEVEL=DEBUG' <<<"$out"
grep -Fxq 'LMCACHE_EXTRA_ARGS=--worker-reap-timeout-seconds 60' <<<"$out"

# --- step 层用 :- 语义：显式空也被默认值填上（表单发不出显式空；置空关
# tracing 的 - 语义保留在渲染层 lib/render-lmcache.sh） ---
out=$(LMCACHE_OTLP_ENDPOINT= bash "$script")
grep -Fxq 'LMCACHE_OTLP_ENDPOINT=http://192.168.10.6:4320' <<<"$out" \
  || { echo 'step 层空 endpoint 应被默认值填上' >&2; exit 1; }

# --- 校验失败：step 应失败且报错可读 ---
rc=0; out=$(ENABLE_LMCACHE=garbage bash "$script" 2>"$tmp/err") || rc=$?
[[ $rc -ne 0 ]] || { echo '非法 ENABLE_LMCACHE 未报错' >&2; exit 1; }
grep -Fq 'ENABLE_LMCACHE must be true or false' "$tmp/err"
rc=0; out=$(LMCACHE_EXTRA_ARGS='--x $(boom)' bash "$script" 2>"$tmp/err2") || rc=$?
[[ $rc -ne 0 ]] || { echo '危险 EXTRA_ARGS 未报错' >&2; exit 1; }
grep -Fq 'unsafe characters' "$tmp/err2"

# --- 端到端：step 输出注入下游 render-config 环境，渲染默认关闭不受影响 ---
work=$(mktemp -d)
cat >"$work/values.yaml" <<'EOF'
common:
  containerEnv:
    - name: XDS_DATABASE_NAME
      value: {XDS_DATABASE_NAME}
    - name: XDS_DATABASE_PASSWORD
      value: {DATABASE_PASSWORD}
frameworkConfigFiles:
  xds_framework.conf: |
    [metric]
    pushgateway = true
    collector_gateway_url = 192.168.10.6:25888
    [deploy]
    k8s_deploy_namespace = old-namespace
lmcacheSidecar:
  enabled: {LMCACHE_SIDECAR_ENABLED}
  logLevel: {LMCACHE_LOG_LEVEL}
  l2Enabled: {LMCACHE_L2_ENABLED}
  tracing:
    otlpEndpoint: {LMCACHE_OTLP_ENDPOINT}
EOF
mkdir -p "$work/chart/templates"
printf 'apiVersion: v2\nname: t\nversion: 0.1.0\n' >"$work/chart/Chart.yaml"
cat >"$work/chart/templates/raycluster-cluster.yaml" <<'EOF'
groupName: {{ $teGroupValues.name }}
groupName: {{ $groupName }}
{{- if $.Values.lmcacheSidecar.enabled }}
- name: lmcache-sidecar
  args:
    {{- if $isLmcacheL2 }}
                  --l2-store-policy default
    {{- end }}
{{- end }}
EOF
cat >"$work/chart/templates/ray-svc.yaml" <<'EOF'
apiVersion: v1
kind: Service
spec:
  # Ray Serve 模式：Service 指向 Ray frontGroup
  selector:
    app.kubernetes.io/created-by: kuberay-operator
    ray.io/group: frontGroup
    in_draining_status: "false"
    app.kubernetes.io/instance: {{ .Release.Name }}
EOF
cat >"$work/arch.json" <<'EOF'
[
  {
    "arch_name": "test-arch",
    "use_ems": false,
    "deploy_spec_packages": [
      {
        "deploy_specs": [
          {"role": "prefill", "min": 1, "max": 1, "default": 1,
           "resources": [{"cpu": 1, "gpu": 4, "memory": "1G"}]},
          {"role": "decode", "min": 1, "max": 1, "default": 1,
           "resources": [{"cpu": 1, "gpu": 4, "memory": "1G"}]}
        ]
      }
    ]
  }
]
EOF
# 无 lmcache step：不注入任何 LMCACHE 变量，渲染应成功且 sidecar 关
out=$(ARCH_NAME=test-arch RUN_DIR="$work/run" CHART_TEMPLATE_DIR="$work/chart" \
  VALUES_TEMPLATE="$work/values.yaml" ARCH_FILE="$work/arch.json" \
  DEPLOY_IMAGE='registry.example/xds:t' NAMESPACE='ns-plain' TARGET_HOSTS='[{"ip":"192.168.0.1"}]' \
  bash "$(dirname "$script")/render-config.sh" 2>"$work/render.err") || {
  echo "无 lmcache step 渲染失败"; cat "$work/render.err" >&2; exit 1; }
grep -Fxq '  enabled: false' "$work/run/rendered/values.rendered.yaml" \
  || { echo '无 step 时 sidecar 应为 false'; cat "$work/run/rendered/values.rendered.yaml" >&2; exit 1; }
# 有 lmcache step：step 契约变量注入后渲染应点亮 sidecar
step_out=$(bash "$script")
while IFS='=' read -r k v; do export "$k=$v"; done <<<"$step_out"
out=$(ARCH_NAME=test-arch RUN_DIR="$work/run2" CHART_TEMPLATE_DIR="$work/chart" \
  VALUES_TEMPLATE="$work/values.yaml" ARCH_FILE="$work/arch.json" \
  DEPLOY_IMAGE='registry.example/xds:t' NAMESPACE='ns-lmcache' TARGET_HOSTS='[{"ip":"192.168.0.1"}]' \
  bash "$(dirname "$script")/render-config.sh" 2>"$work/render2.err") || {
  echo "注入 step 契约后渲染失败"; cat "$work/render2.err" >&2; exit 1; }
grep -Fxq '  enabled: true' "$work/run2/rendered/values.rendered.yaml" \
  || { echo 'step 契约注入后 sidecar 应为 true'; cat "$work/run2/rendered/values.rendered.yaml" >&2; exit 1; }
grep -Fxq '    otlpEndpoint: http://192.168.10.6:4320' "$work/run2/rendered/values.rendered.yaml"
rm -rf "$work"

echo 'PASS: lmcache-config step 契约、校验、下游点亮/缺省关闭全链路'
