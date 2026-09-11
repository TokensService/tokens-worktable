#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"

mkdir -p "$work_dir/chart" "$work_dir/bin" "$work_dir/run/rendered"
printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$work_dir/chart/Chart.yaml"
printf 'global:\n  network:\n    ports:\n      - nodePort: 31365\n' >"$work_dir/values.yaml"
cat >"$work_dir/architecture.request.json" <<'JSON'
{"arch_name":"test-arch","deploy_spec_packages":[{"spec_package_name":"test-package","deploy_specs":[]}]}
JSON
cat >"$work_dir/run/rendered/resources.rendered.json" <<'JSON'
{"resources":[{"resource_id":"prefill-1","resource_type":"prefill","resource_status":"IDLE","resource_bundles":["127.0.0.1"],"task_executor_group":"taskExecutorGroup4prefill1"},{"resource_id":"decode-1","resource_type":"decode","resource_status":"IDLE","resource_bundles":["127.0.0.2"],"task_executor_group":"taskExecutorGroup4decode1"}]}
JSON
cat >"$work_dir/node-labels.json" <<'JSON'
{"key":"xds.optest","value":"node-78","hosts":[{"ip":"192.168.0.78"}]}
JSON

cat >"$work_dir/bin/helm" <<'EOF'
#!/usr/bin/env bash
printf 'helm %s\n' "$*" >>"$EVENT_LOG"
EOF
cat >"$work_dir/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >>"$EVENT_LOG"
case "$*" in
  'get nodes -o json')
    printf '{"items":[{"metadata":{"name":"node-78"},"status":{"addresses":[{"type":"InternalIP","address":"192.168.0.78"}]}}]}'
    ;;
  'get svc -A -o json')
    printf '{"items":[]}'
    ;;
  *'get pods -l ray.io/cluster=xds-test-arch-local-kuberay -o json')
    printf '{"items":[{"metadata":{"name":"taskExecutorGroup4prefill1","labels":{"ray.io/group":"taskExecutorGroup4prefill1"}}},{"metadata":{"name":"taskExecutorGroup4decode1","labels":{"ray.io/group":"taskExecutorGroup4decode1"}}}],"padding":"'
    head -c 3000000 /dev/zero | tr '\0' x
    printf '"}'
    ;;
esac
EOF
cat >"$work_dir/bin/ss" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$work_dir/bin/ss"

cat >"$work_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$EVENT_LOG"
for arg in "$@"; do
  case "$arg" in
    @*) cp "${arg#@}" "$CURL_PAYLOAD_FILE" ;;
  esac
done
if [[ "$*" == *'/models/test-arch'* ]]; then
  printf '{"status":"ACTIVE"}\n'
else
  printf '[]\n'
fi
EOF
chmod +x "$work_dir/bin/helm" "$work_dir/bin/kubectl" "$work_dir/bin/curl"

EVENT_LOG="$work_dir/events.log" \
CURL_PAYLOAD_FILE="$work_dir/model.payload.json" \
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

wait_line="$(grep -nF 'kubectl -n xds-test-arch-local wait --for=condition=Ready pod/taskExecutorGroup4prefill1 --timeout=5s' "$work_dir/events.log" | cut -d: -f1 || true)"
register_line="$(grep -nF '/models/architectures' "$work_dir/events.log" | head -1 | cut -d: -f1 || true)"
if [[ -z "$wait_line" ]]; then
  echo "expected deploy-model.sh to wait for task executor readiness before registration" >&2
  exit 1
fi
if [[ -z "$register_line" || "$wait_line" -ge "$register_line" ]]; then
  echo "task executor readiness wait must precede architecture registration" >&2
  exit 1
fi

echo "deploy task-executor readiness test passed"
