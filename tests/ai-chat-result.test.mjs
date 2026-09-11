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
    functionSource('assistantResultText') + '\n' + functionSource(name) + '\n;globalThis.__fn = ' + name,
    { mode: 'transform' },
  )
  vm.createContext(context)
  vm.runInContext(code, context)
  return context.__fn
}

test('从会话历史中返回最后一条 AI 完整文本', () => {
  const assistantResultText = loadFunction('assistantResultText')
  const events = [
    { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回答' }] } } } },
    { event: { type: 'user/message', data: { content: [{ type: 'text', text: '用户提示' }] } } },
    { event: { type: 'assistant/message', data: { message: { content: [
      { type: 'text', text: '第一段' },
      { type: 'tool-call', text: '不应回填' },
      { type: 'text', text: '第二段' },
    ] } } } },
  ]

  assert.equal(assistantResultText(events), '第一段\n第二段')
})

test('等待 AI 会话完成后才读取并返回最终回答', async () => {
  let snapshot = { byId: { 'session-1': { running: true, completed: false } } }
  const listeners = new Set()
  let historyReads = 0
  const face = {
    async history() {
      historyReads += 1
      return { result: { ok: true, value: { events: [
        { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终建议' }] } } } },
      ] } } }
    },
  }
  const list = {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
  const context = {
    Array, String, Error, setTimeout, clearTimeout,
    sessionBridge: { list, sessions: { binding: id => id === 'session-1' ? { session: face } : null } },
  }
  const waitForSessionAssistant = loadBridgeFunction('waitForSessionAssistant', context)

  const waiting = waitForSessionAssistant('session-1', 200)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(historyReads, 0, '运行中不得读取半成品回答')

  snapshot = { byId: { 'session-1': { running: false, completed: true } } }
  listeners.forEach(fn => fn())

  assert.equal(await waiting, '最终建议')
})

test('当前选中的 AI 会话没有 completed 提醒标志时仍在停止后返回回答', async () => {
  let snapshot = { byId: { 'session-current': { running: true } } }
  const listeners = new Set()
  const face = {
    async history() {
      return { result: { ok: true, value: { events: [
        { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已生成并完成' }] } } } },
      ] } } }
    },
  }
  const list = {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
  const context = {
    Array, String, Error, setTimeout, clearTimeout,
    sessionBridge: { list, sessions: { binding: () => ({ session: face }) } },
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
