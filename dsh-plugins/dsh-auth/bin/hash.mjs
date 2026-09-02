#!/usr/bin/env node
/**
 * dsh-auth 口令哈希生成器：
 *   node bin/hash.mjs            交互式输入（不回显）
 *   node bin/hash.mjs '口令'     直接给出（会留在 shell 历史，慎用）
 * 输出 scrypt$N$r$p$salt$hash，写入 profile 用户覆写层 cordis.patch.yml 的
 * dsh-auth.config.passwordHash 后重启 dsh web 生效。
 */
import { randomBytes, scryptSync } from 'node:crypto'
import readline from 'node:readline'

const N = 16384
const R = 8
const P = 1

/** 不回显的口令输入。 */
function askPassword() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => { if (s.includes('\n')) rl.output.write(s) }
    rl.question('访问口令: ', (answer) => { rl.output.write('\n'); rl.close(); resolve(answer) })
  })
}

const password = process.argv[2] ?? (await askPassword())
if (!password) {
  console.error('口令不能为空')
  process.exit(1)
}
const salt = randomBytes(16)
const hash = scryptSync(password, salt, 32, { N, r: R, p: P })
console.log('scrypt$' + N + '$' + R + '$' + P + '$' + salt.toString('base64') + '$' + hash.toString('base64'))
