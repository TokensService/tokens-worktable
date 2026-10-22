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
# TARGET_HOSTS 带密码时改走密码认证（执行宿主有 sshpass 用 sshpass，没有则用
# SSH_ASKPASS 喂密码——集群节点普遍未装 sshpass）。
#
# 跨 region（hd2 等）：平台注入的 TARGET_IPS 可能是外网入口 endpoint（ip:port
# 形态，如 115.33.98.101:2224），与集群 InternalIP 对不上；分发阶段逐节点 SSH
# 采集内网身份（hostname/-I，连同该 endpoint 的登录凭据）构建映射随小写 env
# 下传，目标解析按「直接命中 → endpoint 映射 → 剥端口」三级。解析后节点级
# SSH **一律走集群内网地址**（endpoint 映射命中时取该节点的 InternalIP，解析
# 不到才退回 endpoint 地址）：这类集群的外网入口在集群内不可路由（2026-10-15
# 实测 node 侧访问为 Network unreachable）。节点凭据三级解析：凭据表按内网 IP
# 或 ip:port 命中 → 身份映射回退（按内网身份反查该 endpoint 的 user/pass，
# 连接走内网 22——映射里的 port 是外网 NAT 端口）。执行宿主自身即目标节点时
# 本地直执。gy1 内网标识行为不变。
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
#   [3/3] 终验：全部目标节点「持久池 Σ(per-NUMA nr_hugepages) == 目标」+
#         allocatable 双达标 + 契约输出。
#
# 池账目口径（2026-10 批量超额现场复盘，关键）：
#   - 达标判据一律用 **Σ(per-NUMA nr_hugepages)**（持久池），不用 HugePages_Total：
#     Total = 持久池 + surplus，surplus 是「别人映射出的超额页」（上一轮实例未清、
#     并发操作、其他大页负载），拿它判到位会把池子顶到目标之上，之后内核还可能把
#     surplus 并进持久池 → 单节点白占 400~600Gi（实测 2.0T 目标跑成 2.5T）。
#   - 起跑前 surplus 必须为 0（等 SURPLUS_WAIT 秒后仍 >0 直接失败，不在地雷上开工）；
#   - 轮询/终验发现 Σnr > 目标 → 只回收「每 NUMA 空闲页」把池子收回目标（在用页不动，
#     实测秒级）；surplus > 0 时内核释放 surplus 会卡死（已知行为）→ 不写、判失败；
#   - 收不回去（无可回收空闲页 / surplus 阻塞）→ **失败**（不再绿灯放行）：内核无法
#     运行时收缩大页，需重启节点回收后重跑；契约区分 surplus 与真超额。
#     allocatable 低于持久池时提示 kubelet 采集滞后。
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
HUGEPAGE_SURPLUS_WAIT_SECONDS=120  # 起跑前等 surplus 自然释放的上限（仍在则失败）
HUGEPAGE_RECLAIM_TIMEOUT_SECONDS=60  # 超额回收（写小 nr_hugepages）等内核释放的上限
HUGEPAGE_RECLAIM_ATTEMPTS=3         # 超额收口重试次数（零头/页面稍后才释放都能收敛）
KUBELET_TIMEOUT_SECONDS=240
KUBELET_POLL_SECONDS=5

# hp_reclaim_excess 的结果出口（小写全局，避免 stdout 混入日志/被平台判成报错行）
hp_reclaim_pages=0

die() { echo "[$SCRIPT_NAME] ERROR: $*" >&2; exit 1; }
log() { echo "[$SCRIPT_NAME] $*"; }
log_err() { echo "[$SCRIPT_NAME] $*" >&2; }   # 供「stdout 只留返回值」的函数；日志仍进运行日志
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

node_ssh_password() { # <user> <port> <ip> <pass> <ssh 选项...> <远程命令...>
    local user=$1 port=$2 ip=$3 pass=$4
    shift 4
    # 密码不改走公钥试探（避免 agent 密钥过多触发 Too many authentication failures），
    # 只喂一次（错密码不重试，防账户锁定）
    local auth_opts='-o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1'
    if have sshpass; then
        SSHPASS="$pass" sshpass -e ssh $auth_opts -p "$port" "$user@$ip" "$@"
        return $?
    fi
    # 无 sshpass（集群节点普遍未装、也不便为流水线装）——SSH_ASKPASS 喂密码：
    # 密码只落执行宿主临时目录（600，askpass 助手读完即删），不进命令行/日志。
    # SSH_ASKPASS_REQUIRE 是环境变量（不是 -o 配置项，写成配置项会 Bad
    # configuration option）；force 需 OpenSSH ≥ 8.4（集群节点实测 9.6），
    # 低于 8.4 时该变量被忽略（故同时补显示屏环境变量，迎合旧版的
    # 「无 tty + 有显示屏」判定）——仍不生效则密码认证直接失败，报错附解法。
    local askdir rc
    askdir="$(mktemp -d /tmp/ems-askpass.XXXXXX)" || die '创建 askpass 临时目录失败'
    printf '%s\n' "$pass" >"$askdir/pass"
    chmod 600 "$askdir/pass"
    printf '#!/bin/sh\nexec cat %s/pass\n' "$askdir" >"$askdir/askpass"
    chmod 700 "$askdir/askpass"
    SSH_ASKPASS="$askdir/askpass" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
        ssh $auth_opts -p "$port" "$user@$ip" "$@" </dev/null
    rc=$?
    rm -rf "$askdir"
    (( rc == 255 )) && die "节点 $ip 密码认证失败（执行宿主无 sshpass，已走 SSH_ASKPASS：密码有误，或 ssh < 8.4 不支持 askpass 优先）：请装 sshpass 或配置节点间 root 免密互通"
    return $rc
}

node_ssh() { # <access> <command...>   access：集群内网 IP/节点名（gy1 与跨 region 均如此）
    local ip=$1
    shift
    local local_ips=" $(hostname -I 2>/dev/null) "
    # 本机判定①：access 即本机 IP（gy1 现行为）→ 本地直接执行
    if [[ "$local_ips" == *" $ip "* ]]; then
        bash -c "$*"
        return $?
    fi
    # 凭据逻辑三级解析：①凭据表按内网 IP 命中（gy1：TARGET_HOSTS 的 ip 即内网 IP）
    # ②凭据表按 address:port 命中（TARGET_HOSTS 直接给 endpoint 且 access 就是它）
    # ③身份映射回退（跨 region NAT 集群：按内网身份反查该节点 endpoint 的
    # user/pass；命中内网身份时连接端口固定 22，命中 endpoint 本身时用它自己的
    # 端口——映射里的 port 是外网 NAT 端口）。末列为该 endpoint 的内网身份，
    # 供本机判定②（access 是外网入口但执行宿主就是该节点，本地直执免绕公网
    # 回连自己）；id_map 缺失（gy1）时回退块整体跳过。
    local entry user port pass fallback_ips ssh_base rc=0
    entry="$(python3 - "${ems_node_creds:-}" "${ems_target_id_map:-}" "$ip" <<'PY'
import json
import sys

creds, id_map, key = sys.argv[1], sys.argv[2], sys.argv[3]


def table_hit(entry, value):
    if entry.get("ip") == value:
        return True
    if ":" in value:
        address, _, port = value.rpartition(":")
        return entry.get("ip") == address and str(entry.get("port") or "22") == port
    return False


for entry in json.loads(creds or "[]"):
    if table_hit(entry, key):
        print(f'{entry.get("user") or "root"}\t{entry.get("port") or "22"}\t{entry.get("pass") or ""}')
        raise SystemExit(0)
for entry in json.loads(id_map or "[]"):
    user = entry.get("user") or "root"
    passwd = entry.get("pass") or ""
    if key == entry.get("endpoint"):          # access 就是外网入口 → 用它自己的端口
        print(f'{user}\t{entry.get("port") or "22"}\t{passwd}')
        raise SystemExit(0)
    if key in (entry.get("ips") or []) or key == (entry.get("hostname") or ""):
        print(f'{user}\t22\t{passwd}\t{" ".join(entry.get("ips") or [])}')
        raise SystemExit(0)
PY
)"
    if [[ -n "$entry" ]]; then
        IFS=$'\t' read -r user port pass fallback_ips <<<"$entry"
    else
        user=root port=22 pass='' fallback_ips=''
    fi
    # 本机判定②：该 endpoint 的内网身份含本机地址 → access 虽是外网入口，执行宿主
    # 就是目标节点，本地直执。
    # ⚠️ 必须逐项**精确相等**，且排除各节点共有的辅助地址（169.254.* 元数据/链路本地、
    # 172.17.* docker 网桥、127.*）：hostname -I 是全量地址表，同集群任意两节点都可能
    # 共享这些地址，用整表做「包含」匹配会把别的节点误判成本机。2026-10-21 现场：
    # probe 节点 31.7 执行 node_ssh 192.168.31.113 时命中 169.254.170.23 / 172.17.0.1
    # → 目标机的「读大页 / 重启 kubelet」全部在 31.7 本地执行：日志显示 113「已达标」
    # （其实是 31.7 的读数），重启的是 31.7 的 kubelet，113 从未被操作，allocatable
    # 永远 0 → 轮询 240s 超时，还被误报成「cadvisor 大页刷新问题」。
    local one
    for one in $fallback_ips; do
        case "$one" in
            169.254.*|127.*|172.17.*|0.0.0.0|::1|"") continue ;;
        esac
        if [[ "$local_ips" == *" $one "* ]]; then
            log "本机判定：$one 属执行宿主自身地址 → 命令本地执行（access=$ip）"
            bash -c "$*"
            return $?
        fi
    done
    ssh_base='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15'
    # 优先密钥认证（集群节点间通常 root 免密互通；平台环境里配的密码是给服务端分发用的，
    # 不应强制节点间也走密码）。rc=255 才是认证/连接失败，此时带密码则改走密码认证。
    ssh $ssh_base -o BatchMode=yes -p "$port" "$user@$ip" "$@" 2>/dev/null || rc=$?
    if (( rc != 255 )); then
        return $rc
    fi
    if [[ -n "$pass" ]]; then
        node_ssh_password "$user" "$port" "$ip" "$pass" $ssh_base "$@"
        return $?
    fi
    die "节点 $ip SSH 密钥认证失败且未提供密码（集群节点间无 root 免密时，请在平台节点环境里填写该节点的登录密码）"
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

rebalance_hp_quota() { # <node_ip> <node_name> <target_pages>  容量上限感知配额重算（缺口转移，总量守恒），写回远程配额文件
    local r_ip=$1 r_node=$2 r_target=$3 numa_info new_quota quota_args d_line new_sum=0
    numa_info="$(node_ssh "$r_ip" 'while read -r d q; do echo "$d $q $(cat $d/nr_hugepages 2>/dev/null || echo 0)"; done < /tmp/ems_hp_quota; grep " MemTotal:" /sys/devices/system/node/node*/meminfo; cat /proc/buddyinfo' 2>/dev/null)" || return 0
    [[ -n "$numa_info" ]] || return 0
    new_quota="$(hp_quota_recalc "$numa_info")"
    [[ -n "$new_quota" ]] || return 0
    # 防御：配额总量绝不得越过目标（算法本身恒守恒，此处拦外部/并发改写与未来回归）
    while read -r d_line; do
        [[ -n "$d_line" ]] || continue
        new_sum=$(( new_sum + ${d_line##* } ))
    done <<<"$new_quota"
    if (( new_sum > r_target )); then
        log "警告: $r_node 配额重算结果 ${new_sum} 页 > 目标 ${r_target} 页，拒绝写回（防超额）"
        return 0
    fi
    quota_args=''
    while read -r d_line; do quota_args+=" '$d_line'"; done <<<"$new_quota"
    # 原子替换：写入器同时在读同一文件，直接 `>` 截断重写会让它读到半行
    # （现场症状：`s/devices/...: No such file` + `[: 0: unary operator expected`）
    if node_ssh "$r_ip" "printf '%s\n'${quota_args} > /tmp/ems_hp_quota.tmp && mv -f /tmp/ems_hp_quota.tmp /tmp/ems_hp_quota" >/dev/null 2>&1; then
        log "$r_node: 配额重算（NUMA 容量上限 + buddy 高阶块比例转移缺口，总量守恒），写入器自动应用"
    else
        log "$r_node: 配额重算写回失败（继续按原配额等待）"
    fi
}

# 每 NUMA 大页账目：dir / nr_hugepages / free_hugepages——达标与回收都以 per-NUMA 为准
hp_numa_pairs() { # <node_ip> → 每行 "dir nr free"
    node_ssh "$1" 'for d in /sys/devices/system/node/node*/hugepages/hugepages-2048kB; do printf "%s %s %s\n" "$d" "$(cat "$d/nr_hugepages" 2>/dev/null || echo 0)" "$(cat "$d/free_hugepages" 2>/dev/null || echo 0)"; done'
}

# 池账目：nr_sum = 持久池页数（唯一达标判据）；surp = surplus 页（Total 里的他人超额页，
# 不属本 step 预留）；free_sum = 可回收的空闲页数
hp_pool_state() { # <node_ip> → stdout "nr_sum surp free_sum"
    local p_sum=0 p_free=0 p_surp pairs d n f
    pairs="$(hp_numa_pairs "$1")" || return 1
    [[ -n "$pairs" ]] || return 1
    while read -r d n f; do
        [[ -n "$n" ]] || continue
        p_sum=$(( p_sum + n )); p_free=$(( p_free + f ))
    done <<<"$pairs"
    p_surp="$(node_ssh "$1" 'awk "/^HugePages_Surp:/{print \$2}" /proc/meminfo' 2>/dev/null)"
    printf '%s %s %s\n' "$p_sum" "${p_surp:-0}" "$p_free"
}

# 超额回收：持久池超目标时，把每 NUMA 的 nr_hugepages 写到 nr-free（只回收空闲页，
# 在用页一律不动）。surplus > 0 时内核释放 surplus 会卡死（已知行为）→ 不写、返回 2。
# stdout：回收页数；返回码：0 完成/无需回收，1 失败，2 surplus 阻塞
hp_reclaim_excess() { # <node_ip> <node_name> <target_pages>
    local r_ip=$1 r_node=$2 r_target=$3
    local pairs d n f sum=0 free_sum=0 excess remain take reclaimed=0 cmd='' quota_new='' surp rw=0
    pairs="$(hp_numa_pairs "$r_ip")" || return 1
    [[ -n "$pairs" ]] || return 1
    while read -r d n f; do
        [[ -n "$n" ]] || continue
        sum=$(( sum + n )); free_sum=$(( free_sum + f ))
    done <<<"$pairs"
    excess=$(( sum - r_target ))
    hp_reclaim_pages=0
    (( excess > 0 )) || return 0
    surp="$(node_ssh "$r_ip" 'awk "/^HugePages_Surp:/{print \$2}" /proc/meminfo' 2>/dev/null)"
    if (( ${surp:-0} > 0 )); then
        log "警告: $r_node 池子超额 ${excess} 页，但 surplus=${surp} > 0——内核释放 surplus 会卡死（已知行为），本次不回收"
        return 2
    fi
    # 只从有闲置页的 NUMA 回收，回收总量恰为超额量（每 NUMA 目标 = nr − 取走的空闲页）
    remain=$excess
    while read -r d n f; do
        [[ -n "$n" ]] || continue
        (( remain > 0 )) || break
        (( f > 0 )) || continue
        take=$f
        (( take > remain )) && take=$remain
        cmd+="echo $(( n - take )) > $d/nr_hugepages; "
        quota_new+="$d $(( n - take ))"$'\n'
        remain=$(( remain - take ))
        reclaimed=$(( reclaimed + take ))
    done <<<"$pairs"
    if (( reclaimed == 0 )); then
        log "警告: $r_node 池子超额 ${excess} 页，但空闲页为 ${free_sum}（全部在用）——运行时无法收缩"
        return 1
    fi
    # sysfs 写同步阻塞：后台写 + 等完成标记（空闲页释放实测秒级，留超时兜底）
    node_ssh "$r_ip" "rm -f /tmp/ems_hp_reclaim_done; nohup bash -c '${cmd}echo ok > /tmp/ems_hp_reclaim_done' >/tmp/ems_hp_reclaim.log 2>&1 &" >/dev/null 2>&1 \
        || { log "警告: $r_node 超额回收写入启动失败"; return 1; }
    while (( rw < HUGEPAGE_RECLAIM_TIMEOUT_SECONDS )); do
        sleep "$HUGEPAGE_POLL_SECONDS"
        rw=$(( rw + HUGEPAGE_POLL_SECONDS ))
        node_ssh "$r_ip" 'test -f /tmp/ems_hp_reclaim_done' >/dev/null 2>&1 && break
    done
    node_ssh "$r_ip" 'test -f /tmp/ems_hp_reclaim_done' >/dev/null 2>&1 \
        || { log "警告: $r_node 超额回收未在 ${HUGEPAGE_RECLAIM_TIMEOUT_SECONDS}s 内完成（内核释放阻塞）"; return 1; }
    log "$r_node: 已回收超额空闲大页 ${reclaimed} 页 ≈ $(( reclaimed / 512 ))Gi（持久池目标 ${r_target} 页）"
    # 缺这两步池子会被「只增不减的写入器」按旧配额重新顶高（实测 +228071 页）：
    #  ① 配额文件原子同步为回收后的值（写入器看到 quota == cur 就不再补）
    #  ② 停写入器（删存活窗口文件即退出）——池子已收口，无需再涨
    if [[ -n "$quota_new" ]]; then
        local q_args='' q_line
        while read -r q_line; do [[ -n "$q_line" ]] && q_args+=" '$q_line'"; done <<<"$quota_new"
        if node_ssh "$r_ip" "printf '%s\n'${q_args} > /tmp/ems_hp_quota.tmp && mv -f /tmp/ems_hp_quota.tmp /tmp/ems_hp_quota" >/dev/null 2>&1; then
            log "$r_node: 配额文件已同步为回收后的值（原子替换）"
        else
            log "警告: $r_node 配额文件同步失败（写入器可能仍按旧配额把池子顶高）"
        fi
    fi
    node_ssh "$r_ip" 'rm -f /tmp/ems_hp_until' >/dev/null 2>&1 || true
    log "$r_node: 已停写入器（避免旧配额把池子再顶回去）"
    hp_reclaim_pages=$reclaimed
    local nr_after
    read -r nr_after _ _ < <(hp_pool_state "$r_ip") || nr_after=-1
    if (( nr_after != r_target )); then
        log "警告: $r_node 回收后持久池 ${nr_after} 页 ≠ 目标 ${r_target} 页（计划回收 ${reclaimed} 页，实测减少 $(( sum - nr_after )) 页）——将重试收口"
    fi
    return 0
}

# 有界重试收口：反复「查账 → 回收空闲页」，直到持久池恰等于目标或重试用尽。
# 覆盖两类残留：回收后剩几页零头、回收时页面还在别人手里（稍后才释放）。
hp_reclaim_to_target() { # <node_ip> <node_name> <target_pages> → 0 已达标/无需，1 收不回
    local t_ip=$1 t_node=$2 t_target=$3 attempt=0 nr surp free
    while :; do
        read -r nr surp free < <(hp_pool_state "$t_ip") || return 1
        (( nr == t_target )) && return 0
        (( nr < t_target )) && return 0                 # 只负责收口，不负责补足
        (( attempt < HUGEPAGE_RECLAIM_ATTEMPTS )) || break
        attempt=$(( attempt + 1 ))
        log "$t_node: 持久池 ${nr} 页 > 目标 ${t_target} 页，第 ${attempt}/${HUGEPAGE_RECLAIM_ATTEMPTS} 次回收空闲页（当前空闲 ${free} 页）"
        hp_reclaim_excess "$t_ip" "$t_node" "$t_target" || true
        reclaimed_pages=$(( reclaimed_pages + hp_reclaim_pages ))
        (( free > 0 )) || sleep "$HUGEPAGE_POLL_SECONDS"  # 无空闲页：等上一轮实例/业务释放后再试
    done
    read -r nr surp free < <(hp_pool_state "$t_ip")
    (( nr == t_target ))
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
        # 输出「节点名\t访问地址」：跨 region 时访问地址 = 该节点 InternalIP（外网
        # 入口在集群内不可路由，节点级 SSH 只能走内网；解析不到才退回 endpoint）。
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
                access = ""
                for addr in (node.get("status") or {}).get("addresses", []):
                    if addr.get("type") == "InternalIP" and addr.get("address"):
                        access = addr["address"]
                        break
                if not access:
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
            log "目标节点：$ip → $node_name（经 endpoint 身份映射，内网 $access 访问）"
        else
            log "目标节点：$ip → $node_name"
        fi
    done

    # ---- [1/3] 配大页（只增不减，已达标跳过）----
    log "=== [1/3] 配置大页（${HUGEPAGE_GIB}Gi/节点，只增不减） ==="
    local total_pages per_numa renewed_nodes='' reclaimed_pages=0
    total_pages=$((HUGEPAGE_GIB * 512))
    local hp_idx hp_node node_ip
    for hp_idx in "${!target_nodes[@]}"; do
        hp_node="${target_nodes[$hp_idx]}"
        node_ip="${target_access[$hp_idx]}"
        local nr_sum surp free_sum current
        # ---- surplus 预检：不在地雷上开工 ----
        # surplus = Total − Σnr，是「别处映射出的超额页」（上一轮实例未清 / 并发操作 /
        # 其他大页负载）。有它的时候写配额会把池子顶过目标（内核可能把 surplus 并进
        # 持久池），所以先等它自然释放，仍在则失败。
        local surp_wait=0
        while :; do
            read -r nr_sum surp free_sum < <(hp_pool_state "$node_ip") \
                || die "读取 $hp_node 大页账目失败"
            (( surp == 0 )) && break
            (( surp_wait < HUGEPAGE_SURPLUS_WAIT_SECONDS )) \
                || die "$hp_node 存在 surplus ${surp} 页（Total 含他人映射的超额大页，非本 step 预留）——在这种账目下配大页会把池子顶过目标；请先确认该节点上其它大页使用方（上一轮实例 / 并发操作）已释放后重跑本 step"
            (( surp_wait > 0 )) || log "$hp_node: 检测到 surplus ${surp} 页（非本 step 预留），等待其释放后再开始（最多 ${HUGEPAGE_SURPLUS_WAIT_SECONDS}s）"
            sleep 10
            surp_wait=$(( surp_wait + 10 ))
        done
        log "$hp_node: 持久池 ${nr_sum} 页 · 空闲 ${free_sum} 页 · surplus 0（目标 ${total_pages} 页）"
        # 历史超额（只增不减残留 / 上一版脚本超配）：先把空闲页收回去，收不回去即失败
        if (( nr_sum > total_pages )); then
            hp_reclaim_to_target "$node_ip" "$hp_node" "$total_pages" || true
            read -r nr_sum surp free_sum < <(hp_pool_state "$node_ip")
            (( nr_sum <= total_pages )) \
                || die "$hp_node 持久池 ${nr_sum} 页 > 目标 ${total_pages} 页且运行时无法回收（空闲 ${free_sum} 页，surplus ${surp}）——内核不能运行时收缩大页，需重启节点回收后重跑本 step"
        fi
        current=$nr_sum
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
        # 配额文件（每行「NUMA大页目录 目标页数」）：初始**精确**均分（余数补前几个 NUMA，
        # 不再 ceil 摸上限——numa 不整除时会多出零头）；写入器每轮重读文件（只增不减：
        # cur ≥ 配额不回写），stall 时按 NUMA 容量与 buddy 高阶块重算缺口分配，重写本
        # 文件即被写入器自动应用
        node_ssh "$node_ip" "rm -f /tmp/ems_hp_done /tmp/ems_hp_quota /tmp/ems_hp_until; numa=\$(ls -d /sys/devices/system/node/node*/hugepages/hugepages-2048kB 2>/dev/null | wc -l); base=\$(( ${total_pages} / numa )); rem=\$(( ${total_pages} % numa )); ls -d /sys/devices/system/node/node*/hugepages/hugepages-2048kB | awk -v b=\$base -v r=\$rem '{print \$1, b + (NR <= r ? 1 : 0)}' > /tmp/ems_hp_quota" \
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
            read -r got surp free_sum < <(hp_pool_state "$node_ip")
            # 持久池超目标（surplus 被并入 / 历史超额）→ 回收空闲页收口，不带着超额判到位
            if (( got > total_pages )); then
                hp_reclaim_to_target "$node_ip" "$hp_node" "$total_pages" || true
                read -r got surp free_sum < <(hp_pool_state "$node_ip")
            fi
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
            rebalance_hp_quota "$node_ip" "$hp_node" "$total_pages"
        done
        if (( got < total_pages )); then
            die "$hp_node 大页 ${waited}s 内未到位（$got/$total_pages；已自动尝试 ${compact_count} 次主动压实（drop_caches+compact_memory）、配额重算与写入器重启仍不足，碎片极度顽固场景请人工释放内存或重启节点后重跑本 step，脚本不硬杀内核态进程）"
        fi
        log "$hp_node: 大页到位（$got 页，等待 ${waited}s，压实 ${compact_count} 次）"
        # 终局收口：持久池必须恰等于目标（轮询里可能因 surplus 阻塞未收回）
        if (( got > total_pages )); then
            hp_reclaim_to_target "$node_ip" "$hp_node" "$total_pages" || true
            read -r got surp free_sum < <(hp_pool_state "$node_ip")
        fi
        (( got == total_pages )) \
            || die "$hp_node 持久池 ${got} 页 ≠ 目标 ${total_pages} 页且运行时无法回收（空闲 ${free_sum} 页，surplus ${surp}）——内核不能运行时收缩大页，需重启节点回收后重跑本 step"
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
        # 重启前后比对 kubelet 的 MainPID + 启动时间戳：不变说明重启命令没落到这台机上
        # （跨 region 误判 / ssh 静默失败等），此时 allocatable 不可能刷新，应立即失败
        # 而不是空转 KUBELET_TIMEOUT_SECONDS 后误报成「cadvisor 采集滞后」。
        local kube_id_before kube_id_after
        kube_id_before="$(node_ssh "$node_ip2" \
            'systemctl show kubelet -p MainPID -p ExecMainStartTimestamp --value 2>/dev/null | tr "\n" " "' \
            2>/dev/null | tr -d '\r' | tail -1)" || true
        node_ssh "$node_ip2" 'systemctl restart kubelet' || die "$kube_node 重启 kubelet 失败"
        sleep 3
        kube_id_after="$(node_ssh "$node_ip2" \
            'systemctl show kubelet -p MainPID -p ExecMainStartTimestamp --value 2>/dev/null | tr "\n" " "' \
            2>/dev/null | tr -d '\r' | tail -1)" || true
        if [[ -n "$kube_id_before" && "$kube_id_before" == "$kube_id_after" ]]; then
            die "$kube_node 重启 kubelet 未生效（MainPID/启动时间仍为「$kube_id_after」）——命令没有落到该节点或该节点 kubelet 未被重启，allocatable 不可能刷新；请先确认该节点 SSH/本机判定与 kubelet 状态（参考 step 手册「本机判定误判」坑）再重跑本 step"
        fi
        log "$kube_node: kubelet 已重启（${kube_id_before:-unknown} → ${kube_id_after:-unknown}）"
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
        (( alloc2 >= HUGEPAGE_GIB )) || die "$kube_node allocatable 仍未达标（${alloc2}Gi < ${HUGEPAGE_GIB}Gi，kubelet 已确认重启过；若持久池本身为 0 说明大页没配上，否则为 cadvisor 采集异常，需人工确认）"
        log "$kube_node: Ready 且 allocatable ${alloc2}Gi 达标"
    done
    [[ -n "$restarted_nodes" ]] || log "全部节点 allocatable 原已达标，本轮未重启 kubelet"

    # ---- [3/3] 终验 + 契约 ----
    log "=== [3/3] 终验（每节点持久池 == 目标 + allocatable 双达标） ==="
    node_json2="$(kubectl get nodes -o json)" || die '获取节点列表失败'
    local kube_idx2 node_ip3 alloc3 surplus_nodes=''
    for kube_idx2 in "${!target_nodes[@]}"; do
        kube_node="${target_nodes[$kube_idx2]}"
        node_ip3="${target_access[$kube_idx2]}"
        read -r current surp free_sum < <(hp_pool_state "$node_ip3") \
            || die "终验读取 $kube_node 大页账目失败"
        # 终验收口：持久池 != 目标时再试一次回收；仍不达标即失败（不再绿灯放行）
        if (( current > total_pages )); then
            hp_reclaim_to_target "$node_ip3" "$kube_node" "$total_pages" || true
            read -r current surp free_sum < <(hp_pool_state "$node_ip3")
        fi
        (( current == total_pages )) \
            || die "$kube_node 终验持久池 ${current} 页 ≠ 目标 ${total_pages} 页（空闲 ${free_sum} 页，surplus ${surp}）——内核不能运行时收缩大页，需重启节点回收后重跑本 step"
        if (( surp > 0 )); then
            log "提示: $kube_node 另有 surplus ${surp} 页（Total 含他人/历史映射的超额页，不属本 step 预留；释放后自动消失，不需重启）"
            surplus_nodes+="$kube_node "
        fi
        alloc3="$(allocatable_gib_of "$(printf '%s' "$node_json2" | python3 -c '
import json, sys
for node in json.load(sys.stdin).get("items", []):
    if node["metadata"]["name"] == sys.argv[1]:
        print(json.dumps(node)); break
' "$kube_node")")"
        (( alloc3 >= HUGEPAGE_GIB )) || die "$kube_node 终验 allocatable 不足（${alloc3}Gi < ${HUGEPAGE_GIB}Gi；请重跑本 step）"
        # allocatable 高于持久池：kubelet 采集滞后（之前回收过大页但未重启 kubelet），
        # 会按虚高额度误导后续调度，提示重启 kubelet 对齐
        if (( alloc3 > HUGEPAGE_GIB )); then
            log "警告: $kube_node allocatable ${alloc3}Gi > 持久池 ${HUGEPAGE_GIB}Gi —— kubelet 采集滞后，重启 kubelet 可对齐（否则调度会按虚高额度记账）"
        fi
        log "$kube_node: 持久池 $current 页 · allocatable ${alloc3}Gi ✓"
    done

    printf '\n--- EMS 大页契约（KEY=VALUE） ---\n'
    printf 'EMS_HUGEPAGE_TARGET_GIB=%s\n' "$HUGEPAGE_GIB"
    printf 'EMS_HUGEPAGES_OK=%s\n' 1
    printf 'EMS_HUGEPAGES_POOL_PAGES=%s\n' "$total_pages"
    printf 'EMS_HUGEPAGES_RENEWED=%s\n' "$(echo "${renewed_nodes// /,}" | sed 's/,$//')"
    printf 'EMS_KUBELET_RESTARTED=%s\n' "$(echo "${restarted_nodes// /,}" | sed 's/,$//')"
    printf 'EMS_HUGEPAGES_RECLAIMED=%s\n' "$reclaimed_pages"
    printf 'EMS_HUGEPAGES_SURPLUS=%s\n' "$(echo "${surplus_nodes// /,}" | sed 's/,$//')"
    # 兼容保留：真超额（持久池超目标且收不回去）现在直接 die，成功路径恒为空
    printf 'EMS_HUGEPAGES_OVERPROVISIONED=%s\n' ''
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
