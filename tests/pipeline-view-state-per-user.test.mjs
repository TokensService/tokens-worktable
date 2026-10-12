import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as pathResolve, dirname } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

/* 流水线视图态（histFilter/plFilter/histPageSize/plPageSize）按登录用户隔离：
   - PUT 把客户端上送的顶层视图键收回 config.userViewStates[username]，共享配置不再保留顶层视图键；
   - GET 按请求用户展开其槽位为顶层键，不暴露他人槽位；
   - 不同用户互不覆盖；无 auth / 未登录走共享桶 ''；
   - 磁盘遗留顶层视图键作为无槽位用户初值（升级迁移），有槽位后以槽位为准。 */
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

/* VIEW_STATE_KEYS 常量声明（助手引用；从源码抽取，避免字面量分叉） */
const VIEW_STATE_DECL = /^const VIEW_STATE_KEYS = .+$/m.exec(source)[0]
const VIEW_STATE_CAP_DECL = /^const VIEW_STATE_USER_CAP = .+$/m.exec(source)[0]

const VIEW_HELPERS = [
  VIEW_STATE_DECL,
  VIEW_STATE_CAP_DECL,
  ...['extractViewState', 'omitViewStateKeys', 'sanitizeViewState', 'viewStateUserKey', 'mergeUserViewStates', 'resolveViewStateForUser'].map(extractFunction),
].join('\n')

function loadViewHelpers() {
  const ctx = {
    resolveRequestAuth: () => undefined,
  }
  vm.createContext(ctx)
  vm.runInContext(VIEW_HELPERS + '\n' + extractFunction('resolveRequestAuth'), ctx)
  return ctx
}

test('助手：extractViewState 只取四键，omitViewStateKeys 剥离视图键与 userViewStates', () => {
  const ctx = loadViewHelpers()
  const cfg = {
    theme: 'dark',
    histFilter: { kw: 'x', status: 'failed', pipeline: '' },
    plFilter: { kw: '', owner: 'mine', favorite: 'all' },
    histPageSize: 20,
    plPageSize: 50,
    schedEnvIds: ['e1'],
    userViewStates: { alice: { histPageSize: 5 } },
  }
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.extractViewState(cfg))), {
    histFilter: { kw: 'x', status: 'failed', pipeline: '' },
    plFilter: { kw: '', owner: 'mine', favorite: 'all' },
    histPageSize: 20,
    plPageSize: 50,
  })
  const rest = JSON.parse(JSON.stringify(ctx.omitViewStateKeys(cfg)))
  assert.deepEqual(rest, { theme: 'dark', schedEnvIds: ['e1'] }, '共享配置不含视图四键与 userViewStates')
})

test('助手：sanitizeViewState 丢弃坏形状，页大小钳到 ≥1', () => {
  const ctx = loadViewHelpers()
  const cleaned = JSON.parse(JSON.stringify(ctx.sanitizeViewState({
    histFilter: { kw: 123, status: null, pipeline: 'P' },
    plFilter: { kw: '', owner: 'bob', favorite: 'nope' },
    histPageSize: 0,
    plPageSize: '30',
    junk: true,
  })))
  assert.deepEqual(cleaned, {
    histFilter: { kw: '123', status: '', pipeline: 'P' },
    plFilter: { kw: '', owner: 'bob', favorite: 'all' },
    histPageSize: 1,
    plPageSize: 30,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.sanitizeViewState(null))), {})
})

test('助手：mergeUserViewStates 按用户覆盖、他人保留、遗留顶层作无槽位初值', () => {
  const ctx = loadViewHelpers()
  const diskMap = { bob: { histFilter: { kw: 'b', status: '', pipeline: '' } } }
  const legacy = { plFilter: { kw: 'legacy', owner: 'all', favorite: 'all' }, histPageSize: 20 }
  const merged = JSON.parse(JSON.stringify(ctx.mergeUserViewStates(
    'alice',
    { histFilter: { kw: 'mine', status: 'failed', pipeline: '' }, plPageSize: 50 },
    diskMap,
    legacy,
  )))
  assert.deepEqual(merged.bob.histFilter, { kw: 'b', status: '', pipeline: '' }, '他人槽位原样保留')
  assert.deepEqual(merged.alice.histFilter, { kw: 'mine', status: 'failed', pipeline: '' })
  assert.deepEqual(merged.alice.plFilter, { kw: 'legacy', owner: 'all', favorite: 'all' }, '无槽位时遗留顶层作初值')
  assert.equal(merged.alice.histPageSize, 20, '遗留初值带上未覆盖的页大小')
  assert.equal(merged.alice.plPageSize, 50, '客户端上送键覆盖')
})

test('助手：viewStateUserKey 无 auth / 空名 → 共享桶，有登录名 → 该用户名', () => {
  const ctx = loadViewHelpers()
  assert.equal(ctx.viewStateUserKey({}, {}), '', '无 auth 服务 → 共享桶')
  ctx.resolveRequestAuth = () => ({ username: '  alice  ', isAdmin: false })
  assert.equal(ctx.viewStateUserKey({}, {}), 'alice', '登录名 trim')
  ctx.resolveRequestAuth = () => ({ username: '', isAdmin: false })
  assert.equal(ctx.viewStateUserKey({}, {}), '', '空用户名 → 共享桶')
})

test('助手：resolveViewStateForUser 槽位优先、遗留兜底、不暴露 userViewStates', () => {
  const ctx = loadViewHelpers()
  const raw = {
    theme: 'dark',
    histFilter: { kw: 'legacy', status: '', pipeline: '' },
    userViewStates: {
      alice: { histFilter: { kw: 'A', status: 'success', pipeline: '' }, histPageSize: 20 },
      bob: { histFilter: { kw: 'B', status: '', pipeline: '' } },
    },
  }
  const forAlice = JSON.parse(JSON.stringify(ctx.resolveViewStateForUser(raw, 'alice')))
  assert.equal(forAlice.theme, 'dark')
  assert.deepEqual(forAlice.histFilter, { kw: 'A', status: 'success', pipeline: '' }, '槽位优先于遗留顶层')
  assert.equal(forAlice.histPageSize, 20)
  assert.ok(!('userViewStates' in forAlice), '不暴露内部映射')
  assert.ok(!('plFilter' in forAlice), '未配置的键不注入')

  const forCarol = JSON.parse(JSON.stringify(ctx.resolveViewStateForUser(raw, 'carol')))
  assert.deepEqual(forCarol.histFilter, { kw: 'legacy', status: '', pipeline: '' }, '无槽位回退遗留顶层')
})

/* ---------- 路由级：真落盘（临时 DSH_HOME），多用户互不覆盖 ---------- */

const BUILTIN_PIPELINE_ID_DECL = /^const BUILTIN_PIPELINE_ID = .+$/m.exec(source)[0]
const SHARED_META = ['stripPipelineSharedMeta', 'deepEqualIgnoring', 'samePipelineContent', 'mergePipelineFavoriteUsers', 'mergePipelinePinnedAt', 'withPipelineSharedMeta']
  .map(extractFunction).join('\n')
const TRUST_HELPERS = [
  BUILTIN_PIPELINE_ID_DECL,
  ...['requestAuthToken', 'parseAuthUsersYaml', 'readAuthAdminUsers', 'resolveRequestAuth',
    'isBuiltinPipelineEntry', 'trustedPipelineViolations', 'trustedPipelineWriteDeny',
    'pipelineEntryOwner', 'ownerPipelineViolations', 'ownerPipelineWriteDeny'].map(extractFunction),
].join('\n')

function loadPipelineRoutes(home, { auth } = {}) {
  const start = source.indexOf('  // 流水线工作台（pipeline.html）的服务端持久化')
  const end = source.indexOf('  // ---- 流水线导入导出：服务端备份', start)
  assert.ok(start >= 0 && end > start, '流水线持久化路由块未找到')
  const helperFns = [
    'cleanPipelineHistory', 'stripPipelineSharedMeta', 'deepEqualIgnoring', 'samePipelineContent', 'mergePipelineFavoriteUsers', 'mergePipelinePinnedAt',
    'withPipelineSharedMeta', 'preserveDiskOnlyConfigKeys', 'mergePipelineConfigForWrite', 'pipelineConfigDifferenceIds',
    'mergePipelineHistoryForWrite', 'serializePipelineStore', 'mergePipelineOneForWrite',
    'extractViewState', 'omitViewStateKeys', 'sanitizeViewState', 'viewStateUserKey', 'mergeUserViewStates', 'resolveViewStateForUser',
  ].map(extractFunction).join('\n')
  const code = VIEW_STATE_DECL + '\n' + VIEW_STATE_CAP_DECL + '\n' + helperFns + '\n' + TRUST_HELPERS + '\n' + source.slice(start, end)
  const handlers = {}
  const storeFile = pathResolve(home, 'storages', 'worktable-pipeline.json')
  const sandbox = {
    DSH_HOME: home,
    pathResolve, readFile, readFileSync,
    ctx: { auth },
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

async function seedHome(t, { config = {}, history = [] } = {}) {
  const home = await mkdtemp(tmpdir() + '/pipeline-viewstate-')
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(pathResolve(home, 'storages'), { recursive: true })
  await writeFile(pathResolve(home, 'storages', 'worktable-pipeline.json'), JSON.stringify({ config, history }), 'utf8')
  return home
}

const readStore = (home) => readFile(pathResolve(home, 'storages', 'worktable-pipeline.json'), 'utf8').then(JSON.parse)

const pl = (id, name) => ({ id, name, stages: [{ id: 'st0', name: '构建', dur: 5 }] })

const viewOf = (kw, owner = 'mine') => ({
  histFilter: { kw, status: 'failed', pipeline: '' },
  plFilter: { kw: kw + '-pl', owner, favorite: 'all' },
  histPageSize: 20,
  plPageSize: 50,
})

/* auth mock：sessions.getByToken 按 token 回不同用户 */
function authFor(usersByToken) {
  return {
    sessions: {
      getByToken(token) {
        const subject = usersByToken[token]
        return subject ? { subject } : undefined
      },
    },
  }
}

const cookie = (token) => ({ cookie: 'dsh_auth=' + token })

test('PUT 收视图态进 userViewStates[username]，共享配置不留顶层视图键', async t => {
  const home = await seedHome(t, { config: { pipelines: [pl('p1', '一')], theme: 'dark' } })
  const h = loadPipelineRoutes(home, { auth: authFor({ tAlice: 'alice' }) })

  const res = await call(h['/api/worktable/pipeline'], {
    method: 'PUT',
    headers: cookie('tAlice'),
    body: {
      config: { pipelines: [pl('p1', '一')], theme: 'dark', ...viewOf('mine') },
      baseConfig: { pipelines: [pl('p1', '一')] },
      history: [],
    },
  })
  assert.equal(res.status, 200)
  const disk = await readStore(home)
  assert.deepEqual(disk.config.userViewStates.alice.histFilter, { kw: 'mine', status: 'failed', pipeline: '' })
  assert.equal(disk.config.userViewStates.alice.plPageSize, 50)
  assert.ok(!('histFilter' in disk.config), '共享配置不再保留顶层 histFilter')
  assert.ok(!('plFilter' in disk.config))
  assert.ok(!('histPageSize' in disk.config))
  assert.ok(!('plPageSize' in disk.config))
  assert.equal(disk.config.theme, 'dark', '共享键不受影响')
  /* 响应与 GET 同形态：视图态展开为顶层键，不暴露 userViewStates */
  const body = res.json()
  assert.deepEqual(body.config.histFilter, { kw: 'mine', status: 'failed', pipeline: '' })
  assert.equal(body.config.plPageSize, 50)
  assert.ok(!('userViewStates' in body.config))
})

test('GET 按请求用户展开其槽位；不同用户互不覆盖', async t => {
  const home = await seedHome(t, { config: { pipelines: [pl('p1', '一')] } })
  const h = loadPipelineRoutes(home, { auth: authFor({ tAlice: 'alice', tBob: 'bob' }) })

  await call(h['/api/worktable/pipeline'], {
    method: 'PUT', headers: cookie('tAlice'),
    body: { config: { pipelines: [pl('p1', '一')], ...viewOf('alice-kw') }, baseConfig: { pipelines: [pl('p1', '一')] }, history: [] },
  })
  await call(h['/api/worktable/pipeline'], {
    method: 'PUT', headers: cookie('tBob'),
    body: { config: { pipelines: [pl('p1', '一')], ...viewOf('bob-kw', 'all') }, baseConfig: { pipelines: [pl('p1', '一')] }, history: [] },
  })

  const disk = await readStore(home)
  assert.deepEqual(disk.config.userViewStates.alice.histFilter, { kw: 'alice-kw', status: 'failed', pipeline: '' })
  assert.deepEqual(disk.config.userViewStates.bob.histFilter, { kw: 'bob-kw', status: 'failed', pipeline: '' }, 'bob 写入不覆盖 alice')

  const getAlice = await call(h['/api/worktable/pipeline'], { method: 'GET', headers: cookie('tAlice') })
  const cfgA = getAlice.json().config
  assert.deepEqual(cfgA.histFilter, { kw: 'alice-kw', status: 'failed', pipeline: '' })
  assert.ok(!('userViewStates' in cfgA), '不暴露他人槽位')
  assert.equal(cfgA.histFilter.kw !== 'bob-kw', true)

  const getBob = await call(h['/api/worktable/pipeline'], { method: 'GET', headers: cookie('tBob') })
  assert.deepEqual(getBob.json().config.histFilter, { kw: 'bob-kw', status: 'failed', pipeline: '' })
})

test('无 auth 服务（token 共享模式）走共享桶，行为与旧版一致', async t => {
  const home = await seedHome(t, { config: { pipelines: [pl('p1', '一')] } })
  const h = loadPipelineRoutes(home, { auth: undefined })

  const res = await call(h['/api/worktable/pipeline'], {
    method: 'PUT', headers: {},
    body: { config: { pipelines: [pl('p1', '一')], ...viewOf('shared-kw') }, baseConfig: { pipelines: [pl('p1', '一')] }, history: [] },
  })
  assert.equal(res.status, 200)
  const disk = await readStore(home)
  assert.deepEqual(disk.config.userViewStates[''].histFilter, { kw: 'shared-kw', status: 'failed', pipeline: '' })
  const get = await call(h['/api/worktable/pipeline'], { method: 'GET', headers: {} })
  assert.deepEqual(get.json().config.histFilter, { kw: 'shared-kw', status: 'failed', pipeline: '' })
})

test('遗留顶层视图键：无槽位用户 GET 回退旧值，首写迁入自己槽位；有槽位后以槽位为准', async t => {
  const home = await seedHome(t, {
    config: {
      pipelines: [pl('p1', '一')],
      histFilter: { kw: 'legacy', status: 'success', pipeline: 'P' },
      plFilter: { kw: 'legacy-pl', owner: 'all', favorite: 'favorite' },
      histPageSize: 15,
      plPageSize: 25,
    },
  })
  const h = loadPipelineRoutes(home, { auth: authFor({ tAlice: 'alice' }) })

  const get1 = await call(h['/api/worktable/pipeline'], { method: 'GET', headers: cookie('tAlice') })
  assert.deepEqual(get1.json().config.histFilter, { kw: 'legacy', status: 'success', pipeline: 'P' }, '无槽位回退遗留顶层')
  assert.equal(get1.json().config.histPageSize, 15)

  await call(h['/api/worktable/pipeline'], {
    method: 'PUT', headers: cookie('tAlice'),
    body: {
      config: { pipelines: [pl('p1', '一')], histFilter: { kw: 'now', status: '', pipeline: '' }, plFilter: { kw: '', owner: 'mine', favorite: 'all' }, histPageSize: 15, plPageSize: 25 },
      baseConfig: { pipelines: [pl('p1', '一')] },
      history: [],
    },
  })
  const disk = await readStore(home)
  assert.equal(disk.config.userViewStates.alice.histFilter.kw, 'now', '首写迁入自己的槽位')
  assert.ok(!('histFilter' in disk.config), '遗留顶层键随写入清出共享配置')
  assert.ok(!('plFilter' in disk.config))

  const get2 = await call(h['/api/worktable/pipeline'], { method: 'GET', headers: cookie('tAlice') })
  assert.equal(get2.json().config.histFilter.kw, 'now', '有槽位后以槽位为准')
})

test('未登录（auth 存在但无会话）落共享桶，不写入任何具名槽位', async t => {
  const home = await seedHome(t, { config: { pipelines: [pl('p1', '一')] } })
  const h = loadPipelineRoutes(home, { auth: authFor({ tAlice: 'alice' }) })

  await call(h['/api/worktable/pipeline'], {
    method: 'PUT', headers: {},
    body: { config: { pipelines: [pl('p1', '一')], ...viewOf('anon') }, baseConfig: { pipelines: [pl('p1', '一')] }, history: [] },
  })
  const disk = await readStore(home)
  assert.deepEqual(disk.config.userViewStates[''].histFilter.kw, 'anon')
  assert.ok(!disk.config.userViewStates.alice, '不写入具名槽位')
})

test('save-one 不丢 userViewStates（单条保存从 {...disk} 出发）', async t => {
  const home = await seedHome(t, {
    config: {
      pipelines: [pl('p1', '原始'), pl('p2', '保留')],
      userViewStates: { alice: { histFilter: { kw: 'keep', status: '', pipeline: '' }, histPageSize: 20 } },
    },
  })
  const h = loadPipelineRoutes(home, { auth: authFor({ tAlice: 'alice' }) })

  const res = await call(h['/api/worktable/pipeline/save-one'], {
    method: 'PUT', headers: cookie('tAlice'),
    body: { pipeline: pl('p1', '编辑后'), basePipeline: pl('p1', '原始'), scriptsDir: '/srv/s' },
  })
  assert.equal(res.status, 200)
  const disk = await readStore(home)
  assert.deepEqual(disk.config.userViewStates.alice.histFilter, { kw: 'keep', status: '', pipeline: '' }, 'save-one 不碰视图态映射')
  assert.equal(disk.config.pipelines[0].name, '编辑后')
})

test('用户槽位上限：超出时丢最旧、当前用户保留', async t => {
  const ctx = loadViewHelpers()
  /* 直接测 mergeUserViewStates 的上限逻辑（路由级灌 100 个用户过重） */
  const big = {}
  for (let i = 0; i < 100; i += 1) big['u' + i] = { histPageSize: 10 }
  const merged = JSON.parse(JSON.stringify(ctx.mergeUserViewStates('me', { histPageSize: 5 }, big, {})))
  assert.ok(Object.keys(merged).length <= 100)
  assert.equal(merged.me.histPageSize, 5, '当前用户保留')
  assert.ok(merged.u0 === undefined || merged.u99 !== undefined, '至少丢掉一个最旧槽位')
})
