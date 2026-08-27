import { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { readdirSync, realpathSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve as pathResolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
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
      json(res, 200, { plugin: 'dsh-worktable', version: PLUGIN_VERSION, ok: true })
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
          const text = JSON.stringify({ layouts, folders })
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
        // 用 node:http/https 直接请求，彻底忽略系统代理（NO_PROXY 在 undici 下偶发失效），
        // 保证「本地访问不走代理」——避免间歇性 fetch failed。
        const fwdHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(headers)) {
          const lk = k.toLowerCase()
          if (lk === 'host' || lk === 'content-length' || lk === 'connection') continue
          fwdHeaders[k] = v
        }
        const reqLib: any = await import(target.protocol === 'https:' ? 'node:https' : 'node:http')
        const result = await new Promise<{ status: number, headers: any, body: Buffer }>((resolve, reject) => {
          const r = reqLib.request(urlStr, { method, headers: fwdHeaders }, (resp: any) => {
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
