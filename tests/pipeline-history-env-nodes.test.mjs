import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open as fsOpen, readFile, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join as pathJoin, resolve as pathResolve } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))

function extractFunction(name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}(?:<[^>]*>)?\\s*\\(`)
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

/* 历史助手区段（cleanPipelineHistory → git 状态快照前）：含 cleanPipelineHistoryEnvNodes /
 * pipelineHistoryEnvNodes / mergePipelineHistoryForWrite / serializePipelineStore 等纯函数。 */
function loadHistoryHelpers() {
  const start = source.indexOf('function cleanPipelineHistory(')
  const end = source.indexOf('/** git 状态快照', start)
  assert.ok(start >= 0 && end > start, 'cleanPipelineHistory helper not found')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const ctx = {}
  vm.createContext(ctx); vm.runInContext(code, ctx)
  return ctx
}

/* API 路由 → buildPipelineApiRun → execPlan → 真 appendPipelineHistory（临时存储文件落盘）全链路。
 * 与 pipeline-run-api.test.mjs 同一抽取手法，但 appendPipelineHistory/readPipelineStore 用真实现，
 * 写盘到临时 DSH_HOME 下的 worktable-pipeline.json。 */
function loadHistoryHarness(storeFile) {
  const histStart = source.indexOf('function cleanPipelineHistory(')
  const histEnd = source.indexOf('/** git 状态快照', histStart)
  assert.ok(histStart >= 0 && histEnd > histStart, '抽取区段未找到')
  /* cleanPipelineHistory → git 状态快照 的区段本身已含流水线 API 触发整段（registerPipelineRunApi /
   * buildPipelineApiRun / 执行池等），无需再单独拼接 API 区段。 */
  const code = stripTypeScriptTypes([
    extractFunction('isLocalTarget'),
    source.slice(histStart, histEnd),
    extractFunction('resolvePipelineScriptsDir'),
    extractFunction('parseStageVars'),
    extractFunction('parseStageJson'),
    extractFunction('jsonPathGet'),
    extractFunction('applyOutVars'),
    extractFunction('execPlan'),
    `const PIPELINE_STORE = ${JSON.stringify(storeFile)}`,
    extractFunction('writeJsonAtomic'),
    'let storeChain = Promise.resolve()',
    extractFunction('withStoreLock'),
    `async function readPipelineStore() {
      try {
        const raw = await readFile(PIPELINE_STORE, 'utf8')
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
      } catch { return {} }
    }`,
    extractFunction('appendPipelineHistory'),
  ].join('\n'), { mode: 'transform' })
  const handlers = {}
  const warnings = []
  const calls = []
  const ctx = {
    URL,
    Promise,
    Buffer,
    Date,
    Math,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { warn() {}, log() {}, error() {} },
    pathResolve,
    readFile,
    dirname,
    fsOpen,
    mkdir,
    json(res, status, body) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    },
    /* 测试环境注入空串安装默认：scriptsDir 未配置时保持无归档目录语义（folder=null 走内嵌日志兜底） */
    DEFAULT_PIPELINE_SCRIPTS_DIR: '',
    fetch: async () => { throw new Error('unexpected fetch') },
    stripSuffixName: value => String(value || '').replace(/\s*·\s*定时后缀\s*$/, '') || 'pipeline',
    hhmm: () => '12:34',
    randHex: length => 'abcdef123456'.slice(0, length),
    sanitizeFsName: String,
    nowCompactFull: () => '20260910123456',
    durText: () => '1s',
    sleepMs: async () => {},
    taskLogPath: (folder, tag, seq, name) => `${folder}/run-${tag}-${String(seq).padStart(2, '0')}-${name}.log`,
    writeTaskLogFile: async () => null,
    appendTaskLogNote: async () => true,
    writePipelineSummaryFile: async () => {},
    stageLogText: (name, result) => `${name}:${result.code}`,
    runStageScript: async script => { calls.push(script.name); return { code: 0, stdout: '', stderr: '' } },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })
  return { ctx, handlers, warnings, calls }
}

function registerRunApi(harness, storeFile) {
  let execution = null
  harness.ctx.registerPipelineRunApi(
    { register(route) { harness.handlers[route.path] = route.handler } },
    {
      readStore: async () => JSON.parse(await readFile(storeFile, 'utf8')),
      execute: plan => (execution = harness.ctx.execPlan(plan)),
      createRunId: () => 'api-run-envnodes',
      warn: message => harness.warnings.push(String(message)),
    },
  )
  return () => execution
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

async function callRun(handler, id, body = {}) {
  const res = response()
  const raw = JSON.stringify(body)
  const req = {
    method: 'POST',
    url: '/api/worktable/pipeline/run/' + encodeURIComponent(id),
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) },
    async *[Symbol.asyncIterator]() { yield Buffer.from(raw) },
  }
  await handler(req, res)
  await Promise.resolve()
  return res
}

async function tempStore(t, store) {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'pipeline-envnodes-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storeFile = pathResolve(dir, 'storages', 'worktable-pipeline.json')
  await mkdir(dirname(storeFile), { recursive: true })
  await writeFile(storeFile, JSON.stringify(store), 'utf8')
  return storeFile
}

const credentialedStore = {
  config: {
    pipelines: [{
      id: 'pipe-release',
      name: '发布流水线',
      stages: [{ id: 'deploy', name: '部署', kind: 'simulate', dur: 1 }],
      defaults: { environmentIds: ['env-dev', 'env-k8s', 'env-bare', 'env-k8s2', 'env-idonly'] },
    }],
    environments: [
      { id: 'env-dev', name: '开发', ip: '10.0.0.1', nodeIp: '', user: 'root', pass: 'dev-pass' },
      { id: 'env-k8s', name: 'K8s 生产', ip: '192.168.1.10', nodeIp: '172.16.0.10', user: 'ops', pass: 'prod-secret-pass' },
      { id: 'env-bare', name: '', ip: '10.0.0.9', nodeIp: '', user: 'u1', pass: 'bare-pass' },
      { id: 'env-k8s2', name: 'k8s-备', ip: '', nodeIp: '172.16.0.11', user: 'u2', pass: 'k8s2-pass' },
      { id: 'env-idonly', name: '', ip: '', nodeIp: '', user: 'u3', pass: 'idonly-pass' },
    ],
  },
  history: [],
}

const NODE_SECRETS = ['dev-pass', 'prod-secret-pass', 'bare-pass', 'k8s2-pass', 'idonly-pass']

test('服务端 API 运行路径写入的历史带结构化 envNodes（name/ip/nodeIp），凭据不落历史', async t => {
  const storeFile = await tempStore(t, credentialedStore)
  const harness = loadHistoryHarness(storeFile)
  const takeExecution = registerRunApi(harness, storeFile)

  const res = await callRun(harness.handlers['/api/worktable/pipeline/run'], 'pipe-release')
  assert.equal(res.status, 202)
  await takeExecution()

  const raw = await readFile(storeFile, 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.history.length, 1)
  const record = parsed.history[0]
  assert.deepEqual(record.envNodes, [
    { name: '开发', ip: '10.0.0.1', nodeIp: '' },
    { name: 'K8s 生产', ip: '192.168.1.10', nodeIp: '172.16.0.10' },
    { name: '', ip: '10.0.0.9', nodeIp: '' },
    { name: 'k8s-备', ip: '172.16.0.11', nodeIp: '172.16.0.11' },
    { name: '', ip: 'env-idonly', nodeIp: '' },
  ])
  for (const node of record.envNodes) {
    assert.deepEqual(Object.keys(node).sort(), ['ip', 'name', 'nodeIp'], 'envNodes 条目只允许 name/ip/nodeIp 三字段')
  }
  const historyText = JSON.stringify(parsed.history)
  for (const secret of [...NODE_SECRETS, 'root', 'ops', 'u1', 'u2', 'u3']) {
    assert.ok(!historyText.includes(secret), `历史记录不得包含节点凭据 ${secret}`)
  }
  /* 存储 config 段按既有设计本就保存环境凭据，断言基线：口令仍在 config，证明清洗针对的是历史记录 */
  assert.ok(raw.includes('prod-secret-pass'), 'config 段凭据应原样保留（历史不落才是本断言的基线）')
})

test('运行 plan 的节点凭据不随历史写进存储文件任何位置', async t => {
  const storeFile = await tempStore(t, { config: {}, history: [] })
  const harness = loadHistoryHarness(storeFile)

  await harness.ctx.execPlan({
    id: 'run-cred-check',
    runId: 'run-cred-check',
    pipelineId: 'pipe-release',
    pipelineName: '发布流水线',
    stages: [{ id: 'deploy', name: '部署', script: { name: 'deploy.sh', path: '/scripts/deploy.sh', params: [], values: {} } }],
    env: '10.0.0.7，10.0.0.8',
    envs: [
      { id: 'e1', name: '节点一', ip: '10.0.0.7', nodeIp: '', user: 'root', pass: 'plan-only-secret' },
      { id: 'e2', name: '', ip: '10.0.0.8', nodeIp: '10.8.0.8', user: 'ops', pass: 'plan-only-secret-2' },
    ],
    repository: null,
    branch: 'main',
    strategy: '',
    by: 'schedule',
    source: 'schedule',
  })

  const raw = await readFile(storeFile, 'utf8')
  assert.ok(!raw.includes('plan-only-secret'), '节点口令不得出现在存储 JSON 任何位置')
  assert.ok(!raw.includes('plan-only-secret-2'), '节点口令不得出现在存储 JSON 任何位置')
  const record = JSON.parse(raw).history[0]
  assert.deepEqual(record.envNodes, [
    { name: '节点一', ip: '10.0.0.7', nodeIp: '' },
    { name: '', ip: '10.0.0.8', nodeIp: '10.8.0.8' },
  ])
})

test('未选任何环境节点时历史记录 envNodes 为 []', async t => {
  const storeFile = await tempStore(t, credentialedStore)
  const harness = loadHistoryHarness(storeFile)
  const takeExecution = registerRunApi(harness, storeFile)

  const res = await callRun(harness.handlers['/api/worktable/pipeline/run'], 'pipe-release', { environmentIds: [] })
  assert.equal(res.status, 202)
  await takeExecution()

  const parsed = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.equal(parsed.history.length, 1)
  assert.ok('envNodes' in parsed.history[0], '新记录必须总是带 envNodes 字段')
  assert.deepEqual(parsed.history[0].envNodes, [])
})

test('旧计划无 envs 数组时按 env 字符串（中文/英文逗号）回退生成 envNodes，且封顶 50 条', async t => {
  const storeFile = await tempStore(t, { config: {}, history: [] })
  const harness = loadHistoryHarness(storeFile)
  const legacyPlan = overrides => ({
    id: 'run-legacy',
    runId: 'run-legacy',
    pipelineId: 'pipe-release',
    pipelineName: '发布流水线',
    stages: [{ id: 'deploy', name: '部署', script: { name: 'deploy.sh', path: '/scripts/deploy.sh', params: [], values: {} } }],
    env: '10.0.0.1，10.0.0.2,10.0.0.3',
    repository: null,
    branch: 'main',
    strategy: '',
    by: 'schedule',
    source: 'schedule',
    ...overrides,
  })

  await harness.ctx.execPlan(legacyPlan())
  let parsed = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.deepEqual(parsed.history[0].envNodes, [
    { name: '', ip: '10.0.0.1', nodeIp: '' },
    { name: '', ip: '10.0.0.2', nodeIp: '' },
    { name: '', ip: '10.0.0.3', nodeIp: '' },
  ])

  await harness.ctx.execPlan(legacyPlan({
    id: 'run-legacy-many',
    runId: 'run-legacy-many',
    env: Array.from({ length: 60 }, (_, index) => `10.0.${Math.floor(index / 256)}.${index % 256}`).join('，'),
  }))
  parsed = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.equal(parsed.history[0].envNodes.length, 50, 'envNodes 最多保留 50 条')
  assert.deepEqual(parsed.history[0].envNodes[0], { name: '', ip: '10.0.0.0', nodeIp: '' })
})

test('mergePipelineHistoryForWrite 对无 envNodes 的遗留记录与带 envNodes 的新记录都原样保留', () => {
  const ctx = loadHistoryHelpers()
  const legacy = { no: 1, tag: 'legacy-1', ts: 100, pipeline: '发布流水线', env: '10.0.0.1' }
  const modern = {
    no: 2, tag: 'run-2', ts: 200, pipeline: '发布流水线', env: '10.0.0.2',
    envNodes: [{ name: '开发', ip: '10.0.0.2', nodeIp: '' }],
  }

  const merged = ctx.mergePipelineHistoryForWrite({}, {}, [legacy, modern], [])
  assert.equal(merged.history.length, 2)
  assert.deepEqual(plain(merged.history[0].envNodes), [{ name: '开发', ip: '10.0.0.2', nodeIp: '' }], '带 envNodes 的记录合并后字段保留')
  assert.ok(!('envNodes' in merged.history[1]), '遗留记录不得被合并补齐出 envNodes 字段')

  const diskOnly = ctx.mergePipelineHistoryForWrite({}, {}, [], [legacy])
  assert.equal(diskOnly.history.length, 1)
  assert.ok(!('envNodes' in diskOnly.history[0]), '磁盘遗留记录原样保留且不报错')
})

test('cleanPipelineHistory 对 envNodes 做防御性清洗（非数组剔除、脏条目过滤、截 50、字段限长）', () => {
  const ctx = loadHistoryHelpers()
  const cleaned = plain(ctx.cleanPipelineHistory([
    { no: 1, tag: 'junk-string', envNodes: 'junk' },
    { no: 2, tag: 'junk-items', envNodes: [null, 'x', 7, { name: '', ip: '' }, { name: 'a', ip: '1', nodeIp: '2', user: 'u', pass: 'p' }, ...Array.from({ length: 60 }, () => ({ name: 'n', ip: 'i' }))] },
    { no: 3, tag: 'oversize', envNodes: [{ name: 'x'.repeat(300), ip: '10.0.0.1' }] },
    { no: 4, tag: 'plain', env: '10.0.0.1' },
  ]))

  assert.ok(!('envNodes' in cleaned[0]), '非数组 envNodes 整体剔除')
  assert.equal(cleaned[1].envNodes.length, 50, '清洗后截到 50 条')
  assert.deepEqual(cleaned[1].envNodes[0], { name: 'a', ip: '1', nodeIp: '2' }, '凭据键不得放行，空条目丢弃')
  assert.equal(cleaned[2].envNodes[0].name.length, 128, '超长字段截断')
  assert.equal(cleaned[2].envNodes[0].ip, '10.0.0.1')
  assert.ok(!('envNodes' in cleaned[3]), '无 envNodes 的遗留记录不受影响')
})

test('pipelineHistoryEnvNodes 映射规则：nodeIp/id 兜底进 ip，name 与 ip 均空的条目丢弃', () => {
  const ctx = loadHistoryHelpers()
  assert.deepEqual(plain(ctx.pipelineHistoryEnvNodes([
    { id: 'e1', name: 'n1', ip: '10.0.0.1', nodeIp: '172.16.0.1', user: 'u', pass: 'p' },
    { id: 'e2', name: 'n2', ip: '', nodeIp: '172.16.0.2' },
    { id: 'e3', name: '', ip: '', nodeIp: '' },
    null,
    'junk',
  ], '')), [
    { name: 'n1', ip: '10.0.0.1', nodeIp: '172.16.0.1' },
    { name: 'n2', ip: '172.16.0.2', nodeIp: '172.16.0.2' },
    { name: '', ip: 'e3', nodeIp: '' },
  ])
  assert.deepEqual(plain(ctx.pipelineHistoryEnvNodes([], '')), [], '空 envs 数组映射为空数组（不回退）')
  assert.deepEqual(plain(ctx.pipelineHistoryEnvNodes(undefined, '10.0.0.1，10.0.0.2')), [
    { name: '', ip: '10.0.0.1', nodeIp: '' },
    { name: '', ip: '10.0.0.2', nodeIp: '' },
  ])
  assert.deepEqual(plain(ctx.pipelineHistoryEnvNodes(null, '')), [], 'envs 缺失且 env 为空时结果仍为空数组')
})
