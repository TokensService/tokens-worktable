import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

/* 运行级设置快照（服务端）：提交 API 运行 / 登记计划时把 scriptsDir / Jenkins / EvalTokens / 普罗 / 归档 /
   预设脚本深拷贝进 plan.settings，execPlan 只读快照——下一次运行前的设置修改不影响已排队或开跑的流水线。 */
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

function loadSnapshotFns() {
  const ctx = vm.createContext({})
  for (const name of ['snapshotPipelineRunSettings', 'resolvePlanRunSettings']) {
    vm.runInContext(stripTypeScriptTypes(extractFunction(name), { mode: 'transform' }), ctx)
  }
  return ctx
}

const fullConfig = () => ({
  scriptsDir: '/custom/scripts',
  jenkins: { url: 'http://jk', user: 'ju', token: 'jt', mode: 'local' },
  evaltok: { url: 'http://et', token: 'etk', mode: 'remote' },
  prom: { url: 'http://prom', collectScript: 'collect.py', modelName: 'm1' },
  archiveDir: '/var/log/op_test',
  archiveScriptName: 'collect_logs.sh',
  cleanupScript: { name: 'cleanup.sh', path: '/custom/scripts/cleanup.sh', params: [], values: {} },
  checkScript: { name: 'check.sh', path: '/custom/scripts/check.sh', params: [], values: {} },
  profilingScript: { name: 'prof.sh', path: '/custom/scripts/prof.sh', params: [], values: {} },
  buildNo: 9,
  pipelines: [{ id: 'p1' }],
})

test('snapshotPipelineRunSettings：深拷贝运行相关设置，后续改配置不影响已取快照', () => {
  const { snapshotPipelineRunSettings } = loadSnapshotFns()
  const config = fullConfig()
  const snap = JSON.parse(JSON.stringify(snapshotPipelineRunSettings(config)))
  assert.equal(snap.scriptsDir, '/custom/scripts')
  assert.deepEqual(snap.jenkins, { url: 'http://jk', user: 'ju', token: 'jt', mode: 'local' })
  assert.equal(snap.evaltok.url, 'http://et')
  assert.equal(snap.prom.collectScript, 'collect.py')
  assert.equal(snap.archiveDir, '/var/log/op_test')
  assert.equal(snap.archiveScriptName, 'collect_logs.sh')
  assert.equal(snap.cleanupScript.name, 'cleanup.sh')
  assert.equal(snap.checkScript.name, 'check.sh')
  assert.equal(snap.profilingScript.name, 'prof.sh')
  assert.ok(!('buildNo' in snap), '非运行字段不进快照')
  assert.ok(!('pipelines' in snap), '流水线定义不进设置快照（阶段已单独快照）')
  config.jenkins.url = 'http://jk2'
  config.prom.collectScript = 'other.py'
  config.cleanupScript.name = 'changed.sh'
  assert.equal(snap.jenkins.url, 'http://jk', '改配置不影响快照')
  assert.equal(snap.prom.collectScript, 'collect.py', '改收集脚本不影响快照')
  assert.equal(snap.cleanupScript.name, 'cleanup.sh', '改预设脚本不影响快照')
})

test('snapshotPipelineRunSettings：archiveScript 旧字段名兼容到 archiveScriptName', () => {
  const { snapshotPipelineRunSettings } = loadSnapshotFns()
  const snap = snapshotPipelineRunSettings({ archiveScript: 'legacy.sh', archiveDir: '/a' })
  assert.equal(snap.archiveScriptName, 'legacy.sh')
  const prefer = snapshotPipelineRunSettings({ archiveScriptName: 'new.sh', archiveScript: 'legacy.sh' })
  assert.equal(prefer.archiveScriptName, 'new.sh', 'archiveScriptName 优先')
})

test('resolvePlanRunSettings：计划 settings 优先，缺字段用当前配置补齐，无 settings 整体回落', () => {
  const { resolvePlanRunSettings } = loadSnapshotFns()
  const live = fullConfig()
  live.jenkins = { url: 'http://live-jk' }
  live.prom = { collectScript: 'live.py' }
  const planned = resolvePlanRunSettings({
    settings: {
      scriptsDir: '/plan/scripts',
      jenkins: { url: 'http://plan-jk', user: 'pu', token: 'pt', mode: 'local' },
      prom: { collectScript: 'plan.py' },
      // 缺 evaltok / archive* / 预设脚本：由 live 补齐
    },
  }, live)
  assert.equal(planned.scriptsDir, '/plan/scripts', '计划自带 scriptsDir 优先')
  assert.equal(planned.jenkins.url, 'http://plan-jk', '计划自带 Jenkins 优先')
  assert.equal(planned.prom.collectScript, 'plan.py', '计划自带普罗配置优先')
  assert.equal(planned.evaltok.url, 'http://et', '计划缺 evaltok 时用当前配置补齐')
  assert.equal(planned.archiveScriptName, 'collect_logs.sh')
  assert.equal(planned.cleanupScript && planned.cleanupScript.name, 'cleanup.sh')
  const fallback = resolvePlanRunSettings({}, live)
  assert.equal(fallback.jenkins.url, 'http://live-jk', '旧计划无 settings 时按执行开始时的配置快照')
  assert.equal(fallback.scriptsDir, '/custom/scripts')
})

test('源码契约：buildPipelineApiRun 写入 settings，execPlan 经 resolvePlanRunSettings 取 runCfg', () => {
  /* buildPipelineApiRun 返回类型含对象字面量，extractFunction 的花括号配平会截在签名上——直接搜源码 */
  assert.match(source, /settings:\s*snapshotPipelineRunSettings\(config\)/, 'buildPipelineApiRun 须把设置快照写入 plan')
  assert.match(extractFunction('execPlan'), /const runCfg = resolvePlanRunSettings\(pl, cfg\)/)
  assert.match(extractFunction('execPlan'), /materializeServerPipelineStages\([\s\S]*?runCfg\)/)
  assert.match(extractFunction('execPlan'), /executeServerHttpStage\(s, runCtx, runCfg/)
  assert.match(extractFunction('execPlan'), /executeServerEvaltokensStage\(s, runCtx, runCfg/)
  assert.match(extractFunction('execPlan'), /serverPromCollectScript\(runCfg\)/)
})
