import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as pathResolve, dirname } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const rawSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
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

const OWNERSHIP_HELPERS = [
  BUILTIN_CONST_DECL,
  ...[
    'requestAuthToken', 'parseAuthUsersYaml', 'readAuthAdminUsers', 'resolveRequestAuth',
    'deepEqualIgnoring', 'isBuiltinPipelineEntry', 'trustedPipelineViolations', 'trustedPipelineWriteDeny',
    'pipelineEntryOwner', 'ownerPipelineViolations', 'ownerPipelineWriteDeny',
  ].map((name) => extractFunction(name)),
].join('\n')

function loadPipelineRoutes(home, { ctx = {} } = {}) {
  const start = source.indexOf('  // 流水线工作台（pipeline.html）的服务端持久化')
  const end = source.indexOf('  // ---- 流水线导入导出：服务端备份', start)
  assert.ok(start >= 0 && end > start, '流水线持久化路由块未找到')
  const helpers = [
    'cleanPipelineHistory', 'stripPipelineSharedMeta', 'samePipelineContent', 'mergePipelineFavoriteUsers', 'mergePipelinePinnedAt',
    'withPipelineSharedMeta', 'preserveDiskOnlyConfigKeys', 'mergePipelineConfigForWrite', 'pipelineConfigDifferenceIds',
    'mergePipelineHistoryForWrite', 'serializePipelineStore', 'mergePipelineOneForWrite',
  ].map((name) => extractFunction(name)).join('\n')
  const code = helpers + '\n' + OWNERSHIP_HELPERS + '\n' + source.slice(start, end)
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
  assert.ok(handlers['/api/worktable/pipeline/save-one'], '缺少 save-one 路由')
  return handlers
}

function loadOwnerHelpers(home) {
  const sandbox = { DSH_HOME: home, readFileSync }
  vm.createContext(sandbox)
  vm.runInContext(OWNERSHIP_HELPERS, sandbox)
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
  dave:
    passwordHash: scrypt$dddddddd
    role: admin
`

async function seedHome(t, { config, history = [], usersYaml = USERS_YAML } = {}) {
  const home = await mkdtemp(tmpdir() + '/pipeline-owner-')
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

const TOKEN_ADMIN = 'tok-admin-0000000000000000000000000000000000'
const TOKEN_ALICE = 'tok-alice-0000000000000000000000000000000000'
const TOKEN_BOB = 'tok-bob-000000000000000000000000000000000000'
const authCtx = () => ({
  auth: {
    sessions: {
      getByToken(token) {
        if (token === TOKEN_ADMIN) return { subject: 'dave', expiresAt: 0, revoked: false }
        if (token === TOKEN_ALICE) return { subject: 'alice', expiresAt: 0, revoked: false }
        if (token === TOKEN_BOB) return { subject: 'bob', expiresAt: 0, revoked: false }
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
const ownedBy = (id, name, owner, extra = {}) => pl(id, name, { owner, createdBy: owner, updatedBy: owner, ...extra })

test('pipelineEntryOwner：owner 优先、回退 createdBy、trim 归一', t => {
  const home = '/tmp'
  const h = loadOwnerHelpers(home)
  assert.equal(h.pipelineEntryOwner({ owner: 'bob', createdBy: 'alice' }), 'bob', 'owner 优先')
  assert.equal(h.pipelineEntryOwner({ createdBy: ' alice ' }), 'alice', '无 owner 回退 createdBy')
  assert.equal(h.pipelineEntryOwner({ owner: '  ', createdBy: 'alice' }), 'alice', '空白 owner 回退创建者')
  assert.equal(h.pipelineEntryOwner({ owner: '  ' }), '', '双空白按未署名')
  assert.equal(h.pipelineEntryOwner(null), '', '空条目安全')
})

test('非 admin 更新他人拥有的流水线 → 403 且不写盘', async t => {
  const config = { pipelines: [ownedBy('p1', 'Alice 的', 'alice'), ownedBy('p2', 'Bob 的', 'bob')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const tampered = { pipelines: [ownedBy('p1', '被 Bob 改名', 'alice'), ownedBy('p2', 'Bob 的', 'bob')] }
  const res = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: tampered, baseConfig: config, history: [] }, TOKEN_BOB))
  assert.equal(res.status, 403)
  assert.equal(res.json().error, 'owner')
  assert.match(res.json().message, /仅拥有者可更新\/删除/)
  assert.deepEqual(res.json().pipelineIds, ['p1'])
  assert.deepEqual((await readStore(home)).config, config, '拒绝时整体不写盘')
})

test('非 admin 删除他人拥有的流水线 → 403', async t => {
  const config = { pipelines: [ownedBy('p1', 'Alice 的', 'alice'), ownedBy('p2', 'Bob 的', 'bob')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const res = await call(h['/api/worktable/pipeline'],
    reqWith('PUT', { config: { pipelines: [ownedBy('p2', 'Bob 的', 'bob')] }, baseConfig: config, history: [] }, TOKEN_BOB))
  assert.equal(res.status, 403)
  assert.deepEqual(res.json().pipelineIds, ['p1'], '删除他人条目被拦')
  assert.deepEqual((await readStore(home)).config.pipelines.map(p => p.id), ['p1', 'p2'])
})

test('拥有者可更新/删除自己的流水线；未署名存量条目全员可写', async t => {
  const config = { pipelines: [ownedBy('p1', 'Alice 的', 'alice'), ownedBy('p2', 'Bob 的', 'bob'), pl('p3', '未署名')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const next = {
    pipelines: [
      ownedBy('p1', 'Alice 改自己', 'alice', { updatedBy: 'alice' }),
      ownedBy('p2', 'Bob 的', 'bob'),
      pl('p3', 'Alice 改未署名', { owner: 'alice', createdBy: 'alice' }),
      ownedBy('p4', 'Alice 新建', 'alice'),
    ],
  }
  const res = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: next, baseConfig: config, history: [] }, TOKEN_ALICE))
  assert.equal(res.status, 200, '改自己 + 改未署名 + 新建自己都放行')
  const disk = await readStore(home)
  assert.deepEqual(disk.config.pipelines.map(p => p.name), ['Alice 改自己', 'Bob 的', 'Alice 改未署名', 'Alice 新建'])
})

test('删除后被其他用户提交恢复（全量 PUT）→ 403，磁盘不复活', async t => {
  /* 磁盘上 p1 已被拥有者删除（只剩 p2）；Bob 的旧页面仍带着 p1 原样提交 */
  const stored = { pipelines: [ownedBy('p2', 'Bob 的', 'bob')] }
  const staleBase = { pipelines: [ownedBy('p1', 'Alice 的', 'alice'), ownedBy('p2', 'Bob 的', 'bob')] }
  const home = await seedHome(t, { config: stored })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const resurrect = {
    pipelines: [ownedBy('p1', 'Alice 的', 'alice'), ownedBy('p2', 'Bob 的', 'bob')],
  }
  /* Bob 声称 p1 相对基线“未改”也会因三方合并丢弃；这里覆盖“客户端把它当自己的变更/新增带回来” */
  const res = await call(h['/api/worktable/pipeline'],
    reqWith('PUT', { config: resurrect, baseConfig: { pipelines: [ownedBy('p2', 'Bob 的', 'bob')] }, history: [] }, TOKEN_BOB))
  assert.equal(res.status, 403, '把他人已删条目当作新增提交回来必须拒绝')
  assert.deepEqual(res.json().pipelineIds, ['p1'])
  assert.deepEqual((await readStore(home)).config.pipelines.map(p => p.id), ['p2'], '磁盘保持已删除')
})

test('删除后被其他用户 save-one 复活 → 不写盘（基线仍在 → 409；当新增提交 → 403）', async t => {
  const stored = { pipelines: [ownedBy('p2', 'Bob 的', 'bob')] }
  const home = await seedHome(t, { config: stored })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  /* 带旧基线：三方合并先报冲突（磁盘已删、内容偏离基线），同样不复活 */
  const withBase = await call(h['/api/worktable/pipeline/save-one'],
    reqWith('PUT', {
      pipeline: ownedBy('p1', 'Alice 的', 'alice'),
      basePipeline: ownedBy('p1', 'Alice 的', 'alice'),
      scriptsDir: '',
    }, TOKEN_BOB))
  assert.equal(withBase.status, 409, '磁盘已删且带基线：合并层 409 拦截')
  assert.deepEqual((await readStore(home)).config.pipelines.map(p => p.id), ['p2'])

  /* 当新增（无基线）：走拥有者校验，拒绝把他人条目提交回来 */
  const asNew = await call(h['/api/worktable/pipeline/save-one'],
    reqWith('PUT', {
      pipeline: ownedBy('p1', 'Alice 的', 'alice'),
      scriptsDir: '',
    }, TOKEN_BOB))
  assert.equal(asNew.status, 403)
  assert.equal(asNew.json().error, 'owner')
  assert.deepEqual([...asNew.json().pipelineIds], ['p1'])
  assert.deepEqual((await readStore(home)).config.pipelines.map(p => p.id), ['p2'], '磁盘保持已删除')
})

test('save-one 更新他人流水线 → 403；更新自己的 → 200', async t => {
  const config = { pipelines: [ownedBy('p1', 'Alice 的', 'alice'), ownedBy('p2', 'Bob 的', 'bob')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const deny = await call(h['/api/worktable/pipeline/save-one'],
    reqWith('PUT', {
      pipeline: ownedBy('p1', 'Bob 改 Alice 的', 'alice'),
      basePipeline: ownedBy('p1', 'Alice 的', 'alice'),
    }, TOKEN_BOB))
  assert.equal(deny.status, 403, 'save-one 与全量 PUT 同一口径')

  const allow = await call(h['/api/worktable/pipeline/save-one'],
    reqWith('PUT', {
      pipeline: ownedBy('p2', 'Bob 改自己的', 'bob'),
      basePipeline: ownedBy('p2', 'Bob 的', 'bob'),
    }, TOKEN_BOB))
  assert.equal(allow.status, 200)
  assert.equal((await readStore(home)).config.pipelines.find(p => p.id === 'p2').name, 'Bob 改自己的')
})

test('他人收藏/置顶（favoriteUsers / pinnedAt）不触发归属拦截', async t => {
  const config = { pipelines: [ownedBy('p1', 'Alice 的', 'alice')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const fav = { pipelines: [ownedBy('p1', 'Alice 的', 'alice', { favoriteUsers: ['bob'], pinnedAt: 123 })] }
  const res = await call(h['/api/worktable/pipeline'], reqWith('PUT', { config: fav, baseConfig: config, history: [] }, TOKEN_BOB))
  assert.equal(res.status, 200, '收藏/置顶是共享元数据，任何登录用户可改')
  const saved = (await readStore(home)).config.pipelines[0]
  assert.deepEqual(saved.favoriteUsers, ['bob'])
  assert.equal(saved.pinnedAt, 123)
})

test('admin 可更新/删除/复活任意流水线；新建不得把 owner 伪造成他人', async t => {
  const config = { pipelines: [ownedBy('p1', 'Alice 的', 'alice')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })

  const adminEdit = await call(h['/api/worktable/pipeline'],
    reqWith('PUT', { config: { pipelines: [ownedBy('p1', 'Admin 改', 'alice'), ownedBy('p2', 'Admin 新建', 'dave')] }, baseConfig: config, history: [] }, TOKEN_ADMIN))
  assert.equal(adminEdit.status, 200)

  const forge = await call(h['/api/worktable/pipeline'],
    reqWith('PUT', { config: { pipelines: [ownedBy('p3', '伪造', 'alice')] }, baseConfig: { pipelines: [] }, history: [] }, TOKEN_BOB))
  assert.equal(forge.status, 403, '非 admin 不得把新建条目的 owner 伪造成他人')
  assert.deepEqual(forge.json().pipelineIds, ['p3'])
})

test('token 共享模式（无 auth 服务）：归属校验整体放行', async t => {
  const config = { pipelines: [ownedBy('p1', 'Alice 的', 'alice')] }
  const home = await seedHome(t, { config })
  const h = loadPipelineRoutes(home, { ctx: {} })

  const res = await call(h['/api/worktable/pipeline'],
    reqWith('PUT', { config: { pipelines: [ownedBy('p1', '匿名改', 'alice'), ownedBy('p2', '匿名新建', 'bob')] }, baseConfig: config, history: [] }))
  assert.equal(res.status, 200, '与 trusted 同约定：无认证服务维持旧行为')
})

test('ownerPipelineViolations 单元：删/改/复活/伪造 owner 分别命中', t => {
  const h = loadOwnerHelpers('/tmp')
  const stored = { pipelines: [ownedBy('p1', 'A', 'alice'), ownedBy('p2', 'B', 'bob'), pl('p3', '未署名')] }
  const deleted = { pipelines: [ownedBy('p2', 'B', 'bob'), pl('p3', '未署名')] }
  /* vm 上下文的数组与宿主 Array 原型不同，拍平成字符串比较 */
  const ids = (list) => [...list].map(String).sort().join(',')
  assert.equal(ids(h.ownerPipelineViolations(stored, deleted, 'bob')), 'p1', '删他人')

  const modified = { pipelines: [ownedBy('p1', 'A 改', 'alice'), ownedBy('p2', 'B', 'bob'), pl('p3', '未署名')] }
  assert.equal(ids(h.ownerPipelineViolations(stored, modified, 'bob')), 'p1', '改他人')

  const resurrect = { pipelines: [ownedBy('p1', 'A', 'alice'), ownedBy('p2', 'B', 'bob'), pl('p3', '未署名')] }
  assert.equal(ids(h.ownerPipelineViolations({ pipelines: [ownedBy('p2', 'B', 'bob')] }, resurrect, 'bob')), 'p1', '复活他人')

  const forge = { pipelines: [ownedBy('p1', 'A', 'alice'), ownedBy('p2', 'B', 'bob'), pl('p3', '未署名'), ownedBy('p4', '伪', 'alice')] }
  assert.equal(ids(h.ownerPipelineViolations(stored, forge, 'bob')), 'p4', '伪造 owner')

  assert.equal(ids(h.ownerPipelineViolations(stored, stored, 'alice')), '', '无变更不拦')
  assert.equal(ids(h.ownerPipelineViolations(stored, modified, 'alice')), '', '拥有者改自己放行')
  assert.equal(ids(h.ownerPipelineViolations(stored, deleted, 'dave')), 'p1', 'violations 本身不感知 admin（writeDeny 负责放行）')
})
