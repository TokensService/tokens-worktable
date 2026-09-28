// codereview 构建历史云端存储目录：经 /api/worktable/health 的 home 解析为 $DSH_HOME/storages，
// 不再硬编码 /mnt/paas/storages；解析出的新目录与旧目录不同时做一次性复制迁移（新目录已有不覆盖、
// 旧文件不删），health 不可达时沿用旧目录兜底且不迁移。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../projects/codereview/code-review-prs.html', import.meta.url), 'utf8')

function functionSource(name) {
  const functionStart = source.indexOf('function ' + name + '(')
  assert.ok(functionStart >= 0, '缺少函数 ' + name)
  const brace = source.indexOf('{', functionStart)
  let depth = 0
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') depth -= 1
    if (depth === 0) return source.slice(functionStart, i + 1)
  }
  assert.fail('函数 ' + name + ' 缺少闭合括号')
}

/* 桩 fetch：按 URL 路由到 health / file / mkdir / write；files 键为绝对路径，值为文件内容（不存在 = 404）。 */
function makeFetch({ home = '/data/.dsh', files = {}, healthOk = true } = {}) {
  const writes = []
  const jsonRes = (obj) => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) })
  const fetch = async (url, opts = {}) => {
    if (url === '/api/worktable/health') return healthOk ? jsonRes({ home }) : { ok: false, headers: { get: () => 'application/json' } }
    if (url.startsWith('/api/worktable/file?path=')) {
      const p = decodeURIComponent(url.slice('/api/worktable/file?path='.length))
      if (!(p in files)) return { ok: false, headers: { get: () => 'application/json' }, text: async () => '{"error":"not found"}' }
      return { ok: true, headers: { get: () => 'application/json' }, text: async () => files[p] }
    }
    if (url === '/api/worktable/mkdir') return jsonRes({ ok: true })
    if (url === '/api/worktable/write') {
      const body = JSON.parse(opts.body)
      writes.push(body)
      files[body.path] = body.content
      return jsonRes({ ok: true })
    }
    throw new Error('未桩接的请求：' + url)
  }
  return { fetch, writes }
}

function loadCtx(fetchStub) {
  const ctx = Object.assign({ JSON, String, Error, Promise, Array, Object, encodeURIComponent, decodeURIComponent }, {
    fetch: fetchStub,
    state: { platform: 'github' },
    REL_HIST_LEGACY_DIR: '/mnt/paas/storages',
    REL_HIST_STORE_DIR: '/mnt/paas/storages',
    relStoreReady: null,
    relStoreResolved: false,
  })
  vm.createContext(ctx)
  vm.runInContext(['resolveRelStoreDir', 'migrateRelStoreLegacy', 'relHistFile'].map(functionSource).join('\n'), ctx)
  return ctx
}

test('health 上报 home 后存储目录切换为 $DSH_HOME/storages', async () => {
  const { fetch } = makeFetch({ home: '/data/.dsh' })
  const ctx = loadCtx(fetch)
  await ctx.resolveRelStoreDir()
  assert.equal(ctx.REL_HIST_STORE_DIR, '/data/.dsh/storages')
  assert.equal(ctx.relStoreResolved, true)
  assert.equal(ctx.relHistFile(), '/data/.dsh/storages/dsh-codereview-relhist-gh.json')
})

test('health home 尾斜杠剔除，空 home 保持旧目录', async () => {
  const { fetch } = makeFetch({ home: '/data/.dsh/' })
  const ctx = loadCtx(fetch)
  await ctx.resolveRelStoreDir()
  assert.equal(ctx.REL_HIST_STORE_DIR, '/data/.dsh/storages')
  const ctx2 = loadCtx(makeFetch({ home: '  ' }).fetch)
  await ctx2.resolveRelStoreDir()
  assert.equal(ctx2.REL_HIST_STORE_DIR, '/mnt/paas/storages')
})

test('旧目录遗留文件一次性迁移：只复制新目录缺失的文件，已有文件不覆盖', async () => {
  const legacy = '/mnt/paas/storages'
  const target = '/data/.dsh/storages'
  const files = {
    [legacy + '/dsh-codereview-relhist-gh.json']: '[{"id":"1"}]',
    [legacy + '/dsh-codereview-relcfg-gc.json']: '{"a":1}',
    [target + '/dsh-codereview-relhist-gh.json']: '[{"id":"new"}]',   // 新目录已有：不得覆盖
  }
  const { fetch, writes } = makeFetch({ files })
  const ctx = loadCtx(fetch)
  await ctx.resolveRelStoreDir()
  const paths = writes.map(w => w.path).sort()
  assert.deepEqual(paths, [target + '/dsh-codereview-relcfg-gc.json'])
  assert.equal(writes[0].content, '{"a":1}')
  assert.equal(files[target + '/dsh-codereview-relhist-gh.json'], '[{"id":"new"}]')
})

test('health 不可达：沿用旧目录兜底且不发起任何迁移写入', async () => {
  const { fetch, writes } = makeFetch({ healthOk: false, files: { '/mnt/paas/storages/dsh-codereview-relhist-gh.json': '[]' } })
  const ctx = loadCtx(fetch)
  await ctx.resolveRelStoreDir()
  assert.equal(ctx.REL_HIST_STORE_DIR, '/mnt/paas/storages')
  assert.equal(ctx.relStoreResolved, true)   // 兜底也算解析完成，读写入口不再等待
  assert.deepEqual(writes, [])
})

test('存储目录与旧目录相同时不做迁移读取', async () => {
  // home 即 /mnt/paas：目录未变化，migrateRelStoreLegacy 直接返回
  const { fetch, writes } = makeFetch({ home: '/mnt/paas' })
  const ctx = loadCtx(fetch)
  await ctx.resolveRelStoreDir()
  assert.equal(ctx.REL_HIST_STORE_DIR, '/mnt/paas/storages')
  assert.deepEqual(writes, [])
})
