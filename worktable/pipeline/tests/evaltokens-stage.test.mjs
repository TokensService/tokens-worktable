import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../pipeline.html', import.meta.url), 'utf8')

function extractFunction(name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const match = marker.exec(html)
  assert.ok(match, `pipeline.html 缺少函数 ${name}`)
  const start = match.index
  const bodyStart = html.indexOf('{', start)
  let depth = 0
  for (let i = bodyStart; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1
    if (html[i] === '}') {
      depth -= 1
      if (depth === 0) return html.slice(start, i + 1)
    }
  }
  throw new Error(`无法提取函数 ${name}`)
}

function loadEvaltokensRuntime(overrides = {}) {
  const context = vm.createContext({
    console,
    encodeURIComponent,
    JSON,
    Object,
    String,
    Date,
    Error,
    Promise,
    AbortController,
    setTimeout,
    clearTimeout,
    ...overrides,
  })
  const names = [
    'evaltokHeaders',
    'evaltokRequestJson',
    'evaltokFetchTasks',
    'evaltokStartRun',
    'evaltokFetchRuns',
    'evaltokStatusKind',
    'runEvaltokensStep',
  ]
  vm.runInContext(names.map(extractFunction).join('\n'), context)
  return context
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
  }
}

test('EvalTokens 阶段启动新 run，并只等待返回的 run_id', async () => {
  const calls = []
  let runPolls = 0
  let advancedTo = null
  let finishedAs = null
  const evaltokConfig = { url: 'http://evaltokens.local', token: 'api-token', mode: 'local' }
  const stage = {
    id: 'eval-stage',
    name: 'PCT60-预热',
    timeout: null,
    evaltokens: { taskId: 'task/a b', taskName: 'warmup', outVars: '' },
  }
  const context = loadEvaltokensRuntime({
    timer: null,
    running: true,
    curRun: { token: 'run-token', vars: {} },
    nodes: {},
    selectedId: '',
    evaltok: evaltokConfig,
    activeStages: () => [stage],
    substRunVars: value => value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url, options = {}) => {
      calls.push({ url, options })
      if (url.endsWith('/api/open/v1/tasks')) {
        return jsonResponse({ tasks: [{ task_id: 'task/a b', name: 'warmup' }] })
      }
      if (url.endsWith('/api/open/v1/tasks/task%2Fa%20b/run')) {
        return jsonResponse({ run_id: 'run-new', task_id: 'task/a b', status: 'running' })
      }
      if (url.includes('/api/open/v1/tasks/runs?task_id=task%2Fa%20b')) {
        runPolls += 1
        return jsonResponse({
          runs: [
            { run_id: 'run-old', task_id: 'task/a b', status: 'success' },
            { run_id: 'run-new', task_id: 'task/a b', status: runPolls === 1 ? 'running' : 'success' },
          ],
        })
      }
      throw new Error(`unexpected request: ${url}`)
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: fn => { fn(); return 1 },
    applyStatusClasses: () => {},
    renderFlow: () => {},
    renderDetail: () => {},
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: index => { advancedTo = index },
    finish: status => { finishedAs = status },
  })

  await context.runEvaltokensStep(0)

  assert.equal(calls[1].options.method, 'POST')
  assert.equal(calls[1].options.headers.Authorization, 'Bearer api-token')
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json')
  assert.equal(calls[1].options.body, '{}')
  assert.equal(runPolls, 2, '旧 run 的成功状态不能让阶段提前结束')
  assert.equal(context.nodes['eval-stage'].status, 'success')
  assert.equal(advancedTo, 1)
  assert.equal(finishedAs, null)
  assert.match(stage._out.stdout, /run-new/)
})

test('远程模式通过 worktable proxy 转发启动请求', async () => {
  const calls = []
  const context = loadEvaltokensRuntime({
    fetch: async (url, options = {}) => {
      calls.push({ url, options })
      return jsonResponse({ status: 201, body: JSON.stringify({ run_id: 'run-remote', status: 'running' }) })
    },
  })

  const run = await context.evaltokStartRun({
    url: 'http://192.168.1.101:9000',
    token: 'remote-token',
    mode: 'remote',
  }, 'task-remote')

  assert.equal(run.run_id, 'run-remote')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/worktable/proxy')
  const forwarded = JSON.parse(calls[0].options.body)
  assert.deepEqual(forwarded, {
    url: 'http://192.168.1.101:9000/api/open/v1/tasks/task-remote/run',
    method: 'POST',
    headers: {
      Authorization: 'Bearer remote-token',
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
})

test('变量或手填任务名会重新解析为真实 task_id，不使用残留的隐藏名称', async () => {
  const calls = []
  let advancedTo = null
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const stage = {
    id: 'eval-by-name',
    name: '按名称运行',
    timeout: null,
    evaltokens: { taskId: '${TASK_NAME}', taskName: 'old-selected-name', outVars: '' },
  }
  const context = loadEvaltokensRuntime({
    timer: null,
    running: true,
    curRun: { token: 'run-token', vars: { TASK_NAME: 'new-task-name' } },
    nodes: {},
    selectedId: '',
    evaltok: evaltokConfig,
    activeStages: () => [stage],
    substRunVars: value => value === '${TASK_NAME}' ? 'new-task-name' : value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url, options = {}) => {
      calls.push({ url, options })
      if (url.endsWith('/api/open/v1/tasks')) {
        return jsonResponse({ tasks: [{ task_id: 'task-resolved', name: 'new-task-name' }] })
      }
      if (url.endsWith('/api/open/v1/tasks/task-resolved/run')) {
        return jsonResponse({ run_id: 'run-resolved', task_id: 'task-resolved', status: 'running' })
      }
      if (url.includes('/api/open/v1/tasks/runs?task_id=task-resolved')) {
        return jsonResponse({ runs: [{ run_id: 'run-resolved', task_id: 'task-resolved', status: 'success' }] })
      }
      throw new Error(`unexpected request: ${url}`)
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: fn => { fn(); return 1 },
    applyStatusClasses: () => {},
    renderFlow: () => {},
    renderDetail: () => {},
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: index => { advancedTo = index },
    finish: status => { throw new Error(`unexpected finish: ${status}`) },
  })

  await context.runEvaltokensStep(0)

  assert.equal(calls[0].options.method, 'GET')
  assert.match(calls[1].url, /\/tasks\/task-resolved\/run$/)
  assert.equal(context.nodes['eval-by-name'].status, 'success')
  assert.equal(advancedTo, 1)
})

test('阶段超时会中断卡住的 EvalTokens 请求', async () => {
  let requestAborted = false
  let finishedAs = null
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const stage = {
    id: 'eval-timeout',
    name: '超时任务',
    timeout: 0.01,
    evaltokens: { taskId: 'task-timeout', taskName: 'timeout-task', outVars: '' },
  }
  const context = loadEvaltokensRuntime({
    timer: null,
    running: true,
    curRun: { token: 'run-token', vars: {} },
    nodes: {},
    selectedId: '',
    evaltok: evaltokConfig,
    activeStages: () => [stage],
    substRunVars: value => value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url, options = {}) => {
      if (url.endsWith('/api/open/v1/tasks')) {
        return jsonResponse({ tasks: [{ task_id: 'task-timeout', name: 'timeout-task' }] })
      }
      return await new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          requestAborted = true
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
    setInterval: () => 1,
    clearInterval: () => {},
    applyStatusClasses: () => {},
    renderFlow: () => {},
    renderDetail: () => {},
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: () => {},
    finish: status => { finishedAs = status },
  })

  const completed = await Promise.race([
    context.runEvaltokensStep(0).then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 200)),
  ])

  assert.equal(completed, true, '卡住的请求必须在阶段超时后返回')
  assert.equal(requestAborted, true)
  assert.equal(context.nodes['eval-timeout'].status, 'failed')
  assert.equal(finishedAs, 'failed')
  assert.match(stage._out.stderr, /等待超时/)
})

test('用户中止会取消正在等待的 EvalTokens 请求且不覆盖中止状态', async () => {
  let requestAborted = false
  let finishCalls = 0
  let markRequestStarted
  const requestStarted = new Promise(resolve => { markRequestStarted = resolve })
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const stage = {
    id: 'eval-abort',
    name: '可中止任务',
    timeout: null,
    evaltokens: { taskId: 'task-abort', taskName: 'abort-task', outVars: '' },
  }
  const context = loadEvaltokensRuntime({
    timer: null,
    running: true,
    curRun: { token: 'run-token', vars: {} },
    nodes: {},
    selectedId: '',
    evaltok: evaltokConfig,
    activeStages: () => [stage],
    substRunVars: value => value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url, options = {}) => {
      if (url.endsWith('/api/open/v1/tasks')) {
        return jsonResponse({ tasks: [{ task_id: 'task-abort', name: 'abort-task' }] })
      }
      markRequestStarted()
      return await new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          requestAborted = true
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
    setInterval: () => 1,
    clearInterval: () => {},
    applyStatusClasses: () => {},
    renderFlow: () => {},
    renderDetail: () => {},
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: () => {},
    finish: () => { finishCalls += 1 },
  })

  const pending = context.runEvaltokensStep(0)
  await requestStarted
  assert.ok(context.curRun.scriptAbort, '运行中请求应注册 AbortController')
  context.running = false
  context.curRun.scriptAbort.abort()
  await pending

  assert.equal(requestAborted, true)
  assert.equal(finishCalls, 0)
})
