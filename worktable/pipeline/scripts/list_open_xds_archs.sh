#!/usr/bin/env bash
# 输出 GIT_BRANCH 中 Open-XDS 架构文件的 arch_name；标准输出每行一个名称。
# 必填环境变量：GIT_BRANCH、GIT_URL、GIT_USER、GIT_PASSWORD。
set -euo pipefail

if (($# != 0)); then
  echo 'list_open_xds_archs.sh does not accept positional arguments' >&2
  exit 2
fi

for required_var in GIT_BRANCH GIT_URL GIT_USER GIT_PASSWORD; do
  if [[ -z "${!required_var:-}" ]]; then
    echo "${required_var} is required" >&2
    exit 2
  fi
done

arch_path='deploy/xds/A3/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json'
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/open-xds-archs.XXXXXX")"
askpass_file="${work_dir}/git-askpass"
cleanup() {
  rm -rf "${work_dir}"
}
trap cleanup EXIT

cat >"${askpass_file}" <<'ASKPASS'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' "${GIT_USER}" ;;
  *Password*) printf '%s\n' "${GIT_PASSWORD}" ;;
esac
ASKPASS
chmod 700 "${askpass_file}"

export GIT_ASKPASS="${askpass_file}"
export GIT_TERMINAL_PROMPT=0
# Do not let a host-level credential helper override the supplied environment
# credentials. --quiet keeps successful Git operations out of stdout.
git -c credential.helper= clone --quiet --depth 1 --branch "${GIT_BRANCH}" \
  --single-branch "${GIT_URL}" "${work_dir}/repo"

arch_file="${work_dir}/repo/${arch_path}"
if [[ ! -f "${arch_file}" ]]; then
  echo "architecture file not found in branch ${GIT_BRANCH}: ${arch_path}" >&2
  exit 1
fi

python3 - "${arch_file}" <<'PY'
import json
from pathlib import Path
import sys

try:
    catalog = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"invalid architecture JSON: {error}")

architectures = catalog if isinstance(catalog, list) else catalog.get("architectures") if isinstance(catalog, dict) else None
if not isinstance(architectures, list):
    raise SystemExit("architecture JSON root must be an array")

for index, architecture in enumerate(architectures):
    name = architecture.get("arch_name") if isinstance(architecture, dict) else None
    if not isinstance(name, str) or not name:
        raise SystemExit(f"architecture entry {index} has no arch_name")
    print(name)
PY
