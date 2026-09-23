#!/usr/bin/env bash
# pipeline: no-positional-args
# EMS 实例巡检流水线 step 主脚本（shell step，无参调用）。
#
# 用法：在流水线中任意位置插入本 step，理论上无需配置任何参数。目标节点由
# 平台注入的 TARGET_IP / TARGET_IPS 提供；平台注入 TARGET_HOSTS 时本脚本自动
# 推送自身到首个具备 kubectl 的目标节点上远程执行（工作台服务端所在主机
# 不需要 kubectl；kubectl 视图是集群级的，任一节点结果一致），目标节点恰为
# 执行节点时额外附本机视角（/proc/meminfo、/dev/shm/ems）。未注入
# TARGET_HOSTS 时在执行机本地运行（手工独立运行场景，需本机有 kubectl）。
# 本 step 全程只读，做三件事：
#   ① 集群巡检：全部 EMS 实例清单（label、helm release chart·app 版本、镜像、
#      pod 健康与异常原因、每节点大页 capacity/allocatable/已分配）+ 空壳遗留
#      ns / release + 被占用未部署的 label（只报告，勿动）；
#   ② 目标节点定位：逐个检查 TARGET_IP/TARGET_IPS 的归属，命中实例则展开该
#      实例与本节点详情；
#   ③ 契约输出：stdout KEY=VALUE（EMS_*），实例计数与首个命中目标的信息
#      注入下游 step 环境。
# 实例识别约定（同 ems-deploy skill）：release 名 = 资源 ns = ems<N>-<M>，
# label key = ems<N>（值 true）；EMS pod = 容器名含 ems 或挂载含 ems 的路径。
# 依赖：执行机需要 ssh/scp（+python3 解析 TARGET_HOSTS，密码认证还需
# sshpass）；实际巡检节点需要 kubectl（可访问集群）、python3，helm 可选
# （缺失时版本信息降级为未知）。
# 退出码：0 正常；1 环境错误（判本 step 失败）。
# 单测：test/test_ems_check.sh。
set -uo pipefail

SCRIPT_NAME='ems-check'

# 零参数设计：TARGET_HOSTS 是平台注入的运行级变量，经 nameref 间接引用——
# 引用名小写且字面量不带 $，平台「识别参数」扫不到，页面保持无入参。
declare -n platform_target_hosts='TARGET_HOSTS'

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

    echo "[$SCRIPT_NAME] remote execution via $probe_user@$probe_host:$probe_port（kubectl 视图为集群级，任一节点一致）"
    remote_scp "$probe_user" "$probe_host" "$probe_port" "$probe_pass" "$self" /tmp/ems-check.sh \
        || die "推送脚本到 $probe_host 失败"

    remote_env=(TARGET_HOSTS=)
    for var in TARGET_IP TARGET_IPS; do
        printf -v quoted '%q' "${!var:-}"
        remote_env+=("$var=$quoted")
    done
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
    python3 - "$workdir/nodes.json" "$workdir/pods.json" "$workdir/namespaces.json" "$workdir/helm.json" <<'PY' || rc=$?
import json
import os
import re
import sys

LOCAL_IDS = [token for token in os.environ.get('EMS_CHECK_LOCAL_IDENTIFIERS', '').split() if token]
TARGET_IPS_RAW = os.environ.get('TARGET_IPS', '').strip()
TARGET_IP_RAW = os.environ.get('TARGET_IP', '').strip()


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

UNITS = {'Ki': 2 ** 10, 'Mi': 2 ** 20, 'Gi': 2 ** 30, 'Ti': 2 ** 40, 'Pi': 2 ** 50,
         'k': 10 ** 3, 'K': 10 ** 3, 'M': 10 ** 6, 'G': 10 ** 9, 'T': 10 ** 12}


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
    lines = []
    release = instance['release']
    label_nodes = ', '.join(
        f'{key}=' + ','.join(label_to_nodes.get(key, [])) for key in instance['label_keys']) or '（无）'
    lines.append(f'    label:         {label_nodes}')
    if release:
        lines.append(f'    helm release:  {release.get("name")} @ ns {release.get("namespace")} · '
                     f'chart {release.get("chart")} · app {release.get("app_version") or "?"} · '
                     f'{release.get("status")} · {release.get("updated")}')
    else:
        lines.append('    helm release:  未找到（无 helm 或 release 缺失）')
    counts = {}
    for pod in instance['pods']:
        for component in components_of(pod):
            counts[component] = counts.get(component, 0) + 1
    summary = ' · '.join(f'{key} {counts[key]}' for key in sorted(counts)) or '无 pod'
    lines.append(f'    Pod:           {instance["running_ready"]}/{len(instance["pods"])} Running&Ready（{summary}）')
    if instance['images']:
        lines.append(f'    镜像:          ' + ', '.join(instance['images']))
    for node_name in instance['all_nodes']:
        lines.append(f'    大页:          {describe_node_hp(node_name)}')
    problems = [f'{pod["metadata"]["namespace"]}/{pod["metadata"]["name"]}: {reason}'
                for pod in instance['pods'] for reason in [pod_problem(pod)] if reason]
    if problems:
        lines.append('    异常:          ' + '; '.join(problems))
    lines.append(f'    状态:          {"健康" if instance["healthy"] else "异常（见上）"}')
    return lines


# ---- ① 集群巡检 ----------------------------------------------------------------
print(f'=== EMS 实例清单（{len(instances)} 个，集群节点 {len(nodes)} 个） ===')
if instances:
    for index, instance in enumerate(instances.values(), 1):
        print(f'[{index}] {instance["name"]}')
        for line in format_instance(instance):
            print(line)
else:
    print('（未发现 EMS 实例）')

active_release_ns = {(instance['release'] or {}).get('namespace') for instance in instances.values()}
active_label_keys = {key for instance in instances.values() for key in instance['label_keys']}
pods_by_ns = {}
for pod in pods:
    pods_by_ns.setdefault(pod.get('metadata', {}).get('namespace', ''), []).append(pod)

shell_namespaces = sorted(ns for ns in namespaces
                          if re.match(r'^ems', ns) and ns not in pods_by_ns and ns not in active_release_ns)
matched_release_names = set(instances)
shell_releases = sorted((release for release in releases
                         if str(release.get('name', '')).startswith('ems')
                         and release.get('name') not in matched_release_names),
                        key=lambda release: release.get('name', ''))
uncovered_labels = {key: value for key, value in label_to_nodes.items() if key not in active_label_keys}

print('=== 空壳/遗留（无 pod，勿动） ===')
if shell_namespaces or shell_releases:
    if shell_namespaces:
        print(f'    ns:           {", ".join(shell_namespaces)}')
    if shell_releases:
        print('    helm release: ' + ', '.join(f'{release.get("name")} (存放 ns {release.get("namespace")})'
                                              for release in shell_releases))
else:
    print('    （无）')
print('=== label 被占用但未部署（勿动他人 label） ===')
if uncovered_labels:
    for key in sorted(uncovered_labels):
        print(f'    {key}=true → {", ".join(uncovered_labels[key])}')
else:
    print('    （无）')


# ---- ② 节点定位（TARGET_IP/TARGET_IPS；未注入回退本机） --------------------------
def instances_on(node_name):
    return [instance for instance in instances.values() if node_name in instance['all_nodes']]


def print_node_view(node_name, instance):
    roles = sorted({component for pod in instance['pods']
                    if node_of(pod) == node_name
                    for component in components_of(pod)})
    print(f'    --- 节点 {node_name} 视角（实例 {instance["name"]}） ---')
    print(f'    角色:  {"+".join(roles) if roles else "仅 label 命中，无本节点 pod"}')
    for pod in sorted(instance['pods'], key=lambda pod: pod['metadata']['name']):
        if node_of(pod) == node_name:
            hp_values = [(container.get('resources') or {}).get('requests', {}).get('hugepages-2Mi')
                         for container in pod_containers(pod)]
            hp_values = [value for value in hp_values if value]
            hp_request = parse_qty(hp_values[0]) if hp_values else None
            print(f'    Pod:   {pod["metadata"]["name"]} · {pod_phase(pod)} · '
                  f'ready={"Y" if pod_ready(pod) else "N"}'
                  + (f' · 大页请求={fmt_gib(hp_request)}' if hp_request else ''))


def print_self_view(node):
    node_name = node['metadata']['name']
    ips = node_ips(node)
    if not (node_name in LOCAL_IDS or any(ip in LOCAL_IDS for ip in ips)):
        return
    try:
        meminfo = {}
        with open('/proc/meminfo', encoding='utf-8') as handle:
            for line in handle:
                key, _, rest = line.partition(':')
                if key.startswith('HugePages'):
                    meminfo[key] = rest.split()[0]
        if meminfo:
            print(f'    本机 /proc/meminfo: ' + ' · '.join(f'{key}={value}' for key, value in meminfo.items()))
    except OSError:
        pass
    print(f'    本机 /dev/shm/ems: ' + ('存在' if os.path.exists('/dev/shm/ems') else '不存在'))


first_hit = None
matched_targets = 0
printed_details = set()

if targets is not None:
    print(f'=== 目标节点定位（TARGET_IP/TARGET_IPS，共 {len(targets)} 个） ===')
    for target in targets:
        node = node_by_key.get(target)
        if not node:
            print(f'    {target}: 不是本集群节点')
            continue
        node_name = node['metadata']['name']
        hits = instances_on(node_name)
        if not hits:
            print(f'    {target} → {node_name}: 不在任何 EMS 实例中')
            continue
        matched_targets += 1
        print(f'    {target} → {node_name}: ' + ', '.join(
            f'{instance["name"]}（label {",".join(instance["label_keys"])}）' for instance in hits))
        if first_hit is None:
            first_hit = hits[0]
        for instance in hits:
            if instance['name'] not in printed_details:
                printed_details.add(instance['name'])
                for line in format_instance(instance):
                    print(line)
        print_node_view(node_name, hits[0])
        print_self_view(node)
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
        ips = node_ips(local_node)
        print(f'执行机 → 集群节点 {node_name}' + (f'（{ips[0]}）' if ips else ''))
        hits = instances_on(node_name)
        if hits:
            for instance in hits:
                print(f'所属实例: {instance["name"]}（label {",".join(instance["label_keys"]) or "?"}，'
                      f'节点 {",".join(instance["all_nodes"])}）')
                if instance['name'] not in printed_details:
                    printed_details.add(instance['name'])
                    for line in format_instance(instance):
                        print(line)
            first_hit = hits[0]
            print_node_view(node_name, first_hit)
            print_self_view(local_node)
        else:
            print('不在任何 EMS 实例中')
    else:
        print(f'执行机（{", ".join(LOCAL_IDS) or "?"}）不是本集群节点；实例清单仍有效')

# ---- ③ 契约输出（stdout KEY=VALUE，注入下游 step） -------------------------------
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
print()
print('--- EMS 巡检契约（KEY=VALUE） ---')
for line in contract:
    print(line)
PY
    return "$rc"
}

main "$@"
