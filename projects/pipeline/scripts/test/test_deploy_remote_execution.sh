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
cat >>"$TEST_SSH_STDIN"
SH
chmod +x "$work_dir/bin/sshpass" "$work_dir/bin/ssh"

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
TARGET_HOSTS='[{"ip":"192.0.2.10:2222","user":"root","pass":"test-password"}]' \
bash "$script" >"$work_dir/output"

grep -Fq 'root@192.0.2.10' "$work_dir/ssh.log"
grep -Fq -- '-p 2222' "$work_dir/ssh.log"
grep -Fq 'DEPLOY_ON_TARGET_HOST=1' "$work_dir/ssh.log"
grep -Fq "$work_dir/remote-render" "$work_dir/ssh.log"
grep -Fq "$work_dir/remote-run/scripts/register-model.sh" "$work_dir/ssh.log"
grep -Fq "$work_dir/remote-run/scripts/cleanup-env.sh" "$work_dir/ssh.log"
grep -Fq 'Deploy the rendered chart' "$work_dir/ssh.stdin"
grep -Fq 'DEPLOY_EXECUTION_HOST=192.0.2.10' "$work_dir/output"

echo "deploy remote-execution tests passed"
