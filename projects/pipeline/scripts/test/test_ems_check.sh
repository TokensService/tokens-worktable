#!/usr/bin/env bash
set -euo pipefail

# ems-check.sh（step 主脚本）契约测试：mock kubectl/helm 提供固定集群数据，验证
#   ① 实例清单与版本标注（chart/app/镜像）；② 每节点大页已分配只统计真实请求；
#   ③ 空壳/遗留识别；④ 客户端 pod；⑤ 目标节点定位（TARGET_IPS 多目标/单 TARGET_IP/
#   未注入回退本机）；⑥ KEY=VALUE 契约；⑦ 参数面（EMS_NAME/EMS_RELEASE_NAMESPACES）；
# 全程只读，不访问真实集群。

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/ems-check.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"; [[ -z "$chart_created" ]] || rm -rf "$chart_dir"' EXIT
export FIXTURES="$tmp"

# 厂商 chart 不入 git（含证书私钥），但 dispatch 模式从 <脚本目录>/ems-chart/Chart.yaml
# 读取门禁期望版本；测试自建等价 fixture 使门禁版本比对链路可被覆盖——已存在真实
# chart（部署/开发机）则原样保留，退出时仅清理本测试创建的目录。
chart_dir="$script_dir/ems-chart"
chart_created=''
if [[ ! -f "$chart_dir/Chart.yaml" ]]; then
  mkdir -p "$chart_dir"
  cat >"$chart_dir/Chart.yaml" <<'YAML'
apiVersion: v2
name: ems
version: 26.8.0-b6
YAML
  chart_created=1
fi

# ---- fixtures ------------------------------------------------------------------
cat >"$tmp/nodes.json" <<'JSON'
{"items": [
  {"metadata": {"name": "node-1", "labels": {"ems8": "true"}},
   "status": {"addresses": [{"type": "Hostname", "address": "node-1"}, {"type": "InternalIP", "address": "10.0.0.1"}],
              "capacity": {"hugepages-2Mi": "2000Gi"},
              "allocatable": {"cpu": "256", "memory": "3022834496Ki", "hugepages-2Mi": "2000Gi"}}},
  {"metadata": {"name": "node-2", "labels": {"ems8": "true"}},
   "status": {"addresses": [{"type": "Hostname", "address": "node-2"}, {"type": "InternalIP", "address": "10.0.0.2"}],
              "capacity": {"hugepages-2Mi": "2000Gi"},
              "allocatable": {"cpu": "256", "memory": "3022834496Ki", "hugepages-2Mi": "2000Gi"}}},
  {"metadata": {"name": "node-3", "labels": {}},
   "status": {"addresses": [{"type": "Hostname", "address": "node-3"}, {"type": "InternalIP", "address": "10.0.0.3"}],
              "capacity": {"hugepages-2Mi": "2000Gi"},
              "allocatable": {"cpu": "256", "memory": "3022834496Ki", "hugepages-2Mi": "2000Gi"}}},
  {"metadata": {"name": "node-4", "labels": {}},
   "status": {"addresses": [{"type": "Hostname", "address": "node-4"}, {"type": "InternalIP", "address": "10.0.0.4"}],
              "capacity": {"hugepages-2Mi": "2000Gi"},
              "allocatable": {"cpu": "256", "memory": "3022834496Ki", "hugepages-2Mi": "2000Gi"}}},
  {"metadata": {"name": "node-5", "labels": {}},
   "status": {"addresses": [{"type": "Hostname", "address": "node-5"}, {"type": "InternalIP", "address": "10.0.0.5"}],
              "capacity": {"hugepages-2Mi": "2000Gi"},
              "allocatable": {"cpu": "256", "memory": "3022834496Ki", "hugepages-2Mi": "2000Gi"}}}
]}
JSON

# make_pod <name> <ns> <node> <container> <image> <phase> <mounts> <hp-request> [cpu] [mem]
make_pod() {
  local name=$1 ns=$2 node=$3 container=$4 image=$5 phase=$6 mounts=${7:-} hp=${8:-} cpu=${9:-} mem=${10:-}
  local mount_json='[]' requests='{}' cs_state
  [[ -n "$mounts" ]] && mount_json="[{\"mountPath\": \"$mounts\"}]"
  local -a req_parts=()
  [[ -n "$hp" ]] && req_parts+=("\"hugepages-2Mi\": \"$hp\"")
  [[ -n "$cpu" ]] && req_parts+=("\"cpu\": \"$cpu\"")
  [[ -n "$mem" ]] && req_parts+=("\"memory\": \"$mem\"")
  ((${#req_parts[@]})) && requests="{"$(IFS=,; echo "${req_parts[*]}")"}"
  local start_json=''
  if [[ "$phase" == Running ]]; then
    cs_state='"ready": true, "restartCount": 0'
    start_json=', "startTime": "2026-09-20T10:00:00Z"'
  else
    cs_state='"ready": false, "restartCount": 0, "state": {"waiting": {"reason": "InsufficientHugepages", "message": "1 Insufficient hugepages-2Mi"}}'
  fi
  printf '{"metadata": {"name": "%s", "namespace": "%s"}, "spec": {"nodeName": "%s", "containers": [{"name": "%s", "image": "%s", "volumeMounts": %s, "resources": {"requests": %s}}]}, "status": {"phase": "%s"%s, "conditions": [{"type": "Ready", "status": "%s"}], "containerStatuses": [{"name": "%s", "image": "%s", %s}]}}' \
    "$name" "$ns" "$node" "$container" "$image" "$mount_json" "$requests" "$phase" "$start_json" \
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
out=$(ems_team_nodes=10.0.0.1,10.0.0.2 TARGET_IP=10.0.0.1 TARGET_IPS='["10.0.0.1","10.0.0.2","10.9.9.9"]' bash "$script") || {
  echo "default run failed:" >&2; echo "$out" >&2; exit 1
}

grep -Fq '=== EMS 健康实例（团队设备，1 个） ===' <<<"$out"
grep -Eq '\[1\] ems8-8 · chart 26\.8\.0-b6 · 运行 [0-9]+d' <<<"$out"
grep -Fq '节点: 10.0.0.1（大页已分配 2000Gi） · 10.0.0.2（大页已分配 2000Gi）' <<<"$out"
grep -Fq '[!] ems9-9 异常（0/1 Running&Ready）' <<<"$out"
grep -Fq '（另有遗留：空壳 ns 1 个 · 孤儿 release 1 个，略）' <<<"$out"
! grep -Fq '镜像:' <<<"$out"
! grep -Fq 'helm release:' <<<"$out"
! grep -Fq 'InsufficientHugepages' <<<"$out"
grep -Fq '目标节点（TARGET_IP/TARGET_IPS，共 3 个）' <<<"$out"
grep -Fq '10.0.0.1 → 10.0.0.1: 属于 ems8-8' <<<"$out"
grep -Eq '属于 ems8-8（chart 26\.8\.0-b6 · 运行 [0-9]+d[0-9]+h · 节点 2 台）' <<<"$out"
grep -Fq '10.0.0.2 → 10.0.0.2: 属于 ems8-8' <<<"$out"
! grep -Fq '实例在非团队设备上' <<<"$out"
grep -Fq '10.9.9.9: 不是本集群节点' <<<"$out"
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
out2=$(env -u TARGET_IPS ems_team_nodes=10.0.0.1,10.0.0.2 TARGET_IP=10.0.0.3 bash "$script")
grep -Fq '10.0.0.3 → 10.0.0.3（非团队设备）: 不属于任何 EMS 实例' <<<"$out2"
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
case "\$cmd" in
  *'hostname -I'*)
    # 身份采集：有 fixture 定义则返回，否则空（entry 不进映射，不影响内网直接命中）
    target=''; port=''; prev=''
    for a in "\$@"; do [[ "\$prev" == -p ]] && port="\$a"; [[ "\$a" == *@* ]] && target="\$a"; prev="\$a"; done
    cat "\$FIXTURES/hostid\${target#*@}:\${port:-22}" 2>/dev/null
    exit 0 ;;
esac
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
grep -Fq '10.0.0.1 → 10.0.0.1（非团队设备）: 属于 ems8-8' <<<"$out5"
grep -Fq 'EMS_TARGET_INSTANCE=ems8-8' <<<"$out5"
grep -Fq 'EMS_TARGET_POD_HEALTH=8/8' <<<"$out5"
grep -q 'TARGET_HOSTS=' "$tmp/ssh.log"
grep -q 'TARGET_IP=10.0.0.1' "$tmp/ssh.log"
# 分发后远程侧不再二次分发（TARGET_HOSTS 已清空；ssh = 探测 kubectl + 身份采集 + 远程执行）
[[ "$(grep -c '^ssh ' "$tmp/ssh.log")" -le 3 ]] || { echo 'unexpected recursive dispatch' >&2; exit 1; }

# ---- ⑥ 退出码：正常 0（异常实例仅报告，不影响退出码） ------------------------------
env -u TARGET_IPS TARGET_IP=10.0.0.1 bash "$script" >/dev/null 2>&1 || { echo 'expected exit code 0' >&2; exit 1; }

# ---- ⑦ 参数面断言：零参数（2026-10 起 ems-check 只做只读巡检，门禁已下移 ems-deploy）----
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
assert params == [], f'参数面应为空（零参数）: {params}'
EOF

echo 'PASS: ems-check step contract (inventory, versions, shells, target placement, dispatch, exit code, zero-param surface)'
