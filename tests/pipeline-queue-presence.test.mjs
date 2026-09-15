import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))

function loadQueueRoute(overrides = {}) {
  const start = source.indexOf('  /* 服务端权威执行池的状态由本路由 GET 实时下发；')
  const end = source.indexOf('  /* 节点占用租约（跨标签页/跨浏览器/API/定时统一的节点互斥', start)
  assert.ok(start >= 0 && end > start, '运行队列在场路由未找到')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  let handler
  const context = {
    URL,
    webServer: { register(route) { handler = route.handler } },
    readJsonBody: async req => req.body || {},
    json(res, status, body) { res.writeHead(status); res.end(JSON.stringify(body)) },
    pipelineExecutions: overrides.pipelineExecutions || { snapshot: () => ({ runs: [], queue: [] }), cancel: () => ({ ok: false, state: 'missing' }) },
    console,
  }
  vm.createContext(context)
  vm.runInContext(code, context)
  return handler
}

function response() {
  return {
    status: 0, body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body == null ? '' : String(body) },
    json() { return this.body ? JSON.parse(this.body) : null },
  }
}

async function call(handler, method, body, url = '/api/worktable/pipeline/queue') {
  const res = response()
  await handler({ method, body, url }, res)
  return res
}

test('队列在场接口仅转发可展示的阶段状态，过滤日志、变量和脚本参数', async () => {
  const handler = loadQueueRoute()
  const stage = {
    id: 'build', name: '构建', kind: 'shell', parallel: true, sub: ['编译'],
    script: { path: 'build.sh', values: { TOKEN: 'secret' } },
    _out: { stdout: 'secret log' },
  }
  const node = {
    status: 'running', progress: 37, dur: 6.5, sub: { 编译: 'success' },
    varsIn: { TOKEN: 'secret' }, varsOut: { RESULT: 'secret' },
  }
  const put = await call(handler, 'PUT', {
    id: 'client-1', label: 'Chrome·abcd', schemaVersion: 2,
    running: null,
    runs: [{
      id: 'run-1', originQueueId: 'queue-origin', pipelineId: 'pipe-1', pipelineName: '发布', by: 'alice', env: '10.0.0.1',
      repoName: 'app', branch: 'dev', strategy: 'rolling', source: 'manual', startedAt: 100,
      stages: [stage], nodes: { build: node },
    }],
    queue: [{
      id: 'queue-1', pipelineId: 'pipe-1', pipelineName: '发布', by: 'bob', env: '10.0.0.2',
      repoName: 'app', branch: 'main', strategy: '', source: 'manual', queuedAt: 200,
      stages: [{ id: 'deploy', name: '部署', skip: true }], nodes: { deploy: { status: 'idle', progress: 0, dur: 0 } },
    }],
  })
  assert.equal(put.status, 200)

  const get = await call(handler, 'GET')
  assert.equal(get.status, 200)
  const client = get.json().clients[0]
  assert.equal(client.schemaVersion, 2)
  assert.deepEqual(plain(client.runs[0]), {
    id: 'run-1', originQueueId: 'queue-origin', pipelineId: 'pipe-1', pipelineName: '发布', by: 'alice', env: '10.0.0.1',
    repoName: 'app', branch: 'dev', strategy: 'rolling', source: 'manual', startedAt: 100,
    stages: [{ id: 'build', name: '构建', parallel: true, sub: ['编译'] }],
    nodes: { build: { status: 'running', progress: 37, dur: 6.5, sub: { 编译: 'success' } } },
  })
  assert.deepEqual(plain(client.queue[0]), {
    id: 'queue-1', pipelineId: 'pipe-1', pipelineName: '发布', by: 'bob', env: '10.0.0.2',
    repoName: 'app', branch: 'main', strategy: '', source: 'manual', queuedAt: 200,
    stages: [{ id: 'deploy', name: '部署', skip: true }],
    nodes: { deploy: { status: 'idle', progress: 0, dur: 0 } },
  })
  assert.equal(JSON.stringify(client).includes('secret'), false)
  assert.equal(JSON.stringify(client).includes('build.sh'), false)
})

test('队列接口返回服务端权威状态，页面离场清理只影响旧在场快照且可取消服务端任务', async () => {
  const cancelled = []
  const serverState = {
    runs: [{
      id: 'run-server', pipelineId: 'pipe-1', pipelineName: '发布', by: 'alice', env: '10.0.0.1', repoName: 'app',
      branch: 'dev', strategy: 'rolling', source: 'manual', startedAt: 100,
      stages: [{ id: 'build', name: '构建', script: { values: { TOKEN: 'secret' } } }],
      nodes: { build: { status: 'running', progress: 25, dur: 3, varsIn: { TOKEN: 'secret' } } },
    }],
    queue: [{
      id: 'queue-server', pipelineId: 'pipe-2', pipelineName: '测试', by: 'bob', env: '10.0.0.2', repoName: 'test',
      branch: 'main', strategy: '', source: 'manual', queuedAt: 200,
      stages: [{ id: 'test', name: '测试' }], nodes: { test: { status: 'idle', progress: 0, dur: 0 } },
    }],
  }
  const handler = loadQueueRoute({
    pipelineExecutions: {
      snapshot: () => serverState,
      cancel: id => { cancelled.push(id); return id === 'run-server' ? { ok: true, state: 'running' } : { ok: false, state: 'missing' } },
    },
  })

  await call(handler, 'PUT', { id: 'legacy-client', label: 'Chrome', running: null, queue: [] })
  const beforeLeave = await call(handler, 'GET')
  assert.deepEqual(plain(beforeLeave.json().server), {
    id: 'server', label: '服务端', schemaVersion: 3,
    runs: [{
      id: 'run-server', pipelineId: 'pipe-1', pipelineName: '发布', by: 'alice', env: '10.0.0.1', repoName: 'app',
      branch: 'dev', strategy: 'rolling', source: 'manual', startedAt: 100,
      stages: [{ id: 'build', name: '构建' }], nodes: { build: { status: 'running', progress: 25, dur: 3 } },
    }],
    queue: [{
      id: 'queue-server', pipelineId: 'pipe-2', pipelineName: '测试', by: 'bob', env: '10.0.0.2', repoName: 'test',
      branch: 'main', strategy: '', source: 'manual', queuedAt: 200,
      stages: [{ id: 'test', name: '测试' }], nodes: { test: { status: 'idle', progress: 0, dur: 0 } },
    }],
  })
  assert.equal(JSON.stringify(beforeLeave.json().server).includes('secret'), false)

  await call(handler, 'POST', { id: 'legacy-client', running: null, queue: [] })
  const afterLeave = await call(handler, 'GET')
  assert.deepEqual(plain(afterLeave.json().server), plain(beforeLeave.json().server), '页面离场不得删除服务端运行或队列')

  const cancel = await call(handler, 'POST', { action: 'cancel', runId: 'run-server' })
  assert.equal(cancel.status, 200)
  assert.deepEqual(cancel.json(), { ok: true, state: 'running' })
  assert.deepEqual(cancelled, ['run-server'])

  const missing = await call(handler, 'POST', { action: 'cancel', runId: 'missing' })
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.json(), { ok: false, state: 'missing' })
})

test('队列接口按运行和阶段返回实时日志，不把日志混入普通队列快照', async () => {
  const calls = []
  const handler = loadQueueRoute({
    pipelineExecutions: {
      snapshot: () => ({ runs: [{ id: 'run-1', stages: [], nodes: {} }], queue: [] }),
      cancel: () => ({ ok: false, state: 'missing' }),
      log: (runId, stageId) => {
        calls.push([runId, stageId])
        return runId === 'run-1' && stageId === 'build'
          ? { text: 'first\nlatest\n', truncated: false, revision: 2 }
          : null
      },
    },
  })

  const found = await call(handler, 'GET', undefined, '/api/worktable/pipeline/queue?runId=run-1&stageId=build')
  assert.equal(found.status, 200)
  assert.deepEqual(found.json(), { text: 'first\nlatest\n', truncated: false, revision: 2 })
  assert.deepEqual(calls, [['run-1', 'build']])

  const missing = await call(handler, 'GET', undefined, '/api/worktable/pipeline/queue?runId=run-1&stageId=missing')
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.json(), { error: 'run or stage not found' })

  const snapshot = await call(handler, 'GET')
  assert.equal(JSON.stringify(snapshot.json()).includes('latest'), false)
})
