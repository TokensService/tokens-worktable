import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

test('服务端历史边界拒绝持久化页面回放缓存', () => {
  const start = source.indexOf('function cleanPipelineHistory(')
  const end = source.indexOf('/** git 状态快照', start)
  assert.ok(start >= 0 && end > start, 'cleanPipelineHistory helper not found')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const ctx = {}
  vm.createContext(ctx); vm.runInContext(code, ctx)
  const input = [{ no: 1, tag: 't1', logs: [{ logFile: '/logs/a.log' }], _lc: { a: 'large log' }, _lm: { a: { size: 9 } }, _ll: {}, _profChecked: true, _profState: { checked: true, stages: [] } }]
  const out = ctx.cleanPipelineHistory(input)
  assert.deepEqual(JSON.parse(JSON.stringify(out)), [{ no: 1, tag: 't1', logs: [{ logFile: '/logs/a.log' }] }])
  assert.ok(input[0]._lc, '清洗不得修改并发请求仍在使用的原对象')
})

test('历史大小裁剪逐条只序列化一次并保留最新前缀', () => {
  const start = source.indexOf('function cleanPipelineHistory(')
  const end = source.indexOf('/** git 状态快照', start)
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const ctx = {}
  vm.createContext(ctx); vm.runInContext(code, ctx)
  let calls = 0
  const history = Array.from({ length: 100 }, (_, index) => ({
    toJSON() { calls += 1; return { no: 100 - index, payload: 'x'.repeat(64 * 1024) } },
  }))
  const text = ctx.serializePipelineStore({ buildNo: 100 }, history, 1024 * 1024)
  const parsed = JSON.parse(text)
  assert.ok(parsed.history.length > 1 && parsed.history.length < history.length)
  assert.equal(parsed.history[0].no, 100)
  assert.equal(parsed.history.at(-1).no, 100 - parsed.history.length + 1)
  assert.ok(calls <= parsed.history.length + 1, `不得因逐条 pop 重复序列化已保留记录，调用次数 ${calls}`)
})

test('历史合并按最终清空时间同时过滤客户端和磁盘旧记录', () => {
  const start = source.indexOf('function cleanPipelineHistory(')
  const end = source.indexOf('/** git 状态快照', start)
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const ctx = {}
  vm.createContext(ctx); vm.runInContext(code, ctx)

  const merged = ctx.mergePipelineHistoryForWrite(
    { buildNo: 12, histClearedAt: 200 },
    { buildNo: 15, histClearedAt: 150 },
    [{ tag: 'stale-client', ts: 100 }, { tag: 'new-client', ts: 300 }],
    [{ tag: 'stale-disk', ts: 120 }, { tag: 'new-disk', ts: 250 }],
  )

  assert.equal(merged.config.buildNo, 15)
  assert.equal(merged.config.histClearedAt, 200)
  assert.deepEqual(Array.from(merged.history, record => record.tag), ['new-client', 'new-disk'])
})

test('轻量历史接口只返回版本字段和历史，ETag 未变化时不再读取存储正文', async () => {
  const start = source.indexOf('function cleanPipelineHistory(')
  const end = source.indexOf('/** git 状态快照', start)
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const ctx = {}
  vm.createContext(ctx); vm.runInContext(code, ctx)
  let reads = 0
  const deps = {
    statStore: async () => ({ ino: 11, size: 99, mtimeMs: 1234.5 }),
    readStore: async () => {
      reads += 1
      return { config: { buildNo: 8, histClearedAt: 200, pipelines: [{ secret: true }] }, history: [{ tag: 'run-8' }] }
    },
  }
  const response = () => ({
    status: 0, headers: {}, body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers },
    end(body) { this.body = body == null ? '' : String(body) },
  })

  const first = response()
  await ctx.handlePipelineHistoryRequest({ method: 'GET', headers: {} }, first, deps)
  assert.equal(first.status, 200)
  assert.equal(first.headers.etag, '"11-99-1234.5"')
  assert.deepEqual(JSON.parse(first.body), {
    config: { buildNo: 8, histClearedAt: 200 }, history: [{ tag: 'run-8' }],
  })
  assert.equal(reads, 1)

  const unchanged = response()
  await ctx.handlePipelineHistoryRequest({ method: 'GET', headers: { 'if-none-match': first.headers.etag } }, unchanged, deps)
  assert.equal(unchanged.status, 304)
  assert.equal(unchanged.body, '')
  assert.equal(reads, 1, '版本未变化时不得再次读取和解析完整 pipeline store')
})

test('轻量历史存储读取只把文件不存在视为空，读取与 JSON 错误向上传播', async () => {
  const start = source.indexOf('function cleanPipelineHistory(')
  const end = source.indexOf('/** git 状态快照', start)
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
  let mode = 'missing'
  const ctx = {
    readFile: async () => {
      if (mode === 'missing') throw missing
      if (mode === 'read-error') throw new Error('disk error')
      return '{broken json'
    },
  }
  vm.createContext(ctx); vm.runInContext(code, ctx)

  assert.deepEqual(JSON.parse(JSON.stringify(await ctx.readPipelineHistoryStore('/store.json'))), {})
  mode = 'read-error'
  await assert.rejects(ctx.readPipelineHistoryStore('/store.json'), /disk error/)
  mode = 'parse-error'
  await assert.rejects(ctx.readPipelineHistoryStore('/store.json'), error => error?.name === 'SyntaxError')
  assert.match(source, /readStore:\s*\(\)\s*=>\s*readPipelineHistoryStore\(PIPELINE_STORE\)/,
    '生产 history 路由必须注入严格读取函数')
})
