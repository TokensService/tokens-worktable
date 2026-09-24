#!/usr/bin/env bash
set -euo pipefail

# ems-check.sh（step 主脚本）契约测试：mock kubectl/helm 提供固定集群数据，验证
#   ① 实例清单与版本标注（chart/app/镜像）；② 每节点大页已分配只统计真实请求；
#   ③ 空壳/遗留识别；④ 客户端 pod；⑤ 目标节点定位（TARGET_IPS 多目标/单 TARGET_IP/
#   未注入回退本机）；⑥ KEY=VALUE 契约；⑦ 参数面（EMS_NAME/EMS_RELEASE_NAMESPACES）；
#   ⑧ 安装前门禁（新鲜通过/label 占用/节点占用+预授权/幂等判定/版本不一致/名字非法）。
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

# ---- ⑧ 门禁场景：EMS_NAME 填写即启用（编排：ems-check → ems-deploy）----------------
# ⑧a 新鲜可用：干净节点 + 未占用名字 → 通过，契约 EMS_GATE/EMS_IDEMPOTENT=0
outg=$(TARGET_IPS='["10.0.0.4","10.0.0.5"]' EMS_NAME=ems13-13 bash "$script") || {
  echo "gate fresh failed:" >&2; echo "$outg" >&2; exit 1
}
grep -Fq '=== 安装前门禁（预安装 ems13-13' <<<"$outg"
grep -Fq '[ok] label ems13=true 无外部占用' <<<"$outg"
grep -Fq '[ok] 名字可用（ns 与 release 均不存在）' <<<"$outg"
grep -Fq '[ok] node-4 资源余量：CPU 256C ≥ 41C · 内存 2882.8Gi ≥ 41Gi（大页另由 ems-hugepages step 保障）' <<<"$outg"
grep -Fq '门禁通过' <<<"$outg"
grep -Fq 'EMS_GATE=passed' <<<"$outg"
grep -Fq 'EMS_IDEMPOTENT=0' <<<"$outg"
grep -Fq 'EMS_NAME=ems13-13' <<<"$outg"
grep -Fq 'EMS_LABEL_KEY=ems13' <<<"$outg"
grep -Fq 'EMS_NODES=10.0.0.4,10.0.0.5' <<<"$outg"
! grep -Fq 'EMS_RELEASE_NAMESPACES=' <<<"$outg"     # 未配置不透传

# ⑧b label 被他人占用 → 失败
rc=0
TARGET_IPS='["10.0.0.4","10.0.0.5"]' EMS_NAME=ems8-8 bash "$script" >/dev/null 2>"$tmp/errg1" || rc=$?
[[ "$rc" == 1 ]] || { echo "gate label-conflict expected exit 1, got $rc" >&2; exit 1; }
grep -Fq 'label ems8=true 已被其他节点占用' "$tmp/errg1"
grep -Fq 'node-1' "$tmp/errg1"

# ⑧c 业务共存：node-1 上有 ems8-8 业务 pod（无 requests）但 CPU/内存余量充足 → 门禁放行
outg2=$(TARGET_IPS='["10.0.0.1","10.0.0.4"]' EMS_NAME=ems13-13 EMS_RELEASE_NAMESPACES=busy-ns bash "$script") || {
  echo "gate coexist failed:" >&2; echo "$outg2" >&2; exit 1
}
grep -Fq '[ok] node-1 资源余量：CPU 256C ≥ 41C' <<<"$outg2"
grep -Fq '门禁通过' <<<"$outg2"
grep -Fq 'EMS_RELEASE_NAMESPACES=busy-ns' <<<"$outg2"   # 释放预授权透传下游（deploy S1 据此删除）

# ⑧c2 资源余量不足 → 失败（CPU/内存被业务 requests 吃光）
cp "$tmp/pods.json" "$tmp/pods.json.orig"
python3 - "$tmp" <<'PY'
import json, sys
base = sys.argv[1]
doc = json.load(open(base + "/pods.json"))
doc["items"].append({"metadata": {"name": "hog-0", "namespace": "hog-ns"},
                     "spec": {"nodeName": "node-1", "containers": [{"name": "hog", "image": "hog:1",
                                "resources": {"requests": {"cpu": "250", "memory": "2900Gi"}}}]},
                     "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]}})
json.dump(doc, open(base + "/pods.json", "w"))
PY
rc=0
TARGET_IPS='["10.0.0.1","10.0.0.4"]' EMS_NAME=ems13-13 bash "$script" >/dev/null 2>"$tmp/errg2" || rc=$?
[[ "$rc" == 1 ]] || { echo "gate resource-cpu expected exit 1, got $rc" >&2; exit 1; }
grep -Fq 'node-1 资源余量不足：CPU 6C（需 41C）' "$tmp/errg2"
grep -Fq '不区分业务归属' "$tmp/errg2"
mv "$tmp/pods.json.orig" "$tmp/pods.json"

# ⑧c3 大页 allocatable 不足 → 门禁仍通过（大页由 ems-hugepages step 负责，不在此拦）
python3 - "$tmp" <<'PY'
import json, sys
base = sys.argv[1]
doc = json.load(open(base + "/nodes.json"))
for node in doc["items"]:
    if node["metadata"]["name"] == "node-4":
        node["status"]["allocatable"]["hugepages-2Mi"] = "1000Gi"
json.dump(doc, open(base + "/nodes.json", "w"))
PY
outg3b=$(TARGET_IPS='["10.0.0.4","10.0.0.5"]' EMS_NAME=ems13-13 bash "$script") || {
  echo "gate hp-low should still pass:" >&2; echo "$outg3b" >&2; exit 1
}
grep -Fq '门禁通过' <<<"$outg3b"
grep -Fq 'EMS_GATE=passed' <<<"$outg3b"
python3 - "$tmp" <<'PY'
import json, sys
base = sys.argv[1]
doc = json.load(open(base + "/nodes.json"))
for node in doc["items"]:
    if node["metadata"]["name"] == "node-4":
        node["status"]["allocatable"]["hugepages-2Mi"] = "2000Gi"
json.dump(doc, open(base + "/nodes.json", "w"))
PY

# ⑧d 幂等判定：健康同名安装（ems8-8，期望版本一致）→ EMS_IDEMPOTENT=1
outg3=$(TARGET_IPS='["10.0.0.1","10.0.0.2"]' EMS_NAME=ems8-8 ems_chart_expected=26.8.0-b6 bash "$script") || {
  echo "gate idempotent failed:" >&2; echo "$outg3" >&2; exit 1
}
grep -Fq '已健康安装（chart 26.8.0-b6），幂等重入' <<<"$outg3"
grep -Fq 'EMS_IDEMPOTENT=1' <<<"$outg3"
grep -Fq '门禁通过' <<<"$outg3"

# ⑧e 版本不一致 → 失败（升级是独立操作）
rc=0
TARGET_IPS='["10.0.0.1","10.0.0.2"]' EMS_NAME=ems8-8 ems_chart_expected=9.9.9 bash "$script" >/dev/null 2>"$tmp/errg3" || rc=$?
[[ "$rc" == 1 ]] || { echo "gate version-mismatch expected exit 1, got $rc" >&2; exit 1; }
grep -Fq '与仓内 9.9.9 不一致' "$tmp/errg3"

# ⑧f 名字格式非法 → 失败
rc=0
TARGET_IPS='["10.0.0.4","10.0.0.5"]' EMS_NAME=foo bash "$script" >/dev/null 2>&1 && rc=1
[[ "$rc" == 0 ]] || { echo "gate bad-name expected exit 1" >&2; exit 1; }

# ⑧g 门禁走 TARGET_HOSTS 分发：EMS_NAME/EMS_RELEASE_NAMESPACES/期望版本随 env 转发远端执行
outg4=$(TARGET_HOSTS='[{"ip":"10.0.0.1","user":"ops"}]' TARGET_IPS='["10.0.0.4","10.0.0.5"]' \
        EMS_NAME=ems13-13 EMS_RELEASE_NAMESPACES=x-ns bash "$script") || {
  echo "gate dispatch failed:" >&2; echo "$outg4" >&2; exit 1
}
grep -Fq '门禁通过' <<<"$outg4"
grep -Fq 'EMS_GATE=passed' <<<"$outg4"
grep -Fq 'EMS_RELEASE_NAMESPACES=x-ns' <<<"$outg4"
grep -q 'EMS_NAME=ems13-13' "$tmp/ssh.log"
grep -q 'EMS_RELEASE_NAMESPACES=x-ns' "$tmp/ssh.log"
grep -q 'ems_chart_expected=26.8.0-b6' "$tmp/ssh.log"

# ⑧h 单节点门禁也通过（check 是通用 step；节点数下限由 ems-deploy 校验，不在此拦）
outg5=$(TARGET_IPS='["10.0.0.4"]' EMS_NAME=ems13-13 bash "$script") || {
  echo "gate single-node failed:" >&2; echo "$outg5" >&2; exit 1
}
grep -Fq '共 1 台' <<<"$outg5"
grep -Fq '门禁通过' <<<"$outg5"
grep -Fq 'EMS_GATE=passed' <<<"$outg5"
grep -Fq 'EMS_NODES=10.0.0.4' <<<"$outg5"

# ---- ⑦ 参数面断言：恰好 2 个门禁可选参数（EMS_NAME/EMS_RELEASE_NAMESPACES），无其他杂项 ----
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
assert params == ['EMS_NAME', 'EMS_RELEASE_NAMESPACES'], f'参数面应为 EMS_NAME/EMS_RELEASE_NAMESPACES: {params}'
EOF

echo 'PASS: ems-check step contract (inventory, versions, shells, target placement, dispatch, exit code, param surface, install gate)'
