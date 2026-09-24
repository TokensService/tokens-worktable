#!/usr/bin/env bash
set -euo pipefail

# ems-hugepages.sh 契约测试：mock kubectl/ssh/scp/sleep（stateful，per-node 大页文件），
# 覆盖：① 全新配置（双节点写入 + kubelet 刷新 + 终验契约）
#      ② 全部原已达标（跳过写入与重启，契约 RENEWED/RESTARTED 为空）
#      ③ 大页迟迟不到位 → 超时失败
#      ④ kubelet 重启后 allocatable 仍不达标 → 失败
#      ⑤ 单节点目标亦合法（无 ≥2 限制）
#      ⑥ MemAvailable 不足 → 只读预检秒级失败并输出诊断（不启动写入器）。
# 全程不接触真实集群/真实 sysfs。

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$script_dir/ems-hugepages.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export FIXTURES="$tmp"
export REAL_SCRIPT="$script"

# ---- fixtures ------------------------------------------------------------------
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
# allocatable 达标视图（kubelet 重启后）+ 单节点单对象视图（get node <name> 形状）
sed 's/"hugepages-2Mi": "0"/"hugepages-2Mi": "2000Gi"/g' "$tmp/nodes.json" >"$tmp/nodes_ready.json"
python3 - "$tmp" <<'PY'
import json, sys
base = sys.argv[1]
nodes = json.load(open(base + "/nodes.json"))["items"]
for name in ("node-1", "node-2"):
    one = next(n for n in nodes if n["metadata"]["name"] == name)
    json.dump(one, open(base + "/node_%s.json" % name, "w"))
    one = json.loads(json.dumps(one))
    one["status"]["allocatable"]["hugepages-2Mi"] = "2000Gi"
    json.dump(one, open(base + "/node_%s_ready.json" % name, "w"))
PY

# ---- stateful mock：kubectl（默认版提为函数：场景④覆写后需恢复）------------------
mkdir -p "$tmp/bin"
write_default_kubectl() {
cat >"$tmp/bin/kubectl" <<EOF
#!/usr/bin/env bash
echo "kubectl \$*" >>"\$FIXTURES/kubectl.log"
if [[ "\$1 \$2" == 'version --request-timeout=5s' ]]; then exit 0; fi
case "\$*" in
  'get nodes -o json')
    # 按各节点 kubelet marker 合成视图（哪个节点重启过，哪个节点 allocatable 达标）
    python3 -c '
import json, os, sys
base, ready = sys.argv[1], sys.argv[2]
fx = sys.argv[3]
items = []
for node in json.load(open(base))["items"]:
    ip = next(a["address"] for a in node["status"]["addresses"] if a["type"] == "InternalIP")
    if os.path.exists(f"{fx}/marker_kubelet_{ip}"):
        node = next(r for r in json.load(open(ready))["items"] if r["metadata"]["name"] == node["metadata"]["name"])
    items.append(node)
print(json.dumps({"items": items}))' "\$FIXTURES/nodes.json" "\$FIXTURES/nodes_ready.json" "\$FIXTURES" ;;
  'get node node-1'*)
    if [[ -e "\$FIXTURES/marker_kubelet_10.0.0.1" ]]; then cat "\$FIXTURES/node_node-1_ready.json"; else cat "\$FIXTURES/node_node-1.json"; fi ;;
  'get node node-2'*)
    if [[ -e "\$FIXTURES/marker_kubelet_10.0.0.2" ]]; then cat "\$FIXTURES/node_node-2_ready.json"; else cat "\$FIXTURES/node_node-2.json"; fi ;;
  *) echo "unexpected kubectl call: \$*" >&2; exit 1 ;;
esac
EOF
}
write_default_kubectl

# ---- stateful mock：ssh（per-node 大页文件）--------------------------------------
cat >"$tmp/bin/ssh" <<EOF
#!/usr/bin/env bash
echo "ssh \$*" >>"\$FIXTURES/ssh.log"
cmd="\${@: -1}"
target=''
for a in "\$@"; do [[ "\$a" == *@* ]] && target="\$a"; done
ip="\${target#*@}"
case "\$cmd" in
  *'command -v kubectl'*) exit 0 ;;
  *'cat > /tmp/ems-hugepages.sh'*) exit 0 ;;   # 脚本推送（stdin 丢弃）
  *'bash /tmp/ems-hugepages.sh'*)
    # 分发执行：翻译路径后本地 eval
    cmd=\$(sed "s|/tmp/ems-hugepages.sh|\$REAL_SCRIPT|" <<<"\$cmd")
    eval "\$cmd" ;;
  *'MemAvailable'*)
    # 只读预检：MemTotal/MemAvailable（per-node 可覆写）+ /dev/shm
    avail="\$(cat "\$FIXTURES/memavail_\$ip" 2>/dev/null || echo 3221225472)"
    printf 'MemTotal:       32959684 kB\nMemAvailable:    %s kB\ntmpfs  1.6T  100G   1.5T   7%% /dev/shm\n' "\$avail" ;;
  *'ps aux --sort=-rss'*) echo 'root  1234 95.0 40.0 ... python train.py' ;;
  *'HugePages_Total'*) echo "HugePages_Total:    \$(cat "\$FIXTURES/hp_\$ip" 2>/dev/null || echo 0)" ;;
  *'nr_hugepages'*)
    # 后台写入器：置该节点大页为达标（除非 fixture 标记卡死）
    if [[ -e "\$FIXTURES/hp_stuck_\$ip" ]]; then echo 'launch: stuck writer' >>"\$FIXTURES/ssh.log"
    else echo 1024000 >"\$FIXTURES/hp_\$ip"; echo 'launch: nohup writer' >>"\$FIXTURES/ssh.log"; fi ;;
  *'systemctl restart kubelet'*) echo "kubelet-restarted @\$ip" >>"\$FIXTURES/ssh.log"; touch "\$FIXTURES/marker_kubelet_\$ip" ;;
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
  rm -f "$FIXTURES"/marker_* "$FIXTURES"/hp_* "$FIXTURES"/memavail_* "$FIXTURES"/{kubectl,ssh}.log
}

HOSTS='[{"ip":"10.0.0.1","user":"root"},{"ip":"10.0.0.2","user":"root"}]'
IPS='["10.0.0.1","10.0.0.2"]'

# ==== 场景①：全新配置（双节点）====================================
reset_state
out=$(TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" bash "$script") || {
  echo "scenario1 failed:" >&2; echo "$out" >&2; exit 1
}
grep -Fq 'remote execution via root@10.0.0.1:22' <<<"$out"
grep -Fq 'node-1: 预检通过（还需 2000Gi，MemAvailable 3072Gi ≥ 2200Gi）' <<<"$out"
grep -Fq 'node-2: 预检通过（还需 2000Gi，MemAvailable 3072Gi ≥ 2200Gi）' <<<"$out"
grep -Fq 'node-1: 0 页 → 1024000 页' <<<"$out"
grep -Fq 'node-2: 0 页 → 1024000 页' <<<"$out"
grep -Fq 'node-1: 大页到位（1024000 页）' <<<"$out"
grep -Fq 'node-1: 重启 kubelet 刷新大页 allocatable' <<<"$out"
grep -Fq 'kubelet-restarted @10.0.0.1' "$FIXTURES/ssh.log"
grep -Fq 'kubelet-restarted @10.0.0.2' "$FIXTURES/ssh.log"
grep -Fq 'node-1: Ready 且 allocatable 2000Gi 达标' <<<"$out"
grep -Fq 'node-1: 大页 1024000 页 · allocatable 2000Gi ✓' <<<"$out"
grep -Fq 'EMS_HUGEPAGE_TARGET_GIB=2000' <<<"$out"
grep -Fq 'EMS_HUGEPAGES_OK=1' <<<"$out"
grep -Fq 'EMS_HUGEPAGES_RENEWED=node-1,node-2' <<<"$out"
grep -Fq 'EMS_KUBELET_RESTARTED=node-1,node-2' <<<"$out"

# ==== 场景②：全部原已达标 → 全跳过 =================================
reset_state
echo 1024000 >"$FIXTURES/hp_10.0.0.1"; echo 1024000 >"$FIXTURES/hp_10.0.0.2"
touch "$FIXTURES/marker_kubelet_10.0.0.1" "$FIXTURES/marker_kubelet_10.0.0.2"   # allocatable 视图直接达标
out=$(TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" bash "$script") || {
  echo "scenario2 failed:" >&2; echo "$out" >&2; exit 1
}
grep -Fq 'node-1: 大页已达标（1024000 页 ≥ 1024000），跳过' <<<"$out"
grep -Fq '全部节点大页原已达标，本轮未新增' <<<"$out"
grep -Fq 'node-1: allocatable 已达标（2000Gi），跳过 kubelet 重启' <<<"$out"
grep -Fq '全部节点 allocatable 原已达标，本轮未重启 kubelet' <<<"$out"
grep -Fq 'EMS_HUGEPAGES_OK=1' <<<"$out"
grep -Fq 'EMS_HUGEPAGES_RENEWED=' <<<"$out"
grep -Fq 'EMS_KUBELET_RESTARTED=' <<<"$out"
! grep -Fq 'nr_hugepages' "$FIXTURES/ssh.log"      # 未触发写入器
! grep -Fq 'kubelet-restarted' "$FIXTURES/ssh.log"

# ==== 场景③：大页卡死不涨 → 超时失败 ===============================
reset_state
touch "$FIXTURES/hp_stuck_10.0.0.1"
rc=0
TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" bash "$script" >/dev/null 2>"$tmp/err3" || rc=$?
[[ "$rc" == 1 ]] || { echo "scenario3 expected exit 1, got $rc" >&2; exit 1; }
grep -Fq 'node-1 大页 900s 内未到位（0/1024000' "$tmp/err3"
grep -Fq '请人工释放内存后重跑本 step' "$tmp/err3"

# ==== 场景④：allocatable 刷不出来 → 失败（mock 忽略 marker，恒不达标）====
reset_state
echo 1024000 >"$FIXTURES/hp_10.0.0.1"; echo 1024000 >"$FIXTURES/hp_10.0.0.2"
cat >"$tmp/bin/kubectl" <<EOF
#!/usr/bin/env bash
echo "kubectl \$*" >>"\$FIXTURES/kubectl.log"
if [[ "\$1 \$2" == 'version --request-timeout=5s' ]]; then exit 0; fi
case "\$*" in
  'get nodes -o json') cat "\$FIXTURES/nodes.json" ;;
  'get node node-1'*) cat "\$FIXTURES/node_node-1.json" ;;    # allocatable 恒 0
  'get node node-2'*) cat "\$FIXTURES/node_node-2.json" ;;
  *) echo "unexpected kubectl call: \$*" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/kubectl"
rc=0
TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" bash "$script" >/dev/null 2>"$tmp/err4" || rc=$?
[[ "$rc" == 1 ]] || { echo "scenario4 expected exit 1, got $rc" >&2; exit 1; }
grep -Fq 'allocatable 仍未达标（0Gi < 2000Gi' "$tmp/err4"
write_default_kubectl   # 恢复默认 mock（场景⑤依赖 marker 感知）

# ==== 场景⑤：单节点目标亦合法（无 ≥2 限制）========================
reset_state
echo 1024000 >"$FIXTURES/hp_10.0.0.2"
touch "$FIXTURES/marker_kubelet_10.0.0.2"
out=$(TARGET_HOSTS='[{"ip":"10.0.0.2","user":"root"}]' TARGET_IPS='["10.0.0.2"]' bash "$script") || {
  echo "scenario5 failed:" >&2; echo "$out" >&2; exit 1
}
grep -Fq 'node-2: 大页已达标' <<<"$out"
grep -Fq 'EMS_HUGEPAGES_OK=1' <<<"$out"

# ==== 场景⑥：MemAvailable 不足 → 预检秒级失败（不启动写入器）===========
reset_state
echo 104857600 >"$FIXTURES/memavail_10.0.0.1"   # 100Gi（远低于 2000+200 余量）
rc=0
TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" bash "$script" >/dev/null 2>"$tmp/err6" || rc=$?
[[ "$rc" == 1 ]] || { echo "scenario6 expected exit 1, got $rc" >&2; exit 1; }
grep -Fq '可用内存不足（还需配 2000Gi，MemAvailable 100Gi < 需求 2200Gi 含 200Gi 余量）' "$tmp/err6"
grep -Fq '诊断（人工确认后清理' "$tmp/err6"
grep -Fq 'python train.py' "$tmp/err6"            # Top 大内存进程已列出
grep -Fq '/dev/shm' "$tmp/err6"                   # shm 占用已列出
grep -Fq '孤儿文件可 rm' "$tmp/err6"
! grep -Fq 'nr_hugepages' "$FIXTURES/ssh.log"     # 未启动写入器
! grep -Fq 'kubelet-restarted' "$FIXTURES/ssh.log"

# ==== 场景⑦：重跑续配——已锁 1618Gi/可用 1195Gi（不够全量 2200 但够差额+余量）→ 预检放行 ====
reset_state
echo 828395 >"$FIXTURES/hp_10.0.0.1"          # 已锁 1618Gi（真实 126 节点现场值）
echo 1024000 >"$FIXTURES/hp_10.0.0.2"
echo 1252969504 >"$FIXTURES/memavail_10.0.0.1"  # 可用 1195Gi
touch "$FIXTURES/marker_kubelet_10.0.0.1"       # allocatable 已达标（此前轮次刷过）
out=$(TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" bash "$script") || {
  echo "scenario7 failed:" >&2; echo "$out" >&2; exit 1
}
grep -Fq 'node-1: 预检通过（还需 382Gi，MemAvailable 1194Gi ≥ 582Gi）' <<<"$out"
grep -Fq 'node-1: 828395 页 → 1024000 页' <<<"$out"
grep -Fq 'EMS_HUGEPAGES_OK=1' <<<"$out"

echo 'PASS: ems-hugepages contract (fresh alloc, all-satisfied skip, stuck timeout, allocatable fail, single node, mem precheck, resume precheck)'
