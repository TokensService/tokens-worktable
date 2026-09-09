#!/usr/bin/env bash
# check-env.sh - 环境健康检查，可单文件本地或远程执行。
# pipeline: no-positional-args
# TARGET_HOSTS= 支持逗号分隔 IP 或 JSON；SSH_USER/SSH_PORT/SSH_PASSWORD 控制 SSH。
# LOG_FILE= 检查日志。退出码 0 表示无 FAIL，非零表示失败。
# 深入检查使用 Python 3 标准库；大页按预留量2048 GiB触发至少剩余700 GiB。
# 跨节点检查临时创建并删除专属探测 Pod，不清理业务 Pod 或启停服务。
set -uo pipefail

# ---------------- 全局 ----------------
ACTION="${ACTION:-check-health}"
DRY_RUN="${DRY_RUN:-0}"
LOG_PREFIX="[bnt]"
LOG_FILE="${LOG_FILE:-/tmp/check-env_$(date +%Y%m%d_%H%M%S).log}"
TARGET_HOSTS="${TARGET_HOSTS:-}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
SSH_PASSWORD="${SSH_PASSWORD:-${TARGET_PASSWORD:-}}"
REMOTE_EXECUTION="${REMOTE_EXECUTION:-0}"
export HEALTH_NODE="${HEALTH_NODE:-}"
export HUGEPAGE_TRIGGER_GIB="${HUGEPAGE_TRIGGER_GIB:-2048}"
export MIN_AVAILABLE_WITH_HUGEPAGES_GIB="${MIN_AVAILABLE_WITH_HUGEPAGES_GIB:-700}"
export NETWORK_TEST_NAMESPACE="${NETWORK_TEST_NAMESPACE:-default}"
export NETWORK_TEST_PEER="${NETWORK_TEST_PEER:-}"
export NETWORK_TEST_IMAGE="${NETWORK_TEST_IMAGE:-}"
HEALTH_PASS=0
HEALTH_WARN=0
HEALTH_FAIL=0

log() {
    local ts; ts=$(date +'%Y-%m-%d %H:%M:%S')
    local line="[$ts] $LOG_PREFIX $*"
    echo "$line"
    echo "$line" >> "$LOG_FILE"
}
die() { log "ERROR: $*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# ---------------- 环境健康检查 ----------------
health_result() {
    local level=$1 message=$2
    case "$level" in
        PASS) ((HEALTH_PASS++)) ;;
        WARN) ((HEALTH_WARN++)) ;;
        FAIL) ((HEALTH_FAIL++)) ;;
        *) die "未知健康检查级别: $level" ;;
    esac
    log "[$level] $message"
}

health_service() {
    local service=$1
    if ! have systemctl; then
        health_result WARN "运行时($service): systemctl 不可用"
    elif systemctl is-active --quiet "$service" 2>/dev/null; then
        health_result PASS "运行时($service): active"
    else
        health_result FAIL "运行时($service): 未处于 active"
    fi
}

health_deep_environment() {
    if ! have python3; then health_result FAIL "深入环境检查需要 python3"; return; fi
    local output level message
    output="$(python3 - <<'PY_HEALTH'
import json
import os
import pathlib
import re
import socket
import subprocess
import uuid

GIB = 1024**3


def report(level, message):
    print(level + '\t' + message.replace('\n', ' '))


def command(args, timeout=12, input=None):
    # 不转印 stderr：systemd/网络工具输出可能含代理认证信息。
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout, input=input)
    if p.returncode:
        raise RuntimeError(args[0] + ' 查询失败，exit=' + str(p.returncode))
    return p.stdout.strip()


def cni_errors(d):
    errors = []
    if d.get('cniVersion') != '0.3.1' or d.get('name') != 'default-network':
        errors.append('版本/网络名偏离128基准(0.3.1/default-network)')
    plugins = d.get('plugins', [])
    if not isinstance(plugins, list) or [p.get('type') for p in plugins if isinstance(p, dict)] != ['vpc-router', 'portmap']:
        return errors + ['插件链必须为 vpc-router → portmap']
    vpc, portmap = plugins
    if vpc.get('ipam', {}).get('subnet') != '10.0.0.0/16':
        errors.append('Pod subnet 偏离128基准 10.0.0.0/16')
    if vpc.get('args', {}).get('phynet') != 'phy_net1':
        errors.append('phynet 偏离128基准 phy_net1')
    if vpc.get('capabilities', {}).get('bandwidth') is not True:
        errors.append('vpc-router bandwidth capability 未开启')
    if portmap.get('capabilities', {}).get('portMappings') is not True:
        errors.append('portmap portMappings 未开启')
    if portmap.get('externalSetMarkChain') != 'KUBE-MARK-MASQ':
        errors.append('portmap 标记链不是 KUBE-MARK-MASQ')
    return errors


def memory_level(total, available, reserved, trigger, minimum):
    if total <= 0 or available < 0 or available > total:
        return 'FAIL'
    if reserved >= trigger and available < minimum:
        return 'FAIL'
    return 'FAIL' if available / total < .02 else ('WARN' if available / total < .1 else 'PASS')


def proxy_keys(values):
    return sorted(k for k, v in values.items() if k.lower() in ('http_proxy', 'https_proxy', 'all_proxy') and v.strip())


def proxy_level(scope, values):
    if not proxy_keys(values):
        return 'PASS'
    # 已明确配置代理的宿主机或运行时仅告警；实际部署连通性由后续镜像拉取、
    # API 与跨节点检查验证，避免把可由 NO_PROXY 绕过的环境直接判为失败。
    return 'WARN' if scope in ('检查进程', '/etc/environment', 'containerd运行进程') else 'FAIL'


def quantity(value):
    m = re.fullmatch(r'([0-9.]+)([KMGT]i?|[kmgteE]|[eE][+-]?\d+)?', str(value))
    if not m:
        raise ValueError('无法解析内存 quantity')
    n, suffix = m.groups()
    powers = {'Ki':1024,'Mi':1024**2,'Gi':1024**3,'Ti':1024**4,
              'k':1000,'K':1000,'M':10**6,'G':10**9,'T':10**12,'m':.001}
    return int(float(n) * (10**int(suffix[1:]) if suffix and suffix[0] in 'eE' and len(suffix)>1 else powers.get(suffix,1)))


def check_cni():
    folder = pathlib.Path('/etc/cni/net.d')
    configs = sorted(p for p in folder.iterdir() if p.suffix in ('.conf', '.conflist', '.json'))
    if [p.name for p in configs] != ['cni.conflist']:
        report('WARN', 'CNI 配置文件集合偏离128基准，额外网络可能影响路由或业务选网: ' + ','.join(p.name for p in configs))
    d = json.loads((folder/'cni.conflist').read_text())
    errors = cni_errors(d)
    report('FAIL' if errors else 'PASS', 'CNI 配置: ' + ('; '.join(errors) or '插件顺序、网段、phynet、capabilities 与128一致'))
    for name in ('vpc-router', 'portmap', 'loopback'):
        p = pathlib.Path('/opt/cni/bin')/name
        report('PASS' if p.is_file() and os.access(p, os.X_OK) else 'FAIL', 'CNI 插件可执行检查: '+name)
    for key, expected in [('net.ipv4.ip_forward','1'),('net.ipv4.conf.all.rp_filter','2'),('net.ipv4.conf.default.rp_filter','2')]:
        actual = command(['sysctl','-n',key])
        report('PASS' if actual==expected else 'FAIL', key+'='+actual+'，128基准='+expected)
    rules = command(['iptables','-t','nat','-S','KUBE-MARK-MASQ'])
    report('PASS' if '--set-xmark 0x4000/0x4000' in rules else 'FAIL', 'CNI portmap 的 KUBE-MARK-MASQ 标记规则')
    routes = json.loads(command(['ip','-j','route','show','default']))
    links = {x['ifname']:x for x in json.loads(command(['ip','-j','address']))}
    usable = [r for r in routes if 'UP' in links.get(r.get('dev'),{}).get('flags',[]) and links.get(r.get('dev'),{}).get('addr_info')]
    report('PASS' if usable else 'FAIL', '默认路由出口需 UP 且有地址: '+','.join(r.get('dev','?') for r in routes))
    # 同一地址从直连路径检查，避免环境代理影响 API 网络检查。
    p = pathlib.Path('/opt/cloud/cce/kubernetes/kubelet/kubeconfig')
    m = re.search(r'^\s*server:\s*[\'"]?(https?://[^\s\'"]+)', p.read_text(), re.M)
    if not m:
        raise RuntimeError('kubelet kubeconfig 未找到 API 地址')
    from urllib.parse import urlsplit
    u = urlsplit(m.group(1))
    socket.getaddrinfo(u.hostname, u.port or 443)
    with socket.create_connection((u.hostname,u.port or 443),timeout=3):
        report('PASS','API Server DNS/直连TCP可达（不代表API认证成功或Pod跨节点网络已验证）')


def check_proxy():
    scopes = [('检查进程',dict(os.environ))]
    for service in ('containerd','kubelet'):
        pid = command(['systemctl','show',service,'--property=MainPID','--value'])
        if not pid.isdigit() or pid=='0':
            report('FAIL',service+' 无有效运行PID，无法核实代理');continue
        raw = pathlib.Path('/proc')/pid/'environ'
        env = dict(x.decode(errors='replace').split('=',1) for x in raw.read_bytes().split(b'\0') if b'=' in x)
        scopes.append((service+'运行进程',env))
    p = pathlib.Path('/etc/environment')
    if p.exists():
        env = {}
        for line in p.read_text().splitlines():
            m = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*$',line)
            if m: env[m[1]]=m[2].strip('"\'')
        scopes.append(('/etc/environment',env))
    for scope,env in scopes:
        active = proxy_keys(env)
        level = proxy_level(scope, env)
        detail = '未设置HTTP/HTTPS/ALL代理'
        if active:
            detail = '存在 '+','.join(active)+'（值已隐藏）'
            detail += ('；宿主机代理仅告警，部署工具需正确绕过内网代理，NO_PROXY是否生效取决于客户端'
                       if level == 'WARN' else '；偏离128服务无代理基准')
        report(level, '代理 '+scope+': '+detail)
        if any(k.lower()=='no_proxy' and v for k,v in env.items()):
            report('PASS','代理 '+scope+': 已配置NO_PROXY（不单独视为开启代理）')


def check_memory():
    info = {}
    for line in pathlib.Path('/proc/meminfo').read_text().splitlines():
        k,v=line.split(':',1);info[k]=int(v.split()[0])*1024
    reserved=used=0
    for p in pathlib.Path('/sys/kernel/mm/hugepages').glob('hugepages-*'):
        size=int(p.name.split('-')[1][:-2])*1024
        count=int((p/'nr_hugepages').read_text());free=int((p/'free_hugepages').read_text())
        reserved+=size*count;used+=size*(count-free)
    # Hugetlb 包括所有页大小及 surplus；保守采用较大值。
    reserved=max(reserved,info.get('Hugetlb',0))
    trigger=int(os.environ.get('HUGEPAGE_TRIGGER_GIB','2048'))*GIB
    minimum=int(os.environ.get('MIN_AVAILABLE_WITH_HUGEPAGES_GIB','700'))*GIB
    if trigger<=0 or minimum<=0:raise ValueError('大页门槛必须为正整数GiB')
    level=memory_level(info['MemTotal'],info['MemAvailable'],reserved,trigger,minimum)
    report(level,'内存: total=%.2f GiB, MemAvailable=%.2f GiB, 大页预留=%.2f GiB, 大页已用=%.2f GiB; 预留达到%d GiB时至少剩余%d GiB（不再重复扣除大页）' % (info['MemTotal']/GIB,info['MemAvailable']/GIB,reserved/GIB,used/GIB,trigger/GIB,minimum/GIB))


def check_pod_memory():
    # 直读 kubelet summary，不依赖故障的 metrics-server。
    nodes=json.loads(command(['kubectl','get','nodes','-o','json']))['items']
    addresses={a['local'] for x in json.loads(command(['ip','-j','address'])) for a in x.get('addr_info',[])}
    matches=[n for n in nodes if any(a['address'] in addresses for a in n['status'].get('addresses',[]) if a['type']=='InternalIP')]
    node=os.environ.get('HEALTH_NODE','')
    if not node:
        if len(matches)!=1:raise RuntimeError('无法唯一识别本机节点，请设置HEALTH_NODE')
        node=matches[0]['metadata']['name']
    pods=json.loads(command(['kubectl','get','pods','-A','--field-selector','spec.nodeName='+node,'-o','json']))['items']
    business=[p for p in pods if p['metadata']['namespace'].startswith('xds-') and p['status'].get('phase') not in ('Succeeded','Failed')]
    if not business:
        report('PASS','容器内存: 本节点无xds业务Pod；128参考 Prefill约1154 GiB/Decode约32 GiB（2026-09-08采样）');return
    stats=json.loads(command(['kubectl','get','--raw','/api/v1/nodes/'+node+'/proxy/stats/summary']))
    by_uid={p['podRef']['uid']:p for p in stats.get('pods',[])}
    total=0
    for pod in business:
        name=pod['metadata']['namespace']+'/'+pod['metadata']['name']
        mem=by_uid.get(pod['metadata']['uid'],{}).get('memory',{})
        if 'workingSetBytes' not in mem:
            report('WARN','容器内存缺少kubelet采样: '+name);continue
        actual=mem['workingSetBytes'];total+=actual
        requested=sum(quantity(c.get('resources',{}).get('requests',{}).get('memory','0')) for c in pod['spec']['containers'])
        report('PASS','容器内存 '+name+': workingSet=%.2f GiB, requests=%.2f GiB（申请量不是实际占用）' % (actual/GIB,requested/GIB))
    report('PASS','xds容器工作集合计=%.2f GiB；128参考 Prefill约1154 GiB/Decode约32 GiB；不从MemAvailable再次扣除已占用量' % (total/GIB))



def check_cross_node():
    nodes = json.loads(command(['kubectl','get','nodes','-o','json']))['items']
    local = os.environ.get('HEALTH_NODE','')
    if not local:
        addresses = {a['local'] for x in json.loads(command(['ip','-j','address'])) for a in x.get('addr_info',[])}
        matches = [n['metadata']['name'] for n in nodes if any(a['address'] in addresses for a in n['status'].get('addresses',[]) if a['type']=='InternalIP')]
        if len(matches)!=1:
            report('FAIL','跨节点测试无法识别本机，请设置 HEALTH_NODE'); return
        local = matches[0]
    healthy = [n['metadata']['name'] for n in nodes
               if not n['spec'].get('unschedulable')
               and not any(t.get('effect') in ('NoSchedule','NoExecute') for t in n['spec'].get('taints',[]))
               and any(c['type']=='Ready' and c['status']=='True' for c in n['status'].get('conditions',[]))]
    peer = os.environ.get('NETWORK_TEST_PEER','')
    candidates = [n for n in healthy if n!=local and (not peer or n==peer)]
    if local not in healthy or not candidates:
        report('FAIL','跨节点测试需要两个不同的 Ready、可调度且无阻止调度污点的节点'); return
    pods = json.loads(command(['kubectl','get','pods','-A','-o','json']))['items']
    images = {}
    for pod in pods:
        if (pod['metadata']['namespace'].startswith('xds-') and
            any(c['type']=='Ready' and c['status']=='True' for c in pod['status'].get('conditions',[]))):
            images.setdefault(pod['spec'].get('nodeName'), pod['spec']['containers'][0]['image'])
    # 标准化会删除业务 Pod，但不会清理镜像缓存。清理后仍应能执行网络探测。
    # 仅选已知 XDS 镜像；不能假定任意系统镜像都包含 python3。
    for node in nodes:
        name = node['metadata']['name']
        cached = sorted({ref for entry in (node.get('status',{}).get('images') or [])
                         for ref in (entry.get('names') or [])
                         if re.search(r'(?:^|/)xds(?::|@sha256:)', ref)})
        if cached:
            tagged = [ref for ref in cached if '@sha256:' not in ref]
            images.setdefault(name, (tagged or cached)[-1])
    image = os.environ.get('NETWORK_TEST_IMAGE','')
    candidates = [n for n in candidates if image or n in images]
    if not candidates or not (image or local in images):
        report('FAIL','跨节点测试缺少探测镜像：配置 NETWORK_TEST_IMAGE（需 python3）；清理后可自动使用节点缓存的 XDS 镜像，当前候选节点未找到可用镜像'); return
    peer = sorted(candidates)[0]
    namespace = os.environ.get('NETWORK_TEST_NAMESPACE','default')
    token = uuid.uuid4().hex
    names = ['env-net-'+token[:12]+'-'+str(i) for i in range(2)]
    attempted = []
    server = "from http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write("+repr(token.encode())+")\nHTTPServer(('0.0.0.0',18080),H).serve_forever()"
    report('PASS','跨节点探测开始: '+local+' ↔ '+peer+'，namespace='+namespace+'（仅验证该命名空间 Pod IP TCP/HTTP，不代表 RDMA 或业务 NetworkPolicy）；镜像='+str({local:image or images[local],peer:image or images[peer]}))
    try:
        for name,node in zip(names,[local,peer]):
            manifest = {'apiVersion':'v1','kind':'Pod','metadata':{'name':name,'namespace':namespace,'labels':{'optest-network-probe':token}},
                'spec':{'nodeSelector':{'kubernetes.io/hostname':next(n['metadata']['labels']['kubernetes.io/hostname'] for n in nodes if n['metadata']['name']==node)},
                'hostNetwork':False,'automountServiceAccountToken':False,'restartPolicy':'Never','activeDeadlineSeconds':180,'terminationGracePeriodSeconds':1,
                'containers':[{'name':'probe','image':image or images[node],'imagePullPolicy':'IfNotPresent','command':['python3','-u','-c',server],
                'resources':{'requests':{'cpu':'10m','memory':'32Mi'},'limits':{'cpu':'100m','memory':'128Mi'}},
                'securityContext':{'allowPrivilegeEscalation':False,'capabilities':{'drop':['ALL']}},
                'readinessProbe':{'tcpSocket':{'port':18080},'periodSeconds':1}}]}}
            # 即使创建请求超时，也按唯一标记查回并清理，避免遗留资源。
            attempted.append(name)
            command(['kubectl','create','-f','-'], input=json.dumps(manifest))
        command(['kubectl','-n',namespace,'wait','--for=condition=Ready','pod/'+names[0],'pod/'+names[1],'--timeout=60s'],timeout=65)
        ips = []
        for name,node in zip(names,[local,peer]):
            pod = json.loads(command(['kubectl','-n',namespace,'get','pod',name,'-o','json']))
            if pod['spec'].get('nodeName')!=node or pod['spec'].get('hostNetwork'):
                raise RuntimeError('探测节点或网络不匹配')
            ips.append(pod['status']['podIP'])
        for source,destination in [(0,1),(1,0)]:
            url = 'http://'+('['+ips[destination]+']' if ':' in ips[destination] else ips[destination])+':18080/'
            client = 'import urllib.request; r=urllib.request.build_opener(urllib.request.ProxyHandler({})).open('+repr(url)+',timeout=5); assert r.status==200 and r.read()=='+repr(token.encode())
            try:
                command(['kubectl','-n',namespace,'exec',names[source],'--','python3','-c',client])
                report('PASS','跨节点 Pod 直连: '+[local,peer][source]+' → '+[local,peer][destination]+' ('+ips[source]+' → '+ips[destination]+':18080)')
            except Exception as e:
                report('FAIL','跨节点 Pod 直连失败: '+[local,peer][source]+' → '+[local,peer][destination]+' ('+type(e).__name__+')')
    finally:
        for name in attempted:
            try:
                found = command(['kubectl','-n',namespace,'get','pod',name,'--ignore-not-found=true','-o','json'])
                if found and json.loads(found)['metadata'].get('labels',{}).get('optest-network-probe')==token:
                    command(['kubectl','-n',namespace,'delete','pod',name,'--ignore-not-found=true','--wait=true','--timeout=15s'],timeout=20)
            except Exception as e:
                report('FAIL','探测 Pod 清理未确认: '+namespace+'/'+name+' ('+type(e).__name__+')')


def main():
    for fn in (check_cni,check_proxy,check_memory,check_pod_memory,check_cross_node):
        try:fn()
        except Exception as e:
            # 避免转印可能含认证信息的异常内容。
            report('WARN' if fn==check_pod_memory else 'FAIL', fn.__name__+' 未完成: '+type(e).__name__+'（检查权限、配置或命令可用性）')


if __name__=='__main__':main()
PY_HEALTH
)" || { health_result FAIL "深入环境检查执行失败"; return; }
    while IFS=$'\t' read -r level message; do
        [[ -n "$level" ]] && health_result "$level" "$message"
    done <<< "$output"
}

health_gpu() {
    if ! have nvidia-smi; then
        health_result WARN "GPU: 未找到 nvidia-smi"
        return
    fi
    local cards
    cards=$(nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || true)
    if [[ -z "$cards" ]]; then
        health_result FAIL "GPU: nvidia-smi 无法读取显卡状态"
    else
        health_result PASS "GPU: $(echo "$cards" | tr '\n' ';' | sed 's/;$//') MiB(卡号,已用,总量)"
    fi
}

check_health() {
    HEALTH_PASS=0; HEALTH_WARN=0; HEALTH_FAIL=0
    log "=== 环境健康检查 ==="
    health_service containerd
    health_service kubelet
    health_deep_environment
    health_gpu
    log "健康检查完成: PASS=$HEALTH_PASS WARN=$HEALTH_WARN FAIL=$HEALTH_FAIL"
    (( HEALTH_FAIL == 0 ))
}

# ---------------- 远端执行 ----------------
remote_scp() {
    if [[ -n "$SSH_PASSWORD" ]]; then
        have sshpass || die "SSH_PASSWORD 已设置但未找到 sshpass"
        SSHPASS="$SSH_PASSWORD" sshpass -e scp "$@"
    else
        scp "$@"
    fi
}

remote_ssh() {
    if [[ -n "$SSH_PASSWORD" ]]; then
        have sshpass || die "SSH_PASSWORD 已设置但未找到 sshpass"
        SSHPASS="$SSH_PASSWORD" sshpass -e ssh "$@"
    else
        ssh "$@"
    fi
}

do_remote() {
    local endpoint="$1" host port target self remote_env pair key
    if [[ "$endpoint" =~ ^([^:]+):([1-9][0-9]*)$ ]]; then
        host="${BASH_REMATCH[1]}"
        port="${BASH_REMATCH[2]}"
        (( port <= 65535 )) || { log "ERROR: 无效 SSH 端口: $endpoint"; return 2; }
    else
        host="$endpoint"
        port="$SSH_PORT"
    fi
    target="${SSH_USER}@${host}"
    local self; self=$(readlink -f "$0" 2>/dev/null || echo "$0")
    log "推送脚本到 $target:$port 并执行 $ACTION"
    remote_scp -P "$port" -q "$self" "$target:/tmp/check-env.sh" || return 1

    remote_env=""
    for key in ACTION LOG_FILE HEALTH_NODE HUGEPAGE_TRIGGER_GIB MIN_AVAILABLE_WITH_HUGEPAGES_GIB NETWORK_TEST_PEER NETWORK_TEST_IMAGE NETWORK_TEST_NAMESPACE; do
        printf -v pair '%q' "$key=${!key:-}"
        remote_env+=" $pair"
    done
    remote_ssh -p "$port" "$target" \
        "env REMOTE_EXECUTION=1 TARGET_HOSTS= $remote_env bash /tmp/check-env.sh"
}

target_ips() {
    local hosts="$TARGET_HOSTS"
    if [[ "$hosts" == \[* ]]; then
        printf '%s' "$hosts" | grep -oE '"ip"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/'
    else
        tr ',' '\n' <<<"$hosts" | sed '/^[[:space:]]*$/d; s/^[[:space:]]*//; s/[[:space:]]*$//'
    fi
}

do_targets() {
    local ip count=0
    while IFS= read -r ip; do
        [[ -z "$ip" ]] && continue
        # SSH/SCP 不得读取目标列表，避免吞掉后续节点。
        do_remote "$ip" </dev/null || return 1
        ((count += 1))
    done < <(target_ips)
    if (( count == 0 )); then
        die "TARGET_HOSTS 未包含可用 IP"
    fi
}

main() {
    [[ $# -eq 0 ]] || die "不支持命令行参数；请使用环境变量配置"
    [[ "$ACTION" == check-health ]] || die "检查脚本仅支持 ACTION=check-health"
    if [[ -n "$TARGET_HOSTS" && "$REMOTE_EXECUTION" != 1 ]]; then
        do_targets
        return $?
    fi
    check_health
}
main "$@"
