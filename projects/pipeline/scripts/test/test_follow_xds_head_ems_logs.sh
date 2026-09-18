#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin" "$work_dir/fixtures/prefill/nested" "$work_dir/fixtures/decode"
printf 'prefill ems log\n' >"$work_dir/fixtures/prefill/nested/p.log"
printf 'decode ems log\n' >"$work_dir/fixtures/decode/d.log"

cat >"$work_dir/bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'get namespace test-ns' ]]; then
  count=0
  [[ ! -f "$NAMESPACE_COUNT" ]] || count="$(cat "$NAMESPACE_COUNT")"
  count=$((count + 1))
  printf '%s' "$count" >"$NAMESPACE_COUNT"
  ((count <= 2))
  exit
fi
if [[ "$*" == *'get pod -l ray.io/node-type=head'* ]]; then
  printf 'head-pod'
  exit 0
fi
if [[ "$*" == *'logs -f head-pod -c ray-head --timestamps'* ]]; then
  printf 'head log\n'
  exit 0
fi
if [[ "$*" == *'get pods -o json'* ]]; then
  cat <<'JSON'
{"items":[
  {"metadata":{"name":"prefill-pod","labels":{"ray.io/group":"prefill-1"}},"spec":{"containers":[{"name":"ray-worker"},{"name":"lmcache-sidecar"}]}},
  {"metadata":{"name":"decode-pod","labels":{"ray.io/group":"decode-1"}},"spec":{"containers":[{"name":"ray-worker"}]}},
  {"metadata":{"name":"ctrl-pod","labels":{"ray.io/group":"ctrlGroup"}},"spec":{"containers":[{"name":"ray-worker"}]}}
]}
JSON
  exit 0
fi
if [[ "$*" == *'exec prefill-pod -c ray-worker -- tar -C /opt/cloud/logs/ems -cf - .'* ]]; then
  tar -C "$EMS_FIXTURES/prefill" -cf - .
  exit 0
fi
if [[ "$*" == *'exec decode-pod -c ray-worker -- tar -C /opt/cloud/logs/ems -cf - .'* ]]; then
  tar -C "$EMS_FIXTURES/decode" -cf - .
  exit 0
fi
echo "unexpected kubectl invocation: $*" >&2
exit 2
SH
cat >"$work_dir/bin/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$work_dir/bin/kubectl" "$work_dir/bin/sleep"

PATH="$work_dir/bin:$PATH" \
NAMESPACE_COUNT="$work_dir/namespace-count" \
EMS_FIXTURES="$work_dir/fixtures" \
KUBECTL_BIN=kubectl \
POLL_INTERVAL_SECONDS=1 \
EMS_LOG_SYNC_INTERVAL_SECONDS=1 \
bash "$script_dir/follow-xds-head-logs.sh" test-ns "$work_dir/logs"

grep -Fxq 'prefill ems log' "$work_dir/logs/ems/prefill-pod/nested/p.log"
[[ ! -e "$work_dir/logs/ems/decode-pod" ]]
[[ ! -e "$work_dir/logs/ems/ctrl-pod" ]]
grep -Fq 'ems_pod=prefill-pod' "$work_dir/logs/metadata"
! grep -Fq 'ems_pod=decode-pod' "$work_dir/logs/metadata"

echo 'follow head and Prefill EMS logs test passed'
