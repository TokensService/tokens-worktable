#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/build_open_xds_image.sh"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/bin" "$work_dir/open-xds/.git"
cat >"$work_dir/bin/git" <<'GIT'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GIT_CALL_LOG"
for argument in "$@"; do
  [[ "$argument" == "show-ref" ]] && exit 1
done
exit 0
GIT
cat >"$work_dir/open-xds/start.sh" <<'START'
#!/usr/bin/env bash
printf 'DEPLOY_STRATEGY=%s\narch=%s\nOPEN_XDS_BRANCH=%s\n' \
  "$DEPLOY_STRATEGY" "$arch" "$OPEN_XDS_BRANCH" > "$START_ENV_LOG"
START
chmod +x "$work_dir/bin/git" "$work_dir/open-xds/start.sh"

GIT_CALL_LOG="$work_dir/git.log" \
START_ENV_LOG="$work_dir/start.env" \
PATH="$work_dir/bin:$PATH" \
GIT_BRANCH='feature/blue-build' \
DEPLOY_STRATEGY='glm-test' \
OPEN_XDS_DIR="$work_dir/open-xds" \
GIT_PROXY='http://proxy.test:8080' \
bash "$script"

grep -Fq -- '-c http.proxy=http://proxy.test:8080 -C ' "$work_dir/git.log"
grep -Fq -- 'fetch --prune origin feature/blue-build' "$work_dir/git.log"
grep -Fq -- 'checkout -b feature/blue-build origin/feature/blue-build' "$work_dir/git.log"
grep -Fq -- 'pull --ff-only origin feature/blue-build' "$work_dir/git.log"
grep -Fxq 'DEPLOY_STRATEGY=glm-test' "$work_dir/start.env"
grep -Fxq 'arch=glm-test' "$work_dir/start.env"
grep -Fxq 'OPEN_XDS_BRANCH=feature/blue-build' "$work_dir/start.env"

echo 'build_open_xds_image uses environment branch and strategy'
