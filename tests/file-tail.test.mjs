import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, open as fsOpen, readFile, rm, stat as fsStat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve as pathResolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import { createReadStream } from 'node:fs'
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
    createReadStream, fsStat,
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

test('raw=1 流式返回原始字节并绕过全量读 256MB 上限（不经过 readLocalFile）', async t => {
  const dir = await mkdtemp(tmpdir() + '/file-raw-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = dir + '/big-trace.raw.json'
  const content = '{"traceEvents":[' + '"ph":"X"'.repeat(4096) + ']}'
  await writeFile(path, content)
  /* raw 分支若仍走 readLocalFile（256MB 上限所在），这个桩会直接 413 失败 */
  const throwingReader = async () => { const e = new Error('file too large'); e.statusCode = 413; throw e }
  const handler = loadFileRoute(throwingReader)
  const sink = new PassThrough()
  const chunks = []
  sink.on('data', c => chunks.push(c))
  let status = 0, headers = {}
  sink.writeHead = (s, h) => { status = s; headers = h }
  await handler({ url: '/api/worktable/file?path=' + encodeURIComponent(path) + '&raw=1' }, sink)
  await finished(sink)
  assert.equal(status, 200)
  assert.equal(headers['content-type'], 'application/octet-stream')
  assert.equal(headers['content-length'], String(Buffer.byteLength(content)))
  assert.equal(headers['x-worktable-file-size'], String(Buffer.byteLength(content)))
  assert.equal(headers['x-worktable-file-truncated'], 'none')
  assert.equal(Buffer.concat(chunks).toString(), content, '流式输出内容与磁盘一致')
})

test('raw=1 对目录路径返回 404 而不是流出目录内容', async t => {
  const dir = await mkdtemp(tmpdir() + '/file-raw-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const handler = loadFileRoute(loadReader())
  const result = { status: 0, data: Buffer.alloc(0) }
  await handler({ url: '/api/worktable/file?path=' + encodeURIComponent(dir) + '&raw=1' }, {
    writeHead(status) { result.status = status },
    end(data) { result.data = Buffer.from(data || '') },
  })
  assert.equal(result.status, 404)
  assert.match(result.data.toString(), /not a file/)
})
