/* GET /api/worktable/session：回显调用方自己本次请求已携带的会话身份与令牌（供流水线页 API 弹窗把
   实际值填进 curl 示例）。只读回显，不签发新会话；无 auth 服务 / 无会话凭据时字段为空串。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
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

function loadSessionRoute({ auth } = {}) {
  const start = source.indexOf('/* ---------- 当前会话信息（API 调用方自服务） ---------- */')
  const end = source.indexOf('/* ---------- 当前会话信息结束 ---------- */', start)
  assert.ok(start >= 0 && end > start, '当前会话信息实现未找到')
  const pathMatch = source.match(/export const SESSION_API_PATH = '([^']+)'/)
  assert.ok(pathMatch, '缺少 SESSION_API_PATH 常量')
  const code = stripTypeScriptTypes([
    extractFunction('requestAuthToken'),
    source.slice(start, end),
  ].join('\n'), { mode: 'transform' })
  const handlers = {}
  const ctx = {
    Promise,
    SESSION_API_PATH: pathMatch[1],
    requestAuthToken: undefined, // 由抽取代码定义覆盖
    /* auth 为 undefined 模拟无 auth 服务（token 共享模式）；否则 { username, isAdmin } 由 stub 返回 */
    resolveRequestAuth: auth === undefined ? () => undefined : () => auth,
    json(res, status, body) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  ctx.registerSessionApi({ register(route) { handlers[route.path] = route } }, /* pluginCtx */ {})
  assert.ok(handlers[pathMatch[1]], '缺少会话信息路由')
  return { handler: handlers[pathMatch[1]].handler, route: handlers[pathMatch[1]], path: pathMatch[1] }
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

async function call(handler, { method = 'GET', headers = {} } = {}) {
  const res = response()
  await handler({ method, url: '/api/worktable/session', headers }, res)
  return res
}

test('路由注册为 exact 且路径固定', () => {
  const { route, path } = loadSessionRoute({ auth: { username: 'alice', isAdmin: true } })
  assert.equal(path, '/api/worktable/session')
  assert.equal(route.kind, 'exact')
})

test('Cookie 会话：回显请求自己携带的 dsh_auth 令牌与登录用户名', async () => {
  const { handler } = loadSessionRoute({ auth: { username: 'alice', isAdmin: false } })
  const res = await call(handler, { headers: { cookie: 'theme=dark; dsh_auth=tok-cookie-1' } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { username: 'alice', token: 'tok-cookie-1' })
  assert.equal(res.headers['cache-control'], 'no-store', '令牌响应不得缓存')
})

test('Bearer 会话：Authorization 头同样回显（守卫与页面身份解析均接受 Bearer）', async () => {
  const { handler } = loadSessionRoute({ auth: { username: 'bob', isAdmin: false } })
  const res = await call(handler, { headers: { authorization: 'Bearer tok-bearer-9' } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { username: 'bob', token: 'tok-bearer-9' })
})

test('无 auth 服务（token 共享模式）：username 空串，无凭据时 token 空串', async () => {
  const { handler } = loadSessionRoute({ auth: undefined })
  const res = await call(handler)
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { username: '', token: '' })
})

test('有 auth 服务但请求无会话凭据：token 空串（页面省略认证行）', async () => {
  const { handler } = loadSessionRoute({ auth: { username: '', isAdmin: false } })
  const res = await call(handler, { headers: { cookie: 'theme=dark' } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { username: '', token: '' })
})

test('非 GET 一律 405', async () => {
  const { handler } = loadSessionRoute({ auth: { username: 'alice', isAdmin: false } })
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await call(handler, { method, headers: { cookie: 'dsh_auth=tok-cookie-1' } })
    assert.equal(res.status, 405, method)
    assert.equal(res.body, '')
  }
})
