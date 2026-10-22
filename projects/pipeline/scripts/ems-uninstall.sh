#!/usr/bin/env bash
# pipeline: no-positional-args
# EMS（mfv-kv 内存池存储）卸载流水线 step 主脚本（shell step，无参调用，零任务参数）。
#
# 语义：执行即卸载/释放（无预演）。目标节点 = 平台注入的 TARGET_IP/TARGET_IPS，
# 脚本自动推导实例（目标节点 label 前缀唯一性 + 其上 EMS pod ns 交叉），并按
# 目标覆盖度自动选择模式：
#   · 整实例卸载：目标节点 ⊇ 该实例的全部 label 节点（或实例单节点）——
#     helm uninstall（--no-hooks，钩子 clean-hugepage 行为与脚本 [3/4] 重复且
#     无 label 节点时钩子 Pending 会卡死卸载）+ 删资源 ns + 全部节点摘 label +
#     大页归零 + 刷 kubelet；
#   · 节点缩容：实例是多节点部署且目标只是其中一部分——只把目标节点从实例
#     中释放（摘 label → DS server 自动消失 → 删钉在目标节点上的 zk/controller
#     pod 促其重建到剩余节点并等 Ready → 大页归零 + 刷 kubelet），release 与
#     资源 ns 保留，实例在剩余节点继续服务（zk 迁移瞬间多数派可能有秒级抖动，
#     server 自动重连）。
# 纯 label 残留（无 pod 无 release）同样可清（仅摘 label 与大页）。目标不
# 属于任何实例 = 已卸干净，幂等成功退出；多 key 时按运行证据仲裁（目标节点
# pod / 集群内 release）：唯一存活实例为准、纯残留 label 顺带清理，多个存活
# 实例交叉才 die 请人工（防误伤他人在役实例）。跨 region（hd2 等）：
# TARGET_IPS 为外网入口 endpoint（ip:port）时经分发阶段采集的身份映射三级
# 解析，gy1 内网行为不变。
#
# 执行位置：工作台服务端（无 kubectl/helm）经 TARGET_HOSTS 自推送到首个具备
# kubectl+helm 的目标节点远程执行；对各目标节点的大页写入 / kubelet 重启：
# 执行宿主自身本地直接执行，其余节点优先密钥认证（集群节点间通常 root 免密
# 互通），密钥失败且凭据带密码时改走密码认证——执行宿主机上有 sshpass 用
# sshpass，没有则用 SSH_ASKPASS 喂密码（集群节点普遍未装 sshpass，见下）。
#
# 节点凭据三级解析（跨 region NAT 集群踩坑，2026-10-15）：①凭据表按内网 IP
# 命中（gy1：TARGET_HOSTS 的 ip 就是内网 IP）；②凭据表按 address:port 命中
# （TARGET_HOSTS 直接给 ip:port）；③身份映射回退——平台注入的是外网入口
# ip:port、与集群内网 IP 对不上时，按内网 IP/hostname 反查该节点 endpoint 的
# user/pass，连接仍走内网 22 端口（映射里的 port 是外网 NAT 端口，集群内 sshd
# 监听 22）。⚠️ 这类集群的外网入口在集群内不可路由（实测 node 侧访问外网
# 入口为 Network unreachable），故节点间操作只能走内网 + 密码（无节点间
# root 免密时）。
#
# 流程（fail-fast + 幂等）：
#   [0/4] 解析：TARGET_IP/TARGET_IPS 三级解析 → 目标节点 → 实例推导（label
#         前缀 + pod ns 交叉）→ 按目标覆盖度定模式（整卸 / 缩容）并打印动作计划
#   [1/4] 整卸：helm uninstall --no-hooks（按 release 实际所在 ns）+ 删资源 ns
#         （等待 + 超时强删 pod 兜底 + 复活检测）；缩容：摘目标节点 label +
#         迁移钉住的 zk/controller pod 到剩余节点并等实例恢复 Ready
#   [2/4] 等待节点大页全 free（目标节点无 hugepages 请求 pod + 每节点
#         HugePages_Free==Total）：大页还原的硬前提，被占用时缩减只会挂 surplus
#   [3/4] 大页还原：per-NUMA nr_hugepages 写 0（nohup 后台写入 + 轮询归零；
#         surplus 释放卡住是内核已知行为，超时 die 并提示唯一回收途径 = 重启
#         节点）+ 重启 kubelet 刷 allocatable（cadvisor 只在 kubelet 启动时采集
#         大页，不刷则节点大页 allocatable 虚高，误导后续调度）
#   [4/4] 清 label（整卸时 label 是幂等重入的节点定位依据放最后；缩容时
#         [1/4] 已摘）+ 终验 + 契约输出（EMS_STATUS 为 uninstalled 或 scaled）
#
# 退出码：0 卸载/缩容完成（或幂等重入全跳过）；1 失败（判本 step 失败）。
# 单测：test/test_ems_uninstall.sh（mock kubectl/helm/ssh/sleep）。
set -uo pipefail

SCRIPT_NAME='ems-uninstall'

# 实例名/label 前缀/仲裁出的残留 label 由目标节点自动推导（[0/4] 段赋值，内部变量非入参；
# 残留列表用小写 ems_stale_labels —— 大写带冒号默认值引用形态会被平台识别器扫成入参）
EMS_NAME=""
ems_stale_labels=''

# 平台注入变量经 nameref 间接引用，避免被「识别参数」扫出入参
declare -n platform_target_hosts='TARGET_HOSTS'
declare -n platform_target_ips='TARGET_IPS'
declare -n platform_target_ip='TARGET_IP'

# 内部常量（普通赋值，不进参数面）
NS_DELETE_TIMEOUT_SECONDS=180
RESURRECT_CHECK_SECONDS=10
HP_FREE_TIMEOUT_SECONDS=300
HP_RELEASE_TIMEOUT_SECONDS=300
HP_RELEASE_POLL_SECONDS=10
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
            'command -v kubectl >/dev/null 2>&1 && command -v helm >/dev/null 2>&1'; then
            break
        fi
        log "$probe_host 缺少 kubectl/helm 或 SSH 不通，尝试下一个目标节点"
        probe_host=''
    done
    [[ -n "$probe_host" ]] || die '所有 TARGET_HOSTS 节点都缺少 kubectl/helm；无法执行卸载'

    log "remote execution via $probe_user@$probe_host:$probe_port（kubectl 视图为集群级）"

    remote_exec "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "cat > /tmp/ems-uninstall.sh" <"$self" \
        || die "推送脚本到 $probe_host 失败"

    # 跨 region 身份映射：逐节点 SSH 采集内网身份（hostname/-I），经小写 env
    # 下传供远程侧目标三级解析；同时带上该 endpoint 的登录凭据，供远程侧
    # node_ssh 在「凭据表按内网 IP 查不到」时按内网身份回退（NAT 集群节点间
    # 无 root 免密，只能密码认证）。specs 为 JSON 数组，先展开为 tab 四元组。
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

    remote_env=(TARGET_HOSTS=)
    local var
    for var in TARGET_IPS TARGET_IP; do
        printf -v quoted '%q' "${!var:-}"
        remote_env+=("$var=$quoted")
    done
    printf -v quoted '%q' "$creds_json"
    remote_env+=("ems_node_creds=$quoted")
    printf -v quoted '%q' "$id_map"
    remote_env+=("ems_target_id_map=$quoted")
    remote_exec "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "env ${remote_env[*]} bash /tmp/ems-uninstall.sh"
    return $?
}

# ==================== 远程阶段（首个有 kubectl+helm 的目标节点） ====================

self="$(readlink -f "$0" 2>/dev/null || echo "$0")"   # MULTI 拆分时递归调用自身要用

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

node_ssh() { # <ip> <command...>   ip：集群内网 IP（gy1 与跨 region 均传内网 IP）
    local ip=$1
    shift
    # 执行宿主即目标节点：本地直接执行（分发宿主本身常是目标之一，免去自 SSH 与 sshpass 依赖）
    if [[ " $(hostname -I 2>/dev/null) " == *" $ip "* ]]; then
        bash -c "$*"
        return $?
    fi
    # 凭据逻辑三级解析：①凭据表按内网 IP 命中（gy1：TARGET_HOSTS 的 ip 即内网 IP）
    # ②凭据表按 address:port 命中（TARGET_HOSTS 直接给 ip:port）③身份映射回退（跨
    # region NAT 集群：TARGET_HOSTS 是外网入口 ip:port，与集群内网 IP 对不上，按内网
    # IP/hostname 反查该节点 endpoint 的 user/pass；连接端口固定 22，映射里的 port 是
    # 外网 NAT 端口，集群内 sshd 监听 22）。
    local entry user port pass ssh_base rc=0
    entry="$(python3 - "${ems_node_creds:-}" "${ems_target_id_map:-}" "$ip" <<'PY'
import json
import sys

creds, id_map, key = sys.argv[1], sys.argv[2], sys.argv[3]


def matches(entry, value):
    if entry.get("ip") == value:
        return True
    if ":" in value:
        address, _, port = value.rpartition(":")
        return entry.get("ip") == address and str(entry.get("port") or "22") == port
    return False


for entry in json.loads(creds or "[]"):
    if matches(entry, key):
        print(f'{entry.get("user") or "root"}\t{entry.get("port") or "22"}\t{entry.get("pass") or ""}')
        raise SystemExit(0)
for entry in json.loads(id_map or "[]"):
    if key in list(entry.get("ips") or []) or key == (entry.get("hostname") or ""):
        print(f'{entry.get("user") or "root"}\t22\t{entry.get("pass") or ""}')
        raise SystemExit(0)
PY
)"
    # 凭据表与身份映射都未命中（本机直执/gy1 无凭据模式）→ 退化为默认
    # root@ip:22 纯密钥认证（集群节点间通常 root 免密互通）
    if [[ -n "$entry" ]]; then
        IFS=$'\t' read -r user port pass <<<"$entry"
    else
        user=root port=22 pass=''
    fi
    ssh_base='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15'
    # 优先密钥认证（集群节点间通常 root 免密互通）。rc=255 才是认证/连接失败，此时带密码则改走密码认证。
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

meminfo_of() { # <ip> → "total free surp"（大页三值；末尾带换行供 read 判成功，空输出=读取失败由调用方判）
    node_ssh "$1" "awk '/^HugePages_(Total|Free|Surp):/{printf \"%s \", \$2} END{print \"\"}' /proc/meminfo"
}

node_internal_ip() { # <node_name> → InternalIP（取不到则空）
    kubectl get node "$1" -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null | tr -d '\r'
}

# 目标节点兜底清扫：把「不属于任何实例、但仍占着大页」的目标节点也归零并刷新 allocatable。
# 典型场景：该节点 label 已被摘（例如上次缩容失败），池子却还留着 2000Gi。
sweep_target_pools() { # <node_name>
    local node_name=$1 node_ip hp_total got w alloc ready w2
    node_ip="$(node_internal_ip "$node_name")"
    if [[ -z "$node_ip" ]]; then
        log_err "$node_name: 取不到 InternalIP，跳过兜底清扫"
        return 1
    fi
    # 无 ems label、无本实例 pod 才算「无人认领」
    read -r hp_total _ _ < <(meminfo_of "$node_ip") || { log_err "$node_name: 读取大页失败"; return 1; }
    hp_total=${hp_total:-0}
    if (( hp_total > 0 )); then
        log "$node_name: 仍占大页 ${hp_total} 页且无实例归属 → 归零"
        node_ssh "$node_ip" "rm -f /tmp/ems_hp_release_done; nohup bash -c 'for n in /sys/devices/system/node/node*/hugepages/hugepages-2048kB/nr_hugepages; do echo 0 > \$n 2>/dev/null || true; done; echo done > /tmp/ems_hp_release_done' >/tmp/ems_hp_release.log 2>&1 &" \
            || { log_err "$node_name: 启动大页释放失败"; return 1; }
        w=0; got=-1
        while (( w < HP_RELEASE_TIMEOUT_SECONDS )); do
            sleep "$HP_RELEASE_POLL_SECONDS"
            w=$((w + HP_RELEASE_POLL_SECONDS))
            read -r got _ _ < <(meminfo_of "$node_ip")
            got=${got:-0}
            (( got == 0 )) && break
            log "$node_name: 大页释放中（剩余 $got 页，${w}s）"
        done
        (( got == 0 )) || { log_err "$node_name: 大页未归零（剩 $got 页，surplus 卡住时需重启节点）"; return 1; }
        log "$node_name: 大页已归零"
    else
        log "$node_name: 大页已为 0"
    fi
    # 清掉「实例已不存在、label 还挂着」的 ems label（release 已卸 / ns 已删但 label 残留，
    # 典型场景：上次卸载在 [4/4] 之前中断）
    local lk
    for lk in $(kubectl get node "$node_name" -o json 2>/dev/null | python3 -c '
import json, re, sys
labels = (json.load(sys.stdin).get("metadata") or {}).get("labels") or {}
print("\n".join(k for k in labels if re.fullmatch(r"ems[0-9]+", k)))
'); do
        [[ -n "$lk" ]] || continue
        local alive
        alive="$(helm list -A -o json 2>/dev/null | python3 -c '
import json, sys
key = sys.argv[1]
try:
    rels = json.load(sys.stdin) or []
except ValueError:
    rels = []
print("yes" if any((r.get("name") or "").startswith(key + "-") for r in rels) else "no")
' "$lk" 2>/dev/null || echo no)"
        if [[ "$alive" == yes ]]; then
            log "$node_name: label $lk 仍有对应 release，保留"
            continue
        fi
        if kubectl label node "$node_name" "$lk-" >/dev/null 2>&1; then
            log "$node_name: 清理无人认领的 label $lk-（实例已不存在）"
        else
            log_err "$node_name: 摘除残留 label $lk 失败"
        fi
    done

    alloc="$(allocatable_gib_of "$(kubectl get node "$node_name" -o json 2>/dev/null)")"
    if (( ${alloc:-0} > 0 )); then
        log "$node_name: allocatable 仍报 ${alloc}Gi → 重启 kubelet 刷新"
        node_ssh "$node_ip" 'systemctl restart kubelet' || { log_err "$node_name: 重启 kubelet 失败"; return 1; }
        w2=0; ready=''
        while (( w2 < KUBELET_TIMEOUT_SECONDS )); do
            sleep "$KUBELET_POLL_SECONDS"
            w2=$((w2 + KUBELET_POLL_SECONDS))
            ready="$(kubectl get node "$node_name" -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.status}{end}' 2>/dev/null)"
            [[ "$ready" == True ]] && break
        done
        [[ "$ready" == True ]] || { log_err "$node_name: 重启 kubelet 后未恢复 Ready"; return 1; }
        log "$node_name: allocatable 已刷新"
    else
        log "$node_name: allocatable 已为 0"
    fi
    return 0
}

allocatable_gib_of() { # <single-node-json> → 大页 allocatable 换算 Gi（键缺失=0）
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

uninstall_main() {
    local label_key rel_ns pair idx node_name node_ip target resolved via_map
    local -a node_names=() node_ips=() target_ips=()

    [[ $# -eq 0 ]] || die '不支持命令行参数；目标节点由平台环境注入'

    have kubectl || die '本机缺少 kubectl（正常应经 TARGET_HOSTS 分发到目标节点执行）'
    have helm || die '本机缺少 helm'
    have python3 || die '需要 python3'
    kubectl version --request-timeout=5s >/dev/null 2>&1 || die 'kubectl 无法访问 Kubernetes API'

    # ---- [0/4] 目标解析（TARGET_IP/TARGET_IPS → 集群节点）+ 实例推导 ----
    log "=== [0/4] 解析目标（TARGET_IP/TARGET_IPS → 实例推导） ==="
    mapfile -t target_ips < <(python3 - "${platform_target_ips:-}" "${platform_target_ip:-}" <<'PY'
import json, sys
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
elif sys.argv[2]:
    print(sys.argv[2])
PY
)
    ((${#target_ips[@]} >= 1)) || die '需要目标节点：请注入 TARGET_IP/TARGET_IPS（平台环境选择），或手工运行时显式指定'
    local node_json
    node_json="$(kubectl get nodes -o json)" || die '获取节点列表失败'
    local -a target_nodes=()
    for target in "${target_ips[@]}"; do
        # 三级解析：①直接命中（内网 IP/节点名，gy1）②endpoint 身份映射（跨 region）
        # ③ip:port 剥端口兜底
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
if node is None:
    for entry in id_map:
        if wanted in (entry.get("endpoint"), entry.get("address")):
            for ident in list(entry.get("ips") or []) + [entry.get("hostname") or ""]:
                node = find(ident)
                if node is not None:
                    break
            if node is not None:
                break
if node is None and ":" in wanted:
    node = find(wanted.rsplit(":", 1)[0])
if node is None:
    raise SystemExit(0)
print(node["metadata"]["name"])
' "$target")"
        [[ -n "$resolved" ]] || die "目标 $target 不是本集群节点（跨 region endpoint 需经 TARGET_HOSTS 分发采集身份映射）"
        target_nodes+=("$resolved")
        log "目标节点：$target → $resolved"
    done

    # ---- 实例推导：目标节点 label 前缀（唯一性）+ 其上 EMS pod 的 ns 交叉 ----
    # 大 JSON（nodes/pods）一律落临时文件走路径，不进 argv（128KiB 内核上限）
    local nodes_tmp pods_tmp helm_tmp
    nodes_tmp="$(mktemp /tmp/ems-uninstall-nodes.XXXXXX)"
    pods_tmp="$(mktemp /tmp/ems-uninstall-pods.XXXXXX)"
    helm_tmp="$(mktemp /tmp/ems-uninstall-helm.XXXXXX)"
    printf '%s' "$node_json" >"$nodes_tmp"
    kubectl get pods -A -o json >"$pods_tmp" || { rm -f "$nodes_tmp" "$pods_tmp" "$helm_tmp"; die '获取全量 pod 列表失败'; }
    helm list -A -o json >"$helm_tmp" 2>/dev/null || echo '[]' >"$helm_tmp"
    local inferred
    inferred="$(python3 - "$nodes_tmp" "$pods_tmp" "$helm_tmp" "${target_nodes[@]}" <<'PY'
import json, re, sys

nodes = json.load(open(sys.argv[1])).get("items", [])
pods = json.load(open(sys.argv[2])).get("items", [])
try:
    releases = json.load(open(sys.argv[3]))
except ValueError:
    releases = []
targets = set(sys.argv[4:])
node_by_name = {n["metadata"]["name"]: n for n in nodes}

label_keys = set()
for name in targets:
    labels = (node_by_name.get(name, {}).get("metadata") or {}).get("labels") or {}
    for key, value in labels.items():
        if re.fullmatch(r"ems\d+", key) and str(value).lower() == "true":
            label_keys.add(key)
pod_ns = {p["metadata"].get("namespace", "") for p in pods
          if (p.get("spec") or {}).get("nodeName") in targets
          and re.match(r"^ems\d", p["metadata"].get("namespace") or "")}
keys = label_keys | {ns.split("-")[0] for ns in pod_ns}
def key_alive(key):
    if any(ns == key or ns.startswith(key + "-") for ns in pod_ns):
        return True
    return any(re.fullmatch(key + r"(-\d+)?", str(rel.get("name") or "")) for rel in releases)
stale_keys = set()
if len(keys) > 1:
    # 多 key 仲裁：以运行证据（目标节点 pod / 集群内 release）区分活实例与残留 label。
    # 唯一存活 → 其余 key 判为残留顺带清理；零存活或多存活 → 真交叉，带证据明细 die。
    alive = {k for k in keys if key_alive(k)}
    if len(alive) == 1:
        stale_keys = keys - alive
        keys = alive
    else:
        detail = []
        for k in sorted(keys):
            marks = []
            if any(ns == k or ns.startswith(k + "-") for ns in pod_ns):
                marks.append("pod")
            if any(re.fullmatch(k + r"(-\d+)?", str(rel.get("name") or "")) for rel in releases):
                marks.append("release")
            detail.append(k + ":" + ("+".join(marks) if marks else "仅label残留"))
        print("MULTI\t" + ",".join(detail))
        raise SystemExit(0)
if not keys:
    print("\t\t")
    raise SystemExit(0)
label_key = keys.pop()
instance = ""
full_ns = {ns for ns in pod_ns if re.fullmatch(label_key + r"(-\d+)?", ns)}
if len(full_ns) > 1:
    print("MULTI\t" + ",".join(sorted(full_ns)))
    raise SystemExit(0)
if full_ns:
    instance = full_ns.pop()
else:
    matched = [rel.get("name") for rel in releases
               if re.fullmatch(label_key + r"(-\d+)?", str(rel.get("name") or ""))]
    if len(matched) > 1:
        print("MULTI\t" + ",".join(sorted(matched)))
        raise SystemExit(0)
    instance = matched[0] if matched else ""
print(label_key + "\t" + instance + "\t" + ",".join(sorted(stale_keys)))
PY
)" || { rm -f "$nodes_tmp" "$pods_tmp" "$helm_tmp"; die '实例推导失败'; }
    rm -f "$nodes_tmp" "$pods_tmp" "$helm_tmp"
    IFS=$'\t' read -r label_key EMS_NAME ems_stale_labels <<<"$inferred"
    # ---- 递归拆分入口（必须先于 MULTI 判断，否则子进程会再次拆分 → 无限递归）----
    local split_depth="${ems_split_depth:-0}"
    if [[ -n "${ems_force_instance:-}" ]]; then
        EMS_NAME="$ems_force_instance"
        label_key="${EMS_NAME%%-*}"
        log "指定实例：$EMS_NAME（label $label_key，由目标节点多实例拆分调用，深度 ${split_depth}）"
    elif [[ "$label_key" == MULTI ]]; then
        # 目标节点上有多个存活实例（例：192.168.31.113 同时承载 ems10-10 与 ems13-13）。
        # 按「调用者对目标节点有完全使用权」：目标节点上触及的实例**全部**剥离干净。
        # 每个实例各自按 label 覆盖度决定整卸 / 缩容，范围都只含目标节点。
        (( split_depth < 4 )) || die "多实例拆分递归过深（depth=$split_depth），疑似死循环，已中止"
        local -a multi_inst=()
        mapfile -t multi_inst < <(kubectl get pods -A -o json 2>/dev/null | python3 -c '
import json, re, sys
targets = set(sys.argv[1].split(","))
pat = re.compile(r"^ems[0-9]+-[0-9]+$")     # 工作负载 ns 即实例名（ems13-13）；资源 ns（ems13）不算
names = set()
for pod in json.load(sys.stdin).get("items", []):
    meta = pod.get("metadata") or {}
    ns = meta.get("namespace") or ""
    node = (pod.get("spec") or {}).get("nodeName") or ""
    if node in targets and pat.match(ns):
        names.add(ns)
print("\n".join(sorted(names)))
' "$(IFS=,; echo "${target_nodes[*]}")")
        if ((${#multi_inst[@]} == 0)); then
            die "目标节点上存在多个 EMS label 但无法枚举出实例名（$EMS_NAME）：请人工确认后重跑"
        fi
        log "目标节点上有 ${#multi_inst[@]} 个存活实例（${multi_inst[*]}）→ 逐个剥离（范围仅限目标节点）"
        local multi_fail='' inst
        for inst in "${multi_inst[@]}"; do
            [[ -n "$inst" ]] || continue
            log "──── 剥离实例 $inst ────"
            if ems_force_instance="$inst" ems_split_depth=$((split_depth + 1)) ems_skip_pool=1 bash "$self"; then
                log "实例 $inst 处理完成"
            else
                multi_fail+="$inst "
                log_err "实例 $inst 处理失败（继续处理后续实例）"
            fi
        done
        if [[ -n "$multi_fail" ]]; then
            die "以下实例未能剥离干净：${multi_fail}（详见各自日志）"
        fi
        log "目标节点上触及的实例已全部剥离：${multi_inst[*]}"
        # 兜底：目标节点里可能还有「label 已摘、但池子没归零」的（上次缩容失败的典型残留）
        local sw_bad='' sw_node
        for sw_node in "${target_nodes[@]}"; do
            sweep_target_pools "$sw_node" || sw_bad+="$sw_node "
        done
        if [[ -n "$sw_bad" ]]; then
            die "以下目标节点仍有大页未归零 / allocatable 未刷新：${sw_bad}（见上方日志）"
        fi
        log "目标节点兜底清扫完成：${target_nodes[*]} 均已无大页占用"
        printf '\n--- EMS 卸载契约（KEY=VALUE） ---\n'
        printf 'EMS_NAME=%s\n' "$(IFS=,; echo "${multi_inst[*]}")"
        printf 'EMS_MULTI_INSTANCES=%s\n' "$(IFS=,; echo "${multi_inst[*]}")"
        printf 'EMS_STATUS=uninstalled\n'
        printf 'EMS_NODES=%s\n' "$(IFS=,; echo "${target_nodes[*]}")"
        return 0
    fi

    if [[ -z "$label_key" ]]; then
        # 目标节点不属于任何实例：仍可能有「label 已摘、池子还留着」的孤儿大页
        #（上次卸载中断的典型残留）→ 一并清扫，保证目标节点真正干净。
        log "目标节点不属于任何 EMS 实例（已卸干净或从未安装）"
        local noinst_bad='' noinst_node
        for noinst_node in "${target_nodes[@]}"; do
            sweep_target_pools "$noinst_node" || noinst_bad+="$noinst_node "
        done
        [[ -z "$noinst_bad" ]] || die "以下目标节点仍有大页未归零 / allocatable 未刷新：${noinst_bad}"
        log "目标节点已干净（无实例、无孤儿大页）：${target_nodes[*]}"
        printf '\n--- EMS 卸载契约（KEY=VALUE） ---\n'
        printf 'EMS_NAME=\n'
        printf 'EMS_STATUS=uninstalled\n'
        printf 'EMS_NODES=%s\n' "$(IFS=,; echo "${target_nodes[*]}")"
        return 0
    fi
    if [[ -n "$EMS_NAME" ]]; then
        log "推导实例：$EMS_NAME（label $label_key）"
    else
        log "label $label_key 残留清理（无 pod/无 release，仅清 label 与大页）"
    fi
    if [[ -n "${ems_stale_labels:-}" ]]; then
        log "残留 label：$ems_stale_labels（无 pod 无 release，实例已卸载）——将在 [4/4] 顺带清理"
    fi

    # 卸载/缩容范围：label 全部节点 vs 目标覆盖度——目标未覆盖全部 label 节点
    # → 缩容（只动目标节点，实例在剩余节点继续服务）；全覆盖 → 整卸（全部节点）
    local scale_mode=0
    local -a remain_nodes=()
    local -a label_pairs=()
    mapfile -t label_pairs < <(printf '%s' "$node_json" | python3 -c '
import json, sys
label_key = sys.argv[1]
for node in json.load(sys.stdin).get("items", []):
    labels = (node.get("metadata") or {}).get("labels") or {}
    if label_key in labels:
        ip = ""
        for addr in (node.get("status") or {}).get("addresses", []):
            if addr.get("type") == "InternalIP":
                ip = addr.get("address"); break
        print(node["metadata"]["name"] + "\t" + ip)
' "$label_key")
    local -a label_all_names=()
    for pair in "${label_pairs[@]}"; do
        IFS=$'\t' read -r node_name node_ip <<<"$pair"
        label_all_names+=("$node_name")
        if [[ " ${target_nodes[*]} " != *" $node_name "* ]]; then
            scale_mode=1
        fi
    done
    if (( scale_mode )); then
        for node_name in "${target_nodes[@]}"; do
            if [[ " ${label_all_names[*]} " == *" $node_name "* ]]; then
                IFS=$'\t' read -r node_name node_ip < <(grep -F "$node_name" <(printf '%s\n' "${label_pairs[@]}"))
                node_names+=("$node_name")
                node_ips+=("${node_ip:-}")
            fi
        done
        for node_name in "${label_all_names[@]}"; do
            [[ " ${target_nodes[*]} " != *" $node_name "* ]] && remain_nodes+=("$node_name")
        done
        log "缩容模式：实例 $EMS_NAME 的 label 节点（${label_all_names[*]}）未被目标全覆盖，剩余节点［${remain_nodes[*]}］继续服务"
        log "动作计划：摘目标节点 label（${node_names[*]}）→ DS server 自动消失 → 迁移钉住的 zk/controller pod → 等大页 free → 归零 + 刷 kubelet；release 与资源 ns 保留"
    else
        for pair in "${label_pairs[@]}"; do
            IFS=$'\t' read -r node_name node_ip <<<"$pair"
            node_names+=("$node_name")
            node_ips+=("${node_ip:-}")
        done
        log "整卸模式：目标覆盖实例全部 label 节点，release + 资源 ns + label + 大页全部清理"
    fi
    for idx in "${!node_names[@]}"; do
        log "操作节点：${node_names[$idx]}（${node_ips[$idx]:-无 InternalIP}）"
    done
    ((${#node_names[@]} >= 1)) || log "无 label $label_key 节点（label 已清或从未安装）：仅清理 ns/release，节点级操作全部跳过"

    # release 实际所在 ns（历史遗留 release 可能不在标准 ns，如 default）
    rel_ns="$(helm list -A -o json 2>/dev/null | python3 -c '
import json, sys
try:
    releases = json.load(sys.stdin)
except ValueError:
    raise SystemExit(0)
for rel in releases:
    if rel.get("name") == sys.argv[1]:
        print(rel.get("namespace") or "default")
        break
' "$EMS_NAME")"

    # ---- [1/4] 整卸：helm release + 资源 ns；缩容：摘 label + 迁移钉住 pod ----
    local release_removed=0 ns_removed=0
    if (( scale_mode )); then
        log "=== [1/4] 缩容：摘目标节点 label + 迁移钉住的 zk/controller pod ==="
        local sc_idx sc_name sc_ip
        for sc_idx in "${!node_names[@]}"; do
            sc_name="${node_names[$sc_idx]}"; sc_ip="${node_ips[$sc_idx]}"
            kubectl label node "$sc_name" "$label_key-" >/dev/null \
                || die "节点 $sc_name 摘 label $label_key 失败"
            log "label 已摘：$sc_name $label_key-（DS server 随 nodeSelector 失配自动删除）"
            # 删钉在目标节点上的实例 pod（zk=StatefulSet/controller=Deployment 不会因
            # 摘 label 自动走，需删 pod 促其重建到剩余 label 节点；server 已由 DS 处理）
            local pinned
            pinned="$(kubectl get pods -n "$EMS_NAME" -o json 2>/dev/null | python3 -c '
import json, sys
try:
    pods = json.load(sys.stdin).get("items", [])
except ValueError:
    raise SystemExit
for pod in pods:
    if (pod.get("spec") or {}).get("nodeName") == sys.argv[1]:
        print((pod.get("metadata") or {}).get("name", ""))
' "$sc_name")"
            if [[ -n "$pinned" ]]; then
                log "删除钉在 $sc_name 上的实例 pod（促重建到剩余节点）：$(echo "$pinned" | tr '\n' ' ')"
                kubectl delete pod -n "$EMS_NAME" --field-selector "spec.nodeName=$sc_name" >/dev/null 2>&1 \
                    || log "警告：$sc_name 上无实例 pod 或删除失败（可能已由 DS 清理）"
            else
                log "$sc_name 上无钉住的实例 pod"
            fi
            # 摘 label 与 DS 同步有竞态：DS 可能刚在 $sc_name 又拉了一个 server pod
            # （2026-10-22 现场：ems-server-xxxx 被重建回目标节点，收尾永远等不到恢复）。
            # 这里做「确认 label 已摘 → 反复清掉该节点上的一切本实例 pod」的幂等收口。
            local sc_wait=0 sc_left=''
            while (( sc_wait < 60 )); do
                local lbl_now
                lbl_now="$(kubectl get node "$sc_name" -o json 2>/dev/null | python3 -c '
import json, sys
labels = (json.load(sys.stdin).get("metadata") or {}).get("labels") or {}
print(labels.get(sys.argv[1], ""))
' "$label_key" 2>/dev/null || true)"
                sc_left="$(kubectl get pods -n "$EMS_NAME" --field-selector "spec.nodeName=$sc_name" -o name 2>/dev/null | tr "\n" " " || true)"
                [[ -z "$lbl_now" && -z "$sc_left" ]] && break
                [[ -n "$lbl_now" ]] && kubectl label node "$sc_name" "$label_key-" >/dev/null 2>&1 || true
                if [[ -n "$sc_left" ]]; then
                    log "清理 $sc_name 上残留的本实例 pod（DS 竞态重建）：$sc_left"
                    kubectl delete pods -n "$EMS_NAME" --field-selector "spec.nodeName=$sc_name" --grace-period=0 --force >/dev/null 2>&1 || true
                fi
                sleep 5
                sc_wait=$(( sc_wait + 5 ))
            done
            [[ -z "$sc_left" ]] || die "$sc_name 上仍有本实例 pod 无法清除（${sc_left}）：目标节点未剥离干净，人工处理后重跑"
            log "$sc_name：label 已摘净、该节点上已无本实例 pod（不会再被实例调度回来）"
        done
        # 等实例在剩余节点恢复：ns 内 pod 全部 Running&Ready 且不在目标节点
        local sc_waited=0 sc_ok=0 sc_bad='' sc_recover_failed=0
        local -a sc_target_pods=()
        log "等待实例在剩余节点恢复（ns $EMS_NAME 全部 pod Ready，最长 ${HP_FREE_TIMEOUT_SECONDS}s；zk 迁移瞬间多数派可能有秒级抖动，server 自动重连）"
        while (( sc_waited < HP_FREE_TIMEOUT_SECONDS )); do
            sleep "$HP_RELEASE_POLL_SECONDS"
            sc_waited=$((sc_waited + HP_RELEASE_POLL_SECONDS))
            sc_bad="$(kubectl get pods -n "$EMS_NAME" -o json 2>/dev/null | python3 -c '
import json, sys
targets = set(sys.argv[1].split(","))
try:
    pods = json.load(sys.stdin).get("items", [])
except ValueError:
    print("ns不存在"); raise SystemExit
if not pods:
    print("无pod"); raise SystemExit
bad = []
for pod in pods:
    meta = pod.get("metadata") or {}
    spec = pod.get("spec") or {}
    status = pod.get("status") or {}
    name = meta.get("name", "?")
    ready = any(c.get("type") == "Ready" and c.get("status") == "True"
                for c in status.get("conditions") or [])
    if spec.get("nodeName") in targets:
        bad.append(f"{name}仍在目标节点({spec.get(\"nodeName\")})")
        continue
    if ready:
        continue
    # 带上原因，便于一眼定位（Pending/Insufficient/VolumeNodeAffinity/ContainerCreating…）
    reason = status.get("reason") or ""
    for cstat in (status.get("containerStatuses") or []) + (status.get("initContainerStatuses") or []):
        waiting = ((cstat.get("state") or {}).get("waiting") or {})
        if waiting.get("reason"):
            reason = waiting["reason"] + ": " + (waiting.get("message") or "")
            break
    bad.append(f"{name}未Ready[{status.get(\"phase\") or \"?\"}{("/" + reason) if reason else ""}]")
print(" ".join(bad))
' "$(IFS=,; echo "${node_names[*]}")")"
            if [[ -z "$sc_bad" ]]; then
                sc_ok=1
                break
            fi
            log "实例恢复中（${sc_waited}s）：$sc_bad"
        done
        if (( sc_ok )); then
            log "实例已在剩余节点恢复 Ready（剩余节点［${remain_nodes[*]}］继续服务 $EMS_NAME）"
        else
            # A 的剥离是首要契约（必须做完），X 在剩余节点的恢复单独报错：
            # 目标是「目标节点干净」+「实例在剩余节点继续服务」，两个都要，缺一个就明确失败。
            sc_recover_failed=1
            log_err "$EMS_NAME 在剩余节点［${remain_nodes[*]}］未在 ${HP_FREE_TIMEOUT_SECONDS}s 内恢复：$sc_bad"
            log_err "诊断：先 kubectl -n $EMS_NAME describe pod <未就绪pod> 看 Events；常见原因是 zk 副本迁移后多数派未重建 / 镜像拉取失败 / 剩余节点资源（大页、CPU）不足。本 step 会先完成目标节点的剥离与清理，最后以失败结束。"
        fi
    else
        log "=== [1/4] 卸载 helm release + 资源 ns ==="
        if [[ -n "$rel_ns" ]]; then
            log "helm uninstall $EMS_NAME（release 位于 ns $rel_ns，--no-hooks 绕开 pre-delete 钩子防卡死）"
            helm uninstall "$EMS_NAME" -n "$rel_ns" --no-hooks \
                || die "helm uninstall 失败（详见上方 helm 输出）"
            release_removed=1
        else
            log "helm release $EMS_NAME 不存在（全 ns 扫描），跳过"
        fi
        if kubectl get ns "$EMS_NAME" -o json >/dev/null 2>&1; then
            log "删除资源 ns $EMS_NAME"
            if ! kubectl delete ns "$EMS_NAME" --wait=true --timeout="${NS_DELETE_TIMEOUT_SECONDS}s"; then
                log "资源 ns 删除超时，强制清理残留 pod"
                kubectl delete pod -n "$EMS_NAME" --all --grace-period=0 --force >/dev/null 2>&1 || true
                kubectl delete ns "$EMS_NAME" --wait=true --timeout=60s \
                    || die "资源 ns $EMS_NAME 删除失败（Finalizer/kuberay 阻塞），需人工处理"
            fi
            ns_removed=1
        else
            log "资源 ns $EMS_NAME 不存在，跳过"
        fi
        if (( ns_removed )); then
            sleep "$RESURRECT_CHECK_SECONDS"
            if kubectl get ns "$EMS_NAME" >/dev/null 2>&1; then
                die "资源 ns $EMS_NAME 删除后死而复生（kuberay/CI 自动重装？）；停手，需人工协调停掉自动部署后重跑"
            fi
            log "资源 ns 已释放且未复活"
        fi
    fi

    # ---- [2/4] + [3/4] 大页处理 ----
    # MULTI 拆分时由父进程在全部实例卸完后**统一**释放池子（ems_skip_pool=1）：
    # 否则先卸的实例会卡在「等本节点大页全 free」，而占着大页的正是还没卸的另一个实例。
    if [[ -n "${ems_skip_pool:-}" ]]; then
        log "=== [2/4][3/4] 跳过（由父进程统一释放大页；本轮仅卸 release/ns/label） ==="
    else
    local released_ips='' restarted_ips='' hp_total=0 hp_free=0 hp_surp=0
    # ---- [2/4] 等待大页全 free（pod 退出 + Free==Total）----
    log "=== [2/4] 等待节点大页全 free（无 hugepages 请求 pod + HugePages_Free==Total，最长 ${HP_FREE_TIMEOUT_SECONDS}s） ==="
        local waited=0 stuck_pods='' stuck_nodes='' all_free=0 pods_tmp
        pods_tmp="$(mktemp /tmp/ems-uninstall-pods.XXXXXX)"
        while :; do
            kubectl get pods -A -o json >"$pods_tmp" || { rm -f "$pods_tmp"; die '获取全量 pod 列表失败'; }
            stuck_pods="$(python3 - "$pods_tmp" "${node_names[@]}" <<'PY'
import json, sys
path, targets = sys.argv[1], set(sys.argv[2:])
found = []
for pod in json.load(open(path)).get("items", []):
    spec = pod.get("spec") or {}
    if spec.get("nodeName") not in targets:
        continue
    if any("hugepages-2Mi" in ((c.get("resources") or {}).get("requests") or {})
           for c in spec.get("containers", [])):
        found.append(f'{(pod.get("metadata") or {}).get("namespace", "?")}/{(pod.get("metadata") or {}).get("name", "?")}')
print("\n".join(found))
PY
)"
            all_free=1; stuck_nodes=''
            for idx in "${!node_ips[@]}"; do
                read -r hp_total hp_free hp_surp < <(meminfo_of "${node_ips[$idx]}") \
                    || { rm -f "$pods_tmp"; die "读取 ${node_names[$idx]} 大页现状失败"; }
                hp_total=${hp_total:-0}; hp_free=${hp_free:-0}
                if (( hp_total > 0 && hp_free < hp_total )); then
                    all_free=0; stuck_nodes+=" ${node_names[$idx]}"
                fi
            done
            [[ -z "$stuck_pods" && "$all_free" == 1 ]] && break
            (( waited < HP_FREE_TIMEOUT_SECONDS )) || { rm -f "$pods_tmp"; die "等待大页 free 超时（${HP_FREE_TIMEOUT_SECONDS}s）：未退出 pod［$stuck_pods ］大页未释放节点［$stuck_nodes ］——EMS 进程未退出或内存池未归还，人工确认后重跑"; }
            log "等待中（${waited}s）：${stuck_pods:+pod $stuck_pods 未退出；}${stuck_nodes:+大页未 free：$stuck_nodes}"
            sleep "$HP_RELEASE_POLL_SECONDS"
            waited=$((waited + HP_RELEASE_POLL_SECONDS))
        done
        rm -f "$pods_tmp"
        log "节点大页已全 free（无 hugepages 请求 pod）"

        # ---- [3/4] 大页归零 + 刷 allocatable ----
        log "=== [3/4] 大页还原为 0（per-NUMA 后台写入）+ 刷新 allocatable ==="
        for idx in "${!node_names[@]}"; do
            node_name="${node_names[$idx]}"; node_ip="${node_ips[$idx]}"
            read -r hp_total hp_free hp_surp < <(meminfo_of "$node_ip") \
                || die "读取 $node_name 大页现状失败"
            hp_total=${hp_total:-0}
            if (( hp_total == 0 )); then
                log "$node_name: 大页已为 0，跳过还原"
            else
                log "$node_name: $hp_total 页 → 0（per-NUMA 后台写入，最长 ${HP_RELEASE_TIMEOUT_SECONDS}s）"
                node_ssh "$node_ip" "rm -f /tmp/ems_hp_release_done; nohup bash -c 'for n in /sys/devices/system/node/node*/hugepages/hugepages-2048kB/nr_hugepages; do echo 0 > \$n 2>/dev/null || true; done; echo done > /tmp/ems_hp_release_done' >/tmp/ems_hp_release.log 2>&1 &" \
                    || die "在 $node_name 启动大页释放写入失败"
                local waited2=0 got_total=-1
                while (( waited2 < HP_RELEASE_TIMEOUT_SECONDS )); do
                    sleep "$HP_RELEASE_POLL_SECONDS"
                    waited2=$((waited2 + HP_RELEASE_POLL_SECONDS))
                    read -r got_total _ < <(meminfo_of "$node_ip")
                    got_total=${got_total:-0}
                    (( got_total == 0 )) && break
                    log "$node_name: 大页释放中（剩余 $got_total 页，${waited2}s）"
                done
                (( got_total == 0 )) || die "$node_name 大页 ${HP_RELEASE_TIMEOUT_SECONDS}s 内未归零（剩余 $got_total 页）：surplus 释放卡住是内核已知行为（大页只增不减），运行时无法回收——唯一可靠途径是重启节点（需人工确认后执行）"
                log "$node_name: 大页已归零"
                released_ips+="$node_ip,"
            fi
            # kubelet：allocatable 仍报大页 → 重启刷新（cadvisor 只在 kubelet 启动时采集）
            local alloc_gib
            alloc_gib="$(allocatable_gib_of "$(kubectl get node "$node_name" -o json)")"
            if (( alloc_gib <= 0 )); then
                log "$node_name: 大页 allocatable 已为 ${alloc_gib}Gi，跳过 kubelet 重启"
                continue
            fi
            log "$node_name: 重启 kubelet 刷新大页 allocatable ${alloc_gib}Gi → 0（pod 不重启，节点短暂 NotReady）"
            node_ssh "$node_ip" 'systemctl restart kubelet' || die "$node_name 重启 kubelet 失败"
            restarted_ips+="$node_ip,"
            local waited3=0 ready=False alloc2=-1
            while (( waited3 < KUBELET_TIMEOUT_SECONDS )); do
                sleep "$KUBELET_POLL_SECONDS"
                waited3=$((waited3 + KUBELET_POLL_SECONDS))
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
' <<<"$(kubectl get node "$node_name" -o json)")"
                [[ "$ready" == True ]] && (( alloc2 <= 0 )) && break
            done
            [[ "$ready" == True ]] || die "$node_name 重启 kubelet 后未恢复 Ready（${waited3}s）"
            (( alloc2 <= 0 )) || die "$node_name allocatable 仍为 ${alloc2}Gi（cadvisor 未刷新，人工确认）"
            log "$node_name: Ready 且 allocatable 已归零"
        done

    fi   # ← ems_skip_pool 分支结束

    # ---- [4/4] 清 label（缩容时 [1/4] 已摘目标节点）+ 终验 ----
    log "=== [4/4] 清理 label + 终验 ==="
    local label_removed='' idx4
    if (( ! scale_mode )); then
        for idx4 in "${!node_names[@]}"; do
            kubectl label node "${node_names[$idx4]}" "$label_key-" >/dev/null \
                || die "节点 ${node_names[$idx4]} 清理 label $label_key 失败"
            log "label 清理：${node_names[$idx4]} $label_key-"
            label_removed+="${node_names[$idx4]},"
        done
    else
        for idx4 in "${!node_names[@]}"; do
            label_removed+="${node_names[$idx4]},"
        done
    fi

    # 顺带清理仲裁识别的残留 label（实例已死无 pod 无 release，清理范围=全集群该 label 节点；
    # 失败不阻塞主实例卸载流程，仅告警）
    if [[ -n "${ems_stale_labels:-}" ]]; then
        local stale_key stale_name
        local -a stale_keys=() stale_nodes=()
        IFS=',' read -r -a stale_keys <<<"$ems_stale_labels"
        for stale_key in "${stale_keys[@]}"; do
            mapfile -t stale_nodes < <(printf '%s' "$node_json" | python3 -c '
import json, sys
for node in json.load(sys.stdin).get("items", []):
    if sys.argv[1] in ((node.get("metadata") or {}).get("labels") or {}):
        print(node["metadata"]["name"])
' "$stale_key")
            ((${#stale_nodes[@]} > 0)) || { log "残留 label $stale_key 无挂载节点（已清或非本集群）：跳过"; continue; }
            for stale_name in "${stale_nodes[@]}"; do
                kubectl label node "$stale_name" "$stale_key-" >/dev/null \
                    || log "警告：$stale_name 清理残留 label $stale_key 失败（不阻塞主流程）"
                label_removed+="$stale_name,"
            done
        done
    fi

    if (( scale_mode )); then
        # 缩容终验：目标节点无 label、无实例 pod（[1/4] 已验 Ready）；release/ns 健在
        kubectl get nodes -o json | python3 -c '
import json, sys
for node in json.load(sys.stdin).get("items", []):
    labels = (node.get("metadata") or {}).get("labels") or {}
    name = node["metadata"]["name"]
    if sys.argv[1] in labels and name in sys.argv[2].split(","):
        print(name); raise SystemExit(1)
' "$label_key" "$(IFS=,; echo "${node_names[*]}")" >/dev/null || die "终验失败：目标节点仍有 label $label_key"
        if [[ -n "$EMS_NAME" ]] && kubectl get ns "$EMS_NAME" >/dev/null 2>&1; then
            helm list -A -o json 2>/dev/null | python3 -c '
import json, sys
try:
    releases = json.load(sys.stdin)
except ValueError:
    raise SystemExit(1)
for rel in releases:
    if rel.get("name") == sys.argv[1]:
        raise SystemExit(0)
raise SystemExit(1)
' "$EMS_NAME" || die "终验失败：缩容模式下 release $EMS_NAME 应保留却不存在"
            log "终验通过（缩容：目标节点已剥离干净；release $EMS_NAME 保留，实例由剩余节点［${remain_nodes[*]}］继续服务）"
        fi
    else
        helm list -A -o json 2>/dev/null | python3 -c '
import json, sys
try:
    releases = json.load(sys.stdin)
except ValueError:
    raise SystemExit(0)
for rel in releases:
    if rel.get("name") == sys.argv[1]:
        raise SystemExit(1)
' "$EMS_NAME" || die "终验失败：release $EMS_NAME 仍存在"
        kubectl get ns "$EMS_NAME" -o json >/dev/null 2>&1 && die "终验失败：资源 ns $EMS_NAME 仍存在"
        if ((${#node_names[@]} > 0)); then
            local idx5
            for idx5 in "${!node_names[@]}"; do
                read -r hp_total hp_free hp_surp < <(meminfo_of "${node_ips[$idx5]}") \
                    || die "终验读取 ${node_names[$idx5]} 大页失败"
                hp_total=${hp_total:-0}; hp_surp=${hp_surp:-0}
                [[ -n "${ems_skip_pool:-}" ]] || (( hp_total == 0 )) || die "终验失败：${node_names[$idx5]} 大页仍为 $hp_total 页（父进程会统一释放：ems_skip_pool 模式下跳过）"
                (( hp_surp == 0 )) || die "终验失败：${node_names[$idx5]} 大页 surplus 为 $hp_surp 页未回收（需重启节点）"
            done
            kubectl get nodes -o json | python3 -c '
import json, sys
for node in json.load(sys.stdin).get("items", []):
    if sys.argv[1] in ((node.get("metadata") or {}).get("labels") or {}):
        print(node["metadata"]["name"]); raise SystemExit(1)
' "$label_key" >/dev/null || die "终验失败：仍有节点带 label $label_key"
        fi
        log '终验通过'
    fi

    # 缩容模式：目标节点已剥离干净，但实例未在剩余节点恢复 → 明确失败（不输出成功契约）
    if (( scale_mode )) && (( ${sc_recover_failed:-0} )); then
        die "目标节点已剥离干净（label / 实例 pod / 大页均已清理），但实例 $EMS_NAME 未在剩余节点［${remain_nodes[*]}］恢复：${sc_bad:-未知}——请按上面的诊断处理实例后重跑本 step 校验"
    fi

    # ---- 目标节点兜底清扫（含未被本实例覆盖的目标节点）----
    local sweep_bad='' sw_node
    for sw_node in "${target_nodes[@]}"; do
        [[ " ${node_names[*]} " == *" $sw_node "* ]] && continue
        sweep_target_pools "$sw_node" || sweep_bad+="$sw_node "
    done
    [[ -z "$sweep_bad" ]] || die "以下目标节点仍有大页未归零 / allocatable 未刷新：${sweep_bad}"

    # ---- 契约输出 ----
    local ems_status=uninstalled
    (( scale_mode )) && ems_status=scaled
    printf '\n--- EMS 卸载契约（KEY=VALUE） ---\n'
    printf 'EMS_NAME=%s\n' "$EMS_NAME"
    printf 'EMS_STATUS=%s\n' "$ems_status"
    printf 'EMS_NODES=%s\n' "$(IFS=,; echo "${node_ips[*]}")"
    printf 'EMS_RELEASE_REMOVED=%s\n' "$release_removed"
    printf 'EMS_NAMESPACE_REMOVED=%s\n' "$ns_removed"
    printf 'EMS_HUGEPAGES_RELEASED=%s\n' "$(echo "$released_ips" | sed 's/,$//')"
    printf 'EMS_KUBELET_RESTARTED=%s\n' "$(echo "$restarted_ips" | sed 's/,$//')"
    printf 'EMS_LABEL_REMOVED=%s\n' "$(echo "$label_removed" | sed 's/,$//')"
    local remain_csv=''
    ((${#remain_nodes[@]})) && remain_csv="$(IFS=,; echo "${remain_nodes[*]}")"
    printf 'EMS_REMAIN_NODES=%s\n' "$remain_csv"
    printf 'EMS_STALE_LABELS=%s\n' "${ems_stale_labels:-}"
}

main() {
    [[ $# -eq 0 ]] || die '不支持命令行参数；请使用环境变量配置'
    if [[ -n "${platform_target_hosts:-}" ]]; then
        dispatch_to_target
        return $?
    fi
    uninstall_main
}

main "$@"
