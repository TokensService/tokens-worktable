#!/usr/bin/env bash
set -euo pipefail

# ems-hugepages.sh 契约测试：mock kubectl/ssh/scp/sleep（stateful，per-node 大页文件），
# 覆盖：① 全新配置（双节点写入 + kubelet 刷新 + 终验契约）
#      ② 全部原已达标（跳过写入与重启，契约 RENEWED/RESTARTED 为空）
#      ③ 大页卡死不涨 → 压实/重算/自愈均无果，超时顺延后失败
#      ④ kubelet 重启后 allocatable 仍不达标 → 失败
#      ⑤ 单节点目标亦合法（无 ≥2 限制）
#      ⑥ MemAvailable 不足 → 只读预检秒级失败并输出诊断（不启动写入器）
#      ⑦ 重跑续配预检（已锁部分不再占可用内存）
#      ⑧ 跨 region（hd2 形态）endpoint 身份映射解析
#      ⑨ 写入器存活窗口早于压实完成退出 → 重启自愈后到位（243 现场回放）
#      ⑩ 配额重算算法：NUMA 容量上限 + buddy 高阶块比例分配、总量守恒。
#      ⑪ 超额护栏：节点物理大页 > 目标 → 告警 + 契约 EMS_HUGEPAGES_OVERPROVISIONED（不失败）。
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
  *'test -f /tmp/ems_hp_done'*)
    # 写入器存活检查：fixture 标记「写入器已退出」时才为真
    [[ -e "\$FIXTURES/hp_exit_\$ip" ]] ;;
  *'buddyinfo'*) exit 1 ;;                          # 配额重算采集：默认失败（静默跳过）
  *'HugePages_Free'*)
    # 超额护栏的物理快照：Total/Free + 每 NUMA（hp 与 hp_numa_* 由用例预置）
    printf 'HugePages_Total:    %s\nHugePages_Free:     0\n' "\$(cat "\$FIXTURES/hp_\$ip" 2>/dev/null || echo 0)"
    for n in 0 1 2 3; do printf 'numa node%s %s\n' "\$n" "\$(cat "\$FIXTURES/hp_numa_\${n}_\$ip" 2>/dev/null || echo 0)"; done ;;
  *'HugePages_Total'*) echo "HugePages_Total:    \$(cat "\$FIXTURES/hp_\$ip" 2>/dev/null || echo 0)" ;;
  *'nr_hugepages'*)
    # 后台写入器（启动/重启）：置该节点大页为达标；fixture 标记 hp_late 时本次启动
    # 不落盘（模拟存活窗口内未写满即退出，自愈重启后才置达标——压实成果被收割）。
    # 必须排在 ems_hp_until / rm -f 之前：写入器命令同时含三者特征
    if [[ -e "\$FIXTURES/hp_stuck_\$ip" ]]; then echo 'launch: stuck writer' >>"\$FIXTURES/ssh.log"
    elif [[ -e "\$FIXTURES/hp_late_\$ip" ]]; then
      rm -f "\$FIXTURES/hp_late_\$ip"
      echo 'launch: writer exits before filling' >>"\$FIXTURES/ssh.log"
    else echo 1024000 >"\$FIXTURES/hp_\$ip"; echo 'launch: nohup writer' >>"\$FIXTURES/ssh.log"; fi ;;
  *'ems_hp_until'*) exit 0 ;;                       # 主动压实触发 + 写入器存活窗口顺延（或配额初始化，均 exit 0）
  *'rm -f /tmp/ems_hp_done'*) exit 0 ;;             # 配额文件初始化兑底
  *'/tmp/ems_hp_quota'*) exit 0 ;;                  # 配额重算写回
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
grep -Fq 'node-1: 大页到位（1024000 页，' <<<"$out"
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

# ==== 场景③：大页卡死不涨 → 压实/重算/自愈无果，超时顺延后失败 ======
reset_state
touch "$FIXTURES/hp_stuck_10.0.0.1"
rc=0
TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" bash "$script" >/dev/null 2>"$tmp/err3" || rc=$?
[[ "$rc" == 1 ]] || { echo "scenario3 expected exit 1, got $rc" >&2; exit 1; }
grep -Fq 'node-1 大页 970s 内未到位（0/1024000' "$tmp/err3"      # 首次压实顺延（70s+900s）
grep -Fq '已自动尝试 1 次主动压实' "$tmp/err3"
grep -Fq '配额重算与写入器重启仍不足' "$tmp/err3"
grep -Fq '请人工释放内存或重启节点后重跑本 step' "$tmp/err3"

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

# ==== 场景⑧：跨 region（hd2 形态）——TARGET_IPS 为外网 endpoint，身份映射解析 ====
tmp8=$(mktemp -d)
mkdir -p "$tmp8/bin"
cat >"$tmp8/nodes.json" <<'JSON'
{"items": [
  {"metadata": {"name": "tokens-engine-bnt3-13lrp"},
   "status": {"addresses": [{"type": "InternalIP", "address": "192.168.31.140"}],
              "conditions": [{"type": "Ready", "status": "True"}],
              "capacity": {"hugepages-2Mi": "2000Gi"}, "allocatable": {"hugepages-2Mi": "0", "cpu": "256"}}},
  {"metadata": {"name": "tokens-engine-bnt3-9d0ee"},
   "status": {"addresses": [{"type": "InternalIP", "address": "192.168.31.120"}],
              "conditions": [{"type": "Ready", "status": "True"}],
              "capacity": {"hugepages-2Mi": "2000Gi"}, "allocatable": {"hugepages-2Mi": "0", "cpu": "256"}}}
]}
JSON
cat >"$tmp8/bin/kubectl" <<EOF
#!/usr/bin/env bash
if [[ "\$1 \$2" == 'version --request-timeout=5s' ]]; then exit 0; fi
case "\$*" in
  'get nodes -o json')
    python3 -c '
import json, os
fx = os.environ["FIXTURES"]
items = []
for node in json.load(open(fx + "/nodes.json"))["items"]:
    ip = next(a["address"] for a in node["status"]["addresses"] if a["type"] == "InternalIP")
    if os.path.exists(f"{fx}/marker_kubelet_{ip}"):
        node = dict(node)
        node["status"] = dict(node["status"])
        node["status"]["allocatable"] = dict(node["status"]["allocatable"], **{"hugepages-2Mi": "2000Gi"})
    items.append(node)
print(json.dumps({"items": items}))' ;;
  'get node '*)
    name=\$3
    python3 -c '
import json, os, sys
fx, name = os.environ["FIXTURES"], sys.argv[1]
node = next(n for n in json.load(open(fx + "/nodes.json"))["items"] if n["metadata"]["name"] == name)
ip = next(a["address"] for a in node["status"]["addresses"] if a["type"] == "InternalIP")
if os.path.exists(f"{fx}/marker_kubelet_{ip}"):
    node = dict(node)
    node["status"] = dict(node["status"])
    node["status"]["allocatable"] = dict(node["status"]["allocatable"], **{"hugepages-2Mi": "2000Gi"})
print(json.dumps(node))' "\$name" ;;
  *) echo "unexpected kubectl call: \$*" >&2; exit 1 ;;
esac
EOF
cat >"$tmp8/bin/ssh" <<EOF
#!/usr/bin/env bash
echo "ssh \$*" >>"\$FIXTURES/ssh.log"
cmd="\${@: -1}"
port=''; prev=''
for a in "\$@"; do [[ "\$prev" == -p ]] && port="\$a"; prev="\$a"; done
case "\$cmd" in
  *'command -v kubectl'*) exit 0 ;;
  *'hostname -I'*)
    # 身份采集（dispatch 阶段）：外网 endpoint → 内网身份
    case "\$port" in
      2224) printf 'tokens-engine-bnt3-13lrp\n192.168.31.140 43.105.134.183\n' ;;
      2225) printf 'tokens-engine-bnt3-9d0ee\n192.168.31.120 43.105.240.70\n' ;;
    esac ;;
  *'rm -f /tmp/ems_hp_done'*) exit 0 ;;            # 配额文件初始化
  *'cat > /tmp/ems-hugepages.sh'*) exit 0 ;;
  *'bash /tmp/ems-hugepages.sh'*)
    cmd=\$(sed "s|/tmp/ems-hugepages.sh|\$REAL_SCRIPT|" <<<"\$cmd")
    eval "\$cmd" ;;
  *'MemAvailable'*)
    printf 'MemTotal:       32959684 kB\nMemAvailable:    3221225472 kB\ntmpfs  1.6T  100G   1.5T   7%% /dev/shm\n' ;;
  *'HugePages_Total'*) echo "HugePages_Total:    \$(cat "\$FIXTURES/hp_\$port" 2>/dev/null || echo 0)" ;;
  *'nr_hugepages'*) echo 1024000 >"\$FIXTURES/hp_\$port" ;;
  *'systemctl restart kubelet'*)
    case "\$port" in 2224) touch "\$FIXTURES/marker_kubelet_192.168.31.140" ;; 2225) touch "\$FIXTURES/marker_kubelet_192.168.31.120" ;; esac
    echo "kubelet-restarted @port\$port" >>"\$FIXTURES/ssh.log" ;;
  *) echo "unexpected ssh cmd: \$cmd" >&2; exit 1 ;;
esac
EOF
cat >"$tmp8/bin/scp" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$tmp8/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp8/bin/"*
out=$(FIXTURES="$tmp8" REAL_SCRIPT="$script" PATH="$tmp8/bin:$PATH" \
    TARGET_HOSTS='[{"ip":"115.33.98.101:2224","user":"root"},{"ip":"115.33.98.101:2225","user":"root"}]' \
    TARGET_IPS='["115.33.98.101:2224","115.33.98.101:2225"]' bash "$script") || {
  echo "scenario8 failed:" >&2; echo "$out" >&2; rm -rf "$tmp8"; exit 1
}
grep -Fq 'remote execution via root@115.33.98.101:2224' <<<"$out"
grep -Fq '目标节点：115.33.98.101:2224 → tokens-engine-bnt3-13lrp（endpoint 115.33.98.101:2224 访问）' <<<"$out"
grep -Fq '目标节点：115.33.98.101:2225 → tokens-engine-bnt3-9d0ee（endpoint 115.33.98.101:2225 访问）' <<<"$out"
grep -Fq 'tokens-engine-bnt3-13lrp: 大页到位（1024000 页，' <<<"$out"
grep -Fq 'tokens-engine-bnt3-9d0ee: Ready 且 allocatable 2000Gi 达标' <<<"$out"
grep -Fq 'tokens-engine-bnt3-9d0ee: 大页 1024000 页 · allocatable 2000Gi ✓' <<<"$out"
grep -Fq 'EMS_HUGEPAGES_OK=1' <<<"$out"
grep -Fq 'EMS_HUGEPAGES_RENEWED=tokens-engine-bnt3-13lrp,tokens-engine-bnt3-9d0ee' <<<"$out"
grep -Fq 'EMS_KUBELET_RESTARTED=tokens-engine-bnt3-13lrp,tokens-engine-bnt3-9d0ee' <<<"$out"
grep -Fq 'kubelet-restarted @port2224' "$tmp8/ssh.log"
grep -Fq 'kubelet-restarted @port2225' "$tmp8/ssh.log"
rm -rf "$tmp8"

# ==== 场景⑨：写入器存活窗口早于压实完成退出 → 重启自愈后到位（243 现场回放）====
reset_state
echo 652705 >"$FIXTURES/hp_10.0.0.1"             # 243 失败现场残留值
touch "$FIXTURES/hp_exit_10.0.0.1" "$FIXTURES/hp_late_10.0.0.1"
echo 1024000 >"$FIXTURES/hp_10.0.0.2"
touch "$FIXTURES/marker_kubelet_10.0.0.2"        # node-2 已达标（含 allocatable）
out=$(TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" bash "$script") || {
  echo "scenario9 failed:" >&2; echo "$out" >&2; exit 1
}
grep -Fq 'node-1: 预检通过（还需 725Gi，MemAvailable 3072Gi ≥ 925Gi）' <<<"$out"
grep -Fq 'node-1: 大页分配中（652705/1024000 页' <<<"$out"
grep -Fq 'node-1: 写入器已退出但大页未到位（压实完成晚于存活窗口的典型现场），重启写入器收割压实成果' <<<"$out"
grep -Fq '第 1 次后台主动压实' <<<"$out"
grep -Fq '写入器存活窗口与超时顺延（已等 70s → 970s）' <<<"$out"
grep -Fq 'node-1: 大页到位（1024000 页，等待 80s，压实 1 次）' <<<"$out"
grep -Fq 'EMS_HUGEPAGES_RENEWED=node-1' <<<"$out"

# ==== 场景⑩：配额重算算法（加载函数直调；243 压实后 buddy 数据回放）====
source <(sed '/^main "\$@"$/d' "$script")
info_243='/sys/devices/system/node/node0/hugepages/hugepages-2048kB 256000 49641
/sys/devices/system/node/node1/hugepages/hugepages-2048kB 256000 25165
/sys/devices/system/node/node2/hugepages/hugepages-2048kB 256000 235101
/sys/devices/system/node/node3/hugepages/hugepages-2048kB 256000 0
/sys/devices/system/node/node0/meminfo:Node 0 MemTotal:  792429596 kB
/sys/devices/system/node/node1/meminfo:Node 1 MemTotal:  792429596 kB
/sys/devices/system/node/node2/meminfo:Node 2 MemTotal:  792429596 kB
/sys/devices/system/node/node3/meminfo:Node 3 MemTotal:  792429596 kB
Node 0, zone DMA 1 0 0 0 0 0 0 0 1 1 2
Node 0, zone DMA32 8 7 3 7 8 7 6 7 7 9 252
Node 0, zone Normal 466942 193144 150467 134749 100582 66982 46775 31387 23327 18915 134224
Node 1, zone Normal 481571 130553 117982 113645 100806 75330 56136 43984 32047 23995 137138
Node 2, zone Normal 610580 160054 146576 132801 113995 97716 66610 44841 32972 23321 29397
Node 3, zone Normal 358765 151353 132114 125872 103993 74081 45953 28061 22958 13 2'
out10=$(hp_quota_recalc "$info_243")
grep -Fq '/sys/devices/system/node/node0/hugepages/hugepages-2048kB 337004' <<<"$out10"
grep -Fq '/sys/devices/system/node/node1/hugepages/hugepages-2048kB 323436' <<<"$out10"
grep -Fq '/sys/devices/system/node/node2/hugepages/hugepages-2048kB 317216' <<<"$out10"
grep -Fq '/sys/devices/system/node/node3/hugepages/hugepages-2048kB 46344' <<<"$out10"
# 总量守恒
sum10=$(awk '{s+=$2} END{print s+0}' <<<"$out10")
[[ "$sum10" == 1024000 ]] || { echo "scenario10 total mismatch: $sum10" >&2; exit 1; }
# 子场景 b：buddy 富余充足 → 按 room 比例分配（总量守恒且不超各 NUMA 可达额）
info2='/sys/devices/system/node/node0/hugepages/hugepages-2048kB 256000 100000
/sys/devices/system/node/node1/hugepages/hugepages-2048kB 256000 100000
/sys/devices/system/node/node0/meminfo:Node 0 MemTotal:  819200000 kB
/sys/devices/system/node/node1/meminfo:Node 1 MemTotal:  819200000 kB
Node 0, zone Normal 1 2 3 4 5 6 7 8 9 52000 4000
Node 1, zone Normal 1 2 3 4 5 6 7 8 9 5000 147500'
out10b=$(hp_quota_recalc "$info2")
grep -Fq '/sys/devices/system/node/node0/hugepages/hugepages-2048kB 152000' <<<"$out10b"
grep -Fq '/sys/devices/system/node/node1/hugepages/hugepages-2048kB 360000' <<<"$out10b"
# 子场景 c：已无缺口 → 无输出（静默）
info3='/sys/devices/system/node/node0/hugepages/hugepages-2048kB 256000 256000
/sys/devices/system/node/node1/hugepages/hugepages-2048kB 256000 256000
Node 0, zone Normal 1 1 1 1 1 1 1 1 1 1 1
Node 1, zone Normal 1 1 1 1 1 1 1 1 1 1 1'
out10c=$(hp_quota_recalc "$info3")
[[ -z "$out10c" ]] || { echo "scenario10c expected empty, got: $out10c" >&2; exit 1; }

# ==== 场景⑪：超额护栏——物理大页 > 目标 → 告警 + 契约，不失败 ==================
reset_state
echo 1312855 >"$FIXTURES/hp_10.0.0.1"            # 113 现场：物理 2564Gi > 目标 2000Gi
echo 330511 >"$FIXTURES/hp_numa_0_10.0.0.1"
echo 277977 >"$FIXTURES/hp_numa_1_10.0.0.1"
echo 373577 >"$FIXTURES/hp_numa_2_10.0.0.1"
echo 330790 >"$FIXTURES/hp_numa_3_10.0.0.1"
echo 1024000 >"$FIXTURES/hp_10.0.0.2"            # node-2 正常（恰好达标）
touch "$FIXTURES/marker_kubelet_10.0.0.1" "$FIXTURES/marker_kubelet_10.0.0.2"
out=$(TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" bash "$script") || {
  echo "scenario11 failed:" >&2; echo "$out" >&2; exit 1
}
grep -Fq 'node-1: 大页已达标（1312855 页 ≥ 1024000），跳过' <<<"$out"
grep -Fq '警告: node-1 大页超额预留 —— 物理 1312855 页 > 目标 1024000 页（多 288855 页 ≈ 564Gi），每 NUMA node0=330511 node1=277977 node2=373577 node3=330790' <<<"$out"
grep -Fq '警告: node-1 超额部分为已预留但闲置的大页，内核无法运行时缩回（需重启节点回收）' <<<"$out"
grep -Fq '警告: node-1 allocatable 2000Gi < 物理大页 2564Gi —— kubelet 采集滞后，重启 kubelet 可对齐' <<<"$out"
grep -Fq 'EMS_HUGEPAGES_OK=1' <<<"$out"
grep -Fq 'EMS_HUGEPAGES_OVERPROVISIONED=node-1' <<<"$out"
grep -Fq 'EMS_HUGEPAGES_RENEWED=' <<<"$out"

# ==== 场景①：物理恰好达标（无超额）→ 无超额告警、契约字段为空 ==================
reset_state
echo 1024000 >"$FIXTURES/hp_10.0.0.1"; echo 1024000 >"$FIXTURES/hp_10.0.0.2"
touch "$FIXTURES/marker_kubelet_10.0.0.1" "$FIXTURES/marker_kubelet_10.0.0.2"
out=$(TARGET_HOSTS="$HOSTS" TARGET_IPS="$IPS" bash "$script") || {
  echo "scenario11b failed:" >&2; echo "$out" >&2; exit 1
}
! grep -Fq '超额预留' <<<"$out" || { echo "scenario11b unexpected overprov warning" >&2; exit 1; }
grep -Fq 'EMS_HUGEPAGES_OVERPROVISIONED=' <<<"$out"

 echo 'PASS: ems-hugepages contract (fresh alloc, all-satisfied skip, stuck timeout+recompact, allocatable fail, single node, mem precheck, resume precheck, cross-region endpoint, writer-revive heal, quota rebalance, overprovision guard)'
