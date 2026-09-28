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

// ---- 服务端 sanitizeUsageEvent ----

test('sanitizeUsageEvent：合法事件通过，user/detail 裁剪空白，at 恒取服务端 now', () => {
  const { sanitizeUsageEvent } = loadServerHelpers()
  const ev = sanitizeUsageEvent({ user: '  alice  ', kind: 'visit', detail: '  ', at: 1 }, 1789900000000)
  assert.deepEqual(plain(ev), { user: 'alice', kind: 'visit', detail: '', at: 1789900000000 }, '客户端给的 at 必须被服务端 now 覆盖')
  const open = sanitizeUsageEvent({ user: 'bob', kind: 'open', detail: 'proj-1' }, 1789900000001)
  assert.deepEqual(plain(open), { user: 'bob', kind: 'open', detail: 'proj-1', at: 1789900000001 })
  const anon = sanitizeUsageEvent({ kind: 'visit' }, 1789900000002)
  assert.deepEqual(plain(anon), { user: '', kind: 'visit', detail: '', at: 1789900000002 }, 'user/detail 缺省 = 匿名空串')
})

test('sanitizeUsageEvent：非对象 body 与非法 kind 一律拒绝', () => {
  const { sanitizeUsageEvent } = loadServerHelpers()
  for (const body of [null, undefined, 42, 'visit', [], true]) {
    assert.equal(sanitizeUsageEvent(body, 1), null, `body=${String(body)} 应拒绝`)
  }
  for (const kind of ['', 'Visit', 'VISIT', '1open', 'open project', 'a'.repeat(33), 'open!', 42, null]) {
    assert.equal(sanitizeUsageEvent({ kind }, 1), null, `kind=${String(kind)} 应拒绝`)
  }
  // 边界：32 字符合法、连字符/下划线/数字合法
  assert.ok(sanitizeUsageEvent({ kind: 'a'.repeat(32) }, 1), '32 字符 kind 应通过')
  assert.ok(sanitizeUsageEvent({ kind: 'open_project-2' }, 1), '下划线/连字符/数字 kind 应通过')
})

test('sanitizeUsageEvent：超长 user/detail 截断到 64/200 字符', () => {
  const { sanitizeUsageEvent } = loadServerHelpers()
  const ev = sanitizeUsageEvent({ user: 'u'.repeat(100), kind: 'visit', detail: 'd'.repeat(300) }, 7)
  assert.equal(ev.user.length, 64)
  assert.equal(ev.detail.length, 200)
  assert.equal(ev.at, 7)
})

// ---- 服务端 parseUsageEvents ----

test('parseUsageEvents：JSONL 逐行解析，坏行跳过，字段同 sanitize 规则', () => {
  const { parseUsageEvents } = loadServerHelpers()
  const text = [
    JSON.stringify({ user: 'alice', kind: 'visit', detail: '', at: 1000 }),
    'not json{',
    JSON.stringify({ user: 'bob', kind: 'OPEN', at: 2000 }),          // kind 非法
    JSON.stringify({ user: 'bob', kind: 'visit', at: 'yesterday' }),  // at 非数值
    JSON.stringify({ user: 'bob', kind: 'visit', at: Number.NaN }),   // at 非有限（JSON 化为 null）
    JSON.stringify({ kind: 'open', at: 3000 }),                       // user 缺省 = 匿名
    JSON.stringify({ user: '  carl ', kind: 'open', detail: 'p', at: 4000 }),
    '',
    '   ',
  ].join('\n')
  const list = parseUsageEvents(text)
  assert.equal(list.length, 3)
  assert.deepEqual(plain(list), [
    { user: 'alice', kind: 'visit', detail: '', at: 1000 },
    { user: '', kind: 'open', detail: '', at: 3000 },
    { user: 'carl', kind: 'open', detail: 'p', at: 4000 },
  ])
  assert.deepEqual(plain(parseUsageEvents('')), [])
  assert.deepEqual(plain(parseUsageEvents('not json\n\n  \n')), [])
})

// ---- 服务端 aggregateUsageEvents ----

const dayAt = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime()
const pad = (n) => String(n).padStart(2, '0')
const dayStr = (at) => { const d = new Date(at); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }

test('aggregateUsageEvents：多用户多 kind 计数、活跃天数、首末时间；乱序输入也正确', () => {
  const { aggregateUsageEvents } = loadServerHelpers()
  const now = dayAt(2026, 9, 21, 12)
  const events = [
    { user: 'bob', kind: 'visit', detail: '', at: dayAt(2026, 9, 20, 9) },
    { user: 'alice', kind: 'open', detail: 'b', at: dayAt(2026, 9, 21, 10) },
    { user: 'alice', kind: 'visit', detail: '', at: dayAt(2026, 9, 19, 8) },
    { user: 'alice', kind: 'open', detail: 'a', at: dayAt(2026, 9, 20, 11) },
    { user: '', kind: 'visit', detail: '', at: dayAt(2026, 9, 21, 11) }, // 匿名
  ]
  const agg = aggregateUsageEvents(events, now)
  assert.equal(agg.total, 5)
  assert.equal(agg.users.length, 3)
  const alice = agg.users[0]
  assert.equal(alice.user, 'alice', 'events 最多者排最前')
  assert.deepEqual(plain({ events: alice.events, visits: alice.visits, opens: alice.opens, days: alice.days }), { events: 3, visits: 1, opens: 2, days: 3 })
  assert.equal(alice.firstAt, dayAt(2026, 9, 19, 8))
  assert.equal(alice.lastAt, dayAt(2026, 9, 21, 10))
  const anon = agg.users.find((u) => u.user === '')
  assert.ok(anon, '匿名（空 user）也单列一行')
  assert.equal(anon.events, 1)
})

test('aggregateUsageEvents：用户排序 events 降序、并列按 lastAt 降序', () => {
  const { aggregateUsageEvents } = loadServerHelpers()
  const now = dayAt(2026, 9, 21, 12)
  const events = [
    { user: 'early', kind: 'visit', detail: '', at: dayAt(2026, 9, 21, 8) },
    { user: 'early', kind: 'visit', detail: '', at: dayAt(2026, 9, 21, 9) },
    { user: 'late', kind: 'visit', detail: '', at: dayAt(2026, 9, 21, 10) },
    { user: 'late', kind: 'visit', detail: '', at: dayAt(2026, 9, 21, 11) },
  ]
  const agg = aggregateUsageEvents(events, now)
  assert.deepEqual(plain(agg.users.map((u) => u.user)), ['late', 'early'], 'events 并列时 lastAt 新者在前')
})

test('aggregateUsageEvents：daily 为最近 30 个日历日（升序补零），users 按当日去重', () => {
  const { aggregateUsageEvents } = loadServerHelpers()
  const now = dayAt(2026, 9, 21, 12)
  const events = [
    { user: 'alice', kind: 'visit', detail: '', at: dayAt(2026, 9, 21, 9) },
    { user: 'alice', kind: 'open', detail: 'a', at: dayAt(2026, 9, 21, 10) },
    { user: 'bob', kind: 'visit', detail: '', at: dayAt(2026, 9, 21, 11) },
    { user: 'alice', kind: 'visit', detail: '', at: dayAt(2026, 9, 1, 9) },   // 窗口内早期
    { user: 'alice', kind: 'visit', detail: '', at: dayAt(2026, 8, 1, 9) },   // 30 天窗口外：计入 total/users 不进 daily
  ]
  const agg = aggregateUsageEvents(events, now)
  assert.equal(agg.daily.length, 30)
  const days = agg.daily.map((d) => d.day)
  assert.deepEqual(plain(days), plain([...days].sort()), 'daily 按日期升序')
  assert.equal(days[29], dayStr(now), '末日为今天')
  assert.equal(days[0], dayStr(dayAt(2026, 8, 23, 12)), '首日为 29 天前')
  const today = agg.daily[29]
  assert.deepEqual(plain({ events: today.events, users: today.users }), { events: 3, users: 2 }, '今日 3 事件 / 去重 2 用户')
  const sep1 = agg.daily.find((d) => d.day === dayStr(dayAt(2026, 9, 1, 12)))
  assert.deepEqual(plain({ events: sep1.events, users: sep1.users }), { events: 1, users: 1 })
  const idle = agg.daily.find((d) => d.day === dayStr(dayAt(2026, 9, 15, 12)))
  assert.deepEqual(plain({ events: idle.events, users: idle.users }), { events: 0, users: 0 }, '无事件的日补零')
})

test('aggregateUsageEvents：recent 为最新 30 条（新→旧）；空输入回退空结构', () => {
  const { aggregateUsageEvents } = loadServerHelpers()
  const now = dayAt(2026, 9, 21, 12)
  const events = []
  for (let i = 0; i < 35; i += 1) events.push({ user: 'u' + (i % 3), kind: 'visit', detail: 'd' + i, at: dayAt(2026, 9, 20, 0) + i })
  const agg = aggregateUsageEvents(events, now)
  assert.equal(agg.recent.length, 30, 'recent 上限 30')
  assert.equal(agg.recent[0].detail, 'd34', '最新一条在前')
  assert.equal(agg.recent[29].detail, 'd5', '最旧一条为第 6 新')
  for (let i = 1; i < agg.recent.length; i += 1) assert.ok(agg.recent[i - 1].at >= agg.recent[i].at, 'recent 新→旧排序')

  const empty = aggregateUsageEvents([], now)
  assert.equal(empty.total, 0)
  assert.deepEqual(plain(empty.users), [])
  assert.deepEqual(plain(empty.recent), [])
  assert.equal(empty.daily.length, 30)
  assert.ok(empty.daily.every((d) => d.events === 0 && d.users === 0), '空输入 daily 全补零')
})

// ---- 客户端 parseUsageStats ----

test('parseUsageStats：正常响应解析，时间格式 MM-DD HH:mm，daily 日截 MM-DD，today 取今日桶', () => {
  const { parseUsageStats } = loadClientHelpers()
  const now = Date.now()
  const todayFull = dayStr(now)
  const stats = parseUsageStats({
    ok: true,
    total: 4,
    users: [
      { user: 'alice', events: 3, visits: 1, opens: 2, days: 2, firstAt: now - 86400000, lastAt: now },
      { user: '', events: 1, visits: 1, opens: 0, days: 1, firstAt: now, lastAt: now },
    ],
    daily: [
      { day: todayFull, events: 4, users: 2 },
      { day: dayStr(now - 86400000), events: 1, users: 1 },
    ],
    recent: [
      { user: 'alice', kind: 'open', detail: 'proj-1', at: now },
      { user: '', kind: 'visit', detail: '', at: now - 60000 },
    ],
  })
  assert.equal(stats.total, 4)
  assert.equal(stats.today, 4, 'today 取 daily 中今日桶的 events')
  assert.equal(stats.users.length, 2)
  assert.match(stats.users[0].last, /^\d{2}-\d{2} \d{2}:\d{2}$/, 'last 为 MM-DD HH:mm')
  assert.equal(stats.users[0].user, 'alice')
  assert.equal(stats.users[1].user, '', '空 user 保留空串（由弹窗渲染匿名文案）')
  assert.equal(stats.daily[0].day, todayFull.slice(5), 'daily day 截为 MM-DD')
  assert.equal(stats.daily[0].users, 2)
  assert.match(stats.recent[0].when, /^\d{2}-\d{2} \d{2}:\d{2}$/, 'when 为 MM-DD HH:mm')
  assert.equal(stats.recent[0].kind, 'open')
  assert.equal(stats.recent[0].detail, 'proj-1')
})

test('parseUsageStats：异常输入（null / 字符串 / 数组 / 旧版 404 兜底页）回退空结构', () => {
  const { parseUsageStats } = loadClientHelpers()
  for (const bad of [null, undefined, 42, 'not json', [], '<html>404</html>']) {
    assert.deepEqual(plain(parseUsageStats(bad)), { total: 0, today: 0, users: [], daily: [], recent: [] }, `输入 ${String(bad)} 应回退空结构`)
  }
  // 部分字段畸形：坏项剔除、好项保留，计数非有限值归零
  const stats = parseUsageStats({
    total: 'many',
    users: [{ user: 'a', events: 2, visits: 1, opens: 1, days: 1, lastAt: 'x' }, null, 42],
    daily: [{ day: 123, events: 1 }],
    recent: 'nope',
  })
  assert.equal(stats.total, 0)
  assert.equal(stats.users.length, 1)
  assert.equal(stats.users[0].last, '', 'lastAt 非数值时 last 为空串')
  assert.equal(stats.daily.length, 1)
  assert.equal(stats.daily[0].day, '', 'day 非字符串时为空串')
  assert.deepEqual(plain(stats.recent), [])
})
