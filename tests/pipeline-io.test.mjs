import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat as fsStat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve as pathResolve, dirname } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

/* 从 src/index.ts 抽取「流水线导入导出：服务端备份」路由块（与 scan-projects 测试同一套切片手法），
   DSH_HOME 指向临时目录，writeJsonAtomic 用测试内的等价实现（tmp + rename） */
function loadIoRoutes(home) {
  const start = source.indexOf('  // ---- 流水线导入导出：服务端备份')
  const end = source.indexOf('  // ---- 流水线定时任务', start)
  assert.ok(start >= 0 && end > start, '服务端备份路由块未找到')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const handlers = {}
  const ctx = {
    DSH_HOME: home,
    pathResolve, readdir, fsStat, readFile,
    readJsonBody: async (req) => req.body ?? {},
    writeJsonAtomic: async (file, text) => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      await writeFile(tmp, text, 'utf8')
      await (await import('node:fs/promises')).rename(tmp, file)
    },
    webServer: { register(route) { handlers[route.path] = route.handler } },
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  assert.ok(handlers['/api/worktable/pipeline/io/list'], '缺少 io/list 路由')
  assert.ok(handlers['/api/worktable/pipeline/io/save'], '缺少 io/save 路由')
  assert.ok(handlers['/api/worktable/pipeline/io/load'], '缺少 io/load 路由')
  return handlers
}

function mockRes() {
  return {
    status: 0, body: '',
    writeHead(s) { this.status = s },
    end(s) { this.body = s == null ? '' : String(s) },
    json() { return this.body ? JSON.parse(this.body) : null },
  }
}

async function call(handler, req) {
  const res = mockRes()
  await handler(req, res)
  return res
}

const post = (body) => ({ method: 'POST', body })

test('save → list → load 往返：落盘到 storages/pipeline-exports/，列表带元数据，读回解析后的 JSON', async t => {
  const home = await mkdtemp(tmpdir() + '/pipeline-io-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const h = loadIoRoutes(home)
  const payload = { app: 'worktable-pipeline', kind: 'pipeline-settings', version: 1, config: { theme: 'dark' } }

  const save = await call(h['/api/worktable/pipeline/io/save'], post({ name: 'backup-a.json', payload }))
  assert.equal(save.status, 200)
  assert.equal(save.json().ok, true)
  assert.equal(save.json().name, 'backup-a.json')
  const expectPath = pathResolve(home, 'storages', 'pipeline-exports', 'backup-a.json')
  assert.equal(save.json().path, expectPath)
  const onDisk = JSON.parse(await readFile(expectPath, 'utf8'))
  assert.deepEqual(onDisk, payload, '落盘内容与 payload 一致')

  const list = await call(h['/api/worktable/pipeline/io/list'], { method: 'GET' })
  assert.equal(list.status, 200)
  assert.equal(list.json().dir, pathResolve(home, 'storages', 'pipeline-exports'))
  assert.equal(list.json().files.length, 1)
  assert.equal(list.json().files[0].name, 'backup-a.json')
  assert.ok(list.json().files[0].size > 0 && list.json().files[0].mtime > 0, '列表带 size 与 mtime')

  const load = await call(h['/api/worktable/pipeline/io/load'], post({ name: 'backup-a.json' }))
  assert.equal(load.status, 200)
  assert.deepEqual(load.json().data, payload, 'load 返回解析后的 JSON')
})

test('文件名白名单：路径分隔符 / .. / 前导点 / 非 .json / 超长一律 400，且不产生任何文件', async t => {
  const home = await mkdtemp(tmpdir() + '/pipeline-io-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const h = loadIoRoutes(home)
  const bad = ['../escape.json', 'a/b.json', 'a\\b.json', '.hidden.json', 'no-suffix', 'x.JSON.bak', 'x'.repeat(121) + '.json', '', null, 42]
  for (const name of bad) {
    const res = await call(h['/api/worktable/pipeline/io/save'], post({ name, payload: { ok: 1 } }))
    assert.equal(res.status, 400, `save 应拒绝文件名 ${JSON.stringify(name)}`)
    const res2 = await call(h['/api/worktable/pipeline/io/load'], post({ name }))
    assert.equal(res2.status, 400, `load 应拒绝文件名 ${JSON.stringify(name)}`)
  }
  assert.deepEqual(await readdir(home), [], '全部非法名字不得落盘（含目录穿越）')
  const load = await call(h['/api/worktable/pipeline/io/load'], post({ name: 'not-exist.json' }))
  assert.equal(load.status, 404, '文件不存在返回 404')
})

test('save：缺 payload / 非 POST 拒绝；list：目录不存在时返回空表', async t => {
  const home = await mkdtemp(tmpdir() + '/pipeline-io-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const h = loadIoRoutes(home)

  const missing = await call(h['/api/worktable/pipeline/io/save'], post({ name: 'a.json' }))
  assert.equal(missing.status, 400)
  const nullPayload = await call(h['/api/worktable/pipeline/io/save'], post({ name: 'a.json', payload: null }))
  assert.equal(nullPayload.status, 400)
  const wrongMethod = await call(h['/api/worktable/pipeline/io/save'], { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
  const wrongMethodLoad = await call(h['/api/worktable/pipeline/io/load'], { method: 'GET' })
  assert.equal(wrongMethodLoad.status, 405)

  const list = await call(h['/api/worktable/pipeline/io/list'], { method: 'GET' })
  assert.equal(list.status, 200)
  assert.deepEqual(list.json().files, [], '目录尚未创建时列表为空而非报错')
})

test('list：按 mtime 倒序，非法文件名不出现在列表', async t => {
  const home = await mkdtemp(tmpdir() + '/pipeline-io-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const dir = pathResolve(home, 'storages', 'pipeline-exports')
  await mkdir(dir, { recursive: true })
  await writeFile(pathResolve(dir, 'old.json'), '{}')
  await new Promise(r => setTimeout(r, 20))
  await writeFile(pathResolve(dir, 'new.json'), '{}')
  await writeFile(pathResolve(dir, 'note.txt'), '{}')   // 非 .json 不列出
  const h = loadIoRoutes(home)
  const list = await call(h['/api/worktable/pipeline/io/list'], { method: 'GET' })
  assert.deepEqual(list.json().files.map(f => f.name), ['new.json', 'old.json'])
})
