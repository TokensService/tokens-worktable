#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/chart"
printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$work_dir/chart/Chart.yaml"
cat >"$work_dir/values.yaml" <<'EOF'
common:
  containerEnv:
    - name: XDS_TE_POD_LABEL_KEY
      value: kubernetes.io/hostname
    - name: XDS_TE_POD_LABEL_VAL
      value: 192.168.0.243
nodeSelector:
  kubernetes.io/hostname: 192.168.0.243
# disabled infrastructure setting: {ELB_ID}
EOF
cat >"$work_dir/architectures.json" <<'EOF'
[
  {
    "arch_name": "test-arch",
    "deploy_spec_packages": [
      {
        "deploy_specs": [
          {
            "role": "prefill",
            "resources": [{"cpu": 1, "gpu": 4, "memory": "1G"}]
          },
          {
            "role": "decode",
            "resources": [{"cpu": 1, "gpu": 4, "memory": "1G"}]
          }
        ]
      }
    ]
  }
]
EOF

ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
TARGET_HOSTS='[{"ip":"192.168.0.243"},{"ip":"192.168.0.78"}]' \
YAML_REPLACE_JSON='{"nodeSelector":{"user":"override"}}' \
bash "$script_dir/render-config.sh" >/dev/null

python3 - "$work_dir/run/rendered/values.rendered.yaml" <<'PY'
import sys
import yaml

with open(sys.argv[1], encoding="utf-8") as source:
    values = yaml.safe_load(source)

expected = {"xds.optest": "node-243-78"}
assert values["nodeSelector"] == expected, values["nodeSelector"]
env = {entry["name"]: entry.get("value") for entry in values["common"]["containerEnv"]}
assert env["XDS_TE_POD_LABEL_KEY"] == "xds.optest", env
assert env["XDS_TE_POD_LABEL_VAL"] == "node-243-78", env
assert all(group["nodeSelector"] == expected for group in values["taskExecutorGroups"])
PY

echo "render target-label tests passed"
