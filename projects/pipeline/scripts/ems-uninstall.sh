#!/usr/bin/env bash
# pipeline: no-positional-args
# EMS（mfv-kv 内存池存储）卸载流水线 step 主脚本（shell step，无位置参数调用）。
#
# 用法：在流水线中插入本 step，唯一可选参数 EMS_DRY_RUN（默认 1 预演）。
# 目标节点 = 平台注入的 TARGET_IP/TARGET_IPS（勾选环境即表达意图），脚本自动
# 推导实例：目标节点的 label 前缀（唯一性校验）+ 其上 EMS pod 的 ns 交叉得
# 实例名；无 pod/release 的纯 label 残留同样可清（仅清 label 与大页）。
# 卸载范围 = 该 label 的**全部**节点（不止勾选的），节点级操作只作用于这些
# 节点；TARGET_HOSTS 仅用于远程分发宿主探测。目标不属于任何实例 = 已卸干净，
# 幂等成功退出；多实例交叉 = die 请人工。推荐两段式：默认预演看清单 →
# EMS_DRY_RUN=0 正式清理。跨 region（hd2 等）：TARGET_IPS 为外网入口 endpoint
# （ip:port）时经分发阶段采集的身份映射三级解析，gy1 内网行为不变。
#
# 执行位置：工作台服务端（无 kubectl/helm）经 TARGET_HOSTS 自推送到首个具备
# kubectl+helm 的目标节点远程执行；对各目标节点的大页写入 / kubelet 重启：
# 执行宿主自身本地直接执行，其余节点优先密钥认证（集群节点间通常 root 免密
# 互通），密钥失败且凭据带密码时才 sshpass 重试（同 ems-hugepages 模式）。
#
# 流程（fail-fast + 幂等）：
#   [0/4] 解析：TARGET_IP/TARGET_IPS 三级解析 → 目标节点 → 实例推导（label
#         前缀 + pod ns 交叉）→ 卸载范围 = label 全部节点
#   [1/4] helm uninstall（按 release 实际所在 ns，历史遗留 release 装在 default
#         等非标准 ns 也能卸；不存在跳过）+ 删资源 ns（等待 + 超时强删 pod 兜底
#         + 复活检测——kuberay/CI 自动重装 → 失败并提示人工协调）
#   [2/4] 等待节点大页全 free（目标节点无 hugepages 请求 pod + 每节点
#         HugePages_Free==Total）：大页还原的硬前提，被占用时缩减只会挂 surplus
#   [3/4] 大页还原：per-NUMA nr_hugepages 写 0（nohup 后台写入 + 轮询归零，
#         规避 sysfs 写入阻塞拖死主流程；surplus 释放卡住是内核已知行为，
#         超时 die 并提示唯一回收途径 = 重启节点）+ 重启 kubelet 刷 allocatable
#         （cadvisor 只在 kubelet 启动时采集大页，不刷则节点大页 allocatable
#         虚高 2000Gi，误导后续调度）
#   [4/4] 清 label（放最后：label 是幂等重入的节点定位依据）+ 终验 + 契约输出
#
# 退出码：0 卸载完成（或幂等重入全跳过）；1 失败（判本 step 失败）。
# 单测：test/test_ems_uninstall.sh（mock kubectl/helm/ssh/sleep）。
set -uo pipefail

SCRIPT_NAME='ems-uninstall'

# ---- step 参数声明（平台「识别参数」按声明与紧邻注释扫描）----
# EMS_DRY_RUN = 预演开关（默认 1=只打印将执行的操作不落地；0=真实卸载）。用法：先默认预演看清单，再设 0 正式清理
EMS_DRY_RUN="${EMS_DRY_RUN:-1}"

# 实例名与 label 前缀由目标节点自动推导（[0/4] 段赋值，内部变量非入参）
EMS_NAME=""

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
run() { # 破坏性命令的 DRY_RUN 包装
    if [[ "$EMS_DRY_RUN" == 1 ]]; then
        log "[DRY_RUN] $*"
        return 0
    fi
    "$@"
}

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
    # 下传供远程侧目标三级解析；specs 为 JSON 数组，先展开为 tab 四元组。
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
        id_lines+="${id_host}:${id_port}"$'\t'"${id_host}"$'\t'"${id_hostname}"$'\t'"${id_ips}"$'\n'
    done
    local id_map='[]'
    if [[ -n "$id_lines" ]]; then
        id_map="$(printf '%s' "$id_lines" | python3 -c '
import json, sys
entries = []
for line in sys.stdin.read().splitlines():
    if not line.strip():
        continue
    endpoint, address, hostname, ips = (line.split("\t") + ["", "", "", ""])[:4]
    entries.append({"endpoint": endpoint, "address": address,
                    "hostname": hostname, "ips": ips.split()})
print(json.dumps(entries))')" || id_map='[]'
    fi

    remote_env=(TARGET_HOSTS=)
    local var
    for var in EMS_DRY_RUN TARGET_IPS TARGET_IP; do
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
    # 凭据表无该节点（本机直执模式）→ 退化为默认 root@ip:22 纯密钥认证
    # （集群节点间通常 root 免密互通；不通时由下方 BatchMode 失败给出明确报错）
    local user port pass ssh_base rc=0
    if [[ -n "$entry" ]]; then
        IFS=$'\t' read -r user port pass <<<"$entry"
    else
        user=root port=22 pass=''
    fi
    ssh_base='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15'
    # 优先密钥认证（集群节点间通常 root 免密互通）。rc=255 才是认证/连接失败，此时带密码则 sshpass 重试。
    ssh $ssh_base -o BatchMode=yes -p "$port" "$user@$ip" "$@" 2>/dev/null || rc=$?
    if (( rc != 255 )); then
        return $rc
    fi
    if [[ -n "$pass" ]]; then
        have sshpass || die "节点 $ip 密钥认证失败且本机未安装 sshpass（或配置节点间 root 免密）"
        SSHPASS="$pass" sshpass -e ssh $ssh_base -p "$port" "$user@$ip" "$@"
        return $?
    fi
    die "节点 $ip SSH 密钥认证失败且未提供密码（检查节点间 root 免密互通）"
}

meminfo_of() { # <ip> → "total free surp"（大页三值；末尾带换行供 read 判成功，空输出=读取失败由调用方判）
    node_ssh "$1" "awk '/^HugePages_(Total|Free|Surp):/{printf \"%s \", \$2} END{print \"\"}' /proc/meminfo"
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

    [[ "$EMS_DRY_RUN" =~ ^[01]$ ]] || die 'EMS_DRY_RUN 必须为 0 或 1'

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
if len(keys) > 1:
    print("MULTI\t" + ",".join(sorted(keys)))
    raise SystemExit(0)
if not keys:
    print("\t")
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
print(label_key + "\t" + instance)
PY
)" || { rm -f "$nodes_tmp" "$pods_tmp" "$helm_tmp"; die '实例推导失败'; }
    rm -f "$nodes_tmp" "$pods_tmp" "$helm_tmp"
    IFS=$'\t' read -r label_key EMS_NAME <<<"$inferred"
    if [[ "$label_key" == MULTI ]]; then
        die "目标节点交叉多个 EMS 实例（$EMS_NAME）：请按实例分批选择目标节点，或人工处理"
    fi
    if [[ -z "$label_key" ]]; then
        log "目标节点不属于任何 EMS 实例（已卸干净或从未安装）：无操作，幂等退出"
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

    # 卸载范围 = label 全部节点（含未勾选的同实例节点）
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
    for pair in "${label_pairs[@]}"; do
        IFS=$'\t' read -r node_name node_ip <<<"$pair"
        node_names+=("$node_name")
        node_ips+=("${node_ip:-}")
        log "卸载节点：$node_name（${node_ip:-无 InternalIP}）"
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

    # ---- [1/4] 卸载 helm release + 资源 ns ----
    log "=== [1/4] 卸载 helm release + 资源 ns ==="
    local release_removed=0 ns_removed=0
    if [[ -n "$rel_ns" ]]; then
        log "helm uninstall $EMS_NAME（release 位于 ns $rel_ns）"
        run helm uninstall "$EMS_NAME" -n "$rel_ns" \
            || die "helm uninstall 失败（详见上方 helm 输出）"
        release_removed=1
    else
        log "helm release $EMS_NAME 不存在（全 ns 扫描），跳过"
    fi
    if kubectl get ns "$EMS_NAME" -o json >/dev/null 2>&1; then
        log "删除资源 ns $EMS_NAME"
        if ! run kubectl delete ns "$EMS_NAME" --wait=true --timeout="${NS_DELETE_TIMEOUT_SECONDS}s"; then
            log "资源 ns 删除超时，强制清理残留 pod"
            run kubectl delete pod -n "$EMS_NAME" --all --grace-period=0 --force >/dev/null 2>&1 || true
            run kubectl delete ns "$EMS_NAME" --wait=true --timeout=60s \
                || die "资源 ns $EMS_NAME 删除失败（Finalizer/kuberay 阻塞），需人工处理"
        fi
        ns_removed=1
    else
        log "资源 ns $EMS_NAME 不存在，跳过"
    fi
    if (( ns_removed )) && [[ "$EMS_DRY_RUN" != 1 ]]; then
        sleep "$RESURRECT_CHECK_SECONDS"
        if kubectl get ns "$EMS_NAME" >/dev/null 2>&1; then
            die "资源 ns $EMS_NAME 删除后死而复生（kuberay/CI 自动重装？）；停手，需人工协调停掉自动部署后重跑"
        fi
        log "资源 ns 已释放且未复活"
    fi

    # ---- [2/4] + [3/4] 大页处理 ----
    local released_ips='' restarted_ips='' hp_total=0 hp_free=0 hp_surp=0
    if [[ "$EMS_DRY_RUN" == 1 ]]; then
        log "=== [2-3/4] DRY_RUN 预演：跳过大页等待与还原 ==="
    else
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
    fi

    # ---- [4/4] 清 label + 终验 ----
    log "=== [4/4] 清理 label + 终验 ==="
    local label_removed='' idx4
    for idx4 in "${!node_names[@]}"; do
        if [[ "$EMS_DRY_RUN" == 1 ]]; then
            log "[DRY_RUN] kubectl label node ${node_names[$idx4]} $label_key-"
        else
            kubectl label node "${node_names[$idx4]}" "$label_key-" >/dev/null \
                || die "节点 ${node_names[$idx4]} 清理 label $label_key 失败"
            log "label 清理：${node_names[$idx4]} $label_key-"
        fi
        label_removed+="${node_names[$idx4]},"
    done

    if [[ "$EMS_DRY_RUN" != 1 ]]; then
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
                (( hp_total == 0 )) || die "终验失败：${node_names[$idx5]} 大页仍为 $hp_total 页"
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

    # ---- 契约输出 ----
    printf '\n--- EMS 卸载契约（KEY=VALUE） ---\n'
    printf 'EMS_NAME=%s\n' "$EMS_NAME"
    printf 'EMS_STATUS=%s\n' "$([[ "$EMS_DRY_RUN" == 1 ]] && echo dryrun || echo uninstalled)"
    printf 'EMS_NODES=%s\n' "$(IFS=,; echo "${node_ips[*]}")"
    printf 'EMS_RELEASE_REMOVED=%s\n' "$release_removed"
    printf 'EMS_NAMESPACE_REMOVED=%s\n' "$ns_removed"
    printf 'EMS_HUGEPAGES_RELEASED=%s\n' "$(echo "$released_ips" | sed 's/,$//')"
    printf 'EMS_KUBELET_RESTARTED=%s\n' "$(echo "$restarted_ips" | sed 's/,$//')"
    printf 'EMS_LABEL_REMOVED=%s\n' "$(echo "$label_removed" | sed 's/,$//')"
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
