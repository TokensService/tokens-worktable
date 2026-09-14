#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/source/deploy/xds/A3/xds_template/cap/model_arch"
git -C "$WORK/source" init -q
git -C "$WORK/source" config user.email 'test@example.invalid'
git -C "$WORK/source" config user.name test
cat >"$WORK/source/deploy/xds/A3/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json" <<'JSON'
[{"arch_name":"prefill-one"},{"arch_name":"decode-two"}]
JSON
git -C "$WORK/source" add .
git -C "$WORK/source" commit -qm initial
git -C "$WORK/source" branch -M arch-test

GIT_BRANCH=arch-test \
GIT_URL="file://$WORK/source" \
GIT_USER=test-user \
GIT_PASSWORD=test-password \
bash "$ROOT/list_open_xds_archs.sh" >"$WORK/output"
printf 'prefill-one\ndecode-two\n' >"$WORK/expected"
cmp "$WORK/expected" "$WORK/output"

if GIT_BRANCH=arch-test GIT_URL="file://$WORK/source" GIT_USER=test-user \
  bash "$ROOT/list_open_xds_archs.sh" >"$WORK/missing.out" 2>"$WORK/missing.err"; then
  echo 'missing GIT_PASSWORD must fail' >&2
  exit 1
fi
test ! -s "$WORK/missing.out"
grep -Fq 'GIT_PASSWORD is required' "$WORK/missing.err"

echo 'PASS: Open-XDS arch listing uses Git environment credentials and prints only names'
