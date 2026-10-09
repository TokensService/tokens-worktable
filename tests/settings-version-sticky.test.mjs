import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const stylesSource = await readFile(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
const clientSource = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

/** 从 styles.ts 的扁平单行规则字符串中取出 `selector{...}` 的规则体 */
function cssRule(source, selector) {
  const start = source.indexOf("'" + selector + '{')
  assert.ok(start >= 0, `styles.ts 缺少 ${selector} 规则`)
  const bodyStart = source.indexOf('{', start)
  const bodyEnd = source.indexOf('}', bodyStart)
  assert.ok(bodyEnd > bodyStart, `${selector} 规则未闭合`)
  return source.slice(bodyStart + 1, bodyEnd)
}

test('.dsh-wt_versionRow 规则存在且为吸附面板底部的 sticky 页脚（不透明底色与面板一致）', () => {
  const rule = cssRule(stylesSource, '.dsh-wt_versionRow')
  assert.ok(rule.includes('position:sticky'), '应含 position:sticky')
  assert.ok(rule.includes('bottom:0'), '应含 bottom:0 吸附可见区底部')
  assert.ok(rule.includes('z-index:'), '应含 z-index 盖住滚过内容')
  assert.ok(rule.includes('background:var(--dsw-alias-bg-base,#0b0e14)'), '应含不透明背景（与 .dsh-wt_manage 面板底色一致）遮住滚过内容')
  const manageRule = cssRule(stylesSource, '.dsh-wt_manage')
  assert.ok(manageRule.includes('padding:6px'), '.dsh-wt_manage 面板仍应为 padding:6px（版本行负边距全宽出血的前提）')
  const popRule = cssRule(stylesSource, '.dsh-wt_pop')
  assert.ok(popRule.includes('overflow:auto'), '.dsh-wt_pop 应仍是滚动容器（sticky 生效的前提）')
})

test('.dsh-wt_versionRow 规则 margin 含 -6px 负值（抵消面板 padding 全宽出血）并保留 border-top 分隔线', () => {
  const rule = cssRule(stylesSource, '.dsh-wt_versionRow')
  const marginDecl = /margin(?:-[a-z]+)?\s*:[^;]+/.exec(rule)
  assert.ok(marginDecl, '应含 margin 声明')
  assert.ok(marginDecl[0].includes('-6px'), 'margin 应含 -6px 负值，抵消面板 6px padding 使分隔线横贯全宽')
  assert.ok(rule.includes('border-top:'), '应保留 border-top 顶部分隔线')
})

test('版本行位于设置面板内部且为面板最后一个区块（sticky 冻结语义成立）', () => {
  const settingsIdx = clientSource.indexOf('dsh-wt_pop dsh-wt_settings')
  assert.ok(settingsIdx >= 0, '未找到设置弹层（dsh-wt_pop dsh-wt_settings）')
  const rowIdx = clientSource.indexOf('dsh-wt_versionRow', settingsIdx)
  assert.ok(rowIdx > settingsIdx, 'dsh-wt_versionRow 应出现在设置面板内')
  assert.equal(clientSource.indexOf('dsh-wt_manageHead', rowIdx), -1, '版本行之后不应再出现 dsh-wt_manageHead（版本行须为面板最后一个区块）')
})
