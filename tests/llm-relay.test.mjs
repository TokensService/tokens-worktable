import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} not found`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error(`${name} body incomplete`)
}

/* 服务端提示词构造器（含 BENCH_WORDS / benchGenText / buildBenchPrompt） */
function loadPromptBuilder() {
  const words = source.match(/const BENCH_WORDS = \([\s\S]*?\)\.split\(' '\)/)
  assert.ok(words, 'BENCH_WORDS not found')
  const ctx = { Math, Number, JSON, String }
  vm.createContext(ctx)
  vm.runInContext(stripTypeScriptTypes(words[0].replace('const BENCH_WORDS', 'BENCH_WORDS'), { mode: 'transform' }), ctx)
  for (const name of ['benchGenText', 'buildBenchPrompt']) {
    vm.runInContext(stripTypeScriptTypes(sliceFunction(name), { mode: 'transform' }), ctx)
  }
  return ctx
}

/* 从 src/index.ts 切出 /api/worktable/llm 的 handler，注入 mock 依赖执行 */
function loadHandler(deps) {
  const anchor = source.indexOf("path: '/api/worktable/llm'")
  assert.ok(anchor >= 0, 'llm relay route not found')
  const hStart = source.indexOf('handler:', anchor)
  const hEnd = source.indexOf('\n    },\n  })', hStart)
  assert.ok(hStart > anchor && hEnd > hStart, 'llm relay handler not found')
  const fnSrc = stripTypeScriptTypes(source.slice(hStart + 'handler:'.length, hEnd + '\n    }'.length), { mode: 'transform' })
  const ctx = {
    URL, Date, JSON, Promise, String, Error, Object, Number, Boolean, Array, Math, RegExp,
    parseInt, parseFloat, isFinite, Buffer, setTimeout, console,
    buildBenchPrompt: loadPromptBuilder().buildBenchPrompt,
    ...deps,
  }
  vm.createContext(ctx)
  vm.runInContext(`handler = ${fnSrc}`, ctx)
  return ctx.handler
}

function mockRes() {
  return {
    status: null, headers: null, chunks: [], ended: false, jsonCode: null, jsonObj: null,
    writeHead(s, h) { this.status = s; this.headers = h || {} },
    write(c) { this.chunks.push(Buffer.from(c)); return true },
    once() {}, end() { this.ended = true },
  }
}
function readerOver(chunks, firstDelayMs = 0) {
  let i = 0
  return {
    read() {
      if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined })
      const v = chunks[i++]
      const r = { done: false, value: typeof v === 'string' ? new TextEncoder().encode(v) : v }
      return i === 1 && firstDelayMs ? new Promise((res) => setTimeout(() => res(r), firstDelayMs)) : Promise.resolve(r)
    },
  }
}
function deps(over = {}) {
  const res = over.res || mockRes()
  return {
    readJsonBody: async () => over.body ?? { baseURL: 'https://api.example.com/v1', endpoint: 'chat/completions', apiKey: 'k', payload: { model: 'm' } },
    json: (r, code, obj) => { r.jsonCode = code; r.jsonObj = obj },
    isLocalTarget: () => !!over.local,
    fetch: over.fetch || (async (url, init) => {
      if (over.capture) over.capture.url = url, over.capture.init = init
      return {
        status: 200,
        headers: new Map([['content-type', 'text/event-stream']]),
        body: { getReader: () => readerOver(over.chunks ?? ['data: {"a":1}\n\n', 'data: [DONE]\n\n'], over.firstDelayMs) },
      }
    }),
    req: { method: 'POST' },
    res,
  }
}

test('中继回传 x-worktable-llm-ttfb（等上游首 chunk 才写响应头）且字节序保持', async () => {
  const res = mockRes()
  const d = deps({ res, firstDelayMs: 60 })
  await loadHandler(d)(d.req, res)
  assert.equal(res.status, 200)
  const ttfb = Number(res.headers['x-worktable-llm-ttfb'])
  assert.ok(Number.isFinite(ttfb) && ttfb >= 50, `ttfb=${ttfb} 应 ≥ 首 chunk 延迟 60ms 量级`)
  assert.equal(res.headers['x-worktable-llm-relay'], '1')
  assert.equal(Buffer.concat(res.chunks).toString(), 'data: {"a":1}\n\ndata: [DONE]\n\n')
  assert.equal(res.ended, true)
})

test('上游无 body 时仍回传 ttfb 并正常结束', async () => {
  const res = mockRes()
  const d = deps({ res, fetch: async () => ({ status: 200, headers: new Map(), body: null }) })
  await loadHandler(d)(d.req, res)
  assert.equal(res.status, 200)
  assert.ok(Number.isFinite(Number(res.headers['x-worktable-llm-ttfb'])))
  assert.equal(res.ended, true)
})

test('安全边界：非 https 目标 400、内网目标 403、非法端点 400、非 POST 405', async () => {
  let res = mockRes()
  let d = deps({ res, body: { baseURL: 'http://api.example.com/v1', endpoint: 'chat/completions' } })
  await loadHandler(d)(d.req, res)
  assert.equal(res.jsonCode, 400)

  res = mockRes()
  d = deps({ res, local: true })
  await loadHandler(d)(d.req, res)
  assert.equal(res.jsonCode, 403)

  res = mockRes()
  d = deps({ res, body: { baseURL: 'https://api.example.com/v1', endpoint: 'admin/keys' } })
  await loadHandler(d)(d.req, res)
  assert.equal(res.jsonCode, 400)

  res = mockRes()
  d = deps({ res })
  await loadHandler(d)({ method: 'GET' }, res)
  assert.equal(res.status, 405)
})

test('buildBenchPrompt：固定前缀跨调用逐字节一致、后缀随机、长度达标', () => {
  const { buildBenchPrompt, estTokens } = loadPromptBuilder()
  const est = (s) => Math.ceil(s.length / 3.2)
  const a = buildBenchPrompt({ inputLen: 2000, cacheHit: 80, outputLen: 200 })
  const b = buildBenchPrompt({ inputLen: 2000, cacheHit: 80, outputLen: 200 })
  assert.ok(est(a) >= 2000, '应达到目标估算长度')
  assert.equal(a.slice(0, 1200), b.slice(0, 1200), '80% 前缀部分跨轮一致（触发厂商缓存）')
  assert.notEqual(a.slice(-300), b.slice(-300), '随机后缀每轮换新')
  assert.ok(a.includes('请用约 200 个 token'), '应带输出长度指令')
})

test('buildBenchPrompt：cacheHit=0 无共享前缀；非法 spec 返回 null', () => {
  const { buildBenchPrompt } = loadPromptBuilder()
  const a = buildBenchPrompt({ inputLen: 1000, cacheHit: 0, outputLen: 100 })
  const b = buildBenchPrompt({ inputLen: 1000, cacheHit: 0, outputLen: 100 })
  assert.notEqual(a.slice(0, 500), b.slice(0, 500), 'cacheHit=0 整段随机')
  assert.equal(buildBenchPrompt({ inputLen: 0, cacheHit: 50 }), null)
  assert.equal(buildBenchPrompt({ inputLen: 200001, cacheHit: 50 }), null)
  assert.equal(buildBenchPrompt({ inputLen: 100, cacheHit: 101 }), null)
  assert.equal(buildBenchPrompt('x'), null)
})

test('promptSpec：handler 用服务端构造的 messages 覆盖 payload，且前缀跨轮一致', async () => {
  const cap1 = {}
  const res1 = mockRes()
  const spec = { inputLen: 110000, cacheHit: 80, outputLen: 200 }
  const d1 = deps({ res: res1, capture: cap1, body: { baseURL: 'https://api.example.com/v1', endpoint: 'chat/completions', apiKey: 'k', payload: { model: 'm' }, promptSpec: spec } })
  await loadHandler(d1)(d1.req, res1)
  assert.equal(res1.status, 200)
  const sent1 = JSON.parse(cap1.init.body)
  assert.equal(sent1.model, 'm', 'payload 其他字段原样透传')
  assert.equal(sent1.messages.length, 1)
  assert.equal(sent1.messages[0].role, 'user')
  assert.ok(sent1.messages[0].content.length > 300000, '110k tokens 约 35 万字符')

  const cap2 = {}
  const res2 = mockRes()
  const d2 = deps({ res: res2, capture: cap2, body: { baseURL: 'https://api.example.com/v1', endpoint: 'chat/completions', apiKey: 'k', payload: { model: 'm' }, promptSpec: spec } })
  await loadHandler(d2)(d2.req, res2)
  const sent2 = JSON.parse(cap2.init.body)
  const c1 = sent1.messages[0].content, c2 = sent2.messages[0].content
  assert.equal(c1.slice(0, 200000), c2.slice(0, 200000), '固定前缀跨轮一致')
  assert.notEqual(c1.slice(-400), c2.slice(-400), '随机后缀跨轮换新')
})

test('promptSpec 非法时 400，不带 promptSpec 时 payload.messages 原样透传', async () => {
  let res = mockRes()
  let d = deps({ res, body: { baseURL: 'https://api.example.com/v1', endpoint: 'chat/completions', apiKey: 'k', payload: {}, promptSpec: { inputLen: -5 } } })
  await loadHandler(d)(d.req, res)
  assert.equal(res.jsonCode, 400)

  const cap = {}
  res = mockRes()
  d = deps({ res, capture: cap, body: { baseURL: 'https://api.example.com/v1', endpoint: 'chat/completions', apiKey: 'k', payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] } } })
  await loadHandler(d)(d.req, res)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(cap.init.body).messages[0].content, 'hi')
})
