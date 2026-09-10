import { test } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { basename, dirname, resolve as pathResolve } from 'node:path'
import { tmpdir } from 'node:os'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function loadHomeHelpers() {
  const start = source.indexOf('/** 从插件模块所在 lib/ 目录推断 DSH home')
  const end = source.indexOf('/** DSH home（storages', start)
  assert.ok(start >= 0 && end > start, 'home helpers not found')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const ctx = { pathResolve, dirname, basename, realpathSync }
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

test('本地编译安装判定：lib/ realpath 落在标准安装布局外 = 开发中', async () => {
  const { isLocalDevInstall } = loadHomeHelpers()
  const tmp = await mkdtemp(pathResolve(tmpdir(), 'wt-dev-'))
  try {
    // release tgz 副本安装：<home>/profiles/web/node_modules/tokens-worktable/lib
    const releaseLib = pathResolve(tmp, 'home/profiles/web/node_modules/tokens-worktable/lib')
    await mkdir(releaseLib, { recursive: true })
    assert.equal(isLocalDevInstall(releaseLib), false, 'release tgz 副本安装不算开发中')
    // 本地编译安装：源码树位置
    const srcLib = pathResolve(tmp, 'src/tokens-worktable/lib')
    await mkdir(srcLib, { recursive: true })
    assert.equal(isLocalDevInstall(srcLib), true, '源码树位置 = 开发中')
    // link: 安装：node_modules 里的符号链接指向源码树，realpath 解开后仍判开发中
    const linkPkg = pathResolve(tmp, 'home/profiles/web/node_modules/linked-worktable')
    await symlink(pathResolve(tmp, 'src/tokens-worktable'), linkPkg)
    assert.equal(isLocalDevInstall(pathResolve(linkPkg, 'lib')), true, 'link: 符号链接 realpath 后 = 开发中')
    // 不存在的路径：realpath 失败，保守判非开发中
    assert.equal(isLocalDevInstall(pathResolve(tmp, 'no-such/lib')), false, 'realpath 失败保守判非开发中')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
