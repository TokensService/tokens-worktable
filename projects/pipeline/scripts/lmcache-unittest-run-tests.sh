#!/usr/bin/env bash
set -euo pipefail

# 第三阶段：在 TARGET_HOSTS[0] 的同一容器中运行 pytest 和可选清理。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lmcache-unittest-remote.sh
source "$SCRIPT_DIR/lmcache-unittest-remote.sh"

# 与第一阶段相同的目标连接参数；容器和日志目录始终属于目标节点。
TARGET_HOSTS="${TARGET_HOSTS:-}"
TARGET_IP="${TARGET_IP:-}"
SSH_PASSWORD="${SSH_PASSWORD:-}"
[[ -n "$SSH_PASSWORD" ]] || SSH_PASSWORD="${TARGET_PASSWORD:-}"
TARGET_USER="${TARGET_USER:-root}"
TARGET_RUN_DIR="${TARGET_RUN_DIR:-}"
require_inherited() {
  local name="$1" prerequisite="$2"
  [[ -n "${!name:-}" ]] || { printf '%s is required; %s\n' "$name" "$prerequisite" >&2; exit 2; }
}
require_inherited LMCACHE_UNITTEST_RUN_DIR 'run pull stage first'
require_inherited LMCACHE_UNITTEST_IMAGE 'run pull stage first'
require_inherited LMCACHE_UNITTEST_CONTAINER 'run rebuild stage first'
require_inherited LMCACHE_UNITTEST_CAP_ADD 'run pull stage first'
require_inherited LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST 'run pull stage first'
require_inherited LMCACHE_UNITTEST_LOG_DIR 'run pull stage first'
require_inherited LMCACHE_UNITTEST_REMOVE_IMAGE 'run pull stage first'

# RUN_DIR 是执行机回传日志目录；目标节点日志仍由
# LMCACHE_UNITTEST_LOG_DIR 指定。
RUN_DIR="${RUN_DIR:-/tmp/LMCache仓-单元测试-$(date +%Y%m%d_%H%M%S)}"
ns="${LMCACHE_NERDCTL_NAMESPACE:-k8s.io}"
# 与重编译阶段使用相同的目标节点代理，允许调用方覆盖。
http_proxy="${LMCACHE_UNITTEST_HTTP_PROXY:-http://192.168.10.6:3128}"
LMCACHE_UNITTEST_TEST_LOG="$LMCACHE_UNITTEST_LOG_DIR/pytest.log"
LMCACHE_UNITTEST_CPU_ONLY="${LMCACHE_UNITTEST_CPU_ONLY:-0}"
LMCACHE_UNITTEST_GPU_DEVICES="${LMCACHE_UNITTEST_GPU_DEVICES:-all}"
blocks_first_target='tests/v1/gpu_connector/test_blocks_first_cs_kv_format.py::test_mp_gather_scatter_roundtrip'
LMCACHE_UNITTEST_ISOLATED_TEST_LOG=''
[[ "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST" =~ ^[01]$ ]] || { echo 'LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST must be 0 or 1' >&2; exit 2; }
[[ "$LMCACHE_UNITTEST_CPU_ONLY" =~ ^[01]$ ]] || { echo 'LMCACHE_UNITTEST_CPU_ONLY must be 0 or 1' >&2; exit 2; }
[[ "$LMCACHE_UNITTEST_GPU_DEVICES" == all || "$LMCACHE_UNITTEST_GPU_DEVICES" =~ ^[0-9]+(,[0-9]+)*$ ]] || {
  echo 'LMCACHE_UNITTEST_GPU_DEVICES must be all or comma-separated GPU IDs such as 0,1' >&2
  exit 2
}
lmcache_remote_init

# The remote script writes large pytest logs on the target. Its final marker is
# the only value returned over SSH, keeping worktable output compact.
remote_result="$(lmcache_remote bash -s <<EOF
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\${PATH:-}"
namespace=$(printf '%q' "$ns")
container=$(printf '%q' "$LMCACHE_UNITTEST_CONTAINER")
image=$(printf '%q' "$LMCACHE_UNITTEST_IMAGE")
proxy=$(printf '%q' "$http_proxy")
test_log=$(printf '%q' "$LMCACHE_UNITTEST_TEST_LOG")
isolate_log=$(printf '%q' "$LMCACHE_UNITTEST_LOG_DIR/pytest-blocks-first.log")
isolate=$(printf '%q' "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST")
remove_image=$(printf '%q' "$LMCACHE_UNITTEST_REMOVE_IMAGE")
keep_container=$(printf '%q' "${LMCACHE_UNITTEST_KEEP_CONTAINER:-0}")
target=$(printf '%q' "$blocks_first_target")
cpu_only=$(printf '%q' "$LMCACHE_UNITTEST_CPU_ONLY")
mkdir -p "\$(dirname "\$test_log")"
pytest_env=(-e "http_proxy=\$proxy" -e "https_proxy=\$proxy" -e 'NO_PROXY=localhost,127.0.0.1' -e 'no_proxy=localhost,127.0.0.1')
pytest_args=()
if [[ "\$cpu_only" == 1 ]]; then
  # 防止没有完整 CUDA marker 的历史用例因可见 GPU 而进入 GPU 分支。
  pytest_env+=(-e 'CUDA_VISIBLE_DEVICES=')
  pytest_args=(-m 'not cuda and not xpu and not musa')
  echo '[lmcache-debug] pytest mode: cpu-only; CUDA devices hidden and device tests excluded'
fi
if [[ "\$isolate" == 1 && "\$cpu_only" != 1 ]]; then
  set +e
  nerdctl --namespace "\$namespace" exec "\${pytest_env[@]}" "\$container" bash -lc \
    '. /opt/lmcache-test-venv/bin/activate && cd /workspace/LMCache && pytest -q -ra "\$1"' _ "\$target" >"\$isolate_log" 2>&1
  isolated_rc=\$?
  nerdctl --namespace "\$namespace" exec "\${pytest_env[@]}" "\$container" bash -lc \
    '. /opt/lmcache-test-venv/bin/activate && cd /workspace/LMCache && pytest -q -ra --deselect "\$1"' _ "\$target" >"\$test_log" 2>&1
  suite_rc=\$?
  set -e
  rc=0
  [[ "\$isolated_rc" == 0 && "\$suite_rc" == 0 ]] || rc=1
else
  isolate_log=''
  set +e
  nerdctl --namespace "\$namespace" exec "\${pytest_env[@]}" "\$container" bash -lc \
    '. /opt/lmcache-test-venv/bin/activate && cd /workspace/LMCache && pytest -q -ra "\$@"' _ "\${pytest_args[@]}" >"\$test_log" 2>&1
  rc=\$?
  set -e
fi
image_removed=0
if [[ "\$rc" == 0 && "\$keep_container" != 1 ]]; then
  nerdctl --namespace "\$namespace" rm -f "\$container" >/dev/null
  if [[ "\$remove_image" == 1 ]]; then
    if nerdctl --namespace "\$namespace" image rm "\$image" >/dev/null; then image_removed=1; fi
  fi
fi
summary_logs=("\$test_log")
[[ -n "\$isolate_log" ]] && summary_logs+=("\$isolate_log")
pytest_count() {
  local label="\$1"
  awk -v label="\$label" '
    {
      for (i = 1; i < NF; i++) {
        status = \$(i + 1)
        gsub(/[,:]/, "", status)
        if (\$(i) ~ /^[0-9]+$/ && status == label) total += \$(i)
      }
    }
    END { print total + 0 }
  ' "\${summary_logs[@]}"
}
pytest_cases() {
  local marker="\$1" names
  names="\$(awk -v marker="\$marker" '\$1 == marker { print \$2 }' "\${summary_logs[@]}" | sort -u | paste -sd ',' -)"
  [[ -n "\$names" ]] || names=none
  printf '%s' "\$names"
}
passed="\$(pytest_count passed)"
failed="\$(pytest_count failed)"
skipped="\$(pytest_count skipped)"
xpassed="\$(pytest_count xpassed)"
failed_cases="\$(pytest_cases FAILED)"
xpassed_cases="\$(pytest_cases XPASS)"
echo "[lmcache-debug] pytest logs: main: \$test_log; isolated: \${isolate_log:-none}"
echo "[lmcache-debug] pytest summary: passed: \$passed, failed: \$failed, skipped: \$skipped, xpassed: \$xpassed"
echo "[lmcache-debug] pytest failed tests: \$failed_cases"
echo "[lmcache-debug] pytest xpassed tests: \$xpassed_cases"
printf 'RESULT=%s\nIMAGE_REMOVED=%s\nISOLATED_LOG=%s\n' "\$rc" "\$image_removed" "\$isolate_log"
exit "\$rc"
EOF
)" || remote_rc=$?
remote_rc="${remote_rc:-0}"
# 仅转发诊断行，不把 RESULT= 等内部控制行暴露为工作台阶段变量。
printf '%s\n' "$remote_result" | awk '/^\[lmcache-debug\]/'
# pytest 无论成功或失败，都尝试将目标节点已有日志复制到执行机 RUN_DIR。
LMCACHE_UNITTEST_LOCAL_LOG_DIR="${LMCACHE_UNITTEST_LOCAL_LOG_DIR:-$RUN_DIR}"
mkdir -p "$LMCACHE_UNITTEST_LOCAL_LOG_DIR"
log_copy_rc=0
log_cleanup_rc=0
log_cleanup_command=''
if lmcache_remote_scp -r \
  "${LMCACHE_UNITTEST_TARGET}:${LMCACHE_UNITTEST_LOG_DIR}/." \
  "$LMCACHE_UNITTEST_LOCAL_LOG_DIR/"; then
  echo "[lmcache-debug] test logs copied to execution host: $LMCACHE_UNITTEST_LOCAL_LOG_DIR"
  # 仅在执行机已完整收到日志后清理目标节点副本；回传失败时保留它供排查。
  printf -v log_cleanup_command 'rm -rf -- %q' "$LMCACHE_UNITTEST_LOG_DIR"
  if lmcache_remote "$log_cleanup_command"; then
    echo "[lmcache-debug] target test logs removed after copy: $LMCACHE_UNITTEST_LOG_DIR"
  else
    log_cleanup_rc=$?
    echo "[lmcache-debug] target test log cleanup failed; target: $LMCACHE_UNITTEST_LOG_DIR" >&2
  fi
else
  log_copy_rc=$?
  echo "[lmcache-debug] test log copy failed; target: $LMCACHE_UNITTEST_LOG_DIR; execution host: $LMCACHE_UNITTEST_LOCAL_LOG_DIR" >&2
fi
# 保留 pytest 的失败结果；pytest 成功时，日志回传或回传后的目标清理失败均使阶段失败。
stage_rc="$remote_rc"
if [[ "$remote_rc" == 0 && "$log_copy_rc" != 0 ]]; then
  stage_rc="$log_copy_rc"
elif [[ "$remote_rc" == 0 && "$log_cleanup_rc" != 0 ]]; then
  stage_rc="$log_cleanup_rc"
fi
LMCACHE_UNITTEST_TEST_RESULT="$stage_rc"
LMCACHE_UNITTEST_IMAGE_REMOVED="$(awk -F= '$1 == "IMAGE_REMOVED" { print $2 }' <<<"$remote_result")"
LMCACHE_UNITTEST_ISOLATED_TEST_LOG="$(awk -F= '$1 == "ISOLATED_LOG" { sub(/^[^=]*=/, ""); print }' <<<"$remote_result")"
[[ -n "$LMCACHE_UNITTEST_IMAGE_REMOVED" ]] || LMCACHE_UNITTEST_IMAGE_REMOVED=0

printf 'RUN_DIR=%s\n' "$RUN_DIR"
printf 'LMCACHE_UNITTEST_RUN_DIR=%s\n' "$LMCACHE_UNITTEST_RUN_DIR"
printf 'LMCACHE_UNITTEST_LOG_DIR=%s\n' "$LMCACHE_UNITTEST_LOG_DIR"
printf 'LMCACHE_UNITTEST_CONTAINER=%s\n' "$LMCACHE_UNITTEST_CONTAINER"
printf 'LMCACHE_UNITTEST_CAP_ADD=%s\n' "$LMCACHE_UNITTEST_CAP_ADD"
printf 'LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST=%s\n' "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST"
printf 'LMCACHE_UNITTEST_HTTP_PROXY=%s\n' "$http_proxy"
printf 'LMCACHE_UNITTEST_REMOVE_IMAGE=%s\n' "$LMCACHE_UNITTEST_REMOVE_IMAGE"
printf 'LMCACHE_UNITTEST_CPU_ONLY=%s\n' "$LMCACHE_UNITTEST_CPU_ONLY"
printf 'LMCACHE_UNITTEST_GPU_DEVICES=%s\n' "$LMCACHE_UNITTEST_GPU_DEVICES"
printf 'LMCACHE_UNITTEST_LOCAL_LOG_DIR=%s\n' "$LMCACHE_UNITTEST_LOCAL_LOG_DIR"
printf 'LMCACHE_UNITTEST_LOG_CLEANUP_RESULT=%s\n' "$log_cleanup_rc"
printf 'LMCACHE_UNITTEST_IMAGE_REMOVED=%s\n' "$LMCACHE_UNITTEST_IMAGE_REMOVED"
printf 'LMCACHE_UNITTEST_TEST_LOG=%s\n' "$LMCACHE_UNITTEST_TEST_LOG"
printf 'LMCACHE_UNITTEST_ISOLATED_TEST_LOG=%s\n' "$LMCACHE_UNITTEST_ISOLATED_TEST_LOG"
printf 'LMCACHE_UNITTEST_TEST_RESULT=%s\n' "$LMCACHE_UNITTEST_TEST_RESULT"
[[ "$stage_rc" == 0 ]]
