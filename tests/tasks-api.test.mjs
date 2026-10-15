/* /api/worktable/tasks 团队任务共享存储 API：
   GET 列出（任意会话）；POST 新建 / DELETE 删除仅 admin；PATCH 中 admin 改全部字段（含 tags）、
   普通成员仅可改分配给自己任务的 status/effect/addProgress；auth 存在时 assignee 强校验 users.yaml
   真实启用用户；无 auth 服务（token 共享模式）退化为全权。存储 $DSH_HOME/storages/worktable-tasks.json。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as pathResolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

/* 顶层函数提取：签名返回类型可能含 {}（如 Map<string, { role?: string }>），花括号配对法会
   误把类型注解当函数体；顶层函数体必以列 0 的 } 收尾，按 '\n}\n' 截断。 */
function extractFunction(name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const match = marker.exec(source)
  assert.ok(match, `src/index.ts 缺少函数 ${name}`)
  const tail = source.indexOf('\n}\n', match.index)
  assert.ok(tail > match.index, `函数 ${name} 收尾未找到`)
  return source.slice(match.index, tail + 3)
}

const USERS_YAML = `version: 1
users:
  alice:
    passwordHash: scrypt$fake
    role: admin
  bob:
    passwordHash: scrypt$fake
  carol:
    passwordHash: scrypt$fake
    disabled: true
`

const AUTH = {
  admin: { username: 'alice', isAdmin: true },
  member: { username: 'bob', isAdmin: false },
  anonymous: { username: '', isAdmin: false },
  tokenMode: undefined,   // 无 auth 服务：退化为全权
}

async function loadTasksRoute({ auth, home } = {}) {
  if (!home) {
    home = await mkdtemp(join(tmpdir(), 'tm-tasks-api-'))
    await mkdir(join(home, 'auth'), { recursive: true })
    await writeFile(join(home, 'auth', 'users.yaml'), USERS_YAML, 'utf8')
  }
  const start = source.indexOf('/* ---------- 团队任务管理（projects/tasks/task-manager.html）共享存储与 API ----------')
  const end = source.indexOf('/* ---------- 团队任务管理结束 ---------- */', start)
  assert.ok(start >= 0 && end > start, '团队任务管理实现未找到')
  const code = stripTypeScriptTypes([
    extractFunction('parseAuthUsersYaml'),
    source.slice(start, end),
  ].join('\n'), { mode: 'transform' })
  const handlers = {}
  const ctx = {
    Promise, URL, JSON, Date, Math, Number, String, Object, Array, Map,
    DSH_HOME: home,
    pathResolve,
    readFileSync,
    readFile,
    fsMkdir: mkdir,
    fsWriteFile: writeFile,
    fsRename: rename,
    readJsonBody: async (req) => (req.body && typeof req.body === 'object' ? req.body : {}),
    resolveRequestAuth: () => auth,
    json(res, status, body) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  assert.equal(typeof ctx.registerTasksApi, 'function', '缺少 registerTasksApi')
  ctx.registerTasksApi({ register(route) { handlers[route.path] = route } }, /* pluginCtx */ {})
  assert.ok(handlers['/api/worktable/tasks'], '缺少团队任务路由')
  return { handler: handlers['/api/worktable/tasks'].handler, route: handlers['/api/worktable/tasks'], home }
}

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers },
    end(body) { this.body = body == null ? '' : String(body) },
    json() { return this.body ? JSON.parse(this.body) : null },
  }
}

async function call(handler, { method = 'GET', url = '/api/worktable/tasks', body, headers = {} } = {}) {
  const res = response()
  await handler({ method, url, headers, body }, res)
  return res
}

async function createTask(handler, over = {}) {
  const res = await call(handler, { method: 'POST', body: { title: '季度汇报 PPT', assignee: 'bob', ...over } })
  assert.equal(res.status, 201, `新建任务失败：${res.body}`)
  return res.json().task
}

test('路由注册为 exact 且路径固定', async () => {
  const { route } = await loadTasksRoute({ auth: AUTH.admin })
  assert.equal(route.kind, 'exact')
})

test('GET 空存储返回空列表；无会话也可读（页面加载不报错）', async () => {
  const { handler } = await loadTasksRoute({ auth: AUTH.anonymous })
  const res = await call(handler)
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { tasks: [] })
})

test('POST admin 新建：补齐默认值、服务端签发 id/时间/创建人并落盘', async () => {
  const { handler, home } = await loadTasksRoute({ auth: AUTH.admin })
  const task = await createTask(handler, { desc: '汇总 Q3 进度', prio: 'high', deadline: Date.now() + 86400000, tags: ['汇报', '材料'] })
  assert.ok(/^t[a-z0-9]+$/.test(task.id), `id 形态异常：${task.id}`)
  assert.equal(task.title, '季度汇报 PPT')
  assert.equal(task.assignee, 'bob')
  assert.equal(task.prio, 'high')
  assert.equal(task.status, 'todo')
  assert.equal(task.effect, '')
  assert.deepEqual(task.tags, ['汇报', '材料'])
  assert.deepEqual(task.progress, [])
  assert.equal(task.createdBy, 'alice')
  assert.ok(task.created > 0 && task.updated >= task.created)
  const disk = JSON.parse(await readFile(join(home, 'storages', 'worktable-tasks.json'), 'utf8'))
  assert.equal(disk.tasks.length, 1)
  const list = await call(handler)
  assert.equal(list.json().tasks.length, 1)
  assert.equal(list.json().tasks[0].id, task.id)
})

test('POST 字段校验：缺标题 / 空标题 / 非法优先级 / 缺负责人均 400', async () => {
  const { handler } = await loadTasksRoute({ auth: AUTH.admin })
  for (const body of [
    { assignee: 'bob' },
    { title: '   ', assignee: 'bob' },
    { title: 'x', assignee: 'bob', prio: 'urgent' },
    { title: 'x' },
    { title: 'x', assignee: '  ' },
  ]) {
    const res = await call(handler, { method: 'POST', body })
    assert.equal(res.status, 400, `应判 400：${JSON.stringify(body)} → ${res.body}`)
  }
})

test('POST 负责人强校验真实用户：非 users.yaml 用户 / 已停用用户 400，admin 用户可受托', async () => {
  const { handler } = await loadTasksRoute({ auth: AUTH.admin })
  const ghost = await call(handler, { method: 'POST', body: { title: 'x', assignee: 'zhangsan' } })
  assert.equal(ghost.status, 400)
  assert.match(ghost.json().error, /真实用户/)
  const disabled = await call(handler, { method: 'POST', body: { title: 'x', assignee: 'carol' } })
  assert.equal(disabled.status, 400)
  assert.match(disabled.json().error, /停用/)
  const ok = await call(handler, { method: 'POST', body: { title: 'x', assignee: 'alice' } })
  assert.equal(ok.status, 201)
})

test('POST 权限：普通成员 403、无会话 401；token 共享模式退化为全权（自由负责人）', async () => {
  const member = await loadTasksRoute({ auth: AUTH.member })
  const forbidden = await call(member.handler, { method: 'POST', body: { title: 'x', assignee: 'bob' } })
  assert.equal(forbidden.status, 403)
  const anon = await loadTasksRoute({ auth: AUTH.anonymous })
  const unauthorized = await call(anon.handler, { method: 'POST', body: { title: 'x', assignee: 'bob' } })
  assert.equal(unauthorized.status, 401)
  const shared = await loadTasksRoute({ auth: AUTH.tokenMode })
  const created = await call(shared.handler, { method: 'POST', body: { title: 'x', assignee: '随便谁' } })
  assert.equal(created.status, 201)
  assert.equal(created.json().task.createdBy, '')
})

test('PATCH admin 可改全部字段（含换负责人/标签；新负责人同样校验真实用户）', async () => {
  const { handler } = await loadTasksRoute({ auth: AUTH.admin })
  const task = await createTask(handler)
  const res = await call(handler, {
    method: 'PATCH',
    body: { id: task.id, title: '改名', prio: 'low', status: 'doing', deadline: Date.now() + 3600000, assignee: 'alice', desc: 'd', effect: 'e', tags: ['紧急', '安全', '紧急'] },
  })
  assert.equal(res.status, 200, res.body)
  const updated = res.json().task
  assert.equal(updated.title, '改名')
  assert.equal(updated.prio, 'low')
  assert.equal(updated.status, 'doing')
  assert.equal(updated.assignee, 'alice')
  assert.deepEqual(updated.tags, ['紧急', '安全'], '标签应去重')
  assert.ok(updated.updated >= task.updated)
  const bad = await call(handler, { method: 'PATCH', body: { id: task.id, assignee: 'ghost' } })
  assert.equal(bad.status, 400)
})

test('标签校验：非数组 / 空标签 / 超 10 个均 400', async () => {
  const { handler } = await loadTasksRoute({ auth: AUTH.admin })
  const task = await createTask(handler)
  for (const tags of ['oops', [''], Array.from({ length: 11 }, (_, i) => 't' + i)]) {
    const res = await call(handler, { method: 'PATCH', body: { id: task.id, tags } })
    assert.equal(res.status, 400, `应判 400：${JSON.stringify(tags)} → ${res.body}`)
  }
  const ok = await call(handler, { method: 'PATCH', body: { id: task.id, tags: Array.from({ length: 10 }, (_, i) => 'g' + i) } })
  assert.equal(ok.status, 200)
  assert.equal(ok.json().task.tags.length, 10)
})

test('PATCH 成员：可改自己任务的 status/effect/addProgress；改 tags/标题或他人任务 403', async () => {
  const admin = await loadTasksRoute({ auth: AUTH.admin })
  const own = await createTask(admin.handler, { assignee: 'bob' })
  const other = await createTask(admin.handler, { assignee: 'alice' })
  const member = await loadTasksRoute({ auth: AUTH.member, home: admin.home })
  /* member 与 admin 共用同一 DSH_HOME（同一存储文件），仅会话身份不同 */
  const ok = await call(member.handler, { method: 'PATCH', body: { id: own.id, status: 'doing', effect: '已过半' } })
  assert.equal(ok.status, 200, ok.body)
  assert.equal(ok.json().task.status, 'doing')
  assert.equal(ok.json().task.effect, '已过半')
  const prog = await call(member.handler, { method: 'PATCH', body: { id: own.id, addProgress: '接口联调完成' } })
  assert.equal(prog.status, 200, prog.body)
  const entries = prog.json().task.progress
  assert.equal(entries.length, 1)
  assert.equal(entries[0].text, '接口联调完成')
  assert.equal(entries[0].by, 'bob')
  assert.ok(entries[0].at > 0 && entries[0].id)
  const restricted = await call(member.handler, { method: 'PATCH', body: { id: own.id, title: '越权' } })
  assert.equal(restricted.status, 403)
  const tagsForbidden = await call(member.handler, { method: 'PATCH', body: { id: own.id, tags: ['x'] } })
  assert.equal(tagsForbidden.status, 403)
  const foreign = await call(member.handler, { method: 'PATCH', body: { id: other.id, status: 'done' } })
  assert.equal(foreign.status, 403)
  const foreignProg = await call(member.handler, { method: 'PATCH', body: { id: other.id, addProgress: '偷加' } })
  assert.equal(foreignProg.status, 403)
})

test('addProgress 校验：空内容 400；进展条数达上限 400；admin 也可追加', async () => {
  const { handler, home } = await loadTasksRoute({ auth: AUTH.admin })
  const task = await createTask(handler)
  const empty = await call(handler, { method: 'PATCH', body: { id: task.id, addProgress: '   ' } })
  assert.equal(empty.status, 400)
  const ok = await call(handler, { method: 'PATCH', body: { id: task.id, addProgress: '第一步完成' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.json().task.progress.length, 1)
  await mkdir(join(home, 'storages'), { recursive: true })
  const disk = JSON.parse(await readFile(join(home, 'storages', 'worktable-tasks.json'), 'utf8'))
  disk.tasks[0].progress = Array.from({ length: 50 }, (_, i) => ({ id: 'p' + i, text: 'x' + i, by: 'alice', at: 1 }))
  await writeFile(join(home, 'storages', 'worktable-tasks.json'), JSON.stringify(disk), 'utf8')
  const over = await call(handler, { method: 'PATCH', body: { id: task.id, addProgress: '溢出' } })
  assert.equal(over.status, 400)
  assert.match(over.json().error, /上限/)
})

test('updateProgress：admin/作者/任务负责人可改写；非相关人员 403；缺 id/空文本 400；不存在 404', async () => {
  const admin = await loadTasksRoute({ auth: AUTH.admin })
  const task = await createTask(admin.handler, { assignee: 'bob' })
  const added = await call(admin.handler, { method: 'PATCH', body: { id: task.id, addProgress: '初稿' } })
  const entry = added.json().task.progress[0]
  const member = await loadTasksRoute({ auth: AUTH.member, home: admin.home })
  /* 任务负责人 bob 可改本任务上任意进展 */
  const ok = await call(member.handler, { method: 'PATCH', body: { id: task.id, updateProgress: { id: entry.id, text: '修订后的进展' } } })
  assert.equal(ok.status, 200, ok.body)
  assert.equal(ok.json().task.progress[0].text, '修订后的进展')
  /* admin 可改任意 */
  const byAdmin = await call(admin.handler, { method: 'PATCH', body: { id: task.id, updateProgress: { id: entry.id, text: 'admin 再改' } } })
  assert.equal(byAdmin.status, 200)
  assert.equal(byAdmin.json().task.progress[0].text, 'admin 再改')
  /* 非负责人、非作者：alice 任务上的进展 bob 改不了 */
  const other = await createTask(admin.handler, { assignee: 'alice' })
  const otherEntry = await call(admin.handler, { method: 'PATCH', body: { id: other.id, addProgress: 'alice 任务上的进展' } })
  const otherId = otherEntry.json().task.progress[0].id
  const forbidden = await call(member.handler, { method: 'PATCH', body: { id: other.id, updateProgress: { id: otherId, text: '偷改' } } })
  assert.equal(forbidden.status, 403)
  assert.match(forbidden.json().error, /作者|负责人|admin|分配给自/)
  const badId = await call(admin.handler, { method: 'PATCH', body: { id: task.id, updateProgress: { id: entry.id } } })
  assert.equal(badId.status, 400)
  const missing = await call(admin.handler, { method: 'PATCH', body: { id: task.id, updateProgress: { id: 'p-none', text: 'x' } } })
  assert.equal(missing.status, 404)
})

test('deleteProgress：admin/作者/任务负责人可删；非相关人员 403；缺 id 400；不存在 404', async () => {
  const admin = await loadTasksRoute({ auth: AUTH.admin })
  const task = await createTask(admin.handler, { assignee: 'bob' })
  const a = await call(admin.handler, { method: 'PATCH', body: { id: task.id, addProgress: '将删' } })
  const b = await call(admin.handler, { method: 'PATCH', body: { id: task.id, addProgress: '保留' } })
  const delId = a.json().task.progress.find((e) => e.text === '将删').id
  const keepId = b.json().task.progress.find((e) => e.text === '保留').id
  const member = await loadTasksRoute({ auth: AUTH.member, home: admin.home })
  /* 任务负责人 bob 可删本任务上任意进展 */
  const ok = await call(member.handler, { method: 'PATCH', body: { id: task.id, deleteProgress: delId } })
  assert.equal(ok.status, 200, ok.body)
  assert.equal(ok.json().task.progress.length, 1)
  assert.equal(ok.json().task.progress[0].id, keepId)
  /* 非相关人员：他人任务上的进展删不了 */
  const other = await createTask(admin.handler, { assignee: 'alice' })
  const otherEntry = await call(admin.handler, { method: 'PATCH', body: { id: other.id, addProgress: '别动' } })
  const otherId = otherEntry.json().task.progress[0].id
  const forbidden = await call(member.handler, { method: 'PATCH', body: { id: other.id, deleteProgress: otherId } })
  assert.equal(forbidden.status, 403)
  /* admin 删剩下的 + 幂等 404 */
  const byAdmin = await call(admin.handler, { method: 'PATCH', body: { id: task.id, deleteProgress: keepId } })
  assert.equal(byAdmin.status, 200)
  assert.equal(byAdmin.json().task.progress.length, 0)
  const again = await call(admin.handler, { method: 'PATCH', body: { id: task.id, deleteProgress: keepId } })
  assert.equal(again.status, 404)
  const empty = await call(admin.handler, { method: 'PATCH', body: { id: task.id, deleteProgress: '' } })
  assert.equal(empty.status, 400)
})

test('PATCH 不存在任务 404；缺 id 400；无会话 401', async () => {
  const { handler } = await loadTasksRoute({ auth: AUTH.admin })
  const missing = await call(handler, { method: 'PATCH', body: { id: 't-none', status: 'done' } })
  assert.equal(missing.status, 404)
  const noId = await call(handler, { method: 'PATCH', body: { status: 'done' } })
  assert.equal(noId.status, 400)
  const anon = await loadTasksRoute({ auth: AUTH.anonymous })
  const unauthorized = await call(anon.handler, { method: 'PATCH', body: { id: 't1', status: 'done' } })
  assert.equal(unauthorized.status, 401)
})

test('DELETE：成员 403；admin 删除后 GET 不再可见；重复删除 404', async () => {
  const admin = await loadTasksRoute({ auth: AUTH.admin })
  const task = await createTask(admin.handler)
  const member = await loadTasksRoute({ auth: AUTH.member, home: admin.home })
  const forbidden = await call(member.handler, { method: 'DELETE', url: `/api/worktable/tasks?id=${task.id}` })
  assert.equal(forbidden.status, 403)
  const ok = await call(admin.handler, { method: 'DELETE', url: `/api/worktable/tasks?id=${task.id}` })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json(), { ok: true, id: task.id })
  const list = await call(admin.handler)
  assert.equal(list.json().tasks.length, 0)
  const again = await call(admin.handler, { method: 'DELETE', url: `/api/worktable/tasks?id=${task.id}` })
  assert.equal(again.status, 404)
})

test('任务总量达上限后新建 413', async () => {
  const { handler, home } = await loadTasksRoute({ auth: AUTH.admin })
  await mkdir(join(home, 'storages'), { recursive: true })
  const bulk = Array.from({ length: 2000 }, (_, i) => ({ id: `t-seed-${i}`, title: 'x', assignee: 'bob', prio: 'mid', status: 'todo' }))
  await writeFile(join(home, 'storages', 'worktable-tasks.json'), JSON.stringify({ tasks: bulk }), 'utf8')
  const res = await call(handler, { method: 'POST', body: { title: '溢出', assignee: 'bob' } })
  assert.equal(res.status, 413)
})

test('未支持的方法 405', async () => {
  const { handler } = await loadTasksRoute({ auth: AUTH.admin })
  const res = await call(handler, { method: 'PUT', body: {} })
  assert.equal(res.status, 405)
})
