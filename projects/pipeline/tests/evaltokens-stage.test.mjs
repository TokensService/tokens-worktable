import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../pipeline.html', import.meta.url), 'utf8')

function extractFunction(name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const match = marker.exec(html)
  assert.ok(match, `pipeline.html 缺少函数 ${name}`)
  const start = match.index
  const bodyStart = html.indexOf('{', start)
  let depth = 0
  for (let i = bodyStart; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1
    if (html[i] === '}') {
      depth -= 1
      if (depth === 0) return html.slice(start, i + 1)
    }
  }
  throw new Error(`无法提取函数 ${name}`)
}

/* 多运行上下文：引擎函数（runEvaltokensStep/archiveRun 等）不再读写全局单例
   （curRun/runStages/nodes/selectedId/timer），改为接收运行上下文 rc 并用 rc.stages/rc.nodes/
   rc.timer/rc.vars/rc.token/rc.over。测试按运行时形状构造 rc。 */
function makeRc(overrides = {}) {
  return {
    id: 'run-test',
    stages: [],
    nodes: {},
    selId: '',
    timer: null,
    over: false,
    overall: null,
    token: 'run-token',
    vars: {},
    scriptAbort: null,
    ...overrides,
  }
}

function loadEvaltokensRuntime(overrides = {}) {
  const context = vm.createContext({
    console,
    encodeURIComponent,
    JSON,
    Object,
    String,
    Date,
    Error,
    Promise,
    Map,
    Set,
    AbortController,
    setTimeout,
    clearTimeout,
    archiveWrites: new Map(),
    archiveFolderFor: () => null,
    archiveTaskLog: async () => null,
    buildLog: stage => [stage._out?.stdout || ''],
    // 视图层桩：引擎经 runSetSel/rcRender/rcOverall 与视图交互，仅当 viewRc===rc 时落地渲染
    viewRc: null,
    selectedId: '',
    activeRuns: [],
    runSetSel: (rc, id) => { rc.selId = id },
    rcRender: () => {},
    rcOverall: (rc, txt, cls, color) => { rc.overall = { txt, cls, color: color || '' } },
    syncViewRun: () => {},
    syncRunState: () => {},
    viewActive: () => false,
    applyStatusClasses: () => {},
    renderFlow: () => {},
    renderDetail: () => {},
    ...overrides,
  })
  const names = [
    'sanitizeFsName',
    'evaltokensStageConfig',
    'normalizeStageKind',
    'evaltokHeaders',
    'evaltokRequestJson',
    'evaltokRequestText',
    'evaltokFetchTasks',
    'evaltokStartRun',
    'evaltokFetchRuns',
    'evaltokReportUrl',
    'evaltokFetchReport',
    'evaltokStatusKind',
    'detectEvaltokTaskParams',
    'detectEvaltokStageParams',
    'commitEvaltokParamValue',
    'stageSeq',
    'taskLogFile',
    'evaltokReportFile',
    'trackArchiveWrite',
    'waitArchiveWrites',
    'archiveEvaltokensReport',
    'archiveRun',
    'runEvaltokensStep',
  ]
  vm.runInContext(names.map(extractFunction).join('\n'), context)
  return context
}

function fakeElement(tagName = 'div') {
  return {
    tagName,
    children: [],
    attributes: {},
    style: {},
    className: '',
    appendChild(child) { this.children.push(child); child.parentElement = this; return child },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return this.attributes[name] },
    addEventListener(type, fn) { (this._handlers = this._handlers || {})[type] = fn },
  }
}

function findByDataField(element, field) {
  if (element.attributes?.['data-f'] === field) return element
  for (const child of element.children || []) {
    const found = findByDataField(child, field)
    if (found) return found
  }
  return null
}

function renderEvaltokensAction(stage, contextOverrides = {}) {
  const action = fakeElement()
  const row = fakeElement()
  row.querySelector = selector => selector === '[data-action]' ? action : null
  const wrap = fakeElement()
  wrap.children = [row]
  const document = {
    createElement: tag => fakeElement(tag),
    createTextNode: text => ({ textContent: text }),
  }
  const context = vm.createContext({
    document,
    editStages: [stage],
    $: id => id === 'plStageList' ? wrap : null,
    openEvaltokPicker: () => {},
    renderEvaltokPickerPanel: () => {},
    ...contextOverrides,
  })
  vm.runInContext([
    extractFunction('mkOutVarHelp'),
    extractFunction('renderStageActionRow'),
  ].join('\n'), context)
  context.renderStageActionRow(0)
  return action
}

/* 渲染 evaltokens 阶段参数区（renderStageParams）：返回 [data-params] 容器假元素 */
function renderEvaltokensParams(stage) {
  const paramsBox = fakeElement()
  const row = fakeElement()
  row.querySelector = selector => selector === '[data-params]' ? paramsBox : null
  const wrap = fakeElement()
  wrap.children = [row]
  const context = vm.createContext({
    document: {
      createElement: tag => fakeElement(tag),
      createTextNode: text => ({ textContent: text }),
    },
    editStages: [stage],
    $: id => id === 'plStageList' ? wrap : null,
  })
  vm.runInContext([
    extractFunction('commitEvaltokParamValue'),
    extractFunction('renderStageParams'),
  ].join('\n'), context)
  context.renderStageParams(0)
  return paramsBox
}

function findButtonByText(element, text) {
  if (element.tagName === 'button' && element.textContent === text) return element
  for (const child of element.children || []) {
    const found = findButtonByText(child, text)
    if (found) return found
  }
  return null
}

test('EvalTokens 报告收集默认开启，并保留用户关闭选择', () => {
  const context = loadEvaltokensRuntime()

  const legacy = context.normalizeStageKind({
    kind: 'evaltokens',
    evaltokens: { taskId: 'legacy-task', taskName: '旧任务', outVars: '' },
  })
  const disabled = context.evaltokensStageConfig({
    taskId: 'quiet-task', taskName: '不收集', outVars: '', collectReport: false,
  })

  assert.equal(legacy.evaltokens.collectReport, true)
  assert.equal(disabled.collectReport, false)
})

test('EvalTokens 阶段编辑器显示默认勾选且可回显关闭状态的报告选项', () => {
  const enabledAction = renderEvaltokensAction({
    kind: 'evaltokens',
    evaltokens: { taskId: 'task-enabled', taskName: '默认收集', outVars: '' },
  })
  const disabledAction = renderEvaltokensAction({
    kind: 'evaltokens',
    evaltokens: { taskId: 'task-disabled', taskName: '关闭收集', outVars: '', collectReport: false },
  })

  const enabled = findByDataField(enabledAction, 'etCollectReport')
  const disabled = findByDataField(disabledAction, 'etCollectReport')
  assert.ok(enabled, '阶段编辑器应提供“收集任务报告”复选框')
  assert.equal(enabled.type, 'checkbox')
  assert.equal(enabled.checked, true)
  assert.equal(disabled.checked, false)
})

test('EvalTokens 阶段配置持久化用户设置的参数覆盖值（values）', () => {
  const context = loadEvaltokensRuntime()

  const cfg = context.evaltokensStageConfig({ taskId: 'task-1', taskName: '任务一', values: { model: 'qwen3', batch: 8 } })
  assert.deepEqual(cfg.values, { model: 'qwen3', batch: '8' })
  assert.deepEqual(context.evaltokensStageConfig(null).values, {})

  const stage = context.normalizeStageKind({
    kind: 'evaltokens',
    evaltokens: { taskId: 'task-1', values: { model: 'qwen3' }, params: [{ key: 'model', label: 'model', def: 'qwen', required: false }] },
  })
  assert.deepEqual(stage.evaltokens.values, { model: 'qwen3' })
  assert.deepEqual(stage.evaltokens.params, [{ key: 'model', label: 'model', def: 'qwen', required: false }], '编辑器内识别到的 params 仍为瞬态保留')
})

test('commitEvaltokParamValue：设置新值写入 values，清空或改回任务原值即删除', () => {
  const context = loadEvaltokensRuntime()
  const et = { values: { model: 'qwen3' } }

  context.commitEvaltokParamValue(et, 'model', 'qwen-max', 'qwen')
  assert.equal(et.values.model, 'qwen-max')
  context.commitEvaltokParamValue(et, 'batch', '16', '8')
  assert.equal(et.values.batch, '16')
  context.commitEvaltokParamValue(et, 'model', 'qwen', 'qwen')   // 改回与任务原值一致 → 删除显式值
  assert.equal('model' in et.values, false)
  context.commitEvaltokParamValue(et, 'batch', '', '8')           // 清空 → 删除显式值
  assert.deepEqual(et.values, {})

  const bare = {}
  context.commitEvaltokParamValue(bare, 'a', '1', '')
  assert.deepEqual(bare.values, { a: '1' }, 'values 缺失时自动创建')
})

test('EvalTokens 任务输入参数渲染为可编辑输入框，改动写入 values', () => {
  const stage = {
    kind: 'evaltokens',
    evaltokens: {
      taskId: 'task-edit', taskName: '可编辑任务',
      values: { model: 'qwen3' },
      params: [
        { key: 'model', label: 'model', def: 'qwen', required: false },
        { key: 'batch', label: 'batch', def: '8', required: false },
      ],
    },
  }
  const box = renderEvaltokensParams(stage)
  const labels = box.children.filter(c => c.tagName === 'label')
  assert.equal(labels.length, 2)
  const modelInput = labels[0].children.find(c => c.tagName === 'input')
  const batchInput = labels[1].children.find(c => c.tagName === 'input')
  assert.equal(modelInput.getAttribute('data-etpkey'), 'model')
  assert.equal(batchInput.getAttribute('data-etpkey'), 'batch')
  assert.equal(modelInput.value, 'qwen3', '已设置的值优先展示')
  assert.equal(batchInput.value, '8', '未设置的展示任务原值')
  assert.equal(modelInput.readOnly, undefined, '参数框可编辑（不再只读）')
  assert.equal(batchInput.readOnly, undefined)

  modelInput.value = 'qwen-max'
  modelInput._handlers.change()
  assert.equal(stage.evaltokens.values.model, 'qwen-max', '修改后写入 values')
  modelInput.value = 'qwen'
  modelInput._handlers.change()
  assert.equal('model' in stage.evaltokens.values, false, '改回任务原值即删除显式值')
})

test('EvalTokens 动作行「识别参数」按钮清缓存并强制重新识别（保留已设值语义）', () => {
  const calls = []
  const stage = {
    kind: 'evaltokens',
    evaltokens: { taskId: 'task-redetect', taskName: '重识别', values: { model: 'qwen3' }, params: [] },
  }
  const action = renderEvaltokensAction(stage, {
    evaltokTasksCache: { tasks: [{ task_id: 'task-redetect' }], ts: 123 },
    detectEvaltokStageParams: (i, keepOnError) => { calls.push([i, keepOnError]) },
  })
  const btn = findButtonByText(action, '识别参数')
  assert.ok(btn, '动作行应提供「识别参数」按钮')
  btn._handlers.click()
  assert.deepEqual(calls, [[0, false]], '手动触发重新识别（失败时清空参数定义）')
})

test('EvalTokens 重新识别参数刷新定义与任务原值，已设置的值保留不刷新', async () => {
  const stage = {
    kind: 'evaltokens',
    evaltokens: {
      taskId: 'task-merge', taskName: '',
      values: { model: 'qwen3' },
      params: [{ key: 'model', label: 'model', def: 'qwen', required: false }],
    },
  }
  const renders = []
  const context = loadEvaltokensRuntime({
    editStages: [stage],
    evaltokFetchTasksCached: async () => [{ task_id: 'task-merge', name: '合并任务', input: { model: 'qwen2.5', batch: 8 } }],
    renderStageParams: () => renders.push(1),
  })

  await context.detectEvaltokStageParams(0, false)

  assert.deepEqual(stage.evaltokens.params.map(p => [p.key, p.def]), [['model', 'qwen2.5'], ['batch', '8']], '参数定义与原值已刷新')
  assert.deepEqual(stage.evaltokens.values, { model: 'qwen3' }, '已设置的参数值不被识别结果刷新')
  assert.equal(renders.length, 1)
})

test('EvalTokens 识别不到任务时清空参数定义，但已设置的值仍保留', async () => {
  const stage = {
    kind: 'evaltokens',
    evaltokens: {
      taskId: 'task-gone',
      values: { model: 'qwen3' },
      params: [{ key: 'model', label: 'model', def: 'qwen', required: false }],
    },
  }
  const context = loadEvaltokensRuntime({
    editStages: [stage],
    evaltokFetchTasksCached: async () => [],
    renderStageParams: () => {},
  })

  await context.detectEvaltokStageParams(0, false)
  assert.deepEqual(stage.evaltokens.params, [])
  assert.deepEqual(stage.evaltokens.values, { model: 'qwen3' })

  stage.evaltokens.params = [{ key: 'model', label: 'model', def: 'qwen', required: false }]
  await context.detectEvaltokStageParams(0, true)   // keepOnError：编辑器打开时的自动识别保留参数定义
  assert.equal(stage.evaltokens.params.length, 1)
  assert.deepEqual(stage.evaltokens.values, { model: 'qwen3' })
})

test('EvalTokens 启动 run 时下发已设置的输入参数覆盖（支持 ${VAR} 引用）', async () => {
  const calls = []
  let advancedTo = null
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const stage = {
    id: 'eval-params',
    name: '带参任务',
    timeout: null,
    evaltokens: {
      taskId: 'task-params', taskName: 'params-task', outVars: '',
      values: { model: '${MODEL_NAME}', batch: '16', unused: '${UNDEFINED_VAR}' },
    },
  }
  const rc = makeRc({ stages: [stage], vars: { MODEL_NAME: 'qwen3' } })
  const context = loadEvaltokensRuntime({
    substRunVars: (value, runCtx) => value.replace(/\$\{MODEL_NAME\}/g, runCtx.vars.MODEL_NAME).replace(/\$\{UNDEFINED_VAR\}/g, ''),
    evaltokConfig: () => evaltokConfig,
    fetch: async (url, options = {}) => {
      calls.push({ url, options })
      if (url.endsWith('/api/open/v1/tasks')) return jsonResponse({ tasks: [{ task_id: 'task-params', name: 'params-task' }] })
      if (url.endsWith('/api/open/v1/tasks/task-params/run')) return jsonResponse({ run_id: 'run-params', task_id: 'task-params', status: 'running' })
      return jsonResponse({ runs: [{ run_id: 'run-params', task_id: 'task-params', status: 'success' }] })
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: fn => { fn(); return 1 },
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: (_rc, index) => { advancedTo = index },
    finish: (_rc, status) => { throw new Error(`unexpected finish: ${status}`) },
  })

  await context.runEvaltokensStep(rc, 0)

  const runCall = calls.find(c => c.url.endsWith('/run'))
  assert.deepEqual(JSON.parse(runCall.options.body), { input: { model: 'qwen3', batch: '16' } }, '已设置的值经 ${VAR} 替换后随 run 请求体下发；替换为空的不下发')
  assert.match(stage._out.stdout, /# input: .*qwen3/)
  assert.equal(rc.nodes['eval-params'].status, 'success')
  assert.equal(advancedTo, 1)
})

test('EvalTokens 任务终态后把 HTML 报告原文归档，并在回显中打印报告地址', async () => {
  const writes = []
  const reportRequests = []
  let advancedTo = null
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const finalRun = {
    run_id: 'run/2026 09',
    task_id: 'task-report',
    status: 'success',
    result: { score: 0.98, cases: [1, 2] },
  }
  const report = '<!DOCTYPE html>\n<html><body><h1>EvalTokens Report</h1></body></html>'
  const stage = {
    id: 'eval-report',
    name: '精度 报告',
    timeout: null,
    evaltokens: { taskId: 'task-report', taskName: 'report-task', outVars: '' },
  }
  const rc = makeRc({ stages: [stage], archive: '/archive/pipeline_20260908', tag: 'build-9' })
  const context = loadEvaltokensRuntime({
    console: { warn: () => {} },
    substRunVars: value => value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url) => {
      if (url.endsWith('/api/open/v1/tasks')) return jsonResponse({ tasks: [{ task_id: 'task-report', name: 'report-task' }] })
      if (url.endsWith('/api/open/v1/tasks/task-report/run')) return jsonResponse({ run_id: finalRun.run_id, task_id: 'task-report', status: 'running' })
      if (url.includes('/api/open/v1/tasks/runs?task_id=task-report')) return jsonResponse({ runs: [finalRun] })
      if (url.includes('/api/v1/report?task_id=')) { reportRequests.push(url); return htmlResponse(report) }
      throw new Error(`unexpected request: ${url}`)
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: fn => { fn(); return 1 },
    archiveFolderFor: ctx => ctx.archive,
    ensureArchiveFolder: async () => true,
    apiWrite: async (path, content) => { writes.push({ path, content }) },
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: (_rc, index) => { advancedTo = index },
    finish: (_rc, status) => { throw new Error(`unexpected finish: ${status}`) },
  })

  await context.runEvaltokensStep(rc, 0)
  await Promise.all(rc.evaltokensReportWrites)

  assert.deepEqual(reportRequests, ['http://evaltokens.local/api/v1/report?task_id=run%2F2026%2009'])
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/archive/pipeline_20260908/run-build-9-01-精度-报告-evaltokens-run-2026-09-report.html')
  assert.equal(writes[0].content, report)
  assert.match(stage._out.stdout, /任务报告（EvalTokens 服务）→ http:\/\/evaltokens\.local\/api\/v1\/report\?task_id=run%2F2026%2009/)
  assert.match(stage._out.stdout, /任务报告已归档/)
  assert.equal(advancedTo, 1)
})

test('报告归档从建目录开始纳入写入跟踪', async () => {
  let releaseMkdir
  const mkdirPending = new Promise(resolve => { releaseMkdir = resolve })
  const context = loadEvaltokensRuntime({
    archiveFolderFor: ctx => ctx.archive,
    fetch: async () => htmlResponse('<!DOCTYPE html><title>tracked</title>'),
    ensureArchiveFolder: () => mkdirPending,
    apiWrite: async () => {},
  })
  const run = { run_id: 'tracked-run', task_id: 'tracked-task', status: 'success' }

  const pending = context.archiveEvaltokensReport(
    { url: 'http://evaltokens.local', token: '', mode: 'local' },
    { archive: '/archive/tracked', tag: 'tracked' }, 1, '跟踪报告', run.run_id,
  )

  assert.equal(context.archiveWrites.get('/archive/tracked')?.size, 1)
  releaseMkdir(true)
  await pending
  await Promise.resolve()
  assert.equal(context.archiveWrites.has('/archive/tracked'), false)
})

test('运行汇总归档等待 EvalTokens 报告后再写文件', async () => {
  let releaseReport
  const reportPending = new Promise(resolve => { releaseReport = resolve })
  const writes = []
  const stageOut = { stdout: '📦 任务报告归档中', stderr: '', code: 0, evaltokens: true, done: true }
  const reportState = { attempt: 1, logFile: null }
  const stage = {
    id: 'eval-summary', name: '汇总报告', kind: 'evaltokens', _out: stageOut,
    _evaltokAttempt: 1, _reportPendingAttempt: 1, _reportArchiveState: reportState,
  }
  const reportSettled = reportPending.then(() => {
    stageOut.stdout = '📦 任务报告已归档 → /archive/ordered/report.html'
    reportState.logFile = '/archive/ordered/run-ordered-01-汇总报告.log'
    stage._logArchived = true
    stage._reportPendingAttempt = null
  })
  const rc = makeRc({
    stages: [stage],
    nodes: { 'eval-summary': { status: 'success', progress: 100, dur: 1, varsOut: {} } },
    archive: '/archive/ordered', tag: 'ordered', startTs: Date.now(),
    evaltokensReportWrites: [reportSettled],
  })
  const context = loadEvaltokensRuntime({
    archiveFolderFor: ctx => ctx.archive,
    archiveStageLog: () => {},
    ensureArchiveFolder: async () => true,
    apiWrite: async (path, content) => { writes.push({ path, content }) },
    archiveScriptName: '',
    archiveConfigured: () => false,
    scriptByName: () => null,
    curPipeline: () => ({ name: '测试流水线' }),
  })

  context.archiveRun(rc, 'success')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writes.length, 0, '报告完成前不能先写汇总并启动后续归档链')

  releaseReport()
  await context.waitArchiveWrites('/archive/ordered')
  assert.deepEqual(writes.map(write => write.path), [
    '/archive/ordered/run-ordered.log',
    '/archive/ordered/run-ordered.profile.json',
  ])
  const logWrite = writes.find(write => write.path.endsWith('.log'))
  const profileWrite = writes.find(write => write.path.endsWith('.profile.json'))
  assert.ok(logWrite)
  assert.ok(profileWrite)
  assert.match(logWrite.content, /任务报告已归档/)
  assert.doesNotMatch(logWrite.content, /任务报告归档中/)
  assert.equal(JSON.parse(profileWrite.content).stages[0].logFile, '/archive/ordered/run-ordered-01-汇总报告.log')
})

test('同一运行失败后重试时，旧汇总不能覆盖最新成功结果', async () => {
  let releaseOldReport
  const oldReportPending = new Promise(resolve => { releaseOldReport = resolve })
  const writes = []
  const stages = [{ id: 'eval-retry', name: '重试阶段', kind: 'evaltokens', _out: { stdout: 'old failed' } }]
  const nodes = { 'eval-retry': { status: 'failed', progress: 100, dur: 2, varsOut: {} } }
  const rc = makeRc({
    stages, nodes,
    archive: '/archive/retry', tag: 'retry', startTs: Date.now(),
    evaltokensReportWrites: [oldReportPending],
  })
  const context = loadEvaltokensRuntime({
    archiveFolderFor: ctx => ctx.archive,
    archiveStageLog: () => {},
    ensureArchiveFolder: async () => true,
    apiWrite: async (path, content) => { writes.push({ path, content }) },
    archiveScriptName: '',
    archiveConfigured: () => false,
    scriptByName: () => null,
    curPipeline: () => ({ name: '测试流水线' }),
  })

  context.archiveRun(rc, 'failed')
  stages[0] = { id: 'eval-retry', name: '重试阶段', kind: 'evaltokens', _out: { stdout: 'new success' } }
  nodes['eval-retry'] = { status: 'success', progress: 100, dur: 1, varsOut: {} }
  rc.evaltokensReportWrites = []
  context.archiveRun(rc, 'success')
  await new Promise(resolve => setImmediate(resolve))
  releaseOldReport()
  await context.waitArchiveWrites('/archive/retry')

  const latestByPath = new Map(writes.map(write => [write.path, write.content]))
  assert.match(latestByPath.get('/archive/retry/run-retry.log'), /new success/)
  assert.doesNotMatch(latestByPath.get('/archive/retry/run-retry.log'), /old failed/)
  assert.equal(JSON.parse(latestByPath.get('/archive/retry/run-retry.profile.json')).result, 'success')
})

test('终态先落到阶段并继续流水线，报告慢归档在后台完成', async () => {
  let releaseMkdir
  let mkdirStarted
  const started = new Promise(resolve => { mkdirStarted = resolve })
  const mkdirPending = new Promise(resolve => { releaseMkdir = resolve })
  let advancedTo = null
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const stage = {
    id: 'eval-slow-report',
    name: '慢报告',
    timeout: null,
    evaltokens: { taskId: 'task-slow-report', taskName: 'slow-report', outVars: '' },
  }
  const rc = makeRc({ stages: [stage], archive: '/archive/run', tag: 'build-12' })
  const context = loadEvaltokensRuntime({
    substRunVars: value => value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url) => {
      if (url.endsWith('/api/open/v1/tasks')) return jsonResponse({ tasks: [{ task_id: 'task-slow-report', name: 'slow-report' }] })
      if (url.endsWith('/api/open/v1/tasks/task-slow-report/run')) return jsonResponse({ run_id: 'run-slow-report', status: 'running' })
      return jsonResponse({ runs: [{ run_id: 'run-slow-report', task_id: 'task-slow-report', status: 'success' }] })
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: fn => { fn(); return 1 },
    buildLog: st => [st._out.stdout],
    archiveFolderFor: ctx => ctx.archive,
    ensureArchiveFolder: () => { mkdirStarted(); return mkdirPending },
    apiWrite: async () => {},
    archiveStageLog: () => {},
    archiveTaskLog: async () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: (_rc, index) => { advancedTo = index },
    finish: (_rc, status) => { throw new Error(`unexpected finish: ${status}`) },
  })

  const stageRun = context.runEvaltokensStep(rc, 0)
  await started

  assert.equal(rc.nodes['eval-slow-report'].status, 'success')
  assert.equal(advancedTo, 1)
  assert.equal(rc.evaltokensReportWrites.length, 1)

  releaseMkdir(true)
  await stageRun
  await Promise.all(rc.evaltokensReportWrites)
  assert.match(stage._out.stdout, /任务报告已归档/)
})

test('EvalTokens 失败终态不等待慢报告，且旧报告回调不污染重试', async () => {
  let releaseMkdir
  let mkdirStarted
  const started = new Promise(resolve => { mkdirStarted = resolve })
  const mkdirPending = new Promise(resolve => { releaseMkdir = resolve })
  let finishedAs = null
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const finalRun = { run_id: 'run-failed-report', task_id: 'task-failed-report', status: 'failed', error: 'score too low' }
  const archivedStageTexts = []
  const stage = {
    id: 'eval-failed-report',
    name: '失败报告',
    timeout: null,
    evaltokens: { taskId: finalRun.task_id, taskName: 'failed-report', outVars: '' },
  }
  const rc = makeRc({ stages: [stage], archive: '/archive/run', tag: 'build-13' })
  const context = loadEvaltokensRuntime({
    substRunVars: value => value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url) => {
      if (url.endsWith('/api/open/v1/tasks')) return jsonResponse({ tasks: [{ task_id: finalRun.task_id, name: 'failed-report' }] })
      if (url.endsWith('/api/open/v1/tasks/task-failed-report/run')) return jsonResponse({ run_id: finalRun.run_id, status: 'running' })
      return jsonResponse({ runs: [finalRun] })
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: fn => { fn(); return 1 },
    archiveFolderFor: ctx => ctx.archive,
    ensureArchiveFolder: () => { mkdirStarted(); return mkdirPending },
    apiWrite: async () => {},
    archiveStageLog: () => {},
    archiveTaskLog: async (_ctx, _seq, _name, text) => {
      archivedStageTexts.push(text)
      return '/archive/run/old-attempt.log'
    },
    buildLog: st => [st._out.stdout],
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: (_rc, index) => { throw new Error(`unexpected advance: ${index}`) },
    finish: (_rc, status) => { finishedAs = status },
  })

  const stageRun = context.runEvaltokensStep(rc, 0)
  await started

  assert.equal(rc.nodes['eval-failed-report'].status, 'failed')
  assert.equal(finishedAs, 'failed')
  assert.equal(rc.evaltokensReportWrites.length, 1)

  stage._evaltokAttempt = (stage._evaltokAttempt || 0) + 1
  stage._out = { stdout: '$ EvalTokens run second-attempt', stderr: '', code: null, evaltokens: true, done: false }
  stage._logArchived = false
  releaseMkdir(true)
  await stageRun
  await Promise.all(rc.evaltokensReportWrites)
  assert.equal(stage._out.stdout, '$ EvalTokens run second-attempt')
  assert.equal(stage._logArchived, false)
  assert.deepEqual(archivedStageTexts, [])
})

test('关闭收集任务报告后不写报告文件', async () => {
  let writes = 0
  const requests = []
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const stage = {
    id: 'eval-no-report',
    name: '不收集报告',
    timeout: null,
    evaltokens: { taskId: 'task-no-report', taskName: 'no-report', outVars: '', collectReport: false },
  }
  const rc = makeRc({ stages: [stage], archive: '/archive/run', tag: 'build-10' })
  const context = loadEvaltokensRuntime({
    substRunVars: value => value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url) => {
      requests.push(url)
      if (url.endsWith('/api/open/v1/tasks')) return jsonResponse({ tasks: [{ task_id: 'task-no-report', name: 'no-report' }] })
      if (url.endsWith('/api/open/v1/tasks/task-no-report/run')) return jsonResponse({ run_id: 'run-no-report', status: 'running' })
      return jsonResponse({ runs: [{ run_id: 'run-no-report', task_id: 'task-no-report', status: 'success' }] })
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: fn => { fn(); return 1 },
    archiveFolderFor: ctx => ctx.archive,
    ensureArchiveFolder: async () => true,
    apiWrite: async () => { writes += 1 },
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: () => {},
    finish: (_rc, status) => { throw new Error(`unexpected finish: ${status}`) },
  })

  await context.runEvaltokensStep(rc, 0)

  assert.equal(writes, 0)
  assert.equal(requests.filter(url => url.includes('/api/v1/report?task_id=')).length, 0)
  assert.doesNotMatch(stage._out.stdout, /任务报告已归档/)
})

test('任务报告写入失败只记入回显，不改变 EvalTokens 成功结果', async () => {
  let advancedTo = null
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const stage = {
    id: 'eval-report-error',
    name: '报告写入失败',
    timeout: null,
    evaltokens: { taskId: 'task-report-error', taskName: 'report-error', outVars: '' },
  }
  const rc = makeRc({ stages: [stage], archive: '/archive/run', tag: 'build-11' })
  const context = loadEvaltokensRuntime({
    console: { warn: () => {} },
    substRunVars: value => value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url) => {
      if (url.endsWith('/api/open/v1/tasks')) return jsonResponse({ tasks: [{ task_id: 'task-report-error', name: 'report-error' }] })
      if (url.endsWith('/api/open/v1/tasks/task-report-error/run')) return jsonResponse({ run_id: 'run-report-error', status: 'running' })
      return jsonResponse({ runs: [{ run_id: 'run-report-error', task_id: 'task-report-error', status: 'success' }] })
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: fn => { fn(); return 1 },
    archiveFolderFor: ctx => ctx.archive,
    ensureArchiveFolder: async () => true,
    apiWrite: async () => { throw new Error('disk full') },
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: (_rc, index) => { advancedTo = index },
    finish: (_rc, status) => { throw new Error(`unexpected finish: ${status}`) },
  })

  await context.runEvaltokensStep(rc, 0)
  await Promise.all(rc.evaltokensReportWrites)

  assert.equal(rc.nodes['eval-report-error'].status, 'success')
  assert.equal(advancedTo, 1)
  assert.match(stage._out.stdout, /任务报告归档失败.*disk full/)
})

test('任务报告查询失败时不写报告，且不改变 EvalTokens 成功结果', async () => {
  let writes = 0
  let advancedTo = null
  const reportRequests = []
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const stage = {
    id: 'eval-report-fetch-error',
    name: '报告查询失败',
    timeout: null,
    evaltokens: { taskId: 'task-report-fetch-error', taskName: 'report-fetch-error', outVars: '' },
  }
  const rc = makeRc({ stages: [stage], archive: '/archive/run', tag: 'build-14' })
  const context = loadEvaltokensRuntime({
    console: { warn: () => {} },
    substRunVars: value => value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url) => {
      if (url.endsWith('/api/open/v1/tasks')) return jsonResponse({ tasks: [{ task_id: 'task-report-fetch-error', name: 'report-fetch-error' }] })
      if (url.endsWith('/api/open/v1/tasks/task-report-fetch-error/run')) return jsonResponse({ run_id: 'run-report-fetch-error', status: 'running' })
      if (url.includes('/api/open/v1/tasks/runs?task_id=task-report-fetch-error')) {
        return jsonResponse({ runs: [{ run_id: 'run-report-fetch-error', task_id: 'task-report-fetch-error', status: 'success' }] })
      }
      if (url.includes('/api/v1/report?task_id=run-report-fetch-error')) {
        reportRequests.push(url)
        return jsonResponse({ message: 'report unavailable' }, 503)
      }
      throw new Error(`unexpected request: ${url}`)
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: fn => { fn(); return 1 },
    archiveFolderFor: ctx => ctx.archive,
    ensureArchiveFolder: async () => true,
    apiWrite: async () => { writes += 1 },
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: (_rc, index) => { advancedTo = index },
    finish: (_rc, status) => { throw new Error(`unexpected finish: ${status}`) },
  })

  await context.runEvaltokensStep(rc, 0)
  await Promise.all(rc.evaltokensReportWrites)

  assert.deepEqual(reportRequests, ['http://evaltokens.local/api/v1/report?task_id=run-report-fetch-error'])
  assert.equal(writes, 0)
  assert.equal(rc.nodes['eval-report-fetch-error'].status, 'success')
  assert.equal(advancedTo, 1)
  assert.match(stage._out.stdout, /任务报告归档失败.*report unavailable.*HTTP 503/)
})

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body) },
    async json() { return body },
  }
}

function htmlResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body },
    async json() { return JSON.parse(body) },
  }
}

test('EvalTokens 阶段启动新 run，并只等待返回的 run_id', async () => {
  const calls = []
  let runPolls = 0
  let advancedTo = null
  let finishedAs = null
  const evaltokConfig = { url: 'http://evaltokens.local', token: 'api-token', mode: 'local' }
  const stage = {
    id: 'eval-stage',
    name: 'PCT60-预热',
    timeout: null,
    evaltokens: { taskId: 'task/a b', taskName: 'warmup', outVars: '' },
  }
  const rc = makeRc({ stages: [stage] })
  const context = loadEvaltokensRuntime({
    substRunVars: value => value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url, options = {}) => {
      calls.push({ url, options })
      if (url.endsWith('/api/open/v1/tasks')) {
        return jsonResponse({ tasks: [{ task_id: 'task/a b', name: 'warmup' }] })
      }
      if (url.endsWith('/api/open/v1/tasks/task%2Fa%20b/run')) {
        return jsonResponse({ run_id: 'run-new', task_id: 'task/a b', status: 'running' })
      }
      if (url.includes('/api/open/v1/tasks/runs?task_id=task%2Fa%20b')) {
        runPolls += 1
        return jsonResponse({
          runs: [
            { run_id: 'run-old', task_id: 'task/a b', status: 'success' },
            { run_id: 'run-new', task_id: 'task/a b', status: runPolls === 1 ? 'running' : 'success' },
          ],
        })
      }
      throw new Error(`unexpected request: ${url}`)
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: fn => { fn(); return 1 },
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: (_rc, index) => { advancedTo = index },
    finish: (_rc, status) => { finishedAs = status },
  })

  await context.runEvaltokensStep(rc, 0)

  assert.equal(calls[1].options.method, 'POST')
  assert.equal(calls[1].options.headers.Authorization, 'Bearer api-token')
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json')
  assert.equal(calls[1].options.body, '{}')
  assert.equal(runPolls, 2, '旧 run 的成功状态不能让阶段提前结束')
  assert.equal(rc.nodes['eval-stage'].status, 'success')
  assert.equal(advancedTo, 1)
  assert.equal(finishedAs, null)
  assert.match(stage._out.stdout, /run-new/)
})

test('远程模式通过 worktable proxy 转发启动请求', async () => {
  const calls = []
  const context = loadEvaltokensRuntime({
    fetch: async (url, options = {}) => {
      calls.push({ url, options })
      return jsonResponse({ status: 201, body: JSON.stringify({ run_id: 'run-remote', status: 'running' }) })
    },
  })

  const run = await context.evaltokStartRun({
    url: 'http://192.168.1.101:9000',
    token: 'remote-token',
    mode: 'remote',
  }, 'task-remote')

  assert.equal(run.run_id, 'run-remote')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/worktable/proxy')
  const forwarded = JSON.parse(calls[0].options.body)
  assert.deepEqual(forwarded, {
    url: 'http://192.168.1.101:9000/api/open/v1/tasks/task-remote/run',
    method: 'POST',
    headers: {
      Authorization: 'Bearer remote-token',
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
})

test('远程模式通过 worktable proxy 携带 Bearer 令牌查询通用报告接口', async () => {
  const calls = []
  const report = '<!DOCTYPE html><html><body>remote report</body></html>'
  const context = loadEvaltokensRuntime({
    fetch: async (url, options = {}) => {
      calls.push({ url, options })
      return jsonResponse({ status: 200, body: report })
    },
  })

  const result = await context.evaltokFetchReport({
    url: 'http://192.168.1.101:9000/',
    token: 'remote-token',
    mode: 'remote',
  }, 'run/a b')

  assert.equal(result, report)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/worktable/proxy')
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    url: 'http://192.168.1.101:9000/api/v1/report?task_id=run%2Fa%20b',
    method: 'GET',
    headers: { Authorization: 'Bearer remote-token' },
  })
})

test('变量或手填任务名会重新解析为真实 task_id，不使用残留的隐藏名称', async () => {
  const calls = []
  let advancedTo = null
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const stage = {
    id: 'eval-by-name',
    name: '按名称运行',
    timeout: null,
    evaltokens: { taskId: '${TASK_NAME}', taskName: 'old-selected-name', outVars: '' },
  }
  const rc = makeRc({ stages: [stage], vars: { TASK_NAME: 'new-task-name' } })
  const context = loadEvaltokensRuntime({
    substRunVars: value => value === '${TASK_NAME}' ? 'new-task-name' : value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url, options = {}) => {
      calls.push({ url, options })
      if (url.endsWith('/api/open/v1/tasks')) {
        return jsonResponse({ tasks: [{ task_id: 'task-resolved', name: 'new-task-name' }] })
      }
      if (url.endsWith('/api/open/v1/tasks/task-resolved/run')) {
        return jsonResponse({ run_id: 'run-resolved', task_id: 'task-resolved', status: 'running' })
      }
      if (url.includes('/api/open/v1/tasks/runs?task_id=task-resolved')) {
        return jsonResponse({ runs: [{ run_id: 'run-resolved', task_id: 'task-resolved', status: 'success' }] })
      }
      throw new Error(`unexpected request: ${url}`)
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: fn => { fn(); return 1 },
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: (_rc, index) => { advancedTo = index },
    finish: (_rc, status) => { throw new Error(`unexpected finish: ${status}`) },
  })

  await context.runEvaltokensStep(rc, 0)

  assert.equal(calls[0].options.method, 'GET')
  assert.match(calls[1].url, /\/tasks\/task-resolved\/run$/)
  assert.equal(rc.nodes['eval-by-name'].status, 'success')
  assert.equal(advancedTo, 1)
})

test('阶段超时会中断卡住的 EvalTokens 请求', async () => {
  let requestAborted = false
  let finishedAs = null
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const stage = {
    id: 'eval-timeout',
    name: '超时任务',
    timeout: 0.01,
    evaltokens: { taskId: 'task-timeout', taskName: 'timeout-task', outVars: '' },
  }
  const rc = makeRc({ stages: [stage] })
  const context = loadEvaltokensRuntime({
    substRunVars: value => value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url, options = {}) => {
      if (url.endsWith('/api/open/v1/tasks')) {
        return jsonResponse({ tasks: [{ task_id: 'task-timeout', name: 'timeout-task' }] })
      }
      return await new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          requestAborted = true
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
    setInterval: () => 1,
    clearInterval: () => {},
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: () => {},
    finish: (_rc, status) => { finishedAs = status },
  })

  const completed = await Promise.race([
    context.runEvaltokensStep(rc, 0).then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 200)),
  ])

  assert.equal(completed, true, '卡住的请求必须在阶段超时后返回')
  assert.equal(requestAborted, true)
  assert.equal(rc.nodes['eval-timeout'].status, 'failed')
  assert.equal(finishedAs, 'failed')
  assert.match(stage._out.stderr, /等待超时/)
})

test('用户中止会取消正在等待的 EvalTokens 请求且不覆盖中止状态', async () => {
  let requestAborted = false
  let finishCalls = 0
  let markRequestStarted
  const requestStarted = new Promise(resolve => { markRequestStarted = resolve })
  const evaltokConfig = { url: 'http://evaltokens.local', token: '', mode: 'local' }
  const stage = {
    id: 'eval-abort',
    name: '可中止任务',
    timeout: null,
    evaltokens: { taskId: 'task-abort', taskName: 'abort-task', outVars: '' },
  }
  const rc = makeRc({ stages: [stage] })
  const context = loadEvaltokensRuntime({
    substRunVars: value => value,
    evaltokConfig: () => evaltokConfig,
    fetch: async (url, options = {}) => {
      if (url.endsWith('/api/open/v1/tasks')) {
        return jsonResponse({ tasks: [{ task_id: 'task-abort', name: 'abort-task' }] })
      }
      markRequestStarted()
      return await new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          requestAborted = true
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
    setInterval: () => 1,
    clearInterval: () => {},
    archiveStageLog: () => {},
    mergeStageVars: () => ({}),
    parseStageJson: value => JSON.parse(value),
    applyOutVars: () => {},
    secToMinInput: value => String(value),
    advance: () => {},
    finish: () => { finishCalls += 1 },
  })

  const pending = context.runEvaltokensStep(rc, 0)
  await requestStarted
  assert.ok(rc.scriptAbort, '运行中请求应注册 AbortController')
  rc.over = true   // 用户中止（abortRun）：本运行标结束后，迟回的 AbortError 不得再次 finish 入账
  rc.scriptAbort.abort()
  await pending

  assert.equal(requestAborted, true)
  assert.equal(finishCalls, 0)
})
