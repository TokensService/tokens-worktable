// 执行池终态发布（server.finished）：已开始运行到达终态（成功/失败/取消）后进入内存环形缓冲，
// 随执行池/代际管理器快照与 GET /api/worktable/pipeline/queue 的 server.finished 下发——
// 覆盖三类终态映射、契约字段、最新在前、TTL/上限 prune、排队即取消不入、多代际透传与白名单清洗。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))   // vm 沙盒产物的原型链与主 realm 不同，深比较前先归一化

/* 与 pipeline-node-leases.test.mjs 同一抽取方式：API 触发区段自带 createPipelineExecutionQueue /
   createPipelineGenerationManager 真身 */
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

/* 与 pipeline-queue-presence.test.mjs 同一 vm 抽取 harness：运行队列路由段 */
function loadQueueRoute(overrides = {}) {
  const start = source.indexOf('  /* 服务端权威执行池的状态由本路由 GET 实时下发；')
  const end = source.indexOf('  /* 节点占用租约（跨标签页/跨浏览器/API/定时统一的节点互斥', start)
  assert.ok(start >= 0 && end > start, '运行队列在场路由未找到')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  let handler
  const context = {
    URL,
    webServer: { register(route) { handler = route.handler } },
    readJsonBody: async req => req.body || {},
    json(res, status, body) { res.writeHead(status); res.end(JSON.stringify(body)) },
    pipelineExecutions: overrides.pipelineExecutions || { snapshot: () => ({ runs: [], queue: [] }), cancel: () => ({ ok: false, state: 'missing' }) },
    console,
    setTimeout, clearTimeout,
    DSH_HOME: '/nonexistent-dsh-home',
    pathResolve: (...parts) => parts.join('/'),
    readFile: async () => { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err },
    writeJsonAtomic: async () => {},
  }
  vm.createContext(context)
  vm.runInContext(code, context)
  return handler
}

function response() {
  return {
    status: 0, body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body == null ? '' : String(body) },
    json() { return this.body ? JSON.parse(this.body) : null },
  }
}

async function callQueue(handler, method, body) {
  const res = response()
  await handler({ method, body, url: '/api/worktable/pipeline/queue' }, res)
  return res
}

const planOf = (id, extra = {}) => ({
  id, runId: id, pipelineId: 'pipe-1', pipelineName: '发布流水线', by: 'alice', source: 'api',
  stages: [{ id: 's1', name: '阶段一' }, { id: 's2', name: '阶段二' }],
  ...extra,
})

test('终态映射：成功/失败/取消都进 finished，字段符合 FinishedEntry 契约', async () => {
  const ctx = loadApiRegion()
  let now = 1_000_000
  const pool = ctx.createPipelineExecutionQueue(async (plan, runtime) => {
    runtime.updateStage('s1', { status: plan.s1Status || 'success', dur: 1.5 })
    now += 700   // 运行耗时 0.7s（注入时钟）
    if (plan.mode === 'resolve-failed') return 'failed'
    if (plan.mode === 'reject-plain') throw new Error('boom')
    if (plan.mode === 'reject-cancel') { const e = new Error('pipeline run cancelled'); e.name = 'AbortError'; e.code = 'PIPELINE_RUN_CANCELLED'; throw e }
    if (plan.mode === 'swallow-abort') {   // 执行器吞掉中止（resolve 且无状态回报）：按池侧取消信号判 cancelled
      await new Promise(resolve => runtime.signal.addEventListener('abort', resolve, { once: true }))
      return undefined
    }
    return 'success'
  }, 1, 10, { nowFn: () => now })

  await pool.run(planOf('ok'))
  await pool.run(planOf('fail-outcome', { mode: 'resolve-failed', s1Status: 'failed' }))
  await assert.rejects(pool.run(planOf('fail-throw', { mode: 'reject-plain', s1Status: 'failed' })), /boom/)
  await assert.rejects(pool.run(planOf('cancel-throw', { mode: 'reject-cancel' })), e => e?.code === 'PIPELINE_RUN_CANCELLED')
  const swallowed = pool.run(planOf('cancel-swallow', { mode: 'swallow-abort' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pool.cancel('cancel-swallow').ok, true)
  await swallowed

  const finished = plain(pool.snapshot().finished)
  assert.equal(finished.length, 5)
  assert.deepEqual(finished.map(e => [e.id, e.status]), [
    ['cancel-swallow', 'cancelled'],
    ['cancel-throw', 'cancelled'],
    ['fail-throw', 'failure'],
    ['fail-outcome', 'failure'],
    ['ok', 'success'],
  ], '最新在前；显式回报/拒绝/池侧取消信号三类来源都正确映射')

  const ok = finished[4]
  assert.deepEqual({ ...ok, startedAt: 0, endedAt: 0, dur: 0 }, {
    id: 'ok', pipelineId: 'pipe-1', pipelineName: '发布流水线', by: 'alice', source: 'api',
    status: 'success', dur: 0, startedAt: 0, endedAt: 0,
    stages: [{ stage: '阶段一', status: 'success', dur: 1.5 }, { stage: '阶段二', status: 'idle', dur: 0 }],
  }, '契约字段白名单：无日志/变量/凭据，stages 只有 stage/status/dur')
  assert.equal(ok.dur, 0.7, 'dur 为秒（注入时钟前进 700ms）')
  assert.equal(ok.endedAt - ok.startedAt, 700, 'startedAt/endedAt 为 ms epoch')
  assert.equal(JSON.stringify(finished).includes('boom'), false, '失败原因不进 finished')
})

test('排队即取消不入 finished；保留策略：上限 20 丢最旧、TTL 120s 惰性 prune', async () => {
  const ctx = loadApiRegion()
  let now = 1_000_000
  let release
  const pool = ctx.createPipelineExecutionQueue(async () => { await new Promise(resolve => { release = resolve }) }, 1, 10, { nowFn: () => now })
  const running = pool.run(planOf('running'))
  const queued = pool.run(planOf('queued'))
  queued.catch(() => {})
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(plain(pool.cancel('queued')), { ok: true, state: 'queued' })
  release()
  await running
  assert.deepEqual(plain(pool.snapshot().finished).map(e => e.id), ['running'], '从未开始的排队项不进 finished')

  /* 上限 20：再连续跑 21 条，最旧的（含 running）被挤出 */
  const fast = ctx.createPipelineExecutionQueue(async () => 'success', 1, 10, { nowFn: () => now })
  for (let i = 0; i < 21; i += 1) await fast.run(planOf('bulk-' + String(i).padStart(2, '0')))
  const capped = plain(fast.snapshot().finished)
  assert.equal(capped.length, 20)
  assert.equal(capped[0].id, 'bulk-20', '最新在前')
  assert.equal(capped[19].id, 'bulk-01', '超上限丢最旧')

  /* TTL 120s：注入时钟跨过 TTL 后读取即 prune（惰性，不起定时器） */
  now += 121 * 1000
  assert.deepEqual(plain(fast.snapshot().finished), [], 'endedAt 距今超 120s 的终态被惰性 prune')
  assert.deepEqual(plain(pool.snapshot().finished), [])
})

test('多代际：旧代 drain 期间与退役后的终态都能从管理器快照读到', async () => {
  const ctx = loadApiRegion()
  /* 管理器聚合层的 prune 用真实时钟（nowFn 是池级测试注入钩子），本用例全程真实时间；
     退役簿 TTL prune 的逻辑与池级同构，已由上一个用例覆盖 */
  const manager = ctx.createPipelineGenerationManager()
  let releaseOld
  const old = ctx.createPipelineExecutionQueue(async () => { await new Promise(resolve => { releaseOld = resolve }); return 'success' }, 1, 10, { generation: 'g-old' })
  manager.activate('g-old', old)
  const oldRun = manager.run(planOf('old-run'))
  await new Promise(resolve => setImmediate(resolve))

  /* 切换 active：旧代停止接收但 drain 继续 */
  const newer = ctx.createPipelineExecutionQueue(async () => 'success', 1, 10, { generation: 'g-new' })
  manager.activate('g-new', newer)
  const newRun = manager.run(planOf('new-run'))
  await newRun
  releaseOld()
  await oldRun   // 旧代 drain 期间到达终态

  const during = plain(manager.snapshot().finished)
  assert.deepEqual(during.map(e => e.id).sort(), ['new-run', 'old-run'], '旧代 drain 期间的终态与新代终态都可见')
  assert.deepEqual(during.map(e => [e.id, e.generation, e.status]).sort(), [['new-run', 'g-new', 'success'], ['old-run', 'g-old', 'success']].sort())
  for (let i = 1; i < during.length; i += 1) assert.ok(during[i - 1].endedAt >= during[i].endedAt, '跨代合并按 endedAt 最新在前')

  /* 旧代 drain 完毕从 generations 退役后，终态仍随快照发布（TTL 内） */
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const retired = plain(manager.snapshot())
  assert.equal(retired.generations.some(g => g.id === 'g-old'), false, '旧代已退役')
  assert.deepEqual(retired.finished.map(e => [e.id, e.generation]).sort(), [['new-run', 'g-new'], ['old-run', 'g-old']].sort(), '退役代终态继续发布')
  await manager.dispose()
})

test('GET /api/worktable/pipeline/queue 的 server.finished：白名单清洗、非法条目剔除、恒为数组', async () => {
  const dirty = {
    id: 'run-1', pipelineId: 'pipe-1', pipelineName: '发布', by: 'alice', source: 'api', generation: 'g-1',
    status: 'success', dur: 3.2, startedAt: 100, endedAt: 3300,
    stages: [
      { stage: '构建', status: 'success', dur: 3.2, log: 'secret log', vars: { TOKEN: 'secret' } },
      { stage: '部署', status: 'weird-status', dur: -5 },
      'garbage',
    ],
    logs: { s1: 'secret log' }, vars: { TOKEN: 'secret' }, token: 'secret',
  }
  const second = { id: 'run-2', pipelineId: 'pipe-2', pipelineName: '测试', by: 'bob', source: 'schedule', status: 'failure', dur: 1, startedAt: 50, endedAt: 1050, stages: [] }
  const handler = loadQueueRoute({
    pipelineExecutions: {
      snapshot: () => ({
        runs: [], queue: [],
        finished: [dirty, { id: 'bad-status', status: 'exploded' }, { status: 'success' }, second],
      }),
      cancel: () => ({ ok: false, state: 'missing' }),
    },
  })
  const get = await callQueue(handler, 'GET')
  assert.equal(get.status, 200)
  const server = get.json().server
  assert.ok(Array.isArray(server.finished), 'finished 恒为数组')
  assert.deepEqual(plain(server.finished), [
    {
      id: 'run-1', pipelineId: 'pipe-1', pipelineName: '发布', by: 'alice', source: 'api', generation: 'g-1',
      status: 'success', dur: 3.2, startedAt: 100, endedAt: 3300,
      stages: [{ stage: '构建', status: 'success', dur: 3.2 }, { stage: '部署', status: 'idle', dur: 0 }],
    },
    { id: 'run-2', pipelineId: 'pipe-2', pipelineName: '测试', by: 'bob', source: 'schedule', status: 'failure', dur: 1, startedAt: 50, endedAt: 1050, stages: [] },
  ], '按契约字段清洗（generation 透传、阶段状态白名单、dur 非负），非法 status/缺 id 整条剔除，顺序保持快照给定的最新在前')
  assert.equal(JSON.stringify(server).includes('secret'), false, '日志/变量/凭据不透传')

  /* 快照无 finished 字段时恒为空数组 */
  const empty = loadQueueRoute({ pipelineExecutions: { snapshot: () => ({ runs: [], queue: [] }), cancel: () => ({ ok: false, state: 'missing' }) } })
  assert.deepEqual((await callQueue(empty, 'GET')).json().server.finished, [])
})
