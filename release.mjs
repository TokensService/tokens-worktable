#!/usr/bin/env node
/**
 * tokens-worktable 一键编译构建并发布：
 *   node release.mjs <tag> [-m 摘要]
 *   例：node release.mjs v1.0.8 -m "流水线支持定时触发"
 *
 * 流程（任一步失败即中止，已推送的 tag / release 不会回滚）：
 *   1. 校验 tag（semver、未占用、工作区干净、gh/git 可用）
 *   2. 同步 package.json / dsh.plugin.json 版本号
 *   3. npm run build && npm run check && npm test
 *   4. 提交「发布 <tag>：<摘要>」、打 tag、推送 origin
 *   5. npm pack 双资产（tokens-worktable-<版本>.tgz + tokens-worktable.tgz），
 *      gh release create（资产文件名带版本号防 dsh 按文件名缓存装回旧版，
 *      不带版本号的资产兼容旧版客户端升级命令）
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = 'TokensService/tokens-worktable'

function die(msg) {
  console.error('[release] ' + msg)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  console.log('[release] $ ' + cmd + ' ' + args.join(' '))
  return execFileSync(cmd, args, { cwd: here, stdio: 'inherit', ...opts })
}

function out(cmd, args) {
  return execFileSync(cmd, args, { cwd: here, encoding: 'utf8' }).trim()
}

// ---- 参数解析 ----
const argv = process.argv.slice(2)
let tagArg = null
let summary = ''
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-m' || argv[i] === '--message') {
    summary = argv[++i] || ''
  } else if (!tagArg) {
    tagArg = argv[i]
  } else {
    die('无法识别的参数：' + argv[i])
  }
}
if (!tagArg) die('用法：node release.mjs <tag> [-m 摘要]    例：node release.mjs v1.0.8')

const version = tagArg.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(version)) die('tag 必须是 semver（如 v1.0.8 或 1.0.8），收到：' + tagArg)
const tag = 'v' + version

// ---- 前置校验 ----
for (const tool of ['git', 'gh', 'npm']) {
  try {
    execFileSync(tool, ['--version'], { stdio: 'ignore' })
  } catch {
    die('缺少命令：' + tool)
  }
}
if (out('git', ['status', '--porcelain'])) die('工作区有未提交改动，先提交或 stash 再发版')
try {
  execFileSync('git', ['rev-parse', '--verify', '--quiet', tag], { cwd: here, stdio: 'ignore' })
  die('本地已存在 tag：' + tag)
} catch (e) {
  if (e.status !== 1) throw e
}
if (out('git', ['ls-remote', '--tags', 'origin', tag])) die('远端已存在 tag：' + tag)

const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch === 'HEAD') die('当前处于 detached HEAD，先切回分支再发版')

// ---- 同步版本号 ----
for (const name of ['package.json', 'dsh.plugin.json']) {
  const path = join(here, name)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  if (data.version === version) die(name + ' 版本已是 ' + version + '，无需重复发布')
  data.version = version
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
  console.log('[release] ' + name + ' version -> ' + version)
}

// ---- 编译构建 + 测试 ----
run('npm', ['run', 'build'])
run('npm', ['run', 'check'])
run('npm', ['test'])

// ---- 提交 + tag + 推送 ----
const commitMsg = '发布 ' + tag + (summary ? '：' + summary : '')
run('git', ['add', 'package.json', 'dsh.plugin.json', 'lib/'])
run('git', ['commit', '-m', commitMsg])
run('git', ['tag', tag])
run('git', ['push', 'origin', branch])
run('git', ['push', 'origin', tag])

// ---- 打包 + GitHub Release ----
const tmp = mkdtempSync(join(tmpdir(), 'tokens-worktable-release-'))
try {
  run('npm', ['pack', here, '--pack-destination', tmp])
  const versioned = join(tmp, 'tokens-worktable-' + version + '.tgz')
  const plain = join(tmp, 'tokens-worktable.tgz')
  copyFileSync(versioned, plain)

  const notes = (summary ? summary + '\n\n' : '') +
    '升级命令：\n```\ndsh plugin --profile web add "https://github.com/' + REPO +
    '/releases/download/' + tag + '/tokens-worktable-' + version + '.tgz"\n```\n\n完成后重启 dsh web 并刷新页面。'
  run('gh', ['release', 'create', tag, '--repo', REPO, '--title', 'tokens-worktable ' + tag,
    '--notes', notes, versioned, plain])
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('[release] done: https://github.com/' + REPO + '/releases/tag/' + tag)
