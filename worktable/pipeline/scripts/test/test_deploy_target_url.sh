#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/chart" "$work_dir/bin" "$work_dir/run/rendered"
printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$work_dir/chart/Chart.yaml"
printf '{}\n' >"$work_dir/values.yaml"
cat >"$work_dir/architecture.request.json" <<'JSON'
{"arch_name":"test-arch","deploy_spec_packages":[{"spec_package_name":"test-package","deploy_specs":[]}]}
JSON
mkdir -p "$work_dir/rendered"
cat >"$work_dir/rendered/resources.rendered.json" <<'JSON'
{"resources":[{"resource_id":"prefill-1","resource_type":"prefill","resource_status":"IDLE","resource_bundles":["127.0.0.1"],"task_executor_group":"taskExecutorGroup4prefill1"}]}
JSON
cat >"$work_dir/node-labels.json" <<'EOF'
{"key":"xds.optest","value":"node-175","hosts":[{"ip":"192.168.31.175"}]}
EOF

cat >"$work_dir/bin/helm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$work_dir/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "get" && "$2" == "nodes" ]]; then
  printf '{"items":[{"metadata":{"name":"node-175"},"status":{"addresses":[{"type":"InternalIP","address":"192.168.31.175"}]}}]}'
elif [[ "$*" == 'get svc -A -o json' ]]; then
  printf '{"items":[]}'
elif [[ "$1" == "-n" && "$3" == "get" && "$4" == "svc" && "$5" == "ray-svc" && "$*" == *"-o json"* ]]; then
  printf '{"spec":{"ports":[{"nodePort":31465}]}}'
elif [[ "$1" == "-n" && "$3" == "get" && "$4" == "pods" && "$*" == *"-o json"* ]]; then
  printf '{"items":[{"metadata":{"name":"taskExecutorGroup4prefill1","labels":{"ray.io/group":"taskExecutorGroup4prefill1"}}}]}'
fi
exit 0
EOF
cat >"$work_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CURL_LOG"
for arg in "$@"; do
  case "$arg" in
    @*) cp "${arg#@}" "$CURL_PAYLOAD_FILE" ;;
  esac
done
if [[ "$*" == *"/models/test-arch"* ]]; then
  printf '{"status":"ACTIVE"}\n'
else
  printf '[]\n'
fi
EOF
chmod +x "$work_dir/bin/helm" "$work_dir/bin/kubectl" "$work_dir/bin/curl"

CURL_LOG="$work_dir/curl.log" \
CURL_PAYLOAD_FILE="$work_dir/model.payload.json" \
DEPLOY_ON_TARGET_HOST=1 \
RUN_DIR="$work_dir/run" \
CHART_DIR="$work_dir/chart" \
VALUES_FILE="$work_dir/values.yaml" \
ARCH_REQUEST_FILE="$work_dir/architecture.request.json" \
RESOURCE_MANIFEST="$work_dir/rendered/resources.rendered.json" \
NODE_LABELS_FILE="$work_dir/node-labels.json" \
ARCH_NAME='test-arch' \
MODEL_PATH='/mnt/paas/GLM-5.2-NVFP4-W4A4-MG39-BNT3/v1' \
TARGET_HOSTS='[{"ip":"192.168.0.78:2222"}]' \
XDS_URL='' \
HELM_BIN="$work_dir/bin/helm" \
KUBECTL_BIN="$work_dir/bin/kubectl" \
PATH="$work_dir/bin:$PATH" \
HEAD_LOG_ROOT="$work_dir/logs" \
XDS_READY_TIMEOUT_SECONDS=5 \
bash "$script_dir/deploy-model.sh" >/dev/null

grep -Fq 'http://192.168.31.175:31465/xds/v1/models/' "$work_dir/curl.log"
grep -Fq 'http://192.168.31.175:31465/xds/v1/models/architectures' "$work_dir/curl.log"
grep -Fq 'http://192.168.31.175:31465/xds/v1/models/test-arch' "$work_dir/curl.log"
python3 - "$work_dir/model.payload.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    payload = json.load(source)
assert payload["model"] == "test-arch", payload
assert payload["arch_name"] == "test-arch", payload
assert payload["spec_package"] == "test-package", payload
assert payload["local_info"]["path"] == "/home/service/works/models_ssd/GLM-5.2-NVFP4-W4A4-MG39-BNT3/v1", payload
PY

echo "deploy target-url tests passed"
