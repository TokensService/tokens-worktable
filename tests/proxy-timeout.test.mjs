import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function loadTimeout() {
  const start = source.indexOf('function serverProxyTimeoutMs(')
  const end = source.indexOf('function registerWorktableProxyRoute(', start)
  assert.ok(start >= 0 && end > start, 'serverProxyTimeoutMs helper not found')
  const ctx = { Number, Math }
  vm.createContext(ctx)
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' }), ctx)
  return ctx.serverProxyTimeoutMs
}

test('代理上游超时缺省 20s', () => {
  const f = loadTimeout()
  for (const v of [undefined, null, '', 'abc', 0, -5, NaN]) assert.equal(f(v), 20_000)
})

test('代理上游超时按请求 timeoutMs 生效，夹取 1s~24h', () => {
  const f = loadTimeout()
  assert.equal(f(500), 1_000)           // 下限夹取
  assert.equal(f(45_000), 45_000)       // 区间内原样
  assert.equal(f('45000'), 45_000)      // 数字字符串同效
  assert.equal(f(3_600_000), 3_600_000)
  assert.equal(f(86_400_000), 86_400_000)
  assert.equal(f(999_999_999), 86_400_000) // 上限夹取
})
