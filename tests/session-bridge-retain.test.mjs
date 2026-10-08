import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

function functionSource(name) {
  const functionStart = source.indexOf('function ' + name + '(')
  const start = functionStart >= 6 && source.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6
    : functionStart
  assert.ok(start >= 0, '缺少函数 ' + name)
  // 函数体起点的 '{' 可能与签名里的对象类型标注混淆（如返回类型 : { release(): void } | null、
  // 形参类型 ref: { release(): void } | null）：逐个候选 '{' 配对到闭合，
  // 首个能编译成完整函数声明的片段才含真函数体（类型标注片段会因缺少函数体而编译失败）。
  for (let brace = source.indexOf('{', functionStart); brace >= 0; brace = source.indexOf('{', brace + 1)) {
    let depth = 0
    let end = -1
    for (let i = brace; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      if (source[i] === '}') depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
    if (end < 0) break
    const candidate = source.slice(start, end)
    // 无函数体的片段会被 strip 当作可擦除的重载签名清成空串，需确认函数声明与函数体大括号仍在
    try {
      const stripped = stripTypeScriptTypes(candidate, { mode: 'transform' })
      if (stripped.includes('function ' + name + '(') && stripped.includes('{')) {
        new vm.Script(stripped)
        return candidate
      }
    } catch { /* 该 '{' 属于类型标注，继续找下一个 */ }
  }
  assert.fail('函数 ' + name + ' 缺少闭合括号')
}

// 被测函数引用模块级 let sessionBridge：提取后经 vm context 注入桩，随用例替换。
function loadSessionBridgeFns(sessionBridge, ...names) {
  const code = stripTypeScriptTypes(
    names.map(functionSource).join('\n') +
      '\n;globalThis.__fns = {' + names.join(',') + '}',
    { mode: 'transform' },
  )
  const context = { Error, setTimeout, sessionBridge }
  vm.createContext(context)
  vm.runInContext(code, context)
  return context.__fns
}

test('retainSessionRef：sessions.retain 存在时调用并返回引用，options 固定 {source:\'worktable\'}', () => {
  const events = []
  const ref = { release: () => events.push(['release']) }
  const { retainSessionRef } = loadSessionBridgeFns({
    sessions: {
      retain: (id, opts) => { events.push(['retain', id, opts]); return ref },
    },
  }, 'retainSessionRef')

  const got = retainSessionRef('s1')

  assert.equal(got, ref)
  // opts 字面量在被测函数（vm realm）里创建，跨 realm 的 deepEqual 会因原型不同误判，按 JSON 比较
  assert.equal(JSON.stringify(events), JSON.stringify([['retain', 's1', { source: 'worktable' }]]))
})

test('retainSessionRef：sessions.retain 抛错时返回 null', () => {
  const { retainSessionRef } = loadSessionBridgeFns({
    sessions: {
      retain: () => { throw new Error('retain unsupported') },
    },
  }, 'retainSessionRef')

  assert.equal(retainSessionRef('s1'), null)
})

test('retainSessionRef：sessions 无 retain 方法时返回 null', () => {
  const { retainSessionRef } = loadSessionBridgeFns({ sessions: {} }, 'retainSessionRef')

  assert.equal(retainSessionRef('s1'), null)
})

test('retainSessionRef：sessionBridge 为 null 时返回 null', () => {
  const { retainSessionRef } = loadSessionBridgeFns(null, 'retainSessionRef')

  assert.equal(retainSessionRef('s1'), null)
})

test('releaseSessionRef：空引用不抛错', () => {
  const { releaseSessionRef } = loadSessionBridgeFns(null, 'releaseSessionRef')

  assert.doesNotThrow(() => releaseSessionRef(null))
  assert.doesNotThrow(() => releaseSessionRef(undefined))
})

test('releaseSessionRef：正常调用引用的 release', () => {
  const events = []
  const { releaseSessionRef } = loadSessionBridgeFns(null, 'releaseSessionRef')

  releaseSessionRef({ release: () => events.push(['release']) })

  assert.deepEqual(events, [['release']])
})

test('releaseSessionRef：release 抛错被吞', () => {
  const { releaseSessionRef } = loadSessionBridgeFns(null, 'releaseSessionRef')

  assert.doesNotThrow(() => releaseSessionRef({ release: () => { throw new Error('boom') } }))
})

test('openSessionInUi：uiWorkspace.openSession 存在时走它，不再调 sessions.open', () => {
  const events = []
  const { openSessionInUi } = loadSessionBridgeFns({
    uiWorkspace: { openSession: (id) => events.push(['uiWorkspace.openSession', id]) },
    sessions: { open: (id) => events.push(['sessions.open', id]) },
  }, 'openSessionInUi')

  openSessionInUi('s1')

  assert.deepEqual(events, [['uiWorkspace.openSession', 's1']])
})

test('openSessionInUi：无 uiWorkspace 时回退 sessions.open', () => {
  const events = []
  const { openSessionInUi } = loadSessionBridgeFns({
    sessions: { open: (id) => events.push(['sessions.open', id]) },
  }, 'openSessionInUi')

  openSessionInUi('s1')

  assert.deepEqual(events, [['sessions.open', 's1']])
})

test('openSessionInUi：两条打开路径都不可用时静默不抛', () => {
  const missing = loadSessionBridgeFns({ sessions: {} }, 'openSessionInUi')
  const nulled = loadSessionBridgeFns(null, 'openSessionInUi')

  assert.doesNotThrow(() => missing.openSessionInUi('s1'))
  assert.doesNotThrow(() => nulled.openSessionInUi('s1'))
})

test('currentSessionIdOf：旧形态快照的 current 字段原样返回', () => {
  const { currentSessionIdOf } = loadSessionBridgeFns(null, 'currentSessionIdOf')

  assert.equal(currentSessionIdOf({ current: 's1' }), 's1')
})

test('currentSessionIdOf：新形态快照取 retainedBy.mainView>0 的行 id', () => {
  const { currentSessionIdOf } = loadSessionBridgeFns(null, 'currentSessionIdOf')

  const snap = { byId: { a: { retainedBy: { mainView: 1 } }, b: { retainedBy: { sidebarView: 2 } }, c: {} } }
  assert.equal(currentSessionIdOf(snap), 'a')
})

test('currentSessionIdOf：byId 无 mainView 行时返回空串', () => {
  const { currentSessionIdOf } = loadSessionBridgeFns(null, 'currentSessionIdOf')

  assert.equal(currentSessionIdOf({ byId: { b: { retainedBy: { sidebarView: 2 } }, c: {} } }), '')
  assert.equal(currentSessionIdOf({ byId: {} }), '')
})

test('currentSessionIdOf：空快照与访问异常时返回空串', () => {
  const { currentSessionIdOf } = loadSessionBridgeFns(null, 'currentSessionIdOf')
  const evil = { get byId() { throw new Error('boom') } }

  assert.equal(currentSessionIdOf(null), '')
  assert.equal(currentSessionIdOf(undefined), '')
  assert.equal(currentSessionIdOf(evil), '')
})

test('fillSessionDraft：会话未 retain 时先 retain 再写草稿，结束后释放引用', async () => {
  const events = []
  const ref = { release: () => events.push(['release']) }
  let retained = false
  // 0.2.0-rc.1 语义：未 retain 的会话 binding(id) 解析为 undefined，retain 之后才拿到 binding
  const { fillSessionDraft } = loadSessionBridgeFns({
    sessions: {
      retain: (id, opts) => { events.push(['retain', id, opts]); retained = true; return ref },
      binding: (id) => { events.push(['binding', id]); return retained ? { ctx: { sessionId: id } } : undefined },
    },
    conversation: {
      input: { for: (ctx) => ({ setDraft: (text) => events.push(['setDraft', ctx.sessionId, text]) }) },
    },
  }, 'fillSessionDraft', 'retainSessionRef', 'releaseSessionRef')

  await fillSessionDraft('s1', '草稿文本')

  const retainAt = events.findIndex((e) => e[0] === 'retain')
  const draftAt = events.findIndex((e) => e[0] === 'setDraft')
  assert.ok(retainAt >= 0, 'fillSessionDraft 应先调用 sessions.retain')
  assert.equal(JSON.stringify(events[retainAt]), JSON.stringify(['retain', 's1', { source: 'worktable' }]))
  assert.ok(draftAt > retainAt, 'setDraft 应发生在 retain 之后')
  assert.equal(JSON.stringify(events[draftAt]), JSON.stringify(['setDraft', 's1', '草稿文本']))
  assert.ok(events.some((e) => e[0] === 'release'), 'fillSessionDraft 结束后应释放 retain 引用')
})
