#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/deploy-model.sh"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/bin" "$work_dir/rendered/xds-cluster"
touch "$work_dir/rendered/xds-cluster/Chart.yaml"
touch "$work_dir/rendered/values.rendered.yaml"
printf '{}' >"$work_dir/rendered/architecture.request.json"
printf '{"resources":[{"task_executor_group":"taskexecutor"}]}' >"$work_dir/rendered/resources.rendered.json"
printf '{"key":"xds.optest","value":"test","hosts":[]}' >"$work_dir/rendered/node-labels.json"

cat >"$work_dir/bin/sshpass" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-e" ]]
shift
exec "$@"
SH

cat >"$work_dir/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$TEST_SSH_LOG"
if [[ "$*" == *"cat "*"pipeline.env"* && "$*" != *"cat >"* ]]; then
  printf 'export XDS_URL=%q\n' 'http://192.168.31.113:31002/xds/v1/chat/completions'
  printf 'export XDS_API_HOST=%q\n' '192.168.31.113'
  printf 'export SERVICE_API=%q\n' 'http://192.168.31.113:31002/xds/v1'
  printf 'export MODEL_API=%q\n' 'http://192.168.31.113:31002/xds/v1/models/glm-5.3-nvfp4'
  exit 0
fi
if [[ "$*" == *"DEPLOY_ON_TARGET_HOST=1"* ]]; then
  printf '%s\n' \
    'XDS_URL=http://192.168.31.113:31002/xds/v1/chat/completions' \
    'XDS_API_HOST=192.168.31.113' \
    'SERVICE_API=http://192.168.31.113:31002/xds/v1' \
    'MODEL_API=http://192.168.31.113:31002/xds/v1/models/glm-5.3-nvfp4'
  exit 0
fi
cat >>"$TEST_SSH_STDIN"
SH
chmod +x "$work_dir/bin/sshpass" "$work_dir/bin/ssh"

# Pipeline stages are separately invoked.  The deploy stage must recover the
# target-node mapping persisted by rendering when the orchestrator does not
# inject TARGET_NODE_IP_MAP again.
printf 'export TARGET_NODE_IP_MAP=%q\n' '{"115.33.98.101:2226":"192.168.31.113"}' >"$work_dir/local.pipeline.env"

PATH="$work_dir/bin:$PATH" \
TEST_SSH_LOG="$work_dir/ssh.log" \
TEST_SSH_STDIN="$work_dir/ssh.stdin" \
RUN_DIR="$work_dir" \
RENDER_DIR="$work_dir/rendered" \
ARCH_NAME=test-arch \
PIPELINE_NAME=test-pipeline \
TARGET_RUN_DIR="$work_dir/remote-run" \
TARGET_RENDER_DIR="$work_dir/remote-render" \
TARGET_PIPELINE_ENV_FILE="$work_dir/remote-run/pipeline.env" \
PIPELINE_ENV_FILE="$work_dir/local.pipeline.env" \
TARGET_HOSTS='[{"ip":"115.33.98.101:2226","user":"root","pass":"test-password"}]' \
bash "$script" >"$work_dir/output"

grep -Fq 'root@115.33.98.101' "$work_dir/ssh.log"
grep -Fq -- '-p 2226' "$work_dir/ssh.log"
grep -Fq 'DEPLOY_ON_TARGET_HOST=1' "$work_dir/ssh.log"
grep -Fq "$work_dir/remote-render" "$work_dir/ssh.log"
grep -Fq "$work_dir/remote-run/scripts/register-model.sh" "$work_dir/ssh.log"
if grep -Fq "$work_dir/remote-run/scripts/cleanup-env.sh" "$work_dir/ssh.log"; then
  echo 'deploy stage must not run standardization cleanup' >&2
  exit 1
fi
grep -Fq 'Deploy the rendered chart' "$work_dir/ssh.stdin"
grep -Fq 'test-password' "$work_dir/ssh.stdin"
grep -Fq 'TARGET_NODE_IP_MAP' "$work_dir/ssh.stdin"
grep -Fq 'DEPLOY_EXECUTION_HOST=115.33.98.101' "$work_dir/output"
grep -Fxq 'XDS_URL=http://115.33.98.101:31002/xds/v1/chat/completions' "$work_dir/output"
grep -Fxq 'XDS_API_HOST=115.33.98.101' "$work_dir/output"
grep -Fxq 'SERVICE_API=http://115.33.98.101:31002/xds/v1' "$work_dir/output"
grep -Fxq 'MODEL_API=http://115.33.98.101:31002/xds/v1/models/glm-5.3-nvfp4' "$work_dir/output"
if grep -Fq '192.168.31.113:31002/xds/v1' "$work_dir/output"; then
  echo 'mapped deployment must not return the Kubernetes InternalIP URLs' >&2
  exit 1
fi
grep -Fxq 'export XDS_URL=http://115.33.98.101:31002/xds/v1/chat/completions' "$work_dir/local.pipeline.env"
grep -Fxq 'export XDS_API_HOST=115.33.98.101' "$work_dir/local.pipeline.env"
grep -Fxq 'export SERVICE_API=http://115.33.98.101:31002/xds/v1' "$work_dir/local.pipeline.env"
grep -Fxq 'export MODEL_API=http://115.33.98.101:31002/xds/v1/models/glm-5.3-nvfp4' "$work_dir/local.pipeline.env"

echo "deploy remote-execution tests passed"
