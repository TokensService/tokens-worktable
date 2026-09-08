#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/chart" "$work_dir/bin" "$work_dir/run/rendered"
printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$work_dir/chart/Chart.yaml"
cat >"$work_dir/values.yaml" <<'YAML'
rayService:
  service:
    ports:
      - name: http
        nodePort: 31365
YAML
printf '{"arch_name":"test-arch","deploy_spec_packages":[{"spec_package_name":"test-package","deploy_specs":[]}]}' >"$work_dir/architecture.request.json"
printf '{"resources":[{"resource_id":"prefill-1","resource_type":"prefill","resource_status":"IDLE","resource_bundles":["127.0.0.1"],"task_executor_group":"taskexecutor"}]}' >"$work_dir/run/rendered/resources.rendered.json"
printf '{"key":"xds.optest","value":"node-78","hosts":[{"ip":"192.168.0.78"}]}' >"$work_dir/node-labels.json"

cat >"$work_dir/bin/helm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == install ]]; then
  for ((index = 1; index <= $#; index++)); do
    if [[ "${!index}" == --values ]]; then
      next=$((index + 1))
      cp "${!next}" "$INSTALLED_VALUES"
      break
    fi
  done
fi
SH

cat >"$work_dir/bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'get nodes -o json')
    printf '{"items":[{"metadata":{"name":"node-78"},"status":{"addresses":[{"type":"InternalIP","address":"192.168.0.78"}]}}]}'
    ;;
  'get svc -A -o json')
    printf '{"items":[{"spec":{"ports":[{"nodePort":31365}]}}]}'
    ;;
  *'get svc ray-svc -o json')
    printf '{"spec":{"ports":[{"name":"frontend-port","nodePort":31375}]}}'
    ;;
  *'get pods -l ray.io/cluster=xds-test-arch-local-kuberay -o json')
    printf '{"items":[{"metadata":{"name":"taskexecutor","labels":{"ray.io/group":"taskexecutor"}}}]}'
    ;;
esac
SH

cat >"$work_dir/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$API_REQUEST_LOG"
if [[ "$*" == *'/models/test-arch'* ]]; then
  printf '{"status":"ACTIVE"}\n'
else
  printf '[]\n'
fi
SH
chmod +x "$work_dir/bin/helm" "$work_dir/bin/kubectl" "$work_dir/bin/curl"

INSTALLED_VALUES="$work_dir/installed-values.yaml" \
API_REQUEST_LOG="$work_dir/api-requests.log" \
DEPLOY_ON_TARGET_HOST=1 \
RUN_DIR="$work_dir/run" \
CHART_DIR="$work_dir/chart" \
VALUES_FILE="$work_dir/values.yaml" \
ARCH_REQUEST_FILE="$work_dir/architecture.request.json" \
RESOURCE_MANIFEST="$work_dir/run/rendered/resources.rendered.json" \
NODE_LABELS_FILE="$work_dir/node-labels.json" \
ARCH_NAME=test-arch \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
HELM_BIN="$work_dir/bin/helm" \
KUBECTL_BIN="$work_dir/bin/kubectl" \
PATH="$work_dir/bin:$PATH" \
HEAD_LOG_ROOT="$work_dir/logs" \
XDS_READY_TIMEOUT_SECONDS=5 \
bash "$script_dir/deploy-model.sh" >"$work_dir/output"

node_port="$(python3 - "$work_dir/installed-values.yaml" <<'PY'
import sys
import yaml

values = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
print(values["rayService"]["service"]["ports"][0]["nodePort"])
PY
)"
[[ "$node_port" == 31375 ]] || {
  echo "expected occupied nodePort 31365 to back off to 31375, got $node_port" >&2
  exit 1
}

grep -Fq 'http://192.168.0.78:31375/xds/v1/models/' "$work_dir/api-requests.log" || {
  echo "expected XDS readiness probe to use the resolved ray-svc NodePort" >&2
  cat "$work_dir/api-requests.log" >&2
  exit 1
}

grep -Fxq 'SERVICE_NAME=ray-svc' "$work_dir/output"
grep -Fxq 'SERVICE_API=http://192.168.0.78:31375/xds/v1' "$work_dir/output"
grep -Fxq 'MODEL=test-arch' "$work_dir/output"
grep -Fxq 'MODEL_ENDPOINT=test-arch' "$work_dir/output"
grep -Fxq 'MODEL_VERSION=v1' "$work_dir/output"
grep -Fxq 'MODEL_API=http://192.168.0.78:31375/xds/v1/models/test-arch' "$work_dir/output"

echo "deploy node-port backoff test passed"
