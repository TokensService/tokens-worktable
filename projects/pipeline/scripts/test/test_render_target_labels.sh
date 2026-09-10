#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/chart"
printf 'apiVersion: v2\nname: xds-test\nversion: 0.1.0\n' >"$work_dir/chart/Chart.yaml"
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
    - name: XDS_DATABASE_PORT
      value: {XDS_DATABASE_PORT}
nodeSelector:
  kubernetes.io/hostname: 192.168.0.243
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
feTemplate:
  default_replica: 10
  nodeSelector:
    kubernetes.io/hostname: 192.168.0.243
global:
  useFemFrontend: true
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
    [deploy]
    k8s_deploy_namespace = old-namespace
    [fe]
    use_fem_frontend = true
    fem_min_frontend_num = 10
    fem_max_frontend_num = 10
lmcache:
  namespace:
    name: old-namespace
  direct:
    image:
      repository: registry.example/old/xds
      tag: old
# disabled infrastructure setting: {ELB_ID}
EOF
cat >"$work_dir/architectures.json" <<'EOF'
[
  {
    "arch_name": "test-arch",
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
TARGET_HOSTS='[{"ip":"192.168.0.243"},{"ip":"192.168.0.78:2222"}]' \
YAML_REPLACE_JSON='{"nodeSelector":{"user":"override"}}' \
TEMPLATE_VARS_JSON='{"XDS_DATABASE_PORT":"3306"}' \
bash "$script_dir/render-config.sh" >/dev/null

python3 - "$work_dir/run/rendered/values.rendered.yaml" <<'PY'
import json
import sys
import yaml

with open(sys.argv[1], encoding="utf-8") as source:
    values = yaml.safe_load(source)

expected = {"xds.optest": "node-243-78"}
assert values["nodeSelector"] == expected, values["nodeSelector"]
assert values["head"]["nodeSelector"] == expected, values["head"]
assert all(group["nodeSelector"] == expected for group in values["workerGroups"].values())
assert values["feTemplate"]["nodeSelector"] == expected, values["feTemplate"]
assert values["feTemplate"]["default_replica"] == 10, values["feTemplate"]
assert values["workerGroups"]["ctrlGroup"]["minReplicas"] == 4, values["workerGroups"]
assert values["workerGroups"]["ctrlGroup"]["maxReplicas"] == 4, values["workerGroups"]
assert values["workerGroups"]["jobExecutorGroup"]["minReplicas"] == 8, values["workerGroups"]
assert values["workerGroups"]["jobExecutorGroup"]["maxReplicas"] == 8, values["workerGroups"]
env = {entry["name"]: entry.get("value") for entry in values["common"]["containerEnv"]}
assert env["XDS_TE_POD_LABEL_KEY"] == "xds.optest", env
assert env["XDS_TE_POD_LABEL_VAL"] == "node-243-78", env
assert env["XDS_NAMESPACE"] == "xds-one-node-78-verify", env
assert env["XDS_DATABASE_PORT"] == "3306", env
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
assert values["global"]["storage"]["hostPath"] == "/mnt/xds/sfs", values["global"]
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
assert "k8s_deploy_namespace = xds-one-node-78-verify" in values["frameworkConfigFiles"]["xds_framework.conf"]
assert "use_fem_frontend = false" in values["frameworkConfigFiles"]["xds_framework.conf"]
assert "mock_db = true" in values["frameworkConfigFiles"]["xds_framework.conf"]
PY

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
grep -qx 'NAMESPACE=xds-runtime-arch-gpu-bnt3-test-tag' "$work_dir/namespace-arch-executor.out"

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
grep -qx 'NAMESPACE=xds-test-arch-test-tag' "$work_dir/namespace-legacy.out"

mkdir -p "$work_dir/chart-role/templates"
printf 'apiVersion: v2\nname: xds-role\nversion: 0.1.0\n' >"$work_dir/chart-role/Chart.yaml"
cat >"$work_dir/chart-role/templates/raycluster-cluster.yaml" <<'EOF'
{{- range $index, $teGroupValues := $.Values.taskExecutorGroups }}
          - name: ray-worker
{{- end }}
EOF
ARCH_NAME=test-arch \
RUN_DIR="$work_dir/run-role-container-names" \
CHART_TEMPLATE_DIR="$work_dir/chart-role" \
VALUES_TEMPLATE="$work_dir/values.yaml" \
ARCH_FILE="$work_dir/architectures.json" \
DEPLOY_IMAGE='registry.example/dataartsfabric/xds:test-tag' \
TARGET_HOSTS='[{"ip":"192.168.0.78"}]' \
bash "$script_dir/render-config.sh" >/dev/null
role_template="$work_dir/run-role-container-names/rendered/xds-cluster/templates/raycluster-cluster.yaml"
grep -Fq 'name: {{ if contains "prefill"' "$role_template"
grep -Fq 'ray-worker-prefill' "$role_template"
grep -Fq 'ray-worker-decode' "$role_template"

echo "render target-label tests passed"
