#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
log="$tmp/commands.log"
cat >"$tmp/bin/nerdctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_LOG"
printf 'NERDCTL_PATH=%s\n' "$PATH" >>"$FAKE_LOG"
if [[ "$*" == *'pytest -q -ra'* ]]; then
  pytest_count=0
  [[ -f "$FAKE_PYTEST_COUNT_FILE" ]] && pytest_count="$(<"$FAKE_PYTEST_COUNT_FILE")"
  pytest_count=$((pytest_count + 1))
  printf '%s' "$pytest_count" >"$FAKE_PYTEST_COUNT_FILE"
  if [[ "$pytest_count" -gt 1 ]]; then
    cat <<'PYTEST'
=========================== short test summary info ============================
FAILED tests/fake_failure.py::test_failure - simulated failure
XPASS tests/fake_xpass.py::test_xpass - simulated xpass
1 failed, 2 skipped, 3 passed, 1 xpassed in 0.01s
PYTEST
  else
    printf '1 passed in 0.01s\n'
  fi
  exit "${FAKE_PYTEST_EXIT:-0}"
fi
if [[ "$*" == *'clone --branch'* ]]; then
  mkdir -p "$FAKE_REPO_DIR"
  printf 'fake repository\n' >"$FAKE_REPO_DIR/README.md"
  git -C "$FAKE_REPO_DIR" init -q
  git -C "$FAKE_REPO_DIR" add README.md
  git -C "$FAKE_REPO_DIR" -c user.name=test -c user.email=test@example.invalid commit -qm initial
fi
if [[ "$*" == *'__LMCACHE_REPO_STATS__'* ]]; then
  printf '__LMCACHE_REPO_STATS__\t1\t1\tdeadbeef\n'
  exit 0
fi
if [[ "${3:-}" == image && "${4:-}" == rm ]]; then exit 0; fi
case "${3:-}" in
  image) exit 1;;
  inspect) printf 'running\n';;
  run) printf 'fake-container-id\n';;
  pull|exec|rm) exit 0;;
esac
EOF
cat >"$tmp/bin/ctr" <<'EOF'
#!/usr/bin/env bash
printf 'ctr %s\n' "$*" >>"$FAKE_LOG"
EOF
cat >"$tmp/bin/sudo" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == ctr && -n "${FAKE_CTR:-}" ]]; then
  shift
  exec "$FAKE_CTR" "$@"
fi
exec "$@"
EOF
cat >"$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >>"$FAKE_LOG"
if [[ "$*" == *' ls-files'* ]]; then
  printf 'README.md\n'
  exit 0
fi
if [[ "$*" == *' rev-parse --short HEAD'* ]]; then
  printf 'deadbeef\n'
  exit 0
fi
if [[ "${GIT_CONFIG_COUNT:-}" == 1 && "${GIT_CONFIG_KEY_0:-}" == 'http.extraHeader' && -n "${GIT_CONFIG_VALUE_0:-}" ]]; then
  printf '%s\n' 'git auth header configured' >>"$FAKE_LOG"
fi
mkdir -p "${@: -1}/lmcache"
EOF
cat >"$tmp/bin/ssh" <<'EOF'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >>"$FAKE_LOG"
args=("$@")
i=0
while (( i < ${#args[@]} )); do
  case "${args[i]}" in
    -p) ((i += 2));;
    -o) ((i += 2));;
    *) break;;
  esac
done
target="${args[i]}"
((i += 1))
[[ "$target" == 'root@192.0.2.78' ]] || {
  echo "unexpected target: $target" >&2
  exit 98
}
if [[ "${args[i]:-}" == 'bash -s' ]]; then
  bash -s
else
  bash -lc "${args[i]:-}"
fi
EOF
cat >"$tmp/bin/sshpass" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == '-e' ]] && shift
case "${1:-}" in
  ssh) shift; exec ssh "$@";;
  scp) shift; exec scp "$@";;
  *) exit 2;;
esac
EOF
cat >"$tmp/bin/scp" <<'EOF'
#!/usr/bin/env bash
printf 'scp %s\n' "$*" >>"$FAKE_LOG"
args=("$@")
i=0
while (( i < ${#args[@]} )); do
  case "${args[i]}" in
    -P|-o) ((i += 2));;
    -r|-q) ((i += 1));;
    *) break;;
  esac
done
source_path="${args[i]}"
destination="${args[i + 1]}"
source_path="${source_path#*:}"
source_path="${source_path%/.}"
mkdir -p "$destination"
cp -a "$source_path/." "$destination/"
EOF
chmod +x "$tmp/bin/nerdctl" "$tmp/bin/ctr" "$tmp/bin/sudo" "$tmp/bin/git"
chmod +x "$tmp/bin/ssh" "$tmp/bin/sshpass" "$tmp/bin/scp"

# 目标节点上的远端 Bash 会话补齐 GPU runtime 的标准 PATH。
grep -Fq 'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\${PATH:-}"' "$root/lmcache-unittest-pull-image.sh"

# 上游变量由工作台变量池自动注入。脚本必须在实际执行时校验它们，
# 但不得使用 Bash 的“变量为空即退出”展开，否则工作台的静态扫描会把这些字段标为人工必填。
for script in lmcache-unittest-rebuild.sh lmcache-unittest-run-tests.sh; do
  if rg -q ': "\$\{LMCACHE_UNITTEST_[A-Z_]+:\?' "$root/$script"; then
    echo "$script must not declare inherited variables with :?" >&2
    exit 1
  fi
done
if env -u LMCACHE_UNITTEST_RUN_DIR PATH="$tmp/bin:$PATH" FAKE_LOG="$log" \
  bash "$root/lmcache-unittest-rebuild.sh" >"$tmp/rebuild-missing.out" 2>&1; then
  echo 'rebuild must reject a missing inherited run directory' >&2
  exit 1
fi
grep -Fq 'run pull stage first' "$tmp/rebuild-missing.out"

# 生产脚本补齐 PATH 后会优先解析宿主机的 sudo；以导出的 Bash 函数模拟
# sudo ctr，使测试仍只记录临时 ctr 桩，不接触真实 containerd。
sudo() {
  if [[ "${1:-}" == ctr && -n "${FAKE_CTR:-}" ]]; then
    shift
    "$FAKE_CTR" "$@"
    return
  fi
  command sudo "$@"
}
export -f sudo

targets='[{"ip":"192.0.2.78","user":"root","pass":"target-secret"},{"ip":"192.0.2.79","user":"root","pass":"must-not-be-used"}]'
execution_run_dir="$tmp/execution-run"
pull_output="$(env PATH="$tmp/bin:/bin" FAKE_LOG="$log" FAKE_CTR="$tmp/bin/ctr" TARGET_HOSTS="$targets" RUN_DIR="$execution_run_dir" LMCACHE_UNITTEST_RUN_DIR="$tmp/default" LMCACHE_UNITTEST_REMOVE_IMAGE=1 \
  AK='test-ak' PROJECT='test-project' REGISTRY='swr.example.test' LOGIN_KEY='test-login-key' \
  bash "$root/lmcache-unittest-pull-image.sh")"
grep -Fq 'ctr -n k8s.io image pull --user test-project@test-ak:test-login-key lmcache-vllm-openai-0.5.4-unitest:latest' "$log"
first_nerdctl_path="$(awk -F= '/^NERDCTL_PATH=/{ print substr($0, index($0, "=") + 1); exit }' "$log")"
[[ "$first_nerdctl_path" == /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:* ]]
[[ ! -e "$tmp/default/state.env" ]]
pull_run_dir="$(awk -F= '$1 == "LMCACHE_UNITTEST_RUN_DIR" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
execution_run_dir_out="$(awk -F= '$1 == "RUN_DIR" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_image="$(awk -F= '$1 == "LMCACHE_UNITTEST_IMAGE" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_container="$(awk -F= '$1 == "LMCACHE_UNITTEST_CONTAINER" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_isolate_blocks_first="$(awk -F= '$1 == "LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_log_dir="$(awk -F= '$1 == "LMCACHE_UNITTEST_LOG_DIR" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_http_proxy="$(awk -F= '$1 == "LMCACHE_UNITTEST_HTTP_PROXY" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_remove_image="$(awk -F= '$1 == "LMCACHE_UNITTEST_REMOVE_IMAGE" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_cpu_only="$(awk -F= '$1 == "LMCACHE_UNITTEST_CPU_ONLY" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_gpu_devices="$(awk -F= '$1 == "LMCACHE_UNITTEST_GPU_DEVICES" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_target_ip="$(awk -F= '$1 == "LMCACHE_UNITTEST_TARGET_IP" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_target_port="$(awk -F= '$1 == "LMCACHE_UNITTEST_TARGET_PORT" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_target_user="$(awk -F= '$1 == "LMCACHE_UNITTEST_TARGET_USER" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
[[ "$pull_run_dir" == "$tmp/default" ]]
[[ "$execution_run_dir_out" == "$execution_run_dir" ]]
[[ "$pull_image" == 'lmcache-vllm-openai-0.5.4-unitest:latest' ]]
[[ "$pull_isolate_blocks_first" == 1 ]]
[[ -n "$pull_container" ]]
[[ "$pull_http_proxy" == 'http://192.168.10.6:3128' ]]
[[ "$pull_remove_image" == 1 ]]
[[ "$pull_cpu_only" == 0 ]]
[[ "$pull_gpu_devices" == all ]]
[[ "$pull_target_ip" == '192.0.2.78' && "$pull_target_port" == 22 && "$pull_target_user" == root ]]
grep -Fq '[lmcache-debug] image cache: miss; pulling image' <<<"$pull_output"
grep -Fq '[lmcache-debug] image pull: completed' <<<"$pull_output"
grep -Fq '[lmcache-debug] container status: running' <<<"$pull_output"

# 后续阶段只消费 pull 阶段的非敏感目标状态；密码仍由当次执行环境提供。
rebuild_output="$(env PATH="$tmp/bin:$PATH" FAKE_LOG="$log" SSH_PASSWORD='target-secret' \
  RUN_DIR="$execution_run_dir_out" \
  FAKE_REPO_DIR="$tmp/repo" \
  LMCACHE_UNITTEST_RUN_DIR="$pull_run_dir" \
  LMCACHE_UNITTEST_IMAGE="$pull_image" \
  LMCACHE_UNITTEST_CONTAINER="$pull_container" \
  LMCACHE_UNITTEST_CAP_ADD='SYS_NICE' \
  LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST="$pull_isolate_blocks_first" \
  LMCACHE_UNITTEST_LOG_DIR="$pull_log_dir" \
  LMCACHE_UNITTEST_HTTP_PROXY="$pull_http_proxy" \
  LMCACHE_UNITTEST_REMOVE_IMAGE="$pull_remove_image" \
  LMCACHE_UNITTEST_CPU_ONLY="$pull_cpu_only" \
  LMCACHE_UNITTEST_GPU_DEVICES="$pull_gpu_devices" \
  LMCACHE_UNITTEST_TARGET_IP="$pull_target_ip" \
  LMCACHE_UNITTEST_TARGET_PORT="$pull_target_port" \
  LMCACHE_UNITTEST_TARGET_USER="$pull_target_user" \
  LMCACHE_UNITTEST_REPO_DIR="$tmp/repo" \
  LMCACHE_UNITTEST_GIT_URL='https://gitcode.com/TokensService/LMCache.git' \
  LMCACHE_UNITTEST_GIT_BRANCH='dev' \
  LMCACHE_UNITTEST_GIT_USER='oauth2' \
  LMCACHE_UNITTEST_GIT_TOKEN='secret-token' \
  bash "$root/lmcache-unittest-rebuild.sh")"
[[ ! -e "$tmp/default/state.env" ]]
rebuild_container="$(awk -F= '$1 == "LMCACHE_UNITTEST_CONTAINER" { print substr($0, index($0, "=") + 1) }' <<<"$rebuild_output")"
rebuild_log_dir="$(awk -F= '$1 == "LMCACHE_UNITTEST_LOG_DIR" { print substr($0, index($0, "=") + 1) }' <<<"$rebuild_output")"
rebuild_http_proxy="$(awk -F= '$1 == "LMCACHE_UNITTEST_HTTP_PROXY" { print substr($0, index($0, "=") + 1) }' <<<"$rebuild_output")"
rebuild_remove_image="$(awk -F= '$1 == "LMCACHE_UNITTEST_REMOVE_IMAGE" { print substr($0, index($0, "=") + 1) }' <<<"$rebuild_output")"
[[ -n "$rebuild_container" ]]
[[ "$rebuild_container" == "$pull_container" ]]
[[ "$rebuild_http_proxy" == "$pull_http_proxy" ]]
[[ "$rebuild_remove_image" == "$pull_remove_image" ]]
grep -Fq '[lmcache-debug] clone: completed' <<<"$rebuild_output"
grep -Fq '[lmcache-debug] repository files:' <<<"$rebuild_output"
grep -Fq '__LMCACHE_REPO_STATS__' "$log"

test_output="$(env PATH="$tmp/bin:$PATH" FAKE_LOG="$log" SSH_PASSWORD='target-secret' \
  RUN_DIR="$execution_run_dir_out" \
  FAKE_PYTEST_COUNT_FILE="$tmp/pytest-count" \
  LMCACHE_UNITTEST_RUN_DIR="$pull_run_dir" \
  LMCACHE_UNITTEST_IMAGE="$pull_image" \
  LMCACHE_UNITTEST_CONTAINER="$rebuild_container" \
  LMCACHE_UNITTEST_CAP_ADD='SYS_NICE' \
  LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST="$pull_isolate_blocks_first" \
  LMCACHE_UNITTEST_LOG_DIR="$rebuild_log_dir" \
  LMCACHE_UNITTEST_HTTP_PROXY="$rebuild_http_proxy" \
  LMCACHE_UNITTEST_REMOVE_IMAGE="$rebuild_remove_image" \
  LMCACHE_UNITTEST_CPU_ONLY="$pull_cpu_only" \
  LMCACHE_UNITTEST_GPU_DEVICES="$pull_gpu_devices" \
  LMCACHE_UNITTEST_TARGET_IP="$pull_target_ip" \
  LMCACHE_UNITTEST_TARGET_PORT="$pull_target_port" \
  LMCACHE_UNITTEST_TARGET_USER="$pull_target_user" \
  bash "$root/lmcache-unittest-run-tests.sh")"
grep -Fq -- '--net=host --gpus all --cap-add SYS_NICE -v /dev/shm:/dev/shm' "$log"
# 认证 clone 的命令主体也必须作为 nerdctl exec 的容器内脚本下发；
# token 只走 stdin，因而不能出现在 nerdctl 参数记录中。
grep -Fq -- 'git -c "http.extraHeader=Authorization: Basic $git_auth_b64" clone' "$log"
grep -Fq -- 'http_proxy=http://192.168.10.6:3128' "$log"
grep -Fq -- 'image rm lmcache-vllm-openai-0.5.4-unitest:latest' "$log"
if grep -Fq 'git https://gitcode.com/TokensService/LMCache.git' "$log"; then exit 1; fi
if grep -Fq 'secret-token' "$log"; then exit 1; fi
grep -Fq -- 'BUILD_WITH_CUDA=1' "$log"
grep -Fq -- 'http_proxy=http://192.168.10.6:3128' "$log"
grep -Fq -- 'test_mp_gather_scatter_roundtrip' "$log"
grep -Fq -- '--deselect "$1"' "$log"
grep -Fq -- 'pytest -q -ra' "$log"
grep -Fq 'ssh -p 22 ' "$log"
grep -Fq 'root@192.0.2.78' "$log"
if grep -Fq '192.0.2.79' "$log" || grep -Fq 'target-secret' "$log" || grep -Fq 'must-not-be-used' "$log"; then
  echo 'only the first target may be used and passwords must not be logged' >&2
  exit 1
fi
[[ ! -e "$tmp/default/state.env" ]]
grep -Fq 'LMCACHE_UNITTEST_TEST_RESULT=0' <<<"$test_output"
grep -Fq 'LMCACHE_UNITTEST_IMAGE_REMOVED=1' <<<"$test_output"
grep -Fq "LMCACHE_UNITTEST_LOCAL_LOG_DIR=$execution_run_dir" <<<"$test_output"
[[ -f "$execution_run_dir/build.log" ]]
[[ -f "$execution_run_dir/pytest.log" ]]
[[ -f "$execution_run_dir/pytest-blocks-first.log" ]]
grep -Fq "root@192.0.2.78:$pull_log_dir/." "$log"
grep -Fq "$execution_run_dir/" "$log"
grep -Fq '[lmcache-debug] pytest summary: passed: 4, failed: 1, skipped: 2, xpassed: 1' <<<"$test_output"
grep -Fq '[lmcache-debug] pytest failed tests: tests/fake_failure.py::test_failure' <<<"$test_output"
grep -Fq '[lmcache-debug] pytest xpassed tests: tests/fake_xpass.py::test_xpass' <<<"$test_output"

cpu_pull_output="$(env PATH="$tmp/bin:/bin" FAKE_LOG="$log" FAKE_CTR="$tmp/bin/ctr" TARGET_HOSTS="$targets" \
  RUN_DIR="$tmp/cpu-execution" LMCACHE_UNITTEST_RUN_DIR="$tmp/cpu" LMCACHE_UNITTEST_REMOVE_IMAGE=0 LMCACHE_UNITTEST_CPU_ONLY=1 \
  AK='test-ak' PROJECT='test-project' LOGIN_KEY='test-login-key' \
  bash "$root/lmcache-unittest-pull-image.sh")"
grep -Fq 'LMCACHE_UNITTEST_CPU_ONLY=1' <<<"$cpu_pull_output"
grep -Fq '[lmcache-debug] execution mode: cpu-only; GPU devices are not attached' <<<"$cpu_pull_output"
cpu_run_line="$(grep 'lmcache-unittest-cpu-execution' "$log" | grep ' run ' | tail -1)"
[[ "$cpu_run_line" != *'--gpus all'* ]]

selected_gpu_output="$(env PATH="$tmp/bin:/bin" FAKE_LOG="$log" FAKE_CTR="$tmp/bin/ctr" TARGET_HOSTS="$targets" \
  RUN_DIR="$tmp/selected-gpu-execution" LMCACHE_UNITTEST_RUN_DIR="$tmp/selected-gpu-target" \
  LMCACHE_UNITTEST_REMOVE_IMAGE=0 LMCACHE_UNITTEST_GPU_DEVICES='0,1' \
  AK='test-ak' PROJECT='test-project' LOGIN_KEY='test-login-key' \
  bash "$root/lmcache-unittest-pull-image.sh")"
grep -Fq 'LMCACHE_UNITTEST_GPU_DEVICES=0,1' <<<"$selected_gpu_output"
grep -Fq '[lmcache-debug] execution mode: gpu; GPU devices: 0,1' <<<"$selected_gpu_output"
selected_gpu_run_line="$(grep 'lmcache-unittest-selected-gpu-execution' "$log" | grep ' run ' | tail -1)"
[[ "$selected_gpu_run_line" == *'--gpus device=0,1'* ]]

cpu_test_output="$(env PATH="$tmp/bin:$PATH" FAKE_LOG="$log" SSH_PASSWORD='target-secret' \
  RUN_DIR="$tmp/cpu-execution" \
  FAKE_PYTEST_COUNT_FILE="$tmp/cpu-pytest-count" \
  LMCACHE_UNITTEST_RUN_DIR="$tmp/cpu" \
  LMCACHE_UNITTEST_IMAGE="$pull_image" \
  LMCACHE_UNITTEST_CONTAINER='lmcache-unittest-cpu' \
  LMCACHE_UNITTEST_CAP_ADD='SYS_NICE' \
  LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST=1 \
  LMCACHE_UNITTEST_LOG_DIR="$tmp/cpu/logs" \
  LMCACHE_UNITTEST_HTTP_PROXY="$pull_http_proxy" \
  LMCACHE_UNITTEST_REMOVE_IMAGE=0 \
  LMCACHE_UNITTEST_CPU_ONLY=1 \
  LMCACHE_UNITTEST_TARGET_IP="$pull_target_ip" \
  LMCACHE_UNITTEST_TARGET_PORT="$pull_target_port" \
  LMCACHE_UNITTEST_TARGET_USER="$pull_target_user" \
  bash "$root/lmcache-unittest-run-tests.sh")"
grep -Fq '[lmcache-debug] pytest mode: cpu-only; CUDA devices hidden and device tests excluded' <<<"$cpu_test_output"
grep -Fq -- 'CUDA_VISIBLE_DEVICES=' "$log"
grep -Fq -- '-m not cuda and not xpu and not musa' "$log"
if grep 'lmcache-unittest-cpu' "$log" | grep -Fq 'test_mp_gather_scatter_roundtrip'; then
  echo 'cpu-only mode must not run the blocks-first CUDA test' >&2
  exit 1
fi

# pytest 失败时也必须先回传已有日志，再将原始失败结果交还给工作台。
failure_remote_log_dir="$tmp/failure-remote/logs"
if env PATH="$tmp/bin:$PATH" FAKE_LOG="$log" SSH_PASSWORD='target-secret' \
  FAKE_PYTEST_COUNT_FILE="$tmp/failure-pytest-count" FAKE_PYTEST_EXIT=1 \
  RUN_DIR="$tmp/failure-execution" \
  LMCACHE_UNITTEST_RUN_DIR="$tmp/failure-remote" \
  LMCACHE_UNITTEST_IMAGE="$pull_image" \
  LMCACHE_UNITTEST_CONTAINER='lmcache-unittest-failure' \
  LMCACHE_UNITTEST_CAP_ADD='SYS_NICE' LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST=0 \
  LMCACHE_UNITTEST_LOG_DIR="$failure_remote_log_dir" \
  LMCACHE_UNITTEST_HTTP_PROXY="$pull_http_proxy" LMCACHE_UNITTEST_REMOVE_IMAGE=0 \
  LMCACHE_UNITTEST_CPU_ONLY=1 \
  LMCACHE_UNITTEST_TARGET_IP="$pull_target_ip" LMCACHE_UNITTEST_TARGET_PORT="$pull_target_port" \
  LMCACHE_UNITTEST_TARGET_USER="$pull_target_user" \
  bash "$root/lmcache-unittest-run-tests.sh" >"$tmp/failure.out" 2>&1; then
  echo 'pytest failure must fail the test stage' >&2
  exit 1
fi
[[ -f "$tmp/failure-execution/pytest.log" ]]
grep -Fq '[lmcache-debug] test logs copied to execution host:' "$tmp/failure.out"
echo 'lmcache unittest pipeline contract passed'
