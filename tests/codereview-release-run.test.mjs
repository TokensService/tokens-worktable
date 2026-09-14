import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../projects/codereview/code-review-prs.html', import.meta.url), 'utf8')

function functionSource(name) {
  const functionStart = source.indexOf('function ' + name + '(')
  const start = functionStart >= 6 && source.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6
    : functionStart
  assert.ok(start >= 0, '缺少函数 ' + name)
  const brace = source.indexOf('{', functionStart)
  let depth = 0
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') depth -= 1
    if (depth === 0) return source.slice(start, i + 1)
  }
  assert.fail('函数 ' + name + ' 缺少闭合括号')
}

function loadFunctions(names, context = {}) {
  const ctx = Object.assign({ JSON, String, Error, Promise, AbortController }, context)
  vm.createContext(ctx)
  vm.runInContext(names.map(functionSource).join('\n'), ctx)
  return ctx
}

/* runRelease 公共桩：返回 { ctx, calls, states, hist, logs, done, relBody, relAutoNotes, relRunBtn } */
function runReleaseHarness(overrides = {}) {
  const calls = []
  const logs = []
  const hist = []
  let savedHist = null
  let lastStates = []
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const repo = { owner: 'TokensService', name: 'demo' }
  const relBody = { value: '' }
  const relAutoNotes = { checked: false }
  const relRunBtn = { disabled: false, textContent: '', classList: { add() {}, remove() {} } }
  const ctx = loadFunctions(['relStopErr', 'runRelease'], Object.assign({
    relRunning: false,
    relAbortCtrl: null,
    relAutoNotes,
    relRunBtn,
    relRunTip: { textContent: '' },
    relResult: { innerHTML: '' },
    relBody,
    relBranch: { value: 'main' },
    relTag: { value: 'v2.0.0' },
    relName: { value: '' },
    relArtifacts: { value: 'dist/*.tgz' },
    relBuildTimeout: { value: '1800' },
    relBuildCmd: { value: '' },
    relPrerelease: { checked: false },
    relCfg: { timeout: 1800 },
    DEFAULT_REL_CFG: { timeout: 1800 },
    state: { token: 't', platform: 'gitcode', buildContainer: '', buildProxy: 'inherit' },
    REL_STEPS: ['编译构建', '创建 Tag', '创建发行版', '上传产物'],
    REL_STEP_AI_NOTES: 'AI 发行说明',
    relStepNames: ['编译构建', '创建 Tag', '创建发行版', '上传产物'],
    relStepLogs: [[], [], [], [], []],
    relSelectedRepo: () => repo,
    effectiveBuildScript: () => 'scripts/build.sh',
    repoGitUrl: () => 'https://git.example/demo.git',
    repoAuthUrl: () => 'https://auth.example/demo.git',
    apiBase: () => 'https://api.example',
    webBase: () => 'https://web.example',
    esc: s => String(s),
    proxyModeLabel: () => 'inherit',
    mergeBuildExtraEnv: () => [],
    applyBuildProxyEnv: () => 'inherit',
    BUILD_WRAP_SCRIPT_PATH: '/tmp/wrap.sh',
    rememberRelCfgCloud: () => {},
    relLogClear: () => {},
    relLog: msg => logs.push(msg),
    relSetSteps: s => { lastStates = s.map(x => Object.assign({}, x)) },
    archiveStepLines: lines => lines,
    ensureRelHistLoaded: async () => hist,
    saveRelHist: h => { savedHist = h },
    renderRelHist: () => finish(),
    genRelNotesForRun: async () => { calls.push('ai'); return { notes: '## v2.0.0\n\n- AI 生成', rangeTip: 'v1.0.0…main · 1 个提交' } },
    execRepoBuild: async () => { calls.push('build'); return { code: 0 } },
    githubCreateTag: async () => { calls.push('tag:github') },
    pushReleaseTag: async () => { calls.push('tag:push') },
    uploadReleaseAssets: async () => { calls.push('upload') },
    uploadGithubAssets: async () => { calls.push('upload:github') },
    fetchPost: async (path, params) => { calls.push('post:' + path + (params && params.body !== undefined ? '|body=' + params.body : '')); return {} },
  }, overrides))
  return {
    ctx, calls, logs,
    states: () => lastStates,
    savedHist: () => savedHist,
    done, relBody, relAutoNotes, relRunBtn,
  }
}

test('勾选「AI 生成发行说明」：AI 步先行回填发行说明，再串行构建/Tag/发行版/产物', async () => {
  const h = runReleaseHarness()
  h.relAutoNotes.checked = true
  h.ctx.runRelease()
  await h.done

  assert.deepEqual(h.calls, [
    'ai',
    'build',
    'post:/repos/TokensService/demo/tags',
    'post:/repos/TokensService/demo/releases|body=## v2.0.0\n\n- AI 生成',
    'upload',
  ])
  assert.equal(h.relBody.value, '## v2.0.0\n\n- AI 生成')
  const states = h.states()
  assert.equal(states.length, 5)
  assert.deepEqual([...states].map(s => s.st), ['ok', 'ok', 'ok', 'ok', 'ok'])
  assert.equal(states[0].note, 'v1.0.0…main · 1 个提交')
  const rec = h.savedHist()[0]
  assert.equal(rec.status, 'ok')
  assert.deepEqual([...rec.steps].map(s => s.name), ['AI 发行说明', '编译构建', '创建 Tag', '创建发行版', '上传产物'])
  assert.equal(h.relRunBtn.textContent, '🚀 构建并发行')
})

test('未勾选「AI 生成发行说明」：保持四步流程、不触发 AI（回归）', async () => {
  const h = runReleaseHarness({
    genRelNotesForRun: async () => { throw new Error('不应调用 AI') },
  })
  h.ctx.runRelease()
  await h.done

  assert.deepEqual(h.calls, [
    'build',
    'post:/repos/TokensService/demo/tags',
    'post:/repos/TokensService/demo/releases|body=',
    'upload',
  ])
  assert.equal(h.states().length, 4)
  assert.deepEqual([...h.savedHist()[0].steps].map(s => s.name), ['编译构建', '创建 Tag', '创建发行版', '上传产物'])
})

test('无新提交时 AI 步标记跳过并沿用现有发行说明，发行继续', async () => {
  const h = runReleaseHarness({
    genRelNotesForRun: async () => ({ notes: '', rangeTip: '' }),
  })
  h.relAutoNotes.checked = true
  h.relBody.value = '手写说明'
  h.ctx.runRelease()
  await h.done

  assert.equal(h.states()[0].st, 'skip')
  assert.equal(h.relBody.value, '手写说明')
  assert.ok(h.calls.includes('build'), '跳过后仍应继续构建')
  assert.equal(h.savedHist()[0].status, 'ok')
})

test('AI 生成发行说明失败即中止发行：不进入构建，按失败归档', async () => {
  const h = runReleaseHarness({
    genRelNotesForRun: async () => { throw new Error('AI 结果桥不可用') },
  })
  h.relAutoNotes.checked = true
  h.ctx.runRelease()
  await h.done

  assert.deepEqual(h.calls, [])
  assert.equal(h.states()[0].st, 'err')
  assert.match(h.savedHist()[0].error, /AI 结果桥不可用/)
  assert.equal(h.savedHist()[0].status, 'err')
})

test('AI 生成期间点「⏹ 停止」：按已停止归档，不进入构建', async () => {
  let resolveAi
  const aiPending = new Promise(resolve => { resolveAi = resolve })
  const h = runReleaseHarness({
    genRelNotesForRun: async (repo, branch, tag, name, signal) => {
      await aiPending
      if (signal.aborted) { const e = new Error('已手动停止'); e.relStop = true; throw e }
      return { notes: '## 迟到说明', rangeTip: 'v1.0.0…main · 1 个提交' }
    },
  })
  h.relAutoNotes.checked = true
  h.ctx.runRelease()
  assert.equal(h.relRunBtn.textContent, '⏹ 停止')
  h.ctx.runRelease()   // 运行中再次点击 = 停止
  resolveAi()
  await h.done

  assert.deepEqual(h.calls, [])
  assert.equal(h.states()[0].st, 'abort')
  assert.equal(h.savedHist()[0].status, 'stop')
  assert.equal(h.relRunBtn.textContent, '🚀 构建并发行')
})

test('genRelNotesForRun 有提交时经 AI 生成并返回说明与区间提示', async () => {
  let aiCalls = 0
  const ctx = loadFunctions(['relStopErr', 'parseRelNotesResult', 'genRelNotesForRun'], {
    fetchPrevRelease: async () => ({ tag_name: 'v1.0.0', created_at: '2026-09-01' }),
    fetchRangeCommits: async () => [{ sha: 'abc12345', msg: 'feat: 新功能' }],
    buildRelNotesPrompt: () => 'notes prompt',
    requestAiResult: async () => { aiCalls += 1; return '<dsh-release-notes>## v2.0.0\n\n- 新功能</dsh-release-notes>' },
    relLog: () => {},
  })

  const out = await ctx.genRelNotesForRun({ owner: 'TokensService', name: 'demo' }, 'main', 'v2.0.0', '', { aborted: false })

  assert.equal(aiCalls, 1)
  assert.equal(out.notes, '## v2.0.0\n\n- 新功能')
  assert.equal(out.rangeTip, 'v1.0.0…main · 1 个提交')
})

test('genRelNotesForRun 无新提交时不调用 AI，返回空说明', async () => {
  let aiCalls = 0
  const ctx = loadFunctions(['relStopErr', 'parseRelNotesResult', 'genRelNotesForRun'], {
    fetchPrevRelease: async () => ({ tag_name: 'v1.0.0', created_at: '2026-09-01' }),
    fetchRangeCommits: async () => [],
    buildRelNotesPrompt: () => 'notes prompt',
    requestAiResult: async () => { aiCalls += 1; return '' },
    relLog: () => {},
  })

  const out = await ctx.genRelNotesForRun({ owner: 'TokensService', name: 'demo' }, 'main', 'v2.0.0', '', { aborted: false })

  assert.equal(aiCalls, 0)
  assert.equal(out.notes, '')
})

test('genRelNotesForRun 在等待 AI 期间被中止时抛停止哨兵', async () => {
  let resolveAi
  const aiPending = new Promise(resolve => { resolveAi = resolve })
  const signal = { aborted: false }
  const ctx = loadFunctions(['relStopErr', 'parseRelNotesResult', 'genRelNotesForRun'], {
    fetchPrevRelease: async () => null,
    fetchRangeCommits: async () => [{ sha: 'abc12345', msg: 'feat: 新功能' }],
    buildRelNotesPrompt: () => 'notes prompt',
    requestAiResult: () => aiPending,
    relLog: () => {},
  })

  const pending = ctx.genRelNotesForRun({ owner: 'TokensService', name: 'demo' }, 'main', 'v2.0.0', '', signal)
  signal.aborted = true
  resolveAi('<dsh-release-notes>## 迟到说明</dsh-release-notes>')

  await assert.rejects(pending, err => err.relStop === true)
})
