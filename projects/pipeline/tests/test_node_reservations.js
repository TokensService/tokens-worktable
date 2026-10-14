/* 节点预留（「节点」独立页签 + 按用户/日期时间段分配）的页面侧测试：
   - 静态契约：navNode 页签在 navEnv 之前；pageNode 容器持有节点环境卡片（DOM id 不变）、pageEnv 不再含 envTable；
     switchPage 有 node 分支并顺带 loadNodeReservations；绑定在尾部统一初始化区（const $ 声明之后，防 TDZ 回归）；
     预留数据不进配置导出（collectConfig 不引用 nodeReservations）。
   - 纯函数：reservationsForNode（过滤+按 start 排序）、fmtResTime（本地 MM-DD HH:mm）、
     envReservationInfo（覆盖判定 T==start 覆盖 / T==end 不覆盖、users 并集、until 取最早 end）、
     envReservedForOthers（admin 旁路 / 本人可用 / 他人拦截 / authReady=false 不拦）、envReservationIssue。
   - 渲染：renderEnvs「预留」列逐时段一行三列对齐（时间段 | 用户 | 备注，生效中整行高亮）与「分配」按钮、非 admin 只读弹窗；renderEnvMulti 未选中态禁用 + 徽标、
     已选中可取消、admin 不拦但显示徽标。
   - 弹窗保存：datetime-local → ISO UTC 转换、base 快照随 PUT 上送、409 刷新重开、403 alert 服务端 message。
   - 运行校验接入：pipelineDefaultRunIssue / runPipeline / submitPipelineRunDialog / addPlan 四处的预留拦截；
     租约 acquire 403 reserved → alert 服务端 message 并按启动失败收尾（不进入运行、不回队）。 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');
const J = x => JSON.parse(JSON.stringify(x));   // vm 沙盒产物与主 realm 原型不同，深比较前先归一化
const flush = () => new Promise(r => setImmediate(r));

function extractFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `pipeline.html 缺少函数 ${name}`);
  const bodyStart = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(match.index, i + 1); }
  }
  throw new Error(`无法提取函数 ${name}`);
}
/* 节点预留整段（含 let nodeReservations / authUsersCache / nodeResEdit 声明与全部函数） */
function resSection() {
  const start = source.indexOf('/* ---------- 节点预留');
  const end = source.indexOf('/* ---------- 节点预留结束 ---------- */', start);
  assert.ok(start >= 0 && end > start, 'pipeline.html 缺少节点预留实现区块');
  return source.slice(start, end);
}
/* 元素桩（与 test_env_selection_default_none.js 同款）：属性选择器查询 + 事件捕获 */
function elStub(tag) {
  const el = {
    tag: tag || 'div', style: {}, children: [], attributes: {}, _listeners: {},
    textContent: '', title: '', placeholder: '', value: '', type: '', className: '', autocomplete: '',
    checked: false, disabled: false,
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const sels = sel.split(',').map(s => s.trim()).filter(Boolean);
      const matchOne = (node, s) => {
        const m = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(s);
        if (!m) return false;
        const got = node.getAttribute(m[1]);
        if (got == null) return false;
        return m[2] === undefined || got === m[2];
      };
      const out = [];
      const walk = n => {
        if (!n || !n.children) return;
        n.children.forEach(c => {
          if (sels.some(s => matchOne(c, s))) out.push(c);
          walk(c);
        });
      };
      walk(this);
      return out;
    },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    fire(type, ev) { (this._listeners[type] || []).forEach(fn => fn(ev || { preventDefault() {}, stopPropagation() {} })); },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html || ''; },
    set(v) { this._html = v; this.children = []; },   // 清空子树（与真实 innerHTML='' 一致）
  });
  return el;
}
const envOf = (id, name, ip) => ({ id, name, ip: ip || '10.0.0.1', nodeIp: '', user: '', pass: '' });
/* 相对当前时刻的预留记录（覆盖中：start 一小时前、end 一小时后） */
const resNow = (id, nodeId, users, extra) => Object.assign({
  id, nodeId, users,
  start: new Date(Date.now() - 3600e3).toISOString(),
  end: new Date(Date.now() + 3600e3).toISOString(),
  note: '', createdBy: 'admin', createdAt: '', updatedAt: '',
}, extra || {});
const resFuture = (id, nodeId, users) => ({
  id, nodeId, users,
  start: new Date(Date.now() + 7200e3).toISOString(),
  end: new Date(Date.now() + 10800e3).toISOString(),
  note: '', createdBy: 'admin', createdAt: '', updatedAt: '',
});
/* 纯函数测试上下文：整段预留区块 + 可覆写全局
   （nodeReservations/authUsersCache/nodeResEdit 由区块内 let 声明，测试经 vm.runInContext 赋值） */
function pureCtx(globals) {
  const ctx = Object.assign({ environments: [], console }, globals || {});
  vm.createContext(ctx);
  vm.runInContext(resSection(), ctx);
  return ctx;
}

/* ==================== 静态契约 ==================== */
test('静态契约：navNode 页签位于 navSched 与 navEnv 之间，带 data-pagenav="node"', () => {
  const navSched = source.indexOf('id="navSched"');
  const navNode = source.indexOf('id="navNode"');
  const navEnv = source.indexOf('id="navEnv"');
  assert.ok(navSched > 0 && navNode > navSched && navEnv > navNode, 'navNode 应在 navSched 之后、navEnv 之前');
  assert.match(source, /<button id="navNode" class="dshell-btn dshell-btnGhost mini" data-pagenav="node">节点<\/button>/);
});

test('静态契约：pageNode 容器持有节点环境卡片（DOM id 不变），pageEnv 不再含节点环境卡片', () => {
  const pageNodeStart = source.indexOf('<div id="pageNode"');
  const pageNodeEnd = source.indexOf('<!-- /pageNode -->', pageNodeStart);
  const pageEnvStart = source.indexOf('<div id="pageEnv"');
  const pageEnvEnd = source.indexOf('<!-- /pageEnv -->', pageEnvStart);
  assert.ok(pageNodeStart > 0 && pageNodeEnd > pageNodeStart, '缺少 pageNode 容器');
  assert.ok(pageEnvStart > 0 && pageEnvEnd > pageEnvStart, '缺少 pageEnv 容器');
  const schedEnd = source.indexOf('</div><!-- /pageSched -->');
  assert.ok(schedEnd > 0 && pageNodeStart > schedEnd && pageNodeStart < pageEnvStart, 'pageNode 应位于 pageSched 与 pageEnv 之间');
  const nodeRegion = source.slice(pageNodeStart, pageNodeEnd);
  const envRegion = source.slice(pageEnvStart, pageEnvEnd);
  ['envTable', 'envAdd', 'envFilter', 'envInfoRefresh', 'gpuRefreshAll', 'envName', 'envIp', 'envNodeIp', 'envUser', 'envPass', 'envAllApply', 'envCancelEdit', 'envCount']
    .forEach(id => {
      assert.ok(nodeRegion.includes(`id="${id}"`), `pageNode 应包含节点环境卡片元素 #${id}`);
      assert.ok(!envRegion.includes(`id="${id}"`), `pageEnv 不应再包含 #${id}`);
    });
  assert.match(nodeRegion, /<th[^>]*>预留<\/th>/, 'envTable 表头应新增「预留」列');
  assert.match(nodeRegion, /预留.{0,30}不随「导入导出」/, '节点页说明行应注明预留数据不随配置导出');
  assert.ok(nodeRegion.indexOf('<th data-sort="name"') < nodeRegion.indexOf('>预留</th>'), '「预留」列在既有排序列之后，不动既有 data-sort');
});

test('静态契约：switchPage 有 node 分支并顺带刷新预留；navNode 绑定在尾部初始化区（const $ 之后，防 TDZ）', () => {
  const fn = extractFunction('switchPage');
  assert.ok(fn.includes("$('pageNode')"), 'switchPage 应显隐 pageNode');
  assert.ok(fn.includes("p==='node'"), 'switchPage 应有 node 分支');
  assert.ok(fn.includes("$('navNode')"), 'switchPage 应切换 navNode 高亮');
  assert.ok(fn.includes('loadNodeReservations()'), '切到节点页应顺带 loadNodeReservations()');
  const decl = source.indexOf('const $ =');
  const bind = source.indexOf("$('navNode').addEventListener('click', ()=>switchPage('node'))");
  assert.ok(decl >= 0 && bind > decl, 'navNode 绑定必须在 const $ 声明之后的尾部初始化区');
});

test('静态契约：nodeResDialog 弹窗结构（z-index 216-224 空档）与绑定齐全', () => {
  const start = source.indexOf('<div id="nodeResDialog"');
  assert.ok(start > 0, '缺少 nodeResDialog 弹窗');
  const end = source.indexOf('<!-- 收集普罗数据对话框', start);
  const html = source.slice(start, end > start ? end : undefined);
  assert.ok(/z-index:21[6-9]|z-index:22[0-4]/.test(html), '弹窗 z-index 应取 216-224 空档');
  ['nodeResTitle', 'nodeResReadonlyTip', 'nodeResClose', 'nodeResList', 'nodeResAddWindow', 'nodeResManualUser', 'nodeResManualAdd', 'nodeResTip', 'nodeResCancel', 'nodeResSave', 'nodeResCloseFooter']
    .forEach(id => assert.ok(html.includes(`id="${id}"`), `弹窗缺少 #${id}`));
  ['nodeResClose', 'nodeResCancel', 'nodeResCloseFooter', 'nodeResAddWindow', 'nodeResManualAdd', 'nodeResSave', 'nodeResDialog']
    .forEach(id => assert.ok(source.includes(`$('${id}').addEventListener`), `尾部初始化区缺少 ${id} 绑定`));
  const decl = source.indexOf('const $ =');
  assert.ok(source.indexOf("$('nodeResSave').addEventListener") > decl, '弹窗绑定须在 const $ 声明之后');
});

test('静态契约：预留数据不进 environments 条目、不进配置导出（collectConfig 不引用预留状态）', () => {
  const collect = extractFunction('collectConfig');
  assert.ok(!/nodeReservations|reservation/i.test(collect), 'collectConfig 不得携带预留数据');
  const norm = extractFunction('normalizeEnv');
  assert.ok(!/reservation/i.test(norm), 'normalizeEnv 不得携带预留字段');
});

/* ==================== 纯函数 ==================== */
test('reservationsForNode：按 nodeId 过滤并按 start 升序', () => {
  const ctx = pureCtx();
  vm.runInContext(`nodeReservations=${JSON.stringify([
    resNow('r2', 'env-a', ['u1'], { start: '2026-10-14T10:00:00.000Z', end: '2026-10-14T12:00:00.000Z' }),
    resNow('r1', 'env-a', ['u2'], { start: '2026-10-13T10:00:00.000Z', end: '2026-10-13T12:00:00.000Z' }),
    resNow('r3', 'env-b', ['u3']),
  ])}`, ctx);
  const out = ctx.reservationsForNode('env-a');
  assert.deepEqual(J(out).map(r => r.id), ['r1', 'r2'], '过滤 env-a 且按开始时间升序');
  assert.deepEqual(J(ctx.reservationsForNode('env-none')), [], '无预留返回空数组');
});

test('fmtResTime：ISO UTC → 本地 MM-DD HH:mm；非法输入返回空串', () => {
  const ctx = pureCtx();
  const d = new Date('2026-10-13T10:30:00.000Z');
  const p2 = n => String(n).padStart(2, '0');
  const expected = p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  assert.equal(ctx.fmtResTime('2026-10-13T10:30:00.000Z'), expected);
  assert.match(ctx.fmtResTime('2026-10-13T10:30:00.000Z'), /^\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(ctx.fmtResTime('not-a-date'), '');
});

test('envReservationInfo：无预留 / 覆盖中（users 并集、until 取最早 end）/ 未来时段不覆盖 / 边界 T==start 覆盖、T==end 不覆盖', () => {
  const ctx = pureCtx();
  vm.runInContext(`nodeReservations=${JSON.stringify([
    { id: 'r1', nodeId: 'env-a', users: ['u1', 'u2'], start: '2026-10-13T10:00:00.000Z', end: '2026-10-13T12:00:00.000Z' },
    { id: 'r2', nodeId: 'env-a', users: ['u2', 'u3'], start: '2026-10-13T11:00:00.000Z', end: '2026-10-13T13:00:00.000Z' },
    { id: 'r3', nodeId: 'env-a', users: ['u9'], start: '2026-10-15T10:00:00.000Z', end: '2026-10-15T12:00:00.000Z' },
  ])}`, ctx);
  const env = envOf('env-a', '开发');
  const T = s => Date.parse(s);
  const none = ctx.envReservationInfo(envOf('env-b', '生产'), T('2026-10-13T11:00:00.000Z'));
  assert.deepEqual(J(none), { reserved: false, users: [], until: null, windows: [] }, '无预留：reserved=false');

  const covering = ctx.envReservationInfo(env, T('2026-10-13T11:30:00.000Z'));
  assert.equal(covering.reserved, true, 'r1/r2 均覆盖该时刻');
  assert.deepEqual(J(covering.users), ['u1', 'u2', 'u3'], 'users 为覆盖记录并集（保持出现顺序去重）');
  assert.equal(covering.until, '2026-10-13T12:00:00.000Z', 'until 取覆盖记录里最早的 end');
  assert.equal(covering.windows.length, 2, '未来时段 r3 不算覆盖');

  assert.equal(ctx.envReservationInfo(env, T('2026-10-13T10:00:00.000Z')).reserved, true, 'T==start 覆盖');
  assert.equal(ctx.envReservationInfo(env, T('2026-10-13T12:00:00.000Z')).windows.some(w => w.id === 'r1'), false, 'T==end 不覆盖');
  const futureOnly = ctx.envReservationInfo(env, T('2026-10-14T00:00:00.000Z'));
  assert.equal(futureOnly.reserved, false, '未来时段不算覆盖中');
});

test('envReservedForOthers：admin 旁路、被预留用户本人可用、他人不可用、authReady=false 不拦', () => {
  const mk = globals => {
    const ctx = pureCtx(Object.assign({ authReady: true, currentUsername: 'me', currentUserIsAdmin: false }, globals));
    vm.runInContext(`nodeReservations=${JSON.stringify([resNow('r1', 'env-a', ['u1', 'u2'])])}`, ctx);
    return ctx;
  };
  const env = envOf('env-a', '开发');
  assert.equal(mk({}).envReservedForOthers(env), true, '他人被预留：非 admin 拦截');
  assert.equal(mk({ currentUsername: 'u1' }).envReservedForOthers(env), false, '被预留用户本人可用');
  assert.equal(mk({ currentUserIsAdmin: true }).envReservedForOthers(env), false, 'admin 全权旁路');
  assert.equal(mk({ authReady: false }).envReservedForOthers(env), false, 'authReady=false（登录态探测在途）不拦，防误灰');
  assert.equal(mk({ currentUsername: '' }).envReservedForOthers(env), false, '无登录身份（无 auth 服务的 token 共享模式）不拦，与服务端「无 auth 不强制」口径一致');
  assert.equal(mk({}).envReservedForOthers(envOf('env-b', '生产')), false, '无预留节点不拦');
});

test('envReservationIssue：逐个列出被拦节点明细；全部可用返回 null', () => {
  const ctx = pureCtx({ authReady: true, currentUsername: 'me', currentUserIsAdmin: false });
  vm.runInContext(`nodeReservations=${JSON.stringify([resNow('r1', 'env-a', ['u1', 'u2'])])}`, ctx);
  const issue = ctx.envReservationIssue([envOf('env-a', '开发', '10.0.0.1'), envOf('env-b', '生产', '10.0.0.2')]);
  assert.ok(issue, 'env-a 被预留给他人：应有拦截明细');
  assert.match(issue, /开发\(10\.0\.0\.1\) 预留给 u1、u2，至 \d{2}-\d{2} \d{2}:\d{2}/, '明细含 名称(ip) 预留给 用户，至 时间');
  assert.ok(!issue.includes('生产'), '可用节点不出现在明细里');
  assert.equal(ctx.envReservationIssue([envOf('env-b', '生产', '10.0.0.2')]), null, '全部可用返回 null');
  assert.equal(ctx.envReservationIssue([]), null, '空列表返回 null（未选节点即无目标节点运行，不拦）');
});

/* ==================== loadNodeReservations ==================== */
test('loadNodeReservations：GET 成功后全量替换并重绘节点表与多选面板；失败静默保留旧值', async () => {
  const calls = { envs: 0, options: 0 };
  const list = [resNow('r1', 'env-a', ['u1'])];
  const ctx = pureCtx({
    renderEnvs: () => { calls.envs++; },
    renderEnvOptions: () => { calls.options++; },
    fetch: async url => {
      assert.equal(url, '/api/worktable/pipeline/reservations', '预留拉取走既定 GET 路由');
      return { ok: true, status: 200, json: async () => ({ reservations: J(list) }) };
    },
  });
  await ctx.loadNodeReservations();
  assert.deepEqual(J(vm.runInContext('nodeReservations', ctx)), J(list), '成功响应全量替换本地');
  assert.equal(calls.envs, 1);
  assert.equal(calls.options, 1);

  const fail = pureCtx({ fetch: async () => { throw new Error('网络断开'); } });
  vm.runInContext(`nodeReservations=${JSON.stringify(list)}`, fail);
  await fail.loadNodeReservations();
  assert.deepEqual(J(vm.runInContext('nodeReservations', fail)), J(list), '拉取异常静默保留旧值');

  const notOk = pureCtx({ fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  vm.runInContext(`nodeReservations=${JSON.stringify(list)}`, notOk);
  await notOk.loadNodeReservations();
  assert.deepEqual(J(vm.runInContext('nodeReservations', notOk)), J(list), '非 ok 响应静默保留旧值');
});

/* ==================== renderEnvs「预留」列与弹窗 ==================== */
/* envTable/tbody 桩：tbody.querySelectorAll 从行 innerHTML 解析 data-* 按钮（同 test_pipeline_run_dialog 的 FakePanel 思路）；
   按钮对象按 attr=value 缓存——renderEnvs 绑定循环与测试后续查询拿到同一对象，点击回调才可触发 */
function envTableFixture() {
  const ths = ['name', 'ip', 'user', 'gpu'].map(k => ({
    getAttribute: n => (n === 'data-sort' ? k : null),
    querySelector: () => ({ textContent: '' }),
  }));
  const tbody = elStub('tbody');
  const btnCache = new Map();
  tbody.querySelectorAll = sel => {
    const m = /^\[data-([a-z]+)\]$/.exec(sel);
    if (!m) return [];
    const attr = m[1];
    const found = [];
    tbody.children.forEach(tr => {
      const re = new RegExp(`data-${attr}="([^"]*)"`, 'g');
      let mm;
      while ((mm = re.exec(tr.innerHTML))) {
        const val = mm[1], key = attr + '=' + val;
        if (!btnCache.has(key)) {
          const b = { _h: {}, getAttribute: () => val };
          b.addEventListener = (t, h) => { b._h[t] = h; };
          b.click = () => { if (b._h.click) b._h.click(); };
          btnCache.set(key, b);
        }
        found.push(btnCache.get(key));
      }
    });
    return found;
  };
  const table = elStub('table');
  table.querySelector = sel => (sel === 'tbody' ? tbody : null);
  table.querySelectorAll = sel => (sel === 'th[data-sort]' ? ths : []);
  return { table, tbody };
}
/* 弹窗元素桩集合（openNodeResDialog/saveNodeResDialog 触及的全部 id） */
function dialogEls() {
  return {
    nodeResDialog: elStub(), nodeResTitle: elStub(), nodeResReadonlyTip: elStub(),
    nodeResClose: elStub(), nodeResList: elStub(), nodeResAddWindow: elStub(),
    nodeResManualUser: elStub(), nodeResManualAdd: elStub(), nodeResTip: elStub(),
    nodeResCancel: elStub(), nodeResSave: elStub(), nodeResCloseFooter: elStub(),
  };
}
function renderEnvsCtx(globals, envs) {
  const { table, tbody } = envTableFixture();const els = Object.assign({ envCount: elStub(), envTable: table }, dialogEls());
  const ctx = pureCtx(Object.assign({
    environments: envs,
    gpuStatus: {}, esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    gpuCellFull: () => 'GPUCELL',
    envSort: { key: null, dir: 1 }, envFilterText: '',
    document: { createElement: tag => elStub(tag) },
    $: id => els[id] || null,
    authReady: true, currentUsername: 'me', currentUserIsAdmin: false,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ users: [{ username: 'u1' }, { username: 'u2' }, { username: 'me' }] }) }),
    alert: () => {}, toast: () => {},
  }, globals || {}));
  vm.runInContext(['gpuBusy', 'envFilterMatch', 'envSortVal', 'envSortList', 'renderEnvs'].map(extractFunction).join('\n'), ctx);
  return { ctx, els, tbody };
}

test('renderEnvs「预留」列：逐时段一行三列对齐（时间段 | 用户 | 备注），生效中整行高亮无「预留中」文案 / 无预留 —；行内含「分配」按钮', () => {
  const p2 = n => String(n).padStart(2, '0');
  const fmt = d => p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  const now = Date.now();
  const activeRange = fmt(new Date(now - 3600e3)) + ' ~ ' + fmt(new Date(now + 3600e3));
  const { ctx, tbody } = renderEnvsCtx(null, [envOf('env-a', '开发', '10.0.0.1'), envOf('env-b', '生产', '10.0.0.2'), envOf('env-c', '测试', '10.0.0.3')]);
  vm.runInContext(`nodeReservations=${JSON.stringify([
    resNow('r1', 'env-c', ['u1', 'u2'], { note: '专项压测' }),
    resFuture('r2', 'env-b', ['u1']), resFuture('r3', 'env-b', ['u3']),
  ])}`, ctx);
  ctx.renderEnvs();
  assert.equal(tbody.children.length, 3);
  const htmlOf = id => tbody.children[['env-a', 'env-b', 'env-c'].indexOf(id)].innerHTML;
  /* 生效中：时间段/用户/备注三格均 st-run 高亮，无「预留中」文字前缀（保持各行左缘对齐） */
  const cHtml = htmlOf('env-c');
  assert.ok(!cHtml.includes('预留中'), '生效中行不再带「预留中」文案');
  const cHi = (cHtml.match(/<span style="white-space:nowrap;color:var\(--st-run\);font-weight:600;" title="当前生效的预留时段">/g) || []).length;
  assert.equal(cHi, 3, '生效中时段的三格整行高亮');
  assert.ok(cHtml.includes(`>${activeRange}</span>`), '时间段格内容');
  assert.ok(cHtml.includes('>u1、u2</span>'), '用户格内容');
  assert.ok(cHtml.includes('>专项压测</span>'), '备注格内容');
  /* 未来时段：每时段一行三格、普通样式，列经网格对齐 */
  assert.ok(htmlOf('env-b').includes('display:grid'), '多时段经网格容器对齐列');
  const bCells = (htmlOf('env-b').match(/<span style="white-space:nowrap;">[^<]*<\/span>/g) || []).length;
  assert.equal(bCells, 6, '两个未来时段 × 三格');
  assert.ok(htmlOf('env-b').includes('>u1</span>') && htmlOf('env-b').includes('>u3</span>'), '各行含对应用户');
  assert.ok(!htmlOf('env-b').includes('预留中') && !htmlOf('env-b').includes('个时段'), '未来时段无预留中标记、不再折叠为时段数');
  /* 无预留显示 — */
  assert.ok(/<span class="dshell-muted">—<\/span>/.test(htmlOf('env-a')), '无预留显示 —');
  ['env-a', 'env-b', 'env-c'].forEach(id => assert.ok(htmlOf(id).includes(`data-envres="${id}"`), `行内应有「分配」按钮（data-envres=${id}）`));
});

test('renderEnvs「预留」列：已结束时段整行置灰并在备注格后缀（已结束）；多时段按开始时间升序逐行排列', () => {
  const { ctx, tbody } = renderEnvsCtx(null, [envOf('env-d', '归档', '10.0.0.4')]);
  const past = { id: 'r0', nodeId: 'env-d', users: ['old'], start: new Date(Date.now() - 7200e3).toISOString(), end: new Date(Date.now() - 3600e3).toISOString(), note: '上周占用', createdBy: 'admin', createdAt: '', updatedAt: '' };
  vm.runInContext(`nodeReservations=${JSON.stringify([
    resFuture('r2', 'env-d', ['u3']),
    past,
    resNow('r1', 'env-d', ['u1'], { note: '进行中备注' }),
  ])}`, ctx);
  ctx.renderEnvs();
  const html = tbody.children[0].innerHTML;
  /* 升序：已结束（最早）→ 生效中 → 未来 */
  const iPast = html.indexOf('上周占用'), iActive = html.indexOf('进行中备注'), iFuture = html.indexOf('>u3</span>');
  assert.ok(iPast >= 0 && iActive > iPast && iFuture > iActive, '时段按开始时间升序逐行排列');
  const mutedCells = (html.match(/<span class="dshell-muted" style="white-space:nowrap;" title="已结束的预留时段">/g) || []).length;
  assert.equal(mutedCells, 3, '已结束时段整行三格置灰');
  assert.ok(html.includes('>上周占用（已结束）</span>'), '已结束时段在备注格后缀（已结束）');
  const hiCells = (html.match(/color:var\(--st-run\);font-weight:600;/g) || []).length;
  assert.equal(hiCells, 3, '生效中时段整行三格高亮');
  assert.ok(!html.includes('预留中'), '不再出现「预留中」文案');
});

test('renderEnvs「分配」按钮：admin 点击打开可编辑弹窗；非 admin 打开只读形态（输入禁用、无保存按钮、标题旁注明）', async () => {
  const envs = [envOf('env-c', '测试', '10.0.0.3')];
  /* 非 admin 只读 */
  const plain = renderEnvsCtx(null, envs);
  vm.runInContext(`nodeReservations=${JSON.stringify([resNow('r1', 'env-c', ['u1'], { note: '占用说明' })])}`, plain.ctx);
  plain.ctx.renderEnvs();
  const btnPlain = plain.tbody.querySelectorAll('[data-envres]')[0];
  assert.ok(btnPlain && btnPlain._h.click, '分配按钮已绑定点击');
  btnPlain.click();
  await flush(); await flush();   // openNodeResDialog 内含 ensureAuthUsers 异步
  assert.equal(plain.els.nodeResDialog.style.display, 'flex', '非 admin 也可打开弹窗（只读查看）');
  assert.match(plain.els.nodeResTitle.textContent, /节点预留分配 — 测试（10\.0\.0\.3）/, '标题含节点名称与 IP');
  assert.equal(plain.els.nodeResReadonlyTip.style.display, '', '标题旁注明只读');
  assert.equal(plain.els.nodeResSave.style.display, 'none', '只读形态无保存按钮');
  assert.equal(plain.els.nodeResCancel.style.display, 'none', '只读形态无取消按钮');
  assert.equal(plain.els.nodeResCloseFooter.style.display, '', '只读形态底栏只留「关闭」');
  const inputs = plain.els.nodeResList.querySelectorAll('[data-res-start],[data-res-end],[data-res-user],[data-res-note]');
  assert.ok(inputs.length >= 4, '只读弹窗仍展示时段明细');
  assert.ok(inputs.every(el => el.disabled === true), '只读形态全部输入禁用');
  assert.equal(plain.els.nodeResList.querySelectorAll('[data-res-del]').length, 0, '只读形态无「删除本时段」按钮');

  /* admin 可编辑 */
  const admin = renderEnvsCtx({ currentUserIsAdmin: true, currentUsername: 'admin' }, envs);
  vm.runInContext(`nodeReservations=${JSON.stringify([resNow('r1', 'env-c', ['u1'], { note: '占用说明' })])}`, admin.ctx);
  admin.ctx.renderEnvs();
  admin.tbody.querySelectorAll('[data-envres]')[0].click();
  await flush(); await flush();
  assert.equal(admin.els.nodeResReadonlyTip.style.display, 'none', 'admin 不显示只读注明');
  assert.equal(admin.els.nodeResSave.style.display, '', 'admin 有保存按钮');
  const adminInputs = admin.els.nodeResList.querySelectorAll('[data-res-start],[data-res-end],[data-res-note]');
  assert.ok(adminInputs.length >= 3 && adminInputs.every(el => el.disabled === false), 'admin 输入可编辑');
  assert.equal(admin.els.nodeResList.querySelectorAll('[data-res-del]').length, 1, 'admin 有「删除本时段」按钮');
});

/* ==================== renderEnvMulti 选择拦截 ==================== */
function envMultiCtx(globals) {
  const btn = elStub(), panel = elStub();
  const ctx = pureCtx(Object.assign({
    environments: [envOf('env-a', '开发', '10.0.0.1'), envOf('env-b', '生产', '10.0.0.2')],
    gpuStatus: {}, gpuBusy: () => false, esc: s => String(s),
    document: { createElement: tag => elStub(tag) },
    $: id => ({ envMultiBtn: btn, envMultiPanel: panel })[id] || null,
    envMultiSearch: {}, envMultiSelSort: {},
    authReady: true, currentUsername: 'me', currentUserIsAdmin: false,
  }, globals || {}));
  vm.runInContext(['envMultiFilterMatch', 'envMultiSortVal', 'envMultiSortList', 'renderEnvMulti'].map(extractFunction).join('\n'), ctx);
  vm.runInContext(`nodeReservations=${JSON.stringify([resNow('r1', 'env-b', ['u1', 'u2'])])}`, ctx);
  return { ctx, btn, panel };
}
const cbOf = (panel, id) => panel.querySelectorAll('[data-envcb]').find(c => c.getAttribute('data-envcb') === id);
const badgeOf = (panel, id) => {
  const lab = panel.querySelectorAll('[data-envopt]').find(l => l.getAttribute('data-envopt') === id);
  return lab ? lab.children.find(c => c.textContent && c.textContent.indexOf('预留中') >= 0) : null;
};

test('renderEnvMulti：被预留给他人的节点未选中态禁用 + 灰色徽标；已选中的保留可取消勾选', () => {
  const { ctx, panel } = envMultiCtx();
  let current = [];
  const opts = { btnId: 'envMultiBtn', panelId: 'envMultiPanel', getIds: () => current, setIds: ids => { current = ids.slice(); } };
  ctx.renderEnvMulti(opts);
  assert.equal(cbOf(panel, 'env-b').disabled, true, '被预留给他人的节点未选中态禁用');
  assert.equal(cbOf(panel, 'env-a').disabled, false, '无预留节点正常可选');
  const badge = badgeOf(panel, 'env-b');
  assert.ok(badge, '被拦节点行附徽标');
  assert.match(badge.textContent, /^预留中：u1、u2（至 \d{2}-\d{2} \d{2}:\d{2}）$/, '徽标文案 预留中：用户（至 时间）');

  current = ['env-b'];   // 已被预留前选中的节点：保留可取消勾选（便于用户摘掉）
  ctx.renderEnvMulti(opts);
  assert.equal(cbOf(panel, 'env-b').disabled, false, '已选中的被拦节点不禁用（可取消勾选）');
  cbOf(panel, 'env-b').checked = false;
  cbOf(panel, 'env-b').fire('change');
  assert.deepEqual(current, [], '已选中的被拦节点可取消勾选摘掉');
});

test('renderEnvMulti：admin 不被拦截但仍显示预留信息徽标；登录态探测在途不拦', () => {
  const admin = envMultiCtx({ currentUserIsAdmin: true, currentUsername: 'admin' });
  admin.ctx.renderEnvMulti({ btnId: 'envMultiBtn', panelId: 'envMultiPanel', getIds: () => [], setIds: () => {} });
  assert.equal(cbOf(admin.panel, 'env-b').disabled, false, 'admin 不被拦截');
  assert.ok(badgeOf(admin.panel, 'env-b'), 'admin 仍显示预留信息徽标');

  const pending = envMultiCtx({ authReady: false });
  pending.ctx.renderEnvMulti({ btnId: 'envMultiBtn', panelId: 'envMultiPanel', getIds: () => [], setIds: () => {} });
  assert.equal(cbOf(pending.panel, 'env-b').disabled, false, 'authReady=false（探测在途）不拦，防误灰');
});

/* ==================== 预留弹窗保存 ==================== */
function dialogCtx(globals, fetchImpl) {
  const els = dialogEls();
  const requests = [], alerts = [], toasts = [];
  const ctx = pureCtx(Object.assign({
    environments: [envOf('env-a', '开发', '10.0.0.1')],
    document: { createElement: tag => elStub(tag) },
    $: id => els[id] || null,
    authReady: true, currentUsername: 'admin', currentUserIsAdmin: true,
    renderEnvs: () => { calls.envs++; }, renderEnvOptions: () => { calls.options++; },
    fetch: fetchImpl,
    alert: m => alerts.push(String(m)), toast: m => toasts.push(String(m)),
    encodeURIComponent,
  }, globals || {}));
  const calls = { envs: 0, options: 0 };
  return { ctx, els, requests, alerts, toasts, calls };
}
const okUsersFetch = async url => {
  if (url === '/auth/users') return { ok: true, status: 200, json: async () => ({ users: [{ username: 'u1' }, { username: 'u2' }, { username: 'admin', current: true }] }) };
  throw new Error('unexpected fetch ' + url);
};

test('预留弹窗保存：datetime-local 值转 ISO UTC、base 快照随 PUT 上送，成功后全量替换本地并重绘', async () => {
  const existing = [resNow('r1', 'env-a', ['u1'], { start: '2026-10-13T10:00:00.000Z', end: '2026-10-13T12:00:00.000Z', note: 'n1' })];
  const fresh = [resNow('r1', 'env-a', ['u1', 'u2'], { start: '2026-10-14T00:00:00.000Z', end: '2026-10-14T02:00:00.000Z' })];
  const requests = [];
  const h = dialogCtx(null, async (url, opts) => {
    if (url === '/auth/users') return okUsersFetch(url);
    requests.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ reservations: J(fresh) }) };
  });
  vm.runInContext(`nodeReservations=${JSON.stringify(existing)}`, h.ctx);
  await h.ctx.openNodeResDialog('env-a');
  assert.equal(h.els.nodeResDialog.style.display, 'flex');
  const startInp = h.els.nodeResList.querySelector('[data-res-start="0"]');
  const endInp = h.els.nodeResList.querySelector('[data-res-end="0"]');
  assert.match(startInp.value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, '打开时 ISO UTC 回填为本地 datetime-local 值');
  assert.equal(new Date(startInp.value).toISOString(), '2026-10-13T10:00:00.000Z', '回填值往返一致');

  startInp.value = '2026-10-14T08:00'; startInp.fire('change');
  endInp.value = '2026-10-14T10:00'; endInp.fire('change');
  const cbU2 = h.els.nodeResList.querySelectorAll('[data-res-user="0"]').find(c => c.value === 'u2');
  assert.ok(cbU2, '候选用户含 /auth/users 提供的 u2');
  cbU2.checked = true; cbU2.fire('change');
  const note = h.els.nodeResList.querySelector('[data-res-note="0"]');
  note.value = '巡检占用'; note.fire('input');

  await h.ctx.saveNodeResDialog();
  assert.equal(requests.length, 1, '发出一次 PUT');
  assert.equal(requests[0].url, '/api/worktable/pipeline/reservations/env-a', 'PUT 到该节点的预留路由');
  assert.equal(requests[0].opts.method, 'PUT');
  const body = J(JSON.parse(requests[0].opts.body));
  assert.equal(body.windows.length, 1);
  assert.equal(body.windows[0].start, new Date('2026-10-14T08:00').toISOString(), 'datetime-local 经 new Date(v).toISOString() 转 UTC');
  assert.equal(body.windows[0].end, new Date('2026-10-14T10:00').toISOString());
  assert.deepEqual(body.windows[0].users.sort(), ['u1', 'u2'], '勾选用户随窗口上送');
  assert.equal(body.windows[0].note, '巡检占用');
  assert.deepEqual(body.base, J(existing), 'base=打开弹窗时该节点窗口快照（供服务端 409 比对）');
  assert.deepEqual(J(vm.runInContext('nodeReservations', h.ctx)), J(fresh), '成功响应全量替换本地');
  assert.equal(h.els.nodeResDialog.style.display, 'none', '成功后关闭弹窗');
  assert.equal(h.calls.envs, 1, '重绘节点表');
  assert.equal(h.calls.options, 1, '重绘环境多选面板');
  assert.equal(h.toasts.length, 1, 'toast 成功');
});

test('预留弹窗保存校验：开始不早于结束 / 无用户时 alert 指明哪段，不发请求', async () => {
  const requests = [];
  const h = dialogCtx(null, async (url, opts) => {
    if (url === '/auth/users') return okUsersFetch(url);
    requests.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ reservations: [] }) };
  });
  await h.ctx.openNodeResDialog('env-a');
  vm.runInContext(`nodeResEdit.windows.push({id:'', start:'2026-10-14T10:00', end:'2026-10-14T08:00', users:['u1'], note:''})`, h.ctx);
  h.ctx.renderNodeResWindows();
  await h.ctx.saveNodeResDialog();
  assert.match(h.alerts[0], /第 1 个时段/, '开始>=结束：alert 指明哪段');
  assert.equal(requests.length, 0, '校验不过不发请求');

  h.alerts.length = 0;
  vm.runInContext(`nodeResEdit.windows=[{id:'', start:'2026-10-14T08:00', end:'2026-10-14T10:00', users:[], note:''}]`, h.ctx);
  h.ctx.renderNodeResWindows();
  await h.ctx.saveNodeResDialog();
  assert.match(h.alerts[0], /第 1 个时段.*至少.*1 个用户/, '无用户：alert 指明哪段至少 1 个用户');
  assert.equal(requests.length, 0);
});

test('预留弹窗保存：409 刷新最新数据后重开弹窗；403 alert 服务端 message', async () => {
  const fresh = [resNow('r9', 'env-a', ['u9'], { note: '他端刚改' })];
  let putCount = 0;
  const h409 = dialogCtx(null, async (url, opts) => {
    if (url === '/auth/users') return okUsersFetch(url);
    if (opts && opts.method === 'PUT') { putCount++; return { ok: false, status: 409, json: async () => ({ error: 'conflict' }) }; }
    return { ok: true, status: 200, json: async () => ({ reservations: J(fresh) }) };   // GET /reservations 刷新
  });
  await h409.ctx.openNodeResDialog('env-a');
  vm.runInContext(`nodeResEdit.windows.push({id:'', start:'2026-10-14T08:00', end:'2026-10-14T10:00', users:['u1'], note:''})`, h409.ctx);
  h409.ctx.renderNodeResWindows();
  await h409.ctx.saveNodeResDialog();
  assert.equal(putCount, 1);
  assert.match(h409.alerts[0], /预留已被他人修改，已为您刷新最新数据/);
  assert.deepEqual(J(vm.runInContext('nodeReservations', h409.ctx)), J(fresh), '409 后重新拉取最新数据');
  assert.equal(h409.els.nodeResDialog.style.display, 'flex', '重开弹窗展示最新数据');
  assert.equal(h409.els.nodeResList.querySelectorAll('[data-res-note="0"]').length, 1);
  assert.equal(h409.els.nodeResList.querySelector('[data-res-note="0"]').value, '他端刚改', '重开弹窗显示他端最新内容');

  const h403 = dialogCtx(null, async (url, opts) => {
    if (url === '/auth/users') return okUsersFetch(url);
    return { ok: false, status: 403, json: async () => ({ error: 'forbidden', message: '仅 admin 可分配节点' }) };
  });
  await h403.ctx.openNodeResDialog('env-a');
  vm.runInContext(`nodeResEdit.windows.push({id:'', start:'2026-10-14T08:00', end:'2026-10-14T10:00', users:['u1'], note:''})`, h403.ctx);
  h403.ctx.renderNodeResWindows();
  await h403.ctx.saveNodeResDialog();
  assert.match(h403.alerts[0], /仅 admin 可分配节点/, '403 alert 服务端 message');
  assert.equal(h403.els.nodeResDialog.style.display, 'flex', '403 不关闭弹窗');
});

test('预留弹窗：/auth/users 拉取失败时候选回退为现有预留用户名并集 + 当前用户名，并提示可手输', async () => {
  const h = dialogCtx(null, async url => {
    if (url === '/auth/users') throw new Error('404');
    throw new Error('unexpected fetch ' + url);
  });
  vm.runInContext(`nodeReservations=${JSON.stringify([resNow('r1', 'env-a', ['olduser'])])}`, h.ctx);
  await h.ctx.openNodeResDialog('env-a');
  assert.match(h.els.nodeResTip.textContent, /用户列表拉取失败/, '失败提示可手输');
  const values = h.els.nodeResList.querySelectorAll('[data-res-user="0"]').map(c => c.value);
  assert.ok(values.includes('olduser'), '候选含现有预留用户名');
  assert.ok(values.includes('admin'), '候选含当前用户名');
});

/* ==================== 运行校验接入 ==================== */
test('pipelineDefaultRunIssue：默认环境被预留给他人时追加预留检查；有环境覆盖时不查默认口径', () => {
  const ctx = pureCtx({
    environments: [envOf('env-a', '开发', '10.0.0.1'), envOf('env-b', '生产', '10.0.0.2')],
    repositories: [],
    PIPELINE_DEFAULT_PRESET_KEYS: ['cleanup', 'check', 'profiling'],   /* normalizePipelineDefaults 回退白名单（无 presetDefOf 的 vm 沙盒口径） */
    authReady: true, currentUsername: 'me', currentUserIsAdmin: false,
  });
  vm.runInContext(`nodeReservations=${JSON.stringify([resNow('r1', 'env-b', ['u1'])])}`, ctx);
  vm.runInContext(extractFunction('pipelineDefaultStringList') + '\n' + extractFunction('normalizePipelineDefaults') + '\n' + extractFunction('pipelineDefaultRunIssue'), ctx);
  const pl = { defaults: { environmentIds: ['env-b'], repositoryId: '', branch: 'main' } };
  const issue = ctx.pipelineDefaultRunIssue(pl);
  assert.match(issue, /预留给 u1/, '默认环境被预留：issue 含预留明细');
  assert.equal(ctx.pipelineDefaultRunIssue(pl, { envs: [ctx.environments[0]] }), '', '有环境覆盖时不查默认环境（由 runPipeline 对实际 envs 检查）');
  assert.equal(ctx.pipelineDefaultRunIssue({ defaults: { environmentIds: ['env-a'], repositoryId: '', branch: 'main' } }), '', '默认环境可用返回空串');
});

test('runPipeline：本次实际 envs 被预留给他人时 alert 并 return reserved，不进入运行', () => {
  const alerts = [], started = [];
  const envB = envOf('env-b', '生产', '10.0.0.2');
  const pipeline = { id: 'pl-1', name: 'PL', stages: [{ id: 's1', sched: {} }] };
  const ctx = pureCtx({
    environments: [envB], repositories: [],
    authReady: true, currentUsername: 'me', currentUserIsAdmin: false,
    findPipeline: () => pipeline, curPipeline: () => pipeline, curPipelineId: 'pl-1',
    resolvePipelineRunOptions: (pl, opts) => opts,
    pipelineDefaultRunIssue: () => '',
    $: () => ({ value: '' }), alert: m => alerts.push(String(m)),
    resolveRepo: () => ({ id: 'r', name: 'r' }), curEnvs: () => [envB], resolveEnv: v => envB,
    curStrategy: () => '', selectedPresetKeys: () => [], DEFAULT_IMAGE: 'img',
    submitServerRun: item => started.push(item),
    Date, Math,
  });
  vm.runInContext(`nodeReservations=${JSON.stringify([resNow('r1', 'env-b', ['u1'])])}`, ctx);
  vm.runInContext(extractFunction('runPipeline'), ctx);
  assert.equal(ctx.runPipeline({ pipelineId: 'pl-1', envs: [envB], by: 'me' }), 'reserved', '被预留：返回 reserved');
  assert.match(alerts[0], /预留给 u1/, 'alert 预留明细');
  assert.equal(started.length, 0, '不进入运行');

  vm.runInContext(`nodeReservations=[]`, ctx);
  assert.equal(ctx.runPipeline({ pipelineId: 'pl-1', envs: [envB], by: 'me' }), 'submitted', '无预留时正常提交');
  assert.equal(started.length, 1);
});

test('submitPipelineRunDialog：弹窗选中节点被预留给他人时 alert 明细并保持弹窗打开（不提交运行）', () => {
  const alerts = [], runs = [];
  const envB = envOf('env-b', '生产', '10.0.0.2');
  const els = {
    pipelineRunDialog: { style: { display: 'flex' } },
    pipelineRunPresets: { querySelectorAll: () => [] },
    pipelineRunRepo: { value: 'repo-a' },
    pipelineRunBranch: { value: 'main' },
    pipelineRunStrategy: { value: '' },
  };
  const ctx = pureCtx({
    environments: [envB], repositories: [{ id: 'repo-a', name: 'A' }],
    pipelineRunDialogPipelineId: 'pl-1', pipelineRunDialogEnvIds: ['env-b'],
    authReady: true, currentUsername: 'me', currentUserIsAdmin: false,
    findPipeline: id => ({ id }), $: id => els[id] || null,
    runPipeline: o => { runs.push(o); return 'submitted'; },
    closePipelineRunDialog: () => { els.pipelineRunDialog.style.display = 'none'; },
    flashRunTip: () => {},
    alert: m => alerts.push(String(m)),
  });
  vm.runInContext(`nodeReservations=${JSON.stringify([resNow('r1', 'env-b', ['u1'])])}`, ctx);
  vm.runInContext(extractFunction('collectPipelineRunDialogOptions') + '\n' + extractFunction('submitPipelineRunDialog'), ctx);
  ctx.submitPipelineRunDialog();
  assert.match(alerts[0], /生产\(10\.0\.0\.2\) 预留给 u1/, 'alert 被拦节点明细');
  assert.equal(runs.length, 0, '不提交运行');
  assert.equal(els.pipelineRunDialog.style.display, 'flex', '弹窗保持打开');

  vm.runInContext(`nodeReservations=[]`, ctx);
  ctx.submitPipelineRunDialog();
  assert.equal(runs.length, 1, '无预留时正常提交');
});

test('addPlan：定时目标节点被预留给他人时 alert 明细并不创建计划', () => {
  const alerts = [];
  const envB = envOf('env-b', '生产', '10.0.0.2');
  const els = {
    runSched: { value: 'once' }, schedBy: { value: 'me' }, schedPipeline: { value: 'pl-1' },
    schedRepo: { value: 'repo-1' }, schedBranch: { value: 'main' }, schedStrategy: { value: '' },
    schedCleanupEnv: { checked: false }, runSchedAt: { value: '2099-01-01T00:00' },
  };
  const ctx = pureCtx({
    console, serverPlans: [], DEFAULT_IMAGE: 'img',
    authReady: true, currentUsername: 'me', currentUserIsAdmin: false,
    $: id => els[id] || null,
    findPipeline: id => ({ id, name: 'p', stages: [{ id: 's1' }] }),
    curPipeline: () => ({ id: 'pl-1', name: 'p', stages: [] }),
    schedEnvs: () => [envB],
    pushPlans: () => {}, renderPlanList: () => {},
    alert: m => alerts.push(String(m)),
  });
  vm.runInContext(`nodeReservations=${JSON.stringify([resNow('r1', 'env-b', ['u1'])])}`, ctx);
  vm.runInContext(extractFunction('addPlan'), ctx);
  ctx.addPlan();
  assert.match(alerts[0], /预留给 u1/, 'alert 预留明细');
  assert.equal(ctx.serverPlans.length, 0, '不创建计划');

  vm.runInContext(`nodeReservations=[]`, ctx);
  ctx.addPlan();
  assert.equal(ctx.serverPlans.length, 1, '无预留时正常创建');
});

/* ==================== 租约 403 reserved ==================== */
test('nodeLeaseRequest：403 {error:reserved} 返回 {ok:false,reserved,message}，其他错误维持抛错降级', async () => {
  const ctx = pureCtx({
    NODE_LEASE_PATH: '/api/worktable/pipeline/leases',
    fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: 'reserved', message: '节点已预留给 u1 至 18:00' }) }),
  });
  vm.runInContext(extractFunction('nodeLeaseRequest'), ctx);
  const r = await ctx.nodeLeaseRequest({ action: 'acquire', runId: 'q1', ips: ['10.0.0.1'] });
  assert.equal(r.ok, false);
  assert.equal(r.reserved, true);
  assert.equal(r.message, '节点已预留给 u1 至 18:00');

  const fail = pureCtx({
    NODE_LEASE_PATH: '/api/worktable/pipeline/leases',
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  vm.runInContext(extractFunction('nodeLeaseRequest'), fail);
  await assert.rejects(() => fail.nodeLeaseRequest({ action: 'acquire' }), /node lease http 500/, '非预留错误维持抛错（acquire 调用方按服务端不可达降级）');
});

test('startRun 租约 acquire 遇 reserved：alert 服务端 message 并按启动失败收尾（不进入运行、不回队等待）', async () => {
  const calls = { sim: 0, render: 0 };
  const alerts = [];
  const ctx = pureCtx({
    DEFAULT_IMAGE: 'img', GITURL: 'g',
    findPipeline: () => null, curPipelineId: 'p1',
    curPipeline: () => ({ id: 'p1', name: 'PL', stages: [] }),
    curEnvs: () => [{ ip: '10.0.0.1' }], resolveEnv: ip => ({ ip }),
    resolveRepo: () => ({ id: 'r', name: 'r' }),
    $: () => ({ value: '' }), currentUsername: 'me', curStrategy: () => '',
    selectedPresetKeys: () => [],
    startSimRun: () => { calls.sim++; },
    queue: [], renderQueue: () => { calls.render++; },
    NODE_WAIT_RETRY_MS: 5000, pendingLeaseStarts: [],
    nodeLeaseRequest: async () => ({ ok: false, reserved: true, message: '节点已预留给 u1 至 18:00' }),
    alert: m => alerts.push(String(m)), console,
  });
  vm.runInContext(extractFunction('runIps') + '\n' + extractFunction('startRun'), ctx);
  ctx.startRun({ id: 'q1', envs: [{ ip: '10.0.0.1' }], by: 'me', stages: [] });
  await flush();
  assert.equal(calls.sim, 0, '不进入运行');
  assert.equal(ctx.queue.length, 0, '不回队等待（预留期内重试必然同样被拒）');
  assert.equal(ctx.pendingLeaseStarts.length, 0, '在途槽位已排空');
  assert.deepEqual(alerts, ['节点已预留给 u1 至 18:00'], 'alert 服务端 message');
  assert.ok(calls.render >= 1, '按启动失败收尾：重绘队列区');
});
