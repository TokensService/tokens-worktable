#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/chart" "$work_dir/bin" "$work_dir/run/rendered"
printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$work_dir/chart/Chart.yaml"
cat >"$work_dir/values.yaml" <<'YAML'
workerGroups:
  ctrlGroup:
    annotations:
      max_count_on_node: '3'
    minReplicas: 2
YAML
cat >"$work_dir/architecture.request.json" <<'JSON'
{"arch_name":"test-arch","deploy_spec_packages":[{"spec_package_name":"test-package","deploy_specs":[]}]}
JSON
cat >"$work_dir/run/rendered/resources.rendered.json" <<'JSON'
{"resources":[{"resource_id":"prefill-1","resource_type":"prefill","resource_status":"IDLE","resource_bundles":["127.0.0.1"],"task_executor_group":"taskExecutorGroup4prefill1"}]}
JSON
cat >"$work_dir/node-labels.json" <<'JSON'
{"key":"xds.optest","value":"node-78","hosts":[{"ip":"192.168.0.78"}]}
JSON

cat >"$work_dir/bin/helm" <<'EOF'
#!/usr/bin/env bash
printf 'helm %s\n' "$*" >>"$EVENT_LOG"
if [[ "$1" == install ]]; then
  values=''
  for ((index = 1; index <= $#; index++)); do
    if [[ "${!index}" == --values ]]; then
      next=$((index + 1))
      values="${!next}"
      break
    fi
  done
  cp "$values" "$INSTALLED_VALUES"
fi
EOF
cat >"$work_dir/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  'get nodes -o json')
    printf '{"items":[{"metadata":{"name":"node-78"},"status":{"addresses":[{"type":"InternalIP","address":"192.168.0.78"}]}}]}'
    ;;
  'get svc -A -o json')
    printf '{"items":[]}'
    ;;
  *'get configmap ctrlgroup-192-168-0-78-slot-cm -o json')
    printf '{"data":{"holders":"[\\"pipeline-op/ctrl-a\\", \\"pipeline-op/ctrl-b\\", \\"old-release/ctrl-stale\\"]"}}'
    ;;
  *'-n pipeline-op get pod ctrl-a -o name')
    printf 'pod/ctrl-a\n'
    ;;
  *'-n pipeline-op get pod ctrl-b -o name')
    printf 'pod/ctrl-b\n'
    ;;
  *'-n old-release get pod ctrl-stale -o name')
    exit 1
    ;;
  *'get pods -l ray.io/cluster=xds-test-arch-local-kuberay -o json')
    printf '{"items":[{"metadata":{"name":"taskExecutorGroup4prefill1","labels":{"ray.io/group":"taskExecutorGroup4prefill1"}}}]}'
    ;;
esac
EOF
cat >"$work_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *'/models/test-arch'* ]]; then
  printf '{"status":"ACTIVE"}\n'
else
  printf '[]\n'
fi
EOF
chmod +x "$work_dir/bin/helm" "$work_dir/bin/kubectl" "$work_dir/bin/curl"

EVENT_LOG="$work_dir/events.log" \
INSTALLED_VALUES="$work_dir/installed-values.yaml" \
DEPLOY_ON_TARGET_HOST=1 \
RUN_DIR="$work_dir/run" \
CHART_DIR="$work_dir/chart" \
VALUES_FILE="$work_dir/values.yaml" \
ARCH_REQUEST_FILE="$work_dir/architecture.request.json" \
RESOURCE_MANIFEST="$work_dir/run/rendered/resources.rendered.json" \
NODE_LABELS_FILE="$work_dir/node-labels.json" \
ARCH_NAME='test-arch' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
XDS_URL='http://192.168.0.78:30079/xds/v1' \
HELM_BIN="$work_dir/bin/helm" \
KUBECTL_BIN="$work_dir/bin/kubectl" \
PATH="$work_dir/bin:$PATH" \
HEAD_LOG_ROOT="$work_dir/logs" \
XDS_READY_TIMEOUT_SECONDS=5 \
bash "$script_dir/deploy-model.sh" >/dev/null

actual="$(python3 - "$work_dir/installed-values.yaml" <<'PY'
import sys
import yaml

values = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
print(values["workerGroups"]["ctrlGroup"]["annotations"]["max_count_on_node"])
PY
)"
if [[ "$actual" != 4 ]]; then
  echo "expected ctrlGroup max_count_on_node=4, got $actual" >&2
  exit 1
fi

source_value="$(python3 - "$work_dir/values.yaml" <<'PY'
import sys
import yaml

values = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
print(values["workerGroups"]["ctrlGroup"]["annotations"]["max_count_on_node"])
PY
)"
if [[ "$source_value" != 3 ]]; then
  echo "expected source values file to remain unchanged, got $source_value" >&2
  exit 1
fi

echo "deploy ctrl slot-capacity test passed"
