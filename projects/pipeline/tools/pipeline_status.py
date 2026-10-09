#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pipeline_status.py —— 查看当前正在运行的流水线（本机视角，无需登录）。

数据源（取并集）：
  1. dsh web 进程树：.../pipeline/scripts/*.sh 脚本进程是「正在跑」的直接证据；
  2. 归档目录活跃度：<archiveDir>/<流水线名>_<14位时间戳>/ 下 run-*.log 最近仍在写入，
     覆盖 HTTP / Jenkins / EvalTokens 等不产本地进程的阶段；
  3. 历史存储终态：worktable-pipeline.json 的 history 按 run tag 记录已完成运行，
     命中即视为结束，避免把「静默的远端长阶段」误报为在跑（静默但无终态的归入
     「疑似在跑」单独列出）；
  4. 可选：设置 DSH_AUTH_TOKEN（dsh-auth-gate 会话 token）时顺带查询
     /api/worktable/pipeline/queue，展示服务端排队与各浏览器客户端上报的运行。

用法：
  python3 projects/pipeline/tools/pipeline_status.py          # 查看在跑流水线
  python3 projects/pipeline/tools/pipeline_status.py --json   # 机器可读输出
  DSH_AUTH_TOKEN=xxx python3 projects/pipeline/tools/pipeline_status.py   # 附带服务端队列

环境变量：
  DSH_HOME         dsh 数据目录（默认 ~/.dsh），用于读 storages/worktable-pipeline.json
                   里的 scriptsDir / archiveDir 与 history；读不到则用内置默认
  WT_ARCHIVE_ROOT  直接指定归档根目录（优先级最高，默认 /var/log/op_test）
  DSH_WEB_PORT     web 端口（默认 3051，仅 queue API 用）
  DSH_WEB_PID_FILE 直接指定 web pid 文件（默认从脚本位置向上查找 dsh-web.pid）
  ACTIVE_SECONDS   归档日志多少秒内仍有写入视为活跃（默认 300）
  SILENT_SECONDS   静默 run 回溯窗口（默认 21600，超过则连「疑似」都不再列出）

退出码：恒 0（状态工具）；内部错误打到 stderr 但尽量输出已得信息。
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request

DEFAULT_ARCHIVE_ROOT = '/var/log/op_test'
DEFAULT_SCRIPTS_DIR = '/root/op_test/worktable/pipeline/scripts'
STAGE_LOG_RE = re.compile(r'^run-(\d{4}-[\w]+)-(\d+)-(.+)\.log$')
RUN_DIR_RE = re.compile(r'^(.*)_(\d{14})$')
SCRIPT_RE = re.compile(r'/pipeline/scripts/([A-Za-z0-9_.-]+\.sh)(?:\s|$)')


def human_duration(seconds):
    seconds = max(0, int(seconds))
    if seconds < 60:
        return '%ds' % seconds
    if seconds < 3600:
        return '%dm%02ds' % (seconds // 60, seconds % 60)
    return '%dh%02dm' % (seconds // 3600, (seconds % 3600) // 60)


def fmt_time(ts, with_date=False):
    try:
        return time.strftime('%m-%d %H:%M:%S' if with_date else '%H:%M:%S', time.localtime(ts))
    except (OverflowError, OSError, ValueError):
        return str(ts)


def find_pid_file():
    """从脚本位置向上查找 dsh-web.pid（兼容放在宿主仓库 tools/ 或插件 projects/ 下）。"""
    if os.environ.get('DSH_WEB_PID_FILE'):
        return os.environ['DSH_WEB_PID_FILE']
    d = os.path.dirname(os.path.abspath(__file__))
    while True:
        candidate = os.path.join(d, 'dsh-web.pid')
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def load_store_config():
    """从 worktable-pipeline.json 读 scriptsDir / archiveDir；失败回退内置默认。
    返回 (scripts_dir, archive_root, store_path)。"""
    dsh_home = os.environ.get('DSH_HOME') or os.path.expanduser('~/.dsh')
    store = os.path.join(dsh_home, 'storages', 'worktable-pipeline.json')
    scripts_dir, archive_root = DEFAULT_SCRIPTS_DIR, DEFAULT_ARCHIVE_ROOT
    try:
        with open(store, 'r', encoding='utf-8') as f:
            cfg = (json.load(f) or {}).get('config') or {}
        if isinstance(cfg.get('scriptsDir'), str) and cfg['scriptsDir'].strip():
            scripts_dir = cfg['scriptsDir'].strip()
        if isinstance(cfg.get('archiveDir'), str) and cfg['archiveDir'].strip():
            archive_root = cfg['archiveDir'].strip()
    except Exception as err:
        print('[warn] 读取 %s 失败，用内置默认路径：%s' % (store, err), file=sys.stderr)
    if os.environ.get('WT_ARCHIVE_ROOT'):
        archive_root = os.environ['WT_ARCHIVE_ROOT'].strip() or archive_root
    if os.environ.get('WT_SCRIPTS_DIR'):
        scripts_dir = os.environ['WT_SCRIPTS_DIR'].strip() or scripts_dir
    return scripts_dir, archive_root.rstrip('/'), store


def load_history(store_path):
    """历史记录按 run tag 索引（tag = 阶段日志文件名里的 run-<tag>- 段）。
    在跑的 run 不入历史，因此 tag 命中历史 = 运行已结束（附终态）。"""
    tags = {}
    try:
        with open(store_path, 'r', encoding='utf-8') as f:
            history = (json.load(f) or {}).get('history') or []
        for r in history:
            tag = isinstance(r, dict) and r.get('tag')
            if tag:
                tags[tag] = {'status': r.get('status'), 'by': r.get('by'),
                             'dur': r.get('dur'), 'no': r.get('no')}
    except Exception:
        pass
    return tags


def list_processes():
    """ps 快照：[{pid, ppid, etimes, args}]；etimes = 已运行秒数，免解析 lstart。"""
    out = subprocess.check_output(
        ['ps', '-eo', 'pid=,ppid=,etimes=,args='], universal_newlines=True)
    procs = []
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        try:
            procs.append({'pid': int(parts[0]), 'ppid': int(parts[1]),
                          'etimes': int(float(parts[2])), 'args': parts[3]})
        except ValueError:
            continue
    return procs


def find_web_pid(procs, pid_file=None):
    """优先 pid 文件（dsh.sh 管理的实例），校验命令行；失效则按 bin.js web 扫描。"""
    by_pid = {p['pid']: p for p in procs}
    if pid_file is None:
        pid_file = find_pid_file()
    if pid_file:
        try:
            with open(pid_file) as f:
                pid = int(f.read().strip())
            if pid in by_pid and re.search(r'bin\.js\s+web\b', by_pid[pid]['args']):
                return pid
        except (OSError, ValueError):
            pass
    for p in procs:
        if re.search(r'bin\.js\s+web\b', p['args']):
            return p['pid']
    return None


def descendants_of(root_pid, procs):
    children = {}
    for p in procs:
        children.setdefault(p['ppid'], []).append(p['pid'])
    seen, stack = set(), [root_pid]
    while stack:
        pid = stack.pop()
        for child in children.get(pid, []):
            if child not in seen:
                seen.add(child)
                stack.append(child)
    return seen


def collect_pipeline_procs(procs):
    """所有流水线脚本进程：{pid: {proc, script}}。"""
    found = {}
    for p in procs:
        m = SCRIPT_RE.search(p['args'])
        if m:
            found[p['pid']] = {'proc': p, 'script': m.group(1)}
    return found


def extract_run_dir(args, archive_root, known_dirs):
    """从命令行提取归档运行目录名（archive_root 下的第一级目录）。
    ps 输出里空格被转义为 \\ ，正则先吃掉 \\ 转义段再还原，最后与磁盘目录做前缀对齐。"""
    m = re.search(re.escape(archive_root) + r'/((?:\\ |[^\s/])+)', args)
    if not m:
        return None
    candidate = m.group(1).replace('\\ ', ' ')
    if candidate in known_dirs:
        return candidate
    for d in known_dirs:
        if d.startswith(candidate) or candidate.startswith(d):
            return d
    return candidate


def extract_target_host(args):
    m = re.search(r'\bssh\b[^\n]*?([\w.-]+)@([\w.-]+(?::\d+)?)', args)
    return m.group(2) if m else None


def scan_archive(archive_root, active_seconds, now, history_tags):
    """扫描归档根目录：{目录名: {pipeline, start_ts, tag, stages, current, newest_mtime, active, finished}}。"""
    runs = {}
    try:
        entries = os.listdir(archive_root)
    except OSError as err:
        print('[warn] 无法读取归档目录 %s：%s' % (archive_root, err), file=sys.stderr)
        return runs
    for entry in entries:
        m = RUN_DIR_RE.match(entry)
        if not m:
            continue
        path = os.path.join(archive_root, entry)
        if not os.path.isdir(path):
            continue
        try:
            start_ts = time.mktime(time.strptime(m.group(2), '%Y%m%d%H%M%S'))
        except ValueError:
            continue
        stages = []
        newest = 0.0
        try:
            files = os.listdir(path)
        except OSError:
            continue
        for fn in files:
            sm = STAGE_LOG_RE.match(fn)
            if not sm:
                continue
            try:
                mtime = os.path.getmtime(os.path.join(path, fn))
            except OSError:
                continue
            stages.append({'seq': int(sm.group(2)), 'name': sm.group(3),
                           'tag': sm.group(1), 'mtime': mtime})
            newest = max(newest, mtime)
        if not stages:
            continue
        stages.sort(key=lambda s: (s['seq'], s['mtime']))
        current = max(stages, key=lambda s: s['mtime'])
        finished = history_tags.get(current['tag'])
        runs[entry] = {
            'pipeline': m.group(1),
            'start_ts': start_ts,
            'tag': current['tag'],
            'stages': stages,
            'current': current,
            'newest_mtime': newest,
            'active': (now - newest) <= active_seconds and not finished,
            'finished': finished,
            'dir': path,
        }
    return runs


def build_proc_view(procs, web_pid, archive_root, known_dirs):
    """进程视角：web 子树里的运行根 + 游离的残留脚本进程。"""
    by_pid = {p['pid']: p for p in procs}
    web_desc = descendants_of(web_pid, procs) if web_pid else set()
    pl_procs = collect_pipeline_procs(procs)

    def is_pipeline_ancestor(pid):
        cursor = by_pid.get(pid, {}).get('ppid')
        while cursor and cursor in by_pid and cursor != web_pid:
            if cursor in pl_procs:
                return True
            cursor = by_pid[cursor]['ppid']
        return False

    roots, leftovers = [], []
    for pid, info in pl_procs.items():
        if pid in web_desc:
            if not is_pipeline_ancestor(pid):
                roots.append(info)
        else:
            leftovers.append(info)

    run_procs = []
    for info in roots:
        root = info['proc']
        sub = descendants_of(root['pid'], procs)
        archives, namespaces, target = set(), set(), None
        for pid in [root['pid']] + sorted(sub):
            p = by_pid.get(pid)
            if not p:
                continue
            d = extract_run_dir(p['args'], archive_root, known_dirs)
            if d:
                archives.add(d)
            if pid in pl_procs and pl_procs[pid]['script'] == 'follow-xds-head-logs.sh':
                m = SCRIPT_RE.search(p['args'])
                rest = p['args'][m.end():].split()
                if rest:
                    namespaces.add(rest[0])
            if target is None:
                target = extract_target_host(p['args'])
        run_procs.append({
            'pid': root['pid'], 'script': info['script'], 'etimes': root['etimes'],
            'archives': sorted(archives), 'namespaces': sorted(namespaces),
            'target': target, 'subprocs': len(sub),
        })
    leftover_list = []
    for info in leftovers:
        p = info['proc']
        leftover_list.append({
            'pid': p['pid'], 'script': info['script'], 'etimes': p['etimes'],
            'archive': extract_run_dir(p['args'], archive_root, known_dirs),
            'args_tail': p['args'][:160],
        })
    run_procs.sort(key=lambda r: r['pid'])
    leftover_list.sort(key=lambda r: r['pid'])
    return run_procs, leftover_list


def query_queue(port, token):
    """可选：带 dsh-auth-gate 会话 token 查询服务端执行队列；失败返回错误字符串。"""
    url = 'http://127.0.0.1:%d/api/worktable/pipeline/queue' % port
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode('utf-8')), None
    except Exception as err:
        return None, str(err)


def entry_line(e, time_key):
    stages = e.get('stages') or []
    nodes = e.get('nodes') or {}
    status_count = {}
    for st in stages:
        status = (nodes.get(st.get('id')) or {}).get('status', 'idle')
        status_count[status] = status_count.get(status, 0) + 1
    stat = '/'.join('%s:%d' % kv for kv in sorted(status_count.items())) or '-'
    ts = e.get(time_key) or 0
    return '    %s  by=%s env=%s  %s=%s  阶段[%s]' % (
        e.get('pipelineName') or e.get('pipelineId') or e.get('id'),
        e.get('by') or '-', e.get('env') or '-', time_key,
        fmt_time(ts / 1000.0) if ts else '-', stat)


def merge_runs(archive_runs, run_procs):
    """按归档目录名合并两个视角；无归档的进程运行单列。"""
    merged = {}
    for name, r in archive_runs.items():
        merged[name] = {'archive': r, 'procs': []}
    for rp in run_procs:
        if rp['archives']:
            for a in rp['archives']:
                merged.setdefault(a, {'archive': None, 'procs': []})['procs'].append(rp)
        else:
            merged.setdefault('pid:%d' % rp['pid'], {'archive': None, 'procs': []})['procs'].append(rp)
    return merged


def classify(merged, active_seconds, silent_seconds, now):
    """三档分类：running（有进程或归档活跃）/ silent（无进程、静默但历史无终态）/ 其余已结束。"""
    running, silent = {}, {}
    for k, v in merged.items():
        arc = v['archive']
        if v['procs'] or (arc and arc['active']):
            running[k] = v
        elif (arc and not arc['finished']
              and (now - arc['newest_mtime']) <= silent_seconds):
            silent[k] = v
    return running, silent


def attach_leftovers(leftovers, running, silent):
    """follow-xds-head-logs.sh 会 daemonize（重挂到 init），在跑运行的这类进程会被
    进程树误判为游离——按归档目录归属重新挂回运行条目，余下的才是真残留。"""
    attached = {}
    true_leftovers = []
    for l in leftovers:
        if l['archive'] and (l['archive'] in running or l['archive'] in silent):
            attached.setdefault(l['archive'], []).append(l)
        else:
            true_leftovers.append(l)
    return attached, true_leftovers


def main():
    args = sys.argv[1:]
    as_json = '--json' in args
    active_seconds = int(os.environ.get('ACTIVE_SECONDS') or '300')
    if '--active-seconds' in args:
        i = args.index('--active-seconds')
        active_seconds = int(args[i + 1])

    now = time.time()
    scripts_dir, archive_root, store_path = load_store_config()
    history_tags = load_history(store_path)
    procs = list_processes()
    web_pid = find_web_pid(procs)
    archive_runs = scan_archive(archive_root, active_seconds, now, history_tags)
    run_procs, leftovers = build_proc_view(procs, web_pid, archive_root, set(archive_runs.keys()))
    merged = merge_runs(archive_runs, run_procs)
    silent_seconds = int(os.environ.get('SILENT_SECONDS') or '21600')
    running, silent = classify(merged, active_seconds, silent_seconds, now)
    attached, leftovers = attach_leftovers(leftovers, running, silent)

    token = os.environ.get('DSH_AUTH_TOKEN') or ''
    port = int(os.environ.get('DSH_WEB_PORT') or '3051')
    queue, queue_err = (None, '未设置 DSH_AUTH_TOKEN，跳过服务端队列查询')
    if token:
        queue, queue_err = query_queue(port, token)

    if as_json:
        print(json.dumps({
            'webPid': web_pid, 'archiveRoot': archive_root, 'scriptsDir': scripts_dir,
            'running': running, 'silent': silent, 'attached': attached,
            'leftovers': leftovers,
            'queue': queue, 'queueError': queue_err,
        }, ensure_ascii=False, indent=2, default=str))
        return 0

    print('dsh web pid: %s    归档根: %s    活跃阈值: %ds' % (
        web_pid if web_pid else '未找到（进程证据不可用）', archive_root, active_seconds))
    print()

    def run_sort_key(k):
        v = merged[k]
        return ((v['archive'] or {}).get('start_ts') or
                now - min((p['etimes'] for p in v['procs']), default=0))

    def print_run(key, v):
        arc, prcs = v['archive'], v['procs']
        name = arc['pipeline'] if arc else '(归档未知)'
        start = arc['start_ts'] if arc else now - min(p['etimes'] for p in prcs)
        print()
        print('● %s   启动 %s（已运行 %s）' % (
            name, fmt_time(start), human_duration(now - start)))
        if arc:
            done = [s for s in arc['stages'] if s is not arc['current']]
            cur = arc['current']
            print('  当前阶段: %02d-%s（日志更新于 %s）  已完成阶段 %d 个  run %s' % (
                cur['seq'], cur['name'], fmt_time(cur['mtime']), len(done), arc['tag']))
            print('  归档: %s' % arc['dir'])
        for rp in prcs:
            print('  进程: %s (pid %d，已运行 %s，子进程 %d)' % (
                rp['script'], rp['pid'], human_duration(rp['etimes']), rp['subprocs']))
            if rp['target']:
                print('  目标: %s' % rp['target'])
            for ns in rp['namespaces']:
                print('  命名空间: %s' % ns)
        if not prcs:
            print('  （无本地脚本进程——HTTP/Jenkins 阶段或远端执行中）')
        for l in attached.get(key, []):
            print('  附属进程: %s (pid %d，已挂 %s，日志跟踪 daemon)' % (
                l['script'], l['pid'], human_duration(l['etimes'])))

    if not running:
        print('当前没有在跑的流水线。')
    else:
        print('正在运行的流水线（%d）：' % len(running))
        for key in sorted(running, key=run_sort_key):
            print_run(key, running[key])

    if silent:
        print()
        print('疑似在跑（日志静默 >%ds、历史无终态，可能远端静默执行或已中断）（%d）：'
              % (active_seconds, len(silent)))
        for key in sorted(silent, key=run_sort_key):
            arc = silent[key]['archive']
            print()
            print('? %s   启动 %s   run %s' % (
                arc['pipeline'], fmt_time(arc['start_ts']), arc['tag']))
            print('  最后阶段: %02d-%s（日志静默于 %s 前）' % (
                arc['current']['seq'], arc['current']['name'],
                human_duration(now - arc['current']['mtime'])))
            print('  归档: %s' % arc['dir'])
            for l in attached.get(key, []):
                print('  附属进程: %s (pid %d，已挂 %s，日志跟踪 daemon)' % (
                    l['script'], l['pid'], human_duration(l['etimes'])))

    print()
    if leftovers:
        print('残留脚本进程（%d，所属运行已结束，确认后可 kill）：' % len(leftovers))
        for l in leftovers:
            extra = ''
            arc = l['archive'] and archive_runs.get(l['archive'])
            if arc:
                fin = arc.get('finished') or {}
                extra = '  归档 %s（已结束: %s by %s）' % (
                    l['archive'], fin.get('status') or '?', fin.get('by') or '?')
            print('  pid %d  %s（已挂 %s）%s' % (
                l['pid'], l['script'], human_duration(l['etimes']), extra))
    else:
        print('无残留脚本进程。')

    print()
    if queue:
        server = queue.get('server') or {}
        print('服务端执行池：运行 %d，排队 %d' % (
            len(server.get('runs') or []), len(server.get('queue') or [])))
        for e in server.get('runs') or []:
            print(entry_line(e, 'startedAt'))
        for e in server.get('queue') or []:
            print(entry_line(e, 'queuedAt'))
        clients = [c for c in (queue.get('clients') or [])]
        if clients:
            print('浏览器客户端上报：')
            for c in clients:
                print('    %s（%ds 前上报）：运行 %d，排队 %d' % (
                    c.get('label') or c.get('id'), c.get('seenAgo', -1),
                    len(c.get('runs') or []), len(c.get('queue') or [])))
        orphans = queue.get('orphans') or []
        if orphans:
            print('失联孤儿条目：')
            for o in orphans:
                print('    %s  kind=%s  失联于 %s  （%s）' % (
                    o.get('pipelineName') or o.get('id'), o.get('kind'),
                    fmt_time((o.get('orphanedAt') or 0) / 1000.0), o.get('ownerLabel') or ''))
    else:
        print('服务端队列：%s' % queue_err)
        if not token:
            print('  （设置 DSH_AUTH_TOKEN=<dsh-auth-gate 会话 token> 可查看排队与孤儿条目）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
