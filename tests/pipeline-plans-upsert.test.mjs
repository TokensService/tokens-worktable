/* 浏览器关闭移交的服务端配套：
   1. POST /api/worktable/pipeline/plans 单条 upsert（按 id 替换，不全量覆盖——pagehide keepalive 用）
   2. serverStageDeadline：阶段 timeout 留空时的兜底等待上限，HTTP/Jenkins/EvalTokens 轮询不得无界
   提取方式同 pipeline-run-api.test.mjs。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join as pathJoin } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function extractFunction(name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const match = marker.exec(source)
  assert.ok(match, `src/index.ts 缺少函数 ${name}`)
  const start = match.index
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`无法提取函数 ${name}`)
}

function extractConst(name) {
  const match = new RegExp(`const\\s+${name}\\s*=`).exec(source)
  assert.ok(match, `src/index.ts 缺少常量 ${name}`)
  const end = source.indexOf('\n', match.index)
  return source.slice(match.index, end)
}

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers },
    end(body) { this.body = body == null ? '' : String(body) },
    json() { return this.body ? JSON.parse(this.body) : null },
  }
}

function loadPlansRoute(plansFile) {
  const marker = "path: '/api/worktable/pipeline/plans'"
  const at = source.indexOf(marker)
  assert.ok(at > 0, 'plans 路由未找到')
  /* 回溯到所属的 webServer.register({ ... })，按括号配平整段截出 */
  const callStart = source.lastIndexOf('webServer.register', at)
  assert.ok(callStart >= 0, 'plans register 调用未找到')
  const braceStart = source.indexOf('{', callStart)
  let depth = 0
  let end = -1
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = source.indexOf(')', i) + 1; break }
    }
  }
  assert.ok(end > braceStart, 'plans register 范围未闭合')
  const snippet = source.slice(callStart, end).replace('webServer.register', 'register')
  const handlers = {}
  const ctx = {
    URL, Promise, Buffer, console, JSON, Array, Object, Number, String, Boolean, Error, Date, Math,
    readJsonBody: async req => req.testBody ?? {},
    writeJsonAtomic: async (file, text) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text, 'utf8') },
    readPlansFile: async () => {
      try {
        const raw = await readFile(plansFile, 'utf8')
        const j = JSON.parse(raw)
        return Array.isArray(j.plans) ? j.plans : []
      } catch { return [] }
    },
    PLANS_STORE: plansFile,
    json(res, status, body) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    },
    register(route) { handlers[route.path] = route.handler },
  }
  vm.createContext(ctx)
  vm.runInContext(stripTypeScriptTypes(snippet, { mode: 'transform' }), ctx)
  assert.ok(handlers['/api/worktable/pipeline/plans'], 'plans handler 未注册')
  return handlers['/api/worktable/pipeline/plans']
}

async function call(handler, method, body) {
  const res = response()
  const raw = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const req = {
    method,
    testBody: body && typeof body === 'object' ? body : (raw ? JSON.parse(raw) : {}),
    async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw) },
  }
  await handler(req, res)
  return res
}

test('POST plans 单条 upsert：按 id 替换、保留他人计划，pagehide keepalive 路径可写', async () => {
  const home = await mkdtemp(pathJoin(tmpdir(), 'wt-plans-upsert-'))
  const plansFile = pathJoin(home, 'storages', 'worktable-pipeline-plans.json')
  await mkdir(dirname(plansFile), { recursive: true })
  await writeFile(plansFile, JSON.stringify({
    plans: [
      { id: 'other', kind: 'interval', pipelineName: '他人计划', createdAt: 1 },
      { id: 'stimer-pl-1-t1-unload', kind: 'once', pipelineName: '旧移交', createdAt: 1, at: 1, stages: [] },
    ],
  }), 'utf8')
  const handler = loadPlansRoute(plansFile)

  const res = await call(handler, 'POST', { plan: { id: 'stimer-pl-1-t1-unload', kind: 'once', pipelineName: '新移交', at: Date.now(), stages: [{ id: 'b' }], createdAt: 2 } })
  assert.equal(res.status, 200)
  assert.equal(res.json().id, 'stimer-pl-1-t1-unload')

  const saved = JSON.parse(await readFile(plansFile, 'utf8'))
  const ids = saved.plans.map(p => p.id).sort()
  assert.deepEqual(ids, ['other', 'stimer-pl-1-t1-unload'], '同 id 替换、他人计划保留')
  assert.equal(saved.plans.find(p => p.id === 'stimer-pl-1-t1-unload').pipelineName, '新移交')
  assert.equal(saved.plans.find(p => p.id === 'other').pipelineName, '他人计划')
})

test('POST plans 也接受裸 plan 体（无 {plan} 包装）；非法体 400', async () => {
  const home = await mkdtemp(pathJoin(tmpdir(), 'wt-plans-bare-'))
  const plansFile = pathJoin(home, 'storages', 'worktable-pipeline-plans.json')
  const handler = loadPlansRoute(plansFile)

  const ok = await call(handler, 'POST', { id: 'unload-q1', kind: 'once', stages: [] })
  assert.equal(ok.status, 200)

  const bad1 = await call(handler, 'POST', { plan: { kind: 'once' } })
  assert.equal(bad1.status, 400, '缺 id')
  const bad2 = await call(handler, 'POST', { plan: { id: 'x', kind: 'cron' } })
  assert.equal(bad2.status, 400, '非法 kind')
})

test('serverStageDeadline：timeout 留空时有兜底上限（不再无限等），显式 timeout 仍优先', () => {
  const code = stripTypeScriptTypes([
    extractConst('SERVER_STAGE_DEFAULT_DEADLINE_MS'),
    extractFunction('serverStageDeadline'),
  ].join('\n'), { mode: 'transform' })
  const ctx = { Date, Math, Number }
  vm.createContext(ctx)
  vm.runInContext(code + '\nglobalThis.__deadline = serverStageDeadline; globalThis.__DEFAULT = SERVER_STAGE_DEFAULT_DEADLINE_MS;', ctx)
  const deadline = ctx.__deadline
  const DEFAULT = ctx.__DEFAULT
  assert.equal(DEFAULT, 6 * 60 * 60 * 1000, '兜底 6 小时：覆盖长构建，又保证阶段不会永久卡住')

  const now = Date.now()
  const empty = deadline({ timeout: null })
  assert.ok(empty > now, 'timeout 留空也必须返回有限 deadline')
  assert.ok(empty <= now + DEFAULT + 50, '留空走默认上限')

  const zero = deadline({ timeout: 0 })
  assert.ok(zero > now && zero <= now + DEFAULT + 50, 'timeout=0 同样走默认上限')

  const explicit = deadline({ timeout: 30 })
  assert.ok(explicit <= now + 30 * 1000 + 50 && explicit > now, '显式 timeout 优先')
  const capped = deadline({ timeout: 99999 })
  assert.ok(capped <= now + 3600 * 1000 + 50, '显式 timeout 上限 1 小时')
})

test('resolvePlanRepository：计划只带 repoId 时按配置补齐 url/user/pass；带 url 的快照优先', () => {
  const code = stripTypeScriptTypes([
    extractFunction('resolvePlanRepository'),
  ].join('\n'), { mode: 'transform' })
  // 同 realm 执行，避免 vm 跨 realm 对象原型导致 deepStrictEqual 误判
  const resolve = new Function(code + '\nreturn resolvePlanRepository;')()
  const store = {
    config: {
      repositories: [
        { id: 'repo-1', name: 'demo', url: 'https://git.example.com/dev/demo.git', user: 'u1', pass: 'p1' },
        { id: 'repo-2', name: 'other', url: 'https://git.example.com/dev/other.git', user: 'u2', pass: 'p2' },
      ],
    },
  }

  const fromId = resolve({ repoId: 'repo-1', repository: null }, store)
  assert.deepEqual(fromId, { id: 'repo-1', name: 'demo', url: 'https://git.example.com/dev/demo.git', user: 'u1', pass: 'p1' },
    '关页移交/队列条目只带 repoId 时必须按配置补齐，否则 GIT_* 不注入、git 类脚本卡在凭据提示')

  const snapshot = { id: 'repo-1', name: 'demo', url: 'https://snap.example.com/x.git', user: 'su', pass: 'sp' }
  assert.deepEqual(resolve({ repoId: 'repo-1', repository: snapshot }, store), snapshot,
    '带 url 的运行期快照优先于配置（配置可能在移交后被改）')

  const emptyUrl = resolve({ repoId: 'repo-2', repository: { id: 'repo-2', url: '' } }, store)
  assert.equal(emptyUrl && emptyUrl.url, 'https://git.example.com/dev/other.git', '空 url 视为缺失，回落配置')

  assert.equal(resolve({ repoId: 'missing', repository: null }, store), null, '配置也找不到时返回 null')
  assert.deepEqual(resolve({ repoId: null, repository: { id: 'x', name: 'n', url: '', user: '', pass: '' } }, store),
    { id: 'x', name: 'n', url: '', user: '', pass: '' }, '无 repoId 且无 url 时原样返回 provided')
})
