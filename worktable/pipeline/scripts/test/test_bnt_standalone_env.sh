#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/bnt-standalone.sh"
work_dir="$(mktemp -d)"
cleanup() {
  local status=$?
  rm -rf "$work_dir"
  exit "$status"
}
trap cleanup EXIT
mkdir -p "$work_dir/bin"

cat >"$work_dir/bin/service" <<'EOF'
#!/usr/bin/env bash
printf 'service %s\n' "$*" >>"$TEST_ACTION_LOG"
EOF

cat >"$work_dir/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

cat >"$work_dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

cat >"$work_dir/bin/ctr" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat >"$work_dir/bin/nvidia-smi" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

chmod +x "$work_dir/bin"/*

# ACTION/HUGEPAGE_PATH are the public environment contract.
hugepage_file="$work_dir/nr_hugepages"
printf '7\n' >"$hugepage_file"
PATH="$work_dir/bin:$PATH" \
  TEST_ACTION_LOG="$work_dir/actions.log" \
  LOG_FILE="$work_dir/hugepages.log" \
  ACTION=hugepages \
  HUGEPAGE_PATH="$hugepage_file" \
  bash "$script" >"$work_dir/hugepages-output" || {
    echo 'expected ACTION=hugepages to select the hugepages action' >&2
    exit 1
  }

[[ "$(cat "$hugepage_file")" == "0" ]]
grep -Fq '大页已清0' "$work_dir/hugepages-output"

if PATH="$work_dir/bin:$PATH" \
  TEST_ACTION_LOG="$work_dir/actions.log" \
  LOG_FILE="$work_dir/bnt.log" \
  DRY_RUN=0 \
  bash "$script" >"$work_dir/output"; then
  echo 'expected health check failure in isolated test environment' >&2
  exit 1
fi

grep -Fq 'BNT 标准化开始 steps=[crond containers gpu]' "$work_dir/output"
grep -Fq 'service crond stop' "$work_dir/actions.log"
grep -Fq '环境健康检查' "$work_dir/output"
grep -Fq '环境检查未通过' "$work_dir/output"

cat >"$work_dir/bin/scp" <<'EOF'
#!/usr/bin/env bash
printf 'scp %s\n' "$*" >>"$TEST_ACTION_LOG"
EOF

cat >"$work_dir/bin/ssh" <<'EOF'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >>"$TEST_ACTION_LOG"
EOF

chmod +x "$work_dir/bin/scp" "$work_dir/bin/ssh"
: >"$work_dir/actions.log"

PATH="$work_dir/bin:$PATH" \
TEST_ACTION_LOG="$work_dir/actions.log" \
LOG_FILE="$work_dir/bnt-remote.log" \
ACTION=check-health \
TARGET_HOSTS='[{"ip":"192.0.2.10"},{"ip":"192.0.2.11"}]' \
bash "$script" >"$work_dir/remote-output"

grep -Fq 'root@192.0.2.10' "$work_dir/actions.log"
grep -Fq 'root@192.0.2.11' "$work_dir/actions.log"
grep -Fq 'REMOTE_EXECUTION=1' "$work_dir/actions.log"

echo 'BNT environment-driven default action test passed'
