#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/bin" "$work_dir/rendered"
cat >"$work_dir/rendered/resources.rendered.json" <<'JSON'
{"resources":[{"resource_id":"prefill-1","resource_type":"prefill","resource_status":"IDLE","resource_bundles":["127.0.0.1"]}]}
JSON
cat >"$work_dir/rendered/architecture.request.json" <<'JSON'
{"arch_name":"glm-5.2-nvfp4-one-node","deploy_spec_packages":[{"spec_package_name":"glm-5.2-nvfp4","deploy_specs":[]}]}
JSON
cat >"$work_dir/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    @*) cp "${arg#@}" "$CURL_PAYLOAD_FILE" ;;
  esac
done
if [[ " $* " == *" -X POST "* ]]; then
  printf '{}\n'
else
  printf '{"status":"ACTIVE"}\n'
fi
SH
chmod +x "$work_dir/bin/curl"

PATH="$work_dir/bin:$PATH" \
CURL_PAYLOAD_FILE="$work_dir/payload.json" \
RUN_DIR="$work_dir" \
RESOURCE_MANIFEST="$work_dir/rendered/resources.rendered.json" \
ARCH_REQUEST_FILE="$work_dir/rendered/architecture.request.json" \
ARCH_NAME='glm-5.2-nvfp4-one-node' \
MODEL_NAME='glm-5.2-nvfp4-one-node' \
MODEL_ENDPOINT='glm-5.2-nvfp4-one-node-serving' \
XDS_URL='http://xds.test/xds/v1' \
"$script_dir/register-model.sh" >/dev/null

actual="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["spec_package"])' "$work_dir/payload.json")"
[[ "$actual" == 'glm-5.2-nvfp4' ]] || {
  echo "expected spec_package=glm-5.2-nvfp4, got $actual" >&2
  exit 1
}

actual_path="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["local_info"]["path"])' "$work_dir/payload.json")"
[[ "$actual_path" == '/home/service/works/models_ssd/GLM-5.2-NVFP4-W4A4-MG39-BNT3/v1' ]] || {
  echo "unexpected default model path: $actual_path" >&2
  exit 1
}

actual_endpoint="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["model_endpoint"])' "$work_dir/payload.json")"
[[ "$actual_endpoint" == 'glm-5.2-nvfp4-one-node-serving' ]] || {
  echo "expected configured model_endpoint, got $actual_endpoint" >&2
  exit 1
}

echo "register model spec-package test passed"
