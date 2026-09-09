import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

/** 从组件源码中抽出 runImport 本体 + 模块级 layoutPagePath，在 vm 里以 mock 依赖运行（同 scan-projects.test.mjs 的抽取手法） */
function loadRunImport({ state, scan, server, aliveRegisteredIds = [] }) {
  const start = source.indexOf('  const runImport = async (folder: string) => {')
  const endMark = source.indexOf('  /** 发布/取消发布', start)
  assert.ok(start >= 0 && endMark > start, 'runImport not found')
  const fnCode = source.slice(start, endMark).trimEnd()
  const lpStart = source.indexOf('function layoutPagePath')
  const lpEnd = source.indexOf('\n}\n', lpStart) + 3
  assert.ok(lpStart >= 0 && lpEnd > lpStart, 'layoutPagePath not found')
  const lpCode = source.slice(lpStart, lpEnd)
  const code = stripTypeScriptTypes(lpCode + '\n' + fnCode + '\n;globalThis.__runImport = runImport', { mode: 'transform' })
  const msgs = []
  const ctx = {
    CONSOLE_ID: 'wt-console',
    projectsRef: { current: { projects: state, metas: {}, aliveRegisteredIds } },
    persistProjects(patch) { Object.assign(state, typeof patch === 'function' ? patch(state) : { ...state, ...patch }) },
    setImportBusy() {},
    setImportMsg(m) { msgs.push(m) },
    t: (k) => k,
    // buildLayout 的 id 只精确到毫秒：mock 成恒定值，验证导入循环自身保证 id 唯一
    buildLayout: (_preset, name) => ({ id: 'layout-samems', title: name, left: null, top: null, main: [{ id: 'p1', title: '窗口1', tabs: [], content: null, active: 0 }] }),
    fetch: async (url) => {
      if (url === '/api/worktable/scan-projects') return { ok: true, json: async () => scan }
      if (url === '/api/worktable/projects') return { ok: true, json: async () => server ?? {} }
      throw new Error('unexpected fetch ' + url)
    },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return { runImport: ctx.__runImport, msgs }
}

function makeState(over = {}) {
  return {
    order: [], lastUsed: {}, hidden: [], nameOverrides: {}, iconOverrides: {},
    removed: [], views: {}, shortcuts: [], layouts: [], bindings: {}, folders: {},
    workspaces: {}, prompts: {}, ...over,
  }
}

/** 构造一个托管 dir/entry 页面的布局条目（模拟工作台里已有的项目） */
function hostedLayout(id, title, dir, entry, extra = {}) {
  return {
    id, title, left: null, top: null,
    main: [{
      id: 'p1', title,
      tabs: [{ id: 't1', title: entry, content: { kind: 'iframe', url: '/api/worktable/site/' + encodeURIComponent(dir) + '/' + encodeURIComponent(entry), title: entry } }],
      active: 0,
    }],
    ...extra,
  }
}

const ROOT = '/root/projects'

test('已有项目：文件夹映射带尾斜杠也认得出，跳过不重复导入', async () => {
  const state = makeState({
    layouts: [hostedLayout('layout-1', '流水线', ROOT + '/pipeline', 'pipeline.html', { icon: '🚀' })],
    folders: { 'layout-1': ROOT + '/pipeline/' },
  })
  const scan = { path: ROOT, projects: [{ name: 'pipeline', dir: ROOT + '/pipeline', entry: 'pipeline.html' }] }
  const { runImport, msgs } = loadRunImport({ state, scan })
  await runImport(ROOT)
  assert.equal(state.layouts.length, 1)
  assert.equal(state.layouts[0].title, '流水线')
  assert.equal(msgs.at(-1).text, 'import.doneSkip')
})

test('已有项目：布局托管同目录不同入口页，按目录级匹配跳过', async () => {
  const state = makeState({
    layouts: [hostedLayout('layout-1', '流水线', ROOT + '/pipeline', 'index.html')],
  })
  const scan = { path: ROOT, projects: [{ name: 'pipeline', dir: ROOT + '/pipeline', entry: 'pipeline.html' }] }
  const { runImport, msgs } = loadRunImport({ state, scan })
  await runImport(ROOT)
  assert.equal(state.layouts.length, 1)
  assert.equal(msgs.at(-1).text, 'import.doneSkip')
})

test('服务端已发布但本地未合并的布局：按目录认回，继承原标题与 logo', async () => {
  const state = makeState()
  const remote = hostedLayout('layout-remote', '性能诊断', ROOT + '/diag_perf', 'index.html', { icon: '📈' })
  const server = { layouts: [remote], folders: { 'layout-remote': ROOT + '/diag_perf' }, workspaces: { 'layout-remote': 'ws-1' } }
  const scan = { path: ROOT, projects: [{ name: 'diag_perf', dir: ROOT + '/diag_perf', entry: 'index.html' }] }
  const { runImport, msgs } = loadRunImport({ state, scan, server })
  await runImport(ROOT)
  assert.equal(state.layouts.length, 1)
  assert.equal(state.layouts[0].id, 'layout-remote')
  assert.equal(state.layouts[0].title, '性能诊断')
  assert.equal(state.layouts[0].icon, '📈')
  assert.equal(state.layouts[0].sync, true)
  assert.equal(state.folders['layout-remote'], ROOT + '/diag_perf')
  assert.equal(state.workspaces['layout-remote'], 'ws-1')
  assert.equal(msgs.at(-1).text, 'import.done')
})

test('删除后再导入：沿用原布局 id，继承删除时留存的名称与 logo', async () => {
  // removeLayout 后的残留状态：布局本体已删，folders/nameOverrides/iconOverrides 按 id 留存
  const state = makeState({
    folders: { 'layout-9': ROOT + '/pipeline' },
    nameOverrides: { 'layout-9': '流水线' },
    iconOverrides: { 'layout-9': '🚀' },
  })
  const scan = { path: ROOT, projects: [{ name: 'pipeline', dir: ROOT + '/pipeline', entry: 'pipeline.html' }] }
  const { runImport, msgs } = loadRunImport({ state, scan })
  await runImport(ROOT)
  assert.equal(state.layouts.length, 1)
  assert.equal(state.layouts[0].id, 'layout-9')
  assert.equal(state.layouts[0].title, '流水线')
  assert.equal(state.layouts[0].icon, '🚀')
  assert.equal(state.folders['layout-9'], ROOT + '/pipeline')
  assert.equal(msgs.at(-1).text, 'import.done')
})

test('散装单页：同根多页互不相挡，未被托管的页照常导入', async () => {
  const state = makeState({
    layouts: [hostedLayout('layout-1', 'A 页', ROOT, 'a.html')],
    folders: { 'layout-1': ROOT },
  })
  const scan = {
    path: ROOT,
    projects: [
      { name: 'a', dir: ROOT, entry: 'a.html' },
      { name: 'b', dir: ROOT, entry: 'b.html' },
    ],
  }
  const { runImport } = loadRunImport({ state, scan })
  await runImport(ROOT)
  assert.equal(state.layouts.length, 2)
  assert.equal(state.layouts[1].title, 'b')
})

test('全新项目：按文件夹名建布局，同毫秒批量导入 id 互不相同', async () => {
  const state = makeState()
  const scan = {
    path: ROOT,
    projects: [
      { name: 'alpha', dir: ROOT + '/alpha', entry: 'index.html' },
      { name: 'beta', dir: ROOT + '/beta', entry: 'beta.html' },
    ],
  }
  const { runImport } = loadRunImport({ state, scan })
  await runImport(ROOT)
  assert.equal(state.layouts.length, 2)
  const ids = state.layouts.map((l) => l.id)
  assert.notEqual(ids[0], ids[1])
  assert.deepEqual(state.layouts.map((l) => l.title).join('|'), 'alpha|beta')
  assert.equal(state.folders[ids[0]], ROOT + '/alpha')
  assert.equal(state.folders[ids[1]], ROOT + '/beta')
})

test('全新项目：页面 <title> 作项目名优先于目录名；认回的用户改名仍优先', async () => {
  // 页面自报名称（<title>）优先于目录名
  const s1 = makeState()
  const r1 = loadRunImport({
    state: s1,
    scan: { path: ROOT, projects: [{ name: 'pipeline', dir: ROOT + '/pipeline', entry: 'pipeline.html', title: '流水线工作台' }] },
  })
  await r1.runImport(ROOT)
  assert.equal(s1.layouts[0].title, '流水线工作台')

  // 删除时转存的用户改名（nameOverrides）比 <title> 更优先
  const s2 = makeState({
    folders: { 'layout-9': ROOT + '/pipeline' },
    nameOverrides: { 'layout-9': '我的流水线' },
  })
  const r2 = loadRunImport({
    state: s2,
    scan: { path: ROOT, projects: [{ name: 'pipeline', dir: ROOT + '/pipeline', entry: 'pipeline.html', title: '流水线工作台' }] },
  })
  await r2.runImport(ROOT)
  assert.equal(s2.layouts[0].title, '我的流水线')
})

test('入驻项目的文件夹映射同样占位；服务端与本地重复的 id 不重复并入', async () => {
  const local = hostedLayout('layout-r1', '已发布', ROOT + '/pub', 'index.html', { sync: true })
  const state = makeState({
    layouts: [local],
    folders: { 'layout-r1': ROOT + '/pub', reg1: ROOT + '/reg' },
  })
  const server = { layouts: [hostedLayout('layout-r1', '已发布', ROOT + '/pub', 'index.html')], folders: { 'layout-r1': ROOT + '/pub' } }
  const scan = {
    path: ROOT,
    projects: [
      { name: 'pub', dir: ROOT + '/pub', entry: 'index.html' },
      { name: 'reg', dir: ROOT + '/reg', entry: 'reg.html' },
    ],
  }
  const { runImport, msgs } = loadRunImport({ state, scan, server, aliveRegisteredIds: ['reg1'] })
  await runImport(ROOT)
  assert.equal(state.layouts.length, 1)
  assert.equal(msgs.at(-1).text, 'import.doneSkip')
})
