import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const serverSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const clientSource = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

function slice(source, begin, end, ctx = {}) {
  const start = source.indexOf(begin)
  const stop = source.indexOf(end, start)
  assert.ok(start >= 0 && stop > start, `helpers not found: ${begin}`)
  const code = stripTypeScriptTypes(source.slice(start, stop), { mode: 'transform' })
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return ctx
}
const loadServerHelpers = () => slice(serverSource, '/* ---------- 用户使用统计 ---------- */', '/* ---------- 用户使用统计结束 ---------- */')
const loadClientHelpers = () => slice(clientSource, '/* ---------- 用户使用统计（上报 + 弹窗数据解析） ---------- */', '/* ---------- 用户使用统计结束 ---------- */')

/** vm 切片内创建的对象属 vm realm（原型与宿主不同），deepEqual 前转回宿主域 */
const plain = (x) => JSON.parse(JSON.stringify(x))

// 与服务端 ONLINE_TTL_MS 的约定值（const 声明不挂到 vm context，用源码文本断言锁定，见下）
const TTL = 90_000

// ---- 服务端 sanitizeHeartbeat ----

test('sanitizeHeartbeat：合法心跳通过，user/client 裁剪空白', () => {
  const { sanitizeHeartbeat } = loadServerHelpers()
  assert.deepEqual(plain(sanitizeHeartbeat({ user: '  alice  ', client: '  tab-1  ' })), { user: 'alice', client: 'tab-1' })
  assert.deepEqual(plain(sanitizeHeartbeat({ client: 'tab-1' })), { user: '', client: 'tab-1' }, 'user 缺省 = 匿名空串')
  assert.deepEqual(plain(sanitizeHeartbeat({ user: 42, client: 'tab-1' })), { user: '', client: 'tab-1' }, 'user 非字符串 = 匿名空串')
  assert.deepEqual(plain(sanitizeHeartbeat({ user: '   ', client: 'tab-1' })), { user: '', client: 'tab-1' }, 'user 纯空白裁剪后为空串（仍合法）')
})

test('sanitizeHeartbeat：非对象 body 一律拒绝', () => {
  const { sanitizeHeartbeat } = loadServerHelpers()
  for (const body of [null, undefined, 42, 'tab-1', [], true]) {
    assert.equal(sanitizeHeartbeat(body), null, `body=${String(body)} 应拒绝`)
  }
})

test('sanitizeHeartbeat：client 缺省 / 非字符串 / 裁剪后为空 → null（400）', () => {
  const { sanitizeHeartbeat } = loadServerHelpers()
  assert.equal(sanitizeHeartbeat({}), null, 'client 缺省')
  assert.equal(sanitizeHeartbeat({ user: 'alice' }), null, '只有 user 没有 client')
  for (const client of [42, null, undefined, true, {}, []]) {
    assert.equal(sanitizeHeartbeat({ client }), null, `client=${String(client)} 非字符串应拒绝`)
  }
  assert.equal(sanitizeHeartbeat({ client: '' }), null, 'client 空串')
  assert.equal(sanitizeHeartbeat({ client: '   ' }), null, 'client 纯空白裁剪后为空')
})

test('sanitizeHeartbeat：超长 user/client 截断到 64 字符', () => {
  const { sanitizeHeartbeat } = loadServerHelpers()
  const hb = sanitizeHeartbeat({ user: 'u'.repeat(100), client: 'c'.repeat(100) })
  assert.equal(hb.user.length, 64)
  assert.equal(hb.client.length, 64)
  // 截断发生在裁剪空白之后：前导空白不占 64 额度
  const padded = sanitizeHeartbeat({ user: '  ' + 'u'.repeat(100), client: ' ' + 'c'.repeat(100) })
  assert.equal(padded.user, 'u'.repeat(64))
  assert.equal(padded.client, 'c'.repeat(64))
})

// ---- 服务端在线表：key 归一规则 ----

test('onlineKeyOf：user 非空按 u: 归一，匿名按 c: 计，两条路径永不相撞', () => {
  const { onlineKeyOf } = loadServerHelpers()
  assert.equal(onlineKeyOf('alice', 'tab-1'), 'u:alice')
  assert.equal(onlineKeyOf('alice', 'tab-2'), 'u:alice', '同一用户换标签页 key 不变')
  assert.equal(onlineKeyOf('', 'tab-1'), 'c:tab-1')
  assert.notEqual(onlineKeyOf('alice', 'x'), onlineKeyOf('', 'alice'), '用户 alice 与匿名客户端 alice 不相撞')
})

test('在线表：同一登录用户多 client 归一为 1 人，条目刷新为最近一次心跳', () => {
  const { touchOnlineTable, countOnlineTable } = loadServerHelpers()
  const t0 = 1_000_000_000
  const table = new Map()
  touchOnlineTable(table, { user: 'alice', client: 'tab-1' }, t0)
  touchOnlineTable(table, { user: 'alice', client: 'tab-2' }, t0 + 1000)
  touchOnlineTable(table, { user: 'alice', client: 'tab-1' }, t0 + 2000)
  assert.equal(countOnlineTable(table, t0 + 2000), 1, '同一登录用户多标签页算 1 人')
  const e = table.get('u:alice')
  assert.equal(e.client, 'tab-1', '条目覆盖为最近一次心跳的 client')
  assert.equal(e.at, t0 + 2000, 'at 取服务端 now')
})

test('在线表：两个匿名 client 计 2 人；命名 + 匿名并存', () => {
  const { touchOnlineTable, countOnlineTable } = loadServerHelpers()
  const t0 = 1_000_000_000
  const table = new Map()
  touchOnlineTable(table, { user: '', client: 'anon-1' }, t0)
  touchOnlineTable(table, { user: '', client: 'anon-2' }, t0)
  assert.equal(countOnlineTable(table, t0), 2, '匿名按客户端实例各计 1 人')
  touchOnlineTable(table, { user: 'alice', client: 'tab-1' }, t0)
  touchOnlineTable(table, { user: 'bob', client: 'tab-9' }, t0)
  assert.equal(countOnlineTable(table, t0), 4, '命名用户与匿名并存各算各的')
  touchOnlineTable(table, { user: 'alice', client: 'tab-2' }, t0 + 1)
  assert.equal(countOnlineTable(table, t0 + 1), 4, 'alice 换标签页不增量')
  touchOnlineTable(table, { user: '', client: 'anon-1' }, t0 + 1)
  assert.equal(countOnlineTable(table, t0 + 1), 4, '同一匿名 client 重复心跳不增量')
})

// ---- 服务端在线表：TTL 过期 ----

test('源码约定：ONLINE_TTL_MS = 90_000（90 秒过期）', () => {
  assert.match(serverSource, /ONLINE_TTL_MS\s*=\s*90_000/, '服务端在线 TTL 应为 90 秒')
})

test('在线表：超过 90s 的条目在 count 时清理，不计入在线数', () => {
  const { touchOnlineTable, countOnlineTable } = loadServerHelpers()
  const t0 = 1_000_000_000
  const table = new Map()
  touchOnlineTable(table, { user: 'alice', client: 'tab-1' }, t0)
  touchOnlineTable(table, { user: 'bob', client: 'tab-2' }, t0)
  assert.equal(countOnlineTable(table, t0 + TTL - 1), 2, 'TTL 内都在线')
  assert.equal(countOnlineTable(table, t0 + TTL + 1000), 0, '超过 90s 全部过期')
  assert.equal(table.size, 0, '过期条目被物理删除而非仅不计数')
  // count 清理后新心跳重新计入
  touchOnlineTable(table, { user: 'carl', client: 'tab-3' }, t0 + TTL + 2000)
  assert.equal(countOnlineTable(table, t0 + TTL + 2000), 1)
})

test('在线表：touch 同样先懒清理过期条目；新旧混杂只留新者', () => {
  const { touchOnlineTable, countOnlineTable } = loadServerHelpers()
  const t0 = 1_000_000_000
  const table = new Map()
  touchOnlineTable(table, { user: 'stale', client: 'tab-1' }, t0)
  touchOnlineTable(table, { user: 'fresh', client: 'tab-2' }, t0 + TTL + 1)
  assert.equal(table.has('u:stale'), false, 'touch 前懒清理过期条目')
  assert.equal(countOnlineTable(table, t0 + TTL + 1), 1)

  const mixed = new Map()
  touchOnlineTable(mixed, { user: 'old', client: 'c1' }, t0)
  touchOnlineTable(mixed, { user: 'new', client: 'c2' }, t0 + 80_000)
  assert.equal(countOnlineTable(mixed, t0 + TTL + 1000), 1, 'old（91s）过期、new（11s）在线')
  assert.equal(mixed.has('u:new'), true)
})

// ---- 服务端接线（路由注册与响应字段，文本级断言） ----

test('服务端接线：heartbeat 路由紧邻 usage 注册，usage GET 响应带顶层 online 字段', () => {
  const usageAt = serverSource.indexOf("path: '/api/worktable/usage'")
  const hbAt = serverSource.indexOf("path: '/api/worktable/usage/heartbeat'")
  assert.ok(usageAt >= 0, 'usage 路由存在')
  assert.ok(hbAt > usageAt, 'heartbeat 路由注册在 usage 之后')
  const between = serverSource.slice(usageAt, hbAt)
  assert.equal((between.match(/webServer\.register\(/g) || []).length, 1, 'usage 与 heartbeat 注册之间不应夹其他路由')

  const hbRegisterAt = serverSource.lastIndexOf('webServer.register', hbAt)
  const nextRegister = serverSource.indexOf('webServer.register', hbAt)
  const block = serverSource.slice(hbRegisterAt, nextRegister >= 0 ? nextRegister : undefined)
  assert.ok(block.includes("kind: 'exact'"), 'heartbeat 为 exact 路由')
  assert.ok(block.includes('res.writeHead(405)'), '非 POST 应 405')
  assert.ok(block.includes('USAGE_BODY_LIMIT'), 'content-length 超 16KB 应 413')
  assert.ok(block.includes('sanitizeHeartbeat('), 'body 经 sanitizeHeartbeat 清洗（非法 → 400）')
  assert.ok(block.includes('touchOnlineTable(onlineTable'), '心跳写入在线表')
  assert.ok(block.includes('{ ok: true }'), '成功回执 { ok: true }')

  const usageBlock = serverSource.slice(usageAt, hbAt)
  assert.ok(usageBlock.includes('online: countOnlineTable(onlineTable'), 'usage GET 响应应带顶层 online 计数字段')
})

// ---- 客户端契约（实现由并行客户端改动提供；落地前以下断言预期失败） ----

test('契约（客户端）：源码中出现 /api/worktable/usage/heartbeat 心跳上报', () => {
  assert.ok(clientSource.includes('/api/worktable/usage/heartbeat'), '客户端应向 /api/worktable/usage/heartbeat 周期性上报心跳')
})

test('契约（客户端）：parseUsageStats 把响应 online 解析进结果（缺失/非法 → 0）', () => {
  const { parseUsageStats } = loadClientHelpers()
  const full = parseUsageStats({ ok: true, total: 2, online: 3, users: [], daily: [], recent: [] })
  assert.equal(full.online, 3, '响应里的 online 应解析进结果')
  assert.equal(parseUsageStats({ ok: true, online: 0, users: [], daily: [], recent: [] }).online, 0, 'online 为 0 合法')
  assert.equal(parseUsageStats({ ok: true, users: [], daily: [], recent: [] }).online, 0, 'online 缺失 → 0')
  for (const bad of [-1, -10, Number.NaN, Number.POSITIVE_INFINITY, 'x', '3', null, undefined, {}, []]) {
    assert.equal(parseUsageStats({ online: bad }).online, 0, `online=${String(bad)} 非法 → 0`)
  }
  assert.equal(parseUsageStats(null).online, 0, '整体输入非法回退空结构时 online 也为 0')
})
