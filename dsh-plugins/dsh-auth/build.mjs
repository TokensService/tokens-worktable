/**
 * dsh-auth 构建：lib/index.js 服务端 ESM（cordis 插件，无客户端 bundle）。
 * @deepseek-ai/* 与 node:* 由宿主提供，保持 external。
 */
import { build } from 'esbuild'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'lib'), { recursive: true })
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const pluginManifest = JSON.parse(readFileSync(join(here, 'dsh.plugin.json'), 'utf8'))
if (pluginManifest.version !== pkg.version) {
  throw new Error('dsh-auth build: package.json version (' + pkg.version + ') != dsh.plugin.json version (' + pluginManifest.version + ')')
}

await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile: 'lib/index.js',
  bundle: true,
  sourcemap: 'external',
  logLevel: 'info',
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  external: ['@deepseek-ai/*', 'node:*'],
})

console.log('[dsh-auth build] done: lib/index.js')
