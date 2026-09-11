import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function loadCollector() {
  const start = source.indexOf('function collectProxyResponse(')
  const end = source.indexOf('async function readJsonBody(', start)
  assert.ok(start >= 0 && end > start, 'collectProxyResponse helper not found')
  const ctx = { Buffer, Number, Error, Promise }
  vm.createContext(ctx)
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' }), ctx)
  return ctx.collectProxyResponse
}

function response(headers = {}) {
  const stream = new EventEmitter()
  stream.headers = headers
  stream.destroyedByLimit = false
  stream.destroy = error => { stream.destroyedByLimit = true; if (error) queueMicrotask(() => stream.emit('error', error)) }
  return stream
}

test('代理响应声明长度超限时在读取正文前销毁上游', async () => {
  const collect = loadCollector()
  const upstream = response({ 'content-length': '11' })
  await assert.rejects(collect(upstream, 10), /response too large/)
  assert.equal(upstream.destroyedByLimit, true)
})

test('代理 chunked 响应在累计块越界时立即销毁上游', async () => {
  const collect = loadCollector()
  const upstream = response({})
  const pending = collect(upstream, 10)
  upstream.emit('data', Buffer.from('123456'))
  upstream.emit('data', Buffer.from('78901'))
  await assert.rejects(pending, /response too large/)
  assert.equal(upstream.destroyedByLimit, true)
})

test('代理上限内响应保持原始字节顺序', async () => {
  const collect = loadCollector()
  const upstream = response({})
  const pending = collect(upstream, 10)
  upstream.emit('data', Buffer.from('1234'))
  upstream.emit('data', Buffer.from('5678'))
  upstream.emit('end')
  assert.equal((await pending).toString('utf8'), '12345678')
  assert.equal(upstream.destroyedByLimit, false)
})
