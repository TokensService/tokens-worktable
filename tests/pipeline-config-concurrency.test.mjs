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
