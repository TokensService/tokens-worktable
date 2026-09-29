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

# ---- ⑨ 跨 region（hd2 形态）：TARGET_IPS 为外网入口 endpoint，经身份映射定位 ----
# 独立 fixtures：集群节点是内网 31.x/长主机名，平台注入的目标是 115.33.98.101:222x
mk_cross_fixtures() { # <dir> <pods-and-labels: full|gate>
    local d=$1 mode=$2
    mkdir -p "$d/bin"
    if [[ "$mode" == full ]]; then
        cat >"$d/nodes.json" <<'JSON'
{"items": [
  {"metadata": {"name": "tokens-engine-bnt3-13lrp", "labels": {"ems10": "true"}},
   "status": {"addresses": [{"type": "InternalIP", "address": "192.168.31.140"}],
              "conditions": [{"type": "Ready", "status": "True"}],
              "allocatable": {"cpu": "256", "memory": "3Ti"}}},
  {"metadata": {"name": "tokens-engine-bnt3-9d0ee", "labels": {"ems10": "true"}},
   "status": {"addresses": [{"type": "InternalIP", "address": "192.168.31.120"}],
              "conditions": [{"type": "Ready", "status": "True"}],
              "allocatable": {"cpu": "256", "memory": "3Ti"}}}
]}
JSON
        cat >"$d/pods.json" <<'JSON'
{"items": [
  {"metadata": {"namespace": "ems10-10", "name": "ems-server-140"},
   "spec": {"nodeName": "tokens-engine-bnt3-13lrp",
            "containers": [{"name": "ems-server", "image": "swr.example/xms/ems-server:26.8.0-b6",
                             "resources": {"requests": {"hugepages-2Mi": "2000Gi", "cpu": "40"}}}]},
   "status": {"phase": "Running", "startTime": "2026-09-27T00:00:00Z", "conditions": [{"type": "Ready", "status": "True"}]}},
  {"metadata": {"namespace": "ems10-10", "name": "ems-server-120"},
   "spec": {"nodeName": "tokens-engine-bnt3-9d0ee",
            "containers": [{"name": "ems-server", "image": "swr.example/xms/ems-server:26.8.0-b6",
                             "resources": {"requests": {"hugepages-2Mi": "2000Gi", "cpu": "40"}}}]},
   "status": {"phase": "Running", "startTime": "2026-09-27T00:00:00Z", "conditions": [{"type": "Ready", "status": "True"}]}}
]}
JSON
        echo '{"items": [{"metadata": {"name": "ems10-10"}}, {"metadata": {"name": "ems10"}}]}' >"$d/namespaces.json"
        echo '[{"name": "ems10-10", "namespace": "ems10", "chart": "ems-26.8.0-b6", "app_version": "26.8.0-b6", "status": "deployed"}]' >"$d/helm.json"
    else
        cat >"$d/nodes.json" <<'JSON'
{"items": [
  {"metadata": {"name": "tokens-engine-bnt3-13lrp", "labels": {}},
   "status": {"addresses": [{"type": "InternalIP", "address": "192.168.31.140"}],
              "conditions": [{"type": "Ready", "status": "True"}],
              "allocatable": {"cpu": "256", "memory": "3Ti"}}},
  {"metadata": {"name": "tokens-engine-bnt3-9d0ee", "labels": {}},
   "status": {"addresses": [{"type": "InternalIP", "address": "192.168.31.120"}],
              "conditions": [{"type": "Ready", "status": "True"}],
              "allocatable": {"cpu": "256", "memory": "3Ti"}}}
]}
JSON
        echo '{"items": []}' >"$d/pods.json"
        echo '{"items": [{"metadata": {"name": "kube-system"}}]}' >"$d/namespaces.json"
        echo '[]' >"$d/helm.json"
    fi
    # 身份采集 fixture：外网 endpoint → 内网身份
    printf 'tokens-engine-bnt3-13lrp\n192.168.31.140 43.105.134.183\n' >"$d/hostid115.33.98.101:2224"
    printf 'tokens-engine-bnt3-9d0ee\n192.168.31.120 43.105.240.70\n' >"$d/hostid115.33.98.101:2225"
    cat >"$d/bin/kubectl" <<EOF
#!/usr/bin/env bash
if [[ "\$1 \$2" == 'version --request-timeout=5s' ]]; then exit 0; fi
case "\$*" in
  *'get nodes'*)      cat "\$FIXTURES/nodes.json" ;;
  *'get pods -A'*)    cat "\$FIXTURES/pods.json" ;;
  *'get namespaces'*) cat "\$FIXTURES/namespaces.json" ;;
  *) echo "unexpected kubectl call: \$*" >&2; exit 1 ;;
esac
EOF
    cat >"$d/bin/helm" <<EOF
#!/usr/bin/env bash
cat "\$FIXTURES/helm.json"
EOF
    cat >"$d/bin/ssh" <<EOF
#!/usr/bin/env bash
cmd="\${@: -1}"
case "\$cmd" in
  *'hostname -I'*)
    target=''; port=''; prev=''
    for a in "\$@"; do [[ "\$prev" == -p ]] && port="\$a"; [[ "\$a" == *@* ]] && target="\$a"; prev="\$a"; done
    cat "\$FIXTURES/hostid\${target#*@}:\${port:-22}" 2>/dev/null
    exit 0 ;;
esac
case "\$cmd" in
  *'command -v kubectl'*) exit 0 ;;
esac
cmd="\$(sed "s|/tmp/ems-check.sh|\$REAL_SCRIPT|" <<<"\$cmd")"
eval "\$cmd"
EOF
    cat >"$d/bin/scp" <<EOF
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$d/bin/"*
}

# ⑨ 巡检定位：endpoint 经身份映射命中集群节点
tmp9=$(mktemp -d)
mk_cross_fixtures "$tmp9" full
out9=$(PATH="$tmp9/bin:$PATH" FIXTURES="$tmp9" REAL_SCRIPT="$script" \
    TARGET_HOSTS='[{"ip":"115.33.98.101:2224","user":"root"},{"ip":"115.33.98.101:2225","user":"root"}]' \
    TARGET_IPS='["115.33.98.101:2224","115.33.98.101:2225"]' bash "$script") || {
  echo 'cross-region run failed:' >&2; echo "$out9" >&2; exit 1
}
grep -Fq 'remote execution via root@115.33.98.101:2224' <<<"$out9"
grep -Fq '115.33.98.101:2224 → 192.168.31.140: 属于 ems10-10' <<<"$out9"
grep -Fq '115.33.98.101:2225 → 192.168.31.120: 属于 ems10-10' <<<"$out9"
grep -Fq 'EMS_TARGET_MATCHED=2' <<<"$out9"
grep -Fq 'EMS_TARGET_INSTANCE=ems10-10' <<<"$out9"
grep -Fq 'EMS_TARGET_NODES=tokens-engine-bnt3-13lrp,tokens-engine-bnt3-9d0ee' <<<"$out9"
rm -rf "$tmp9"

# ⑨b 跨 region 门禁：G-2 目标解析经身份映射，门禁通过
tmp9=$(mktemp -d)
mk_cross_fixtures "$tmp9" gate
outg9=$(PATH="$tmp9/bin:$PATH" FIXTURES="$tmp9" REAL_SCRIPT="$script" \
    TARGET_HOSTS='[{"ip":"115.33.98.101:2224","user":"root"},{"ip":"115.33.98.101:2225","user":"root"}]' \
    TARGET_IPS='["115.33.98.101:2224","115.33.98.101:2225"]' \
    EMS_NAME=ems20-20 bash "$script") || {
  echo 'cross-region gate failed:' >&2; echo "$outg9" >&2; exit 1
}
grep -Fq '目标节点：tokens-engine-bnt3-13lrp、tokens-engine-bnt3-9d0ee' <<<"$outg9"
grep -Fq '门禁通过' <<<"$outg9"
grep -Fq 'EMS_GATE=passed' <<<"$outg9"
grep -Fq 'EMS_NODES=115.33.98.101:2224,115.33.98.101:2225' <<<"$outg9"
rm -rf "$tmp9"

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
