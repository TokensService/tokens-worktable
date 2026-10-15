import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { resolve as pathResolve } from 'node:path'
import vm from 'node:vm'

/* 流水线脚本目录默认值（src/index.ts）：设置文件（worktable-pipeline.json 的 config.scriptsDir）
   已配置即用；未配置时服务端执行器兜底到插件安装后的 projects/pipeline/scripts；
   配置值指向的目录已不存在（如已删除的 git worktree）时同样兜底安装默认（存在性检查经注入的
   statSync 判定；未注入 statSync 的 vm 抽取上下文跳过检查、维持纯映射语义）。 */
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

test('resolvePipelineScriptsDir：配置目录已不存在（如已删除的 worktree）时兜底安装默认并回调告知', () => {
  const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
  const warns = []
  const ctx = loadFunctions(['resolvePipelineScriptsDir'], { statSync: enoent })
  const onMissingDir = (configured, fallback) => warns.push(configured + '→' + fallback)
  assert.equal(ctx.resolvePipelineScriptsDir({ scriptsDir: '/deleted/worktree/scripts' }, '/installed/scripts', onMissingDir), '/installed/scripts')
  assert.deepEqual(warns, ['/deleted/worktree/scripts→/installed/scripts'])
  // 未传回调：静默兜底，不抛错
  assert.equal(ctx.resolvePipelineScriptsDir({ scriptsDir: '/deleted/worktree/scripts' }, '/installed/scripts'), '/installed/scripts')
  // 回调自身抛错被吞掉，不影响解析结果
  assert.equal(ctx.resolvePipelineScriptsDir({ scriptsDir: '/deleted/worktree/scripts' }, '/installed/scripts', () => { throw new Error('boom') }), '/installed/scripts')
})

test('resolvePipelineScriptsDir：配置路径存在但不是目录 → 兜底；是目录 → 原样使用', () => {
  const asFile = loadFunctions(['resolvePipelineScriptsDir'], { statSync: () => ({ isDirectory: () => false }) })
  assert.equal(asFile.resolvePipelineScriptsDir({ scriptsDir: '/custom/file' }, '/installed/scripts'), '/installed/scripts')
  const asDir = loadFunctions(['resolvePipelineScriptsDir'], { statSync: () => ({ isDirectory: () => true }) })
  assert.equal(asDir.resolvePipelineScriptsDir({ scriptsDir: '/custom/scripts' }, '/installed/scripts'), '/custom/scripts')
  // 未配置/空白时不触发存在性检查（statSync 不应被调用）
  let called = 0
  const counting = loadFunctions(['resolvePipelineScriptsDir'], { statSync: () => { called += 1; return { isDirectory: () => true } } })
  assert.equal(counting.resolvePipelineScriptsDir({ scriptsDir: '  ' }, '/installed/scripts'), '/installed/scripts')
  assert.equal(called, 0)
})

test('源码契约：安装默认常量与两个执行入口都经 resolvePipelineScriptsDir 解析', () => {
  assert.match(source, /const DEFAULT_PIPELINE_SCRIPTS_DIR = pathResolve\(PLUGIN_DIR, 'projects', 'pipeline', 'scripts'\)/)
  const execPlan = extractFunction('execPlan')
  assert.match(execPlan, /const scriptsDir = resolvePipelineScriptsDir\(runCfg, DEFAULT_PIPELINE_SCRIPTS_DIR,/)
  const promCollect = extractFunction('serverPromCollectScript')
  assert.match(promCollect, /resolvePipelineScriptsDir\(config, DEFAULT_PIPELINE_SCRIPTS_DIR\)/)
})
