import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as pathResolve, dirname } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

/* 「磁盘独有配置键保留」回归测试：新版页面上线后，仍打开的旧页面/旧客户端一次全量保存
   不得把新版写入的新配置键抹掉（升级不冲掉老配置）；客户端显式发送的空值仍是清除语义。
   范式与 pipeline-config-concurrency.test.mjs 一致：读 src/index.ts 文本 → 去类型 → 抽函数 vm 注入；
   路由级测试复用 pipeline-trust.test.mjs 的路由块抽取模式（临时 DSH_HOME 真落盘）。 */
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

function loadFunctions(names, extraDecls = []) {
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext([...extraDecls, ...names.map(extractFunction)].join('\n'), ctx)
  return ctx
}

/* 合并函数引用的共享元数据助手（剥离比对 + 键序无关深比较 + 三方合并），抽函数时一并加载 */
const SHARED_META_HELPERS = ['stripPipelineSharedMeta', 'deepEqualIgnoring', 'samePipelineContent', 'mergePipelineFavoriteUsers', 'mergePipelinePinnedAt', 'withPipelineSharedMeta']

function preserve(clientConfig, diskConfig) {
  const ctx = loadFunctions(['preserveDiskOnlyConfigKeys'])
  return JSON.parse(JSON.stringify(ctx.preserveDiskOnlyConfigKeys(clientConfig, diskConfig)))
}

function merge(clientConfig, baseConfig, diskConfig) {
  const ctx = loadFunctions([...SHARED_META_HELPERS, 'preserveDiskOnlyConfigKeys', 'mergePipelineConfigForWrite'])
  return JSON.parse(JSON.stringify(ctx.mergePipelineConfigForWrite(clientConfig, baseConfig, diskConfig)))
}

function mergeOne(clientPipeline, basePipeline, diskConfig) {
  const ctx = loadFunctions([...SHARED_META_HELPERS, 'mergePipelineOneForWrite'])
  return JSON.parse(JSON.stringify(ctx.mergePipelineOneForWrite(clientPipeline, basePipeline, diskConfig)))
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
    'withPipelineSharedMeta', 'preserveDiskOnlyConfigKeys', 'mergePipelineConfigForWrite', 'pipelineConfigDifferenceIds',
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

async function seedHome(t, { config, history = [] } = {}) {
  const home = await mkdtemp(tmpdir() + '/pipeline-preserve-')
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(pathResolve(home, 'storages'), { recursive: true })
  await writeFile(pathResolve(home, 'storages', 'worktable-pipeline.json'), JSON.stringify({ config, history }), 'utf8')
  return home
}

const readStore = (home) => readFile(pathResolve(home, 'storages', 'worktable-pipeline.json'), 'utf8').then(JSON.parse)

const pl = (id, name) => ({ id, name, stages: [{ id: 'st0', name: '构建', dur: 5 }] })

/* ---------- preserveDiskOnlyConfigKeys 函数级：key absent 与显式空值的区分 ---------- */

test('保留助手：磁盘独有键（含嵌套对象/数组/0 值）并入，客户端未携带即按磁盘值保留', () => {
  const disk = { theme: 'dark', newKey: { a: 1, b: ['x'] }, flags: [1, 2], retries: 0 }
  const client = { theme: 'light' }

  const result = preserve(client, disk)

  assert.equal(result.theme, 'light', '双方都有的键以客户端为准')
  assert.deepEqual(result.newKey, { a: 1, b: ['x'] }, '磁盘独有的嵌套对象原样保留')
  assert.deepEqual(result.flags, [1, 2], '磁盘独有的数组原样保留')
  assert.equal(result.retries, 0, '磁盘独有的 0 值也保留（key absent 才保留，与值真假无关）')
})

test('保留助手：客户端显式发送的空串/false/空数组/0/null 覆盖磁盘（清除语义不被保留逻辑吞掉）', () => {
  const disk = { scriptsDir: '/opt/scripts', notify: true, tags: ['a'], retries: 3, note: 'x' }
  const client = { scriptsDir: '', notify: false, tags: [], retries: 0, note: null }

  const result = preserve(client, disk)

  assert.equal(result.scriptsDir, '', '空串 = 显式清除，不回填磁盘值')
  assert.equal(result.notify, false, 'false = 显式清除')
  assert.deepEqual(result.tags, [], '空数组 = 显式清除')
  assert.equal(result.retries, 0, '0 = 显式值')
  assert.equal(result.note, null, 'null = 显式值（JSON 可表达）')
})

test('保留助手：非对象输入归一为 {}，磁盘/客户端缺一侧时不抛错', () => {
  assert.deepEqual(preserve(null, { a: 1 }), { a: 1 }, '客户端非对象 → 全部为磁盘独有键')
  assert.deepEqual(preserve({ a: 1 }, null), { a: 1 }, '磁盘非对象 → 即客户端快照')
  assert.deepEqual(preserve(['x'], { a: 1 }), { a: 1 }, '数组不算配置对象')
  assert.deepEqual(preserve(undefined, undefined), {}, '双侧缺失 → 空配置')
})

/* ---------- 带 baseConfig 的三方合并路径（mergePipelineConfigForWrite） ---------- */

test('三方合并：客户端未携带的磁盘独有配置键保留，pipelines 之外的客户端键仍按保存值提交', () => {
  /* 场景：base 是旧页面打开时的基线；新版页面随后在磁盘写入了 settingsV2/newKey；
     旧页面一次保存只带自己知道的键——新键不得被抹掉。 */
  const base = { pipelines: [pl('p1', '流水线一')], theme: 'dark' }
  const disk = { pipelines: [pl('p1', '流水线一')], theme: 'dark', settingsV2: { gate: true }, newKey: 'server' }
  const client = { pipelines: [pl('p1', '流水线一')], theme: 'light' }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.settingsV2, { gate: true }, '客户端未携带的新版键按磁盘值保留')
  assert.equal(result.config.newKey, 'server')
  assert.equal(result.config.theme, 'light', '客户端携带的键以客户端为准')
})

test('三方合并：客户端显式空值覆盖磁盘值，pipelines 三方合并行为不变', () => {
  const base = { pipelines: [pl('p1', '一'), pl('p2', '二')], scriptsDir: '/old', tags: ['x'] }
  const disk = { pipelines: [pl('p1', '一-A'), pl('p2', '二')], scriptsDir: '/old', tags: ['x'] }
  const client = { pipelines: [pl('p1', '一'), pl('p2', '二-B')], scriptsDir: '', tags: [] }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.pipelines.map(item => [item.id, item.name]), [
    ['p1', '一-A'],
    ['p2', '二-B'],
  ], '不同 id 的并发改动同时保留（三方合并行为不变）')
  assert.equal(result.config.scriptsDir, '', '显式空串清除磁盘 scriptsDir')
  assert.deepEqual(result.config.tags, [], '显式空数组清除磁盘 tags')
})

test('三方合并：同一 id 双边真改仍冲突，且冲突回声 config 也带磁盘独有键', () => {
  const base = { pipelines: [pl('p1', '原始')] }
  const disk = { pipelines: [pl('p1', '浏览器 A')], settingsV2: { gate: true } }
  const client = { pipelines: [pl('p1', '浏览器 B')] }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, ['p1'], '冲突判定不受保留逻辑影响')
  assert.equal(result.config.pipelines[0].name, '浏览器 A', '冲突时以磁盘版本供调用方刷新')
  assert.deepEqual(result.config.settingsV2, { gate: true }, '冲突回声里的磁盘独有键同样在（刷新后客户端自愈不丢键）')
})

/* ---------- 无 baseConfig 的旧页面路径（PUT 路由 else 分支） ---------- */

test('旧页面路径：无 baseConfig 的 PUT 保留磁盘独有键，客户端键照常写入（路由级真落盘）', async t => {
  const diskConfig = { pipelines: [pl('p1', '一致')], theme: 'dark', settingsV2: { gate: true }, retries: 0 }
  const home = await seedHome(t, { config: diskConfig })
  const h = loadPipelineRoutes(home, { ctx: {} })   // 无 auth 服务 → 不校验 trusted，聚焦保留语义

  const clientConfig = { pipelines: [pl('p1', '一致')], theme: 'light' }   // 旧页面快照，不带 baseConfig
  const res = await call(h['/api/worktable/pipeline'], { method: 'PUT', body: { config: clientConfig, history: [] }, headers: {} })

  assert.equal(res.status, 200, '流水线定义一致 → 放行')
  const disk = await readStore(home)
  assert.deepEqual(disk.config.settingsV2, { gate: true }, '客户端未携带的新版键落盘后仍在')
  assert.equal(disk.config.retries, 0, '磁盘独有的 0 值键保留')
  assert.equal(disk.config.theme, 'light', '客户端携带的键以客户端为准')
})

test('旧页面路径：客户端显式空值清除磁盘键值（路由级），pipelines 不同仍 409 且不写盘', async t => {
  const diskConfig = { pipelines: [pl('p1', '一致')], scriptsDir: '/opt/s' }
  const home = await seedHome(t, { config: diskConfig })
  const h = loadPipelineRoutes(home, { ctx: {} })

  const cleared = await call(h['/api/worktable/pipeline'], {
    method: 'PUT', headers: {},
    body: { config: { pipelines: [pl('p1', '一致')], scriptsDir: '' }, history: [] },
  })
  assert.equal(cleared.status, 200)
  assert.equal((await readStore(home)).config.scriptsDir, '', '显式空串覆盖磁盘值，不被保留逻辑回填')

  const conflict = await call(h['/api/worktable/pipeline'], {
    method: 'PUT', headers: {},
    body: { config: { pipelines: [pl('p1', '旧页面改动')] }, history: [] },
  })
  assert.equal(conflict.status, 409, '无基线时流水线定义不同仍拒绝（并发保护不松动）')
  assert.equal((await readStore(home)).config.pipelines[0].name, '一致', '409 不写盘')
})

test('旧页面路径文本断言：else 分支经保留助手并入磁盘独有键，冲突判定仍用原始客户端快照', () => {
  assert.match(source, /baseConfig\s*\?\s*mergePipelineConfigForWrite\(config, baseConfig, diskCfg\)\s*:\s*\{[\s\S]*?preserveDiskOnlyConfigKeys\(config, diskCfg\)[\s\S]*?pipelineConfigDifferenceIds\(config, diskCfg\)/,
    '无 baseConfig 分支：落盘 config 走 preserveDiskOnlyConfigKeys，冲突判定仍比对客户端原始快照')
})

/* ---------- save-one 单条保存：磁盘独有键保留确认（{...disk} 出发，本次未改） ---------- */

test('单条保存：磁盘独有配置键与历史之外的字段一律保留', () => {
  const disk = { pipelines: [pl('p1', '原始'), pl('p2', '保留')], settingsV2: { gate: true }, retries: 0, buildNo: 9 }

  const result = mergeOne(pl('p1', '编辑后'), pl('p1', '原始'), disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.settingsV2, { gate: true }, 'save-one 从 {...disk} 出发，客户端没提的键不丢')
  assert.equal(result.config.retries, 0)
  assert.equal(result.config.buildNo, 9)
  assert.deepEqual(result.config.pipelines.map(item => [item.id, item.name]), [['p1', '编辑后'], ['p2', '保留']])
})
