#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/print-env.sh"

output="$(PIPELINE_VISIBLE_VALUE=ok PIPELINE_API_KEY=top-secret bash "$script")"
grep -Fxq 'PIPELINE_VISIBLE_VALUE=ok' <<<"$output"
grep -Fxq 'PIPELINE_API_KEY=<redacted>' <<<"$output"
if grep -Fq 'top-secret' <<<"$output"; then
  echo 'secret leaked while SHOW_SECRETS is disabled' >&2
  exit 1
fi

output="$(SHOW_SECRETS=1 PIPELINE_API_KEY=top-secret bash "$script")"
grep -Fxq 'PIPELINE_API_KEY=top-secret' <<<"$output"

if SHOW_SECRETS=bad bash "$script" >/dev/null 2>&1; then
  echo 'invalid SHOW_SECRETS unexpectedly succeeded' >&2
  exit 1
fi


contract_file="$(mktemp)"
trap '[[ ! -e "$contract_file" ]] || unlink "$contract_file"' EXIT
printf 'export XDS_URL=%q\nexport SERVICE_API=%q\n' \
  'http://192.0.2.10:31465/xds/v1' 'http://192.0.2.10:31465/xds/v1' >"$contract_file"
output="$(PIPELINE_ENV_FILE="$contract_file" bash "$script")"
grep -Fxq 'XDS_URL=http://192.0.2.10:31465/xds/v1' <<<"$output"
grep -Fxq 'SERVICE_API=http://192.0.2.10:31465/xds/v1' <<<"$output"

echo 'print-env tests passed'
