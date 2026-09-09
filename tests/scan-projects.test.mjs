import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve as pathResolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function loadScanRoute() {
  const start = source.indexOf('  // 一键导入的项目扫描')
  const gitRoute = source.indexOf("path: '/api/worktable/git',", start)
  assert.ok(start >= 0 && gitRoute > start, 'scan-projects route not found')
  const end = source.lastIndexOf('})', gitRoute) + 2
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  let handler
  const ctx = {
    readdir, readFile, pathResolve,
    readJsonBody: async (req) => req.body ?? {},
    webServer: { register(route) { handler = route.handler } },
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return handler
}

function mockReq(body) { return { method: 'POST', body } }
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

test('扫描文件夹：每个含 .html 的子目录一个项目，散装 .html 算单页项目', async t => {
  const dir = await mkdtemp(tmpdir() + '/scan-projects-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(dir + '/alpha')
  await writeFile(dir + '/alpha/index.html', '<html></html>')
  await writeFile(dir + '/alpha/other.html', '<html></html>')
  await mkdir(dir + '/beta')
  await writeFile(dir + '/beta/beta.html', '<html></html>')
  await mkdir(dir + '/gamma')
  await writeFile(dir + '/gamma/page.html', '<html></html>')
  await mkdir(dir + '/delta')
  await writeFile(dir + '/delta/z-last.html', '<html></html>')
  await writeFile(dir + '/delta/a-first.html', '<html></html>')
  await mkdir(dir + '/empty')
  await writeFile(dir + '/empty/readme.txt', 'no html here')
  await mkdir(dir + '/.hidden')
  await writeFile(dir + '/.hidden/index.html', '<html></html>')
  await writeFile(dir + '/loose.html', '<html></html>')

  const res = await call(loadScanRoute(), mockReq({ path: dir }))
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.path, pathResolve(dir))
  const names = body.projects.map(p => p.name)
  assert.deepEqual(names, ['alpha', 'beta', 'delta', 'gamma', 'loose'])
  const byName = Object.fromEntries(body.projects.map(p => [p.name, p]))
  assert.equal(byName.alpha.entry, 'index.html', 'index.html 优先')
  assert.equal(byName.beta.entry, 'beta.html', '与目录同名的 .html 优先于字母序')
  assert.equal(byName.gamma.entry, 'page.html', '唯一 .html 直接采用')
  assert.equal(byName.delta.entry, 'a-first.html', '无 index/同名时取字母序首个')
  assert.equal(byName.alpha.dir, pathResolve(dir, 'alpha'))
  assert.equal(byName.loose.dir, pathResolve(dir), '散装 .html 的项目目录 = 被扫描目录本身')
  assert.equal(byName.loose.entry, 'loose.html')
})

test('入口页 <meta name="worktable-icon"> 自声明图标随扫描结果返回', async t => {
  const dir = await mkdtemp(tmpdir() + '/scan-projects-icon-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(dir + '/rocket')
  await writeFile(dir + '/rocket/index.html', '<html><head><meta name="worktable-icon" content="🚀" /></head></html>')
  await mkdir(dir + '/ladybug')
  // 属性顺序反过来（content 在前）也要认得出
  await writeFile(dir + '/ladybug/ladybug.html', '<html><head><meta content="🐞" name="worktable-icon" /></head></html>')
  await mkdir(dir + '/plain')
  await writeFile(dir + '/plain/index.html', '<html><head><meta name="viewport" content="width=x" /></head></html>')

  const res = await call(loadScanRoute(), mockReq({ path: dir }))
  assert.equal(res.status, 200)
  const byName = Object.fromEntries(res.json().projects.map(p => [p.name, p]))
  assert.equal(byName.rocket.icon, '🚀')
  assert.equal(byName.ladybug.icon, '🐞')
  assert.equal('icon' in byName.plain, false, '未声明的项目不带 icon 字段')
})

test('入口页 <title> 作为项目自报名称随扫描结果返回', async t => {
  const dir = await mkdtemp(tmpdir() + '/scan-projects-title-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(dir + '/pipeline')
  await writeFile(dir + '/pipeline/pipeline.html', '<html><head>\n<title>  流水线\n工作台 </title>\n</head></html>')
  await mkdir(dir + '/plain')
  await writeFile(dir + '/plain/index.html', '<html><head></head></html>')

  const res = await call(loadScanRoute(), mockReq({ path: dir }))
  assert.equal(res.status, 200)
  const byName = Object.fromEntries(res.json().projects.map(p => [p.name, p]))
  assert.equal(byName.pipeline.title, '流水线 工作台', 'title 折叠空白后返回')
  assert.equal('title' in byName.plain, false, '无 <title> 的项目不带 title 字段')
})

test('缺少 path 返回 400，目录不存在返回 500', async () => {
  const handler = loadScanRoute()
  const bad = await call(handler, mockReq({}))
  assert.equal(bad.status, 400)
  const missing = await call(handler, mockReq({ path: tmpdir() + '/scan-projects-no-such-dir-xyz' }))
  assert.equal(missing.status, 500)
  assert.match(missing.json().error, /ENOENT/)
})

test('非 POST 方法返回 405', async () => {
  const res = mockRes()
  await loadScanRoute()({ method: 'GET' }, res)
  assert.equal(res.status, 405)
})
