import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as pathResolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function loadHomeHelpers() {
  const start = source.indexOf('/** 从插件模块所在 lib/ 目录推断 DSH home')
  const end = source.indexOf('/** DSH home（storages', start)
  assert.ok(start >= 0 && end > start, 'home helpers not found')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const ctx = { pathResolve, dirname, basename }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return ctx
}

test('模块位置推断：标准安装路径 <home>/profiles/<profile>/node_modules/<pkg>/lib 解析出 dsh home', () => {
  const { inferDshHomeFromModuleDir } = loadHomeHelpers()
  assert.equal(inferDshHomeFromModuleDir('/mnt/paas/profiles/web/node_modules/tokens-worktable/lib'), '/mnt/paas')
  assert.equal(inferDshHomeFromModuleDir('/home/u/.dsh/profiles/cli/node_modules/tokens-worktable/lib'), '/home/u/.dsh')
  assert.equal(inferDshHomeFromModuleDir('/h/profiles/web/node_modules/@scope/pkg/lib'), '/h', 'scoped 包多上溯一层 @scope')
  assert.equal(inferDshHomeFromModuleDir('/home/u/dev/tokens-worktable/lib'), null, '源码树位置不推断')
  assert.equal(inferDshHomeFromModuleDir('/mnt/data/lhf/tokens-worktable/lib'), null, 'link: realpath 位置不推断')
})

test('DSH_HOME 环境变量解析：空白 = 未设，支持 ~ 与 ~/ 展开', () => {
  const { resolveDshHomeEnv } = loadHomeHelpers()
  assert.equal(resolveDshHomeEnv(undefined, '/home/u'), null)
  assert.equal(resolveDshHomeEnv('', '/home/u'), null)
  assert.equal(resolveDshHomeEnv('   ', '/home/u'), null)
  assert.equal(resolveDshHomeEnv('/mnt/paas', '/home/u'), '/mnt/paas')
  assert.equal(resolveDshHomeEnv('  /mnt/paas  ', '/home/u'), '/mnt/paas', '首尾空白剔除')
  assert.equal(resolveDshHomeEnv('~', '/home/u'), '/home/u')
  assert.equal(resolveDshHomeEnv('~/dsh-data', '/home/u'), pathResolve('/home/u', 'dsh-data'))
})
