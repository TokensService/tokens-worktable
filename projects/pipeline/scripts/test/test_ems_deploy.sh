#!/usr/bin/env bash
set -euo pipefail

# ems-deploy.sh 契约测试：mock kubectl/helm/ssh/scp/sleep（带状态标记的 stateful mock），
# 覆盖：① 全新安装 happy path（释放/label/helm 参数/契约；大页在 ems-hugepages step）
#      ② 同名 ns/release 残留且无门禁幂等判定（EMS_IDEMPOTENT≠1）→ 拒绝盲装
#      ③ 授权释放（EMS_RELEASE_NAMESPACES）后安装
#      ④ 门禁判定幂等（EMS_IDEMPOTENT=1）→ 跳过安装仅验证。
#      （label 占用/节点业务占用门禁已上移 ems-check，见 test_ems_check.sh 门禁场景）
# 全程不接触真实集群/真实 sysfs。

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/ems-deploy.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export FIXTURES="$tmp"
export REAL_SCRIPT="$script"
export REAL_BUNDLE="$script_dir"

# ---- 基础 fixtures（各场景按需覆写） ----------------------------------------------
cat >"$tmp/nodes.json" <<'JSON'
{"items": [
  {"metadata": {"name": "node-1", "labels": {}},
   "status": {"addresses": [{"type": "Hostname", "address": "node-1"}, {"type": "InternalIP", "address": "10.0.0.1"}],
              "conditions": [{"type": "Ready", "status": "True"}],
              "capacity": {"hugepages-2Mi": "2000Gi"}, "allocatable": {"hugepages-2Mi": "0"}}},
  {"metadata": {"name": "node-2", "labels": {}},
   "status": {"addresses": [{"type": "Hostname", "address": "node-2"}, {"type": "InternalIP", "address": "10.0.0.2"}],
              "conditions": [{"type": "Ready", "status": "True"}],
              "capacity": {"hugepages-2Mi": "2000Gi"}, "allocatable": {"hugepages-2Mi": "0"}}}
]}
JSON
# kubelet 重启后 allocatable 达标视图
sed 's/"hugepages-2Mi": "0"/"hugepages-2Mi": "2000Gi"/g' "$tmp/nodes.json" >"$tmp/nodes_ready.json"

mk_pod() { # <name> <ns> <node> <phase:running|pending>
  printf '{"metadata": {"name": "%s", "namespace": "%s"}, "spec": {"nodeName": "%s", "containers": [{"name": "ems-server", "image": "ems:26.8.0-b6", "resources": {"requests": {"hugepages-2Mi": "2000Gi"}}}]}, "status": {"phase": "%s", "conditions": [{"type": "Ready", "status": "%s"}], "containerStatuses": [{"name": "ems-server", "ready": true, "restartCount": 0, "image": "ems:26.8.0-b6"}]}}' \
    "$1" "$2" "$3" "$([ "$4" = running ] && echo Running || echo Pending)" "$([ "$4" = running ] && echo True || echo False)"
}

cat >"$tmp/pods_clean.json" <<JSON
{"items": [$(mk_pod ems-zookeeper-0 kube-system node-1 running)]}
JSON
cat >"$tmp/pods_busy.json" <<JSON
{"items": [$(mk_pod ems-zookeeper-0 kube-system node-1 running), $(mk_pod busy-app-0 busy-ns node-1 running)]}
JSON
{
  printf '{"items": ['
  for i in 0 1 2; do ((i)) && printf ', '; mk_pod "ems-zookeeper-$i" ems13-13 node-1 running; done
  printf ', '; mk_pod ems-controller-0 ems13-13 node-1 running
  printf ', '; mk_pod ems-init-1 ems13-13 node-1 running
  printf ', '; mk_pod ems-init-2 ems13-13 node-2 running
  printf ', '; mk_pod ems-server-1 ems13-13 node-1 running
  printf ', '; mk_pod ems-server-2 ems13-13 node-2 running
  printf ']}\n'
} >"$tmp/ems_pods.json"
cp "$tmp/pods_clean.json" "$tmp/pods_all.json"
echo '[]' >"$tmp/helm.json"
echo 0 >"$tmp/hp_total"
# 单节点视图（真实形状：单对象，非 items 列表）与安装后的全量 pod 视图
python3 - "$tmp" <<'PY'
import json, sys
base = sys.argv[1]
nodes = json.load(open(base + "/nodes.json"))["items"]
for name in ("node-1",):
    one = next(n for n in nodes if n["metadata"]["name"] == name)
    json.dump(one, open(base + "/node1.json", "w"))
    one = json.loads(json.dumps(one))
    one["status"]["allocatable"]["hugepages-2Mi"] = "2000Gi"
    json.dump(one, open(base + "/node1_ready.json", "w"))
clean = json.load(open(base + "/pods_clean.json"))
ems = json.load(open(base + "/ems_pods.json"))
json.dump({"items": clean["items"] + ems["items"]}, open(base + "/pods_installed.json", "w"))
PY

# ---- stateful mock：kubectl --------------------------------------------------------
mkdir -p "$tmp/bin"
cat >"$tmp/bin/kubectl" <<EOF
#!/usr/bin/env bash
echo "kubectl \$*" >>"\$FIXTURES/kubectl.log"
if [[ "\$1 \$2" == 'version --request-timeout=5s' ]]; then exit 0; fi
case "\$*" in
  *'get nodes'*)
    if [[ "\$*" == *' -l '* ]]; then
      # 按命令中的 label 动态过滤 nodes.json（真实 -l 查询形状：{"items":[...]}）
      python3 -c 'import json,re,sys; doc=json.load(open(sys.argv[1])); m=re.search(r"-l ([^ ]+)=(\S+)", sys.argv[2]); k,v=(m.groups() if m else ("","")); print(json.dumps({"items":[n for n in doc["items"] if n["metadata"].get("labels",{}).get(k)==v]}))' "\$FIXTURES/nodes.json" "\$*"
    else cat "\$FIXTURES/nodes.json"; fi ;;
  'get node '*)
    # 单节点查询返回单对象（非 items 列表）；本轮只有 node-1 被查询
    if [[ -e "\$FIXTURES/marker_kubelet" ]]; then cat "\$FIXTURES/node1_ready.json"; else cat "\$FIXTURES/node1.json"; fi ;;
  *'get namespaces'*|'get ns '*)
    if [[ "\$3" == ems13-13 && ( -e "\$FIXTURES/marker_installed" || -e "\$FIXTURES/marker_preset" ) ]]; then
      echo '{"metadata": {"name": "ems13-13"}}'
    elif [[ "\$3" == busy-ns && ! -e "\$FIXTURES/marker_deleted" ]]; then
      echo '{"metadata": {"name": "busy-ns"}}'
    else
      exit 1   # 真实 kubectl：ns 不存在时退出非零
    fi ;;
  *'get pods -A'*)
    if [[ -e "\$FIXTURES/marker_installed" || -e "\$FIXTURES/marker_preset" ]]; then cat "\$FIXTURES/pods_installed.json"
    else cat "\$FIXTURES/pods_all.json"; fi ;;
  *'get pods -n ems13-13'*)
    if [[ -e "\$FIXTURES/marker_installed" || -e "\$FIXTURES/marker_preset" ]]; then cat "\$FIXTURES/ems_pods.json"
    else echo '{"items": []}'; fi ;;
  *'get pods -n busy-ns'*) [[ -e "\$FIXTURES/marker_deleted" ]] || echo 'busy-app-0   1/1   Running   0' ;;
  *'delete ns busy-ns'*) touch "\$FIXTURES/marker_deleted"; cp "\$FIXTURES/pods_clean.json" "\$FIXTURES/pods_all.json" ;;
  *'delete ns '*) exit 0 ;;
  *'label node '*'ems13=true'*) touch "\$FIXTURES/marker_labeled" ;;
  *) echo "unexpected kubectl call: \$*" >&2; exit 1 ;;
esac
EOF
# 场景②占用视图：node-9 带 ems13 label
cat >"$tmp/bin/helm" <<EOF
#!/usr/bin/env bash
echo "helm \$*" >>"\$FIXTURES/helm.log"
case "\$1 \$2" in
  'list -A'|'list -a') cat "\$FIXTURES/helm.json" ;;
  'install '*)
    touch "\$FIXTURES/marker_installed"
    # 安装后 helm list 应可见该 release（chart 字段=ems-<Chart.yaml version>）
    ver=\$(sed -n 's/^version:[[:space:]]*//p' "\$3/Chart.yaml" | head -1 | tr -d '"')
    python3 -c 'import json,sys; rels=json.load(open(sys.argv[1])); rels.append({"name":sys.argv[2],"namespace":sys.argv[3],"chart":"ems-"+sys.argv[4],"status":"deployed"}); json.dump(rels,open(sys.argv[1],"w"))' "\$FIXTURES/helm.json" "\$2" "\$5" "\$ver"
    echo 'installed' ;;
  *) echo "unexpected helm call: \$*" >&2; exit 1 ;;
esac
EOF
cat >"$tmp/bin/ssh" <<EOF
#!/usr/bin/env bash
echo "ssh \$*" >>"\$FIXTURES/ssh.log"
cmd="\${@: -1}"
case "\$cmd" in
  *'cat > /tmp/ems-deploy-bundle.tgz'*) exit 0 ;;   # 安装包推送（stdin 丢弃）
  *'bash /tmp/ems-deploy-bundle/'*)
    # 分发执行：跳过解包（避免写入真实仓目录），翻译路径后本地 eval
    cmd="\${cmd#tar -C /tmp/ems-deploy-bundle -xzf /tmp/ems-deploy-bundle.tgz && }"
    cmd=\$(sed "s|/tmp/ems-deploy-bundle|\$REAL_BUNDLE|g" <<<"\$cmd")
    eval "\$cmd" ;;
  *'command -v kubectl'*) exit 0 ;;
  *'command -v helm'*) exit 0 ;;
  *'systemctl restart kubelet'*) echo "kubelet-restarted @\$(hostname)" >>"\$FIXTURES/ssh.log"; touch "\$FIXTURES/marker_kubelet" ;;
  *'HugePages_Total'*) echo "HugePages_Total:    \$(cat \$FIXTURES/hp_total)" ;;
  *'nr_hugepages'*)
    # 后台写入器：直接把 fixture 大页总量置为达标值（2000Gi=1024000 页）
    echo 1024000 >"\$FIXTURES/hp_total"; echo 'launch: nohup writer' >>"\$FIXTURES/ssh.log" ;;
  *) echo "unexpected ssh cmd: \$cmd" >&2; exit 1 ;;
esac
EOF
cat >"$tmp/bin/scp" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$tmp/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp/bin/"*
PATH="$tmp/bin:$PATH"
export PATH

reset_state() {
  rm -f "$FIXTURES"/marker_* "$FIXTURES"/{kubectl,helm,ssh}.log
  cp "$FIXTURES/pods_clean.json" "$FIXTURES/pods_all.json"
  echo '[]' >"$FIXTURES/helm.json"
  echo 0 >"$FIXTURES/hp_total"
}

HOSTS='[{"ip":"10.0.0.1","user":"root"},{"ip":"10.0.0.2","user":"root"}]'
IPS='["10.0.0.1","10.0.0.2"]'

# ==== 场景①：全新安装 happy path ==================================
reset_state
out=$(TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" EMS_NAME=ems13-13 bash "$script") || {
  echo "scenario1 failed:" >&2; echo "$out" >&2; exit 1
}
grep -Fq 'remote execution via root@10.0.0.1:22' <<<"$out"
grep -Fq '幂等重入' <<<"$out" && { echo 'scenario1: should be fresh install' >&2; exit 1; }
grep -Fq '跳过安装，仅验证' <<<"$out" && { echo 'scenario1: must be fresh install' >&2; exit 1; }
grep -Fq 'helm install ems13-13' <<<"$out"
grep -Fq 'nodeSelector.emsCtrl.labelKey=ems13' <<<"$out"
grep -Fq 'nodeSelector.emsServer.labelKey=ems13' <<<"$out"
! grep -Fq 'hugePages.num' <<<"$out"        # 2000Gi 默认不注入 hugePages 覆盖
grep -Fq 'label：node-1 ems13=true' <<<"$out"
grep -Fq 'label：node-2 ems13=true' <<<"$out"
grep -Fq 'EMS_NAME=ems13-13' <<<"$out"
grep -Fq 'EMS_NAMESPACE=ems13-13' <<<"$out"
grep -Fq 'EMS_LABEL_KEY=ems13' <<<"$out"
grep -Fq 'EMS_NODES=10.0.0.1,10.0.0.2' <<<"$out"
grep -Fq 'EMS_CHART_VERSION=26.8.0-b6' <<<"$out"
grep -Fq 'EMS_POD_HEALTH=8/8' <<<"$out"
grep -Fq 'EMS_STATUS=installed' <<<"$out"

# ==== 场景②：同名 ns/release 残留且无门禁幂等判定 → 拒绝盲装 =========
reset_state
touch "$FIXTURES/marker_preset"
cat >"$FIXTURES/helm.json" <<'JSON'
[{"name": "ems13-13", "namespace": "ems13", "chart": "ems-26.8.0-b6", "app_version": "26.8.0-b6", "status": "deployed"}]
JSON
rc=0
TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" EMS_NAME=ems13-13 bash "$script" >/dev/null 2>"$tmp/err2" || rc=$?
[[ "$rc" == 1 ]] || { echo "scenario2 expected exit 1, got $rc" >&2; exit 1; }
grep -Fq '未获门禁幂等判定' "$tmp/err2"
grep -Fq '前置 ems-check' "$tmp/err2"
#（label 占用 / 节点业务占用门禁已上移 ems-check，见 test_ems_check.sh 门禁场景）

# ==== 场景③：授权释放（EMS_RELEASE_NAMESPACES）后安装 ======================
reset_state
cp "$FIXTURES/pods_busy.json" "$FIXTURES/pods_all.json"
out=$(TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" EMS_NAME=ems13-13 EMS_RELEASE_NAMESPACES=busy-ns bash "$script") || {
  echo "scenario3b failed:" >&2; echo "$out" >&2; exit 1
}
grep -Fq '删除命名空间 busy-ns' <<<"$out"
grep -Fq '未复活' <<<"$out"
grep -Fq 'helm install ems13-13' <<<"$out"
! grep -Fq 'hugePages.num' <<<"$out"        # 大页固定 2000Gi（chart values 内置），不注入覆盖
grep -Fq 'EMS_STATUS=installed' <<<"$out"

# ==== 场景④：门禁判定幂等（EMS_IDEMPOTENT=1）→ 跳过安装仅验证 =========
reset_state
touch "$FIXTURES/marker_preset"
cat >"$FIXTURES/helm.json" <<'JSON'
[{"name": "ems13-13", "namespace": "ems13", "chart": "ems-26.8.0-b6", "app_version": "26.8.0-b6", "status": "deployed"}]
JSON
out=$(TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" EMS_NAME=ems13-13 EMS_IDEMPOTENT=1 bash "$script") || {
  echo "scenario4 failed:" >&2; echo "$out" >&2; exit 1
}
grep -Fq '幂等重入' <<<"$out"
grep -Fq '跳过安装，仅验证' <<<"$out"
grep -Fq 'helm install' <<<"$out" && { echo 'scenario4: must not reinstall' >&2; exit 1; }
grep -Fq 'EMS_POD_HEALTH=8/8' <<<"$out"
grep -Fq 'EMS_STATUS=installed' <<<"$out"

# ==== 场景⑤：EMS_NAME 为空（未继承也未显式填写）→ 运行时报错并提示 =====
reset_state
rc=0
TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" EMS_NAME= bash "$script" >/dev/null 2>"$tmp/err5" || rc=$?
[[ "$rc" == 1 ]] || { echo "scenario5 expected exit 1, got $rc" >&2; exit 1; }
grep -Fq 'EMS_NAME 为空' "$tmp/err5"
grep -Fq 'ems-check 门禁契约注入' "$tmp/err5"

echo 'PASS: ems-deploy contract (fresh install, refuse blind re-entry, authorized release, gate-approved idempotent re-entry, empty-name hint)'
