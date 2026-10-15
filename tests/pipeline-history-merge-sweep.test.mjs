/* 混合编排历史合并为一条 + 卡死「进行中」清扫 回归测试。
 * 背景：
 *  - 合并：含「需本地运行」前缀 + 定时后缀的混合编排曾拆成「本地记录 + tag+'-srv' 后缀记录」两条；
 *    现改回单条——后缀计划不再携带拆分标记，execPlan 写同 tag 记录（启动即「进行中」、逐阶段刷新、
 *    结束落终态），appendPipelineHistory 同 tag 合并保留首条记录身份（名称/执行人/commit/来源），
 *    耗时按整条运行起止（首条记录 startTs）重算，阶段日志按名并集补齐。
 *  - 清扫：本地编排运行的历史由页面启动即写 running，页面崩溃/断网且 pagehide 失败落史（fail-run）
 *    未送达时永久挂「进行中」；planStaleHistorySweep 按活体信号（在场快照 / 活动计划同 tag）判死，
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
 * 与 pipeline-run-api.test.mjs 的 loadExecPlan 同结构，精简到本文件所需。
 * overrides 可覆盖 vm 上下文条目（如让 writeTaskLogFile 抛错模拟中盘异常）。 */
function loadExecPlanCapture(overrides = {}) {
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
    ...overrides,
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })
  return { execPlan: ctx.execPlan, history }
}

/* execPlan 真实落盘 harness（真 appendPipelineHistory + 临时存储文件），验证与既有记录的合并关系。
 * durText 桩按秒数回显，便于断言「耗时按整条运行起止重算」。 */
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
    durText: sec => 'total:' + Math.round(sec),
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

test('合并模式：后缀写同 tag 记录（启动即「进行中」、逐阶段刷新、结束落终态），不出现第二条', async () => {
  const f = loadExecPlanCapture()
  await f.execPlan(suffixPlan())
  assert.ok(f.history.length >= 4, `启动 1 次 + 每阶段 1 次 + 终态 1 次，实际 ${f.history.length} 次写入`)
  for (const rec of f.history) assert.equal(rec.tag, '1200-aaaaa', '全部写入同 tag 记录（不再派生 tag+\'-srv\'）')
  const first = f.history[0]
  assert.equal(first.status, 'running', '启动即写「进行中」')
  assert.deepEqual(first.logs.map(l => l.stage), ['检出'], '启动记录带本地前缀阶段快照')
  assert.equal(first.logs[0].local, true, '本地前缀阶段保留 local 标识')
  const last = f.history[f.history.length - 1]
  assert.equal(last.status, 'success', '收尾落终态')
  assert.deepEqual(last.logs.map(l => l.stage), ['检出', '构建', '推送'], '终态记录含前缀快照 + 全部后缀阶段')
  assert.equal(last.logs[0].local, true)
})

test('兼容：旧版页面登记的拆分标记字段不再读取，同样合并同 tag（一条记录）', async () => {
  const f = loadExecPlanCapture()
  await f.execPlan(suffixPlan({ histMode: 'split' }))
  assert.ok(f.history.length >= 4)
  for (const rec of f.history) assert.equal(rec.tag, '1200-aaaaa', '带拆分标记的旧计划也写同 tag（字段已不读取）')
  assert.equal(f.history[0].status, 'running')
  assert.equal(f.history[f.history.length - 1].status, 'success')
})

test('无 tag 的服务端计划（定时/API）保持旧行为：只在结束写一次历史', async () => {
  const f = loadExecPlanCapture()
  const plan = suffixPlan()
  delete plan.tag
  await f.execPlan(plan)
  assert.equal(f.history.length, 1, '无 tag 计划不得产生「进行中」进度写入')
  assert.equal(f.history[0].status, 'success')
  assert.equal(f.history[0].tag, '1234-abcde', '无 tag 计划按执行时刻生成 tag（hhmm-randHex 桩）')
})

test('合并模式真实落盘：服务端后缀并入页面本地前缀同一条记录，身份保留、耗时按整条运行重算', async t => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'pipeline-merge-'))
  try {
    const storeFile = pathJoin(dir, 'worktable-pipeline.json')
    const pageStartTs = Date.now() - 9000   // 页面 9 秒前启动本地前缀
    const pageRec = {
      no: 7, tag: '1200-aaaaa', pipeline: '部署', status: 'running', dur: '6s', ts: 1000,
      startTs: pageStartTs, by: 'tester', source: 'local', commit: 'c0ffee1',
      logs: [{ stage: '检出', status: 'success', dur: 6, local: true, logFile: '/arc/run-1200-aaaaa-01-检出.log' }],
    }
    await import('node:fs/promises').then(fs => fs.writeFile(storeFile, JSON.stringify({ config: {}, history: [pageRec] })))
    const h = loadExecPlanRealStore(storeFile)
    await h.ctx.execPlan(suffixPlan())
    const parsed = JSON.parse(await readFile(storeFile, 'utf8'))
    const merged = parsed.history.filter(r => r.tag === '1200-aaaaa')
    assert.equal(parsed.history.length, 1, '本地与非本地执行只留一条记录：' + JSON.stringify(parsed.history.map(r => r.tag)))
    assert.equal(merged.length, 1)
    const rec = merged[0]
    assert.equal(rec.status, 'success', '服务端收尾落终态')
    assert.equal(rec.pipeline, '部署', '名称保留页面首条记录（不带「· 定时后缀」尾巴）')
    assert.equal(rec.by, 'tester', '执行人保留页面首条记录（不带 ⏰）')
    assert.equal(rec.source, 'local', '来源保留 local（不被覆盖成 schedule-suffix）')
    assert.equal(rec.commit, 'c0ffee1', 'commit 保留页面首条记录（不换随机值）')
    assert.equal(rec.no, 7, '编号保留首条记录')
    assert.equal(rec.startTs, pageStartTs, '起始时刻保留页面启动时刻')
    assert.equal(rec.dur, 'total:9', '耗时按整条运行起止重算（durText 桩回显秒数），不再只剩后缀段')
    assert.deepEqual(rec.logs.map(l => l.stage), ['检出', '构建', '推送'], '阶段日志按名并集：本地前缀 + 服务端后缀')
    assert.equal(rec.logs[0].local, true, '本地前缀阶段保留 local 标识')
    assert.equal(rec.logs[0].logFile, '/arc/run-1200-aaaaa-01-检出.log', '本地前缀日志路径不被服务端快照冲掉')
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
  const activePlanTags = new Set(['t-plan'])
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

test('planStaleHistorySweep：混合编排单条记录（同 tag）由活动计划保护，不判死', () => {
  const ctx = loadHistoryHelpers()
  const now = 100000000
  const history = [{ tag: 't1', status: 'running', ts: now - 60 * 60 * 1000 }]
  const evidence = new Map()   // 服务端执行中的后缀没有任何页面侧证据
  const { deadTags } = ctx.planStaleHistorySweep(now, history, new Set(), new Set(['t1']), evidence, [])
  assert.equal(deadTags.size, 0, '活动计划保护同 tag 的单条记录（后缀执行期间不判死）')
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

test('静态契约：拆分标记与 -srv 派生记录移除；同 tag 合并保留首条记录身份与整条耗时', () => {
  assert.ok(!source.includes('histMode'), '服务端不再读取 histMode 拆分标记')
  assert.ok(!source.includes("-srv'"), '不再派生 tag+\'-srv\' 记录')
  assert.ok(source.includes("['pipeline', 'by', 'commit', 'source']"), '同 tag 合并保留首条记录身份（名称/执行人/commit/来源）')
  assert.ok(source.includes('prev.startTs'), '耗时按整条运行起止（首条记录 startTs）重算')
  assert.ok(source.includes("rec.status = 'failed'"), '判死记录落 failed 终态')
  assert.ok(source.includes('本地执行中断：页面失联'), '判死记录补系统日志说明')
  assert.ok(source.includes('sweepStaleRunningHistory'), '清扫器接入定时循环')
  assert.ok(source.includes("planStaleHistorySweep(now, history, liveTags, activePlanTags, evidence, dormantPlans)"), '清扫器调用纯函数决策')
  assert.ok(source.includes('pipelineExecutions.runningTags()'), '清扫器把执行池在跑条目的 tag 并入活体信号（防长运行 neverSeen 误判死）')
})

/* 中盘异常兜底：写入 running 与终态落史之间的执行主体被 try/catch 兜住——阶段组 Promise.all 拒绝、
   HTTP/EvalTokens 阶段抛错、recordStageResult 写任务日志失败等任何逃逸都无条件落终态。 */
test('execPlan 兜底：执行主体中盘抛错（写任务日志失败）仍落 failed 终态并记「（系统）」行', async () => {
  const f = loadExecPlanCapture({ writeTaskLogFile: async () => { throw new Error('disk full') } })
  const result = await f.execPlan(suffixPlan())
  assert.equal(result, 'failed', '执行器向执行池回报 failed 终态')
  assert.equal(f.history[0].status, 'running', '启动已写「进行中」')
  const last = f.history[f.history.length - 1]
  assert.equal(last.status, 'failed', '终态无条件落史（不再停在 running 等 sweep 判死）')
  const sys = last.logs.find(l => l.stage === '（系统）')
  assert.ok(sys, '终态记录带（系统）日志行')
  assert.equal(sys.status, 'failed')
  assert.ok(sys.log.includes('执行异常：disk full'), '系统行含异常原因：' + sys.log)
})

test('execPlan 兜底：abort 类错误（用户取消语义）按 aborted 落史，不记失败行', async () => {
  const f = loadExecPlanCapture({
    writeTaskLogFile: async () => { const e = new Error('操作已取消'); e.name = 'AbortError'; throw e },
  })
  const result = await f.execPlan(suffixPlan())
  assert.equal(result, 'aborted', 'abort 不记 failed')
  const last = f.history[f.history.length - 1]
  assert.equal(last.status, 'aborted')
  assert.ok(!last.logs.some(l => l.stage === '（系统）' && l.status === 'failed'), 'abort 不记（系统）失败行')
})

/* 终态不可逆：磁盘已终态（success/failed/aborted）而客户端仍是 running 且 ts 不严格更新时，
   status 取磁盘终态——ts 相等（tie）也不得复活（fail-run 与防抖整存 PUT 竞态下两侧同 ts）。 */
test('mergePipelineHistoryForWrite：终态不可逆——磁盘 failed + 客户端同 ts running → failed（不复活）', () => {
  const ctx = loadHistoryHelpers()
  const client = [{ no: 5, tag: 't-1', ts: 200, status: 'running', pipeline: 'PL', logs: [{ stage: '本地A', status: 'success', local: true, dur: 1 }] }]
  const disk = [{ no: 5, tag: 't-1', ts: 200, status: 'failed', pipeline: 'PL', closeError: '浏览器页面已关闭', logs: [{ stage: '定时B', status: 'failed', dur: 2 }] }]
  const out = ctx.mergePipelineHistoryForWrite({}, {}, client, disk)
  assert.equal(out.history.length, 1, '同 tag 只留一条')
  const rec = out.history[0]
  assert.equal(rec.status, 'failed', 'ts 相等（tie）也不得把终态复活成 running')
  assert.equal(rec.closeError, '浏览器页面已关闭', '其余顶层字段仍按既有规则合并（客户端缺失的键从磁盘侧并入）')
  const names = rec.logs.map(e => e.stage)
  assert.ok(names.includes('本地A') && names.includes('定时B') && rec.logs.length === 2, 'logs 仍按名并集合并')
})

test('mergePipelineHistoryForWrite：终态不可逆的放行口——客户端 ts 严格更新时允许翻回 running', () => {
  const ctx = loadHistoryHelpers()
  const client = [{ no: 5, tag: 't-1', ts: 300, status: 'running', pipeline: 'PL', logs: [{ stage: '本地A', status: 'success', local: true, dur: 1 }] }]
  const disk = [{ no: 5, tag: 't-1', ts: 200, status: 'failed', pipeline: 'PL', logs: [{ stage: '定时B', status: 'failed', dur: 2 }] }]
  const out = ctx.mergePipelineHistoryForWrite({}, {}, client, disk)
  assert.equal(out.history[0].status, 'running', '设计内的终态→running 翻转（markHistorySuffixRunning 会 bump ts）凭严格更新的 ts 放行')
})

test('planStaleHistorySweep：liveTags 含执行池在跑 tag 的记录不判死（长运行 neverSeen 场景）', () => {
  const ctx = loadHistoryHelpers()
  const now = 100000000
  /* 服务端执行池在跑 45 分钟的长运行：once 计划已从计划文件移除（无活动计划）、无浏览器在场证据——
     sweepStaleRunningHistory 把执行池 runningTags 并入 liveTags 后不得被 neverSeen 兜底误判死 */
  const history = [{ tag: 't-pool', status: 'running', ts: now - 45 * 60 * 1000, startTs: now - 45 * 60 * 1000 }]
  const { deadTags, dropPlanIds } = ctx.planStaleHistorySweep(now, history, new Set(['t-pool']), new Set(), new Map(), [])
  assert.equal(deadTags.size, 0, '执行池在跑 tag 是活体信号')
  assert.deepEqual(dropPlanIds, [])
})
