import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

function extractHelpers() {
  const start = source.indexOf('function cleanPipelineHistory(')
  const end = source.indexOf('/** git 状态快照', start)
  assert.ok(start >= 0 && end > start, 'history helpers not found')
  return source.slice(start, end)
}

async function loadHarness(t, store) {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'pipeline-hist-tag-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storeFile = pathResolve(dir, 'storages', 'worktable-pipeline.json')
  await mkdir(dirname(storeFile), { recursive: true })
  await writeFile(storeFile, JSON.stringify(store), 'utf8')
  const code = stripTypeScriptTypes([
    extractHelpers(),
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
    Promise, Buffer, Date, Math, JSON, console: { warn() {}, log() {}, error() {} },
    pathResolve, readFile, dirname, mkdir, writeFile,
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })
  return { ctx, storeFile }
}

test('appendPipelineHistory：同 tag（页面启动时的「进行中」记录）原地更新为终态，不新增第二条', async t => {
  const running = {
    no: 5, tag: 'run-tag-1', pipeline: '部署', status: 'running', dur: '0s',
    ts: Date.now() - 1000, startTs: Date.now() - 1000, logs: [],
  }
  const { ctx, storeFile } = await loadHarness(t, {
    config: { buildNo: 5 },
    history: [running],
  })
  await ctx.appendPipelineHistory({
    no: 0, tag: 'run-tag-1', pipeline: '部署', status: 'success', dur: '3s',
    by: 'alice', logs: [{ stage: '构建', status: 'success' }], ts: Date.now(),
  })
  const parsed = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.equal(parsed.history.length, 1, '同 tag 原地替换，历史里不得留下「进行中 + 已完成」两条')
  assert.equal(parsed.history[0].status, 'success')
  assert.equal(parsed.history[0].no, 5, '沿用原编号，不另占新号')
  assert.equal(parsed.history[0].tag, 'run-tag-1')
  assert.equal(parsed.history[0].logs.length, 1)
  assert.equal(parsed.config.buildNo, 5, '原地更新不推进 buildNo')
})

test('appendPipelineHistory：无同 tag 记录时照常新增并占号', async t => {
  const { ctx, storeFile } = await loadHarness(t, {
    config: { buildNo: 2 },
    history: [{ no: 2, tag: 'other', status: 'success', ts: 1 }],
  })
  await ctx.appendPipelineHistory({
    no: 0, tag: 'fresh-tag', pipeline: 'P', status: 'failed', dur: '1s', by: 'bob', logs: [],
  })
  const parsed = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.equal(parsed.history.length, 2)
  assert.equal(parsed.history[0].tag, 'fresh-tag')
  assert.equal(parsed.history[0].no, 3)
  assert.equal(parsed.config.buildNo, 3)
})

test('appendPipelineHistory：无 tag 的记录仍走新增（旧路径）', async t => {
  const { ctx, storeFile } = await loadHarness(t, {
    config: { buildNo: 1 },
    history: [{ no: 1, tag: 'x', status: 'success', ts: 1 }],
  })
  await ctx.appendPipelineHistory({
    no: 0, pipeline: 'P', status: 'success', dur: '1s', by: 'bob', logs: [], ts: 9,
  })
  const parsed = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.equal(parsed.history.length, 2)
  assert.equal(parsed.history[0].no, 2)
})
