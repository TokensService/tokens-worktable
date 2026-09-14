#!/usr/bin/env bash
# 输出 open-xds 远端的全部分支名，每行一个。
# 可覆盖：OPEN_XDS_REPO、GITHUB_API_URL、GITHUB_TOKEN、GITHUB_PROXY。
set -euo pipefail

OPEN_XDS_REPO=${OPEN_XDS_REPO:-TokensService/open-xds}
GITHUB_API_URL=${GITHUB_API_URL:-https://api.github.com}
GITHUB_TOKEN=${GITHUB_TOKEN:-}
github_proxy_explicit=false
if [[ -v GITHUB_PROXY ]]; then
  github_proxy_explicit=true
else
  GITHUB_PROXY=${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}
fi

curl_args=(-fsSL -H 'Accept: application/vnd.github+json')
if [[ -n "${GITHUB_TOKEN}" ]]; then
  curl_args+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi
if [[ -n "${GITHUB_PROXY}" ]]; then
  curl_args+=(--proxy "${GITHUB_PROXY}")
elif [[ "${github_proxy_explicit}" == true ]]; then
  curl_args+=(--noproxy '*')
fi

page=1
while :; do
  if ! response=$(curl "${curl_args[@]}" --get \
    --data-urlencode 'per_page=100' \
    --data-urlencode "page=${page}" \
    "${GITHUB_API_URL%/}/repos/${OPEN_XDS_REPO}/branches"); then
    echo 'cannot read open-xds branches; set GITHUB_TOKEN for this private repository' >&2
    exit 1
  fi
  count=$(python3 -c '
import json
import sys

branches = json.load(sys.stdin)
if not isinstance(branches, list):
    message = branches.get("message", "invalid response") if isinstance(branches, dict) else "invalid response"
    raise SystemExit(f"GitHub Branches API did not return a branch list: {message}")
print(len(branches))
' <<< "${response}")
  python3 -c '
import json
import sys

for branch in json.load(sys.stdin):
    name = branch.get("name") if isinstance(branch, dict) else None
    if not isinstance(name, str) or not name:
        raise SystemExit("GitHub Branches API returned a branch without name")
    print(name)
' <<< "${response}"
  [[ "${count}" -lt 100 ]] && break
  ((page += 1))
done
