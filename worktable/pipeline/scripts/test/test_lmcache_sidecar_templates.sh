#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
template_root="$repo_root/worktable/pipeline/templates/xds-cicd-3p1d-lmcache"
values_template="$template_root/values-16Node-je-cpp-bnt3.yaml"
chart_template="$template_root/xds-cluster/templates/raycluster-cluster.yaml"

python3 - "$values_template" "$chart_template" <<'PY'
import sys
from pathlib import Path

values_path, chart_path = map(Path, sys.argv[1:])
assert values_path.is_file(), values_path
assert chart_path.is_file(), chart_path
values_text = values_path.read_text(encoding="utf-8")
for fragment in (
    "lmcacheSidecar:",
    "enabled: {LMCACHE_SIDECAR_ENABLED}",
    "mpPortBase: {LMCACHE_MP_PORT_BASE}",
    "httpPortBase: {LMCACHE_HTTP_PORT_BASE}",
    "l1InitSizeGb: {LMCACHE_L1_INIT_SIZE_GB}",
    "l1SizeGb: {LMCACHE_L1_SIZE_GB}",
):
    assert fragment in values_text, fragment
text = chart_path.read_text(encoding="utf-8")
# Sidecar is a Chart concern: it is enabled only for names containing prefill,
# and derives a unique local port from the rendered Prefill group ordinal.
for fragment in (
    'contains "prefill" (lower $teGroupValues.name)',
    'regexFind "[0-9]+$" $teGroupValues.name',
    'name: lmcache-sidecar',
    'name: LMCACHE_MP_PORT',
    'name: LMCACHE_HTTP_PORT',
    'name: lmcache-host-shm',
):
    assert fragment in text, fragment
assert 'contains "decode" (lower $teGroupValues.name)' in text
PY

echo "lmcache static sidecar template tests passed"
