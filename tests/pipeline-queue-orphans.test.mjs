import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))

/* 与 pipeline-queue-presence.test.mjs 同一 vm 抽取 harness，额外返回 context 以便
   调用路由段内的函数声明（sweepQueuePresence / addQueueOrphan / pruneQueueOrphans）
   并 await 启动加载标记 queueOrphansReady。 */
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
    console: overrides.console || console,
    /* 孤儿登记簿引用的外层作用域符号：默认全部惰性 stub（读 ENOENT、写丢弃、不落盘） */
    setTimeout, clearTimeout,
    DSH_HOME: overrides.DSH_HOME || '/nonexistent-dsh-home',
    pathResolve: overrides.pathResolve || ((...parts) => parts.join('/')),
    readFile: overrides.readFile || (async () => { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err }),
    writeJsonAtomic: overrides.writeJsonAtomic || (async () => {}),
  }
  vm.createContext(context)
  vm.runInContext(code, context)
  return { handler, context }
}

function response() {
  return {
    status: 0, body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body == null ? '' : String(body) },
    json() { return this.body ? JSON.parse(this.body) : null },
  }
}

async function call(handler, method, body, url = '/api/worktable/pipeline/queue') {
  const res = response()
  await handler({ method, body, url }, res)
  return res
}

const v3 = (id, extra = {}) => ({ schemaVersion: 3, id, label: 'Chrome·' + id, running: null, runs: [], queue: [], ...extra })
const runEntry = (id, extra = {}) => ({
  id, pipelineId: 'pipe-1', pipelineName: '发布流水线', by: 'alice', env: '10.0.0.1',
  repoName: 'app', branch: 'dev', strategy: 'rolling', source: 'manual', startedAt: 1000,
  stages: [{ id: 'build', name: '构建' }], nodes: { build: { status: 'running', progress: 40, dur: 3 } },
  ...extra,
})
const queueEntry = (id, extra = {}) => ({
  id, pipelineId: 'pipe-2', pipelineName: '测试流水线', by: 'bob', env: '10.0.0.2',
  repoName: 'test', branch: 'main', strategy: '', source: 'manual', queuedAt: 2000,
  stages: [{ id: 'test', name: '测试' }], nodes: { test: { status: 'idle', progress: 0, dur: 0 } },
  ...extra,
})
const orphansOf = res => res.json().orphans

test('v3 客户端条目消失且无 completed → 进孤儿簿，GET orphans 字段齐全且不泄密', async () => {
  const { handler } = loadQueueRoute()
  await call(handler, 'PUT', v3('c1', {
    runs: [runEntry('run-1', { _out: { stdout: 'secret log' }, stages: [{ id: 'build', name: '构建', script: { values: { TOKEN: 'secret' } } }] })],
    queue: [queueEntry('q-1')],
  }))
  let get = await call(handler, 'GET')
  assert.deepEqual(orphansOf(get), [], 'orphans 恒为数组，初始为空')

  const put = await call(handler, 'PUT', v3('c1'))   // 本次上报 runs/queue 全消失，无 completed
  assert.equal(put.status, 200)
  get = await call(handler, 'GET')
  assert.equal(get.json().clients.length, 0, '空闲客户端不在 clients 里')
  const orphans = orphansOf(get)
  assert.equal(orphans.length, 2)

  const runOrphan = orphans.find(o => o.id === 'run-1')
  assert.equal(runOrphan.ownerId, 'c1')
  assert.equal(runOrphan.ownerLabel, 'Chrome·c1')
  assert.equal(runOrphan.kind, 'running')
  assert.equal(typeof runOrphan.orphanedAt, 'number')
  assert.ok(runOrphan.orphanedAt > 0)
  /* 清洗后快照字段保留（与运行队列条目同口径） */
  assert.equal(runOrphan.pipelineName, '发布流水线')
  assert.equal(runOrphan.nodes.build.status, 'running')
  assert.equal(runOrphan.stages[0].name, '构建')
  const queueOrphan = orphans.find(o => o.id === 'q-1')
  assert.equal(queueOrphan.kind, 'queued')
  assert.equal(queueOrphan.queuedAt, 2000)
  /* 与在场快照同一白名单口径：日志、变量、脚本参数不进孤儿簿 */
  assert.equal(JSON.stringify(orphans).includes('secret'), false)
})

test('v3 客户端条目消失但在 completed 中 → 不进孤儿簿', async () => {
  const { handler } = loadQueueRoute()
  await call(handler, 'PUT', v3('c1', { runs: [runEntry('run-1')], queue: [queueEntry('q-1')] }))
  await call(handler, 'PUT', v3('c1', { completed: ['run-1', 'q-1'] }))
  const get = await call(handler, 'GET')
  assert.deepEqual(orphansOf(get), [])
})

test('completed 补报出簿：条目先失联入簿，随后补报完成即移除', async () => {
  const { handler } = loadQueueRoute()
  await call(handler, 'PUT', v3('c1', { runs: [runEntry('run-1')] }))
  await call(handler, 'PUT', v3('c1'))                       // 失联入簿
  assert.equal(orphansOf(await call(handler, 'GET')).length, 1)
  await call(handler, 'PUT', v3('c1', { completed: ['run-1'] }))   // 补报完成
  assert.deepEqual(orphansOf(await call(handler, 'GET')), [])
})

test('在场记录 TTL 过期 → 其 runs/queue 条目进孤儿簿后再删在场记录', async () => {
  const { handler, context } = loadQueueRoute()
  await call(handler, 'PUT', v3('c1', { runs: [runEntry('run-1')], queue: [queueEntry('q-1')] }))
  /* running 旧字段与 runs[0] 同物：runs 为空时把 running 当唯一一条登记 */
  await call(handler, 'PUT', v3('c2', { running: runEntry('run-solo'), runs: [] }))
  /* v1 旧客户端过期不进孤儿簿（兼容现状） */
  await call(handler, 'PUT', { id: 'old', label: 'OldPage', runs: [runEntry('run-old')], queue: [] })

  context.sweepQueuePresence(Date.now() + 46 * 1000)   // 注入假时间触发 45s TTL 过期

  const get = await call(handler, 'GET')
  assert.equal(get.json().clients.length, 0)
  const orphans = orphansOf(get)
  assert.equal(orphans.length, 3)
  assert.deepEqual(orphans.map(o => o.id).sort(), ['q-1', 'run-1', 'run-solo'])
  const solo = orphans.find(o => o.id === 'run-solo')
  assert.equal(solo.kind, 'running')
  assert.equal(solo.ownerId, 'c2')
  assert.equal(orphans.find(o => o.id === 'q-1').kind, 'queued')
})

test('复活：同 ownerId 重新上报同 id → 孤儿移除；不同 owner 不受影响', async () => {
  const { handler, context } = loadQueueRoute()
  await call(handler, 'PUT', v3('c1', { runs: [runEntry('run-1')] }))
  context.sweepQueuePresence(Date.now() + 46 * 1000)   // 网络抖动导致 TTL 过期入簿
  assert.equal(orphansOf(await call(handler, 'GET')).length, 1)

  await call(handler, 'PUT', v3('c2', { runs: [runEntry('run-1')] }))   // 别的浏览器上报同 id
  assert.equal(orphansOf(await call(handler, 'GET')).length, 1, '孤儿键含 ownerId，他人上报不移除')

  await call(handler, 'PUT', v3('c1', { runs: [runEntry('run-1')] }))   // 原 owner 恢复上报 → 复活
  const get = await call(handler, 'GET')
  assert.deepEqual(orphansOf(get), [])
  assert.equal(get.json().clients.length, 2)
})

test('dismiss：存在 → 200 dismissed，不存在 → 404 missing，缺参 → 400', async () => {
  const { handler } = loadQueueRoute()
  await call(handler, 'PUT', v3('c1', { runs: [runEntry('run-1')] }))
  await call(handler, 'PUT', v3('c1'))                       // 入簿

  const missingParams = await call(handler, 'POST', { action: 'dismiss', ownerId: 'c1' })
  assert.equal(missingParams.status, 400)

  const missing = await call(handler, 'POST', { action: 'dismiss', ownerId: 'c1', id: 'nope' })
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.json(), { ok: false, state: 'missing' })

  const dismissed = await call(handler, 'POST', { action: 'dismiss', ownerId: 'c1', id: 'run-1' })
  assert.equal(dismissed.status, 200)
  assert.deepEqual(dismissed.json(), { ok: true, state: 'dismissed' })
  assert.deepEqual(orphansOf(await call(handler, 'GET')), [])

  const again = await call(handler, 'POST', { action: 'dismiss', ownerId: 'c1', id: 'run-1' })
  assert.equal(again.status, 404)
})

test('v1/v2 旧客户端条目消失不进孤儿簿（兼容现状）', async () => {
  const { handler } = loadQueueRoute()
  await call(handler, 'PUT', { id: 'c1', label: 'Old', schemaVersion: 2, runs: [runEntry('run-1')], queue: [queueEntry('q-1')] })
  await call(handler, 'PUT', { id: 'c1', label: 'Old', schemaVersion: 2, runs: [], queue: [] })
  assert.deepEqual(orphansOf(await call(handler, 'GET')), [])
  /* v1（无 schemaVersion）走 running 旧字段同样不进 */
  await call(handler, 'PUT', { id: 'c2', label: 'Older', running: runEntry('run-2'), queue: [] })
  await call(handler, 'PUT', { id: 'c2', label: 'Older', running: null, queue: [] })
  assert.deepEqual(orphansOf(await call(handler, 'GET')), [])
})

test('持久化：变更防抖落盘为 {"orphans":[...]}，重启后加载恢复，损坏文件按空簿处理', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wt-orphans-'))
  const storeFile = join(home, 'storages', 'worktable-pipeline-orphans.json')
  const fsStubs = {
    DSH_HOME: home,
    pathResolve: join,
    readFile,
    writeJsonAtomic: async (file, text) => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, file)
    },
  }
  const first = loadQueueRoute(fsStubs)
  await first.context.queueOrphansReady                       // 无文件 → 空簿
  await call(first.handler, 'PUT', v3('c1', { runs: [runEntry('run-1')] }))
  await call(first.handler, 'PUT', v3('c1'))                  // 失联入簿，触发防抖落盘

  let saved = null
  for (let i = 0; i < 40 && !saved; i += 1) {                 // 等防抖 300ms 落盘
    await new Promise(resolve => setTimeout(resolve, 100))
    try { saved = JSON.parse(await readFile(storeFile, 'utf8')) } catch {}
  }
  assert.ok(saved, '孤儿簿未在防抖窗口内落盘')
  assert.equal(saved.orphans.length, 1)
  assert.equal(saved.orphans[0].id, 'run-1')
  assert.equal(saved.orphans[0].ownerId, 'c1')

  /* 模拟重启：新沙盒异步加载同一文件 */
  const second = loadQueueRoute(fsStubs)
  await second.context.queueOrphansReady
  const loaded = orphansOf(await call(second.handler, 'GET'))
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'run-1')
  assert.equal(loaded[0].ownerLabel, 'Chrome·c1')
  assert.equal(loaded[0].kind, 'running')
  assert.equal(typeof loaded[0].orphanedAt, 'number')

  /* 文件损坏 → 按空簿处理且只 warn */
  await writeFile(storeFile, '{broken json', 'utf8')
  const warnings = []
  const third = loadQueueRoute({ ...fsStubs, console: { warn: (...args) => warnings.push(args.map(String).join(' ')) } })
  await third.context.queueOrphansReady
  assert.deepEqual(orphansOf(await call(third.handler, 'GET')), [])
  assert.ok(warnings.some(line => line.includes('损坏')), '损坏应只 warn：' + JSON.stringify(warnings))
})

test('保留策略：orphanedAt 超 24 小时丢弃，总量超 100 条丢最旧', async () => {
  const { handler, context } = loadQueueRoute()
  context.addQueueOrphan('c1', 'Chrome·c1', 'running', runEntry('run-1'), Date.now())
  assert.equal(context.pruneQueueOrphans(Date.now() + 23 * 3600 * 1000), false, '未超龄不丢弃')
  assert.equal(orphansOf(await call(handler, 'GET')).length, 1)
  assert.equal(context.pruneQueueOrphans(Date.now() + 25 * 3600 * 1000), true, '超龄丢弃')
  assert.deepEqual(orphansOf(await call(handler, 'GET')), [])

  /* 100 上限：orphanedAt 最小的最旧条目先丢 */
  const base = Date.now()
  for (let i = 0; i < 105; i += 1) context.addQueueOrphan('c1', 'Chrome·c1', 'running', runEntry('run-' + i), base + i)
  const orphans = orphansOf(await call(handler, 'GET'))
  assert.equal(orphans.length, 100)
  const ids = new Set(orphans.map(o => o.id))
  for (let i = 0; i < 5; i += 1) assert.equal(ids.has('run-' + i), false, '最旧的被丢弃: run-' + i)
  assert.equal(ids.has('run-5'), true)
  assert.equal(ids.has('run-104'), true)
})
