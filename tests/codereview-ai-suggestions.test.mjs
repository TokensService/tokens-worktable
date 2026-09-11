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

function loadFunction(name, context = {}) {
  const ctx = Object.assign({ JSON, String, Error }, context)
  vm.createContext(ctx)
  vm.runInContext(functionSource(name) + '\n;globalThis.__fn = ' + name, ctx)
  return ctx.__fn
}

function loadFunctions(names, context = {}) {
  const ctx = Object.assign({ JSON, String, Error, Promise }, context)
  vm.createContext(ctx)
  vm.runInContext(names.map(functionSource).join('\n'), ctx)
  return ctx
}

test('AI 构建建议协议同时解析构建脚本与产物路径', () => {
  const parseRelBuildSuggestion = loadFunction('parseRelBuildSuggestion')
  const reply = [
    '分析完成。',
    '<dsh-release-config>',
    '{"script":"scripts/build.sh","artifacts":"dist/*.tgz reports/result.zip"}',
    '</dsh-release-config>',
  ].join('\n')

  assert.equal(JSON.stringify(parseRelBuildSuggestion(reply)), JSON.stringify({
    script: 'scripts/build.sh',
    artifacts: 'dist/*.tgz reports/result.zip',
  }))
})

test('AI 构建建议拒绝绝对路径和目录穿越，不覆盖为危险配置', () => {
  const parseRelBuildSuggestion = loadFunction('parseRelBuildSuggestion')
  const wrapped = value => '<dsh-release-config>' + JSON.stringify(value) + '</dsh-release-config>'

  assert.throws(() => parseRelBuildSuggestion(wrapped({ script: '../build.sh', artifacts: 'dist/*.tgz' })), /仓内相对路径/)
  assert.throws(() => parseRelBuildSuggestion(wrapped({ script: 'scripts/build.sh', artifacts: '/tmp/app.tgz' })), /仓内相对路径/)
  assert.throws(() => parseRelBuildSuggestion(wrapped({ script: 'scripts/build.sh', artifacts: 'dist/../secret' })), /仓内相对路径/)
})

test('AI 构建建议严格要求仅含两个字符串字段', () => {
  const parseRelBuildSuggestion = loadFunction('parseRelBuildSuggestion')
  const wrapped = value => '<dsh-release-config>' + JSON.stringify(value) + '</dsh-release-config>'

  assert.throws(() => parseRelBuildSuggestion(wrapped({ script: true, artifacts: 'dist/*.tgz' })), /字符串字段/)
  assert.throws(() => parseRelBuildSuggestion(wrapped({ script: 'scripts/build.sh', artifacts: 123 })), /字符串字段/)
  assert.throws(() => parseRelBuildSuggestion(wrapped({ script: ['scripts/build.sh'], artifacts: 'dist/*.tgz' })), /字符串字段/)
  assert.throws(() => parseRelBuildSuggestion(wrapped({ script: 'scripts/build.sh' })), /必须且只能包含/)
  assert.throws(() => parseRelBuildSuggestion(wrapped({ script: 'scripts/build.sh', artifacts: 'dist/*.tgz', note: 'extra' })), /必须且只能包含/)
})

test('空分支按实际默认 main 生成云端构建配置键', () => {
  const relBranchKey = loadFunction('relBranchKey', {
    relSelectedRepo: () => ({ owner: 'TokensService', name: 'demo' }),
    relBranch: { value: '   ' },
  })

  assert.equal(relBranchKey(), 'TokensService/demo@main')
})

test('AI 构建建议同时回填两项并立即保存分支级云端配置', () => {
  const relCfg = { script: 'old.sh', artifacts: 'old/*.zip' }
  const relArtifacts = { value: 'old/*.zip' }
  const calls = []
  const applyRelBuildSuggestion = loadFunction('applyRelBuildSuggestion', {
    relCfg,
    relArtifacts,
    applyBuildScriptSelection: () => calls.push('select'),
    saveRelCfg: () => calls.push('local'),
    rememberRelCfgCloud: () => calls.push('cloud'),
  })

  applyRelBuildSuggestion({ script: 'ci/release.sh', artifacts: 'out/*.tar.gz' })

  assert.equal(relCfg.script, 'ci/release.sh')
  assert.equal(relCfg.artifacts, 'out/*.tar.gz')
  assert.equal(relArtifacts.value, 'out/*.tar.gz')
  assert.deepEqual(calls, ['select', 'local', 'cloud'])
})

test('页面通过宿主结果桥等待并取得 AI 最终文本', async () => {
  const prompts = []
  const requestAiResult = loadFunction('requestAiResult', {
    getHost: () => ({
      __dshSendChatForResult: async prompt => { prompts.push(prompt); return '最终文本' },
    }),
  })

  assert.equal(await requestAiResult('生成请求'), '最终文本')
  assert.deepEqual(prompts, ['生成请求'])
})

test('构建建议提示携带仓库分支、可选认证和严格回填协议', () => {
  const buildRelBuildSuggestionPrompt = loadFunction('buildRelBuildSuggestionPrompt', {
    state: { embed: true, token: 'secret-token' },
    apiBase: () => 'https://api.example/v5',
    platformLabel: () => 'GitCode',
    encodeURIComponent,
    effectiveBuildScript: () => 'scripts/old.sh',
    relArtifacts: { value: 'old/*.zip' },
  })
  const prompt = buildRelBuildSuggestionPrompt({ owner: 'TokensService', name: 'demo' }, 'release/v2')

  assert.match(prompt, /GitCode 仓库 TokensService\/demo/)
  assert.match(prompt, /release\/v2/)
  assert.match(prompt, /Authorization: Bearer secret-token/)
  assert.match(prompt, /scripts\/old\.sh/)
  assert.match(prompt, /old\/\*\.zip/)
  assert.match(prompt, /<dsh-release-config>/)
  assert.match(prompt, /"script".*"artifacts"/s)
})

test('点击构建 AI 建议后等待结果、同时回填两项并恢复按钮', async () => {
  const relCfg = { script: '', artifacts: '' }
  const relArtifacts = { value: '' }
  const relBuildAiBtn = { disabled: false, textContent: '✦ AI 建议' }
  const relBuildAiTip = { textContent: '' }
  const events = []
  const ctx = loadFunctions(
    ['parseRelBuildSuggestion', 'applyRelBuildSuggestion', 'genRelBuildSuggestion'],
    {
      state: { token: 'configured' },
      relCfg,
      relArtifacts,
      relBuildAiBtn,
      relBuildAiTip,
      relBuildAiBusy: false,
      relBranch: { value: 'dev' },
      relSelectedRepo: () => ({ owner: 'TokensService', name: 'demo' }),
      buildRelBuildSuggestionPrompt: () => 'prompt',
      requestAiResult: async () => '<dsh-release-config>{"script":"scripts/build.sh","artifacts":"dist/*.tgz"}</dsh-release-config>',
      applyBuildScriptSelection: () => events.push('select'),
      saveRelCfg: () => events.push('local'),
      rememberRelCfgCloud: () => events.push('cloud'),
      toast: message => events.push(message),
    },
  )

  await ctx.genRelBuildSuggestion()

  assert.equal(relCfg.script, 'scripts/build.sh')
  assert.equal(relArtifacts.value, 'dist/*.tgz')
  assert.equal(relBuildAiBtn.disabled, false)
  assert.equal(relBuildAiBtn.textContent, '✦ AI 建议')
  assert.match(relBuildAiTip.textContent, /已自动回填/)
  assert.deepEqual(events.slice(0, 3), ['select', 'local', 'cloud'])
})

test('发行说明只从 AI 回答的结果标记内提取 Markdown', () => {
  const parseRelNotesResult = loadFunction('parseRelNotesResult')
  const reply = [
    '以下是生成结果：',
    '<dsh-release-notes>',
    '## v2.0.0（2026-09-11）',
    '',
    '### ✨ 新功能',
    '- 自动回填发行说明（`abc12345`）',
    '</dsh-release-notes>',
    '可以继续调整。',
  ].join('\n')

  assert.equal(parseRelNotesResult(reply), [
    '## v2.0.0（2026-09-11）',
    '',
    '### ✨ 新功能',
    '- 自动回填发行说明（`abc12345`）',
  ].join('\n'))
})

test('发行说明 AI 完成后自动回填文本框并恢复按钮', async () => {
  const relBody = { value: '原说明' }
  const relNotesAiBtn = { disabled: false, textContent: '✦ AI 生成' }
  const relNotesAiTip = { textContent: '' }
  const ctx = loadFunctions(['parseRelNotesResult', 'genRelNotes'], {
    state: { token: 'configured' },
    relNotesAiBusy: false,
    relBody,
    relNotesAiBtn,
    relNotesAiTip,
    relBranch: { value: 'dev' },
    relTag: { value: 'v2.0.0' },
    relName: { value: '' },
    relSelectedRepo: () => ({ owner: 'TokensService', name: 'demo' }),
    fetchPrevRelease: async () => ({ tag_name: 'v1.0.0', created_at: '2026-09-01' }),
    fetchRangeCommits: async () => [{ sha: 'abc12345', msg: 'feat: 新功能' }],
    buildRelNotesPrompt: () => 'notes prompt',
    requestAiResult: async () => '<dsh-release-notes>## v2.0.0\n\n- 新功能</dsh-release-notes>',
    launchRelNotesSession: () => {},
    describeApiError: error => ({ title: String(error) }),
    toast: () => {},
  })

  const pending = ctx.genRelNotes()
  assert.equal(typeof pending?.then, 'function', '生成函数应返回可等待的 Promise')
  await pending

  assert.equal(relBody.value, '## v2.0.0\n\n- 新功能')
  assert.equal(relNotesAiBtn.disabled, false)
  assert.equal(relNotesAiBtn.textContent, '✦ AI 生成')
  assert.match(relNotesAiTip.textContent, /已自动回填/)
})

test('AI 分析期间切换仓库或分支时不把旧构建建议回填到新选择', async () => {
  let resolveResult
  const result = new Promise(resolve => { resolveResult = resolve })
  const relCfg = { script: 'keep.sh', artifacts: 'keep/*.tgz' }
  const relArtifacts = { value: 'keep/*.tgz' }
  const relBranch = { value: 'dev' }
  const relBuildAiBtn = { disabled: false, textContent: '✦ AI 建议' }
  const relBuildAiTip = { textContent: '' }
  const repo = { owner: 'TokensService', name: 'demo' }
  const ctx = loadFunctions(
    ['parseRelBuildSuggestion', 'applyRelBuildSuggestion', 'genRelBuildSuggestion'],
    {
      state: { token: 'configured' }, relCfg, relArtifacts, relBranch, relBuildAiBtn, relBuildAiTip,
      relBuildAiBusy: false,
      relSelectedRepo: () => repo,
      buildRelBuildSuggestionPrompt: () => 'prompt',
      requestAiResult: () => result,
      applyBuildScriptSelection: () => {}, saveRelCfg: () => {}, rememberRelCfgCloud: () => {}, toast: () => {},
    },
  )

  const pending = ctx.genRelBuildSuggestion()
  relBranch.value = 'main'
  resolveResult('<dsh-release-config>{"script":"scripts/new.sh","artifacts":"new/*.tgz"}</dsh-release-config>')
  await pending

  assert.equal(relCfg.script, 'keep.sh')
  assert.equal(relArtifacts.value, 'keep/*.tgz')
  assert.match(relBuildAiTip.textContent, /已变更/)
})

test('AI 分析期间切换平台时不把旧构建建议回填到同名仓库', async () => {
  let resolveResult
  const result = new Promise(resolve => { resolveResult = resolve })
  const state = { token: 'configured', platform: 'gitcode' }
  const relCfg = { script: 'keep.sh', artifacts: 'keep/*.tgz' }
  const relArtifacts = { value: 'keep/*.tgz' }
  const relBuildAiBtn = { disabled: false, textContent: '✦ AI 建议' }
  const relBuildAiTip = { textContent: '' }
  const ctx = loadFunctions(
    ['parseRelBuildSuggestion', 'applyRelBuildSuggestion', 'genRelBuildSuggestion'],
    {
      state, relCfg, relArtifacts, relBuildAiBtn, relBuildAiTip,
      relBuildAiBusy: false, relBranch: { value: 'dev' },
      relSelectedRepo: () => ({ owner: 'TokensService', name: 'demo' }),
      buildRelBuildSuggestionPrompt: () => 'prompt', requestAiResult: () => result,
      applyBuildScriptSelection: () => {}, saveRelCfg: () => {}, rememberRelCfgCloud: () => {}, toast: () => {},
    },
  )

  const pending = ctx.genRelBuildSuggestion()
  state.platform = 'github'
  resolveResult('<dsh-release-config>{"script":"scripts/new.sh","artifacts":"new/*.tgz"}</dsh-release-config>')
  await pending

  assert.equal(relCfg.script, 'keep.sh')
  assert.equal(relArtifacts.value, 'keep/*.tgz')
  assert.match(relBuildAiTip.textContent, /已变更/)
})

test('AI 生成期间切换发行分支时不把旧发行说明回填到新选择', async () => {
  let resolveResult
  const result = new Promise(resolve => { resolveResult = resolve })
  const relBody = { value: '保留的新分支说明' }
  const relBranch = { value: 'dev' }
  const relNotesAiBtn = { disabled: false, textContent: '✦ AI 生成' }
  const relNotesAiTip = { textContent: '' }
  const repo = { owner: 'TokensService', name: 'demo' }
  const ctx = loadFunctions(['parseRelNotesResult', 'genRelNotes'], {
    state: { token: 'configured' }, relNotesAiBusy: false, relBody, relBranch, relNotesAiBtn, relNotesAiTip,
    relTag: { value: 'v2.0.0' }, relName: { value: '' }, relSelectedRepo: () => repo,
    fetchPrevRelease: async () => null,
    fetchRangeCommits: async () => [{ sha: 'abc12345', msg: 'feat: 新功能' }],
    buildRelNotesPrompt: () => 'prompt', requestAiResult: () => result, toast: () => {},
  })

  const pending = ctx.genRelNotes()
  relBranch.value = 'main'
  resolveResult('<dsh-release-notes>## dev 分支说明</dsh-release-notes>')
  await pending

  assert.equal(relBody.value, '保留的新分支说明')
  assert.match(relNotesAiTip.textContent, /已变更/)
})

test('AI 生成期间切换平台时不把旧发行说明回填到同名仓库', async () => {
  let resolveResult
  const result = new Promise(resolve => { resolveResult = resolve })
  const state = { token: 'configured', platform: 'gitcode' }
  const relBody = { value: '保留的新平台说明' }
  const relNotesAiTip = { textContent: '' }
  const ctx = loadFunctions(['parseRelNotesResult', 'genRelNotes'], {
    state, relNotesAiBusy: false, relBody,
    relBranch: { value: 'dev' }, relTag: { value: 'v2.0.0' }, relName: { value: '' },
    relNotesAiBtn: { disabled: false, textContent: '✦ AI 生成' }, relNotesAiTip,
    relSelectedRepo: () => ({ owner: 'TokensService', name: 'demo' }),
    fetchPrevRelease: async () => null,
    fetchRangeCommits: async () => [{ sha: 'abc12345', msg: 'feat: 新功能' }],
    buildRelNotesPrompt: () => 'prompt', requestAiResult: () => result, toast: () => {},
  })

  const pending = ctx.genRelNotes()
  state.platform = 'github'
  resolveResult('<dsh-release-notes>## 旧平台说明</dsh-release-notes>')
  await pending

  assert.equal(relBody.value, '保留的新平台说明')
  assert.match(relNotesAiTip.textContent, /已变更/)
})

test('拉取上一发行版期间切换平台时不再请求提交或启动 AI', async () => {
  let resolvePrev
  const prevPending = new Promise(resolve => { resolvePrev = resolve })
  const state = { token: 'configured', platform: 'gitcode' }
  const calls = []
  const ctx = loadFunctions(['parseRelNotesResult', 'genRelNotes'], {
    state, relNotesAiBusy: false, relBody: { value: '保留' },
    relBranch: { value: 'dev' }, relTag: { value: 'v2.0.0' }, relName: { value: '' },
    relNotesAiBtn: { disabled: false, textContent: '✦ AI 生成' }, relNotesAiTip: { textContent: '' },
    relSelectedRepo: () => ({ owner: 'TokensService', name: 'demo' }),
    fetchPrevRelease: () => prevPending,
    fetchRangeCommits: async () => { calls.push('commits'); return [{ sha: 'abc12345', msg: 'feat' }] },
    buildRelNotesPrompt: () => 'prompt',
    requestAiResult: async () => { calls.push('ai'); return '<dsh-release-notes>旧平台</dsh-release-notes>' },
    toast: () => {},
  })

  const pending = ctx.genRelNotes()
  state.platform = 'github'
  resolvePrev(null)
  await pending

  assert.deepEqual(calls, [])
})
