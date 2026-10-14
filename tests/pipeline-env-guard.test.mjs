/* 节点环境写保护（environmentsWriteDeny，配节点仅 admin）的服务端路由测试：
   - token 共享模式（无 auth 服务）：环境变更一律放行（与 trusted/owner 守卫同一约定）；
   - 非 admin：新增/修改/删除节点 → 403 {error:'envs'} 且整体不写盘；仅顺序/多余字段差异不算变更；
   - 非 admin：环境未改动的普通保存（含他端并发增删节点随合并保留）放行；
   - admin：增/改/删全权；
   - 空库播种：磁盘尚无节点环境时非 admin 首次携带节点放行（此后存量变更仍 403）；
   - auth 存在但会话无效（ghost token）按非 admin 处理。
   路由块抽取与可信/归属守卫测试（pipeline-trust.test.mjs）同一套手法。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as pathResolve, dirname } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const rawSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
/* 先整体去类型（strip 模式保留注释标记、类型注解抹成空白、不改变偏移），后续切片/抽函数都在去类型后的源码上进行 */
const source = stripTypeScriptTypes(rawSource, { mode: 'strip' })

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

const BUILTIN_CONST_DECL = (() => {
  const match = /^const BUILTIN_PIPELINE_ID = .+$/m.exec(source)
  assert.ok(match, 'src/index.ts 缺少 BUILTIN_PIPELINE_ID 常量')
  return match[0]
})()

const HELPERS = [
  BUILTIN_CONST_DECL,
  ...[
    'requestAuthToken', 'parseAuthUsersYaml', 'readAuthAdminUsers', 'resolveRequestAuth',
    'deepEqualIgnoring', 'isBuiltinPipelineEntry', 'trustedPipelineViolations', 'trustedPipelineWriteDeny',
    'pipelineEntryOwner', 'ownerPipelineViolations', 'ownerPipelineWriteDeny',
    'sameEnvironmentContent', 'environmentsWriteDeny',
  ].map((name) => extractFunction(name)),
].join('\n')

/* 与 pipeline-trust.test.mjs 同一手法：抽取「流水线工作台服务端持久化」路由块（全量 PUT + save-one），
   DSH_HOME 指向临时目录，writeJsonAtomic / withStoreLock / readPipelineStore 用测试内等价实现 */
function loadPipelineRoutes(home, { ctx = {} } = {}) {
  const start = source.indexOf('  // 流水线工作台（pipeline.html）的服务端持久化')
  const end = source.indexOf('  // ---- 流水线导入导出：服务端备份', start)
  assert.ok(start >= 0 && end > start, '流水线持久化路由块未找到')
  const viewDecls = [
    /^const VIEW_STATE_KEYS = .+$/m.exec(source)[0],
    /^const VIEW_STATE_USER_CAP = .+$/m.exec(source)[0],
  ].join('\n')
  const helpers = [
    'cleanPipelineHistory', 'stripPipelineSharedMeta', 'samePipelineContent', 'mergePipelineFavoriteUsers', 'mergePipelinePinnedAt',
    'withPipelineSharedMeta', 'preserveDiskOnlyConfigKeys', 'mergePipelineConfigForWrite', 'pipelineConfigDifferenceIds',
    'mergeStageLogsForHistory', 'mergePipelineHistoryForWrite', 'serializePipelineStore', 'mergePipelineOneForWrite',
    'extractViewState', 'omitViewStateKeys', 'sanitizeViewState', 'viewStateUserKey', 'mergeUserViewStates', 'resolveViewStateForUser',
  ].map((name) => extractFunction(name)).join('\n')
  const code = viewDecls + '\n' + helpers + '\n' + HELPERS + '\n' + source.slice(start, end)
  const handlers = {}
  const storeFile = pathResolve(home, 'storages', 'worktable-pipeline.json')
  const sandbox = {
    DSH_HOME: home,
    pathResolve, readFile, readFileSync, ctx,
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
    withStoreLock: (() => {
      let chain = Promise.resolve()
      return (fn) => { const p = chain.then(fn); chain = p.then(() => undefined, () => undefined); return p }
    })(),
    webServer: { register(route) { handlers[route.path] = route.handler } },
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  assert.ok(handlers['/api/worktable/pipeline'], '缺少全量 PUT 路由')
  return handlers
}

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

const USERS_YAML = `version: 1
users:
  alice:
    passwordHash: scrypt$aaaaaaaa
  bob:
    passwordHash: scrypt$bbbbbbbb
    role: admin
`

async function seedHome(t, { config, history = [], usersYaml = USERS_YAML } = {}) {
  const home = await mkdtemp(tmpdir() + '/pipeline-env-guard-')
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(pathResolve(home, 'storages'), { recursive: true })
  await writeFile(pathResolve(home, 'storages', 'worktable-pipeline.json'), JSON.stringify({ config, history }), 'utf8')
  if (usersYaml !== null) {
    await mkdir(pathResolve(home, 'auth'), { recursive: true })
    await writeFile(pathResolve(home, 'auth', 'users.yaml'), usersYaml, 'utf8')
  }
  return home
}

const readStore = (home) => readFile(pathResolve(home, 'storages', 'worktable-pipeline.json'), 'utf8').then(JSON.parse)

/* 会话桩：token → {subject}；auth 服务形态与 dsh-auth-gate 的 ctx.provide('auth') 一致（getByToken 同步） */
const TOKEN_ADMIN = 'tok-admin-0000000000000000000000000000000000'
const TOKEN_USER = 'tok-user-00000000000000000000000000000000000'
const TOKEN_GHOST = 'tok-ghost-0000000000000000000000000000000000'   // 已撤销/不存在
const authCtx = () => ({
  auth: {
    sessions: {
      getByToken(token) {
        if (token === TOKEN_ADMIN) return { subject: 'bob', expiresAt: 0, revoked: false }
        if (token === TOKEN_USER) return { subject: 'alice', expiresAt: 0, revoked: false }
        return undefined
      },
    },
  },
})
const reqWith = (method, body, token) => ({
  method, body,
  headers: token ? { cookie: 'other=1; dsh_auth=' + token + '; theme=dark' } : {},
})

const env = (id, name, extra = {}) => ({ id, name, ip: '10.0.0.1', nodeIp: '', llmAddr: '', user: '', pass: '', ...extra })
const pl = (id, name) => ({ id, name, stages: [{ id: 'st0', name: '构建', dur: 5 }] })

test('token 共享模式（无 auth 服务）：节点增删改一律放行', async t => {
  const config = { pipelines: [pl('p1', 'A')], environments: [env('e1', '生产')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: {} })   // ctx 无 auth 服务

  const modified = { pipelines: [pl('p1', 'A')], environments: [env('e1', '改名', { pass: 'x' }), env('e2', '新增')] }
  const res = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: modified, baseConfig: config, history: [] }))
  assert.equal(res.status, 200, '无 auth 服务时环境变更放行')
  const disk = await readStore(home)
  assert.deepEqual(disk.config.environments.map(e => e.name), ['改名', '新增'])
})

test('非 admin：修改/新增/删除节点 → 403 envs 且整体不写盘（连同同包的流水线改动）', async t => {
  const config = { pipelines: [pl('p1', 'A')], environments: [env('e1', '生产'), env('e2', '测试')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })
  const put = (environments, pipelines) => call(h['/api/worktable/pipeline'], reqWith('PUT',
    { config: { pipelines: pipelines || [pl('p1', 'A')], environments }, baseConfig: config, history: [] }, TOKEN_USER))

  const edit = await put([env('e1', '生产', { pass: 'tampered' }), env('e2', '测试')])
  assert.equal(edit.status, 403, '改节点内容')
  assert.equal(edit.json().error, 'envs')
  assert.match(edit.json().message, /仅 admin/)

  const add = await put([env('e1', '生产'), env('e2', '测试'), env('e3', '私加')])
  assert.equal(add.status, 403, '新增节点')

  const del = await put([env('e1', '生产')])
  assert.equal(del.status, 403, '删除节点')

  /* 环境未改动、仅改流水线：放行（守卫不误伤正常保存） */
  const plOnly = await put([env('e1', '生产'), env('e2', '测试')], [pl('p1', '改名')])
  assert.equal(plOnly.status, 200, '环境未改动时流水线保存放行')

  const disk = await readStore(home)
  assert.deepEqual(disk.config.environments, config.environments, '三次 403 均未写盘')
  assert.equal(disk.config.pipelines[0].name, '改名', '放行的流水线改动正常落盘')
})

test('非 admin：他端并发新增/删除节点随合并保留，不被守卫误判为本端变更', async t => {
  const base = { pipelines: [pl('p1', 'A')], environments: [env('e1', '生产')] }
  /* 磁盘已是他端（admin）改过的样子：新增 e2、改 e1 密码 */
  const disk = { pipelines: [pl('p1', 'A')], environments: [env('e1', '生产', { pass: 'new' }), env('e2', '新增')] }
  const home = await seedHome(t, { config: disk })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  /* 本端（非 admin）基线是旧的，只改流水线名、环境未动 → 合并后环境=磁盘 → 放行且保留他端改动 */
  const res = await call(h['/api/worktable/pipeline'], reqWith('PUT',
    { config: { pipelines: [pl('p1', '改名')], environments: base.environments }, baseConfig: base, history: [] }, TOKEN_USER))
  assert.equal(res.status, 200)
  const stored = await readStore(home)
  assert.deepEqual(stored.config.environments.map(e => [e.id, e.name, e.pass || '']),
    [['e1', '生产', 'new'], ['e2', '新增', '']], '他端节点改动按三方合并保留')
  assert.equal(stored.config.pipelines[0].name, '改名')
})

test('非 admin：仅条目顺序不同 / 携带多余字段不算环境变更', async t => {
  const config = { pipelines: [pl('p1', 'A')], environments: [env('e1', '生产'), env('e2', '测试')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  /* 顺序颠倒 + 多余字段（sameEnvironmentContent 只认规范字段；合并层对未改动条目以磁盘为准） */
  const reordered = [{ ...env('e2', '测试'), legacy: 'x' }, { ...env('e1', '生产'), extra: { a: 1 } }]
  const res = await call(h['/api/worktable/pipeline'], reqWith('PUT',
    { config: { pipelines: [pl('p1', 'A')], environments: reordered }, baseConfig: config, history: [] }, TOKEN_USER))
  assert.equal(res.status, 200, '顺序/多余字段差异不触发守卫')
  assert.deepEqual((await readStore(home)).config.environments.map(e => e.id), ['e1', 'e2'], '磁盘顺序保持')
})

test('admin：新增/修改/删除节点全权放行', async t => {
  const config = { pipelines: [pl('p1', 'A')], environments: [env('e1', '生产'), env('e2', '测试')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const modified = { pipelines: [pl('p1', 'A')], environments: [env('e2', '测试', { user: 'root' }), env('e3', '新机房')] }
  const res = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: modified, baseConfig: config, history: [] }, TOKEN_ADMIN))
  assert.equal(res.status, 200)
  const disk = await readStore(home)
  assert.deepEqual(disk.config.environments.map(e => e.id), ['e2', 'e3'], 'admin 的增删改落盘')
  assert.equal(disk.config.environments[0].user, 'root')
})

test('auth 存在但会话无效（ghost token）：按非 admin 拦截环境变更', async t => {
  const config = { pipelines: [pl('p1', 'A')], environments: [env('e1', '生产')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const res = await call(h['/api/worktable/pipeline'], reqWith('PUT',
    { config: { pipelines: [pl('p1', 'A')], environments: [env('e1', '篡改')] }, baseConfig: config, history: [] }, TOKEN_GHOST))
  assert.equal(res.status, 403)
  assert.equal(res.json().error, 'envs')
})

test('空库播种：磁盘尚无节点环境时非 admin 首次携带节点放行；此后存量变更仍 403', async t => {
  const home = await seedHome(t, { config: { pipelines: [pl('p1', 'A')] } })   // 无 environments 键
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const seedCfg = { pipelines: [pl('p1', 'A')], environments: [env('e1', '生产')] }
  const seed = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: seedCfg, baseConfig: { pipelines: [pl('p1', 'A')] }, history: [] }, TOKEN_USER))
  assert.equal(seed.status, 200, '空库首次播种放行（防新部署锁死）')
  assert.deepEqual((await readStore(home)).config.environments.map(e => e.id), ['e1'])

  const tamper = await call(h['/api/worktable/pipeline'], reqWith('PUT',
    { config: { pipelines: [pl('p1', 'A')], environments: [env('e1', '改名')] }, baseConfig: seedCfg, history: [] }, TOKEN_USER))
  assert.equal(tamper.status, 403, '播种后存量变更仍仅 admin')
})
