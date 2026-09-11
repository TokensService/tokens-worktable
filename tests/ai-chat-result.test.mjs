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
  const brace = source.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') depth -= 1
    if (depth === 0) return source.slice(start, i + 1)
  }
  assert.fail('函数 ' + name + ' 缺少闭合括号')
}

function loadFunction(name) {
  const code = stripTypeScriptTypes(functionSource(name) + '\n;globalThis.__fn = ' + name, { mode: 'transform' })
  const context = { Array, String }
  vm.createContext(context)
  vm.runInContext(code, context)
  return context.__fn
}

function loadBridgeFunction(name, context) {
  const code = stripTypeScriptTypes(
    functionSource('assistantResultOutcome') + '\n' + functionSource(name) + '\n;globalThis.__fn = ' + name,
    { mode: 'transform' },
  )
  vm.createContext(context)
  vm.runInContext(code, context)
  return context.__fn
}

test('只从正常完成的最后一回合返回 AI 完整文本', () => {
  const assistantResultOutcome = loadFunction('assistantResultOutcome')
  const events = [
    { event: { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '旧回答' }] } } } },
    { event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
    { event: { type: 'user/message', data: { content: [{ type: 'text', text: '用户提示' }] } } },
    { event: { type: 'assistant/message', data: { turn: 2, message: { content: [
      { type: 'text', text: '第一段' },
      { type: 'tool-call', text: '不应回填' },
      { type: 'text', text: '第二段' },
    ] } } } },
    { event: { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } } },
  ]

  assert.equal(JSON.stringify(assistantResultOutcome(events)), JSON.stringify({ state: 'completed', text: '第一段\n第二段' }))
})

test('中止或错误回合即使已有 AI 文本也标记失败', () => {
  const assistantResultOutcome = loadFunction('assistantResultOutcome')
  const assistant = interrupted => ({ event: { type: 'assistant/message', data: {
    turn: 1, ...(interrupted ? { interrupted: true } : {}),
    message: { content: [{ type: 'text', text: '<dsh-release-config>{}</dsh-release-config>' }] },
  } } })

  assert.equal(assistantResultOutcome([
    assistant(true),
    { event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } } },
  ]).state, 'failed')
  assert.equal(assistantResultOutcome([
    assistant(false),
    { event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', message: 'boom' } } } },
  ]).state, 'failed')
})

test('等待 AI 会话完成后才读取并返回最终回答', async () => {
  let snapshot = { byId: { 'session-1': { running: true, completed: false } } }
  let entries = []
  const listListeners = new Set()
  const eventListeners = new Set()
  let eventReads = 0
  const eventSource = {
    getSnapshot() { eventReads += 1; return { entries } },
    subscribe(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn) },
  }
  const list = {
    getSnapshot: () => snapshot,
    subscribe(fn) { listListeners.add(fn); return () => listListeners.delete(fn) },
  }
  const context = {
    Array, String, Error, setTimeout, clearTimeout,
    sessionBridge: { list, sessions: { binding: id => id === 'session-1' ? { eventSource } : null } },
  }
  const waitForSessionAssistant = loadBridgeFunction('waitForSessionAssistant', context)

  const waiting = waitForSessionAssistant('session-1', 200)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(eventReads, 0, '运行中不得读取半成品回答')

  snapshot = { byId: { 'session-1': { running: false, completed: true } } }
  listListeners.forEach(fn => fn())
  assert.equal(eventReads, 1)

  entries = [
    { event: { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '最终建议' }] } } } },
    { event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
  ]
  eventListeners.forEach(fn => fn())

  assert.equal(await waiting, '最终建议')
})

test('当前选中的 AI 会话没有 completed 提醒标志时仍在停止后返回回答', async () => {
  let snapshot = { byId: { 'session-current': { running: true } } }
  const listeners = new Set()
  const eventSource = {
    getSnapshot() {
      return { entries: [
        { event: { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '已生成并完成' }] } } } },
        { event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
      ] }
    },
    subscribe() { return () => {} },
  }
  const list = {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
  const context = {
    Array, String, Error, setTimeout, clearTimeout,
    sessionBridge: { list, sessions: { binding: () => ({ eventSource }) } },
  }
  const waitForSessionAssistant = loadBridgeFunction('waitForSessionAssistant', context)
  const waiting = waitForSessionAssistant('session-current', 50)

  snapshot = { byId: { 'session-current': { running: false } } }
  listeners.forEach(fn => fn())

  assert.equal(await waiting, '已生成并完成')
})

test('结果桥新建右侧会话、自动发送并把最终 AI 文本返回调用页', async () => {
  const calls = []
  const context = {
    Error,
    sessionBridge: {
      sessions: {
        create: async options => { calls.push(['create', options]); return 'session-result' },
        open: async id => { calls.push(['open', id]) },
      },
    },
    defaultWorkspaceId: () => 'workspace-default',
    ensureSessionPreset: async id => { calls.push(['preset', id]) },
    ensureSessionModel: async id => { calls.push(['model', id]) },
    markPluginSessionOpen: id => { calls.push(['mark', id]) },
    promptIntoSession: async (id, text) => { calls.push(['prompt', id, text]) },
    waitForSessionAssistant: async id => { calls.push(['wait', id]); return 'AI 最终结果' },
  }
  const sendChatForResult = loadBridgeFunction('sendChatForResult', context)

  assert.equal(await sendChatForResult('请生成配置'), 'AI 最终结果')
  assert.equal(JSON.stringify(calls), JSON.stringify([
    ['create', { workspaceId: 'workspace-default' }],
    ['preset', 'session-result'],
    ['model', 'session-result'],
    ['mark', 'session-result'],
    ['open', 'session-result'],
    ['prompt', 'session-result', '请生成配置'],
    ['wait', 'session-result'],
  ]))
})
