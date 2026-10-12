import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open as fsOpen, readFile, rm, writeFile } from 'node:fs/promises'
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

/* cleanPipelineHistory → git 状态快照 区段：含 mergeStageLogsForHistory / mergePipelineHistoryForWrite */
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

function loadAppendHarness(storeFile) {
  const histStart = source.indexOf('function cleanPipelineHistory(')
  const histEnd = source.indexOf('/** git 状态快照', histStart)
  const code = stripTypeScriptTypes([
    source.slice(histStart, histEnd),
    extractFunction('writeJsonAtomic'),
    'let storeChain = Promise.resolve()',
    extractFunction('withStoreLock'),
    `const PIPELINE_STORE = ${JSON.stringify(storeFile)}`,
    `async function readPipelineStore() {
      try {
        const raw = await readFile(PIPELINE_STORE, 'utf8')
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
      } catch { return {} }
    }`,
    extractFunction('appendPipelineHistory'),
  ].join('\n'), { mode: 'transform' })
  const ctx = {
    URL, Promise, Buffer, Date, Math, JSON, Object, Array, Map, Set,
    console: { warn() {}, log() {}, error() {} },
    readFile,
    writeFile,
    mkdir,
    fsOpen,
    dirname,
    pathResolve,
    process: { env: {} },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })
  return ctx
}

test('mergeStageLogsForHistory：按阶段名并集，本地前缀 + 服务端后缀完整', () => {
  const ctx = loadHistoryHelpers()
  const merged = ctx.mergeStageLogsForHistory(
    [{ stage: '本地A', status: 'success', dur: 1, local: true }, { stage: '定时B', status: 'skipped', dur: 0 }],
    [{ stage: '定时B', status: 'success', dur: 2, logFile: '/x/b.log' }, { stage: '定时C', status: 'failed', dur: 3 }],
  )
  assert.deepEqual(Array.from(merged.map(e => e.stage)), ['本地A', '定时B', '定时C'])
  assert.equal(merged[0].local, true)
  assert.equal(merged[1].status, 'success')
  assert.equal(merged[1].local, undefined, '服务端阶段默认无 local 标记')
  assert.equal(merged[2].status, 'failed')
})

test('mergePipelineHistoryForWrite：同 tag 双边合并阶段日志，不再整条客户端覆盖', () => {
  const ctx = loadHistoryHelpers()
  const client = [{
    no: 3, tag: 't-1', ts: 100, status: 'success', pipeline: 'PL',
    logs: [{ stage: '本地A', status: 'success', local: true, dur: 1 }],
  }]
  const disk = [{
    no: 3, tag: 't-1', ts: 200, status: 'failed', pipeline: 'PL',
    logs: [{ stage: '定时B', status: 'failed', dur: 2 }],
  }]
  const out = ctx.mergePipelineHistoryForWrite({}, {}, client, disk)
  assert.equal(out.history.length, 1, '同 tag 只留一条')
  const rec = out.history[0]
  assert.equal(rec.status, 'failed', '顶层取 ts 较新一侧（服务端终态）')
  assert.equal(rec.no, 3)
  const logNames = Array.from(rec.logs.map(e => e.stage))
  assert.equal(logNames.includes('本地A') && logNames.includes('定时B') && logNames.length === 2, true, logNames.join(','))
  assert.equal(rec.logs.find(e => e.stage === '本地A').local, true)
})

test('mergePipelineHistoryForWrite：无 tag 仍按 ts/no 键去重，清空点约束不变', () => {
  const ctx = loadHistoryHelpers()
  const out = ctx.mergePipelineHistoryForWrite({ histClearedAt: 50 }, {}, [
    { no: 1, ts: 10, logs: [] },
    { no: 2, ts: 60, logs: [{ stage: 'A' }] },
  ], [
    { no: 3, ts: 70, logs: [{ stage: 'B' }] },
    { no: 1, ts: 10, logs: [{ stage: 'old' }] },
  ])
  const nos = Array.from(out.history.map(h => h.no)).sort((a, b) => a - b)
  assert.deepEqual(nos, [2, 3], '清空点之前的记录与同 ts 重复项不复活')
})

test('appendPipelineHistory：同 tag 原地合并，不占新编号、阶段日志并集', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'pl-hist-merge-'))
  const storeFile = pathJoin(dir, 'worktable-pipeline.json')
  try {
    await writeFile(storeFile, JSON.stringify({
      config: { buildNo: 5 },
      history: [{
        no: 5, tag: 't-h', ts: 100, status: 'success', pipeline: 'PL', by: 'alice',
        logs: [{ stage: '本地A', status: 'success', local: true, dur: 1 }],
      }],
    }), 'utf8')
    const ctx = loadAppendHarness(storeFile)
    await ctx.appendPipelineHistory({
      tag: 't-h', status: 'failed', pipeline: 'PL', by: 'alice ⏰', ts: 200,
      logs: [{ stage: '定时B', status: 'failed', dur: 2 }],
    })
    const raw = JSON.parse(await readFile(storeFile, 'utf8'))
    assert.equal(raw.history.length, 1, '同 tag 只留一条运行历史')
    assert.equal(raw.history[0].no, 5, '沿用原编号')
    assert.equal(raw.history[0].status, 'failed')
    assert.equal(raw.config.buildNo, 5, '不推进 buildNo')
    const logNames = Array.from(raw.history[0].logs.map(e => e.stage))
    assert.equal(logNames.includes('本地A') && logNames.includes('定时B') && logNames.length === 2, true, logNames.join(','))
    assert.equal(raw.history[0].logs.find(e => e.stage === '本地A').local, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('appendPipelineHistory：无同 tag 走新增（纯定时/独立运行路径不变）', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'pl-hist-add-'))
  const storeFile = pathJoin(dir, 'worktable-pipeline.json')
  try {
    await writeFile(storeFile, JSON.stringify({
      config: { buildNo: 1 },
      history: [{ no: 1, tag: 't-old', ts: 1, status: 'success', logs: [] }],
    }), 'utf8')
    const ctx = loadAppendHarness(storeFile)
    await ctx.appendPipelineHistory({
      tag: 't-new', status: 'success', pipeline: 'PL', logs: [{ stage: 'S', status: 'success' }],
    })
    const raw = JSON.parse(await readFile(storeFile, 'utf8'))
    assert.equal(raw.history.length, 2)
    assert.equal(raw.history[0].tag, 't-new')
    assert.equal(raw.history[0].no, 2)
    assert.equal(raw.config.buildNo, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
