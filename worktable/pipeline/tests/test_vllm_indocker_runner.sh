#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$ROOT/scripts/indocker/entrypoint.sh"
test -x "$RUNNER"
grep -Fq 'dockerd' "$RUNNER"
grep -Fq 'docker info' "$RUNNER"
grep -Fq 'docker login' "$RUNNER"
grep -Fq 'docker push' "$RUNNER"
grep -Fq 'SWR_CREDENTIALS_FILE' "$RUNNER"
grep -Fq 'push-success' "$RUNNER"
! grep -Fq 'docker save' "$RUNNER"
grep -Fq 'build.log' "$RUNNER"
grep -Fq 'BUILD_ARGS_TEXT' "$RUNNER"
test -f "$ROOT/scripts/indocker/Dockerfile"
grep -Fq 'dind' "$ROOT/scripts/indocker/Dockerfile"
echo 'PASS: indocker runner contract'
