import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve as pathResolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const serverSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function slice(source, begin, end, ctx = {}) {
  const start = source.indexOf(begin)
  const stop = source.indexOf(end, start)
  assert.ok(start >= 0 && stop > start, `helpers not found: ${begin}`)
  const code = stripTypeScriptTypes(source.slice(start, stop), { mode: 'transform' })
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return ctx
}
const loadClientHelpers = () => slice(clientSource, '/* ---------- 版本更新历史 ---------- */', '/* ---------- 版本更新历史结束 ---------- */')
const loadServerHelpers = () => slice(serverSource, '/* ---------- 版本安装历史（本服务器装过哪些版本） ---------- */', '/* ---------- 版本安装历史结束 ---------- */')

/** vm 切片内创建的对象属 vm realm（原型与宿主不同），deepEqual 前转回宿主域 */
const plain = (x) => JSON.parse(JSON.stringify(x))

// ---- 客户端 parseInstallHistory ----

test('解析安装历史：按时间倒序，最新一条标记当前版本，时间本地格式化', () => {
  const { parseInstallHistory } = loadClientHelpers()
  const list = parseInstallHistory({
    version: '1.1.7',
    history: [
      { version: '1.1.5', at: 1789600000000 },
      { version: '1.1.7', at: 1789800000000 },
      { version: '1.1.6', at: 1789700000000 },
    ],
  })
  assert.deepEqual(plain(list.map((e) => e.version)), ['1.1.7', '1.1.6', '1.1.5'])
  assert.deepEqual(plain(list.map((e) => e.current)), [true, false, false], '仅最新一条为当前版本')
  for (const e of list) assert.match(e.when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'when 应为本地 YYYY-MM-DD HH:mm')
})

test('接受裸数组与 {history} 两种载荷；缺字段 / 类型错误项被剔除；版本号裁剪空白', () => {
  const { parseInstallHistory } = loadClientHelpers()
  const bare = parseInstallHistory([{ version: ' 1.1.7 ', at: 1789800000000 }])
  assert.equal(bare[0].version, '1.1.7')
  const mixed = parseInstallHistory({ history: [
    { version: '1.1.7', at: 1789800000000 },
    { version: '', at: 1789800000001 }, // 空版本
    { version: '1.1.6' }, // 缺 at
    { version: '1.1.5', at: 'yesterday' }, // at 非数值
    { version: '1.1.4', at: Number.NaN }, // at 非有限
    null,
    42,
  ] })
  assert.deepEqual(plain(mixed.map((e) => e.version)), ['1.1.7'])
})

test('入参异常（404 兜底页 / null / 对象缺 history）：返回空表', () => {
  const { parseInstallHistory } = loadClientHelpers()
  for (const bad of [null, undefined, {}, '<html>…</html>', 42, { history: 'nope' }]) {
    assert.deepEqual(plain(parseInstallHistory(bad)), [], JSON.stringify(bad))
  }
})

test('最多展示 100 条（最新的优先）', () => {
  const { parseInstallHistory } = loadClientHelpers()
  const data = Array.from({ length: 130 }, (_, i) => ({ version: '1.1.' + i, at: 1789600000000 + i }))
  const list = parseInstallHistory(data)
  assert.equal(list.length, 100)
  assert.equal(list[0].version, '1.1.129')
  assert.equal(list[99].version, '1.1.30')
})

// ---- 服务端 sanitizeVersionHistory / recordVersionInstall ----

test('服务端清洗：接受裸数组与 {history}，剔除缺字段项，按 at 升序', () => {
  const { sanitizeVersionHistory } = loadServerHelpers()
  const out = sanitizeVersionHistory({ history: [
    { version: '1.1.7', at: 1789800000000 },
    { version: ' 1.1.5 ', at: 1789600000000 },
    { version: 'bad' }, // 缺 at
    { at: 1789700000000 }, // 缺 version
    'junk',
  ] })
  assert.deepEqual(plain(out), [
    { version: '1.1.5', at: 1789600000000 },
    { version: '1.1.7', at: 1789800000000 },
  ])
  assert.deepEqual(plain(sanitizeVersionHistory('not json')), [])
})

test('启动记录：版本与末条不同才追加（新装 / 升级 / 回退），相同返回 null', () => {
  const { recordVersionInstall, sanitizeVersionHistory } = loadServerHelpers()
  const base = sanitizeVersionHistory([{ version: '1.1.6', at: 1789700000000 }])
  assert.equal(recordVersionInstall(base, '1.1.6', 1789800000000), null, '同版本重启不重复记录')
  const upgraded = recordVersionInstall(base, '1.1.7', 1789800000000)
  assert.deepEqual(plain(upgraded), [
    { version: '1.1.6', at: 1789700000000 },
    { version: '1.1.7', at: 1789800000000 },
  ])
  const rollback = recordVersionInstall(upgraded, '1.1.6', 1789900000000)
  assert.equal(rollback.length, 3, '回退也记一条（历史是安装轨迹，非版本去重）')
  assert.equal(rollback[2].version, '1.1.6')
  assert.equal(recordVersionInstall(base, 'dev', 1789800000000), null, '非语义化版本（dev 构建）不记录')
  const first = recordVersionInstall([], '1.1.7', 1789800000000)
  assert.deepEqual(plain(first), [{ version: '1.1.7', at: 1789800000000 }], '首次启动建立首条记录')
})

test('历史上限：清洗与追加均截尾保留最近 200 条', () => {
  const { recordVersionInstall, sanitizeVersionHistory } = loadServerHelpers()
  const data = Array.from({ length: 210 }, (_, i) => ({ version: '1.0.' + i, at: 1789600000000 + i }))
  const cleaned = sanitizeVersionHistory(data)
  assert.equal(cleaned.length, 200)
  assert.equal(cleaned[0].version, '1.0.10')
  const appended = recordVersionInstall(cleaned, '1.1.0', 1789900000000)
  assert.equal(appended.length, 200)
  assert.equal(appended[199].version, '1.1.0')
  assert.equal(appended[0].version, '1.0.11', '追加后再截尾')
})

// ---- 服务端路由集成（切片 apply 内的路由块，真实落盘到临时 DSH_HOME） ----

function loadVersionHistoryRoute(home, pluginVersion) {
  const helpersStart = serverSource.indexOf('/* ---------- 版本安装历史（本服务器装过哪些版本） ---------- */')
  const helpersEnd = serverSource.indexOf('/* ---------- 版本安装历史结束 ---------- */', helpersStart)
  const blockStart = serverSource.indexOf('  // 版本安装历史（本服务器装过哪些版本）')
  const blockEnd = serverSource.indexOf('  // 本地文件读取', blockStart)
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart && blockStart >= 0 && blockEnd > blockStart, '版本安装历史路由块未找到')
  const code = stripTypeScriptTypes(serverSource.slice(helpersStart, helpersEnd) + '\n' + serverSource.slice(blockStart, blockEnd), { mode: 'transform' })
  const handlers = {}
  const ctx = {
    PLUGIN_VERSION: pluginVersion,
    DSH_HOME: home,
    pathResolve, readFile,
    ctx: { logger: { warn() {} } },
    writeJsonAtomic: async (file, text) => {
      const fsx = await import('node:fs/promises')
      await fsx.mkdir(pathResolve(file, '..'), { recursive: true })
      const tmp = file + '.tmp'
      await fsx.writeFile(tmp, text, 'utf8')
      await fsx.rename(tmp, file)
    },
    webServer: { register(route) { handlers[route.path] = route.handler } },
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) },
    Date,
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  assert.ok(handlers['/api/worktable/version-history'], '缺少 version-history 路由')
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

async function waitForFile(file) {
  for (let i = 0; i < 50; i++) {
    try { return await readFile(file, 'utf8') } catch { await new Promise((r) => setTimeout(r, 20)) }
  }
  throw new Error('version history file not written: ' + file)
}

async function waitForFileChange(file, prevContent) {
  for (let i = 0; i < 50; i++) {
    try {
      const c = await readFile(file, 'utf8')
      if (c !== prevContent) return c
    } catch { /* 读取失败继续等 */ }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('version history file not updated: ' + file)
}

test('路由集成：首次启动落盘当前版本；再次启动同版本不重复记录，升级后追加', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const home = await mkdtemp(tmpdir() + '/wt-verhist-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const file = pathResolve(home, 'storages', 'worktable-version-history.json')

  // 首次启动（1.1.6）：落盘首条记录；GET 返回该记录
  let h = loadVersionHistoryRoute(home, '1.1.6')
  const first = JSON.parse(await waitForFile(file))
  assert.equal(first.history.length, 1)
  assert.equal(first.history[0].version, '1.1.6')
  assert.ok(Number.isFinite(first.history[0].at))
  let res = mockRes()
  await h['/api/worktable/version-history']({ method: 'GET', url: '/api/worktable/version-history' }, res)
  assert.equal(res.status, 200)
  assert.equal(res.json().version, '1.1.6')
  assert.equal(res.json().history.length, 1)

  // 同版本重启：文件不变（末条 at 不回写）
  const before = await readFile(file, 'utf8')
  h = loadVersionHistoryRoute(home, '1.1.6')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(await readFile(file, 'utf8'), before, '同版本重启不产生新记录')

  // 升级到 1.1.7：追加一条；GET 按时间升序返回两条
  h = loadVersionHistoryRoute(home, '1.1.7')
  const upgraded = JSON.parse(await waitForFileChange(file, before))
  assert.deepEqual(upgraded.history.map((e) => e.version), ['1.1.6', '1.1.7'])
  res = mockRes()
  await h['/api/worktable/version-history']({ method: 'GET', url: '/api/worktable/version-history' }, res)
  assert.deepEqual(res.json().history.map((e) => e.version), ['1.1.6', '1.1.7'])

  // 非 GET 方法 405
  res = mockRes()
  await h['/api/worktable/version-history']({ method: 'POST', url: '/api/worktable/version-history' }, res)
  assert.equal(res.status, 405)
})

test('源码契约：服务端注册安装历史路由并落盘，客户端走同源接口，locales 中英键齐全', async () => {  assert.ok(serverSource.includes("path: '/api/worktable/version-history'"), '服务端应注册安装历史路由')
  assert.ok(serverSource.includes("pathResolve(DSH_HOME, 'storages', 'worktable-version-history.json')"), '历史应落盘 storages')
  assert.ok(serverSource.includes('recordVersionInstall(base, PLUGIN_VERSION, Date.now())'), '启动与查询均应经 recordVersionInstall')
  assert.ok(clientSource.includes("fetch('/api/worktable/version-history'"), '客户端应请求同源安装历史接口')
  assert.ok(!clientSource.includes('api.github.com/repos/' + 'TokensService/tokens-worktable/releases?per_page'), '不应再拉 GitHub releases 列表')
  assert.ok(clientSource.includes("t('history.btn')"), '版本行应有「更新历史」入口按钮')
  assert.ok(clientSource.includes('parseInstallHistory(d)'), '拉取结果应经 parseInstallHistory 解析')
  const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  const zhBlock = locales.slice(0, locales.indexOf('export const en'))
  const enBlock = locales.slice(locales.indexOf('export const en'))
  for (const key of ['history.btn', 'history.title', 'history.loading', 'history.failed', 'history.retry', 'history.refresh', 'history.close', 'history.empty', 'history.current', 'history.hint']) {
    assert.ok(zhBlock.includes("'" + key + "'"), 'zh 缺 ' + key)
    assert.ok(enBlock.includes("'" + key + "'"), 'en 缺 ' + key)
  }
})
