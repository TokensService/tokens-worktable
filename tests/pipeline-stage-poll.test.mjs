// 流水线阶段完成轮询端点（服务端长轮询）：
//   POST /api/worktable/pipeline/stage-poll/jenkins    {phase:'queue'|'build', url, headers?, timeoutMs?, console?, offset?}
//   POST /api/worktable/pipeline/stage-poll/evaltokens {url, headers?, runId, timeoutMs?}
// 覆盖：终态判定（queue executable/cancelled、build result、evaltokens kind）、窗口耗尽 {done:false}、
// 30 连败 {done:true, failed:'poll'}、外网目标 403、参数非法 400、headers 透传、客户端断开停止上游轮询。
// 上游用本地 http server 模拟 Jenkins/EvalTokens（127.0.0.1 过内网白名单，全局 fetch 真实请求）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))

/* vm 抽取阶段轮询区段（自包含，仅依赖 isLocalTarget/readJsonBody/json）；
   isLocalTarget 从源文件原样抽取拼在前面，保证白名单语义与线上一致 */
function loadStagePollRoutes() {
  const whitelistStart = source.indexOf('function isLocalTarget(')
  const whitelistEnd = source.indexOf('const MAX_ENTRIES', whitelistStart)
  const start = source.indexOf('/* ---------- 流水线阶段完成轮询（服务端长轮询） ----------\n')
  const end = source.indexOf('/* ---------- 流水线阶段完成轮询结束 ---------- */', start)
  assert.ok(whitelistStart >= 0 && whitelistEnd > whitelistStart, 'isLocalTarget 未找到')
  assert.ok(start >= 0 && end > start, '阶段轮询实现未找到')
  const code = stripTypeScriptTypes(source.slice(whitelistStart, whitelistEnd) + '\n' + source.slice(start, end), { mode: 'transform' })
  const handlers = {}
  const context = {
    URL, fetch, AbortController, setTimeout, clearTimeout, Buffer, console,
    webServer: { register(route) { handlers[route.path] = route.handler } },
    readJsonBody: async req => req.body || {},
    json(res, status, body) { res.writeHead(status); res.end(JSON.stringify(body)) },
  }
  vm.createContext(context)
  vm.runInContext(code, context)
  context.registerPipelineStagePollRoutes(context.webServer)   // 生产由 apply() 调用，这里手动触发注册
  return handlers
}

const routes = loadStagePollRoutes()
const jenkinsHandler = routes['/api/worktable/pipeline/stage-poll/jenkins']
const evaltokensHandler = routes['/api/worktable/pipeline/stage-poll/evaltokens']
assert.ok(jenkinsHandler && evaltokensHandler, '阶段轮询两个端点未注册')

function mockRes() {
  const res = new EventEmitter()
  res.status = 0
  res.body = ''
  res.writeHead = status => { res.status = status; return res }
  res.end = body => { res.body = body == null ? '' : String(body) }
  res.json = () => (res.body ? JSON.parse(res.body) : null)
  return res
}

async function call(handler, body, method = 'POST') {
  const res = mockRes()
  await handler({ method, url: '/stage-poll', body }, res)
  return res
}

/* 本地 http server 模拟上游；hits 记录请求路径（含 query），state 由用例闭包改写 */
async function startUpstream(handler) {
  const hits = []
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://upstream.internal')
    hits.push({ path: u.pathname + u.search, headers: req.headers })
    handler(req, res, u)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, hits, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) }
}

const until = async (fn, timeout = 3000) => {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - t0 > timeout) throw new Error('wait condition timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('jenkins queue：出现 executable.number → {done:true, buildNumber}；首轮立即轮询', async () => {
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ executable: { number: 42 } }))
  })
  try {
    const res = await call(jenkinsHandler, { phase: 'queue', url: `http://127.0.0.1:${up.port}/queue/item/9/api/json`, timeoutMs: 5000 })
    assert.equal(res.status, 200)
    assert.deepEqual(plain(res.json()), { done: true, buildNumber: 42 })
    assert.equal(up.hits.length, 1, '首轮立即发起，一次命中即终态')
  } finally { await up.close() }
})

test('jenkins queue：item 消失（404）与 cancelled 标记 → {done:true, cancelled:true}', async () => {
  for (const mode of ['404', 'cancelled']) {
    const up = await startUpstream((req, res) => {
      if (mode === '404') { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ cancelled: true, why: '用户取消' }))
    })
    try {
      const res = await call(jenkinsHandler, { phase: 'queue', url: `http://127.0.0.1:${up.port}/queue/item/9/api/json`, timeoutMs: 5000 })
      assert.deepEqual(plain(res.json()), { done: true, cancelled: true }, mode + ' 应按已取消终态')
    } finally { await up.close() }
  }
})

test('jenkins queue：窗口耗尽未终态 → {done:false}，窗口时长守约', async () => {
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ why: 'Waiting for next available executor' }))
  })
  try {
    const t0 = Date.now()
    const res = await call(jenkinsHandler, { phase: 'queue', url: `http://127.0.0.1:${up.port}/queue/item/9/api/json`, timeoutMs: 300 })
    const elapsed = Date.now() - t0
    assert.deepEqual(plain(res.json()), { done: false }, '无 failures/console 时不带多余字段')
    assert.ok(elapsed >= 250 && elapsed < 3000, '窗口约 300ms 耗尽后返回，实际 ' + elapsed + 'ms')
    assert.ok(up.hits.length >= 1)
  } finally { await up.close() }
})

test('jenkins build：building=false → {done:true, result}；building 中窗口耗尽 → {done:false}', async () => {
  let building = true
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ number: 42, building, result: building ? null : 'SUCCESS', duration: 100 }))
  })
  try {
    const url = `http://127.0.0.1:${up.port}/job/app/42/api/json?tree=number,building,result,duration`
    const pending = await call(jenkinsHandler, { phase: 'build', url, timeoutMs: 300 })
    assert.deepEqual(plain(pending.json()), { done: false })
    building = false
    const done = await call(jenkinsHandler, { phase: 'build', url, timeoutMs: 5000 })
    assert.deepEqual(plain(done.json()), { done: true, result: 'SUCCESS' })
  } finally { await up.close() }
})

test('jenkins build：console:true 附带 progressiveText 增量控制台，offset 逐请求续传', async () => {
  let log = 'line1\nline2\n'
  let building = true
  const up = await startUpstream((req, res, u) => {
    if (u.pathname.endsWith('/logText/progressiveText')) {
      const start = Number(u.searchParams.get('start')) || 0
      res.writeHead(200, { 'content-type': 'text/plain', 'x-text-size': String(log.length) })
      res.end(log.slice(start))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ number: 42, building, result: building ? null : 'SUCCESS' }))
  })
  try {
    const url = `http://127.0.0.1:${up.port}/job/app/42/api/json`
    const first = await call(jenkinsHandler, { phase: 'build', url, timeoutMs: 300, console: true, offset: 0 })
    assert.deepEqual(plain(first.json()), { done: false, console: { text: 'line1\nline2\n', offset: 12 } })

    /* 客户端拿返回的 offset 续传：构建期间新增日志 + 终态同一响应带回 */
    log += 'done\n'
    building = false
    const second = await call(jenkinsHandler, { phase: 'build', url, timeoutMs: 300, console: true, offset: 12 })
    assert.deepEqual(plain(second.json()), { done: true, result: 'SUCCESS', console: { text: 'done\n', offset: 17 } })

    /* 无新增内容时终态不带 console */
    const third = await call(jenkinsHandler, { phase: 'build', url, timeoutMs: 300, console: true, offset: 17 })
    assert.deepEqual(plain(third.json()), { done: true, result: 'SUCCESS' })
  } finally { await up.close() }
})

test('jenkins：headers 原样透传上游（鉴权透传），逐跳头剔除', async () => {
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ executable: { number: 7 } }))
  })
  try {
    const res = await call(jenkinsHandler, {
      phase: 'queue', url: `http://127.0.0.1:${up.port}/queue/item/9/api/json`, timeoutMs: 1000,
      headers: { Authorization: 'Basic dXNlcjp0b2tlbg==', 'X-Custom': 'yes', Host: 'evil.example', Connection: 'close', 'Content-Length': '5' },
    })
    assert.deepEqual(plain(res.json()), { done: true, buildNumber: 7 })
    assert.equal(up.hits[0].headers.authorization, 'Basic dXNlcjp0b2tlbg==', '鉴权头透传')
    assert.equal(up.hits[0].headers['x-custom'], 'yes')
    assert.notEqual(up.hits[0].headers.host, 'evil.example', 'host 逐跳头不透传')
  } finally { await up.close() }
})

test('jenkins：上游连续失败跨请求累计，30 连败 → {done:true, failed:\'poll\', failures:30}，随后重新计数', async () => {
  const up = await startUpstream((req, res) => { res.writeHead(500); res.end('boom') })
  try {
    const url = `http://127.0.0.1:${up.port}/queue/item/9/api/json`
    let terminal = null
    let previous = 0
    for (let i = 0; i < 200 && !terminal; i += 1) {
      const res = await call(jenkinsHandler, { phase: 'queue', url, timeoutMs: 60 })
      const body = res.json()
      if (body.done === true) terminal = body
      else {
        assert.equal(body.done, false)
        assert.ok(body.failures > previous, '失败计数跨请求累计递增：' + body.failures + ' <= ' + previous)
        assert.ok(body.failures < 30)
        previous = body.failures
      }
    }
    assert.deepEqual(terminal, { done: true, failed: 'poll', failures: 30 })
    assert.ok(up.hits.length >= 30, '每次上游失败都计入')

    /* 判负后同 key 请求立即返回终态，不再打上游（10 分钟 TTL 后自动解除；新一次运行换 key 重新计数） */
    const hitsBefore = up.hits.length
    const again = await call(jenkinsHandler, { phase: 'queue', url, timeoutMs: 60 })
    assert.deepEqual(plain(again.json()), { done: true, failed: 'poll', failures: 30 })
    assert.equal(up.hits.length, hitsBefore, '判负后不再发起上游请求')
  } finally { await up.close() }
})

test('jenkins：成功一次失败计数清零（30  cap 只在连续失败时触发）', async () => {
  let fail = true
  const up = await startUpstream((req, res) => {
    if (fail) { res.writeHead(500); res.end('boom'); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ executable: { number: 11 } }))
  })
  try {
    const url = `http://127.0.0.1:${up.port}/queue/item/9/api/json`
    let last = 0
    for (let i = 0; i < 60; i += 1) {   // 累计到 25+ 次连续失败（未到 30 cap）
      const body = (await call(jenkinsHandler, { phase: 'queue', url, timeoutMs: 60 })).json()
      last = body.failures || 0
      if (last >= 25) break
    }
    assert.ok(last >= 25 && last < 30, '失败已累计到 25~29：' + last)
    fail = false
    const ok = await call(jenkinsHandler, { phase: 'queue', url, timeoutMs: 1000 })
    assert.deepEqual(plain(ok.json()), { done: true, buildNumber: 11 }, '成功一次即终态，不触发 30 连败')
    fail = true
    const again = await call(jenkinsHandler, { phase: 'queue', url, timeoutMs: 60 })
    assert.equal(again.json().done, false)
    assert.ok((again.json().failures || 0) < 10, '成功已清零，失败重新计数：' + JSON.stringify(again.json()))
  } finally { await up.close() }
})

test('jenkins：外网目标 403 {error:\'forbidden\'}；参数非法 400', async () => {
  const forbidden1 = await call(jenkinsHandler, { phase: 'queue', url: 'http://8.8.8.8/queue/item/1/api/json' })
  assert.equal(forbidden1.status, 403)
  assert.deepEqual(plain(forbidden1.json()), { error: 'forbidden' })
  const forbidden2 = await call(jenkinsHandler, { phase: 'build', url: 'http://example.com/job/a/1/api/json' })
  assert.equal(forbidden2.status, 403)

  const badPhase = await call(jenkinsHandler, { phase: 'stage', url: 'http://127.0.0.1:1/x' })
  assert.equal(badPhase.status, 400)
  const noUrl = await call(jenkinsHandler, { phase: 'queue' })
  assert.equal(noUrl.status, 400)
  const badUrl = await call(jenkinsHandler, { phase: 'queue', url: 'not a url' })
  assert.equal(badUrl.status, 400)
  const badProto = await call(jenkinsHandler, { phase: 'queue', url: 'ftp://127.0.0.1/x' })
  assert.equal(badProto.status, 400)
  const badTimeout = await call(jenkinsHandler, { phase: 'queue', url: 'http://127.0.0.1:1/x', timeoutMs: -5 })
  assert.equal(badTimeout.status, 400)
  const badOffset = await call(jenkinsHandler, { phase: 'build', url: 'http://127.0.0.1:1/x', console: true, offset: -1 })
  assert.equal(badOffset.status, 400)
  const getRes = await call(jenkinsHandler, { phase: 'queue', url: 'http://127.0.0.1:1/x' }, 'GET')
  assert.equal(getRes.status, 405)
})

test('jenkins：客户端断开连接立即停止窗口与上游轮询（真实 HTTP 端到端）', async () => {
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ why: 'pending' }))   // 永不到终态
  })
  /* 把 vm 抽取的 handler 包进真实 HTTP 服务，验证 res close 真实触发 */
  const gateway = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch {}
      jenkinsHandler({ method: req.method, url: req.url, body }, res)
    })
  })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  const controller = new AbortController()
  try {
    const pending = fetch(`http://127.0.0.1:${gateway.address().port}/api/worktable/pipeline/stage-poll/jenkins`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'queue', url: `http://127.0.0.1:${up.port}/queue/item/9/api/json`, timeoutMs: 25000 }),
      signal: controller.signal,
    })
    pending.catch(() => {})
    await until(() => up.hits.length >= 1)
    controller.abort()   // 浏览器断开：服务端必须停止上游轮询
    await assert.rejects(pending)
    await new Promise(resolve => setTimeout(resolve, 2300))   // 超过一个 2s 轮询节拍
    assert.equal(up.hits.length, 1, '断开后不再有新的上游轮询')
  } finally {
    gateway.close()
    await up.close()
  }
})

test('evaltokens：runId 到终态 → {done:true, status, run 原样透传}；失败优先归类', async () => {
  const run = { run_id: 'r-1', status: 'completed', detail: { score: 0.9 }, token: 'as-is' }
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ runs: [run] }))
  })
  try {
    const url = `http://127.0.0.1:${up.port}/api/open/v1/tasks/runs?task_id=t-1`
    const res = await call(evaltokensHandler, { url, runId: 'r-1', timeoutMs: 5000, headers: { Authorization: 'Bearer t' } })
    assert.deepEqual(plain(res.json()), { done: true, status: 'success', run })
    assert.equal(up.hits[0].headers.authorization, 'Bearer t', 'Bearer 鉴权透传')
  } finally { await up.close() }

  /* completed_with_errors 必须判 failed（失败优先，与服务端执行池 serverEvaltokensStatus 同口径） */
  const up2 = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ runs: [{ run_id: 'r-2', status: 'completed_with_errors' }] }))
  })
  try {
    const res = await call(evaltokensHandler, { url: `http://127.0.0.1:${up2.port}/api/open/v1/tasks/runs?task_id=t-1`, runId: 'r-2', timeoutMs: 5000 })
    assert.equal(res.json().done, true)
    assert.equal(res.json().status, 'failed')
    assert.equal(res.json().run.status, 'completed_with_errors')
  } finally { await up2.close() }
})

test('evaltokens：runId 不在列表按运行中，窗口耗尽 {done:false}；裸数组响应兼容', async () => {
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ runs: [{ run_id: 'other', status: 'running' }] }))
  })
  try {
    const res = await call(evaltokensHandler, { url: `http://127.0.0.1:${up.port}/api/open/v1/tasks/runs?task_id=t-1`, runId: 'r-missing', timeoutMs: 300 })
    assert.deepEqual(plain(res.json()), { done: false })
  } finally { await up.close() }

  const bare = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{ run_id: 'r-1', state: 'FAILED' }]))
  })
  try {
    const res = await call(evaltokensHandler, { url: `http://127.0.0.1:${bare.port}/api/open/v1/tasks/runs?task_id=t-1`, runId: 'r-1', timeoutMs: 5000 })
    assert.deepEqual(plain(res.json()), { done: true, status: 'failed', run: { run_id: 'r-1', state: 'FAILED' } })
  } finally { await bare.close() }
})

test('evaltokens：30 连败 → {done:true, failed:\'poll\', failures:30}', async () => {
  const up = await startUpstream((req, res) => { res.writeHead(502); res.end('bad gateway') })
  try {
    const url = `http://127.0.0.1:${up.port}/api/open/v1/tasks/runs?task_id=t-1`
    let terminal = null
    for (let i = 0; i < 200 && !terminal; i += 1) {
      const body = (await call(evaltokensHandler, { url, runId: 'r-1', timeoutMs: 60 })).json()
      if (body.done === true) terminal = body
      else assert.ok((body.failures || 0) < 30)
    }
    assert.deepEqual(terminal, { done: true, failed: 'poll', failures: 30 })
  } finally { await up.close() }
})

test('evaltokens：外网目标 403；缺 runId/坏 url 400', async () => {
  const forbidden = await call(evaltokensHandler, { url: 'http://8.8.8.8/api/open/v1/tasks/runs?task_id=t', runId: 'r' })
  assert.equal(forbidden.status, 403)
  assert.deepEqual(plain(forbidden.json()), { error: 'forbidden' })
  const noRunId = await call(evaltokensHandler, { url: 'http://127.0.0.1:1/x' })
  assert.equal(noRunId.status, 400)
  const badUrl = await call(evaltokensHandler, { url: '::', runId: 'r' })
  assert.equal(badUrl.status, 400)
  const badTimeout = await call(evaltokensHandler, { url: 'http://127.0.0.1:1/x', runId: 'r', timeoutMs: 0 })
  assert.equal(badTimeout.status, 400)
})

test('evaltokens：客户端断开连接立即停止窗口与上游轮询（res close）', async () => {
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ runs: [{ run_id: 'r-1', status: 'running' }] }))
  })
  try {
    const res = mockRes()
    const pending = evaltokensHandler({ method: 'POST', url: '/stage-poll', body: { url: `http://127.0.0.1:${up.port}/api/open/v1/tasks/runs?task_id=t-1`, runId: 'r-1', timeoutMs: 25000 } }, res)
    await until(() => up.hits.length >= 1)
    res.emit('close')   // 浏览器断开：窗口立即中止，静默收尾
    await pending
    assert.equal(res.status, 0, '断开后不再写响应')
    assert.equal(res.body, '')
    assert.equal(up.hits.length, 1, '断开后不再有新的上游轮询')
  } finally { await up.close() }
})
