#!/usr/bin/env bash
# pipeline: no-positional-args
# EMS 实例巡检流水线 step 主脚本（shell step，无参调用）。
#
# 用法：在流水线中任意位置插入本 step；纯巡检无需任何参数。目标节点由
# 平台注入的 TARGET_IP / TARGET_IPS 提供；平台注入 TARGET_HOSTS 时本脚本自动
# 推送自身到首个具备 kubectl 的目标节点上远程执行（工作台服务端所在主机
# 不需要 kubectl；kubectl 视图是集群级的，任一节点结果一致），目标节点恰为
# 执行节点时额外附本机视角（/proc/meminfo、/dev/shm/ems）。未注入
# TARGET_HOSTS 时在执行机本地运行（手工独立运行场景，需本机有 kubectl）。
# 跨 region（hd2 等）：平台注入的 TARGET_IP/TARGET_IPS 可能是外网入口
# endpoint（ip:port 形态，如 115.33.98.101:2224），与集群 InternalIP 对不上；
# 分发阶段会逐节点 SSH 采集内网身份（hostname/hostname -I）构建映射表随
# 小写 env 下传，目标定位按「直接命中（内网 IP/节点名）→ endpoint 映射 →
# 剥端口兜底」三级解析（gy1 内网标识行为不变）。
# 本 step 全程只读；填写 EMS_NAME 即启用「安装前门禁」（编排上应置于 ems-deploy
# 之前）：校验名字/label/ns·release/节点占用，任一不过即 exit 1 拦住下游；
# 通过则输出 EMS_NAME/EMS_LABEL_KEY/EMS_NODES/EMS_IDEMPOTENT 供 deploy 继承。
# 本 step 全程只读，输出精简版（团队设备口径）：
#   ① 集群巡检：团队设备上的健康实例为主体（实例名·chart 版本·运行时长，
#      团队节点与大页已分配，各两行；非团队节点仅计数）；异常实例一行标注；
#      非团队设备上的实例与空壳/遗留仅一行汇总；
#   ② 目标节点定位：逐个检查 TARGET_IP/TARGET_IPS 归属，命中实例则输出实例简报
#      （版本/运行时长/节点数；非团队设备节点带标注）；
#   ③ 安装前门禁（EMS_NAME 填写时）：名字格式/label 占用/ns·release 残留/
#      资源余量（CPU/内存，调度器 requests 口径；大页由 ems-hugepages step 负责，
#      不关心节点上跑着什么业务），不过即拦；
#   ④ 契约输出：stdout KEY=VALUE（EMS_*），实例计数与首个命中目标的信息
#      注入下游 step 环境；门禁模式下额外输出门禁契约。
# 实例识别约定（同 ems-deploy skill）：release 名 = 资源 ns = ems<N>-<M>，
# label key = ems<N>（值 true）；EMS pod = 容器名含 ems 或挂载含 ems 的路径。
# 依赖：执行机需要 ssh/scp（+python3 解析 TARGET_HOSTS，密码认证还需
# sshpass）；实际巡检节点需要 kubectl（可访问集群）、python3，helm 可选
# （缺失时版本信息降级为未知）。
# 退出码：0 正常；1 环境错误（判本 step 失败）。
# 单测：test/test_ems_check.sh。
set -uo pipefail

SCRIPT_NAME='ems-check'

# ---- step 参数声明（可选；均留空 = 纯巡检，参数面不变零必填）----
# EMS_NAME = 安装前门禁：预安装实例名（ems<N>-<M>）。填写即启用门禁（校验名字/label/ns·release/
#            节点占用，任一不过本 step 失败拦住下游 ems-deploy）；成功时输出 EMS_IDEMPOTENT 等
#            契约供 deploy 继承。编排：ems-check(门禁) → ems-deploy
EMS_NAME="${EMS_NAME:-}"
# EMS_RELEASE_NAMESPACES = 释放预授权（逗号分隔 ns）：门禁不再判业务占用（改查资源余量），
#            此参数仅原样透传下游（ems-deploy S1 据此删除）；纯巡检模式忽略
EMS_RELEASE_NAMESPACES="${EMS_RELEASE_NAMESPACES:-}"

# 平台注入变量经 nameref 间接引用，避免被「识别参数」扫出入参：
# TARGET_HOSTS（目标节点凭据）；EMS_IDEMPOTENT 仅为门禁→deploy 的单向契约入口，不进参数面
declare -n platform_target_hosts='TARGET_HOSTS'

# 团队设备清单（tokens-devices skill 为准，设备增减时同步更新）：仅这些设备的
# 实例/节点进入巡检主体输出；其余设备团队只有只读权限，输出一行汇总不展开。
# 小写 ems_team_nodes 可覆盖（测试/临时调整用，不进参数面）。
TEAM_NODES_DEFAULT='192.168.0.243,192.168.0.128,192.168.0.215,192.168.0.55,192.168.0.126,192.168.0.237,192.168.31.140,192.168.31.120,192.168.31.113,192.168.31.164,192.168.31.7'
team_nodes="${ems_team_nodes:-$TEAM_NODES_DEFAULT}"

die() { echo "[$SCRIPT_NAME] ERROR: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- 远程分发（TARGET_HOSTS 注入时：推送到首个具备 kubectl 的目标节点执行）----
remote_run() { # <user> <host> <port> <pass> <command>
    local user=$1 host=$2 port=$3 pass=$4 command=$5 ssh_base
    ssh_base='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15'
    if [[ -n "$pass" ]]; then
        have sshpass || die '目标节点配置了密码但执行机未安装 sshpass'
        SSHPASS="$pass" sshpass -e ssh $ssh_base -p "$port" "$user@$host" "$command"
    else
        ssh $ssh_base -p "$port" "$user@$host" "$command"
    fi
}

remote_scp() { # <user> <host> <port> <pass> <source> <destination>
    local user=$1 host=$2 port=$3 pass=$4 source=$5 destination=$6 ssh_base
    ssh_base='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR'
    if [[ -n "$pass" ]]; then
        have sshpass || die '目标节点配置了密码但执行机未安装 sshpass'
        SSHPASS="$pass" sshpass -e scp -P "$port" $ssh_base -q "$source" "$user@$host:$destination"
    else
        scp -P "$port" $ssh_base -q "$source" "$user@$host:$destination"
    fi
}

dispatch_to_target() {
    local self spec probe_user probe_host probe_port probe_pass='' quoted
    local -a specs=() remote_env=()

    have ssh || die '远程执行需要 ssh（执行机未安装）'
    have python3 || die '远程分发需要 python3（解析 TARGET_HOSTS）'

    local raw
    raw="$(python3 - "${platform_target_hosts:-}" <<'PY'
import json
import re
import sys

try:
    hosts = json.loads(sys.argv[1])
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
    print(f'{host.get("user") or "root"}\t{address}\t{port}\t{password}')
PY
)" || die '解析 TARGET_HOSTS 失败'
    mapfile -t specs <<<"$raw"

    self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
    for spec in "${specs[@]}"; do
        IFS=$'\t' read -r probe_user probe_host probe_port probe_pass <<<"$spec"
        if remote_run "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
            'command -v kubectl >/dev/null 2>&1'; then
            break
        fi
        echo "[$SCRIPT_NAME] $probe_host 缺少 kubectl，尝试下一个目标节点"
        probe_host=''
    done
    [[ -n "$probe_host" ]] || die '所有 TARGET_HOSTS 节点都缺少 kubectl；本 step 需要在有 kubectl 的节点上执行'

    # 跨 region 目标身份映射：hd2 等环境平台注入的 TARGET_IPS 是外网入口
    # endpoint（ip:port，如 115.33.98.101:2224），与集群 InternalIP 对不上。
    # 逐节点 SSH 采集内网身份（hostname / hostname -I），映射表经小写 env
    # 下传远程侧供目标解析回退（采集失败或不适用时表为空，行为不变）。
    local id_lines='' id_user id_host id_port id_pass id_out id_hostname id_ips
    for spec in "${specs[@]}"; do
        IFS=$'\t' read -r id_user id_host id_port id_pass <<<"$spec"
        id_out="$(remote_run "$id_user" "$id_host" "$id_port" "$id_pass" \
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

    # 门禁期望版本：执行机读仓内 ems-chart/Chart.yaml（远程侧无仓，经小写 env 转发；
    # 缺失 = 门禁跳过 chart 版本比对，仅报告）
    local expected_chart='' chart_yaml
    if [[ -n "${EMS_NAME:-}" ]]; then
        chart_yaml="$(dirname "$self")/ems-chart/Chart.yaml"
        if [[ -f "$chart_yaml" ]]; then
            expected_chart="$(sed -n 's/^version:[[:space:]]*//p' "$chart_yaml" | head -1 | tr -d '"')"
        fi
        [[ -n "$expected_chart" ]] || echo "[$SCRIPT_NAME] WARN: 未找到 $chart_yaml，门禁跳过 chart 版本比对"
    fi

    echo "[$SCRIPT_NAME] remote execution via $probe_user@$probe_host:$probe_port（kubectl 视图为集群级，任一节点一致）"
    remote_scp "$probe_user" "$probe_host" "$probe_port" "$probe_pass" "$self" /tmp/ems-check.sh \
        || die "推送脚本到 $probe_host 失败"

    remote_env=(TARGET_HOSTS=)
    for var in TARGET_IP TARGET_IPS EMS_NAME EMS_RELEASE_NAMESPACES; do
        printf -v quoted '%q' "${!var:-}"
        remote_env+=("$var=$quoted")
    done
    printf -v quoted '%q' "$expected_chart"
    remote_env+=("ems_chart_expected=$quoted")
    printf -v quoted '%q' "$id_map"
    remote_env+=("ems_target_id_map=$quoted")
    remote_run "$probe_user" "$probe_host" "$probe_port" "$probe_pass" \
        "env ${remote_env[*]} bash /tmp/ems-check.sh"
}

main() {
    [[ $# -eq 0 ]] || die '不支持命令行参数；请使用环境变量配置'
    if [[ -n "${platform_target_hosts:-}" ]]; then
        dispatch_to_target
        return
    fi
    have kubectl || die '本机缺少 kubectl；本 step 通过 TARGET_HOSTS 自动分发到有 kubectl 的目标节点执行，手工运行请在有 kubectl 的主机上执行'
    have python3 || die '需要 python3'
    kubectl version --request-timeout=5s >/dev/null 2>&1 || die 'kubectl 无法访问 Kubernetes API'

    workdir="$(mktemp -d)"
    trap 'rm -rf "$workdir"' EXIT

    echo "[$SCRIPT_NAME] collecting cluster state (nodes/pods/namespaces/helm)"
    kubectl get nodes --request-timeout=60s -o json >"$workdir/nodes.json" \
        || die '获取节点列表失败'
    kubectl get pods -A --request-timeout=120s -o json >"$workdir/pods.json" \
        || die '获取 pod 列表失败'
    kubectl get namespaces --request-timeout=30s -o json >"$workdir/namespaces.json" \
        || die '获取命名空间列表失败'
    if have helm; then
        helm list -A -o json >"$workdir/helm.json" 2>/dev/null || echo '[]' >"$workdir/helm.json"
    else
        echo '[]' >"$workdir/helm.json"
    fi

    # 本机标识始终采集：目标节点恰为执行节点时用于补充本机视角（/proc/meminfo、
    # /dev/shm/ems）；未注入 TARGET_* 时兼作回退识别。
    local identifiers
    identifiers="$(hostname -I 2>/dev/null || true) $(hostname 2>/dev/null || true)"

    local rc=0
    EMS_CHECK_LOCAL_IDENTIFIERS="$identifiers" \
    EMS_CHECK_TEAM_NODES="$team_nodes" \
    python3 - "$workdir/nodes.json" "$workdir/pods.json" "$workdir/namespaces.json" "$workdir/helm.json" <<'PY' || rc=$?
import json
import os
import re
import sys
from datetime import datetime, timezone

LOCAL_IDS = [token for token in os.environ.get('EMS_CHECK_LOCAL_IDENTIFIERS', '').split() if token]
TARGET_IPS_RAW = os.environ.get('TARGET_IPS', '').strip()
TARGET_IP_RAW = os.environ.get('TARGET_IP', '').strip()
TEAM_NODES = {token.strip() for token in os.environ.get('EMS_CHECK_TEAM_NODES', '').split(',') if token.strip()}


def load_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)
    except Exception:
        if default is not None:
            return default
        raise


def fail(message):
    print(f'[ems-check] ERROR: {message}', file=sys.stderr)
    sys.exit(1)


try:
    nodes = load_json(sys.argv[1])['items']
    pods = load_json(sys.argv[2])['items']
    namespaces = [item['metadata']['name'] for item in load_json(sys.argv[3])['items']]
    releases = load_json(sys.argv[4], default=[])
except Exception as error:
    fail(f'解析 kubectl/helm 输出失败: {error}')
if not isinstance(releases, list):
    releases = []

# 目标列表：平台注入的 TARGET_IPS（JSON 数组）优先，其次 TARGET_IP；
# 均未注入时回退本机识别（手工独立运行）。
if TARGET_IPS_RAW:
    try:
        targets = [str(item) for item in json.loads(TARGET_IPS_RAW)]
    except (ValueError, TypeError):
        targets = [item.strip() for item in TARGET_IPS_RAW.split(',') if item.strip()]
elif TARGET_IP_RAW:
    targets = [TARGET_IP_RAW]
else:
    targets = None

# 跨 region 目标身份映射（分发阶段逐节点 SSH 采集，见 dispatch_to_target）：
# 外网入口 endpoint（ip:port）→ 该主机内网身份（ips/hostname）。缺省/解析失败为空表。
TARGET_ID_MAP = []
_raw_map = os.environ.get('ems_target_id_map', '').strip()
if _raw_map:
    try:
        _parsed = json.loads(_raw_map)
        if isinstance(_parsed, list):
            TARGET_ID_MAP = [entry for entry in _parsed if isinstance(entry, dict)]
    except ValueError:
        pass

UNITS = {'Ki': 2 ** 10, 'Mi': 2 ** 20, 'Gi': 2 ** 30, 'Ti': 2 ** 40, 'Pi': 2 ** 50,
         'k': 10 ** 3, 'K': 10 ** 3, 'M': 10 ** 6, 'G': 10 ** 9, 'T': 10 ** 12, 'm': 10 ** -3}


def parse_qty(value):
    if value is None:
        return None
    text = str(value).strip()
    for suffix, factor in sorted(UNITS.items(), key=lambda item: -len(item[0])):
        if text.endswith(suffix):
            try:
                return float(text[:-len(suffix)]) * factor
            except ValueError:
                break
    try:
        return float(text)
    except ValueError:
        return None


def fmt_gib(value):
    if value is None:
        return '?'
    gib = value / 2 ** 30
    if abs(gib - round(gib)) < 0.05:
        return f'{round(gib)}Gi'
    return f'{gib:.1f}Gi'


LABEL_RE = re.compile(r'^ems\d')
INSTANCE_NS_RE = re.compile(r'^ems\d')


def node_label_keys(node):
    labels = (node.get('metadata') or {}).get('labels') or {}
    return sorted(key for key, value in labels.items() if LABEL_RE.match(key) and str(value).lower() == 'true')


def node_ips(node):
    return [addr.get('address') for addr in (node.get('status') or {}).get('addresses', []) or []
            if addr.get('type') == 'InternalIP']


def pod_containers(pod):
    spec = pod.get('spec') or {}
    return list(spec.get('containers') or []) + list(spec.get('initContainers') or [])


def components_of(pod):
    blob = ' '.join([str(pod.get('metadata', {}).get('name', ''))] +
                    [str(container.get('name', '')) for container in pod_containers(pod)]).lower()
    found = []
    if 'controller' in blob:
        found.append('controller')
    if 'zookeeper' in blob or '-zk' in blob:
        found.append('zookeeper')
    if 'server' in blob:
        found.append('server')
    if 'init' in blob:
        found.append('init')
    return found or ['other']


def pod_phase(pod):
    return (pod.get('status') or {}).get('phase') or 'Unknown'


def pod_ready(pod):
    for condition in (pod.get('status') or {}).get('conditions') or []:
        if condition.get('type') == 'Ready':
            return str(condition.get('status')) == 'True'
    return False


def pod_problem(pod):
    if pod_phase(pod) == 'Running' and pod_ready(pod):
        return ''
    for cs in (pod.get('status') or {}).get('containerStatuses') or []:
        waiting = (cs.get('state') or {}).get('waiting') or {}
        if waiting.get('reason'):
            message = waiting.get('message') or ''
            return f"{waiting['reason']}" + (f' ({message})' if message else '')
    return pod_phase(pod)


def pod_images(pod):
    status = pod.get('status') or {}
    images = [cs.get('image') for cs in (status.get('containerStatuses') or []) if cs.get('image')]
    if not images:
        images = [container.get('image') for container in pod_containers(pod) if container.get('image')]
    return sorted({image for image in images if image})


def node_of(pod):
    return (pod.get('spec') or {}).get('nodeName')


def chart_split(chart):
    match = re.match(r'^(.+)-(\d+\.\d+.*)$', chart or '')
    if match:
        return match.group(1), match.group(2)
    return chart or '?', ''


def pod_start_ts(pod):
    text = (pod.get('status') or {}).get('startTime')
    if not text:
        return None
    try:
        return datetime.fromisoformat(str(text).replace('Z', '+00:00'))
    except ValueError:
        return None


def fmt_duration(delta):
    total = int(delta.total_seconds())
    if total < 0:
        return '?'
    days, rem = divmod(total, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    if days:
        return f'{days}d{hours}h'
    if hours:
        return f'{hours}h{minutes:02d}m'
    return f'{minutes}m'


NOW = datetime.now(timezone.utc)


def node_display(node_name):
    """节点展示标识：优先 InternalIP，缺失退节点名（gy1 节点名即 IP）。"""
    node = node_by_key.get(node_name)
    ips = node_ips(node) if node else []
    return ips[0] if ips else node_name


def is_team_node(node_name):
    """团队设备判定：节点 InternalIP 或节点名在清单内（gy1 节点名即 IP）。"""
    if node_name in TEAM_NODES:
        return True
    node = node_by_key.get(node_name)
    return any(ip in TEAM_NODES for ip in node_ips(node)) if node else False


def instance_is_team(instance):
    """实例旧属团队：任一 pod 实际落点（或 label 节点，全 Pending 时）为团队设备；
    无任何落点的实例保守视为团队（Pending 不应导致不可见）。"""
    scope = instance['pod_nodes'] or instance['all_nodes']
    return not scope or any(is_team_node(name) for name in scope)


# ---- 节点索引 -----------------------------------------------------------------
node_by_key = {}
for node in nodes:
    name = node['metadata']['name']
    node_by_key.setdefault(name, node)
    for ip in node_ips(node):
        node_by_key.setdefault(ip, node)
label_to_nodes = {}
for node in nodes:
    for key in node_label_keys(node):
        label_to_nodes.setdefault(key, []).append(node['metadata']['name'])


def resolve_target(target):
    """目标标识 → 集群节点（三级）：①直接命中（内网 IP/节点名，gy1 现行为）；
    ②endpoint 身份映射（外网入口 ip:port → 该主机内网 ips/hostname）；
    ③ip:port 剥端口兜底（内网 IP 带端口的注入形态）。都不中返回 None。"""
    if target in node_by_key:
        return node_by_key[target]
    for entry in TARGET_ID_MAP:
        if target not in (entry.get('endpoint'), entry.get('address')):
            continue
        for ident in list(entry.get('ips') or []) + [entry.get('hostname') or '']:
            if ident and ident in node_by_key:
                return node_by_key[ident]
    if ':' in target:
        address = target.rsplit(':', 1)[0]
        if address in node_by_key:
            return node_by_key[address]
    return None

# ---- 实例构建（资源 ns 维度） --------------------------------------------------
instance_pods = {}
for pod in pods:
    namespace = pod.get('metadata', {}).get('namespace', '')
    if INSTANCE_NS_RE.match(namespace):
        instance_pods.setdefault(namespace, []).append(pod)

release_by_name = {release.get('name'): release for release in releases if release.get('name')}

instances = {}
for namespace, members in sorted(instance_pods.items()):
    label_keys = set()
    pod_nodes = set()
    for pod in members:
        node_name = node_of(pod)
        if node_name and node_name in node_by_key:
            pod_nodes.add(node_name)
            label_keys.update(node_label_keys(node_by_key[node_name]))
    all_nodes = set(pod_nodes)
    for key in label_keys:
        all_nodes.update(label_to_nodes.get(key, []))
    release = release_by_name.get(namespace)
    chart_name, chart_version = chart_split(release.get('chart')) if release else ('', '')
    start_stamps = [ts for ts in (pod_start_ts(pod) for pod in members) if ts]
    instances[namespace] = {
        'name': namespace,
        'label_keys': sorted(label_keys),
        'pod_nodes': sorted(pod_nodes),
        'all_nodes': sorted(all_nodes),
        'pods': members,
        'release': release,
        'chart_version': chart_version,
        'healthy': bool(members) and all(pod_phase(pod) == 'Running' and pod_ready(pod) for pod in members),
        'running_ready': sum(1 for pod in members if pod_phase(pod) == 'Running' and pod_ready(pod)),
        'images': sorted({image for pod in members for image in pod_images(pod)}),
        'uptime': fmt_duration(NOW - min(start_stamps)) if start_stamps else '?',
    }

# 每节点大页已分配（全部 pod 的 hugepages-2Mi requests 汇总）
node_hp_allocated = {}
for pod in pods:
    node_name = node_of(pod)
    if not node_name:
        continue
    total = 0.0
    for container in pod_containers(pod):
        request = parse_qty(((container.get('resources') or {}).get('requests') or {}).get('hugepages-2Mi'))
        if request:
            total += request
    if total:
        node_hp_allocated[node_name] = node_hp_allocated.get(node_name, 0.0) + total


def describe_node_hp(node_name):
    node = node_by_key.get(node_name)
    if not node:
        return f'{node_name}: <不在节点列表>'
    status = node.get('status') or {}
    capacity = parse_qty((status.get('capacity') or {}).get('hugepages-2Mi'))
    allocatable = parse_qty((status.get('allocatable') or {}).get('hugepages-2Mi'))
    allocated = node_hp_allocated.get(node_name)
    percent = f' ({allocated / allocatable * 100:.0f}%)' if allocated is not None and allocatable else ''
    ips = node_ips(node)
    ip_suffix = f' ({ips[0]})' if ips and ips[0] != node_name else ''
    return (f'{node_name}{ip_suffix}: capacity {fmt_gib(capacity)} · allocatable {fmt_gib(allocatable)} · '
            f'已分配 {fmt_gib(allocated)}{percent}')


def format_instance(instance):
    """精简两行：首行实例名·chart 版本·运行时长；次行团队节点与大页已分配
    （非团队节点仅计数不展开）。"""
    head = instance['name']
    if instance['chart_version']:
        head += f" · chart {instance['chart_version']}"
    head += f" · 运行 {instance['uptime']}"
    team_nodes_line = [n for n in instance['all_nodes'] if is_team_node(n)]
    other_count = len(instance['all_nodes']) - len(team_nodes_line)
    if team_nodes_line:
        nodes_part = ' · '.join(
            f"{node_display(n)}（大页已分配 {fmt_gib(node_hp_allocated.get(n))}）"
            for n in team_nodes_line)
    else:
        nodes_part = '（无团队节点）'
    if other_count:
        nodes_part += f'（另含非团队节点 {other_count} 台）'
    return [head, f'    节点: {nodes_part}']


# ---- ① 集群巡检（健康实例为主体，异常/遗留仅一行汇总） --------------------
active_release_ns = {(instance['release'] or {}).get('namespace') for instance in instances.values()}
pods_by_ns = {}
for pod in pods:
    pods_by_ns.setdefault(pod.get('metadata', {}).get('namespace', ''), []).append(pod)
shell_namespaces = sorted(ns for ns in namespaces
                          if re.match(r'^ems', ns) and ns not in pods_by_ns and ns not in active_release_ns)
shell_releases = sorted((release for release in releases
                         if str(release.get('name', '')).startswith('ems')
                         and release.get('name') not in set(instances)),
                        key=lambda release: release.get('name', ''))

healthy = [instance for instance in instances.values() if instance['healthy'] and instance_is_team(instance)]
unhealthy = [instance for instance in instances.values() if not instance['healthy'] and instance_is_team(instance)]
non_team = [instance for instance in instances.values() if not instance_is_team(instance)]
print(f'=== EMS 健康实例（团队设备，{len(healthy)} 个） ===')
if healthy:
    for index, instance in enumerate(healthy, 1):
        head, nodes_line = format_instance(instance)
        print(f'[{index}] {head}')
        print(nodes_line)
else:
    print('（无）')
for instance in unhealthy:
    print(f"[!] {instance['name']} 异常（{instance['running_ready']}/{len(instance['pods'])} Running&Ready）")
if non_team:
    print(f"（另有 {len(non_team)} 个实例在非团队设备上：{','.join(i['name'] for i in non_team)}，略）")
if shell_namespaces or shell_releases:
    extra = []
    if shell_namespaces:
        extra.append(f'空壳 ns {len(shell_namespaces)} 个')
    if shell_releases:
        extra.append(f'孤儿 release {len(shell_releases)} 个')
    print(f"（另有遗留：{' · '.join(extra)}，略）")


# ---- ② 节点定位（TARGET_IP/TARGET_IPS；未注入回退本机） --------------------------
def instances_on(node_name):
    return [instance for instance in instances.values() if node_name in instance['all_nodes']]


def instance_brief(instance):
    parts = []
    if instance['chart_version']:
        parts.append(f"chart {instance['chart_version']}")
    parts.append(f"运行 {instance['uptime']}")
    parts.append(f"节点 {len(instance['all_nodes'])} 台")
    return f"{instance['name']}（{' · '.join(parts)}）"


def target_label(node_name):
    """目标节点展示：非团队设备追加标注（只读权限提醒）。"""
    display = node_display(node_name)
    return display if is_team_node(node_name) else f'{display}（非团队设备）'


first_hit = None
matched_targets = 0

if targets is not None:
    print(f'=== 目标节点（TARGET_IP/TARGET_IPS，共 {len(targets)} 个） ===')
    for target in targets:
        node = resolve_target(target)
        if not node:
            print(f'    {target}: 不是本集群节点')
            continue
        node_name = node['metadata']['name']
        hits = instances_on(node_name)
        if not hits:
            print(f'    {target} → {target_label(node_name)}: 不属于任何 EMS 实例')
            continue
        matched_targets += 1
        if first_hit is None:
            first_hit = hits[0]
        line = f'    {target} → {target_label(node_name)}: 属于 {instance_brief(hits[0])}'
        if len(hits) > 1:
            line += f"（另命中 {','.join(h['name'] for h in hits[1:])}）"
        print(line)
else:
    print('=== 本机识别（未注入 TARGET_IP/TARGET_IPS，回退执行机定位） ===')
    local_node = None
    for candidate in LOCAL_IDS:
        node = node_by_key.get(candidate)
        if node:
            local_node = node
            break
    if local_node:
        node_name = local_node['metadata']['name']
        print(f'执行机 → 集群节点 {target_label(node_name)}')
        hits = instances_on(node_name)
        if hits:
            first_hit = hits[0]
            line = f'    属于 {instance_brief(hits[0])}'
            if len(hits) > 1:
                line += f"（另命中 {','.join(h['name'] for h in hits[1:])}）"
            print(line)
        else:
            print('    不属于任何 EMS 实例')
    else:
        print(f'执行机（{", ".join(LOCAL_IDS) or "?"}）不是本集群节点；实例清单仍有效')

# ---- ③ 安装前门禁（EMS_NAME 填写时；编排位置：ems-deploy 之前）--------------------
GATE_NAME = os.environ.get('EMS_NAME', '').strip()
GATE_RELEASE_PASSTHROUGH = os.environ.get('EMS_RELEASE_NAMESPACES', '').strip()
GATE_EXPECTED = os.environ.get('ems_chart_expected', '').strip()
gate_contract = []
if GATE_NAME:
    print()
    print(f'=== 安装前门禁（预安装 {GATE_NAME}；任一不过即失败拦住下游 ems-deploy） ===')
    if not re.fullmatch(r'ems\d+(-\d+)?', GATE_NAME):
        fail(f'EMS_NAME 格式应为 ems<N>-<M>，如 ems13-13（当前：{GATE_NAME}）')
    label_key = GATE_NAME.split('-')[0]
    if targets is None:
        fail('门禁需要目标节点：请配置环境/节点选择（TARGET_IPS/TARGET_HOSTS）')
    gate_nodes = []
    for target in targets:
        node = resolve_target(target)
        if not node:
            fail(f'目标 {target} 不是本集群节点（跨 region endpoint 需经 TARGET_HOSTS 分发采集身份映射）')
        gate_nodes.append(node['metadata']['name'])
    # 节点数量不设限（check 是通用巡检 step，单节点巡检/门禁均合法）；
    # 「EMS 安装至少 2 台」是 ems-deploy 的执行前提，由 deploy 自行校验
    print(f'    [ok] 目标节点：{"、".join(gate_nodes)}（label {label_key}，共 {len(gate_nodes)} 台）')
    occupied = [name for name in label_to_nodes.get(label_key, []) if name not in gate_nodes]
    if occupied:
        fail(f'label {label_key}=true 已被其他节点占用：{"、".join(occupied)}（换名或人工协调，勿动他人 label）')
    print(f'    [ok] label {label_key}=true 无外部占用')
    ns_exists = GATE_NAME in namespaces
    gate_release = release_by_name.get(GATE_NAME)
    idempotent = 0
    if ns_exists and gate_release:
        installed_version = chart_split(gate_release.get('chart') or '')[1]
        if GATE_EXPECTED and installed_version and installed_version != GATE_EXPECTED:
            fail(f'实例 {GATE_NAME} 已安装 chart {installed_version}，与仓内 {GATE_EXPECTED} 不一致；'
                 '升级是独立操作，请人工处理')
        instance = instances.get(GATE_NAME)
        if instance and instance['healthy']:
            idempotent = 1
            print(f'    [ok] 已健康安装（chart {installed_version or "?"}），幂等重入：deploy 将跳过安装仅验证')
        else:
            detail = (f'（{instance["running_ready"]}/{len(instance["pods"])} Running&Ready）' if instance
                      else '（无 pod）')
            fail(f'实例 {GATE_NAME} 已存在且不健康{detail}；不自动重装，需人工处理')
    elif ns_exists:
        fail(f'资源 ns {GATE_NAME} 已存在但找不到对应 helm release（残留，需人工处理）')
    elif gate_release:
        fail(f'发现同名 helm release {GATE_NAME} 但资源 ns 不存在（残留，需人工处理）')
    else:
        print('    [ok] 名字可用（ns 与 release 均不存在）')
    # G-5 资源余量（调度器 requests 口径；不关心节点上是否跑着其他业务，只看装不装得下）。
    # 只查 CPU/内存：大页有独立的 ems-hugepages step 负责（配置/allocatable 刷新），
    # 门禁不重复判。需求：每节点 ems-server 40C+40Gi（含 sidecar 计 41C/41Gi）；集群级
    # controller 8C/8G + zk×3 1C/4G 落在其中一节点（需单节点再余 12C/20Gi）。
    # EMS 自身 ns（GATE_NAME）的 pod 不计入占用——幂等重入时它们就是 EMS 的。
    REQ_CPU, REQ_MEM = 41, 41 * 2 ** 30
    EXTRA_CPU, EXTRA_MEM = 12, 20 * 2 ** 30

    def pod_request(containers, field):
        return sum(parse_qty(((c.get('resources') or {}).get('requests') or {}).get(field)) or 0
                   for c in containers)

    node_request = {name: {'cpu': 0.0, 'mem': 0.0} for name in gate_nodes}
    for pod in pods:
        node_name = node_of(pod)
        if node_name not in node_request or pod_phase(pod) in ('Succeeded', 'Failed'):
            continue
        if pod.get('metadata', {}).get('namespace', '') == GATE_NAME:
            continue
        spec = pod.get('spec') or {}
        regular, inits = spec.get('containers') or [], spec.get('initContainers') or []
        for field, key in (('cpu', 'cpu'), ('memory', 'mem')):
            value = max(pod_request(regular, field),
                        max((parse_qty(((c.get('resources') or {}).get('requests') or {}).get(field)) or 0
                             for c in inits), default=0))
            node_request[node_name][key] += value
    free = {}
    for node_name in gate_nodes:
        allocatable = (node_by_key[node_name].get('status') or {}).get('allocatable') or {}
        cpu_free = (parse_qty(allocatable.get('cpu')) or 0) - node_request[node_name]['cpu']
        mem_free = (parse_qty(allocatable.get('memory')) or 0) - node_request[node_name]['mem']
        free[node_name] = (cpu_free, mem_free)
        if cpu_free < REQ_CPU or mem_free + 1e-6 < REQ_MEM:
            fail(f'{node_name} 资源余量不足：CPU {cpu_free:.0f}C（需 {REQ_CPU}C）· 内存 {fmt_gib(mem_free)}（需 {fmt_gib(REQ_MEM)}）；'
                 '需先释放业务或等余量恢复（门禁只看 requests 余量，不区分业务归属；大页由 ems-hugepages step 负责）')
        print(f'    [ok] {node_name} 资源余量：CPU {cpu_free:.0f}C ≥ {REQ_CPU}C · 内存 {fmt_gib(mem_free)} ≥ {fmt_gib(REQ_MEM)}（大页另由 ems-hugepages step 保障）')
    if not any(cpu >= REQ_CPU + EXTRA_CPU and mem >= REQ_MEM + EXTRA_MEM
               for cpu, mem in free.values()):
        fail(f'无目标节点能容纳集群级组件（controller+zk 需单节点再余 {EXTRA_CPU}C/{fmt_gib(EXTRA_MEM)}）')
    print('    门禁通过')
    gate_contract = [
        f'EMS_NAME={GATE_NAME}',
        f'EMS_LABEL_KEY={label_key}',
        f'EMS_NODES={",".join(targets)}',
        f'EMS_IDEMPOTENT={idempotent}',
        'EMS_GATE=passed',
    ]
    if GATE_RELEASE_PASSTHROUGH:
        gate_contract.append(f'EMS_RELEASE_NAMESPACES={GATE_RELEASE_PASSTHROUGH}')

# ---- ④ 契约输出（stdout KEY=VALUE，注入下游 step） -------------------------------
healthy_count = sum(1 for instance in instances.values() if instance['healthy'])
unhealthy = sorted(name for name, instance in instances.items() if not instance['healthy'])
contract = [
    f'EMS_INSTANCE_COUNT={len(instances)}',
    f'EMS_INSTANCES={",".join(sorted(instances))}',
    f'EMS_HEALTHY_COUNT={healthy_count}',
    f'EMS_UNHEALTHY={",".join(unhealthy)}',
]
if targets is not None:
    contract.append(f'EMS_TARGET_TOTAL={len(targets)}')
    contract.append(f'EMS_TARGET_MATCHED={matched_targets}')
if first_hit:
    contract += [
        f'EMS_TARGET_INSTANCE={first_hit["name"]}',
        f'EMS_TARGET_LABEL_KEY={",".join(first_hit["label_keys"])}',
        f'EMS_TARGET_NODES={",".join(first_hit["all_nodes"])}',
        f'EMS_TARGET_CHART_VERSION={first_hit["chart_version"] or "?"}',
        f'EMS_TARGET_POD_HEALTH={first_hit["running_ready"]}/{len(first_hit["pods"])}',
    ]
contract += gate_contract
print()
print('--- EMS 巡检契约（KEY=VALUE） ---')
for line in contract:
    print(line)
PY
    return "$rc"
}

main "$@"
