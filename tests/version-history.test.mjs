import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

function loadHistoryHelpers() {
  const start = source.indexOf('/* ---------- 版本更新历史 ---------- */')
  const end = source.indexOf('/* ---------- 版本更新历史结束 ---------- */', start)
  assert.ok(start >= 0 && end > start, 'version history helpers not found')
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return ctx
}

/** vm 切片内创建的对象属 vm realm（原型与宿主不同），deepEqual 前转回宿主域 */
const plain = (x) => JSON.parse(JSON.stringify(x))

const rel = (tag, extra = {}) => ({
  tag_name: tag,
  draft: false,
  published_at: '2026-09-18T08:29:46Z',
  created_at: '2026-09-18T08:29:44Z',
  body: '## 变更\n\n- 某某修复',
  html_url: 'https://github.com/TokensService/tokens-worktable/releases/tag/' + tag,
  ...extra,
})

test('解析发行列表：按版本号倒序，标记当前版本与可升级版本', () => {
  const { parseReleaseHistory } = loadHistoryHelpers()
  const list = parseReleaseHistory([rel('v1.1.5'), rel('v1.1.7'), rel('v1.1.4')], '1.1.5')
  assert.deepEqual(plain(list.map((e) => e.version)), ['1.1.7', '1.1.5', '1.1.4'])
  assert.equal(list[0].newer, true, '更高版本标记可升级')
  assert.equal(list[0].current, false)
  assert.equal(list[1].current, true, '与安装版一致标记当前版本')
  assert.equal(list[1].newer, false)
  assert.equal(list[2].current, false)
  assert.equal(list[2].newer, false)
  assert.equal(list[1].tag, 'v1.1.5')
  assert.equal(list[1].date, '2026-09-18')
  assert.ok(list[1].notes.includes('某某修复'))
  assert.ok(list[1].url.endsWith('/v1.1.5'))
})

test('过滤草稿、非 semver 标签与非对象项；空标签跳过', () => {
  const { parseReleaseHistory } = loadHistoryHelpers()
  const list = parseReleaseHistory([
    rel('v1.1.7', { draft: true }), // 草稿不展示
    rel('nightly-20260918'), // 非 semver 标签
    rel(''), // 空标签
    null,
    42,
    rel('v1.1.6'),
  ], '1.1.6')
  assert.deepEqual(plain(list.map((e) => e.version)), ['1.1.6'])
})

test('日期缺失时回退 created_at，仍缺失则为空串；说明裁剪空白与长度上限', () => {
  const { parseReleaseHistory } = loadHistoryHelpers()
  const list = parseReleaseHistory([
    rel('v1.1.7', { published_at: '', created_at: '2026-09-17T01:02:03Z' }),
    rel('v1.1.6', { published_at: null, created_at: null }),
    rel('v1.1.5', { body: '  x  \n' }),
    rel('v1.1.4', { body: 'y'.repeat(5000) }),
    rel('v1.1.3', { body: null, html_url: null }),
  ], '1.1.7')
  assert.equal(list[0].date, '2026-09-17', 'published_at 为空回退 created_at')
  assert.equal(list[1].date, '', '两者皆空则为空串')
  assert.equal(list[2].notes, 'x', '说明裁剪首尾空白')
  assert.equal(list[3].notes.length, 4000, '说明最多保留 4000 字符')
  assert.equal(list[4].notes, '', '无说明回退空串')
  assert.equal(list[4].url, '', '无链接回退空串')
})

test('入参非数组（代理拦截页 / 异常响应）：返回空表', () => {
  const { parseReleaseHistory } = loadHistoryHelpers()
  for (const bad of [null, undefined, {}, '<html>…</html>', 42]) {
    assert.deepEqual(plain(parseReleaseHistory(bad, '1.1.7')), [], JSON.stringify(bad))
  }
})

test('最多保留 30 条（版本号最高的优先）', () => {
  const { parseReleaseHistory } = loadHistoryHelpers()
  const data = Array.from({ length: 40 }, (_, i) => rel('v1.' + String(i + 1) + '.0'))
  const list = parseReleaseHistory(data, '1.1.0')
  assert.equal(list.length, 30)
  assert.equal(list[0].version, '1.40.0')
  assert.equal(list[29].version, '1.11.0')
})

test('源码契约：设置面板入口、releases 列表拉取与弹窗渲染齐备，locales 中英键齐全', async () => {
  assert.ok(source.includes("/releases?per_page=30"), '应拉取 releases 列表而非仅 latest')
  assert.ok(source.includes("t('history.btn')"), '版本行应有「更新历史」入口按钮')
  assert.ok(source.includes('parseReleaseHistory(d, LOCAL_VERSION)'), '拉取结果应经 parseReleaseHistory 解析')
  const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  const zhBlock = locales.slice(0, locales.indexOf('export const en'))
  const enBlock = locales.slice(locales.indexOf('export const en'))
  for (const key of ['history.btn', 'history.title', 'history.loading', 'history.failed', 'history.retry', 'history.refresh', 'history.close', 'history.empty', 'history.current', 'history.newer', 'history.noNotes', 'history.viewOnGithub']) {
    assert.ok(zhBlock.includes("'" + key + "'"), 'zh 缺 ' + key)
    assert.ok(enBlock.includes("'" + key + "'"), 'en 缺 ' + key)
  }
})
