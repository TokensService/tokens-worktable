import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, open as fsOpen, readFile, readdir, rename as fsRename, rm, unlink as fsUnlink, writeFile } from 'node:fs/promises'
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

async function createHarness(t, overrides = {}) {
  const dir = await mkdtemp(tmpdir() + '/worktable-write-stream-')
  const routes = new Map()
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
  vm.runInNewContext(code, {
    webServer: { register: route => routes.set(route.path, route.handler) },
    fsOpen, fsRename: overrides.fsRename || fsRename, fsUnlink, dirname, pathResolve, process, Buffer, URL, Date, Math, json,
  })
  const server = createServer((req, res) => routes.get('/api/worktable/write-stream')(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })
  return { dir, port: server.address().port }
}

async function waitUntil(check, message) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

test('流式写入接口按分块完整落盘，不经 JSON 整体缓冲', async t => {
  const { dir, port } = await createHarness(t)
  const target = pathResolve(dir, 'large.log')

  const chunks = ['header\n', 'x'.repeat(2 * 1024 * 1024), '\n尾声\n']
  const response = await fetch(
    `http://127.0.0.1:${port}/api/worktable/write-stream?path=${encodeURIComponent(target)}`,
    { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: new Blob(chunks) },
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(await readFile(target, 'utf8'), chunks.join(''))
  assert.deepEqual(await readdir(dir), ['large.log'], '原子替换后不应遗留临时文件')
})

test('声明长度超限时在创建临时文件前返回 413', async t => {
  const { dir, port } = await createHarness(t)
  const target = pathResolve(dir, 'too-large.log')
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, method: 'POST',
      path: `/api/worktable/write-stream?path=${encodeURIComponent(target)}`,
      headers: { 'content-length': 256 * 1024 * 1024 + 1 },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 413)
  assert.deepEqual(await readdir(dir), [], '超限请求不得创建目标或临时文件')
})

test('客户端中途断开会删除部分临时文件并保留旧目标', async t => {
  const { dir, port } = await createHarness(t)
  const target = pathResolve(dir, 'atomic.log')
  await writeFile(target, 'old-content', 'utf8')
  const req = httpRequest({
    hostname: '127.0.0.1', port, method: 'POST',
    path: `/api/worktable/write-stream?path=${encodeURIComponent(target)}`,
    headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
  })
  req.on('error', () => {})
  req.write(Buffer.alloc(1024 * 1024, 0x78))
  await waitUntil(async () => (await readdir(dir)).some(name => name.endsWith('.tmp')), '未观察到流式写入临时文件')
  req.destroy(new Error('test abort'))
  await waitUntil(async () => !(await readdir(dir)).some(name => name.endsWith('.tmp')), '客户端断开后临时文件未清理')
  assert.equal(await readFile(target, 'utf8'), 'old-content')
})

test('原子替换失败会清理临时文件并返回 500', async t => {
  const { dir, port } = await createHarness(t, { fsRename: async () => { throw new Error('rename failed') } })
  const target = pathResolve(dir, 'rename-failed.log')
  const response = await fetch(
    `http://127.0.0.1:${port}/api/worktable/write-stream?path=${encodeURIComponent(target)}`,
    { method: 'POST', body: 'new-content' },
  )
  assert.equal(response.status, 500)
  assert.match((await response.json()).error, /rename failed/)
  assert.deepEqual(await readdir(dir), [], 'rename 失败后不得遗留目标或临时文件')
})
