import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, mkdir as fsMkdir, open as fsOpen, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve as pathResolve } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

// 用真实 HTTP 请求和子进程执行注册的路由；隔离宿主插件启动及定时任务。
const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const start = source.indexOf('  // 流水线阶段脚本执行')
const end = source.indexOf('  // 本地文件写入', start)
const code = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
async function fixture(t, options = {}) {
  const dir = await mkdtemp(tmpdir() + '/exec-log-')
  const routes = new Map()
  let maxWritableLength = 0
  let drainListenerCount = 0
  let drainEventCount = 0
  let activeDrainListeners = 0
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
  vm.runInNewContext(code, { execFile, spawn: options.spawn || spawn, fsMkdir, fsOpen: options.fsOpen || fsOpen, dirname, pathResolve, process, Buffer, setTimeout, clearTimeout,
    webServer: { register: r => routes.set(r.path, r.handler) }, json, dropOversizeEnv: () => '',
    readJsonBody: async req => { let s = ''; for await (const c of req) s += c; return JSON.parse(s) } })
  const server = createServer((req, res) => {
    const write = res.write.bind(res)
    const once = res.once.bind(res)
    const off = res.off.bind(res)
    const drainWrappers = new Map()
    res.write = (...args) => {
      const writable = write(...args)
      maxWritableLength = Math.max(maxWritableLength, res.writableLength)
      return writable
    }
    res.once = (event, listener) => {
      if (event !== 'drain') return once(event, listener)
      drainListenerCount += 1; activeDrainListeners += 1
      const wrapped = (...args) => {
        if (drainWrappers.delete(listener)) activeDrainListeners -= 1
        return listener(...args)
      }
      drainWrappers.set(listener, wrapped)
      return once(event, wrapped)
    }
    res.off = (event, listener) => {
      if (event === 'drain' && drainWrappers.has(listener)) {
        const wrapped = drainWrappers.get(listener)
        drainWrappers.delete(listener); activeDrainListeners -= 1
        return off(event, wrapped)
      }
      return off(event, listener)
    }
    res.on('drain', () => { drainEventCount += 1 })
    return routes.get(req.url)(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }) })
  return {
    dir,
    maxWritableLength: () => maxWritableLength,
    drainListenerCount: () => drainListenerCount,
    drainEventCount: () => drainEventCount,
    activeDrainListeners: () => activeDrainListeners,
    async run(script, extra = {}, route = 'exec-stream') {
      const path = dir + '/script.sh'; await writeFile(path, script)
      return fetch('http://127.0.0.1:' + server.address().port + '/api/worktable/' + route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, args: [], cwd: dir, logFile: dir + '/nested/stage.log', ...extra }) })
    },
    async runRaw(script, extra = {}, route = 'exec-stream') {
      const path = dir + '/script.sh'; await writeFile(path, script)
      const body = JSON.stringify({ path, args: [], cwd: dir, logFile: dir + '/nested/stage.log', ...extra })
      return new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: '/api/worktable/' + route, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, resolve)
        req.on('error', reject); req.end(body)
      })
    },
  }
}
async function until(fn) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)) }
  assert.fail('等待日志落盘超时')
}
test('流式阶段实时写文件，完成标记发出前日志已关闭', async t => {
  const f = await fixture(t)
  const res = await f.run('echo hello\necho error >&2\nsleep 0.3\necho done\n')
  const reader = res.body.getReader()
  await reader.read()
  await until(async () => (await readFile(f.dir + '/nested/stage.log', 'utf8').catch(() => '')).includes('hello'))
  let rest = ''; for (;;) { const c = await reader.read(); if (c.done) break; rest += Buffer.from(c.value).toString() }
  const events = rest.trim().split('\n').map(x => JSON.parse(x))
  assert.equal(events.at(-1).type, 'done')
  assert.equal(events.at(-1).logFile, f.dir + '/nested/stage.log')
  const log = await readFile(f.dir + '/nested/stage.log', 'utf8')
  assert.match(log, /hello/); assert.match(log, /error/); assert.match(log, /done/); assert.match(log, /\[exit 0\]/)
})
test('一次性执行由服务端归档，保留非零退出码', async t => {
  const f = await fixture(t), res = await f.run('echo failed\nexit 7\n', {}, 'exec'), out = await res.json()
  assert.equal(out.code, 7); assert.equal(out.logFile, f.dir + '/nested/stage.log')
  assert.match(await readFile(out.logFile, 'utf8'), /failed\n\[exit 7\]/)
})
test('一次性执行也实时写入，并保持两路输出到达顺序', async t => {
  const f = await fixture(t)
  const response = f.run('echo first\nsleep 0.1\necho second >&2\nsleep 0.5\necho third\n', {}, 'exec')
  await until(async () => (await readFile(f.dir + '/nested/stage.log', 'utf8').catch(() => '')).includes('second'))
  assert.doesNotMatch(await readFile(f.dir + '/nested/stage.log', 'utf8'), /third\n/)
  const out = await (await response).json()
  assert.equal(out.stdout, 'first\nthird\n'); assert.equal(out.stderr, 'second\n')
  assert.match(await readFile(out.logFile, 'utf8'), /first\nsecond\nthird\n\[exit 0\]/)
})
test('日志目录不可写不重跑脚本，报告归档失败', async t => {
  const f = await fixture(t)
  await writeFile(f.dir + '/blocked', 'file')
  const res = await f.run('echo once\n', { logFile: f.dir + '/blocked/stage.log' })
  const events = (await res.text()).trim().split('\n').map(x => JSON.parse(x))
  assert.equal(events.at(-1).code, 0)
  assert.ok(events.at(-1).logError)
  assert.equal(events.filter(e => e.type === 'out').map(e => e.text).join(''), 'once\n')
})
test('客户端中止后保留已经产生的日志和中止标记', async t => {
  const f = await fixture(t)
  const res = await f.run('echo before-abort\nsleep 10\n', { }, 'exec-stream')
  const reader = res.body.getReader(); await reader.read()
  await until(async () => (await readFile(f.dir + '/nested/stage.log', 'utf8').catch(() => '')).includes('before-abort'))
  await reader.cancel()
  await until(async () => (await readFile(f.dir + '/nested/stage.log', 'utf8')).includes('[aborted]'))
})
test('超时保留输出及终止原因', async t => {
  const f = await fixture(t), res = await f.run('echo before-timeout\nsleep 10\n', { timeoutMs: 1000 })
  const events = (await res.text()).trim().split('\n').map(x => JSON.parse(x))
  const log = await readFile(f.dir + '/nested/stage.log', 'utf8')
  assert.match(log, /before-timeout/); assert.match(log, /timed out/)
  assert.notEqual(events.at(-1).code, 0)
})
test('无归档参数的旧调用保持原有返回协议', async t => {
  const f = await fixture(t), res = await f.run('echo old\n', { logFile: null })
  const events = (await res.text()).trim().split('\n').map(x => JSON.parse(x))
  assert.equal(events.at(-1).code, 0); assert.equal(events.at(-1).logFile, undefined)
  assert.equal(events.filter(e => e.type === 'out').map(e => e.text).join(''), 'old\n')
})
test('输出中文跨数据块不损坏', async t => {
  const f = await fixture(t), res = await f.run("printf '\\344'; sleep 0.03; printf '\\270\\255\\n'\n")
  const events = (await res.text()).trim().split('\n').map(x => JSON.parse(x))
  assert.equal(events.filter(e => e.type === 'out').map(e => e.text).join(''), '中\n')
  assert.match(await readFile(f.dir + '/nested/stage.log', 'utf8'), /中\n\[exit 0\]/)
})
test('客户端不消费响应时，服务端仍写完日志', async t => {
  const f = await fixture(t), res = await f.run('printf "%0100000d\\n" 0\necho finished\n')
  await until(async () => (await readFile(f.dir + '/nested/stage.log', 'utf8').catch(() => '')).includes('[exit 0]'))
  const log = await readFile(f.dir + '/nested/stage.log', 'utf8')
  assert.match(log, /finished/); assert.ok(log.length > 100000)
  await res.text()
})
test('慢客户端下流式响应积压保持有界，恢复读取后脚本完成', async t => {
  const f = await fixture(t)
  const res = await f.run('yes 0123456789abcdef0123456789abcdef | head -c 8388608\necho finished\n')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(f.maxWritableLength() < 2 * 1024 * 1024, 'HTTP 待发送缓冲不应随脚本输出无限增长')
  const events = (await res.text()).trim().split('\n').map(x => JSON.parse(x))
  assert.equal(events.at(-1).type, 'done')
  assert.equal(events.at(-1).code, 0)
  const stdout = events.filter(event => event.type === 'out').map(event => event.text).join('')
  const expectedBytes = 8388608 + Buffer.byteLength('finished\n')
  assert.equal(Buffer.byteLength(stdout), expectedBytes, '恢复读取后 NDJSON 输出不得丢块')
  assert.match(stdout, /finished\n$/)
  const log = await readFile(f.dir + '/nested/stage.log', 'utf8')
  const archivedOutput = log.slice(log.indexOf('\n') + 1, -Buffer.byteLength('[exit 0]\n'))
  assert.equal(Buffer.byteLength(archivedOutput), expectedBytes, '服务端归档不得因暂停 / 恢复丢失输出')
  assert.match(log, /finished\n\[exit 0\]/)
  assert.ok(f.drainListenerCount() > 0, '大量输出必须实际进入背压暂停路径')
  assert.ok(f.drainEventCount() > 0, '恢复消费后必须触发 drain 恢复子进程输出')
})
test('进入 HTTP 背压后客户端断开仍排空管道并关闭归档日志', async t => {
  const f = await fixture(t)
  const res = await f.runRaw('yes 0123456789abcdef0123456789abcdef | head -c 16777216\nsleep 10\n')
  res.pause()
  await until(async () => f.activeDrainListeners() > 0)
  res.destroy()
  await until(async () => (await readFile(f.dir + '/nested/stage.log', 'utf8').catch(() => '')).includes('[aborted]'))
  assert.match(await readFile(f.dir + '/nested/stage.log', 'utf8'), /\[aborted\]\n$/)
})
test('进入磁盘背压后客户端断开，磁盘恢复仍关闭归档日志', async t => {
  let releaseWrites
  let clientDisconnected = false
  let resumesAfterDisconnect = 0
  const writesBlocked = new Promise(resolve => { releaseWrites = resolve })
  const slowOpen = async (...args) => {
    const handle = await fsOpen(...args)
    return {
      writeFile: async (...writeArgs) => { await writesBlocked; return handle.writeFile(...writeArgs) },
      close: (...closeArgs) => handle.close(...closeArgs),
    }
  }
  const trackedSpawn = (...args) => {
    const child = spawn(...args)
    for (const stream of [child.stdout, child.stderr]) {
      const resume = stream.resume.bind(stream)
      stream.resume = (...resumeArgs) => {
        if (clientDisconnected) resumesAfterDisconnect += 1
        return resume(...resumeArgs)
      }
    }
    return child
  }
  const f = await fixture(t, { fsOpen: slowOpen, spawn: trackedSpawn })
  const res = await f.runRaw('yes 0123456789abcdef0123456789abcdef | head -c 4194304\nprintf finished > producer-finished\nsleep 10\n')
  res.resume()
  await new Promise(resolve => setTimeout(resolve, 600))
  const producerFinishedEarly = await readFile(f.dir + '/producer-finished', 'utf8').then(() => true, () => false)
  clientDisconnected = true
  res.destroy()
  releaseWrites()
  assert.equal(producerFinishedEarly, false, '断开前应确认子进程正因磁盘积压暂停')
  await until(async () => (await readFile(f.dir + '/nested/stage.log', 'utf8').catch(() => '')).includes('[aborted]'))
  assert.ok(resumesAfterDisconnect > 0, '磁盘降到低水位后应恢复已终止子进程的管道以可靠排空')
  assert.match(await readFile(f.dir + '/nested/stage.log', 'utf8'), /\[aborted\]\n$/)
})
test('归档磁盘阻塞时暂停子进程，磁盘恢复后继续且不丢日志', async t => {
  let releaseWrites
  const writesBlocked = new Promise(resolve => { releaseWrites = resolve })
  const slowOpen = async (...args) => {
    const handle = await fsOpen(...args)
    return {
      writeFile: async (...writeArgs) => { await writesBlocked; return handle.writeFile(...writeArgs) },
      close: (...closeArgs) => handle.close(...closeArgs),
    }
  }
  const f = await fixture(t, { fsOpen: slowOpen })
  const res = await f.run('yes 0123456789abcdef0123456789abcdef | head -c 4194304\nprintf finished > producer-finished\n')
  const responseBody = res.text()
  await new Promise(resolve => setTimeout(resolve, 600))
  const producerFinishedEarly = await readFile(f.dir + '/producer-finished', 'utf8').then(() => true, () => false)
  releaseWrites()
  const events = (await responseBody).trim().split('\n').map(x => JSON.parse(x))
  assert.equal(producerFinishedEarly, false, '磁盘写入积压时子进程不应继续无限产生日志')
  assert.equal(events.at(-1).type, 'done')
  assert.equal(events.at(-1).code, 0)
  const stdout = events.filter(event => event.type === 'out').map(event => event.text).join('')
  assert.equal(Buffer.byteLength(stdout), 4194304)
  const log = await readFile(f.dir + '/nested/stage.log', 'utf8')
  assert.match(log, /\[exit 0\]\n$/)
  assert.equal(log.slice(log.indexOf('\n') + 1, -Buffer.byteLength('[exit 0]\n')), stdout + (stdout.endsWith('\n') ? '' : '\n'))
})
test('spawn 同步抛错也关闭日志文件', async t => {
  const f = await fixture(t), res = await f.run('echo unused\n', { args: ['\0'] })
  await res.text()
  assert.match(await readFile(f.dir + '/nested/stage.log', 'utf8'), /\[error\]/)
})
