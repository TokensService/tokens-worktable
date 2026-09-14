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
  enabled: true
  resources: {}
VALUES
cat >"$WORK/architecture.json" <<'ARCH'
[{"arch_name":"lmcache-probe-test","deploy_spec_packages":[{"deploy_specs":[{"role":"prefill","min":2,"max":2,"default":2,"resources":[{"gpu":1,"cpu":1,"memory":"1G"}]}]}]}]
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
for name in ("startupProbe", "readinessProbe", "livenessProbe"):
    probe = sidecar[name]
    assert probe["httpGet"] == {
        "host": "127.0.0.1",
        "path": "/healthcheck",
        "port": "lmcache-http",
    }, probe
assert sidecar["startupProbe"]["failureThreshold"] == 120
assert sidecar["readinessProbe"]["failureThreshold"] == 3
assert sidecar["livenessProbe"]["failureThreshold"] == 6
PY

template="$WORK/run/rendered/xds-cluster/templates/raycluster-cluster.yaml"
for probe in startupProbe readinessProbe livenessProbe; do
  grep -Fq "{{- if \$lmcache.${probe} }}" "$template"
  grep -Fq "${probe}:" "$template"
done
grep -Fq 'resources: {{- toYaml $lmcache.resources | nindent 6 }}' "$template"

echo 'PASS: LMCache sidecar probe defaults and template rendering are configured'
