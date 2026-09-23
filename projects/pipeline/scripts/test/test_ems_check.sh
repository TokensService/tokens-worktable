#!/usr/bin/env bash
set -euo pipefail

# ems-check.sh（step 主脚本）契约测试：mock kubectl/helm 提供固定集群数据，验证
#   ① 实例清单与版本标注（chart/app/镜像）；② 每节点大页已分配只统计真实请求；
#   ③ 空壳/遗留识别；④ 客户端 pod；⑤ 目标节点定位（TARGET_IPS 多目标/单 TARGET_IP/
#   未注入回退本机）；⑥ KEY=VALUE 契约；⑦ STRICT 门禁退出码。
# 全程只读，不访问真实集群。

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/ems-check.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export FIXTURES="$tmp"

# ---- fixtures ------------------------------------------------------------------
cat >"$tmp/nodes.json" <<'JSON'
{"items": [
  {"metadata": {"name": "node-1", "labels": {"ems8": "true"}},
   "status": {"addresses": [{"type": "Hostname", "address": "node-1"}, {"type": "InternalIP", "address": "10.0.0.1"}],
              "capacity": {"hugepages-2Mi": "2000Gi"}, "allocatable": {"hugepages-2Mi": "2000Gi"}}},
  {"metadata": {"name": "node-2", "labels": {"ems8": "true"}},
   "status": {"addresses": [{"type": "Hostname", "address": "node-2"}, {"type": "InternalIP", "address": "10.0.0.2"}],
              "capacity": {"hugepages-2Mi": "2000Gi"}, "allocatable": {"hugepages-2Mi": "2000Gi"}}},
  {"metadata": {"name": "node-3", "labels": {}},
   "status": {"addresses": [{"type": "Hostname", "address": "node-3"}, {"type": "InternalIP", "address": "10.0.0.3"}],
              "capacity": {"hugepages-2Mi": "0"}, "allocatable": {"hugepages-2Mi": "0"}}}
]}
JSON

# make_pod <name> <ns> <node> <container> <image> <phase> <mounts> <hp-request>
make_pod() {
  local name=$1 ns=$2 node=$3 container=$4 image=$5 phase=$6 mounts=${7:-} hp=${8:-}
  local mount_json='[]' requests='{}' cs_state
  [[ -n "$mounts" ]] && mount_json="[{\"mountPath\": \"$mounts\"}]"
  [[ -n "$hp" ]] && requests="{\"hugepages-2Mi\": \"$hp\"}"
  if [[ "$phase" == Running ]]; then
    cs_state='"ready": true, "restartCount": 0'
  else
    cs_state='"ready": false, "restartCount": 0, "state": {"waiting": {"reason": "InsufficientHugepages", "message": "1 Insufficient hugepages-2Mi"}}'
  fi
  printf '{"metadata": {"name": "%s", "namespace": "%s"}, "spec": {"nodeName": "%s", "containers": [{"name": "%s", "image": "%s", "volumeMounts": %s, "resources": {"requests": %s}}]}, "status": {"phase": "%s", "conditions": [{"type": "Ready", "status": "%s"}], "containerStatuses": [{"name": "%s", "image": "%s", %s}]}}' \
    "$name" "$ns" "$node" "$container" "$image" "$mount_json" "$requests" "$phase" \
    "$([[ $phase == Running ]] && echo True || echo False)" "$container" "$image" "$cs_state"
}

{
  printf '['
  make_pod ems-controller-0    ems8-8 node-1 ems-controller swr.example/xms/ems-controller:26.8.0-b6 Running
  printf ', '; make_pod ems-zookeeper-0   ems8-8 node-1 zookeeper     swr.example/xms/ems-zookeeper:26.8.0-b6 Running
  printf ', '; make_pod ems-zookeeper-1   ems8-8 node-2 zookeeper     swr.example/xms/ems-zookeeper:26.8.0-b6 Running
  printf ', '; make_pod ems-zookeeper-2   ems8-8 node-2 zookeeper     swr.example/xms/ems-zookeeper:26.8.0-b6 Running
  printf ', '; make_pod ems-server-node-1 ems8-8 node-1 ray-worker    swr.example/xms/ems-server:26.8.0-b6    Running /dev/shm/ems 2000Gi
  printf ', '; make_pod ems-server-node-2 ems8-8 node-2 ray-worker    swr.example/xms/ems-server:26.8.0-b6    Running /dev/shm/ems 2000Gi
  printf ', '; make_pod ems-init-node-1   ems8-8 node-1 ems-init      swr.example/xms/ems-init:26.8.0-b6      Running
  printf ', '; make_pod ems-init-node-2   ems8-8 node-2 ems-init      swr.example/xms/ems-init:26.8.0-b6      Running
  printf ', '; make_pod ems-server-node-3 ems9-9 ''     ray-worker    swr.example/xms/ems-server:26.8.0-b6    Pending  /dev/shm/ems 2000Gi
  printf ', '; make_pod xds-w0             app-xds node-3 ray-worker  swr.example/xds/runtime:latest          Running /dev/shm/ems
  printf ']\n'
} | python3 -c 'import json,sys; json.dump({"items": json.load(sys.stdin)}, sys.stdout)' >"$tmp/pods.json"

cat >"$tmp/namespaces.json" <<'JSON'
{"items": [
  {"metadata": {"name": "default"}}, {"metadata": {"name": "kube-system"}},
  {"metadata": {"name": "ems8"}}, {"metadata": {"name": "ems9"}},
  {"metadata": {"name": "ems8-8"}}, {"metadata": {"name": "ems9-9"}},
  {"metadata": {"name": "ems"}}
]}
JSON

cat >"$tmp/helm.json" <<'JSON'
[
  {"name": "ems8-8", "namespace": "ems8", "revision": "1", "status": "deployed", "chart": "ems-chart-26.8.0-b6", "app_version": "26.8.0-b6", "updated": "2026-09-20T10:00:00Z"},
  {"name": "ems9-9", "namespace": "ems9", "revision": "1", "status": "deployed", "chart": "ems-chart-26.8.0-b6", "app_version": "26.8.0-b6", "updated": "2026-09-21T10:00:00Z"},
  {"name": "ems243", "namespace": "default", "revision": "1", "status": "deployed", "chart": "ems-chart-26.8.0-b6", "app_version": "26.8.0-b6", "updated": "2026-09-01T10:00:00Z"}
]
JSON

# ---- mock kubectl / helm --------------------------------------------------------
mkdir -p "$tmp/bin"
cat >"$tmp/bin/kubectl" <<EOF
#!/usr/bin/env bash
if [[ "\$1 \$2" == 'version --request-timeout=5s' ]]; then exit 0; fi
case "\$*" in
  *'get nodes'*)              cat "\$FIXTURES/nodes.json" ;;
  *'get pods -A'*)            cat "\$FIXTURES/pods.json" ;;
  *'get namespaces'*)         cat "\$FIXTURES/namespaces.json" ;;
  *) echo "unexpected kubectl call: \$*" >&2; exit 1 ;;
esac
EOF
cat >"$tmp/bin/helm" <<EOF
#!/usr/bin/env bash
[[ "\$1" == 'list' ]] || { echo "unexpected helm call: \$*" >&2; exit 1; }
cat "\$FIXTURES/helm.json"
EOF
chmod +x "$tmp/bin/kubectl" "$tmp/bin/helm"
PATH="$tmp/bin:$PATH"
export PATH
# ---- ① step 场景：平台注入 TARGET_IP + TARGET_IPS（多目标，含命中/未命中/非集群节点） ----
out=$(TARGET_IP=10.0.0.1 TARGET_IPS='["10.0.0.1","10.0.0.2","10.9.9.9"]' bash "$script") || {
  echo "default run failed:" >&2; echo "$out" >&2; exit 1
}

grep -Fq '[1] ems8-8' <<<"$out"
grep -Fq 'chart ems-chart-26.8.0-b6 · app 26.8.0-b6' <<<"$out"
grep -Fq '8/8 Running&Ready（controller 1 · init 2 · server 2 · zookeeper 3）' <<<"$out"
grep -Fq 'swr.example/xms/ems-server:26.8.0-b6' <<<"$out"
grep -Fq 'allocatable 2000Gi · 已分配 2000Gi (100%)' <<<"$out"
grep -Fq 'ns:           ems' <<<"$out"
grep -Fq 'helm release: ems243 (存放 ns default)' <<<"$out"
! grep -Fq 'EMS 客户端' <<<"$out"
grep -Fq 'InsufficientHugepages (1 Insufficient hugepages-2Mi)' <<<"$out"
grep -Fq '目标节点定位（TARGET_IP/TARGET_IPS，共 3 个）' <<<"$out"
grep -Fq '10.0.0.1 → node-1: ems8-8（label ems8）' <<<"$out"
grep -Fq '10.0.0.2 → node-2: ems8-8（label ems8）' <<<"$out"
grep -Fq '10.9.9.9: 不是本集群节点' <<<"$out"
grep -Fq -- '--- 节点 node-1 视角（实例 ems8-8） ---' <<<"$out"
grep -Fq '角色:  controller+init+server+zookeeper' <<<"$out"
grep -Fq 'EMS_INSTANCE_COUNT=2' <<<"$out"
grep -Fq 'EMS_INSTANCES=ems8-8,ems9-9' <<<"$out"
grep -Fq 'EMS_HEALTHY_COUNT=1' <<<"$out"
grep -Fq 'EMS_UNHEALTHY=ems9-9' <<<"$out"
grep -Fq 'EMS_TARGET_TOTAL=3' <<<"$out"
grep -Fq 'EMS_TARGET_MATCHED=2' <<<"$out"
grep -Fq 'EMS_TARGET_INSTANCE=ems8-8' <<<"$out"
grep -Fq 'EMS_TARGET_LABEL_KEY=ems8' <<<"$out"
grep -Fq 'EMS_TARGET_CHART_VERSION=26.8.0-b6' <<<"$out"
grep -Fq 'EMS_TARGET_POD_HEALTH=8/8' <<<"$out"

# ---- ② 仅 TARGET_IP（无 TARGET_IPS）：目标不在任何实例 -----------------------------
out2=$(env -u TARGET_IPS TARGET_IP=10.0.0.3 bash "$script")
grep -Fq '10.0.0.3 → node-3: 不在任何 EMS 实例中' <<<"$out2"
grep -Fq 'EMS_TARGET_TOTAL=1' <<<"$out2"
grep -Fq 'EMS_TARGET_MATCHED=0' <<<"$out2"
! grep -Fq 'EMS_TARGET_INSTANCE=' <<<"$out2"

# ---- ③ 未注入 TARGET_*：回退本机识别（真实主机不在 fixture 集群中） ------------------
out3=$(env -u TARGET_IPS -u TARGET_IP bash "$script")
grep -Fq '未注入 TARGET_IP/TARGET_IPS，回退执行机定位' <<<"$out3"
grep -Fq '不是本集群节点' <<<"$out3"
grep -Fq 'EMS_INSTANCE_COUNT=2' <<<"$out3"

# ---- ⑤ TARGET_HOSTS 分发：自推送到首个有 kubectl 的目标节点执行 ------------------
export REAL_SCRIPT="$script"
cat >"$tmp/bin/ssh" <<EOF
#!/usr/bin/env bash
echo "ssh \$*" >>"\$FIXTURES/ssh.log"
cmd="\${@: -1}"
cmd="\$(sed "s|/tmp/ems-check.sh|\$REAL_SCRIPT|" <<<"\$cmd")"
eval "\$cmd"
EOF
cat >"$tmp/bin/scp" <<EOF
#!/usr/bin/env bash
echo "scp \$*" >>"\$FIXTURES/ssh.log"
exit 0
EOF
chmod +x "$tmp/bin/ssh" "$tmp/bin/scp"
out5=$(TARGET_HOSTS='[{"ip":"10.0.0.1","user":"ops"}]' TARGET_IP=10.0.0.1 bash "$script") || {
  echo "dispatch run failed:" >&2; echo "$out5" >&2; exit 1
}
grep -Fq 'remote execution via ops@10.0.0.1:22' <<<"$out5"
grep -Fq '10.0.0.1 → node-1: ems8-8（label ems8）' <<<"$out5"
grep -Fq 'EMS_TARGET_INSTANCE=ems8-8' <<<"$out5"
grep -Fq 'EMS_TARGET_POD_HEALTH=8/8' <<<"$out5"
grep -q 'TARGET_HOSTS=' "$tmp/ssh.log"
grep -q 'TARGET_IP=10.0.0.1' "$tmp/ssh.log"
# 分发后远程侧不再二次分发（TARGET_HOSTS 已清空，不出现递归 ssh）
[[ "$(grep -c '^ssh ' "$tmp/ssh.log")" -le 2 ]] || { echo 'unexpected recursive dispatch' >&2; exit 1; }

# ---- ⑥ 退出码：正常 0（异常实例仅报告，不影响退出码） ------------------------------
env -u TARGET_IPS TARGET_IP=10.0.0.1 bash "$script" >/dev/null 2>&1 || { echo 'expected exit code 0' >&2; exit 1; }

# ---- ⑦ 零参数断言：模拟平台 detectParams（全大写 $VAR/${VAR:-}，排除 shell 内置与内部赋值变量） ----
python3 - "$script" <<'EOF'
import re
import sys

src = open(sys.argv[1], encoding='utf-8').read()
built = {'PATH', 'HOME', 'PWD', 'OLDPWD', 'USER', 'SHELL', 'LANG', 'TERM', 'RANDOM', 'LINENO',
         'IFS', 'PPID', 'UID', 'EUID', 'BASH', 'BASH_VERSION', 'BASH_SOURCE', 'BASH_LINENO',
         'FUNCNAME', 'PIPESTATUS', 'OSTYPE', 'HOSTNAME', 'HOSTTYPE', 'SHLVL', '_', 'SECONDS', 'EPOCHREALTIME'}
internal = set()
for m in re.finditer(r'^\s*(?:declare\s+(?:-[a-zA-Z]+\s+)?|local\s+|export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$', src, re.M):
    var, rhs = m.group(1), m.group(2).strip().strip('"\'')
    if not re.search(r'\$\{?' + var + r'\b', rhs):
        internal.add(var)
refs = set(re.findall(r'\$\{?([A-Za-z_][A-Za-z0-9_]*)', src))
params = sorted(v for v in refs if re.fullmatch(r'[A-Z_][A-Z0-9_]*', v) and v not in built and v not in internal)
assert not params, f'平台「识别参数」会显示入参: {params}'
EOF

echo 'PASS: ems-check step contract (inventory, versions, shells, target placement, dispatch, exit code, zero params)'
