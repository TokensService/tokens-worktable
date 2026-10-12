/* 混合编排历史拆分 + 卡死「进行中」清扫 回归测试。
 * 背景：
 *  - 拆分：含「需本地运行」前缀 + 定时后缀的混合编排，此前服务端后缀经同 tag 合并进本地记录，
 *    本地/非本地任务挤在一条记录且记录身份（名称/执行人/来源/耗时）被后缀覆盖；现后缀计划带
 *    histMode:'split'，execPlan 改写 tag+'-srv' 独立记录，启动即「进行中」、逐阶段刷新、结束落终态。
 *  - 清扫：本地编排运行的历史由页面启动即写 running，页面崩溃/断网且 pagehide 失败落史（fail-run）
 *    未送达时永久挂「进行中」；planStaleHistorySweep 按活体信号（在场快照 / 活动计划）判死，
 *    让「本地执行没完成」的错误在运行历史状态中体现（正常关页由 fail-run 路由直接落失败终态）。
 * 抽取手法与 pipeline-run-api.test.mjs / pipeline-history-env-nodes.test.mjs 一致。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join as pathJoin, resolve as pathResolve } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function extractFunction(name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}(?:<[^>]*>)?\\s*\\(`)
  const match = marker.exec(source)
  assert.ok(match, `src/index.ts 缺少函数 ${name}`)
  const start = match.index
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`无法提取函数 ${name}`)
}

/* cleanPipelineHistory → git 状态快照 区段：含 mergeStageLogsForHistory / mergePipelineHistoryForWrite /
 * planStaleHistorySweep 等纯函数（与 pipeline-history-env-nodes.test.mjs 同口径）。 */
function loadHistoryHelpers() {
  const start = source.indexOf('function cleanPipelineHistory(')
  const end = source.indexOf('/** git 状态快照', start)
  assert.ok(start >= 0 && end > start, 'history helpers 区段未找到')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return ctx
}

const plain = value => JSON.parse(JSON.stringify(value))

/* execPlan 捕获型 harness：appendPipelineHistory 只记录不写盘（断言写入序列用）。
 * 与 pipeline-run-api.test.mjs 的 loadExecPlan 同结构，精简到本文件所需。 */
function loadExecPlanCapture() {
  const apiStart = source.indexOf('/* ---------- 流水线 API 触发 ---------- */')
  const apiEnd = source.indexOf('/* ---------- 流水线 API 触发结束 ---------- */', apiStart)
  assert.ok(apiStart >= 0 && apiEnd > apiStart, '流水线 API helper 未找到')
  const code = stripTypeScriptTypes([
    extractFunction('isLocalTarget'),
    source.slice(apiStart, apiEnd),
    extractFunction('pipelineHistoryEnvNodes'),
    extractFunction('resolvePipelineScriptsDir'),
    extractFunction('parseStageVars'),
    extractFunction('parseStageJson'),
    extractFunction('jsonPathGet'),
    extractFunction('applyOutVars'),
    extractFunction('execPlan'),
  ].join('\n'), { mode: 'transform' })
  const history = []
  const ctx = {
    URL, Promise, Buffer, Date, Math, URLSearchParams, AbortController, setTimeout, clearTimeout,
    console: { warn() {}, log() {}, error() {} },
    pathResolve,
    DEFAULT_PIPELINE_SCRIPTS_DIR: '',
    fetch: async () => { throw new Error('unexpected fetch') },
    readPipelineStore: async () => ({ config: {} }),
    stripSuffixName: value => String(value || '').replace(/\s*·\s*定时后缀\s*$/, '') || 'pipeline',
    hhmm: () => '12:34',
    randHex: length => 'abcdef123456'.slice(0, length),
    sanitizeFsName: String,
    nowCompactFull: () => '20260910123456',
    durText: () => '1s',
    sleepMs: async () => {},
    taskLogPath: (folder, tag, seq, name) => `${folder}/run-${tag}-${String(seq).padStart(2, '0')}-${name}.log`,
    writeTaskLogFile: async () => null,
    appendTaskLogNote: async () => true,
    writePipelineSummaryFile: async () => {},
    stageLogText: (name, result) => `${name}:${result.code}`,
    runStageScript: async script => ({ code: 0, stdout: '', stderr: '', script: script.name }),
    appendPipelineHistory: async record => { history.push(plain(record)) },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })
  return { execPlan: ctx.execPlan, history }
}

/* execPlan 真实落盘 harness（真 appendPipelineHistory + 临时存储文件），验证与既有记录的合并/不动关系。 */
function loadExecPlanRealStore(storeFile) {
  const histStart = source.indexOf('function cleanPipelineHistory(')
  const histEnd = source.indexOf('/** git 状态快照', histStart)
  const code = stripTypeScriptTypes([
    extractFunction('isLocalTarget'),
    source.slice(histStart, histEnd),
    extractFunction('resolvePipelineScriptsDir'),
    extractFunction('parseStageVars'),
    extractFunction('parseStageJson'),
    extractFunction('jsonPathGet'),
    extractFunction('applyOutVars'),
    extractFunction('execPlan'),
    `const PIPELINE_STORE = ${JSON.stringify(storeFile)}`,
    extractFunction('writeJsonAtomic'),
    'let storeChain = Promise.resolve()',
    extractFunction('withStoreLock'),
    `async function readPipelineStore() {
      try {
        const raw = await readFile(PIPELINE_STORE, 'utf8')
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
      } catch { return {} }
    }`,
    extractFunction('appendPipelineHistory'),
  ].join('\n'), { mode: 'transform' })
  const ctx = {
    URL, Promise, Buffer, Date, Math, URLSearchParams, AbortController, setTimeout, clearTimeout,
    console: { warn() {}, log() {}, error() {} },
    pathResolve, readFile, dirname,
    DEFAULT_PIPELINE_SCRIPTS_DIR: '',
    fetch: async () => { throw new Error('unexpected fetch') },
    stripSuffixName: value => String(value || '').replace(/\s*·\s*定时后缀\s*$/, '') || 'pipeline',
    hhmm: () => '12:34',
    randHex: length => 'abcdef123456'.slice(0, length),
    sanitizeFsName: String,
    nowCompactFull: () => '20260910123456',
    durText: () => '1s',
    sleepMs: async () => {},
    taskLogPath: (folder, tag, seq, name) => `${folder}/run-${tag}-${String(seq).padStart(2, '0')}-${name}.log`,
    writeTaskLogFile: async () => null,
    appendTaskLogNote: async () => true,
    writePipelineSummaryFile: async () => {},
    stageLogText: (name, result) => `${name}:${result.code}`,
    runStageScript: async script => ({ code: 0, stdout: '', stderr: '', script: script.name }),
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })
  return { ctx }
}

function suffixPlan(overrides = {}) {
  return {
    id: 'stimer-pl-1-1200-aaaaa-suffix',
    pipelineId: 'pl-1',
    pipelineName: '部署 · 定时后缀',
    stages: [
      { id: 'build', name: '构建', script: { name: 'build.sh', path: '/scripts/build.sh', params: [], values: {} } },
      { id: 'push', name: '推送', script: { name: 'push.sh', path: '/scripts/push.sh', params: [], values: {} } },
    ],
    prefixStages: [{ id: 'a', name: '检出', status: 'success', dur: 6, local: true }],
    env: '', envs: [], repository: null, branch: 'main', strategy: '',
    by: 'tester ⏰', tag: '1200-aaaaa', archive: '/arc/deploy_20261012120000', baseSeq: 1,
    kind: 'once', at: Date.now(),
    ...overrides,
  }
}

test('拆分模式（histMode:split）：后缀写 tag+\'-srv\' 独立记录，启动即「进行中」、逐阶段刷新、结束落终态', async () => {
  const f = loadExecPlanCapture()
  await f.execPlan(suffixPlan({ histMode: 'split' }))
  assert.ok(f.history.length >= 4, `启动 1 次 + 每阶段 1 次 + 终态 1 次，实际 ${f.history.length} 次写入`)
  for (const rec of f.history) assert.equal(rec.tag, '1200-aaaaa-srv', '拆分模式全部写入 tag+\'-srv\' 独立记录')
  const first = f.history[0]
  assert.equal(first.status, 'running', '启动即写「进行中」')
  assert.deepEqual(first.logs.map(l => l.stage), ['检出'], '启动记录带本地前缀阶段快照')
  assert.equal(first.logs[0].local, true, '本地前缀阶段保留 local 标识')
  assert.equal(first.pipeline, '部署 · 定时后缀')
  const last = f.history[f.history.length - 1]
  assert.equal(last.status, 'success', '收尾落终态')
  assert.deepEqual(last.logs.map(l => l.stage), ['检出', '构建', '推送'], '终态记录含前缀快照 + 全部后缀阶段')
  assert.equal(last.logs[0].local, true)
})

test('接管模式（无 histMode）：关页移交沿用原 tag 原地更新，同 tag 只有一条记录', async () => {
  const f = loadExecPlanCapture()
  const plan = suffixPlan()
  delete plan.histMode
  plan.pipelineName = '部署 · 关页移交'
  await f.execPlan(plan)
  assert.ok(f.history.length >= 4, `启动 + 逐阶段 + 终态多次写入，实际 ${f.history.length} 次`)
  for (const rec of f.history) assert.equal(rec.tag, '1200-aaaaa', '接管模式写原 tag（原地更新页面遗留的「进行中」记录）')
  assert.equal(f.history[0].status, 'running')
  assert.equal(f.history[f.history.length - 1].status, 'success')
})

test('无 tag 的服务端计划（定时/API）保持旧行为：只在结束写一次历史', async () => {
  const f = loadExecPlanCapture()
  const plan = suffixPlan()
  delete plan.histMode
  delete plan.tag
  await f.execPlan(plan)
  assert.equal(f.history.length, 1, '无 tag 计划不得产生「进行中」进度写入')
  assert.equal(f.history[0].status, 'success')
  assert.equal(f.history[0].tag, '1234-abcde', '无 tag 计划按执行时刻生成 tag（hhmm-randHex 桩）')
})

test('拆分模式真实落盘：页面已落定的本地前缀记录（同 tag）不被服务端后缀覆盖', async t => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'pipeline-split-'))
  try {
    const storeFile = pathJoin(dir, 'worktable-pipeline.json')
    const pageRec = {
      no: 7, tag: '1200-aaaaa', pipeline: '部署', status: 'success', dur: '6s', ts: 1000,
      by: 'tester', source: 'local', logs: [{ stage: '检出', status: 'success', dur: 6, local: true, logFile: '/arc/run-1200-aaaaa-01-检出.log' }],
    }
    await import('node:fs/promises').then(fs => fs.writeFile(storeFile, JSON.stringify({ config: {}, history: [pageRec] })))
    const h = loadExecPlanRealStore(storeFile)
    await h.ctx.execPlan(suffixPlan({ histMode: 'split' }))
    const parsed = JSON.parse(await readFile(storeFile, 'utf8'))
    const tLocal = parsed.history.find(r => r.tag === '1200-aaaaa')
    const tSrv = parsed.history.find(r => r.tag === '1200-aaaaa-srv')
    assert.ok(tLocal && tSrv, '本地记录与后缀记录各是一条')
    assert.deepEqual(plain(tLocal), plain({ ...pageRec, no: 7 }), '本地前缀记录原样保留（名称/执行人/来源/耗时/日志路径均不被后缀覆盖）')
    assert.equal(tSrv.status, 'success')
    assert.equal(tSrv.pipeline, '部署 · 定时后缀')
    assert.equal(tSrv.source, 'schedule-suffix')
    assert.deepEqual(tSrv.logs.map(l => l.stage), ['检出', '构建', '推送'], '后缀记录含本地前缀快照（local 标识）+ 后缀阶段')
    assert.equal(tSrv.logs[0].local, true)
    assert.ok(tSrv.no !== 7, '后缀记录独立编号')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('planStaleHistorySweep：孤儿证据超宽限的「进行中」记录判死，同 tag 休眠计划一并清理', () => {
  const ctx = loadHistoryHelpers()
  const now = 100000000
  const history = [
    { tag: 't-dead', status: 'running', ts: now - 10 * 60 * 1000 },
    { tag: 't-live', status: 'running', ts: now - 10 * 60 * 1000 },
    { tag: 't-plan', status: 'running', ts: now - 10 * 60 * 1000 },
    { tag: 't-fresh', status: 'running', ts: now - 10 * 60 * 1000 },
    { tag: 't-done', status: 'success', ts: now - 60 * 60 * 1000 },
    { status: 'running', ts: now - 60 * 60 * 1000 },   // 无 tag：不参与判死（无法定位休眠计划，保守跳过）
  ]
  const liveTags = new Set(['t-live'])
  const activePlanTags = new Set(['t-plan', 't-plan-srv'])
  const evidence = new Map([
    ['t-dead', now - 4 * 60 * 1000],    // 孤儿入簿 4 分钟：超 3 分钟宽限 → 死
    ['t-fresh', now - 1 * 60 * 1000],   // 刚失联 1 分钟：宽限内 → 活
    ['t-live', now - 10 * 60 * 1000],   // 证据虽旧但在场快照仍新鲜 → 活（liveTags 优先）
    ['t-done', now - 30 * 60 * 1000],   // 终态不参与
  ])
  const dormantPlans = [
    { id: 'stimer-pl-t-dead-suffix', tag: 't-dead', at: 0 },
    { id: 'stimer-pl-t-fresh-suffix', tag: 't-fresh', at: 0 },
  ]
  const { deadTags, dropPlanIds } = ctx.planStaleHistorySweep(now, history, liveTags, activePlanTags, evidence, dormantPlans)
  assert.deepEqual([...deadTags], ['t-dead'])
  assert.deepEqual(dropPlanIds, ['stimer-pl-t-dead-suffix'], '仅死 tag 的休眠计划被清理，宽限内的保留')
})

test('planStaleHistorySweep：拆分后缀记录（tag+\'-srv\'）由活动计划保护，不判死', () => {
  const ctx = loadHistoryHelpers()
  const now = 100000000
  const history = [{ tag: 't1-srv', status: 'running', ts: now - 60 * 60 * 1000 }]
  const evidence = new Map()   // 服务端执行中的拆分后缀记录没有任何页面侧证据
  const { deadTags } = ctx.planStaleHistorySweep(now, history, new Set(), new Set(['t1', 't1-srv']), evidence, [])
  assert.equal(deadTags.size, 0, '活动计划（含 -srv 派生 tag）保护执行中的拆分后缀记录')
})

test('planStaleHistorySweep：从未有信号且记录很旧的兜底判死；新记录不误伤', () => {
  const ctx = loadHistoryHelpers()
  const now = 100000000
  const history = [
    { tag: 't-ancient', status: 'running', ts: now - 45 * 60 * 1000 },   // 45 分钟前：兜底判死
    { tag: 't-young', status: 'running', ts: now - 10 * 60 * 1000 },     // 10 分钟：兜底宽限内
  ]
  const { deadTags, dropPlanIds } = ctx.planStaleHistorySweep(now, history, new Set(), new Set(), new Map(), [])
  assert.deepEqual([...deadTags], ['t-ancient'])
  assert.deepEqual(dropPlanIds, [])
})

test('cleanQueueEntry 透传 tag（「进行中」历史清扫据此把失联运行判死），缺省不带该键', () => {
  const code = stripTypeScriptTypes([
    'const QUEUE_STAGE_CAP = 50',
    extractFunction('cleanQueueStage'),
    extractFunction('cleanQueueNode'),
    extractFunction('cleanQueueEntry'),
  ].join('\n'), { mode: 'transform' })
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  const withTag = ctx.cleanQueueEntry({ id: 'r1', tag: '2205-abc', pipelineName: 'P', startedAt: 1, stages: [], nodes: {} }, 'startedAt')
  assert.equal(withTag.tag, '2205-abc', '在场/孤儿条目必须保留 tag：否则失联运行的历史记录永远等不到判死证据')
  const noTag = ctx.cleanQueueEntry({ id: 'r2', pipelineName: 'P', startedAt: 1, stages: [], nodes: {} }, 'startedAt')
  assert.equal('tag' in noTag, false, '缺省不带 tag 键（队列快照既有断言不受影响）')
})

test('静态契约：清扫器判死后把记录标记 failed 并补系统日志、休眠计划按 id 清理', () => {
  assert.ok(source.includes("rec.status = 'failed'"), '判死记录落 failed 终态')
  assert.ok(source.includes('本地执行中断：页面失联'), '判死记录补系统日志说明')
  assert.ok(source.includes('sweepStaleRunningHistory'), '清扫器接入定时循环')
  assert.ok(source.includes("planStaleHistorySweep(now, history, liveTags, activePlanTags, evidence, dormantPlans)"), '清扫器调用纯函数决策')
})
