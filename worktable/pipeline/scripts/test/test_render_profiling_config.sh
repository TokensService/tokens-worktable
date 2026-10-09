#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/chart/templates"
printf 'apiVersion: v2\nname: xds-cluster\nversion: 0.1.0\n' >"$WORK/chart/Chart.yaml"
printf 'groupName: {{ $teGroupValues.name }}\ngroupName: {{ $groupName }}\n' >"$WORK/chart/templates/raycluster-cluster.yaml"
cat >"$WORK/values.yaml" <<'VALUES'
common:
  containerEnv: []
frameworkConfigFiles:
  xds_framework.conf: "mock_db = false\n"
workerGroups:
  taskExecutorGroup-card: {}
  jobExecutorGroup: {}
VALUES
cat >"$WORK/architecture.json" <<'ARCH'
[
  {
    "arch_name": "profiling-test",
    "deploy_spec_packages": [{
      "spec_package_name": "profiling-test",
      "deploy_specs": [
        {"name":"prefill","role":"prefill","params":{},"min":1,"max":1,"default":1,"resources":[{"cpu":1,"gpu":1,"memory":"1G"}]},
        {"name":"decode","role":"decode","params":{},"min":1,"max":1,"default":1,"resources":[{"cpu":1,"gpu":1,"memory":"1G"}]}
      ]
    }]
  }
]
ARCH
ENABLE_PROFILING=true \
RUN_DIR="$WORK/run" \
CHART_TEMPLATE_DIR="$WORK/chart" \
VALUES_TEMPLATE="$WORK/values.yaml" \
ARCH_FILE="$WORK/architecture.json" \
ARCH_NAME=profiling-test \
DEPLOY_IMAGE=registry.example.com/xds:test \
TARGET_HOSTS='[{"ip":"192.0.2.10","user":"root"}]' \
MOCK_DB=false \
ENABLE_LMCACHE_TRACING=false \
bash "$ROOT/render-config.sh" >/dev/null
python3 - "$WORK/run/rendered/architecture.request.json" <<'PY'
import json,sys
arch=json.load(open(sys.argv[1], encoding='utf-8'))
specs=arch['deploy_spec_packages'][0]['deploy_specs']
by_role={s['role']:s['params'] for s in specs}
for role, path in [('prefill','/home/service/works/models_ssd/profile/prefill'),('decode','/home/service/works/models_ssd/profile/decode')]:
    cfg=by_role[role]['profiler_config']
    assert cfg['profiler']=='torch', cfg
    assert cfg['torch_profiler_dir']==path, cfg
    assert cfg['ignore_frontend'] is True, cfg
print('profiling config passed')
PY
