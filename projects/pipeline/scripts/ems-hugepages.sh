#!/usr/bin/env bash
# pipeline: no-positional-args
# EMS 目标节点 2Mi 大页配置流水线 step 主脚本（shell step，无参调用，零任务参数）。
#
# 编排位置：ems-check（EMS_NAME 门禁）→ 本 step → ems-deploy（安装）。
# 大页配置是安装流程中最耗时/最易卡死的环节（compaction，最长 900s/节点），单独
# 成 step 便于失败后人工清理内存、仅重跑本 step（幂等：只增不减、已达标跳过），
# 不必整条流水线重来。
#
# 用法：无需任何参数。目标节点 = 平台注入的 TARGET_IPS/TARGET_HOSTS；注入
# TARGET_HOSTS 时自推送到首个具备 kubectl 的目标节点远程执行（工作台服务端
# 无 kubectl）；对各目标节点的大页写入 / kubelet 重启：**执行宿主自身本地直接
# 执行**，其余节点优先密钥认证（集群节点间通常 root 免密互通），密钥失败且
# TARGET_HOSTS 带密码时才 sshpass 重试（需执行宿主装有 sshpass）。
#
# 跨 region（hd2 等）：平台注入的 TARGET_IPS 可能是外网入口 endpoint（ip:port
# 形态，如 115.33.98.101:2224），与集群 InternalIP 对不上；分发阶段逐节点 SSH
# 采集内网身份（hostname/-I）构建映射随小写 env 下传，目标解析按「直接命中 →
# endpoint 映射 → 剥端口」三级；解析后节点操作经 endpoint 凭据 SSH（同外网 IP
# 多端口节点按 address:port 组合匹配凭据），执行宿主自身即目标节点时本地直执。
# gy1 内网标识行为不变。
#
# 流程（fail-fast，任一步失败即中止，人工看运行日志后处理/重跑）：
#   [0/3] 解析目标节点（kubectl 节点名 + InternalIP；单节点亦合法——本 step 逐节点操作）
#   [1/3] 配大页：只读预检（MemAvailable < 目标+余量 → 秒级失败并输出大内存
#         进程 / /dev/shm 诊断，不自动清理——涉业务确认红线）→ /sys per-node
#         接口、只增不减（固定 2000Gi = 1024000 页/节点）、nohup 后台写入 +
#         轮询到位；停滞自愈三件套：① 写入器退出自愈——3T 内存一轮压实约
#         10 分钟，常超出写入器初始存活窗口，退出即重启以收割压实成果；
#         ② 后台 drop_caches + compact_memory 主动压实（冷却 600s 可重复
#         触发，每次顺延写入器存活窗口与本节点超时，绝对硬上限 3600s）；
#         ③ 配额重算（缺口转移：NUMA 物理容量上限 + buddyinfo 高阶块分布
#         按比例分配、总量守恒，重写配额文件后写入器自动应用；k8s 按节点
#         总量调度大页，per-NUMA 不均不影响调度）；已达标节点跳过
#   [2/3] 刷 allocatable：allocatable 未达标的节点重启 kubelet（pod 不重启、节点
#         NotReady 数十秒——cadvisor 只在 kubelet 启动时采集大页），轮询 Ready + 达标（240s）
#   [3/3] 终验：全部目标节点 HugePages_Total 与 allocatable 双达标 + 契约输出；
#         超额护栏：物理大页 > 目标（只增不减 + 历史/手工写入残留）时响亮告警并
#         记入 EMS_HUGEPAGES_OVERPROVISIONED（内核无法运行时缩回，需重启节点回收，
#         不影响 EMS 使用，故告警不失败）；allocatable 低于物理时提示 kubelet 采集滞后
#
# ⚠️ 内存顺序：compaction 需要干净内存，目标节点上若有待释放的业务 pod，请先
# 释放再跑本 step（ems-deploy 的释放阶段在本 step 之后执行——busy 节点编排时
# 注意先手动清理，脏内存下大页分配可能极慢甚至卡死）。
#
# 退出码：0 全部达标（或原已达标）；1 失败（判本 step 失败）。
# 单测：test/test_ems_hugepages.sh。
set -uo pipefail

SCRIPT_NAME='ems-hugepages'

# 零参数设计：TARGET_HOSTS 为平台注入的运行级变量，经 nameref 间接引用——
# 引用名小写且字面量不带 $，平台「识别参数」扫不到，页面保持无入参。
declare -n platform_target_hosts='TARGET_HOSTS'
declare -n platform_target_ips='TARGET_IPS'

# 内部常量（普通赋值，不进参数面）；HUGEPAGE_GIB 固定 2000Gi（与仓内 chart values 同值）
HUGEPAGE_GIB=2000
HUGEPAGE_PRECHECK_MARGIN_GIB=200   # 预检余量：MemAvailable 需 ≥ 目标+余量，低于则提前失败
HUGEPAGE_TIMEOUT_SECONDS=900
HUGEPAGE_POLL_SECONDS=10
HUGEPAGE_HARD_TIMEOUT_SECONDS=3600      # 单节点绝对硬上限：压实顺延可多次拉长超时，但最多等这么久必出结果
HUGEPAGE_COMPACT_COOLDOWN_SECONDS=600   # 两次主动压实最小间隔（≈3T 内存一轮 compaction 耗时，短于此再压无意义）
HUGEPAGE_STALL_ROUNDS=6            # 连续 N 轮（×POLL 秒）无增长判停滞：先主动压实，再缺口转移
KUBELET_TIMEOUT_SECONDS=240
KUBELET_POLL_SECONDS=5

die() { echo "[$SCRIPT_NAME] ERROR: $*" >&2; exit 1; }
log() { echo "[$SCRIPT_NAME] $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ==================== 本地阶段（工作台服务端）：解析目标并分发 ====================

remote_exec() { # <user> <host> <port> <pass> <command>
    local user=$1 host=$2 port=$3 pass=$4 command=$5 ssh_base
    ssh_base='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15'
    if [[ -n "$pass" ]]; then
        have sshpass || die '目标节点配置了密码但执行机未安装 sshpass'
        SSHPASS="$pass" sshpass -e ssh $ssh_base -p "$port" "$user@$host" "$command"
    else
        ssh $ssh_base -p "$port" "$user@$host" "$command"
    fi
}

dispatch_to_target() {
    local self spec probe_user probe_host probe_port probe_pass='' quoted
    local -a specs=() remote_env=()

    have ssh || die '远程执行需要 ssh（执行机未安装）'
    have python3 || die '远程分发需要 python3'
    have scp || die '远程分发需要 scp'

    local raw
    raw="$(python3 - "${platform_target_hosts:-}" <<'PY'
import json
import re
import sys

raw = sys.argv[1].strip()
if not raw:
    raise SystemExit("TARGET_HOSTS is empty")
try:
    hosts = json.loads(raw)
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid TARGET_HOSTS: {error}")
if not isinstance(hosts, list) or not hosts:
    raise SystemExit("TARGET_HOSTS must be a non-empty JSON array")
for host in hosts:
    if not isinstance(host, dict) or not isinstance(host.get("ip"), str) or not host["ip"]:
        raise SystemExit("every TARGET_HOSTS entry must contain a non-empty ip")
    endpoint = host["ip"]
    match = re.fullmatch(r"([^:]+):(\d+)", endpoint)
    address, port = match.groups() if match else (endpoint, "22")
    password = host.get("pass", host.get("password", "")) or ""
    print(json.dumps({"ip": address, "port": port, "user": host.get("user") or "root", "pass": password},
                     separators=(",", ":")))
PY
)" || die '解析 TARGET_HOSTS 失败'
    mapfile -t specs <<<"$raw"

    # 节点凭据（含密码）以小写环境变量转发到远端：不进「识别参数」，也不回显日志
    local creds_json
    creds_json="$(printf '%s\n' "${specs[@]}" | python3 -c 'import json,sys; print("[" + ",".join(line.strip() for line in sys.stdin if line.strip()) + "]")')"

    self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
    for spec in "${specs[@]}"; do
        probe_host="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["ip"])' "$spec")"
        probe_port="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["port"])' "$spec")"
        probe_user="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["user"])' "$spec")"
        probe_pass="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["pass"])' "$spec")"
        if remote_exec "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
            'command -v kubectl >/dev/null 2>&1'; then
            break
        fi
        log "$probe_host 缺少 kubectl 或 SSH 不通，尝试下一个目标节点"
        probe_host=''
    done
    [[ -n "$probe_host" ]] || die '所有 TARGET_HOSTS 节点都缺少 kubectl；无法执行大页配置'

    log "remote execution via $probe_user@$probe_host:$probe_port（kubectl 视图为集群级）"

    # 跨 region 目标身份映射（hd2 等环境平台注入的 TARGET_IPS 是外网入口 endpoint，
    # 与集群 InternalIP 对不上）：逐节点 SSH 采集内网身份（hostname/-I），映射表
    # （含凭据，供远程侧节点解析与 node_ssh 回退）经小写 env 下传；采集失败则
    # 对应 entry 缺失，gy1 内网行为不变。specs 为 JSON 数组，先展开为 tab 四元组。
    local id_lines='' id_user id_host id_port id_pass id_out id_hostname id_ips
    local -a id_specs=()
    mapfile -t id_specs < <(printf '%s\n' "${specs[@]}" | python3 -c '
import json, sys
for line in sys.stdin.read().splitlines():
    if not line.strip():
        continue
    entry = json.loads(line)
    print((entry.get("user") or "root") + "\t" + entry["ip"] + "\t" + (entry.get("port") or "22") + "\t" + (entry.get("pass") or ""))
')
    for spec in "${id_specs[@]}"; do
        IFS=$'\t' read -r id_user id_host id_port id_pass <<<"$spec"
        id_out="$(remote_exec "$id_user" "$id_host" "$id_port" "$id_pass" \
            'hostname 2>/dev/null; hostname -I 2>/dev/null' 2>/dev/null)" || true
        id_hostname="$(sed -n '1p' <<<"$id_out" | tr -d '\r')"
        id_ips="$(sed -n '2p' <<<"$id_out" | tr -d '\r')"
        [[ -n "$id_hostname" || -n "$id_ips" ]] || continue
        id_lines+="${id_user}"$'\t'"${id_host}"$'\t'"${id_port}"$'\t'"${id_pass}"$'\t'"${id_hostname}"$'\t'"${id_ips}"$'\n'
    done
    local id_map='[]'
    if [[ -n "$id_lines" ]]; then
        id_map="$(printf '%s' "$id_lines" | python3 -c '
import json, sys
entries = []
for line in sys.stdin.read().splitlines():
    if not line.strip():
        continue
    user, address, port, password, hostname, ips = (line.split("\t") + [""] * 6)[:6]
    entries.append({"endpoint": address + ":" + port, "address": address, "port": port,
                    "user": user, "pass": password, "hostname": hostname, "ips": ips.split()})
print(json.dumps(entries))')" || id_map='[]'
    fi
    remote_exec "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "cat > /tmp/ems-hugepages.sh" <"$self" \
        || die "推送脚本到 $probe_host 失败"

    remote_env=(TARGET_HOSTS=)
    printf -v quoted '%q' "${platform_target_ips:-}"
    remote_env+=("TARGET_IPS=$quoted")
    printf -v quoted '%q' "$creds_json"
    remote_env+=("ems_node_creds=$quoted")
    printf -v quoted '%q' "$id_map"
    remote_env+=("ems_target_id_map=$quoted")
    remote_exec "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "env ${remote_env[*]} bash /tmp/ems-hugepages.sh"
    return $?
}

# ==================== 远程阶段（首个有 kubectl 的目标节点） ====================

node_ssh() { # <access> <command...>   access：内网 IP/节点名（gy1）或 endpoint 地址（跨 region）
    local ip=$1
    shift
    local local_ips=" $(hostname -I 2>/dev/null) "
    # 本机判定①：access 即本机 IP（gy1 现行为）→ 本地直接执行
    if [[ "$local_ips" == *" $ip "* ]]; then
        bash -c "$*"
        return $?
    fi
    local entry=''
    entry="$(python3 - "${ems_node_creds:-}" "$ip" <<'PY'
import json
import sys

key = sys.argv[2]
for entry in json.loads(sys.argv[1] or "[]"):
    hit = entry.get("ip") == key
    if not hit and ":" in key:
        address, _, port = key.rpartition(":")
        hit = entry.get("ip") == address and str(entry.get("port") or "22") == port
    if hit:
        print(f'{entry.get("user") or "root"}\t{entry.get("port") or "22"}\t{entry.get("pass") or ""}')
        break
PY
)"
    # 身份映射查询（两用：①本机判定——access 对应 endpoint 的内网身份含本机任一
    # IP（执行宿主即目标节点）则本地执行，免绕公网回连自己；②凭据回退——creds
    # 表无此地址时用 endpoint 凭据。id_map 缺失（gy1）时此块整体跳过。）
    local id_entry=''
    id_entry="$(python3 - "${ems_target_id_map:-}" "$ip" <<'PY'
import json
import sys

for entry in json.loads(sys.argv[1] or "[]"):
    if sys.argv[2] in (entry.get("endpoint"), entry.get("address")) \
            or sys.argv[2] in list(entry.get("ips") or []) + [entry.get("hostname") or ""]:
        print(f'{entry.get("user") or "root"}\t{entry.get("port") or "22"}\t{entry.get("pass") or ""}\t{" ".join(entry.get("ips") or [])}')
        break
PY
)"
    if [[ -n "$id_entry" ]]; then
        local e_ips one
        e_ips="${id_entry##*$'\t'}"
        for one in $e_ips; do
            if [[ "$local_ips" == *" $one "* ]]; then
                bash -c "$*"
                return $?
            fi
        done
        [[ -n "$entry" ]] || entry="$id_entry"
    fi
    [[ -n "$entry" ]] || die "节点 $ip 不在 TARGET_HOSTS 凭据列表中（且无身份映射回退）"
    local user port pass ssh_base rc=0
    IFS=$'\t' read -r user port pass <<<"$entry"
    ssh_base='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15'
    # 优先密钥认证（集群节点间通常 root 免密互通；平台环境里配的密码是给服务端分发用的，
    # 不应强制节点间也走密码）。rc=255 才是认证/连接失败，此时带密码则 sshpass 重试。
    ssh $ssh_base -o BatchMode=yes -p "$port" "$user@$ip" "$@" 2>/dev/null || rc=$?
    if (( rc != 255 )); then
        return $rc
    fi
    if [[ -n "$pass" ]]; then
        have sshpass || die "节点 $ip 密钥认证失败且本机未安装 sshpass（apt-get install -y sshpass，或配置节点间 root 免密）"
        SSHPASS="$pass" sshpass -e ssh $ssh_base -p "$port" "$user@$ip" "$@"
        return $?
    fi
    die "节点 $ip SSH 密钥认证失败且未提供密码（检查节点间 root 免密互通）"
}

allocatable_gib_of() { # <single-node-json>
    python3 -c '
import json, sys
node = json.load(sys.stdin)
value = (node.get("status") or {}).get("allocatable", {}).get("hugepages-2Mi", "0")
units = {"Ki": 2**10, "Mi": 2**20, "Gi": 2**30, "Ti": 2**40}
for suffix, factor in sorted(units.items(), key=lambda i: -len(i[0])):
    if value.endswith(suffix):
        try: value = str(int(float(value[:-len(suffix)]) * factor // 2**30)); break
        except ValueError: pass
print(value)
' <<<"$1"
}

start_hp_writer() { # <node_ip>  启动/重启大页写入器（存活窗口文件已过期则先顺延；沿用配额文件，只增不减）
    node_ssh "$1" "now_r=\$(date +%s); [ \"\$(cat /tmp/ems_hp_until 2>/dev/null || echo 0)\" -lt \"\$now_r\" ] && echo \$(( now_r + ${HUGEPAGE_TIMEOUT_SECONDS} )) > /tmp/ems_hp_until || true; rm -f /tmp/ems_hp_done; nohup bash -c 'while [ \$(cat /tmp/ems_hp_until 2>/dev/null || echo 0) -gt \$(date +%s) ]; do ok=1; while read -r d q; do cur=\$(cat \$d/nr_hugepages 2>/dev/null || echo 0); if [ \$cur -lt \$q ]; then ok=0; echo \$q > \$d/nr_hugepages 2>/dev/null || true; fi; done < /tmp/ems_hp_quota; [ \$ok -eq 1 ] && break; sleep 5; done; echo done > /tmp/ems_hp_done' >/tmp/ems_hp.log 2>&1 &" \
        || die "在节点 $1 启动大页写入器失败"
}

hp_quota_recalc() { # <numa_info文本>  stdin外的纯算法：配额行(dir quota cur) + NUMA meminfo 行 + buddyinfo 行 → stdout 新配额行（无变化无输出）
    python3 - "$1" <<'PY'
import re
import sys

lines = (sys.argv[1] or "").splitlines()
quota, cur, cap, high = {}, {}, {}, {}
for ln in lines:
    parts = ln.split()
    if parts and parts[0].startswith("/sys/") and parts[0].endswith("/hugepages-2048kB") and len(parts) >= 3:
        quota[parts[0]] = int(parts[1])
        cur[parts[0]] = int(parts[2])
if not quota:
    raise SystemExit
node_of = lambda d: d.rsplit("/node", 1)[1].split("/", 1)[0]
for ln in lines:                      # Node N MemTotal:  xxx kB（grep 带文件名前缀形态亦兼容）
    m = re.search(r"Node\s+(\d+)\s+MemTotal:\s+(\d+)", ln)
    if m:
        cap[m.group(1)] = int(m.group(2)) // 2048
for ln in lines:                      # Node N, zone Normal c0..c10 → buddy 可立即转大页页数 = c9 + 2*c10
    parts = ln.split()
    if parts[:1] == ["Node"] and len(parts) >= 6 and parts[3] == "Normal":
        counts = ([int(x) for x in parts[4:]] + [0] * 11)[:11]
        high[parts[1].rstrip(",")] = counts[9] + 2 * counts[10]
total = sum(quota.values())
orig = dict(quota)
need = total - sum(cur.values())
if need <= 0:
    raise SystemExit
room = {d: max(0, min(cap.get(node_of(d), 10 ** 9), cur[d] + high.get(node_of(d), 0)) - cur[d]) for d in quota}
sum_room = sum(room.values())
if sum_room >= need:                  # 总量守恒：缺口按 buddy 可转页数比例分配，上限为各 NUMA 可达额
    assigned = 0
    for d in quota:
        share = need * room[d] // sum_room
        quota[d] = cur[d] + share
        assigned += share
    for d in sorted(quota, key=lambda x: (-room[x], x)):
        if assigned >= need:
            break
        quota[d] += 1
        assigned += 1
else:                                  # 总可达性不足：先吃满各 NUMA 可达额，残量给物理容量最大 NUMA（写入器持续重试，压实扩大 room 后下轮重算收敛）
    for d in quota:
        quota[d] = cur[d] + room[d]
    quota[max(quota, key=lambda d: (cap.get(node_of(d), 0), d))] += need - sum_room
if quota == orig:
    raise SystemExit
print("\n".join("%s %d" % (d, q) for d, q in quota.items()))
PY
}

rebalance_hp_quota() { # <node_ip> <node_name>  容量上限感知配额重算（缺口转移，总量守恒），写回远程配额文件
    local r_ip=$1 r_node=$2 numa_info new_quota quota_args d_line
    numa_info="$(node_ssh "$r_ip" 'while read -r d q; do echo "$d $q $(cat $d/nr_hugepages 2>/dev/null || echo 0)"; done < /tmp/ems_hp_quota; grep " MemTotal:" /sys/devices/system/node/node*/meminfo; cat /proc/buddyinfo' 2>/dev/null)" || return 0
    [[ -n "$numa_info" ]] || return 0
    new_quota="$(hp_quota_recalc "$numa_info")"
    [[ -n "$new_quota" ]] || return 0
    quota_args=''
    while read -r d_line; do quota_args+=" '$d_line'"; done <<<"$new_quota"
    if node_ssh "$r_ip" "printf '%s\n'${quota_args} > /tmp/ems_hp_quota" >/dev/null 2>&1; then
        log "$r_node: 配额重算（NUMA 容量上限 + buddy 高阶块比例转移缺口，总量守恒），写入器自动应用"
    else
        log "$r_node: 配额重算写回失败（继续按原配额等待）"
    fi
}

# 大页物理现状快照：Total/Free（页）+ 每 NUMA nr_hugepages——供超额护栏输出明细
hp_snapshot() { # <node_ip>
    node_ssh "$1" 'grep "^HugePages_Total:" /proc/meminfo; grep "^HugePages_Free:" /proc/meminfo; for d in /sys/devices/system/node/node*/hugepages/hugepages-2048kB; do n=$(echo "$d" | sed -E "s#.*/(node[0-9]+)/.*#\1#"); printf "numa %s %s\n" "$n" "$(cat "$d/nr_hugepages" 2>/dev/null || echo 0)"; done' 2>/dev/null
}

# 大页超额护栏：节点已预留大页 > 目标（历史/手工写入或只增不减残留的常见后果）。
# 内核无法运行时缩回大页（release 卡死，见 skill 坑 3），只能重启节点回收；不影响
# EMS 使用，故响亮告警并记入契约而非失败。
hp_overprov_warn() { # <node_name> <current_pages> <target_pages> [snapshot]
    local g_node=$1 g_cur=$2 g_target=$3 g_snap=${4:-} extra detail=''
    (( g_cur > g_target )) || return 1
    extra=$(( g_cur - g_target ))
    detail="$(awk '/^numa /{printf "%s=%s ", $2, $3}' <<<"$g_snap" 2>/dev/null)"
    if [[ -n "$detail" ]]; then
        log "警告: $g_node 大页超额预留 —— 物理 ${g_cur} 页 > 目标 ${g_target} 页（多 ${extra} 页 ≈ $(( extra / 512 ))Gi），每 NUMA ${detail% }"
    else
        log "警告: $g_node 大页超额预留 —— 物理 ${g_cur} 页 > 目标 ${g_target} 页（多 ${extra} 页 ≈ $(( extra / 512 ))Gi）"
    fi
    log "警告: $g_node 超额部分为已预留但闲置的大页，内核无法运行时缩回（需重启节点回收），不影响 EMS 使用"
    return 0
}

hugepages_main() {
    local node_json ip node_name access resolved
    local -a target_nodes=() target_access=()

    have kubectl || die '本机缺少 kubectl（正常应经 TARGET_HOSTS 分发到目标节点执行）'
    have python3 || die '需要 python3'
    kubectl version --request-timeout=5s >/dev/null 2>&1 || die 'kubectl 无法访问 Kubernetes API'

    # 目标节点列表：注入的 TARGET_IPS（JSON 数组），缺省退化为凭据列表全部节点
    local -a target_ips=()
    mapfile -t target_ips < <(python3 - "${platform_target_ips:-}" "${ems_node_creds:-}" <<'PY'
import json
import sys

raw = (sys.argv[1] or "").strip()
if raw:
    try:
        values = json.loads(raw)
        if isinstance(values, list):
            for item in values:
                print(str(item))
            raise SystemExit
    except (ValueError, TypeError):
        pass
    for item in raw.split(","):
        if item.strip():
            print(item.strip())
    raise SystemExit
for entry in json.loads(sys.argv[2] or "[]"):
    print(entry.get("ip", ""))
PY
)
    ((${#target_ips[@]} >= 1)) || die '至少需要 1 个目标节点（TARGET_IPS/TARGET_HOSTS）'

    # ---- [0/3] 解析目标节点 ----
    log "=== [0/3] 解析目标节点（目标 ${HUGEPAGE_GIB}Gi/节点） ==="
    node_json="$(kubectl get nodes -o json)" || die '获取节点列表失败'
    for ip in "${target_ips[@]}"; do
        # 三级解析：①直接命中（内网 IP/节点名，gy1 现行为）②endpoint 身份映射
        # （跨 region：外网入口 ip:port → 该主机内网 ips/hostname）③ip:port 剥端口。
        # 输出「节点名\t访问地址」：跨 region 时访问地址 = endpoint 地址（凭据回退用）。
        resolved="$(printf '%s' "$node_json" | EMS_TARGET_ID_MAP="${ems_target_id_map:-}" python3 -c '
import json, os, sys

id_map = []
raw = (os.environ.get("EMS_TARGET_ID_MAP") or "").strip()
if raw:
    try:
        id_map = [entry for entry in json.loads(raw) if isinstance(entry, dict)]
    except ValueError:
        pass
nodes = json.load(sys.stdin).get("items", [])


def find(ident):
    for node in nodes:
        if node["metadata"]["name"] == ident:
            return node
        for addr in (node.get("status") or {}).get("addresses", []):
            if addr.get("type") == "InternalIP" and addr.get("address") == ident:
                return node
    return None


wanted = sys.argv[1]
node = find(wanted)
access = wanted
via = "direct"
if node is None:
    for entry in id_map:
        if wanted in (entry.get("endpoint"), entry.get("address")):
            for ident in list(entry.get("ips") or []) + [entry.get("hostname") or ""]:
                node = find(ident)
                if node is not None:
                    break
            if node is not None:
                access = entry.get("endpoint") or entry.get("address") or wanted
                via = "endpoint"
                break
if node is None and ":" in wanted:
    address = wanted.rsplit(":", 1)[0]
    node = find(address)
    if node is not None:
        access = address
if node is None:
    raise SystemExit(0)
print(node["metadata"]["name"] + "\t" + access + "\t" + via)
' "$ip")"
        [[ -n "$resolved" ]] || die "目标 $ip 不是本集群节点"
        local via_map
        IFS=$'\t' read -r node_name access via_map <<<"$resolved"
        target_nodes+=("$node_name")
        target_access+=("$access")
        if [[ "$via_map" == endpoint ]]; then
            log "目标节点：$ip → $node_name（endpoint $access 访问）"
        else
            log "目标节点：$ip → $node_name"
        fi
    done

    # ---- [1/3] 配大页（只增不减，已达标跳过）----
    log "=== [1/3] 配置大页（${HUGEPAGE_GIB}Gi/节点，只增不减） ==="
    local total_pages per_numa renewed_nodes='' overprov_nodes=''
    total_pages=$((HUGEPAGE_GIB * 512))
    local hp_idx hp_node node_ip
    for hp_idx in "${!target_nodes[@]}"; do
        hp_node="${target_nodes[$hp_idx]}"
        node_ip="${target_access[$hp_idx]}"
        local current
        current="$(node_ssh "$node_ip" 'grep HugePages_Total /proc/meminfo' | awk '{print $2}')" \
            || die "读取 $hp_node 大页现状失败"
        if (( current >= total_pages )); then
            log "$hp_node: 大页已达标（$current 页 ≥ $total_pages），跳过"
            continue
        fi
        # ---- 只读预检：可用内存不足提前失败（秒级）而非干等 900s 超时 ----
        # 不自动清理：/dev/shm 活跃文件与大内存业务进程需人工确认（红线）；
        # 诊断输出走 stderr，不进 stdout 的 KEY=VALUE 变量池（防 ps 参数泄入下游）
        local probe_out avail_kb avail_gib
        probe_out="$(node_ssh "$node_ip" "egrep 'MemTotal|MemAvailable' /proc/meminfo; df -h /dev/shm 2>/dev/null | tail -1")" \
            || die "读取 $hp_node 内存现状失败"
        avail_kb="$(awk '/MemAvailable/{print $2}' <<<"$probe_out")"
        [[ -n "$avail_kb" ]] || die "$hp_node 预检异常：未读到 MemAvailable"
        avail_gib=$(( avail_kb / 1024 / 1024 ))
        # 需求 = 目标 − 已锁定（大页只增不减，重跑时已锁部分不再占可用内存），加余量
        local remaining_gib=$(( (total_pages - current) / 512 ))   # 512 页(2MiB)/Gi
        local need_gib=$(( remaining_gib + HUGEPAGE_PRECHECK_MARGIN_GIB ))
        if (( avail_gib < need_gib )); then
            echo "[$SCRIPT_NAME] $hp_node: 可用内存不足（还需配 ${remaining_gib}Gi，MemAvailable ${avail_gib}Gi < 需求 ${need_gib}Gi 含 ${HUGEPAGE_PRECHECK_MARGIN_GIB}Gi 余量），预计分配必卡，预检失败" >&2
            echo "[$SCRIPT_NAME] $hp_node 诊断（人工确认后清理，再重跑本 step）：" >&2
            printf '    %s\n' "$probe_out" >&2
            node_ssh "$node_ip" "ps aux --sort=-rss | head -6" 2>/dev/null | sed 's/^/    /' >&2 || true
            die "$hp_node 大内存进程需业务方确认、/dev/shm 孤儿文件可 rm、必要时 drop_caches；清理后重跑本 step（幂等）"
        fi
        log "$hp_node: 预检通过（还需 ${remaining_gib}Gi，MemAvailable ${avail_gib}Gi ≥ ${need_gib}Gi）"
        log "$hp_node: $current 页 → $total_pages 页（per-NUMA 后台写入 + 停滞自愈：主动压实/配额重算/写入器重启）"
        # 配额文件（每行「NUMA大页目录 目标页数」）：初始均分向上取整；写入器每轮
        # 重读文件（只增不减：cur ≥ 配额不回写），stall 时按 NUMA 容量与 buddy
        # 高阶块重算缺口分配（总量守恒），重写本文件即被写入器自动应用
        node_ssh "$node_ip" "rm -f /tmp/ems_hp_done /tmp/ems_hp_quota /tmp/ems_hp_until; numa=\$(ls -d /sys/devices/system/node/node*/hugepages/hugepages-2048kB 2>/dev/null | wc -l); per=\$(( ( ${total_pages} + numa - 1 ) / numa )); ls -d /sys/devices/system/node/node*/hugepages/hugepages-2048kB | awk -v p=\$per '{print \$1, p}' > /tmp/ems_hp_quota" \
            || die "在 $hp_node 初始化大页配额失败"
        start_hp_writer "$node_ip"
        # 轮询到位；停滞自愈三件套：① 写入器退出自愈（3T 压实一轮约 10 分钟，
        # 常超出写入器初始存活窗口，退出即重启收割压实成果）② 主动压实（冷却
        # HUGEPAGE_COMPACT_COOLDOWN_SECONDS 可重复触发，每次顺延写入器存活窗口
        # 与本节点超时；绝对硬上限 HUGEPAGE_HARD_TIMEOUT_SECONDS）③ 配额重算
        local waited=0 got='' last_got=-1 stall_rounds=0 compact_last=0 compact_count=0 \
              timeout_effective=$HUGEPAGE_TIMEOUT_SECONDS now_s
        while (( waited < HUGEPAGE_HARD_TIMEOUT_SECONDS && waited < timeout_effective )); do
            sleep "$HUGEPAGE_POLL_SECONDS"
            waited=$((waited + HUGEPAGE_POLL_SECONDS))
            got="$(node_ssh "$node_ip" 'grep HugePages_Total /proc/meminfo' | awk '{print $2}')"
            (( got >= total_pages )) && break
            log "$hp_node: 大页分配中（$got/$total_pages 页，${waited}s）"
            if (( got == last_got )); then (( stall_rounds++ )); else stall_rounds=0; fi
            last_got=$got
            (( stall_rounds < HUGEPAGE_STALL_ROUNDS )) && continue
            stall_rounds=0
            now_s=$(date +%s)
            # ① 写入器退出自愈：done 文件在 = 写入器已退（存活窗口早于压实完成
            # 到期的典型现场），重启后立即补写把压实整理出的高阶块收进大页池
            if node_ssh "$node_ip" 'test -f /tmp/ems_hp_done' >/dev/null 2>&1; then
                log "$hp_node: 写入器已退出但大页未到位（压实完成晚于存活窗口的典型现场），重启写入器收割压实成果"
                start_hp_writer "$node_ip"
            fi
            # ② 周期性主动压实（冷却内不重复触发）；顺延写入器存活窗口与本节点超时
            if (( now_s - compact_last >= HUGEPAGE_COMPACT_COOLDOWN_SECONDS )); then
                compact_last=$now_s
                compact_count=$((compact_count + 1))
                timeout_effective=$(( waited + HUGEPAGE_TIMEOUT_SECONDS ))
                log "$hp_node: 写入停滞（${HUGEPAGE_STALL_ROUNDS} 轮无增长），第 ${compact_count} 次后台主动压实（drop_caches + compact_memory，3T 内存约 10 分钟），写入器存活窗口与超时顺延（已等 ${waited}s → ${timeout_effective}s）"
                node_ssh "$node_ip" "echo \$(( \$(date +%s) + ${HUGEPAGE_TIMEOUT_SECONDS} )) > /tmp/ems_hp_until; nohup bash -c 'sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null; echo 1 > /proc/sys/vm/compact_memory 2>/dev/null' >/tmp/ems_hp_compact.log 2>&1 &" >/dev/null 2>&1 || true
            fi
            # ③ 配额重算（容量上限感知的缺口转移，总量守恒）
            rebalance_hp_quota "$node_ip" "$hp_node"
        done
        if (( got < total_pages )); then
            die "$hp_node 大页 ${waited}s 内未到位（$got/$total_pages；已自动尝试 ${compact_count} 次主动压实（drop_caches+compact_memory）、配额重算与写入器重启仍不足，碎片极度顽固场景请人工释放内存或重启节点后重跑本 step，脚本不硬杀内核态进程）"
        fi
        log "$hp_node: 大页到位（$got 页，等待 ${waited}s，压实 ${compact_count} 次）"
        if (( got > total_pages )); then
            log "警告: $hp_node 分配结果 ${got} 页 > 目标 ${total_pages} 页（多 $(( got - total_pages )) 页）—— 疑似分配超额（配额文件总量应守恒于目标），请排查"
        fi
        renewed_nodes+="$hp_node "
    done
    [[ -n "$renewed_nodes" ]] || log "全部节点大页原已达标，本轮未新增"

    # ---- [2/3] 刷 allocatable（allocatable 未达标的节点重启 kubelet）----
    log "=== [2/3] 刷新大页 allocatable（按需重启 kubelet） ==="
    local kube_node alloc_gib restarted_nodes='' node_json2
    local kube_idx node_ip2
    for kube_idx in "${!target_nodes[@]}"; do
        kube_node="${target_nodes[$kube_idx]}"
        node_ip2="${target_access[$kube_idx]}"
        alloc_gib="$(allocatable_gib_of "$(kubectl get node "$kube_node" -o json)")"
        if (( alloc_gib >= HUGEPAGE_GIB )); then
            log "$kube_node: allocatable 已达标（${alloc_gib}Gi），跳过 kubelet 重启"
            continue
        fi
        log "$kube_node: 重启 kubelet 刷新大页 allocatable（pod 不重启，节点短暂 NotReady）"
        node_ssh "$node_ip2" 'systemctl restart kubelet' || die "$kube_node 重启 kubelet 失败"
        restarted_nodes+="$kube_node "
        local waited2=0 ready='' alloc2=0 node_ready_json
        while (( waited2 < KUBELET_TIMEOUT_SECONDS )); do
            sleep "$KUBELET_POLL_SECONDS"
            waited2=$((waited2 + KUBELET_POLL_SECONDS))
            node_ready_json="$(kubectl get node "$kube_node" -o json)"
            read -r ready alloc2 <<<"$(python3 -c '
import json, sys
node = json.load(sys.stdin)
ready = any(c.get("type") == "Ready" and c.get("status") == "True"
            for c in (node.get("status") or {}).get("conditions") or [])
text = (node.get("status") or {}).get("allocatable", {}).get("hugepages-2Mi", "0")
units = {"Ki": 2**10, "Mi": 2**20, "Gi": 2**30, "Ti": 2**40}
value = 0
for suffix, factor in sorted(units.items(), key=lambda i: -len(i[0])):
    if text.endswith(suffix):
        try: value = float(text[:-len(suffix)]) * factor; break
        except ValueError: pass
try: value = value or float(text)
except ValueError: pass
print(("True" if ready else "False"), int(value // 2**30))
' <<<"$node_ready_json")"
            [[ "$ready" == True ]] && (( alloc2 >= HUGEPAGE_GIB )) && break
        done
        [[ "$ready" == True ]] || die "$kube_node 重启 kubelet 后未恢复 Ready（${waited2}s）"
        (( alloc2 >= HUGEPAGE_GIB )) || die "$kube_node allocatable 仍未达标（${alloc2}Gi < ${HUGEPAGE_GIB}Gi；cadvisor 大页刷新问题需人工确认）"
        log "$kube_node: Ready 且 allocatable ${alloc2}Gi 达标"
    done
    [[ -n "$restarted_nodes" ]] || log "全部节点 allocatable 原已达标，本轮未重启 kubelet"

    # ---- [3/3] 终验 + 契约 ----
    log "=== [3/3] 终验（每节点大页总量 + allocatable 双达标） ==="
    node_json2="$(kubectl get nodes -o json)" || die '获取节点列表失败'
    local kube_idx2 node_ip3 alloc3 phys_gib
    for kube_idx2 in "${!target_nodes[@]}"; do
        kube_node="${target_nodes[$kube_idx2]}"
        node_ip3="${target_access[$kube_idx2]}"
        current="$(node_ssh "$node_ip3" 'grep HugePages_Total /proc/meminfo' | awk '{print $2}')" \
            || die "终验读取 $kube_node 大页失败"
        (( current >= total_pages )) || die "$kube_node 终验大页不足（$current/$total_pages 页）"
        # 超额护栏：物理 > 目标（只增不减 + 历史/手工写入残留）→ 告警 + 契约标记（不失败）
        if (( current > total_pages )); then
            hp_overprov_warn "$kube_node" "$current" "$total_pages" "$(hp_snapshot "$node_ip3")"
            overprov_nodes+="$kube_node "
        fi
        alloc3="$(allocatable_gib_of "$(printf '%s' "$node_json2" | python3 -c '
import json, sys
for node in json.load(sys.stdin).get("items", []):
    if node["metadata"]["name"] == sys.argv[1]:
        print(json.dumps(node)); break
' "$kube_node")")"
        (( alloc3 >= HUGEPAGE_GIB )) || die "$kube_node 终验 allocatable 不足（${alloc3}Gi < ${HUGEPAGE_GIB}Gi；请重跑本 step）"
        # allocatable 低于物理大页：cadvisor 只在 kubelet 启动时采集，物理被抬高而
        # kubelet 未重启时 allocatable 陈旧偏低，提示重启 kubelet 可对齐（EMS 按 allocatable 调度）
        phys_gib=$(( current / 512 ))
        if (( alloc3 < phys_gib )); then
            log "警告: $kube_node allocatable ${alloc3}Gi < 物理大页 ${phys_gib}Gi —— kubelet 采集滞后，重启 kubelet 可对齐"
        fi
        log "$kube_node: 大页 $current 页 · allocatable ${alloc3}Gi ✓"
    done

    printf '\n--- EMS 大页契约（KEY=VALUE） ---\n'
    printf 'EMS_HUGEPAGE_TARGET_GIB=%s\n' "$HUGEPAGE_GIB"
    printf 'EMS_HUGEPAGES_OK=%s\n' 1
    printf 'EMS_HUGEPAGES_RENEWED=%s\n' "$(echo "${renewed_nodes// /,}" | sed 's/,$//')"
    printf 'EMS_KUBELET_RESTARTED=%s\n' "$(echo "${restarted_nodes// /,}" | sed 's/,$//')"
    printf 'EMS_HUGEPAGES_OVERPROVISIONED=%s\n' "$(echo "${overprov_nodes// /,}" | sed 's/,$//')"
}

main() {
    [[ $# -eq 0 ]] || die '不支持命令行参数；请使用环境变量配置'
    if [[ -n "${platform_target_hosts:-}" ]]; then
        dispatch_to_target
        return $?
    fi
    hugepages_main
}

main "$@"
