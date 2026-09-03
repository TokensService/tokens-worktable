import { Context } from '@deepseek-ai/cordis'
import { execFile, spawn } from 'node:child_process'
import { readdirSync, realpathSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve as pathResolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { homedir, networkInterfaces } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * dsh-worktable 服务端：健康路由 + 工作区内容窗的数据路由。
 * 参考 dsh-better-sidebar 的架构——内容窗能力由本插件自己的服务端路由提供：
 *   - POST /api/worktable/fs     目录列表（资源管理器窗）
 *   - POST /api/worktable/git    git 状态（源代码管理窗）
 *   - WS   /api/worktable/term   node-pty 终端流（终端窗；依赖宿主 node_modules 中的
 *                                node-pty 与 ws，缺失时该路由不注册、终端窗降级提示）
 */

declare const __WT_VERSION__: string
const PLUGIN_VERSION = typeof __WT_VERSION__ === 'undefined' ? 'dev' : __WT_VERSION__

export const name = 'dsh-worktable'
export const inject = ['webServer', 'sessions']

/** 插件项目目录（lib/ 的上一级；经 link: 安装时 realpath 即源码目录，供「开发 dsh-worktable」新会话定位工作目录） */
const PLUGIN_DIR = (() => {
  try { return pathResolve(realpathSync(dirname(fileURLToPath(import.meta.url))), '..') } catch {}
  try { return pathResolve(dirname(fileURLToPath(import.meta.url)), '..') } catch {}
  return process.cwd()
})()

export const HEALTH_PATH = '/api/worktable/health'
export const PROXY_PATH = '/api/worktable/proxy'

/** 服务端代联目标白名单：仅回环 / RFC1918 内网 / 链路本地，避免成为任意 SSRF 出口 */
function isLocalTarget(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === 'dsh.internal' || h === 'host.docker.internal' || h.endsWith('.local')) return true
  const nums = h.split('.').map((s) => (s && /^\d+$/.test(s) ? Number(s) : NaN))
  if (nums.length === 4 && nums.every((n) => !Number.isNaN(n) && n >= 0 && n <= 255)) {
    if (nums[0] === 127) return true                                 // 回环
    if (nums[0] === 10) return true                                  // 10/8
    if (nums[0] === 192 && nums[1] === 168) return true              // 192.168/16
    if (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) return true // 172.16/12
    if (nums[0] === 169 && nums[1] === 254) return true              // 链路本地
    if (nums[0] === 0 && nums[1] === 0 && nums[2] === 0 && nums[3] === 0) return true
    return false
  }
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fd')) return true
  return false
}

const MAX_ENTRIES = 500

/** 本地文件/站点静态资源的 MIME 映射（file 与 site 两条路由共用） */
const FILE_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  pdf: 'application/pdf', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
}

const SITE_PREFIX = '/api/worktable/site'

// 原生皮肤模板（esbuild text loader 嵌入；/api/worktable/template 路由直接下发）
// @ts-ignore
import dshellCss from '../template/dshell.css'
// @ts-ignore
import dshellHtml from '../template/dshell.html'
const TEMPLATE_PREFIX = '/api/worktable/template'

/**
 * 从本插件模块位置向祖先方向查找并加载 node_modules 包（如 ws / node-pty）。
 * 本包经 junction 链接进 profile，普通 import 可能解析不到 profile 级依赖；
 * 同时尝试 junction 路径与 realpath 两条祖先链。
 */
function loadPkg(pkg: string): any | null {
  const starts = new Set<string>()
  try { starts.add(dirname(fileURLToPath(import.meta.url))) } catch {}
  try { starts.add(realpathSync(dirname(fileURLToPath(import.meta.url)))) } catch {}
  for (const start of starts) {
    let dir: string | null = start
    while (dir && dir !== pathResolve(dir, '..')) {
      try {
        const req = createRequire(pathToFileURL(pathResolve(dir, '__wt_probe__.js')).href)
        return req(pkg)
      } catch {}
      dir = pathResolve(dir, '..')
    }
  }
  // 兜底：DSH 标准目录 ~/.dsh/profiles/*/node_modules（宿主按 realpath 加载时前两条链都找不到）
  try {
    const profilesDir = pathResolve(homedir(), '.dsh', 'profiles')
    for (const profile of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!profile.isDirectory() && !profile.isSymbolicLink()) continue
      const nm = pathResolve(profilesDir, profile.name, 'node_modules')
      try {
        const req = createRequire(pathToFileURL(pathResolve(nm, '__wt_probe__.js')).href)
        return req(pkg)
      } catch {}
    }
  } catch {}
  return null
}

/** 解析会话工作目录：服务端 header.cwd 优先，其次客户端传入 cwd，最后进程 cwd */
function serverCwd(ctx: any, sessionId?: string, clientCwd?: string): string {
  if (sessionId) {
    try {
      const headerCwd = ctx.sessions?.get?.(sessionId)?.header?.cwd
      if (typeof headerCwd === 'string' && headerCwd) return headerCwd
    } catch {}
  }
  if (typeof clientCwd === 'string' && clientCwd) return clientCwd
  return process.cwd()
}

function json(res: any, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: any): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

/** 列出一个目录层级（目录在前、大小写不敏感排序、上限 500、隐藏项标注） */
async function listDirectory(path: string) {
  const abs = pathResolve(path)
  const dirents = await readdir(abs, { withFileTypes: true })
  const entries = dirents
    .map((d) => ({ name: d.name, path: abs + sep + d.name, isDir: d.isDirectory(), hidden: d.name.startsWith('.') }))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  const truncated = entries.length > MAX_ENTRIES
  return { path: abs, entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated }
}

function gitExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolvePromise(stdout)
    })
  })
}

/** git 状态快照（porcelain v1 -z；非仓库返回 isRepo:false） */
async function gitStatus(cwd: string) {
  try {
    const branchRaw = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    const porcelain = await gitExec(['status', '--porcelain=v1', '-z'], cwd)
    const entries = porcelain
      .split('\0')
      .filter((s) => s.length > 2)
      .map((s) => ({ xy: s.slice(0, 2), path: s.slice(3) }))
    return { isRepo: true, branch: branchRaw.trim() || 'HEAD', entries }
  } catch {
    return { isRepo: false, branch: undefined, entries: [] }
  }
}

/** 终端 WebSocket 升级路由（同步注册 + ctx.effect，同 better-sidebar；node-pty 缺失时不注册） */
function setupTerminal(webServer: any, ctx: any) {
  if (typeof webServer.registerUpgrade !== 'function') return
  const wsMod = loadPkg('ws')
  const ptyMod = loadPkg('node-pty')
  ctx.logger?.info?.('[dsh-worktable] term deps: ws=' + (wsMod ? 'ok' : 'MISSING') + ' node-pty=' + (ptyMod ? 'ok' : 'MISSING'))
  if (!wsMod || !ptyMod) {
    ctx.logger?.warn('[dsh-worktable] 终端路由未注册：ws/node-pty 不可用')
    return
  }
  const WebSocketServer = wsMod.WebSocketServer ?? wsMod.default?.WebSocketServer
  if (!WebSocketServer) return
  const pty = ptyMod.default ?? ptyMod
  const wss = new WebSocketServer({ noServer: true })
  const spawnShell = (): { cmd: string; args: string[] } =>
    process.platform === 'win32'
      ? { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] } // -NoProfile：跳过用户配置（oh-my-posh 花哨提示符在 xterm 里是乱码，PSReadLine 长输入行不换行被截断）
      : { cmd: process.env.SHELL || '/bin/bash', args: [] }
  const clampDim = (v: number, fallback: number) => Math.min(1024, Math.max(2, Number.isFinite(v) ? v : fallback))

  ctx.effect(() => webServer.registerUpgrade({
    path: '/api/worktable/term',
    handler: (req: any, socket: any, head: any) => {
      wss.handleUpgrade(req, socket, head, (ws: any) => {
        const u = new URL(req.url ?? '/', 'http://dsh.internal')
        const cwd = serverCwd(ctx, u.searchParams.get('sessionId') || undefined, u.searchParams.get('cwd') || undefined)
        const cols = clampDim(Number(u.searchParams.get('cols')), 80)
        const rows = clampDim(Number(u.searchParams.get('rows')), 24)
        let term: any = null
        try {
          const shell = spawnShell()
          term = pty.spawn(shell.cmd, shell.args, { name: 'xterm-256color', cols, rows, cwd, env: process.env })
        } catch (err) {
          try { ws.send('\r\n[worktable] 终端启动失败：' + String(err)) } catch {}
          try { ws.close() } catch {}
          return
        }
        term.onData((d: string) => { try { ws.send(d) } catch {} })
        term.onExit(() => { try { ws.close() } catch {} })
        ws.on('message', (raw: any) => {
          const text = String(raw)
          try {
            const msg = JSON.parse(text)
            if (msg && msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
              term.resize(clampDim(msg.cols, cols), clampDim(msg.rows, rows))
              return
            }
          } catch {}
          try { term.write(text) } catch {}
        })
        ws.on('close', () => { try { term.kill() } catch {} })
      })
    },
  }), 'dsh-worktable: terminal upgrade')
}

export function apply(ctx: Context) {
  const webServer = (ctx as any).webServer
  if (!webServer) {
    ctx.logger?.warn('[dsh-worktable] ctx.webServer 不可用（headless profile？），跳过服务端路由')
    return
  }

  webServer.register({
    kind: 'exact',
    path: HEALTH_PATH,
    handler: (_req: any, res: any) => {
      json(res, 200, { plugin: 'dsh-worktable', version: PLUGIN_VERSION, dir: PLUGIN_DIR, ok: true })
    },
  })

  // 本地文件读取（资源管理器点击 .html 后浏览器标签内打开）
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/file',
    handler: async (req: any, res: any) => {
      try {
        const u = new URL(req.url ?? '/', 'http://dsh.internal')
        const p = u.searchParams.get('path') || ''
        if (!p) { json(res, 400, { error: 'missing path' }); return }
        const abs = pathResolve(p)
        const stat = await import('node:fs/promises').then((m) => m.stat(abs))
        if (stat.size > 20 * 1024 * 1024) { json(res, 413, { error: 'file too large' }); return }
        const data = await readFile(abs)
        const ext = (abs.split('.').pop() || '').toLowerCase()
        const types: Record<string, string> = {
          html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
          css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
          json: 'application/json; charset=utf-8', md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
          pdf: 'application/pdf', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
        }
        res.writeHead(200, { 'content-type': FILE_TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' })
        res.end(data)
      } catch (err) {
        json(res, 404, { error: String(err) })
      }
    },
  })

  // 本地站点（目录级静态托管）：点开 index.html 时挂载整个所在目录，
  // 让 ./assets/... 等相对引用正常解析（前缀路由，余下路径 = <rootToken>/<相对路径>）。
  // 原生皮肤模板：HTML 骨架 + 设计系统样式表（随插件分发，主题自动适配）
  webServer.register({
    kind: 'prefix',
    path: TEMPLATE_PREFIX,
    handler: (req: any, res: any) => {
      try {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const rel = pathname.slice(TEMPLATE_PREFIX.length)
        if (rel === '/dshell.css') {
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
          res.end(dshellCss)
        } else {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(dshellHtml)
        }
      } catch (err) {
        res.writeHead(404); res.end(String(err))
      }
    },
  })

  webServer.register({
    kind: 'prefix',
    path: SITE_PREFIX,
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const segs = pathname.slice(SITE_PREFIX.length).split('/').filter(Boolean)
        const rootToken = decodeURIComponent(segs.shift() ?? '')
        const rel = segs.map((s) => { try { return decodeURIComponent(s) } catch { return s } }).join('/')
        if (!rootToken) { json(res, 400, { error: 'missing root' }); return }
        const root = pathResolve(rootToken)
        let abs = pathResolve(root, rel)
        if (abs !== root && !abs.startsWith(root + sep)) { json(res, 403, { error: 'outside root' }); return }
        const statMod = await import('node:fs/promises')
        let info = await statMod.stat(abs).catch(() => null)
        if (info && info.isDirectory()) {
          abs = pathResolve(abs, 'index.html')
          info = await statMod.stat(abs).catch(() => null)
        }
        if (!info || !info.isFile()) { json(res, 404, { error: 'not found' }); return }
        if (info.size > 40 * 1024 * 1024) { json(res, 413, { error: 'file too large' }); return }
        const data = await readFile(abs)
        const ext = (abs.split('.').pop() || '').toLowerCase()
        res.writeHead(200, { 'content-type': FILE_TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' })
        res.end(data)
      } catch (err) {
        json(res, 404, { error: String(err) })
      }
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/worktable/fs',
    handler: async (req: any, res: any) => {
      try {
        const body = await readJsonBody(req)
        const path = typeof body.path === 'string' && body.path
          ? body.path
          : serverCwd(ctx, body.sessionId, body.cwd)
        json(res, 200, await listDirectory(path))
      } catch (err) {
        json(res, 500, { path: '', entries: [], truncated: false, error: String(err) })
      }
    },
  })

  // 工作区列表（自定义窗口会话分组用）：读宿主 ~/.dsh/storages/workspace.json（只读）
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/workspaces',
    handler: async (_req: any, res: any) => {
      try {
        const file = pathResolve(homedir(), '.dsh', 'storages', 'workspace.json')
        const raw = await readFile(file, 'utf8')
        // 容忍 BOM（外部工具改写可能带 EF BB BF，JSON.parse 会抛错）
        json(res, 200, JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw))
      } catch (err) {
        json(res, 404, { error: String(err) })
      }
    },
  })

  // 跨浏览器同步的项目存储：新建项目一律本地（localStorage），完善后在管理列表点 ☁「发布」，
  // 布局条目转存此文件；任何浏览器启动时 GET 拉取合并，取消发布即移出。
  // 全量覆盖写（last-write-wins），原子落盘（tmp + rename）。
  const PROJECTS_STORE = pathResolve(homedir(), '.dsh', 'storages', 'worktable-projects.json')
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/projects',
    handler: async (req: any, res: any) => {
      try {
        if (req.method === 'GET') {
          let raw = ''
          try { raw = await readFile(PROJECTS_STORE, 'utf8') } catch { /* 无文件 = 空集 */ }
          const p = raw ? JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) : {}
          json(res, 200, {
            layouts: Array.isArray(p.layouts) ? p.layouts : [],
            folders: p.folders && typeof p.folders === 'object' ? p.folders : {},
            workspaces: p.workspaces && typeof p.workspaces === 'object' ? p.workspaces : {},
          })
          return
        }
        if (req.method === 'PUT') {
          const body = await readJsonBody(req)
          const layouts = Array.isArray(body.layouts)
            ? body.layouts.filter((l: any) => l && typeof l.id === 'string' && typeof l.title === 'string' && Array.isArray(l.main))
            : []
          const folders: Record<string, string> = {}
          if (body.folders && typeof body.folders === 'object') {
            for (const [k, v] of Object.entries(body.folders)) if (typeof v === 'string') folders[k] = v
          }
          const workspaces: Record<string, string> = {}
          if (body.workspaces && typeof body.workspaces === 'object') {
            for (const [k, v] of Object.entries(body.workspaces)) if (typeof v === 'string') workspaces[k] = v
          }
          const text = JSON.stringify({ layouts, folders, workspaces })
          if (text.length > 1024 * 1024) { json(res, 413, { error: 'too large' }); return }
          const fsx = await import('node:fs/promises')
          await fsx.mkdir(dirname(PROJECTS_STORE), { recursive: true })
          const tmp = PROJECTS_STORE + '.tmp'
          await fsx.writeFile(tmp, text, 'utf8')
          await fsx.rename(tmp, PROJECTS_STORE)
          json(res, 200, { ok: true })
          return
        }
        res.writeHead(405); res.end()
      } catch (err) {
        json(res, 500, { error: String(err) })
      }
    },
  })

  // 流水线工作台（pipeline.html）的服务端持久化：配置（pipelines/envs/scriptsDir/theme 等）
  // 与运行历史（含各阶段日志快照）。全量覆盖写（last-write-wins），原子落盘（tmp + rename）。
  const PIPELINE_STORE = pathResolve(homedir(), '.dsh', 'storages', 'worktable-pipeline.json')
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/pipeline',
    handler: async (req: any, res: any) => {
      try {
        if (req.method === 'GET') {
          let raw = ''
          try { raw = await readFile(PIPELINE_STORE, 'utf8') } catch { /* 无文件 = 空集 */ }
          const p = raw ? JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) : {}
          json(res, 200, {
            config: p.config && typeof p.config === 'object' && !Array.isArray(p.config) ? p.config : {},
            history: Array.isArray(p.history) ? p.history : [],
          })
          return
        }
        if (req.method === 'PUT') {
          const body = await readJsonBody(req)
          const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {}
          const history = Array.isArray(body.history) ? body.history.slice(0, 500) : []
          const text = JSON.stringify({ config, history })
          if (text.length > 20 * 1024 * 1024) { json(res, 413, { error: 'too large' }); return }
          const fsx = await import('node:fs/promises')
          await fsx.mkdir(dirname(PIPELINE_STORE), { recursive: true })
          const tmp = PIPELINE_STORE + '.tmp'
          await fsx.writeFile(tmp, text, 'utf8')
          await fsx.rename(tmp, PIPELINE_STORE)
          json(res, 200, { ok: true })
          return
        }
        res.writeHead(405); res.end()
      } catch (err) {
        json(res, 500, { error: String(err) })
      }
    },
  })

  // ---- 流水线定时任务（服务端调度，关闭页面也会执行）----
  // 计划存独立文件 worktable-pipeline-plans.json；调度器每 15s 轮询，到期即在服务端执行：
  // 脚本阶段用 bash 真跑（参数/环境注入规则与前端 execScript 一致），模拟阶段按耗时等待，
  // 审批门自动通过；运行记录（含各阶段日志）追加进 worktable-pipeline.json 的 history。
  const PLANS_STORE = pathResolve(homedir(), '.dsh', 'storages', 'worktable-pipeline-plans.json')

  async function writeJsonAtomic(file: string, text: string) {
    const fsx = await import('node:fs/promises')
    await fsx.mkdir(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    await fsx.writeFile(tmp, text, 'utf8')
    await fsx.rename(tmp, file)
  }
  async function readPlansFile(): Promise<any[]> {
    try {
      const raw = await readFile(PLANS_STORE, 'utf8')
      const j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
      return Array.isArray(j.plans) ? j.plans : []
    } catch { return [] }
  }
  async function readPipelineStore(): Promise<any> {
    try {
      const raw = await readFile(PIPELINE_STORE, 'utf8')
      return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
    } catch { return {} }
  }

  webServer.register({
    kind: 'exact',
    path: '/api/worktable/pipeline/plans',
    handler: async (req: any, res: any) => {
      try {
        if (req.method === 'GET') { json(res, 200, { plans: await readPlansFile() }); return }
        if (req.method === 'PUT') {
          const body = await readJsonBody(req)
          const plans = Array.isArray(body.plans)
            ? body.plans.filter((p: any) => p && typeof p.id === 'string' && (p.kind === 'once' || p.kind === 'interval')).slice(0, 100)
            : []
          const text = JSON.stringify({ plans })
          if (text.length > 1024 * 1024) { json(res, 413, { error: 'too large' }); return }
          await writeJsonAtomic(PLANS_STORE, text)
          json(res, 200, { ok: true })
          return
        }
        res.writeHead(405); res.end()
      } catch (err) {
        json(res, 500, { error: String(err) })
      }
    },
  })

  // AI 日志分析：把前端汇总好的运行日志（Markdown）写到固定文件，返回绝对路径，
  // 由页面 postMessage 给插件客户端新开会话分析（路径对聊天 Agent 可读）
  const LOGDUMP_FILE = pathResolve(homedir(), '.dsh', 'storages', 'worktable-pipeline-logs.md')
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/pipeline/logdump',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const content = typeof body.content === 'string' ? body.content : ''
        if (!content) { json(res, 400, { error: 'missing content' }); return }
        if (content.length > 20 * 1024 * 1024) { json(res, 413, { error: 'too large' }); return }
        await writeJsonAtomic(LOGDUMP_FILE, content)
        json(res, 200, { ok: true, path: LOGDUMP_FILE })
      } catch (err) {
        json(res, 500, { error: String(err) })
      }
    },
  })

  // ---- GPU 状态查询（pipeline.html 环境页/多选面板；本机直连，远程经 sshpass+ssh）----
  // 响应：{ total, used, gpus:[{index,util,mem}], procs:[{pid,uuid,proc,container,up}], containers:[名称...] }
  // up 为容器已运行时长（docker/nerdctl 的 RunningFor，如 "Up 3 days"），未能关联容器时为空串
  // 失败返回 { error }（HTTP 仍 200，前端据 error 字段展示原因）
  function localAddrs(): Set<string> {
    const set = new Set<string>(['127.0.0.1', 'localhost', '::1'])
    try {
      const ifs = networkInterfaces()
      for (const list of Object.values(ifs)) for (const it of list || []) if (it && it.address) set.add(it.address)
    } catch { /* 忽略，按远程处理 */ }
    return set
  }
  function execText(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      // 超时 60s：远程探针含 ssh 握手 + 3 次 nvidia-smi + nerdctl 列容器，繁忙节点实测 ~10s，20s 余量不足
      execFile(cmd, args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          // execFile 超时/被终止时 stderr 为空，err.message 只剩 "Command failed: ..."，补一句可读的失败原因
          const why = (err as any).killed ? '（执行超过 60s 被终止）' : ''
          reject(new Error((String(stderr || '').trim() || String((err as Error).message || err)) + why))
        }
        else resolvePromise(String(stdout || ''))
      })
    })
  }
  // 一段命令取全量数据（=== 分四段：GPU 列表 / 计算进程 / 进程容器 cgroup / 容器清单）
  // 容器清单段兼容无 docker 的 K8s 节点：docker（有则输出）+ nerdctl 的 k8s.io 与 default 两个 namespace；
  // 段尾 true 兜底：ssh 退出码取末条命令，目标机缺 nerdctl/docker 时否则会整体以 127 失败、丢掉已采到的数据
  const GPU_PROBE =
    'nvidia-smi --query-gpu=index,uuid,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits; ' +
    'echo ===; ' +
    'nvidia-smi --query-compute-apps=pid,gpu_uuid,process_name --format=csv,noheader; ' +
    'echo ===; ' +
    'for p in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null); do ' +
    'echo "$p:$(cat /proc/$p/cgroup 2>/dev/null | grep -oE "[0-9a-f]{64}" | head -1)"; done; ' +
    'echo ===; ' +
    '(docker ps --format "{{.ID}}|{{.Names}}|{{.RunningFor}}" 2>/dev/null; ' +
    'nerdctl --namespace k8s.io ps --format "{{.ID}}|{{.Names}}|{{.RunningFor}}" 2>/dev/null; ' +
    'nerdctl ps --format "{{.ID}}|{{.Names}}|{{.RunningFor}}" 2>/dev/null; true)'
  async function queryGpu(ip: string, user: string, pass: string) {
    let out: string
    if (localAddrs().has(ip)) {
      out = await execText('bash', ['-c', GPU_PROBE])
    } else {
      const target = user ? user + '@' + ip : ip
      // 远程登录 shell 可能是 zsh（如部分 BMS 节点）：`echo ===` 触发 zsh 的 =word 展开报错，
      // $(...) 结果默认不做单词拆分导致 for 循环失效。base64 编码后经管道交给 bash 执行，与登录 shell 解耦。
      const remoteCmd = 'echo ' + Buffer.from(GPU_PROBE).toString('base64') + ' | base64 -d | bash'
      // UserKnownHostsFile=/dev/null：不查不写 known_hosts，首次登录的 yes/no 确认与
      // 重装后指纹变更（REMOTE HOST IDENTIFICATION HAS CHANGED）都不阻塞（内网受信前提）
      const sshArgs = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=8', target, remoteCmd]
      // 密码路径：只做密码/键盘交互认证（跳过公钥尝试，避免 agent 密钥过多触发 Too many authentication failures），
      // 密码只喂一次（错误即失败返回，不把错密码重试 3 遍触发账户锁定）
      out = pass
        ? await execText('sshpass', ['-p', pass, 'ssh', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', ...sshArgs])
        : await execText('ssh', ['-o', 'BatchMode=yes', ...sshArgs])
    }
    const secs = out.split(/^===\s*$/m)
    const gpus = (secs[0] || '').trim().split('\n').filter(Boolean).map((l) => {
      const p = l.split(',').map((s) => s.trim())
      return { index: p[0], uuid: p[1] || '', util: p[2] || '0', mem: p[3] || '0' }
    })
    if (!gpus.length) return { error: 'nvidia-smi 无输出（未安装驱动或无 GPU）' }
    const procs = (secs[1] || '').trim().split('\n').filter(Boolean).map((l) => {
      const p = l.split(',').map((s) => s.trim())
      return { pid: p[0], uuid: p[1] || '', proc: p[2] || '' }
    })
    const cg: Record<string, string> = {}
    for (const l of (secs[2] || '').trim().split('\n')) {
      const m = /^(\S+):([0-9a-f]{64})$/.exec(l.trim())
      if (m) cg[m[1]] = m[2]
    }
    // 容器清单行格式 id|名称|已运行时长（RunningFor 含空格，故用 | 分隔而非空白）
    const dockers = (secs[3] || '').trim().split('\n').filter(Boolean).map((l) => {
      const p = l.trim().split('|')
      return { id: (p[0] || '').trim(), name: (p[1] || '').trim(), up: (p.slice(2).join('|') || '').trim() }
    })
    const procsOut = procs.map((p) => {
      let container = '', up = ''
      const hex = cg[p.pid]
      if (hex) { const d = dockers.find((x) => x.id && hex.indexOf(x.id) === 0); if (d) { container = d.name; up = d.up } }
      return { pid: p.pid, uuid: p.uuid, proc: p.proc, container, up }
    })
    const busyUuids = new Set(procs.map((p) => p.uuid))
    const used = gpus.filter((g) => busyUuids.has(g.uuid) || Number(g.mem) > 1024).length
    const containers = Array.from(new Set(procsOut.map((p) => p.container).filter(Boolean)))
    return { total: gpus.length, used, gpus: gpus.map((g) => ({ index: g.index, util: g.util, mem: g.mem })), procs: procsOut, containers }
  }
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/gpu',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const ip = typeof body.ip === 'string' ? body.ip.trim() : ''
        if (!ip) { json(res, 400, { error: 'missing ip' }); return }
        const r = await queryGpu(ip, typeof body.user === 'string' ? body.user.trim() : '', typeof body.pass === 'string' ? body.pass : '')
        json(res, 200, r)
      } catch (err) {
        json(res, 200, { error: String(err && (err as Error).message ? (err as Error).message : err) })
      }
    },
  })

  const planRunning = new Set<string>()
  const planLastRun = new Map<string, number>()
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const randHex = (n: number) => Math.random().toString(16).slice(2, 2 + n)
  const hhmm = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
  const durText = (sec: number) => (sec < 60 ? Math.round(sec) + 's' : Math.floor(sec / 60) + 'm' + Math.round(sec % 60) + 's')
  const truncLog = (t: string) => (t.length > 8192 ? t.slice(0, 8192) + '\n…(截断)' : t)
  // 与页面一致的归档命名：文件名安全化（非法字符/空白 → '-'，去首尾 '-'）
  const sanitizeFsName = (s: any) => String(s || 'pipeline').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'pipeline'
  const nowCompactFull = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) }
  const stripSuffixName = (name: any) => String(name || '').replace(/\s*·\s*定时后缀\s*$/, '') || 'pipeline'

  /** 任务级回显归档（定时执行）：与页面 archiveStageLog 同一约定 run-<tag>-NN-任务名.log；失败仅告警不影响执行 */
  async function writeTaskLogFile(folder: string, tag: string, seq: number, name: string, text: string): Promise<string | null> {
    try {
      const fsx = await import('node:fs/promises')
      await fsx.mkdir(folder, { recursive: true })
      const file = folder + '/run-' + tag + '-' + String(seq).padStart(2, '0') + '-' + sanitizeFsName(name) + '.log'
      await fsx.writeFile(file, text, 'utf8')
      return file
    } catch (e) { console.warn('[archive] 定时任务日志归档失败（不影响执行）:', e); return null }
  }

  function runStageScript(sc: any, runCtx: any, scriptsDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const args: string[] = []
    const env: Record<string, string> = {}
    for (const p of sc.params || []) {
      // 与前端 execScript 一致：静态 :-默认值 照常下发（页面已预填为显式值）；
      // 动态默认值（dyn，含 $引用/$(命令) 的脚本表达式）不下发字面值——注入后 shell 不会二次展开，
      // 留空交由脚本自身 :- 展开，同时不挡住下方同名的运行级注入（TARGET_IP/TARGET_USER 等）。
      const hasVal = sc.values && sc.values[p.key] !== undefined
      const v = hasVal ? sc.values[p.key] : (p.dyn ? '' : p.def || '')
      if (p.kind === 'pos') args.push(String(v))
      else if (String(v) !== '') env[p.key] = String(v)
    }
    // 与前端 execScript 一致：注入运行上下文（脚本显式配置的同名参数优先）：
    //   TARGET_IP=首个目标节点 IP；TARGET_IPS=全部目标 IP（JSON 数组）
    //   TARGET_HOSTS=全部节点 [{ip,user,pass}]（JSON 数组，多节点各自凭据）
    //   TARGET_USER/TARGET_PASSWORD=首个节点登录凭据；IMAGE_NAME/IMAGE_TAG=镜像名与本次 tag；
    //   PIPELINE_NAME=流水线名；GIT_BRANCH/DEPLOY_STRATEGY=分支与部署策略
    const ctx0 = (runCtx.envs && runCtx.envs[0]) || null
    if (env.TARGET_IP === undefined) env.TARGET_IP = String((ctx0 && ctx0.ip) || runCtx.env || '')
    if (env.TARGET_IPS === undefined && runCtx.envs) env.TARGET_IPS = JSON.stringify((runCtx.envs || []).map((e: any) => e.ip))
    if (env.TARGET_HOSTS === undefined && runCtx.envs) env.TARGET_HOSTS = JSON.stringify((runCtx.envs || []).map((e: any) => ({ ip: e.ip, user: e.user || '', pass: e.pass || '' })))
    if (env.IMAGE_NAME === undefined && runCtx.image) env.IMAGE_NAME = String(runCtx.image)
    if (env.IMAGE_TAG === undefined && runCtx.tag) env.IMAGE_TAG = String(runCtx.tag)
    if (env.PIPELINE_NAME === undefined && runCtx.pipelineName) env.PIPELINE_NAME = String(runCtx.pipelineName)
    if (env.GIT_BRANCH === undefined && runCtx.branch) env.GIT_BRANCH = String(runCtx.branch)
    if (env.DEPLOY_STRATEGY === undefined && runCtx.strategy) env.DEPLOY_STRATEGY = String(runCtx.strategy)
    if (ctx0) {
      if (ctx0.user && env.TARGET_USER === undefined) env.TARGET_USER = String(ctx0.user)
      if (ctx0.pass && env.TARGET_PASSWORD === undefined) env.TARGET_PASSWORD = String(ctx0.pass)
    }
    // 与前端 execScript 一致：注入归档上下文（脚本显式配置的同名参数优先）
    if (runCtx.archive) {
      if (env.ARCHIVE_DIR === undefined) env.ARCHIVE_DIR = String(runCtx.archive)
      if (env.ARCHIVE_FOLDER === undefined) env.ARCHIVE_FOLDER = String(runCtx.archive)
      if (runCtx.pipelineName && env.ARCHIVE_PIPELINE === undefined) env.ARCHIVE_PIPELINE = String(runCtx.pipelineName)
      if (runCtx.tag && env.ARCHIVE_TAG === undefined) env.ARCHIVE_TAG = String(runCtx.tag)
    }
    return new Promise((resolve) => {
      const isPy = sc.lang === 'py' || /\.py$/i.test(sc.name || '')
      execFile(isPy ? 'python3' : 'bash', [sc.path, ...args], { cwd: scriptsDir || undefined, env: { ...process.env, ...env }, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
          resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })
        })
    })
  }
  function stageLogText(name: string, r: { code: number; stdout: string; stderr: string }) {
    const interp = /\.py$/i.test(name) ? 'python3' : 'bash'
    let t = '$ ' + interp + ' ' + name + '\n' + (r.stdout || '')
    if (r.stderr) t += '\n✗ ' + r.stderr.split('\n').join('\n✗ ')
    return truncLog(t + '\n[exit ' + r.code + ']')
  }
  async function appendPipelineHistory(rec: any) {
    const j = await readPipelineStore()
    const cfg = j.config && typeof j.config === 'object' && !Array.isArray(j.config) ? j.config : {}
    const history = Array.isArray(j.history) ? j.history : []
    const no = Math.max(Number(cfg.buildNo) || 0, ...history.map((h: any) => Number(h && h.no) || 0), 0) + 1
    cfg.buildNo = no
    rec.no = no
    history.unshift(rec)
    const text = JSON.stringify({ config: cfg, history: history.slice(0, 500) })
    if (text.length > 20 * 1024 * 1024) return
    await writeJsonAtomic(PIPELINE_STORE, text)
  }
  async function execPlan(pl: any) {
    const t0 = Date.now()
    const store = await readPipelineStore()
    const cfg = store.config && typeof store.config === 'object' && !Array.isArray(store.config) ? store.config : {}
    const scriptsDir = typeof cfg.scriptsDir === 'string' ? cfg.scriptsDir : ''
    // 归档上下文（与页面约定一致）：
    //   阶段定时后缀沿用页面传入的 pl.archive/pl.tag/baseSeq——回显写入本地前缀同一归档文件夹、编号连贯；
    //   独立定时计划自建「<流水线名>_<年月日时分秒>」文件夹（archiveDir 或 scriptsDir 旁 runs/ 兜底，同页面 fallbackArchiveRoot）。
    const pipeName = stripSuffixName(pl.pipelineName)
    const tag = (typeof pl.tag === 'string' && pl.tag) ? pl.tag : hhmm().replace(':', '') + '-' + randHex(5)
    const baseSeq = Math.max(0, Number(pl.baseSeq) || 0)
    const isSuffixRun = typeof pl.archive === 'string' && !!pl.archive
    let archiveRoot = typeof cfg.archiveDir === 'string' ? cfg.archiveDir.trim().replace(/\/+$/, '') : ''
    if (!archiveRoot && scriptsDir && scriptsDir.charAt(0) === '/') {
      const dir = scriptsDir.replace(/\/+$/, '').replace(/\/[^/]*$/, '')
      archiveRoot = (dir || '/') + '/runs'
    }
    const folder = isSuffixRun ? String(pl.archive) : (archiveRoot ? archiveRoot + '/' + sanitizeFsName(pipeName) + '_' + nowCompactFull() : null)
    const runCtx = { env: pl.env || '', envs: Array.isArray(pl.envs) ? pl.envs : [], archive: folder, tag, pipelineName: pipeName, image: pl.image || '', branch: pl.branch || '', strategy: pl.strategy || '' }
    const logs: any[] = []
    const profileStages: any[] = []
    let status = 'success'
    // 与页面行为一致：勾选「先清理环境」时启动前先执行清理脚本（回显归档为 00 号任务日志）
    if (cfg.cleanupEnabled && cfg.cleanupScript && cfg.cleanupScript.path) {
      const st0 = Date.now()
      const r = await runStageScript(cfg.cleanupScript, runCtx, scriptsDir)
      const text = stageLogText(cfg.cleanupScript.name, r)
      const logFile = folder ? await writeTaskLogFile(folder, tag, 0, '环境清理', text) : null
      logs.push({ stage: '环境清理', status: r.code === 0 ? 'success' : 'failed', log: text })
      profileStages.push({ id: '__cleanup__', name: '环境清理', status: r.code === 0 ? 'success' : 'failed', durSec: Math.round((Date.now() - st0) / 100) / 10, script: cfg.cleanupScript.name || null, logFile })
    }
    let seq = baseSeq + 1
    for (const s of pl.stages || []) {
      const st0 = Date.now()
      let entry: any = null
      if (s.skip || s.gate) { entry = { status: 'skipped', text: '[定时执行] 本阶段配置为不执行，已跳过' } }   // 兼容旧计划中的 gate（审批门）标记
      else if (s.kind === 'url' || s.kind === 'jenkins') { entry = { status: 'success', text: '[定时执行] URL 请求阶段：定时触发暂不支持，已跳过' } }   // 兼容旧计划中的 kind:'jenkins'（Jenkins 阶段已改为 URL 请求阶段）
      else if (s.script && s.script.path) {
        const r = await runStageScript(s.script, runCtx, scriptsDir)
        entry = { status: r.code === 0 ? 'success' : 'failed', text: stageLogText(s.script.name, r) }
        if (r.code !== 0) status = 'failed'
      } else {
        await sleepMs(Math.min(Math.max(1, Number(s.dur) || 5), 60) * 1000)
        entry = { status: 'success', text: '[定时执行] 模拟阶段完成' }
      }
      // 每个任务的回显都写入归档文件夹、独立日志文件（run-<tag>-NN-任务名.log）
      const logFile = folder ? await writeTaskLogFile(folder, tag, seq, s.name, entry.text) : null
      logs.push({ stage: s.name, status: entry.status, log: entry.text })
      profileStages.push({ id: s.id, name: s.name, status: entry.status, durSec: Math.round((Date.now() - st0) / 100) / 10, script: (s.script && s.script.name) || null, logFile })
      seq++
      if (status === 'failed') break
    }
    // 汇总 run-<tag>.log + profiling run-<tag>.profile.json（与页面 archiveRun 同约定）：
    //   定时后缀追加到页面登记时已写内容（去掉旧 [result] 行、profile 按阶段 id/name 合并）；独立计划整文件新建。
    if (folder) {
      try {
        const fsx = await import('node:fs/promises')
        await fsx.mkdir(folder, { recursive: true })
        const sumFile = folder + '/run-' + tag + '.log'
        let prev = ''
        try { prev = await fsx.readFile(sumFile, 'utf8') } catch { /* 首次创建 */ }
        prev = prev.replace(/\s*\[result\][^\n]*\s*$/, '')   // 去掉页面登记时写入的 result 行，由服务端统一收尾
        const lines: string[] = []
        if (prev.trim()) lines.push(prev.replace(/\s+$/, ''), '', '----- 定时执行（服务端） -----')
        logs.forEach(l => { lines.push('===== ' + l.stage + ' [' + l.status + '] ====='); l.log.split('\n').forEach((x: string) => lines.push(x)); lines.push('') })
        lines.push('[result] ' + status)
        await fsx.writeFile(sumFile, lines.join('\n') + '\n', 'utf8')
      } catch (e) { console.warn('[archive] 定时运行日志汇总失败（不影响执行）:', e) }
      try {
        const fsx = await import('node:fs/promises')
        const profFile = folder + '/run-' + tag + '.profile.json'
        let profile: any = null
        try { profile = JSON.parse(await fsx.readFile(profFile, 'utf8')) } catch { /* 首次创建 */ }
        if (!profile || typeof profile !== 'object') profile = {}
        profile.pipeline = pipeName
        profile.tag = tag
        if (!profile.commit) profile.commit = randHex(7)
        profile.env = pl.env || ''
        profile.image = pl.image || ''
        profile.by = pl.by || 'schedule'
        profile.source = isSuffixRun ? '定时后缀' : '定时计划'
        profile.result = status
        if (!profile.startTime) profile.startTime = new Date(t0).toISOString()
        profile.totalDurSec = Math.round((Date.now() - t0) / 100) / 10
        if (!Array.isArray(profile.stages)) profile.stages = []
        profileStages.forEach(rec => {
          const idx = profile.stages.findIndex((x: any) => x && (x.id === rec.id || x.name === rec.name))
          if (idx >= 0) profile.stages[idx] = { ...profile.stages[idx], ...rec }
          else profile.stages.push(rec)
        })
        await fsx.writeFile(profFile, JSON.stringify(profile, null, 2), 'utf8')
      } catch (e) { console.warn('[archive] 定时运行 profiling 写入失败（不影响执行）:', e) }
      // 归档脚本（可选）：与页面一致，写完日志/profiling 后执行（如 collect_logs.sh），收集额外日志到归档目录；失败不影响执行
      const archiveScriptName = typeof cfg.archiveScript === 'string' ? cfg.archiveScript.trim() : ''
      if (archiveScriptName && archiveRoot && typeof cfg.archiveDir === 'string' && cfg.archiveDir.trim()) {
        try {
          await new Promise<void>((resolve) => {
            execFile('bash', [pathResolve(scriptsDir, archiveScriptName)], {
              cwd: scriptsDir || undefined,
              env: { ...process.env, ARCHIVE_DIR: folder, ARCHIVE_FOLDER: folder, ARCHIVE_LOG_FILE: folder + '/run-' + tag + '.log', ARCHIVE_PROFILE_FILE: folder + '/run-' + tag + '.profile.json', ARCHIVE_PIPELINE: pipeName, ARCHIVE_TAG: tag, ARCHIVE_RESULT: status },
              timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
            }, (err) => { if (err) console.warn('[archive] 归档脚本退出码 ' + ((err as any).code ?? err) + '（不影响执行）'); resolve() })
          })
        } catch (e) { console.warn('[archive] 归档脚本执行失败（不影响执行）:', e) }
      }
    }
    await appendPipelineHistory({
      no: 0, pipeline: pl.pipelineName || '', env: pl.env || '', commit: randHex(7),
      status, dur: durText((Date.now() - t0) / 1000), time: '今天 ' + hhmm(), by: pl.by || 'schedule', logs,
      tag, archive: folder || null,
    })
  }
  async function planTick() {
    const plans = await readPlansFile()
    const now = Date.now()
    for (const p of plans) {
      if (!p || typeof p.id !== 'string' || planRunning.has(p.id)) continue
      if (p.kind === 'once') {
        if (!(Number(p.at) > 0) || Number(p.at) > now) continue
        planRunning.add(p.id)
        // 一次性：执行完从计划文件中移除
        execPlan(p).catch(() => {}).finally(async () => {
          planRunning.delete(p.id)
          const rest = (await readPlansFile()).filter((x: any) => x && x.id !== p.id)
          await writeJsonAtomic(PLANS_STORE, JSON.stringify({ plans: rest })).catch(() => {})
        })
      } else if (p.kind === 'interval') {
        // 周期单位：min/hour/day/week 按固定毫秒步进；month/year 按日历步进（每月/每年同日触发）。
        // 旧计划仅带 everyMin（分钟）：unit 归一为 'min'、every 取 everyMin，向后兼容。
        const unit = typeof p.everyUnit === 'string' && p.everyUnit ? p.everyUnit : 'min'
        const every = Math.max(1, Number(p.every) || Number(p.everyMin) || 10)
        const startAt = Number(p.startAt) || 0
        if (startAt && now < startAt) continue
        const base = startAt || Number(p.createdAt) || now
        // 有 startAt 时首触发点为 startAt 本身（last 取 base 之前，语义与旧版一致）；否则首触发在 createdAt 之后一个周期
        const last = planLastRun.get(p.id) || (startAt ? base - 1 : base)
        // 计算 last 之后第一个应触发点：固定单位直接按步长取整推进；日历单位从基准逐格步进（月/年格数有限）
        const FIXED_MS: Record<string, number> = { min: 60000, hour: 3600000, day: 86400000, week: 604800000 }
        let next: number
        if (FIXED_MS[unit]) {
          const step = FIXED_MS[unit] * every
          next = base + (Math.floor((last - base) / step) + 1) * step
        } else {
          next = base
          const d = new Date(base)
          let guard = 0
          while (next <= last && guard++ < 5000) {
            if (unit === 'year') d.setFullYear(d.getFullYear() + every)
            else d.setMonth(d.getMonth() + every)
            next = d.getTime()
          }
        }
        if (next > now) continue
        planLastRun.set(p.id, now)
        planRunning.add(p.id)
        execPlan(p).catch(() => {}).finally(() => planRunning.delete(p.id))
      }
    }
  }
  setInterval(() => { planTick().catch(() => {}) }, 15000)

  // 流水线阶段脚本执行（pipeline.html 的 execScript 调用）：按扩展名选解释器（.sh→bash、.py→python3），
  // 环境变量/参数由前端 execScript 组装后透传（注入规则与 runStageScript 一致，在前端完成）。
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/exec',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const path = typeof body.path === 'string' ? body.path : ''
        if (!path) { json(res, 400, { error: 'missing path' }); return }
        const args: string[] = Array.isArray(body.args) ? body.args.map((a: any) => String(a)) : []
        const envIn = (body.env && typeof body.env === 'object') ? body.env : {}
        const env: Record<string, string> = {}
        for (const k of Object.keys(envIn)) { const v = (envIn as any)[k]; if (v !== undefined && v !== null) env[k] = String(v) }
        const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined
        const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 120000, 1000), 3600000)
        const interp = /\.py$/i.test(path) ? 'python3' : 'bash'
        execFile(interp, [path, ...args], { cwd, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) => {
            const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
            json(res, 200, { code, stdout: String(stdout || ''), stderr: String(stderr || '') })
          })
      } catch (err) {
        json(res, 500, { error: String(err && err.message ? err.message : err) })
      }
    }
  })

  // 流式执行（脚本阶段实时回显）：参数与 /api/worktable/exec 一致，但用 spawn 边执行边把
  // stdout/stderr 以 NDJSON 逐块回传（{"type":"out"|"err","text":…} / {"type":"done","code":N} /
  // {"type":"error","message":…}）。pipeline.html 的 execStreaming 按行解析、实时追加到阶段详情；
  // 客户端断开（中止 / 刷新）时终止子进程（detached 进程组，SIGTERM 连子进程一起收）；超时同样生效。
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/exec-stream',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const scriptPath = typeof body.path === 'string' ? body.path : ''
        if (!scriptPath) { json(res, 400, { error: 'missing path' }); return }
        const args: string[] = Array.isArray(body.args) ? body.args.map((a: any) => String(a)) : []
        const envIn = (body.env && typeof body.env === 'object') ? body.env : {}
        const env: Record<string, string> = {}
        for (const k of Object.keys(envIn)) { const v = (envIn as any)[k]; if (v !== undefined && v !== null) env[k] = String(v) }
        const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined
        const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 120000, 1000), 3600000)
        const interp = /.py$/i.test(scriptPath) ? 'python3' : 'bash'
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
        const send = (obj: unknown) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n') }
        // detached 让子进程成为独立进程组组长，终止时整个进程组一起收（脚本的子进程不残留孤儿）
        const child = spawn(interp, [scriptPath, ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true, detached: process.platform !== 'win32' })
        let finished = false
        let timedOut = false
        const killTree = (sig: string) => {
          try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig) } catch {}
        }
        const killTimer = setTimeout(() => { timedOut = true; killTree('SIGKILL') }, timeoutMs)
        child.stdout.on('data', (d: Buffer) => send({ type: 'out', text: d.toString('utf8') }))
        child.stderr.on('data', (d: Buffer) => send({ type: 'err', text: d.toString('utf8') }))
        child.on('error', (err: Error) => {               // ENOENT 等无法启动
          if (finished) return
          finished = true
          clearTimeout(killTimer)
          send({ type: 'error', message: String(err && err.message ? err.message : err) })
          res.end()
        })
        child.on('close', (code: number | null) => {
          if (finished) return
          finished = true
          clearTimeout(killTimer)
          if (timedOut) send({ type: 'error', message: 'exec timed out after ' + Math.round(timeoutMs / 1000) + 's' })
          else send({ type: 'done', code: typeof code === 'number' ? code : 1 })
          res.end()
        })
        res.on('close', () => {                            // 客户端断开（中止/刷新）：终止子进程
          if (!finished) { finished = true; clearTimeout(killTimer); killTree('SIGTERM') }
        })
      } catch (err) {
        try { if (!res.writableEnded) res.end() } catch {}
      }
    }
  })

  // 本地文件写入（MD 编辑模式保存回磁盘）
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/write',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const p = typeof body.path === 'string' ? body.path : ''
        const content = typeof body.content === 'string' ? body.content : ''
        if (!p) { json(res, 400, { error: 'missing path' }); return }
        if (content.length > 20 * 1024 * 1024) { json(res, 413, { error: 'content too large' }); return }
        const abs = pathResolve(p)
        await import('node:fs/promises').then((m) => m.writeFile(abs, content, 'utf8'))
        json(res, 200, { ok: true })
      } catch (err) {
        json(res, 500, { error: String(err) })
      }
    },
  })

  // 新建分组：创建目录（仅当父目录已存在，避免递归误建深层垃圾目录）
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/mkdir',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const p = typeof body.path === 'string' ? body.path.trim() : ''
        if (!p) { json(res, 400, { error: 'missing path' }); return }
        const abs = pathResolve(p)
        const fsx = await import('node:fs/promises')
        const parent = dirname(abs)
        try { await fsx.access(parent) } catch { json(res, 400, { error: 'parent not found' }); return }
        await fsx.mkdir(abs)
        json(res, 200, { ok: true, path: abs })
      } catch (err: any) {
        json(res, err?.code === 'EEXIST' ? 200 : 500, err?.code === 'EEXIST' ? { ok: true, exists: true } : { error: String(err) })
      }
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/worktable/git',
    handler: async (req: any, res: any) => {
      const body = await readJsonBody(req)
      const cwd = serverCwd(ctx, body.sessionId, body.cwd)
      json(res, 200, await gitStatus(cwd))
    },
  })

  // 代码仓联通性检测 + 远程分支/Tag 列举：服务端 git ls-remote --heads --tags <url>。
  // HTTP(S) 仓库凭据注入 URL（user:token@host）；SSH 走服务端 ssh 配置。
  // 阻断 ext/file 传输，避免恶意 URL 触发任意命令执行 / 本地路径探测。
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/git-remote',
    handler: async (req: any, res: any) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const body = await readJsonBody(req)
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      const user = typeof body.user === 'string' ? body.user : ''
      const pass = typeof body.pass === 'string' ? body.pass : ''
      if (!url) { json(res, 400, { ok: false, error: 'missing url' }); return }
      let fetchUrl = url
      if ((user || pass) && /^https?:\/\//i.test(url)) {
        try {
          const u = new URL(url)
          if (user) u.username = user
          if (pass) u.password = pass
          fetchUrl = u.toString()
        } catch { /* 非 http(s) 或非法 URL：交给 git 自身处理协议/凭据 */ }
      }
      const args = ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', 'ls-remote', '--heads', '--tags', fetchUrl]
      const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile('git', args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
          resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })
        })
      })
      if (r.code === 0) {
        const branches: string[] = []
        const tags: string[] = []
        for (const line of r.stdout.split('\n')) {
          const s = line.trim()
          let m = /^[0-9a-f]+\trefs\/heads\/(.+)$/.exec(s)
          if (m) { if (!branches.includes(m[1])) branches.push(m[1]); continue }
          m = /^[0-9a-f]+\trefs\/tags\/([^^]+)$/.exec(s)   // 忽略 annotated tag 的 peeled ref（…^{}）
          if (m) { if (!tags.includes(m[1])) tags.push(m[1]) }
        }
        json(res, 200, { ok: true, branches, tags })
      } else {
        json(res, 200, { ok: false, error: (r.stderr || r.stdout || 'git ls-remote failed').trim().slice(0, 2000) })
      }
    },
  })

  setupTerminal(webServer, ctx)

  // 服务端代联：为工作台项目页（如「流水线」的 Jenkins 集成）提供经本插件服务器的 HTTP 转发。
  // 背景：用户浏览器多经 SSH 隧道反代访问本机，且跨域直连 Jenkins 会被 CORS 拦截；
  // 改为由本机插件服务端代联请求，浏览器只与本插件同源交互，彻底绕开 CORS 与隧道可达性问题。
  // 安全约束：仅允许回环 / 内网（RFC1918 / 链路本地）目标，拒绝公网地址。
  webServer.register({
    kind: 'exact',
    path: PROXY_PATH,
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const urlStr = typeof body.url === 'string' ? body.url.trim() : ''
        const method = (typeof body.method === 'string' ? body.method : 'GET').toUpperCase()
        if (!urlStr) { json(res, 400, { error: 'missing url' }); return }
        let target: URL
        try { target = new URL(urlStr) } catch { json(res, 400, { error: 'bad url' }); return }
        if (!/^https?:$/.test(target.protocol)) { json(res, 400, { error: 'unsupported protocol' }); return }
        if (!isLocalTarget(target.hostname)) { json(res, 403, { error: 'only loopback/private targets allowed' }); return }
        const headers: Record<string, string> = {}
        if (body.headers && typeof body.headers === 'object') {
          for (const [k, v] of Object.entries(body.headers)) {
            if (typeof v === 'string') headers[k] = v
          }
        }
        const reqBody = (method === 'GET' || method === 'HEAD') ? undefined : (typeof body.body === 'string' ? body.body : undefined)
        // 默认用 node:http/https + 显式独立 Agent 直连，忽略系统代理
        // （Node 24 起 NODE_USE_ENV_PROXY=1 时 node:http 同样会走系统代理，
        // 本机 127.0.0.1:8118 不通部分内网目标会挂起直到超时）。
        // 调用方传 useProxy:true 时不注入 Agent，按进程环境走系统代理
        // （需 NODE_USE_ENV_PROXY=1 才生效，否则 node:http 恒为直连）。
        const useProxy = body.useProxy === true
        const fwdHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(headers)) {
          const lk = k.toLowerCase()
          if (lk === 'host' || lk === 'content-length' || lk === 'connection') continue
          fwdHeaders[k] = v
        }
        const reqLib: any = await import(target.protocol === 'https:' ? 'node:https' : 'node:http')
        const result = await new Promise<{ status: number, headers: any, body: Buffer }>((resolve, reject) => {
          const r = reqLib.request(urlStr, useProxy ? { method, headers: fwdHeaders } : { method, headers: fwdHeaders, agent: new reqLib.Agent() }, (resp: any) => {
            const chunks: Buffer[] = []
            resp.on('data', (c: Buffer) => chunks.push(c))
            resp.on('end', () => resolve({ status: resp.statusCode ?? 0, headers: resp.headers, body: Buffer.concat(chunks) }))
            resp.on('error', reject)
          })
          r.on('error', reject)
          r.setTimeout(20000, () => { try { r.destroy(new Error('timeout')) } catch {} })
          if (reqBody) r.write(reqBody)
          r.end()
        })
        if (result.body.length > 20 * 1024 * 1024) { json(res, 502, { error: 'response too large' }); return }
        const outHeaders: Record<string, string> = {}
        for (const k of Object.keys(result.headers)) outHeaders[k] = String(result.headers[k])
        json(res, 200, {
          status: result.status,
          statusText: '',
          headers: outHeaders,
          contentType: String(result.headers['content-type'] ?? ''),
          finalUrl: urlStr,
          body: result.body.toString('utf8'),
        })
      } catch (err: any) {
        json(res, 500, { error: String(err) })
      }
    },
  })
}
