#!/usr/bin/env bash
# pipeline: no-positional-args
# EMS（mfv-kv 内存池存储）安装流水线 step 主脚本（shell step，无位置参数调用）。
#
# 用法：在流水线中插入本 step，2 个参数均可选（留空即继承上游变量，
# 通常来自前置 ems-check 门禁的契约输出；独立运行时需显式提供 EMS_NAME）。
# 目标节点 = 平台注入的 TARGET_IPS/TARGET_HOSTS（EMS 集群节点，通常 2 台）。
#
# 编排：ems-check（EMS_NAME 门禁模式：校验名字/label 占用/ns·release 残留/
# 资源余量（CPU/内存/大页）/版本一致，输出 EMS_IDEMPOTENT 判定）→ ems-hugepages（大页配置
# + 刷 allocatable，最耗时环节独立成步便于单独重跑）→ 本 step（纯安装执行）。
#
# 执行位置：工作台服务端（无 kubectl）把本脚本与仓内 scripts/ems-chart/ 打包，
# 推送到首个具备 kubectl+helm 的目标节点远程执行；安装全程只经 kubectl/helm
# 操作集群，**不直接 SSH 目标节点**（大页/kubelet 操作在 ems-hugepages step）。
#
# 跨 region（hd2 等）：平台注入的 TARGET_IPS 可能是外网入口 endpoint（ip:port
# 形态，如 115.33.98.101:2224），与集群 InternalIP 对不上；分发阶段逐节点 SSH
# 采集内网身份（hostname/-I）构建映射随小写 env 下传，目标解析按「直接命中 →
# endpoint 映射 → 剥端口」三级（label 打在解析出的集群节点名上）。gy1 内网
# 标识行为不变。
#
# 流程（fail-fast；门禁与大页已上移前置 step，本 step 只留最小防线）：
#   P0 前置防线：同名 ns/release 已存在且无门禁幂等判定（EMS_IDEMPOTENT≠1）
#      → 拒绝盲装；门禁判定幂等 → 跳过安装仅验证
#   S1 释放节点：仅删除 EMS_RELEASE_NAMESPACES 显式列出的 ns，删后复查不复活
#      （kuberay/CI 自动重装 → 失败并提示人工协调）
#   S2 安装：打 label + helm install（版本 = 仓内 ems-chart/，单独维护）
#   S3 验证：全部 pod Running&Ready + 每节点大页已分配达标（大页未配够/allocatable
#      未刷 → 失败并指向 ems-hugepages step）+ 契约输出
#
# chart 版本维护：安装版本由与本脚本同目录的 scripts/ems-chart/ 整体决定
#（Chart.yaml 与 values 镜像 tag 绑定）；⚠️ 该目录不入 git（含厂商证书私钥/
# 密码，见仓根 .gitignore），随部署环境分发（如平台机 scripts 目录）；升级 =
# 在各环境替换该目录，再走独立的卸载/升级流程。同名 release 已存在且 chart
# 版本与本地目录不一致时由前置门禁拦截，本 step 不自动升级/重装。
#
# 退出码：0 安装成功（或幂等重入）；1 检查失败/环境错误（判本 step 失败）。
# 单测：test/test_ems_deploy.sh（mock kubectl/helm/ssh，覆盖安装/占用/释放/幂等）。
set -uo pipefail

SCRIPT_NAME='ems-deploy'

# ---- step 参数声明（平台「识别参数」按声明与紧邻注释扫描）----
# EMS_NAME = EMS 实例名（=资源 ns=release 名，如 ems13-13）；label key 与 release 存放 ns 取首段（ems13）。
#            留空 = 继承上游变量（编排：前置 ems-check 门禁输出）；独立运行时需显式指定，
#            运行时为空会在前置检查报错并提示（不设必填校验，便于保存阶段留空继承）
EMS_NAME="${EMS_NAME:-}"
# HUGEPAGE_GIB 已收紧为内部常量（固定 2000Gi，与仓内 chart values 同值；1000Gi 规格已废弃，不再作为入参）
# EMS_RELEASE_NAMESPACES = 预授权释放（删除）的命名空间，逗号分隔；留空 = 目标节点存在业务 pod 时直接失败
EMS_RELEASE_NAMESPACES="${EMS_RELEASE_NAMESPACES:-}"

# 平台注入变量经 nameref 间接引用，避免被「识别参数」扫出入参（零冗余参数设计）。
declare -n platform_target_hosts='TARGET_HOSTS'
declare -n platform_target_ips='TARGET_IPS'
# EMS_IDEMPOTENT：前置 ems-check 门禁的单向契约（健康同名安装=1，deploy 据此幂等重入）；
# nameref 间接引用不进「识别参数」
declare -n platform_ems_idempotent='EMS_IDEMPOTENT'

# 内部常量（普通赋值，不进参数面）；大页固定 2000Gi（配置在 ems-hugepages step，
# 本 step 仅在验证阶段比对每节点已分配量）
HUGEPAGE_GIB=2000
RELEASE_TIMEOUT_SECONDS=180
RESURRECT_CHECK_SECONDS=10
VERIFY_TIMEOUT_SECONDS=900
VERIFY_POLL_SECONDS=10

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
    local self bundle_dir tarball probe_user probe_host probe_port probe_pass='' spec quoted
    local -a specs=() remote_env=()

    have ssh || die '远程执行需要 ssh（执行机未安装）'
    have python3 || die '远程分发需要 python3'
    have tar || die '远程分发需要 tar'

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
    ((${#specs[@]} >= 2)) || die 'EMS 安装至少需要 2 个目标节点（TARGET_HOSTS）'


    self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
    bundle_dir="$(cd "$(dirname "$self")" && pwd)"
    [[ -d "$bundle_dir/ems-chart" ]] || die "未找到仓内 chart：$bundle_dir/ems-chart（ems-deploy 须与 ems-chart/ 同目录分发）"

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
    [[ -n "$probe_host" ]] || die '所有 TARGET_HOSTS 节点都缺少 kubectl/helm；无法执行安装'

    # 跨 region 目标身份映射（hd2 等环境平台注入的 TARGET_IPS 是外网入口 endpoint，
    # 与集群 InternalIP 对不上）：逐节点 SSH 采集内网身份（hostname/-I），映射表
    # 经小写 env 下传供远程侧目标解析（三级：直接命中 → endpoint 映射 → 剥端口）；
    # 采集失败则空表，gy1 内网行为不变。specs 为 JSON 数组，先展开为 tab 四元组。
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

    tarball="/tmp/ems-deploy-bundle-$$.tgz"
    tar -C "$bundle_dir" -czf "$tarball" "$(basename "$self")" ems-chart \
        || die '打包脚本与 chart 失败'
    remote_exec "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "rm -rf /tmp/ems-deploy-bundle && mkdir -p /tmp/ems-deploy-bundle && cat > /tmp/ems-deploy-bundle.tgz" <"$tarball" \
        || die "推送安装包到 $probe_host 失败"
    rm -f "$tarball"

    log "remote execution via $probe_user@$probe_host:$probe_port（kubectl 视图为集群级）"
    remote_env=(TARGET_HOSTS=)
    for var in EMS_NAME EMS_RELEASE_NAMESPACES TARGET_IPS EMS_IDEMPOTENT; do
        printf -v quoted '%q' "${!var:-}"
        remote_env+=("$var=$quoted")
    done
    printf -v quoted '%q' "$id_map"
    remote_env+=("ems_target_id_map=$quoted")
    remote_exec "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "tar -C /tmp/ems-deploy-bundle -xzf /tmp/ems-deploy-bundle.tgz && env ${remote_env[*]} bash /tmp/ems-deploy-bundle/$(basename "$self")"
    return $?
}

# ==================== 远程阶段（首个有 kubectl+helm 的目标节点） ====================

install_main() {
    local label_ns label_key chart_dir chart_version
    local -a target_ips=() target_nodes=()

    [[ -n "$EMS_NAME" ]] || die "EMS_NAME 为空：请在 step 参数显式填写，或经前置 ems-check 门禁契约注入（上游变量 EMS_NAME）"
    [[ "$EMS_NAME" =~ ^ems[0-9]+(-[0-9]+)?$ ]] || die "EMS_NAME 格式应为 ems<N>-<M>，如 ems13-13（当前：$EMS_NAME）"
    label_key="${EMS_NAME%%-*}"
    label_ns="$label_key"

    chart_dir="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/ems-chart" 2>/dev/null && pwd)" \
        || die '未找到 ems-chart 目录'
    chart_version="$(sed -n 's/^version:[[:space:]]*//p' "$chart_dir/Chart.yaml" | head -1 | tr -d '"')"
    [[ -n "$chart_version" ]] || die "无法读取 chart 版本：$chart_dir/Chart.yaml"
    chart_name="$(sed -n 's/^name:[[:space:]]*//p' "$chart_dir/Chart.yaml" | head -1 | tr -d '"')"
    [[ -n "$chart_name" ]] || die "无法读取 chart 名：$chart_dir/Chart.yaml"

    # 目标 IP 列表：注入的 TARGET_IPS（JSON 数组）；平台按所选环境注入，缺失即报错
    mapfile -t target_ips < <(python3 - "${platform_target_ips:-}" <<'PY'
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
PY
)
    ((${#target_ips[@]} >= 2)) || die 'EMS 安装至少需要 2 个目标节点（TARGET_IPS/TARGET_HOSTS）'

    # ---- 解析目标节点名 ----
    log "=== [0/3] 解析目标节点（chart $chart_version） ==="
    local node_json ip
    node_json="$(kubectl get nodes -o json)" || die '获取节点列表失败'
    for ip in "${target_ips[@]}"; do
        # 三级解析：①直接命中（内网 IP/节点名，gy1 现行为）②endpoint 身份映射
        #（跨 region：外网入口 ip:port → 该主机内网 ips/hostname）③ip:port 剥端口。
        # 本 step 不 SSH 目标节点（大页/kubelet 在 ems-hugepages step），只需节点名。
        local name via_map
        name="$(printf '%s' "$node_json" | EMS_TARGET_ID_MAP="${ems_target_id_map:-}" python3 -c '
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
via = "direct"
if node is None:
    for entry in id_map:
        if wanted in (entry.get("endpoint"), entry.get("address")):
            for ident in list(entry.get("ips") or []) + [entry.get("hostname") or ""]:
                node = find(ident)
                if node is not None:
                    break
            if node is not None:
                via = "endpoint"
                break
if node is None and ":" in wanted:
    node = find(wanted.rsplit(":", 1)[0])
if node is None:
    raise SystemExit(0)
print(node["metadata"]["name"] + "\t" + via)
' "$ip")"
        [[ -n "$name" ]] || die "目标 $ip 不是本集群节点（跨 region endpoint 需经 TARGET_HOSTS 分发采集身份映射）"
        IFS=$'\t' read -r name via_map <<<"$name"
        target_nodes+=("$name")
        if [[ "$via_map" == endpoint ]]; then
            log "目标节点：$ip → $name（endpoint 解析）"
        else
            log "目标节点：$ip → $name"
        fi
    done

    # ---- 前置检查（最小防线；完整门禁在前置 ems-check 的 EMS_NAME 模式）----
    # 门禁已校验：名字格式/label 占用/ns·release 残留/版本一致/资源余量，并给出
    # EMS_IDEMPOTENT 判定（健康同名安装 = 1，deploy 跳过安装仅验证）。此处仅拦截
    # 未经门禁的重入（同名 ns/release 已存在却无幂等判定），防误装/盲装。
    log "=== [1/3] 前置检查（门禁契约 EMS_IDEMPOTENT=${platform_ems_idempotent:-0}） ==="
    local release_exists=0
    helm list -A -o json 2>/dev/null | python3 -c '
import json, sys
for rel in json.load(sys.stdin):
    if rel.get("name") == sys.argv[1]:
        raise SystemExit(0)
raise SystemExit(1)' "$EMS_NAME" && release_exists=1
    local ns_exists=0
    kubectl get ns "$EMS_NAME" -o json >/dev/null 2>&1 && ns_exists=1
    local idempotent=0
    if (( ns_exists || release_exists )); then
        if [[ "${platform_ems_idempotent:-0}" != 1 ]]; then
            die "已存在同名安装（ns=$ns_exists release=$release_exists）且未获门禁幂等判定：请在流水线前置 ems-check（EMS_NAME 门禁模式）重跑，或人工处理残留"
        fi
        idempotent=1
        log "门禁已判定幂等重入：跳过安装，仅验证"
    else
        log "名字可用（ns 与 release 均不存在）"
    fi

    if (( ! idempotent )); then
        # ---- S1 释放节点 ----
        local -a authorized=()
        local ns_item
        [[ -n "$EMS_RELEASE_NAMESPACES" ]] && IFS=',' read -ra authorized <<<"$EMS_RELEASE_NAMESPACES"
        if [[ -n "$EMS_RELEASE_NAMESPACES" ]]; then
            log "=== [2/3] 释放节点（已预授权：$EMS_RELEASE_NAMESPACES） ==="
            local del_ns
            for del_ns in "${authorized[@]}"; do
                [[ -n "$del_ns" ]] || continue
                log "删除命名空间 $del_ns（含 pod：$(kubectl get pods -n "$del_ns" --no-headers 2>/dev/null | awk '{printf "%s ", $1}')）"
                if ! kubectl delete ns "$del_ns" --wait=true --timeout="${RELEASE_TIMEOUT_SECONDS}s" >/dev/null 2>&1; then
                    log "命名空间 $del_ns 删除超时，强制清理残留 pod"
                    kubectl delete pod -n "$del_ns" --all --grace-period=0 --force >/dev/null 2>&1 || true
                    kubectl delete ns "$del_ns" --wait=true --timeout=60s >/dev/null 2>&1 \
                        || die "命名空间 $del_ns 删除失败（可能有 kuberay/Finalizer 阻塞），需人工处理"
                fi
                sleep "$RESURRECT_CHECK_SECONDS"
                if kubectl get ns "$del_ns" >/dev/null 2>&1 \
                    || [[ -n "$(kubectl get pods -A -o json | python3 -c '
import json, sys
wanted = sys.argv[1]
found = [p["metadata"]["name"] for p in json.load(sys.stdin).get("items", [])
         if p.get("metadata", {}).get("namespace") == wanted]
print("\n".join(found[:5]))
' "$del_ns" 2>/dev/null)" ]]; then
                    die "命名空间 $del_ns 删除后死而复生（kuberay/CI 自动重装？）；停手，需人工协调停掉自动部署后重跑"
                fi
                log "命名空间 $del_ns 已释放且未复活"
            done
        else
            log "=== [2/3] 释放节点（未配置 EMS_RELEASE_NAMESPACES，跳过） ==="
        fi

        # ---- S2 安装 ----
        log "=== [3/3] 打 label + helm install ==="
        local lbl_node
        for lbl_node in "${target_nodes[@]}"; do
            kubectl label node "$lbl_node" "$label_key=true" --overwrite >/dev/null \
                || die "节点 $lbl_node 打 label $label_key=true 失败"
            log "label：$lbl_node $label_key=true"
        done
        local -a helm_sets=("nodeSelector.emsCtrl.labelKey=$label_key" "nodeSelector.emsServer.labelKey=$label_key")
        local -a helm_args=()
        local set_item
        for set_item in "${helm_sets[@]}"; do helm_args+=(--set "$set_item"); done
        log "helm install $EMS_NAME（ns $label_ns，chart ems-$chart_version，set：${helm_sets[*]}）"
        helm install "$EMS_NAME" "$chart_dir" -n "$label_ns" --create-namespace "${helm_args[@]}" \
            || die "helm install 失败（详见上方 helm 输出）"
    fi

    # ---- S3 验证 ----
    log "=== 验证（pod 全 Running&Ready + 每节点大页分配达标，最长 ${VERIFY_TIMEOUT_SECONDS}s） ==="
    local vwaited=0 pod_summary='' hp_ok=0
    while (( vwaited < VERIFY_TIMEOUT_SECONDS )); do
        sleep "$VERIFY_POLL_SECONDS"
        vwaited=$((vwaited + VERIFY_POLL_SECONDS))
        pod_summary="$(kubectl get pods -n "$EMS_NAME" -o json | python3 -c '
import json, sys
pods = json.load(sys.stdin).get("items", [])
if not pods:
    print("0/0"); raise SystemExit
ready = 0
for pod in pods:
    phase = (pod.get("status") or {}).get("phase")
    ok = any(c.get("type") == "Ready" and c.get("status") == "True"
             for c in (pod.get("status") or {}).get("conditions") or [])
    ready += 1 if (phase == "Running" and ok) else 0
print(f"{ready}/{len(pods)}")
')"
        [[ "$pod_summary" == */* ]] || pod_summary='0/0'
        log "pod 状态：$pod_summary"
        local ready_count total_count
        ready_count="${pod_summary%%/*}"
        total_count="${pod_summary##*/}"
        (( total_count >= 6 && ready_count == total_count )) && { hp_ok=1; break; }
    done
    ((hp_ok)) || die "pod 未在 ${VERIFY_TIMEOUT_SECONDS}s 内全部就绪（最后状态 $pod_summary；zk 抖动通常自愈，持续异常请看 describe）"

    # 同 G2：全量 pod JSON 走临时文件（管道 + heredoc 的 python3 - 互斥，argv 有 128KiB 上限）
    local pods_json
    pods_json="$(mktemp /tmp/ems-deploy-pods.XXXXXX)"
    kubectl get pods -A -o json >"$pods_json" \
        || { rm -f "$pods_json"; die '获取全量 pod 列表失败'; }
    python3 - "$EMS_NAME" "$HUGEPAGE_GIB" "$pods_json" "${target_nodes[@]}" <<'PY' || { rm -f "$pods_json"; die '大页分配校验未达标（大页配置与 allocatable 刷新在 ems-hugepages step；未配够请先跑该 step 再重试）'; }
import json
import sys

ems_name, target_gib, path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
targets = set(sys.argv[4:])
alloc = {}
for pod in json.load(open(path)).get("items", []):
    node = (pod.get("spec") or {}).get("nodeName")
    if node not in targets:
        continue
    total = 0
    for container in (pod.get("spec") or {}).get("containers", []):
        text = ((container.get("resources") or {}).get("requests") or {}).get("hugepages-2Mi")
        if not text:
            continue
        units = {"Ki": 2**10, "Mi": 2**20, "Gi": 2**30, "Ti": 2**40}
        value = 0
        for suffix, factor in sorted(units.items(), key=lambda i: -len(i[0])):
            if text.endswith(suffix):
                try: value = float(text[:-len(suffix)]) * factor; break
                except ValueError: pass
        try: value = value or float(text)
        except ValueError: pass
        total += value
    alloc[node] = alloc.get(node, 0) + total
bad = [f"{node}={int(gib // 2**30)}Gi" for node, gib in sorted(alloc.items()) if gib < target_gib * 2**30]
if bad:
    print("大页已分配不足: " + ", ".join(bad), file=sys.stderr)
    sys.exit(1)
print("[ems-deploy] 大页分配达标：" + ", ".join(f"{node}={int(g // 2**30)}Gi" for node, g in sorted(alloc.items())))
PY
    rm -f "$pods_json"

    # ---- 契约输出 ----
    printf '\n--- EMS 安装契约（KEY=VALUE） ---\n'
    printf 'EMS_NAME=%s\n' "$EMS_NAME"
    printf 'EMS_NAMESPACE=%s\n' "$EMS_NAME"
    printf 'EMS_LABEL_KEY=%s\n' "$label_key"
    printf 'EMS_NODES=%s\n' "$(IFS=,; echo "${target_ips[*]}")"
    printf 'EMS_CHART_VERSION=%s\n' "$(helm list -A -o json 2>/dev/null | python3 -c '
import json, sys
for rel in json.load(sys.stdin):
    if rel.get("name") == sys.argv[1]:
        chart = rel.get("chart", "")
        prefix = sys.argv[2] + "-"
        print(chart[len(prefix):] if chart.startswith(prefix) else chart)
        break
' "$EMS_NAME" "$chart_name")"
    printf 'EMS_POD_HEALTH=%s\n' "$pod_summary"
    printf 'EMS_STATUS=installed\n'
}

main() {
    [[ $# -eq 0 ]] || die '不支持命令行参数；请使用环境变量配置'
    if [[ -n "${platform_target_hosts:-}" ]]; then
        dispatch_to_target
        return $?
    fi
    have kubectl || die '本机缺少 kubectl（正常应经 TARGET_HOSTS 分发到目标节点执行）'
    have helm || die '本机缺少 helm'
    have python3 || die '需要 python3'
    kubectl version --request-timeout=5s >/dev/null 2>&1 || die 'kubectl 无法访问 Kubernetes API'
    install_main
}

main "$@"
