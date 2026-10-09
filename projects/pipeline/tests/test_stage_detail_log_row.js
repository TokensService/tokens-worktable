const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function extractFunction(name) {
  const marker = new RegExp(`function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `pipeline.html 缺少函数 ${name}`);
  let start = match.index;
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;   // 保留 async 前缀
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`无法提取函数 ${name}`);
}

/* ---------- 静态契约 ---------- */

test('静态契约：阶段详情日志行的新函数、按钮文案与控件 ID 齐备', () => {
  for (const name of ['stageLogFileFor', 'currentStageAnalysisRec', 'appendStageLogRow', 'stageDetailAnalysis', 'openFolderWithFeedback', 'openStageLogFolder']) {
    assert.ok(new RegExp(`function\\s+${name}\\s*\\(`).test(source), `pipeline.html 缺少函数 ${name}`);
  }
  assert.ok(source.includes('🔍 AI 分析'), '缺少「🔍 AI 分析」按钮文案');
  assert.ok(source.includes('📂 打开日志'), '缺少「📂 打开日志」按钮文案');
  for (const id of ['stageLogRow', 'stageLogPath', 'stageLogAiBtn', 'stageLogOpenBtn', 'stageLogTip']) {
    assert.ok(new RegExp(`id\\s*=\\s*["'\`]${id}["'\`]`).test(source), `缺少 #${id}`);
  }
  assert.ok(source.includes('正在等待日志落盘并打开目录…'), '缺少等待落盘文案');
  assert.ok(source.includes('✗ 目录不存在（含归档根目录）：'), '缺少目录不存在文案');
  assert.ok(source.includes('✓ 已在侧边栏打开 '), '缺少侧边栏打开成功文案');
});

test('回归：「📂 打开归档目录」按钮与其 title 原文不变', () => {
  const openBtn = source.match(/<button\b[^>]*\bid="openArchiveBtn"[^>]*>[^<]*<\/button>/);
  assert.ok(openBtn, '缺少 #openArchiveBtn 按钮');
  assert.ok(openBtn[0].includes('📂 打开归档目录'), '#openArchiveBtn 文案应为「📂 打开归档目录」');
  const title = '打开归档目录：经 dsh-better-sidebar 侧边窗打开（文件夹窗口，文件树以归档目录为根），同时关闭侧边会话窗（聊天列）让出空间，保持当前页面与会话、不新建会话（需要 AI 分析时用运行历史标题行的分析按钮）；未装该插件或桥不可用时回退到 DSH 服务端系统文件管理器（回退路径不关会话窗）。目录选取：运行中取当前运行的归档文件夹；未运行时取运行历史选中行（点击历史行即刷新目标），未选中则提示先选择一条运行历史（不再回退打开归档根目录）。目标目录不存在时（历史归档已清理等）回退打开其父目录（归档根），连归档根都不存在才报「目录不存在」。';
  assert.ok(openBtn[0].includes(`title="${title}"`), '#openArchiveBtn 的 title 原文被改动');
});

test('回归：运行历史标题行「🔍 AI 日志分析」按钮（data-ract="log"）不变', () => {
  assert.equal((source.match(/data-ract="log"/g) || []).length, 1, 'data-ract="log" 应恰好出现一次');
  assert.ok(/<button\b[^>]*data-ract="log"[^>]*>[^<]*🔍 AI 日志分析/.test(source), 'data-ract="log" 按钮应为「🔍 AI 日志分析」');
});

test('openArchiveFolder 保留：仍解析 archiveTargetFolder 并委托 openFolderWithFeedback', () => {
  const body = extractFunction('openArchiveFolder');
  assert.ok(body.includes('archiveTargetFolder'), 'openArchiveFolder 仍应引用 archiveTargetFolder 解析目标目录');
  assert.ok(body.includes('openFolderWithFeedback'), 'openArchiveFolder 应委托 openFolderWithFeedback 执行打开');
});

test('renderDetail / renderReplayDetail 接入阶段日志行', () => {
  const liveBody = extractFunction('renderDetail');
  assert.ok(liveBody.includes('appendStageLogRow'), 'renderDetail（实时）应调用 appendStageLogRow');
  assert.ok(liveBody.includes('stageLogFileFor('), 'renderDetail（实时）应经 stageLogFileFor 取日志文件');
  assert.ok(liveBody.includes('currentStageAnalysisRec('), 'renderDetail（实时）应经 currentStageAnalysisRec 取分析记录');
  const replayBody = extractFunction('renderReplayDetail');
  assert.ok(replayBody.includes('appendStageLogRow'), 'renderReplayDetail（回放）应调用 appendStageLogRow');
});

/* ---------- stageLogFileFor ---------- */

function stageLogCtx(stubs) {
  const ctx = Object.assign({
    archiveFolderFor: () => '/arch/run-x',
    taskLogFile: (rc, seq, name) => `run-${rc.tag}-${seq}-${name}.log`,
    stageSeq: () => 1,
  }, stubs || {});
  vm.createContext(ctx);
  vm.runInContext(extractFunction('stageLogFileFor'), ctx);
  return ctx;
}

test('stageLogFileFor：_serverLogFile 优先于 _serverLogExpectedFile', () => {
  const ctx = stageLogCtx();
  const stage = { name: '部署', _serverLogFile: '/srv/01-部署.log', _serverLogExpectedFile: '/exp/01-部署.log' };
  assert.equal(ctx.stageLogFileFor(stage, { tag: 'run-x', stages: [stage] }), '/srv/01-部署.log');
});

test('stageLogFileFor：无 _serverLogFile 时回退 _serverLogExpectedFile', () => {
  const ctx = stageLogCtx();
  const stage = { name: '部署', _serverLogExpectedFile: '/exp/01-部署.log' };
  assert.equal(ctx.stageLogFileFor(stage, { tag: 'run-x', stages: [stage] }), '/exp/01-部署.log');
});

test('stageLogFileFor：无服务端文件字段时拼归档路径，预设阶段序号走 stageSeq=0', () => {
  const seqArgs = [];
  const taskArgs = [];
  const ctx = stageLogCtx({
    stageSeq(stages, i) { seqArgs.push([stages, i]); return 0; },
    taskLogFile(rc, seq, name) { taskArgs.push([rc, seq, name]); return `run-${rc.tag}-00-${name}.log`; },
  });
  const preset = { name: '环境检查', preset: true };
  const stage = { name: '部署' };
  const rc = { tag: 'run-x', stages: [preset, stage] };

  assert.equal(ctx.stageLogFileFor(preset, rc), '/arch/run-x/run-run-x-00-环境检查.log');
  assert.equal(seqArgs.length, 1, '应调用 stageSeq 计算归档序号');
  assert.equal(seqArgs[0][0], rc.stages, 'stageSeq 应收到 rc.stages');
  assert.equal(seqArgs[0][1], 0, '预设阶段位于 rc.stages 下标 0');
  assert.equal(taskArgs.length, 1, '应调用 taskLogFile 拼日志文件名');
  assert.deepEqual(taskArgs[0], [rc, 0, '环境检查'], 'taskLogFile 应以 (rc, stageSeq 结果, 阶段名) 调用');
});

test('stageLogFileFor：正式阶段按 stageSeq 结果拼文件名', () => {
  const ctx = stageLogCtx({
    stageSeq: (stages, i) => i + 1,
    taskLogFile: (rc, seq, name) => `run-${rc.tag}-0${seq}-${name}.log`,
  });
  const build = { name: '构建' };
  const deploy = { name: '部署' };
  const rc = { tag: 'run-x', stages: [build, deploy] };

  assert.equal(ctx.stageLogFileFor(deploy, rc), '/arch/run-x/run-run-x-02-部署.log');
});

test('stageLogFileFor：阶段不在 rc.stages 中返回 null', () => {
  const ctx = stageLogCtx();
  const orphan = { name: '幽灵阶段' };
  assert.equal(ctx.stageLogFileFor(orphan, { tag: 'run-x', stages: [] }), null);
});

test('stageLogFileFor：无归档目录返回 null', () => {
  const stage = { name: '部署' };
  const empty = stageLogCtx({ archiveFolderFor: () => '' });
  assert.equal(empty.stageLogFileFor(stage, { tag: 'run-x', stages: [stage] }), null, 'archiveFolderFor 返回空串应为 null');
  const none = stageLogCtx({ archiveFolderFor: () => null });
  assert.equal(none.stageLogFileFor(stage, { tag: 'run-x', stages: [stage] }), null, 'archiveFolderFor 返回 null 应为 null');
});

/* ---------- currentStageAnalysisRec ---------- */

function analysisRecCtx(extra) {
  const ctx = Object.assign({ replayRec: null, curRun: null, history: [] }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(extractFunction('currentStageAnalysisRec'), ctx);
  return ctx;
}

test('currentStageAnalysisRec：回放态优先返回 replayRec', () => {
  const replay = { tag: 'run-replay', no: 7 };
  const ctx = analysisRecCtx({ replayRec: replay, curRun: { tag: 'run-a' }, history: [{ tag: 'run-a' }] });
  assert.equal(ctx.currentStageAnalysisRec(), replay, 'replayRec 非空应原样返回');
});

test('currentStageAnalysisRec：非回放态按 curRun.tag 匹配运行历史', () => {
  const hit = { tag: 'run-b', no: 2 };
  const ctx = analysisRecCtx({ curRun: { tag: 'run-b' }, history: [{ tag: 'run-a', no: 1 }, hit] });
  assert.equal(ctx.currentStageAnalysisRec(), hit, '应返回 history 中 tag 与 curRun.tag 相同的记录');
});

test('currentStageAnalysisRec：curRun 缺失或无 tag 返回 null', () => {
  const noTag = analysisRecCtx({ curRun: {}, history: [{ tag: 'run-a' }] });
  assert.equal(noTag.currentStageAnalysisRec(), null, 'curRun 无 tag 应为 null');
  const noRun = analysisRecCtx({ history: [{ tag: 'run-a' }] });
  assert.equal(noRun.currentStageAnalysisRec(), null, 'curRun 为空应为 null');
});

test('currentStageAnalysisRec：tag 无匹配或无 tag 字段的记录不命中', () => {
  const miss = analysisRecCtx({ curRun: { tag: 'run-x' }, history: [{ tag: 'run-a' }, { tag: 'run-b' }] });
  assert.equal(miss.currentStageAnalysisRec(), undefined, 'history 无匹配 tag 时不得返回记录');
  const noTagField = analysisRecCtx({ curRun: { tag: 'run-x' }, history: [{ no: 9, status: 'success' }] });
  assert.equal(noTagField.currentStageAnalysisRec(), undefined, '无 tag 字段的历史记录不得误匹配');
});

/* ---------- stageDetailAnalysis ---------- */

function stageDetailCtx(extra) {
  const calls = { chats: [], alerts: [] };
  const ctx = Object.assign({
    replayRec: null,
    curRun: null,
    history: [],
    alert: text => calls.alerts.push(String(text)),
    createAnalysisChat: (kind, recs) => calls.chats.push({ kind, recs: Array.from(recs) }),
  }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(extractFunction('currentStageAnalysisRec') + '\n' + extractFunction('stageDetailAnalysis'), ctx);
  return { ctx, calls };
}

test('stageDetailAnalysis：有分析记录时以 (log,[rec]) 发起 AI 分析', () => {
  const rec = { tag: 'run-a', no: 1 };
  const { ctx, calls } = stageDetailCtx({ replayRec: rec });

  ctx.stageDetailAnalysis();

  assert.equal(calls.chats.length, 1, '应调用一次 createAnalysisChat');
  assert.equal(calls.chats[0].kind, 'log', '分析类型应为 log');
  assert.equal(calls.chats[0].recs.length, 1, '应只分析当前这一次运行');
  assert.equal(calls.chats[0].recs[0], rec, '应把当前分析记录传给 createAnalysisChat');
  assert.equal(calls.alerts.length, 0, '有记录时不应弹提示');
});

test('stageDetailAnalysis：无分析记录时提示且不发起 AI 分析', () => {
  const { ctx, calls } = stageDetailCtx();

  ctx.stageDetailAnalysis();

  assert.deepEqual(calls.alerts, ['本次运行尚未写入运行历史（运行结束后自动生成），暂不能发起 AI 分析。'], '应提示先等待运行历史生成');
  assert.equal(calls.chats.length, 0, '无记录时不得调用 createAnalysisChat');
});

/* ---------- openStageLogFolder ---------- */

test('openStageLogFolder：取日志文件所在目录调用 openFolderWithFeedback', () => {
  const calls = [];
  const tip = { textContent: '', style: {} };
  const ctx = {
    openFolderWithFeedback(folder, say) { calls.push({ folder, sayType: typeof say }); },
    $: id => (id === 'stageLogTip' ? tip : null),
    alert() {},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('openStageLogFolder'), ctx);

  ctx.openStageLogFolder('/a/b/run-x-01-部署.log');

  assert.equal(calls.length, 1, '应调用一次 openFolderWithFeedback');
  assert.equal(calls[0].folder, '/a/b', '应去掉末段文件名只传目录');
  assert.equal(calls[0].sayType, 'function', '应传入状态提示函数 say');
});

test('openStageLogFolder：file 为空仅提示，不调用 openFolderWithFeedback', () => {
  const calls = [];
  const tip = { textContent: '', style: {} };
  const ctx = {
    openFolderWithFeedback(folder) { calls.push(folder); },
    $: id => (id === 'stageLogTip' ? tip : null),
    alert() {},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('openStageLogFolder'), ctx);

  ctx.openStageLogFolder(null);

  assert.equal(calls.length, 0, 'file 为空不得调用 openFolderWithFeedback');
});

/* ---------- openFolderWithFeedback ---------- */

function openFolderCtx(overrides) {
  const calls = { waits: 0, resolved: [], sidebar: [], closed: 0, fm: [], says: [] };
  const say = (t, c) => calls.says.push({ t: String(t), c: c || '' });
  const ctx = Object.assign({
    waitArchiveWrites: async () => { calls.waits += 1; },
    resolveExistingFolder: async folder => { calls.resolved.push(folder); return { folder, fellBack: false }; },
    openFolderViaFileManager: async (folder, s, fellBack) => { calls.fm.push({ folder, fellBack }); },
    window: { parent: {
      __dshOpenFolderInSidebar: folder => { calls.sidebar.push(folder); return true; },
      __dshCloseSideChat: () => { calls.closed += 1; },
    } },
  }, overrides || {});
  vm.createContext(ctx);
  vm.runInContext(extractFunction('openFolderWithFeedback'), ctx);
  return { ctx, calls, say };
}

test('openFolderWithFeedback：侧边栏桥成功时提示成功并关闭侧边会话窗', async () => {
  const { ctx, calls, say } = openFolderCtx();

  await ctx.openFolderWithFeedback('/a/b', say);

  assert.equal(calls.waits, 1, '应先等待日志落盘');
  assert.deepEqual(calls.resolved, ['/a/b'], '应预检目录存在性');
  assert.deepEqual(calls.sidebar, ['/a/b'], '应经侧边栏桥打开目标目录');
  assert.equal(calls.closed, 1, '侧边栏打开成功后应调用 __dshCloseSideChat 让出空间');
  assert.equal(calls.fm.length, 0, '侧边栏桥成功时不应回退服务端文件管理器');
  assert.ok(calls.says.some(x => x.t.startsWith('✓ 已在侧边栏打开 ')), '成功文案应以「✓ 已在侧边栏打开 」开头');
  assert.equal(calls.says[0].t, '正在等待日志落盘并打开目录…', '第一步应提示正在等待落盘');
});

test('openFolderWithFeedback：侧边栏桥不可用时回退服务端文件管理器', async () => {
  const { ctx, calls, say } = openFolderCtx({
    window: { parent: {
      __dshOpenFolderInSidebar: () => false,
      __dshCloseSideChat: () => { calls.closed += 1; },
    } },
  });

  await ctx.openFolderWithFeedback('/a/b', say);

  assert.deepEqual(calls.fm, [{ folder: '/a/b', fellBack: false }], '应回退 openFolderViaFileManager 打开目标目录');
  assert.equal(calls.closed, 0, '未走侧边栏桥不得关闭侧边会话窗');
  assert.ok(calls.says.some(x => x.t === '正在打开服务端文件管理器…'), '回退前应提示正在打开服务端文件管理器');
});

test('openFolderWithFeedback：目录不存在（含归档根目录）时提示且不打开', async () => {
  const { ctx, calls, say } = openFolderCtx({
    resolveExistingFolder: async folder => { calls.resolved.push(folder); return { folder: null }; },
  });

  await ctx.openFolderWithFeedback('/a/b', say);

  assert.ok(calls.says.some(x => x.t.startsWith('✗ 目录不存在（含归档根目录）：/a/b')), '应提示目录不存在（含归档根目录）');
  assert.equal(calls.sidebar.length, 0, '目录不存在不得调侧边栏桥');
  assert.equal(calls.fm.length, 0, '目录不存在不得回退文件管理器');
});

/* ---------- appendStageLogRow ---------- */

let elSeq = 0;
function makeEl(tag) {
  const el = {
    _seq: elSeq += 1,
    tagName: String(tag).toUpperCase(),
    id: '', className: '', textContent: '', title: '', value: '',
    style: {}, dataset: {}, attributes: {}, children: [], handlers: {},
    disabled: false, htmlIds: [], htmlDisabled: false,
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) {
      html = String(v);
      el.htmlIds = (html.match(/\bid="([^"]+)"/g) || []).map(s => s.slice(4, -1));
      el.htmlDisabled = /\bdisabled\b/.test(html);
    },
  });
  el.appendChild = child => { el.children.push(child); return child; };
  el.addEventListener = (type, fn) => { el.handlers[type] = fn; };
  el.setAttribute = (name, value) => { el.attributes[name] = String(value); };
  el.querySelector = () => null;
  return el;
}

function makeKv() {
  const kv = { children: [], appended: 0, inserted: [] };
  kv.appendChild = child => { kv.appended += 1; kv.children.push(child); return child; };
  kv.insertAdjacentHTML = (pos, html) => { kv.inserted.push(String(html)); };
  return kv;
}

function findIn(root, id) {
  for (const child of root.children || []) {
    if (child.id === id || child.attributes.id === id || child.htmlIds.includes(id)) return child;
    const hit = findIn(child, id);
    if (hit) return hit;
  }
  return null;
}

function isDisabled(el) {
  return el.disabled === true || 'disabled' in el.attributes || el.htmlDisabled;
}

function hasText(el, text) {
  return String(el.textContent).includes(text) || String(el.innerHTML).includes(text);
}

function appendRowCtx(extra) {
  const ctx = Object.assign({
    document: { createElement: tag => makeEl(tag) },
    esc: v => String(v === undefined || v === null ? '' : v),
    $: () => null,
    stageDetailAnalysis() {},
    openStageLogFolder() {},
  }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(extractFunction('appendStageLogRow'), ctx);
  return ctx;
}

test('appendStageLogRow：path 与 rec 都给时渲染完整日志行结构', () => {
  const ctx = appendRowCtx();
  const kv = makeKv();
  const rec = { tag: 'run-x', no: 1 };

  ctx.appendStageLogRow(kv, '/a/b/run-x-01-部署.log', rec);

  assert.equal(kv.inserted.length, 0, '应通过 appendChild 追加节点而非 innerHTML');
  const row = findIn(kv, 'stageLogRow');
  assert.ok(row, '应生成 #stageLogRow');
  const path = findIn(kv, 'stageLogPath');
  assert.ok(path, '应生成 #stageLogPath');
  assert.ok(hasText(path, '/a/b/run-x-01-部署.log'), '#stageLogPath 应展示日志文件路径');
  const aiBtn = findIn(kv, 'stageLogAiBtn');
  assert.ok(aiBtn, '应生成 #stageLogAiBtn');
  assert.ok(hasText(aiBtn, '🔍 AI 分析'), '#stageLogAiBtn 文案应为「🔍 AI 分析」');
  assert.ok(!isDisabled(aiBtn), '有分析记录时 AI 分析按钮不应禁用');
  const openBtn = findIn(kv, 'stageLogOpenBtn');
  assert.ok(openBtn, '应生成 #stageLogOpenBtn');
  assert.ok(hasText(openBtn, '📂 打开日志'), '#stageLogOpenBtn 文案应为「📂 打开日志」');
  assert.ok(!isDisabled(openBtn), '有日志路径时打开按钮不应禁用');
  const tipRow = findIn(kv, 'stageLogTipRow');
  assert.ok(tipRow, '应生成 #stageLogTipRow');
  assert.ok(tipRow.style.display === 'none' || String(tipRow.attributes.style || '').includes('display:none'), '#stageLogTipRow 初始应隐藏（display:none）');
  assert.ok(findIn(kv, 'stageLogTip'), '应生成 #stageLogTip');
});

test('appendStageLogRow：无 path 时打开按钮禁用，无 rec 时 AI 按钮禁用', () => {
  const ctx = appendRowCtx();
  const noPath = makeKv();
  ctx.appendStageLogRow(noPath, null, { tag: 'run-x' });
  assert.ok(isDisabled(findIn(noPath, 'stageLogOpenBtn')), '无 path 时 #stageLogOpenBtn 应禁用');
  assert.ok(!isDisabled(findIn(noPath, 'stageLogAiBtn')), '无 path 但有 rec 时 #stageLogAiBtn 不应禁用');

  const noRec = makeKv();
  ctx.appendStageLogRow(noRec, '/a/b/run-x-01-部署.log', null);
  assert.ok(isDisabled(findIn(noRec, 'stageLogAiBtn')), '无 rec 时 #stageLogAiBtn 应禁用');
  assert.ok(!isDisabled(findIn(noRec, 'stageLogOpenBtn')), '有 path 但无 rec 时 #stageLogOpenBtn 不应禁用');
});

test('appendStageLogRow：path 与 rec 皆空时不渲染任何节点', () => {
  const ctx = appendRowCtx();
  const kv = makeKv();

  ctx.appendStageLogRow(kv, null, null);

  assert.equal(kv.appended, 0, '皆空时 kv 不得新增子节点');
  assert.equal(kv.inserted.length, 0, '皆空时不得向 kv 注入 HTML');
});
