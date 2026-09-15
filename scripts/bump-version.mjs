#!/usr/bin/env node
/**
 * 发版前同步三处版本号：package.json / dsh.plugin.json / package-lock.json
 * （package-lock.json 含顶层 version 与 packages[""].version 两处）。
 *
 * 用法：npm run bump -- <版本>     例：npm run bump -- 1.1.0（v 前缀可有可无）
 *
 * 只改文件、不提交；提交并推送后，发行页「编译发行」的 RELEASE_TAG 一致性校验
 * （scripts/build.sh）才会通过。一键发布（含提交/打 tag/推送/建 Release）仍可用
 * 仓根的 release.mjs。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function die(msg) {
  console.error('[bump] ' + msg)
  process.exit(1)
}

const here = join(dirname(fileURLToPath(import.meta.url)), '..')

const arg = process.argv[2]
if (!arg) die('用法：npm run bump -- <版本>   例：npm run bump -- 1.1.0')
const version = arg.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(version)) die('版本号必须是 semver（如 1.1.0），收到：' + arg)

for (const name of ['package.json', 'dsh.plugin.json']) {
  const path = join(here, name)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  if (data.version === version) die(name + ' 版本已是 ' + version + '，无需 bump')
  data.version = version
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
  console.log('[bump] ' + name + ' version -> ' + version)
}

const lockPath = join(here, 'package-lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
lock.version = version
if (lock.packages && lock.packages['']) lock.packages[''].version = version
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
console.log('[bump] package-lock.json version -> ' + version)

console.log('[bump] 完成。提交并推送后再到发行页构建：')
console.log('  git add package.json dsh.plugin.json package-lock.json')
console.log('  git commit -m "发布 v' + version + '：<摘要>" && git push')
