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
    resources: {{- toYaml $lmcache.resources | nindent 6 }}
  {{- end }}
TEMPLATE
cat >"$WORK/values.yaml" <<'VALUES'
global: {}
lmcacheSidecar:
  enabled: {LMCACHE_SIDECAR_ENABLED}
  mpPortBase: {LMCACHE_MP_PORT_BASE}
  httpPortBase: {LMCACHE_HTTP_PORT_BASE}
  l1InitSizeGb: {LMCACHE_L1_INIT_SIZE_GB}
  l1SizeGb: {LMCACHE_L1_SIZE_GB}
  l1AlignBytes: {LMCACHE_L1_ALIGN_BYTES}
  l2:
    enabled: {LMCACHE_L2_ENABLED}
    hostPath: {LMCACHE_L2_HOST_PATH}
    mountPath: {LMCACHE_L2_MOUNT_PATH}
    maxCapacityGb: {LMCACHE_L2_MAX_CAPACITY_GB}
    numWorkers: {LMCACHE_L2_NUM_WORKERS}
    useOdirect: {LMCACHE_L2_USE_ODIRECT}
  resources:
    requests:
      cpu: {LMCACHE_CPU_REQUEST}
      memory: {LMCACHE_MEMORY_REQUEST}
    limits:
      cpu: {LMCACHE_CPU_LIMIT}
      memory: {LMCACHE_MEMORY_LIMIT}
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
bash "$ROOT/render-config.sh" >/dev/null

python3 - "$WORK/run/rendered/values.rendered.yaml" <<'PY'
import sys
import yaml

values = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
sidecar = values["lmcacheSidecar"]
assert sidecar["enabled"] is True
assert sidecar["mpPortBase"] == 5555
assert sidecar["httpPortBase"] == 5565
assert sidecar["l1InitSizeGb"] == 20
assert sidecar["l1SizeGb"] == 200
assert sidecar["l1AlignBytes"] == "4096"
assert sidecar["l2"] == {
    "enabled": False,
    "hostPath": "/mnt/paas/lmcache/glm52-l2",
    "mountPath": "/mnt/paas/lmcache/glm52-l2",
    "maxCapacityGb": 10240,
    "numWorkers": 32,
    "useOdirect": False,
}
assert sidecar["resources"] == {
    "requests": {"cpu": 4, "memory": "8Gi"},
    "limits": {"cpu": 8, "memory": "240Gi"},
}
assert sidecar["cudaVisibleDevices"] == "0"
groups = values["taskExecutorGroups"]
assert [group["containerEnvOverrides"]["NVIDIA_VISIBLE_DEVICES"] for group in groups] == ["0", "1"]
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
LMCACHE_L2_ENABLED=true \
LMCACHE_L2_HOST_PATH=/data/lmcache-l2 \
LMCACHE_L2_MOUNT_PATH=/cache/l2 \
LMCACHE_L2_MAX_CAPACITY_GB=2048 \
LMCACHE_L2_NUM_WORKERS=16 \
LMCACHE_L2_USE_ODIRECT=true \
bash "$ROOT/render-config.sh" >/dev/null

python3 - "$WORK/run-l2/rendered/values.rendered.yaml" <<'PY'
import sys
import yaml

values = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
assert values["lmcacheSidecar"]["l2"] == {
    "enabled": True,
    "hostPath": "/data/lmcache-l2",
    "mountPath": "/cache/l2",
    "maxCapacityGb": 2048,
    "numWorkers": 16,
    "useOdirect": True,
}
PY

echo 'PASS: LMCache health checks remain owned by the Chart and values templates'
