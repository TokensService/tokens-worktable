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
groupName: {{ $teGroupValues.name }}
groupName: {{ $groupName }}
TEMPLATE
cat >"$WORK/values.yaml" <<'VALUES'
common:
  containerEnv:
    - name: EMS_ENABLE
      value: 'false'
frameworkConfigFiles:
  xds_framework.conf: |
    [ems_config]
    ems_enable = false
workerGroups:
  taskExecutorGroup-card:
    ems:
      enable: false
  jobExecutorGroup:
    ems:
      enable: false
VALUES
cat >"$WORK/architecture.json" <<'ARCH'
[
  {
    "arch_name": "ems-from-params",
    "deploy_spec_packages": [{
      "deploy_specs": [
        {"role":"prefill","params":{"use_ems":true},"min":1,"max":1,"default":1,"resources":[{"cpu":1,"gpu":1,"memory":"1G"}]},
        {"role":"decode","params":{"use_ems":true},"min":1,"max":1,"default":1,"resources":[{"cpu":1,"gpu":1,"memory":"1G"}]}
      ]
    }]
  }
]
ARCH

RUN_DIR="$WORK/run" \
CHART_TEMPLATE_DIR="$WORK/chart" \
VALUES_TEMPLATE="$WORK/values.yaml" \
ARCH_FILE="$WORK/architecture.json" \
ARCH_NAME=ems-from-params \
DEPLOY_IMAGE=registry.example.com/xds:test \
TARGET_HOSTS='[{"ip":"192.0.2.10","user":"root"}]' \
MOCK_DB=false \
ENABLE_LMCACHE_TRACING=false \
bash "$ROOT/render-config.sh" >/dev/null

python3 - "$WORK/run/rendered/values.rendered.yaml" <<'PY'
import sys
import yaml

values = yaml.safe_load(open(sys.argv[1], encoding='utf-8'))
assert values['workerGroups']['taskExecutorGroup-card']['ems']['enable'] is True
assert values['workerGroups']['jobExecutorGroup']['ems']['enable'] is True
env = {item['name']: item['value'] for item in values['common']['containerEnv']}
assert env['EMS_ENABLE'] == 'true'
assert 'ems_enable = true' in values['frameworkConfigFiles']['xds_framework.conf']
PY

echo 'PASS: params.use_ems enables EMS rendering'
