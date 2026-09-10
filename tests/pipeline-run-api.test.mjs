import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { resolve as pathResolve } from 'node:path'
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

function loadRunRoute(store) {
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
    console,
    pathResolve,
    readJsonBody: async req => req.body ?? {},
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
      execute: async plan => { executions.push(plan) },
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
  const res = response()
  await handler({ method, url: '/api/worktable/pipeline/run/' + encodeURIComponent(id), body }, res)
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
    ['pipe-release', { presets: ['cleanup', 'root-shell'] }, 400, 'invalid preset'],
  ]
  for (const [id, body, status, error] of cases) {
    const f = loadRunRoute(stored)
    const res = await call(f.handler, id, body)
    assert.equal(res.status, status)
    assert.equal(res.json().error, error)
    assert.equal(f.executions.length, 0)
  }

  const f = loadRunRoute(stored)
  const res = await call(f.handler, 'pipe-release', {}, 'GET')
  assert.equal(res.status, 405)
  assert.equal(f.executions.length, 0)
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

test('服务端为缺少预设标记的旧流水线补齐所选预设任务', () => {
  const f = loadRunRoute(stored)
  const expanded = f.ctx.materializeServerPipelineStages(
    [{ id: 'build', name: '构建', kind: 'simulate' }],
    ['cleanup', 'profiling', 'promCollect'],
    {
      scriptsDir: '/opt/pipeline/scripts',
      cleanupScript: { name: 'cleanup.sh', path: '/opt/pipeline/scripts/cleanup.sh' },
      profilingScript: { name: 'profile.py', path: '/opt/pipeline/scripts/profile.py' },
      prom: { collectScript: 'collect.py' },
    },
  )

  assert.deepEqual(plain(expanded.map(stage => stage.id)), ['__cleanup__', 'build', '__profiling__', '__prom_collect__'])
  assert.equal(expanded.at(-1).script.path, '/opt/pipeline/scripts/collect.py')
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
    execFile(command, args, options, callback) {
      called = { command, args, options }
      callback(null, '', '')
    },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)

  const result = await ctx.runStageScript(
    { name: 'deploy.sh', path: '/scripts/deploy.sh', params: [], values: {} },
    {
      env: '10.0.0.2',
      envs: [{ ip: '10.0.0.2', user: 'root', pass: 'node-pass' }],
      repository: { url: 'https://git.example/app.git', user: 'git-bot', pass: 'git-token' },
      branch: 'release/2026',
      strategy: 'blue-green',
      pipelineName: '发布流水线',
      tag: 'api-tag',
    },
    '/scripts',
  )

  assert.equal(result.code, 0)
  assert.equal(called.options.env.GIT_URL, 'https://git.example/app.git')
  assert.equal(called.options.env.GIT_USER, 'git-bot')
  assert.equal(called.options.env.GIT_PASSWORD, 'git-token')
  assert.equal(called.options.env.GIT_BRANCH, 'release/2026')
  assert.equal(called.options.env.DEPLOY_STRATEGY, 'blue-green')
  assert.equal(called.options.env.KEEP_ME, 'yes')
})

function loadExecPlan(config, results = {}) {
  const apiStart = source.indexOf('/* ---------- 流水线 API 触发 ---------- */')
  const apiEnd = source.indexOf('/* ---------- 流水线 API 触发结束 ---------- */', apiStart)
  assert.ok(apiStart >= 0 && apiEnd > apiStart, '流水线 API helper 未找到')
  const code = stripTypeScriptTypes(source.slice(apiStart, apiEnd) + '\n' + extractFunction('execPlan'), { mode: 'transform' })
  const calls = []
  const history = []
  const ctx = {
    URL,
    Promise,
    Buffer,
    Date,
    Math,
    console,
    pathResolve,
    readPipelineStore: async () => ({ config }),
    stripSuffixName: value => String(value || '').replace(/\s*·\s*定时后缀\s*$/, '') || 'pipeline',
    hhmm: () => '12:34',
    randHex: length => 'abcdef123456'.slice(0, length),
    sanitizeFsName: String,
    nowCompactFull: () => '20260910123456',
    durText: () => '1s',
    sleepMs: async () => {},
    writeTaskLogFile: async () => null,
    stageLogText: (name, result) => `${name}:${result.code}`,
    parseStageVars: () => ({}),
    parseStageJson: () => null,
    applyOutVars() {},
    runStageScript: async (script, runContext) => {
      calls.push({ script: script.name, runContext: plain(runContext) })
      return results[script.name] || { code: 0, stdout: '', stderr: '' }
    },
    appendPipelineHistory: async record => history.push(plain(record)),
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return { execPlan: ctx.execPlan, calls, history }
}

const apiExecutionConfig = {
  scriptsDir: '',
  checkScript: { name: 'check.sh', path: '/scripts/check.sh', params: [], values: {} },
  profilingScript: { name: 'profile.sh', path: '/scripts/profile.sh', params: [], values: {} },
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
