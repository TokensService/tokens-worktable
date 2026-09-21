import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function extractFunction(name) {
  const marker = new RegExp(`function\\s+${name}\\s*\\(`)
  const match = marker.exec(source)
  assert.ok(match, `src/index.ts 缺少函数 ${name}`)
  const bodyStart = source.indexOf('{', match.index)
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}' && --depth === 0) return source.slice(match.index, index + 1)
  }
  throw new Error(`无法提取函数 ${name}`)
}

function merge(clientConfig, baseConfig, diskConfig) {
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(stripTypeScriptTypes(extractFunction('mergePipelineConfigForWrite'), { mode: 'transform' }), ctx)
  return JSON.parse(JSON.stringify(ctx.mergePipelineConfigForWrite(clientConfig, baseConfig, diskConfig)))
}

function legacyConflicts(clientConfig, diskConfig) {
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(stripTypeScriptTypes(extractFunction('pipelineConfigDifferenceIds'), { mode: 'transform' }), ctx)
  return JSON.parse(JSON.stringify(ctx.pipelineConfigDifferenceIds(clientConfig, diskConfig)))
}

function mergeOne(clientPipeline, basePipeline, diskConfig) {
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(stripTypeScriptTypes(extractFunction('mergePipelineOneForWrite'), { mode: 'transform' }), ctx)
  return JSON.parse(JSON.stringify(ctx.mergePipelineOneForWrite(clientPipeline, basePipeline, diskConfig)))
}

const pipeline = (id, name, stage = 'build') => ({ id, name, stages: [{ id: stage, name: stage }] })

test('两个浏览器修改不同流水线时按 id 合并，双方修改都保留', () => {
  const base = { pipelines: [pipeline('p1', '流水线一'), pipeline('p2', '流水线二')], theme: 'dark' }
  const disk = { pipelines: [pipeline('p1', '流水线一-A'), pipeline('p2', '流水线二')], theme: 'dark' }
  const client = { pipelines: [pipeline('p1', '流水线一'), pipeline('p2', '流水线二-B')], theme: 'light' }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.pipelines.map(item => [item.id, item.name]), [
    ['p1', '流水线一-A'],
    ['p2', '流水线二-B'],
  ])
  assert.equal(result.config.theme, 'light', '流水线之外的客户端配置仍按当前保存值提交')
})

test('两个浏览器修改同一流水线时拒绝静默覆盖并报告冲突 id', () => {
  const base = { pipelines: [pipeline('p1', '原始')] }
  const disk = { pipelines: [pipeline('p1', '浏览器 A')] }
  const client = { pipelines: [pipeline('p1', '浏览器 B')] }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, ['p1'])
  assert.equal(result.config.pipelines[0].name, '浏览器 A', '冲突时以磁盘版本供调用方刷新，不伪造已保存')
})

test('旧浏览器快照未改动流水线时保留服务端后来新增与删除的定义', () => {
  const base = { pipelines: [pipeline('p1', '保留'), pipeline('p2', '后来删除')] }
  const disk = { pipelines: [pipeline('p1', '保留'), pipeline('p3', '后来新增')] }
  const client = structuredClone(base)

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.pipelines.map(item => item.id), ['p1', 'p3'])
})

test('一端删除、另一端修改同一流水线时按冲突处理', () => {
  const base = { pipelines: [pipeline('p1', '原始')] }
  const disk = { pipelines: [pipeline('p1', '浏览器 A 修改')] }
  const client = { pipelines: [] }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, ['p1'])
  assert.equal(result.config.pipelines[0].name, '浏览器 A 修改')
})

test('旧页面不带基线时，只要流水线定义不同就报告冲突 id，不能绕过并发保护', () => {
  const disk = { pipelines: [pipeline('p1', '服务端新版'), pipeline('p2', '服务端新增')] }
  const stale = { pipelines: [pipeline('p1', '旧页面修改')] }

  assert.deepEqual(legacyConflicts(stale, disk), ['p1', 'p2'])
  assert.match(source, /baseConfig\s*\?\s*mergePipelineConfigForWrite[\s\S]*pipelineConfigDifferenceIds\(config, diskCfg\)/)
})

test('旧页面流水线定义与磁盘一致时仍可写历史和其他配置', () => {
  const disk = { pipelines: [pipeline('p1', '一致')], theme: 'dark' }
  const client = { pipelines: [pipeline('p1', '一致')], theme: 'light' }
  assert.deepEqual(legacyConflicts(client, disk), [])
})

test('客户端保存不带历史正文时按磁盘历史保留，buildNo/histClearedAt 取双方较大值', () => {
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(stripTypeScriptTypes(extractFunction('mergePipelineHistoryForWrite'), { mode: 'transform' }), ctx)
  /* 编辑器显式保存的瘦身负载（omitHistory）到达服务端时 clientHistory=[]，
     磁盘上的定时/他端/本页运行历史必须全部保留（清空点之前的仍视为已删）。 */
  const result = JSON.parse(JSON.stringify(ctx.mergePipelineHistoryForWrite(
    { buildNo: 3 },
    { buildNo: 7, histClearedAt: 100 },
    [],
    [{ tag: 'a', ts: 200 }, { tag: 'b', ts: 50 }],
  )))
  assert.deepEqual(result.history.map(record => record.tag), ['a'])
  assert.equal(result.config.buildNo, 7)
  assert.equal(result.config.histClearedAt, 100)
})

test('单条保存：磁盘该条未偏离基线时原位替换，其余流水线与配置字段不动', () => {
  const disk = { pipelines: [pipeline('p1', '原始'), pipeline('p2', '保留')], jenkins: { url: 'http://j' }, buildNo: 9 }

  const result = mergeOne(pipeline('p1', '编辑后'), pipeline('p1', '原始'), disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.pipelines.map(item => [item.id, item.name]), [['p1', '编辑后'], ['p2', '保留']])
  assert.deepEqual(result.config.jenkins, { url: 'http://j' }, '历史与其他配置字段一律不动')
  assert.equal(result.config.buildNo, 9)
})

test('单条保存：新建（基线为 null 且磁盘无此 id）追加到列表末尾', () => {
  const disk = { pipelines: [pipeline('p1', '已有')] }

  const result = mergeOne(pipeline('p2', '新建'), null, disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.pipelines.map(item => item.id), ['p1', 'p2'])
})

test('单条保存：磁盘该条已被他端修改或删除时报告冲突且不写盘', () => {
  const moved = mergeOne(pipeline('p1', '浏览器 B'), pipeline('p1', '原始'), { pipelines: [pipeline('p1', '浏览器 A')] })
  assert.deepEqual(moved.conflicts, ['p1'])
  assert.equal(moved.config.pipelines[0].name, '浏览器 A', '冲突时以磁盘版本供调用方刷新')

  const deleted = mergeOne(pipeline('p1', '浏览器 B'), pipeline('p1', '原始'), { pipelines: [] })
  assert.deepEqual(deleted.conflicts, ['p1'], '他端删除同一条同样算偏离基线')
})

test('单条保存路由注册于 /api/worktable/pipeline/save-one 且历史不经过合并', () => {
  assert.match(source, /path:\s*'\/api\/worktable\/pipeline\/save-one'/)
  const start = source.indexOf("path: '/api/worktable/pipeline/save-one'")
  const end = source.indexOf('webServer.register', start)
  const route = source.slice(start, end)
  assert.doesNotMatch(route, /mergePipelineHistoryForWrite/, '单条保存不触碰历史合并，磁盘历史原样保留')
})
