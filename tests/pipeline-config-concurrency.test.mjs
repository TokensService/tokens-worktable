import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const rawSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
/* 先整体去类型（strip 模式保留注释标记、类型注解抹成空白、不改变偏移），后续切片/抽函数都在去类型后的
   源码上进行，避免函数返回类型里的 {} 干扰提取器的 brace 配对（如 trustedPipelineViolations 的返回类型）；
   路由文本断言同样在该源码上进行（strip 不动代码文本）。 */
const source = stripTypeScriptTypes(rawSource, { mode: 'strip' })

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

/* 合并函数引用的共享元数据助手（剥离比对 + 键序无关深比较 + 三方合并 + 节点环境条目比对），抽函数时一并加载 */
const SHARED_META_HELPERS = ['stripPipelineSharedMeta', 'deepEqualIgnoring', 'samePipelineContent', 'sameEnvironmentContent', 'sameRepositoryContent', 'mergePipelineFavoriteUsers', 'mergePipelinePinnedAt', 'withPipelineSharedMeta']

function loadFunctions(names, extraDecls = []) {
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext([...extraDecls, ...names.map(extractFunction)].join('\n'), ctx)
  return ctx
}

/* BUILTIN_PIPELINE_ID 常量声明（trustedPipelineViolations 引用；从源码抽取，避免字面量分叉） */
const BUILTIN_CONST_DECL = /^const BUILTIN_PIPELINE_ID = .+$/m.exec(source)[0]
  + '\n' + /^const BUILTIN_PIPELINE_IDS = .+$/m.exec(source)[0]

function merge(clientConfig, baseConfig, diskConfig) {
  /* mergePipelineConfigForWrite 现依赖 preserveDiskOnlyConfigKeys（磁盘独有键保留），抽取时一并加载 */
  const ctx = loadFunctions([...SHARED_META_HELPERS, 'preserveDiskOnlyConfigKeys', 'mergePipelineConfigForWrite'])
  return JSON.parse(JSON.stringify(ctx.mergePipelineConfigForWrite(clientConfig, baseConfig, diskConfig)))
}

function legacyConflicts(clientConfig, diskConfig) {
  const ctx = loadFunctions(['pipelineConfigDifferenceIds'])
  return JSON.parse(JSON.stringify(ctx.pipelineConfigDifferenceIds(clientConfig, diskConfig)))
}

function mergeOne(clientPipeline, basePipeline, diskConfig) {
  const ctx = loadFunctions([...SHARED_META_HELPERS, 'mergePipelineOneForWrite'])
  return JSON.parse(JSON.stringify(ctx.mergePipelineOneForWrite(clientPipeline, basePipeline, diskConfig)))
}

function trustedViolations(storedConfig, mergedConfig) {
  const ctx = loadFunctions(['deepEqualIgnoring', 'isBuiltinPipelineEntry', 'trustedPipelineViolations'], [BUILTIN_CONST_DECL])
  return JSON.parse(JSON.stringify(ctx.trustedPipelineViolations(storedConfig, mergedConfig)))
}

const pipeline = (id, name, stage = 'build') => ({ id, name, stages: [{ id: stage, name: stage }] })
/* 带共享元数据的条目：favorites 为 null 时省略 favoriteUsers 键，pinnedAt 仅传入时写键 */
const metaPipeline = (id, name, favorites = [], pinnedAt) => {
  const p = pipeline(id, name)
  if (favorites !== null) p.favoriteUsers = favorites
  if (pinnedAt !== undefined) p.pinnedAt = pinnedAt
  return p
}

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
  vm.runInContext(stripTypeScriptTypes(
    [extractFunction('mergeStageLogsForHistory'), extractFunction('mergePipelineHistoryForWrite')].join('\n'),
    { mode: 'transform' },
  ), ctx)
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

/* ---------- favoriteUsers / pinnedAt：合并层豁免 + 三方合并（多用户 phantom 冲突修复） ---------- */

test('单条保存：他端并发收藏不再误判冲突，写回收藏为三方合并结果（保留双方）', () => {
  const base = metaPipeline('p1', '原始', ['bob'])
  const disk = { pipelines: [metaPipeline('p1', '原始', ['bob', 'alice']), pipeline('p2', '保留')], buildNo: 9 }

  const result = mergeOne({ ...metaPipeline('p1', '编辑后', ['bob']) }, base, disk)

  assert.deepEqual(result.conflicts, [], '磁盘仅 favoriteUsers 偏离基线（他人收藏）不再 409')
  const saved = result.config.pipelines.find(item => item.id === 'p1')
  assert.equal(saved.name, '编辑后', '内容取客户端编辑结果')
  assert.deepEqual(saved.favoriteUsers, ['bob', 'alice'], '本端收藏与他端并发收藏都保留')
  assert.deepEqual(result.config.pipelines.map(item => item.id), ['p1', 'p2'], '其余条目不动')
  assert.equal(result.config.buildNo, 9)
})

test('单条保存：并发取消收藏生效（即使磁盘仍有该用户），合并顺序先 client 后 disk 独有', () => {
  const base = metaPipeline('p1', '原始', ['a', 'b'])
  const disk = { pipelines: [metaPipeline('p1', '原始', ['b', 'd', 'a'])] }   // 他端新增 d，仍留 b
  const clientEdit = metaPipeline('p1', '编辑后', ['c', 'a'])                 // 本端删 b、增 c

  const result = mergeOne(clientEdit, base, disk)

  assert.deepEqual(result.conflicts, [])
  const saved = result.config.pipelines[0]
  assert.equal(saved.name, '编辑后')
  assert.deepEqual(saved.favoriteUsers, ['c', 'a', 'd'], '(client ∩ disk) ∪ (client − base) ∪ (disk − base)，b 被本端取消')
})

test('全量保存：本端编辑与他端收藏同一条目不再冲突，内容取本端、收藏合并', () => {
  const base = { pipelines: [metaPipeline('p1', '原始', [])] }
  const disk = { pipelines: [metaPipeline('p1', '原始', ['alice'])] }        // 他端仅收藏
  const client = { pipelines: [metaPipeline('p1', '编辑后', [])] }           // 本端编辑内容

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.equal(result.config.pipelines[0].name, '编辑后')
  assert.deepEqual(result.config.pipelines[0].favoriteUsers, ['alice'], '他端收藏合入本端编辑结果')
})

test('全量保存：本端复制新增条目时他端收藏无关条目不再整条 409，副本与既有条目均正确', () => {
  const base = { pipelines: [metaPipeline('p1', '甲', []), metaPipeline('p2', '乙', [])] }
  const disk = { pipelines: [metaPipeline('p1', '甲', []), metaPipeline('p2', '乙', ['alice'])] }
  const client = { pipelines: [metaPipeline('p1', '甲', []), metaPipeline('p2', '乙', []), pipeline('p2-copy', '乙-副本')] }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.pipelines.map(item => item.id), ['p1', 'p2', 'p2-copy'], '磁盘顺序在前，本端新增追加')
  assert.deepEqual(result.config.pipelines.find(item => item.id === 'p2').favoriteUsers, ['alice'], '无关条目的他端收藏保留')
  const copy = result.config.pipelines.find(item => item.id === 'p2-copy')
  assert.equal(copy.name, '乙-副本')
  assert.ok(!('favoriteUsers' in copy) && !('pinnedAt' in copy), '仅 client 独有的新条目保持原样，不套归一')
})

test('全量保存：pinnedAt 三方合并——本端置顶取本端、本端未动取磁盘、双方同改取 client，且不再冲突', () => {
  const base = { pipelines: [pipeline('p1', '甲'), pipeline('p2', '乙'), pipeline('p3', '丙'), metaPipeline('p4', '丁', null, 10)] }
  const client = { pipelines: [metaPipeline('p1', '甲', null, 100), pipeline('p2', '乙'), pipeline('p3', '丙'), metaPipeline('p4', '丁', null, 100)] }
  const disk = { pipelines: [pipeline('p1', '甲'), metaPipeline('p2', '乙', null, 200), pipeline('p3', '丙'), metaPipeline('p4', '丁', null, 200)] }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [], '剥离后内容相同的 pinnedAt-only 分歧不再产生冲突')
  const byId = Object.fromEntries(result.config.pipelines.map(item => [item.id, item]))
  assert.equal(byId.p1.pinnedAt, 100, '本端置顶（基线无）→ 取本端')
  assert.equal(byId.p2.pinnedAt, 200, '本端未动 → 取磁盘')
  assert.ok(!('pinnedAt' in byId.p3), '双方都未置顶 → 不写 pinnedAt 键')
  assert.equal(byId.p4.pinnedAt, 100, '双方同时改 → 按三方规则取 client')
})

test('单条保存：磁盘仅置顶变化不算偏离基线，写回沿用磁盘置顶值', () => {
  const base = pipeline('p1', '原始')
  const disk = { pipelines: [metaPipeline('p1', '原始', null, 300)] }

  const result = mergeOne(metaPipeline('p1', '编辑后'), base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.equal(result.config.pipelines[0].name, '编辑后')
  assert.equal(result.config.pipelines[0].pinnedAt, 300, '本端未动置顶 → 取磁盘值')
})

test('全量保存：双方真实修改同一条目内容仍报告冲突（收藏并存不误判放行）', () => {
  const base = { pipelines: [metaPipeline('p1', '原始', ['alice'])] }
  const disk = { pipelines: [metaPipeline('p1', '甲改', ['alice', 'bob'])] }
  const client = { pipelines: [metaPipeline('p1', '乙改', ['alice'])] }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, ['p1'], '内容（name/stages 等）真改仍 409')
  assert.equal(result.config.pipelines[0].name, '甲改', '冲突时以磁盘版本供调用方刷新')
})

test('守卫：trusted/内置条目仅 favoriteUsers 或 pinnedAt 差异无违规，内容差异仍违规', () => {
  const stored = { pipelines: [
    { ...metaPipeline('t1', '可信', []), trusted: true, pinnedAt: 5 },
    { ...metaPipeline('pl-xds', '内置', ['alice']), builtIn: true },
  ] }
  const metaOnly = { pipelines: [
    { ...metaPipeline('t1', '可信', ['carol']), trusted: true, pinnedAt: 9 },
    { ...metaPipeline('pl-xds', '内置', ['alice', 'bob']), builtIn: true, pinnedAt: 7 },
  ] }
  assert.deepEqual(trustedViolations(stored, metaOnly), { edit: [], mark: [], builtinEdit: [], builtinCreate: [] },
    'favoriteUsers / pinnedAt 属非内容元数据，豁免 trusted 与内置两个分支')

  const tampered = { pipelines: [
    { ...metaPipeline('t1', '可信-被改', []), trusted: true, pinnedAt: 5 },
    { ...metaPipeline('pl-xds', '内置', ['alice']), builtIn: true, stages: [] },
  ] }
  const violations = trustedViolations(stored, tampered)
  assert.deepEqual(violations.edit, ['t1'], 'trusted 条目内容差异仍违规')
  assert.deepEqual(violations.builtinEdit, ['pl-xds'], '内置条目内容差异仍违规')
})

test('形状归一：收藏合并结果为空时省略 favoriteUsers 键，pinnedAt 为 0 时省略 pinnedAt 键', () => {
  const base = { pipelines: [metaPipeline('p1', '甲', ['alice'], 100)] }
  const disk = { pipelines: [metaPipeline('p1', '甲', ['alice'], 100)] }
  const client = { pipelines: [metaPipeline('p1', '甲-改', [], 0)] }   // 本端取消收藏 + 取消置顶并编辑

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  const saved = result.config.pipelines[0]
  assert.equal(saved.name, '甲-改')
  assert.ok(!('favoriteUsers' in saved), '收藏全部取消后不再保留空数组键（客户端迁移会补回 []）')
  assert.ok(!('pinnedAt' in saved), '取消置顶后不再保留 pinnedAt 键')

  const one = mergeOne(metaPipeline('p1', '编辑后', [], 0), metaPipeline('p1', '甲', ['alice'], 100), disk)
  assert.deepEqual(one.conflicts, [])
  assert.ok(!('favoriteUsers' in one.config.pipelines[0]) && !('pinnedAt' in one.config.pipelines[0]), '单条保存同样归一')
})

/* ---------- 节点环境（environments）按 id 三方合并：整表 last-write-wins 修复 ---------- */
/* 场景原型：两个浏览器同时打开设置页，A 添加节点落盘后，B（仍是旧列表快照）添加另一个节点——
   修复前 B 的整表保存把 A 的节点覆盖丢失；修复后按 id 合并，双方新增都保留。 */
const env = (id, name, extra) => ({ id, name, ip: '10.0.0.1', nodeIp: '', user: 'root', pass: '', ...(extra || {}) })

test('节点环境：两个浏览器各添加不同节点，双方新增都保留（磁盘序在前，本端新增追加）', () => {
  const base = { environments: [env('env-1', '节点一')] }
  const disk = { environments: [env('env-1', '节点一'), env('env-a', 'A 添加')] }
  const client = { pipelines: [], environments: [env('env-1', '节点一'), env('env-b', 'B 添加')] }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [], '节点环境合并不产生 409 冲突')
  assert.deepEqual(result.config.environments.map(item => item.id), ['env-1', 'env-a', 'env-b'], '双方新增都保留，磁盘顺序在前')
})

test('节点环境：本端未改动的条目以磁盘为准（他端修改/删除同步生效）', () => {
  const base = { environments: [env('env-1', '节点一'), env('env-2', '节点二'), env('env-3', '节点三')] }
  const disk = { environments: [env('env-1', '节点一-他端改名'), env('env-3', '节点三')] }   // 他端改 env-1、删 env-2
  const client = { pipelines: [], environments: [env('env-1', '节点一'), env('env-2', '节点二'), env('env-3', '节点三')] }   // 本端未动

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.environments.map(item => [item.id, item.name]), [['env-1', '节点一-他端改名'], ['env-3', '节点三']])
})

test('节点环境：本端删除磁盘未动的条目删除生效；本端修改取本端', () => {
  const base = { environments: [env('env-1', '节点一'), env('env-2', '节点二')] }
  const disk = { environments: [env('env-1', '节点一'), env('env-2', '节点二')] }
  const client = { pipelines: [], environments: [env('env-2', '节点二', { pass: 'new-pass' })] }   // 本端删 env-1、改 env-2

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.environments.map(item => item.id), ['env-2'], '本端删除生效')
  assert.equal(result.config.environments[0].pass, 'new-pass', '本端修改生效')
})

test('节点环境：同 id 双边都改按后写赢取本端，不报冲突；本端改 vs 他端删由本端复活', () => {
  const base = { environments: [env('env-1', '原始'), env('env-2', '节点二')] }
  const bothChanged = merge(
    { pipelines: [], environments: [env('env-1', 'B 改', { user: 'bob' }), env('env-2', '节点二')] },
    base,
    { environments: [env('env-1', 'A 改'), env('env-2', '节点二')] },
  )
  assert.deepEqual(bothChanged.conflicts, [], '同 id 双边都改不产生 409（区别于流水线的冲突语义）')
  assert.deepEqual(bothChanged.config.environments.map(item => [item.id, item.name]), [['env-1', 'B 改'], ['env-2', '节点二']])
  assert.equal(bothChanged.config.environments[0].user, 'bob')

  const editVsDelete = merge(
    { pipelines: [], environments: [env('env-1', '原始'), env('env-2', '节点二', { pass: 'p2' })] },
    base,
    { environments: [env('env-1', '原始')] },   // 他端删了 env-2
  )
  assert.deepEqual(editVsDelete.conflicts, [])
  assert.deepEqual(editVsDelete.config.environments.map(item => item.id), ['env-1', 'env-2'], '本端在途修改不被他端删除吞掉')
})

test('节点环境：旧页面 baseConfig 不带 environments 基线时维持整表 last-write-wins（向后兼容）', () => {
  const disk = { environments: [env('env-1', '节点一'), env('env-a', '他端新增')] }
  const client = { pipelines: [], environments: [env('env-1', '节点一'), env('env-b', '旧页面新增')] }

  const result = merge(client, { pipelines: [] }, disk)

  assert.deepEqual(result.config.environments.map(item => item.id), ['env-1', 'env-b'], '无基线时客户端整表为准（磁盘他端新增被覆盖，同旧行为）')
})

test('节点环境：条目比对只看规范字段，多余字段/键序不造成 phantom 偏离', () => {
  const base = { environments: [{ id: 'env-1', name: '节点一', ip: '10.0.0.1', user: 'root', pass: '', nodeIp: '', legacy: 'x' }] }
  const disk = { environments: [env('env-1', '节点一')] }
  const client = { pipelines: [], environments: [{ pass: '', user: 'root', ip: '10.0.0.1', name: '节点一', id: 'env-1', nodeIp: '' }] }   // 键序打乱

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.environments.map(item => item.id), ['env-1'], '规范字段一致即未改动，不复活多余字段也不丢条目')
})

test('节点环境：llmAddr（LLM服务地址）属规范字段——仅改 llmAddr 视为本端改动，他端 llmAddr 改动同步生效', () => {
  const base = { environments: [env('env-1', '节点一')] }
  const disk = { environments: [env('env-1', '节点一')] }
  const client = { pipelines: [], environments: [env('env-1', '节点一', { llmAddr: '10.0.0.1:8000' })] }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.equal(result.config.environments[0].llmAddr, '10.0.0.1:8000', '本端仅改 llmAddr 取本端（比对不含该字段会被当作未改动而落 disk 丢失）')

  const remoteEdited = merge(
    { pipelines: [], environments: [env('env-1', '节点一')] },
    base,
    { environments: [env('env-1', '节点一', { llmAddr: '10.0.0.1:9000' })] },
  )
  assert.equal(remoteEdited.config.environments[0].llmAddr, '10.0.0.1:9000', '本端未改时他端 llmAddr 修改同步生效')
})

test('源码契约：runStageScript 注入 TARGET_LLM_ADDR_MAP（SSH 地址 → LLM服务地址，仅填了的节点，与 TARGET_NODE_IP_MAP 同口径）', () => {
  const fn = extractFunction('runStageScript')
  assert.match(fn, /env\.TARGET_NODE_IP_MAP === undefined && runCtx\.envs/, '既有 TARGET_NODE_IP_MAP 注入应在场')
  assert.match(fn, /env\.TARGET_LLM_ADDR_MAP === undefined && runCtx\.envs/, '缺少 TARGET_LLM_ADDR_MAP 注入')
  assert.match(fn, /if \(e\.ip && e\.llmAddr\) llmAddrMap\[e\.ip\] = e\.llmAddr/, '映射应只含同时有 ip 与 llmAddr 的节点')
})

test('节点环境：合并不影响流水线冲突判定，流水线冲突时 environments 仍按合并结果随响应返回', () => {
  const base = { pipelines: [pipeline('p1', '原始')], environments: [env('env-1', '节点一')] }
  const disk = { pipelines: [pipeline('p1', '浏览器 A')], environments: [env('env-1', '节点一'), env('env-a', '他端新增')] }
  const client = { pipelines: [pipeline('p1', '浏览器 B')], environments: [env('env-1', '节点一'), env('env-b', '本端新增')] }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, ['p1'], '流水线真冲突仍 409')
  assert.deepEqual(result.config.environments.map(item => item.id), ['env-1', 'env-a', 'env-b'], '409 不落盘，响应里的合并结果仅供调用方参考')
})

/* ---------- 代码仓（repositories）按 id 三方合并：整表 last-write-wins 修复 ---------- */
/* 场景原型：两个浏览器同时打开设置页，A 添加代码仓落盘后，B（仍是旧列表快照）添加另一个代码仓——
   修复前 B 的整表保存把 A 的代码仓覆盖丢失；修复后按 id 合并，双方新增都保留。 */
const repo = (id, name, extra) => ({ id, name, url: 'https://git.example.com/' + name + '.git', user: '', pass: '', fetchMode: 'server', jenkinsJob: '', strategyUrl: '', strategyMode: 'url', strategyScript: '', ...(extra || {}) })

test('代码仓：两个浏览器各添加不同仓库，双方新增都保留（磁盘序在前，本端新增追加）', () => {
  const base = { repositories: [repo('r-1', 'repo-one')] }
  const disk = { repositories: [repo('r-1', 'repo-one'), repo('r-a', 'A 添加')] }
  const client = { pipelines: [], repositories: [repo('r-1', 'repo-one'), repo('r-b', 'B 添加')] }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [], '代码仓合并不产生 409 冲突')
  assert.deepEqual(result.config.repositories.map(item => item.id), ['r-1', 'r-a', 'r-b'], '双方新增都保留，磁盘顺序在前')
})

test('代码仓：本端未改动的条目以磁盘为准（他端修改/删除同步生效）', () => {
  const base = { repositories: [repo('r-1', 'repo-one'), repo('r-2', 'repo-two'), repo('r-3', 'repo-three')] }
  const disk = { repositories: [repo('r-1', '改名-他端', { url: 'https://new.example.com/x.git' }), repo('r-3', 'repo-three')] }   // 他端改 r-1、删 r-2
  const client = { pipelines: [], repositories: [repo('r-1', 'repo-one'), repo('r-2', 'repo-two'), repo('r-3', 'repo-three')] }   // 本端未动

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.repositories.map(item => [item.id, item.name]), [['r-1', '改名-他端'], ['r-3', 'repo-three']])
})

test('代码仓：本端删除磁盘未动的条目删除生效；本端修改取本端', () => {
  const base = { repositories: [repo('r-1', 'repo-one'), repo('r-2', 'repo-two')] }
  const disk = { repositories: [repo('r-1', 'repo-one'), repo('r-2', 'repo-two')] }
  const client = { pipelines: [], repositories: [repo('r-2', 'repo-two', { pass: 'new-token', strategyUrl: 'http://s/{branch}' })] }   // 本端删 r-1、改 r-2

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.repositories.map(item => item.id), ['r-2'], '本端删除生效')
  assert.equal(result.config.repositories[0].pass, 'new-token', '本端修改生效')
  assert.equal(result.config.repositories[0].strategyUrl, 'http://s/{branch}', '部署策略 URL 修改生效')
})

test('代码仓：同 id 双边都改按后写赢取本端，不报冲突；本端改 vs 他端删由本端复活', () => {
  const base = { repositories: [repo('r-1', '原始'), repo('r-2', 'repo-two')] }
  const bothChanged = merge(
    { pipelines: [], repositories: [repo('r-1', 'B 改', { user: 'bob' }), repo('r-2', 'repo-two')] },
    base,
    { repositories: [repo('r-1', 'A 改'), repo('r-2', 'repo-two')] },
  )
  assert.deepEqual(bothChanged.conflicts, [], '同 id 双边都改不产生 409（区别于流水线的冲突语义）')
  assert.deepEqual(bothChanged.config.repositories.map(item => [item.id, item.name]), [['r-1', 'B 改'], ['r-2', 'repo-two']])
  assert.equal(bothChanged.config.repositories[0].user, 'bob')

  const editVsDelete = merge(
    { pipelines: [], repositories: [repo('r-1', '原始'), repo('r-2', 'repo-two', { pass: 'p2' })] },
    base,
    { repositories: [repo('r-1', '原始')] },   // 他端删了 r-2
  )
  assert.deepEqual(editVsDelete.conflicts, [])
  assert.deepEqual(editVsDelete.config.repositories.map(item => item.id), ['r-1', 'r-2'], '本端在途修改不被他端删除吞掉')
})

test('代码仓：旧页面 baseConfig 不带 repositories 基线时维持整表 last-write-wins（向后兼容）', () => {
  const disk = { repositories: [repo('r-1', 'repo-one'), repo('r-a', '他端新增')] }
  const client = { pipelines: [], repositories: [repo('r-1', 'repo-one'), repo('r-b', '旧页面新增')] }

  const result = merge(client, { pipelines: [] }, disk)

  assert.deepEqual(result.config.repositories.map(item => item.id), ['r-1', 'r-b'], '无基线时客户端整表为准（磁盘他端新增被覆盖，同旧行为）')
})

test('代码仓：条目比对只看规范字段（含 fetchMode/strategyMode/strategyScript/jenkinsJob/strategyUrl），多余字段/键序不造成 phantom 偏离', () => {
  const base = { repositories: [{ id: 'r-1', name: 'repo-one', url: 'u', user: '', pass: '', fetchMode: 'server', jenkinsJob: '', strategyUrl: '', strategyMode: 'url', strategyScript: '', legacy: 'x' }] }
  const disk = { repositories: [repo('r-1', 'repo-one')] }
  const client = { pipelines: [], repositories: [{ pass: '', user: '', url: 'u', name: 'repo-one', id: 'r-1', fetchMode: 'server', strategyScript: '', strategyMode: 'url', strategyUrl: '', jenkinsJob: '' }] }   // 键序打乱

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.config.repositories.map(item => item.id), ['r-1'], '规范字段一致即未改动，不复活多余字段也不丢条目')
})

test('代码仓：strategyUrl/strategyScript/fetchMode/jenkinsJob 属规范字段——仅改其一视为本端改动', () => {
  const base = { repositories: [repo('r-1', 'repo-one')] }
  const disk = { repositories: [repo('r-1', 'repo-one')] }
  const client = { pipelines: [], repositories: [repo('r-1', 'repo-one', { strategyUrl: 'http://s/{branch}' })] }

  const result = merge(client, base, disk)

  assert.deepEqual(result.conflicts, [])
  assert.equal(result.config.repositories[0].strategyUrl, 'http://s/{branch}', '本端仅改 strategyUrl 取本端')

  const remoteEdited = merge(
    { pipelines: [], repositories: [repo('r-1', 'repo-one')] },
    base,
    { repositories: [repo('r-1', 'repo-one', { fetchMode: 'jenkins-server', jenkinsJob: 'job-x' })] },
  )
  assert.equal(remoteEdited.config.repositories[0].fetchMode, 'jenkins-server', '本端未改时他端 fetchMode 修改同步生效')
  assert.equal(remoteEdited.config.repositories[0].jenkinsJob, 'job-x')
})
