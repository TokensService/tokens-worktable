#!/usr/bin/env bash
# 输出指定 open-xds 分支 model_arch JSON 中的全部 arch_name，每行一个。
# 用法：list_open_xds_archs.sh [branch]
# 可覆盖：OPEN_XDS_REPO、OPEN_XDS_BRANCH、OPEN_XDS_ARCH_PATH、GITHUB_API_URL、
#          GITHUB_TOKEN、GITHUB_PROXY。
set -euo pipefail

branch=${1:-${OPEN_XDS_BRANCH:-main}}
OPEN_XDS_REPO=${OPEN_XDS_REPO:-TokensService/open-xds}
OPEN_XDS_ARCH_PATH=${OPEN_XDS_ARCH_PATH:-deploy/xds/A3/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json}
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

if ! response=$(curl "${curl_args[@]}" --get \
  --data-urlencode "ref=${branch}" \
  "${GITHUB_API_URL%/}/repos/${OPEN_XDS_REPO}/contents/${OPEN_XDS_ARCH_PATH}"); then
  echo "cannot read architecture file for branch ${branch}; set GITHUB_TOKEN for this private repository" >&2
  exit 1
fi

python3 -c '
import base64
import json
import sys

response = json.load(sys.stdin)
if not isinstance(response, dict) or "content" not in response:
    message = response.get("message", "missing content") if isinstance(response, dict) else "invalid response"
    raise SystemExit(f"GitHub Contents API did not return the architecture file: {message}")

try:
    architectures = json.loads(base64.b64decode(response["content"]).decode("utf-8"))
except (KeyError, TypeError, ValueError, UnicodeDecodeError) as error:
    raise SystemExit(f"invalid architecture JSON: {error}")

if not isinstance(architectures, list):
    raise SystemExit("architecture JSON root must be an array")
for index, architecture in enumerate(architectures):
    name = architecture.get("arch_name") if isinstance(architecture, dict) else None
    if not isinstance(name, str) or not name:
        raise SystemExit(f"architecture entry {index} has no arch_name")
    print(name)
' <<< "${response}"
