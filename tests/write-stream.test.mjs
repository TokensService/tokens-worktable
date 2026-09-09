import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, open as fsOpen, readFile, rename as fsRename, rm, unlink as fsUnlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve as pathResolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const start = source.indexOf('  // 大文件流式写入（流水线归档）')
const end = source.indexOf('  // 新建分组', start)
assert.ok(start >= 0 && end > start, 'write-stream route not found')
const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })

test('流式写入接口按分块完整落盘，不经 JSON 整体缓冲', async t => {
  const dir = await mkdtemp(tmpdir() + '/worktable-write-stream-')
  const target = pathResolve(dir, 'large.log')
  const routes = new Map()
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
  vm.runInNewContext(code, {
    webServer: { register: route => routes.set(route.path, route.handler) },
    fsOpen, fsRename, fsUnlink, dirname, pathResolve, process, Buffer, URL, Date, Math, json,
  })
  const server = createServer((req, res) => routes.get('/api/worktable/write-stream')(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })

  const chunks = ['header\n', 'x'.repeat(2 * 1024 * 1024), '\n尾声\n']
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/worktable/write-stream?path=${encodeURIComponent(target)}`,
    { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: new Blob(chunks) },
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(await readFile(target, 'utf8'), chunks.join(''))
  const leftovers = (await import('node:fs/promises')).readdir(dir)
  assert.deepEqual(await leftovers, ['large.log'], '原子替换后不应遗留临时文件')
})
