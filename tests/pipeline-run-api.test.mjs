import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open as fsOpen, readFile, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, resolve as pathResolve } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))

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

function loadRunRoute(store, overrides = {}) {
  const start = source.indexOf('/* ---------- 流水线 API 触发 ---------- */')
  const end = source.indexOf('/* ---------- 流水线 API 触发结束 ---------- */', start)
  assert.ok(start >= 0 && end > start, '流水线 API 触发实现未找到')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const handlers = {}
  const executions = []
  const warnings = []
  let runSeq = 0
  const ctx = {
    URL,
    Promise,
    Buffer,
    console,
    pathResolve,
    json(res, status, body) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  ctx.registerPipelineRunApi(
    { register(route) { handlers[route.path] = route.handler } },
    {
      readStore: async () => structuredClone(store),
      execute: overrides.execute || (async plan => { executions.push(plan) }),
      createRunId: () => 'api-run-' + (++runSeq),
      warn: message => warnings.push(String(message)),
    },
  )
  assert.ok(handlers['/api/worktable/pipeline/run'], '缺少流水线运行前缀路由')
  return { handler: handlers['/api/worktable/pipeline/run'], executions, warnings, ctx }
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

async function call(handler, id, body = {}, method = 'POST') {
  return callRaw(handler, id, method === 'POST' ? JSON.stringify(body) : '', method)
}

async function callRaw(handler, id, raw = '', method = 'POST', contentType = 'application/json', extraHeaders = {}) {
  const res = response()
  const chunks = raw === '' ? [] : [Buffer.from(raw)]
  const headers = { ...extraHeaders }
  if (contentType) headers['content-type'] = contentType
  if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-length')) {
    headers['content-length'] = String(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  }
  const req = {
    method,
    url: '/api/worktable/pipeline/run/' + encodeURIComponent(id),
    headers,
    async *[Symbol.asyncIterator]() { yield * chunks },
  }
  await handler(req, res)
  await Promise.resolve()
  return res
}

const stored = {
  config: {
    pipelines: [{
      id: 'pipe-release',
      name: '发布流水线',
      stages: [{ id: 'deploy', name: '部署', kind: 'simulate', dur: 1 }],
      defaults: {
        environmentIds: ['env-prod'],
        repositoryId: 'repo-app',
        branch: 'release/2026',
        strategy: 'blue-green',
        presets: ['cleanup', 'profiling'],
      },
    }],
    environments: [
      { id: 'env-dev', name: '开发', ip: '10.0.0.1', user: 'root', pass: 'dev-pass' },
      { id: 'env-prod', name: '生产', ip: '10.0.0.2', user: 'ops', pass: 'prod-pass' },
    ],
    repositories: [
      { id: 'repo-tools', name: '工具库', url: 'https://git.example/tools.git', user: 'bot', pass: '' },
      { id: 'repo-app', name: '应用库', url: 'https://git.example/app.git', user: 'bot', pass: '' },
    ],
  },
  history: [],
}

test('API 未传运行参数时逐项使用流水线默认值并异步接受运行', async () => {
  const f = loadRunRoute(stored)
  const res = await call(f.handler, 'pipe-release')

  assert.equal(res.status, 202)
  assert.deepEqual(res.json(), {
    ok: true,
    accepted: true,
    runId: 'api-run-1',
    pipelineId: 'pipe-release',
    pipelineName: '发布流水线',
  })
  assert.equal(f.executions.length, 1)
  const run = f.executions[0]
  assert.equal(run.id, 'api-run-1')
  assert.equal(run.pipelineId, 'pipe-release')
  assert.equal(run.pipelineName, '发布流水线')
  assert.deepEqual(plain(run.envs), [{ id: 'env-prod', name: '生产', ip: '10.0.0.2', user: 'ops', pass: 'prod-pass' }])
  assert.equal(run.env, '10.0.0.2')
  assert.deepEqual(plain(run.repository), { id: 'repo-app', name: '应用库', url: 'https://git.example/app.git', user: 'bot', pass: '' })
  assert.equal(run.branch, 'release/2026')
  assert.equal(run.strategy, 'blue-green')
  assert.deepEqual(plain(run.presets), ['cleanup', 'profiling'])
  assert.equal(run.by, 'api')
  assert.equal(run.source, 'api')
  assert.deepEqual(plain(run.stages), stored.config.pipelines[0].stages)
})

test('服务端 API 与定时计划共用的执行队列最多并发 2 条并按 FIFO 排空', async () => {
  const f = loadRunRoute(stored)
  const releases = []
  const started = []
  const pool = f.ctx.createPipelineExecutionQueue(async plan => {
    started.push(plan.id)
    await new Promise(resolve => releases.push(resolve))
  }, 2, 10)
  const pending = Array.from({ length: 5 }, (_, index) => pool.run({ id: 'run-' + index }))
  await Promise.resolve()
  assert.deepEqual(plain(started), ['run-0', 'run-1'])
  assert.deepEqual(plain(pool.stats()), { active: 2, queued: 3, limit: 2 })

  releases.shift()()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(plain(started), ['run-0', 'run-1', 'run-2'])
  while (started.length < 5) { while (releases.length) releases.shift()(); await new Promise(resolve => setImmediate(resolve)) }
  while (releases.length) releases.shift()()
  await Promise.all(pending)
  assert.deepEqual(plain(started), ['run-0', 'run-1', 'run-2', 'run-3', 'run-4'])
  assert.deepEqual(plain(pool.stats()), { active: 0, queued: 0, limit: 2 })
})

test('服务端执行队列满时拒绝继续持有任务，API 不返回虚假的 202', async () => {
  const f = loadRunRoute(stored)
  const releases = []
  const pool = f.ctx.createPipelineExecutionQueue(async () => {
    await new Promise(resolve => releases.push(resolve))
  }, 1, 1)
  const running = pool.run({ id: 'active' })
  const queued = pool.run({ id: 'queued' })
  assert.throws(() => pool.run({ id: 'overflow' }), error => error?.status === 503 && error?.code === 'PIPELINE_QUEUE_FULL')

  const api = loadRunRoute(stored, { execute: plan => pool.run(plan) })
  const response = await call(api.handler, 'pipe-release')
  assert.equal(response.status, 503)
  assert.match(response.json().error, /queue full/)

  releases.shift()(); await new Promise(resolve => setImmediate(resolve))
  releases.shift()(); await Promise.all([running, queued])
})

test('API 请求体可以覆盖全部运行参数，空策略和空预设也是显式覆盖', async () => {
  const f = loadRunRoute(stored)
  const res = await call(f.handler, 'pipe-release', {
    environmentIds: ['env-dev'],
    repositoryId: 'repo-tools',
    branch: 'feature/api',
    strategy: '',
    presets: [],
    by: 'jenkins',
  })

  assert.equal(res.status, 202)
  const run = f.executions[0]
  assert.deepEqual(plain(run.envs.map(env => env.id)), ['env-dev'])
  assert.equal(run.repository.id, 'repo-tools')
  assert.equal(run.branch, 'feature/api')
  assert.equal(run.strategy, '')
  assert.deepEqual(plain(run.presets), [])
  assert.equal(run.by, 'jenkins')
})

test('API 代码仓对象可单次覆盖地址和凭据且不会写回配置', async () => {
  const f = loadRunRoute(stored)
  const res = await call(f.handler, 'pipe-release', {
    repositoryId: 'repo-app',
    repository: {
      name: '临时镜像仓',
      url: 'https://mirror.example/app.git',
      user: 'api-bot',
      pass: 'one-time-token',
    },
  })

  assert.equal(res.status, 202)
  assert.deepEqual(plain(f.executions[0].repository), {
    id: 'repo-app',
    name: '临时镜像仓',
    url: 'https://mirror.example/app.git',
    user: 'api-bot',
    pass: 'one-time-token',
  })
  assert.equal(stored.config.repositories[1].pass, '')
})

test('旧流水线没有默认值时回退首个环境、首个代码仓和安全基础值', async () => {
  const legacy = structuredClone(stored)
  delete legacy.config.pipelines[0].defaults
  const f = loadRunRoute(legacy)
  const res = await call(f.handler, 'pipe-release')

  assert.equal(res.status, 202)
  const run = f.executions[0]
  assert.deepEqual(plain(run.envs.map(env => env.id)), ['env-dev'])
  assert.equal(run.repository.id, 'repo-tools')
  assert.equal(run.branch, 'main')
  assert.equal(run.strategy, '')
  assert.deepEqual(plain(run.presets), [])
  assert.equal(run.by, 'api')
})

test('API 拒绝未知流水线、环境、代码仓、非法预设和非 POST 方法', async () => {
  const cases = [
    ['missing', {}, 404, 'pipeline not found'],
    ['pipe-release', { environmentIds: ['missing-env'] }, 400, 'environment not found'],
    ['pipe-release', { repositoryId: 'missing-repo' }, 400, 'repository not found'],
    ['pipe-release', { environmentIds: [] }, 400, 'environmentIds must not be empty'],
    ['pipe-release', { environmentIds: ['env-prod', 7] }, 400, 'invalid environmentIds'],
    ['pipe-release', { repository: [] }, 400, 'invalid repository'],
    ['pipe-release', { repository: { pass: 7 } }, 400, 'invalid repository.pass'],
    ['pipe-release', { presets: [7] }, 400, 'invalid presets'],
    ['pipe-release', { presets: ['cleanup', 'root-shell'] }, 400, 'invalid preset'],
  ]
  for (const [id, body, status, error] of cases) {
    const f = loadRunRoute(stored)
    const res = await call(f.handler, id, body)
    assert.equal(res.status, status)
    assert.equal(res.json().error, error)
    assert.equal(f.executions.length, 0)
  }

  let f = loadRunRoute(stored)
  let res = await call(f.handler, 'pipe-release', {}, 'GET')
  assert.equal(res.status, 405)
  assert.equal(f.executions.length, 0)

  const malformedDefault = structuredClone(stored)
  malformedDefault.config.pipelines[0].defaults.environmentIds = ['env-prod', 7]
  f = loadRunRoute(malformedDefault)
  res = await call(f.handler, 'pipe-release')
  assert.equal(res.status, 409)
  assert.equal(res.json().error, 'invalid configured environmentIds')
  assert.equal(f.executions.length, 0)

  const malformedRepositoryDefault = structuredClone(stored)
  malformedRepositoryDefault.config.pipelines[0].defaults.repositoryId = 7
  f = loadRunRoute(malformedRepositoryDefault)
  res = await call(f.handler, 'pipe-release')
  assert.equal(res.status, 409)
  assert.equal(res.json().error, 'invalid configured repositoryId')
  assert.equal(f.executions.length, 0)
})

test('API 拒绝失效的流水线默认引用，不静默改投首个环境或代码仓', async () => {
  const invalidEnvironment = structuredClone(stored)
  invalidEnvironment.config.pipelines[0].defaults.environmentIds = ['env-prod', 'removed-env']
  let f = loadRunRoute(invalidEnvironment)
  let res = await call(f.handler, 'pipe-release')
  assert.equal(res.status, 409)
  assert.equal(res.json().error, 'configured environment not found')
  assert.equal(f.executions.length, 0)

  const invalidRepository = structuredClone(stored)
  invalidRepository.config.pipelines[0].defaults.repositoryId = 'removed-repo'
  f = loadRunRoute(invalidRepository)
  res = await call(f.handler, 'pipe-release')
  assert.equal(res.status, 409)
  assert.equal(res.json().error, 'configured repository not found')
  assert.equal(f.executions.length, 0)
})

test('API 严格拒绝畸形、非对象、错误媒体类型和超限 JSON，不会误启默认流水线', async () => {
  const cases = [
    ['{', 'application/json', {}, 400, 'invalid JSON'],
    ['[]', 'application/json', {}, 400, 'JSON body must be an object'],
    ['"deploy"', 'application/json', {}, 400, 'JSON body must be an object'],
    ['{}', 'text/plain', {}, 415, 'content-type must be application/json'],
    [JSON.stringify({ padding: 'x'.repeat(70 * 1024) }), 'application/json', {}, 413, 'request body too large'],
  ]
  for (const [raw, contentType, headers, status, error] of cases) {
    const f = loadRunRoute(stored)
    const res = await callRaw(f.handler, 'pipe-release', raw, 'POST', contentType, headers)
    assert.equal(res.status, status)
    assert.equal(res.json().error, error)
    assert.equal(f.executions.length, 0)
  }
})

test('服务端按流水线编排位置展开所选预设任务并忽略未选项', () => {
  const f = loadRunRoute(stored)
  const stages = [
    { id: '__cleanup__', name: '环境清理', preset: true, pkey: 'cleanup' },
    { id: 'build', name: '构建', kind: 'simulate' },
    { id: '__check__', name: '环境检查', preset: true, pkey: 'check' },
    { id: '__profiling__', name: 'Profiling', preset: true, pkey: 'profiling' },
  ]
  const config = {
    scriptsDir: '/opt/pipeline/scripts',
    cleanupScript: { name: 'cleanup.sh', path: '/opt/pipeline/scripts/cleanup.sh' },
    checkScript: { name: 'check.sh', path: '/opt/pipeline/scripts/check.sh' },
    profilingScript: { name: 'profile.py', path: '/opt/pipeline/scripts/profile.py' },
  }

  const expanded = f.ctx.materializeServerPipelineStages(stages, ['check', 'profiling'], config)

  assert.deepEqual(plain(expanded.map(stage => ({ id: stage.id, script: stage.script && stage.script.name, block: stage.presetBlock }))), [
    { id: 'build' },
    { id: '__check__', script: 'check.sh', block: true },
    { id: '__profiling__', script: 'profile.py', block: false },
  ])
})

test('服务端为缺少预设标记的旧流水线补齐所选预设任务（promCollect 预设已下线，一律忽略）', () => {
  const f = loadRunRoute(stored)
  const expanded = f.ctx.materializeServerPipelineStages(
    [
      { id: 'build', name: '构建', kind: 'simulate' },
      { id: '__prom_collect__', name: '收集普罗数据', preset: true, pkey: 'promCollect' },   // 旧流水线遗留的普罗预设标记行：随预设下线丢弃
    ],
    ['cleanup', 'profiling', 'promCollect'],
    {
      scriptsDir: '/opt/pipeline/scripts',
      cleanupScript: { name: 'cleanup.sh', path: '/opt/pipeline/scripts/cleanup.sh' },
      profilingScript: { name: 'profile.py', path: '/opt/pipeline/scripts/profile.py' },
      prom: { collectScript: 'collect.py' },
    },
  )

  assert.deepEqual(plain(expanded.map(stage => stage.id)), ['__cleanup__', 'build', '__profiling__'])
})

test('EvalTokens 终态先判失败且只接受明确成功值', () => {
  const f = loadRunRoute(stored)
  assert.equal(f.ctx.serverEvaltokensStatus('completed_with_errors'), 'failed')
  assert.equal(f.ctx.serverEvaltokensStatus('not_completed'), 'failed')
  assert.equal(f.ctx.serverEvaltokensStatus('FAILED'), 'failed')
  assert.equal(f.ctx.serverEvaltokensStatus('completed'), 'success')
  assert.equal(f.ctx.serverEvaltokensStatus('success'), 'success')
  assert.equal(f.ctx.serverEvaltokensStatus('success_pending_review'), 'running')
})

test('无 Content-Length 的分块远端响应也按字节上限中止', async () => {
  const f = loadRunRoute(stored)
  let index = 0
  let cancelled = false
  const reader = {
    async read() {
      index += 1
      if (index === 1) return { done: false, value: Buffer.from('1234') }
      if (index === 2) return { done: false, value: Buffer.from('5678') }
      return { done: true }
    },
    async cancel() { cancelled = true },
    releaseLock() {},
  }
  await assert.rejects(
    f.ctx.readServerResponseText({ headers: { get() { return '' } }, body: { getReader() { return reader } } }, 5, 'HTTP '),
    /响应正文超过 5 字节上限/,
  )
  assert.equal(cancelled, true)
})

test('API 选择的代码仓凭据和地址进入服务端脚本运行环境', async () => {
  const start = source.indexOf('  // 参数值 ${VAR} 引用替换（同页面 substRunVars）')
  const end = source.indexOf('  /* 任务回显文本：', start)
  assert.ok(start >= 0 && end > start, '服务端脚本运行函数未找到')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  let called
  const ctx = {
    Buffer,
    Promise,
    process: { env: { KEEP_ME: 'yes' }, platform: process.platform },
    setTimeout,
    clearTimeout,
    spawn(command, args, options) {
      called = { command, args, options }
      const child = new EventEmitter()
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 12345; child.kill = () => true
      queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0) })
      return child
    },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)

  const result = await ctx.runStageScript(
    { name: 'deploy.sh', path: '/scripts/deploy.sh', params: [{ key: 'TRIGGERED_BY', kind: 'env' }], values: { TRIGGERED_BY: '${BY}' } },
    {
      env: '10.0.0.2',
      envs: [{ ip: '10.0.0.2', user: 'root', pass: 'node-pass' }],
      repository: { url: 'https://git.example/app.git', user: 'git-bot', pass: 'git-token' },
      branch: 'release/2026',
      strategy: 'blue-green',
      pipelineName: '发布流水线',
      tag: 'api-tag',
      by: 'jenkins',
    },
    '/scripts',
  )

  assert.equal(result.code, 0)
  assert.equal(called.options.env.GIT_URL, 'https://git.example/app.git')
  assert.equal(called.options.env.GIT_USER, 'git-bot')
  assert.equal(called.options.env.GIT_PASSWORD, 'git-token')
  assert.equal(called.options.env.GIT_BRANCH, 'release/2026')
  assert.equal(called.options.env.DEPLOY_STRATEGY, 'blue-green')
  assert.equal(called.options.env.TRIGGERED_BY, 'jenkins')
  assert.equal(called.options.env.KEEP_ME, 'yes')
})

test('服务端脚本把完整大日志流式落盘，内存结果有界且保留早期变量', async t => {
  const dir = await mkdtemp(tmpdir() + '/pipeline-server-log-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const logFile = pathResolve(dir, 'run-heavy.log')
  const start = source.indexOf('  // 参数值 ${VAR} 引用替换（同页面 substRunVars）')
  const end = source.indexOf('  /* 任务回显文本：', start)
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const chunks = ['EARLY=kept\n', ...Array.from({ length: 8 }, () => 'x'.repeat(128 * 1024)), '\nLATE=tail\n']
  const spawnMock = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 12345; child.kill = () => true
    queueMicrotask(() => {
      chunks.forEach(chunk => child.stdout.write(chunk))
      child.stderr.write('partial-')
      child.stderr.write('line\n')
      child.stderr.write('next')
      child.stdout.end(); child.stderr.end(); child.emit('close', 0)
    })
    return child
  }
  const ctx = {
    Buffer, Promise, process: { env: {}, platform: 'win32' }, spawn: spawnMock, fsMkdir: mkdir, fsOpen, dirname, pathResolve, setTimeout, clearTimeout,
    execFile(_command, _args, _options, callback) { callback(null, chunks.join(''), '') },
  }
  vm.createContext(ctx); vm.runInContext(code, ctx)
  const tail = ctx.createServerTextTail()
  for (const chunk of chunks) ctx.appendServerTextTail(tail, chunk)
  assert.ok(tail.chunks.reduce((sum, value) => sum + value.length, 0) <= 256 * 1024, '服务端尾窗也必须释放已淘汰分片引用')
  const result = await ctx.runStageScript(
    { name: 'heavy.sh', path: '/scripts/heavy.sh', params: [], values: {}, outVars: '' },
    { envs: [], repository: {}, pipelineName: 'P', tag: 'tag' }, '/scripts', {}, 0, undefined, logFile,
  )
  assert.equal(result.code, 0)
  assert.ok(result.stdout.length <= 256 * 1024)
  assert.equal(result.stdoutTruncated, true)
  assert.equal(result.vars.EARLY, 'kept')
  const archived = await readFile(logFile, 'utf8')
  assert.match(archived, /EARLY=kept/)
  assert.match(archived, /LATE=tail/)
  assert.match(archived, /✗ partial-line\n✗ next/, 'stderr 分片边界不能被误写成新的日志行')
  assert.doesNotMatch(archived, /partial-\n✗ line/, 'stderr 原始行跨 chunk 时不能插入换行')
  assert.ok(archived.length > 1024 * 1024, '磁盘任务日志必须保留完整输出')
})

test('服务端直写任务日志追加普罗结果，流式汇总保留完整任务正文', async t => {
  const dir = await mkdtemp(tmpdir() + '/pipeline-summary-log-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const taskLog = pathResolve(dir, 'task.log'), summary = pathResolve(dir, 'summary.log')
  const full = 'HEAD\n' + 'x'.repeat(1024 * 1024) + '\nTAIL\n[exit 0]\n'
  await writeFile(taskLog, full, 'utf8')
  const code = stripTypeScriptTypes(extractFunction('appendTaskLogNote') + '\n' + extractFunction('stripTrailingPipelineResult') + '\n' + extractFunction('writePipelineSummaryFile'), { mode: 'transform' })
  let lockCalls = 0, activeLocks = 0
  const ctx = {
    Buffer, fsOpen, fsMkdir: mkdir, dirname, pathResolve, createReadStream, String, console: { warn() {} },
    async lockStreamWritePath() {
      lockCalls += 1
      assert.equal(activeLocks, 0, '同一汇总路径的写入必须串行')
      activeLocks += 1
      return () => { activeLocks -= 1 }
    },
  }
  vm.createContext(ctx); vm.runInContext(code, ctx)
  const note = '[普罗采集] 已收集 → /metrics/task'
  assert.equal(await ctx.appendTaskLogNote(taskLog, note), true)
  await ctx.writePipelineSummaryFile(summary, false, [{ stage: '测试模型', status: 'success', logFile: taskLog, log: '' }], 'success')
  const taskText = await readFile(taskLog, 'utf8'), summaryText = await readFile(summary, 'utf8')
  assert.match(taskText, /HEAD/); assert.match(taskText, /TAIL/); assert.match(taskText, /\[普罗采集\] 已收集/)
  assert.match(summaryText, /HEAD/); assert.match(summaryText, /TAIL/); assert.match(summaryText, /\[普罗采集\] 已收集/)
  await ctx.writePipelineSummaryFile(summary, true, [{ stage: '收尾', status: 'failed', log: 'oops' }], 'failed')
  const appended = await readFile(summary, 'utf8')
  assert.equal((appended.match(/^\[result\]/gm) || []).length, 1, '定时后缀追加后只能保留一个最终 result')
  assert.match(appended, /----- 定时执行（服务端） -----/)
  assert.match(appended, /\[result\] failed\n$/)
  assert.equal(lockCalls, 2, '新建与后缀追加都必须复用流式归档的路径锁')
  assert.equal(activeLocks, 0)
})

function loadExecPlan(config, results = {}, fetchImpl = async () => { throw new Error('unexpected fetch') }) {
  const apiStart = source.indexOf('/* ---------- 流水线 API 触发 ---------- */')
  const apiEnd = source.indexOf('/* ---------- 流水线 API 触发结束 ---------- */', apiStart)
  assert.ok(apiStart >= 0 && apiEnd > apiStart, '流水线 API helper 未找到')
  const code = stripTypeScriptTypes(source.slice(apiStart, apiEnd) + '\n' + extractFunction('execPlan'), { mode: 'transform' })
  const calls = []
  const history = []
  const notes = []
  const summaries = []
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
    fetch: fetchImpl,
    readPipelineStore: async () => ({ config }),
    stripSuffixName: value => String(value || '').replace(/\s*·\s*定时后缀\s*$/, '') || 'pipeline',
    hhmm: () => '12:34',
    randHex: length => 'abcdef123456'.slice(0, length),
    sanitizeFsName: String,
    nowCompactFull: () => '20260910123456',
    durText: () => '1s',
    sleepMs: async () => {},
    taskLogPath: (folder, tag, seq, name) => `${folder}/run-${tag}-${String(seq).padStart(2, '0')}-${name}.log`,
    writeTaskLogFile: async () => null,
    appendTaskLogNote: async (file, note) => { notes.push({ file, note }); return true },
    writePipelineSummaryFile: async (file, append, logs, status) => { summaries.push({ file, append, logs: plain(logs), status }) },
    stageLogText: (name, result) => `${name}:${result.code}`,
    parseStageVars: () => ({}),
    parseStageJson: () => null,
    applyOutVars() {},
    runStageScript: async (script, runContext, scriptsDir, varsPool, timeout, extraEnv, outputFile) => {
      calls.push({ script: script.name, runContext: plain(runContext), scriptsDir, varsPool: plain(varsPool || {}), timeout, extraEnv: plain(extraEnv || {}), outputFile })
      return results[script.name] || { code: 0, stdout: '', stderr: '' }
    },
    appendPipelineHistory: async record => history.push(plain(record)),
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return { execPlan: ctx.execPlan, calls, history, notes, summaries }
}

const apiExecutionConfig = {
  scriptsDir: '',
  checkScript: { name: 'check.sh', path: '/scripts/check.sh', params: [], values: {} },
  profilingScript: { name: 'profile.sh', path: '/scripts/profile.sh', params: [], values: {} },
}

function fetchResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return headers[String(name).toLowerCase()] || '' } },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body) },
  }
}

function apiExecutionPlan(presets = ['check']) {
  return {
    id: 'api-run-7',
    runId: 'api-run-7',
    pipelineId: 'pipe-release',
    pipelineName: '发布流水线',
    stages: [
      { id: '__check__', name: '环境检查', preset: true, pkey: 'check' },
      { id: 'deploy', name: '部署', script: { name: 'deploy.sh', path: '/scripts/deploy.sh', params: [], values: {} } },
      { id: '__profiling__', name: 'Profiling', preset: true, pkey: 'profiling' },
    ],
    env: '10.0.0.2',
    envs: [{ id: 'env-prod', ip: '10.0.0.2', user: 'ops', pass: 'node-pass' }],
    repository: { id: 'repo-app', url: 'https://git.example/app.git', user: 'bot', pass: '' },
    repoId: 'repo-app',
    branch: 'release/2026',
    strategy: 'blue-green',
    presets,
    by: 'jenkins',
    source: 'api',
  }
}

test('API 服务端执行器展开预设、携带代码仓上下文并写入可关联的历史字段', async () => {
  const f = loadExecPlan(apiExecutionConfig)
  await f.execPlan(apiExecutionPlan(['check']))

  assert.deepEqual(f.calls.map(call => call.script), ['check.sh', 'deploy.sh'])
  assert.equal(f.calls[0].runContext.repository.url, 'https://git.example/app.git')
  assert.equal(f.calls[0].runContext.branch, 'release/2026')
  assert.equal(f.history.length, 1)
  assert.equal(f.history[0].runId, 'api-run-7')
  assert.equal(f.history[0].pipelineId, 'pipe-release')
  assert.equal(f.history[0].repoId, 'repo-app')
  assert.equal(f.history[0].source, 'api')
  assert.equal(f.history[0].status, 'success')
})

test('非阻断预设失败后继续运行，环境检查失败则阻断后续阶段', async () => {
  const profiling = loadExecPlan(apiExecutionConfig, { 'profile.sh': { code: 2, stdout: '', stderr: 'profile failed' } })
  await profiling.execPlan(apiExecutionPlan(['profiling']))
  assert.deepEqual(profiling.calls.map(call => call.script), ['deploy.sh', 'profile.sh'])
  assert.equal(profiling.history[0].status, 'success')

  const checking = loadExecPlan(apiExecutionConfig, { 'check.sh': { code: 3, stdout: '', stderr: 'check failed' } })
  await checking.execPlan(apiExecutionPlan(['check']))
  assert.deepEqual(checking.calls.map(call => call.script), ['check.sh'])
  assert.equal(checking.history[0].status, 'failed')
})

test('API 服务端实际执行 HTTP 阶段并替换运行变量，不把未执行请求记为成功', async () => {
  const requests = []
  const f = loadExecPlan(apiExecutionConfig, {}, async (url, options = {}) => {
    requests.push({ url: String(url), options })
    return fetchResponse(200, '{\n  "image": "registry.example/app:v9"\n}')
  })
  const plan = apiExecutionPlan([])
  plan.stages = [{
    id: 'trigger', name: '触发发布', kind: 'http',
    url: { url: 'https://hooks.internal/deploy?branch={GIT_BRANCH}', outVars: 'IMAGE_URL=image' },
  }]

  await f.execPlan(plan)

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://hooks.internal/deploy?branch=release%2F2026')
  assert.equal(requests[0].options.method, 'GET')
  assert.equal(f.history[0].status, 'success')
  assert.match(f.history[0].logs[0].log, /\{"image":"registry\.example\/app:v9"\}/,'多行 JSON 响应应规整为单行供输出变量解析')
  assert.doesNotMatch(f.history[0].logs[0].log, /暂不支持|已跳过/)
})

test('API 服务端执行旧 Jenkins fullName 阶段并等待对应构建完成', async () => {
  const requests = []
  const f = loadExecPlan({
    ...apiExecutionConfig,
    jenkins: { url: 'http://jenkins.internal', user: 'ci', token: 'secret' },
  }, {}, async (url, options = {}) => {
    const value = String(url)
    requests.push({ url: value, options })
    if (value.endsWith('/crumbIssuer/api/json')) return fetchResponse(404, '')
    if (value.endsWith('/buildWithParameters')) return fetchResponse(201, '', { location: '/queue/item/99/' })
    if (value.endsWith('/queue/item/99/api/json')) return fetchResponse(200, { executable: { number: 42 } })
    if (value.includes('/42/api/json')) return fetchResponse(200, { number: 42, building: false, result: 'SUCCESS' })
    if (value.endsWith('/42/consoleText')) return fetchResponse(200, 'IMAGE_TAG=from-jenkins')
    throw new Error('unexpected URL ' + value)
  })
  const plan = apiExecutionPlan([])
  plan.stages = [{ id: 'jenkins', name: 'Jenkins 构建', kind: 'jenkins', jenkins: { job: 'folder/app' } }]

  await f.execPlan(plan)

  assert.ok(requests.some(request => request.url.endsWith('/job/folder/job/app/buildWithParameters') && request.options.method === 'POST'))
  assert.ok(requests.some(request => request.url.endsWith('/queue/item/99/api/json')),'应从本次触发返回的 queue item 解析构建号')
  assert.ok(!requests.some(request => request.url.includes('nextBuildNumber')),'不能用存在并发竞态的 nextBuildNumber 绑定本次构建')
  assert.ok(requests.some(request => request.url.includes('/job/folder/job/app/42/api/json')))
  assert.equal(f.history[0].status, 'success')
})

test('Jenkins 构建成功后的最终控制台读取仍受阶段 deadline 限制', async () => {
  const f = loadExecPlan({
    ...apiExecutionConfig,
    jenkins: { url: 'http://jenkins.internal', user: 'ci', token: 'secret' },
  }, {}, async (url, options = {}) => {
    const value = String(url)
    if (value.endsWith('/crumbIssuer/api/json')) return fetchResponse(404, '')
    if (value.endsWith('/buildWithParameters')) return fetchResponse(201, '', { location: '/queue/item/100/' })
    if (value.endsWith('/queue/item/100/api/json')) return fetchResponse(200, { executable: { number: 43 } })
    if (value.includes('/43/api/json')) return fetchResponse(200, { number: 43, building: false, result: 'SUCCESS' })
    if (value.endsWith('/43/consoleText')) {
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    throw new Error('unexpected URL ' + value)
  })
  const plan = apiExecutionPlan([])
  plan.stages = [{ id: 'jenkins-timeout', name: 'Jenkins 收尾超时', kind: 'jenkins', timeout: 1, jenkins: { job: 'folder/app' } }]

  await f.execPlan(plan)

  assert.equal(f.history[0].status, 'failed', '收尾控制台请求超时不得误报 Jenkins 成功')
  assert.match(f.history[0].logs[0].log, /Jenkins 控制台等待超时/)
})

test('Jenkins 控制台超限不改写构建终态但显示日志不完整告警', async () => {
  const f = loadExecPlan({
    ...apiExecutionConfig,
    jenkins: { url: 'http://jenkins.internal', user: 'ci', token: 'secret' },
  }, {}, async (url) => {
    const value = String(url)
    if (value.endsWith('/crumbIssuer/api/json')) return fetchResponse(404, '')
    if (value.endsWith('/buildWithParameters')) return fetchResponse(201, '', { location: '/queue/item/101/' })
    if (value.endsWith('/queue/item/101/api/json')) return fetchResponse(200, { executable: { number: 44 } })
    if (value.includes('/44/api/json')) return fetchResponse(200, { number: 44, building: false, result: 'SUCCESS' })
    if (value.endsWith('/44/consoleText')) return fetchResponse(200, '', { 'content-length': String(17 * 1024 * 1024) })
    throw new Error('unexpected URL ' + value)
  })
  const plan = apiExecutionPlan([])
  plan.stages = [{ id: 'jenkins-large-console', name: 'Jenkins 超大控制台', kind: 'jenkins', jenkins: { job: 'folder/app' } }]

  await f.execPlan(plan)

  assert.equal(f.history[0].status, 'success')
  assert.match(f.history[0].logs[0].log, /控制台读取失败.*日志可能不完整.*响应正文超过/)
})

test('HTTP 完整 Jenkins URL 只向配置的轮询端发送凭据，触发地址不泄露 Basic 认证', async () => {
  const requests = []
  const f = loadExecPlan({
    ...apiExecutionConfig,
    jenkins: { url: 'http://jenkins.internal', user: 'ci', token: 'secret' },
  }, {}, async (url, options = {}) => {
    const value = String(url)
    requests.push({ url: value, options })
    if (value.startsWith('https://trigger.example/job/folder/job/app/build')) return fetchResponse(201, '', { location: 'https://trigger.example/queue/item/77/' })
    if (value === 'http://jenkins.internal/queue/item/77/api/json') return fetchResponse(200, { executable: { number: 7 } })
    if (value.includes('/job/folder/job/app/7/api/json')) return fetchResponse(200, { number: 7, building: false, result: 'SUCCESS' })
    if (value.endsWith('/job/folder/job/app/7/consoleText')) return fetchResponse(200, '')
    throw new Error('unexpected URL ' + value)
  })
  const plan = apiExecutionPlan([])
  plan.stages = [{
    id: 'jenkins-url', name: 'Jenkins URL', kind: 'http',
    url: { url: 'https://trigger.example/job/folder/job/app/build?token=public-trigger-token' },
  }]

  await f.execPlan(plan)

  const trigger = requests.find(request => request.url.startsWith('https://trigger.example/'))
  assert.ok(trigger)
  assert.equal(trigger.options.headers && trigger.options.headers.Authorization, undefined)
  const poll = requests.find(request => request.url.startsWith('http://jenkins.internal/job/'))
  assert.ok(poll)
  assert.match(poll.options.headers.Authorization, /^Basic /)
  assert.equal(f.history[0].status, 'success')
})

test('Jenkins 触发响应缺少 queue Location 时失败，不猜测其他构建号', async () => {
  const requests = []
  const f = loadExecPlan({
    ...apiExecutionConfig,
    jenkins: { url: 'http://jenkins.internal', user: 'ci', token: 'secret' },
  }, {}, async (url, options = {}) => {
    const value = String(url)
    requests.push(value)
    if (value.endsWith('/crumbIssuer/api/json')) return fetchResponse(404, '')
    if (value.endsWith('/buildWithParameters')) return fetchResponse(201, '')
    throw new Error('unexpected URL ' + value)
  })
  const plan = apiExecutionPlan([])
  plan.stages = [{ id: 'jenkins', name: 'Jenkins 构建', kind: 'jenkins', jenkins: { job: 'folder/app' } }]

  await f.execPlan(plan)

  assert.equal(f.history[0].status, 'failed')
  assert.match(f.history[0].logs[0].log, /缺少 queue Location/)
  assert.ok(!requests.some(url => url.includes('nextBuildNumber')))
})

test('HTTP 响应正文超过服务端上限时中止读取并把阶段记为失败', async () => {
  let textRead = false
  let cancelled = false
  const f = loadExecPlan(apiExecutionConfig, {}, async () => ({
    status: 200,
    headers: { get(name) { return String(name).toLowerCase() === 'content-length' ? String(20 * 1024 * 1024) : '' } },
    body: { async cancel() { cancelled = true } },
    async text() { textRead = true; return 'x' },
  }))
  const plan = apiExecutionPlan([])
  plan.stages = [{ id: 'large', name: '超大响应', kind: 'http', url: { url: 'https://hooks.internal/large' } }]

  await f.execPlan(plan)

  assert.equal(f.history[0].status, 'failed')
  assert.match(f.history[0].logs[0].log, /响应正文超过/)
  assert.equal(textRead, false)
  assert.equal(cancelled, true)
})

test('API 服务端执行 EvalTokens 阶段，传入参数覆盖并等待本次 run 终态', async () => {
  const requests = []
  const f = loadExecPlan({
    ...apiExecutionConfig,
    evaltok: { url: 'http://evaltokens.internal', token: 'eval-secret' },
  }, {}, async (url, options = {}) => {
    const value = String(url)
    requests.push({ url: value, options })
    if (value.endsWith('/api/open/v1/tasks')) return fetchResponse(200, { items: [{ id: 'task-42', name: '评分' }] })
    if (value.endsWith('/api/open/v1/tasks/task-42/run')) return fetchResponse(200, { run_id: 'run-new', status: 'running' })
    if (value.includes('/api/open/v1/tasks/runs?')) return fetchResponse(200, { runs: [{ run_id: 'run-new', status: 'success', score: 98 }] })
    throw new Error('unexpected URL ' + value)
  })
  const plan = apiExecutionPlan([])
  plan.vars = { TASK_ID: '42', MODEL_PATH: '/models/demo' }
  plan.stages = [{
    id: 'eval', name: '模型评分', kind: 'evaltokens', timeout: 30,
    evaltokens: { taskId: 'task-${TASK_ID}', taskName: '', values: { model: '${MODEL_PATH}' }, outVars: 'SCORE=score' },
  }]

  await f.execPlan(plan)

  const start = requests.find(request => request.url.endsWith('/api/open/v1/tasks/task-42/run'))
  assert.ok(start)
  assert.equal(start.options.headers.Authorization, 'Bearer eval-secret')
  assert.deepEqual(JSON.parse(start.options.body), { input: { model: '/models/demo' } })
  assert.ok(requests.some(request => request.url.includes('task_id=task-42')))
  assert.equal(f.history[0].status, 'success')
  assert.doesNotMatch(f.history[0].logs[0].log, /暂不支持|已跳过/)
})

test('EvalTokens completed_with_errors 终态使 API 流水线失败', async () => {
  const f = loadExecPlan({
    ...apiExecutionConfig,
    evaltok: { url: 'http://evaltokens.internal', token: '' },
  }, {}, async (url) => {
    const value = String(url)
    if (value.endsWith('/api/open/v1/tasks')) return fetchResponse(200, [{ id: 'task-bad', name: '失败评估' }])
    if (value.endsWith('/api/open/v1/tasks/task-bad/run')) return fetchResponse(200, { run_id: 'run-bad', status: 'running' })
    if (value.includes('/api/open/v1/tasks/runs?')) return fetchResponse(200, { runs: [{ run_id: 'run-bad', status: 'completed_with_errors' }] })
    throw new Error('unexpected URL ' + value)
  })
  const plan = apiExecutionPlan([])
  plan.stages = [{ id: 'eval', name: '失败评估', kind: 'evaltokens', evaltokens: { taskId: 'task-bad' } }]

  await f.execPlan(plan)

  assert.equal(f.history[0].status, 'failed')
  assert.match(f.history[0].logs[0].log, /EvalTokens failed/)
})

test('勾选收集普罗数据的任务在终态按其起止注入 collect 动作、时间范围、数据源与任务级产物目录', async () => {
  const f = loadExecPlan({
    ...apiExecutionConfig,
    archiveDir: '/var/pipeline-runs',
    prom: { url: 'http://prom.internal:9090', collectScript: 'collect.py' },
  })
  const plan = apiExecutionPlan([])
  plan.vars = { MODEL_PATH: '/models/demo' }
  plan.stages = [{ id: 'test-model', name: '测试模型', promCollect: true, script: { name: 'test.sh', path: '/scripts/test.sh', params: [], values: {} } }]

  await f.execPlan(plan)

  const collect = f.calls.find(call => call.script === 'collect.py')
  assert.ok(collect)
  assert.equal(collect.timeout, 0)
  assert.equal(collect.extraEnv.METRICS_ACTION, 'collect')
  assert.equal(collect.extraEnv.PROMETHEUS_URL, 'http://prom.internal:9090')
  assert.equal(collect.extraEnv.MODEL_NAME, '/models/demo')
  assert.equal(collect.extraEnv.XDS_NAMESPACE, 'blue-green-jenkins')
  assert.match(collect.extraEnv.METRICS_OUTPUT_DIR, /^\/var\/pipeline-runs\/.+\/测试模型-01-普罗数据$/)
  assert.ok(Date.parse(collect.extraEnv.PROM_START) <= Date.parse(collect.extraEnv.PROM_END))
  assert.match(f.history[0].logs[0].log, /\[普罗采集\] 已收集 → /)
})

test('普罗采集结果追加到服务端已直写的任务日志并由汇总复用', async () => {
  const taskLog = '/var/pipeline-runs/direct-task.log'
  const f = loadExecPlan({
    ...apiExecutionConfig,
    archiveDir: '/var/pipeline-runs',
    prom: { url: 'http://prom.internal:9090', collectScript: 'collect.py' },
  }, { 'test.sh': { code: 0, stdout: 'tail', stderr: '', logFile: taskLog } })
  const plan = apiExecutionPlan([])
  plan.stages = [{ id: 'test-model', name: '测试模型', promCollect: true, script: { name: 'test.sh', path: '/scripts/test.sh', params: [], values: {} } }]
  await f.execPlan(plan)
  assert.equal(f.notes.length, 1)
  assert.equal(f.notes[0].file, taskLog)
  assert.match(f.notes[0].note, /^\[普罗采集\] 已收集 → /)
  assert.equal(f.summaries[0].logs[0].logFile, taskLog)
  assert.equal(f.summaries[0].logs[0].logSuffix, '')
})

test('未勾选收集普罗数据的任务与不配置收集脚本时都不发起任务级采集', async () => {
  const off = loadExecPlan({ ...apiExecutionConfig, prom: { url: 'http://prom.internal:9090', collectScript: 'collect.py' } })
  const offPlan = apiExecutionPlan([])
  offPlan.stages = [{ id: 'test-model', name: '测试模型', script: { name: 'test.sh', path: '/scripts/test.sh', params: [], values: {} } }]
  await off.execPlan(offPlan)
  assert.ok(!off.calls.some(call => call.script === 'collect.py'), '未勾选的任务不采集')

  const noScript = loadExecPlan({ ...apiExecutionConfig, prom: { url: 'http://prom.internal:9090', collectScript: '' } })
  const skipPlan = apiExecutionPlan([])
  skipPlan.stages = [{ id: 'test-model', name: '测试模型', promCollect: true, script: { name: 'test.sh', path: '/scripts/test.sh', params: [], values: {} } }]
  await noScript.execPlan(skipPlan)
  assert.ok(!noScript.calls.some(call => call.script === 'collect.py'), '未配置收集脚本不发起采集')
  assert.match(noScript.history[0].logs[0].log, /\[普罗采集\] 已勾选收集普罗数据，但未配置收集脚本/)
})
