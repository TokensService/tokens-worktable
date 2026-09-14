#!/usr/bin/env bash
# 拉取 GIT_BRANCH 指定的 open-xds 分支，并在该 checkout 中运行 start.sh 构建镜像。
# 必填环境变量：GIT_BRANCH、DEPLOY_STRATEGY（可由 arch 或 ARCH 兼容提供）。
# 可覆盖：OPEN_XDS_GIT_URL、OPEN_XDS_DIR、GITHUB_TOKEN、GIT_PROXY。
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
op_test_root=$(cd "${script_dir}/../../.." && pwd)

GIT_BRANCH=${GIT_BRANCH:-}
DEPLOY_STRATEGY=${DEPLOY_STRATEGY:-${arch:-${ARCH:-}}}
OPEN_XDS_GIT_URL=${OPEN_XDS_GIT_URL:-https://github.com/TokensService/open-xds.git}
OPEN_XDS_DIR=${OPEN_XDS_DIR:-"${op_test_root}/.open-xds"}
GITHUB_TOKEN=${GITHUB_TOKEN:-${GH_TOKEN:-}}
GIT_PROXY=${GIT_PROXY:-${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}}

if [[ -z "${GITHUB_TOKEN}" ]] && command -v gh >/dev/null 2>&1; then
  if gh api --hostname github.com /user >/dev/null 2>&1; then
    GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)"
  fi
fi

if [[ -z "${GIT_BRANCH}" ]]; then
  echo 'GIT_BRANCH is required' >&2
  exit 2
fi
if [[ -z "${DEPLOY_STRATEGY}" ]]; then
  echo 'DEPLOY_STRATEGY or arch is required' >&2
  exit 2
fi
if [[ -z "${GITHUB_TOKEN}" ]]; then
  echo 'a GitHub token is required; set GITHUB_TOKEN or GH_TOKEN, or authenticate with gh auth login' >&2
  exit 2
fi
export GITHUB_TOKEN

GIT_ASKPASS_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/open-xds-git-askpass.XXXXXX")"
trap 'rm -f "$GIT_ASKPASS_SCRIPT"' EXIT
cat >"$GIT_ASKPASS_SCRIPT" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) printf '%s\n' "$GITHUB_TOKEN" ;;
esac
EOF
chmod 700 "$GIT_ASKPASS_SCRIPT"
export GIT_ASKPASS="$GIT_ASKPASS_SCRIPT"
export GIT_TERMINAL_PROMPT=0

# Disable credential helpers so a stale local Basic credential cannot override
# the supplied GitHub HTTPS credential.
git_args=(-c credential.helper=)
if [[ -n "${GIT_PROXY}" ]]; then
  git_args+=(-c "http.proxy=${GIT_PROXY}")
fi

if [[ -e "${OPEN_XDS_DIR}" && ! -d "${OPEN_XDS_DIR}/.git" ]]; then
  echo "OPEN_XDS_DIR is not a git checkout: ${OPEN_XDS_DIR}" >&2
  exit 2
fi

if [[ -d "${OPEN_XDS_DIR}/.git" ]]; then
  echo "[open-xds-build] fetch branch ${GIT_BRANCH}"
  git "${git_args[@]}" -C "${OPEN_XDS_DIR}" fetch --prune origin "${GIT_BRANCH}"
  if git -C "${OPEN_XDS_DIR}" show-ref --verify --quiet "refs/heads/${GIT_BRANCH}"; then
    git -C "${OPEN_XDS_DIR}" checkout "${GIT_BRANCH}"
  else
    git -C "${OPEN_XDS_DIR}" checkout -b "${GIT_BRANCH}" "origin/${GIT_BRANCH}"
  fi
  git "${git_args[@]}" -C "${OPEN_XDS_DIR}" pull --ff-only origin "${GIT_BRANCH}"
else
  echo "[open-xds-build] clone branch ${GIT_BRANCH} into ${OPEN_XDS_DIR}"
  git "${git_args[@]}" clone --branch "${GIT_BRANCH}" --single-branch \
    "${OPEN_XDS_GIT_URL}" "${OPEN_XDS_DIR}"
fi

export DEPLOY_STRATEGY
export arch="${DEPLOY_STRATEGY}"
export OPEN_XDS_BRANCH="${GIT_BRANCH}"
GITCODE_RELEASE_TOKEN=${GITCODE_RELEASE_TOKEN:-${GITCODE_TOKEN:-}}
export GITCODE_RELEASE_TOKEN

echo "[open-xds-build] branch=${GIT_BRANCH} deploy_strategy=${DEPLOY_STRATEGY} checkout=${OPEN_XDS_DIR}"
(
  cd "${OPEN_XDS_DIR}"
  bash ./start.sh
)
