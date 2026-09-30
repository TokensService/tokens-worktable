#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/check-env.sh"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin"

cat >"$work_dir/bin/sshpass" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == -e ]]; shift
exec "$@"
SH
cat >"$work_dir/bin/scp" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$work_dir/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$TEST_SSH_LOG"
command="${*: -1}"
if [[ "$command" == *'command -v rping'* ]]; then exit 0; fi
if [[ "$command" == *'ip -br addr show'* ]]; then
  if [[ "$*" == *'root@192.0.2.10'* ]]; then
    printf 'roce_bond0 10.10.0.10\n'
  else
    printf 'roce_bond0 10.10.0.20\n'
  fi
  exit 0
fi
if [[ "$command" == *'rping -s'* ]]; then printf '7654\n'; exit 0; fi
if [[ "$command" == *'kill -0 7654'* ]]; then exit 0; fi
if [[ "$command" == *'rping -c'* ]]; then exit 0; fi
if [[ "$command" == *'kill -TERM 7654'* ]]; then exit 0; fi
# Remote single-node health checks are outside this unit test.
exit 0
SH
chmod +x "$work_dir/bin"/*

PATH="$work_dir/bin:$PATH" \
TEST_SSH_LOG="$work_dir/ssh.log" \
LOG_FILE="$work_dir/check.log" \
RDMA_RPING_ENABLED=true \
TARGET_HOSTS='[{"ip":"192.0.2.10","user":"root","pass":"one"},{"ip":"192.0.2.20","user":"root","pass":"two"}]' \
bash "$script" >"$work_dir/output"

grep -Fq 'RDMA rping: total=2 ok=2 fail=0' "$work_dir/output"
grep -Fq 'rping -c -I 10.10.0.10 -a 10.10.0.20 -C 1 -v' "$work_dir/ssh.log"
grep -Fq 'rping -c -I 10.10.0.20 -a 10.10.0.10 -C 1 -v' "$work_dir/ssh.log"
grep -Fq 'kill -TERM 7654' "$work_dir/ssh.log"
if grep -Fq 'pkill -f' "$work_dir/ssh.log"; then
  echo 'RDMA check must clean up only its recorded server PID' >&2
  exit 1
fi

echo 'RDMA rping environment-check test passed'
