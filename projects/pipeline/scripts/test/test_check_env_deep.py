#!/usr/bin/env python3
"""离线验证 CNI、代理和内存门槛，不操作集群。"""
import pathlib
import unittest
import json
from unittest.mock import patch

script = pathlib.Path(__file__).parents[1] / 'check-env.sh'
text = script.read_text()
code = text.split("<<'PY_HEALTH'\n", 1)[1].split('\nPY_HEALTH', 1)[0]
ns = {'__name__': 'test_health'}
exec(compile(code, str(script), 'exec'), ns)

class Checks(unittest.TestCase):
    def test_cni_chain(self):
        good = {'cniVersion':'0.3.1', 'name':'default-network', 'plugins':[
            {'type':'vpc-router','capabilities':{'bandwidth':True},'ipam':{'subnet':'10.0.0.0/16'},'args':{'phynet':'phy_net1'}},
            {'type':'portmap','capabilities':{'portMappings':True},'externalSetMarkChain':'KUBE-MARK-MASQ'}]}
        self.assertEqual(ns['cni_errors'](good), [])
        good['plugins'].reverse()
        self.assertTrue(ns['cni_errors'](good))
        self.assertTrue(ns['cni_errors']({'plugins':[]}))

    def test_hugepage_boundary(self):
        g = 1024**3
        self.assertEqual(ns['memory_level'](3000*g,700*g,2048*g,2048*g,700*g), 'PASS')
        self.assertEqual(ns['memory_level'](3000*g,699*g,2048*g,2048*g,700*g), 'FAIL')
        # 预留但尚未实际使用的大页也占普通内存。
        self.assertEqual(ns['memory_level'](3000*g,500*g,2048*g,2048*g,700*g), 'FAIL')
        self.assertEqual(ns['memory_level'](3000*g,1500*g,0,2048*g,700*g), 'PASS')

    def test_proxy_secrets(self):
        self.assertEqual(ns['proxy_keys']({'HTTPS_PROXY':'http://user:secret@host:8080','no_proxy':'*'}), ['HTTPS_PROXY'])
        self.assertEqual(ns['proxy_keys']({'HTTP_PROXY':'','NO_PROXY':'localhost'}), [])

    def test_proxy_scope_severity(self):
        env = {'HTTPS_PROXY': 'http://user:secret@proxy:3128'}
        for scope in ('检查进程', '/etc/environment'):
            self.assertEqual(ns['proxy_level'](scope, env), 'WARN')
        for scope in ('containerd运行进程', 'kubelet运行进程'):
            self.assertEqual(ns['proxy_level'](scope, env), 'FAIL')
        self.assertEqual(ns['proxy_level']('检查进程', {'NO_PROXY': '*'}), 'PASS')

    def test_memory_units(self):
        self.assertEqual(ns['quantity']('1410G'),1410*10**9)
        self.assertEqual(ns['quantity']('24Gi'),24*1024**3)
        self.assertEqual(ns['quantity']('100Mi'),100*1024**2)

class Network(unittest.TestCase):
    def run_probe(self, fail_exec=False, fail_create=False, peer='b', image='python:cached', cached=False):
        calls=[]; created={}; reports=[]
        def fake(args, **kwargs):
            calls.append(args)
            if args[:3]==['kubectl','get','nodes']:
                return json.dumps({'items':[{'metadata':{'name':n,'labels':{'kubernetes.io/hostname':n}},'spec':{},'status':{'conditions':[{'type':'Ready','status':'True'}], 'images':[{'names':None}, {'names':['registry.example/xds:cached-'+n]}] if cached else None}} for n in ['a','b']]})
            if args[:3]==['kubectl','get','pods']:return '{"items":[]}'
            if 'create' in args:
                pod=json.loads(kwargs['input']);created[pod['metadata']['name']]=pod
                self.assertFalse(pod['spec']['hostNetwork'])
                self.assertEqual(pod['spec']['containers'][0]['image'], image or 'registry.example/xds:cached-'+pod['spec']['nodeSelector']['kubernetes.io/hostname'])
                self.assertFalse(pod['spec']['automountServiceAccountToken'])
                if fail_create:raise RuntimeError('simulated timeout after creation')
            if 'get' in args and 'pod' in args:
                pod=created[args[5]]
                pod['spec']['nodeName']=pod['spec']['nodeSelector']['kubernetes.io/hostname']
                pod['status']={'podIP':'10.0.0.'+('1' if pod['spec']['nodeName']=='a' else '2')}
                return json.dumps(pod)
            if 'exec' in args and fail_exec:raise RuntimeError('unreachable')
            return ''
        with patch.dict(ns,command=fake,report=lambda *r:reports.append(r)), patch.dict(ns['os'].environ,{'HEALTH_NODE':'a','NETWORK_TEST_PEER':peer,'NETWORK_TEST_IMAGE':image},clear=True):
            if fail_create:
                with self.assertRaises(RuntimeError):ns['check_cross_node']()
            else:ns['check_cross_node']()
        return calls,reports

    def test_clean_nodes_use_cached_images(self):
        calls,reports=self.run_probe(image='', cached=True)
        self.assertEqual(sum('exec' in c for c in calls),2)
        self.assertEqual(sum('delete' in c for c in calls),2)
        self.assertFalse(any(r[0]=='FAIL' for r in reports))

    def test_missing_images_still_fails(self):
        calls,reports=self.run_probe(image='')
        self.assertFalse(any('create' in c for c in calls))
        self.assertTrue(any(r[0]=='FAIL' for r in reports))

    def test_bidirectional_and_cleanup(self):
        calls,reports=self.run_probe()
        self.assertEqual(sum('exec' in c for c in calls),2)
        self.assertEqual(sum('delete' in c for c in calls),2)
        self.assertFalse(any(r[0]=='FAIL' for r in reports))

    def test_failure_still_reverse_and_cleanup(self):
        calls,reports=self.run_probe(fail_exec=True)
        self.assertEqual(sum('exec' in c for c in calls),2)
        self.assertEqual(sum('delete' in c for c in calls),2)
        self.assertEqual(sum(r[0]=='FAIL' for r in reports),2)

    def test_create_timeout_cleanup(self):
        calls,_=self.run_probe(fail_create=True)
        self.assertEqual(sum('delete' in c for c in calls),1)

    def test_same_node_rejected(self):
        calls,reports=self.run_probe(peer='a')
        self.assertFalse(any('create' in c for c in calls))
        self.assertEqual(reports[0][0],'FAIL')

if __name__ == '__main__':
    unittest.main()
