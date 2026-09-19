#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/pull-image.sh"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

fake_bin="$work_dir/bin"
template_dir="$work_dir/template-source"
run_dir="$work_dir/run"
mkdir -p "$fake_bin" "$template_dir/xds-cluster"

cat >"$template_dir/xds-cluster/Chart.yaml" <<'EOF'
apiVersion: v2
name: xds-test
version: 0.1.0
EOF
printf 'common: {}\n' >"$template_dir/values.yaml"
printf '{"architectures": []}\n' >"$template_dir/architectures.json"

cat >"$fake_bin/nerdctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${3:-}" in
  image) exit 0 ;;
  create|rm) exit 0 ;;
  start)
    printf '%s\n' \
      /srv/xds-assets/xds_template/k8s/xds-cluster \
      /srv/xds-assets/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml \
      /srv/xds-assets/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json
    ;;
  cp)
    case "$4" in
      *'/opt/deploy_template/'*|*'/opt/op_test/'*) exit 1 ;;
      *'/srv/xds-assets/xds_template/k8s/xds-cluster') cp -a "$FAKE_TEMPLATE_DIR/xds-cluster" "$5" ;;
      *'/srv/xds-assets/xds_template_values/xds-cluster-low-latency/k8s/values-16Node-je-cpp-bnt3.yaml') cp -a "$FAKE_TEMPLATE_DIR/values.yaml" "$5" ;;
      *'/srv/xds-assets/xds_template/cap/model_arch/model_arch-lt-je-cpp-bnt3.json') cp -a "$FAKE_TEMPLATE_DIR/architectures.json" "$5" ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
EOF
chmod 0755 "$fake_bin/nerdctl"

PATH="$fake_bin:$PATH" \
FAKE_TEMPLATE_DIR="$template_dir" \
IMAGE_NAME='registry.example/xds:test' \
RUN_DIR="$run_dir" \
bash "$script" >/dev/null

test -f "$run_dir/template/xds-cluster/Chart.yaml"
test -f "$run_dir/template/values-16Node-je-cpp-bnt3.yaml"
test -f "$run_dir/template/model_arch-lt-je-cpp-bnt3.json"

echo 'pull template auto-discovery test passed'
