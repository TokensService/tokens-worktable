import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { resolve as pathResolve } from 'node:path'
import vm from 'node:vm'

/* 流水线脚本目录默认值（src/index.ts）：设置文件（worktable-pipeline.json 的 config.scriptsDir）
   已配置即用；未配置时服务端执行器兜底到插件安装后的 projects/pipeline/scripts */
const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function extractFunction(name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
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

function loadFunctions(names, injections = {}) {
  const ctx = vm.createContext({ pathResolve, ...injections })
  for (const name of names) vm.runInContext(stripTypeScriptTypes(extractFunction(name), { mode: 'transform' }), ctx)
  return ctx
}

test('resolvePipelineScriptsDir：设置文件已配置 scriptsDir 即用（trim 后非空）', () => {
  const { resolvePipelineScriptsDir } = loadFunctions(['resolvePipelineScriptsDir'])
  assert.equal(resolvePipelineScriptsDir({ scriptsDir: '/custom/scripts' }, '/installed/scripts'), '/custom/scripts')
  assert.equal(resolvePipelineScriptsDir({ scriptsDir: '  /custom/scripts  ' }, '/installed/scripts'), '/custom/scripts')
})

test('resolvePipelineScriptsDir：未配置/空白/非字符串时兜底安装默认路径', () => {
  const { resolvePipelineScriptsDir } = loadFunctions(['resolvePipelineScriptsDir'])
  assert.equal(resolvePipelineScriptsDir({}, '/installed/scripts'), '/installed/scripts')
  assert.equal(resolvePipelineScriptsDir({ scriptsDir: '' }, '/installed/scripts'), '/installed/scripts')
  assert.equal(resolvePipelineScriptsDir({ scriptsDir: '   ' }, '/installed/scripts'), '/installed/scripts')
  assert.equal(resolvePipelineScriptsDir({ scriptsDir: 42 }, '/installed/scripts'), '/installed/scripts')
  assert.equal(resolvePipelineScriptsDir(null, '/installed/scripts'), '/installed/scripts')
})

test('serverPromCollectScript：收集脚本路径按 scriptsDir 解析，未配置走安装默认', () => {
  const ctx = loadFunctions(['resolvePipelineScriptsDir', 'serverPromCollectScript'], { DEFAULT_PIPELINE_SCRIPTS_DIR: '/installed/scripts' })
  const custom = ctx.serverPromCollectScript({ prom: { collectScript: 'collect.py' }, scriptsDir: '/custom' })
  assert.equal(custom.path, pathResolve('/custom', 'collect.py'))
  const fallback = ctx.serverPromCollectScript({ prom: { collectScript: 'collect.py' } })
  assert.equal(fallback.path, pathResolve('/installed/scripts', 'collect.py'))
  assert.equal(ctx.serverPromCollectScript({ prom: {} }), null)
  assert.equal(ctx.serverPromCollectScript({}), null)
})

test('源码契约：安装默认常量与两个执行入口都经 resolvePipelineScriptsDir 解析', () => {
  assert.match(source, /const DEFAULT_PIPELINE_SCRIPTS_DIR = pathResolve\(PLUGIN_DIR, 'projects', 'pipeline', 'scripts'\)/)
  const execPlan = extractFunction('execPlan')
  assert.match(execPlan, /const scriptsDir = resolvePipelineScriptsDir\(cfg, DEFAULT_PIPELINE_SCRIPTS_DIR\)/)
  const promCollect = extractFunction('serverPromCollectScript')
  assert.match(promCollect, /resolvePipelineScriptsDir\(config, DEFAULT_PIPELINE_SCRIPTS_DIR\)/)
})
