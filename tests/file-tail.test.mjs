import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, open as fsOpen, readFile, rm, stat as fsStat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve as pathResolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function loadReader() {
  const start = source.indexOf('async function readLocalFile(')
  const end = source.indexOf('/** git 状态快照', start)
  assert.ok(start >= 0 && end > start, 'readLocalFile helper not found')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const ctx = { readFile, fsOpen, fsStat, Buffer }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return ctx.readLocalFile
}

function loadFileRoute(readLocalFile) {
  const start = source.indexOf('  // 本地文件读取')
  const end = source.indexOf('  // 本地站点', start)
  assert.ok(start >= 0 && end > start, 'file route not found')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  let handler
  const ctx = {
    URL, pathResolve, readLocalFile, FILE_TYPES: { log: 'text/plain; charset=utf-8' },
    webServer: { register(route) { handler = route.handler } },
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(Buffer.from(JSON.stringify(body))) },
  }
  vm.createContext(ctx); vm.runInContext(code, ctx)
  return handler
}

test('尾部读取不返回大文件正文，并从完整行开始', async t => {
  const dir = await mkdtemp(tmpdir() + '/file-tail-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = dir + '/large.log'
  const content = 'first-line\n' + 'x'.repeat(128 * 1024) + '\nlast-one\nlast-two\n'
  await writeFile(path, content)
  const readLocalFile = loadReader()
  const result = await readLocalFile(path, '65536')
  assert.equal(result.size, Buffer.byteLength(content))
  assert.equal(result.truncated, true)
  assert.ok(result.data.length < Buffer.byteLength(content))
  assert.doesNotMatch(result.data.toString(), /first-line/)
  assert.equal(result.data.toString().startsWith('last-one\n'), true)
  assert.match(result.data.toString(), /last-two\n$/)
})

test('未请求尾部时保持完整文件读取兼容性', async t => {
  const dir = await mkdtemp(tmpdir() + '/file-tail-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = dir + '/small.txt'
  await writeFile(path, '完整内容\n')
  const result = await loadReader()(path, null)
  assert.equal(result.data.toString(), '完整内容\n')
  assert.equal(result.truncated, false)
})

test('尾部起点恰好位于行首时保留第一条完整行', async t => {
  const dir = await mkdtemp(tmpdir() + '/file-tail-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = dir + '/boundary.log'
  const tail = 'keep\n' + 'x'.repeat(1013) + '\nlast\n'
  assert.equal(Buffer.byteLength(tail), 1024)
  await writeFile(path, 'drop\n' + tail)
  const result = await loadReader()(path, '1024')
  assert.equal(result.data.toString(), tail)
})

test('文件路由透传尾读参数并返回截尾元数据响应头', async t => {
  const dir = await mkdtemp(tmpdir() + '/file-tail-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = dir + '/route.log'
  await writeFile(path, 'head\n' + 'x'.repeat(4096) + '\nlast\n')
  const handler = loadFileRoute(loadReader())
  const result = { status: 0, headers: {}, data: Buffer.alloc(0) }
  await handler({ url: '/api/worktable/file?path=' + encodeURIComponent(path) + '&tailBytes=1024' }, {
    writeHead(status, headers) { result.status = status; result.headers = headers },
    end(data) { result.data = Buffer.from(data) },
  })
  assert.equal(result.status, 200)
  assert.equal(result.headers['x-worktable-file-truncated'], 'tail')
  assert.equal(Number(result.headers['x-worktable-file-size']), (await fsStat(path)).size)
  assert.ok(result.data.length <= 1024)
  assert.match(result.data.toString(), /last\n$/)
})
