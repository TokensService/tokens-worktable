#!/usr/bin/env bash
set -euo pipefail

# ems-uninstall.sh 契约测试：mock kubectl/helm/ssh/sleep（stateful，per-node 大页文件），
# 覆盖：① 完整卸载（release+ns 删除、label 节点定位、大页归零、kubelet 重启、
#          label 清理、契约输出；非目标节点的 hugepages pod 不阻塞等待）
#      ② 幂等重入（无 release/ns/label、大页已 0）→ 全跳过成功
#      ③ 大页释放卡死（写入器不生效）→ 超时失败并提示「重启节点」
#      ④ 残留 label 仲裁：节点叠脏 label（无 pod/release）→ 唯一存活实例为准，
#          残留 label 顺带清理，正常卸载不 die
#      ⑤ 节点缩容：多节点实例只选部分目标 → 摘目标节点 label + 删钉住 pod 迁移
#          → 目标节点大页归零 + kubelet，release/ns 保留，实例在剩余节点服务（scaled）
#      ⑥ release 位于非标准 ns（default）→ 按实际 ns 卸载
#      ⑦ TARGET_HOSTS 远程分发模式冒烟（翻译路径本地 eval，凭据下传）。
#      ⑧ 真交叉（目标节点双活实例 pod 证据）→ 带证据明细 die 拒卸。
# 全程不接触真实集群/真实 sysfs。

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/ems-uninstall.sh"
failures=0
pass_count=0

assert_rc() { # <期望rc> <实际rc> <场景>
    [[ "$1" == "$2" ]] && return 0
    echo "FAIL[$3]: 退出码期望 $1 实际 $2"
    failures=$((failures + 1))
}
assert_contains() { # <haystack> <needle> <场景>
    grep -Fq -- "$2" <<<"$1" && return 0
    echo "FAIL[$3]: 输出缺少预期内容：$2"
    failures=$((failures + 1))
}
assert_not_contains() { # <haystack> <needle> <场景>
    grep -Fq -- "$2" <<<"$1" && { echo "FAIL[$3]: 输出不应包含：$2"; failures=$((failures + 1)); return; }
    return 0
}
assert_file_eq() { # <file> <内容> <场景>
    [[ "$(cat "$1" 2>/dev/null)" == "$2" ]] && return 0
    echo "FAIL[$3]: 文件 $1 内容期望 [$2] 实际 [$(cat "$1" 2>/dev/null)]"
    failures=$((failures + 1))
}
case_ok() { echo "  ✓ $1"; pass_count=$((pass_count + 1)); }

make_fixtures() { # <tmp> <with_label:0|1>
    local t=$1 with_label=$2
    cat >"$t/nodes.json" <<'JSON'
{"items": [
  {"metadata": {"name": "node-1", "labels": {"ems13": "true"}},
   "status": {"addresses": [{"type": "Hostname", "address": "node-1"}, {"type": "InternalIP", "address": "10.0.0.1"}],
              "conditions": [{"type": "Ready", "status": "True"}],
              "capacity": {"hugepages-2Mi": "2000Gi"}, "allocatable": {"hugepages-2Mi": "2000Gi", "cpu": "256"}}},
  {"metadata": {"name": "node-2", "labels": {"ems13": "true"}},
   "status": {"addresses": [{"type": "Hostname", "address": "node-2"}, {"type": "InternalIP", "address": "10.0.0.2"}],
              "conditions": [{"type": "Ready", "status": "True"}],
              "capacity": {"hugepages-2Mi": "2000Gi"}, "allocatable": {"hugepages-2Mi": "2000Gi", "cpu": "256"}}},
  {"metadata": {"name": "node-other", "labels": {"other": "true"}},
   "status": {"addresses": [{"type": "InternalIP", "address": "10.0.0.9"}],
              "conditions": [{"type": "Ready", "status": "True"}],
              "allocatable": {"cpu": "256"}}}
]}
JSON
    [[ "$with_label" == 1 ]] || python3 - "$t/nodes.json" <<'PY'
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
for node in doc["items"]:
    node["metadata"].get("labels", {}).pop("ems13", None)
json.dump(doc, open(path, "w"))
PY
    cat >"$t/pods.json" <<'JSON'
{"items": [
  {"metadata": {"namespace": "ems13-13", "name": "ems-server-abcde"},
   "spec": {"nodeName": "node-1", "containers": [{"name": "ems-server", "resources": {"requests": {"hugepages-2Mi": "2000Gi", "cpu": "40"}}}]},
   "status": {"conditions": [{"type": "Ready", "status": "True"}]}},
  {"metadata": {"namespace": "other-ns", "name": "other-hp-pod"},
   "spec": {"nodeName": "node-other", "containers": [{"name": "x", "resources": {"requests": {"hugepages-2Mi": "4Gi"}}}]}},
  {"metadata": {"namespace": "default", "name": "plain-pod"},
   "spec": {"nodeName": "node-2", "containers": [{"name": "y"}]}}
]}
JSON
    echo "1024000 1024000 0" >"$t/hp_10.0.0.1"
    echo "1024000 1024000 0" >"$t/hp_10.0.0.2"
    mkdir -p "$t/bin"

    cat >"$t/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

    # stateful mock：kubectl（视图按 marker 合成：label 清理 / kubelet 重启后 allocatable 去键）
    cat >"$t/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
echo "kubectl $*" >>"$FIXTURES/kubectl.log"
if [[ "$1 $2" == 'version --request-timeout=5s' ]]; then exit 0; fi
case "$*" in
  'get nodes -o json')
    python3 -c '
import json, os
fx = os.environ["FIXTURES"]
items = []
for node in json.load(open(fx + "/nodes.json"))["items"]:
    name = node["metadata"]["name"]
    ip = next(a["address"] for a in node["status"]["addresses"] if a["type"] == "InternalIP")
    labels = dict(node["metadata"].get("labels") or {})
    labels = {k: v for k, v in labels.items() if not os.path.exists(f"{fx}/marker_label_{name}_{k}")}
    node["metadata"]["labels"] = labels
    if os.path.exists(f"{fx}/marker_kubelet_{ip}"):
        node["status"]["allocatable"].pop("hugepages-2Mi", None)
    items.append(node)
print(json.dumps({"items": items}))' ;;
  'get node '*)
    name=$3
    python3 -c '
import json, os, sys
fx, name = os.environ["FIXTURES"], sys.argv[1]
node = next(n for n in json.load(open(fx + "/nodes.json"))["items"] if n["metadata"]["name"] == name)
ip = next(a["address"] for a in node["status"]["addresses"] if a["type"] == "InternalIP")
labels = dict(node["metadata"].get("labels") or {})
labels = {k: v for k, v in labels.items() if not os.path.exists(f"{fx}/marker_label_{name}_{k}")}
node["metadata"]["labels"] = labels
if os.path.exists(f"{fx}/marker_kubelet_{ip}"):
    node["status"]["allocatable"].pop("hugepages-2Mi", None)
print(json.dumps(node))' "$name" ;;
  'get ns '*)
    [[ -e "$FIXTURES/ns_deleted" ]] && exit 1
    echo '{"kind": "Namespace", "metadata": {"name": "ems13-13"}}' ;;
  'delete ns '*)
    touch "$FIXTURES/ns_deleted" "$FIXTURES/pod_gone"
    echo 'namespace "ems13-13" deleted' ;;
  'delete pod '*)
    touch "$FIXTURES/marker_pod_moved"
    exit 0 ;;
  'label node '*)
    key="${*: -1}"; key="${key%-}"
    touch "$FIXTURES/marker_label_$3_$key" ;;
  'get pods -n '*'-o json')
    python3 -c '
import json, os, sys
fx, ns = os.environ["FIXTURES"], sys.argv[1]
doc = json.load(open(fx + "/pods.json"))
items = [p for p in doc["items"] if p["metadata"].get("namespace") == ns]
if os.path.exists(fx + "/marker_pod_moved"):
    for pod in items:
        if (pod.get("spec") or {}).get("nodeName") == "node-1":
            pod["spec"]["nodeName"] = "node-2"
print(json.dumps({"items": items}))' "${4:-}" ;;
  'get pods -A -o json')
    if [[ -e "$FIXTURES/pod_gone" ]]; then echo '{"items": []}'
    else
      python3 -c '
import json, os
fx = os.environ["FIXTURES"]
doc = json.load(open(fx + "/pods.json"))
if os.path.exists(fx + "/marker_pod_moved"):
    for pod in doc["items"]:
        if (pod.get("spec") or {}).get("nodeName") == "node-1" and pod["metadata"].get("namespace", "").startswith("ems"):
            pod["spec"]["nodeName"] = "node-2"
print(json.dumps(doc))'
    fi ;;
  *)
    echo "unexpected kubectl call: $*" >&2; exit 1 ;;
esac
EOF

    cat >"$t/bin/helm" <<'EOF'
#!/usr/bin/env bash
echo "helm $*" >>"$FIXTURES/helm.log"
case "$*" in
  'list -A -o json')
    if [[ -e "$FIXTURES/helm_released" ]]; then echo '[]'
    else printf '[{"name":"ems13-13","namespace":"%s","chart":"ems-26.8.0-b6"},{"name":"other","namespace":"kube"}]' "${EMS_HELM_NS:-ems13}"
    fi ;;
  'uninstall '*)
    touch "$FIXTURES/helm_released"
    echo 'release "ems13-13" uninstalled' ;;
  *)
    echo "unexpected helm call: $*" >&2; exit 1 ;;
esac
EOF

    cat >"$t/bin/ssh" <<'EOF'
#!/usr/bin/env bash
echo "ssh $*" >>"$FIXTURES/ssh.log"
cmd="${@: -1}"
target=''
for a in "$@"; do [[ "$a" == *@* ]] && target="$a"; done
ip="${target#*@}"
case "$cmd" in
  *'command -v kubectl'*) exit 0 ;;
  *'cat > /tmp/ems-uninstall.sh'*) exit 0 ;;
  *'bash /tmp/ems-uninstall.sh'*)
    cmd=$(sed "s|/tmp/ems-uninstall.sh|$REAL_SCRIPT|" <<<"$cmd")
    eval "$cmd" ;;
  *'nr_hugepages'*)
    [[ -e "$FIXTURES/stuck_$ip" ]] || echo "0 0 0" >"$FIXTURES/hp_$ip"
    exit 0 ;;
  *'HugePages_'*)
    read -r t f s < <(cat "$FIXTURES/hp_$ip" 2>/dev/null || echo "0 0 0")
    printf '%s %s %s\n' "$t" "$f" "$s" ;;
  *'systemctl restart kubelet'*)
    touch "$FIXTURES/marker_kubelet_$ip" ;;
  *)
    echo "unexpected ssh cmd: $cmd" >&2; exit 1 ;;
esac
EOF

    chmod +x "$t/bin/sleep" "$t/bin/kubectl" "$t/bin/helm" "$t/bin/ssh"
    touch "$t/kubectl.log" "$t/helm.log" "$t/ssh.log"   # 预创建：无调用的场景断言 cat 不报错
}

run_script() { # <tmp> [env assignments...] → stdout/stderr 合并，rc 透传
    local t=$1
    shift
    env -u TARGET_HOSTS -u EMS_NAME -u EMS_KEEP_HUGEPAGES -u EMS_DRY_RUN \
        PATH="$t/bin:$PATH" FIXTURES="$t" REAL_SCRIPT="$script" \
        "$@" bash "$script" 2>&1
}

# ==================== 场景①：完整卸载 ====================
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
make_fixtures "$t" 1
rc=0; out=$(run_script "$t" TARGET_IPS='["10.0.0.1","10.0.0.2"]') || rc=$?
assert_rc 0 "$rc" ①
assert_contains "$out" '目标节点：10.0.0.1 → node-1' ①
assert_contains "$out" '推导实例：ems13-13（label ems13）' ①
assert_contains "$out" 'uninstall ems13-13（release 位于 ns ems13，--no-hooks 绕开 pre-delete 钩子防卡死）' ①
assert_contains "$(cat "$t/helm.log")" 'uninstall ems13-13 -n ems13 --no-hooks' ①
assert_contains "$(cat "$t/kubectl.log")" 'delete ns ems13-13' ①
assert_contains "$(cat "$t/kubectl.log")" 'label node node-1 ems13-' ①
assert_contains "$(cat "$t/kubectl.log")" 'label node node-2 ems13-' ①
assert_contains "$(cat "$t/ssh.log")" 'systemctl restart kubelet' ①
assert_contains "$out" 'EMS_STATUS=uninstalled' ①
assert_contains "$out" 'EMS_RELEASE_REMOVED=1' ①
assert_contains "$out" 'EMS_NAMESPACE_REMOVED=1' ①
assert_contains "$out" 'EMS_HUGEPAGES_RELEASED=10.0.0.1,10.0.0.2' ①
assert_contains "$out" 'EMS_KUBELET_RESTARTED=10.0.0.1,10.0.0.2' ①
assert_contains "$out" 'EMS_LABEL_REMOVED=node-1,node-2' ①
assert_contains "$out" '终验通过' ①
assert_not_contains "$out" 'unexpected' ①
assert_file_eq "$t/hp_10.0.0.1" '0 0 0' ①
assert_file_eq "$t/hp_10.0.0.2" '0 0 0' ①
rm -rf "$t"
case_ok '场景① 完整卸载（大页归零+kubelet+label 清理+契约）'

# ==================== 场景②：幂等重入（全跳过） ====================
t=$(mktemp -d)
make_fixtures "$t" 0
touch "$t/helm_released" "$t/ns_deleted" "$t/pod_gone"
echo "0 0 0" >"$t/hp_10.0.0.1"; echo "0 0 0" >"$t/hp_10.0.0.2"
rc=0; out=$(run_script "$t" TARGET_IPS='["10.0.0.1"]') || rc=$?
assert_rc 0 "$rc" ②
assert_contains "$out" '目标节点不属于任何 EMS 实例（已卸干净或从未安装）：无操作，幂等退出' ②
assert_contains "$out" 'EMS_STATUS=uninstalled' ②
assert_not_contains "$out" 'unexpected' ②
rm -rf "$t"
case_ok '场景② 幂等重入（无 release/ns/label，全跳过成功）'

# ==================== 场景③：大页释放卡死 ====================
t=$(mktemp -d)
make_fixtures "$t" 1
touch "$t/stuck_10.0.0.2"
rc=0; out=$(run_script "$t" TARGET_IPS='["10.0.0.1","10.0.0.2"]') || rc=$?
assert_rc 1 "$rc" ③
assert_contains "$out" '重启节点' ③
assert_file_eq "$t/hp_10.0.0.1" '0 0 0' ③
assert_file_eq "$t/hp_10.0.0.2" '1024000 1024000 0' ③
rm -rf "$t"
case_ok '场景③ 大页释放卡死 → 超时失败并提示重启节点'

# ==================== 场景④：残留 label 仲裁（唯一存活实例 + 脏 label）→ 顺带清理 ====================
t=$(mktemp -d)
make_fixtures "$t" 1
python3 - "$t/nodes.json" <<'PY2'
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
for node in doc["items"]:
    if node["metadata"]["name"] == "node-1":
        node["metadata"]["labels"]["ems14"] = "true"
json.dump(doc, open(path, "w"))
PY2
rc=0; out=$(run_script "$t" TARGET_IPS='["10.0.0.1","10.0.0.2"]') || rc=$?
assert_rc 0 "$rc" ④
assert_contains "$out" '推导实例：ems13-13（label ems13）' ④
assert_contains "$out" '残留 label：ems14' ④
assert_contains "$(cat "$t/helm.log")" 'uninstall ems13-13 -n ems13' ④
assert_contains "$(cat "$t/kubectl.log")" 'label node node-1 ems13-' ④
assert_contains "$(cat "$t/kubectl.log")" 'label node node-1 ems14-' ④
assert_contains "$out" 'EMS_STALE_LABELS=ems14' ④
assert_contains "$out" '终验通过' ④
assert_not_contains "$out" 'unexpected' ④
rm -rf "$t"
case_ok '场景④ 残留 label 仲裁（脏 label 无 pod/release）→ 正常卸载 + 顺带清理'

# ==================== 场景⑧：真交叉（双存活实例证据）→ die ====================
t=$(mktemp -d)
make_fixtures "$t" 1
python3 - "$t/nodes.json" <<'PY2'
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
for node in doc["items"]:
    if node["metadata"]["name"] == "node-1":
        node["metadata"]["labels"]["ems14"] = "true"
json.dump(doc, open(path, "w"))
PY2
python3 - "$t/pods.json" <<'PY2'
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
doc["items"].append({"metadata": {"namespace": "ems14-14", "name": "ems-server-xyz"},
                     "spec": {"nodeName": "node-1", "containers": [{"name": "ems-server",
                               "resources": {"requests": {"hugepages-2Mi": "2000Gi"}}}]}})
json.dump(doc, open(path, "w"))
PY2
rc=0; out=$(run_script "$t" TARGET_IPS='["10.0.0.1"]') || rc=$?
assert_rc 1 "$rc" ⑧
assert_contains "$out" '交叉多个 EMS 存活实例（ems13:pod+release,ems14:pod）' ⑧
assert_not_contains "$(cat "$t/helm.log")" 'uninstall' ⑧
assert_not_contains "$(cat "$t/kubectl.log")" 'label node' ⑧
rm -rf "$t"
case_ok '场景⑧ 真交叉（双活实例 pod 证据）→ 带证据明细 die'

# ==================== 场景⑤：节点缩容（部分目标 → scaled） ====================
t=$(mktemp -d)
make_fixtures "$t" 1
rc=0; out=$(run_script "$t" TARGET_IPS='["10.0.0.1"]') || rc=$?
assert_rc 0 "$rc" ⑤
assert_contains "$out" '缩容模式：实例 ems13-13 的 label 节点（node-1 node-2）未被目标全覆盖，剩余节点［node-2］继续服务' ⑤
assert_contains "$out" '动作计划：摘目标节点 label（node-1）' ⑤
assert_not_contains "$(cat "$t/helm.log")" 'uninstall' ⑤
assert_not_contains "$(cat "$t/kubectl.log")" 'delete ns' ⑤
assert_contains "$(cat "$t/kubectl.log")" 'label node node-1 ems13-' ⑤
assert_not_contains "$(cat "$t/kubectl.log")" 'label node node-2' ⑤
assert_contains "$(cat "$t/kubectl.log")" 'delete pod -n ems13-13 --field-selector spec.nodeName=node-1' ⑤
assert_contains "$(cat "$t/ssh.log")" 'systemctl restart kubelet' ⑤
assert_contains "$out" 'EMS_STATUS=scaled' ⑤
assert_contains "$out" 'EMS_RELEASE_REMOVED=0' ⑤
assert_contains "$out" 'EMS_HUGEPAGES_RELEASED=10.0.0.1' ⑤
assert_contains "$out" '终验通过（缩容：release ems13-13 保留，实例在剩余节点服务）' ⑤
assert_not_contains "$out" 'unexpected' ⑤
assert_file_eq "$t/hp_10.0.0.1" '0 0 0' ⑤
assert_file_eq "$t/hp_10.0.0.2" '1024000 1024000 0' ⑤
rm -rf "$t"
case_ok '场景⑤ 节点缩容（单目标：摘 label+迁 pod+大页归零，release/ns 保留）'

# ==================== 场景⑥：release 位于非标准 ns ====================
t=$(mktemp -d)
make_fixtures "$t" 1
rc=0; out=$(run_script "$t" TARGET_IPS='["10.0.0.1","10.0.0.2"]' EMS_HELM_NS=default) || rc=$?
assert_rc 0 "$rc" ⑥
assert_contains "$(cat "$t/helm.log")" 'uninstall ems13-13 -n default' ⑥
rm -rf "$t"
case_ok '场景⑥ release 位于 default ns → 按实际 ns 卸载'

# ==================== 场景⑦：TARGET_HOSTS 远程分发冒烟 ====================
t=$(mktemp -d)
make_fixtures "$t" 1
# 分发模式需 TARGET_HOSTS 注入（不走 run_script 的 env -u TARGET_HOSTS 削变量）
rc=0; out=$(env -u EMS_NAME PATH="$t/bin:$PATH" FIXTURES="$t" REAL_SCRIPT="$script" \
    TARGET_HOSTS='[{"ip":"10.0.0.1","user":"root"},{"ip":"10.0.0.2","user":"root"}]' \
    TARGET_IPS='["10.0.0.1","10.0.0.2"]' bash "$script" 2>&1) || rc=$?
assert_rc 0 "$rc" ⑦
assert_contains "$out" 'remote execution via root@10.0.0.1:22' ⑦
assert_contains "$out" 'EMS_STATUS=uninstalled' ⑦
assert_contains "$(cat "$t/ssh.log")" 'bash /tmp/ems-uninstall.sh' ⑦
assert_contains "$(cat "$t/ssh.log")" 'systemctl restart kubelet' ⑦
assert_not_contains "$out" 'unexpected' ⑦
rm -rf "$t"
case_ok '场景⑦ TARGET_HOSTS 远程分发模式冒烟'

echo
if (( failures > 0 )); then
    echo "结果：$failures 项断言失败"
    exit 1
fi
echo "结果：全部 $pass_count 个场景通过"
