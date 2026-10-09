import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as pathResolve, dirname } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

/* 「列表复制按钮生成的副本无法在编辑器改名」的服务端复现/回归测试：
   用真实路由代码（从 src/index.ts 抽取，临时 DSH_HOME 落真盘）+ 字节级忠实的客户端模拟
   （迁移/合并函数从 projects/pipeline/pipeline.html 抽取，复制/改名/保存的数据操作逐行对照
   copyPipeline:8667 / savePlForm:8511 / pushPipelineOne:1195 / pushState:1119 / loadServerState:1273）。 */

const rawSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
/* 先整体去类型（strip 模式保留注释标记、类型注解抹成空白、不改变偏移），与 pipeline-trust 测试同一手法 */
const source = stripTypeScriptTypes(rawSource, { mode: 'strip' })
const page = await readFile(new URL('../projects/pipeline/pipeline.html', import.meta.url), 'utf8')

function extractFunction(name, text = source) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const match = marker.exec(text)
  assert.ok(match, `缺少函数 ${name}`)
  const bodyStart = text.indexOf('{', match.index)
  let depth = 0
  for (let index = bodyStart; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}' && --depth === 0) return text.slice(match.index, index + 1)
  }
  throw new Error(`无法提取函数 ${name}`)
}

/* BUILTIN_PIPELINE_ID 常量声明（trustedPipelineViolations 引用；从源码抽取，避免字面量分叉） */
const BUILTIN_CONST_DECL = /^const BUILTIN_PIPELINE_ID = .+$/m.exec(source)[0]

const TRUST_HELPERS = [
  BUILTIN_CONST_DECL,
  ...[
    'requestAuthToken', 'parseAuthUsersYaml', 'readAuthAdminUsers', 'resolveRequestAuth',
    'deepEqualIgnoring', 'isBuiltinPipelineEntry', 'trustedPipelineViolations', 'trustedPipelineWriteDeny',
  ].map((name) => extractFunction(name)),
].join('\n')

/* 与 pipeline-trust.test.mjs 同一套路由块抽取：PUT 全量 + save-one + GET，临时 DSH_HOME 真落盘 */
function loadPipelineRoutes(home, { ctx = {} } = {}) {
  const start = source.indexOf('  // 流水线工作台（pipeline.html）的服务端持久化')
  const end = source.indexOf('  // ---- 流水线导入导出：服务端备份', start)
  assert.ok(start >= 0 && end > start, '流水线持久化路由块未找到')
  const helpers = [
    'cleanPipelineHistory', 'stripPipelineSharedMeta', 'samePipelineContent', 'mergePipelineFavoriteUsers', 'mergePipelinePinnedAt',
    'withPipelineSharedMeta', 'mergePipelineConfigForWrite', 'pipelineConfigDifferenceIds',
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

/* 客户端迁移/合并函数：从 pipeline.html 原样抽取（纯数据函数，不碰 DOM），保证模拟的字节序列与页面一致 */
const client = (() => {
  const presetKeys = /^const PIPELINE_DEFAULT_PRESET_KEYS=.+$/m.exec(page)[0]
  const names = [
    'pipelineDefaultStringList', 'normalizePipelineDefaults', 'pipelineFavoriteUsers', 'migratePipelineDefaults',
    'migrateGate', 'migrateStageUrl', 'cleanScriptValues', 'migratePrefillDefaults', 'migratePromPreset',
    'stripPipelineSharedMeta', 'reconcilePipelinesAfterSave', 'mergePipelinesFromServer',
  ]
  const sandbox = {}
  vm.createContext(sandbox)
  vm.runInContext([presetKeys, ...names.map((n) => extractFunction(n, page))].join('\n'), sandbox)
  return sandbox
})()

function mockRes() {
  return {
    status: 0, body: '',
    writeHead(s) { this.status = s },
    end(s) { this.body = s == null ? '' : String(s) },
    json() { return this.body ? JSON.parse(this.body) : null },
  }
}

const roundtrip = (value) => JSON.parse(JSON.stringify(value))

/* 字节级忠实的单页面模拟：只保留数据操作（DOM/渲染/定时器略去），每个函数注明对应的页面函数与行号口径 */
function makeClient(handlers, { token } = {}) {
  const c = { serverConfigBase: null, pipelines: [], scriptsDir: '', stateLoaded: false }
  const migrateAll = (list) => list
    .map((p) => roundtrip(p))
    .map(client.migrateGate).map(client.migrateStageUrl).map(client.migratePrefillDefaults)
    .map(client.migratePipelineDefaults).map(client.migratePromPreset)
  const call = async (handler, method, body) => {
    const res = mockRes()
    await handler({ method, body, headers: token ? { cookie: 'dsh_auth=' + token } : {} }, res)
    return res
  }
  /* loadServerState（pipeline.html:1273）：GET → 基线快照 → 按 id 三方合并 + 迁移 */
  c.load = async () => {
    const res = await call(handlers['/api/worktable/pipeline'], 'GET')
    assert.equal(res.status, 200, 'GET 应成功')
    const st = res.json()
    const prevBase = (c.serverConfigBase && Array.isArray(c.serverConfigBase.pipelines)) ? c.serverConfigBase.pipelines : []
    c.serverConfigBase = roundtrip(st.config && typeof st.config === 'object' ? st.config : {})
    if (Array.isArray(st.config.pipelines) && st.config.pipelines.length) {
      const merged = client.mergePipelinesFromServer(prevBase, c.pipelines, st.config.pipelines)
      c.pipelines = migrateAll(merged.pipelines)
      if (merged.keptBaseEntries.length) {
        c.serverConfigBase.pipelines = (Array.isArray(c.serverConfigBase.pipelines) ? c.serverConfigBase.pipelines : [])
          .concat(merged.keptBaseEntries.map((p) => roundtrip(p)))
      }
    }
    c.stateLoaded = true
  }
  /* pushPipelineOne（pipeline.html:1195）：基线条目在拿到锁后从 serverConfigBase 取 */
  c.saveOne = async (id) => {
    const edited = c.pipelines.find((p) => p && p.id === id)
    if (!edited) return { ok: false, error: '流水线已不在本页列表中' }
    const pipelineSnap = roundtrip(edited)
    const localSnap = roundtrip(c.pipelines)
    const baseList = (c.serverConfigBase && Array.isArray(c.serverConfigBase.pipelines)) ? c.serverConfigBase.pipelines : []
    const baseOne = baseList.find((p) => p && p.id === id) || null
    const res = await call(handlers['/api/worktable/pipeline/save-one'], 'PUT', { pipeline: pipelineSnap, basePipeline: baseOne, scriptsDir: c.scriptsDir })
    const body = res.json() || {}
    if (res.status !== 200) return { ok: false, status: res.status, conflict: res.status === 409, trusted: res.status === 403, error: String(body.error || ('HTTP ' + res.status)) }
    if (body.config && typeof body.config === 'object') {
      c.serverConfigBase = roundtrip(body.config)
      if (Array.isArray(body.config.pipelines)) c.pipelines = migrateAll(client.reconcilePipelinesAfterSave(localSnap, body.config.pipelines, c.pipelines))
    }
    return { ok: true, config: body.config || {} }
  }
  /* copyPipeline（pipeline.html:8667）：深拷贝源条目 → 新 id/非内置/不继承置顶收藏可信/副本名/署名 → save-one */
  c.copyPipeline = async (id, me = '') => {
    const src = c.pipelines.find((p) => p && p.id === id)
    assert.ok(src, `源流水线 ${id} 不存在`)
    const clone = roundtrip(src)
    clone.id = 'pl-' + Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36)
    clone.builtIn = false
    clone.pinnedAt = 0
    clone.favoriteUsers = []
    delete clone.trusted
    clone.name = (src.name || '').replace(/（副本( \d+)?）$/, '') + '（副本）'
    clone.createdBy = me
    clone.owner = me
    clone.updatedBy = me
    c.pipelines.push(clone)
    const saved = await c.saveOne(clone.id)
    return { clone, saved }
  }
  /* savePlForm（pipeline.html:8511）改名场景的数据操作：阶段按编辑器 canonical 键序重建（8563-8574），
     改名 + 署名写入（8579：createdBy/owner 各自空白才补为本用户、updatedBy 每次保存刷新）→ save-one；
     409 时按 8693-8717 回滚本条到保存前版本（名称还原） */
  c.renameViaEditor = async (id, newName, me = '') => {
    const previousPipelines = roundtrip(c.pipelines)
    const p = c.pipelines.find((item) => item && item.id === id)
    assert.ok(p, `流水线 ${id} 不存在`)
    p.name = newName
    p.stages = p.stages.map((s) => {
      if (s.preset) return { id: s.id, name: s.name, preset: true, pkey: s.pkey }
      const st = { id: s.id, name: s.name, dur: Math.max(0, parseInt(s.dur) || 0), skip: !!s.skip, sub: (s.sub || []), kind: s.kind || 'simulate' }
      if (s.parallel === true) st.parallel = true
      if (s.promCollect) st.promCollect = true
      if (s.timeout) st.timeout = Math.max(1, parseInt(s.timeout, 10) || 120)
      if (s.script && s.script.name) st.script = { name: s.script.name, path: s.script.path, lang: s.script.lang, params: (s.script.params || []), values: (s.script.values || {}), outVars: (s.script.outVars || '') }
      if (s.url) st.url = { url: s.url.url, outVars: (s.url.outVars || '') }
      if (s.evaltokens) st.evaltokens = s.evaltokens
      if (s.sched) st.sched = {}
      return st
    })
    if (!p.builtIn && me) {
      if (typeof p.createdBy !== 'string' || !p.createdBy.trim()) p.createdBy = me
      if (typeof p.owner !== 'string' || !p.owner.trim()) p.owner = me
    }
    if (!p.builtIn && me) p.updatedBy = me
    const saved = await c.saveOne(id)
    if (saved && saved.ok === false) {
      /* savePlForm 冲突回滚（8693-8717 的单条版本）：名称还原成保存前（副本名） */
      const previousPipeline = previousPipelines.find((item) => String(item && item.id || '') === String(id))
      const previousIndex = previousPipelines.findIndex((item) => String(item && item.id || '') === String(id))
      c.pipelines = c.pipelines.filter((item) => String(item && item.id || '') !== String(id))
      if (previousPipeline) c.pipelines.splice(Math.min(Math.max(previousIndex, 0), c.pipelines.length), 0, previousPipeline)
    }
    return saved
  }
  /* pushState（pipeline.html:1119）全量 PUT：baseConfig 只带 pipelines（1141 的瘦身负载） */
  c.pushState = async () => {
    const config = { pipelines: c.pipelines, scriptsDir: c.scriptsDir }
    const baseList = (c.serverConfigBase && Array.isArray(c.serverConfigBase.pipelines)) ? c.serverConfigBase.pipelines : []
    const res = await call(handlers['/api/worktable/pipeline'], 'PUT', { config, baseConfig: { pipelines: baseList } })
    const body = res.json() || {}
    if (res.status !== 200) return { ok: false, status: res.status, conflict: res.status === 409, trusted: res.status === 403, conflicts: body.conflicts || [], error: String(body.error || ('HTTP ' + res.status)) }
    if (body.config && typeof body.config === 'object') {
      c.serverConfigBase = roundtrip(body.config)
      if (Array.isArray(body.config.pipelines)) c.pipelines = migrateAll(client.reconcilePipelinesAfterSave(config.pipelines, body.config.pipelines, c.pipelines))
    }
    return { ok: true, config: body.config || {} }
  }
  return c
}

const USERS_YAML = `version: 1
users:
  alice:
    passwordHash: scrypt$aaaaaaaa
  bob:
    passwordHash: scrypt$bbbbbbbb
    role: admin
`
const TOKEN_USER = 'tok-user-00000000000000000000000000000000000'
const authCtx = () => ({
  auth: {
    sessions: {
      getByToken(token) {
        if (token === TOKEN_USER) return { subject: 'alice', expiresAt: 0, revoked: false }
        return undefined
      },
    },
  },
})

/* 与生产存储同形的条目：内置（id,name,stages,builtIn,defaults,createdBy,owner,updatedBy 键序）与
   普通条目；阶段键序 canonical = id,name,dur,skip,sub,kind[,url...]（savePlForm 重建顺序）。
   owner 键按迁移后落盘形态携带（migratePipelineDefaults 对存量数据补 owner:''，编辑保存时才补署具体用户；
   缺 owner 键的旧数据会让迁移后的客户端条目与磁盘/基线产生内容差，全量 PUT 把带 owner 的客户端版本
   送上后触发服务端内置/可信条目守卫 403——本文件的种子一律采用迁移后形态，规避该过渡态） */
const defaultsShape = () => ({ environmentIds: [], repositoryId: '', branch: 'main', strategy: '', presets: [] })
const presetStages = () => [
  { id: 'st-preset-cleanup', name: '环境清理', preset: true, pkey: 'cleanup' },
  { id: 'st-preset-check', name: '环境检查', preset: true, pkey: 'check' },
]
const builtinEntry = () => ({
  id: 'pl-xds', name: '安装部署XDS',
  stages: [...presetStages(), { id: 'st0', name: '模拟部署', dur: 5, skip: false, sub: [], kind: 'simulate' }],
  builtIn: true, defaults: defaultsShape(), createdBy: 'bob', owner: '', updatedBy: 'bob',
})
const customEntry = (id, name) => ({
  id, name,
  stages: [...presetStages(), { id: 'st0', name: '部署', dur: 5, skip: false, sub: [], kind: 'http', url: { url: 'http://jenkins/job/x', outVars: '' } }],
  builtIn: false, defaults: defaultsShape(), createdBy: 'alice', owner: '', updatedBy: 'alice',
})
/* 「旧版/导入」键序的条目：内容与普通条目相同，但阶段键序非 canonical（kind 提前）——
   编辑器重存会把阶段重建为 canonical 键序，字节变、内容不变 */
const legacyOrderEntry = (id, name) => ({
  id, name,
  stages: [...presetStages(), { id: 'st0', name: '部署', kind: 'http', dur: 5, skip: false, sub: [], url: { url: 'http://jenkins/job/x', outVars: '' } }],
  builtIn: false, defaults: defaultsShape(), createdBy: 'alice', owner: '', updatedBy: 'alice',
})

async function seedHome(t, { config, history = [], usersYaml = USERS_YAML } = {}) {
  const home = await mkdtemp(tmpdir() + '/pipeline-copy-rename-')
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
const diskEntry = async (home, id) => (await readStore(home)).config.pipelines.find((p) => p && p.id === id) || null

test('复制普通流水线后立即改名：save-one 链路 200 且新名落盘，多轮改名不 409', async t => {
  const home = await seedHome(t, { config: { pipelines: [builtinEntry(), customEntry('pl-a', '构建部署')] } })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })
  const a = makeClient(h, { token: TOKEN_USER })
  await a.load()

  const { clone, saved } = await a.copyPipeline('pl-a', 'alice')
  assert.equal(saved.status ?? 200, 200, `副本落盘应成功：${saved.error || ''}`)
  assert.equal((await diskEntry(home, clone.id)).name, '构建部署（副本）')

  const renamed = await a.renameViaEditor(clone.id, '构建部署-我的定制', 'alice')
  assert.equal(renamed.status ?? 200, 200, `副本改名不应被拒：${renamed.error || ''}`)
  assert.equal(renamed.ok, true, '改名 save-one 应 200')
  const disk1 = await diskEntry(home, clone.id)
  assert.equal(disk1.name, '构建部署-我的定制', '新名必须落盘')
  assert.deepEqual(Object.keys(disk1.stages[2]), ['id', 'name', 'dur', 'skip', 'sub', 'kind', 'url'], '阶段按编辑器 canonical 键序落盘')
  assert.ok(!('favoriteUsers' in disk1) && !('pinnedAt' in disk1), '空收藏/零置顶按形状归一省略键')

  const renamed2 = await a.renameViaEditor(clone.id, '构建部署-再改名', 'alice')
  assert.equal(renamed2.ok, true, `第二轮改名不应 409：${renamed2.error || ''}`)
  assert.equal((await diskEntry(home, clone.id)).name, '构建部署-再改名')
})

test('非 admin 复制内置/可信流水线后改名：副本是普通条目，save-one 不被可信守卫误伤', async t => {
  const trusted = { ...customEntry('pl-t', '可信流水线'), trusted: true }
  const home = await seedHome(t, { config: { pipelines: [builtinEntry(), trusted] } })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })
  const a = makeClient(h, { token: TOKEN_USER })
  await a.load()

  const copyBuiltin = await a.copyPipeline('pl-xds', 'alice')
  assert.equal(copyBuiltin.saved.ok, true, `内置流水线的副本落盘不应 403：${copyBuiltin.saved.error || ''}`)
  const renameBuiltinCopy = await a.renameViaEditor(copyBuiltin.clone.id, '我的XDS定制', 'alice')
  assert.equal(renameBuiltinCopy.ok, true, `内置副本改名不应被内置守卫拦截：${renameBuiltinCopy.error || ''}`)
  assert.equal((await diskEntry(home, copyBuiltin.clone.id)).name, '我的XDS定制')

  const copyTrusted = await a.copyPipeline('pl-t', 'alice')
  assert.equal(copyTrusted.saved.ok, true, `可信流水线的副本落盘不应 403：${copyTrusted.saved.error || ''}`)
  const renameTrustedCopy = await a.renameViaEditor(copyTrusted.clone.id, '我的可信定制', 'alice')
  assert.equal(renameTrustedCopy.ok, true, `可信副本改名不应被可信守卫拦截：${renameTrustedCopy.error || ''}`)
  const diskT = await diskEntry(home, copyTrusted.clone.id)
  assert.equal(diskT.name, '我的可信定制')
  assert.equal(diskT.trusted, undefined, '副本不继承可信标记')
  assert.equal((await diskEntry(home, 'pl-t')).name, '可信流水线', '源可信条目原样保留')
})

test('复制→改名→全量 PUT→save-one 交替多轮：不 409、新名保持、无关条目的他端收藏不误伤', async t => {
  const home = await seedHome(t, { config: { pipelines: [builtinEntry(), customEntry('pl-a', '构建部署'), customEntry('pl-b', '性能压测')] } })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })
  const a = makeClient(h, { token: TOKEN_USER })
  await a.load()

  const { clone } = await a.copyPipeline('pl-a', 'alice')
  assert.equal((await a.renameViaEditor(clone.id, '改名第一轮', 'alice')).ok, true)
  assert.equal((await a.pushState()).ok, true, '改名后全量 PUT 应 200')
  assert.equal((await a.renameViaEditor(clone.id, '改名第二轮', 'alice')).ok, true, '全量 PUT 后再改名不应 409')

  /* 另一浏览器对无关条目点收藏（全量 PUT）：save-one 只按 id 比对该条，不应受影响 */
  const c = makeClient(h, { token: TOKEN_USER })
  await c.load()
  const fav = c.pipelines.find((p) => p && p.id === 'pl-b')
  fav.favoriteUsers = ['alice']
  assert.equal((await c.pushState()).ok, true, '他端收藏无关条目应 200')

  assert.equal((await a.renameViaEditor(clone.id, '改名第三轮', 'alice')).ok, true, '他端收藏后改名不应 409')
  assert.equal((await a.pushState()).ok, true, '改名后再全量 PUT 应 200')
  const disk = await diskEntry(home, clone.id)
  assert.equal(disk.name, '改名第三轮', '多轮交替后新名保持')
  assert.deepEqual((await diskEntry(home, 'pl-b')).favoriteUsers, ['alice'], '无关条目的收藏保留')
})

test('复现：他端以「同内容、不同键序」重存副本后，本端改名 save-one 不得 phantom 409', async t => {
  /* 源流水线的阶段是旧版/导入键序（内容等价、字节序不同）；本端复制后，他端编辑器重存把阶段
     重建为 canonical 键序——磁盘条目字节偏离本端基线但内容相同，改名保存不得按冲突拦截 */
  const home = await seedHome(t, { config: { pipelines: [builtinEntry(), legacyOrderEntry('pl-old', '旧键序流水线')] } })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })
  const a = makeClient(h, { token: TOKEN_USER })
  await a.load()
  const { clone } = await a.copyPipeline('pl-old', 'alice')
  const diskBefore = await diskEntry(home, clone.id)
  assert.deepEqual(Object.keys(diskBefore.stages[2]), ['id', 'name', 'kind', 'dur', 'skip', 'sub', 'url'], '副本首次落盘保持源条目的旧键序')

  /* 他端打开同一副本的编辑器，不改任何内容直接保存（阶段被重建为 canonical 键序） */
  const b = makeClient(h, { token: TOKEN_USER })
  await b.load()
  const reSaved = await b.renameViaEditor(clone.id, '旧键序流水线（副本）', 'alice')   // 同名保存，仅阶段键序重排
  assert.equal(reSaved.ok, true, '他端重存应 200')
  const diskAfter = await diskEntry(home, clone.id)
  assert.deepEqual(Object.keys(diskAfter.stages[2]), ['id', 'name', 'dur', 'skip', 'sub', 'kind', 'url'], '他端重存后磁盘为 canonical 键序')

  /* 本端改名：基线（旧键序）与磁盘（canonical）仅键序不同、内容相同——不得报 409 回滚名称 */
  const renamed = await a.renameViaEditor(clone.id, '旧键序流水线-改名', 'alice')
  assert.equal(renamed.ok, true, `同内容不同键序不得 phantom 409：${renamed.error || ''}`)
  const diskFinal = await diskEntry(home, clone.id)
  assert.equal(diskFinal.name, '旧键序流水线-改名', '新名必须落盘（不被还原成副本名）')
  assert.deepEqual(Object.keys(diskFinal.stages[2]), ['id', 'name', 'dur', 'skip', 'sub', 'kind', 'url'], '他端重存的 canonical 键序内容保留')
})

test('保存确认丢失后重试：客户端与磁盘内容一致按幂等放行，内容不同仍 409 防静默覆盖', async t => {
  const home = await seedHome(t, { config: { pipelines: [builtinEntry(), customEntry('pl-a', '构建部署')] } })
  const h = loadPipelineRoutes(home, { ctx: authCtx() })
  const a = makeClient(h, { token: TOKEN_USER })
  await a.load()
  const preCopyBase = roundtrip(a.serverConfigBase)   // 复制前基线（无副本）

  /* 第一次保存：服务器已写盘，但响应在途中丢失（直接调路由、不把响应应用到客户端状态） */
  const src = a.pipelines.find((p) => p && p.id === 'pl-a')
  const clone = roundtrip(src)
  clone.id = 'pl-lostack01'
  clone.builtIn = false
  clone.pinnedAt = 0
  clone.favoriteUsers = []
  delete clone.trusted
  clone.name = '构建部署（副本）'
  clone.createdBy = 'alice'
  clone.owner = 'alice'
  clone.updatedBy = 'alice'
  const first = mockRes()
  await h['/api/worktable/pipeline/save-one']({ method: 'PUT', body: { pipeline: clone, basePipeline: null, scriptsDir: '' }, headers: { cookie: 'dsh_auth=' + TOKEN_USER } }, first)
  assert.equal(first.status, 200, '首次落盘成功（但假设响应丢失，客户端未应用）')
  assert.ok(await diskEntry(home, clone.id), '磁盘已有副本')

  /* 客户端重试保存：基线仍停留在复制前（无副本）、磁盘已有同内容副本 → 幂等成功而非 409 锁死 */
  a.pipelines.push(clone)
  a.serverConfigBase = preCopyBase
  const diskBefore = roundtrip(await diskEntry(home, clone.id))
  const retry = await a.saveOne(clone.id)
  assert.equal(retry.ok, true, `与磁盘内容一致的重试应幂等放行：${retry.error || ''}`)
  assert.deepEqual(roundtrip(await diskEntry(home, clone.id)), diskBefore, '幂等写不改变磁盘条目')
  assert.ok((a.serverConfigBase.pipelines || []).some((p) => p && p.id === clone.id), '响应把基线自愈到含副本')

  /* 同样是基线缺失，但客户端内容真实偏离磁盘（他端可能已有并发修改）：仍必须 409 由客户端重拉抉择 */
  a.serverConfigBase = roundtrip(preCopyBase)   // 重演基线缺失
  const renamed = await a.renameViaEditor(clone.id, '基线缺失后的改名', 'alice')
  assert.equal(renamed.conflict, true, '内容真实偏离磁盘时仍须 409，不能静默覆盖')
  assert.equal((await diskEntry(home, clone.id)).name, '构建部署（副本）', '409 不写盘，磁盘保持原名')
})
