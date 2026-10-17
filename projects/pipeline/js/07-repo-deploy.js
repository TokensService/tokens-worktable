/* ===== 07-repo-deploy.js · 代码仓配置与按分支部署策略 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 3213–3612）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* 点击绑定在脚本尾部统一初始化区进行（const $ 声明之前不得在顶层执行 $()，否则 TDZ 中断整个脚本） */
/* ---------- 代码仓配置（名称 + URL + 用户名 + 访问令牌） ---------- */
/* 分支获取方式：server=服务端 git ls-remote；browser=浏览器直连 /info/refs；jenkins-browser/jenkins-server=Jenkins 多分支任务子任务名（浏览器直连 / 服务端代连，按仓库各自选择）；旧值 jenkins 归为 jenkins-browser */
function normalizeFetchMode(m){ return m==='browser'?'browser':(m==='jenkins-server'?'jenkins-server':((m==='jenkins'||m==='jenkins-browser')?'jenkins-browser':'server')); }
function isJenkinsFetchMode(m){ return m==='jenkins-browser'||m==='jenkins-server'; }
function fetchModeLabel(m){ return m==='browser'?'浏览器':(m==='jenkins-browser'?'Jenkins·浏览器':(m==='jenkins-server'?'Jenkins·服务端':'服务端')); }
function fetchModeTitle(m){ return m==='browser'?'浏览器直连 /info/refs（需 CORS）':(m==='jenkins-browser'?'Jenkins 多分支任务子任务名（本地浏览器直连 Jenkins）':(m==='jenkins-server'?'Jenkins 多分支任务子任务名（服务端经 /api/worktable/proxy 代连）':'服务端 git ls-remote')); }
function normalizeRepo(r){ return {id:r.id, name:r.name, url:r.url, user:r.user||'', pass:r.pass||'', fetchMode:normalizeFetchMode(r.fetchMode), jenkinsJob:r.jenkinsJob||'', strategyUrl:r.strategyUrl||'', strategyMode:r.strategyMode==='script'?'script':'url', strategyScript:r.strategyScript||''}; }
function loadRepos(){ try{ const a=JSON.parse(localStorage.getItem('pip-repos')); if(Array.isArray(a)&&a.length) return a.map(normalizeRepo); }catch(e){} return null; }
function saveRepos(){ try{ localStorage.setItem('pip-repos', JSON.stringify(repositories)); }catch(e){} persistState(); }
function saveRepoSel(){ try{ localStorage.setItem('pip-curRepo', curRepoId); }catch(e){} }
function curRepo(){ return repositories.find(r=>r.id===curRepoId) || repositories[0]; }
function resolveRepo(v){ if(!v) return curRepo(); return repositories.find(r=>r.id===v)||repositories.find(r=>r.url===v)||repositories.find(r=>r.name===v)||{id:'',name:String(v),url:String(v),user:'',pass:''}; }
function renderRepoOptions(){
  const sel=$('repoSel'); if(!sel) return; const cur=sel.value; sel.innerHTML='';
  repositories.forEach(r=>{ const o=document.createElement('option'); o.value=r.id; o.textContent=r.name; if(r.id===curRepoId) o.selected=true; sel.appendChild(o); });
  if(cur && repositories.some(r=>r.id===cur)) sel.value=cur;
  if(repositories.length && !repositories.some(r=>r.id===sel.value)) sel.value=repositories[0].id;
}
function renderRepos(){
  $('repoCount').textContent = repositories.length? '('+repositories.length+')':'';
  const tb=$('repoTable').querySelector('tbody'); tb.innerHTML='';
  repositories.forEach(r=>{
    const tr=document.createElement('tr');
    const stSrc=strategySourceOf(r);
    const stCell='<td class="dshell-muted" style="font-size:11px;"'+(stSrc?(' title="'+esc(stSrc.mode==='script'?stSrc.script:stSrc.url)+'">✓ '+(stSrc.mode==='script'?('脚本 · '+esc(stSrc.script)):'URL')):'>—')+'</td>';
    tr.innerHTML='<td style="font-weight:600">'+esc(r.name)+'</td><td class="dshell-muted">'+esc(r.url||'—')+'</td><td class="dshell-muted">'+esc(r.user||'—')+'</td><td class="dshell-muted">'+(r.pass?'••••••':'—')+'</td><td class="dshell-muted" style="font-size:11px;" title="'+fetchModeTitle(r.fetchMode)+'">'+(isJenkinsFetchMode(r.fetchMode)?(fetchModeLabel(r.fetchMode)+(r.jenkinsJob?(' · '+esc(r.jenkinsJob)):'')):fetchModeLabel(r.fetchMode))+'</td>'+stCell+
      '<td style="white-space:nowrap"><button class="dshell-btn dshell-btnGhost mini" data-repotest="'+r.id+'" title="检测连通性并列举远程分支">测试</button> <button class="dshell-btn dshell-btnGhost mini" data-repoststrategy="'+r.id+'" title="按主控当前分支试拉部署策略（URL 或脚本）">策略测试</button> <button class="dshell-btn dshell-btnGhost mini" data-repoedit="'+r.id+'">编辑</button> <button class="dshell-btn dshell-btnDanger mini" data-repodel="'+r.id+'">删除</button></td>';
    tb.appendChild(tr);
  });
  tb.querySelectorAll('[data-repotest]').forEach(b=>b.addEventListener('click',()=>{ const r=repositories.find(x=>x.id===b.getAttribute('data-repotest')); if(r) testRepo(r); }));
  tb.querySelectorAll('[data-repoststrategy]').forEach(b=>b.addEventListener('click',()=>{ const r=repositories.find(x=>x.id===b.getAttribute('data-repoststrategy')); if(r) testRepoStrategy(r); }));
  tb.querySelectorAll('[data-repoedit]').forEach(b=>b.addEventListener('click',()=>startRepoEdit(b.getAttribute('data-repoedit'))));
  tb.querySelectorAll('[data-repodel]').forEach(b=>b.addEventListener('click',()=>delRepo(b.getAttribute('data-repodel'))));
}
function startRepoEdit(id){ const r=repositories.find(x=>x.id===id); if(!r) return; repoEditId=id; $('repoName').value=r.name; $('repoUrl').value=r.url; $('repoUser').value=r.user||''; $('repoPass').value=r.pass||''; $('repoFetchMode').value=normalizeFetchMode(r.fetchMode); $('repoJenkinsJob').value=r.jenkinsJob||''; $('repoStrategyMode').value=r.strategyMode==='script'?'script':'url'; $('repoStrategyUrl').value=r.strategyUrl||''; $('repoStrategyScript').value=r.strategyScript||''; toggleRepoJenkinsJobInput(); toggleRepoStrategyInput(); $('repoAdd').textContent='保存'; $('repoCancelEdit').style.display=''; }
function resetRepoForm(){ repoEditId=null; $('repoName').value=''; $('repoUrl').value=''; $('repoUser').value=''; $('repoPass').value=''; $('repoFetchMode').value='server'; $('repoJenkinsJob').value=''; $('repoStrategyMode').value='url'; $('repoStrategyUrl').value=''; $('repoStrategyScript').value=''; toggleRepoJenkinsJobInput(); toggleRepoStrategyInput(); $('repoAdd').textContent='添加'; $('repoCancelEdit').style.display='none'; }
function saveRepoForm(){
  const name=$('repoName').value.trim(); const url=$('repoUrl').value.trim(); const user=$('repoUser').value.trim(); const pass=$('repoPass').value;
  const fm=normalizeFetchMode($('repoFetchMode').value);
  const jkJob=($('repoJenkinsJob').value||'').trim();
  const stMode=$('repoStrategyMode').value==='script'?'script':'url';
  const stUrl=($('repoStrategyUrl').value||'').trim();
  const stScript=($('repoStrategyScript').value||'').trim();
  /* 分支获取选 Jenkins 时分支取自多分支任务子任务名，仓库 URL 可留空（任务框必填）；其余方式仍必填 URL */
  if(isJenkinsFetchMode(fm)){ if(!jkJob){ alert('分支获取为 Jenkins 时请填写多分支任务或 refs 接口地址'); return; } }
  else if(!url){ alert('请填写仓库 URL'); return; }
  if(repoEditId){ const r=repositories.find(x=>x.id===repoEditId); if(r){ r.name=name||url||jkJob; r.url=url; r.user=user; r.pass=pass; r.fetchMode=fm; r.jenkinsJob=isJenkinsFetchMode(fm)?jkJob:''; r.strategyMode=stMode; r.strategyUrl=stUrl; r.strategyScript=stScript; } }
  else { repositories.push({id:'repo-'+Date.now().toString(36), name:name||url||jkJob, url, user, pass, fetchMode:fm, jenkinsJob:isJenkinsFetchMode(fm)?jkJob:'', strategyMode:stMode, strategyUrl:stUrl, strategyScript:stScript}); }
  if(repoEditId){ delete repoBranches[repoEditId]; } saveRepos(); resetRepoForm(); renderRepos(); renderRepoOptions();
}
function delRepo(id){ if(!confirm('删除该代码仓？')) return; repositories=repositories.filter(r=>r.id!==id); if(!repositories.length){ repositories=[{id:'repo-1',name:'默认',url:'',user:'',pass:'',fetchMode:'server'}]; } if(curRepoId===id) curRepoId=repositories[0].id; saveRepos(); saveRepoSel(); renderRepos(); renderRepoOptions(); }
function applyRepoCredAll(){
  const u=$('repoUser').value.trim(); const p=$('repoPass').value;
  if(!u && !p){ alert('请先在上面的用户名/令牌框里填写要统一设置的凭据'); return; }
  if(!repositories.length){ alert('暂无代码仓'); return; }
  if(!confirm('将用户名「'+(u||'(空)')+'」/令牌 应用到全部 '+repositories.length+' 个仓库？')) return;
  repositories.forEach(r=>{ r.user=u; r.pass=p; });
  saveRepos(); renderRepos();
}

/* 分支获取方式切换：仅 Jenkins（浏览器直连/服务端代连）时显示任务选择框；Jenkins 模式下 URL 可留空，联动占位提示 */
function toggleRepoJenkinsJobInput(){ const sel=$('repoFetchMode'); const inp=$('repoJenkinsJob'); if(!sel||!inp) return; const jk=isJenkinsFetchMode(sel.value); inp.style.display = jk?'':'none'; const urlInp=$('repoUrl'); if(urlInp) urlInp.placeholder = jk?'URL（Jenkins 模式可留空）':'URL（如 https://git.example.com/dev/myapp.git）'; }
/* 部署策略来源切换：URL 模式显示 URL 输入框，脚本模式显示脚本选择框（scripts 目录 datalist） */
function toggleRepoStrategyInput(){ const sel=$('repoStrategyMode'); if(!sel) return; const sc=sel.value==='script'; const u=$('repoStrategyUrl'); const s=$('repoStrategyScript'); if(u) u.style.display=sc?'none':''; if(s) s.style.display=sc?'':'none'; }

/* 按 fetchMode 分流：统一返回 {ok, branches:[], tags:[], error} */
async function fetchRepoRefs(r){
  if(r.fetchMode==='browser') return fetchBranchesBrowser(r);
  if(isJenkinsFetchMode(r.fetchMode)) return fetchBranchesJenkins(r);
  const res=await fetch('/api/worktable/git-remote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:r.url,user:r.user||'',pass:r.pass||''})});
  return res.json();
}
/* 浏览器直连：解析 git smart-HTTP refs 广告，输出 branches/tags */
async function fetchBranchesBrowser(repo){
  const out={ok:false, branches:[], tags:[], error:''};
  let base=(repo.url||'').trim();
  if(!base){ out.error='仓库 URL 为空'; return out; }
  while(base.length && base.charAt(base.length-1)==='/') base=base.slice(0,-1);
  const endpoint=base+'/info/refs?service=git-upload-pack';
  const headers={};
  if(repo.user||repo.pass){
    try{ headers['Authorization']='Basic '+btoa(unescape(encodeURIComponent((repo.user||'')+':'+(repo.pass||'')))); }catch(e){}
  }
  let res;
  try{ res=await fetch(endpoint,{method:'GET',headers:headers,mode:'cors'}); }
  catch(e){ out.error='浏览器直连失败（多为 CORS 拦截或网络不可达）：'+String(e.message||e).slice(0,140)+' —— 建议切回「服务端拉取」'; return out; }
  if(!res.ok){ out.error='仓库返回 HTTP '+res.status+' —— 浏览器直连仅对开了 CORS 的 git 服务器有效，建议切回「服务端拉取」'; return out; }
  let buf;
  try{ buf=new Uint8Array(await res.arrayBuffer()); }catch(e){ out.error='读取响应失败：'+String(e.message||e).slice(0,140); return out; }
  const refs=parseGitRefsAdvertisement(buf);
  if(!refs){ out.error='无法解析 git 分支广告（可能非 smart-HTTP 端点）—— 建议切回「服务端拉取」'; return out; }
  out.branches=refs.filter(x=>x.name.indexOf('refs/heads/')===0).map(x=>x.name.slice(11)).sort();
  out.tags=refs.filter(x=>x.name.indexOf('refs/tags/')===0).map(x=>x.name.slice(10)).sort();
  out.ok=true; return out;
}
/* Jenkins 分支来源有两种：① 多分支/文件夹任务：子任务名即分支；② 自定义 refs 接口：jenkinsJob 直接填完整 http(s) 地址，返回分页 JSON {total,offset,limit,next_offset,items:[{type,name}]}，跟 next_offset 逐页拉全（refs 接口免凭证，请求不附带 Jenkins 用户名/令牌）。多分支任务路径复用全局 jenkins 凭据 + jkFetchJson/jkJobPath，连接方式按仓库选择覆盖全局连接模式：jenkins-browser=local 浏览器直连；jenkins-server=remote 经 /api/worktable/proxy 服务端代连。返回 {ok, branches, tags, error} */
async function fetchBranchesJenkins(r){
  const out={ok:false, branches:[], tags:[], error:''};
  const job=(r.jenkinsJob||'').trim();
  if(!job){ out.error='未配置 Jenkins 任务（在「代码仓」表单选择一个多分支任务，或粘贴 refs 接口完整地址）'; return out; }
  const j=Object.assign({}, jenkins, {mode:(r.fetchMode==='jenkins-server')?'remote':'local'});
  /* ② refs 接口：分页 {total,offset,limit,next_offset,items:[{type:'branch'|'tag',name}]}，逐页拉取直至拉全；接口免凭证，不携带 Jenkins 凭据 */
  if(/^https?:\/\//i.test(job)){
    const jn=Object.assign({}, j, {user:'', token:''});   // refs 接口免凭证：清空用户名/令牌，jkFetchJson 即不附加 Authorization
    const branches=[], tags=[];
    try{
      let url=job;
      for(let page=0; page<100; page++){            // 页数兜底，防接口异常导致死循环
        const data=await jkFetchJson(jn, url);
        const items=(data && Array.isArray(data.items))?data.items:[];
        if(!items.length){ if(page===0){ out.error='refs 接口未返回任何条目（items 为空，请确认接口地址与分页格式）'; return out; } break; }
        for(const it of items){
          const n=String((it&&it.name)||'').trim(); if(!n) continue;
          if(it.type==='tag') tags.push(n); else branches.push(n);   // type 缺省/未知按分支计
        }
        const total=+data.total||0, next=(data.next_offset===null||data.next_offset===undefined)?NaN:+data.next_offset;
        if(!isFinite(next)||next>=total) break;
        url=job.replace(/([?&])offset=\d+/, '$1offset='+next);      // 保留原 query，仅替换/追加 offset
        if(url===job) url=job+(job.indexOf('?')>=0?'&':'?')+'offset='+next;
      }
    }catch(e){
      const em=String((e&&e.message)||e).slice(0,160);
      /* TypeError（Failed to fetch / NetworkError / Load failed）= 浏览器层失败，多为 CORS 拦截（接口未回 Access-Control-Allow-Origin）或网络不可达，补充排查指引 */
      out.error='refs 接口请求失败：'+em+(/failed to fetch|networkerror|load failed/i.test(em)?' —— 多为 CORS 拦截或网络不可达：若浏览器地址栏能直接打开该接口即为 CORS，需接口方添加 Access-Control-Allow-Origin 响应头（浏览器安全限制，页面侧无法绕过）；否则请检查到该服务的网络通路':'');
      return out;
    }
    out.branches=Array.from(new Set(branches)).sort(); out.tags=Array.from(new Set(tags)).sort(); out.ok=true; return out;
  }
  const base=(j.url||'').replace(/\/+$/,'');
  if(!base){ out.error='Jenkins 地址未配置（请在「设置」页填写 Jenkins 服务地址）'; return out; }
  let data;
  try{ data=await jkFetchJson(j, base+jkJobPath(job)+'api/json?tree=jobs[name,fullName,color,_class]'); }
  catch(e){ out.error='Jenkins 请求失败：'+String(e.message||e).slice(0,160); return out; }
  const subs=(data && Array.isArray(data.jobs))?data.jobs:[];
  if(!subs.length){ out.error='该 Jenkins 任务未返回子任务列表（实际类型 '+(data&&data._class?String(data._class).split('.').pop():'未知')+'，非多分支/文件夹类型，如 Multibranch Pipeline；若其经自定义接口暴露分支，请直接粘贴 refs 接口完整地址）'; return out; }
  const branches=subs.map(function(s){
    let n=String(s.fullName||s.name||'');
    n=n.split('/').pop();                      // 多分支子任务 fullName 形如 <父任务>/<分支>，取末段
    try{ n=decodeURIComponent(n); }catch(e){} // Jenkins 会把 / 编码成 %2F，还原为真实分支名
    return n;
  }).filter(Boolean).sort();
  out.branches=branches; out.ok=true; return out;
}
/* 解析 smart-HTTP refs 广告（GET info/refs?service=git-upload-pack 响应体）。返回 [{sha,name}] 或 null */
function parseGitRefsAdvertisement(buf){
  try{
    let pos=0; const dec=new TextDecoder('utf-8',{fatal:false}); const refs=[];
    const readPkt=()=>{ if(pos+4>buf.length) return null; const hex=dec.decode(buf.subarray(pos,pos+4)); if(!/^[0-9a-f]{4}$/.test(hex)) return null; const len=parseInt(hex,16); if(len===0){ pos+=4; return ''; } if(len<4||pos+len>buf.length) return null; const s=dec.decode(buf.subarray(pos+4,pos+len)); pos+=len; return s; };
    const all=[]; let line=readPkt(); if(line===null) return null;
    if(!(typeof line==='string' && line.indexOf('# service=')===0)) all.push(line);
    let l; while((l=readPkt())!==null){ if(l!=='') all.push(l); }
    for(const t of all){
      const m=t.match(/^([0-9a-f]{40}) /);
      if(!m) continue;
      let name=t.slice(m[0].length);
      for(let i=0;i<name.length;i++){ const c=name.charCodeAt(i); if(c===0||c===10||c===13){ name=name.slice(0,i); break; } }
      if(name) refs.push({sha:m[1], name:name});
    }
    return refs;
  }catch(e){ return null; }
}
async function testRepo(r){
  const tip=$('repoTestTip'); if(!tip || !r) return;
  tip.style.color=''; tip.textContent='测试中…（'+r.name+' · '+fetchModeLabel(r.fetchMode)+'）';
  let j;
  try{ j=await fetchRepoRefs(r); }
  catch(e){ tip.style.color='var(--log-err)'; tip.textContent='✗ '+r.name+' 请求失败：'+String(e.message||e).slice(0,160); return; }
  if(j && j.ok){
    const nb=j.branches?j.branches.length:0; const nt=j.tags?j.tags.length:0;
    tip.style.color='var(--log-ok)'; tip.textContent='✓ '+r.name+' 连接成功 · '+nb+' 个分支'+(nt?(' · '+nt+' 个 Tag'):'');
    repoBranches[r.id]={branches:(j.branches||[]), tags:(j.tags||[]), error:''};   // 顺便刷新该仓分支/Tag 缓存
  } else {
    tip.style.color='var(--log-err)'; tip.textContent='✗ '+r.name+' 连接失败：'+(j && j.error ? String(j.error).slice(0,160) : '未知错误');
  }
}
/* 部署策略单独测试：按主控当前分支试拉一次部署策略（URL 模式 {branch} 占位替换 / 脚本模式注入 GIT_BRANCH 执行），
   报告策略个数或失败原因；测试的是当前选中仓库时顺便刷新主控「部署策略」下拉缓存 */
async function testRepoStrategy(r){
  const tip=$('repoTestTip'); if(!tip || !r) return;
  const src=strategySourceOf(r);
  if(!src){ tip.style.color='var(--log-warn)'; tip.textContent='⚠ '+r.name+' 未配置部署策略（URL 或脚本，点「编辑」在表单中填写）'; return; }
  const br=($('branchName') && $('branchName').value.trim())||'0830_dev_bnt3';
  const srcLabel=src.mode==='script'?('脚本 '+src.script):'URL';
  tip.style.color=''; tip.textContent='测试部署策略中…（'+r.name+' · '+srcLabel+' · 分支 '+br+'）';
  const st= src.mode==='script' ? await fetchDeployStrategiesByScript(src.script, r, br) : await fetchDeployStrategies(src.url, br);
  if(st.error){ tip.style.color='var(--log-err)'; tip.textContent='✗ '+r.name+' 部署策略拉取失败（'+srcLabel+' · 分支 '+br+'）：'+st.error; }
  else { tip.style.color='var(--log-ok)'; tip.textContent='✓ '+r.name+' 部署策略拉取成功（'+srcLabel+' · 分支 '+br+'）· '+st.items.length+' 个：'+st.items.slice(0,8).join('、')+(st.items.length>8?' …':''); }
  if(r.id===curRepoId){ deployStrategies[deployStrategyKey(r,br)]={items:st.items, error:st.error}; if(strategyPanelOpen()) renderStrategyPanel(); }
}
/* 分支/Tag 与部署策略面板上下文：主控（运行流水线设置）与定时页共用同一套拉取/渲染逻辑，
   仅输入框、面板元素与目标代码仓不同（which 缺省='main' 主控，'sched'=定时页） */
function pickCtx(which){
  if(which==='run') return {
    inp:$('pipelineRunBranch'), panel:$('pipelineRunBranchPanel'),
    repo:function(){ return resolveRepo(($('pipelineRunRepo') && $('pipelineRunRepo').value) || curRepoId) || curRepo(); },
    branch:function(){ return ($('pipelineRunBranch').value.trim()||'main'); },
    strategyInp:$('pipelineRunStrategy'), strategyPanel:$('pipelineRunStrategyPanel'),
  };
  if(which==='sched') return {
    inp:$('schedBranch'), panel:$('schedBranchPanel'),
    repo:function(){ return resolveRepo(($('schedRepo') && $('schedRepo').value) || curRepoId); },
    branch:function(){ return ($('schedBranch').value.trim()||'main'); },
    strategyInp:$('schedStrategy'), strategyPanel:$('schedStrategyPanel'),
  };
  return {
    inp:$('branchName'), panel:$('branchPanel'),
    repo:curRepo,
    branch:function(){ return ($('branchName').value.trim()||'0830_dev_bnt3'); },
    strategyInp:$('deployStrategyName'), strategyPanel:$('strategyPanel'),
  };
}
/* 分支/Tag 选择：按当前代码仓搜索远程分支与 Tag，下拉面板点选；仍可手动输入 */
async function loadRepoBranches(repo, force, which){
  repo = repo || pickCtx(which).repo();
  const id=repo.id;
  if(!force && repoBranches[id] && !repoBranches[id].error && !repoBranches[id].loading) return repoBranches[id];
  repoBranches[id]={loading:true};
  renderBranchPanel(false, which);
  let j;
  try{ j=await fetchRepoRefs(repo); }
  catch(e){ j={ok:false, error:String(e.message||e)}; }
  repoBranches[id] = (j && j.ok) ? {branches:(j.branches||[]), tags:(j.tags||[]), error:''} : {branches:[], tags:[], error:(j&&j.error)?String(j.error):'未知错误'};
  return repoBranches[id];
}
/* 加载三点：分支 / 部署策略面板「加载中」与头部计数占位共用的弹跳小圆点（样式见 .pip-dots） */
function loadingDots(){ return '<span class="pip-dots"><i></i><i></i><i></i></span>'; }
function renderBranchPanel(showAll, which){
  const ctx=pickCtx(which); const panel=ctx.panel; const inp=ctx.inp; if(!panel||!inp) return;
  const repo=ctx.repo(); const q=showAll?'':inp.value.trim().toLowerCase();
  const cached=repoBranches[repo.id];
  const ready=cached&&!cached.loading&&!cached.error;
  const nb=ready?(cached.branches||[]).length:0;
  const nt=ready?(cached.tags||[]).length:0;
  let h='<div style="display:flex;align-items:center;justify-content:space-between;padding:2px 4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:4px;">'
    +'<span class="dshell-muted" style="font-size:10px;">'+esc(repo.name)+' · '+(isJenkinsFetchMode(repo.fetchMode)?(fetchModeLabel(repo.fetchMode)+(repo.jenkinsJob?(' · '+esc(repo.jenkinsJob)):'')):fetchModeLabel(repo.fetchMode))+(ready?(' · '+nb+' 分支'+(nt?(' · '+nt+' Tag'):'')):(' · '+loadingDots()))+'</span>'
    +'<span data-branchrefresh style="cursor:pointer;color:var(--dsw-alias-state-accent-primary);font-size:11px;" title="重新拉取">⟳</span></div>';
  if(!cached || cached.loading){ h+='<div class="dshell-muted" style="font-size:11px;padding:4px 6px;">加载中'+loadingDots()+'</div>'; }
  else if(cached.error){ h+='<div style="color:var(--log-err);font-size:11px;padding:4px 6px;white-space:pre-wrap;">✗ '+esc(cached.error.slice(0,200))+'</div>'; if(repo.fetchMode==='browser'||isJenkinsFetchMode(repo.fetchMode)){ h+='<div style="padding:2px 6px;"><button class="dshell-btn dshell-btnGhost mini" data-branchfallback type="button">切回服务端并重试</button></div>'; } }
  else {
    const br=(cached.branches||[]).filter(b=> !q || b.toLowerCase().indexOf(q)>=0).slice(0,200);
    const tg=(cached.tags||[]).filter(t=> !q || t.toLowerCase().indexOf(q)>=0).slice(0,200);
    const item=(name)=>'<div data-branch="'+esc(name)+'" style="padding:3px 8px;cursor:pointer;border-radius:5px;font-size:12px;'+(name===inp.value?'color:var(--dsw-alias-state-accent-primary);font-weight:600;':'')+'">'+esc(name)+'</div>';
    const head=(label,n)=> n? '<div class="dshell-muted" style="font-size:10px;padding:3px 8px 2px;opacity:.7;">'+label+'（'+n+'）</div>':'';
    if(!br.length && !tg.length){ h+='<div class="dshell-muted" style="font-size:11px;padding:4px 6px;">无匹配</div>'; }
    else { h+=head('分支',br.length)+br.map(item).join('')+head('Tag',tg.length)+tg.map(item).join(''); }
  }
  panel.innerHTML=h; panel.style.display='block';
  if(which==='run') positionPipelineRunPanel('pipelineRunBranchPanel','pipelineRunBranch');
  panel.querySelectorAll('[data-branch]').forEach(el=>el.addEventListener('click',()=>{ inp.value=el.getAttribute('data-branch'); panel.style.display='none'; inp.focus(); loadDeployStrategies(false, which); }));
  const rb=panel.querySelector('[data-branchrefresh]'); if(rb) rb.addEventListener('click', ()=>loadRepoBranches(ctx.repo(), true, which));
  const fb=panel.querySelector('[data-branchfallback]'); if(fb) fb.addEventListener('click', ()=>{ const rr=ctx.repo(); if(rr){ rr.fetchMode='server'; saveRepos(); renderRepos(); renderRepoOptions(); } loadRepoBranches(ctx.repo(), true, which).then(()=>renderBranchPanel(false, which)); });
}
/* ---------- 部署策略（按分支从代码仓部署策略配置拉取：URL 或脚本） ---------- */
/* 仓库的部署策略来源归一化：脚本模式（strategyMode==='script'）取 strategyScript，否则取 strategyUrl；对应值为空视为未配置 */
function strategySourceOf(repo){
  if(!repo) return null;
  if(repo.strategyMode==='script'){ const s=(repo.strategyScript||'').trim(); return s?{mode:'script',script:s}:null; }
  const u=(repo.strategyUrl||'').trim(); return u?{mode:'url',url:u}:null;
}
async function fetchStrategyJson(url){
  try{
    const r=await fetch(url,{cache:'no-store'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    return await r.json();
  }catch(e){
    const r=await fetch('/api/worktable/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,method:'GET'})});
    const p=await r.json();
    if(p && p.error) throw new Error(String(p.error));
    if((p.status||0)!==200) throw new Error('HTTP '+(p.status||0));
    return JSON.parse(p.body||'{}');
  }
}
/* 缓存 key 含来源（URL/脚本名）：改部署策略配置后旧缓存自动失效 */
function deployStrategyKey(repo,branch){ const src=strategySourceOf(repo); return repo.id+'|'+(branch||'')+'|'+(!src?'':(src.mode==='script'?('s:'+src.script):('u:'+src.url))); }
/* 拉取指定分支的部署策略列表：tpl 中 {branch} 替换为分支名；分页 {total,offset,next_offset,items:[{arch_name}]}
   （arch_name 缺省回退 name）跟 next_offset 逐页拉全。返回 {items:[], error:''} */
async function fetchDeployStrategies(tpl, branch){
  const url=tpl.split('{branch}').join(encodeURIComponent(branch));
  const items=[];
  try{
    let u=url;
    for(let page=0; page<100; page++){            // 页数兜底，防接口异常导致死循环
      const data=await fetchStrategyJson(u);
      const arr=(data && Array.isArray(data.items))?data.items:[];
      if(!arr.length){ if(page===0) throw new Error('接口未返回任何条目（items 为空，请确认 URL 与分页格式）'); break; }
      for(const it of arr){ const n=String((it&&(it.arch_name!==undefined?it.arch_name:it.name))||'').trim(); if(n) items.push(n); }
      const total=+data.total||0, next=(data.next_offset===null||data.next_offset===undefined)?NaN:+data.next_offset;
      if(!isFinite(next)||next>=total) break;
      const nu=url.replace(/([?&])offset=\d+/,'$1offset='+next);   // 保留原 query，仅替换/追加 offset
      u=(nu===url)? url+(url.indexOf('?')>=0?'&':'?')+'offset='+next : nu;
    }
    return {items:Array.from(new Set(items)), error:''};
  }catch(e){ return {items:[], error:String(e.message||e).slice(0,160)}; }
}
/* 脚本模式输出解析：stdout 每行一个策略名（去首尾空白、跳过空行、按序去重） */
function parseStrategyScriptOutput(stdout){
  const items=[];
  String(stdout||'').split('\n').forEach(l=>{ const n=l.trim(); if(n && items.indexOf(n)<0) items.push(n); });
  return items;
}
/* 脚本模式：按分支执行 scripts 目录中的脚本（注入 GIT_BRANCH 当前分支与 GIT_URL/GIT_USER/GIT_PASSWORD 仓库凭据），
   stdout 每行解析为一个策略名；脚本缺失 / 非零退出 / 请求失败视为失败。返回 {items:[], error:''} */
async function fetchDeployStrategiesByScript(scriptName, repo, branch){
  const sc=scriptByName(scriptName);
  if(!sc) return {items:[], error:'脚本不存在：'+scriptName+'（需在 scripts 目录下，可到「编辑流水线」重新加载脚本）'.slice(0,160)};
  const env={GIT_BRANCH:branch||'', GIT_URL:(repo&&repo.url)||'', GIT_USER:(repo&&repo.user)||'', GIT_PASSWORD:(repo&&repo.pass)||''};
  let j;
  try{
    const r=await fetch('/api/worktable/exec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:sc.path,args:[],env,cwd:scriptsDir,timeoutMs:30000})});
    j=await r.json();
  }catch(e){ return {items:[], error:'脚本执行失败：'+String(e.message||e).slice(0,140)}; }
  if(j && j.error) return {items:[], error:String(j.error).slice(0,160)};
  const code=(j && j.code!==undefined)?j.code:1;
  if(code!==0){ const err=String((j&&j.stderr)||'').trim(); return {items:[], error:('脚本退出码 '+code+(err?('：'+err.slice(0,120)):'')).slice(0,160)}; }
  const items=parseStrategyScriptOutput((j&&j.stdout)||'');
  if(!items.length) return {items:[], error:'脚本未输出任何策略（stdout 需每行一个策略名）'};
  return {items:items, error:''};
}
/* 主控当前选中的部署策略（input 自由文本，可手输列表外名称；空串=不使用） */
function curStrategy(){ const i=$('deployStrategyName'); return i?i.value.trim():''; }
/* 主控「权重路径」（可选）：非空时作为 MODEL_PATH 环境变量注入本次运行的每个任务；仅本地保存，不上送服务端 */
function curWeightsPath(){ const i=$('weightsPath'); return i?i.value.trim():''; }
function strategyPanelOpen(which){ const p=pickCtx(which).strategyPanel; return !!(p && p.style.display!=='none'); }
/* 拉取当前分支的策略列表进缓存；仅面板打开时重绘（初始化调用不弹面板）；which 区分主控 / 定时页面板 */
async function loadDeployStrategies(force, which){
  const ctx=pickCtx(which); const repo=ctx.repo(); const branch=ctx.branch();
  const src=strategySourceOf(repo);
  const key=deployStrategyKey(repo,branch);
  if(!src){ delete deployStrategies[key]; if(strategyPanelOpen(which)) renderStrategyPanel(false, which); return; }
  const cached=deployStrategies[key];
  if(!force && cached && !cached.loading){ if(strategyPanelOpen(which)) renderStrategyPanel(false, which); return; }
  deployStrategies[key]={loading:true}; if(strategyPanelOpen(which)) renderStrategyPanel(false, which);
  deployStrategies[key]= src.mode==='script' ? await fetchDeployStrategiesByScript(src.script, repo, branch) : await fetchDeployStrategies(src.url, branch);
  if(strategyPanelOpen(which)) renderStrategyPanel(false, which);
}
/* 部署策略搜索面板：与分支/Tag 面板同款——头部仓库/分支/个数 + ⟳ 重新拉取，列表按输入筛选，点选回填 */
function renderStrategyPanel(showAll, which){
  const ctx=pickCtx(which); const panel=ctx.strategyPanel; const inp=ctx.strategyInp; if(!panel||!inp) return;
  const repo=ctx.repo(); const branch=ctx.branch();
  const q=showAll?'':inp.value.trim().toLowerCase();
  const src=strategySourceOf(repo);
  const st=src?deployStrategies[deployStrategyKey(repo,branch)]:null;
  const ready=st&&!st.loading&&!st.error;
  let h='<div style="display:flex;align-items:center;justify-content:space-between;padding:2px 4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:4px;">'
    +'<span class="dshell-muted" style="font-size:10px;">'+esc(repo.name)+' · '+esc(branch)+(src?(' · '+(src.mode==='script'?'脚本':'URL')):'')+(ready?(' · '+st.items.length+' 策略'):(' · '+loadingDots()))+'</span>'
    +'<span data-strategyrefresh style="cursor:pointer;color:var(--dsw-alias-state-accent-primary);font-size:11px;" title="重新拉取">⟳</span></div>';
  if(!src){ h+='<div class="dshell-muted" style="font-size:11px;padding:4px 6px;">未配置部署策略（URL 或脚本），请在「设置」页代码仓中配置</div>'; }
  else if(!st || st.loading){ h+='<div class="dshell-muted" style="font-size:11px;padding:4px 6px;">加载中'+loadingDots()+'</div>'; }
  else if(st.error){ h+='<div style="color:var(--log-err);font-size:11px;padding:4px 6px;white-space:pre-wrap;">✗ '+esc(st.error.slice(0,200))+'</div>'; }
  else {
    const cur=inp.value.trim();
    const items=st.items.filter(n=>!q||n.toLowerCase().indexOf(q)>=0).slice(0,200);
    const item=(name)=>'<div data-strategy="'+esc(name)+'" style="padding:3px 8px;cursor:pointer;border-radius:5px;font-size:12px;'+(name===cur?'color:var(--dsw-alias-state-accent-primary);font-weight:600;':'')+'">'+(name?esc(name):'<span class="dshell-muted">（不使用）</span>')+'</div>';
    h+=item('');
    if(!items.length){ h+='<div class="dshell-muted" style="font-size:11px;padding:4px 6px;">无匹配</div>'; }
    else { h+='<div class="dshell-muted" style="font-size:10px;padding:3px 8px 2px;opacity:.7;">策略（'+items.length+'）</div>'+items.map(item).join(''); }
  }
  panel.innerHTML=h; panel.style.display='block';
  if(which==='run') positionPipelineRunPanel('pipelineRunStrategyPanel','pipelineRunStrategy');
  panel.querySelectorAll('[data-strategy]').forEach(el=>el.addEventListener('click',()=>{ inp.value=el.getAttribute('data-strategy'); panel.style.display='none'; inp.focus(); }));
  const rb=panel.querySelector('[data-strategyrefresh]'); if(rb) rb.addEventListener('click', ()=>loadDeployStrategies(true, which));
}
function slug(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
function stageIdFor(name){
  const lc=(name||'').toLowerCase();
  const map={'检出':'checkout','checkout':'checkout','校验':'validate','validate':'validate','审批':'approval','approval':'approval','构建镜像':'build','构建':'build','build':'build','推送镜像':'push','push':'push','部署到 k8s':'deploy','部署到k8s':'deploy','deploy to k8s':'deploy','deploy':'deploy','健康检查':'health','health':'health',
    'vllm环境检查':'vlcheck','vllm节点准备':'vlprepare','部署prefill(pp)':'vlprefill','部署decode(dp)':'vldecode','等待服务就绪':'vlwait','重建pd-proxy':'vlproxy','p/d联调验证':'vlverify'};
  if(map[name]) return map[name];
  if(map[lc]) return map[lc];
  return slug(name)||null;
}
function parseStagesText(text){
  return text.split('\n').map(l=>l.trim()).filter(Boolean).map((l,idx)=>{
    const parts=l.split(',').map(s=>s.trim());
    const name=parts[0]||('阶段 '+(idx+1));
    const dur=parts[1]?Math.max(1,parseInt(parts[1])||5):5;
    const skip=parts[2]==='skip'||parts[2]==='gate'||parts[2]==='不执行';   // 兼容旧文本中的 gate 标记
    let id=stageIdFor(name)||('st'+idx);
    return {id,name,dur,skip,sub:[]};
  });
}
