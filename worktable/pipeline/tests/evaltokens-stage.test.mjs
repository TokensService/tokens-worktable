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
    ...overrides,
  })
  const names = [
    'evaltokHeaders',
    'evaltokRequestJson',
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

  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer api-token')
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json')
  assert.equal(calls[0].options.body, '{}')
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
