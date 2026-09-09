#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pull_render_config.sh"
pull_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pull-image.sh"

grep -Fq '|| TARGET_RUN_DIR="/tmp/op-test-pipeline/${PIPELINE_NAME}"' "$script"
grep -Fq '|| TARGET_RENDER_DIR="${TARGET_RUN_DIR}/rendered"' "$script"
grep -Fq '|| TARGET_PIPELINE_ENV_FILE="${TARGET_RUN_DIR}/pipeline.env"' "$script"
grep -Fq 'sync_rendered_to_targets()' "$script"
grep -Fq 'tar -C "$RENDER_DIR" -cf - .' "$script"
grep -Fq 'TARGET_HOSTS must be a non-empty JSON array' "$script"
grep -Fq 'sshpass -e ssh -p "$port" -o StrictHostKeyChecking=no' "$script"
grep -Fq 'TARGET_RUN_DIR TARGET_RENDER_DIR' "$script"
grep -Fq 'TARGET_PIPELINE_ENV_FILE SSH_PASSWORD' "$script"
grep -Fq 'safe_target_hosts=' "$script"
grep -Fq "printf 'export TARGET_HOSTS=%q\\n' \"\$safe_target_hosts\"" "$script"

if grep -Eq 'remote_bash|pull_image_on_target|export_templates_from_control_target' "$pull_script"; then
  echo 'image pull and template export must run on the pipeline execution host' >&2
  exit 1
fi

grep -Fq 'nerdctl --namespace k8s.io pull "$image"' "$pull_script"
grep -Fq 'nerdctl --namespace k8s.io create --net=none' "$pull_script"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
fake_bin="$work_dir/bin"
template_dir="$work_dir/template-source"
mkdir -p "$fake_bin" "$template_dir/xds-cluster"

cat >"$template_dir/xds-cluster/Chart.yaml" <<'EOF'
apiVersion: v2
name: xds-test
version: 0.1.0
EOF
cat >"$template_dir/values.yaml" <<'EOF'
frameworkConfigFiles:
  xds_framework.conf: "mock_db = false\n"
common:
  containerEnv: []
EOF
cat >"$template_dir/architectures.json" <<'EOF'
{"architectures":[{"arch_name":"test-arch","deploy_spec_packages":[{"deploy_specs":[{"name":"prefill","role":"prefill","min":1,"max":1,"default":1,"resources":[{"gpu":1,"cpu":1,"memory":"1G"}]},{"name":"decode","role":"decode","min":1,"max":1,"default":1,"resources":[{"gpu":1,"cpu":1,"memory":"1G"}]}]}]}]}
EOF
cat >"$fake_bin/nerdctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${3:-}" in
  image) exit 0 ;;
  create|rm) exit 0 ;;
  cp)
    case "$4" in
      *'/xds_template/k8s/xds-cluster') cp -a "$FAKE_TEMPLATE_DIR/xds-cluster" "$5" ;;
      *'/values-16Node-je-cpp-bnt3.yaml') cp -a "$FAKE_TEMPLATE_DIR/values.yaml" "$5" ;;
      *'/model_arch-lt-je-cpp-bnt3.json') cp -a "$FAKE_TEMPLATE_DIR/architectures.json" "$5" ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
EOF
cat >"$fake_bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
while [[ "$1" == -* ]]; do
  if [[ "$1" == "-o" ]]; then
    shift 2
  elif [[ "$1" == "-p" ]]; then
    printf '%s\n' "$2" >>"$SSH_PORT_LOG"
    shift 2
  else
    shift
  fi
done
shift
bash -c "$1"
EOF
chmod 0755 "$fake_bin/nerdctl" "$fake_bin/ssh"

PATH="$fake_bin:$PATH" \
FAKE_TEMPLATE_DIR="$template_dir" \
SSH_PORT_LOG="$work_dir/ssh-ports.log" \
IMAGE_NAME='registry.example/xds:test' \
ARCH_NAME='test-arch' \
PIPELINE_NAME='target-sync-test' \
RUN_DIR="$work_dir/execution-run" \
TARGET_RUN_DIR="$work_dir/target-run" \
TARGET_HOSTS='[{"ip":"127.0.0.1","user":"root","pass":"must-not-be-copied"}]' \
bash "$script" >/dev/null

test -f "$work_dir/target-run/rendered/xds-cluster/Chart.yaml"
test -f "$work_dir/target-run/rendered/values.rendered.yaml"
test -f "$work_dir/target-run/rendered/architecture.request.json"
test -f "$work_dir/target-run/pipeline.env"
grep -Fq "export RENDER_DIR=$work_dir/target-run/rendered" "$work_dir/target-run/pipeline.env"
if grep -Fq 'must-not-be-copied' "$work_dir/target-run/pipeline.env"; then
  echo 'target pipeline environment must not contain SSH passwords' >&2
  exit 1
fi

PATH="$fake_bin:$PATH" \
FAKE_TEMPLATE_DIR="$template_dir" \
SSH_PORT_LOG="$work_dir/ssh-ports.log" \
IMAGE_NAME='registry.example/xds:test' \
ARCH_NAME='test-arch' \
PIPELINE_NAME='target-port-test' \
RUN_DIR="$work_dir/port-execution-run" \
TARGET_RUN_DIR="$work_dir/port-target-run" \
TARGET_HOSTS='[{"ip":"127.0.0.1:2222","user":"root"}]' \
bash "$script" >/dev/null

grep -Fxq '2222' "$work_dir/ssh-ports.log"

PATH="$fake_bin:$PATH" \
FAKE_TEMPLATE_DIR="$template_dir" \
SSH_PORT_LOG="$work_dir/ssh-ports.log" \
IMAGE_NAME='registry.example/xds:test' \
ARCH_NAME='test-arch' \
PIPELINE_NAME='target-ips-port-test' \
RUN_DIR="$work_dir/target-ips-execution-run" \
TARGET_RUN_DIR="$work_dir/target-ips-target-run" \
TARGET_IP='127.0.0.1:2223' \
TARGET_IPS='["127.0.0.1:2223"]' \
bash "$script" >/dev/null

grep -Fxq '2223' "$work_dir/ssh-ports.log"

echo "pull-render target-sync tests passed"
