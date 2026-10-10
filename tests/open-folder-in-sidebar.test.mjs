import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

// 同 session-bridge-retain.test.mjs：从源码切片提取函数，strip 类型后经 vm context 注入桩。
function functionSource(name) {
  const functionStart = source.indexOf('function ' + name + '(')
  const start = functionStart >= 6 && source.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6
    : functionStart
  assert.ok(start >= 0, '缺少函数 ' + name)
  // 函数体起点的 '{' 可能与签名里的对象类型标注混淆：逐个候选 '{' 配对到闭合，
  // 首个能编译成完整函数声明的片段才含真函数体（类型标注片段会因缺少函数体而编译失败）。
  for (let brace = source.indexOf('{', functionStart); brace >= 0; brace = source.indexOf('{', brace + 1)) {
    let depth = 0
    let end = -1
    for (let i = brace; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      if (source[i] === '}') depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
    if (end < 0) break
    const candidate = source.slice(start, end)
    // 无函数体的片段会被 strip 当作可擦除的重载签名清成空串，需确认函数声明与函数体大括号仍在
    try {
      const stripped = stripTypeScriptTypes(candidate, { mode: 'transform' })
      if (stripped.includes('function ' + name + '(') && stripped.includes('{')) {
        new vm.Script(stripped)
        return candidate
      }
    } catch { /* 该 '{' 属于类型标注，继续找下一个 */ }
  }
  assert.fail('函数 ' + name + ' 缺少闭合括号')
}

// 被测函数引用模块级 let applyCtx：提取后经 vm context 注入桩，随用例替换。
function loadFolderFns(applyCtx) {
  const code = stripTypeScriptTypes(
    ['sessionFileAddressOf', 'openFolderInSidebar'].map(functionSource).join('\n') +
      '\n;globalThis.__fns = { sessionFileAddressOf, openFolderInSidebar }',
    { mode: 'transform' },
  )
  const context = { applyCtx }
  vm.createContext(context)
  vm.runInContext(code, context)
  return context.__fns
}

// 组装 applyCtx 桩：按服务名返回给定的 sidebarRight / betterSidebar 桩。
function ctxWith({ sidebarRight, betterSidebar }) {
  return {
    get(name) {
      if (name === 'sidebarRight') return sidebarRight
      if (name === 'betterSidebar') return betterSidebar
      return undefined
    },
  }
}

test('sessionFileAddressOf：绝对路径逐段编码，sessionId 后保留双斜杠', () => {
  const { sessionFileAddressOf } = loadFolderFns(null)

  const address = sessionFileAddressOf('s1', '/var/log/op_test/GLM5.2性能测试_ems（副本-2）_20261010004557')

  assert.ok(address.startsWith('dsh-resource://file/session/s1//var/log/op_test/'), '绝对路径应在 sessionId 后保留前导斜杠（双斜杠）')
  // 中文与全角括号按段 encodeURIComponent；逐段解码拼接应还原原路径
  const prefix = 'dsh-resource://file/session/s1/'
  assert.equal(
    address.slice(prefix.length).split('/').map(decodeURIComponent).join('/'),
    '/var/log/op_test/GLM5.2性能测试_ems（副本-2）_20261010004557',
  )
  assert.ok(!address.includes('性'), '非 ASCII 段应被编码')
})

test('sessionFileAddressOf：反斜杠归一化为 /，冒号字面保留（Windows 盘符），sessionId 同规则编码', () => {
  const { sessionFileAddressOf } = loadFolderFns(null)

  assert.equal(
    sessionFileAddressOf('s 1', 'C:\\a b\\c'),
    'dsh-resource://file/session/s%201/C:/a%20b/c',
  )
})

test('sessionFileAddressOf：相对路径剥除前导 ./', () => {
  const { sessionFileAddressOf } = loadFolderFns(null)

  assert.equal(sessionFileAddressOf('s1', './a/./b'), 'dsh-resource://file/session/s1/a/./b')
})

test('openFolderInSidebar：Tier1 直调宿主 sidebarRight.openResource，params.meta.dir 透传目录语义', () => {
  const events = []
  const { openFolderInSidebar } = loadFolderFns(ctxWith({
    sidebarRight: {
      mounted: { getSnapshot: () => 's1' },
      openResource: (address, options) => events.push(['openResource', address, options]),
    },
    betterSidebar: { openTab: (seed) => events.push(['openTab', seed]) },
  }))

  const got = openFolderInSidebar('/var/log/归档')

  assert.equal(got, true)
  assert.equal(events.length, 1, 'Tier1 成功时不得再动 betterSidebar.openTab')
  assert.equal(events[0][0], 'openResource')
  assert.equal(events[0][1], 'dsh-resource://file/session/s1//var/log/%E5%BD%92%E6%A1%A3')
  // options 字面量在被测函数（vm realm）里创建，跨 realm 的 deepEqual 会因原型不同误判，按 JSON 比较
  assert.equal(JSON.stringify(events[0][2]), JSON.stringify({ revealIfOpened: true, params: { meta: { dir: true } } }))
})

test('openFolderInSidebar：无 sidebarRight 服务时回退 Tier2 底部工作台（target:\'bottom\'，meta 不丢）', () => {
  const events = []
  const { openFolderInSidebar } = loadFolderFns(ctxWith({
    sidebarRight: undefined,
    betterSidebar: { openTab: (seed) => events.push(['openTab', seed]) },
  }))

  const got = openFolderInSidebar('/var/log/archive')

  assert.equal(got, true)
  assert.equal(events.length, 1)
  assert.equal(events[0][0], 'openTab')
  assert.equal(
    JSON.stringify(events[0][1]),
    JSON.stringify({ type: 'editor', title: 'archive', path: '/var/log/archive', id: 'editor:/var/log/archive', meta: { dir: true }, target: 'bottom' }),
  )
})

test('openFolderInSidebar：宿主无挂载会话（mounted 快照 undefined）时回退 Tier2', () => {
  const events = []
  const { openFolderInSidebar } = loadFolderFns(ctxWith({
    sidebarRight: {
      mounted: { getSnapshot: () => undefined },
      openResource: (address, options) => events.push(['openResource', address, options]),
    },
    betterSidebar: { openTab: (seed) => events.push(['openTab', seed]) },
  }))

  const got = openFolderInSidebar('/var/log/archive')

  assert.equal(got, true)
  assert.deepEqual(events.map((e) => e[0]), ['openTab'])
})

test('openFolderInSidebar：openResource 抛错（宿主无会话面挂载）时回退 Tier2', () => {
  const events = []
  const { openFolderInSidebar } = loadFolderFns(ctxWith({
    sidebarRight: {
      mounted: { getSnapshot: () => 's1' },
      openResource: () => { throw new Error('sidebarRight: no session surface is mounted') },
    },
    betterSidebar: { openTab: (seed) => events.push(['openTab', seed]) },
  }))

  const got = openFolderInSidebar('/var/log/archive')

  assert.equal(got, true)
  assert.deepEqual(events.map((e) => e[0]), ['openTab'])
})

test('openFolderInSidebar：两级服务都缺失（含 applyCtx 为 null）时返回 false', () => {
  const missing = loadFolderFns(ctxWith({ sidebarRight: undefined, betterSidebar: undefined }))
  const nulled = loadFolderFns(null)

  assert.equal(missing.openFolderInSidebar('/var/log/archive'), false)
  assert.equal(nulled.openFolderInSidebar('/var/log/archive'), false)
})

test('openFolderInSidebar：Tier2 openTab 抛错时返回 false', () => {
  const { openFolderInSidebar } = loadFolderFns(ctxWith({
    sidebarRight: undefined,
    betterSidebar: { openTab: () => { throw new Error('boom') } },
  }))

  assert.equal(openFolderInSidebar('/var/log/archive'), false)
})

test('openFolderInSidebar：入参为空串/非字符串时返回 false 且不触碰任何服务', () => {
  const events = []
  const { openFolderInSidebar } = loadFolderFns(ctxWith({
    sidebarRight: {
      mounted: { getSnapshot: () => 's1' },
      openResource: (address, options) => events.push(['openResource', address, options]),
    },
    betterSidebar: { openTab: (seed) => events.push(['openTab', seed]) },
  }))

  assert.equal(openFolderInSidebar(''), false)
  assert.equal(openFolderInSidebar(undefined), false)
  assert.equal(openFolderInSidebar(null), false)
  assert.equal(events.length, 0)
})
