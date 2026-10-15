import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { networkInterfaces } from 'node:os'
import { resolve as pathResolve, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { stat as fsStat, rename as fsRename, unlink as fsUnlink } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFileText()

async function readFileText() {
  const { readFile } = await import('node:fs/promises')
  return readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
}

/* 整段抽取「远程服务器文件浏览 / 拉取」块（rfs + rfetch 两个路由及其依赖函数） */
function loadRemoteBlock(execFileImpl, extra = {}) {
  const start = source.indexOf('  // ---- 远程服务器文件浏览')
  const rf = source.indexOf("path: '/api/worktable/rfetch'", start)
  const end = source.indexOf('\n  })', rf)
  assert.ok(start >= 0 && rf > start && end > rf, 'remote block not found')
  const code = stripTypeScriptTypes(source.slice(start, end + '\n  })'.length), { mode: 'transform' })
  const handlers = {}
  const ctx = {
    Buffer, process, URL,
    DSH_HOME: '/tmp/.test-dsh-home',
    pathResolve, basename, createHash,
    fsStat, fsRename, fsUnlink,
    fsMkdir: extra.fsMkdir || (async () => {}),
    listDirectory: extra.listDirectory || (async () => { throw new Error('不应走到本地 listDirectory') }),
    localAddrs: () => new Set(['127.0.0.1', 'localhost', '::1']),
    parseHostPort: (ip) => { const m = /^([^:]+):(\d+)$/.exec(ip.trim()); return m ? { host: m[1], port: m[2] } : { host: ip.trim(), port: '' } },
    execFile: execFileImpl,
    readJsonBody: async (req) => req.body || {},
    webServer: { register(route) { handlers[route.path] = route.handler } },
    json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(Buffer.from(JSON.stringify(body))) },
  }
  vm.createContext(ctx); vm.runInContext(code, ctx)
  return handlers
}
function fakeRes() {
  const r = { status: 0, body: null, writeHead(s) { r.status = s }, end(d) { r.body = d ? JSON.parse(d.toString()) : null }, destroyed: false }
  return r
}

test('rfs：本机地址直接走本地 listDirectory 透传', async t => {
  const marker = { path: '/x', entries: [{ name: 'a', path: '/x/a', isDir: false, hidden: false }], truncated: false }
  const handlers = loadRemoteBlock(() => { throw new Error('不应执行 execFile') }, { listDirectory: async (p) => (p === '/x' ? marker : null) })
  const res = fakeRes()
  await handlers['/api/worktable/rfs']({ method: 'POST', body: { ip: '127.0.0.1', path: '/x' } }, res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, marker)
})

test('rfs：远程经 sshpass+ssh 列目录，find 输出解析为同形条目（目录在前）', async () => {
  const calls = []
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args })
    cb(null, 'sub\td\na.pt.trace.json\tf\n.hid\tf\n', '')
  }
  const handlers = loadRemoteBlock(execFile)
  const res = fakeRes()
  await handlers['/api/worktable/rfs']({ method: 'POST', body: { ip: '192.0.2.9:2222', user: 'lihaifeng', pass: 'pw', path: '/data/traces' } }, res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, {
    path: '/data/traces',
    entries: [
      { name: 'sub', path: '/data/traces/sub', isDir: true, hidden: false },
      { name: '.hid', path: '/data/traces/.hid', isDir: false, hidden: true },
      { name: 'a.pt.trace.json', path: '/data/traces/a.pt.trace.json', isDir: false, hidden: false },
    ],
    truncated: false,
  })
  /* ssh 命令装配：sshpass -p pw ssh … -p 2222 lihaifeng@192.0.2.9 echo <b64>|base64 -d|bash */
  assert.equal(calls.length, 1)
  const { cmd, args } = calls[0]
  assert.equal(cmd, 'sshpass')
  assert.deepEqual([...args].slice(0, 3), ['-p', 'pw', 'ssh'])   /* vm 上下文的数组是跨 realm 对象，展开回主 realm */
  const pi = args.indexOf('-p', 3)
  assert.equal(args[pi + 1], '2222', '端口经 ssh -p 传入')
  assert.ok(args.includes('lihaifeng@192.0.2.9'))
  const script = Buffer.from(args[args.length - 1].split(' ')[1], 'base64').toString()   /* 末参 remoteCmd 中 echo 后的 b64 词 */
  assert.ok(script.includes('base64') && script.includes('find'), '远程脚本为 base64 包路径 + find 列表')
  assert.ok(script.includes(Buffer.from('/data/traces').toString('base64')), '路径经 base64 嵌入脚本')
})

test('rfs：远程非目录回 __ENOTDIR__ → 404；缺参 400；GET 405', async () => {
  const handlers = loadRemoteBlock((cmd, args, opts, cb) => cb(null, '__ENOTDIR__\n', ''))
  let res = fakeRes()
  await handlers['/api/worktable/rfs']({ method: 'POST', body: { ip: '192.0.2.9', path: '/etc/passwd' } }, res)
  assert.equal(res.status, 404)
  res = fakeRes()
  await handlers['/api/worktable/rfs']({ method: 'POST', body: { ip: '', path: '/x' } }, res)
  assert.equal(res.status, 400)
  res = fakeRes()
  await handlers['/api/worktable/rfs']({ method: 'GET', body: {} }, res)
  assert.equal(res.status, 405)
})

test('rfetch：本机地址直接返回原路径（不拷贝）；非文件 404', async t => {
  const dir = await mkdtemp(tmpdir() + '/rfetch-local-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const f = dir + '/a.pt.trace.json'
  await writeFile(f, '{"traceEvents":[]}')
  const handlers = loadRemoteBlock(() => { throw new Error('不应执行 execFile') })
  let res = fakeRes()
  await handlers['/api/worktable/rfetch']({ method: 'POST', body: { ip: 'localhost', path: f } }, res)
  assert.equal(res.status, 200)
  assert.equal(res.body.path, f, '本机直接返回原路径')
  assert.equal(res.body.cached, true)
  res = fakeRes()
  await handlers['/api/worktable/rfetch']({ method: 'POST', body: { ip: 'localhost', path: dir } }, res)
  assert.equal(res.status, 404)
  /* 本机短路：不存在的文件 ENOENT 也应归一为 404 + 中文提示（页面 toast 直接展示该文案） */
  res = fakeRes()
  await handlers['/api/worktable/rfetch']({ method: 'POST', body: { ip: 'localhost', path: dir + '/nope.pt.trace.json' } }, res)
  assert.equal(res.status, 404)
  assert.ok(res.body.error.includes('远程文件不存在'), res.body.error)
})

test('rfetch：远程经 stat 探测 + sshpass scp 拉取到缓存，大小一致二次命中缓存', async () => {
  const calls = []
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args })
    if (cmd === 'sshpass' && args.includes('ssh')) { cb(null, '  12345\n', ''); return }          /* stat -c %s */
    if (cmd === 'sshpass' && args.includes('scp')) {                                                 /* scp 拉取：模拟写入目标 */
      const local = args[args.length - 1]
      import('node:fs').then(fs => { fs.mkdirSync(pathResolve(local, '..'), { recursive: true }); fs.writeFile(local, Buffer.alloc(12345), (e) => cb(e, '', '')) })
      return
    }
    cb(new Error('unexpected call'), '', '')
  }
  const handlers = loadRemoteBlock(execFile)
  let res = fakeRes()
  await handlers['/api/worktable/rfetch']({ method: 'POST', body: { ip: '192.0.2.9', user: 'u', pass: 'pw', path: '/data/big.pt.trace.json' } }, res)
  assert.equal(res.status, 200)
  assert.equal(res.body.cached, false)
  assert.equal(res.body.size, 12345)
  assert.ok(res.body.path.includes('remote-cache') && res.body.path.endsWith('big.pt.trace.json'), res.body.path)
  /* scp 端口用 -P（大写）、目标 user@host:'path' 单引号包裹 */
  const scpCall = calls.find(c => c.args.includes('scp'))
  const target = scpCall.args[scpCall.args.length - 2]
  assert.equal(target, "u@192.0.2.9:'/data/big.pt.trace.json'")
  /* 二次调用：stat 相同大小 → 直接命中缓存，不再 scp */
  calls.length = 0
  res = fakeRes()
  await handlers['/api/worktable/rfetch']({ method: 'POST', body: { ip: '192.0.2.9', user: 'u', pass: 'pw', path: '/data/big.pt.trace.json' } }, res)
  assert.equal(res.body.cached, true)
  assert.equal(calls.filter(c => c.args.includes('scp')).length, 0)
  /* 清缓存目录 */
  const { rm } = await import('node:fs/promises')
  await rm('/tmp/.test-dsh-home', { recursive: true, force: true })
})

test('rfetch：远程文件不存在（__NOENT__）→ 404', async () => {
  const handlers = loadRemoteBlock((cmd, args, opts, cb) => cb(null, '__NOENT__\n', ''))
  const res = fakeRes()
  await handlers['/api/worktable/rfetch']({ method: 'POST', body: { ip: '192.0.2.9', path: '/nope' } }, res)
  assert.equal(res.status, 404)
})

test('rfetch：dstDir 指定时直接落该目录（不走 remote-cache 哈希子目录），临时名 scp 后原子改名，二次命中', async t => {
  const dir = await mkdtemp(tmpdir() + '/rfetch-dstdir-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dstDir = dir + '/save'
  const calls = []
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args: [...args] })
    if (cmd === 'sshpass' && args.includes('ssh')) { cb(null, '  777\n', ''); return }
    if (cmd === 'sshpass' && args.includes('scp')) {
      const temp = args[args.length - 1]
      import('node:fs').then(fs => { fs.mkdirSync(pathResolve(temp, '..'), { recursive: true }); fs.writeFile(temp, Buffer.alloc(777), (e) => cb(e, '', '')) })
      return
    }
    cb(new Error('unexpected call'), '', '')
  }
  const handlers = loadRemoteBlock(execFile)
  let res = fakeRes()
  await handlers['/api/worktable/rfetch']({ method: 'POST', body: { ip: '192.0.2.9', user: 'u', pass: 'pw', path: '/data/big.pt.trace.json', dstDir } }, res)
  assert.equal(res.status, 200)
  assert.equal(res.body.path, pathResolve(dstDir, 'big.pt.trace.json'), '落在 dstDir 下、保留原始文件名')
  assert.ok(!res.body.path.includes('remote-cache'), '不经 remote-cache')
  const scpCall = calls.find(c => c.args.includes('scp'))
  assert.ok(scpCall.args[scpCall.args.length - 1].includes('.rfetch-'), 'scp 先落临时名')
  /* 二次调用大小一致 → 命中不拉取 */
  calls.length = 0
  res = fakeRes()
  await handlers['/api/worktable/rfetch']({ method: 'POST', body: { ip: '192.0.2.9', user: 'u', pass: 'pw', path: '/data/big.pt.trace.json', dstDir } }, res)
  assert.equal(res.body.cached, true)
  assert.equal(calls.filter(c => c.args.includes('scp')).length, 0)
  /* 相对路径 dstDir 被丢弃（非绝对路径不生效，回退默认缓存口径） */
  res = fakeRes()
  await handlers['/api/worktable/rfetch']({ method: 'POST', body: { ip: '192.0.2.9', user: 'u', pass: 'pw', path: '/data/big.pt.trace.json', dstDir: 'relative/dir' } }, res)
  assert.equal(res.status, 200)
  assert.ok(res.body.path.includes('remote-cache'), res.body.path)
  const { rm: rm2 } = await import('node:fs/promises')
  await rm2('/tmp/.test-dsh-home', { recursive: true, force: true })
})
