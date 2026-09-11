import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

function loadTitleHelpers(fetchImpl) {
  const start = source.indexOf('/* ---------- 侧栏标题取 dsh 登录用户 ---------- */')
  const end = source.indexOf('/* ---------- 侧栏标题取 dsh 登录用户结束 ---------- */', start)
  assert.ok(start >= 0 && end > start, 'auth username title helpers not found')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const ctx = { fetch: fetchImpl }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return ctx
}

const authFetch = (body, ok = true) => async () => ({ ok, json: async () => body })

test('已登录：返回裁剪后的登录用户名', async () => {
  const { probeAuthUsername } = loadTitleHelpers(authFetch({ authenticated: true, username: '  lhf  ' }))
  assert.equal(await probeAuthUsername(), 'lhf')
})

test('token 共享模式（username 为 null）/ 未登录 / 用户名缺失或为空：回退空串', async () => {
  for (const body of [
    { authenticated: true, username: null },
    { authenticated: false, username: 'lhf' },
    { authenticated: true },
    { authenticated: true, username: '   ' },
    {},
  ]) {
    const { probeAuthUsername } = loadTitleHelpers(authFetch(body))
    assert.equal(await probeAuthUsername(), '', JSON.stringify(body))
  }
})

test('响应非 200 / 非 JSON（未装认证插件走 SPA 兜底）/ 请求抛错：回退空串', async () => {
  assert.equal(await loadTitleHelpers(authFetch({}, false)).probeAuthUsername(), '')
  const htmlFallback = async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <') } })
  assert.equal(await loadTitleHelpers(htmlFallback).probeAuthUsername(), '')
  const networkDown = async () => { throw new Error('network') }
  assert.equal(await loadTitleHelpers(networkDown).probeAuthUsername(), '')
})

test('侧栏标题取舍：自定义名 > 登录用户名 > 默认「工作台」', () => {
  const { worktableTitleOf } = loadTitleHelpers(authFetch({}))
  assert.equal(worktableTitleOf('我的台', 'lhf', '工作台'), '我的台', '自定义名优先')
  assert.equal(worktableTitleOf('', 'lhf', '工作台'), 'lhf', '缺省取登录用户名')
  assert.equal(worktableTitleOf('', '', '工作台'), '工作台', '取不到用户名回退默认「工作台」')
  assert.equal(worktableTitleOf('', '', '工作台（开发中）'), '工作台（开发中）', 'link: 安装的默认名后缀保留')
})
