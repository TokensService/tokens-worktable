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

PATH="$work_dir/bin:$PATH" \
  TEST_ACTION_LOG="$work_dir/actions.log" \
  LOG_FILE="$work_dir/bnt.log" \
  DRY_RUN=0 \
  bash "$script" >"$work_dir/output"

grep -Fq 'BNT 标准化开始 steps=[crond containers gpu]' "$work_dir/output"
grep -Fq 'service crond stop' "$work_dir/actions.log"
if grep -Fq '环境健康检查' "$work_dir/output"; then exit 1; fi

cat >"$work_dir/bin/scp" <<'EOF'
#!/usr/bin/env bash
printf 'scp %s\n' "$*" >>"$TEST_ACTION_LOG"
EOF

cat >"$work_dir/bin/ssh" <<'EOF'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >>"$TEST_ACTION_LOG"
EOF

cat >"$work_dir/bin/sshpass" <<'EOF'
#!/usr/bin/env bash
printf 'sshpass password=%s command=%s\n' "$SSHPASS" "$*" >>"$TEST_ACTION_LOG"
[[ "${1:-}" == '-e' ]] && shift
"$@"
EOF

chmod +x "$work_dir/bin/scp" "$work_dir/bin/ssh" "$work_dir/bin/sshpass"
: >"$work_dir/actions.log"

PATH="$work_dir/bin:$PATH" \
TEST_ACTION_LOG="$work_dir/actions.log" \
LOG_FILE="$work_dir/bnt-remote.log" \
ACTION=check-health \
SSH_PASSWORD=test-password \
TARGET_HOSTS='[{"ip":"192.0.2.10"},{"ip":"192.0.2.11"}]' \
bash "$script" >"$work_dir/remote-output"

grep -Fq 'sshpass password=test-password' "$work_dir/actions.log"
grep -Fq 'root@192.0.2.10' "$work_dir/actions.log"
grep -Fq 'root@192.0.2.11' "$work_dir/actions.log"
grep -Fq 'REMOTE_EXECUTION=1' "$work_dir/actions.log"

# 两个新入口单独复制后仍能运行，不依赖旧入口或相邻文件。
cp "$script_dir/cleanup-env.sh" "$work_dir/cleanup-env.sh"
cp "$script_dir/check-env.sh" "$work_dir/check-env.sh"
PATH="$work_dir/bin:$PATH" TEST_ACTION_LOG="$work_dir/actions.log" LOG_FILE="$work_dir/clean.log" \
  DRY_RUN=1 bash "$work_dir/cleanup-env.sh" >"$work_dir/clean-output"
if grep -q '环境健康检查' "$work_dir/clean-output"; then exit 1; fi
: >"$work_dir/actions.log"
if PATH="$work_dir/bin:$PATH" TEST_ACTION_LOG="$work_dir/actions.log" LOG_FILE="$work_dir/check.log" \
  bash "$work_dir/check-env.sh" >"$work_dir/check-output"; then
  echo '检查应报告测试环境缺少组件' >&2; exit 1
fi
grep -q '健康检查完成' "$work_dir/check-output"
[[ ! -s "$work_dir/actions.log" ]]
# 检查脚本不能被继承的 ACTION 切换成清理。
if ACTION=kill-gpu LOG_FILE="$work_dir/reject.log" bash "$work_dir/check-env.sh" >"$work_dir/reject-output"; then exit 1; fi
echo 'BNT independent cleanup/check environment tests passed'
