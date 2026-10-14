import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as pathResolve } from 'node:path'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { stat as fsStat, rename as fsRename, unlink as fsUnlink } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

/* 整段抽取 /api/worktable/copy 路由（从注释标记到本路由 register 调用收尾） */
function loadCopyRoute() {
  const start = source.indexOf('  // 服务端文件复制')
  const end = source.indexOf('\n  })', start)
  assert.ok(start >= 0 && end > start, 'copy route not found')
  const code = stripTypeScriptTypes(source.slice(start, end + '\n  })'.length), { mode: 'transform' })
  let handler
  const ctx = {
    URL, pathResolve, fsStat, createReadStream, createWriteStream, streamPipeline, fsRename, fsUnlink,
    process,
    readJsonBody: async (req) => req.body || {},
    webServer: { register(route) { handler = route.handler } },
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(Buffer.from(JSON.stringify(body))) },
  }
  vm.createContext(ctx); vm.runInContext(code, ctx)
  return handler
}
function fakeRes() {
  const r = { status: 0, body: null, writeHead(s) { r.status = s }, end(d) { r.body = d ? JSON.parse(d.toString()) : null } }
  return r
}

test('copy 路由：流式复制文件并原子落盘', async t => {
  const dir = await mkdtemp(tmpdir() + '/copy-route-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const src = dir + '/a.pt.trace.json'
  const content = '{"traceEvents":[' + '"ph":"X",'.repeat(10000) + ']}'
  await writeFile(src, content)
  const dst = dir + '/sub/b.pt.trace.json'
  await import('node:fs/promises').then(m => m.mkdir(dir + '/sub'))
  const handler = loadCopyRoute()
  const res = fakeRes()
  await handler({ method: 'POST', body: { src, dst } }, res)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.size, Buffer.byteLength(content))
  assert.equal(await readFile(dst, 'utf8'), content, '内容与源一致')
  /* 临时文件已清理 */
  const leftovers = (await import('node:fs/promises').then(m => m.readdir(dir + '/sub'))).filter(f => f.includes('.worktable-copy-'))
  assert.deepEqual(leftovers, [])
})

test('copy 路由：参数缺失 400、src 与 dst 相同 400、源不存在/非文件 404 或 500', async t => {
  const dir = await mkdtemp(tmpdir() + '/copy-route-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const handler = loadCopyRoute()
  let res = fakeRes()
  await handler({ method: 'POST', body: { src: '', dst: 'x' } }, res)
  assert.equal(res.status, 400)
  res = fakeRes()
  await handler({ method: 'POST', body: { src: dir + '/a', dst: dir + '/a' } }, res)
  assert.equal(res.status, 400)
  res = fakeRes()
  await handler({ method: 'POST', body: { src: dir + '/not-exist', dst: dir + '/b' } }, res)
  assert.ok(res.status === 404 || res.status === 500, `源不存在应 404/500，实际 ${res.status}`)
  res = fakeRes()
  await handler({ method: 'POST', body: { src: dir, dst: dir + '/b' } }, res)
  assert.equal(res.status, 404, '目录作源应 404')
  res = fakeRes()
  await handler({ method: 'GET', body: {} }, res)
  assert.equal(res.status, 405)
})
