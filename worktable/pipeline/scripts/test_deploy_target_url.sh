#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/chart" "$work_dir/bin"
printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$work_dir/chart/Chart.yaml"
printf '{}\n' >"$work_dir/values.yaml"
printf '{}\n' >"$work_dir/architecture.request.json"
cat >"$work_dir/node-labels.json" <<'EOF'
{"key":"xds.optest","value":"node-78","hosts":[{"ip":"192.168.0.78"}]}
EOF

cat >"$work_dir/bin/helm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$work_dir/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "get" && "$2" == "nodes" ]]; then
  printf '{"items":[{"metadata":{"name":"node-78"},"status":{"addresses":[{"type":"InternalIP","address":"192.168.0.78"}]}}]}'
fi
exit 0
EOF
cat >"$work_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CURL_LOG"
printf '[]\n'
EOF
chmod +x "$work_dir/bin/helm" "$work_dir/bin/kubectl" "$work_dir/bin/curl"

CURL_LOG="$work_dir/curl.log" \
RUN_DIR="$work_dir/run" \
CHART_DIR="$work_dir/chart" \
VALUES_FILE="$work_dir/values.yaml" \
ARCH_REQUEST_FILE="$work_dir/architecture.request.json" \
NODE_LABELS_FILE="$work_dir/node-labels.json" \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
XDS_URL='' \
HELM_BIN="$work_dir/bin/helm" \
KUBECTL_BIN="$work_dir/bin/kubectl" \
PATH="$work_dir/bin:$PATH" \
HEAD_LOG_ROOT="$work_dir/logs" \
XDS_READY_TIMEOUT_SECONDS=5 \
bash "$script_dir/deploy-model.sh" >/dev/null

grep -Fq 'http://192.168.0.78:30079/xds/v1/models/' "$work_dir/curl.log"
grep -Fq 'http://192.168.0.78:30079/xds/v1/models/architectures' "$work_dir/curl.log"

echo "deploy target-url tests passed"
