#!/usr/bin/env python3
# -*-coding:utf-8 -*-
# 打流平台自定义作业：清理 XDS+LMCache 三层缓存
#   L1  (DRAM)          sidecar POST /cache/clear（端口从 /etc/lmcache-ports/ports.env 动态发现）
#   HBM (prefix cache)  XDS OM diagnose reset_prefix_cache（轮询引擎日志确认 success）
#   L2  (fs_native 磁盘) sidecar 容器内 find -delete（按 node:path 去重，文件数归零验证）
# 实现方式：SSH 到目标机（需挂载 /mnt/paas 且具备 kubectl/curl/python3），
# 执行 tokens-worktable 仓的 clear-lmcache-cache.sh，复用其全部清理与验证逻辑。
import os
import re
import shlex
import socket

import paramiko

from yunqi_sdk import WeaponBase, runner, logger, TASK_RESULT_PATH, FLAGS, MODE

# 清理脚本位置（按序探测，命中即用）：
#   1. /opt/op-test/bin/clear-lmcache-cache.sh —— gy1 各节点本地，由仓库
#      distribute-clear-lmcache.sh 统一分发（脚本升级后重跑分发即可）
#   2. tokens-worktable 仓共享存储路径 —— 兜底（弹性新节点未分发时仍可执行）
SCRIPT_CANDIDATES = (
    '/opt/op-test/bin/clear-lmcache-cache.sh',
    ('/mnt/paas/lichangsong/projects/TokensService/'
     'tokens-worktable/projects/pipeline/scripts/clear-lmcache-cache.sh'),
)
SUCCESS_MARK = '__LMCACHE_CLEAR_OK__'
SSH_CMD_TIMEOUT = 1500  # L2 大目录删除可能持续数分钟，整体上限 25 分钟


def as_bool(value, default=True):
    if value is None or value == '':
        return default
    return str(value).strip().lower() in ('true', '1', 'yes', 'y')


def normalize_endpoint(endpoint):
    """endpoint 入参为 host:port；容忍误带 http:// 前缀或路径，统一输出 http://host:port"""
    endpoint = str(endpoint or '').strip().rstrip('/')
    if not endpoint:
        return ''
    match = re.match(r'^https?://([^/]+)', endpoint)
    if match:
        return 'http://' + match.group(1)
    return 'http://' + endpoint.split('/')[0]


def ssh_login(hostname, username, password, port=22):
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(hostname, port=int(port), username=username, password=password)
    return ssh


def ssh_execute_cmd(ssh, cmd, timeout=SSH_CMD_TIMEOUT):
    log_info = cmd if len(cmd) <= 80 else cmd[:80] + '...'
    logger.info('执行命令: ' + log_info)
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    try:
        output = stdout.read().decode('utf-8', errors='ignore')
        output += stderr.read().decode('utf-8', errors='ignore')
    except socket.timeout:
        raise Exception(f'命令执行超时({timeout}s): {log_info}')
    logger.info('输出信息: ' + output)
    return output


def task_switches(task, reset_hbm):
    """task 入参映射到 clear-lmcache-cache.sh 的 CLEAR_L1 / CLEAR_HBM / CLEAR_L2 开关"""
    task = (task or 'clear').strip().lower()
    if task == 'clear':        # 默认：三层全清（HBM 仍受 reset_prefix_cache 控制）
        clear_l1, clear_l2 = '1', '1'
    elif task == 'hbm':        # 仅清 HBM
        clear_l1, clear_l2 = '0', '0'
    elif task == 'l1':         # 仅清 L1 (DRAM)
        clear_l1, clear_l2 = '1', '0'
    elif task == 'l2':         # 仅清 L2 (磁盘)
        clear_l1, clear_l2 = '0', '1'
    else:
        raise Exception(f"不支持的 task: {task}（可选 clear / hbm / l1 / l2）")
    clear_hbm = '1' if (task == 'hbm' or reset_hbm) else '0'
    return clear_l1, clear_hbm, clear_l2


class WeaponExecute(WeaponBase):
    def run(self):
        logger.info('开始执行 LMCache 缓存清理作业')
        hostname = self.param['hostname']
        username = self.param['username']
        password = self.param['password']
        port = self.param.get('port') or 22
        task = self.param.get('task') or 'clear'
        namespace = (self.param.get('namespace') or '').strip()   # 留空时脚本自动发现
        endpoint = normalize_endpoint(self.param.get('endpoint'))
        reset_hbm = as_bool(self.param.get('reset_prefix_cache'), default=True)
        script_path = (self.param.get('script_path') or '').strip()
        if script_path:
            candidates = [script_path]  # 显式指定时不做探测
        else:
            candidates = list(SCRIPT_CANDIDATES)
        resolve = ('script_path=$(for p in ' + ' '.join(shlex.quote(p) for p in candidates)
                   + '; do [ -f "$p" ] && { printf %s "$p"; break; }; done)')
        missing_hint = '或'.join(candidates)
        result_check = self.param.get('result_check')

        clear_l1, clear_hbm, clear_l2 = task_switches(task, reset_hbm)
        env = {
            'NAMESPACE': namespace,
            'DRY_RUN': '0',
            'CLEAR_L1': clear_l1,
            'CLEAR_HBM': clear_hbm,
            'CLEAR_L2': clear_l2,
            'IDLE_CHECK': '1',      # 清 L2 前校验入口流量已空闲（最近请求<60s 中止，防打断在途请求）
            'HBM_VERIFY': '1',      # reset 后轮询引擎日志逐引擎确认 success，异常响亮报错
        }
        if endpoint:
            # XDS OM 地址；留空则脚本从 ray-svc NodePort 自动发现
            env['FE_URL'] = endpoint

        env_prefix = ' '.join(f'{key}={shlex.quote(str(value))}' for key, value in env.items())
        cmd = (
            f"{resolve}; [ -n \"$script_path\" ] || {{ echo "
            f'"ERROR: 未找到清理脚本: {missing_hint}" >&2; exit 2; }}; '
            f'{env_prefix} bash "$script_path" && echo {SUCCESS_MARK}'
        )

        ssh = ssh_login(hostname, username, password, int(port))
        try:
            result = ssh_execute_cmd(ssh, cmd)
        finally:
            ssh.close()

        # result_check 语义（与平台既有作业一致：回显中不包含期望值即报错中止）：
        #   true(默认) -> 检查内置成功标记（脚本退出码 0 才输出，同时覆盖"退出码失败但回显看似正常"）
        #   false      -> 关闭回显检查
        #   其他字符串 -> 按正则在回显中查找
        rc_value = str(result_check).strip() if result_check is not None else 'true'
        if rc_value.lower() in ('true', '1', 'yes', 'y'):
            expect = SUCCESS_MARK
        elif rc_value.lower() in ('false', '0', 'no', 'n', ''):
            expect = ''
        else:
            expect = rc_value
        if expect and re.search(expect, result) is None:
            raise Exception(f'结果检查失败, expect result: [{expect}], but get result: {result}')

        with os.fdopen(os.open(
                os.path.join(TASK_RESULT_PATH.format(task_id=self.task_id), 'result.txt'),
                FLAGS, MODE), 'w', encoding='utf-8', errors='ignore') as file:
            file.write(result)
        logger.info('LMCache 缓存清理作业执行完成')


if __name__ == '__main__':
    runner(WeaponExecute())
