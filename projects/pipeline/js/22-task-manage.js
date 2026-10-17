/* ===== 22-task-manage.js · 流水线任务管理（多条流水线：列表/表单/增删改） =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 10867–11343）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */

/* ---------- 流水线任务管理（多条流水线） ---------- */
function closePlRowMenu(){
  if(!plMenuOpenId) return;
  plMenuOpenId=null;
  const panel=$('plRowMenuPanel'); if(panel) panel.style.display='none';
}
/* 展开行内「⋯」菜单：列表项文案随置顶态刷新；fixed 定位——右缘对齐 ⋯ 按钮、下缘贴按钮底部，
   不占用文档流，故不被 overflow 容器裁剪、也不撑大流水线行高 */
function openPlRowMenu(id, anchorBtn){
  const pl=findPipeline(id); if(!pl) return;
  const panel=$('plRowMenuPanel'), item=$('plRowMenuPin'), favoriteItem=$('plRowMenuFavorite'), historyItem=$('plRowMenuHistory'); if(!panel||!item||!favoriteItem||!historyItem) return;
  plMenuOpenId=id;
  item.textContent = pl.pinnedAt ? '取消置顶' : '置顶';
  item.title = pl.pinnedAt ? '取消置顶，恢复数组原顺序' : '置顶到列表最前，随服务端同步';
  favoriteItem.textContent = isPipelineFavorite(pl) ? '取消收藏' : '收藏';
  favoriteItem.title = currentUsername ? '收藏状态按当前登录用户独立保存并随服务端同步' : '登录后可收藏流水线';
  historyItem.title='查看流水线「'+pl.name+'」的运行历史（按流水线名筛选，清空其他筛选条件）';
  /* 「标记可信/取消可信」入口：仅 password 模式（已取得登录用户）且当前会话为 admin、且非内置流水线时
     显示；token 模式/探测失败无法判定 admin，不显示（此时 trusted 也不限制编辑，见 plEditable）。 */
  const trustedItem=$('plRowMenuTrusted');
  if(trustedItem && trustedItem.style){
    const meTrusted=(typeof currentUsername!=='undefined')?(currentUsername||''):'';
    const isAdminTrusted=(typeof currentUserIsAdmin!=='undefined')&&!!currentUserIsAdmin;
    const canMarkTrusted=!!(!pl.builtIn && meTrusted && isAdminTrusted);
    trustedItem.style.display=canMarkTrusted?'':'none';
    if(canMarkTrusted){
      trustedItem.textContent=pl.trusted?'取消可信':'标记可信';
      trustedItem.title=pl.trusted?'取消可信标记：恢复「仅拥有者可编辑」':'标记为可信流水线：仅 admin 可编辑/删除，其他用户只读（仍可运行）';
    }
  }
  panel.style.display='block';
  if(anchorBtn && anchorBtn.getBoundingClientRect){
    const r=anchorBtn.getBoundingClientRect();
    panel.style.left=Math.max(4, r.right-(panel.offsetWidth||0))+'px';   // 先 display:block 再量宽，右缘对齐锚按钮
    panel.style.top=(r.bottom+4)+'px';
  }
}
/* 行内「⋯」菜单「运行历史」：按流水线名精确过滤运行历史（同时清空关键字/状态筛选），回到第一页、
   回显筛选控件并滚动到运行历史卡片；再触发一次服务端拉取（在途去重），让他端/定时运行的记录即刻可见 */
function showPipelineHistory(id){
  const pl=findPipeline(id); if(!pl) return;
  histFilter={kw:'',status:'',pipeline:String(pl.name||'')};
  saveHistFilter(); histPage=0;
  const kwInp=$('histFilterKw'); if(kwInp) kwInp.value='';
  const stSel=$('histFilterStatus'); if(stSel) stSel.value='';
  renderHistFilterOptions(); renderHistory();
  refreshHistoryFromServer(false);
  const card=$('histCard'); if(card&&card.scrollIntoView) card.scrollIntoView({behavior:'smooth',block:'start'});
}
/* 运行历史行「查看流水线」：独立于整行点击回放，定位对应流水线并把任务列表筛到该名称。 */
function showPipelineFromHistory(rec){
  const name=String(rec&&rec.pipeline||'').trim(); if(!name) return;
  const pl=(rec.pipelineId&&findPipeline(rec.pipelineId))||pipelines.find(p=>p&&p.name===name)||null;
  plFilter={kw:name,owner:'all',favorite:'all'};
  plPage=0;
  const kwInp=$('plFilterKw'); if(kwInp) kwInp.value=name;
  const ownerInp=$('plFilterOwner'); if(ownerInp) ownerInp.value=plOwnerFilterLabel('all');   /* 组合框回显「全部」标签（模式键→显示文本走 helper） */
  const favoriteSel=$('plFilterFavorite'); if(favoriteSel) favoriteSel.value='all';
  if(pl) selectPipeline(pl.id);
  savePlFilter(); renderPipelines();
  const card=$('pipelineTaskCard'); if(card&&card.scrollIntoView) card.scrollIntoView({behavior:'smooth',block:'start'});
}
function closeHistoryRowMenu(){
  historyMenuOpenRec=null;
  const panel=$('historyRowMenuPanel'); if(panel) panel.style.display='none';
}
function openHistoryRowMenu(rec, anchorBtn){
  const panel=$('historyRowMenuPanel'), item=$('historyRowMenuViewPipeline');
  if(!panel||!item) return;
  historyMenuOpenRec=rec;
  item.title='查看并筛选流水线「'+String(rec&&rec.pipeline||'')+'」';
  panel.style.display='block';
  if(anchorBtn&&anchorBtn.getBoundingClientRect){
    const r=anchorBtn.getBoundingClientRect();
    panel.style.left=Math.max(4,r.right-(panel.offsetWidth||0))+'px';
    panel.style.top=(r.bottom+4)+'px';
  }
}
/* 置顶切换：pinnedAt>0 视为已置顶。任务列表与运行框下拉把已置顶排最前（多条按置顶时间新→旧），取消置顶回到原数组顺序；
   pinnedAt 随流水线 config 经 persistState 上送服务端、随导出文件保存，各浏览器刷新后一致；复制副本不继承（见 copyPipeline）。 */
function togglePipelinePin(id){
  const p=findPipeline(id); if(!p) return;
  p.pinnedAt=p.pinnedAt?0:Date.now();
  savePipelines();
  renderPipelines();
}
/* 可信标记切换（admin 专属，菜单入口见 openPlRowMenu；服务端同时强制校验，非 admin 直调 API 返回 403）：
   置位 trusted=true、取消时删除字段保持数据干净；保存成功 toast 反馈。保存走 immediate 以拿到结果：
   403 时 pushState 已 toast 服务端 message 并 loadServerState 重拉状态同步，此处直接返回不再重复处理；
   其他失败回滚本地标记并提示。 */
async function togglePipelineTrusted(id){
  const p=findPipeline(id); if(!p || p.builtIn) return;
  const me=(typeof currentUsername!=='undefined')?(currentUsername||''):'';
  const isAdmin=(typeof currentUserIsAdmin!=='undefined')&&!!currentUserIsAdmin;
  if(!me || !isAdmin){ if(typeof alert==='function') alert('仅 admin 可标记/取消可信流水线。'); return; }   // 兜底：菜单入口已对非 admin 隐藏
  const marking=!p.trusted;
  if(marking) p.trusted=true; else delete p.trusted;
  renderPipelines();
  let saved=null;
  try{ saved=await savePipelines({immediate:true, silentConflict:true}); }   /* 409 冲突由下方回滚 + alert 单独处理，不走 pushState 的提示 + 重拉，避免双重提示 */
  catch(e){ saved={ok:false,error:String(e&&e.message||e)}; }
  if(saved && saved.ok===false){
    if(saved.trusted) return;   /* 403 可信拦截：pushState 已 toast 服务端 message 并重新拉取服务端状态同步 */
    if(marking) delete p.trusted; else p.trusted=true;   // 网络/冲突等其他失败：回滚本地标记
    renderPipelines();
    if(typeof alert==='function') alert((marking?'标记可信失败：':'取消可信失败：')+String(saved.error||'未知错误'));
    return;
  }
  if(typeof toast==='function') toast(marking?'已标记为可信流水线：仅 admin 可编辑':'已取消可信标记');
}
function renderPipelines(){
  renderPlFilterOptions();
  /* 已置顶（pinnedAt）排最前，多条按置顶时间新→旧；未置顶保持数组原序（内置经加载迁移居首）——Array.sort 稳定，键相同不动相对位置 */
  const view=pipelines.filter(plFilterMatch).sort((a,b)=>((b.pinnedAt||0)-(a.pinnedAt||0)));
  const pageSize=(typeof plPageSize==='number'&&plPageSize>0)?plPageSize:10;
  const pages=Math.max(1,Math.ceil(view.length/pageSize));
  let page=(typeof plPage==='number')?plPage:0;
  if(page>pages-1) page=pages-1;
  if(page<0) page=0;
  if(typeof plPage==='number') plPage=page;
  const queueCounts=pipelineQueueCounts();
  $('plCount').textContent = pipelines.length ? ('('+view.length+'/'+pipelines.length+')') : '';
  const fTip=$('plFilterTip'); if(fTip) fTip.textContent = (view.length<pipelines.length || plFilter.kw || plFilter.favorite==='favorite') ? ('已筛选 '+view.length+' / '+pipelines.length+' 条') : '';
  const tb=$('plTable').querySelector('tbody'); tb.innerHTML='';
  if(!view.length){ const tr0=document.createElement('tr'); tr0.innerHTML='<td colspan="4" class="dshell-muted" style="text-align:center;padding:14px 0;">'+(pipelines.length?'无匹配的流水线':'暂无流水线')+'</td>'; tb.appendChild(tr0); }
  view.slice(page*pageSize,(page+1)*pageSize).forEach(p=>{
    const tr=document.createElement('tr');
    const isCur = p.id===curPipelineId;
    const isPinned = !!p.pinnedAt;
    const isFavorite = isPipelineFavorite(p);
    const realStages=p.stages.filter(s=>!s.preset);   // 预设任务标记不计入阶段数/预览（编排区按位置展示）
    const preview = realStages.map(s=>s.name).join(' → ');
    /* 署名展示：拥有者 + 最后修改人（修改人与拥有者相同则不重复；内置流水线不显示）；
       创建者与拥有者不同（所有权转移/旧数据）时署名行 title 追加「创建者 @z」提示。
       plCreatorOf 为可选依赖：typeof 守卫防旧测试桩缺函数。 */
    const plOwner=plOwnerOf(p);
    const plCreator=(typeof plCreatorOf==='function')?plCreatorOf(p):'';
    const auditTag = p.builtIn ? '' : ((plOwner ? ' · 拥有 @'+esc(plOwner) : '') + ((plUpdaterOf(p) && plUpdaterOf(p)!==plOwner) ? ' · 修改 @'+esc(plUpdaterOf(p)) : ''));
    const auditTitle = (!p.builtIn && plCreator && plCreator!==plOwner) ? '创建者 @'+plCreator : '';
    if(isCur) tr.className='sel';
    /* 本表只展示该流水线在全部来源中的运行/排队汇总，不把某一次运行或「查看中」状态绑进行点击；
       逐次详情仍统一在「运行队列」查看，本表整行点击始终选用流水线。 */
    tr.title='点击选用该流水线';
    const queueCount=queueCounts[p.id]||{running:0,queued:0};
    const queueTitle=(queueCount.running||queueCount.queued)?('运行 '+queueCount.running+' · 排队 '+queueCount.queued):'当前无运行或排队任务';
    /* 归属编辑限制（plEditable：仅拥有者可编辑/删除，admin 例外可编辑/删除任意非可信流水线；内置视同可信——仅 admin 可编辑，其他用户只读）：
       他人流水线行内「编辑」变「查看」（带拥有者提示）、不渲染「删除」；内置行对任何人（含 admin）
       都不渲染「删除」（deletePipeline 另有不依赖 plEditable 的内置拦截）；「复制」对所有行可用
       （复制为自己的副本后编辑）。 */
    const canEditPl=plEditable(p);
    const plEditBtn='<button class="dshell-btn dshell-btnGhost mini" data-pledit="'+p.id+'"'+(!canEditPl?(p.builtIn?' title="可信流水线：仅 admin 可编辑，其他用户只读（仍可运行）"':(p.trusted?' title="可信流水线：仅 admin 可编辑，您可查看/运行，或复制为副本"':' title="拥有者 @'+esc(plOwner)+'，仅查看；可复制为副本"')):'')+'>'+(canEditPl?'编辑':'查看')+'</button>';
    const plDelBtn=(canEditPl&&!p.builtIn)?'<button class="dshell-btn dshell-btnDanger mini" data-pldel="'+p.id+'">删除</button>':'';
    tr.innerHTML='<td><div style="font-weight:600'+(isCur?';color:var(--dsw-alias-state-accent-primary)':'')+'">'+esc(p.name)+(p.builtIn?' <span style="font-size:10px;color:var(--dsw-alias-state-accent-primary);border:1px solid var(--dsw-alias-state-accent-primary);border-radius:4px;padding:0 3px;" title="可信流水线：仅 admin 可编辑，其他用户只读（仍可运行）">可信</span>':'')+(p.trusted?' <span style="font-size:10px;color:var(--dsw-alias-state-accent-primary);border:1px solid var(--dsw-alias-state-accent-primary);border-radius:4px;padding:0 3px;" title="管理员标记的可信流水线：仅 admin 可编辑，其他用户只读（仍可运行）">可信</span>':'')+(isCur?' <span style="font-size:10px;color:var(--dsw-alias-state-accent-primary)">当前</span>':'')+(isPinned?' <span style="font-size:10px;color:var(--dsw-alias-state-accent-primary)">置顶</span>':'')+(isFavorite?' <span style="font-size:10px;color:var(--dsw-alias-state-accent-primary)" title="已收藏">★ 收藏</span>':'')+'</div><div class="dshell-muted" style="font-size:10px"'+(auditTitle?' title="'+esc(auditTitle)+'"':'')+'>'+esc(preview)+auditTag+'</div></td>'+
      '<td>'+realStages.length+'</td>'+
      '<td data-plqueue="'+esc(p.id)+'" title="'+queueTitle+'" style="white-space:nowrap">'+pipelineQueueCountHtml(queueCount)+'</td>'+
      '<td style="white-space:nowrap"><button class="dshell-btn dshell-btnGhost mini" data-plrun="'+p.id+'" title="运行流水线「'+esc(p.name)+'」" aria-label="运行流水线「'+esc(p.name)+'」">▶</button> <button class="dshell-btn dshell-btnGhost mini" data-plapi="'+p.id+'" title="查看流水线「'+esc(p.name)+'」的 API 调用方式">API</button> '+plEditBtn+' <button class="dshell-btn dshell-btnGhost mini" data-plcopy="'+p.id+'" title="复制该流水线为可编辑副本">复制</button> '+plDelBtn+
      ' <button class="dshell-btn dshell-btnGhost mini" data-plmenu="'+p.id+'" title="更多操作" aria-label="流水线「'+esc(p.name)+'」更多操作">⋯</button></td>';
    tr.addEventListener('click',()=>selectPipeline(p.id));   // 整行点击：选用该流水线（运行中也可切换；运行/编辑/复制/删除按钮已阻止冒泡）
    tb.appendChild(tr);
  });
  tb.querySelectorAll('[data-plrun]').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation(); openPipelineRunDialog(b.getAttribute('data-plrun')); }));
  tb.querySelectorAll('[data-plapi]').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation(); showPipelineApi(findPipeline(b.getAttribute('data-plapi'))); }));
  tb.querySelectorAll('[data-pledit]').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation(); openPlForm(b.getAttribute('data-pledit')); }));
  tb.querySelectorAll('[data-plcopy]').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation(); copyPipeline(b.getAttribute('data-plcopy')); }));
  tb.querySelectorAll('[data-pldel]').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation(); deletePipeline(b.getAttribute('data-pldel')); }));
  tb.querySelectorAll('[data-plmenu]').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation(); const id=b.getAttribute('data-plmenu'); if(plMenuOpenId===id) closePlRowMenu(); else openPlRowMenu(id, b); }));
  const info=$('plPageInfo'); if(info) info.textContent='第 '+(page+1)+'/'+pages+' 页 · 共 '+view.length+' 条';
  const prev=$('plPrev'), next=$('plNext');
  if(prev) prev.disabled=page<=0;
  if(next) next.disabled=page>=pages-1;
  renderPipelineSel();
}
/* 运行框流水线下拉：与「流水线任务」行选用双向同步；运行中也可切换（selectPipeline 脱离运行视图，在跑任务转后台继续） */
function renderPipelineSel(){
  const sel=$('pipelineSel'); if(!sel) return;
  const cur=curPipeline(); sel.innerHTML='';
  /* 与任务列表同一排序：已置顶在前（置顶时间新→旧），其余保持数组原序 */
  pipelines.slice().sort((a,b)=>((b.pinnedAt||0)-(a.pinnedAt||0))).forEach(p=>{ const o=document.createElement('option'); o.value=p.id; o.textContent=p.name; if(cur && p.id===cur.id) o.selected=true; sel.appendChild(o); });
}
function selectPipeline(id){
  exitHistoryReplay();   // 手动切换流水线：退出历史回放（回放态下 selectPipeline 不会被 enterHistoryReplay 调用，无递归）
  curPipelineId=id; try{ localStorage.setItem('pip-curPipeline',id); }catch(e){}   /* 运行行临时配置仅本地，不上送服务端 */
  /* 下拉选用、新建或复制可能选中当前页之外的流水线：目标仍命中当前筛选时同步翻到它所在页；
     若筛选本身排除了目标则保持当前页，不擅自清除用户筛选。排序须与 renderPipelines 一致。 */
  const listView=pipelines.filter(plFilterMatch).sort((a,b)=>((b.pinnedAt||0)-(a.pinnedAt||0)));
  const listIndex=listView.findIndex(p=>p.id===id);
  if(listIndex>=0){ const pageSize=(typeof plPageSize==='number'&&plPageSize>0)?plPageSize:10; plPage=Math.floor(listIndex/pageSize); }
  /* 运行中也可切换：脱离运行/结果视图，回到所选流水线的空闲编排；在跑运行不受影响、转后台继续
     （运行状态统一在「运行队列」展示，点击队列条目可回看该次运行的阶段详情） */
  viewRc=null; syncViewRun(); applyRunOverall(null);
  refreshArchiveTip();
  resetNodes(); renderPipelines(); renderFlow(); renderDetail();
}
function savePlDraft(){
  try{
    editDefaults=collectPipelineDefaultForm();
    localStorage.setItem('pip-plDraft', JSON.stringify({
      editId: $('plForm').dataset.editId || '',
      name: $('plName').value,
      scriptsDir: $('scriptsDir').value,
      stages: editStages,
      defaults:editDefaults,
      savedAt: Date.now()
    }));
  }catch(e){}
  const tip=$('plDraftTip'); if(tip){ tip.textContent='草稿已自动保存'; if(plDraftTipTimer) clearTimeout(plDraftTipTimer); plDraftTipTimer=setTimeout(()=>{ tip.textContent=''; },1800); }
}
function schedulePlDraftSave(){ if(plDraftTimer) clearTimeout(plDraftTimer); plDraftTimer=setTimeout(savePlDraft, 400); }
function clearPlDraft(){ if(plDraftTimer){ clearTimeout(plDraftTimer); plDraftTimer=null; } try{ localStorage.removeItem('pip-plDraft'); }catch(e){} const tip=$('plDraftTip'); if(tip) tip.textContent=''; }
function loadPlDraft(){ try{ return JSON.parse(localStorage.getItem('pip-plDraft')||'null'); }catch(e){ return null; } }
function applyPlFormReadOnly(){
  const f=$('plForm'); if(!f) return;
  /* 顶部静态控件（不随阶段列表重渲染）两种模式下都显式切换；阶段卡内动态控件只在只读时强制禁用——
     可编辑模式的行内 disabled（如首张卡 ↑）由 renderStageEditor 自身渲染，不在此恢复 */
  ['plName','scriptsDir','scriptsReload','plDefaultEnvMultiBtn','plDefaultRepo','plDefaultBranch','plDefaultStrategy'].forEach(id=>{ const el=$(id); if(el) el.disabled=plFormReadOnly; });
  const presets=$('plDefaultPresets'); if(presets) presets.querySelectorAll('input').forEach(el=>{ el.disabled=plFormReadOnly; });
  const add=$('plStageAdd'); if(add) add.style.display=plFormReadOnly?'none':'';
  const save=$('plSave'); if(save) save.style.display=plFormReadOnly?'none':'';
  const wrap=$('plStageList');
  if(wrap&&wrap.children) for(let i=0;i<wrap.children.length;i+=1){
    const row=wrap.children[i]; row.draggable=!plFormReadOnly; row.style.cursor=plFormReadOnly?'default':'';
    if(plFormReadOnly) row.querySelectorAll('input,select,textarea,button').forEach(el=>{ el.disabled=true; });
  }
}
function openPlForm(id, focusIdx){
  if(typeof stateLoaded!=='undefined'&&!stateLoaded){ alert('服务端流水线配置仍在加载，暂不能编辑。请稍后重试或刷新页面。'); return; }
  const f=$('plForm'); f.style.display='flex';
  editFocusIdx=(typeof focusIdx==='number')?focusIdx:-1;
  editSelStage=null;   // 打开编辑器即重建 editStages 草稿，选中引用随之失效
  $('scriptsDir').value=scriptsDir;
  /* id 失效（如已删除的流水线残留）时兜底到当前流水线，保证弹窗内容与编排区一致 */
  const p = id ? (findPipeline(id) || curPipeline()) : null;
  f.dataset.editId = p ? p.id : '';
  plFormReadOnly=!!(p&&!plEditable(p));   // 内置（视同可信，仅 admin 可编辑）、可信（非 admin）与他人拥有的流水线只读查看（plEditable），编辑器整体切为只读模式
  $('plFormTitle').textContent = p ? (plFormReadOnly ? (p.builtIn ? '查看流水线（可信·只读）：' : (p.trusted ? '查看流水线（可信'+(plOwnerOf(p)?'·拥有者 @'+plOwnerOf(p):'')+'·只读）：' : (plOwnerOf(p) ? '查看流水线（拥有者 @'+plOwnerOf(p)+'·只读）：' : '查看流水线（只读）：'))) : (p.builtIn ? '编辑流水线（可信）：' : (p.trusted ? '编辑流水线（可信）：' : '编辑流水线：')))+p.name : '新建流水线';
  /* 「从分享导入」仅在「新建流水线」时提供：编辑/查看已有流水线不提供覆盖入口 */
  const importShareBtn=$('plImportShare'); if(importShareBtn) importShareBtn.style.display=p?'none':'';

  if(p){ $('plName').value=p.name; editDefaults=normalizePipelineDefaults(p.defaults);
    editStages=p.stages.map(s=> (s && s.preset) ? {id:s.id, name:s.name, preset:true, pkey:s.pkey}   /* 预设标记行原样带入 */
      : normalizeStageKind({id:s.id, name:s.name, dur:s.dur, timeout:s.timeout||null, skip:!!(s.skip||s.gate), parallel:s.parallel===true, promCollect:!!s.promCollect, sched: s.sched?{}:null, sub:(s.sub||[]), kind:s.kind, script:s.script?{name:s.script.name,path:s.script.path,lang:s.script.lang,params:(s.script.params||[]),values:(s.script.values||{}),outVars:(s.script.outVars||'')}:null, url:s.url?{url:s.url.url,outVars:(s.url.outVars||'')}:null, evaltokens:s.evaltokens?Object.assign(evaltokensStageConfig(s.evaltokens),{params:[]}):null, jenkins:s.jenkins?{job:s.jenkins.job,outVars:(s.jenkins.outVars||'')}:null})); }   /* jenkins 字段仅为兼容旧数据带入，normalizeStageKind 内迁入 http 后清掉；evaltokens.params 不持久化（编辑器打开时自动重新识别），evaltokens.values（用户设置的参数覆盖值）随流水线持久化、经 evaltokensStageConfig 带入 */
  else { $('plName').value=''; editDefaults=currentPipelineDefaultSeed(); editStages=[newStage('检出'),newStage('校验'),newStage('构建镜像')]; }
  editStages=withPresetMarkers(editStages);   // 补齐缺失的预设任务标记行：清理/检查/前置自定义最前，Profiling/末尾自定义最后
  /* 草稿恢复：若上次未保存就退出（关闭/刷新/点遮罩），且编辑的是同一条流水线（新建对应空 id），则恢复草稿，避免误操作丢失；
     只读查看（内置/他人拥有的流水线）不恢复草稿——展示内容须为流水线定义真值，且只读模式也不会产生新草稿 */
  const draft=plFormReadOnly?null:loadPlDraft();
  if(draft && Array.isArray(draft.stages) && (draft.editId||'')===$('plForm').dataset.editId){
    editStages=draft.stages;
    if(typeof draft.name==='string') $('plName').value=draft.name;
    if(typeof draft.scriptsDir==='string') $('scriptsDir').value=draft.scriptsDir;
    if(draft.defaults) editDefaults=normalizePipelineDefaults(draft.defaults);
  }
  renderPipelineDefaultForm();
  applyPlFormReadOnly();   // 顶部静态控件与保存/添加入口按只读模式切换（阶段卡内控件在 renderStageEditor 末尾应用）
  /* 编排区双击阶段进入（带 focusIdx）时，焦点阶段即选中卡：高亮统一走 plstage-sel 单通道（applyEditSel
     在 renderStageEditor 末尾恢复）。必须晚于草稿恢复——恢复会整组替换 editStages，早了引用即失效 */
  if(editFocusIdx>=0 && editFocusIdx<editStages.length) editSelStage=editStages[editFocusIdx];
  loadScripts().then(async ()=>{
    renderStageEditor();
    /* 对已绑脚本的阶段自动重新识别参数：存量数据可能带旧版识别器的截断默认值（如 RENDER_DIR 的 ${RUN_DIR}），
       重新识别刷新 placeholder 展示；用户真实改动由 detectStageParams 内部合并保留（keepOnError 防止脚本暂不可读时清空） */
    await Promise.all(editStages.map((s,i)=>{
      if(s.preset) return null;   // 预设任务行的脚本在设置页配置，不参与阶段参数识别
      if(s.kind==='evaltokens'&&s.evaltokens&&s.evaltokens.taskId) return detectEvaltokStageParams(i,true);
      if(s.script&&s.script.path) return detectStageParams(i,true);
      return null;
    }));
  });
  if(!plFormReadOnly) $('plName').focus();   // 只读查看不抢焦点（名称输入框已禁用）
}
async function savePlForm(){
  /* 内置流水线视同可信（仅 admin 可编辑保存）与他人拥有的流水线只读（plEditable）：只读时保存入口已隐藏，
     此处兜底拦截一切写回路径（如需改动请用列表「复制」生成可编辑副本） */
  const guardP=findPipeline($('plForm').dataset.editId||'');
  if(guardP && guardP.builtIn && !plEditable(guardP)){ alert('预置流水线「'+guardP.name+'」视同可信：仅 admin 可编辑保存，其他用户只读（仍可运行）；如需定制可在「流水线任务」列表「复制」为副本后编辑。'); return; }
  if(guardP && !plEditable(guardP)){
    if(guardP.trusted){ alert('流水线「'+guardP.name+'」已被管理员标记为可信，仅 admin 可编辑保存；如需改动可在「流水线任务」列表「复制」为副本后编辑。'); return; }
    alert('流水线「'+guardP.name+'」由 @'+plOwnerOf(guardP)+' 拥有，仅拥有者可编辑保存；可在「流水线任务」列表「复制」为副本后编辑。'); return;
  }
  const name=$('plName').value.trim()||'未命名流水线';
  if(!editStages.some(s=>!s.preset)){ alert('请至少添加一个阶段（预设任务不计入）'); return; }
  // 校验：阶段名非空/不重复、脚本存在（可警告）、必填参数已填；预设任务行仅参与排序，跳过内容校验
  const seen={};
  for(let i=0;i<editStages.length;i++){
    const s=editStages[i];
    if(s.preset) continue;
    if(PRESET_BY_NAME[s.name]){ alert('第 '+(i+1)+' 阶段的名称「'+s.name+'」与预设任务（系统预设或自定义预设）同名，请修改'); return; }
    if(!String(s.name).trim()){ alert('第 '+(i+1)+' 阶段的名称未填写'); return; }
    if(seen[s.name]){ alert('阶段名重复：'+s.name); return; }
    seen[s.name]=1;
    if(s.kind==='http'){
      if(!s.url || !String(s.url.url).trim()){ alert('第 '+(i+1)+' 阶段「'+s.name+'」未填写请求 URL'); return; }
    }
    if(s.kind==='evaltokens'){
      if(!s.evaltokens || !(String(s.evaltokens.taskId).trim()||String(s.evaltokens.taskName).trim())){ alert('第 '+(i+1)+' 阶段「'+s.name+'」未选择 EvalTokens 任务'); return; }
    }
    if(s.script && s.script.name){   // 仅填了「输出变量」未选脚本的占位（name 为空）视为未绑脚本，按本地模拟处理
      if(!scriptByName(s.script.name)){ if(!confirm('第 '+(i+1)+' 阶段「'+s.name+'」的脚本「'+s.script.name+'」不在 scripts 目录中，仍要保存？')) return; }
      const missing=(s.script.params||[]).filter(p=>p.required && !String((s.script.values&&s.script.values[p.key]!==undefined)?s.script.values[p.key]:(p.def||'')).trim());
      if(missing.length){ alert('第 '+(i+1)+' 阶段「'+s.name+'」脚本 '+s.script.name+' 有必填参数未填：'+missing.map(p=>p.label||p.key).join('、')); return; }
    }
  }
  /* 定时阶段顺序校验：阶段默认支持定时，勾选「需本地运行」的阶段必须排在所有定时阶段之前；
     即「若本地运行任务的前面有定时任务，则报错」；预设任务行不参与定时校验 */
  {
    let schedStarted=false;
    for(let i=0;i<editStages.length;i++){
      if(editStages[i].preset) continue;
      const has=!!editStages[i].sched;
      if(has){
        schedStarted=true;
      } else if(schedStarted){
        alert('第 '+(i+1)+' 阶段「'+editStages[i].name+'」勾选了「需本地运行」，但不能排在定时阶段之后。\n规则：本地运行阶段必须在所有定时阶段之前。');
        return;
      }
    }
  }
  const previousPipelines=JSON.parse(JSON.stringify(pipelines));
  const previousScriptsDir=scriptsDir;
  const serverPipelinesAtSave=(typeof serverConfigBase!=='undefined'&&serverConfigBase&&Array.isArray(serverConfigBase.pipelines))
    ?JSON.parse(JSON.stringify(serverConfigBase.pipelines)):[];
  scriptsDir=$('scriptsDir').value.trim()||scriptsDir; scriptsDirIsFallback=false; saveScriptsDir();
  const stages=editStages.map((s,i)=>{
    if(s.preset) return {id:s.id, name:s.name, preset:true, pkey:s.pkey};   // 预设任务标记：位置随流水线保存
    const st={id:stageIdFor(s.name)||('st'+i), name:s.name, dur:Math.max(0,parseInt(s.dur)||0), skip:!!s.skip, sub:(s.sub||[]), kind:s.kind||'simulate'};   /* dur 保留编辑器原值（含 0=不设置耗时），不再回退默认 5 秒 */
    if(s.parallel===true) st.parallel=true;
    if(s.promCollect) st.promCollect=true;   // 任务级普罗采集开关：随阶段持久化，任务进入终态后按其起止采集（见 taskPromFinalize）
    if(s.timeout) st.timeout=Math.max(1,parseInt(s.timeout,10)||120);
    if(s.script && s.script.name) st.script={name:s.script.name, path:s.script.path, lang:scriptLangOf(s.script), params:(s.script.params||[]), values:(s.script.values||{}), outVars:(s.script.outVars||'')};
    if(s.url) st.url={url:s.url.url, outVars:(s.url.outVars||'')};
    if(s.evaltokens) st.evaltokens=evaltokensStageConfig(s.evaltokens);
    if(s.sched) st.sched={};   // 仅标记「支持定时」，周期跟随流水线定时计划
    return st;
  });
  const editId=$('plForm').dataset.editId;
  const defaults=collectPipelineDefaultForm();
  const me=currentUsername||'';   // 新建/复制流水线署名：取已缓存的当前登录用户（页面加载时由 fillExecutorFromAuth 探测写入），未取到则不署名
  let savedPipelineId=editId;
  if(editId){ const p=findPipeline(editId); if(p){ p.name=name; p.stages=stages; p.defaults=defaults; delete p.prom; if(!p.builtIn && me){ if(typeof p.createdBy!=='string' || !p.createdBy.trim()) p.createdBy=me; if(typeof p.owner!=='string' || !p.owner.trim()) p.owner=me; } if(!p.builtIn && me) p.updatedBy=me; } }   /* 编辑存量流水线按原始字段补署：createdBy 与 owner 各自空白才补为本用户（均空白即未署名；owner 缺失的存量数据首次保存即归属保存人），已署名不动；每次保存都刷新最后修改人 */
  else { const created={id:'pl-'+Date.now().toString(36), name, stages, defaults, builtIn:false, createdBy:me, owner:me, updatedBy:me}; pipelines.push(created); savedPipelineId=created.id; }
  const saveForm=$('plForm');
  const saveFormWasInert=!!(saveForm&&saveForm.inert);
  const saveButton=$('plSave');
  const saveButtonText=saveButton?saveButton.textContent:'';
  if(saveForm) saveForm.inert=true;   // 整个编辑器冻结到服务端确认，防止请求快照之后的新输入被成功收尾清掉
  if(saveButton){ saveButton.disabled=true; saveButton.textContent='保存中…'; }
  /* 慢链路明示：显式保存必须等服务端确认（并发安全），公网映射等慢上行链路下可能需要数秒；
     超过 4 秒在底栏提示「仍在保存」，避免误以为卡死而刷新页面（刷新时本次保存结果尚未确认） */
  const saveSlowTip=$('plDraftTip');
  const saveSlowTimer=setTimeout(()=>{ if(saveSlowTip){ saveSlowTip.textContent='网络较慢，仍在保存，请勿刷新或关闭页面…'; saveSlowTip.style.color='var(--log-warn)'; } },4000);
  let saved;
  /* 单条保存：只上传当前流水线（KB 级）；旧服务端无单条路由（unsupported/404）回退瘦身全量保存 */
  try{
    saved=await pushPipelineOne(savedPipelineId);
    if(saved && saved.unsupported) saved=await savePipelines({immediate:true, silentConflict:true});   /* 编辑器冲突由下方回滚 + alert 单独处理，409 不再 toast/重拉，避免双重提示 */
  }
  catch(e){ saved={ok:false,error:String(e&&e.message||e)}; }
  finally{
    clearTimeout(saveSlowTimer);
    if(saveSlowTip&&saveSlowTip.textContent.indexOf('仍在保存')>=0){ saveSlowTip.textContent=''; saveSlowTip.style.color=''; }
    if(saveForm) saveForm.inert=saveFormWasInert; if(saveButton){ saveButton.disabled=false; saveButton.textContent=saveButtonText||'保存'; }
  }
  if(saved && saved.ok===false){
    if(saved.trusted){
      /* 可信拦截（服务端 403）：pushPipelineOne/pushState 已 toast 服务端 message 并 loadServerState
         重拉状态同步，此处不再走本地回滚/alert（回滚会把刚同步的服务端定义再次覆盖）；编辑器退出。 */
      clearPlDraft(); $('plForm').style.display='none';
      renderPipelines();
      return saved;
    }
    /* 只撤销本次编辑的流水线；等待同页串行锁期间，前序 PUT 可能已把其他浏览器的不同流水线合入当前列表，
       整表回滚会再次丢掉它们，并在下次保存时把缺项误解释为删除。 */
    const previousPipeline=previousPipelines.find(p=>String(p&&p.id||'')===String(savedPipelineId));
    const previousIndex=previousPipelines.findIndex(p=>String(p&&p.id||'')===String(savedPipelineId));
    const baseAtSave=serverPipelinesAtSave.find(p=>String(p&&p.id||'')===String(savedPipelineId));
    const latestServerPipelines=(typeof serverConfigBase!=='undefined'&&serverConfigBase&&Array.isArray(serverConfigBase.pipelines))?serverConfigBase.pipelines:[];
    const latestBase=latestServerPipelines.find(p=>String(p&&p.id||'')===String(savedPipelineId));
    const baseAdvanced=!!baseAtSave!==!!latestBase||(baseAtSave&&latestBase&&JSON.stringify(baseAtSave)!==JSON.stringify(latestBase));
    const rollbackPipeline=baseAdvanced?(latestBase?JSON.parse(JSON.stringify(latestBase)):null):previousPipeline;
    pipelines=pipelines.filter(p=>String(p&&p.id||'')!==String(savedPipelineId));
    if(rollbackPipeline) pipelines.splice(Math.min(Math.max(previousIndex,0),pipelines.length),0,rollbackPipeline);
    scriptsDir=previousScriptsDir;
    try{ localStorage.setItem('pip-pipelines', JSON.stringify(pipelines)); localStorage.setItem('pip-scriptsDir',scriptsDir); }catch(e){}
    renderPipelines();
    if(saved.conflict) alert('该流水线已被其他浏览器修改，本次保存未覆盖远端版本。请先刷新流水线任务，再重新应用当前草稿。');
    else alert('流水线保存失败：'+String(saved.error||'未知错误')+'。编辑内容已保留，请重试。');
    return saved;
  }
  clearPlDraft(); $('plForm').style.display='none';
  /* 运行期保存：不触发 selectPipeline（避免脱离正在查看的运行视图），仅刷新列表 */
  if(running){ renderPipelines(); }
  else if(editId && editId===curPipelineId){ selectPipeline(editId); }
  else if(!editId){ selectPipeline(pipelines[pipelines.length-1].id); }
  else { renderPipelines(); }
  renderPipelines();
  return saved||{ok:true};
}
function deletePipeline(id){
  /* 归属拦截：内置流水线任何人（含 admin）都不可删除——独立于 plEditable 先行拦截（admin 对内置可编辑但不可删除）；
     其余仅拥有者可删除（admin 例外可删任意非可信流水线；可信流水线仅 admin 可删除）；行内「删除」按钮对只读行与内置行已不渲染，此处兜底 */
  const delP=findPipeline(id);
  if(delP && delP.builtIn){ alert('预置流水线「'+delP.name+'」不可删除。'); return; }
  if(delP && !plEditable(delP)){ alert(delP.trusted ? '流水线「'+delP.name+'」已被管理员标记为可信，仅 admin 可删除。' : '流水线「'+delP.name+'」由 @'+plOwnerOf(delP)+' 拥有，仅拥有者可删除；可在「流水线任务」列表「复制」为副本后编辑自己的副本。'); return; }
  if(running){ alert('流水线运行中，暂不能删除（可点「重置」中止当前运行）。'); return; }
  if(!confirm('删除该流水线？')) return;
  pipelines=pipelines.filter(p=>p.id!==id);
  if(!pipelines.length){ pipelines=builtinPipelineSeeds(); }
  savePipelines();
  if(curPipelineId===id){ curPipelineId=pipelines[0].id; viewRc=null; syncViewRun(); resetNodes(); }
  renderPipelines(); renderFlow(); renderDetail();
}
/* 复制流水线：深拷贝阶段及脚本/URL/定时等绑定，生成新 id 与不重名的「副本」名称；
   副本一律标记为非内置（可编辑/可删除），因此内置流水线也能复制出可定制的副本 */
function uniqueCopyName(raw){
  const base=(raw||'').replace(/（副本( \d+)?）$/,'');   /* 去掉已有副本后缀，避免链式累加 */
  const taken=new Set(pipelines.map(p=>p.name));
  if(!taken.has(base+'（副本）')) return base+'（副本）';
  let n=2; while(taken.has(base+'（副本 '+n+'）')) n++;
  return base+'（副本 '+n+'）';
}
/* 副本落盘走单条保存（pushPipelineOne）：复制只新增一个条目，天然免疫其他条目的并发冲突——
   多用户下全量 PUT 的三方合并对「同一 id 双边偏离基线」报 409，复制若走全量，任一无关条目的
   并发变动都会让整批失败且副本只留在 localStorage（刷新即丢）。旧服务端无单条路由（404）
   时回退全量保存。UI 不等保存结果（复制保持轻量，不走编辑器那套 inert 等待）：保存确认后
   pushPipelineOne 内部已 reconcile 并刷新基线；硬失败（含 409）toast 提示并安排防抖重试兜底，
   本地副本保留，用户也可重试复制。可信 403 已由 pushPipelineOne toast + 重拉状态，不重复处理。 */
async function copyPipeline(id){
  const src=findPipeline(id); if(!src) return;
  const me=currentUsername||'';   // 副本署名：复制者即创建者与拥有者（当前登录用户），未取到则不署名
  const clone=JSON.parse(JSON.stringify(src));   /* 深拷贝：阶段及 script/url/sched/sub 等绑定均为纯数据 */
  clone.id='pl-'+Date.now().toString(36);
  clone.builtIn=false;   /* 副本一律非内置：内置流水线的副本亦可编辑/删除 */
  clone.pinnedAt=0;   /* 副本不继承置顶：置顶随源条目，不随复制扩散 */
  clone.favoriteUsers=[];   /* 副本不继承任何用户的收藏：收藏关系属于源流水线 */
  delete clone.trusted;   /* 副本不继承可信标记：复制品默认非可信（可信须由 admin 重新标记） */
  clone.name=uniqueCopyName(src.name);
  clone.createdBy=me;   /* 副本归属复制者，不继承源流水线创建者 */
  clone.owner=me;   /* 副本拥有者同为复制者：编辑权限按拥有者判定，不继承源流水线拥有者 */
  clone.updatedBy=me;   /* 复制即副本的最后一次修改 */
  pipelines.push(clone);
  try{ localStorage.setItem('pip-pipelines', JSON.stringify(pipelines)); }catch(e){}   /* 离线缓存即时更新（原 savePipelines 的同步语义），不等服务端确认 */
  /* 运行期复制：不切换当前流水线（避免脱离正在查看的运行视图），仅刷新列表 */
  if(running){ renderPipelines(); }
  else { selectPipeline(clone.id); }
  let saved=null;
  try{ saved=await pushPipelineOne(clone.id); }
  catch(e){ saved={ok:false,error:String(e&&e.message||e)}; }
  if(saved && saved.unsupported) await savePipelines({immediate:true});
  else if(saved && saved.ok===false && !saved.trusted){
    if(typeof toast==='function') toast('副本保存失败：'+String(saved.error||'未知错误')+'。副本仍保留在本页，稍后将自动重试保存；也可刷新前重新复制。');
    savePipelines();   /* 防抖重试兜底：走全量 PUT，冲突时由 pushState 的非静默 409 分支提示并自愈 */
  }
}
