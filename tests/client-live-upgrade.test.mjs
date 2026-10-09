import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'src/client/index.tsx'), 'utf8')

test('更新提示应说明安装后刷新页面即可，无需重启 dsh', () => {
  const prompt = source.match(/const upgradeAiPrompt = \(tag: string\) => ([^\n]+)/)?.[1] ?? ''
  assert.match(prompt, /刷新页面/)
  assert.doesNotMatch(prompt, /重启 dsh/)
})

test('客户端应通过 health 版本与 revision 变化提示刷新', () => {
  assert.match(source, /fetch\('\/api\/worktable\/health'/)
  assert.match(source, /revision/)
  assert.match(source, /刷新页面/)
})
