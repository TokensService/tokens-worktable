/* ===== 03-run-dialog-api.js · 任务列表运行弹窗与流水线 API 调用说明 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 1963–2234）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* ---------- 流水线任务列表运行弹窗 ---------- */
function portalPipelineRunPanels(){
  const body=document.body; if(!body) return;
  /* 运行弹窗内的下拉面板提升到 body 浮层：fixed 定位 + z-index 1000 显示在最上层，
     不被弹窗卡片（overflow:auto）裁剪，也不随弹窗内容滚动错位 */
  ['pipelineRunEnvMultiPanel','pipelineRunBranchPanel','pipelineRunStrategyPanel'].forEach(id=>{
    const panel=$(id); if(panel&&panel.parentNode!==body) body.appendChild(panel);
  });
}
function positionPipelineRunPanel(panelId,anchorId){
  const panel=$(panelId),anchor=$(anchorId); if(!panel||!anchor||typeof anchor.getBoundingClientRect!=='function') return;
  const rect=anchor.getBoundingClientRect();
  panel.style.position='fixed';
  panel.style.left=Math.max(8,rect.left)+'px';
  panel.style.top=Math.max(8,rect.bottom+4)+'px';
  panel.style.minWidth=Math.max(200,rect.width)+'px';
  panel.style.zIndex='1000';
}
function positionPipelineRunPanels(){
  positionPipelineRunPanel('pipelineRunEnvMultiPanel','pipelineRunEnvMultiBtn');
  positionPipelineRunPanel('pipelineRunBranchPanel','pipelineRunBranch');
  positionPipelineRunPanel('pipelineRunStrategyPanel','pipelineRunStrategy');
}
function closePipelineRunDialog(){
  pipelineRunDialogPipelineId=''; pipelineRunDialogEnvIds=[];
  $('pipelineRunDialog').style.display='none';
  const panel=$('pipelineRunEnvMultiPanel'); if(panel) panel.style.display='none';
  const branchPanel=$('pipelineRunBranchPanel'); if(branchPanel) branchPanel.style.display='none';
  const strategyPanel=$('pipelineRunStrategyPanel'); if(strategyPanel) strategyPanel.style.display='none';
}
function renderPipelineRunDialogEnvs(){
  renderEnvMulti({
    btnId:'pipelineRunEnvMultiBtn',panelId:'pipelineRunEnvMultiPanel',
    getIds:()=>pipelineRunDialogEnvIds,
    setIds:ids=>{ pipelineRunDialogEnvIds=ids.slice(); },
    /* 运行弹窗收紧可选范围：「预留给我 / 未分配」筛选默认勾选，且预留给他人（envAvailGroup===2）的
       节点一律不可勾选（含 admin；已选中的保留可取消勾选） */
    availOnly:true,
  });
}
function openPipelineRunDialog(id){
  const pl=findPipeline(id); if(!pl) return;
  const defaults=currentPipelineRunOptions();
  portalPipelineRunPanels();
  pipelineRunDialogPipelineId=pl.id;
  pipelineRunDialogEnvIds=defaults.envs.map(env=>env&&env.id).filter(Boolean);
  $('pipelineRunTitle').textContent='运行流水线：'+(pl.name||pl.id);
  renderPipelineRunDialogEnvs();
  const repoSel=$('pipelineRunRepo'); repoSel.innerHTML='';
  const placeholder=document.createElement('option'); placeholder.value=''; placeholder.textContent='请选择代码仓'; repoSel.appendChild(placeholder);
  repositories.forEach(repo=>{ const option=document.createElement('option'); option.value=repo.id; option.textContent=repo.name||repo.url||repo.id; repoSel.appendChild(option); });
  repoSel.value=defaults.repoId;
  $('pipelineRunBranch').value=defaults.branch||'main';
  $('pipelineRunStrategy').value=defaults.strategy||'';
  $('pipelineRunWeightsPath').value=defaults.weightsPath||'';   // 权重路径默认继承主控当前值，可在弹窗逐项覆盖（留空=不注入）
  $('pipelineRunPresets').querySelectorAll('[data-pipelinerunpreset]').forEach(input=>{ input.checked=defaults.presets.indexOf(input.getAttribute('data-pipelinerunpreset'))>=0; });
  const warning=$('pipelineRunWarning');
  warning.textContent='';
  warning.style.display='none';
  $('pipelineRunDialog').style.display='flex';
}
function collectPipelineRunDialogOptions(){
  const presets=Array.from($('pipelineRunPresets').querySelectorAll('[data-pipelinerunpreset]')).filter(input=>input.checked).map(input=>input.getAttribute('data-pipelinerunpreset'));
  return {
    pipelineId:pipelineRunDialogPipelineId,
    envs:pipelineRunDialogEnvIds.map(id=>environments.find(env=>env.id===id)).filter(Boolean),
    repoId:$('pipelineRunRepo').value,
    branch:$('pipelineRunBranch').value.trim()||'main',
    strategy:$('pipelineRunStrategy').value.trim(),
    weightsPath:$('pipelineRunWeightsPath').value.trim(),
    presets,
  };
}
function submitPipelineRunDialog(){
  const options=collectPipelineRunDialogOptions(); if(!options.pipelineId) return;
  if(!findPipeline(options.pipelineId)){ closePipelineRunDialog(); alert('流水线已不存在，请刷新任务列表后重试。'); return; }
  if(!options.repoId || !repositories.some(repo=>repo.id===options.repoId)){ alert('请选择代码仓。'); return; }
  /* 节点预留拦截（客户端体验层，真正门禁在服务端）：弹窗选中的节点被预留给他人时 alert 明细并
     保持弹窗打开（不提交运行，用户可摘掉被预留节点后重试）。typeof 守卫：vm 抽取测试无该函数时跳过 */
  if(typeof envReservationIssue==='function'){
    const resIssue=envReservationIssue(options.envs);
    if(resIssue){ alert(resIssue); return; }
  }
  const result=runPipeline(options);
  if(result===false) alert('本地队列已满（上限 '+QUEUE_CAP+'），请等待当前任务完成或取消部分排队任务。');
  else if(result==='queued') flashRunTip('已加入本地队列（第 '+queue.length+' 位）');
  else if(result==='submitted') flashRunTip('已提交服务端运行队列');
  if(result===true || result==='queued' || result==='submitted') closePipelineRunDialog();
}
/* ---------- 流水线任务列表运行弹窗结束 ---------- */
/* ---------- 流水线 API 调用说明 ---------- */
function shellSingleQuoted(value){ return "'"+String(value).replace(/'/g,"'\"'\"'")+"'"; }
function pipelineApiSpec(pl,origin,sessionToken){
  /* 请求体与 curl 按主控运行框当前填写的运行参数动态生成（与点「▶ 运行流水线」取数一致：
     环境多选/代码仓/分支/部署策略/执行人/预设任务均取当前值），不再读取流水线保存的默认参数；
     默认参数仅在 API 调用方省略字段时由服务端逐项回退。 */
  const envIds=curEnvs().map(e=>e&&e.id).filter(Boolean);
  const repoId=String(($('repoSel')&&$('repoSel').value)||'').trim();
  const branch=(($('branchName')&&$('branchName').value)||'').trim()||'main';   // 与 runPipeline 一致：分支留空按 main
  const strategy=curStrategy();
  const by=currentUsername||'api';   // 执行人留空（未取到登录用户）按服务端缺省 api
  const presets=selectedPresetKeys();
  const weightsPath=curWeightsPath();   // 权重路径（主控可选填写）：随请求体 weightsPath 逐项覆盖，空串=不注入 MODEL_PATH
  /* environmentIds 显式空数组 = 不选择任何节点（无目标节点运行），服务端按空数组执行；
     代码仓显式空串仍会被服务端判 400（invalid repositoryId）：无有效选择时省略该字段
     （调用时回退流水线默认配置）并给出警告，不生成必败的请求体 */
  const issues=[];
  const body={};
  body.environmentIds=envIds;   // 与运行框一致：未选中任何节点即显式空数组（无目标节点运行）
  if(!envIds.length) issues.push('当前未选中目标环境：environmentIds 为空数组，即不选择任何节点（无目标节点运行）');
  if(repoId) body.repositoryId=repoId;
  else issues.push('当前未选中代码仓，已省略 repositoryId（调用时回退流水线默认配置）');
  body.branch=branch;
  body.strategy=strategy;   // 显式空串=不使用部署策略（逐项覆盖默认值）
  body.weightsPath=weightsPath;   // 显式空串=不注入 MODEL_PATH（权重路径无流水线默认值，省略字段同为不注入）
  body.presets=presets;     // 显式空数组=不执行预设任务（逐项覆盖默认值）
  body.by=by;
  const endpoint='/api/worktable/pipeline/run/'+encodeURIComponent(pl&&pl.id||'');
  const base=String(origin||'').replace(/\/+$/,'');
  const url=base+endpoint;
  const bodyText=JSON.stringify(body,null,2);
  /* curl 示例内嵌当前登录会话令牌（实际值，无占位符）：dsh-auth-gate 守卫接受 Authorization: Bearer
     会话令牌（与 Cookie 同权），复制即可在任意机器直接执行；令牌由弹窗打开时经 /api/worktable/session
     实时取当前会话生成，退出登录/换号后失效，重新打开本弹窗即得新值。未取到会话（未启用认证插件的
     token 共享部署）时省略认证行，单条命令直接调用。 */
  const token=String(sessionToken||'');
  const curl=(token
    ? "# 已内嵌当前登录会话令牌（实际值；与浏览器登录同权，退出登录后失效，届时重新打开本弹窗取新值）\ncurl -X POST "+shellSingleQuoted(url)+" \\\n  -H 'Content-Type: application/json' \\\n  -H "+shellSingleQuoted('Authorization: Bearer '+token)+" \\\n  --data "+shellSingleQuoted(JSON.stringify(body))
    : "# 未检测到登录会话（未启用认证插件的部署无需令牌），直接调用\ncurl -X POST "+shellSingleQuoted(url)+" \\\n  -H 'Content-Type: application/json' \\\n  --data "+shellSingleQuoted(JSON.stringify(body)));
  return {endpoint,body,bodyText,curl,warning:issues.join('；')};
}
/* 「▶ 直接调用」：页面内同源发起一次真实 POST（携带登录会话，免导出 Cookie），按对话框当前展示的
   端点与请求体原样调用；202 受理后复用 submitServerRun 的跟随机制（pendingServerRunFocus +
   pullRemoteQueue + followPendingServerRun）把编排区/阶段详情切到本次运行，结果内联展示不关闭弹窗。
   typeof 守卫：vm 抽取测试未注入跟随/拉取函数时跳过，不影响结果展示与断言。 */
async function invokePipelineApi(){
  const spec=pipelineApiCur; if(!spec) return;
  const btn=$('pipelineApiInvoke'), out=$('pipelineApiResult');
  if(btn){ btn.disabled=true; btn.textContent='调用中…'; }
  if(out){ out.style.display=''; out.style.color=''; out.textContent=''; }
  try{
    const res=await fetch(spec.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(spec.body)});
    const result=await res.json().catch(()=>({}));
    if(res.status===202&&result&&result.runId){
      if(out){ out.style.color='var(--log-ok,#4ade80)'; out.textContent='✓ 已受理：runId='+result.runId+'（流水线「'+(result.pipelineName||'')+'」），运行队列 / 运行历史中可查看进度与回显'; }
      if(typeof followPendingServerRun==='function'&&typeof SERVER_RUN_FOCUS_MS==='number'){
        pendingServerRunFocus={runId:String(result.runId),until:Date.now()+SERVER_RUN_FOCUS_MS,previewId:''};
      }
      if(typeof pullRemoteQueue==='function') await pullRemoteQueue();
      if(typeof followPendingServerRun==='function') followPendingServerRun();
    }else if(out){
      out.style.color='var(--log-err,#f87171)';
      out.textContent='✗ HTTP '+res.status+'：'+String((result&&(result.error||result.message))||'调用失败');
    }
  }catch(e){
    if(out){ out.style.color='var(--log-err,#f87171)'; out.textContent='✗ 网络错误：'+String(e&&e.message||e); }
  }finally{
    if(btn){ btn.disabled=false; btn.textContent='▶ 直接调用'; }
  }
}
async function showPipelineApi(pl){
  if(!pl) return;
  /* 打开时实时取当前会话令牌填进 curl 示例（实际值，无占位符）；取不到（未启用认证插件 / 网络异常）
     按无令牌生成（省略认证行）。typeof 守卫：vm 抽取测试未注入 fetch 时跳过，同步路径不受影响 */
  let sessionToken='';
  try{
    if(typeof fetch==='function'){
      const sessionRes=await fetch('/api/worktable/session',{cache:'no-store'});
      if(sessionRes&&sessionRes.ok){ const sessionInfo=await sessionRes.json(); sessionToken=String(sessionInfo&&sessionInfo.token||''); }
    }
  }catch(e){}
  const spec=pipelineApiSpec(pl,location.origin,sessionToken);
  pipelineApiCur={endpoint:spec.endpoint,body:spec.body};
  $('pipelineApiTitle').textContent='流水线 API：'+(pl.name||pl.id);
  $('pipelineApiEndpoint').textContent=spec.endpoint;
  $('pipelineApiWarning').textContent=spec.warning?'⚠ '+spec.warning:'';
  $('pipelineApiWarning').style.display=spec.warning?'':'none';
  $('pipelineApiBody').textContent=spec.bodyText;
  $('pipelineApiCurl').textContent=spec.curl;
  const apiOut=$('pipelineApiResult'); if(apiOut){ apiOut.style.display='none'; apiOut.textContent=''; }
  const apiBtn=$('pipelineApiInvoke'); if(apiBtn){ apiBtn.disabled=false; apiBtn.textContent='▶ 直接调用'; }
  $('pipelineApiDialog').style.display='flex';
}
/* ---------- 流水线 API 调用说明结束 ---------- */
/* 内置种子工厂：按注册表生成内置流水线（migratePipelineDefaults 归一化默认运行参数；
   注册表 defaults 增量覆盖，如 vLLM 流水线把默认分支固定为 v0.30.0.tokens、预设任务默认全不勾选） */
function builtinPipelineSeed(id){
  const def=BUILTIN_PIPELINE_DEFS.find(d=>d.id===id);
  if(!def) return null;
  const p=migratePipelineDefaults({id:def.id, name:def.name, stages:def.stages(), builtIn:true});
  if(def.defaults) p.defaults=normalizePipelineDefaults(Object.assign({}, p.defaults, def.defaults));
  return p;
}
function defaultPipeline(){ return builtinPipelineSeed(DEFAULT_PIPELINE_ID); }
function builtinPipelineSeeds(){ return BUILTIN_PIPELINE_DEFS.map(d=>builtinPipelineSeed(d.id)); }
/* 内置重组（loadPipelines/loadServerState/applyPipelineRefreshPayload/normalizeImportedPipelines/deletePipeline
   五处共用）：按注册表顺序逐条「存储版（保留 admin 编辑）优先、缺省用种子」，自定义条目随后；
   未登记 id 的 builtIn 条目（未来/旧版）按既有口径丢弃。 */
function regroupBuiltinPipelines(list){
  const src=Array.isArray(list)?list:[];
  const customs=src.filter(p=>p && !p.builtIn);
  return builtinPipelineSeeds().map(seed=> src.find(p=>p && p.builtIn && p.id===seed.id) || seed ).concat(customs);
}
/* 键序无关深比较（内置种子纯净度判定用；数组按序、对象按键集） */
function deepEqLoose(a,b){
  if(a===b) return true;
  if(typeof a!==typeof b) return false;
  if(!a||!b||typeof a!=='object') return false;
  if(Array.isArray(a)!==Array.isArray(b)) return false;
  if(Array.isArray(a)){
    if(a.length!==b.length) return false;
    for(let i=0;i<a.length;i++){ if(!deepEqLoose(a[i],b[i])) return false; }
    return true;
  }
  const ka=Object.keys(a), kb=Object.keys(b);
  if(ka.length!==kb.length) return false;
  for(const k of ka){ if(!Object.prototype.hasOwnProperty.call(b,k)||!deepEqLoose(a[k],b[k])) return false; }
  return true;
}
/* 全量写服务端时该内置条目是否免上送：① 内置；② 内容与代码种子逐字段一致（剥离 favoriteUsers/pinnedAt
   共享元数据、并剥离各阶段 script.path——rebindBuiltinScriptPaths 按名回填的本机路径属环境适配、
   不算内容编辑）——即「纯净种子」；③ 服务端基线尚无该 id。满足即免上送：否则非 admin 的首次保存会把
   新内置种子的「创建」推给服务端，触发 builtinCreate 403（src/index.ts trustedPipelineViolations）。
   admin 编辑过（内容偏离种子）或服务端已持久化的内置条目照常随包上送；纯净种子不上送不影响本端
   展示与运行（种子在代码里），admin 首次编辑保存后即转为服务端版本。 */
function builtinSeedOmittable(p){
  if(!p || p.builtIn!==true) return false;
  const seed=builtinPipelineSeed(p.id); if(!seed) return false;
  const base=(typeof serverConfigBase!=='undefined'&&serverConfigBase&&Array.isArray(serverConfigBase.pipelines))?serverConfigBase.pipelines:[];
  if(base.some(b=>b && b.id===p.id)) return false;
  const normalize=p=>{ const c=JSON.parse(JSON.stringify(stripPipelineSharedMeta(p))); (c.stages||[]).forEach(s=>{ if(s && s.script) delete s.script.path; }); return c; };
  return deepEqLoose(normalize(p), normalize(seed));
}
/* 旧数据迁移：「审批门」(gate) 已改为「是否执行」(skip)，旧 gate:true 阶段按不执行处理 */
function migrateGate(p){ if(p && Array.isArray(p.stages)) p.stages.forEach(s=>{ if(s && s.gate){ s.skip=true; delete s.gate; } }); return p; }
/* 旧数据迁移：Jenkins 阶段先改为 URL 请求阶段、再统一改为 HTTP 阶段（kind:'jenkins'/'url'→'http'，jenkins.job→url.url）；
   「拉取参数」的 params/values 随之下线，参数改由 URL 的 {GIT_BRANCH} 等 {变量名} 占位符传递 */
function migrateStageUrl(p){ if(p && Array.isArray(p.stages)) p.stages.forEach(s=>{ if(!s) return; if(s.kind==='jenkins'||s.kind==='url') s.kind='http'; if(s.jenkins){ if(!s.url) s.url={url:s.jenkins.job||'', outVars:s.jenkins.outVars||''}; delete s.jenkins; } }); return p; }
/* HTTP 阶段取值（兼容旧数据：kind:'jenkins'/'url' / jenkins.job 字段，见 migrateStageUrl/normalizeStageKind） */
function stageUrlOf(s){ if(!s) return ''; if(s.url && s.url.url!==undefined) return String(s.url.url||''); return (s.jenkins && s.jenkins.job) ? String(s.jenkins.job) : ''; }
/* 旧数据迁移：旧版识别器把脚本静态 :-默认值 预填进 values 作为显式值（压过运行级注入的同名变量）；
   现默认值以可编辑文本填入参数框、未改动不写入 values 不下发，加载时清掉与识别默认值相同的 values 项（视为预填产物，见 cleanScriptValues） */
function migratePrefillDefaults(p){ if(p && Array.isArray(p.stages)) p.stages.forEach(s=>{ if(s && s.script && s.script.values) s.script.values=cleanScriptValues(s.script.params, s.script.values); }); return p; }
/* 旧数据迁移：「收集普罗数据」已从系统预设任务下线（改为任务卡上的「收集普罗数据」开关，见 renderStageEditor/taskPromCollect），
   清掉阶段列表里的 promCollect 预设标记行与旧顶层 prom 配置（其中 model/namespace 取值即现 DEFAULT_PIPELINE_PROM 默认值，不再随流水线保存） */
function migratePromPreset(p){ if(p && Array.isArray(p.stages)) p.stages=p.stages.filter(s=>!(s && s.preset && s.pkey==='promCollect')); if(p) delete p.prom; return p; }
function loadPipelines(){
  let stored=null;
  try{ const a=JSON.parse(localStorage.getItem('pip-pipelines')); stored=Array.isArray(a)?a:null; }catch(e){ stored=null; }
  if(stored && stored.length){
    return regroupBuiltinPipelines(stored).map(migrateGate).map(migrateStageUrl).map(migratePrefillDefaults).map(migratePipelineDefaults).map(migratePromPreset);
  }
  return builtinPipelineSeeds();
}
function curPipeline(){ return pipelines.find(p=>p.id===curPipelineId) || pipelines[0]; }
function activeStages(){ return runStages || curPipeline().stages; }
function findPipeline(id){ return pipelines.find(p=>p.id===id); }
function savePipelines(options){
  try{ localStorage.setItem('pip-pipelines', JSON.stringify(pipelines)); }catch(e){}
  if(options&&options.immediate) return pushState(options);   /* silentConflict 等选项透传给 pushState */
  persistState();
}
