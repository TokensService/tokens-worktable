#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/pull-image.sh"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin" "$work_dir/template/xds-cluster"

printf 'apiVersion: v2\nname: test\nversion: 0.1.0\n' >"$work_dir/template/xds-cluster/Chart.yaml"
printf 'common: {}\n' >"$work_dir/template/values.yaml"
printf '{"architectures": []}\n' >"$work_dir/template/architectures.json"

cat >"$work_dir/bin/nerdctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${3:-}" in
  image) exit 1 ;;
  pull|create|rm) exit 0 ;;
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
cat >"$work_dir/bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
while [[ "$1" == -* ]]; do
  if [[ "$1" == '-o' ]]; then shift 2
  elif [[ "$1" == '-p' ]]; then remote_port="$2"; printf '%s\n' "$2" >>"$SSH_PORT_LOG"; shift 2
  else shift
  fi
done
shift
REMOTE_PORT="$remote_port" bash -c "$1"
EOF
cat >"$work_dir/bin/ctr" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s\n' "${REMOTE_PORT:-}" "$*" >>"$CTR_LOG"
if [[ "$*" == '-n k8s.io images ls -q' && "${REMOTE_PORT:-}" == '2223' ]]; then
  printf '%s\n' 'swr.cn-southwest-2.myhuaweicloud.com/dataartsfabric/xds:test'
fi
EOF
cat >"$work_dir/bin/sudo" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF
chmod 0755 "$work_dir/bin/nerdctl" "$work_dir/bin/ssh" "$work_dir/bin/ctr" "$work_dir/bin/sudo"

PATH="$work_dir/bin:$PATH" \
FAKE_TEMPLATE_DIR="$work_dir/template" \
SSH_PORT_LOG="$work_dir/ssh-ports.log" \
CTR_LOG="$work_dir/ctr.log" \
IMAGE_NAME='swr.cn-southwest-2.myhuaweicloud.com/dataartsfabric/xds:test' \
RUN_DIR="$work_dir/run" \
TARGET_HOSTS='[{"ip":"115.33.98.101:2223","user":"root"},{"ip":"115.33.98.101:2222","user":"root"},{"ip":"115.33.98.101:2224","user":"root"}]' \
TARGET_NODE_IP_MAP='{"115.33.98.101:2223":"192.168.31.175","115.33.98.101:2222":"192.168.31.17"}' \
AK='test-ak' \
LOGIN_KEY='test-login-key' \
PULL_TARGET_IMAGES_ONLY=1 \
bash "$script" >/dev/null

grep -Fxq '2223' "$work_dir/ssh-ports.log"
grep -Fxq '2222' "$work_dir/ssh-ports.log"
if grep -Fxq '2224' "$work_dir/ssh-ports.log"; then
  echo 'unmapped SSH endpoint must not receive registry credentials' >&2
  exit 1
fi
expected_pull='-n k8s.io images pull --user cn-southwest-2@test-ak:test-login-key swr.cn-southwest-2.myhuaweicloud.com/dataartsfabric/xds:test'
if grep -Fxq "2223|$expected_pull" "$work_dir/ctr.log"; then
  echo 'mapped target pull must be skipped when the exact image already exists' >&2
  exit 1
fi
grep -Fxq "2222|$expected_pull" "$work_dir/ctr.log"
grep -Fxq '2223|-n k8s.io images ls -q' "$work_dir/ctr.log"
grep -Fxq '2222|-n k8s.io images ls -q' "$work_dir/ctr.log"

PATH="$work_dir/bin:$PATH" \
SSH_PORT_LOG="$work_dir/cached-without-credentials-ssh.log" \
CTR_LOG="$work_dir/cached-without-credentials-ctr.log" \
IMAGE_NAME='swr.cn-southwest-2.myhuaweicloud.com/dataartsfabric/xds:test' \
TARGET_HOSTS='[{"ip":"115.33.98.101:2223","user":"root"}]' \
TARGET_NODE_IP_MAP='{"115.33.98.101:2223":"192.168.31.175"}' \
PULL_TARGET_IMAGES_ONLY=1 \
bash "$script" >/dev/null
if grep -Fq 'images pull' "$work_dir/cached-without-credentials-ctr.log"; then
  echo 'cached mapped target must not require credentials or execute a pull' >&2
  exit 1
fi

missing_credentials_log="$work_dir/missing-credentials.log"
if PATH="$work_dir/bin:$PATH" \
  SSH_PORT_LOG="$work_dir/missing-credentials-ssh.log" \
  CTR_LOG="$work_dir/missing-credentials-ctr.log" \
  IMAGE_NAME='swr.cn-southwest-2.myhuaweicloud.com/dataartsfabric/xds:test' \
  TARGET_HOSTS='[{"ip":"115.33.98.101:2222","user":"root"}]' \
  TARGET_NODE_IP_MAP='{"115.33.98.101:2222":"192.168.31.17"}' \
  PULL_TARGET_IMAGES_ONLY=1 \
  bash "$script" >"$missing_credentials_log" 2>&1; then
  echo 'mapped target pull must fail when registry credentials are missing' >&2
  exit 1
fi
grep -Fq 'AK and LOGIN_KEY are required when the mapped target image is absent' "$missing_credentials_log"

echo 'pull target-image tests passed (cached images skip authenticated ctr pulls)'
