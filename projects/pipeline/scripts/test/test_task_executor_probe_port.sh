#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/chart"
cat >"$WORK/chart/Chart.yaml" <<'EOF'
apiVersion: v2
name: xds-cluster
version: 0.1.0
EOF
cat >"$WORK/values.yaml" <<'EOF'
workerGroups:
  taskExecutorGroup-card:
    livenessProbe:
      exec:
        command: [bash, -c, 'wget -q -O- http://localhost:52365/api/local_raylet_healthz | grep success']
    readinessProbe:
      exec:
        command: [bash, -c, 'wget -q -O- http://localhost:52365/api/local_raylet_healthz | grep success']
    startupProbe:
      exec:
        command: [bash, -c, 'wget -q -O- http://localhost:52365/api/local_raylet_healthz | grep success']
EOF
cat >"$WORK/architecture.json" <<'EOF'
[{"arch_name":"probe-port-test","deploy_spec_packages":[{"spec_package_name":"probe-port-test","deploy_specs":[{"name":"prefill","role":"prefill","min":1,"max":1,"default":1,"params":{},"resources":[{"gpu":4,"cpu":1,"memory":"1G"}]},{"name":"decode","role":"decode","min":1,"max":1,"default":1,"params":{},"resources":[{"gpu":4,"cpu":1,"memory":"1G"}]}]}]}]
EOF

RUN_DIR="$WORK/run" \
CHART_TEMPLATE_DIR="$WORK/chart" \
VALUES_TEMPLATE="$WORK/values.yaml" \
ARCH_FILE="$WORK/architecture.json" \
ARCH_NAME=probe-port-test \
DEPLOY_IMAGE=registry.example.com/xds:test \
TARGET_HOSTS='[{"ip":"192.0.2.10","user":"root"}]' \
MOCK_DB=false \
bash "$ROOT/render-config.sh" >"$WORK/render.out"

VALUES_FILE="$(awk -F= '/^VALUES_FILE=/{print $2}' "$WORK/render.out")"
python3 - "$VALUES_FILE" <<'PY'
import sys
import yaml

values = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
probes = values["workerGroups"]["taskExecutorGroup-card"]
for name in ("livenessProbe", "readinessProbe", "startupProbe"):
    command = probes[name]["exec"]["command"][-1]
    assert "{DASHBOARD_AGENT_LISTEN_PORT}" in command
    assert ":52365/" not in command

groups = values["taskExecutorGroups"]
assert [group["rayStartParamsPorts"]["dashboard-agent-listen-port"] for group in groups] == [33300, 33301]
port_ranges = [
    (group["rayStartParamsPorts"]["min-worker-port"], group["rayStartParamsPorts"]["max-worker-port"])
    for group in groups
]
assert port_ranges[0][0] <= port_ranges[0][1]
assert port_ranges[1][0] <= port_ranges[1][1]
assert port_ranges[0][1] < port_ranges[1][0]
ray_start_params = values["workerGroups"]["taskExecutorGroup-card"]["rayStartParams"]
assert "min-worker-port" in ray_start_params
assert "max-worker-port" in ray_start_params
PY

echo "PASS: task executor probes use each group's dashboard agent port"
