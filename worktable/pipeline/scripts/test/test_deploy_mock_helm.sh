#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/bin" "$work_dir/rendered/xds-cluster"
printf '{"hosts":[{"ip":"192.168.31.7"}]}' >"$work_dir/rendered/node-labels.json"
printf '{}' >"$work_dir/rendered/resources.rendered.json"
printf '{}' >"$work_dir/rendered/architecture.request.json"
: >"$work_dir/rendered/values.rendered.yaml"
: >"$work_dir/rendered/xds-cluster/Chart.yaml"

for command in helm kubectl curl ssh sshpass; do
  cat >"$work_dir/bin/$command" <<'EOF'
#!/usr/bin/env bash
echo "unexpected external command: $0 $*" >&2
exit 99
EOF
  chmod +x "$work_dir/bin/$command"
done

PATH="$work_dir/bin:$PATH" \
DEPLOY_ON_TARGET_HOST=0 \
TARGET_HOSTS='[{"ip":"115.33.98.101:2224"}]' \
TARGET_NODE_IP_MAP='{"115.33.98.101:2224":"192.168.31.7"}' \
MOCK_HELM_DEPLOY=true \
RUN_DIR="$work_dir" \
RENDER_DIR="$work_dir/rendered" \
PIPELINE_ENV_FILE="$work_dir/pipeline.env" \
CHART_DIR="$work_dir/rendered/xds-cluster" \
VALUES_FILE="$work_dir/rendered/values.rendered.yaml" \
ARCH_REQUEST_FILE="$work_dir/rendered/architecture.request.json" \
RESOURCE_MANIFEST="$work_dir/rendered/resources.rendered.json" \
NODE_LABELS_FILE="$work_dir/rendered/node-labels.json" \
ARCH_NAME='mock-arch' \
MODEL_NAME='mock-model' \
MODEL_ENDPOINT='mock-model' \
MODEL_PATH='/mnt/paas/mock-weight/v1' \
bash "$script_dir/deploy-model.sh" >"$work_dir/output"

grep -Fxq '[mock] Helm deployment, readiness checks, log collection, and model registration skipped' "$work_dir/output"
grep -Fxq 'XDS_URL=http://115.33.98.101:31004/xds/v1/chat/completions' "$work_dir/output"
grep -Fxq 'SERVICE_API=http://115.33.98.101:31004/xds/v1' "$work_dir/output"
grep -Fxq 'MODEL_API=http://115.33.98.101:31004/xds/v1/models/mock-model' "$work_dir/output"
grep -Fxq 'export XDS_URL=http://115.33.98.101:31004/xds/v1/chat/completions' "$work_dir/pipeline.env"

echo 'deploy mock-helm tests passed'
