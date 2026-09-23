#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/chart"
printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$work_dir/chart/Chart.yaml"
mkdir -p "$work_dir/chart/templates"
cat >"$work_dir/chart/templates/raycluster-cluster.yaml" <<'EOF'
groupName: {{ $teGroupValues.name }}
groupName: {{ $groupName }}
{{- $lmcache := $.Values.lmcacheSidecar | default dict }}
{{- if $lmcache.enabled }}
- name: lmcache-sidecar
  resources: {{- toYaml $lmcache.resources | nindent 4 }}
  args:
    {{- if $isLmcacheL2 }}
                  --l2-store-policy
    {{- end }}
{{- end }}
EOF
cat >"$work_dir/chart/templates/ray-svc.yaml" <<'EOF'
apiVersion: v1
kind: Service
spec:
  # Ray Serve 模式：Service 指向 Ray frontGroup
  selector:
    app.kubernetes.io/created-by: kuberay-operator
    ray.io/group: frontGroup
    in_draining_status: "false"
    app.kubernetes.io/instance: {{ .Release.Name }}
EOF
cat >"$work_dir/values.yaml" <<'EOF'
common:
  containerEnv:
    - name: RAY_gcs_rpc_server_reconnect_timeout_s
      value: '1209600'
    - name: XCCL_TURBO_FIX_PP_WEIGHT_LOAD
      value: '1'
    - name: XDS_TE_POD_LABEL_KEY
      value: kubernetes.io/hostname
    - name: XDS_TE_POD_LABEL_VAL
      value: 192.168.0.243
    - name: XDS_NAMESPACE
      value: old-namespace
    - name: XDS_DATABASE_NAME
      value: {XDS_DATABASE_NAME}
    - name: XDS_DATABASE_PORT
      value: {XDS_DATABASE_PORT}
    - name: XDS_DATABASE_USERNAME
      value: {XDS_DATABASE_USERNAME}
    - name: XDS_DATABASE_PASSWORD
      value: {DATABASE_PASSWORD}
    - name: EMS_ENABLE
      value: 'true'
nodeSelector:
  kubernetes.io/hostname: 192.168.0.243
rayService:
  service:
    ports:
      # Image templates may carry a literal default instead of {NODE_PORT};
      # the renderer must still apply the mapped target's fixed NodePort.
      - nodePort: 31365
head:
  nodeSelector: {}
workerGroups:
  ctrlGroup:
    minReplicas: 4
    maxReplicas: 4
    nodeSelector:
      kubernetes.io/hostname: 192.168.0.243
  frontGroup:
    nodeSelector: {}
  jobExecutorGroup:
    minReplicas: 8
    maxReplicas: 8
    ems:
      enable: true
ems:
  enable: true
feTemplate:
  default_replica: 10
  nodeSelector:
    kubernetes.io/hostname: 192.168.0.243
global:
  useFemFrontend: true
  network:
    ports:
      - name: frontend-port
        nodePort: 31365
  storage:
    hostPath: /mnt/paas
  imageRegistry: registry.example/old
  images:
    ray: xds:old
  roleName: old-namespace-role
  roleBindingName: old-namespace-role-binding
  serviceAccountName: old-namespace-sa
  serviceAccountSecretName: old-namespace-sa-secret
frameworkConfigFiles:
  xds_framework.conf: |
    [metric]
    pushgateway = true
    collector_gateway_url = 192.168.10.6:25888
    [deploy]
    k8s_deploy_namespace = old-namespace
    [fe]
    use_fem_frontend = true
    fem_min_frontend_num = 10
    fem_max_frontend_num = 10
    [ems_config]
    ems_enable = true
    ems_namespace = ems_deploy_ns
    ems_cluster_id = 00000000-0000-0000-0000-000000000000
lmcache:
  namespace:
    name: old-namespace
  direct:
    image:
      repository: registry.example/old/xds
      tag: old
lmcacheSidecar:
  # lite 模板契约：仅 enabled/logLevel/l2Enabled 由渲染器替换，
  # 端口/尺寸/资源等默认值固化在 values 模板中。
  enabled: {LMCACHE_SIDECAR_ENABLED}
  logLevel: {LMCACHE_LOG_LEVEL}
  l2Enabled: {LMCACHE_L2_ENABLED}
  tracing:
    otlpEndpoint: {LMCACHE_OTLP_ENDPOINT}
  mpPortBase: 5555
  httpPortBase: 5565
  l1InitSizeGb: 20
  l1SizeGb: 200
  l1AlignBytes: "4096"
  maxWorkers: 1
  cudaVisibleDevices: ''
  resources:
    requests:
      cpu: 4
      memory: 8Gi
    limits:
      cpu: 8
      memory: 240Gi
# disabled infrastructure setting: {ELB_ID}
EOF
cat >"$work_dir/architectures.json" <<'EOF'
[
  {
    "arch_name": "test-arch",
    "use_ems": false,
    "deploy_spec_packages": [
      {
        "deploy_specs": [
          {
            "role": "prefill",
            "min": 1,
            "max": 1,
            "default": 1,
            "resources": [{"cpu": 1, "gpu": 4, "memory": "1G"}]
          },
          {
            "role": "decode",
            "min": 1,
            "max": 1,
            "default": 1,
            "resources": [{"cpu": 1, "gpu": 4, "memory": "1G"}]
          }
        ]
      }
    ]
  }
]
EOF

ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-one-node-78-verify' \
XDS_DATABASE_NAME='custom_db' \
XDS_DATABASE_PORT='32106' \
XDS_DATABASE_USERNAME='custom_user' \
XDS_DATABASE_PASSWORD='custom_password' \
TARGET_HOSTS='[{"ip":"192.168.0.243"},{"ip":"192.168.0.78:2222"}]' \
TARGET_NODE_IP_MAP='{"192.168.0.243":"192.168.31.175","192.168.0.78:2222":"192.168.31.17"}' \
MODEL_CACHE_HOST_PATH='/mnt/paas' \
YAML_REPLACE_JSON='{"nodeSelector":{"user":"override"}}' \
TEMPLATE_VARS_JSON='{"XDS_DATABASE_PORT":"3306"}' \
EMS_NAMESPACE='op-ems' \
bash "$script_dir/render-config.sh" >/dev/null

python3 - "$work_dir/run/rendered/values.rendered.yaml" <<'PY'
import json
import sys
import yaml

with open(sys.argv[1], encoding="utf-8") as source:
    values = yaml.safe_load(source)

expected = {"xds.optest": "node-175-17"}
assert values["nodeSelector"] == expected, values["nodeSelector"]
assert values["rayService"]["service"]["ports"][0]["nodePort"] == 31008, values["rayService"]
assert values["global"]["network"]["ports"][0]["nodePort"] == 31008, values["global"]["network"]
assert values["head"]["nodeSelector"] == expected, values["head"]
assert all(group["nodeSelector"] == expected for group in values["workerGroups"].values())
assert values["feTemplate"]["nodeSelector"] == expected, values["feTemplate"]
assert values["global"]["storage"]["hostPath"] == "/mnt/paas", values["global"]
assert values["feTemplate"]["default_replica"] == 10, values["feTemplate"]
assert values["workerGroups"]["ctrlGroup"]["minReplicas"] == 4, values["workerGroups"]
assert values["workerGroups"]["ctrlGroup"]["maxReplicas"] == 4, values["workerGroups"]
assert values["workerGroups"]["jobExecutorGroup"]["minReplicas"] == 8, values["workerGroups"]
assert values["workerGroups"]["jobExecutorGroup"]["maxReplicas"] == 8, values["workerGroups"]
assert values["workerGroups"]["frontGroup"]["labels"] == {
    "ray.io/group": "frontGroup"
}, values["workerGroups"]
env = {entry["name"]: entry.get("value") for entry in values["common"]["containerEnv"]}
assert env["XDS_TE_POD_LABEL_KEY"] == "xds.optest", env
assert env["XDS_TE_POD_LABEL_VAL"] == "node-175-17", env
assert env["XDS_NAMESPACE"] == "xds-one-node-78-verify", env
assert env["XDS_DATABASE_NAME"] == "custom_db", env
assert env["XDS_DATABASE_PORT"] == "32106", env
assert env["XDS_DATABASE_USERNAME"] == "custom_user", env
assert env["XDS_DATABASE_PASSWORD"] == "custom_password", env
assert env["EMS_ENABLE"] == "false", env
assert isinstance(env["XDS_DATABASE_PORT"], str), env
assert "RAY_gcs_rpc_server_reconnect_timeout_s" not in env, env
assert "XCCL_TURBO_FIX_PP_WEIGHT_LOAD" not in env, env
assert all(group["nodeSelector"] == expected for group in values["taskExecutorGroups"])
for group in values["taskExecutorGroups"]:
    resources = group["resources"]
    assert resources.startswith("'") and resources.endswith("'"), resources
    assert json.loads(resources[1:-1])["XDS-TE"] == 4
assert values["global"]["imageRegistry"] == "registry.example/dataartsfabric"
assert values["global"]["useFemFrontend"] is False, values["global"]
assert values["global"]["storage"]["hostPath"] == "/mnt/paas", values["global"]
assert values["global"]["imagePullSecrets"] == [
    {"name": "default-secret"},
    {"name": "swr-cn-southwest-2"},
], values["global"]
assert values["global"]["images"]["ray"] == "xds:test-tag"
assert values["global"].get("fullnameOverride", "") == "", values["global"]
assert values["global"]["roleName"] == "xds-one-node-78-verify-role"
assert values["global"]["roleBindingName"] == "xds-one-node-78-verify-role-binding"
assert values["global"]["serviceAccountName"] == "xds-one-node-78-verify-sa"
assert values["global"]["serviceAccountSecretName"] == "xds-one-node-78-verify-sa-secret"
assert values["lmcache"]["namespace"]["name"] == "xds-one-node-78-verify"
assert values["lmcache"]["direct"]["image"] == {
    "repository": "registry.example/dataartsfabric/xds", "tag": "test-tag"
}
sidecar = values["lmcacheSidecar"]
assert sidecar["enabled"] is False
assert sidecar["logLevel"] == "INFO"
assert sidecar["l2Enabled"] is True, sidecar
# 固化在模板中的 sidecar 默认值不被渲染器篡改（lite 不做参数透传）。
assert sidecar["mpPortBase"] == 5555
assert sidecar["httpPortBase"] == 5565
assert sidecar["l1InitSizeGb"] == 20
assert sidecar["l1SizeGb"] == 200
assert sidecar["l1AlignBytes"] == "4096"
assert sidecar["maxWorkers"] == 1
assert sidecar["cudaVisibleDevices"] == ""
assert sidecar["resources"] == {
    "requests": {"cpu": 4, "memory": "8Gi"},
    "limits": {"cpu": 8, "memory": "240Gi"},
}
assert not any(probe_name in sidecar for probe_name in (
    "startupProbe", "readinessProbe", "livenessProbe"
))
assert "k8s_deploy_namespace = xds-one-node-78-verify" in values["frameworkConfigFiles"]["xds_framework.conf"]
assert "collector_gateway_url = 192.168.16.146:25888" in values["frameworkConfigFiles"]["xds_framework.conf"]
assert "use_fem_frontend = false" in values["frameworkConfigFiles"]["xds_framework.conf"]
assert "mock_db = true" in values["frameworkConfigFiles"]["xds_framework.conf"]
assert values["ems"]["enable"] is False, values["ems"]
assert values["workerGroups"]["jobExecutorGroup"]["ems"]["enable"] is False
assert "ems_enable = false" in values["frameworkConfigFiles"]["xds_framework.conf"]
assert "ems_namespace = op-ems" in values["frameworkConfigFiles"]["xds_framework.conf"]
PY

rendered_chart="$work_dir/run/rendered/xds-cluster/templates/raycluster-cluster.yaml"
grep -Fq 'groupName: {{ if contains "prefill" (lower $teGroupValues.name) }}prefill-' "$rendered_chart"
# sidecar 未启用（ENABLE_LMCACHE 默认 false）时跳过 tracing patch：
# 非 LMCache 部署不应因旧 chart 缺锄点而失败。
if grep -Fq -- '--enable-tracing' "$rendered_chart"; then
  echo "tracing patch must be skipped when lmcacheSidecar is disabled" >&2
  exit 1
fi
grep -Fq 'else if contains "decode" (lower $teGroupValues.name) }}decode-' "$rendered_chart"
grep -Fq 'else if or (eq $groupName "jobExecutorGroup") (contains "jobexecutor" (lower $groupName)) }}je' "$rendered_chart"
if grep -Fq 'eq $groupName "frontGroup") (contains "frontend" (lower $groupName)) }}fe' "$rendered_chart"; then
  echo "frontGroup must remain the KubeRay group name" >&2
  exit 1
fi
rendered_service="$work_dir/run/rendered/xds-cluster/templates/ray-svc.yaml"
grep -Fq 'ray.io/group: frontGroup' "$rendered_service"
if grep -Fq 'app.kubernetes.io/created-by: kuberay-operator' "$rendered_service"; then
  echo "ray-svc must select only the explicit FE-group label" >&2
  exit 1
fi

ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-lmcache-override" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-lmcache-override' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
  TEMPLATE_VARS_JSON='{"LMCACHE_SIDECAR_ENABLED":"true","LMCACHE_LOG_LEVEL":"DEBUG","LMCACHE_L2_ENABLED":"false"}' \
  bash "$script_dir/render-config.sh" >/dev/null

python3 - "$work_dir/run-lmcache-override/rendered/values.rendered.yaml" <<'PY'
import sys
import yaml

with open(sys.argv[1], encoding="utf-8") as source:
    values = yaml.safe_load(source)

sidecar = values["lmcacheSidecar"]
assert sidecar["enabled"] is True, sidecar
assert sidecar["logLevel"] == "DEBUG", sidecar
assert sidecar["l2Enabled"] is False, sidecar
assert "enabled" not in sidecar["tracing"], sidecar
assert sidecar["tracing"]["otlpEndpoint"] == "http://192.168.10.6:4320", sidecar
PY

# sidecar 启用时 tracing patch 注入在 lmcache args 锚点之前（旧式 chart，无原生 tracing）。
rendered_chart_override="$work_dir/run-lmcache-override/rendered/xds-cluster/templates/raycluster-cluster.yaml"
grep -Fq -- '--enable-tracing \' "$rendered_chart_override"
grep -Fq -- '--otlp-endpoint http://192.168.10.6:4320 \' "$rendered_chart_override"

# 新式 chart：模板已原生携带 tracing 条件块（lmcacheSidecar.tracing.*），
# 渲染后 patch 必须跳过且不重复注入。
mkdir -p "$work_dir/chart-native/templates"
printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$work_dir/chart-native/Chart.yaml"
cat >"$work_dir/chart-native/templates/raycluster-cluster.yaml" <<'EOF'
groupName: {{ $teGroupValues.name }}
groupName: {{ $groupName }}
{{- $lmcache := $.Values.lmcacheSidecar | default dict }}
{{- $lmcacheTracing := $lmcache.tracing | default dict }}
{{- $lmcacheTracingEnabled := ne ($lmcacheTracing.otlpEndpoint | default "") "" }}
{{- if $lmcache.enabled }}
- name: lmcache-sidecar
  args:
    {{- if $isLmcacheL2 }}
                  --l2-store-policy default --l2-adapter "$l2_adapter_json" \
    {{- end }}
    {{- if $lmcacheTracingEnabled }}
                  --enable-tracing \
                  --otlp-endpoint {{ $lmcacheTracing.otlpEndpoint }}
    {{- end }}
{{- end }}
EOF
ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-native-chart" \
CHART_TEMPLATE_DIR="$work_dir/chart-native" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-native-chart' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
  TEMPLATE_VARS_JSON='{"LMCACHE_SIDECAR_ENABLED":"true"}' \
  bash "$script_dir/render-config.sh" >"$work_dir/native-chart.out" 2>&1
native_rendered="$work_dir/run-native-chart/rendered/xds-cluster/templates/raycluster-cluster.yaml"
[[ $(grep -Fc -- '--enable-tracing' "$native_rendered") -eq 1 ]] || { echo 'native chart 不应重复注入 tracing' >&2; exit 1; }
grep -Fq 'LMCACHE_OTLP_PATCH_SKIPPED=chart template already carries tracing args' "$work_dir/native-chart.out"
grep -Fq -- '--otlp-endpoint {{ $lmcacheTracing.otlpEndpoint }}' "$native_rendered"

# endpoint 置空 = 关闭 tracing：旧式 chart 不注入 patch，原生模板条件块也不生效。
ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-lmcache-no-otlp" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-lmcache-no-otlp' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
LMCACHE_OTLP_ENDPOINT='' \
  TEMPLATE_VARS_JSON='{"LMCACHE_SIDECAR_ENABLED":"true"}' \
  bash "$script_dir/render-config.sh" >"$work_dir/no-otlp.out" 2>&1
if grep -Fq -- '--enable-tracing' "$work_dir/run-lmcache-no-otlp/rendered/xds-cluster/templates/raycluster-cluster.yaml"; then
  echo "endpoint 置空时不应注入 tracing patch" >&2
  exit 1
fi
python3 - "$work_dir/run-lmcache-no-otlp/rendered/values.rendered.yaml" <<'PY'
import sys
import yaml

with open(sys.argv[1], encoding="utf-8") as source:
    values = yaml.safe_load(source)

assert values["lmcacheSidecar"]["tracing"]["otlpEndpoint"] in ("", None), values["lmcacheSidecar"]["tracing"]
PY

# LMCACHE_EXTRA_ARGS：注入成功（与 tracing patch 共存，同一 exec 命令内）。
ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-lmcache-extra-args" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-lmcache-extra-args' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
  LMCACHE_EXTRA_ARGS='--worker-reap-timeout-seconds 60 --worker-registration-grace-seconds 60' \
  TEMPLATE_VARS_JSON='{"LMCACHE_SIDECAR_ENABLED":"true"}' \
  bash "$script_dir/render-config.sh" >"$work_dir/extra-args.out" 2>&1
extra_rendered="$work_dir/run-lmcache-extra-args/rendered/xds-cluster/templates/raycluster-cluster.yaml"
grep -Fq -- '--worker-reap-timeout-seconds 60 --worker-registration-grace-seconds 60 \' "$extra_rendered"
grep -Fq 'LMCACHE_EXTRA_ARGS_PATCHED=--worker-reap-timeout-seconds 60' "$work_dir/extra-args.out"
# tracing patch 同的注入且都在 exec 内：extra 行后紧跟 L2 锚点
line_no=$(grep -Fn -- '--worker-registration-grace-seconds 60 \' "$extra_rendered" | head -1 | cut -d: -f1)
anchor_no=$(grep -Fn -- '--l2-store-policy' "$extra_rendered" | head -1 | cut -d: -f1)
[[ -n "$line_no" && -n "$anchor_no" && $((anchor_no - line_no)) -le 3 ]] || { echo 'extra args 未紧邻 L2 锚点' >&2; exit 1; }

# 危险字符 → 渲染失败
danger='--x "$(boom)"'
if ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-lmcache-extra-danger" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-lmcache-extra-danger' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
  LMCACHE_EXTRA_ARGS="$danger" \
  TEMPLATE_VARS_JSON='{"LMCACHE_SIDECAR_ENABLED":"true"}' \
  bash "$script_dir/render-config.sh" >"$work_dir/extra-danger.out" 2>&1; then
  echo '危险字符未被拒绝' >&2
  exit 1
fi
grep -Fq 'unsafe characters' "$work_dir/extra-danger.out" || { echo '危险字符报错文案不对' >&2; exit 1; }

# sidecar 未启用 → 跳过注入且渲染成功
ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-lmcache-extra-disabled" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-lmcache-extra-disabled' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
  LMCACHE_EXTRA_ARGS='--worker-reap-timeout-seconds 60' \
  bash "$script_dir/render-config.sh" >"$work_dir/extra-disabled.out" 2>&1
grep -Fq 'render-lmcache] extra-args skipped: lmcacheSidecar.enabled=false' "$work_dir/extra-disabled.out"
if grep -Fq -- '--worker-reap-timeout-seconds' "$work_dir/run-lmcache-extra-disabled/rendered/xds-cluster/templates/raycluster-cluster.yaml"; then
  echo 'sidecar 未启用时不应注入 extra args' >&2
  exit 1
fi

# 回归：旧 chart 无 LMCache 锚点 + sidecar 未启用（非 LMCache arch）→ 渲染成功且不 patch。
mkdir -p "$work_dir/chart-legacy/templates"
printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$work_dir/chart-legacy/Chart.yaml"
cat >"$work_dir/chart-legacy/templates/raycluster-cluster.yaml" <<'EOF'
groupName: {{ $teGroupValues.name }}
groupName: {{ $groupName }}
EOF
ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-legacy-chart" \
CHART_TEMPLATE_DIR="$work_dir/chart-legacy" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-legacy-chart' \
TARGET_HOSTS='[{"ip":"192.168.0.243"}]' \
  bash "$script_dir/render-config.sh" >"$work_dir/legacy-chart.out" 2>&1
grep -Fq 'render-lmcache] tracing patch skipped: lmcacheSidecar.enabled=false' "$work_dir/legacy-chart.out"
if grep -Fq -- '--enable-tracing' "$work_dir/run-legacy-chart/rendered/xds-cluster/templates/raycluster-cluster.yaml"; then
  echo "legacy chart must not receive the tracing patch without lmcache" >&2
  exit 1
fi

# sidecar 显式启用但旧 chart 缺锄点：仍视为模板漂移，硬报错。
if ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-legacy-chart-drift" \
CHART_TEMPLATE_DIR="$work_dir/chart-legacy" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-legacy-chart-drift' \
TARGET_HOSTS='[{"ip":"192.168.0.243"}]' \
  TEMPLATE_VARS_JSON='{"LMCACHE_SIDECAR_ENABLED":"true"}' \
  bash "$script_dir/render-config.sh" >"$work_dir/legacy-drift.out" 2>&1; then
  echo "missing anchor with lmcache enabled must fail" >&2
  exit 1
fi
grep -Fq 'LMCache sidecar args anchor not found in chart template' "$work_dir/legacy-drift.out"

if ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-missing-map" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-one-node-map-failure' \
TARGET_HOSTS='[{"ip":"192.168.0.243"},{"ip":"192.168.0.78:2222"}]' \
TARGET_NODE_IP_MAP='{"192.168.0.243":"192.168.31.175"}' \
bash "$script_dir/render-config.sh" >"$work_dir/missing-map.out" 2>&1; then
  echo 'render must reject a node-IP map missing a target SSH endpoint' >&2
  exit 1
fi
grep -Fq 'TARGET_NODE_IP_MAP is missing target endpoint: 192.168.0.78:2222' "$work_dir/missing-map.out"

ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-single" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-one-node-78-verify' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
TEMPLATE_VARS_JSON='{"XDS_DATABASE_PORT":"3306"}' \
bash "$script_dir/render-config.sh" >/dev/null

python3 - "$work_dir/run-single/rendered/values.rendered.yaml" <<'PY'
import sys
import yaml

with open(sys.argv[1], encoding="utf-8") as source:
    values = yaml.safe_load(source)

assert values["feTemplate"]["default_replica"] == 2, values["feTemplate"]
assert values["global"].get("fullnameOverride", "") == "", values["global"]
assert values["workerGroups"]["ctrlGroup"]["minReplicas"] == 2, values["workerGroups"]
assert values["workerGroups"]["ctrlGroup"]["maxReplicas"] == 2, values["workerGroups"]
assert values["workerGroups"]["jobExecutorGroup"]["minReplicas"] == 2, values["workerGroups"]
assert values["workerGroups"]["jobExecutorGroup"]["maxReplicas"] == 2, values["workerGroups"]
framework_config = values["frameworkConfigFiles"]["xds_framework.conf"]
assert "fem_min_frontend_num = 2" in framework_config, framework_config
assert "fem_max_frontend_num = 2" in framework_config, framework_config
assert "collector_gateway_url = 192.168.10.6:25888" in framework_config, framework_config
assert "mock_db = true" in framework_config, framework_config
PY

ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-image-secrets" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-one-node-78-verify' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
IMAGE_PULL_SECRETS='first-secret, second-secret' \
bash "$script_dir/render-config.sh" >/dev/null

python3 - "$work_dir/run-image-secrets/rendered/values.rendered.yaml" <<'PY'
import sys
import yaml

with open(sys.argv[1], encoding="utf-8") as source:
    values = yaml.safe_load(source)

assert values["global"]["imagePullSecrets"] == [
    {"name": "first-secret"},
    {"name": "second-secret"},
], values["global"]
PY

ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-image-secret-compat" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-one-node-78-verify' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
IMAGE_PULL_SECRET='legacy-secret, second-secret' \
bash "$script_dir/render-config.sh" >/dev/null

python3 - "$work_dir/run-image-secret-compat/rendered/values.rendered.yaml" <<'PY'
import sys
import yaml

with open(sys.argv[1], encoding="utf-8") as source:
    values = yaml.safe_load(source)

assert values["global"]["imagePullSecrets"] == [
    {"name": "legacy-secret"},
    {"name": "second-secret"},
], values["global"]
PY

health_service_template="$work_dir/run-single/rendered/xds-cluster/templates/xds-head-health-service.yaml"
test -f "$health_service_template"
grep -q 'name: ray-gcs-head-svc' "$health_service_template"
grep -q 'publishNotReadyAddresses: true' "$health_service_template"
grep -q 'ray.io/node-type: head' "$health_service_template"

sed 's/"use_ems": false/"use_ems": true/' "$work_dir/architectures.json" >"$work_dir/architectures-ems.json"
ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-ems-enabled" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures-ems.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
NAMESPACE='xds-ems-enabled' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
EMS_NAMESPACE='op-ems-enabled' \
bash "$script_dir/render-config.sh" >/dev/null

python3 - "$work_dir/run-ems-enabled/rendered/values.rendered.yaml" <<'PY'
import sys
import yaml

with open(sys.argv[1], encoding="utf-8") as source:
    values = yaml.safe_load(source)
env = {entry["name"]: entry.get("value") for entry in values["common"]["containerEnv"]}
framework_config = values["frameworkConfigFiles"]["xds_framework.conf"]
assert env["EMS_ENABLE"] == "true", env
assert values["ems"]["enable"] is True, values["ems"]
assert values["workerGroups"]["jobExecutorGroup"]["ems"]["enable"] is True
assert "ems_enable = true" in framework_config, framework_config
assert "ems_namespace = op-ems-enabled" in framework_config, framework_config
PY

# Both `arch` and EXECUTOR select the descriptive namespace.  If either input
# is absent the pre-existing ARCH_NAME-based namespace remains in effect.
arch='runtime-arch' EXECUTOR='gpu-bnt3' \
ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-namespace-arch-executor" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
IMAGE_TAG='test-tag' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
bash "$script_dir/render-config.sh" >"$work_dir/namespace-arch-executor.out"
grep -qx 'NAMESPACE=xds-runtime-arch-gpu-bnt3' "$work_dir/namespace-arch-executor.out"

arch='runtime-arch' \
ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-namespace-legacy" \
CHART_TEMPLATE_DIR="$work_dir/chart" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
IMAGE_TAG='test-tag' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
bash "$script_dir/render-config.sh" >"$work_dir/namespace-legacy.out"
grep -qx 'NAMESPACE=xds-test-arch' "$work_dir/namespace-legacy.out"


# Role names in the copied Chart remain the upstream KubeRay names.

echo "render target-label tests passed"
