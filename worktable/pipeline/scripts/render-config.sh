#!/usr/bin/env bash
# Render one immutable deployment contract from extracted XDS templates.
# The pipeline forwards every KEY=VALUE line below to later stages.
set -euo pipefail

normalize_kubernetes_name() {
  local value="$1" max_length="$2"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/-+/-/g; s/^-+//; s/-+$//')"
  value="${value:0:max_length}"
  value="${value%-}"
  [[ -n "$value" ]] || { echo "cannot derive a Kubernetes name from: $1" >&2; return 2; }
  printf '%s' "$value"
}

# 架构名优先使用流水线 arch_name，其次 DEPLOY_STRATEGY；兼容旧 ARCH_NAME。
ARCH_NAME="${arch_name:-${DEPLOY_STRATEGY:-${ARCH_NAME:-default}}}"
RUN_DIR="${RUN_DIR:-/tmp/op-test-pipeline-$(date +%Y%m%d_%H%M%S)}"
RENDER_DIR="${RENDER_DIR:-${RUN_DIR}/rendered}"
CHART_TEMPLATE_DIR="${CHART_TEMPLATE_DIR:-$RUN_DIR/template/xds-cluster}"
VALUES_TEMPLATE="${VALUES_TEMPLATE:-$RUN_DIR/template/values-16Node-je-cpp-bnt3.yaml}"
ARCH_FILE="${ARCH_FILE:-$RUN_DIR/template/model_arch-lt-je-cpp-bnt3.json}"
DEPLOY_IMAGE="${DEPLOY_IMAGE:-${IMAGE_NAME:-myapp}:${IMAGE_TAG:-latest}}"
IMAGE_PULL_SECRETS="${IMAGE_PULL_SECRETS:-${IMAGE_PULL_SECRET:-default-secret,swr-cn-southwest-2}}"
NUM_PREFILL="${NUM_PREFILL:-}"
NUM_DECODE="${NUM_DECODE:-}"
PREFILL_GPU="${PREFILL_GPU:-}"
DECODE_GPU="${DECODE_GPU:-}"
NAMESPACE="${NAMESPACE:-xds-${ARCH_NAME}-${IMAGE_TAG:-local}}"
RELEASE_NAME="${RELEASE_NAME:-$NAMESPACE}"
NAMESPACE="$(normalize_kubernetes_name "$NAMESPACE" 63)"
RELEASE_NAME="$(normalize_kubernetes_name "$RELEASE_NAME" 53)"
PREFILL_OVERRIDES_JSON="${PREFILL_OVERRIDES_JSON:-}"
DECODE_OVERRIDES_JSON="${DECODE_OVERRIDES_JSON:-}"
REPLACE_MAP_JSON="${REPLACE_MAP_JSON:-}"
EQUAL_REPLACE_JSON="${EQUAL_REPLACE_JSON:-}"
YAML_REPLACE_JSON="${YAML_REPLACE_JSON:-}"
TEMPLATE_VARS_JSON="${TEMPLATE_VARS_JSON:-}"
EMS_NAMESPACE="${ems_namespace:-${EMS_NAMESPACE:-}}"
NODE_PORT_MAP="${NODE_PORT_MAP:-{\"192.168.31.59\":31000,\"192.168.31.125\":31001,\"192.168.31.18\":31002,\"192.168.31.127\":31003,\"192.168.31.190\":31004,\"192.168.31.104\":31005,\"192.168.31.197\":31007,\"192.168.31.175\":31008,\"192.168.31.17\":31009,\"192.168.31.238\":31010,\"192.168.31.163\":31011,\"192.168.31.70\":31012,\"192.168.31.214\":31013,\"192.168.31.111\":31014,\"192.168.31.65\":31015,\"192.168.31.96\":31016,\"192.168.31.105\":31017,\"192.168.31.89\":31018}}"
MOCK_DB="${MOCK_DB:-true}"
TARGET_HOSTS="${TARGET_HOSTS:-[]}"
TARGET_NODE_IP_MAP="${TARGET_NODE_IP_MAP:-}"
[[ -n "$TARGET_NODE_IP_MAP" ]] || TARGET_NODE_IP_MAP='{}'
NODE_SELECTOR_KEY="xds.optest"

[[ -n "$PREFILL_OVERRIDES_JSON" ]] || PREFILL_OVERRIDES_JSON='{}'
[[ -n "$DECODE_OVERRIDES_JSON" ]] || DECODE_OVERRIDES_JSON='{}'
[[ -n "$REPLACE_MAP_JSON" ]] || REPLACE_MAP_JSON='{}'
[[ -n "$EQUAL_REPLACE_JSON" ]] || EQUAL_REPLACE_JSON='{}'
[[ -n "$YAML_REPLACE_JSON" ]] || YAML_REPLACE_JSON='{}'
[[ -n "$TEMPLATE_VARS_JSON" ]] || TEMPLATE_VARS_JSON='{}'

for value in "$NUM_PREFILL" "$NUM_DECODE" "$PREFILL_GPU" "$DECODE_GPU"; do
  [[ -z "$value" ]] && continue
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
  "$NODE_SELECTOR_KEY" "$TARGET_HOSTS" "$TARGET_NODE_IP_MAP" "$NODE_LABELS_FILE" "$TEMPLATE_VARS_JSON" "$EMS_NAMESPACE" "$NODE_PORT_MAP" \
  "$CHART_DIR" "$IMAGE_PULL_SECRETS" <<'PY'
import copy
import json
from pathlib import Path
import re
import sys

import yaml

(values_template, arch_file, arch_name, values_file, arch_request_file,
 resource_manifest_file, deploy_image, num_prefill, num_decode,
 prefill_gpu, decode_gpu, namespace, prefill_overrides, decode_overrides,
 replace_map, equal_replace_map, yaml_replace_map, mock_db,
 node_selector_key, target_hosts_json, target_node_ip_map_json, node_labels_file, template_vars_json, ems_namespace, node_port_map_json,
 chart_dir, image_pull_secrets_text) = sys.argv[1:]

num_prefill = int(num_prefill) if num_prefill else None
num_decode = int(num_decode) if num_decode else None
prefill_gpu = int(prefill_gpu) if prefill_gpu else None
decode_gpu = int(decode_gpu) if decode_gpu else None
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

image_pull_secrets = []
for secret_name in image_pull_secrets_text.split(","):
    secret_name = secret_name.strip()
    if not secret_name:
        continue
    if not re.fullmatch(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?", secret_name):
        raise SystemExit(f"invalid image pull secret name: {secret_name}")
    if secret_name not in [item["name"] for item in image_pull_secrets]:
        image_pull_secrets.append({"name": secret_name})
if not image_pull_secrets:
    raise SystemExit("IMAGE_PULL_SECRETS must contain at least one secret name")

try:
    target_hosts = json.loads(target_hosts_json)
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid TARGET_HOSTS: {error}")
if not isinstance(target_hosts, list) or not target_hosts:
    raise SystemExit("TARGET_HOSTS must be a non-empty JSON array")
try:
    target_node_ip_map = json.loads(target_node_ip_map_json)
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid TARGET_NODE_IP_MAP: {error}")
if not isinstance(target_node_ip_map, dict):
    raise SystemExit("TARGET_NODE_IP_MAP must be a JSON object")
try:
    node_port_map = json.loads(node_port_map_json)
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid NODE_PORT_MAP: {error}")
if not isinstance(node_port_map, dict):
    raise SystemExit("NODE_PORT_MAP must be a JSON object")
for ip, port in node_port_map.items():
    if not isinstance(ip, str) or not re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", ip) or type(port) is not int or not 30000 <= port <= 32767:
        raise SystemExit("NODE_PORT_MAP entries must map an IPv4 address to a NodePort in 30000-32767")
target_ips = []
for host in target_hosts:
    if not isinstance(host, dict) or not isinstance(host.get("ip"), str) or not host["ip"]:
        raise SystemExit("every TARGET_HOSTS entry must contain a non-empty ip")
    endpoint = host["ip"]
    mapped_ip = target_node_ip_map.get(endpoint)
    if target_node_ip_map and not isinstance(mapped_ip, str):
        raise SystemExit(f"TARGET_NODE_IP_MAP is missing target endpoint: {endpoint}")
    if mapped_ip is not None and (not isinstance(mapped_ip, str) or not mapped_ip):
        raise SystemExit(f"TARGET_NODE_IP_MAP value must be a non-empty IP for target endpoint: {endpoint}")
    endpoint_match = re.fullmatch(r"([^:]+):(\d+)", endpoint)
    if endpoint_match:
        address, port = endpoint_match.groups()
        if not 1 <= int(port) <= 65535:
            raise SystemExit(f"invalid TARGET_HOSTS port: {endpoint}")
        target_ips.append(mapped_ip if mapped_ip is not None else address)
    else:
        target_ips.append(mapped_ip if mapped_ip is not None else endpoint)

def selector_fragment(ip):
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", ip):
        return ip.rsplit(".", 1)[1]
    return re.sub(r"[^a-zA-Z0-9]+", "-", ip).strip("-")

node_selector_value = "node-" + "-".join(selector_fragment(ip) for ip in target_ips)
target_node_port = node_port_map.get(target_ips[0])

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

def remove_container_env(name):
    common = values.get("common")
    if not isinstance(common, dict) or not isinstance(common.get("containerEnv"), list):
        return
    common["containerEnv"] = [
        item for item in common["containerEnv"]
        if not isinstance(item, dict) or item.get("name") != name
    ]

def set_ems_switches(value, enabled):
    if isinstance(value, dict):
        if value.get("name") == "EMS_ENABLE":
            value["value"] = str(enabled).lower()
            value.pop("valueFrom", None)
        for key, child in value.items():
            if key.lower() == "ems" and isinstance(child, dict):
                child["enable"] = enabled
            elif key.lower() in ("ems_enable", "enable_ems"):
                value[key] = enabled
            set_ems_switches(child, enabled)
    elif isinstance(value, list):
        for child in value:
            set_ems_switches(child, enabled)

def split_image_reference(reference):
    image_path, separator, tag = reference.rpartition(":")
    if not separator or "/" not in image_path:
        raise SystemExit(f"DEPLOY_IMAGE must include a registry path and tag: {reference}")
    registry, image_name = image_path.rsplit("/", 1)
    return registry, image_path, f"{image_name}:{tag}", tag

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
use_ems = arch.get("use_ems", False)
if type(use_ems) is not bool:
    raise SystemExit(f"{arch_name}.use_ems must be a boolean when specified")

groups = []
resources = []
bundle_index = 1
for package in arch.get("deploy_spec_packages", []):
    for spec_index, spec in enumerate(package.get("deploy_specs", [])):
        role = spec.get("role")
        if role not in ("prefill", "decode"):
            continue
        replicas_override = num_prefill if role == "prefill" else num_decode
        gpu_override = prefill_gpu if role == "prefill" else decode_gpu
        overrides = prefill_overrides if role == "prefill" else decode_overrides
        spec = deep_merge(spec, overrides)
        if replicas_override is not None:
            spec["min"] = spec["max"] = spec["default"] = replicas_override
        for field in ("min", "max", "default"):
            value = spec.get(field)
            if type(value) is not int or value < 1:
                raise SystemExit(f"{role}.{field} must be a positive integer in arch")
        if not spec["min"] <= spec["default"] <= spec["max"]:
            raise SystemExit(f"{role} requires min <= default <= max")
        replicas = spec["default"]
        resource_specs = spec.get("resources", [])
        if len(resource_specs) != 1:
            raise SystemExit(f"{role} requires exactly one resources entry per TE")
        resource = resource_specs[0]
        if gpu_override is not None:
            resource["gpu"] = gpu_override
        gpu = resource.get("gpu")
        if type(gpu) is not int or gpu < 1:
            raise SystemExit(f"{role}.resources[0].gpu must be a positive integer")
        if "cpu" not in resource or "memory" not in resource:
            raise SystemExit(f"{role}.resources[0] must include cpu and memory")
        # TP/PP/DP 是模型并行策略，不可从 GPU 数擅自推导或覆盖。
        package["deploy_specs"][spec_index] = spec
        for index in range(1, replicas + 1):
            group_name = f"taskExecutorGroup{gpu}{role}{index}"
            groups.append({
                "name": group_name,
                "replicas": 1,
                "nodeSelector": {node_selector_key: node_selector_value},
                "resources": "'" + json.dumps({"GPU-BNT3-POD": gpu, "XDS-TE": gpu, role: 1}) + "'",
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

# TE pods use host networking.  Their Ray core workers therefore share one
# host port namespace and must not use the same default worker-port range.
worker_port_first = 10002
worker_port_last = 19999
worker_port_capacity = worker_port_last - worker_port_first + 1
worker_port_span = worker_port_capacity // len(groups)
if worker_port_span < 1:
    raise SystemExit(f"too many task executor groups for worker ports: {len(groups)}")
for group_index, group in enumerate(groups):
    range_start = worker_port_first + group_index * worker_port_span
    range_end = worker_port_last if group_index == len(groups) - 1 else range_start + worker_port_span - 1
    group["rayStartParamsPorts"]["min-worker-port"] = range_start
    group["rayStartParamsPorts"]["max-worker-port"] = range_end

with open(values_template, encoding="utf-8") as source:
    values_text = source.read().replace("{IMAGE_TAG}", deploy_image.rsplit(":", 1)[-1])
template_vars.setdefault("IMAGE_TAG", deploy_image.rsplit(":", 1)[-1])
template_vars.setdefault("DEPLOY_NAMESPACE", namespace)
# TE 标签由渲染器按 TARGET_HOSTS 计算，模板内联引用时直接替换为同一份值。
template_vars.setdefault("XDS_TE_POD_LABEL_KEY", node_selector_key)
template_vars.setdefault("XDS_TE_POD_LABEL_VAL", node_selector_value)
# 环境相关占位符默认值，均可被 TEMPLATE_VARS_JSON 覆盖：
# 数据库五项为 mock 参考值（MOCK_DB=true 时不真正连库）；ELB_ID 仅用于注解；
# NODE_PORT/SERVICE_PORT/COLLECTOR_GATEWAY_URL 为本环境固定配置。
template_vars.setdefault("XDS_DATABASE_HOST", "127.0.0.1")
template_vars.setdefault("XDS_DATABASE_PORT", "5432")
template_vars.setdefault("XDS_DATABASE_NAME", "xds")
template_vars.setdefault("XDS_DATABASE_USERNAME", "xds")
template_vars.setdefault("DATABASE_PASSWORD", "mock")
template_vars.setdefault("ELB_ID", "unused")
if target_node_port is not None:
    template_vars["NODE_PORT"] = str(target_node_port)
else:
    template_vars.setdefault("NODE_PORT", "31365")
template_vars.setdefault("SERVICE_PORT", "8080")
template_vars.setdefault("COLLECTOR_GATEWAY_URL", "192.168.10.6:25888")
# 新版模板包含可选 LMCache Sidecar。默认关闭以保持没有 Sidecar 的部署行为；
# 所有字段仍在 values 中填入可解析的值，启用时可由 TEMPLATE_VARS_JSON 覆盖。
template_vars.setdefault("LMCACHE_SIDECAR_ENABLED", "false")
template_vars.setdefault("LMCACHE_MP_PORT_BASE", "18000")
template_vars.setdefault("LMCACHE_HTTP_PORT_BASE", "18080")
template_vars.setdefault("LMCACHE_L1_INIT_SIZE_GB", "0")
template_vars.setdefault("LMCACHE_L1_SIZE_GB", "0")
template_vars.setdefault("LMCACHE_L1_ALIGN_BYTES", "4096")
template_vars.setdefault("LMCACHE_MAX_WORKERS", "1")
template_vars.setdefault("LMCACHE_LOG_LEVEL", "INFO")
template_vars.setdefault("LMCACHE_CPU_REQUEST", "1")
template_vars.setdefault("LMCACHE_MEMORY_REQUEST", "1Gi")
template_vars.setdefault("LMCACHE_CPU_LIMIT", "1")
template_vars.setdefault("LMCACHE_MEMORY_LIMIT", "1Gi")
placeholder_pattern = re.compile(r"(?<!\$)\{([A-Z][A-Z0-9_]*)\}")
active_values_text = "\n".join(
    line for line in values_text.splitlines() if not line.lstrip().startswith("#")
)
helm_runtime_placeholders = {"DASHBOARD_AGENT_LISTEN_PORT"}
unresolved = sorted({match.group(1) for match in placeholder_pattern.finditer(active_values_text)
                     if match.group(1) not in template_vars
                     and match.group(1) not in helm_runtime_placeholders})
if unresolved:
    raise SystemExit("unresolved template placeholders: " + ", ".join(unresolved))
for key, value in template_vars.items():
    values_text = values_text.replace("{" + key + "}", str(value))
for key, value in replace_map.items():
    if value:
        values_text = values_text.replace(str(key), str(value))
for key, value in equal_replace_map.items():
    values_text = re.sub(re.escape(str(key)) + r" =.*", f"{key} = {value}", values_text)
values = yaml.safe_load(values_text) or {}

if str(mock_db).lower() == "true":
    framework_files = values.get("frameworkConfigFiles")
    if not isinstance(framework_files, dict) or not isinstance(framework_files.get("xds_framework.conf"), str):
        raise SystemExit("frameworkConfigFiles.xds_framework.conf must be a string when MOCK_DB=true")
    framework_config = framework_files["xds_framework.conf"]
    mock_db_pattern = re.compile(r"(?m)^(\s*mock_db\s*=\s*).*$", re.IGNORECASE)
    if mock_db_pattern.search(framework_config):
        framework_files["xds_framework.conf"] = mock_db_pattern.sub(r"\g<1>true", framework_config)
    else:
        framework_files["xds_framework.conf"] = framework_config.rstrip() + "\nmock_db = true\n"

def normalize_container_env_values(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ("containerEnv", "env") and isinstance(child, list):
                for entry in child:
                    if isinstance(entry, dict) and "value" in entry and not isinstance(entry["value"], str):
                        env_value = entry["value"]
                        entry["value"] = str(env_value).lower() if isinstance(env_value, bool) else str(env_value)
            else:
                normalize_container_env_values(child)
    elif isinstance(value, list):
        for child in value:
            normalize_container_env_values(child)

normalize_container_env_values(values)
set_ems_switches(values, use_ems)
upsert_container_env("EMS_ENABLE", str(use_ems).lower())
values["taskExecutorGroups"] = groups
values.setdefault("global", {})["imagePullSecrets"] = image_pull_secrets
values["global"] = deep_merge(values.get("global", {}), {
    "namespace": namespace,
    "enableTaskExecutorGroups": True,
    "storage": {"hostPath": "/mnt/xds/sfs"},
})
values = deep_merge(values, yaml_replace_map)

# The chart substitutes this placeholder per task executor group.  Image
# templates from older builds hard-code 52365, which makes custom Ray
# dashboard-agent ports fail their Kubernetes health probes.
worker_group_templates = values.get("workerGroups")
task_executor_template = (
    worker_group_templates.get("taskExecutorGroup-card")
    if isinstance(worker_group_templates, dict) else None
)
if isinstance(task_executor_template, dict):
    ray_start_params = task_executor_template.setdefault("rayStartParams", {})
    if not isinstance(ray_start_params, dict):
        raise SystemExit("workerGroups.taskExecutorGroup-card.rayStartParams must be a mapping")
    ray_start_params.setdefault("min-worker-port", worker_port_first)
    ray_start_params.setdefault("max-worker-port", worker_port_last)
    for probe_name in ("livenessProbe", "readinessProbe", "startupProbe"):
        command = task_executor_template.get(probe_name, {}).get("exec", {}).get("command")
        if isinstance(command, list):
            task_executor_template[probe_name]["exec"]["command"] = [
                item.replace(
                    "http://localhost:52365/api/local_raylet_healthz",
                    "http://localhost:{DASHBOARD_AGENT_LISTEN_PORT}/api/local_raylet_healthz",
                ) if isinstance(item, str) else item
                for item in command
            ]

# Target placement is derived only from TARGET_HOSTS and must not be overridden.
values["nodeSelector"] = {node_selector_key: node_selector_value}
values.setdefault("head", {})["nodeSelector"] = {node_selector_key: node_selector_value}
values.setdefault("feTemplate", {})["nodeSelector"] = {node_selector_key: node_selector_value}
worker_groups = values.get("workerGroups")
if isinstance(worker_groups, dict):
    for worker_group in worker_groups.values():
        if isinstance(worker_group, dict):
            worker_group["nodeSelector"] = {node_selector_key: node_selector_value}
elif isinstance(worker_groups, list):
    for worker_group in worker_groups:
        if isinstance(worker_group, dict):
            worker_group["nodeSelector"] = {node_selector_key: node_selector_value}
if len(target_hosts) == 1:
    values.setdefault("feTemplate", {})["default_replica"] = 2
    if isinstance(worker_groups, dict):
        for group_name in ("ctrlGroup", "jobExecutorGroup"):
            worker_group = worker_groups.get(group_name)
            if isinstance(worker_group, dict):
                worker_group["minReplicas"] = 2
                worker_group["maxReplicas"] = 2
    framework_files = values.get("frameworkConfigFiles")
    if isinstance(framework_files, dict) and isinstance(framework_files.get("xds_framework.conf"), str):
        framework_files["xds_framework.conf"] = re.sub(
            r"(?m)^(\s*fem_(?:min|max)_frontend_num\s*=\s*)\d+",
            r"\g<1>2",
            framework_files["xds_framework.conf"],
        )
    health_service_template = Path(chart_dir) / "templates" / "xds-head-health-service.yaml"
    health_service_template.parent.mkdir(parents=True, exist_ok=True)
    health_service_template.write_text("""apiVersion: v1
kind: Service
metadata:
  name: ray-gcs-head-svc
  namespace: {{ .Release.Namespace }}
spec:
  publishNotReadyAddresses: true
  selector:
    ray.io/cluster: {{ include \"ray-cluster.fullname\" . }}
    ray.io/node-type: head
  ports:
    - name: dashboard
      port: 8265
      targetPort: 8265
""", encoding="utf-8")
upsert_container_env("XDS_TE_POD_LABEL_KEY", node_selector_key)
upsert_container_env("XDS_TE_POD_LABEL_VAL", node_selector_value)
upsert_container_env("XDS_NAMESPACE", namespace)
# The chart appends this exact value to every Ray worker environment.
remove_container_env("RAY_gcs_rpc_server_reconnect_timeout_s")
remove_container_env("XCCL_TURBO_FIX_PP_WEIGHT_LOAD")

registry, image_repository, image_name, image_tag = split_image_reference(deploy_image)
global_values = values.setdefault("global", {})
global_values["useFemFrontend"] = False
global_values["imageRegistry"] = registry
global_values.setdefault("images", {})["ray"] = image_name
global_values["roleName"] = f"{namespace}-role"
global_values["roleBindingName"] = f"{namespace}-role-binding"
global_values["serviceAccountName"] = f"{namespace}-sa"
global_values["serviceAccountSecretName"] = f"{namespace}-sa-secret"

lmcache = values.get("lmcache")
if isinstance(lmcache, dict):
    namespace_config = lmcache.get("namespace")
    if isinstance(namespace_config, dict):
        namespace_config["name"] = namespace
    direct = lmcache.get("direct")
    if isinstance(direct, dict) and isinstance(direct.get("image"), dict):
        direct["image"]["repository"] = image_repository
        direct["image"]["tag"] = image_tag

framework_files = values.get("frameworkConfigFiles")
if isinstance(framework_files, dict) and isinstance(framework_files.get("xds_framework.conf"), str):
    framework_files["xds_framework.conf"] = re.sub(
        r"(?m)^(\s*ems_enable\s*=\s*).*$",
        rf"\g<1>{str(use_ems).lower()}",
        framework_files["xds_framework.conf"],
    )
    if ems_namespace:
        framework_files["xds_framework.conf"] = re.sub(
            r"(?m)^(\s*ems_namespace\s*=\s*).*$",
            rf"\g<1>{ems_namespace}",
            framework_files["xds_framework.conf"],
        )
    framework_files["xds_framework.conf"] = re.sub(
        r"(?m)^(\s*use_fem_frontend\s*=\s*).*$",
        r"\g<1>false",
        framework_files["xds_framework.conf"],
    )
    framework_files["xds_framework.conf"] = re.sub(
        r"(?m)^(\s*k8s_deploy_namespace\s*=\s*).*$",
        rf"\g<1>{namespace}",
        framework_files["xds_framework.conf"],
    )
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
