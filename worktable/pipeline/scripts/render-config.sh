#!/usr/bin/env bash
# Render one immutable deployment contract from extracted XDS templates.
# The pipeline forwards every KEY=VALUE line below to later stages.
set -euo pipefail

ARCH_NAME="${ARCH_NAME:-default}"
RUN_DIR="${RUN_DIR:-/tmp/op-test-pipeline-$(date +%Y%m%d_%H%M%S)}"
RENDER_DIR="${RENDER_DIR:-${RUN_DIR}/rendered}"
CHART_TEMPLATE_DIR="${CHART_TEMPLATE_DIR:-$RUN_DIR/template/xds-cluster}"
VALUES_TEMPLATE="${VALUES_TEMPLATE:-$RUN_DIR/template/values-16Node-je-cpp-bnt3.yaml}"
ARCH_FILE="${ARCH_FILE:-$RUN_DIR/template/model_arch-lt-je-cpp-bnt3.json}"
DEPLOY_IMAGE="${DEPLOY_IMAGE:-${IMAGE_NAME:-myapp}:${IMAGE_TAG:-latest}}"
NUM_PREFILL="${NUM_PREFILL:-1}"
NUM_DECODE="${NUM_DECODE:-1}"
PREFILL_GPU="${PREFILL_GPU:-4}"
DECODE_GPU="${DECODE_GPU:-4}"
NAMESPACE="${NAMESPACE:-xds-${ARCH_NAME}-${IMAGE_TAG:-local}}"
RELEASE_NAME="${RELEASE_NAME:-$NAMESPACE}"
PREFILL_OVERRIDES_JSON="${PREFILL_OVERRIDES_JSON:-}"
DECODE_OVERRIDES_JSON="${DECODE_OVERRIDES_JSON:-}"
REPLACE_MAP_JSON="${REPLACE_MAP_JSON:-}"
EQUAL_REPLACE_JSON="${EQUAL_REPLACE_JSON:-}"
YAML_REPLACE_JSON="${YAML_REPLACE_JSON:-}"
TEMPLATE_VARS_JSON="${TEMPLATE_VARS_JSON:-}"
MOCK_DB="${MOCK_DB:-false}"
TARGET_HOSTS="${TARGET_HOSTS:-[]}"
NODE_SELECTOR_KEY="xds.optest"

[[ -n "$PREFILL_OVERRIDES_JSON" ]] || PREFILL_OVERRIDES_JSON='{}'
[[ -n "$DECODE_OVERRIDES_JSON" ]] || DECODE_OVERRIDES_JSON='{}'
[[ -n "$REPLACE_MAP_JSON" ]] || REPLACE_MAP_JSON='{}'
[[ -n "$EQUAL_REPLACE_JSON" ]] || EQUAL_REPLACE_JSON='{}'
[[ -n "$YAML_REPLACE_JSON" ]] || YAML_REPLACE_JSON='{}'
[[ -n "$TEMPLATE_VARS_JSON" ]] || TEMPLATE_VARS_JSON='{}'

for value in "$NUM_PREFILL" "$NUM_DECODE" "$PREFILL_GPU" "$DECODE_GPU"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "invalid positive integer: $value" >&2; exit 2; }
done
[[ -f "$VALUES_TEMPLATE" ]] || { echo "values template not found: $VALUES_TEMPLATE" >&2; exit 2; }
[[ -f "$ARCH_FILE" ]] || { echo "architecture file not found: $ARCH_FILE" >&2; exit 2; }
[[ -f "$CHART_TEMPLATE_DIR/Chart.yaml" ]] || { echo "chart template not found: $CHART_TEMPLATE_DIR" >&2; exit 2; }

CHART_DIR="$RENDER_DIR/xds-cluster"
VALUES_FILE="$RENDER_DIR/values.rendered.yaml"
ARCH_REQUEST_FILE="$RENDER_DIR/architecture.request.json"
RESOURCE_MANIFEST="$RENDER_DIR/resources.rendered.json"
NODE_LABELS_FILE="$RENDER_DIR/node-labels.json"
mkdir -p "$RENDER_DIR"
rm -rf "$CHART_DIR"
cp -a "$CHART_TEMPLATE_DIR" "$CHART_DIR"

python3 - "$VALUES_TEMPLATE" "$ARCH_FILE" "$ARCH_NAME" "$VALUES_FILE" \
  "$ARCH_REQUEST_FILE" "$RESOURCE_MANIFEST" "$DEPLOY_IMAGE" "$NUM_PREFILL" \
  "$NUM_DECODE" "$PREFILL_GPU" "$DECODE_GPU" "$NAMESPACE" \
  "$PREFILL_OVERRIDES_JSON" "$DECODE_OVERRIDES_JSON" "$REPLACE_MAP_JSON" \
  "$EQUAL_REPLACE_JSON" "$YAML_REPLACE_JSON" "$MOCK_DB" \
  "$NODE_SELECTOR_KEY" "$TARGET_HOSTS" "$NODE_LABELS_FILE" "$TEMPLATE_VARS_JSON" <<'PY'
import copy
import json
import re
import sys

import yaml

(values_template, arch_file, arch_name, values_file, arch_request_file,
 resource_manifest_file, deploy_image, num_prefill, num_decode,
 prefill_gpu, decode_gpu, namespace, prefill_overrides, decode_overrides,
 replace_map, equal_replace_map, yaml_replace_map, mock_db,
 node_selector_key, target_hosts_json, node_labels_file, template_vars_json) = sys.argv[1:]

num_prefill = int(num_prefill)
num_decode = int(num_decode)
prefill_gpu = int(prefill_gpu)
decode_gpu = int(decode_gpu)
def load_json(name, value):
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise SystemExit(f"invalid {name}: {error}")
    if not isinstance(parsed, dict):
        raise SystemExit(f"{name} must be a JSON object")
    return parsed

prefill_overrides = load_json("PREFILL_OVERRIDES_JSON", prefill_overrides)
decode_overrides = load_json("DECODE_OVERRIDES_JSON", decode_overrides)
replace_map = load_json("REPLACE_MAP_JSON", replace_map)
equal_replace_map = load_json("EQUAL_REPLACE_JSON", equal_replace_map)
yaml_replace_map = load_json("YAML_REPLACE_JSON", yaml_replace_map)
template_vars = load_json("TEMPLATE_VARS_JSON", template_vars_json)

try:
    target_hosts = json.loads(target_hosts_json)
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid TARGET_HOSTS: {error}")
if not isinstance(target_hosts, list) or not target_hosts:
    raise SystemExit("TARGET_HOSTS must be a non-empty JSON array")
target_ips = []
for host in target_hosts:
    if not isinstance(host, dict) or not isinstance(host.get("ip"), str) or not host["ip"]:
        raise SystemExit("every TARGET_HOSTS entry must contain a non-empty ip")
    target_ips.append(host["ip"])

def selector_fragment(ip):
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", ip):
        return ip.rsplit(".", 1)[1]
    return re.sub(r"[^a-zA-Z0-9]+", "-", ip).strip("-")

node_selector_value = "node-" + "-".join(selector_fragment(ip) for ip in target_ips)

def upsert_container_env(name, value):
    common = values.setdefault("common", {})
    container_env = common.setdefault("containerEnv", [])
    if not isinstance(container_env, list):
        raise SystemExit("common.containerEnv must be a list")
    for item in container_env:
        if isinstance(item, dict) and item.get("name") == name:
            item["value"] = value
            item.pop("valueFrom", None)
            return
    container_env.append({"name": name, "value": value})

def deep_merge(base, update):
    result = copy.deepcopy(base)
    for key, value in update.items():
        if isinstance(result.get(key), dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result

with open(arch_file, encoding="utf-8") as source:
    catalog = json.load(source)
architectures = catalog if isinstance(catalog, list) else catalog.get("architectures", [])
matches = [arch for arch in architectures if arch.get("arch_name") == arch_name]
if len(matches) != 1:
    raise SystemExit(f"arch_name not found or not unique: {arch_name}")
arch = copy.deepcopy(matches[0])

groups = []
resources = []
bundle_index = 1
for package in arch.get("deploy_spec_packages", []):
    for spec_index, spec in enumerate(package.get("deploy_specs", [])):
        role = spec.get("role")
        if role not in ("prefill", "decode"):
            continue
        replicas = num_prefill if role == "prefill" else num_decode
        gpu = prefill_gpu if role == "prefill" else decode_gpu
        overrides = prefill_overrides if role == "prefill" else decode_overrides
        spec["min"] = spec["max"] = spec["default"] = replicas
        spec = deep_merge(spec, overrides)
        spec["resources"][0]["gpu"] = gpu
        if role == "decode":
            spec.setdefault("params", {})["data_parallel_size"] = gpu
        package["deploy_specs"][spec_index] = spec
        for index in range(1, replicas + 1):
            group_name = f"taskExecutorGroup{gpu}{role}{index}"
            groups.append({
                "name": group_name,
                "replicas": 1,
                "nodeSelector": {node_selector_key: node_selector_value},
                "resources": json.dumps({"GPU-BNT3-POD": gpu, "XDS-TE": gpu, role: 1}),
                "containerEnvOverrides": {},
                "portsOverrides": {"metrics": 33200 + len(groups)},
                "rayStartParamsPorts": {
                    "num-gpus": gpu,
                    "dashboard-agent-listen-port": 33300 + len(groups),
                },
                "containerResources": {
                    "limits": {"cpu": str(spec["resources"][0].get("cpu", 0)), "nvidia.com/gpu": gpu, "memory": spec["resources"][0].get("memory", "0G"), "hugepages-2Mi": "0"},
                    "requests": {"cpu": str(spec["resources"][0].get("cpu", 0)), "nvidia.com/gpu": gpu, "memory": spec["resources"][0].get("memory", "0G"), "hugepages-2Mi": "0"},
                },
            })
            resources.append({
                "resource_id": f"{arch_name}-{role}-{index}",
                "role": role,
                "resource_type": role,
                "resource_status": "IDLE",
                "resource_bundles": [f"127.0.0.{bundle_index}"],
                "task_executor_group": group_name,
                "gpu": gpu,
            })
            bundle_index += 1

if not groups:
    raise SystemExit(f"no prefill/decode specs found in {arch_name}")

with open(values_template, encoding="utf-8") as source:
    values_text = source.read().replace("{IMAGE_TAG}", deploy_image.rsplit(":", 1)[-1])
template_vars.setdefault("IMAGE_TAG", deploy_image.rsplit(":", 1)[-1])
template_vars.setdefault("DEPLOY_NAMESPACE", namespace)
placeholder_pattern = re.compile(r"(?<!\$)\{([A-Z][A-Z0-9_]*)\}")
unresolved = sorted({match.group(1) for match in placeholder_pattern.finditer(values_text)
                     if match.group(1) not in template_vars})
if unresolved:
    raise SystemExit("unresolved template placeholders: " + ", ".join(unresolved))
for key, value in template_vars.items():
    values_text = values_text.replace("{" + key + "}", str(value))
for key, value in replace_map.items():
    if value:
        values_text = values_text.replace(str(key), str(value))
for key, value in equal_replace_map.items():
    values_text = re.sub(re.escape(str(key)) + r" =.*", f"{key} = {value}", values_text)
if str(mock_db).lower() == "true":
    if "mock_db" in values_text:
        values_text = re.sub(r"mock_db =.*", "mock_db = true", values_text)
values = yaml.safe_load(values_text) or {}
values["taskExecutorGroups"] = groups
values["global"] = deep_merge(values.get("global", {}), {
    "namespace": namespace,
    "enableTaskExecutorGroups": True,
})
values = deep_merge(values, yaml_replace_map)
# Target placement is derived only from TARGET_HOSTS and must not be overridden.
values["nodeSelector"] = {node_selector_key: node_selector_value}
upsert_container_env("XDS_TE_POD_LABEL_KEY", node_selector_key)
upsert_container_env("XDS_TE_POD_LABEL_VAL", node_selector_value)
with open(values_file, "w", encoding="utf-8") as output:
    yaml.safe_dump(values, output, allow_unicode=True, sort_keys=False)
with open(arch_request_file, "w", encoding="utf-8") as output:
    json.dump(arch, output, ensure_ascii=False, indent=2)
    output.write("\n")
with open(resource_manifest_file, "w", encoding="utf-8") as output:
    json.dump({"arch_name": arch_name, "resources": resources}, output, ensure_ascii=False, indent=2)
    output.write("\n")
with open(node_labels_file, "w", encoding="utf-8") as output:
    json.dump({
        "key": node_selector_key,
        "value": node_selector_value,
        "hosts": [{"ip": ip} for ip in target_ips],
    }, output, ensure_ascii=False, indent=2)
    output.write("\n")
PY

printf 'RUN_DIR=%s\n' "$RUN_DIR"
printf 'RENDER_DIR=%s\n' "$RENDER_DIR"
printf 'CHART_DIR=%s\n' "$CHART_DIR"
printf 'VALUES_FILE=%s\n' "$VALUES_FILE"
printf 'ARCH_FILE=%s\n' "$ARCH_FILE"
printf 'ARCH_NAME=%s\n' "$ARCH_NAME"
printf 'ARCH_REQUEST_FILE=%s\n' "$ARCH_REQUEST_FILE"
printf 'RESOURCE_MANIFEST=%s\n' "$RESOURCE_MANIFEST"
printf 'NODE_LABELS_FILE=%s\n' "$NODE_LABELS_FILE"
printf 'DEPLOY_IMAGE=%s\n' "$DEPLOY_IMAGE"
printf 'NAMESPACE=%s\n' "$NAMESPACE"
printf 'RELEASE_NAME=%s\n' "$RELEASE_NAME"
