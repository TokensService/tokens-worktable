#!/usr/bin/env python3
"""pipeline_status 工具的离线单测：不依赖 dsh web、不读真实归档目录。"""
import importlib.util
import json
import os
import pathlib
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location(
    'pipeline_status', pathlib.Path(__file__).parents[1] / 'pipeline_status.py')
ps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ps)

NOW = time.time()


def make_run(root, dirname, stages, mtimes):
    """在临时归档根下造一个运行目录：stages=[(tag, seq, name)]，mtimes 与 stages 对齐。"""
    path = root / dirname
    path.mkdir(parents=True)
    for (tag, seq, name), mtime in zip(stages, mtimes):
        f = path / ('run-%s-%02d-%s.log' % (tag, seq, name))
        f.write_text('log of %s\n' % name)
        os.utime(f, (mtime, mtime))
    return path


class Regexes(unittest.TestCase):
    def test_stage_log(self):
        m = ps.STAGE_LOG_RE.match('run-1205-3312c-05-安装部署.log')
        self.assertEqual(m.groups(), ('1205-3312c', '05', '安装部署'))
        # 整 run 汇总日志（无阶段序号）不匹配
        self.assertIsNone(ps.STAGE_LOG_RE.match('run-1154-56bb0.log'))
        self.assertIsNone(ps.STAGE_LOG_RE.match('other.log'))

    def test_run_dir(self):
        m = ps.RUN_DIR_RE.match('压测decode性能（yxw）（副本-2）_20261009120518')
        self.assertEqual(m.group(1), '压测decode性能（yxw）（副本-2）')
        self.assertEqual(m.group(2), '20261009120518')
        self.assertIsNone(ps.RUN_DIR_RE.match('controller.log'))
        self.assertIsNone(ps.RUN_DIR_RE.match('notimestamp'))


class Helpers(unittest.TestCase):
    def test_human_duration(self):
        self.assertEqual(ps.human_duration(59), '59s')
        self.assertEqual(ps.human_duration(61), '1m01s')
        self.assertEqual(ps.human_duration(3723), '1h02m')

    def test_extract_target_host(self):
        args = 'sshpass -e ssh -p 22 -o StrictHostKeyChecking=no root@192.168.0.126 kubectl get pods'
        self.assertEqual(ps.extract_target_host(args), '192.168.0.126')
        args = 'sshpass -e ssh -p 2227 root@115.33.98.101 kubectl get ns'
        self.assertEqual(ps.extract_target_host(args), '115.33.98.101')
        self.assertIsNone(ps.extract_target_host('bash deploy-model.sh'))

    def test_extract_run_dir(self):
        known = {'流水线dev-wwx_20261009121804', '压测decode性能（yxw）（副本-2）_20261009120518'}
        args = 'bash follow-xds-head-logs.sh ns-a /var/log/op_test/流水线dev-wwx_20261009121804/xds_head_follow_logs_x'
        self.assertEqual(ps.extract_run_dir(args, '/var/log/op_test', known),
                         '流水线dev-wwx_20261009121804')
        # ps 输出里空格转义为 \ 时与磁盘目录做前缀对齐
        known2 = {'my pipe_20261009120000'}
        args2 = 'ssh host /var/log/op_test/my\\ pipe_20261009120000/logs'
        self.assertEqual(ps.extract_run_dir(args2, '/var/log/op_test', known2),
                         'my pipe_20261009120000')
        self.assertIsNone(ps.extract_run_dir('bash deploy-model.sh', '/var/log/op_test', known))


class Store(unittest.TestCase):
    def test_load_history(self):
        with tempfile.TemporaryDirectory() as td:
            store = os.path.join(td, 'worktable-pipeline.json')
            with open(store, 'w') as f:
                json.dump({'history': [
                    {'tag': '1218-55a47', 'status': 'failed', 'by': 'wuwanxu', 'dur': '4m31s', 'no': 1346},
                    {'status': 'success'},  # 无 tag 的坏记录被跳过
                    'garbage',
                ]}, f)
            tags = ps.load_history(store)
            self.assertEqual(set(tags), {'1218-55a47'})
            self.assertEqual(tags['1218-55a47']['status'], 'failed')
        # 文件缺失按空表
        self.assertEqual(ps.load_history('/nonexistent/store.json'), {})


class Archive(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self._td.name)

    def tearDown(self):
        self._td.cleanup()

    def test_scan_and_classify(self):
        history = {'1300-aaaa1': {'status': 'failed', 'by': 'u', 'dur': '1m', 'no': 1}}
        # 活跃运行：日志刚写入
        make_run(self.root, '活跃流水线_20261009120000',
                 [('1200-bbbb2', 1, '拉取镜像')], [NOW - 10])
        # 已结束运行：日志很新但 tag 在 history 中
        make_run(self.root, '已结束流水线_20261009130000',
                 [('1300-aaaa1', 1, '环境检查')], [NOW - 5])
        # 静默运行：日志旧、无终态
        make_run(self.root, '静默流水线_20261009080000',
                 [('0800-cccc3', 3, '安装部署')], [NOW - 3600])
        # 非运行目录与无 run 日志目录被忽略
        (self.root / 'controller.log').write_text('x')
        (self.root / '空目录_20261009100000').mkdir()

        runs = ps.scan_archive(str(self.root), 300, NOW, history)
        self.assertEqual(set(runs), {'活跃流水线_20261009120000', '已结束流水线_20261009130000',
                                     '静默流水线_20261009080000'})
        self.assertTrue(runs['活跃流水线_20261009120000']['active'])
        self.assertIsNone(runs['活跃流水线_20261009120000']['finished'])
        self.assertFalse(runs['已结束流水线_20261009130000']['active'])
        self.assertEqual(runs['已结束流水线_20261009130000']['finished']['status'], 'failed')
        self.assertFalse(runs['静默流水线_20261009080000']['active'])

        merged = ps.merge_runs(runs, [])
        running, silent = ps.classify(merged, 300, 21600, NOW)
        self.assertEqual(set(running), {'活跃流水线_20261009120000'})
        self.assertEqual(set(silent), {'静默流水线_20261009080000'})
        # 静默超窗后连疑似都不列
        _, silent2 = ps.classify(merged, 300, 1800, NOW)
        self.assertEqual(silent2, {})

    def test_proc_evidence_overrides_stale_log(self):
        # 有活跃进程时，即使日志静默也算在跑（运行根携带归档目录）
        make_run(self.root, '远端流水线_20261009120000',
                 [('1200-dddd4', 2, '安装部署')], [NOW - 7200])
        runs = ps.scan_archive(str(self.root), 300, NOW, {})
        rp = {'pid': 1, 'script': 'deploy-model.sh', 'etimes': 100,
              'archives': ['远端流水线_20261009120000'], 'namespaces': [], 'target': None, 'subprocs': 0}
        merged = ps.merge_runs(runs, [rp])
        running, silent = ps.classify(merged, 300, 21600, NOW)
        self.assertEqual(set(running), {'远端流水线_20261009120000'})
        self.assertEqual(silent, {})

    def test_attach_leftovers(self):
        running = {'在跑_20261009120000': {}}
        silent = {'静默_20261009080000': {}}
        leftovers = [
            {'pid': 1, 'script': 'follow-xds-head-logs.sh', 'etimes': 10,
             'archive': '在跑_20261009120000', 'args_tail': ''},
            {'pid': 2, 'script': 'follow-xds-head-logs.sh', 'etimes': 20,
             'archive': '静默_20261009080000', 'args_tail': ''},
            {'pid': 3, 'script': 'follow-xds-head-logs.sh', 'etimes': 30,
             'archive': '已结束_20261009110000', 'args_tail': ''},
            {'pid': 4, 'script': 'follow-xds-head-logs.sh', 'etimes': 40,
             'archive': None, 'args_tail': ''},
        ]
        attached, rest = ps.attach_leftovers(leftovers, running, silent)
        self.assertEqual(set(attached), {'在跑_20261009120000', '静默_20261009080000'})
        self.assertEqual([l['pid'] for l in rest], [3, 4])


class WebPid(unittest.TestCase):
    PROCS = [
        {'pid': 100, 'ppid': 1, 'etimes': 500, 'args': 'node /x/apps/cli/lib/bin.js web --port 3051'},
        {'pid': 200, 'ppid': 100, 'etimes': 100, 'args': 'bash /s/pipeline/scripts/deploy-model.sh'},
    ]

    def test_pid_file_preferred(self):
        with tempfile.TemporaryDirectory() as td:
            pid_file = os.path.join(td, 'dsh-web.pid')
            with open(pid_file, 'w') as f:
                f.write('100\n')
            self.assertEqual(ps.find_web_pid(self.PROCS, pid_file=pid_file), 100)

    def test_pid_file_stale_falls_back_to_scan(self):
        with tempfile.TemporaryDirectory() as td:
            pid_file = os.path.join(td, 'dsh-web.pid')
            with open(pid_file, 'w') as f:
                f.write('999999\n')  # 不存在/不匹配的 pid
            self.assertEqual(ps.find_web_pid(self.PROCS, pid_file=pid_file), 100)

    def test_not_found(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertIsNone(ps.find_web_pid([], pid_file=os.path.join(td, 'missing.pid')))


if __name__ == '__main__':
    unittest.main()
