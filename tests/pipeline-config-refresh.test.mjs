import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const page = await readFile(new URL('../projects/pipeline/pipeline.html', import.meta.url), 'utf8')

function extractFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(page)
  assert.ok(match, `pipeline.html 缺少函数 ${name}`)
  const bodyStart = page.indexOf('{', match.index)
  let depth = 0
  for (let index = bodyStart; index < page.length; index += 1) {
    if (page[index] === '{') depth += 1
    else if (page[index] === '}' && --depth === 0) return page.slice(match.index, index + 1)
  }
  throw new Error(`无法提取函数 ${name}`)
}

function loadRefreshFixture(remoteState, fetchError) {
  const start = page.indexOf('/* ---------- 流水线任务手动刷新 ---------- */')
  const end = page.indexOf('/* ---------- 流水线任务管理（多条流水线） ---------- */', start)
  assert.ok(start >= 0 && end > start, '流水线任务手动刷新逻辑未找到')

  const stored = new Map()
  const alerts = []
  const calls = { pipelines: 0, flow: 0, detail: 0, reset: 0 }
  const button = { disabled: false, addEventListener(type, handler) { if (type === 'click') this.click = handler } }
  const initialPipelines = [{ id: 'pl-xds', name: '旧流水线', stages: [{ id: 'st-old' }], builtIn: true }]
  const ctx = {
    DEFAULT_PIPELINE_ID: 'pl-xds',
    pipelines: initialPipelines,
    /* 手动刷新改按 id 三方合并（applyPipelineRefreshPayload 与 loadServerState 同口径）：
       共同基线 serverConfigBase 须与本页初始状态一致，远端改动才会按「本地未改取远端」应用 */
    serverConfigBase: JSON.parse(JSON.stringify({ pipelines: initialPipelines })),
    stateFetchEpoch: 0,
    curPipelineId: 'pl-xds',
    selectedId: 'st-old',
    runStages: null,
    replayRec: null,
    running: false,
    defaultPipeline: () => ({ id: 'pl-xds', name: '默认流水线', stages: [{ id: 'st-default' }], builtIn: true }),
    migrateGate: p => p,
    migrateStageUrl: p => p,
    migratePrefillDefaults: p => p,
    migratePipelineDefaults: p => p,
    migratePromPreset: p => p,
    findPipeline: id => ctx.pipelines.find(p => p.id === id),
    curPipeline: () => ctx.pipelines.find(p => p.id === ctx.curPipelineId) || ctx.pipelines[0],
    localStorage: { setItem: (key, value) => stored.set(key, value) },
    $: id => id === 'pipelineRefresh' ? button : null,
    fetch: async url => {
      assert.equal(url, '/api/worktable/pipeline')
      if (fetchError) throw fetchError
      return { ok: true, json: async () => remoteState }
    },
    alert: message => alerts.push(message),
    resetNodes: () => { calls.reset++ },
    renderPipelines: () => { calls.pipelines++ },
    renderFlow: () => { calls.flow++ },
    renderDetail: () => { calls.detail++ },
  }
  vm.createContext(ctx)
  /* 刷新段落在切片外的依赖：按 id 三方合并（mergePipelinesFromServer/stripPipelineSharedMeta）
     与过期快照重拉（fetchPipelineStateFresh，内部走 ctx.fetch 与 ctx.stateFetchEpoch） */
  vm.runInContext(['stripPipelineSharedMeta', 'mergePipelinesFromServer', 'fetchPipelineStateFresh'].map(extractFunction).join('\n'), ctx)
  vm.runInContext(page.slice(start, end), ctx)
  assert.equal(button.click, ctx.refreshPipelinesFromServer, '刷新按钮应绑定手动刷新处理器')
  return { ctx, stored, alerts, calls, button }
}

test('手动刷新后显示其他浏览器新建的流水线，并保留当前选择', async () => {
  const remote = {
    config: {
      pipelines: [
        { id: 'pl-xds', name: '远端流水线', stages: [{ id: 'st-old' }, { id: 'st-new' }], builtIn: true },
        { id: 'pl-shared', name: '其他浏览器新建', stages: [{ id: 'st-shared' }], builtIn: false },
      ],
    },
  }
  const f = loadRefreshFixture(remote)

  await f.button.click()

  assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.pipelines.map(p => p.name))), ['远端流水线', '其他浏览器新建'])
  assert.equal(f.ctx.curPipelineId, 'pl-xds')
  assert.equal(f.ctx.selectedId, 'st-old')
  assert.deepEqual(f.calls, { pipelines: 1, flow: 0, detail: 0, reset: 1 })
  assert.deepEqual(JSON.parse(f.stored.get('pip-pipelines')).map(p => p.id), ['pl-xds', 'pl-shared'])
  assert.equal(f.button.disabled, false)
  assert.deepEqual(f.alerts, [])
})

test('手动刷新失败时保留现有流水线并恢复按钮', async () => {
  const f = loadRefreshFixture(null, new Error('network down'))

  await f.button.click()

  assert.deepEqual(f.ctx.pipelines.map(p => p.name), ['旧流水线'])
  assert.equal(f.button.disabled, false)
  assert.equal(f.alerts.length, 1)
  /* fetchPipelineStateFresh 不向外抛网络错误（st=null 按拉取失败处理），告警不再带底层错误详情 */
  assert.match(f.alerts[0], /刷新流水线任务失败：服务端配置拉取失败/)
})

test('刷新请求返回前开始运行时丢弃迟到的远端状态', async () => {
  let resolveRemote
  const remotePending = new Promise(resolve => { resolveRemote = resolve })
  const f = loadRefreshFixture(remotePending)
  const refreshing = f.button.click()
  await Promise.resolve()
  f.ctx.running = true
  resolveRemote({
    config: { pipelines: [{ id: 'pl-xds', name: '不应应用', stages: [{ id: 'st-remote' }], builtIn: true }] },
  })

  await refreshing

  assert.deepEqual(f.ctx.pipelines.map(p => p.name), ['旧流水线'])
  assert.deepEqual(f.calls, { pipelines: 0, flow: 0, detail: 0, reset: 0 })
  assert.equal(f.button.disabled, false)
  assert.match(f.alerts[0], /流水线已开始运行.*刷新已取消/)
})

test('刷新任务列表时保留普通完成态的阶段快照', async () => {
  const remote = {
    config: {
      pipelines: [
        { id: 'pl-xds', name: '远端流水线', stages: [{ id: 'st-remote' }], builtIn: true },
        { id: 'pl-shared', name: '其他浏览器新建', stages: [{ id: 'st-shared' }], builtIn: false },
      ],
    },
  }
  const f = loadRefreshFixture(remote)
  const snapshot = [{ id: 'st-old', name: '已完成阶段' }]
  f.ctx.runStages = snapshot

  await f.button.click()

  assert.equal(f.ctx.runStages, snapshot)
  assert.equal(f.ctx.selectedId, 'st-old')
  assert.equal(f.ctx.replayRec, null)
  assert.deepEqual(f.calls, { pipelines: 1, flow: 0, detail: 0, reset: 0 })
})

test('刷新任务列表时保留历史回放态的阶段快照', async () => {
  const remote = {
    config: { pipelines: [{ id: 'pl-xds', name: '远端流水线', stages: [{ id: 'st-remote' }], builtIn: true }] },
  }
  const f = loadRefreshFixture(remote)
  const snapshot = [{ id: 'st-old', name: '回放阶段' }]
  f.ctx.runStages = snapshot
  f.ctx.replayRec = { tag: 'history-1' }

  await f.button.click()

  assert.equal(f.ctx.runStages, snapshot)
  assert.equal(f.ctx.selectedId, 'st-old')
  assert.equal(f.ctx.replayRec.tag, 'history-1')
  assert.deepEqual(f.calls, { pipelines: 1, flow: 0, detail: 0, reset: 0 })
})

test('刷新请求在途时保留用户最新选择的阶段', async () => {
  let resolveRemote
  const remotePending = new Promise(resolve => { resolveRemote = resolve })
  const f = loadRefreshFixture(remotePending)
  f.ctx.pipelines[0].stages.push({ id: 'st-latest' })
  const refreshing = f.button.click()
  await Promise.resolve()
  f.ctx.selectedId = 'st-latest'
  resolveRemote({
    config: {
      pipelines: [{ id: 'pl-xds', name: '远端流水线', stages: [{ id: 'st-old' }, { id: 'st-latest' }], builtIn: true }],
    },
  })

  await refreshing

  assert.equal(f.ctx.selectedId, 'st-latest')
  assert.deepEqual(f.calls, { pipelines: 1, flow: 0, detail: 0, reset: 1 })
})
