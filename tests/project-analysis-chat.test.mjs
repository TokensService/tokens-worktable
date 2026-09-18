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

function loadProjectChatFunctions() {
  const names = [
    'createProjectAnalysisChat',
    'requestProjectAnalysisChat',
    'resumeDeferredProjectAnalysisChat',
  ]
  const code = stripTypeScriptTypes(
    names.map(functionSource).join('\n') +
      '\n;globalThis.__fns = {' + names.join(',') + '}',
    { mode: 'transform' },
  )
  const context = { Error }
  vm.createContext(context)
  vm.runInContext(code, context)
  return context.__fns
}

function configuredDeps(events, chatClosed = true) {
  return {
    currentProjectId: () => 'pipeline-project',
    projectWorkspaceId: id => id === 'pipeline-project' ? 'workspace-pipeline' : null,
    workspaceExists: id => id === 'workspace-pipeline',
    defer: request => events.push(['defer', request]),
    isProjectSettingsVisible: () => true,
    revealProjectSettings: () => events.push(['expand-sidebar']),
    openWorkspaceSettings: id => events.push(['settings', id]),
    isSideChatClosed: () => chatClosed,
    openSideChat: () => events.push(['open-chat']),
    createChat: async (text, workspaceId, cwd) => events.push(['create', text, workspaceId, cwd]),
  }
}

test('项目已有工作区且侧边会话框关闭时，先打开会话框再在项目工作区创建分析会话', async () => {
  const { requestProjectAnalysisChat } = loadProjectChatFunctions()
  const events = []

  const result = await requestProjectAnalysisChat('分析提示词', '/archive/run-a', configuredDeps(events, true))

  assert.equal(result, 'created')
  assert.equal(JSON.stringify(events), JSON.stringify([
    ['open-chat'],
    ['create', '分析提示词', 'workspace-pipeline', '/archive/run-a'],
  ]))
})

test('侧边会话框已经打开时不重复切换，仍在项目工作区创建新会话', async () => {
  const { requestProjectAnalysisChat } = loadProjectChatFunctions()
  const events = []

  const result = await requestProjectAnalysisChat('Profiling 提示词', '/archive/run-b', configuredDeps(events, false))

  assert.equal(result, 'created')
  assert.equal(JSON.stringify(events), JSON.stringify([
    ['create', 'Profiling 提示词', 'workspace-pipeline', '/archive/run-b'],
  ]))
})

test('项目工作区未设置或已失效时暂存请求并弹出本项目工作区设置，不创建会话', async () => {
  const { requestProjectAnalysisChat } = loadProjectChatFunctions()
  for (const workspaceId of [null, 'workspace-deleted']) {
    const events = []
    const deps = configuredDeps(events)
    deps.projectWorkspaceId = () => workspaceId

    const result = await requestProjectAnalysisChat('性能诊断提示词', '/archive/run-c', deps)

    assert.equal(result, 'workspace-required')
    assert.equal(JSON.stringify(events), JSON.stringify([
      ['defer', { projectId: 'pipeline-project', text: '性能诊断提示词', cwd: '/archive/run-c' }],
      ['settings', 'pipeline-project'],
    ]))
  }
})

test('工作台左栏折叠时先展开左栏，再弹出项目工作区设置', async () => {
  const { requestProjectAnalysisChat } = loadProjectChatFunctions()
  const events = []
  const deps = configuredDeps(events)
  deps.projectWorkspaceId = () => null
  deps.isProjectSettingsVisible = () => false

  const result = await requestProjectAnalysisChat('日志分析提示词', '/archive/run-a', deps)

  assert.equal(result, 'workspace-required')
  assert.equal(JSON.stringify(events), JSON.stringify([
    ['defer', { projectId: 'pipeline-project', text: '日志分析提示词', cwd: '/archive/run-a' }],
    ['expand-sidebar'],
    ['settings', 'pipeline-project'],
  ]))
})

test('用户为同一项目选定工作区后，继续暂存的分析请求并创建会话', async () => {
  const { resumeDeferredProjectAnalysisChat } = loadProjectChatFunctions()
  const events = []
  const pending = { projectId: 'pipeline-project', text: '日志分析提示词', cwd: '/archive/run-a' }

  const resumed = await resumeDeferredProjectAnalysisChat(
    pending,
    'pipeline-project',
    'workspace-new',
    configuredDeps(events, true),
  )

  assert.equal(resumed, true)
  assert.equal(JSON.stringify(events), JSON.stringify([
    ['open-chat'],
    ['create', '日志分析提示词', 'workspace-new', '/archive/run-a'],
  ]))
})

test('工作区选择不属于暂存请求的项目时不得误建会话', async () => {
  const { resumeDeferredProjectAnalysisChat } = loadProjectChatFunctions()
  const events = []

  const resumed = await resumeDeferredProjectAnalysisChat(
    { projectId: 'pipeline-project', text: '日志分析提示词', cwd: '/archive/run-a' },
    'another-project',
    'workspace-other',
    configuredDeps(events, true),
  )

  assert.equal(resumed, false)
  assert.deepEqual(events, [])
})

test('当前没有打开工作台项目时明确拒绝创建项目分析会话', async () => {
  const { requestProjectAnalysisChat } = loadProjectChatFunctions()
  const deps = configuredDeps([])
  deps.currentProjectId = () => null

  await assert.rejects(
    requestProjectAnalysisChat('分析提示词', '/archive', deps),
    /current project unavailable/,
  )
})
