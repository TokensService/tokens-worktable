/**
 * dsh-auth 服务端：OPTEST 登录页 + 全站守卫。
 * 依赖宿主 webserver 的前置守卫钩子（registerGuard）：守卫先于路由匹配与
 * upgrade 协商执行，把命名路由、SPA fallback 与 WebSocket 统一拦在会话
 * Cookie 校验之后，仅放行 /login 与 /api/auth/logout 两条匿名路由。
 * 会话保存在进程内（随机 token -> 过期时刻），重启即全部失效、需重新登录。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback) as (
  password: string, salt: Buffer, keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>

export const name = 'dsh-auth'
export const inject = ['webServer']

const LOGIN_PATH = '/login'
const LOGOUT_PATH = '/api/auth/logout'
const COOKIE_NAME = 'dsh_auth'
const MAX_BODY_BYTES = 4096
const SWEEP_INTERVAL_MS = 60_000

/** apply() 收到的原始配置（来自 profile cordis.patch.yml 用户覆写层）。 */
interface RawConfig {
  passwordHash?: unknown
  sessionTtlHours?: unknown
  secureCookie?: unknown
  maxAttempts?: unknown
  windowMinutes?: unknown
}

/** 解析后的口令哈希：scrypt$N$r$p$saltB64$hashB64 的分解。 */
interface PasswordHash {
  N: number
  r: number
  p: number
  salt: Buffer
  expected: Buffer
}

interface Config {
  password: PasswordHash
  sessionTtlMs: number
  secureCookie: boolean
  maxAttempts: number
  windowMs: number
}

/** 正整数配置项：缺省回退，非法值属配置错误。 */
function positiveInt(value: unknown, fallback: number, key: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('dsh-auth: config.' + key + ' 必须是正整数')
  }
  return value
}

/** 解析并校验口令哈希；畸形或参数越界（防配置态 DoS）即加载失败。 */
function parsePasswordHash(encoded: unknown): PasswordHash {
  if (typeof encoded !== 'string' || !encoded.startsWith('scrypt$')) {
    throw new Error('dsh-auth: 缺少 config.passwordHash（scrypt$N$r$p$salt$hash 格式，在插件目录执行 npm run hash 生成）')
  }
  const parts = encoded.split('$')
  if (parts.length !== 6) throw new Error('dsh-auth: config.passwordHash 格式错误，应为 scrypt$N$r$p$salt$hash')
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = Buffer.from(parts[4], 'base64')
  const expected = Buffer.from(parts[5], 'base64')
  if (!Number.isInteger(N) || N < 1024 || N > 1_048_576 || (N & (N - 1)) !== 0) {
    throw new Error('dsh-auth: passwordHash 的 N 必须是 [1024, 1048576] 内的 2 的幂')
  }
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 32) {
    throw new Error('dsh-auth: passwordHash 的 r/p 必须在 [1, 32] 内')
  }
  if (salt.length < 16 || expected.length < 16 || expected.length > 64) {
    throw new Error('dsh-auth: passwordHash 的 salt/hash 长度异常')
  }
  return { N, r, p, salt, expected }
}

/** 校验并补全配置；任何非法值都在插件加载时报错（misconfiguration fails loud）。 */
function resolveConfig(raw: RawConfig): Config {
  const source = raw ?? {}
  if (source.secureCookie !== undefined && typeof source.secureCookie !== 'boolean') {
    throw new Error('dsh-auth: config.secureCookie 必须是布尔值')
  }
  return {
    password: parsePasswordHash(source.passwordHash),
    sessionTtlMs: positiveInt(source.sessionTtlHours, 12, 'sessionTtlHours') * 3_600_000,
    secureCookie: source.secureCookie === true,
    maxAttempts: positiveInt(source.maxAttempts, 10, 'maxAttempts'),
    windowMs: positiveInt(source.windowMinutes, 10, 'windowMinutes') * 60_000,
  }
}

export function apply(ctx: Context, raw: RawConfig): void {
  const config = resolveConfig(raw)
  const webServer = (ctx as any).webServer
  if (typeof webServer?.registerGuard !== 'function') {
    throw new Error('dsh-auth: 宿主 webServer 缺少 registerGuard —— 请先给 deepseek-harness 应用 patches/webserver-guard.patch 并重建（./apply-branding.sh）')
  }

  /** token -> 过期时刻（ms）；进程内会话，重启失效。 */
  const sessions = new Map<string, number>()
  /** ip -> 窗口内登录失败时刻列表（限流依据）。 */
  const failures = new Map<string, number[]>()

  const readToken = (req: IncomingMessage): string | undefined => {
    const header = req.headers.cookie
    if (header === undefined) return undefined
    for (const part of header.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim()
    }
    return undefined
  }

  const sessionValid = (token: string | undefined): boolean => {
    if (token === undefined || token.length === 0) return false
    const expires = sessions.get(token)
    if (expires === undefined) return false
    if (expires <= Date.now()) {
      sessions.delete(token)
      return false
    }
    return true
  }

  const issueSession = (): string => {
    const token = randomBytes(32).toString('base64url')
    sessions.set(token, Date.now() + config.sessionTtlMs)
    return token
  }

  const cookieFor = (token: string): string => {
    const base = COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + String(Math.floor(config.sessionTtlMs / 1000))
    return config.secureCookie ? base + '; Secure' : base
  }

  const throttled = (ip: string, now: number): boolean => {
    const kept = (failures.get(ip) ?? []).filter((at) => now - at < config.windowMs)
    if (kept.length === 0) failures.delete(ip)
    else failures.set(ip, kept)
    return kept.length >= config.maxAttempts
  }

  const readBody = (req: IncomingMessage): Promise<Buffer> => new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('dsh-auth: login body exceeds ' + String(MAX_BODY_BYTES) + ' bytes'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolveBody(Buffer.concat(chunks)) })
    req.on('error', reject)
  })

  const verifyPassword = async (password: string): Promise<boolean> => {
    const derived = await scrypt(password, config.password.salt, config.password.expected.length, {
      N: config.password.N,
      r: config.password.r,
      p: config.password.p,
    })
    return timingSafeEqual(derived, config.password.expected)
  }

  /** 登录回跳地址：仅接受站内绝对路径，防开放重定向。 */
  const safeNext = (value: string | null): string =>
    value !== null && value.startsWith('/') && !value.startsWith('//') ? value : '/'

  const escapeHtml = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const renderPage = (view: { next: string; error?: string }): string => {
    const error = view.error === undefined
      ? ''
      : '<p class="error">' + escapeHtml(view.error) + '</p>'
    return '<!doctype html>
'
      + '<html lang="zh-CN">
<head>
<meta charset="utf-8">
'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">
'
      + '<meta name="robots" content="noindex,nofollow">
'
      + '<title>OPTEST 登录</title>
<style>
'
      + ':root{color-scheme:dark}*{box-sizing:border-box}'
      + 'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e14;color:#e6e9ef;'
      + 'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif}'
      + '.card{width:min(360px,90vw);padding:40px 32px;background:#151a23;border:1px solid #262d3a;border-radius:16px;'
      + 'box-shadow:0 16px 48px rgba(0,0,0,.45)}'
      + '.badge{display:block;margin:0 auto 12px}'
      + 'h1{margin:0;text-align:center;font-size:22px;letter-spacing:4px}'
      + '.sub{margin:6px 0 28px;text-align:center;font-size:12px;color:#8a93a5}'
      + 'label{display:block;font-size:13px;color:#aab2c2}'
      + 'input[type=password]{width:100%;margin-top:8px;padding:11px 12px;font-size:15px;color:#e6e9ef;'
      + 'background:#0b0e14;border:1px solid #333c4d;border-radius:8px;outline:none}'
      + 'input[type=password]:focus{border-color:#4d7cfe}'
      + 'button{width:100%;margin-top:22px;padding:11px 0;font-size:15px;letter-spacing:6px;color:#fff;'
      + 'background:#3b62d9;border:0;border-radius:8px;cursor:pointer}'
      + 'button:hover{background:#4d7cfe}'
      + '.error{margin:0 0 14px;padding:9px 12px;font-size:13px;color:#ff9c9c;background:rgba(255,92,92,.12);'
      + 'border:1px solid rgba(255,92,92,.35);border-radius:8px}
'
      + '</style>
</head>
<body>
<main class="card">
'
      + '<svg class="badge" width="56" height="56" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
      + '<rect x="2" y="2" width="20" height="20" rx="6" stroke="#e6e9ef" stroke-width="2"/>'
      + '<text x="12" y="16" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="9" '
      + 'font-weight="700" fill="#e6e9ef">OP</text></svg>
'
      + '<h1>OPTEST</h1>
<p class="sub">DeepSeek Harness Web 访问验证</p>
'
      + error + '
'
      + '<form method="post" action="' + LOGIN_PATH + '">
'
      + '<input type="hidden" name="next" value="' + escapeHtml(view.next) + '">
'
      + '<label>访问口令
'
      + '<input type="password" name="password" required autocomplete="current-password" autofocus>
'
      + '</label>
<button type="submit">登录</button>
</form>
</main>
</body>
</html>
'
  }

  const sendPage = (res: ServerResponse, status: number, view: { next: string; error?: string }): void => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    res.end(renderPage(view))
  }

  const onLogin = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method ?? 'GET') !== 'POST') {
      if (sessionValid(readToken(req))) {
        res.writeHead(302, { location: '/', 'cache-control': 'no-store' })
        res.end()
        return
      }
      const next = safeNext(new URL(req.url ?? '/', 'http://x').searchParams.get('next'))
      sendPage(res, 200, { next })
      return
    }
    const ip = req.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    if (throttled(ip, now)) {
      sendPage(res, 429, { next: '/', error: '尝试过于频繁，请稍后再试' })
      return
    }
    let body: Buffer
    try {
      body = await readBody(req)
    } catch {
      sendPage(res, 400, { next: '/', error: '请求无效' })
      return
    }
    const params = new URLSearchParams(body.toString('utf8'))
    const next = safeNext(params.get('next'))
    if (await verifyPassword(params.get('password') ?? '')) {
      failures.delete(ip)
      res.writeHead(302, { location: next, 'set-cookie': cookieFor(issueSession()), 'cache-control': 'no-store' })
      res.end()
      return
    }
    failures.set(ip, [...(failures.get(ip) ?? []), now])
    sendPage(res, 401, { next, error: '口令错误' })
  }

  const onLogout = (req: IncomingMessage, res: ServerResponse): void => {
    const token = readToken(req)
    if (token !== undefined) sessions.delete(token)
    res.writeHead(302, {
      location: LOGIN_PATH,
      'set-cookie': COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'cache-control': 'no-store',
    })
    res.end()
  }

  /** HTTP 前置守卫：匿名请求只放行登录/登出路由，其余按浏览器导航重定向、按 API 答 401。 */
  const guardHttp = (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === LOGIN_PATH || path === LOGOUT_PATH) return false
    if (sessionValid(readToken(req))) return false
    if ((req.method ?? 'GET') === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
      res.writeHead(302, {
        location: LOGIN_PATH + '?next=' + encodeURIComponent(req.url ?? '/'),
        'cache-control': 'no-store',
      })
      res.end()
      return true
    }
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end('{"error":"unauthorized"}')
    return true
  }

  /** upgrade 前置守卫（同步）：无有效会话直接拒绝协商。 */
  const guardUpgrade = (req: IncomingMessage): boolean => !sessionValid(readToken(req))

  /** 周期清扫过期会话与限流窗口外的失败记录，避免长驻进程内存累积。 */
  const sweep = (): void => {
    const now = Date.now()
    for (const [token, expires] of sessions) {
      if (expires <= now) sessions.delete(token)
    }
    for (const [ip, list] of failures) {
      const kept = list.filter((at) => now - at < config.windowMs)
      if (kept.length === 0) failures.delete(ip)
      else failures.set(ip, kept)
    }
  }

  ctx.effect(() => {
    const disposeLogin = webServer.register({ kind: 'exact', path: LOGIN_PATH, handler: onLogin })
    const disposeLogout = webServer.register({ kind: 'exact', path: LOGOUT_PATH, handler: onLogout })
    const disposeGuard = webServer.registerGuard({ http: guardHttp, upgrade: guardUpgrade })
    const timer = setInterval(sweep, SWEEP_INTERVAL_MS)
    timer.unref()
    return () => {
      disposeLogin()
      disposeLogout()
      disposeGuard()
      clearInterval(timer)
    }
  })
}
