/* 关页即失败的服务端配套：POST /api/worktable/pipeline/history/fail-run
   页面本地编排的在跑运行随浏览器关闭中断，pagehide 以 keepalive 把 failed 终态记录直送本路由：
   1. 同 tag「进行中」记录原地终态化（保留启动编号、阶段日志并集合并、status 服务端强制 failed）
   2. 无同 tag 记录按新记录插入兜底；已是终态的记录不覆盖
   3. 失败阶段的归档日志文件追加中断行（限该次运行归档目录内路径）
   4. 同 tag 休眠后缀计划（at<=0）清除，活动计划与他人计划保留
   提取方式同 pipeline-plans-upsert.test.mjs。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join as pathJoin } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

function extractFunction(name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const match = marker.exec(source)
  assert.ok(match, `src/index.ts 缺少函数 ${name}`)
  const start = match.index
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`无法提取函数 ${name}`)
}

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers },
    end(body) { this.body = body == null ? '' : String(body) },
    json() { return this.body ? JSON.parse(this.body) : null },
  }
}

async function loadFailRunRoute(home) {
  const storeFile = pathJoin(home, 'storages', 'worktable-pipeline.json')
  const plansFile = pathJoin(home, 'storages', 'worktable-pipeline-plans.json')
  const marker = "path: '/api/worktable/pipeline/history/fail-run'"
  const at = source.indexOf(marker)
  assert.ok(at > 0, 'fail-run 路由未找到')
  const callStart = source.lastIndexOf('webServer.register', at)
  assert.ok(callStart >= 0, 'fail-run register 调用未找到')
  const braceStart = source.indexOf('{', callStart)
  let depth = 0
  let end = -1
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = source.indexOf(')', i) + 1; break }
    }
  }
  assert.ok(end > braceStart, 'fail-run register 范围未闭合')
  const snippet = source.slice(callStart, end).replace('webServer.register', 'register')
  const helpers = [
    'cleanPipelineHistoryEnvNodes',
    'cleanPipelineHistory',
    'mergeStageLogsForHistory',
    'serializePipelineStore',
    'cleanCloseFailRecord',
  ].map(extractFunction).join('\n')
  const handlers = {}
  const ctx = {
    URL, Promise, Buffer, console, JSON, Array, Object, Number, String, Boolean, Error, Date, Math, Set, Map,
    readJsonBody: async req => req.testBody ?? {},
    writeJsonAtomic: async (file, text) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text, 'utf8') },
    readPipelineStore: async () => {
      try {
        const raw = await readFile(storeFile, 'utf8')
        return JSON.parse(raw)
      } catch { return {} }
    },
    readPlansFile: async () => {
      try {
        const raw = await readFile(plansFile, 'utf8')
        const j = JSON.parse(raw)
        return Array.isArray(j.plans) ? j.plans : []
      } catch { return [] }
    },
    PIPELINE_STORE: storeFile,
    PLANS_STORE: plansFile,
    withStoreLock: async fn => fn(),
    fsAppendFile: (await import('node:fs/promises')).appendFile,
    json(res, status, body) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    },
    register(route) { handlers[route.path] = route.handler },
  }
  vm.createContext(ctx)
  vm.runInContext(stripTypeScriptTypes(helpers + '\n' + snippet, { mode: 'transform' }), ctx)
  assert.ok(handlers['/api/worktable/pipeline/history/fail-run'], 'fail-run handler 未注册')
  return handlers['/api/worktable/pipeline/history/fail-run']
}

async function call(handler, method, body) {
  const res = response()
  const req = { method, testBody: body && typeof body === 'object' ? body : {}, async *[Symbol.asyncIterator]() {} }
  await handler(req, res)
  return res
}

async function readStore(home) {
  const raw = await readFile(pathJoin(home, 'storages', 'worktable-pipeline.json'), 'utf8')
  return JSON.parse(raw)
}
async function readPlans(home) {
  try {
    return JSON.parse(await readFile(pathJoin(home, 'storages', 'worktable-pipeline-plans.json'), 'utf8')).plans
  } catch { return [] }
}

function failRecord(overrides) {
  return Object.assign({
    tag: 't-close-1', pipeline: '关页实测', env: '10.0.0.1', commit: 'abcdef1',
    status: 'failed', dur: '12s', time: '今天 10:00', ts: 1791822000000, startTs: 1791821988000,
    by: 'tester', source: 'local', closeError: '浏览器页面已关闭，本地任务未执行完，本次运行按失败结束',
    logs: [
      { stage: '检出', status: 'success', dur: 5, local: true },
      { stage: '部署', status: 'failed', dur: 12, local: true },
      { stage: '健康检查', status: 'skipped', dur: 0, local: true },
    ],
  }, overrides || {})
}

test('fail-run：同 tag「进行中」记录原地终态化——保留编号、状态 failed、阶段日志并集、中断原因落史', async () => {
  const home = await mkdtemp(pathJoin(tmpdir(), 'wt-failrun-'))
  await mkdir(pathJoin(home, 'storages'), { recursive: true })
  await writeFile(pathJoin(home, 'storages', 'worktable-pipeline.json'), JSON.stringify({
    config: { buildNo: 41 },
    history: [
      { no: 41, tag: 't-close-1', pipeline: '关页实测', status: 'running', dur: '0s', ts: 1791821988000, startTs: 1791821988000, by: 'tester', logs: [] },
      { no: 40, tag: 't-other', pipeline: '别的', status: 'running', dur: '0s', ts: 1791821980000, by: 'someone' },
    ],
  }), 'utf8')
  const handler = await loadFailRunRoute(home)
  const res = await call(handler, 'POST', { records: [failRecord()] })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json().finalized, ['t-close-1'])
  const store = await readStore(home)
  const rec = store.history.find(h => h.tag === 't-close-1')
  assert.equal(rec.no, 41, '保留启动时编号')
  assert.equal(rec.status, 'failed', '原地终态化为失败')
  assert.ok(/浏览器页面已关闭/.test(rec.closeError), '中断原因随记录落史')
  assert.equal(rec.logs.length, 3, '阶段日志落史（成功/失败/跳过）')
  assert.equal(rec.logs.find(l => l.stage === '部署').status, 'failed')
  assert.equal(rec.logs.find(l => l.stage === '健康检查').status, 'skipped')
  const other = store.history.find(h => h.tag === 't-other')
  assert.equal(other.status, 'running', '他人/其他运行不受影响')
  assert.equal(store.config.buildNo, 41, '原地更新不消耗新编号')
})

test('fail-run：无同 tag 记录时插入兜底并占新编号；客户端伪造 status 也被强制 failed', async () => {
  const home = await mkdtemp(pathJoin(tmpdir(), 'wt-failrun-'))
  await mkdir(pathJoin(home, 'storages'), { recursive: true })
  await writeFile(pathJoin(home, 'storages', 'worktable-pipeline.json'), JSON.stringify({
    config: { buildNo: 7 }, history: [{ no: 7, tag: 't-x', pipeline: '旧', status: 'success', ts: 1 }],
  }), 'utf8')
  const handler = await loadFailRunRoute(home)
  const rec = failRecord({ tag: 't-new', status: 'success' })   // 伪造 success：服务端必须强制 failed
  const res = await call(handler, 'POST', { records: [rec] })
  assert.equal(res.status, 200)
  const store = await readStore(home)
  const inserted = store.history.find(h => h.tag === 't-new')
  assert.ok(inserted, '无同 tag 记录时插入兜底')
  assert.equal(inserted.status, 'failed', '该通道只落失败终态')
  assert.equal(inserted.no, 8, '新记录占用新编号')
  assert.equal(store.config.buildNo, 8)
})

test('fail-run：已是终态的同 tag 记录不覆盖（清扫判死 / 他端先落优先）', async () => {
  const home = await mkdtemp(pathJoin(tmpdir(), 'wt-failrun-'))
  await mkdir(pathJoin(home, 'storages'), { recursive: true })
  await writeFile(pathJoin(home, 'storages', 'worktable-pipeline.json'), JSON.stringify({
    config: { buildNo: 3 },
    history: [{ no: 3, tag: 't-close-1', pipeline: '关页实测', status: 'failed', ts: 1791821999000, logs: [{ stage: '（系统）', status: 'failed', log: '失联判死' }] }],
  }), 'utf8')
  const handler = await loadFailRunRoute(home)
  const res = await call(handler, 'POST', { records: [failRecord()] })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json().finalized, [], '已终态记录不再覆写')
  const store = await readStore(home)
  const rec = store.history.find(h => h.tag === 't-close-1')
  assert.equal(rec.ts, 1791821999000, '记录保持先落的终态版本')
  assert.equal(rec.logs[0].log, '失联判死')
})

test('fail-run：同 tag 休眠后缀计划清除；活动计划与他人计划保留', async () => {
  const home = await mkdtemp(pathJoin(tmpdir(), 'wt-failrun-'))
  await mkdir(pathJoin(home, 'storages'), { recursive: true })
  await writeFile(pathJoin(home, 'storages', 'worktable-pipeline.json'), JSON.stringify({ config: { buildNo: 1 }, history: [] }), 'utf8')
  await writeFile(pathJoin(home, 'storages', 'worktable-pipeline-plans.json'), JSON.stringify({
    plans: [
      { id: 'stimer-pl-1-t-close-1-suffix', kind: 'once', at: 0, tag: 't-close-1', pipelineName: '后缀' },
      { id: 'stimer-pl-1-t-close-2-suffix', kind: 'once', at: 0, tag: 't-close-2', pipelineName: '他人后缀' },
      { id: 'stimer-pl-1-t-close-3-suffix', kind: 'once', at: 1791822000000, tag: 't-close-1', pipelineName: '已激活计划' },
    ],
  }), 'utf8')
  const handler = await loadFailRunRoute(home)
  const res = await call(handler, 'POST', { records: [failRecord()] })
  assert.equal(res.status, 200)
  const plans = await readPlans(home)
  const ids = plans.map(p => p.id).sort()
  assert.deepEqual(ids, ['stimer-pl-1-t-close-2-suffix', 'stimer-pl-1-t-close-3-suffix'],
    '同 tag 休眠计划清除；他人休眠计划与本 tag 已激活计划保留')
})

test('fail-run：失败阶段归档日志追加中断行；归档目录外的 logFile 不写入', async () => {
  const home = await mkdtemp(pathJoin(tmpdir(), 'wt-failrun-'))
  const archive = pathJoin(home, 'archive', '关页实测_20261013_100000')
  await mkdir(archive, { recursive: true })
  await mkdir(pathJoin(home, 'storages'), { recursive: true })
  await writeFile(pathJoin(home, 'storages', 'worktable-pipeline.json'), JSON.stringify({ config: {}, history: [] }), 'utf8')
  const stageLog = pathJoin(archive, 'run-t-close-1-02-部署.log')
  await writeFile(stageLog, '前半段输出\n', 'utf8')
  const outside = pathJoin(home, 'outside.log')
  await writeFile(outside, '不该被动\n', 'utf8')
  const handler = await loadFailRunRoute(home)
  const rec = failRecord({
    archive,
    logs: [
      { stage: '检出', status: 'success', dur: 5, local: true, logFile: pathJoin(archive, 'run-t-close-1-01-检出.log') },
      { stage: '部署', status: 'failed', dur: 12, local: true, logFile: stageLog },
      { stage: '逃逸', status: 'failed', dur: 1, logFile: outside },
    ],
  })
  const res = await call(handler, 'POST', { records: [rec] })
  assert.equal(res.status, 200)
  const text = await readFile(stageLog, 'utf8')
  assert.ok(/\[中断\] 浏览器页面已关闭/.test(text), '失败阶段归档日志追加中断行')
  assert.ok(text.startsWith('前半段输出\n'), '原有日志内容保留')
  assert.equal(await readFile(outside, 'utf8'), '不该被动\n', '归档目录外的文件不写入')
})

test('fail-run：无有效记录 400；GET 405；非法记录（缺 tag）被剔除', async () => {
  const home = await mkdtemp(pathJoin(tmpdir(), 'wt-failrun-'))
  const handler = await loadFailRunRoute(home)
  const bad = await call(handler, 'POST', { records: [{ pipeline: '无 tag' }] })
  assert.equal(bad.status, 400)
  const empty = await call(handler, 'POST', {})
  assert.equal(empty.status, 400)
  const get = await call(handler, 'GET')
  assert.equal(get.status, 405)
})

test('cleanCloseFailRecord：字段白名单与截断——envNodes 剥离凭据、logs 白名单、tag 非法拒收', async () => {
  const home = await mkdtemp(pathJoin(tmpdir(), 'wt-failrun-'))
  await mkdir(pathJoin(home, 'storages'), { recursive: true })
  await writeFile(pathJoin(home, 'storages', 'worktable-pipeline.json'), JSON.stringify({ config: {}, history: [] }), 'utf8')
  const handler = await loadFailRunRoute(home)
  const rec = failRecord({
    envNodes: [{ name: 'n1', ip: '10.0.0.1', nodeIp: '', user: 'u', pass: 'p' }, 'junk', { name: '', ip: '' }],
    logs: [{ stage: 's', status: 'hacked', dur: -3, logFile: '/x.log', evil: true }, { stage: '', status: 'failed' }, null],
    _lc: { cached: true },   // 浏览器内存缓存字段不得进共享存储
  })
  const res = await call(handler, 'POST', { records: [rec, { tag: 'x'.repeat(200) }] })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json().finalized, ['t-close-1'], 'tag 超长的记录被剔除')
  const store = await readStore(home)
  const saved = store.history.find(h => h.tag === 't-close-1')
  assert.deepEqual(saved.envNodes, [{ name: 'n1', ip: '10.0.0.1', nodeIp: '' }], 'envNodes 只留 name/ip/nodeIp，凭据剥离')
  assert.equal(saved._lc, undefined, 'transient 字段不入库')
  assert.equal(saved.logs.length, 1, '空 stage / null 条目剔除')
  assert.equal(saved.logs[0].status, 'skipped', '非法阶段状态归一为 skipped')
  assert.equal(saved.logs[0].dur, 0, '负耗时钳 0')
  assert.equal(saved.logs[0].evil, undefined, '日志条目白名单字段')
})

test('fail-run：与「进行中」清扫的关系——终态化后的记录不再被 sweep 判死条件命中（status 非 running）', async () => {
  /* 静态契约：sweep 只处理 status==='running' 的记录；fail-run 落史的 failed 记录天然豁免 */
  const sweepSrc = extractFunction('planStaleHistorySweep')
  assert.ok(/rec\.status !== 'running'/.test(sweepSrc), 'sweep 只判死 running 记录')
  const routeAt = source.indexOf("path: '/api/worktable/pipeline/history/fail-run'")
  const pagehideContract = "if (existing.status !== 'running') continue"
  assert.ok(source.slice(routeAt, routeAt + 4000).includes(pagehideContract), 'fail-run 不覆盖已终态记录（与 sweep 判死结果共存）')
})
