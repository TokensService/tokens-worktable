#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin"

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
command="${*: -1}"
if [[ "$command" == *'get namespace test-ns'* ]]; then
  count=0
  [[ ! -f "$TEST_NAMESPACE_COUNT" ]] || count="$(cat "$TEST_NAMESPACE_COUNT")"
  count=$((count + 1))
  printf '%s' "$count" >"$TEST_NAMESPACE_COUNT"
  (( count == 1 ))
  exit
fi
if [[ "$command" == *'get pods -o json'* ]]; then
  printf '{"items":[]}'
  exit
fi
if [[ "$command" == *'get pod -l ray.io/node-type=head'* ]]; then
  printf 'head-pod'
  exit
fi
if [[ "$command" == *'logs -f head-pod -c ray-head --timestamps'* ]]; then
  printf 'remote head log\n'
  exit
fi
printf 'unexpected remote command: %s\n' "$command" >&2
exit 2
SH

cat >"$work_dir/bin/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$work_dir/bin/sshpass" "$work_dir/bin/ssh" "$work_dir/bin/sleep"

PATH="$work_dir/bin:$PATH" \
TEST_SSH_LOG="$work_dir/ssh.log" \
TEST_NAMESPACE_COUNT="$work_dir/namespace-count" \
REMOTE_KUBECTL_TARGET=root@192.0.2.10 \
REMOTE_KUBECTL_PORT=2222 \
REMOTE_KUBECTL_PASSWORD=test-password \
POLL_INTERVAL_SECONDS=1 \
EMS_LOG_SYNC_INTERVAL_SECONDS=60 \
bash "$script_dir/follow-xds-head-logs.sh" test-ns "$work_dir/logs"

grep -Fxq 'remote head log' "$work_dir/logs/head-pod.follow.log"
grep -Fq 'remote_kubectl_target=root@192.0.2.10' "$work_dir/logs/metadata"
grep -Fq -- '-p 2222' "$work_dir/ssh.log"
grep -Fq 'kubectl -n test-ns logs -f head-pod -c ray-head --timestamps' "$work_dir/ssh.log"
echo 'follow remote head logs test passed'
