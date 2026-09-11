import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

// 切片 GPU 状态查询段（含探针与路由），用 mock execFile 喂探针输出、真实 HTTP 请求验证解析。
const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const start = source.indexOf('  // ---- GPU 状态查询')
const end = source.indexOf('  const planRunning', start)
assert.notEqual(start, -1, 'src/index.ts 应有 GPU 状态查询段注释锚点')
assert.notEqual(end, -1, 'src/index.ts 应有 planRunning 锚点')
const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })

// 探针输出：=== 分 7 段（GPU 列表 / 计算进程 / 进程 cgroup / 容器清单 / 进程显存 / VmRSS / 容器 cgroup 内存）
const HEX = (prefix) => (prefix + '0'.repeat(64)).slice(0, 64)
function probeOut({ withMem = true } = {}) {
  const secs = [
    ['0, GPU-aaaa, 35, 12345, 24576', '1, GPU-bbbb, 0, 10, 24576'].join('\n'),
    ['123, GPU-aaaa, /usr/bin/python', '456, GPU-aaaa, /usr/local/bin/vllm'].join('\n'),
    [`123:${HEX('abc123')}`, `456:${HEX('def456')}`].join('\n'),
    ['abc123|xds-prefill|Up 3 days', 'def456|xds-decode|Up 2 hours'].join('\n'),
  ]
  if (withMem) {
    secs.push(
      ['123, 8192', '456, 10240'].join('\n'),
      ['123:1048576', '456:2097152'].join('\n'),
      ['123:2147483648', '456:4294967296'].join('\n'),
    )
  }
  return secs.join('\n===\n')
}

async function fixture(t, stdout) {
  const routes = new Map()
  const probes = []
  const execFile = (cmd, args, opts, cb) => {
    probes.push({ cmd, args })
    setTimeout(() => cb(null, stdout, ''), 0)
  }
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
  const ctx = vm.createContext({
    execFile, Buffer, setTimeout, networkInterfaces: () => ({}),
    webServer: { register: r => routes.set(r.path, r.handler) }, json,
    readJsonBody: async req => { let s = ''; for await (const c of req) s += c; return JSON.parse(s) },
  })
  vm.runInContext(code, ctx)
  const server = createServer((req, res) => routes.get(req.url)(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)) })
  return {
    ctx,
    probes,
    async post(body) {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/worktable/gpu`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      return r.json()
    },
  }
}

test('detail=true 返回进程显存/RSS/容器内存与显存总量', async t => {
  const f = await fixture(t, probeOut())
  const r = await f.post({ ip: '127.0.0.1', user: '', pass: '', detail: true })
  assert.equal(r.total, 2)
  assert.equal(r.used, 1)
  assert.equal(r.gpus[0].memTotal, '24576')
  assert.deepEqual(r.containers, ['xds-prefill', 'xds-decode'])
  const [p1, p2] = r.procs
  assert.equal(p1.container, 'xds-prefill')
  assert.equal(p1.up, 'Up 3 days')
  assert.equal(p1.gpuMem, '8192')
  assert.equal(p1.rss, '1024.0')
  assert.equal(p1.cgMem, '2048.0')
  assert.equal(p2.gpuMem, '10240')
  assert.equal(p2.rss, '2048.0')
  assert.equal(p2.cgMem, '4096.0')
  // detail 探针追加内存段（cgroup memory.current 与 VmRSS 采集）
  assert.ok(f.probes[0].args[1].includes('memory.current'))
  assert.ok(f.probes[0].args[1].includes('VmRSS'))
})

test('非 detail 调用响应保持原样（无内存字段、探针不追加内存段）', async t => {
  const f = await fixture(t, probeOut({ withMem: false }))
  const r = await f.post({ ip: '127.0.0.1', user: '', pass: '' })
  assert.equal(r.total, 2)
  assert.equal('gpuMem' in r.procs[0], false)
  assert.equal('rss' in r.procs[0], false)
  assert.equal('cgMem' in r.procs[0], false)
  assert.equal('memTotal' in r.gpus[0], false)
  assert.ok(!f.probes[0].args[1].includes('memory.current'))
})

test('探针缺内存段时 detail 字段降级为空串', async t => {
  const f = await fixture(t, probeOut({ withMem: false }))
  const r = await f.post({ ip: '127.0.0.1', detail: true })
  assert.equal(r.procs[0].gpuMem, '')
  assert.equal(r.procs[0].rss, '')
  assert.equal(r.procs[0].cgMem, '')
  assert.equal(r.gpus[0].memTotal, '24576')
})

test('nvidia-smi 无输出返回 error（HTTP 仍 200）', async t => {
  const f = await fixture(t, '\n===\n\n===\n\n===\n')
  const r = await f.post({ ip: '127.0.0.1', detail: true })
  assert.match(r.error, /nvidia-smi 无输出/)
})

test('parseHostPort 拆 IP:端口，IPv6 多冒号整体作 host', async t => {
  const f = await fixture(t, probeOut())
  const run = (expr) => JSON.parse(JSON.stringify(vm.runInContext(expr, f.ctx)))
  assert.deepEqual(run('parseHostPort("115.33.98.101:2222")'), { host: '115.33.98.101', port: '2222' })
  assert.deepEqual(run('parseHostPort("::1")'), { host: '::1', port: '' })
  assert.deepEqual(run('parseHostPort("10.0.0.1")'), { host: '10.0.0.1', port: '' })
})
