import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as pathResolve, dirname } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const rawSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
/* 先整体去类型（strip 模式保留注释标记、类型注解抹成空白、不改变偏移），后续切片/抽函数都在去类型后的源码上进行，
   避免函数返回类型里的 {} 干扰提取器的 brace 配对（如 Map<string, { role?: string }>）。 */
const source = stripTypeScriptTypes(rawSource, { mode: 'strip' })

/* 提取单个顶层函数（含可选 async 前缀；与 pipeline-config-concurrency 测试同一套 brace 配对手法） */
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

const TRUST_HELPERS = [
  'requestAuthToken', 'parseAuthUsersYaml', 'readAuthAdminUsers', 'resolveRequestAuth',
  'deepEqualIgnoring', 'trustedPipelineViolations', 'trustedPipelineWriteDeny',
].map((name) => extractFunction(name)).join('\n')

/* 从 src/index.ts 抽取「流水线工作台服务端持久化」路由块（PUT 全量 + save-one），前置真实的合并/校验助手，
   DSH_HOME 指向临时目录，writeJsonAtomic / withStoreLock / readPipelineStore 用测试内的等价实现 */
function loadPipelineRoutes(home, { ctx = {} } = {}) {
  const start = source.indexOf('  // 流水线工作台（pipeline.html）的服务端持久化')
  const end = source.indexOf('  // ---- 流水线导入导出：服务端备份', start)
  assert.ok(start >= 0 && end > start, '流水线持久化路由块未找到')
  const helpers = [
    'cleanPipelineHistory', 'mergePipelineConfigForWrite', 'pipelineConfigDifferenceIds',
    'mergePipelineHistoryForWrite', 'serializePipelineStore', 'mergePipelineOneForWrite',
  ].map((name) => extractFunction(name)).join('\n')
  const code = helpers + '\n' + TRUST_HELPERS + '\n' + source.slice(start, end)
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
    withStoreLock: (() => {   // 与源码同语义：读-改-写串行化
      let chain = Promise.resolve()
      return (fn) => { const p = chain.then(fn); chain = p.then(() => undefined, () => undefined); return p }
    })(),
    webServer: { register(route) { handlers[route.path] = route.handler } },
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  assert.ok(handlers['/api/worktable/pipeline'], '缺少全量 PUT 路由')
  assert.ok(handlers['/api/worktable/pipeline/save-one'], '缺少 save-one 路由')
  return handlers
}

/* 只加载可信流水线助手（users.yaml 迷你解析等单元测试用） */
function loadTrustHelpers(home) {
  const sandbox = {
    DSH_HOME: home,
    readFileSync,
  }
  vm.createContext(sandbox)
  vm.runInContext(TRUST_HELPERS, sandbox)
  return sandbox
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
  carol:
    passwordHash: scrypt$cccccccc
    role: admin
    disabled: true
`

async function seedHome(t, { config, history = [], usersYaml = USERS_YAML } = {}) {
  const home = await mkdtemp(tmpdir() + '/pipeline-trust-')
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

const pl = (id, name, extra = {}) => ({ id, name, stages: [{ id: 'st0', name: '构建', dur: 5 }], ...extra })
const trustedPl = (id, name, extra = {}) => pl(id, name, { trusted: true, favoriteUsers: ['alice'], ...extra })

test('users.yaml 迷你解析：普通用户 / admin / 引号 key 与值 / 缺 role / disabled 不影响 admin / 文件缺失', async t => {
  const home = await mkdtemp(tmpdir() + '/pipeline-trust-yaml-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const h = loadTrustHelpers(home)

  const parsed = h.parseAuthUsersYaml(USERS_YAML)
  assert.equal(parsed.get('alice').role, undefined, '普通用户无 role')
  assert.equal(parsed.get('bob').role, 'admin')
  assert.equal(parsed.get('carol').disabled, true, 'disabled 字段照实解析')

  const quoted = h.parseAuthUsersYaml('version: 1\nusers:\n  "we rd":\n    role: "admin"\n  \'single\' :\n    role: \'admin\'\n  norole:\n    passwordHash: scrypt$x\n')
  assert.equal(quoted.get('we rd').role, 'admin', '双引号包裹的 key 与值')
  assert.equal(quoted.get('single').role, 'admin', '单引号包裹的 key 与值')
  assert.equal(quoted.get('norole').role, undefined, '缺 role = 普通用户')

  const admins = h.readAuthAdminUsers(pathResolve(home, 'auth', 'users.yaml'))
  assert.deepEqual([...admins], [], '文件缺失 → 无人是 admin')

  await mkdir(pathResolve(home, 'auth'), { recursive: true })
  await writeFile(pathResolve(home, 'auth', 'users.yaml'), USERS_YAML, 'utf8')
  const admins2 = h.readAuthAdminUsers(pathResolve(home, 'auth', 'users.yaml'))
  assert.deepEqual([...admins2].sort(), ['bob', 'carol'], 'disabled 不影响 admin 判定（与 auth-gate isAdmin 一致）')

  const garbage = h.parseAuthUsersYaml('{{{not yaml')
  assert.equal(garbage.size, 0, '坏输入不抛错，按空解析')
})

test('token 共享模式（无 auth 服务）：全部写操作放行', async t => {
  const config = { pipelines: [trustedPl('p1', '可信'), pl('p2', '普通')], theme: 'dark' }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: {} })   // ctx 无 auth 服务

  const modified = { ...config, pipelines: [pl('p1', '改名', { favoriteUsers: [] }), pl('p2', '普通', { trusted: true }), pl('p3', '新建', { trusted: true })] }
  const res = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: modified, baseConfig: config, history: [] }))
  assert.equal(res.status, 200, '改内容/打标/新建 trusted 在无 auth 服务时一律放行')
  const disk = await readStore(home)
  assert.deepEqual(disk.config.pipelines.map(p => p.id), ['p1', 'p2', 'p3'])
  assert.equal(disk.config.pipelines[0].trusted, undefined, '摘标也生效')
})

test('非 admin：改 trusted 条目内容 → 403 且不写盘；仅改 favoriteUsers → 放行', async t => {
  const config = { pipelines: [trustedPl('p1', '可信'), pl('p2', '普通')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const tampered = { pipelines: [trustedPl('p1', '篡改'), pl('p2', '普通')] }
  const deny = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: tampered, baseConfig: config, history: [] }, TOKEN_USER))
  assert.equal(deny.status, 403)
  assert.equal(deny.json().error, 'trusted')
  assert.match(deny.json().message, /可信/)
  assert.match(deny.json().message, /admin/)
  assert.deepEqual(deny.json().pipelineIds, ['p1'])
  assert.deepEqual((await readStore(home)).config, config, '拒绝时整体不写盘')

  const favOnly = { pipelines: [trustedPl('p1', '可信', { favoriteUsers: [] }), pl('p2', '普通')] }
  const allow = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: favOnly, baseConfig: config, history: [] }, TOKEN_USER))
  assert.equal(allow.status, 200, 'favoriteUsers 是按用户收藏的个人数据，任何登录用户可改')
  assert.deepEqual((await readStore(home)).config.pipelines[0].favoriteUsers, [])
})

test('非 admin：摘标 / 删除 / 打标 / 新建 trusted → 全部 403 且不写盘', async t => {
  const config = { pipelines: [trustedPl('p1', '可信'), pl('p2', '普通')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })
  const put = (pipelines) => call(h['/api/worktable/pipeline'], reqWith('PUT', { config: { pipelines }, baseConfig: config, history: [] }, TOKEN_USER))

  const unmark = await put([pl('p1', '可信', { favoriteUsers: ['alice'] }), pl('p2', '普通')])
  assert.equal(unmark.status, 403, '摘除 trusted 标记')
  assert.deepEqual(unmark.json().pipelineIds, ['p1'])

  const remove = await put([pl('p2', '普通')])
  assert.equal(remove.status, 403, '删除 trusted 条目')
  assert.deepEqual(remove.json().pipelineIds, ['p1'])

  const mark = await put([trustedPl('p1', '可信'), pl('p2', '普通', { trusted: true })])
  assert.equal(mark.status, 403, '给既有条目打标')
  assert.deepEqual(mark.json().pipelineIds, ['p2'])
  assert.match(mark.json().message, /仅 admin 可将流水线标记为可信/)

  const create = await put([trustedPl('p1', '可信'), pl('p2', '普通'), pl('p3', '新建', { trusted: true })])
  assert.equal(create.status, 403, '新建即带 trusted')
  assert.deepEqual(create.json().pipelineIds, ['p3'])

  const mixed = await put([pl('p2', '普通'), pl('p3', '新建', { trusted: true })])
  assert.equal(mixed.status, 403, '删除 + 新建并存时两类信息合并')
  assert.match(mixed.json().message, /可信，仅 admin 可编辑/)
  assert.match(mixed.json().message, /仅 admin 可将流水线标记为可信/)
  assert.deepEqual(mixed.json().pipelineIds, ['p1', 'p3'])

  assert.deepEqual((await readStore(home)).config, config, '全部拒绝，磁盘保持原样')
})

test('非 admin：修改未 trusted 的流水线 → 放行（含新建/删除普通条目）', async t => {
  const config = { pipelines: [trustedPl('p1', '可信'), pl('p2', '普通')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const next = { pipelines: [trustedPl('p1', '可信'), pl('p2', '改名'), pl('p3', '新建普通')], theme: 'light' }
  const res = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: next, baseConfig: config, history: [] }, TOKEN_USER))
  assert.equal(res.status, 200)
  const disk = await readStore(home)
  assert.deepEqual(disk.config.pipelines.map(p => [p.id, p.name]), [['p1', '可信'], ['p2', '改名'], ['p3', '新建普通']])
  assert.equal(disk.config.pipelines[0].trusted, true, 'trusted 条目原样保留')
  assert.equal(disk.config.theme, 'light')
})

test('admin：trusted 条目改内容 / 摘标 / 删除 / 打标 全部放行', async t => {
  const config = { pipelines: [trustedPl('p1', '可信'), pl('p2', '普通')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const edit = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: { pipelines: [trustedPl('p1', '管理员改名'), pl('p2', '普通')] }, baseConfig: config, history: [] }, TOKEN_ADMIN))
  assert.equal(edit.status, 200, 'admin 改 trusted 内容')

  const unmark = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: { pipelines: [pl('p1', '管理员改名', { favoriteUsers: ['alice'] }), pl('p2', '普通', { trusted: true })] }, baseConfig: edit.json().config, history: [] }, TOKEN_ADMIN))
  assert.equal(unmark.status, 200, 'admin 摘标 + 给别的条目打标')
  const disk = await readStore(home)
  assert.equal(disk.config.pipelines[0].trusted, undefined)
  assert.equal(disk.config.pipelines[1].trusted, true)

  const remove = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: { pipelines: [pl('p1', '管理员改名', { favoriteUsers: ['alice'] })] }, baseConfig: unmark.json().config, history: [] }, TOKEN_ADMIN))
  assert.equal(remove.status, 200, 'admin 删除 trusted 条目')
  assert.deepEqual((await readStore(home)).config.pipelines.map(p => p.id), ['p1'])
})

test('auth 服务存在但会话缺失/无效 → 按非 admin（403）；无 Cookie 时试 Bearer', async t => {
  const config = { pipelines: [trustedPl('p1', '可信'), pl('p2', '普通')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })
  const tampered = { pipelines: [trustedPl('p1', '篡改'), pl('p2', '普通')] }

  const noToken = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: tampered, baseConfig: config, history: [] }))
  assert.equal(noToken.status, 403, '无会话按非 admin')

  const ghost = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: tampered, baseConfig: config, history: [] }, TOKEN_GHOST))
  assert.equal(ghost.status, 403, '无效 token 按非 admin')

  const bearer = await call(h['/api/worktable/pipeline'], {
    method: 'PUT', body: { config: tampered, baseConfig: config, history: [] },
    headers: { authorization: 'Bearer ' + TOKEN_USER },
  })
  assert.equal(bearer.status, 403, 'Bearer 通道同样识别为非 admin')

  const bearerAdmin = await call(h['/api/worktable/pipeline'], {
    method: 'PUT', body: { config: tampered, baseConfig: config, history: [] },
    headers: { authorization: 'Bearer ' + TOKEN_ADMIN },
  })
  assert.equal(bearerAdmin.status, 200, 'Bearer 携带 admin token 放行')
})

test('users.yaml 缺失但有 auth 服务：无人是 admin，非 admin 限制生效', async t => {
  const config = { pipelines: [trustedPl('p1', '可信')] }
  const home = await seedHome(t, { config, usersYaml: null })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })
  const res = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: { pipelines: [trustedPl('p1', '篡改')] }, baseConfig: config, history: [] }, TOKEN_USER))
  assert.equal(res.status, 403)
  const adminToo = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: { pipelines: [trustedPl('p1', '篡改')] }, baseConfig: config, history: [] }, TOKEN_ADMIN))
  assert.equal(adminToo.status, 403, 'users.yaml 缺失时 bob 也不再是 admin')
})

test('save-one 单条保存：非 admin 改 trusted 内容 → 403；仅改 favoriteUsers → 放行；admin → 放行', async t => {
  const config = { pipelines: [trustedPl('p1', '可信'), pl('p2', '普通')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })
  const saveOne = (pipeline, basePipeline, token) => call(h['/api/worktable/pipeline/save-one'], reqWith('PUT', { pipeline, basePipeline }, token))

  const deny = await saveOne(trustedPl('p1', '篡改'), trustedPl('p1', '可信'), TOKEN_USER)
  assert.equal(deny.status, 403)
  assert.equal(deny.json().error, 'trusted')
  assert.deepEqual(deny.json().pipelineIds, ['p1'])
  assert.deepEqual((await readStore(home)).config, config, '拒绝时不写盘')

  const createTrusted = await saveOne(pl('p9', '新建', { trusted: true }), null, TOKEN_USER)
  assert.equal(createTrusted.status, 403, '非 admin 经 save-one 新建 trusted 同样拦截')

  const fav = await saveOne(trustedPl('p1', '可信', { favoriteUsers: ['alice', 'bob'] }), trustedPl('p1', '可信'), TOKEN_USER)
  assert.equal(fav.status, 200, '仅改 favoriteUsers 放行')
  assert.deepEqual((await readStore(home)).config.pipelines[0].favoriteUsers, ['alice', 'bob'])

  const adminEdit = await saveOne(trustedPl('p1', '管理员改名', { favoriteUsers: ['alice', 'bob'] }), fav.json().config.pipelines[0], TOKEN_ADMIN)
  assert.equal(adminEdit.status, 200, 'admin 经 save-one 改 trusted 放行')
  assert.equal((await readStore(home)).config.pipelines[0].name, '管理员改名')

  const other = await saveOne(pl('p2', '普通改名'), pl('p2', '普通'), TOKEN_USER)
  assert.equal(other.status, 200, '非 admin 改普通条目不误伤')
})

test('非 admin 的运行期全量保存（条目未变、仅历史推进）不误伤 trusted 流水线', async t => {
  const config = { pipelines: [trustedPl('p1', '可信'), pl('p2', '普通')], buildNo: 3 }
  const home = await seedHome(t, { config, history: [{ tag: 'old', ts: 100 }] })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })
  /* 与页面 pushState 同形：config 原样回传（条目未编辑），history 带新运行记录 */
  const res = await call(h['/api/worktable/pipeline'], reqWith('PUT', {
    config, baseConfig: config,
    history: [{ tag: 'new', ts: 200 }, { tag: 'old', ts: 100 }],
  }, TOKEN_USER))
  assert.equal(res.status, 200, '运行历史写入不受 trusted 限制（只限制编辑定义）')
  const disk = await readStore(home)
  assert.deepEqual(disk.config.pipelines, config.pipelines, '条目共识未变')
  assert.equal(disk.history[0].tag, 'new')
})
