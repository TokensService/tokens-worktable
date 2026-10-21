#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

expected_target_map='{
  "115.33.98.101:2224": "192.168.31.140",
  "115.33.98.101:2225": "192.168.31.120",
  "115.33.98.101:2226": "192.168.31.113",
  "115.33.98.101:2227": "192.168.31.164",
  "115.33.98.101:2228": "192.168.31.7",
  "115.33.98.101:2229": "192.168.31.181"
}'
expected_node_ports='{
  "192.168.31.140": 31000,
  "192.168.31.120": 31001,
  "192.168.31.113": 31002,
  "192.168.31.164": 31003,
  "192.168.31.7": 31004,
  "192.168.31.181": 31006,
  "192.168.47.115": 31040,
  "192.168.47.3": 31041,
  "192.168.47.71": 31042,
  "192.168.47.44": 31043,
  "192.168.47.214": 31044,
  "192.168.47.92": 31035,
  "192.168.47.148": 31036,
  "192.168.47.4": 32004,
  "192.168.47.109": 32109,
  "192.168.47.112": 32112,
  "192.168.47.201": 32201,
  "192.168.47.85": 32085,
  "192.168.47.141": 32141,
  "192.168.47.90": 32090,
  "192.168.47.15": 32015,
  "192.168.47.32": 32032,
  "192.168.47.246": 32246
}'

pull_prefix="$(sed -n '1,/^TARGET_USER=/p' "$script_dir/pull_render_config.sh" | sed '/^SCRIPT_DIR=/d')"
actual_target_map="$(env -u TARGET_NODE_IP_MAP bash -c "$pull_prefix
printf '%s' \"\$TARGET_NODE_IP_MAP\"")"

python3 - "$actual_target_map" "$expected_target_map" <<'PY'
import json
import sys

actual, expected = map(json.loads, sys.argv[1:])
for endpoint, node_ip in expected.items():
    assert actual.get(endpoint) == node_ip, (endpoint, actual.get(endpoint), node_ip)
PY

override_target_map="$(TARGET_NODE_IP_MAP='{"115.33.98.101:2224":"203.0.113.140"}' bash -c "$pull_prefix
printf '%s' \"\$TARGET_NODE_IP_MAP\"")"
python3 - "$override_target_map" <<'PY'
import json
import sys

actual = json.loads(sys.argv[1])
assert actual["115.33.98.101:2224"] == "203.0.113.140", actual
assert actual["115.33.98.101:2225"] == "192.168.31.120", actual
PY

for script in pull_render_config.sh render-config.sh deploy-model.sh; do
  assignment="$(grep -m1 'NODE_PORT_MAP=' "$script_dir/$script")"
  actual_node_ports="$(env -u NODE_PORT_MAP bash -c "$assignment
printf '%s' \"\$NODE_PORT_MAP\"")"
  python3 - "$script" "$actual_node_ports" "$expected_node_ports" <<'PY'
import json
import sys

script, actual_text, expected_text = sys.argv[1:]
actual, expected = json.loads(actual_text), json.loads(expected_text)
for node_ip, port in expected.items():
    assert actual.get(node_ip) == port, (script, node_ip, actual.get(node_ip), port)
PY
done

source <(sed '/^main "\$@"$/d' "$script_dir/cleanup-env.sh")
while read -r node_ip node_port; do
  [[ "$(node_port_for_ip "$node_ip")" == "$node_port" ]]
done <<'EOF'
192.168.31.140 31000
192.168.31.120 31001
192.168.31.113 31002
192.168.31.164 31003
192.168.31.7 31004
192.168.31.181 31006
192.168.47.115 31040
192.168.47.3 31041
192.168.47.71 31042
192.168.47.44 31043
192.168.47.214 31044
192.168.47.92 31035
192.168.47.148 31036
192.168.47.4 32004
192.168.47.109 32109
192.168.47.112 32112
192.168.47.201 32201
192.168.47.85 32085
192.168.47.141 32141
192.168.47.90 32090
192.168.47.15 32015
192.168.47.32 32032
192.168.47.246 32246
EOF

echo 'mapped environment default tests passed'
