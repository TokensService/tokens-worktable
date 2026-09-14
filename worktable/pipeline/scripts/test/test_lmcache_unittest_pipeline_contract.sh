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
if [[ "${3:-}" == image && "${4:-}" == rm ]]; then exit 0; fi
case "${3:-}" in image) exit 1;; pull|run|exec|rm) exit 0;; esac
EOF
cat >"$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >>"$FAKE_LOG"
if [[ "${GIT_CONFIG_COUNT:-}" == 1 && "${GIT_CONFIG_KEY_0:-}" == 'http.extraHeader' && -n "${GIT_CONFIG_VALUE_0:-}" ]]; then
  printf '%s\n' 'git auth header configured' >>"$FAKE_LOG"
fi
mkdir -p "${@: -1}/lmcache"
EOF
chmod +x "$tmp/bin/nerdctl" "$tmp/bin/git"
pull_output="$(env PATH="$tmp/bin:$PATH" FAKE_LOG="$log" LMCACHE_UNITTEST_RUN_DIR="$tmp/default" LMCACHE_UNITTEST_REMOVE_IMAGE=1 \
  bash "$root/lmcache-unittest-pull-image.sh")"
grep -Fq 'pull lmcache-vllm-openai-0.5.4-unitest:latest' "$log"
[[ ! -e "$tmp/default/state.env" ]]
pull_run_dir="$(awk -F= '$1 == "LMCACHE_UNITTEST_RUN_DIR" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_image="$(awk -F= '$1 == "LMCACHE_UNITTEST_IMAGE" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_container="$(awk -F= '$1 == "LMCACHE_UNITTEST_CONTAINER" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_isolate_blocks_first="$(awk -F= '$1 == "LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_log_dir="$(awk -F= '$1 == "LMCACHE_UNITTEST_LOG_DIR" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_http_proxy="$(awk -F= '$1 == "LMCACHE_UNITTEST_HTTP_PROXY" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
pull_remove_image="$(awk -F= '$1 == "LMCACHE_UNITTEST_REMOVE_IMAGE" { print substr($0, index($0, "=") + 1) }' <<<"$pull_output")"
[[ "$pull_run_dir" == "$tmp/default" ]]
[[ "$pull_image" == 'lmcache-vllm-openai-0.5.4-unitest:latest' ]]
[[ "$pull_isolate_blocks_first" == 1 ]]
[[ -n "$pull_container" ]]
[[ "$pull_http_proxy" == 'http://127.0.0.1:8889' ]]
[[ "$pull_remove_image" == 1 ]]

rebuild_output="$(env PATH="$tmp/bin:$PATH" FAKE_LOG="$log" \
  LMCACHE_UNITTEST_RUN_DIR="$pull_run_dir" \
  LMCACHE_UNITTEST_IMAGE="$pull_image" \
  LMCACHE_UNITTEST_CONTAINER="$pull_container" \
  LMCACHE_UNITTEST_CAP_ADD='SYS_NICE' \
  LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST="$pull_isolate_blocks_first" \
  LMCACHE_UNITTEST_LOG_DIR="$pull_log_dir" \
  LMCACHE_UNITTEST_HTTP_PROXY="$pull_http_proxy" \
  LMCACHE_UNITTEST_REMOVE_IMAGE="$pull_remove_image" \
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

test_output="$(env PATH="$tmp/bin:$PATH" FAKE_LOG="$log" \
  LMCACHE_UNITTEST_RUN_DIR="$pull_run_dir" \
  LMCACHE_UNITTEST_IMAGE="$pull_image" \
  LMCACHE_UNITTEST_CONTAINER="$rebuild_container" \
  LMCACHE_UNITTEST_CAP_ADD='SYS_NICE' \
  LMCACHE_UNITTEST_ISOLATE_BLOCKS_FIRST="$pull_isolate_blocks_first" \
  LMCACHE_UNITTEST_LOG_DIR="$rebuild_log_dir" \
  LMCACHE_UNITTEST_HTTP_PROXY="$rebuild_http_proxy" \
  LMCACHE_UNITTEST_REMOVE_IMAGE="$rebuild_remove_image" \
  bash "$root/lmcache-unittest-run-tests.sh")"
grep -Fq -- '--net=host --gpus all --cap-add SYS_NICE -v /dev/shm:/dev/shm' "$log"
# 认证 clone 的命令主体也必须作为 nerdctl exec 的容器内脚本下发；
# token 只走 stdin，因而不能出现在 nerdctl 参数记录中。
grep -Fq -- 'git -c "http.extraHeader=Authorization: Basic $git_auth_b64" clone' "$log"
grep -Fq -- 'http_proxy=http://127.0.0.1:8889' "$log"
grep -Fq -- 'image rm lmcache-vllm-openai-0.5.4-unitest:latest' "$log"
if grep -Fq 'git https://gitcode.com/TokensService/LMCache.git' "$log"; then exit 1; fi
if grep -Fq 'secret-token' "$log"; then exit 1; fi
grep -Fq -- 'BUILD_WITH_CUDA=1' "$log"
grep -Fq -- 'http_proxy=http://127.0.0.1:8889' "$log"
grep -Fq -- 'test_mp_gather_scatter_roundtrip' "$log"
grep -Fq -- '--deselect "$1"' "$log"
grep -Fq -- 'pytest -q -ra' "$log"
[[ ! -e "$tmp/default/state.env" ]]
grep -Fq 'LMCACHE_UNITTEST_TEST_RESULT=0' <<<"$test_output"
grep -Fq 'LMCACHE_UNITTEST_IMAGE_REMOVED=1' <<<"$test_output"
echo 'lmcache unittest pipeline contract passed'
