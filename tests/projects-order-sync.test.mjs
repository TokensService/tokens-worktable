import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as fsx from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve as pathResolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const serverSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const clientSource = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

/** 抽出 /api/worktable/projects 路由（同 scan-projects.test.mjs 的抽取手法），DSH_HOME 指向临时目录；
 * 路由体内的动态 import('node:fs/promises') 改接测试提供的 fsx（vm 动态 import 需 --experimental-vm-modules，不用） */
function loadProjectsRoute(dshHome) {
  const start = serverSource.indexOf('  // 跨浏览器同步的项目存储')
  const endMark = serverSource.indexOf('  // 流水线工作台（pipeline.html）的服务端持久化', start)
  assert.ok(start >= 0 && endMark > start, 'projects route not found')
  const slice = serverSource.slice(start, endMark).replace("const fsx = await import('node:fs/promises')", '/* fsx 由测试注入 */')
  assert.ok(slice.includes('/* fsx 由测试注入 */'), '动态 import 替换失败')
  const code = stripTypeScriptTypes(slice, { mode: 'transform' })
  let handler
  const ctx = {
    DSH_HOME: dshHome,
    pathResolve, dirname, readFile, fsx,
    readJsonBody: async (req) => req.body ?? {},
    webServer: { register(route) { handler = route.handler } },
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return handler
}

/** 从客户端源码抽出模块级纯函数 mergeRemoteOrder（启动合并的排序归并逻辑） */
function loadMergeRemoteOrder() {
  const start = clientSource.indexOf('function mergeRemoteOrder')
  const end = clientSource.indexOf('\n}\n', start) + 3
  assert.ok(start >= 0 && end > start, 'mergeRemoteOrder not found')
  const code = stripTypeScriptTypes(clientSource.slice(start, end) + '\n;globalThis.__mergeRemoteOrder = mergeRemoteOrder', { mode: 'transform' })
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  // vm realm 的数组原型不同，deepEqual 会误判——转回本 realm 再断言
  return (...args) => {
    const r = ctx.__mergeRemoteOrder(...args)
    return r === null ? null : [...r]
  }
}

function mockRes() {
  return {
    status: 0, body: '',
    writeHead(s) { this.status = s },
    end(s) { this.body = s == null ? '' : String(s) },
    json() { return this.body ? JSON.parse(this.body) : null },
  }
}

async function call(handler, req) {
  const res = mockRes()
  await handler(req, res)
  return res
}

async function makeRoute(t) {
  const dir = await mkdtemp(tmpdir() + '/projects-order-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { handler: loadProjectsRoute(dir), store: dir + '/storages/worktable-projects.json' }
}

test('服务端 PUT：order 仅接受字符串数组，非字符串元素过滤后落盘', async t => {
  const { handler, store } = await makeRoute(t)
  const put = await call(handler, { method: 'PUT', body: { layouts: [], folders: {}, workspaces: {}, prompts: {}, order: ['a', 1, 'b', null] } })
  assert.equal(put.status, 200)
  const onDisk = JSON.parse(await readFile(store, 'utf8'))
  assert.deepEqual(onDisk.order, ['a', 'b'])
})

test('服务端 PUT：缺 order 字段时落盘空数组；GET 原样返回已存 order', async t => {
  const { handler, store } = await makeRoute(t)
  const put = await call(handler, { method: 'PUT', body: { layouts: [], order: ['x', 'y'] } })
  assert.equal(put.status, 200)
  assert.deepEqual(JSON.parse(await readFile(store, 'utf8')).order, ['x', 'y'])
  const get = await call(handler, { method: 'GET' })
  assert.equal(get.status, 200)
  assert.deepEqual(get.json().order, ['x', 'y'])

  const putNoOrder = await call(handler, { method: 'PUT', body: { layouts: [] } })
  assert.equal(putNoOrder.status, 200)
  assert.deepEqual(JSON.parse(await readFile(store, 'utf8')).order, [])
})

test('服务端 GET：无 order 的旧存储文件返回 order: []；存储文件本身缺字段也兜底', async t => {
  const { handler, store } = await makeRoute(t)
  await mkdir(dirname(store), { recursive: true })
  await writeFile(store, JSON.stringify({ layouts: [], folders: {}, workspaces: {}, prompts: {} }))
  const legacy = await call(handler, { method: 'GET' })
  assert.equal(legacy.status, 200)
  assert.deepEqual(legacy.json().order, [])

  // order 里混入非字符串元素的旧文件同样过滤
  await writeFile(store, JSON.stringify({ layouts: [], order: ['a', 2, null, 'b'] }))
  const dirty = await call(handler, { method: 'GET' })
  assert.deepEqual(dirty.json().order, ['a', 'b'])

  // 无存储文件 = 空集
  await rm(store, { force: true })
  const empty = await call(handler, { method: 'GET' })
  assert.deepEqual(empty.json().order, [])
})

test('客户端合并：远端 order 非空时远端优先，本地独有 id 保相对序追加尾部', () => {
  const merge = loadMergeRemoteOrder()
  assert.deepEqual(merge(['b', 'a'], ['a', 'c', 'b']), ['b', 'a', 'c'])
  // 远端已是本地超集：原样采用远端
  assert.deepEqual(merge(['a', 'b', 'c'], ['b', 'a']), ['a', 'b', 'c'])
  // 远端数组里的非字符串元素先过滤再合并
  assert.deepEqual(merge(['a', 1, null], ['b']), ['a', 'b'])
  // 不按 known id 过滤：远端/本地未知 id 都保留（渲染期 effectiveOrder 才过滤已卸载 id）
  assert.deepEqual(merge(['ghost'], ['local-only']), ['ghost', 'local-only'])
})

test('客户端合并：远端无 order（缺字段/空数组/非数组）时返回 null，调用方保留本地序不动', () => {
  const merge = loadMergeRemoteOrder()
  assert.equal(merge(undefined, ['a', 'b']), null)
  assert.equal(merge(null, ['a', 'b']), null)
  assert.equal(merge([], ['a', 'b']), null)
  assert.equal(merge('not-an-array', ['a', 'b']), null)
  // 空元素被过滤后为空同样视为远端无 order
  assert.equal(merge([1, null], ['a', 'b']), null)
})
