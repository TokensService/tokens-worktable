/* ===== 08-services-config.js · 步骤脚本绑定、Jenkins/EvalTokens/普罗服务配置、Jenkins 任务列表 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 3613–3999）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */

/* ---------- 步骤脚本绑定（scripts 目录 + 参数自动识别 + 执行） ---------- */
function detectScriptsDir(){
  try{
    if(typeof location!=='undefined' && location.pathname){
      const m=/\/api\/worktable\/site\/([^/]+)\//.exec(location.pathname);
      if(m){ const folder=decodeURIComponent(m[1]); if(folder) return folder.replace(/\/+$/,'')+'/scripts'; }
    }
  }catch(e){}
  return 'scripts';
}
function saveScriptsDir(){ try{ localStorage.setItem('pip-scriptsDir', scriptsDir); }catch(e){} persistState(); }
/* 脚本目录默认值：安装默认已解析则优先（安装后的 scripts 路径），否则退回 URL 嗅探（detectScriptsDir） */
function scriptsDirDefault(){ return installedScriptsDir || detectScriptsDir(); }
/* 安装默认到达或服务端设置无 scriptsDir 时调用：fallback 态生效值升级为安装默认并落盘、刷新脚本列表 */
function maybeAdoptInstalledScriptsDir(){
  if(!scriptsDirIsFallback || !installedScriptsDir || scriptsDir===installedScriptsDir) return;
  scriptsDir=installedScriptsDir;
  saveScriptsDir();
  loadScripts();
  renderScriptsDirCfg();
}
/* 设置页「脚本目录」卡片回显：生效值 + 安装默认路径（health 未解析时显示构成规则） */
function renderScriptsDirCfg(){
  const inp=$('cfgScriptsDir'); if(!inp) return;
  if(document.activeElement!==inp) inp.value=scriptsDir||'';
  const tip=$('cfgScriptsDirTip');
  if(tip) tip.textContent='安装默认：'+(installedScriptsDir||'插件安装目录/projects/pipeline/scripts')+(scriptsDirIsFallback?'（当前生效）':'');
}
/* 设置页保存/重置脚本目录：留空=恢复安装默认（回到 fallback 态）；自定义值随设置持久化到服务端并跨浏览器同步 */
function applyScriptsDirInput(raw){
  const v=(raw||'').trim();
  scriptsDir=v||scriptsDirDefault();
  scriptsDirIsFallback=!v;
  saveScriptsDir();
  loadScripts();
  renderScriptsDirCfg();
}
function saveArchiveDir(){ try{ localStorage.setItem('pip-archiveDir', archiveDir); }catch(e){} persistState(); }
function saveArchiveScript(){ try{ localStorage.setItem('pip-archiveScript', archiveScriptName); }catch(e){} persistState(); }

/* ---------- Jenkins 服务配置（连接模式 + 测试连接） ----------
   本地浏览器连接：浏览器直接用 JS 连接 Jenkins（不走桥接；需 Jenkins 允许跨域或同源）；
   远程服务器端连接：DSH 服务端经 /api/worktable/proxy 代连 Jenkins（仅回环/内网）。 */
function loadJenkins(){
  try{ const a=JSON.parse(localStorage.getItem('pip-jenkins')); if(a && typeof a==='object') return Object.assign({}, DEFAULT_JENKINS, a); }catch(e){}
  return Object.assign({}, DEFAULT_JENKINS);
}
function saveJenkins(){ try{ localStorage.setItem('pip-jenkins', JSON.stringify(jenkins)); }catch(e){} persistState(); }
function applyJenkinsForm(){
  $('jkUrl').value = jenkins.url || DEFAULT_JENKINS.url;
  $('jkLinkUrl').value = jenkins.linkUrl || '';
  $('jkUser').value = jenkins.user || '';
  $('jkToken').value = jenkins.token || '';
  setJenkinsMode(jenkins.mode);
}
function setJenkinsMode(m){
  jenkins.mode = (m==='remote') ? 'remote' : 'local';
  $('jkModeLocal').classList.toggle('sel', jenkins.mode==='local');
  $('jkModeRemote').classList.toggle('sel', jenkins.mode==='remote');
}
function collectJenkinsForm(){
  return {
    url: ($('jkUrl').value||'').trim() || DEFAULT_JENKINS.url,
    linkUrl: ($('jkLinkUrl').value||'').trim(),
    user: ($('jkUser').value||'').trim(),
    token: ($('jkToken').value||'').trim(),
    mode: jenkins.mode,
  };
}
async function testJenkins(){
  const j = collectJenkinsForm();
  const tip = $('jkTestTip');
  tip.style.color = ''; tip.textContent = '测试中…';
  const auth = (j.user || j.token) ? ('Basic ' + btoa(j.user + ':' + j.token)) : '';
  const sub = '/api/json?tree=mode,nodeName,numExecutors';
  try {
    let status = 0, body = '';
    if (j.mode === 'local') {
      const r = await fetch(j.url.replace(/\/+$/,'') + sub, { headers: auth ? { Authorization: auth } : {}, cache: 'no-store' });
      status = r.status; body = await r.text();
    } else {
      const r = await fetch('/api/worktable/proxy', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: j.url.replace(/\/+$/,'') + sub, method:'GET', headers: auth ? { Authorization: auth } : {} }) });
      const p = await r.json();
      if (p && p.error) { tip.style.color='var(--log-err)'; tip.textContent='✗ ' + p.error; return; }
      status = p.status || 0; body = p.body || '';
    }
    if (status === 200) {
      let info = {}; try { info = JSON.parse(body); } catch (e) {}
      if (info && (info.nodeName || info.numExecutors !== undefined)) {
        tip.style.color = 'var(--log-ok)';
        tip.textContent = '✓ 连接成功 · 节点 ' + (info.nodeName || '?') + ' · ' + (info.numExecutors !== undefined ? info.numExecutors : '?') + ' 执行器' + (info.mode ? (' · ' + info.mode + ' 模式') : '');
      } else {
        tip.style.color = 'var(--log-ok)'; tip.textContent = '✓ HTTP 200（未返回预期的 Jenkins 元数据）';
      }
    } else {
      tip.style.color = 'var(--log-err)'; tip.textContent = '✗ Jenkins 返回 HTTP ' + status;
    }
  } catch (e) {
    tip.style.color = 'var(--log-err)'; tip.textContent = '✗ ' + ((e && e.message) ? e.message : e);
  }
}

/* ---------- EvalTokens 服务配置（评估任务管理服务：默认 http://1.95.87.43:9000） ----------
   本地浏览器连接：浏览器直接请求服务 API（需服务允许跨域 CORS 或同源）；
   远程服务器端连接：DSH 服务端经 /api/worktable/proxy 代连服务（仅回环/内网，公网地址走本地连接）。 */
function loadEvaltok(){
  try{
    const a=JSON.parse(localStorage.getItem('pip-evaltokens')); if(a && typeof a==='object') return Object.assign({}, DEFAULT_EVALTOK, a);
    /* 迁移旧 EvalScope 配置（pip-evalscope）到 EvalTokens，保留已配置的服务地址 */
    const old=JSON.parse(localStorage.getItem('pip-evalscope')); if(old && typeof old==='object') return Object.assign({}, DEFAULT_EVALTOK, old);
  }catch(e){}
  return Object.assign({}, DEFAULT_EVALTOK);
}
function saveEvaltok(){ try{ localStorage.setItem('pip-evaltokens', JSON.stringify(evaltok)); localStorage.removeItem('pip-evalscope'); }catch(e){} persistState(); }
function applyEvaltokForm(){
  $('etUrl').value = evaltok.url || DEFAULT_EVALTOK.url;
  $('etLinkUrl').value = evaltok.linkUrl || '';
  $('etToken').value = evaltok.token || '';
  setEvaltokMode(evaltok.mode);
}
function setEvaltokMode(m){
  evaltok.mode = (m==='remote') ? 'remote' : 'local';
  $('etModeLocal').classList.toggle('sel', evaltok.mode==='local');
  $('etModeRemote').classList.toggle('sel', evaltok.mode==='remote');
}
function collectEvaltokForm(){
  return {
    url: ($('etUrl').value||'').trim() || DEFAULT_EVALTOK.url,
    linkUrl: ($('etLinkUrl').value||'').trim(),
    token: ($('etToken').value||'').trim(),
    mode: evaltok.mode,
  };
}
/* 取带 Bearer 令牌的请求头（令牌为空时不附加 Authorization，由服务按未鉴权处理） */
function evaltokHeaders(e){ return e.token ? { Authorization:'Bearer ' + e.token } : {}; }
/* 测试连接：本地模式浏览器直连服务任务接口（带 Bearer 令牌；跨域无 CORS 会抛 TypeError，提示切本地/检查令牌）；远程模式经 /api/worktable/proxy 代连（仅回环/内网） */
async function testEvaltok(){
  const e = collectEvaltokForm();
  const tip = $('etTestTip');
  tip.style.color = ''; tip.textContent = '测试中…';
  const api = e.url.replace(/\/+$/,'') + '/api/open/v1/tasks';
  const headers = evaltokHeaders(e);
  try {
    let status = 0;
    if (e.mode === 'local') {
      const r = await fetch(api, { cache:'no-store', headers });
      status = r.status;
    } else {
      const r = await fetch('/api/worktable/proxy', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: api, method:'GET', headers }) });
      const p = await r.json();
      if (p && p.error) { tip.style.color='var(--log-err)'; tip.textContent='✗ ' + p.error + (/-?only loopback|private targets/i.test(String(p.error)) ? '（公网地址请切「本地浏览器连接」）' : ''); return; }
      status = p.status || 0;
    }
    if (status === 200) { tip.style.color = 'var(--log-ok)'; tip.textContent = '✓ 服务可达且令牌有效（HTTP 200）'; }
    else if (status === 401 || status === 403) { tip.style.color = 'var(--log-err)'; tip.textContent = '✗ 令牌无效或缺失（HTTP ' + status + '），请在「访问令牌」填写正确的 Bearer 令牌'; }
    else { tip.style.color = 'var(--log-err)'; tip.textContent = '✗ 服务返回 HTTP ' + status; }
  } catch (err) {
    const em = (err && err.message) ? err.message : String(err);
    tip.style.color = 'var(--log-err)';
    tip.textContent = '✗ ' + em + (/failed to fetch|networkerror|load failed/i.test(em) ? ' —— 多为 CORS 拦截或网络不可达：浏览器地址栏能直接打开服务即为 CORS，请保持「本地浏览器连接」并确认令牌正确' : '');
  }
}
/* 获取任务列表：经 /api/open/v1/tasks 拉取评估任务（本地直连 / 远程走 proxy，复用连接模式 + Bearer 令牌），表格展示；「打开」链接到该任务详情页 */
async function listEvaltokTasks(){
  const e = collectEvaltokForm();
  const openBase = (e.linkUrl || e.url || '').trim();
  const wrap = $('etReportsWrap'); const tip = $('etReportsTip'); const tb = $('etReportsTable').querySelector('tbody');
  tip.style.color=''; tip.textContent='拉取中…'; tb.innerHTML=''; wrap.style.display='none';
  if (!openBase) { tip.style.color='var(--log-err)'; tip.textContent='✗ 未配置服务地址'; return; }
  const api = e.url.replace(/\/+$/,'') + '/api/open/v1/tasks';
  const headers = evaltokHeaders(e);
  try {
    let data;
    if (e.mode === 'local') {
      const r = await fetch(api, { cache:'no-store', headers });
      if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try { const j = await r.json(); if (j && (j.error||j.message)) msg = String(j.error||j.message) + '（HTTP ' + r.status + '）'; } catch (_) {}
        throw new Error(msg);
      }
      data = await r.json();
    } else {
      const r = await fetch('/api/worktable/proxy', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: api, method:'GET', headers }) });
      const p = await r.json();
      if (p && p.error) throw new Error(p.error + (/-?only loopback|private targets/i.test(String(p.error)) ? '（公网地址请切「本地浏览器连接」）' : ''));
      if ((p.status||0) !== 200) {
        let msg = 'HTTP ' + (p.status||0);
        try { const j = JSON.parse(p.body || '{}'); if (j && (j.error||j.message)) msg = String(j.error||j.message) + '（HTTP ' + (p.status||0) + '）'; } catch (_) {}
        throw new Error(msg);
      }
      data = JSON.parse(p.body || '{}');
    }
    /* 归一化为任务数组：兼容裸数组 / {data|tasks|list|items|results:[...]} 等常见包装 */
    const tasks = Array.isArray(data) ? data
      : (Array.isArray(data.data) ? data.data
      : (Array.isArray(data.tasks) ? data.tasks
      : (Array.isArray(data.list) ? data.list
      : (Array.isArray(data.items) ? data.items
      : (Array.isArray(data.results) ? data.results : [])))));
    wrap.style.display='';
    if (!tasks.length) {
      const tr=document.createElement('tr'); const td=document.createElement('td');
      td.colSpan=6; td.className='dshell-muted'; td.textContent='（无任务）'; tr.appendChild(td); tb.appendChild(tr);
    }
    tasks.forEach((t,i) => {
      const tr=document.createElement('tr');
      const tdIdx=document.createElement('td'); tdIdx.className='dshell-muted'; tdIdx.textContent=String(i+1);
      const id=String(t.id||t.task_id||t.uuid||t._id||'');
      const tdId=document.createElement('td'); tdId.style.fontFamily='Menlo,Consolas,monospace'; tdId.style.fontSize='11px'; tdId.textContent=id||'-';
      const name=String(t.name||t.title||t.task_name||t.display_name||'');
      const tdName=document.createElement('td'); tdName.textContent=name||'-';
      const st=String(t.status||t.state||t.task_status||t.phase||'');
      const tdSt=document.createElement('td'); tdSt.textContent=st||'-';
      const tm=t.created_at||t.create_time||t.start_time||t.created_time||t.gmt_create||t.created||'';
      const tdTm=document.createElement('td'); tdTm.textContent= tm ? (String(new Date(tm))==='Invalid Date' ? String(tm) : new Date(tm).toLocaleString()) : '-';
      const tdOp=document.createElement('td');
      const link = openBase.replace(/\/+$/,'') + (id ? ('/tasks/' + encodeURIComponent(id)) : '');
      const a=document.createElement('a'); a.href=link; a.target='_blank'; a.rel='noopener'; a.textContent='打开'; a.style.marginRight='8px';
      const cp=document.createElement('button'); cp.className='dshell-btn dshell-btnGhost mini'; cp.type='button'; cp.textContent='复制链接';
      cp.addEventListener('click', ()=>copyText(link, cp));
      tdOp.appendChild(a); tdOp.appendChild(cp);
      tr.appendChild(tdIdx); tr.appendChild(tdId); tr.appendChild(tdName); tr.appendChild(tdSt); tr.appendChild(tdTm); tr.appendChild(tdOp);
      tb.appendChild(tr);
    });
    const total = (!Array.isArray(data) && Number.isFinite(data.total)) ? data.total : tasks.length;
    tip.style.color='var(--log-ok)'; tip.textContent='✓ 共 ' + tasks.length + ' 个任务' + (total!==tasks.length ? '（总计 ' + total + '）' : '');
  } catch (err) {
    const em = (err && err.message) ? err.message : String(err);
    tip.style.color='var(--log-err)';
    tip.textContent='✗ ' + em + (/failed to fetch|networkerror|load failed/i.test(em) ? ' —— 多为 CORS 拦截或网络不可达，请保持「本地浏览器连接」并确认令牌正确' : '');
  }
}

/* ---------- 普罗数据（Prometheus）服务配置（设置页内卡片）：连接模式 + 测试连接 ----------
   本地浏览器连接：浏览器直接请求 Prometheus API（需 Prometheus 允许跨域 CORS 或同源）；
   远程服务器端连接：DSH 服务端经 /api/worktable/proxy 代连 Prometheus（仅回环/内网）。 */
function loadProm(){
  try{ const a=JSON.parse(localStorage.getItem('pip-prom')); if(a && typeof a==='object') return Object.assign({}, DEFAULT_PROM, a); }catch(e){}
  return Object.assign({}, DEFAULT_PROM);
}
function saveProm(){ try{ localStorage.setItem('pip-prom', JSON.stringify(prom)); }catch(e){} persistState(); }
function applyPromForm(){
  $('pmUrl').value = prom.url || DEFAULT_PROM.url;
  $('pmLinkUrl').value = prom.linkUrl || '';
  $('pmCollectScript').value = prom.collectScript || '';
  setPromMode(prom.mode);
}
function setPromMode(m){
  prom.mode = (m==='remote') ? 'remote' : 'local';
  $('pmModeLocal').classList.toggle('sel', prom.mode==='local');
  $('pmModeRemote').classList.toggle('sel', prom.mode==='remote');
}
function collectPromForm(){
  return {
    url: ($('pmUrl').value||'').trim() || DEFAULT_PROM.url,
    linkUrl: ($('pmLinkUrl').value||'').trim(),
    mode: prom.mode,
    collectScript: ($('pmCollectScript').value||'').trim(),
  };
}
/* 测试连接：本地模式浏览器直连 Prometheus 的 /api/v1/status/buildinfo（跨域无 CORS 会抛 TypeError，提示切远程）；远程模式经 /api/worktable/proxy 代连 */
async function testProm(){
  const p = collectPromForm();
  const tip = $('pmTestTip');
  tip.style.color = ''; tip.textContent = '测试中…';
  const api = p.url.replace(/\/+$/,'') + '/api/v1/status/buildinfo';
  try {
    let data;
    if (p.mode === 'local') {
      const r = await fetch(api, { cache:'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } else {
      const r = await fetch('/api/worktable/proxy', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: api, method:'GET', headers:{} }) });
      const pr = await r.json();
      if (pr && pr.error) { tip.style.color='var(--log-err)'; tip.textContent='✗ ' + pr.error; return; }
      if ((pr.status||0) !== 200) throw new Error('HTTP ' + (pr.status||0));
      data = JSON.parse(pr.body || '{}');
    }
    const ver = (data && data.data && data.data.version) ? data.data.version : '';
    tip.style.color = 'var(--log-ok)'; tip.textContent = '✓ Prometheus 可达' + (ver ? '（版本 ' + ver + '）' : '');
  } catch (err) {
    const em = (err && err.message) ? err.message : String(err);
    tip.style.color = 'var(--log-err)';
    tip.textContent = '✗ ' + em + (/failed to fetch|networkerror|load failed/i.test(em) ? ' —— 多为 CORS 拦截或网络不可达：浏览器地址栏能直接打开数据源即为 CORS，请切「远程服务器端连接」由 DSH 服务端代连' : '');
  }
}

/* ---------- Jenkins：拉取任务列表（本地直连 / 远程走 proxy，复用连接模式） ---------- */
/* 模式自适应取 JSON：本地模式浏览器直连；远程模式经 DSH 服务端 /api/worktable/proxy 代连 */
async function jkFetchJson(j, url, signal){
  const auth = (j.user || j.token) ? { Authorization: 'Basic ' + btoa(j.user + ':' + j.token) } : {};
  if (j.mode === 'local') {
    const r = await fetch(url, { headers: auth, cache: 'no-store', signal:signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  const r = await fetch('/api/worktable/proxy', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url, method:'GET', headers: auth }), signal:signal });
  const p = await r.json();
  if (p && p.error) throw new Error(p.error);
  if ((p.status||0) !== 200) throw new Error('HTTP ' + (p.status||0));
  return JSON.parse(p.body || '{}');
}
/* Jenkins color → 可读状态（_anime 后缀=正在构建） */
function jobStatus(color){
  if (!color) return '-';
  const building = color.endsWith('_anime');
  const base = color.replace(/_anime$/, '');
  const map = { blue:'成功', red:'失败', yellow:'不稳定', grey:'未构建', disabled:'已禁用', aborted:'已中止', notbuilt:'未构建' };
  return (map[base] || base) + (building ? '（构建中）' : '');
}
/* 递归拉取所有任务（展开文件夹/多分支）。子级 URL 用 fullName 拼到配置的 base 上，
   避免 Jenkins 返回的绝对地址绕开本机桥接/反代导致再次被 CORS 拦截。 */
async function fetchAllJenkinsJobs(j){
  const base = j.url.replace(/\/+$/, '');
  const jobUrl = (fn) => base + '/job/' + String(fn).split('/').map(encodeURIComponent).join('/job/') + '/';
  async function walk(nodeUrl){
    const data = await jkFetchJson(j, nodeUrl.replace(/\/+$/,'') + '/api/json?tree=jobs[name,fullName,url,color,_class]');
    let out = [];
    for (const job of (data.jobs || [])) {
      const isContainer = /folder|multibranch|organization/i.test(job._class || '');
      const fullName = job.fullName || job.name;
      if (isContainer) out = out.concat(await walk(jobUrl(fullName)));
      else out.push({ name: fullName, color: job.color });
    }
    return out;
  }
  return walk(base + '/');
}
/* 复制到剪贴板（clipboard API 优先，execCommand 兜底；http://127.0.0.1 / localhost 属安全上下文） */
function copyText(text, btn){
  const done = ()=>{ if(btn){ const o=btn.textContent; btn.textContent='已复制'; setTimeout(()=>{ btn.textContent=o; },1200);} };
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done).catch(()=>fallbackCopy(text, done)); }
  else fallbackCopy(text, done);
}
function fallbackCopy(text, done){
  try{ const ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); if(done) done(); }catch(e){}
}
async function listJenkinsJobs(){
  const j = collectJenkinsForm();
  const openBase = (j.linkUrl || j.url).replace(/\/+$/,'');   // 打开/复制用：真实 Jenkins 地址（留空则用上方 Jenkins 地址）
  const wrap = $('jkJobsWrap'); const tip = $('jkJobsTip'); const tb = $('jkJobsTable').querySelector('tbody');
  tip.style.color=''; tip.textContent='拉取中…'; tb.innerHTML=''; wrap.style.display='none';
  try {
    const jobs = await fetchAllJenkinsJobs(j);
    availableJenkinsJobs = jobs.map(function(jb){ return {name: jb.name}; }); fillJenkinsJobsDatalist();
    wrap.style.display='';
    if (!jobs.length) {
      const tr=document.createElement('tr'); const td=document.createElement('td');
      td.colSpan=3; td.className='dshell-muted'; td.textContent='（无任务）'; tr.appendChild(td); tb.appendChild(tr);
    }
    jobs.forEach(job => {
      const link = openBase + '/job/' + String(job.name).split('/').map(encodeURIComponent).join('/job/') + '/';
      const tr = document.createElement('tr');
      const tdName=document.createElement('td'); tdName.textContent=job.name;
      const tdSt=document.createElement('td'); tdSt.textContent=jobStatus(job.color);
      const c=job.color||'';
      tdSt.style.color = c.indexOf('red')===0 ? 'var(--log-err)' : (c.indexOf('blue')===0 ? 'var(--log-ok)' : (c.indexOf('yellow')===0 ? 'var(--log-warn)' : ''));
      const tdOp=document.createElement('td');
      const a=document.createElement('a'); a.href=link; a.target='_blank'; a.rel='noopener'; a.textContent='打开'; a.style.marginRight='8px';
      const cp=document.createElement('button'); cp.className='dshell-btn dshell-btnGhost mini'; cp.type='button'; cp.textContent='复制链接';
      cp.addEventListener('click', ()=>copyText(link, cp));
      tdOp.appendChild(a); tdOp.appendChild(cp);
      tr.appendChild(tdName); tr.appendChild(tdSt); tr.appendChild(tdOp);
      tb.appendChild(tr);
    });
    tip.style.color='var(--log-ok)'; tip.textContent='✓ 共 ' + jobs.length + ' 个任务';
  } catch(e) {
    tip.style.color='var(--log-err)'; tip.textContent='✗ ' + ((e && e.message) ? e.message : e);
  }
}
