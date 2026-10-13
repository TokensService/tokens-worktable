#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin"

cat >"$work_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl\n' >>"$TRACE_LOG"
printf '200 0.001\n'
EOF
cat >"$work_dir/bin/sleep" <<'EOF'
#!/usr/bin/env bash
printf 'sleep %s\n' "$1" >>"$TRACE_LOG"
EOF
chmod +x "$work_dir/bin/curl" "$work_dir/bin/sleep"

TRACE_LOG="$work_dir/trace.log" \
PATH="$work_dir/bin:$PATH" \
PROFILING_URL='http://127.0.0.1:31003/xds/v1' \
PROFILING_SELF_TEST=false \
PROFILING_COLLECT=false \
PROFILING_START_DELAY_SECONDS=2 \
bash "$script_dir/profiling.sh" >/dev/null

test "$(sed -n '1p' "$work_dir/trace.log")" = 'sleep 2'
test "$(sed -n '2p' "$work_dir/trace.log")" = 'curl'

if TRACE_LOG="$work_dir/invalid.log" PATH="$work_dir/bin:$PATH" \
  PROFILING_URL='http://127.0.0.1:31003/xds/v1' \
  PROFILING_SELF_TEST=false PROFILING_COLLECT=false \
  PROFILING_START_DELAY_SECONDS=-1 bash "$script_dir/profiling.sh" >/dev/null 2>&1; then
  echo 'negative profiling delay unexpectedly succeeded' >&2
  exit 1
fi

echo 'profiling start delay tests passed'
