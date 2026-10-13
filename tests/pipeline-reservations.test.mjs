import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as pathResolve, dirname } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

/* 节点预留（worktable-pipeline-reservations.json）服务端测试：
   复用 pipeline-trust.test.mjs 的 vm 路由块抽取基建（strip 保注释 → 按注释标记切片 → 假 webServer.register
   收集 handler → 临时 DSH_HOME + 假 json/readJsonBody/writeJsonAtomic/withStoreLock/readPipelineStore
   + 假 ctx.auth.sessions.getByToken）。覆盖：GET 下发、PUT 权限/校验/404/409/幂等/清挂、
   三处强制点（run API / leases acquire / execPlan 兜底）与纯函数边界。 */

const rawSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
/* 先整体去类型（strip 模式保留注释标记、类型注解抹成空白、不改变偏移），后续切片/抽函数都在去类型后的源码上进行 */
const source = stripTypeScriptTypes(rawSource, { mode: 'strip' })

/* 提取单个顶层函数（含可选 async 前缀；brace 配对手法与 pipeline-trust/pipeline-config-concurrency 一致） */
function extractFunction(name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const match = marker.exec(source)
  assert.ok(match, `src/index.ts 缺少函数 ${name}`)
  const bodyStart = source.indexOf('{', match.index)
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}' && --depth === 0) return source.slice(match.index, index + 1)
  }
  throw new Error(`无法提取函数 ${name}`)
}

/* 预留纯函数区 + 身份解析链（resolveRequestAuth 内部经 readAuthAdminUsers 读 users.yaml 判 admin） */
const RESERVATION_HELPERS = [
  /^const RESERVATION_WINDOWS_CAP = .+$/m.exec(source)[0],
  /^const RESERVATION_USERS_CAP = .+$/m.exec(source)[0],
  /^const RESERVATION_NOTE_CAP = .+$/m.exec(source)[0],
  ...[
    'normalizeReservationWindows', 'sameReservationWindow', 'reservationConflictsForEnvs',
    'reservationConflictMessage', 'hasAuthService',
    'requestAuthToken', 'parseAuthUsersYaml', 'readAuthAdminUsers', 'resolveRequestAuth',
  ].map((name) => extractFunction(name)),
].join('\n')

function mockRes() {
  return {
    status: 0, body: '',
    writeHead(s) { this.status = s },
    end(s) { this.body = s == null ? '' : String(s) },
    json() { return this.body ? JSON.parse(this.body) : null },
  }
}

async function call(handler, req) {
  const res = mockRes()
  await handler(req, res)
  return res
}

/* 会话桩：token → {subject}；auth 服务形态与 dsh-auth-gate 的 ctx.provide('auth') 一致（getByToken 同步） */
const TOKEN_ADMIN = 'tok-root-0000000000000000000000000000000000'
const TOKEN_U1 = 'tok-u1-000000000000000000000000000000000000'
const TOKEN_U2 = 'tok-u2-000000000000000000000000000000000000'
const authCtx = () => ({
  auth: {
    sessions: {
      getByToken(token) {
        if (token === TOKEN_ADMIN) return { subject: 'root', expiresAt: 0, revoked: false }
        if (token === TOKEN_U1) return { subject: 'u1', expiresAt: 0, revoked: false }
        if (token === TOKEN_U2) return { subject: 'u2', expiresAt: 0, revoked: false }
        return undefined
      },
    },
  },
})
const USERS_YAML = `version: 1
users:
  root:
    passwordHash: scrypt$rrrrrrrr
    role: admin
  u1:
    passwordHash: scrypt$11111111
  u2:
    passwordHash: scrypt$22222222
`

const ENV1 = { id: 'env-1', name: '构建机1', ip: '10.0.0.1', nodeIp: '', user: 'root', pass: 'x' }
const ENV2 = { id: 'env-2', name: '构建机2', ip: '10.0.0.2', nodeIp: '', user: 'root', pass: 'x' }
/* 合法窗口（非 ISO 入参，验证规范化补毫秒）；users 故意乱序 + 重复，验证去重排序 */
const W1 = { start: '2026-10-13T06:00:00Z', end: '2026-10-13T10:00:00Z', users: ['u2', 'u1', 'u1'], note: '交班' }
const W1_ISO = { start: '2026-10-13T06:00:00.000Z', end: '2026-10-13T10:00:00.000Z' }

async function seedHome(t, { environments = [ENV1, ENV2], reservations = null, usersYaml = USERS_YAML } = {}) {
  const home = await mkdtemp(tmpdir() + '/pipeline-rsv-')
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(pathResolve(home, 'storages'), { recursive: true })
  await writeFile(pathResolve(home, 'storages', 'worktable-pipeline.json'), JSON.stringify({ config: { environments }, history: [] }), 'utf8')
  if (reservations !== null) {
    await writeFile(pathResolve(home, 'storages', 'worktable-pipeline-reservations.json'), JSON.stringify({ reservations }), 'utf8')
  }
  if (usersYaml !== null) {
    await mkdir(pathResolve(home, 'auth'), { recursive: true })
    await writeFile(pathResolve(home, 'auth', 'users.yaml'), usersYaml, 'utf8')
  }
  return home
}

const readRsv = (home) => readFile(pathResolve(home, 'storages', 'worktable-pipeline-reservations.json'), 'utf8').then(JSON.parse).catch(() => null)

const reqWith = (method, url, body, token) => ({
  method, url, body,
  headers: token ? { cookie: 'other=1; dsh_auth=' + token + '; theme=dark' } : {},
})

/* 抽取「节点预留路由块」（GET + PUT），块首/块尾注释标记切片；writeJsonAtomic / withStoreLock /
   readPipelineStore 用测试内的等价实现，readReservationsStore/writeReservationsStore 是块内真实实现 */
function loadReservationRoutes(home, { ctx = {} } = {}) {
  const start = source.indexOf('  /* ---- 节点预留（pipeline 节点环境按「日期 + 时间段」分配给指定用户）----')
  const end = source.indexOf('  /* 【节点预留路由块终点】 */', start)
  assert.ok(start >= 0 && end > start, '节点预留路由块未找到')
  const code = RESERVATION_HELPERS + '\n' + source.slice(start, end)
  const handlers = {}
  const storeFile = pathResolve(home, 'storages', 'worktable-pipeline.json')
  const sandbox = {
    DSH_HOME: home, pathResolve, readFile, readFileSync, ctx, URL,
    RESERVATIONS_STORE: pathResolve(home, 'storages', 'worktable-pipeline-reservations.json'),
    readJsonBody: async (req) => req.body ?? {},
    writeJsonAtomic: async (file, text) => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, file)
    },
    readPipelineStore: async () => {
      try {
        const raw = await readFile(storeFile, 'utf8')
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
      } catch { return {} }
    },
    withStoreLock: (() => {   // 与源码同语义：读-改-写串行化
      let chain = Promise.resolve()
      return (fn) => { const p = chain.then(fn); chain = p.then(() => undefined, () => undefined); return p }
    })(),
    webServer: { register(route) { handlers[route.kind + ' ' + route.path] = route.handler } },
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  const get = handlers['exact /api/worktable/pipeline/reservations']
  const put = handlers['prefix /api/worktable/pipeline/reservations']
  assert.ok(get && put, '缺少节点预留 GET/PUT 路由')
  return { get, put }
}

test('GET reservations：空存储下发空表；admin 写入后下发全量；GET 不设身份门槛', async t => {
  const home = await seedHome(t)
  const r = loadReservationRoutes(home, { ctx: authCtx() })

  const empty = await call(r.get, reqWith('GET', '/api/worktable/pipeline/reservations'))
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json(), { reservations: [] }, '无预留文件 → 空表')

  const put = await call(r.put, reqWith('PUT', '/api/worktable/pipeline/reservations/env-1', { windows: [W1] }, TOKEN_ADMIN))
  assert.equal(put.status, 200)
  const list = await call(r.get, reqWith('GET', '/api/worktable/pipeline/reservations'))   // 无 token 也可读
  assert.equal(list.status, 200)
  assert.equal(list.json().reservations.length, 1)
  assert.equal(list.json().reservations[0].nodeId, 'env-1')
  assert.equal(list.json().reservations[0].createdBy, 'root')
})

test('PUT：非 admin 403、无会话 403、均不写盘；无 auth 服务（token 共享模式）放行', async t => {
  const home = await seedHome(t)
  const r = loadReservationRoutes(home, { ctx: authCtx() })
  const url = '/api/worktable/pipeline/reservations/env-1'

  const deny = await call(r.put, reqWith('PUT', url, { windows: [W1] }, TOKEN_U1))
  assert.equal(deny.status, 403)
  assert.equal(deny.json().error, 'forbidden')
  assert.match(deny.json().message, /仅 admin 用户可分配节点/)

  const anon = await call(r.put, reqWith('PUT', url, { windows: [W1] }))   // auth 存在但无会话 → 同样 403
  assert.equal(anon.status, 403)
  assert.equal(await readRsv(home), null, '两次拒绝都不落盘')

  const noAuth = loadReservationRoutes(home, { ctx: {} })   // 无 auth 服务 → 放行（与 owner 守卫同范式）
  const ok = await call(noAuth.put, reqWith('PUT', url, { windows: [W1] }))
  assert.equal(ok.status, 200)
  assert.equal(ok.json().reservations[0].createdBy, '', '无 auth 时 createdBy 为空串')
})

test('PUT admin 成功写盘：start/end 统一 ISO、users 去重排序、note 缺省、rsv- 前缀 id', async t => {
  const home = await seedHome(t)
  const r = loadReservationRoutes(home, { ctx: authCtx() })

  const res = await call(r.put, reqWith('PUT', '/api/worktable/pipeline/reservations/env-1', { windows: [W1] }, TOKEN_ADMIN))
  assert.equal(res.status, 200)
  assert.equal(res.json().ok, true)
  assert.equal(res.json().reservations.length, 1)
  const rec = res.json().reservations[0]
  assert.ok(rec.id.startsWith('rsv-'), 'id 前缀 rsv-')
  assert.equal(rec.nodeId, 'env-1')
  assert.equal(rec.start, W1_ISO.start, 'start 规范化为带毫秒 ISO')
  assert.equal(rec.end, W1_ISO.end)
  assert.deepEqual(rec.users, ['u1', 'u2'], 'users 去重 + 排序')
  assert.equal(rec.note, '交班')
  assert.equal(rec.createdBy, 'root')
  assert.ok(Date.parse(rec.createdAt) > 0 && Date.parse(rec.updatedAt) > 0, 'createdAt/updatedAt 为 ISO')
  const disk = await readRsv(home)
  assert.deepEqual(disk.reservations, res.json().reservations, '响应全量与落盘一致')
})

test('PUT 校验 400：windows 缺失/非数组、start>=end、非法日期、users 空、users 空串、users 超 50、超 50 条、note 非字符串', async t => {
  const home = await seedHome(t)
  const r = loadReservationRoutes(home, { ctx: authCtx() })
  const url = '/api/worktable/pipeline/reservations/env-1'
  const put = (body) => call(r.put, reqWith('PUT', url, body, TOKEN_ADMIN))
  const ok = { start: '2026-10-13T06:00:00Z', end: '2026-10-13T10:00:00Z', users: ['u1'] }

  const bad = [
    [{}, 'windows 缺失'],
    [{ windows: 'x' }, 'windows 非数组'],
    [{ windows: [{ ...ok, start: ok.end, end: ok.start }] }, 'start>=end'],
    [{ windows: [{ ...ok, start: 'not-a-date' }] }, 'start 不可解析'],
    [{ windows: [{ ...ok, end: '' }] }, 'end 不可解析'],
    [{ windows: [{ ...ok, users: [] }] }, 'users 空数组'],
    [{ windows: [{ ...ok, users: [''] }] }, 'users 含空串'],
    [{ windows: [{ ...ok, users: Array.from({ length: 51 }, (_, i) => 'u' + i) }] }, 'users 超 50'],
    [{ windows: Array.from({ length: 51 }, () => ({ ...ok })) }, '超 50 条时段'],
    [{ windows: [{ ...ok, note: 5 }] }, 'note 非字符串'],
  ]
  for (const [body, label] of bad) {
    const res = await put(body)
    assert.equal(res.status, 400, label)
    assert.equal(res.json().error, 'invalid', label)
    assert.ok(typeof res.json().message === 'string' && res.json().message, label + '：带具体原因')
  }
  assert.equal(await readRsv(home), null, '全部拒绝，不落盘')
})

test('PUT 404：nodeId 不在 config.environments', async t => {
  const home = await seedHome(t)
  const r = loadReservationRoutes(home, { ctx: authCtx() })
  const res = await call(r.put, reqWith('PUT', '/api/worktable/pipeline/reservations/env-x', { windows: [W1] }, TOKEN_ADMIN))
  assert.equal(res.status, 404)
  assert.equal(res.json().error, 'node-not-found')
  assert.equal(await readRsv(home), null, '404 不落盘')
})

test('PUT base 乐观并发：base 不一致 409 回全量不写盘；base 一致成功；窗口未变保留 id/createdBy/createdAt', async t => {
  const home = await seedHome(t, {
    reservations: [{ id: 'rsv-other', nodeId: 'env-2', users: ['u2'], start: W1_ISO.start, end: W1_ISO.end, note: '', createdBy: 'root', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }],
  })
  const r = loadReservationRoutes(home, { ctx: authCtx() })
  const url = '/api/worktable/pipeline/reservations/env-1'

  const first = await call(r.put, reqWith('PUT', url, { windows: [W1] }, TOKEN_ADMIN))
  assert.equal(first.status, 200)
  const r1 = first.json().reservations.find((x) => x.nodeId === 'env-1')

  /* base 一致（客户端带的是含 id 的完整快照）且窗口未变 → 幂等成功，原 id/createdBy/createdAt 保留 */
  const same = await call(r.put, reqWith('PUT', url, { windows: [W1], base: [r1] }, TOKEN_ADMIN))
  assert.equal(same.status, 200)
  const r2 = same.json().reservations.find((x) => x.nodeId === 'env-1')
  assert.equal(r2.id, r1.id, '窗口未变 → 保留原 id')
  assert.equal(r2.createdAt, r1.createdAt, '保留 createdAt')
  assert.equal(r2.createdBy, r1.createdBy, '保留 createdBy')

  /* base 陈旧（他端已把 env-1 窗口改空）→ 409，响应带服务端全量（含 env-2 的记录），不写盘 */
  const stale = await call(r.put, reqWith('PUT', url, { windows: [W1], base: [] }, TOKEN_ADMIN))
  assert.equal(stale.status, 409)
  assert.equal(stale.json().error, 'conflict')
  assert.equal(stale.json().reservations.length, 2, '409 回服务端当前全量')
  assert.ok(stale.json().reservations.some((x) => x.id === 'rsv-other'))
  const disk = await readRsv(home)
  assert.deepEqual(disk.reservations.find((x) => x.nodeId === 'env-1').id, r1.id, '409 不写盘')

  /* base 一致但窗口变更 → 新 id */
  const changed = await call(r.put, reqWith('PUT', url, { windows: [{ ...W1, note: '改' }], base: [r2] }, TOKEN_ADMIN))
  assert.equal(changed.status, 200)
  const r3 = changed.json().reservations.find((x) => x.nodeId === 'env-1')
  assert.notEqual(r3.id, r1.id, '窗口变更 → 换新 id')
  assert.equal(r3.note, '改')

  /* windows: [] = 清空该节点预留（合法） */
  const cleared = await call(r.put, reqWith('PUT', url, { windows: [], base: [r3] }, TOKEN_ADMIN))
  assert.equal(cleared.status, 200)
  assert.ok(!cleared.json().reservations.some((x) => x.nodeId === 'env-1'))
  assert.ok(cleared.json().reservations.some((x) => x.id === 'rsv-other'), '清空只影响本节点')
})

test('PUT 清挂：写某节点时一并删除 environments 里已不存在节点的记录', async t => {
  const home = await seedHome(t, {
    environments: [ENV1],   // env-gone 已不在节点列表
    reservations: [
      { id: 'rsv-a', nodeId: 'env-1', users: ['u1'], start: W1_ISO.start, end: W1_ISO.end, note: '', createdBy: 'root', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'rsv-gone', nodeId: 'env-gone', users: ['u2'], start: W1_ISO.start, end: W1_ISO.end, note: '', createdBy: 'root', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
    ],
  })
  const r = loadReservationRoutes(home, { ctx: authCtx() })
  const res = await call(r.put, reqWith('PUT', '/api/worktable/pipeline/reservations/env-1', { windows: [W1] }, TOKEN_ADMIN))
  assert.equal(res.status, 200)
  const disk = await readRsv(home)
  assert.equal(disk.reservations.length, 1, 'env-gone 的悬挂记录被清挂')
  assert.equal(disk.reservations[0].nodeId, 'env-1')
  assert.notEqual(disk.reservations[0].id, 'rsv-a', '本节点旧记录被替换')
})

/* ---- 强制点 a：运行 API（registerPipelineRunApi handler 内，buildPipelineApiRun 之后、execute 之前）---- */

function loadRunApi(home, { ctx = {}, store, reservations = [] } = {}) {
  const start = source.indexOf('/* ---------- 流水线 API 触发 ---------- */')
  const end = source.indexOf('/* ---------- 流水线 API 触发结束 ---------- */', start)
  assert.ok(start >= 0 && end > start, '流水线 API 触发实现未找到')
  const code = [extractFunction('isLocalTarget'), RESERVATION_HELPERS, source.slice(start, end)].join('\n')
  const handlers = {}
  const executions = []
  const sandbox = {
    URL, URLSearchParams, Promise, Buffer, AbortController, setTimeout, clearTimeout, console, pathResolve,
    DSH_HOME: home, readFileSync,
    PROXY_PATH: '/api/worktable/proxy',
    readJsonBody: async (req) => req.body || {},
    collectProxyResponse: async (body) => body,
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })
  sandbox.registerPipelineRunApi(
    { register(route) { handlers[route.path] = route.handler } },
    {
      readStore: async () => JSON.parse(JSON.stringify(store)),
      execute: async (plan) => { executions.push(plan) },
      createRunId: () => 'run-test-1',
      warn: () => {},
      ctx,
      readReservations: async () => JSON.parse(JSON.stringify(reservations)),
    },
  )
  assert.ok(handlers['/api/worktable/pipeline/run'], '缺少流水线运行前缀路由')
  return { handler: handlers['/api/worktable/pipeline/run'], executions }
}

async function callRun(handler, id, body, token) {
  const payload = Buffer.from(JSON.stringify(body ?? {}))
  const req = {
    method: 'POST',
    url: '/api/worktable/pipeline/run/' + encodeURIComponent(id),
    headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...(token ? { cookie: 'dsh_auth=' + token } : {}) },
    async *[Symbol.asyncIterator]() { yield payload },
  }
  const res = mockRes()
  await handler(req, res)
  return res
}

const RUN_STORE = {
  config: {
    pipelines: [{ id: 'p1', name: '发布流水线', stages: [{ id: 's1', name: '构建', kind: 'simulate', dur: 1 }], defaults: { environmentIds: ['env-1'], branch: 'main' } }],
    environments: [ENV1, ENV2],
    repositories: [],
  },
  history: [],
}
const nowCovering = () => ({
  id: 'rsv-now', nodeId: 'env-1', users: ['u1'],
  start: new Date(Date.now() - 3600e3).toISOString(), end: new Date(Date.now() + 3600e3).toISOString(),
  note: '', createdBy: 'root', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
})
const pastWindow = () => ({
  id: 'rsv-past', nodeId: 'env-1', users: ['u1'],
  start: new Date(Date.now() - 7200e3).toISOString(), end: new Date(Date.now() - 3600e3).toISOString(),
  note: '', createdBy: 'root', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
})

test('强制点 a（运行 API）：他人预留覆盖当前 → 403 reserved 且不入池；本人/admin/无覆盖/无 auth 放行', async t => {
  const home = await seedHome(t)
  const rsv = nowCovering()
  const load = (ctx, reservations) => loadRunApi(home, { ctx, store: RUN_STORE, reservations })

  const denied = await callRun(load(authCtx(), [rsv]).handler, 'p1', {}, TOKEN_U2)
  assert.equal(denied.status, 403)
  assert.equal(denied.json().error, 'reserved')
  assert.match(denied.json().message, /节点已被预留给其他用户/)
  assert.match(denied.json().message, /构建机1\(10\.0\.0\.1\)/)
  assert.deepEqual(denied.json().conflicts, [{ nodeId: 'env-1', name: '构建机1', ip: '10.0.0.1', users: ['u1'], until: rsv.end }], 'conflicts 明细齐全')

  const anon = await callRun(load(authCtx(), [rsv]).handler, 'p1', {}, null)
  assert.equal(anon.status, 403, 'auth 存在但无有效会话 → 按非 admin 匿名挡住（预期行为）')

  const mine = load(authCtx(), [rsv])
  const own = await callRun(mine.handler, 'p1', {}, TOKEN_U1)
  assert.equal(own.status, 202, '被预留用户本人放行')
  assert.equal(mine.executions.length, 1)

  const adminRun = load(authCtx(), [rsv])
  assert.equal((await callRun(adminRun.handler, 'p1', {}, TOKEN_ADMIN)).status, 202, 'admin 全权旁路')

  const past = load(authCtx(), [pastWindow()])
  assert.equal((await callRun(past.handler, 'p1', {}, TOKEN_U2)).status, 202, '无覆盖当前时段的预留 → 放行')

  const noAuth = load({}, [rsv])
  assert.equal((await callRun(noAuth.handler, 'p1', {}, TOKEN_U2)).status, 202, '无 auth 服务（token 共享模式）不校验')

  const none = load(authCtx(), [])
  assert.equal((await callRun(none.handler, 'p1', {}, TOKEN_U2)).status, 202, '无预留记录放行')
})

/* ---- 强制点 b：租约获取（leases 路由 acquire 分支；release 不校验）---- */

function loadLeases(home, { ctx = {}, environments = [ENV1, ENV2], reservations = [] } = {}) {
  const start = source.indexOf('  /* 节点占用租约（跨标签页')
  const end = source.indexOf('  // AI 日志分析', start)
  assert.ok(start >= 0 && end > start, 'leases 路由块未找到')
  const code = RESERVATION_HELPERS + '\n' + source.slice(start, end)
  const handlers = {}
  const acquireCalls = []
  const sandbox = {
    DSH_HOME: home, pathResolve, readFileSync, ctx,
    pipelineSupervisor: {
      leases: {
        list: () => [],
        acquire: (...args) => { acquireCalls.push(args); return { ok: true } },
        release: () => 0,
      },
    },
    readJsonBody: async (req) => req.body ?? {},
    readPipelineStore: async () => ({ config: { environments }, history: [] }),
    readReservationsStore: async () => ({ reservations: JSON.parse(JSON.stringify(reservations)) }),
    webServer: { register(route) { handlers[route.path] = route.handler } },
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  assert.ok(handlers['/api/worktable/pipeline/leases'], '缺少 leases 路由')
  return { handler: handlers['/api/worktable/pipeline/leases'], acquireCalls }
}

test('强制点 b（租约 acquire）：他人预留覆盖 → 403 reserved 且不放租；本人/admin/无 auth/未知 ip/release 放行', async t => {
  const home = await seedHome(t)
  const rsv = nowCovering()
  const acquire = (h, token, ips = ['10.0.0.1']) => call(h.handler, reqWith('POST', '/api/worktable/pipeline/leases', { action: 'acquire', runId: 'run-1', ips, label: 'l', by: 'x' }, token))

  const denied = loadLeases(home, { ctx: authCtx(), reservations: [rsv] })
  const res = await acquire(denied, TOKEN_U2)
  assert.equal(res.status, 403)
  assert.equal(res.json().error, 'reserved')
  assert.match(res.json().message, /节点已被预留给其他用户/)
  assert.equal(res.json().conflicts[0].nodeId, 'env-1')
  assert.equal(denied.acquireCalls.length, 0, '拒绝时不放租约')

  const mine = loadLeases(home, { ctx: authCtx(), reservations: [rsv] })
  assert.equal((await acquire(mine, TOKEN_U1)).status, 200, '被预留用户本人放行')
  assert.equal(mine.acquireCalls.length, 1)

  const admin = loadLeases(home, { ctx: authCtx(), reservations: [rsv] })
  assert.equal((await acquire(admin, TOKEN_ADMIN)).status, 200, 'admin 旁路')

  const noAuth = loadLeases(home, { ctx: {}, reservations: [rsv] })
  assert.equal((await acquire(noAuth, TOKEN_U2)).status, 200, '无 auth 服务不校验')

  const unknownIp = loadLeases(home, { ctx: authCtx(), reservations: [rsv] })
  assert.equal((await acquire(unknownIp, TOKEN_U2, ['10.9.9.9'])).status, 200, '映射不到环境节点的 ip 无预留约束')

  /* release / 其它 action 不校验 */
  const rel = loadLeases(home, { ctx: authCtx(), reservations: [rsv] })
  const released = await call(rel.handler, reqWith('POST', '/api/worktable/pipeline/leases', { action: 'release', runId: 'run-1', ips: ['10.0.0.1'] }, TOKEN_U2))
  assert.equal(released.status, 200)
  assert.equal(released.json().ok, true)
})

/* ---- 强制点 c：execPlan 兜底（定时/移交/入池计划；冲突按失败落史，不执行阶段）---- */

function loadExecPlan(home, { ctx = {}, store, reservations = [] } = {}) {
  const captured = []
  const sandbox = {
    DSH_HOME: home, pathResolve, readFileSync, ctx, console,
    readPipelineStore: async () => JSON.parse(JSON.stringify(store)),
    readReservationsStore: async () => ({ reservations: JSON.parse(JSON.stringify(reservations)) }),
    appendPipelineHistory: async (rec) => { captured.push(JSON.parse(JSON.stringify(rec))) },
    /* execPlan 引用但本路径不求值的 apply 级助手（randHex/hhmm/durText/stripSuffixName 在源码里是箭头函数，
       extractFunction 抽不到，给等价实现）；DEFAULT_PIPELINE_SCRIPTS_DIR 置空使归档目录不成立（folder=null） */
    DEFAULT_PIPELINE_SCRIPTS_DIR: '',
    stripSuffixName: (name) => String(name || '').replace(/\s*·\s*定时后缀\s*$/, '') || 'pipeline',
    hhmm: () => '10:00',
    durText: (sec) => Math.round(sec) + 's',
    randHex: (n) => 'x'.repeat(n),
  }
  const code = [
    ...['resolvePlanRunSettings', 'snapshotPipelineRunSettings', 'resolvePipelineScriptsDir', 'resolvePlanRepository', 'pipelineHistoryEnvNodes', 'serverPipelineStageGroups'].map((name) => extractFunction(name)),
    RESERVATION_HELPERS,
    extractFunction('execPlan'),
  ].join('\n')
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  assert.ok(typeof sandbox.execPlan === 'function', '缺少 execPlan')
  return { execPlan: sandbox.execPlan, captured }
}

const EXEC_STORE = { config: { environments: [ENV1, ENV2], repositories: [] }, history: [] }
const execPlanOf = (by, envs) => ({
  id: 'plan-1', runId: 'run-exec-1', pipelineName: '发布流水线', tag: 't-rsv', env: envs.length ? '10.0.0.1' : '',
  envs, by, stages: [], source: 'schedule', createdAt: 1,
})

test('强制点 c（execPlan 兜底）：冲突 → 返回 failed 并按失败落史（含明细），不执行阶段', async t => {
  const home = await seedHome(t)
  const rsv = nowCovering()
  const plan = execPlanOf('u2', [{ ...ENV1 }])

  const denied = loadExecPlan(home, { ctx: authCtx(), store: EXEC_STORE, reservations: [rsv] })
  const ret = await denied.execPlan(plan)
  assert.equal(ret, 'failed', '冲突时本次运行按失败结束')
  assert.equal(denied.captured.length, 1, '只落一次终态（writeLiveHistory(running) 在校验之后，未执行）')
  const rec = denied.captured[0]
  assert.equal(rec.status, 'failed')
  assert.equal(rec.tag, 't-rsv')
  assert.equal(rec.logs.length, 1, '无阶段日志，只有预留校验明细')
  assert.equal(rec.logs[0].stage, '节点预留校验')
  assert.equal(rec.logs[0].status, 'failed')
  assert.match(rec.logs[0].log, /节点已被预留给其他用户/)
  assert.match(rec.logs[0].log, /构建机1\(10\.0\.0\.1\)/)
  assert.match(rec.logs[0].log, /u1/)
  assert.match(rec.logs[0].log, new RegExp(rsv.end.replace(/[.]/g, '\\.')))
})

test('强制点 c（execPlan 兜底）：被预留用户本人 / admin 署名 / 无目标节点 / 无 auth 服务 → 正常执行', async t => {
  const home = await seedHome(t)
  const rsv = nowCovering()

  const mine = loadExecPlan(home, { ctx: authCtx(), store: EXEC_STORE, reservations: [rsv] })
  assert.equal(await mine.execPlan(execPlanOf('u1', [{ ...ENV1 }])), 'success', '被预留用户本人放行')
  assert.equal(mine.captured.length, 2, 'running + 终态两次落史')
  assert.equal(mine.captured[0].status, 'running')
  assert.equal(mine.captured[1].status, 'success')

  const admin = loadExecPlan(home, { ctx: authCtx(), store: EXEC_STORE, reservations: [rsv] })
  assert.equal(await admin.execPlan(execPlanOf('root', [{ ...ENV1 }])), 'success', 'admin 署名（users.yaml role:admin）旁路')

  const noEnvs = loadExecPlan(home, { ctx: authCtx(), store: EXEC_STORE, reservations: [rsv] })
  assert.equal(await noEnvs.execPlan(execPlanOf('u2', [])), 'success', 'pl.envs 为空（无目标节点）跳过校验')

  const noAuth = loadExecPlan(home, { ctx: {}, store: EXEC_STORE, reservations: [rsv] })
  assert.equal(await noAuth.execPlan(execPlanOf('u2', [{ ...ENV1 }])), 'success', '无 auth 服务（token 共享模式）跳过')
})

/* ---- 纯函数：覆盖/并集/admin/边界时刻/文案 ---- */

function loadPure() {
  const sandbox = {}
  vm.createContext(sandbox)
  vm.runInContext(RESERVATION_HELPERS, sandbox)
  /* vm realm 内新建的数组/对象原型与本 realm 不同，deepStrictEqual 会误判不等——返回值过一遍 JSON 归一 */
  const plain = (v) => JSON.parse(JSON.stringify(v))
  return {
    ...sandbox,
    normalizeReservationWindows: (input) => plain(sandbox.normalizeReservationWindows(input)),
    reservationConflictsForEnvs: (...args) => plain(sandbox.reservationConflictsForEnvs(...args)),
  }
}

test('纯函数 reservationConflictsForEnvs：覆盖判定、users 并集、admin 旁路、边界时刻', () => {
  const h = loadPure()
  const envs = [{ id: 'n1', name: '构建机1', ip: '10.0.0.1' }]
  const rsv = (start, end, users, nodeId = 'n1') => ({ nodeId, start, end, users })
  const T = Date.parse('2026-10-13T08:00:00.000Z')
  const covering = rsv('2026-10-13T06:00:00.000Z', '2026-10-13T10:00:00.000Z', ['u1'])

  assert.deepEqual(h.reservationConflictsForEnvs(envs, [], 'u2', false, T), [], '无预留 → 无冲突')
  const c = h.reservationConflictsForEnvs(envs, [covering], 'u2', false, T)
  assert.equal(c.length, 1, '覆盖且他人 → 冲突')
  assert.deepEqual(c[0], { nodeId: 'n1', name: '构建机1', ip: '10.0.0.1', users: ['u1'], until: '2026-10-13T10:00:00.000Z' })
  assert.deepEqual(h.reservationConflictsForEnvs(envs, [covering], 'u1', false, T), [], '被预留用户本人放行')
  assert.deepEqual(h.reservationConflictsForEnvs(envs, [covering], 'u2', true, T), [], 'admin 直接空数组')
  assert.equal(h.reservationConflictsForEnvs(envs, [covering], '', false, T).length, 1, '空串 username 按普通用户处理')

  /* 边界时刻：T==start 覆盖、T==end 不覆盖 */
  assert.equal(h.reservationConflictsForEnvs(envs, [covering], 'u2', false, Date.parse('2026-10-13T06:00:00.000Z')).length, 1, 'T==start 覆盖')
  assert.deepEqual(h.reservationConflictsForEnvs(envs, [covering], 'u2', false, Date.parse('2026-10-13T10:00:00.000Z')), [], 'T==end 不覆盖')

  /* 多记录并集：用户在任一覆盖记录即放行；until 取覆盖窗口中最早的 end */
  const earlier = rsv('2026-10-13T07:00:00.000Z', '2026-10-13T09:00:00.000Z', ['u2'])
  assert.deepEqual(h.reservationConflictsForEnvs(envs, [covering, earlier], 'u2', false, T), [], 'users 并集命中')
  const c2 = h.reservationConflictsForEnvs(envs, [covering, earlier], 'u3', false, T)
  assert.deepEqual(c2[0].users, ['u1', 'u2'], '冲突条目 users = 覆盖记录并集（排序）')
  assert.equal(c2[0].until, '2026-10-13T09:00:00.000Z', 'until = 覆盖窗口中最早的 end')

  assert.deepEqual(h.reservationConflictsForEnvs(envs, [rsv('2026-10-13T06:00:00.000Z', '2026-10-13T10:00:00.000Z', ['u1'], 'n2')], 'u2', false, T), [], '其它节点的预留不影响')
  assert.deepEqual(h.reservationConflictsForEnvs([], [covering], 'u2', false, T), [], '空 envs → 空')
  assert.deepEqual(h.reservationConflictsForEnvs(envs, [{ nodeId: 'n1', start: 'bad', end: 'bad', users: ['u1'] }], 'u2', false, T), [], '坏时间记录忽略')
  /* ip 兜底 nodeIp */
  const c3 = h.reservationConflictsForEnvs([{ id: 'n1', name: '', ip: '', nodeIp: '192.168.1.5' }], [covering], 'u2', false, T)
  assert.equal(c3[0].ip, '192.168.1.5')
})

test('纯函数 normalizeReservationWindows：规范化（ISO/去重排序/note 缺省与截断）与校验矩阵', () => {
  const h = loadPure()
  const ok = h.normalizeReservationWindows([{ start: '2026-10-13T06:00:00Z', end: '2026-10-13T10:00:00Z', users: ['u2', 'u1', 'u1'], note: 'n', id: 'rsv-x' }])
  assert.deepEqual(ok.windows, [{ start: '2026-10-13T06:00:00.000Z', end: '2026-10-13T10:00:00.000Z', users: ['u1', 'u2'], note: 'n' }], 'ISO 化 + users 去重排序；多余键忽略')
  const bare = h.normalizeReservationWindows([{ start: '2026-10-13T06:00:00Z', end: '2026-10-13T10:00:00Z', users: ['u1'] }])
  assert.equal(bare.windows[0].note, '', 'note 缺省空串')
  const long = h.normalizeReservationWindows([{ start: '2026-10-13T06:00:00Z', end: '2026-10-13T10:00:00Z', users: ['u1'], note: 'x'.repeat(300) }])
  assert.equal(long.windows[0].note.length, 200, 'note 截到 200 字符')
  assert.deepEqual(h.normalizeReservationWindows([]), { windows: [] }, '空数组合法（清空该节点）')

  const w = { start: '2026-10-13T06:00:00Z', end: '2026-10-13T10:00:00Z', users: ['u1'] }
  assert.ok(h.normalizeReservationWindows('x').error, '非数组')
  assert.ok(h.normalizeReservationWindows([{ ...w, start: w.end, end: w.start }]).error, 'start>=end')
  assert.ok(h.normalizeReservationWindows([{ ...w, start: 'bad' }]).error, '非法日期')
  assert.ok(h.normalizeReservationWindows([{ ...w, users: [] }]).error, 'users 空')
  assert.ok(h.normalizeReservationWindows([{ ...w, users: [' '] }]).error, 'users 空白串')
  assert.ok(h.normalizeReservationWindows([{ ...w, users: Array.from({ length: 51 }, (_, i) => 'u' + i) }]).error, 'users 超 50')
  assert.ok(h.normalizeReservationWindows(Array.from({ length: 51 }, () => ({ ...w }))).error, '超 50 条')
  assert.ok(h.normalizeReservationWindows([{ ...w, note: 1 }]).error, 'note 非字符串')
  assert.ok(h.normalizeReservationWindows([null]).error, '非对象元素')
})

test('纯函数 sameReservationWindow / reservationConflictMessage / hasAuthService', () => {
  const h = loadPure()
  const a = { start: '2026-10-13T06:00:00.000Z', end: '2026-10-13T10:00:00.000Z', users: ['u1', 'u2'], note: 'n' }
  assert.ok(h.sameReservationWindow(a, { ...a, users: ['u2', 'u1'] }), 'users 乱序仍相等')
  assert.ok(h.sameReservationWindow(a, { ...a, id: 'rsv-1', createdBy: 'root' }), '多余键不参与比对')
  assert.ok(!h.sameReservationWindow(a, { ...a, note: '' }), 'note 不同')
  assert.ok(!h.sameReservationWindow(a, { ...a, end: '2026-10-13T11:00:00.000Z' }), 'end 不同')
  assert.ok(!h.sameReservationWindow(a, { ...a, users: ['u1'] }), 'users 不同')
  assert.ok(!h.sameReservationWindow(a, null), 'null 不相等')

  assert.equal(
    h.reservationConflictMessage([{ nodeId: 'n1', name: '构建机1', ip: '10.0.0.1', users: ['u1', 'u2'], until: '2026-10-13T10:00:00.000Z' }]),
    '节点已被预留给其他用户：构建机1(10.0.0.1) 预留给 u1,u2，至 2026-10-13T10:00:00.000Z',
  )
  assert.match(h.reservationConflictMessage([{ nodeId: 'n1', name: '', ip: '', users: [], until: 'x' }]), /n1 预留给 其他用户/, '名称为空退化 nodeId、users 空写其他用户')

  assert.equal(h.hasAuthService({}), false, '无 auth 服务')
  assert.equal(h.hasAuthService({ auth: { sessions: { getByToken() {} } } }), true)
  assert.equal(h.hasAuthService({ get: (k) => (k === 'auth' ? { sessions: { getByToken() {} } } : undefined) }), true, 'ctx.get 兜底路径')
  assert.equal(h.hasAuthService({ auth: { sessions: {} } }), false, 'sessions 缺 getByToken')
})
