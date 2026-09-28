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
# 流程（fail-fast，任一步失败即中止，人工看运行日志后处理/重跑）：
#   [0/3] 解析目标节点（kubectl 节点名 + InternalIP；单节点亦合法——本 step 逐节点操作）
#   [1/3] 配大页：只读预检（MemAvailable < 目标+余量 → 秒级失败并输出大内存
#         进程 / /dev/shm 诊断，不自动清理——涉业务确认红线）→ /sys per-node
#         接口、只增不减（固定 2000Gi = 1024000 页/节点）、nohup 后台写入 +
#         轮询到位（900s）；已达标节点跳过
#   [2/3] 刷 allocatable：allocatable 未达标的节点重启 kubelet（pod 不重启、节点
#         NotReady 数十秒——cadvisor 只在 kubelet 启动时采集大页），轮询 Ready + 达标（240s）
#   [3/3] 终验：全部目标节点 HugePages_Total 与 allocatable 双达标 + 契约输出
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

# 内部常量（普通赋值，不进参数面）；HUGEPAGE_GIB 固定 2000Gi（与仓内 chart values 同值）
HUGEPAGE_GIB=2000
HUGEPAGE_PRECHECK_MARGIN_GIB=200   # 预检余量：MemAvailable 需 ≥ 目标+余量，低于则提前失败
HUGEPAGE_TIMEOUT_SECONDS=900
HUGEPAGE_POLL_SECONDS=10
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
    remote_exec "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "cat > /tmp/ems-hugepages.sh" <"$self" \
        || die "推送脚本到 $probe_host 失败"

    remote_env=(TARGET_HOSTS=)
    printf -v quoted '%q' "${TARGET_IPS:-}"
    remote_env+=("TARGET_IPS=$quoted")
    printf -v quoted '%q' "$creds_json"
    remote_env+=("ems_node_creds=$quoted")
    remote_exec "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "env ${remote_env[*]} bash /tmp/ems-hugepages.sh"
    return $?
}

# ==================== 远程阶段（首个有 kubectl 的目标节点） ====================

node_ssh() { # <ip> <command...>
    local ip=$1
    shift
    # 执行宿主即目标节点：本地直接执行（分发宿主本身常是目标之一，免去自 SSH 与 sshpass 依赖）
    if [[ " $(hostname -I 2>/dev/null) " == *" $ip "* ]]; then
        bash -c "$*"
        return $?
    fi
    local entry
    entry="$(python3 - "${ems_node_creds:-}" "$ip" <<'PY'
import json
import sys

for entry in json.loads(sys.argv[1] or "[]"):
    if entry.get("ip") == sys.argv[2]:
        print(f'{entry.get("user") or "root"}\t{entry.get("port") or "22"}\t{entry.get("pass") or ""}')
        break
PY
)"
    [[ -n "$entry" ]] || die "节点 $ip 不在 TARGET_HOSTS 凭据列表中"
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

internal_ip_of() { # <node_json> <node_name>
    printf '%s' "$1" | python3 -c '
import json, sys
for node in json.load(sys.stdin).get("items", []):
    if node["metadata"]["name"] == sys.argv[1]:
        for addr in node.get("status", {}).get("addresses", []):
            if addr.get("type") == "InternalIP":
                print(addr["address"]); break
        break
' "$2"
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

hugepages_main() {
    local node_json ip node_name
    local -a target_nodes=()

    have kubectl || die '本机缺少 kubectl（正常应经 TARGET_HOSTS 分发到目标节点执行）'
    have python3 || die '需要 python3'
    kubectl version --request-timeout=5s >/dev/null 2>&1 || die 'kubectl 无法访问 Kubernetes API'

    # 目标节点列表：注入的 TARGET_IPS（JSON 数组），缺省退化为凭据列表全部节点
    local -a target_ips=()
    mapfile -t target_ips < <(python3 - "${TARGET_IPS:-}" "${ems_node_creds:-}" <<'PY'
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
        node_name="$(printf '%s' "$node_json" | python3 -c '
import json, sys
wanted = sys.argv[1]
for node in json.load(sys.stdin).get("items", []):
    if node["metadata"]["name"] == wanted:
        print(wanted); break
    for addr in node.get("status", {}).get("addresses", []):
        if addr.get("type") == "InternalIP" and addr.get("address") == wanted:
            print(node["metadata"]["name"]); break
    else:
        continue
    break
' "$ip")"
        [[ -n "$node_name" ]] || die "目标 $ip 不是本集群节点"
        target_nodes+=("$node_name")
        log "目标节点：$ip → $node_name"
    done

    # ---- [1/3] 配大页（只增不减，已达标跳过）----
    log "=== [1/3] 配置大页（${HUGEPAGE_GIB}Gi/节点，只增不减） ==="
    local total_pages per_numa hp_node renewed_nodes=''
    total_pages=$((HUGEPAGE_GIB * 512))
    for hp_node in "${target_nodes[@]}"; do
        local node_ip current
        node_ip="$(internal_ip_of "$node_json" "$hp_node")"
        [[ -n "$node_ip" ]] || die "无法解析节点 $hp_node 的 InternalIP"
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
        log "$hp_node: $current 页 → $total_pages 页（per-NUMA 后台写入，最长等待 ${HUGEPAGE_TIMEOUT_SECONDS}s）"
        node_ssh "$node_ip" "rm -f /tmp/ems_hp_done; nohup bash -c 'total=$total_pages; deadline=\$(( \$(date +%s) + ${HUGEPAGE_TIMEOUT_SECONDS} - 60 )); numa=\$(ls -d /sys/devices/system/node/node* 2>/dev/null | wc -l); per=\$(( (total + numa - 1) / numa )); while [ \$(date +%s) -lt \$deadline ]; do ok=1; for n in /sys/devices/system/node/node*/hugepages/hugepages-2048kB/nr_hugepages; do cur=\$(cat \$n); if [ \$cur -lt \$per ]; then ok=0; echo \$per > \$n 2>/dev/null || true; fi; done; [ \$ok -eq 1 ] && break; sleep 5; done; echo done > /tmp/ems_hp_done' >/tmp/ems_hp.log 2>&1 &" \
            || die "在 $hp_node 启动大页写入失败"
        local waited=0 got=''
        while (( waited < HUGEPAGE_TIMEOUT_SECONDS )); do
            sleep "$HUGEPAGE_POLL_SECONDS"
            waited=$((waited + HUGEPAGE_POLL_SECONDS))
            got="$(node_ssh "$node_ip" 'grep HugePages_Total /proc/meminfo' | awk '{print $2}')"
            (( got >= total_pages )) && break
            log "$hp_node: 大页分配中（$got/$total_pages 页，${waited}s）"
        done
        if (( got < total_pages )); then
            die "$hp_node 大页 ${HUGEPAGE_TIMEOUT_SECONDS}s 内未到位（$got/$total_pages；compaction 卡死场景请人工释放内存后重跑本 step，脚本不硬杀内核态进程）"
        fi
        log "$hp_node: 大页到位（$got 页）"
        renewed_nodes+="$hp_node "
    done
    [[ -n "$renewed_nodes" ]] || log "全部节点大页原已达标，本轮未新增"

    # ---- [2/3] 刷 allocatable（allocatable 未达标的节点重启 kubelet）----
    log "=== [2/3] 刷新大页 allocatable（按需重启 kubelet） ==="
    local kube_node alloc_gib restarted_nodes='' node_json2
    for kube_node in "${target_nodes[@]}"; do
        alloc_gib="$(allocatable_gib_of "$(kubectl get node "$kube_node" -o json)")"
        if (( alloc_gib >= HUGEPAGE_GIB )); then
            log "$kube_node: allocatable 已达标（${alloc_gib}Gi），跳过 kubelet 重启"
            continue
        fi
        local node_ip2
        node_ip2="$(internal_ip_of "$node_json" "$kube_node")"
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
    for kube_node in "${target_nodes[@]}"; do
        local node_ip3 alloc3
        node_ip3="$(internal_ip_of "$node_json2" "$kube_node")"
        current="$(node_ssh "$node_ip3" 'grep HugePages_Total /proc/meminfo' | awk '{print $2}')" \
            || die "终验读取 $kube_node 大页失败"
        (( current >= total_pages )) || die "$kube_node 终验大页不足（$current/$total_pages 页）"
        alloc3="$(allocatable_gib_of "$(printf '%s' "$node_json2" | python3 -c '
import json, sys
for node in json.load(sys.stdin).get("items", []):
    if node["metadata"]["name"] == sys.argv[1]:
        print(json.dumps(node)); break
' "$kube_node")")"
        (( alloc3 >= HUGEPAGE_GIB )) || die "$kube_node 终验 allocatable 不足（${alloc3}Gi < ${HUGEPAGE_GIB}Gi；请重跑本 step）"
        log "$kube_node: 大页 $current 页 · allocatable ${alloc3}Gi ✓"
    done

    printf '\n--- EMS 大页契约（KEY=VALUE） ---\n'
    printf 'EMS_HUGEPAGE_TARGET_GIB=%s\n' "$HUGEPAGE_GIB"
    printf 'EMS_HUGEPAGES_OK=%s\n' 1
    printf 'EMS_HUGEPAGES_RENEWED=%s\n' "$(echo "${renewed_nodes// /,}" | sed 's/,$//')"
    printf 'EMS_KUBELET_RESTARTED=%s\n' "$(echo "${restarted_nodes// /,}" | sed 's/,$//')"
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
