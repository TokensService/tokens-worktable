#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"

mkdir -p "$work_dir/chart" "$work_dir/bin" "$work_dir/run/rendered"
printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$work_dir/chart/Chart.yaml"
printf '{}\n' >"$work_dir/values.yaml"
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
  *'get pods -l ray.io/cluster=xds-test-arch-local-kuberay -o name')
    if [[ ! -e "$PODS_DELETED" ]]; then
      printf 'pod/stale-task-executor\n'
    fi
    ;;
  *'get pods -l app=frontend-executor,xds-component=frontend -o name')
    if [[ ! -e "$FRONTEND_PODS_DELETED" ]]; then
      printf 'pod/stale-frontend\n'
    fi
    ;;
  *'get pods -l ray.io/cluster=xds-test-arch-local-kuberay -o json')
    printf '{"items":[{"metadata":{"name":"taskExecutorGroup4prefill1","labels":{"ray.io/group":"taskExecutorGroup4prefill1"}}}]}'
    ;;
  *'delete pod/stale-task-executor'*)
    : >"$PODS_DELETED"
    ;;
  *'delete pod/stale-frontend'*)
    : >"$FRONTEND_PODS_DELETED"
    ;;
esac
EOF
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
PODS_DELETED="$work_dir/pods-deleted" \
FRONTEND_PODS_DELETED="$work_dir/frontend-pods-deleted" \
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

delete_line="$(grep -nF 'kubectl -n xds-test-arch-local delete pod/stale-task-executor --grace-period=0 --force --wait=false' "$work_dir/events.log" | cut -d: -f1 || true)"
frontend_delete_line="$(grep -nF 'kubectl -n xds-test-arch-local delete pod/stale-frontend --grace-period=0 --force --wait=false' "$work_dir/events.log" | cut -d: -f1 || true)"
install_line="$(grep -nF 'helm install xds-test-arch-local' "$work_dir/events.log" | cut -d: -f1 || true)"
if [[ -z "$delete_line" ]]; then
  echo "expected deploy-model.sh to delete stale Ray worker pods after uninstall" >&2
  exit 1
fi
if [[ -z "$install_line" || "$delete_line" -ge "$install_line" ]]; then
  echo "stale Ray worker pods must be deleted before helm install" >&2
  exit 1
fi
if [[ -z "$frontend_delete_line" || "$frontend_delete_line" -ge "$install_line" ]]; then
  echo "stale frontend executor pods must be deleted before helm install" >&2
  exit 1
fi

echo "deploy stale-pod cleanup test passed"
