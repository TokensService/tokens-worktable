import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

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
    fetch: over.fetch || (async () => ({
      status: 200,
      headers: new Map([['content-type', 'text/event-stream']]),
      body: { getReader: () => readerOver(over.chunks ?? ['data: {"a":1}\n\n', 'data: [DONE]\n\n'], over.firstDelayMs) },
    })),
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
