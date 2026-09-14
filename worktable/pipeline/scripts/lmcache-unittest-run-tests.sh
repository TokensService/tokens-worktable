#!/usr/bin/env bash
set -euo pipefail

# 第三阶段：在 TARGET_HOSTS[0] 的同一容器中运行 pytest 和可选清理。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lmcache-unittest-remote.sh
source "$SCRIPT_DIR/lmcache-unittest-remote.sh"

# 与第一阶段相同的目标连接参数；容器和日志目录始终属于目标节点。
TARGET_HOSTS="${TARGET_HOSTS:-}"
TARGET_IP="${TARGET_IP:-}"
SSH_PASSWORD="${SSH_PASSWORD:-${TARGET_PASSWORD:-}}"
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

RUN_DIR="$LMCACHE_UNITTEST_RUN_DIR"
ns="${LMCACHE_NERDCTL_NAMESPACE:-k8s.io}"
# 与重编译阶段使用相同的目标节点代理，允许调用方覆盖。
http_proxy="${LMCACHE_UNITTEST_HTTP_PROXY:-http://192.168.10.6:3128}"
LMCACHE_UNITTEST_TEST_LOG="$LMCACHE_UNITTEST_LOG_DIR/pytest.log"
blocks_first_target='tests/v1/gpu_connector/test_blocks_first_cs_kv_format.py::test_mp_gather_scatter_roundtrip'
LMCACHE_UNITTEST_ISOLATED_TEST_LOG=''
[[ "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST" =~ ^[01]$ ]] || { echo 'LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST must be 0 or 1' >&2; exit 2; }
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
mkdir -p "\$(dirname "\$test_log")"
pytest_env=(-e "http_proxy=\$proxy" -e "https_proxy=\$proxy" -e 'NO_PROXY=localhost,127.0.0.1' -e 'no_proxy=localhost,127.0.0.1')
if [[ "\$isolate" == 1 ]]; then
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
    '. /opt/lmcache-test-venv/bin/activate && cd /workspace/LMCache && pytest -q -ra' >"\$test_log" 2>&1
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
printf 'RESULT=%s\nIMAGE_REMOVED=%s\nISOLATED_LOG=%s\n' "\$rc" "\$image_removed" "\$isolate_log"
exit "\$rc"
EOF
)" || remote_rc=$?
remote_rc="${remote_rc:-0}"
LMCACHE_UNITTEST_TEST_RESULT="$remote_rc"
LMCACHE_UNITTEST_IMAGE_REMOVED="$(awk -F= '$1 == "IMAGE_REMOVED" { print $2 }' <<<"$remote_result")"
LMCACHE_UNITTEST_ISOLATED_TEST_LOG="$(awk -F= '$1 == "ISOLATED_LOG" { sub(/^[^=]*=/, ""); print }' <<<"$remote_result")"
[[ -n "$LMCACHE_UNITTEST_IMAGE_REMOVED" ]] || LMCACHE_UNITTEST_IMAGE_REMOVED=0

printf 'LMCACHE_UNITTEST_RUN_DIR=%s\n' "$RUN_DIR"
printf 'LMCACHE_UNITTEST_LOG_DIR=%s\n' "$LMCACHE_UNITTEST_LOG_DIR"
printf 'LMCACHE_UNITTEST_CONTAINER=%s\n' "$LMCACHE_UNITTEST_CONTAINER"
printf 'LMCACHE_UNITTEST_CAP_ADD=%s\n' "$LMCACHE_UNITTEST_CAP_ADD"
printf 'LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST=%s\n' "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST"
printf 'LMCACHE_UNITTEST_HTTP_PROXY=%s\n' "$http_proxy"
printf 'LMCACHE_UNITTEST_REMOVE_IMAGE=%s\n' "$LMCACHE_UNITTEST_REMOVE_IMAGE"
printf 'LMCACHE_UNITTEST_IMAGE_REMOVED=%s\n' "$LMCACHE_UNITTEST_IMAGE_REMOVED"
printf 'LMCACHE_UNITTEST_TEST_LOG=%s\n' "$LMCACHE_UNITTEST_TEST_LOG"
printf 'LMCACHE_UNITTEST_ISOLATED_TEST_LOG=%s\n' "$LMCACHE_UNITTEST_ISOLATED_TEST_LOG"
printf 'LMCACHE_UNITTEST_TEST_RESULT=%s\n' "$LMCACHE_UNITTEST_TEST_RESULT"
[[ "$remote_rc" == 0 ]]
