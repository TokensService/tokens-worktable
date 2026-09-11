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
  const input = [{ no: 1, tag: 't1', logs: [{ logFile: '/logs/a.log' }], _lc: { a: 'large log' }, _lm: { a: { size: 9 } }, _ll: {}, _profChecked: true }]
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
