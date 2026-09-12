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

echo 'print-env tests passed'
