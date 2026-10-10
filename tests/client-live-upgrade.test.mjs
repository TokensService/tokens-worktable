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

test('升级提示词要求执行结果携带版本信息', () => {
  const prompt = source.match(/const upgradeAiPrompt = \(tag: string\) => ([^\n]+)/)?.[1] ?? ''
  assert.ok(prompt.includes('+ tag +'), '提示词拼接目标版本 tag')
  assert.match(prompt, /版本号/, '提示词要求结果中给出版本号')
  assert.match(prompt, /核对实际安装的版本/, '提示词要求核对实际安装的版本')
})

test('客户端应通过 health 版本与 revision 变化提示刷新', () => {
  assert.match(source, /fetch\('\/api\/worktable\/health'/)
  assert.match(source, /revision/)
  assert.match(source, /刷新页面/)
})
