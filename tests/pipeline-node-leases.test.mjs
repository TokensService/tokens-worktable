// 节点占用租约与执行池节点调度：同一节点（环境 IP）同一时间只跑一条流水线——
// 租约工厂语义（互斥/原子/续租/TTL）、执行池 hooks（同机串行/异机并行/池外租约等待重试/
// 无目标 IP 保持旧 FIFO）、/api/worktable/pipeline/leases 路由全链路。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))   // vm 沙盒产物的原型链与主 realm 不同，深比较前先归一化

/* 与 pipeline-run-api.test.mjs 同一抽取方式：API 触发区段自带 createPipelineNodeLeases /
   pipelineEnvIps / pipelineLeaseOwner / createPipelineExecutionQueue 真身 */
function loadApiRegion() {
  const start = source.indexOf('/* ---------- 流水线 API 触发 ---------- */')
  const end = source.indexOf('/* ---------- 流水线 API 触发结束 ---------- */', start)
  assert.ok(start >= 0 && end > start, '流水线 API 触发实现未找到')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const ctx = { URL, Promise, Buffer, AbortController, setTimeout, clearTimeout, console, pathResolve: (p) => p, json() {} }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return ctx
}

test('节点租约：同节点互斥、异节点并行、多 IP 原子申请、同人续租保留起始时间、释放后可占用', () => {
  const ctx = loadApiRegion()
  let now = 1000 * 1000
  const leases = ctx.createPipelineNodeLeases(90 * 1000, () => now)
  assert.deepEqual(plain(leases.acquire('run-a', ['10.0.0.1'], '流水线A', 'alice')), { ok: true })
  const denied = leases.acquire('run-b', ['10.0.0.1'], '流水线B', 'bob')
  assert.equal(denied.ok, false, '同一节点不能同时跑两条流水线')
  assert.deepEqual(plain(denied.conflicts), [{ ip: '10.0.0.1', owner: 'run-a', label: '流水线A', by: 'alice', since: 1000 * 1000 }])
  assert.equal(leases.acquire('run-b', ['10.0.0.2'], '流水线B', 'bob').ok, true, '不同节点互不阻塞')
  const multi = leases.acquire('run-c', ['10.0.0.3', '10.0.0.2'], '流水线C', 'cat')
  assert.equal(multi.ok, false, '多 IP 任一被占即整体失败')
  assert.deepEqual(plain(multi.conflicts.map(c => c.ip)), ['10.0.0.2'])
  assert.equal(leases.list().filter(l => l.owner === 'run-c').length, 0, '冲突时一个 IP 都不占用（原子性）')
  now += 30000
  assert.equal(leases.acquire('run-a', ['10.0.0.1'], '流水线A', 'alice').ok, true, '持有方续租成功')
  const held = leases.list().find(l => l.ip === '10.0.0.1')
  assert.equal(held.since, 1000 * 1000, '续租保留首次占用时间')
  assert.equal(held.seenAgo, 0, '刚续租 seenAgo 为 0')
  now += 5000
  assert.equal(leases.list().find(l => l.ip === '10.0.0.1').seenAgo, 5, '占用表按秒回报距今时间')
  assert.equal(leases.release('run-a'), 1)
  assert.equal(leases.release('run-a'), 0, '重复释放幂等')
  assert.equal(leases.acquire('run-b', ['10.0.0.1'], '', '').ok, true, '释放后他方可占用')
})

test('节点租约：持有方崩溃未释放时到期自动释放（TTL）', () => {
  const ctx = loadApiRegion()
  let now = 0
  const leases = ctx.createPipelineNodeLeases(90 * 1000, () => now)
  assert.equal(leases.acquire('run-a', ['10.0.0.1'], '', '').ok, true)
  now += 89 * 1000
  assert.equal(leases.acquire('run-b', ['10.0.0.1'], '', '').ok, false, 'TTL 内仍被占用')
  now += 2000
  assert.equal(leases.acquire('run-b', ['10.0.0.1'], '', '').ok, true, '超过 TTL 自动释放，节点不被永久锁死')
})

test('pipelineEnvIps / pipelineLeaseOwner：提取目标节点 IP 与租约持有方标识', () => {
  const ctx = loadApiRegion()
  assert.deepEqual(plain(ctx.pipelineEnvIps([{ ip: ' A ' }, { ip: 'B' }, { ip: 'A' }, {}, null])), ['A', 'B'])
  assert.deepEqual(plain(ctx.pipelineEnvIps(null)), [])
  assert.deepEqual(plain(ctx.pipelineEnvIps([])), [])
  assert.equal(ctx.pipelineLeaseOwner({ runId: 'api-1', id: 'p1' }), 'api-1', 'API 运行优先逐次 runId')
  assert.equal(ctx.pipelineLeaseOwner({ id: 'p1' }), 'p1', '定时计划用计划 id')
  assert.equal(ctx.pipelineLeaseOwner(null), 'plan-unknown')
})

test('执行池：同一节点的计划串行排队，不同节点并行，池外租约占用时等待重试', async () => {
  const ctx = loadApiRegion()
  let now = 0
  const leases = ctx.createPipelineNodeLeases(90 * 1000, () => now)
  const hooks = {
    ipsOf: plan => plan.ips || [],
    acquire: (plan, ips) => leases.acquire(plan.runId, ips, plan.pipelineName || '', '').ok,
    release: plan => { leases.release(plan.runId) },
    retryMs: 20,
  }
  const started = []
  const releases = []
  const pool = ctx.createPipelineExecutionQueue(async plan => {
    started.push(plan.id)
    await new Promise(resolve => releases.push(resolve))
  }, 2, 10, hooks)
  const plan = (id, runId, ips) => ({ id, runId, ips })
  const runs = [pool.run(plan('A1', 'ra1', ['X'])), pool.run(plan('A2', 'ra2', ['X'])), pool.run(plan('B1', 'rb1', ['Y']))]
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started.slice().sort(), ['A1', 'B1'], '同节点 A2 排队，异节点 B1 并行')
  assert.equal(leases.list().length, 2, '在跑计划各自持有节点租约')
  assert.equal(leases.acquire('page-run', ['Z'], '页面运行', 'bob').ok, true, '池外（页面手动运行）先占节点 Z')
  const z1 = pool.run(plan('Z1', 'rz1', ['Z']))
  releases.shift()()   // A1 完成 → 租约释放 → 同节点的 A2 按序启动
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(started.includes('A2'), true, '在跑结束后同节点排队计划按序启动')
  releases.shift()()   // B1 完成 → 空出槽位，但 Z1 的节点仍被池外租约占用
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(started.includes('Z1'), false, '节点被池外租约占用：留在队列等待（retryMs 重试也不抢占）')
  leases.release('page-run')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(started.includes('Z1'), true, '池外租约释放后按 retryMs 重试启动')
  while (releases.length) releases.shift()()
  await Promise.all([...runs, z1])
  await new Promise(resolve => setImmediate(resolve))   // 等 pool finally 释放租约
  assert.equal(leases.list().length, 0, '全部结束后租约释放干净')
})

test('执行池：无目标 IP 的计划不按节点约束（保持旧版纯 FIFO 行为）', async () => {
  const ctx = loadApiRegion()
  const hooks = {
    ipsOf: () => [],
    acquire: () => { throw new Error('无目标 IP 不应申请租约') },
    release: () => { throw new Error('无目标 IP 不应释放租约') },
  }
  const started = []
  const pool = ctx.createPipelineExecutionQueue(async plan => { started.push(plan.id) }, 2, 10, hooks)
  await Promise.all([pool.run({ id: 'p1' }), pool.run({ id: 'p2' }), pool.run({ id: 'p3' })])
  assert.deepEqual(started, ['p1', 'p2', 'p3'])
})

/* 租约路由：acquire/conflict/list/release 全链路（vm 抽取 apply 内的真实路由块） */
function loadLeaseRoute() {
  const marker = '  /* 节点占用租约（跨标签页'
  const start = source.indexOf(marker)
  const end = source.indexOf('  // AI 日志分析', start)
  assert.ok(start >= 0 && end > start, '节点租约路由块未找到')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const routes = new Map()
  const ctx = {
    webServer: { register: r => routes.set(r.path, r.handler) },
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) },
    readJsonBody: async req => JSON.parse(req.bodyText),
    createPipelineNodeLeases: loadApiRegion().createPipelineNodeLeases,
    console,
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  assert.ok(routes.get('/api/worktable/pipeline/leases'), '缺少节点租约路由')
  return { handler: routes.get('/api/worktable/pipeline/leases') }
}

function leaseResponse() {
  return {
    status: 0, body: '',
    writeHead(s) { this.status = s },
    end(b) { this.body = b == null ? '' : String(b) },
    json() { return this.body ? JSON.parse(this.body) : null },
  }
}

test('租约路由：申请/冲突/占用表/批量释放 全链路', async () => {
  const { handler } = loadLeaseRoute()
  const call = async body => {
    const res = leaseResponse()
    await handler({ method: body ? 'POST' : 'GET', bodyText: body ? JSON.stringify(body) : '' }, res)
    return res
  }
  let res = await call({ action: 'acquire', runId: 'r1', ips: ['10.0.0.1', '10.0.0.2'], label: '发布', by: 'alice' })
  assert.deepEqual(res.json(), { ok: true })
  res = await call({ action: 'acquire', runId: 'r2', ips: ['10.0.0.2'], label: '构建', by: 'bob' })
  assert.equal(res.json().ok, false)
  assert.equal(res.json().conflicts[0].ip, '10.0.0.2')
  assert.equal(res.json().conflicts[0].by, 'alice')
  res = await call(null)
  assert.equal(res.json().leases.length, 2, 'GET 返回当前占用表')
  res = await call({ action: 'release', runIds: ['r1'] })   // pagehide beacon 的批量形态
  assert.deepEqual(res.json(), { ok: true, released: 2 })
  res = await call({ action: 'acquire', runId: 'r2', ips: ['10.0.0.2'] })
  assert.equal(res.json().ok, true, '释放后他方可占用')
  res = await call({ action: 'release', runId: 'r1' })
  assert.equal(res.json().released, 0, '已不持有时释放幂等')
  res = await call({ action: 'acquire', runId: 'r3', ips: [] })
  assert.equal(res.status, 400, '缺 ips 拒绝')
  res = await call({ action: 'bogus', runId: 'r3', ips: ['10.0.0.9'] })
  assert.equal(res.status, 400, '未知 action 拒绝')
  res = await call({ action: 'release' })
  assert.equal(res.status, 400, '缺 runId 拒绝')
})
