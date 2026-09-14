import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))

function loadQueueRoute() {
  const start = source.indexOf('  /* 运行队列跨浏览器可见：')
  const end = source.indexOf('  // AI 日志分析：', start)
  assert.ok(start >= 0 && end > start, '运行队列在场路由未找到')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  let handler
  const context = {
    webServer: { register(route) { handler = route.handler } },
    readJsonBody: async req => req.body || {},
    json(res, status, body) { res.writeHead(status); res.end(JSON.stringify(body)) },
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

async function call(handler, method, body) {
  const res = response()
  await handler({ method, body }, res)
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
