#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/bnt-standalone.sh"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin"

cat >"$work_dir/bin/service" <<'EOF'
#!/usr/bin/env bash
printf 'service %s\n' "$*" >>"$BNT_TEST_LOG"
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

PATH="$work_dir/bin:$PATH" \
BNT_TEST_LOG="$work_dir/actions.log" \
LOG_FILE="$work_dir/bnt.log" \
BNT_DRY_RUN=0 \
bash "$script" >"$work_dir/output"

grep -Fq 'BNT 标准化开始 steps=[crond containers gpu]' "$work_dir/output"
grep -Fq 'service crond stop' "$work_dir/actions.log"

cat >"$work_dir/bin/scp" <<'EOF'
#!/usr/bin/env bash
printf 'scp %s\n' "$*" >>"$BNT_TEST_LOG"
EOF

cat >"$work_dir/bin/ssh" <<'EOF'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >>"$BNT_TEST_LOG"
EOF

chmod +x "$work_dir/bin/scp" "$work_dir/bin/ssh"
: >"$work_dir/actions.log"

PATH="$work_dir/bin:$PATH" \
BNT_TEST_LOG="$work_dir/actions.log" \
LOG_FILE="$work_dir/bnt-remote.log" \
BNT_ACTION=check-health \
TARGET_HOSTS='[{"ip":"192.0.2.10"},{"ip":"192.0.2.11"}]' \
bash "$script" >"$work_dir/remote-output"

grep -Fq 'root@192.0.2.10' "$work_dir/actions.log"
grep -Fq 'root@192.0.2.11' "$work_dir/actions.log"
grep -Fq 'BNT_REMOTE_EXECUTION=1' "$work_dir/actions.log"

echo 'BNT environment-driven default action test passed'
