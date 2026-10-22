/* ===== 23-theme-binding-share.js · 主题切换、DOM 事件绑定与流水线分享 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 11344–11720）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */


/* ---------- 主题切换 ---------- */
function systemDark(){ return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches); }
/* 只把当前主题应用到 DOM 与本地缓存，不持久化到服务端：本函数随 renderAll 被首屏初始化、
   loadServerState 成功重渲染、409/403 自愈重拉反复调用，若在此 persistState，页面一开（及每次
   自愈重拉后）都会无条件排一次全量 PUT——本地相对服务端并无任何实际变化，多人在场时每个访客的
   这次自动写都是潜在 409 冲突源。主题偏好只有用户在下拉框改选时才真正变化，由 change 监听器
   显式 persistState；系统深浅色翻转不改 themePref（collectConfig 无差异），同样无需写。 */
function applyTheme(){ const resolved = themePref==='auto' ? (systemDark()?'dark':'light') : themePref; document.documentElement.setAttribute('data-theme', resolved); try{ localStorage.setItem('pip-theme', themePref); }catch(e){} }

/* ---------- 绑定 ---------- */
function toast(msg){
  let el=(typeof $==='function')?$('pageToast'):null;
  if(!el && typeof document!=='undefined' && document.createElement && document.body){
    el=document.createElement('div'); el.id='pageToast'; el.className='page-toast';
    document.body.appendChild(el);
  }
  if(!el) return;
  el.textContent=String(msg||'');
  el.style.display='block';
  if(pageToastTimer && typeof clearTimeout==='function') clearTimeout(pageToastTimer);
  if(typeof setTimeout==='function') pageToastTimer=setTimeout(()=>{ el.style.display='none'; },4000);
}
function flashRunTip(txt){ const t=$('runTip'); if(!t) return; t.textContent=txt; if(runTipTimer) clearTimeout(runTipTimer); runTipTimer=setTimeout(()=>{ t.textContent=''; },2500); }
/* 中止指定运行：以「已中止」计入历史并消耗队列。
   流式脚本经 AbortController 断开会话并终止子进程；Jenkins/EvalTokens 阶段在各自 finally 中停止外部 build/run；
   旧插件构建的一次性执行无法中断，结果回来后按令牌丢弃。 */
function abortRun(rc){
  if(!rc || rc.over) return;
  cancelParallelGroup(rc);   // 并行子上下文各自持有取消器/计时器，先全部终止再按父运行统一记一次中止历史
  if(rc.scriptAbort){ try{ rc.scriptAbort.abort(); }catch(e){} }   // 断开流式会话 / 取消 EvalTokens 请求
  if(rc.timer){ clearInterval(rc.timer); rc.timer=null; }
  // 中止兜底：先把被中断任务（含预设任务）的当前回显即时归档为独立任务日志（archiveStageLog 内部有 _logArchived 幂等保护）
  rc.stages.forEach((s,idx)=>{ const n=rc.nodes[s.id]; if(n && n.status==='running') archiveStageLog(s, stageSeq(rc.stages,idx), rc); });
  // 被中断的运行中阶段置为 aborted（保留已运行进度/耗时/变量），详情面板如实展示「终止」而非误显「未开始」
  rc.stages.forEach(s=>{ const n=rc.nodes[s.id]; if(n && (n.status==='running')) rc.nodes[s.id]=Object.assign({}, n, {status:'aborted',progress:n.progress||0,dur:n.dur||0,sub:{},varsIn:n.varsIn||{},varsOut:n.varsOut||{}}); });
  finish(rc,'aborted');
  rcRender(rc);
}
function pipelineDefaultFormChanged(){ editDefaults=collectPipelineDefaultForm(); schedulePlDraftSave(); }
function updateStageFromEditor(e){
  const f=e.target.getAttribute && e.target.getAttribute('data-f'); if(!f) return;
  const row=e.target.closest('.plstage'); const i=parseInt(row.dataset.idx,10); const s=editStages[i]; if(!s) return;
  if(f==='ord'){   // 数字排序：把该阶段移动到目标序号（1 起，自动夹取到有效范围）
    const to=Math.min(editStages.length, Math.max(1, parseInt(e.target.value,10)||(i+1)))-1;
    if(to!==i){ editFocusIdx=moveEditStage(i,to); renderStageEditor(); }
    else e.target.value=String(i+1);
    return;
  }
  if(f==='name') s.name=e.target.value;
  else if(f==='dur'){ const mv=parseFloat(e.target.value); s.dur=Math.max(0,Math.round(mv*60)||0); }   /* 输入为分钟，×60 存秒；0/留空=0（不设置耗时，运行即结束），编辑时保留原值 */
  else if(f==='timeout'){ const sec=Math.round(parseFloat(e.target.value)*60); s.timeout=(sec>=1)?sec:null; }   /* 留空=null（无超时） */
  else if(f==='skip') s.skip=e.target.checked;
  else if(f==='parallel') s.parallel=e.target.checked;
  else if(f==='sched'){ if(s.kind==='http'){ s.sched = e.target.checked ? null : {}; } renderStageSched(i); } /* 勾选「需本地运行」置空 sched；取消勾选恢复支持定时。仅 http 任务类型支持本地执行：非 http 阶段即使收到外部置空（旧 DOM/分享导入残留）也不改 sched */
  else if(f==='script'){ setStageScript(i, e.target.value.trim()); }
  else if(f==='stageUrl'){ setStageUrl(i, e.target.value); }
  else if(f==='urlOutVars'){ if(!s.url) s.url={url:'',outVars:''}; s.url.outVars=e.target.value; }
  else if(f==='etTaskId'){ if(!s.evaltokens) s.evaltokens=Object.assign(evaltokensStageConfig(null),{params:[]}); const nid=e.target.value.trim(); if(nid!==s.evaltokens.taskId) s.evaltokens.values={}; s.evaltokens.taskId=nid; s.evaltokens.taskName=''; s.evaltokens.params=[]; detectEvaltokStageParams(i,true); }   /* 手动输入后清除选择器残留名称，再异步识别参数（失败保留空）；改换任务时原任务已设参数值一并清空 */
  else if(f==='etOutVars'){ if(!s.evaltokens) s.evaltokens=Object.assign(evaltokensStageConfig(null),{params:[]}); s.evaltokens.outVars=e.target.value; }
  else if(f==='etCollectReport'){ if(!s.evaltokens) s.evaltokens=Object.assign(evaltokensStageConfig(null),{params:[]}); s.evaltokens.collectReport=!!e.target.checked; }
  else if(f==='scriptOutVars'){ if(!s.script) s.script={name:'',path:'',lang:(s.kind==='python'?'py':'sh'),params:[],values:{}}; s.script.outVars=e.target.value; }   /* 未选脚本先存占位，保存时无名脚本不落库（savePlForm） */
  else if(f==='promCollect') s.promCollect=e.target.checked;   // 任务级普罗采集开关：任务终态按其起止采集普罗指标（见 taskPromFinalize）
  schedulePlDraftSave();
}
/* 页面切换（流水线 / 定时 / 节点管理 / 设置） */
function switchPage(p){
  $('pageMain').style.display = p==='main'?'':'none';
  $('pageSched').style.display = p==='sched'?'':'none';
  $('pageNode').style.display = p==='node'?'':'none';
  $('pageEnv').style.display = p==='env'?'':'none';
  $('navMain').className = 'dshell-btn mini'+(p==='main'?'':' dshell-btnGhost');
  $('navSched').className = 'dshell-btn mini'+(p==='sched'?'':' dshell-btnGhost');
  $('navNode').className = 'dshell-btn mini'+(p==='node'?'':' dshell-btnGhost');
  $('navEnv').className = 'dshell-btn mini'+(p==='env'?'':' dshell-btnGhost');
  if(p==='sched'){ renderSchedForm(); loadPlans(); }   // 进「定时」页重新拉取计划列表：其他浏览器/服务端的增删与活动执行状态一并刷新
  if(p==='node'){ loadNodeReservations(); }   // 进「节点管理」页顺带刷新预留数据：他端的分配改动同步进「预留」列与选择拦截
}
/* 分析配置（设置页内卡片）：提示词模板编辑 */
function fillCfgForm(){ $('cfgPromptLog').value=analysisPrompts.log; $('cfgPromptProf').value=analysisPrompts.prof; $('cfgPromptPerf').value=analysisPrompts.perf; $('cfgPromptStage').value=analysisPrompts.stage; }

/* ---------- 流水线分享（行「⋯」菜单 → 分享 / 新建流水线 → 从分享导入） ----------
   分享载荷只含定义内容（名称 / 业务阶段 / 默认运行参数），不含 id、内置、置顶、收藏、可信与署名等实例元数据；
   预设任务不随分享传递（系统清理/检查/Profiling 与自定义预设的标记行、默认勾选）：预设脚本在各端设置页配置、
   自定义预设 key 也因端而异，带过去对不上本端配置——导入后由本端 withPresetMarkers 按本地设置补齐标记行，
   默认勾选为空由用户在编辑器自选。点「分享」把 JSON 复制到剪贴板，对方在「新建流水线」点「从分享导入」，
   在弹出的输入框粘贴还原到编辑器，确认后保存为新流水线。载荷含阶段脚本参数值（可能含节点口令等敏感信息），
   仅在可信渠道传递。 */
function buildPipelineShare(pl){
  return {
    app:'worktable-pipeline', kind:'pipeline-share', version:1, exportedAt:new Date().toISOString(),
    pipeline:{
      name:typeof pl.name==='string'?pl.name:'',
      stages:JSON.parse(JSON.stringify(pl.stages||[])).filter(s=>!(s && s.preset)),
      defaults:Object.assign(normalizePipelineDefaults(pl.defaults),{presets:[]}),
    },
  };
}
function sharePipeline(id){
  const pl=findPipeline(id); if(!pl) return;
  copyText(JSON.stringify(buildPipelineShare(pl), null, 2));
  if(typeof toast==='function') toast('✓ 已复制流水线「'+pl.name+'」的分享内容到剪贴板；在「新建流水线」点「从分享导入」即可还原');
}
/* 解析分享内容：接受 buildPipelineShare 的 envelope，或直接粘贴的流水线对象（{name,stages,...}）；
   非法（非 JSON / 无业务阶段）返回 null。预设任务不随分享传递：载荷里若有预设标记行或默认勾选
   （旧版分享 / 手写 JSON）在此剥掉，导入后由本端 withPresetMarkers 按本地设置补齐。 */
function parsePipelineShare(text){
  let data=null;
  try{ data=JSON.parse(String(text==null?'':text).trim()); }catch(e){ return null; }
  if(!data || typeof data!=='object' || Array.isArray(data)) return null;
  let p=null;
  if(data.app==='worktable-pipeline' && data.kind==='pipeline-share' && data.pipeline && typeof data.pipeline==='object' && !Array.isArray(data.pipeline)) p=data.pipeline;
  else if(Array.isArray(data.stages)) p=data;
  else return null;
  const stages=JSON.parse(JSON.stringify(p.stages)).filter(s=>!(s && s.preset));
  if(!stages.some(s=>s && typeof s==='object')) return null;
  return {
    name:typeof p.name==='string'?p.name:'',
    stages,
    defaults:Object.assign(normalizePipelineDefaults(p.defaults),{presets:[]}),
  };
}
/* 「新建流水线 → 从分享导入」：点按钮弹出 textarea 输入框，粘贴分享 JSON 后确认导入；
   解析成功后覆盖当前表单（名称/阶段/默认运行参数）并存草稿，由用户确认后点「保存」落库。 */
function plShareImportTipShow(msg, bad){ const t=$('plShareImportTip'); if(!t) return; t.style.color=bad?'var(--log-err)':'var(--log-ok)'; t.textContent=msg; }
function openPipelineShareImport(){
  const d=$('plShareImportDialog'); if(!d) return;
  const ta=$('plShareImportText'); if(ta) ta.value='';
  plShareImportTipShow('');
  d.style.display='flex';
}
function closePipelineShareImport(){ const d=$('plShareImportDialog'); if(d) d.style.display='none'; }
function importPipelineShare(){
  if(plFormReadOnly || $('plForm').dataset.editId) return;
  openPipelineShareImport();
}
/* 从弹窗 textarea 内容导入：非法（非 JSON / 无 stages）在弹窗内给 ✗ 提示并保留粘贴内容供修正；
   解析成功后填表并关闭弹窗。返回 'ok' / 'invalid'。 */
async function applyPipelineShareText(text){
  const shared=parsePipelineShare(text);
  if(!shared){ plShareImportTipShow('✗ 分享内容无效：不是可识别的流水线分享 JSON', true); return 'invalid'; }
  $('plName').value=shared.name||'';
  editStages=editStagesFromStored(shared.stages);
  editDefaults=normalizePipelineDefaults(shared.defaults);
  editSelStage=null; editFocusIdx=-1;
  renderPipelineDefaultForm();
  schedulePlDraftSave();
  loadScripts().then(async ()=>{
    renderStageEditor();
    await Promise.all(editStages.map((s,i)=>{
      if(s.preset) return null;   // 预设任务行的脚本在设置页配置，不参与阶段参数识别
      if(s.kind==='evaltokens'&&s.evaltokens&&s.evaltokens.taskId) return detectEvaltokStageParams(i,true);
      if(s.script&&s.script.path) return detectStageParams(i,true);
      return null;
    }));
  });
  closePipelineShareImport();
  if(typeof toast==='function') toast('✓ 已从分享内容导入「'+(shared.name||'未命名流水线')+'」，确认后点「保存」');
  return 'ok';
}
