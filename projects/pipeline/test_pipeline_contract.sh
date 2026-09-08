#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$ROOT/scripts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/xds-cluster/templates"
cat >"$WORK/xds-cluster/Chart.yaml" <<'EOF'
apiVersion: v2
name: xds-cluster
version: 0.1.0
EOF
cat >"$WORK/values.template.yaml" <<'EOF'
global:
  image: repo/xds:{IMAGE_TAG}
  sentinel: old
taskExecutorGroups: []
frameworkConfigFiles:
  xds_framework.conf: |
    mock_db = false
EOF
cat >"$WORK/model_arch.json" <<'EOF'
[
  {
    "arch_name": "glm-5.2-nvfp4",
    "deploy_spec_packages": [{
      "spec_package_name": "glm-5.2-nvfp4",
      "deploy_specs": [
        {"name": "prefill", "role": "prefill", "params": {"pipeline_parallel_size": 4}, "resources": [{"device_type": "BNT3", "cpu": 48, "gpu": 4, "memory": "200G"}], "min": 1, "max": 1, "default": 1},
        {"name": "decode", "role": "decode", "params": {"data_parallel_size": 8}, "resources": [{"device_type": "BNT3", "cpu": 48, "gpu": 8, "memory": "200G"}], "min": 1, "max": 1, "default": 1}
      ]
    }]
  }
]
EOF

RUN_DIR="$WORK/run" \
CHART_TEMPLATE_DIR="$WORK/xds-cluster" \
VALUES_TEMPLATE="$WORK/values.template.yaml" \
ARCH_FILE="$WORK/model_arch.json" \
ARCH_NAME="glm-5.2-nvfp4" \
TARGET_HOSTS='[{"ip":"192.0.2.10","user":"root","pass":"test"}]' \
NUM_PREFILL=2 NUM_DECODE=1 PREFILL_GPU=4 DECODE_GPU=4 \
DEPLOY_IMAGE="registry.example.com/xds:test" \
NAMESPACE="xds-test" RELEASE_NAME="xds-test" \
NODE_SELECTOR_KEY="xds.zcx.bnt" NODE_SELECTOR_VALUE="zcx" \
REPLACE_MAP_JSON='{"old":"replaced"}' \
YAML_REPLACE_JSON='{"global":{"extra":"enabled"}}' \
bash "$SCRIPTS/render-config.sh" >"$WORK/render.out"

set -a
source <(grep -E '^(RUN_DIR|CHART_DIR|VALUES_FILE|ARCH_REQUEST_FILE|RESOURCE_MANIFEST|ARCH_FILE|ARCH_NAME|NAMESPACE|RELEASE_NAME)=' "$WORK/render.out")
set +a

test -f "$CHART_DIR/Chart.yaml"
test -f "$VALUES_FILE"
test -f "$ARCH_REQUEST_FILE"
test -f "$RESOURCE_MANIFEST"

python3 - "$ARCH_REQUEST_FILE" "$RESOURCE_MANIFEST" "$VALUES_FILE" <<'PY'
import json
import sys
import yaml

arch = json.load(open(sys.argv[1]))
specs = arch["deploy_spec_packages"][0]["deploy_specs"]
prefill, decode = specs
assert (prefill["min"], prefill["max"], prefill["default"]) == (2, 2, 2)
assert prefill["resources"][0]["gpu"] == 4
assert (decode["min"], decode["max"], decode["default"]) == (1, 1, 1)
assert decode["resources"][0]["gpu"] == 4
assert decode["params"]["data_parallel_size"] == 8  # 不再根据 GPU 覆盖 arch 的 DP

resources = json.load(open(sys.argv[2]))
assert [r["role"] for r in resources["resources"]] == ["prefill", "prefill", "decode"]
assert [r["gpu"] for r in resources["resources"]] == [4, 4, 4]
assert len({r["resource_id"] for r in resources["resources"]}) == 3

values = yaml.safe_load(open(sys.argv[3]))
assert len(values["taskExecutorGroups"]) == 3
assert values["global"]["sentinel"] == "replaced"
assert values["global"]["extra"] == "enabled"
assert values["global"]["enableTaskExecutorGroups"] is True
assert all(group["nodeSelector"] == {"xds.optest": "node-10"} for group in values["taskExecutorGroups"])
PY

echo "PASS: render-config produces one coherent P/D deployment contract"

FAKE_BIN="$WORK/fake-bin"
FAKE_IMAGE_ROOT="$WORK/fake-image"
mkdir -p "$FAKE_BIN" \
  "$FAKE_IMAGE_ROOT/opt/op_test/xds_template/k8s/xds-cluster" \
  "$FAKE_IMAGE_ROOT/opt/op_test/xds_template_values/xds-cluster-low-latency/k8s" \
  "$FAKE_IMAGE_ROOT/opt/op_test/xds_template/cap/model_arch"
cp "$WORK/xds-cluster/Chart.yaml" "$FAKE_IMAGE_ROOT/opt/op_test/xds_template/k8s/xds-cluster/Chart.yaml"
cp "$WORK/values.template.yaml" "$FAKE_IMAGE_ROOT/opt/op_test/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml"
cp "$WORK/model_arch.json" "$FAKE_IMAGE_ROOT/opt/op_test/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json"
cat >"$FAKE_BIN/nerdctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--namespace" ]]; then
  shift 2
fi
case "$1" in
  image) exit 0 ;;
  pull) exit 0 ;;
  create) echo fake-container ;;
  cp)
    src="${2#*:}"
    cp -a "$FAKE_IMAGE_ROOT$src" "$3"
    ;;
  rm) exit 0 ;;
  *) echo "unexpected nerdctl invocation: $*" >&2; exit 1 ;;
esac
EOF
cat >"$FAKE_BIN/sshpass" <<'EOF'
#!/usr/bin/env bash
shift 2
exec "$@"
EOF
cat >"$FAKE_BIN/ssh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$FAKE_BIN/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
all="$*"
case "$all" in
  "get nodes -o json")
    echo '{"items":[{"metadata":{"name":"node-a"},"status":{"addresses":[{"type":"InternalIP","address":"192.0.2.10"}]}}]}' ;;
  *"get svc -A -o json") echo '{"items":[]}' ;;
  *"get configmap "*) echo '{}' ;;
  *"get pods "*"-o name") exit 0 ;;
  *"get pods "*"-o json")
    echo '{"items":[{"metadata":{"name":"prefill-1","labels":{"ray.io/group":"taskExecutorGroup4prefill1"}}},{"metadata":{"name":"prefill-2","labels":{"ray.io/group":"taskExecutorGroup4prefill2"}}},{"metadata":{"name":"decode-1","labels":{"ray.io/group":"taskExecutorGroup4decode1"}}}]}' ;;
  "label node "*) exit 0 ;;
  *" wait "*) exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$FAKE_BIN/nerdctl" "$FAKE_BIN/sshpass" "$FAKE_BIN/ssh" "$FAKE_BIN/kubectl"

PATH="$FAKE_BIN:$PATH" FAKE_IMAGE_ROOT="$FAKE_IMAGE_ROOT" \
RUN_DIR="$WORK/pull-run" TARGET_IP="192.0.2.10" TARGET_USER=root TARGET_PASSWORD=test \
env -u CHART_TEMPLATE_DIR -u VALUES_TEMPLATE -u ARCH_FILE \
  bash "$SCRIPTS/pull-image.sh" registry.example.com/xds:test >"$WORK/pull.out"

grep -qx "RUN_DIR=$WORK/pull-run" "$WORK/pull.out"
grep -qx "CHART_TEMPLATE_DIR=$WORK/pull-run/template/xds-cluster" "$WORK/pull.out"
grep -qx "VALUES_TEMPLATE=$WORK/pull-run/template/values-16Node-je-cpp-bnt3.yaml" "$WORK/pull.out"
grep -qx "ARCH_FILE=$WORK/pull-run/template/model_arch-lt-je-cpp-bnt3.json" "$WORK/pull.out"
test -f "$WORK/pull-run/template/xds-cluster/Chart.yaml"
test -f "$WORK/pull-run/template/values-16Node-je-cpp-bnt3.yaml"
test -f "$WORK/pull-run/template/model_arch-lt-je-cpp-bnt3.json"

PATH="$FAKE_BIN:$PATH" FAKE_IMAGE_ROOT="$FAKE_IMAGE_ROOT" \
RUN_DIR="$WORK/pull-run-injected" TARGET_IP="192.0.2.10" TARGET_USER=root TARGET_PASSWORD=test \
IMAGE_NAME="registry.example.com/xds" IMAGE_TAG="test" \
env -u CHART_TEMPLATE_DIR -u VALUES_TEMPLATE -u ARCH_FILE \
  bash "$SCRIPTS/pull-image.sh" "" >"$WORK/pull-injected.out"
grep -qx 'DEPLOY_IMAGE=registry.example.com/xds:test' "$WORK/pull-injected.out"

echo "PASS: pull-image exports all three immutable template inputs"

CAPTURE_DIR="$WORK/capture"
mkdir -p "$CAPTURE_DIR"
cat >"$FAKE_BIN/helm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$CAPTURE_DIR/helm.args"
EOF
cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
all="$*"
payload=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  case "${args[$i]}" in
    --data-binary)
      payload="${args[$((i+1))]#@}"
      ;;
    --data-raw|-d)
      payload="${args[$((i+1))]}"
      ;;
  esac
done
case "$all" in
  *"/models/architectures"*) cp "$payload" "$CAPTURE_DIR/registered-arch.json"; echo '{"ok":true}' ;;
  *"/models/"*)
    if [[ -n "$payload" ]]; then
      cp "$payload" "$CAPTURE_DIR/registered-model.json"; echo '{"ok":true}'
    elif [[ "$all" == *"/models/" ]]; then
      echo '[]'
    else
      echo '{"status":"ACTIVE"}'
    fi ;;
  *"/chat/completions"*) echo '{"choices":[{"message":{"content":"ok"}}]}' ;;
  *) echo '{}' ;;
esac
EOF
chmod +x "$FAKE_BIN/helm" "$FAKE_BIN/curl"

set -a
source <(grep -E '^(RUN_DIR|CHART_DIR|VALUES_FILE|ARCH_REQUEST_FILE|RESOURCE_MANIFEST|ARCH_FILE|ARCH_NAME|NAMESPACE|RELEASE_NAME)=' "$WORK/render.out")
set +a
PATH="$FAKE_BIN:$PATH" CAPTURE_DIR="$CAPTURE_DIR" XDS_URL="http://xds.test/xds/v1" DEPLOY_ON_TARGET_HOST=1 \
  TARGET_HOSTS='[{"ip":"192.0.2.10","user":"root","pass":"test"}]' HEAD_LOG_ROOT="$WORK/head-logs" \
  RELEASE_CLEANUP_TIMEOUT_SECONDS=1 RELEASE_CLEANUP_POLL_SECONDS=1 \
  XDS_READY_TIMEOUT_SECONDS=1 XDS_READY_POLL_SECONDS=1 \
  TASK_EXECUTOR_READY_TIMEOUT_SECONDS=1 TASK_EXECUTOR_READY_POLL_SECONDS=1 \
  timeout 8s bash "$SCRIPTS/deploy-model.sh" >"$WORK/deploy.out" || { cat "$WORK/deploy.out" >&2; exit 1; }
grep -q -- "install $RELEASE_NAME $CHART_DIR --namespace $NAMESPACE --create-namespace --values $VALUES_FILE" "$CAPTURE_DIR/helm.args"
cmp "$ARCH_REQUEST_FILE" "$CAPTURE_DIR/registered-arch.json"

PATH="$FAKE_BIN:$PATH" CAPTURE_DIR="$CAPTURE_DIR" XDS_URL="http://xds.test/xds/v1" \
  MODEL_NAME="glm52-test" MODEL_PATH="/models/glm52" \
  bash "$SCRIPTS/register-model.sh" >"$WORK/register.out"
python3 - "$CAPTURE_DIR/registered-model.json" "$RESOURCE_MANIFEST" <<'PY'
import json
import sys
model = json.load(open(sys.argv[1]))
manifest = json.load(open(sys.argv[2]))
assert model["model"] == "glm52-test"
assert model["local_info"]["path"] == "/models/glm52"
assert model["resource_list"] == [{k: r[k] for k in ("resource_id", "resource_type", "resource_status", "resource_bundles")} for r in manifest["resources"]]
PY

PATH="$FAKE_BIN:$PATH" CAPTURE_DIR="$CAPTURE_DIR" XDS_URL="http://xds.test/xds/v1" \
  MODEL_NAME="glm52-test" bash "$SCRIPTS/model-health.sh" >"$WORK/health.out"
grep -q 'model is healthy' "$WORK/health.out"

python3 - "$WORK" "$SCRIPTS/render-config.sh" <<'PY_ARCH'
import json, os, pathlib, subprocess, sys, yaml
work=pathlib.Path(sys.argv[1])
arch=json.loads((work/'model_arch.json').read_text())
p,d=arch[0]['deploy_spec_packages'][0]['deploy_specs']
p.update(min=2,max=5,default=3)
p['resources'][0]['memory']='1410G'
d['resources'][0]['gpu']=2
d['params']={'tensor_parallel_size':2,'pipeline_parallel_size':1,'data_parallel_size':1}
source=work/'inherit.json';source.write_text(json.dumps(arch))
env=dict(os.environ, RUN_DIR=str(work/'inherit'), RENDER_DIR=str(work/'inherit/rendered'),
 CHART_TEMPLATE_DIR=str(work/'xds-cluster'), VALUES_TEMPLATE=str(work/'values.template.yaml'),
 ARCH_FILE=str(source), ARCH_NAME='glm-5.2-nvfp4', TARGET_HOSTS='[{"ip":"192.0.2.10"}]',
 DEPLOY_IMAGE='registry.example.com/xds:test')
for key in ('NUM_PREFILL','NUM_DECODE','PREFILL_GPU','DECODE_GPU','PREFILL_OVERRIDES_JSON','DECODE_OVERRIDES_JSON'):
 env.pop(key,None)
subprocess.run(['bash',sys.argv[2]],env=env,check=True,stdout=subprocess.DEVNULL)
render=work/'inherit/rendered'
actual=json.loads((render/'architecture.request.json').read_text())
assert actual['deploy_spec_packages']==arch[0]['deploy_spec_packages']
groups=yaml.safe_load((render/'values.rendered.yaml').read_text())['taskExecutorGroups']
assert len(groups)==4
for g in groups[:3]:
 assert g['containerResources']['requests']['memory']=='1410G'
 assert g['containerResources']['limits']['memory']=='1410G'
 assert g['containerResources']['requests']['nvidia.com/gpu']==4
assert groups[3]['containerResources']['requests']['nvidia.com/gpu']==2
assert groups[3]['containerResources']['requests']['memory']=='200G'
p['default']=6
source.write_text(json.dumps(arch))
failed=subprocess.run(['bash',sys.argv[2]],env=env,capture_output=True,text=True)
assert failed.returncode!=0 and 'min <= default <= max' in failed.stderr
print('PASS: arch resources, 3P1D defaults, parallel params and replica bounds')
PY_ARCH

echo "PASS: deployment, registration, and health scripts consume the rendered contract"
