/* ===== 01-server-state.js · 内置流水线定义（小节标题）与服务端持久化：配置与运行历史读写、三方合并、串行保存锁 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 1014–1785）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* ---------- 流水线定义（内置） ---------- */

/* ---------- 服务端持久化（配置 + 运行历史，存服务端 ~/.dsh/storages/worktable-pipeline.json；日志不内嵌，走归档文件引用） ---------- */
/* 基线（最近一次成功 GET/PUT 的服务端配置；PUT 携带它做多浏览器三方合并）随会话持久化到
   localStorage（pip-server-base）：此前基线只存内存，页面重载即丢——保存失败/未及上送的本地改动
   在重载后的首次 GET 合并里被误判成「双边都改取服务端」而静默回滚，且离线缓存被旧值覆盖
   （改动彻底丢失）。持久化后重载仍知道「上次确认的服务端状态」：本地≠基线而远端==基线的在途
   改动按既有口径保留本地，并由 loadServerState 标记 migrated 回推一次补送服务端。 */
function loadServerBaseLS(){ try{ const v=JSON.parse(localStorage.getItem('pip-server-base')); if(v&&typeof v==='object'&&!Array.isArray(v)) return v; }catch(e){} return null; }
function markServerBaseConfirmed(){ try{ if(serverConfigBase&&typeof serverConfigBase==='object') localStorage.setItem('pip-server-base', JSON.stringify(serverConfigBase)); }catch(e){} }
function persistState(){
  if(persistTimer) clearTimeout(persistTimer);
  persistTimer=setTimeout(pushState, 400);   // 不在此拦 stateLoaded：交由 pushState 先重试加载再决定写不写
}
/* 收集上送服务端的配置：代码仓条目保留访问令牌 pass（明文随配置保存到服务端 worktable-pipeline.json，
   团队各浏览器共享）；视图状态与定时环境选择同随服务端持久化——例外：编辑器草稿 pip-plDraft 仍仅存本浏览器（未过校验的半成品，见 savePlDraft）。
   其中筛选/页大小（histFilter/plFilter/histPageSize/plPageSize）服务端按登录用户隔离存 userViewStates[username]，
   同用户跨浏览器跟随、互不覆盖他人（API 形态不变，仍是顶层键）；schedEnvIds 定时环境仍团队共享。
   运行流水线行的临时配置（curPipelineId/selectedEnvIds/curRepoId/branch/strategy/预设勾选）只存浏览器
   localStorage，不上送服务端——各人临时调整自己的运行参数，不覆盖他人浏览器的取值。 */
function collectConfig(){
  return { pipelines:pipelines.filter(p=>!builtinSeedOmittable(p)), environments,
    repositories: repositories.map(function(r){ return Object.assign({}, r); }),
    scriptsDir, theme: themePref, buildNo, cleanupScript, checkScript, profilingScript, customPresets, jenkins, evaltok, prom,
    archiveDir, archiveScriptName, analysisPrompts, histClearedAt,
    schedEnvIds: Array.isArray(schedEnvIds)?schedEnvIds.slice():[],
    histFilter: {kw:String(histFilter.kw||''),status:String(histFilter.status||''),pipeline:String(histFilter.pipeline||'')},
    plFilter: {kw:String(plFilter.kw||''),owner:String(plFilter.owner||'mine'),favorite:plFilter.favorite==='favorite'?'favorite':'all'},
    histPageSize: Math.max(1,parseInt(histPageSize,10)||10),
    plPageSize: Math.max(1,parseInt(plPageSize,10)||10) };
}
function historyForPersist(){
  const transient=['_lc','_lm','_ll','_profChecked','_profState'];
  return history.filter(h=>!h.demo).map(h=>{
    const clean={}; Object.keys(h).forEach(k=>{ if(transient.indexOf(k)<0) clean[k]=h[k]; }); return clean;
  });
}
function historyPersistSig(text){
  let h1=5381, h2=0;
  for(let i=0;i<text.length;i++){ const c=text.charCodeAt(i); h1=((h1<<5)+h1+c)|0; h2=((h2<<7)+h2+c)|0; }
  return text.length+':'+h1+':'+h2;
}
/* 历史被服务端内容整体替换（首次加载 / 定时刷新）即与服务端一致：标记已同步；随后的本地改动
   （新运行记录、清空、内嵌日志迁移）会改变签名，下次保存自动恢复携带。 */
function historyMarkSynced(){ historySyncSig=historyPersistSig(JSON.stringify(historyForPersist())); }
/* 服务端可能把其他浏览器对“不同流水线”的修改一起合入本次 PUT 响应。把这些结果同步回当前页，
   但保留请求在途期间本页产生的更新，避免下一次保存又把刚合入的远端流水线误删。 */
function reconcilePipelinesAfterSave(submitted, accepted, current){
  const before=Array.isArray(submitted)?submitted:[], remote=Array.isArray(accepted)?accepted:[], now=Array.isArray(current)?current:[];
  const beforeById=new Map(before.filter(p=>p&&p.id).map(p=>[String(p.id),p]));
  const remoteById=new Map(remote.filter(p=>p&&p.id).map(p=>[String(p.id),p]));
  const nowById=new Map(now.filter(p=>p&&p.id).map(p=>[String(p.id),p]));
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const order=[];
  remote.concat(now).forEach(p=>{ const id=String(p&&p.id||''); if(id&&order.indexOf(id)<0) order.push(id); });
  const result=[];
  order.forEach(id=>{
    const hadBefore=beforeById.has(id), hasNow=nowById.has(id);
    const changedWhileSaving=hadBefore!==hasNow||(hadBefore&&hasNow&&!same(beforeById.get(id),nowById.get(id)));
    if(changedWhileSaving){ if(hasNow) result.push(nowById.get(id)); }
    else if(remoteById.has(id)) result.push(remoteById.get(id));
  });
  return result;
}
/* 内容比对用的条目副本：剥离顶层 favoriteUsers / pinnedAt（与服务端 src/index.ts 的 stripPipelineSharedMeta
   同口径——二者是共享条目上的非内容元数据：收藏按用户、置顶任何人可改，不参与内容同一性比对，
   否则他人收藏/置顶会被误判为内容变化）。 */
function stripPipelineSharedMeta(entry){
  if(!entry||typeof entry!=='object'||Array.isArray(entry)) return entry;
  const copy={};
  Object.keys(entry).forEach(k=>{ if(k!=='favoriteUsers'&&k!=='pinnedAt') copy[k]=entry[k]; });
  return copy;
}
/* loadServerState 的流水线按 id 三方合并（替代整表替换：自愈重拉不再把本地未落盘内容冲掉）：
   共同基线 = serverConfigBase.pipelines，本地 = 当前全局 pipelines，远端 = GET 响应 cfg.pipelines。
   - 仅本地存在（基线/远端都无）：本地新增未落盘 → 保留（维持本地相对顺序，追加在合并结果末尾）；
   - 基线有、远端无（远端已删除）：本地与基线一致 → 随远端删除；本地相对基线有改动（删除可能正撞
     保存在途）→ 保留本地，并把原基线条目收进 keptBaseEntries（调用方补回新基线，口径见其注释）；
   - 本地==基线 → 取远端；远端==基线 → 保留本地；双边都改且内容不一致 → 取远端（同步语义下服务端为准）；
   - 仅远端存在：他端新增 → 取远端（远端新增/修改/删除照常同步到页面）。
   内容比对一律用 stripPipelineSharedMeta 剥离顶层 favoriteUsers/pinnedAt 后的副本（比对豁免口径与服务端合并层一致）。
   结果顺序：先按远端顺序（保留他端新增的位置），再追加仅本地的条目（维持本地相对顺序）。 */
function mergePipelinesFromServer(baseList, localList, remoteList){
  const valid=p=>p&&typeof p==='object'&&!Array.isArray(p)&&p.id!==undefined&&p.id!==null;
  const mapOf=list=>{ const m=new Map(); (Array.isArray(list)?list:[]).forEach(p=>{ if(valid(p)) m.set(String(p.id),p); }); return m; };
  const base=mapOf(baseList), local=mapOf(localList), remote=mapOf(remoteList);
  /* 与服务端 sameEntry 同口径：存在性一致且剥离共享元数据后内容相等 */
  const same=(a,b)=>{ const ah=a!==undefined, bh=b!==undefined; return ah===bh&&(!ah||JSON.stringify(stripPipelineSharedMeta(a))===JSON.stringify(stripPipelineSharedMeta(b))); };
  const result=[], keptBaseEntries=[], seen=new Set();
  (Array.isArray(remoteList)?remoteList:[]).forEach(p=>{
    if(!valid(p)) return; const id=String(p.id); if(seen.has(id)) return; seen.add(id);
    const b=base.get(id), l=local.get(id), r=remote.get(id);
    if(!local.has(id)){ if(!same(r,b)) result.push(r); return; }   /* 本地已删除：远端未改（==基线）维持本地删除（在途删除不复活）；远端也改则服务端为准恢复远端版 */
    if(same(l,b)){ result.push(r); return; }                        /* 本地未改：取远端（远端新增/修改照常同步） */
    if(same(r,b)){ result.push(l); return; }                        /* 远端未改：保留本地（在途修改不被重拉冲掉） */
    result.push(r);                                                 /* 双边都改且不一致：服务端为准 */
  });
  (Array.isArray(localList)?localList:[]).forEach(p=>{
    if(!valid(p)) return; const id=String(p.id); if(seen.has(id)) return; seen.add(id);
    const b=base.get(id), l=local.get(id);
    if(!base.has(id)){ result.push(l); return; }                    /* 仅本地存在：本地新增未落盘，保留 */
    /* 基线有、远端无（远端已删除）：本地==基线随远端删除；本地有改动（保存在途）保留本地，
       并记下原基线条目——新基线必须保留它，否则基线回退成「无」后下次 save-one 的 baseOne=null 与
       diskOne=null 相等，会把他人刚删的条目静默重建（本应 409 由用户抉择） */
    if(!same(l,b)){ result.push(l); keptBaseEntries.push(b); }
  });
  return {pipelines:result, keptBaseEntries};
}
/* 节点环境条目比对：只看 normalizeEnv 的规范字段（id/name/ip/nodeIp/llmAddr/user/pass），与键序、多余字段无关——
   基线条目来自服务端快照（原始 JSON），本页条目经 normalizeEnv 归一，直接 JSON.stringify 会 phantom 不同。 */
function sameEnvEntry(a,b){
  if(a===b) return true;
  if(!a||!b) return false;
  return String(a.id)===String(b.id) && String(a.name||'')===String(b.name||'') && String(a.ip||'')===String(b.ip||'')
    && String(a.nodeIp||'')===String(b.nodeIp||'') && String(a.llmAddr||'')===String(b.llmAddr||'')
    && String(a.user||'')===String(b.user||'') && String(a.pass||'')===String(b.pass||'');
}
/* loadServerState 的节点环境按 id 三方合并（与流水线 mergePipelinesFromServer 同口径，替代整表替换）：
   共同基线 = serverConfigBase.environments，本地 = 当前全局 environments，远端 = GET 响应 cfg.environments。
   - 仅本地存在（基线/远端都无）：本地新增未落盘 → 保留（追加在合并结果末尾）——409 自愈重拉、
     他端保存触发的快照同步不再把本页刚添加的节点冲掉；
   - 基线有、远端无（远端已删除）：本地与基线一致 → 随远端删除；本地相对基线有改动（删除正撞保存在途）→ 保留本地；
   - 本地==基线 → 取远端；远端==基线 → 保留本地；双边都改且内容不一致 → 取远端（同步语义下服务端为准）；
   - 本地无、远端有：远端==基线 → 维持本地删除（在途删除不复活）；远端已改或为新增 → 取远端。
   结果顺序：先按远端顺序（保留他端新增的位置），再追加仅本地的条目。 */
function mergeEnvironmentsFromServer(baseList, localList, remoteList){
  const valid=e=>e&&typeof e==='object'&&!Array.isArray(e)&&e.id!==undefined&&e.id!==null&&String(e.id)!=='';
  const mapOf=list=>{ const m=new Map(); (Array.isArray(list)?list:[]).forEach(e=>{ if(valid(e)) m.set(String(e.id),e); }); return m; };
  const base=mapOf(baseList), local=mapOf(localList), remote=mapOf(remoteList);
  const same=(a,b)=>{ const ah=a!==undefined, bh=b!==undefined; return ah===bh&&(!ah||sameEnvEntry(a,b)); };
  const result=[], seen=new Set();
  (Array.isArray(remoteList)?remoteList:[]).forEach(e=>{
    if(!valid(e)) return; const id=String(e.id); if(seen.has(id)) return; seen.add(id);
    const b=base.get(id), l=local.get(id), r=remote.get(id);
    if(!local.has(id)){ if(!same(r,b)) result.push(normalizeEnv(r)); return; }   /* 本地已删除：远端未改维持删除；远端已改/他端新增取远端 */
    if(same(l,b)){ result.push(normalizeEnv(r)); return; }                       /* 本地未改：取远端（远端新增/修改照常同步） */
    if(same(r,b)){ result.push(l); return; }                                     /* 远端未改：保留本地（在途修改不被重拉冲掉） */
    result.push(normalizeEnv(r));                                                /* 双边都改且不一致：服务端为准 */
  });
  (Array.isArray(localList)?localList:[]).forEach(e=>{
    if(!valid(e)) return; const id=String(e.id); if(seen.has(id)) return; seen.add(id);
    const b=base.get(id), l=local.get(id);
    if(!base.has(id)){ result.push(l); return; }                                 /* 仅本地存在：本地新增未落盘，保留 */
    if(!same(l,b)) result.push(l);                                               /* 基线有、远端无（远端已删）：本地有改动（保存在途）保留本地 */
  });
  return result;
}
/* 代码仓条目比对：只看 normalizeRepo 的规范字段（id/name/url/user/pass/fetchMode/jenkinsJob/strategyUrl/strategyMode/strategyScript），
   与键序、多余字段无关——基线条目来自服务端快照（原始 JSON），本页条目经 normalizeRepo 归一，直接 JSON.stringify 会 phantom 不同。 */
function sameRepoEntry(a,b){
  if(a===b) return true;
  if(!a||!b) return false;
  return String(a.id)===String(b.id) && String(a.name||'')===String(b.name||'') && String(a.url||'')===String(b.url||'')
    && String(a.user||'')===String(b.user||'') && String(a.pass||'')===String(b.pass||'')
    && String(a.fetchMode||'')===String(b.fetchMode||'') && String(a.jenkinsJob||'')===String(b.jenkinsJob||'')
    && String(a.strategyUrl||'')===String(b.strategyUrl||'') && String(a.strategyMode||'')===String(b.strategyMode||'')
    && String(a.strategyScript||'')===String(b.strategyScript||'');
}
/* loadServerState 的代码仓按 id 三方合并（与节点环境 mergeEnvironmentsFromServer 同口径，替代整表替换）：
   共同基线 = serverConfigBase.repositories，本地 = 当前全局 repositories，远端 = GET 响应 cfg.repositories。
   - 仅本地存在（基线/远端都无）：本地新增未落盘 → 保留（追加在合并结果末尾）——409 自愈重拉、
     他端保存触发的快照同步不再把本页刚添加的代码仓冲掉；
   - 基线有、远端无（远端已删除）：本地与基线一致 → 随远端删除；本地相对基线有改动（删除正撞保存在途）→ 保留本地；
   - 本地==基线 → 取远端；远端==基线 → 保留本地；双边都改且内容不一致 → 取远端（同步语义下服务端为准）；
   - 本地无、远端有：远端==基线 → 维持本地删除（在途删除不复活）；远端已改或为新增 → 取远端。
   结果顺序：先按远端顺序（保留他端新增的位置），再追加仅本地的条目。
   合并后对空 pass 做本地令牌回填迁移（与旧版整表替换路径同口径）。 */
function mergeRepositoriesFromServer(baseList, localList, remoteList){
  const valid=r=>r&&typeof r==='object'&&!Array.isArray(r)&&r.id!==undefined&&r.id!==null&&String(r.id)!=='';
  const mapOf=list=>{ const m=new Map(); (Array.isArray(list)?list:[]).forEach(r=>{ if(valid(r)) m.set(String(r.id),r); }); return m; };
  const base=mapOf(baseList), local=mapOf(localList), remote=mapOf(remoteList);
  const same=(a,b)=>{ const ah=a!==undefined, bh=b!==undefined; return ah===bh&&(!ah||sameRepoEntry(a,b)); };
  const result=[], seen=new Set();
  (Array.isArray(remoteList)?remoteList:[]).forEach(r=>{
    if(!valid(r)) return; const id=String(r.id); if(seen.has(id)) return; seen.add(id);
    const b=base.get(id), l=local.get(id), r2=remote.get(id);
    if(!local.has(id)){ if(!same(r2,b)) result.push(normalizeRepo(r2)); return; }   /* 本地已删除：远端未改维持删除；远端已改/他端新增取远端 */
    if(same(l,b)){ result.push(normalizeRepo(r2)); return; }                        /* 本地未改：取远端（远端新增/修改照常同步） */
    if(same(r2,b)){ result.push(normalizeRepo(l)); return; }                        /* 远端未改：保留本地（在途修改不被重拉冲掉） */
    result.push(normalizeRepo(r2));                                                 /* 双边都改且不一致：服务端为准 */
  });
  (Array.isArray(localList)?localList:[]).forEach(r=>{
    if(!valid(r)) return; const id=String(r.id); if(seen.has(id)) return; seen.add(id);
    const b=base.get(id), l=local.get(id);
    if(!base.has(id)){ result.push(normalizeRepo(l)); return; }                     /* 仅本地存在：本地新增未落盘，保留 */
    if(!same(l,b)) result.push(normalizeRepo(l));                                   /* 基线有、远端无（远端已删）：本地有改动（保存在途）保留本地 */
  });
  return result;
}
/* options.silentConflict：409 冲突时不提示、不重拉（编辑器 savePlForm 的回退全量保存使用——
   冲突由编辑器自己的回滚 + alert 单独处理）；默认（含 persistState 防抖调用）非静默。 */
async function pushState(options){
  /* Promise 链互斥（替代 while+await 的 check-then-set）：读链尾与挂链尾之间无 await，同步原子，
     等待者严格按到达顺序逐个放行；链尾无人排队时由 finally 清回 null。基线快照保持拿到锁再取的语义。 */
  const persistPrev=persistInFlight||Promise.resolve();
  let releasePersist;
  const persistMine=new Promise(resolve=>{ releasePersist=resolve; });
  persistInFlight=persistMine;
  await persistPrev;
  try{
  if(persistTimer){ clearTimeout(persistTimer); persistTimer=null; }
  /* 先快照本页要保存的状态：首次加载尚在途时，loadServerState 会刷新全局变量，不能把用户刚点保存的
     内容替换成远端旧值后再提交。共同基线则必须等 GET 成功后再取。 */
  const config=collectConfig(), savedHistory=historyForPersist();
  const historySig=historyPersistSig(JSON.stringify(savedHistory));
  if(!stateLoaded){ await loadServerState(); if(!stateLoaded) return {ok:false,error:'服务端配置加载失败'}; }
  try{
    /* 演示数据（demo 标记）不上服务端；历史只存元数据 + 日志文件路径（全量日志在归档文件）；
       服务端 PUT 路由按 tag/ts 合并磁盘上页面未知的记录（定时运行产出），不再全量覆盖。
       负载瘦身（「保存中…」等待与上行字节数成正比，公网映射等慢上行链路下全量负载曾需 10 秒级）：
       baseConfig 带 pipelines / environments / repositories——服务端三方合并按这三类条目的 id 比对基线
       （mergePipelineConfigForWrite），其余基线字段从不读取；历史正文仅在内容自上次确认同步后有变化时携带（签名比对），
       未变不带——服务端合并对客户端未上报的记录一律按磁盘保留，不丢定时/他端/本页运行历史。 */
    const payload={config, baseConfig:{
      pipelines:(serverConfigBase&&Array.isArray(serverConfigBase.pipelines))?serverConfigBase.pipelines:[],
      /* 节点环境基线随保存上送：服务端据此按 id 三方合并，他端并发新增的节点不再被本页整表覆盖 */
      environments:(serverConfigBase&&Array.isArray(serverConfigBase.environments))?serverConfigBase.environments:[],
      /* 代码仓基线随保存上送：服务端据此按 id 三方合并，他端并发新增/修改的代码仓不再被本页整表覆盖 */
      repositories:(serverConfigBase&&Array.isArray(serverConfigBase.repositories))?serverConfigBase.repositories:[],
    }};
    if(historySig!==historySyncSig) payload.history=savedHistory;
    /* 看门狗：链路黑洞（连接在但无响应）时 60 秒中止，防一次卡死的 PUT 长期占用 persistInFlight、
       后续保存全部排队假死；合并写幂等，中止后重发安全 */
    const abortCtrl=new AbortController(); const abortTimer=setTimeout(()=>abortCtrl.abort(),60000);
    let r;
    try{ r=await fetch('/api/worktable/pipeline',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:abortCtrl.signal}); }
    catch(e){ if(e&&e.name==='AbortError') return {ok:false,error:'保存请求超过 60 秒无响应，已中止；请检查网络后重试（编辑内容仍保留）'}; throw e; }
    finally{ clearTimeout(abortTimer); }
    let body={}; try{ body=await r.json(); }catch(e){}
    if(r.status===403){
      /* 可信流水线服务端强制拦截（非 admin 直调 API 同样被拒，body 形如
         {error:'trusted', message:'…', pipelineIds:[…]}）：toast 服务端 message 并重拉状态同步。
         403 是权限拒绝而非冲突/网络错误：不走 conflict 语义、不重试，定义以服务端为准。 */
      const msg403=(body && typeof body.message==='string' && body.message.trim()) ? body.message.trim() : '流水线已被管理员标记为可信，仅 admin 可编辑';
      if(typeof toast==='function') toast(msg403); else if(typeof alert==='function') alert(msg403);
      try{ if(typeof loadServerState==='function') await loadServerState(); if(typeof renderPipelines==='function') renderPipelines(); }catch(e){}
      return {ok:false, status:403, trusted:true, error:String((body && body.error)||'HTTP 403')};
    }
    if(!r.ok){
      const failure={ok:false, conflict:r.status===409, conflicts:Array.isArray(body.conflicts)?body.conflicts:[], error:String(body.error||('HTTP '+r.status))};
      if(r.status===409 && !(options&&options.silentConflict)){
        /* 非编辑器路径（复制兜底重试/删除/收藏/置顶/设置等）的 409：此前只 return，冲突静默失败且
           基线 serverConfigBase 不前进，后续保存持续 409 锁死。这里 toast 告知并重拉服务端状态自愈——
           重拉按 id 三方合并（远端版本同步进来、本地未落盘内容保留，见 mergePipelinesFromServer）、
           基线随之前进，用户重试操作即可。conflictHandled 标记供
           自带失败处理的调用方识别「已提示并重拉」，避免双重提示。 */
        if(typeof toast==='function') toast('保存冲突：数据已被他人修改，已刷新为最新状态，请重试操作');
        try{ if(typeof loadServerState==='function') await loadServerState(); if(typeof renderPipelines==='function') renderPipelines(); }catch(e){}
        failure.conflictHandled=true;
      }
      return failure;
    }
    if(body.config && typeof body.config==='object' && !Array.isArray(body.config)){
      serverConfigBase=JSON.parse(JSON.stringify(body.config));
      if(typeof markServerBaseConfirmed==='function') markServerBaseConfirmed();   // 基线前进随会话持久化（typeof 守卫：沙盒单独抽取本函数时未随行）；下同
      stateFetchEpoch+=1;   // 基线前进（保存确认）：在途 GET 快照自此视为过期（见 fetchPipelineStateFresh）
      if(Array.isArray(body.config.pipelines) && typeof pipelines!=='undefined'){
        /* reconcile 后重新内置置顶重组：免上送的纯净内置种子不在 accepted 里，reconcile 会把它们
           追加到尾部，这里按注册表口径恢复「内置在前、自定义保持相对序」 */
        pipelines=regroupBuiltinPipelines(reconcilePipelinesAfterSave(config.pipelines,body.config.pipelines,pipelines))
          .map(p=>JSON.parse(JSON.stringify(p))).map(migrateGate).map(migrateStageUrl).map(migratePrefillDefaults).map(migratePipelineDefaults).map(migratePromPreset);
        try{ localStorage.setItem('pip-pipelines',JSON.stringify(pipelines)); }catch(e){}
      }
      /* 节点环境同样按响应合回：服务端三方合并可能带进他端并发新增/修改的节点；
         请求在途期间本页产生的环境改动（继续添加/编辑/删除）由 reconcile 保留，不被响应覆盖。
         reconcilePipelinesAfterSave 是通用 id 协调（submitted/accepted/current 三份快照比对），与环境条目同构复用。 */
      if(Array.isArray(body.config.environments) && typeof environments!=='undefined'){
        environments=reconcilePipelinesAfterSave(config.environments,body.config.environments,environments)
          .map(e=>JSON.parse(JSON.stringify(e))).map(normalizeEnv);
        try{ localStorage.setItem('pip-envs',JSON.stringify(environments)); }catch(e){}
      }
      /* 代码仓同样按响应合回：服务端三方合并可能带进他端并发新增/修改的代码仓；
         请求在途期间本页产生的代码仓改动（继续添加/编辑/删除）由 reconcile 保留，不被响应覆盖。 */
      if(Array.isArray(body.config.repositories) && typeof repositories!=='undefined'){
        repositories=reconcilePipelinesAfterSave(config.repositories,body.config.repositories,repositories)
          .map(r=>JSON.parse(JSON.stringify(r))).map(normalizeRepo);
        try{ localStorage.setItem('pip-repos',JSON.stringify(repositories)); }catch(e){}
        if(typeof renderRepos==='function') renderRepos();
        if(typeof renderRepoOptions==='function') renderRepoOptions();
      }
    }
    historySyncSig=historySig;   // 本批历史已确认落盘：下次内容未变不再携带
    return {ok:true,config:body.config||config};
  }catch(e){ return {ok:false,error:String(e&&e.message||e)}; }
  }finally{
    releasePersist();
    if(persistInFlight===persistMine) persistInFlight=null;   /* 自己是链尾（无后续排队者）才清回 null；否则链已交给下一个等待者 */
  }
}
/* 编辑器单条保存：只上传当前编辑的流水线（约 KB 级，慢上行链路秒级以内；全量 PUT 曾需 10 秒级），
   服务端按 id 三方合并（mergePipelineOneForWrite），不触碰历史与其他配置字段。
   与 pushState 共用 persistInFlight 串行锁——基线快照必须等锁到手后再取（等待期间前序保存确认的
   新基线才是本条合并的共同基线）。旧服务端无此路由（404）时返回 unsupported，由调用方回退全量保存。 */
async function pushPipelineOne(pipelineId){
  /* Promise 链互斥（与 pushState 同一条链，写法与口径见其头部注释）：严格按到达顺序逐个放行。 */
  const persistPrev=persistInFlight||Promise.resolve();
  let releaseOne;
  const persistMine=new Promise(resolve=>{ releaseOne=resolve; });
  persistInFlight=persistMine;
  await persistPrev;
  try{
  const edited=findPipeline(pipelineId);
  if(!edited) return {ok:false,error:'流水线已不在本页列表中（可能被其他浏览器删除），请刷新后重试'};
  const pipelineSnap=JSON.parse(JSON.stringify(edited));
  const localSnap=JSON.parse(JSON.stringify(pipelines));   // 响应合入时的本页快照（reconcilePipelinesAfterSave 语义同 pushState）
  const baseList=(typeof serverConfigBase!=='undefined'&&serverConfigBase&&Array.isArray(serverConfigBase.pipelines))?serverConfigBase.pipelines:[];
  const baseOne=baseList.find(p=>p&&p.id===pipelineId)||null;
  try{
    const payload={pipeline:pipelineSnap, basePipeline:baseOne, scriptsDir};
    /* 看门狗与 pushState 同理：黑洞链路 60 秒中止，防串行锁被卡死 */
    const abortCtrl=new AbortController(); const abortTimer=setTimeout(()=>abortCtrl.abort(),60000);
    let r;
    try{ r=await fetch('/api/worktable/pipeline/save-one',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:abortCtrl.signal}); }
    catch(e){ if(e&&e.name==='AbortError') return {ok:false,error:'保存请求超过 60 秒无响应，已中止；请检查网络后重试（编辑内容仍保留）'}; throw e; }
    finally{ clearTimeout(abortTimer); }
    if(r.status===404) return {ok:false, unsupported:true};
    let body={}; try{ body=await r.json(); }catch(e){}
    if(r.status===403){
      /* 可信流水线服务端强制拦截（语义同 pushState 的 403 分支）：toast 服务端 message 并重拉状态同步；
         不回退全量保存（那是给网络错误/冲突用的），由调用方按 saved.trusted 收尾。 */
      const msg403=(body && typeof body.message==='string' && body.message.trim()) ? body.message.trim() : '流水线已被管理员标记为可信，仅 admin 可编辑';
      if(typeof toast==='function') toast(msg403); else if(typeof alert==='function') alert(msg403);
      try{ if(typeof loadServerState==='function') await loadServerState(); if(typeof renderPipelines==='function') renderPipelines(); }catch(e){}
      return {ok:false, status:403, trusted:true, error:String((body && body.error)||'HTTP 403')};
    }
    if(!r.ok){
      if(r.status===409 && body.config && typeof body.config==='object' && !Array.isArray(body.config)){
        /* 409 响应携带磁盘真值（save-one 路由冲突时回传 diskCfg）：采纳为新基线并合回本页（语义同成功分支）。
           陈旧基线的 phantom 冲突（典型：复制副本落盘后基线被过期 GET 快照污染成「无此条目」，或另一标签页
           复制的副本晚于本页基线）此前把该条目永久锁死在 409——每次 save-one 都 baseOne=null ≠ 磁盘条目，
           编辑器反复回滚改名并误报「被其他浏览器修改」。基线本来就是「服务端已确认状态」的缓存，
           采纳后编辑器回滚按 baseAdvanced 取前进后的最新确认版，用户重试保存即成功；真实并发冲突同义正确。 */
        serverConfigBase=JSON.parse(JSON.stringify(body.config));
        if(typeof markServerBaseConfirmed==='function') markServerBaseConfirmed();   // 409 采纳磁盘真值为新基线：随会话持久化（口径同成功分支）
        stateFetchEpoch+=1;
        if(Array.isArray(body.config.pipelines) && typeof pipelines!=='undefined'){
          pipelines=regroupBuiltinPipelines(reconcilePipelinesAfterSave(localSnap,body.config.pipelines,pipelines))
            .map(p=>JSON.parse(JSON.stringify(p))).map(migrateGate).map(migrateStageUrl).map(migratePrefillDefaults).map(migratePipelineDefaults).map(migratePromPreset);
          try{ localStorage.setItem('pip-pipelines',JSON.stringify(pipelines)); }catch(e){}
        }
      }
      return {ok:false, conflict:r.status===409, conflicts:Array.isArray(body.conflicts)?body.conflicts:[], error:String(body.error||('HTTP '+r.status))};
    }
    if(body.config && typeof body.config==='object' && !Array.isArray(body.config)){
      serverConfigBase=JSON.parse(JSON.stringify(body.config));
      if(typeof markServerBaseConfirmed==='function') markServerBaseConfirmed();   // 基线前进随会话持久化（typeof 守卫：沙盒单独抽取本函数时未随行）；下同
      stateFetchEpoch+=1;   // 基线前进（保存确认）：在途 GET 快照自此视为过期（见 fetchPipelineStateFresh）
      if(Array.isArray(body.config.pipelines) && typeof pipelines!=='undefined'){
        pipelines=regroupBuiltinPipelines(reconcilePipelinesAfterSave(localSnap,body.config.pipelines,pipelines))
          .map(p=>JSON.parse(JSON.stringify(p))).map(migrateGate).map(migrateStageUrl).map(migratePrefillDefaults).map(migratePipelineDefaults).map(migratePromPreset);
        try{ localStorage.setItem('pip-pipelines',JSON.stringify(pipelines)); }catch(e){}
      }
    }
    return {ok:true,config:body.config||{}};
  }catch(e){ return {ok:false,error:String(e&&e.message||e)}; }
  }finally{
    releaseOne();
    if(persistInFlight===persistMine) persistInFlight=null;   /* 自己是链尾（无后续排队者）才清回 null */
  }
}
/* GET /api/worktable/pipeline，并保证快照不落后于任何一次基线前进：请求在途期间若有保存被确认
   （stateFetchEpoch 前进），响应快照可能取于该次保存落盘之前——按它三方合并会把刚落盘的条目误判为
   「远端已删除」（基线有、远端无、本地==基线 → 随远端删除），刚复制的副本即从页面消失、基线被污染。
   过期则重拉（上限 2 次防活锁；仍过期则按现有合并口径应用，不劣于修复前）。 */
async function fetchPipelineStateFresh(){
  let st=null, epochAtFetch=stateFetchEpoch, retries=0;
  for(;;){
    st=null;
    try{ const r=await fetch('/api/worktable/pipeline'); if(r.ok) st=await r.json(); }catch(e){}
    if(!st || stateFetchEpoch===epochAtFetch || retries>=2) return st;
    retries+=1; epochAtFetch=stateFetchEpoch;
  }
}
async function loadServerState(){
  const st=await fetchPipelineStateFresh();
  /* 旧版服务端配置迁移标记：服务端缺新键（且启动时本地有对应旧值，见 legacyLocalKeys）或代码仓条目
     服务端令牌为空而本地有同 id 令牌时置位；finally 里据此 persistState 一次，把迁移结果推上服务端 */
  let migrated=false;
  try{
    /* 流水线/节点环境/代码仓三方合并的共同基线必须先取出：serverConfigBase 随后即被响应快照替换 */
    const prevBasePipelines=(serverConfigBase&&Array.isArray(serverConfigBase.pipelines))?serverConfigBase.pipelines:[];
    const prevBaseEnvironments=(serverConfigBase&&Array.isArray(serverConfigBase.environments))?serverConfigBase.environments:[];
    const prevBaseRepositories=(serverConfigBase&&Array.isArray(serverConfigBase.repositories))?serverConfigBase.repositories:[];
    if(st){ serverConfigBase=JSON.parse(JSON.stringify((st.config&&typeof st.config==='object'&&!Array.isArray(st.config))?st.config:{})); if(typeof markServerBaseConfirmed==='function') markServerBaseConfirmed(); stateFetchEpoch+=1; }   // 基线前进（新鲜快照应用，随会话持久化）：在途 GET 快照自此视为过期
    if(st && st.config && Object.keys(st.config).length){
      const cfg=st.config;
      if(Array.isArray(cfg.pipelines) && cfg.pipelines.length){
        /* 按 id 三方合并（替代整表替换）：自愈重拉不再把本地未落盘的新增/修改冲掉，合并口径见 mergePipelinesFromServer */
        const merged=mergePipelinesFromServer(prevBasePipelines, pipelines, cfg.pipelines);
        pipelines=regroupBuiltinPipelines(merged.pipelines).map(migrateGate).map(migrateStageUrl).map(migratePrefillDefaults).map(migratePipelineDefaults).map(migratePromPreset);
        rebindBuiltinScriptPaths();   /* 服务端版本内置替换种子后，按名对齐当前 scriptsDir 的脚本路径 */
        /* 新基线以响应快照为准，但「保留的本地条目」不得让基线回退到错误状态：
           - 本地新增（基线本就无）：快照里本来就没有，保持无基线——下次 save-one 的 baseOne=null 与磁盘比对，
             磁盘也无即正常新增落盘；
           - 基线有但远端缺、本地有改动而保留的条目：把原基线条目补回新基线——否则 baseOne 变成 null 后与
             diskOne(null) 相等，下次 save-one 会把他人刚删的条目静默重建（本应 409 由用户抉择）。 */
        if(merged.keptBaseEntries.length) serverConfigBase.pipelines=(Array.isArray(serverConfigBase.pipelines)?serverConfigBase.pipelines:[]).concat(merged.keptBaseEntries.map(p=>JSON.parse(JSON.stringify(p))));
      }
      /* 节点环境按 id 三方合并（替代整表替换）：409 自愈重拉/快照同步不再把本地未落盘的新增节点冲掉，
         他端新增/修改/删除照常同步进来；合并口径见 mergeEnvironmentsFromServer。
         例外：已确认身份的非 admin 以服务端为权威整表替换（含空数组）——服务端 environmentsWriteDeny
         会 403 拒绝非 admin 的环境变更，本地不得残留分歧（否则随后每次保存都撞 403）；
         admin / 探测在途 / token 模式维持三方合并。 */
      if(Array.isArray(cfg.environments)){
        if(!envConfigEditable()) environments=cfg.environments.map(normalizeEnv);
        else if(cfg.environments.length) environments=mergeEnvironmentsFromServer(prevBaseEnvironments, environments, cfg.environments);
      }
      /* 代码仓按 id 三方合并（替代整表替换，与节点环境 mergeEnvironmentsFromServer 同口径）：
         409 自愈重拉/快照同步不再把本地未落盘的新增/修改代码仓冲掉，他端新增/修改/删除照常同步进来。
         合并后对空 pass 做本地令牌回填迁移：旧版客户端上送时剔除 pass，服务端条目 pass 为空而本页
         （启动时从 localStorage 离线缓存装入）存有同 id 令牌 → 回填并标记 migrated（末尾统一回推一次）；
         服务端已有令牌的条目一律以服务端为准（merge 结果中远端条目已含服务端 pass）。 */
      if(Array.isArray(cfg.repositories) && cfg.repositories.length){
        /* 种子态丢弃：服务端已有真实代码仓，演示种子不再作为本地条目参与合并/上送
         （typeof 守卫：沙盒单独抽取本函数时种子标记可能不存在，口径同 legacyLocalKeys） */
        if(typeof reposSeededByDefault!=='undefined' && reposSeededByDefault){ repositories=[]; reposSeededByDefault=false; }
        const prevPass={}; repositories.forEach(function(r){ if(r.pass) prevPass[r.id]=r.pass; });
        repositories=mergeRepositoriesFromServer(prevBaseRepositories, repositories, cfg.repositories);
        repositories.forEach(function(r){ if(!r.pass && prevPass[r.id]){ r.pass=prevPass[r.id]; migrated=true; } });
        /* 合并结果里有服务端快照解释不了的条目（本地≠基线而远端==基线的在途修改被保留 / 本地新增
           未落盘）＝存在未同步到服务端的本地改动（上次保存失败或未及上送）：标记 migrated 回推一次
           补送——否则要等下一次任意编辑才同步，期间关页又会回到「刷新丢改动」的老问题。
           比对先对服务端条目过 normalizeRepo（缺省键补规范值，如无 fetchMode → 'server'）：合并结果
           已归一，直接比原始快照会把缺键的存量条目误判成「解释不了」→ 每次加载都白排一次写。 */
        if(repositories.some(function(r){ const rr=cfg.repositories.find(function(x){ return x&&String(x.id)===String(r.id); }); return !rr||!sameRepoEntry(r,normalizeRepo(rr)); })) migrated=true;
      }
      /* 视图状态与定时环境选择（定时环境/历史与流水线筛选/页大小）：键存在（含空串/空数组）一律以服务端为准；
         筛选/页大小服务端已按当前登录用户取其槽位（userViewStates[username]），他人改动不会串到本页；
         旧版服务端无该键且启动时 localStorage 有对应旧值（legacyLocalKeys 快照）→ 保留本地值（全局已在启动时
         从 localStorage 装入）并标记 migrated，finally 统一回推一次。stateLoaded 门控不变：服务端不可达时
         本块不执行，不会用默认值覆盖服务端。409/403 自愈重拉也走这里：他端改动借此同步进来；筛选/页大小这类
         视图状态直接按服务端覆盖，文本输入框仅在未聚焦时回写（聚焦中说明正在输入，状态仍已应用、回显留给
         失焦后的渲染）——在途未确认的本地编辑可能被冲掉，编辑动作本身会再触发 persistState 重新上送，属可
         接受取舍。
         运行流水线行的临时配置（当前流水线/环境多选/当前代码仓/分支/部署策略/预设勾选）只存浏览器本地，
         不从服务端覆盖（collectConfig 也不上送）——各人临时调整不影响他人。 */
      const hadLegacy=k=>typeof legacyLocalKeys!=='undefined' && !!legacyLocalKeys[k];   // typeof 守卫：沙盒单独抽取本函数时快照可能不存在
      const setInputVal=(id,v)=>{ const el=$(id); if(!el) return; if(typeof document!=='undefined' && document && document.activeElement===el) return; el.value=v; };
      if(Array.isArray(cfg.schedEnvIds)) schedEnvIds=cfg.schedEnvIds.filter(id=>typeof id==='string');
      else if(hadLegacy('pip-schedEnvSel')) migrated=true;
      if(cfg.histFilter && typeof cfg.histFilter==='object' && !Array.isArray(cfg.histFilter)){
        histFilter={kw:String(cfg.histFilter.kw||''),status:String(cfg.histFilter.status||''),pipeline:String(cfg.histFilter.pipeline||'')};
        /* histFilterPipeline 输入框由 renderHistFilterOptions 按状态回显（自带聚焦守卫），此处只回写另两个控件 */
        setInputVal('histFilterKw', histFilter.kw); setInputVal('histFilterStatus', histFilter.status);
      }
      else if(hadLegacy('pip-histFilter')) migrated=true;
      if(cfg.plFilter && typeof cfg.plFilter==='object' && !Array.isArray(cfg.plFilter)){
        plFilter={kw:String(cfg.plFilter.kw||''),owner:String(cfg.plFilter.owner||'mine'),favorite:cfg.plFilter.favorite==='favorite'?'favorite':'all'};
        setInputVal('plFilterKw', plFilter.kw);
        setInputVal('plFilterOwner', typeof plOwnerFilterLabel==='function'?plOwnerFilterLabel(plFilter.owner):plFilter.owner);
        setInputVal('plFilterFavorite', plFilter.favorite);
      }
      else if(hadLegacy('pip-plFilter')) migrated=true;
      if(Number.isFinite(cfg.histPageSize)){ histPageSize=Math.max(1,parseInt(cfg.histPageSize,10)||10); setInputVal('histPageSize', String(histPageSize)); }
      else if(hadLegacy('pip-histPageSize')) migrated=true;
      if(Number.isFinite(cfg.plPageSize)){ plPageSize=Math.max(1,parseInt(cfg.plPageSize,10)||10); setInputVal('plPageSize', String(plPageSize)); }
      else if(hadLegacy('pip-plPageSize')) migrated=true;
      if(typeof cfg.scriptsDir==='string' && cfg.scriptsDir){ scriptsDir=cfg.scriptsDir; scriptsDirIsFallback=false; }
      else maybeAdoptInstalledScriptsDir();   // 服务端设置文件未配置 scriptsDir：fallback 态改用安装默认（health 未到时由 health 回调再试）
      if(typeof cfg.theme==='string' && ['auto','dark','light'].indexOf(cfg.theme)>=0){ themePref=cfg.theme; $('theme').value=themePref; }
      if(Number.isFinite(cfg.buildNo)) buildNo=cfg.buildNo;
      if(cfg.cleanupScript && typeof cfg.cleanupScript.name==='string') cleanupScript=cfg.cleanupScript;
      if(cfg.checkScript && typeof cfg.checkScript.name==='string') checkScript=cfg.checkScript;
      if(cfg.profilingScript && typeof cfg.profilingScript.name==='string') profilingScript=cfg.profilingScript;
      /* 自定义预设任务：旧服务端数据无此字段时保持本地（localStorage）配置；有则以服务端为准并重建名称表/面板/设置页专区 */
      if(Array.isArray(cfg.customPresets)){ customPresets=normalizeCustomPresets(cfg.customPresets); rebuildPresetNameMap(); renderPresetMultiPanel(); renderPresetMultiBtn(); renderCustomPresetZone(); }
      if(cfg.jenkins && typeof cfg.jenkins==='object') jenkins=Object.assign({}, DEFAULT_JENKINS, cfg.jenkins);
      if(cfg.evaltok && typeof cfg.evaltok==='object') evaltok=Object.assign({}, DEFAULT_EVALTOK, cfg.evaltok);
      else if(cfg.evalscope && typeof cfg.evalscope==='object') evaltok=Object.assign({}, DEFAULT_EVALTOK, cfg.evalscope);   /* 兼容旧 EvalScope 配置快照 */
      if(cfg.prom && typeof cfg.prom==='object') prom=Object.assign({}, DEFAULT_PROM, cfg.prom);
      if(typeof cfg.archiveDir==='string'){ archiveDir=cfg.archiveDir; $('archiveDir').value=archiveDir; }
      if(typeof cfg.archiveScriptName==='string'){ archiveScriptName=cfg.archiveScriptName; $('archiveScriptName').value=archiveScriptName; }
      if(cfg.analysisPrompts && typeof cfg.analysisPrompts==='object') analysisPrompts=Object.assign({}, DEFAULT_PROMPTS, cfg.analysisPrompts);
      if(Number.isFinite(cfg.histClearedAt)) histClearedAt=cfg.histClearedAt;
      /* 服务端历史为空但被显式清空过（histClearedAt）：保持空，不复活内置演示数据 */
      if(Array.isArray(st.history) && st.history.length){ history=st.history; historyMarkSynced(); }
      else if(histClearedAt){ history=[]; historyMarkSynced(); }
      runStages=null; selectedId=curPipeline().stages[0].id;
      /* 同步 localStorage 离线缓存 */
      try{
        localStorage.setItem('pip-pipelines', JSON.stringify(pipelines));
        localStorage.setItem('pip-envs', JSON.stringify(environments));
        localStorage.setItem('pip-envSel', JSON.stringify(selectedEnvIds));
        localStorage.setItem('pip-repos', JSON.stringify(repositories));
        localStorage.setItem('pip-curRepo', curRepoId);
        localStorage.setItem('pip-scriptsDir', scriptsDir);
        localStorage.setItem('pip-curPipeline', curPipelineId);
        /* 定时环境/筛选/页大小随服务端同步，同步后刷新离线缓存（typeof 守卫：沙盒单独抽取本函数时这些全局可能不存在）；
           运行行临时配置（envSel/curRepo/curPipeline/branch/strategy/预设勾选）不从服务端覆盖，这里只把本地值回写缓存 */
        if(typeof schedEnvIds!=='undefined') localStorage.setItem('pip-schedEnvSel', JSON.stringify(schedEnvIds));
        if(typeof histFilter!=='undefined') localStorage.setItem('pip-histFilter', JSON.stringify(histFilter));
        if(typeof plFilter!=='undefined') localStorage.setItem('pip-plFilter', JSON.stringify(plFilter));
        if(typeof histPageSize!=='undefined') localStorage.setItem('pip-histPageSize', String(histPageSize));
        if(typeof plPageSize!=='undefined') localStorage.setItem('pip-plPageSize', String(plPageSize));
        if($('branchName')) localStorage.setItem('pip-branch', $('branchName').value||'');
        if($('deployStrategyName')) localStorage.setItem('pip-strategy', $('deployStrategyName').value||'');
        if($('weightsPath')) localStorage.setItem('pip-weightsPath', $('weightsPath').value||'');
        localStorage.setItem('pip-theme', themePref);
        localStorage.setItem('pip-cleanupScript', JSON.stringify(cleanupScript));
        localStorage.setItem('pip-cleanupEnabled', $('cleanupEnv').checked?'1':'');
        localStorage.setItem('pip-checkScript', JSON.stringify(checkScript));
        localStorage.setItem('pip-checkEnabled', $('checkEnv').checked?'1':'');
        localStorage.setItem('pip-profilingScript', JSON.stringify(profilingScript));
        localStorage.setItem('pip-profilingEnabled', $('profilingEnv').checked?'1':'');
        localStorage.setItem('pip-jenkins', JSON.stringify(jenkins));
        localStorage.setItem('pip-evaltokens', JSON.stringify(evaltok));
        localStorage.setItem('pip-prom', JSON.stringify(prom));
        localStorage.setItem('pip-archiveDir', archiveDir);
        localStorage.setItem('pip-archiveScript', archiveScriptName);
        localStorage.setItem('pip-analysisPrompts', JSON.stringify(analysisPrompts));
        if(typeof customPresets!=='undefined') localStorage.setItem('pip-customPresets', JSON.stringify(customPresets));   // 沙盒单独抽取本函数时 customPresets 可能不存在
      }catch(e){}
      $('cleanupScriptName').value=cleanupScript?cleanupScript.name:'';
      renderCleanupParams();
      $('checkScriptName').value=checkScript?checkScript.name:'';
      renderCheckParams();
      $('profilingScriptName').value=profilingScript?profilingScript.name:'';
      renderProfilingParams();
      renderAll();
      migrateInlineLogs();   // 后台把存量内嵌日志迁移为归档文件引用（完成后自行 persistState）
    }
  } finally {
    /* 仅在成功拉到服务端响应后才打开写入门：拉取失败（服务端暂不可达）保持 stateLoaded=false，
       防止随后保存用本地默认值把服务端历史/配置整体覆盖（pushState 会先重试加载） */
    if(st) stateLoaded=true;
    /* 服务端为空：把本地（localStorage/默认）状态迁移上去 */
    if(st && (!st.config || !Object.keys(st.config).length)) persistState();
    /* 旧版服务端缺新键 / 代码仓令牌被旧版剔除：本地旧值已在上方采用（migrated），回推一次完成迁移
       （沿用上方「服务端为空迁移」同一模式；此时 stateLoaded 已置位，pushState 不会再重试加载） */
    else if(migrated && !_migratedPersistDone){ _migratedPersistDone=true; persistState(); }   // 会话闩锁：旧版 schema 迁移回推最多一次；非 admin 看可信流水线 persist 必 403，不闩则与 migrateInlineLogs 同理死循环
  }
}
async function migrateInlineLogs(){
  /* 一次性会话闩锁。动机：旧版"内嵌日志全文"→新版"归档文件引用"是存量迁移，本应一次性完成。
     bug：非 admin 看可信流水线时 persist 必 403；migrate 在 loadServerState 末尾每次重跑→persist→403→
     403 分支重拉 loadServerState→又重跑 migrate，形成每秒一圈的 229KB GET + 403 PUT + 整页重渲染（#73 的 17-19% CPU）。
     代价：只读用户的迁移不在本会话完成——但只读用户本就写不进去，迁移对他们从不会成功，无真实损失；
     有写权限者（admin）打开时迁移照常落盘。瞬态错误重试推迟到下次刷新，可接受。 */
  if(_migrateInlineLogsDone) return; _migrateInlineLogsDone=true;
  let changed=false;
  for(const rec of history){
    if(!rec || rec.demo || !rec.archive || !rec.tag || !Array.isArray(rec.logs)) continue;
    const inline=rec.logs.filter(l=>l && typeof l.log==='string');
    if(!inline.length) continue;
    let names=null;
    try{
      const r=await fetch('/api/worktable/fs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:rec.archive})});
      const j=await r.json(); names=new Set((j && j.entries || []).map(e=>e.name));
    }catch(e){}
    if(!names) continue;
    const isPreStage=n=>((typeof PRESET_BY_NAME!=='undefined')?!!PRESET_BY_NAME[n]:(n==='环境检查'||n==='环境清理'||n==='Profiling'))||n==='收集普罗数据';   // 预设任务（系统 + 自定义，按名称表判定；沙盒单独抽取本函数时退回系统三项硬编码；「收集普罗数据」为已下线预设的旧名）：与归档命名约定一致占 00 号，阶段从 01 起
    for(const l of inline){
      const idx=rec.logs.indexOf(l);
      const seq=isPreStage(l.stage)?0:(idx-rec.logs.slice(0,idx).filter(x=>x&&isPreStage(x.stage)).length+1);   // 00=预设任务，普通阶段按剔除预设任务后的位置从 01 起
      const fname='run-'+rec.tag+'-'+String(seq).padStart(2,'0')+'-'+sanitizeFsName(l.stage)+'.log';
      const fp=rec.archive+'/'+fname;
      if(!names.has(fname)){
        try{ await apiWrite(fp, l.log); }catch(e){ continue; }
      }
      rec.logs[idx]={stage:l.stage, status:l.status, dur:l.dur||0, logFile:fp};
      changed=true;
    }
  }
  if(changed) persistState();
}
/* 收集本次运行各阶段日志的元数据，随历史记录持久化到服务端：
   全量日志的唯一实体是归档文件（run-<tag>-NN-任务名.log，永不截断），历史条目只存 logFile 路径，
   回放历史时按需经文件读路由拉取（见 loadReplayLogs）；无归档目录（scriptsDir 非绝对路径）时内嵌全文兜底 */
function collectRunLogs(rc, handoffFromIdx){
  const out=[];
  const folder=rc ? archiveFolderFor(rc) : null;
  const skipFrom=Number.isFinite(handoffFromIdx)?handoffFromIdx:(rc&&Number.isFinite(rc.handoffFromIdx)?rc.handoffFromIdx:-1);
  (rc?rc.stages:[]).forEach((s,idx)=>{
    if(skipFrom>=0 && idx>=skipFrom) return;   // 已移交服务端的后缀阶段不写本地占位（后缀由服务端写同 tag 记录时按阶段名并集补齐，本条只留本地部分）
    const n=rc.nodes[s.id];
    if(!n || n.status==='running') return;
    const e={stage:s.name, status:n.status, dur:(n.dur||0), local:true};
    const st0=Number(n.startedAt); if(Number.isFinite(st0)&&st0>0) e.startedAt=st0;   // 阶段开始时间随历史持久化，回放详情据此展示
    if(folder) e.logFile=folder+'/'+taskLogFile(rc, stageSeq(rc.stages, idx), s.name);
    else{
      /* 无归档目录时只能内嵌全文；仍用分片构建避免先拆成百万行对象。 */
      let text=''; try{ text=(buildLogParts(s,rc,n)||[]).join(''); }catch(e2){}
      e.log=text;
    }
    out.push(e);
  });
  return out;
}
/* 历史阶段日志合并（按阶段名并集）：页面 finish 原地更新启动时写入的「进行中」记录、服务端 PUT
   合并页面与磁盘两侧同 tag 记录（含 fail-run 关页失败落史与同 tag 的旧版页面记录）时，按阶段名
   并集合并出完整列表，避免任一侧整条替换冲掉另一侧。同名阶段后者覆盖状态/耗时/日志路径，
   保留任一侧的 local 标记（本地执行标识）；顺序：先前侧（本地前缀），再追加后侧独有的阶段。
   混合编排的定时后缀同样走同 tag 合并：服务端执行后缀时写同 tag 记录，与本地前缀合成一条
   （记录身份保留页面首条，见服务端 appendPipelineHistory）。 */
function mergeStageLogsForHistory(prevLogs, nextLogs){
  const listA=Array.isArray(prevLogs)?prevLogs:[];
  const listB=Array.isArray(nextLogs)?nextLogs:[];
  const out=[];
  const byName={};
  const put=(e)=>{
    if(!e||typeof e!=='object') return;
    const name=String(e.stage||'');
    if(!name) return;
    const prev=byName[name];
    if(prev){
      const merged=Object.assign({}, prev, e);
      if(prev.local && e.local===undefined) merged.local=true;
      if(!merged.logFile && prev.logFile) merged.logFile=prev.logFile;
      if(merged.dur===undefined && prev.dur!==undefined) merged.dur=prev.dur;
      if(merged.startedAt===undefined && prev.startedAt!==undefined) merged.startedAt=prev.startedAt;   // 任一侧记录了阶段开始时间即保留
      if(merged.log===undefined && prev.log!==undefined) merged.log=prev.log;
      byName[name]=merged;
      const idx=out.indexOf(prev);
      if(idx>=0) out[idx]=merged;
    }else{
      byName[name]=e;
      out.push(e);
    }
  };
  listA.forEach(put);
  listB.forEach(put);
  return out;
}
