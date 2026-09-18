#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/chart/templates"
cat >"$WORK/chart/Chart.yaml" <<'CHART'
apiVersion: v2
name: xds-cluster
version: 0.1.0
CHART
cat >"$WORK/chart/templates/raycluster-cluster.yaml" <<'TEMPLATE'
{{- $lmcache := $.Values.lmcacheSidecar | default dict }}
{{- $isLmcachePrefill := true }}
groupName: {{ $teGroupValues.name }}
groupName: {{ $groupName }}
containers:
  {{- if $isLmcachePrefill }}
  - name: lmcache-sidecar
    ports:
      - name: lmcache-http
        containerPort: 18080
        protocol: TCP
    args:
      {{- if $isLmcacheL2 }}
                  --l2-store-policy
      {{- end }}
    resources: {{- toYaml $lmcache.resources | nindent 6 }}
  {{- end }}
TEMPLATE
cat >"$WORK/values.yaml" <<'VALUES'
global: {}
# lite 模板契约：渲染器只替换 enabled/l2Enabled；端口/尺寸/资源等默认值
# 固化在 values 模板中，分卡与 sidecar 卡对齐由 device plugin 与 chart 兜底。
lmcacheSidecar:
  enabled: {LMCACHE_SIDECAR_ENABLED}
  l2Enabled: {LMCACHE_L2_ENABLED}
  mpPortBase: 5555
  httpPortBase: 5565
  l1InitSizeGb: 20
  l1SizeGb: 200
  l1AlignBytes: "4096"
  maxWorkers: 1
  cudaVisibleDevices: ''
  resources:
    requests:
      cpu: 4
      memory: 8Gi
    limits:
      cpu: 8
      memory: 240Gi
VALUES
cat >"$WORK/architecture.json" <<'ARCH'
[{"arch_name":"lmcache-probe-test","deploy_spec_packages":[{"deploy_specs":[{"role":"prefill","params":{"use_lmcache":true},"min":1,"max":1,"default":1,"resources":[{"gpu":1,"cpu":1,"memory":"1G"}]},{"role":"decode","min":1,"max":1,"default":1,"resources":[{"gpu":1,"cpu":1,"memory":"1G"}]}]}]}]
ARCH

RUN_DIR="$WORK/run" \
CHART_TEMPLATE_DIR="$WORK/chart" \
VALUES_TEMPLATE="$WORK/values.yaml" \
ARCH_FILE="$WORK/architecture.json" \
ARCH_NAME=lmcache-probe-test \
DEPLOY_IMAGE=registry.example.com/xds:test \
TARGET_HOSTS='[{"ip":"192.0.2.10","user":"root"}]' \
MOCK_DB=false \
ENABLE_LMCACHE=true \
bash "$ROOT/render-config.sh" >/dev/null

python3 - "$WORK/run/rendered/values.rendered.yaml" <<'PY'
import sys
import yaml

values = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
sidecar = values["lmcacheSidecar"]
assert sidecar["enabled"] is True
# lite 默认开启 L2（消费上游 LMCACHE_L2_ENABLED，默认 true）。
assert sidecar["l2Enabled"] is True
# 固化在模板中的 sidecar 默认值不被渲染器篡改。
assert sidecar["mpPortBase"] == 5555
assert sidecar["httpPortBase"] == 5565
assert sidecar["l1InitSizeGb"] == 20
assert sidecar["l1SizeGb"] == 200
assert sidecar["l1AlignBytes"] == "4096"
assert sidecar["maxWorkers"] == 1
assert sidecar["resources"] == {
    "requests": {"cpu": 4, "memory": "8Gi"},
    "limits": {"cpu": 8, "memory": "240Gi"},
}
# lite 不做占卡/卡对齐：sidecar 的 cudaVisibleDevices 保留模板空串，
# 由 chart 兜底从 ray-worker 的 NVIDIA_VISIBLE_DEVICES 推导。
assert sidecar["cudaVisibleDevices"] == ""
groups = values["taskExecutorGroups"]
assert all(
    "NVIDIA_VISIBLE_DEVICES" not in (group.get("containerEnvOverrides") or {})
    for group in groups
), groups
assert not any(name in sidecar for name in ("startupProbe", "readinessProbe", "livenessProbe"))
PY

template="$WORK/run/rendered/xds-cluster/templates/raycluster-cluster.yaml"
if grep -Eq 'startupProbe|readinessProbe|livenessProbe|healthcheck' "$template"; then
  echo 'render-config.sh must not inject LMCache health checks into the Chart' >&2
  exit 1
fi
grep -Fq 'resources: {{- toYaml $lmcache.resources | nindent 6 }}' "$template"

RUN_DIR="$WORK/run-l2" \
CHART_TEMPLATE_DIR="$WORK/chart" \
VALUES_TEMPLATE="$WORK/values.yaml" \
ARCH_FILE="$WORK/architecture.json" \
ARCH_NAME=lmcache-probe-test \
DEPLOY_IMAGE=registry.example.com/xds:test \
TARGET_HOSTS='[{"ip":"192.0.2.10","user":"root"}]' \
MOCK_DB=false \
ENABLE_LMCACHE=false \
LMCACHE_L2_ENABLED=false \
bash "$ROOT/render-config.sh" >/dev/null

python3 - "$WORK/run-l2/rendered/values.rendered.yaml" <<'PY'
import sys
import yaml

sidecar = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))["lmcacheSidecar"]
assert sidecar["enabled"] is False, sidecar
assert sidecar["l2Enabled"] is False, sidecar
PY

echo 'PASS: LMCache health checks remain owned by the Chart and values templates'
