#!/usr/bin/env bash
set -euo pipefail

# 必填上游输入（由 pull-image.sh / rebuild.sh 的 KEY=VALUE 输出自动注入；单独执行时必须提供）：
# - LMCACHE_UNITTEST_RUN_DIR、LMCACHE_UNITTEST_CONTAINER、LMCACHE_UNITTEST_CAP_ADD、
#   LMCACHE_UNITTEST_LOG_DIR。
# 可选覆盖输入：LMCACHE_NERDCTL_NAMESPACE、LMCACHE_UNITTEST_HTTP_PROXY、
# LMCACHE_UNITTEST_REMOVE_IMAGE；
# LMCACHE_UNITTEST_KEEP_CONTAINER=1 时测试成功后保留容器。
# CAP_ADD 在本阶段仅继续传递给后续任务，不作为 pytest 命令参数使用。
# 本阶段输出 pytest 日志路径和退出码，供工作台归档或下游任务引用。
# 第三阶段：在重编译完成的同一容器中执行 LMCache pytest。
command -v nerdctl >/dev/null || { echo 'nerdctl is required' >&2; exit 2; }
# 容器名、日志目录和 capability 均由前序阶段经工作台变量池传入。
: "${LMCACHE_UNITTEST_RUN_DIR:?run pull stage first}"
: "${LMCACHE_UNITTEST_IMAGE:?run pull stage first}"
: "${LMCACHE_UNITTEST_CONTAINER:?run rebuild stage first}"
: "${LMCACHE_UNITTEST_CAP_ADD:?run pull stage first}"
: "${LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST:?run pull stage first}"
: "${LMCACHE_UNITTEST_LOG_DIR:?run pull stage first}"
: "${LMCACHE_UNITTEST_REMOVE_IMAGE:?run pull stage first}"
RUN_DIR="$LMCACHE_UNITTEST_RUN_DIR"
ns="${LMCACHE_NERDCTL_NAMESPACE:-k8s.io}"
LMCACHE_UNITTEST_TEST_LOG="$LMCACHE_UNITTEST_LOG_DIR/pytest.log"
mkdir -p "$LMCACHE_UNITTEST_LOG_DIR"
http_proxy="${LMCACHE_UNITTEST_HTTP_PROXY:-http://127.0.0.1:8889}"
pytest_exec_env=(-e "http_proxy=$http_proxy" -e "https_proxy=$http_proxy" -e 'NO_PROXY=localhost,127.0.0.1' -e 'no_proxy=localhost,127.0.0.1')
blocks_first_target='tests/v1/gpu_connector/test_blocks_first_cs_kv_format.py::test_mp_gather_scatter_roundtrip'
LMCACHE_UNITTEST_ISOLATED_TEST_LOG=''

if [[ "$LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST" == 1 ]]; then
  # 该用例独立运行时通过，但共享 CUDA context 的全量执行中可能观察到前序 native
  # runtime 留下的错误。先用新 Python/CUDA 进程执行它，再从主套件排除，确保只运行一次。
  LMCACHE_UNITTEST_ISOLATED_TEST_LOG="$LMCACHE_UNITTEST_LOG_DIR/pytest-blocks-first.log"
  set +e
  nerdctl --namespace "$ns" exec "${pytest_exec_env[@]}" "$LMCACHE_UNITTEST_CONTAINER" bash -lc \
    '. /opt/lmcache-test-venv/bin/activate && cd /workspace/LMCache && pytest -q -ra "$1"' _ "$blocks_first_target" \
    >"$LMCACHE_UNITTEST_ISOLATED_TEST_LOG" 2>&1
  isolated_rc=$?
  nerdctl --namespace "$ns" exec "${pytest_exec_env[@]}" "$LMCACHE_UNITTEST_CONTAINER" bash -lc \
    '. /opt/lmcache-test-venv/bin/activate && cd /workspace/LMCache && pytest -q -ra --deselect "$1"' _ "$blocks_first_target" \
    >"$LMCACHE_UNITTEST_TEST_LOG" 2>&1
  suite_rc=$?
  set -e
  # 两个进程均通过才算本阶段成功，避免隔离模式掩盖目标用例自身的失败。
  rc=0
  [[ "$isolated_rc" == 0 && "$suite_rc" == 0 ]] || rc=1
else
  # 诊断模式刻意保留原始单进程顺序，以持续暴露跨测试 CUDA context 污染。
  set +e
  nerdctl --namespace "$ns" exec "${pytest_exec_env[@]}" "$LMCACHE_UNITTEST_CONTAINER" bash -lc \
    '. /opt/lmcache-test-venv/bin/activate && cd /workspace/LMCache && pytest -q -ra' >"$LMCACHE_UNITTEST_TEST_LOG" 2>&1
  rc=$?
  set -e
fi
LMCACHE_UNITTEST_TEST_RESULT="$rc"
LMCACHE_UNITTEST_IMAGE_REMOVED=0
# 默认在测试成功后回收容器；设置 KEEP_CONTAINER=1 可保留现场用于诊断。
if [[ "$rc" == 0 && "${LMCACHE_UNITTEST_KEEP_CONTAINER:-0}" != 1 ]]; then
  nerdctl --namespace "$ns" rm -f "$LMCACHE_UNITTEST_CONTAINER" >/dev/null
  # 仅在成功且容器已回收后删除镜像。失败现场或 KEEP_CONTAINER=1 不触发删除，
  # 避免清理镜像时破坏可复现的诊断环境。
  if [[ "$LMCACHE_UNITTEST_REMOVE_IMAGE" == 1 ]]; then
    if nerdctl --namespace "$ns" image rm "$LMCACHE_UNITTEST_IMAGE" >/dev/null; then
      LMCACHE_UNITTEST_IMAGE_REMOVED=1
    else
      echo "warning: image was not removed (it may be referenced by another container): $LMCACHE_UNITTEST_IMAGE" >&2
    fi
  fi
fi

# 结果同样以 KEY=VALUE 输出，便于工作台归档和后续任务引用。
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
[[ "$rc" == 0 ]]
