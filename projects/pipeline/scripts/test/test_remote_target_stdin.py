"""离线检查 SSH/SCP 读取 stdin 时仍遍历全部目标；不连接或清理机器。"""
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

class RemoteTargets(unittest.TestCase):
    def test_all_targets(self):
        for script, action in (('cleanup-env.sh', 'standardize'), ('check-env.sh', 'check-health'), ('bnt-standalone.sh', 'standardize'), ('bnt-standalone.sh', 'check-health')):
            for hosts in ('192.168.0.128,192.168.0.78', '[{"ip":"192.168.0.128"},{"ip":"192.168.0.78"}]'):
                with self.subTest(script=script, action=action, hosts=hosts), tempfile.TemporaryDirectory() as folder:
                    root = pathlib.Path(folder)
                    for name in ('ssh', 'scp'):
                        stub = root / name
                        stub.write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> "$TRACE"\ncat >/dev/null\n')
                        stub.chmod(0o755)
                    env = dict(os.environ, PATH=folder+':'+os.environ['PATH'], TRACE=str(root/'trace'),
                               TARGET_HOSTS=hosts, SSH_PASSWORD='', TARGET_PASSWORD='', REMOTE_EXECUTION='0',
                               ACTION=action, LOG_FILE=str(root/'log'))
                    result = subprocess.run(['bash', str(ROOT/script)], env=env, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
                    calls=(root/'trace').read_text().splitlines()
                    self.assertEqual(len(calls), 4, calls)
                    self.assertTrue(all('ACTION='+action in call for call in calls if 'REMOTE_EXECUTION' in call))
                    self.assertEqual(sum('root@192.168.0.128' in c for c in calls), 2)
                    self.assertEqual(sum('root@192.168.0.78' in c for c in calls), 2)

if __name__ == '__main__':
    unittest.main()
