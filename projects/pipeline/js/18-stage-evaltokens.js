/* ===== 18-stage-evaltokens.js · EvalTokens 任务运行阶段（启动 run 并等待终态） =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 8502–9199）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* ---------- EvalTokens 任务运行阶段：启动新 run 并等待终态（本地直连 / 远程走 proxy；复用「设置」页 EvalTokens 服务配置 + Bearer 令牌） ----------
   任务由「设置」页 EvalTokens 服务管理（GET /api/open/v1/tasks）；阶段填任务 ID（优先）或名称，运行时先匹配任务，
   再 POST /api/open/v1/tasks/:id/run 启动新 run，并通过 runs 接口只等待该 run 到终态。运行对象顶层标量字段按 KEY=VALUE /
   单行 JSON 规则累计为输出变量（与 HTTP / 脚本阶段一致，见 mergeStageVars/applyOutVars），并附「查看报告」链接。 */
/* 取已保存的 EvalTokens 服务配置（地址/令牌/连接模式，见 loadEvaltok）；服务未配置时返回空 url 供调用方提示 */
function evaltokConfig(){ return evaltok && typeof evaltok==='object' ? evaltok : {url:'',token:'',mode:'local'}; }
/* EvalTokens JSON 请求：本地浏览器直连或经 /api/worktable/proxy 代连；POST 请求体显式发 {}，兼容服务端 JSON 解析。
   timeoutMs（可选）仅对代连生效：传给代理的上游超时（默认 20s，上限 24h）；同步 /run 等长耗时调用必须显式传入。 */
async function evaltokRequestJson(e, api, method, body, signal, timeoutMs){
  const verb=method||'GET'; const headers=evaltokHeaders(e);
  if(body!==undefined) headers['Content-Type']='application/json';
  if(e.mode==='remote'){
    const req={url:api,method:verb,headers}; if(body!==undefined) req.body=JSON.stringify(body);
    if(Number(timeoutMs)>0) req.timeoutMs=Number(timeoutMs);
    const r=await fetch('/api/worktable/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req),signal:signal});
    const p=await r.json(); if(p&&p.error) throw new Error(p.error+(/-?only loopback|private targets/i.test(String(p.error))?'（公网地址请切「本地浏览器连接」）':''));
    const status=p.status||0; if(status<200||status>=300){ let msg='HTTP '+status; try{ const j=JSON.parse(p.body||'{}'); if(j&&(j.error||j.message)) msg=String(j.error||j.message)+'（HTTP '+status+'）'; }catch(_){} throw new Error(msg); }
    return JSON.parse(p.body||'{}');
  }
  const opts={method:verb,cache:'no-store',headers,signal:signal}; if(body!==undefined) opts.body=JSON.stringify(body);
  const r=await fetch(api,opts), text=await readBrowserResponseText(r,20*1024*1024); let parsed;
  try{ parsed=JSON.parse(text); }catch(error){ if(r.ok) throw error; }
  if(!r.ok){ let msg='HTTP '+r.status; if(parsed&&(parsed.error||parsed.message)) msg=String(parsed.error||parsed.message)+'（HTTP '+r.status+'）'; throw new Error(msg); }
  return parsed;
}
/* EvalTokens 文本请求：报告接口返回完整 HTML，不做 JSON 解析；连接模式/鉴权/错误提示与 JSON 请求一致。 */
async function evaltokRequestText(e, api, signal){
  const headers=evaltokHeaders(e);
  if(e.mode==='remote'){
    const r=await fetch('/api/worktable/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:api,method:'GET',headers:headers}),signal:signal});
    const p=await r.json(); if(p&&p.error) throw new Error(p.error+(/-?only loopback|private targets/i.test(String(p.error))?'（公网地址请切「本地浏览器连接」）':''));
    const status=p.status||0, text=String(p.body||'');
    if(status<200||status>=300){ let msg='HTTP '+status; try{ const j=JSON.parse(text||'{}'); if(j&&(j.error||j.message)) msg=String(j.error||j.message)+'（HTTP '+status+'）'; }catch(_){} throw new Error(msg); }
    return text;
  }
  const r=await fetch(api,{method:'GET',cache:'no-store',headers:headers,signal:signal}); const text=await readBrowserResponseText(r,20*1024*1024);
  if(!r.ok){ let msg='HTTP '+r.status; try{ const j=JSON.parse(text||'{}'); if(j&&(j.error||j.message)) msg=String(j.error||j.message)+'（HTTP '+r.status+'）'; }catch(_){} throw new Error(msg); }
  return text;
}
/* 拉取 EvalTokens 任务列表，并归一化裸数组 / {data|tasks|list|items|results:[...]} 等常见包装。 */
async function evaltokFetchTasks(e, signal){
  const base=(e.url||'').replace(/\/+$/,''); if(!base) throw new Error('EvalTokens 服务地址未配置（请在「设置」页配置）');
  const data=await evaltokRequestJson(e, base+'/api/open/v1/tasks', 'GET', undefined, signal);
  return Array.isArray(data)?data:(Array.isArray(data.data)?data.data:(Array.isArray(data.tasks)?data.tasks:(Array.isArray(data.list)?data.list:(Array.isArray(data.items)?data.items:(Array.isArray(data.results)?data.results:[])))));
}
/* 启动一次新的任务运行；返回的 run_id 是后续轮询唯一依据，不能用该任务的旧运行结果代替。
   input：编辑器显式设置的任务输入参数覆盖（键值对），非空时随请求体 {input:{...}} 下发；未设置时保持空体 {} 兼容旧行为。
   timeoutMs：/run 调用的整体超时——服务端为同步执行（任务跑完才返回启动响应）时必须覆盖整个任务时长；
   缺省走代理默认 20s，仅兼容旧的异步秒回服务。 */
async function evaltokStartRun(e, taskId, signal, input, timeoutMs){
  const base=(e.url||'').replace(/\/+$/,''); if(!base) throw new Error('EvalTokens 服务地址未配置（请在「设置」页配置）');
  const body=(input && Object.keys(input).length) ? {input:input} : {};
  const run=await evaltokRequestJson(e, base+'/api/open/v1/tasks/'+encodeURIComponent(taskId)+'/run', 'POST', body, signal, timeoutMs);
  if(!run||!run.run_id) throw new Error('EvalTokens 启动任务未返回 run_id');
  return run;
}
async function evaltokStopRun(e, runId){
  const base=(e.url||'').replace(/\/+$/,''); if(!base) throw new Error('EvalTokens 服务地址未配置（请在「设置」页配置）');
  const stopCtrl=new AbortController(); const timeout=setTimeout(function(){ stopCtrl.abort(); },10000);
  try{ return await evaltokRequestJson(e,base+'/api/v1/tasks/runs/'+encodeURIComponent(runId)+'/stop','POST',{},stopCtrl.signal); }
  finally{ clearTimeout(timeout); }
}
/* 拉取指定任务的运行列表；服务当前返回 {runs:[...]}，同时兼容裸数组 / data|items|results 包装。 */
async function evaltokFetchRuns(e, taskId, signal){
  const base=(e.url||'').replace(/\/+$/,''); if(!base) throw new Error('EvalTokens 服务地址未配置（请在「设置」页配置）');
  const api=base+'/api/open/v1/tasks/runs?task_id='+encodeURIComponent(taskId);
  const data=await evaltokRequestJson(e, api, 'GET', undefined, signal);
  return Array.isArray(data)?data:(Array.isArray(data.runs)?data.runs:(Array.isArray(data.data)?data.data:(Array.isArray(data.items)?data.items:(Array.isArray(data.results)?data.results:[]))));
}
/* 终态 run 的完整报告：通用 report 接口的 task_id 实际传启动响应返回的 run_id。 */
function evaltokReportUrl(e, runId){
  const base=(e.url||'').replace(/\/+$/,''); if(!base) throw new Error('EvalTokens 服务地址未配置（请在「设置」页配置）');
  return base+'/api/v1/report?task_id='+encodeURIComponent(runId);
}
async function evaltokFetchReport(e, runId, signal){
  return evaltokRequestText(e, evaltokReportUrl(e,runId), signal);
}
async function evaltokFetchTasksCached(){
  const now=Date.now();
  if(evaltokTasksCache.tasks && now-evaltokTasksCache.ts<15000) return evaltokTasksCache.tasks;
  const tasks=await evaltokFetchTasks(evaltokConfig());
  evaltokTasksCache={tasks, ts:now};
  return tasks;
}
/* 从 EvalTokens 任务对象提取输入参数：兼容 input/inputs/params/parameters/args/config/arguments 等常见字段名，
   对象取键值对、数组取 {name|key, value|def|default} 元素，供阶段编辑器识别展示并设置覆盖值 */
function detectEvaltokTaskParams(task){
  if(!task || typeof task!=='object') return [];
  const fields=['input','inputs','params','parameters','args','arguments','config','input_params','task_params','task_input','input_args','payload','metadata'];
  let raw=null;
  for(const f of fields){ const v=task[f]; if(v!==undefined && v!==null){ raw=v; break; } }
  if(raw==null) return [];
  const params=[]; const seen={};
  const add=(k,v)=>{
    k=String(k); if(!k || seen[k]) return; seen[k]=1;
    if(v && typeof v==='object') try{ v=JSON.stringify(v); }catch(_){ v=String(v); }
    params.push({key:k, label:k, def:String(v), required:false});
  };
  if(Array.isArray(raw)){
    raw.forEach((item,idx)=>{
      if(item && typeof item==='object'){
        const k=item.key||item.name||item.param||item.field||item.label||('参数'+(idx+1));
        const v=item.value!==undefined?item.value:(item.def!==undefined?item.def:(item.default!==undefined?item.default:''));
        add(k,v);
      } else { add(String(item),''); }
    });
  } else if(typeof raw==='object'){
    Object.keys(raw).forEach(k=>add(k, raw[k]));
  }
  return params;
}
/* 阶段编辑器：对已选任务的 evaltokens 阶段自动识别输入参数（拉取任务列表→匹配任务→提取参数）。
   只刷新 params（参数定义与任务原值）；用户在 evaltokens.values 里显式设置的参数值一律保留、不被识别结果刷新。
   keepOnError：编辑器打开时置 true——服务未配置 / 拉取失败时保留已有参数不清空 */
async function detectEvaltokStageParams(i, keepOnError){
  const s=editStages[i]; if(!s||s.kind!=='evaltokens'||!s.evaltokens) return;
  const tid=String(s.evaltokens.taskId||'').trim(); if(!tid) return;
  try{
    const tasks=await evaltokFetchTasksCached();
    const idOf=t=>String(t.id||t.task_id||t.uuid||t._id||'');
    const nameOf=t=>String(t.name||t.title||t.task_name||t.display_name||'');
    const task=tasks.find(t=>idOf(t)===tid) || tasks.find(t=>nameOf(t)===tid) || null;
    if(!task){ if(!keepOnError) s.evaltokens.params=[]; }
    else{ s.evaltokens.params=detectEvaltokTaskParams(task); }
  }catch(e){ if(!keepOnError) s.evaltokens.params=[]; }
  renderStageParams(i);
  applyPlFormReadOnly();   // 异步重识别重建了参数输入框，只读模式下需重新禁用
}
/* EvalTokens 任务状态归类：成功 / 失败 / 运行中（大小写不敏感子串匹配，覆盖 success|done|completed|passed|finished 与 failed|error|cancel|abort|killed 等） */
function evaltokStatusKind(st){
  const s=String(st||'').toLowerCase();
  if(/success|succeed|done|complet|pass|finish/.test(s)) return 'success';
  if(/fail|error|cancel|abort|kill|stop|timeout/.test(s)) return 'failed';
  return 'running';
}
/* 编辑器 evalTokens 任务选择面板：聚焦输入框 / 点「选择」按钮时拉取任务列表并渲染可搜索下拉，
   选中任务后回填 taskId/taskName 并自动识别任务输入参数（复用「设置」页 EvalTokens 服务配置 + Bearer 令牌） */
async function openEvaltokPicker(i){
  const wrap=$('plStageList'); const row=(wrap && wrap.children)?wrap.children[i]:null; if(!row) return;
  const box=row.querySelector('[data-action]'); if(!box) return;
  const panel=box.querySelector('[data-etpick-panel]'); if(!panel) return;
  const s=editStages[i]; if(!s||!s.evaltokens) return;
  panel.style.display='block';
  panel.innerHTML='<div class="dshell-muted" style="font-size:11px;padding:4px 6px;">拉取中'+loadingDots()+'</div>';
  try{
    const tasks=await evaltokFetchTasksCached();
    s._etTasks=tasks;   /* 暂存供输入框过滤面板用（_ 前缀=瞬态，不持久化） */
    renderEvaltokPickerPanel(i, '');
  }catch(e){
    panel.innerHTML='<div style="color:var(--log-err);font-size:11px;padding:4px 6px;white-space:pre-wrap;">✗ '+(e&&e.message?e.message:e)+'</div>';
  }
}
/* 渲染任务选择面板内容：按输入框文本过滤，点击项回填并触发参数识别 */
function renderEvaltokPickerPanel(i, q){
  const wrap=$('plStageList'); const row=(wrap && wrap.children)?wrap.children[i]:null; if(!row) return;
  const box=row.querySelector('[data-action]'); if(!box) return;
  const panel=box.querySelector('[data-etpick-panel]'); if(!panel) return;
  const s=editStages[i]; if(!s) return;
  const tasks=(s._etTasks)||[];
  const idOf=t=>String(t.id||t.task_id||t.uuid||t._id||'');
  const nameOf=t=>String(t.name||t.title||t.task_name||t.display_name||'');
  const stOf=t=>String(t.status||t.state||t.task_status||t.phase||'');
  if(!tasks.length){ panel.innerHTML='<div class="dshell-muted" style="font-size:11px;padding:4px 6px;">（无任务）</div>'; panel.style.display='block'; return; }
  const ql=(q||'').toLowerCase();
  const filtered=tasks.filter(t=>{ const id=idOf(t),nm=nameOf(t); return !ql||id.toLowerCase().indexOf(ql)>=0||nm.toLowerCase().indexOf(ql)>=0; }).slice(0,200);
  let h='<div style="display:flex;align-items:center;justify-content:space-between;padding:2px 6px 4px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:2px;">'
    +'<span class="dshell-muted" style="font-size:10px;">共 '+tasks.length+' 个任务'+(q?(' · 匹配 '+filtered.length):'')+'</span>'
    +'<span data-etpickrefresh style="cursor:pointer;color:var(--dsw-alias-state-accent-primary);font-size:11px;" title="重新拉取">⟳</span></div>';
  if(!filtered.length){ h+='<div class="dshell-muted" style="font-size:11px;padding:4px 6px;">无匹配</div>'; }
  else{
    h+=filtered.map(t=>{
      const id=idOf(t),nm=nameOf(t),st=stOf(t);
      const sel=(s.evaltokens&&s.evaltokens.taskId===id);
      return '<div data-etpick-item="'+esc(id||nm)+'" style="padding:3px 8px;cursor:pointer;border-radius:5px;font-size:12px;'+(sel?'color:var(--dsw-alias-state-accent-primary);font-weight:600;':'')+'">'+esc(id||nm)+' — '+esc(nm||id)+(st?(' ['+esc(st)+']'):'')+'</div>';
    }).join('');
  }
  panel.innerHTML=h; panel.style.display='block';
  panel.querySelectorAll('[data-etpick-item]').forEach(el=>el.addEventListener('click', ()=>{
    const v=el.getAttribute('data-etpick-item'); const t=tasks.find(x=>idOf(x)===v||nameOf(x)===v); if(!t) return;
    if(!s.evaltokens) s.evaltokens=Object.assign(evaltokensStageConfig(null),{params:[]});
    if(idOf(t)!==s.evaltokens.taskId) s.evaltokens.values={};   /* 换选其他任务：原任务的已设参数值不再适用，一并清空 */
    s.evaltokens.taskId=idOf(t); s.evaltokens.taskName=nameOf(t);
    s.evaltokens.params=detectEvaltokTaskParams(t);   /* 选中任务后自动识别其输入参数（已设置的值保留） */
    panel.style.display='none';
    renderStageActionRow(i); renderStageParams(i);
  }));
  const rb=panel.querySelector('[data-etpickrefresh]'); if(rb) rb.addEventListener('click', ()=>{ evaltokTasksCache={tasks:null,ts:0}; openEvaltokPicker(i); });
}
/* EvalTokens 阶段运行：匹配 taskId（优先；未命中则把所填值当名称匹配）或 taskName，启动一次新 run，
   再按启动响应的 run_id 等待终态；/run 调用本身覆盖整个任务时长（服务端同步执行时跑完才返回，代连超时按
   阶段超时/24h 兜底传入，见 startTimeoutMs），拿到 run_id 后首轮轮询即确认终态；捕获运行字段为输出变量并附
   「查看报告」链接；阶段超时/中止/迟回守卫与 runUrlStep 同规则 */
async function runEvaltokensStep(rc, i){
  const stg=rc.stages; const s=stg[i]; const et=s.evaltokens||{};
  const attempt=(s._evaltokAttempt||0)+1; s._evaltokAttempt=attempt;   // 识别同一阶段的失败重试，防止旧报告回调污染新一次执行
  /* 任务 ID/名称支持 ${VAR} 引用上游阶段产出变量（如前序脚本输出 TASK_ID=xxx 后此处填 ${TASK_ID}）：
     运行时用 substRunVars 从 rc.vars（上游变量同名优先）+ 运行级注入变量（TARGET_IP/IMAGE_NAME/ARCHIVE_DIR
     等）替换后再匹配任务；未定义的单个 ${VAR} 引用按空值处理（空 taskId+空 taskName → 抛「未选择 EvalTokens
     任务」）。与脚本阶段参数值 ${VAR} 替换同一套规则（见 substRunVars）；编辑器内的 taskId/taskName 仍按字面值
     用于任务选择面板与输入参数自动识别，不做运行时替换。 */
  const taskId=substRunVars(String(et.taskId||''), rc).trim(); const taskName=substRunVars(String(et.taskName||''), rc).trim(); const outSpec=et.outVars||'';
  /* 任务输入参数覆盖：编辑器显式设置的值（et.values，随流水线持久化）随 run 启动请求体 {input:{...}} 下发；
     值支持 ${VAR} 引用上游产出/运行级变量（与 taskId 同一套 substRunVars 规则），替换后为空（含未定义引用）的不下发 */
  const inputOverrides={};
  Object.keys(et.values||{}).forEach(k=>{ const v=substRunVars(String(et.values[k]), rc); if(v!=='') inputOverrides[k]=v; });
  const tk=rc.token; const varsIn=Object.assign({},rc.vars||{});
  const label='EvalTokens · '+(taskName||taskId||'未命名');
  rc.nodes[s.id]={status:'running',progress:0,dur:0,sub:{},script:label,varsIn:varsIn,varsOut:{},startedAt:Date.now()};
  runSetSel(rc,s.id); rcRender(rc,true);
  const t0=Date.now(); const deadline=s.timeout?t0+s.timeout*1000:0; let lastLive=0, deadlineTimer=null, startAbortTimer=null, timedOut=false, waitingRunId='', waitingStatus='', service=null, externalRunActive=false;
  const ctrl=new AbortController(); rc.scriptAbort=ctrl;   // 复用运行级中止句柄：停止/重置按钮可取消 EvalTokens 网络请求
  const startCtrl=new AbortController();   // 启动请求已发出后保留到取得 run_id；终止/超时先给响应 10s 清理宽限，再硬中断
  const scheduleStartAbort=function(){
    if(startAbortTimer===null&&!startCtrl.signal.aborted) startAbortTimer=setTimeout(function(){ startCtrl.abort(); },10000);
  };
  ctrl.signal.addEventListener('abort',scheduleStartAbort,{once:true});
  const timeoutMessage=()=> 'EvalTokens 任务等待超时（阶段超时 '+secToMinInput(s.timeout)+' 分钟'+(waitingRunId?('，run '+waitingRunId+' 仍为 '+(waitingStatus||'未知状态')):'')+'）';
  const ensureActive=()=>{
    if(rc.over||rc.token!==tk) return false;
    if(timedOut||(deadline&&Date.now()>=deadline)){ timedOut=true; if(!ctrl.signal.aborted) ctrl.abort(); throw new Error(timeoutMessage()); }
    return true;
  };
  if(deadline) deadlineTimer=setTimeout(function(){ timedOut=true; if(!ctrl.signal.aborted) ctrl.abort(); },Math.max(0,deadline-Date.now()));
  if(rc.timer) clearInterval(rc.timer);
  /* 进度推进并入全局共享 tick（stageTickRun，全页面唯一 500ms interval，不再每阶段各起定时器）；
     rc.timer 改存进度任务键作在途标记（既有 clearInterval/rc.timer=null 收尾路径语义不变） */
  const _tick=globalThis.__pipelineStageTick||(globalThis.__pipelineStageTick={tasks:{},seq:0,timer:null});
  Object.keys(_tick.tasks).forEach(function(_k){ const _t=_tick.tasks[_k]; if(_t.rc===rc&&_t.stageId===s.id) delete _tick.tasks[_k]; });   // 同运行同阶段重注册去重（中止/重置后立即重试等）
  rc.timer='st'+(++_tick.seq)+'-'+s.id;
  _tick.tasks[rc.timer]={rc:rc,stageId:s.id,t0:t0,last:t0,rate:1/1000};   // 节奏同原 1000ms 定时器（每 tick +1）
  if(!_tick.timer&&!(typeof document!=='undefined'&&document.hidden)) _tick.timer=setInterval(function(){ if(typeof stageTickRun==='function') stageTickRun(); else { clearInterval(_tick.timer); _tick.timer=null; _tick.tasks={}; } },500);   // 页面隐藏时不起表（恢复可见时 visibilitychange 立即补 tick 再走表）；沙盒未抽取 stageTickRun 时自毁防空转
  const logSink=createClientStageLogSink(s,rc,stageSeq(rc.stages,i),s.name);
  const log=createLiveLog('$ EvalTokens run '+(taskId||taskName||''),logSink), outputProbe=createOutputProbe(outSpec);
  /* abortRun 可能在任一轮 await 期间收尾；服务端 sink 保存全文，阶段仅挂有界尾窗供失败兜底。 */
  s._archiveOutputParts=log.parts; s._archiveStdout=null;
  try{
    if(!taskId && !taskName) throw new Error('未选择 EvalTokens 任务');
    const e=(typeof runEvaltokCfg==='function')?runEvaltokCfg(rc):evaltokConfig(); service=e; if(!e.url) throw new Error('EvalTokens 服务地址未配置（请在「设置」页配置）');
    const idOf=t=>String(t.id||t.task_id||t.uuid||t._id||'');
    const nameOf=t=>String(t.name||t.title||t.task_name||t.display_name||'');
    /* 每次运行都向服务核验任务：兼容手填名称、${VAR} 解析出的名称，以及编辑器旧数据中残留的 taskName。 */
    const tasks=await evaltokFetchTasks(e, ctrl.signal); if(!ensureActive()) return;
    const task=(taskId?tasks.find(t=>idOf(t)===taskId):null) || (taskId?tasks.find(t=>nameOf(t)===taskId):null) || (taskName?tasks.find(t=>nameOf(t)===taskName):null) || null;
    if(!task) throw new Error('未在 EvalTokens 服务找到匹配任务：'+(taskId||('"'+taskName+'"'))+'（可能已删除，请核对任务 ID/名称）');
    const resolvedTaskId=idOf(task), resolvedTaskName=nameOf(task)||taskName;
    if(!resolvedTaskId) throw new Error('匹配的 EvalTokens 任务缺少 task_id，无法启动');
    appendLiveLog(log,'# service: '+e.url.replace(/\/+$/,'')+'/api/open/v1/tasks/'+encodeURIComponent(resolvedTaskId)+'/run  mode='+(e.mode==='remote'?'remote':'local'));
    if(Object.keys(inputOverrides).length) appendLiveLog(log,'# input: '+JSON.stringify(inputOverrides));
    s._out=liveOutputSnapshot(log.live,{code:null,evaltokens:true,done:false}); rcRender(rc);
    /* /run 同步等待整个任务时长：超时取阶段超时（留空按 24h 兜底），另加 30s 宽限让阶段自身超时
       （deadlineTimer）先于代理超时生效，保证超时文案与清理路径不变；代理侧硬上限 24h，只兜
       「服务彻底假死」的极端情况，阶段超时留空即等效不限时。 */
    const startTimeoutMs=Math.min((s.timeout?s.timeout*1000:24*60*60*1000)+30000, 24*60*60*1000);
    const started=await evaltokStartRun(e, resolvedTaskId, startCtrl.signal, inputOverrides, startTimeoutMs);
    const runId=String(started.run_id||'');
    waitingRunId=runId; waitingStatus=String(started.status||started.state||started.phase||''); externalRunActive=true;
    if(!ensureActive()) return;
    appendLiveLog(log,'# started run '+runId+' task='+resolvedTaskId+(resolvedTaskName?(' '+resolvedTaskName):''));
    let run=started, result=null;
    /* 完成状态轮询优先经服务端 stage-poll 长轮询（终态判定与上游连败兜底在服务端，浏览器只循环调端点）；
       首选轻量状态端点 /runs/<runId>/status（只回 id/status/时间戳，无 config/error 膨胀）；
       旧版 evalscope 无该端点（404）时自动回退列表端点 /runs?task_id=（带全量 error 字段）；
       404（旧 dsh 无 stage-poll 路由）/403（目标非内网）时回退 evaltokFetchRuns 直连轮询。 */
    let pollVia='server';
    const statusPollUrl=(e.url||'').replace(/\/+$/,'')+'/api/open/v1/tasks/runs/'+encodeURIComponent(runId)+'/status';
    const runsListUrl=(e.url||'').replace(/\/+$/,'')+'/api/open/v1/tasks/runs?task_id='+encodeURIComponent(resolvedTaskId);
    let pollUrl=statusPollUrl;   // 当前轮询目标（statusEndpointMissing 后切到 runsListUrl）
    const stagePollEvaltokens=async()=>{   // 返回响应对象；返回 null 表示已回退直连
      try{ return await stagePollRequest(STAGE_POLL_EVALTOKENS_PATH,{url:pollUrl, headers:evaltokHeaders(e), runId:runId},ctrl.signal); }
      catch(err){
        if(err&&err.stagePollFallback&&pollVia==='server'){
          pollVia='direct';
          console.warn('[pipeline] EvalTokens 阶段轮询回退浏览器直连：stage-poll HTTP '+err.stagePollFallback);
          appendLiveLog(log,'# stage-poll 服务端轮询不可用（HTTP '+err.stagePollFallback+'），回退浏览器直连轮询');
          s._out=liveOutputSnapshot(log.live,{code:null,evaltokens:true,done:false}); lastLive=maybeRenderLiveDetail(rc,s,lastLive,1000);
          return null;
        }
        throw err;
      }
    };
    while(pollVia==='server'){
      const pr=await stagePollEvaltokens();
      if(!pr) break;   // 已回退浏览器直连：转下方直连轮询
      if(!ensureActive()) return;
      /* 旧版 evalscope 无轻量状态端点：切换到列表端点继续轮询 */
      if(pr.done===true&&pr.statusEndpointMissing&&pollUrl===statusPollUrl){
        pollUrl=runsListUrl;
        appendLiveLog(log,'# 轻量状态端点不可用（旧版 evalscope），切换到 runs 列表端点轮询');
        s._out=liveOutputSnapshot(log.live,{code:null,evaltokens:true,done:false}); lastLive=maybeRenderLiveDetail(rc,s,lastLive,1000);
        continue;
      }
      const st=String(pr.status||'running');   // 窗口耗尽的 {done:false} 不带 status：按运行中处理
      waitingStatus=st;
      const fails=Number(pr.failures)||0;
      appendLiveLog(log,'# run '+runId+' status='+st+(fails?('（连续失败 '+fails+' 次）'):''));
      s._out=liveOutputSnapshot(log.live,{code:null,evaltokens:true,done:false}); lastLive=maybeRenderLiveDetail(rc,s,lastLive,1000);
      if(logSink) await logSink.flush();   // 归档网络慢时在轮询点施加背压，不让待写状态行 Promise 无界堆积
      if(!ensureActive()) return;
      if(pr.done===true){
        if(pr.failed) throw new Error('EvalTokens 状态轮询持续失败（服务端持续失败约 '+Math.round((Number(pr.failures)||0)*3/60)+' 分钟，已兜底判败）');
        if(pr.run&&typeof pr.run==='object') run=pr.run;
        const sk=evaltokStatusKind(st);   // 服务端终态 kind 与 evaltokStatusKind 同口径，这里再归一化兜底
        if(sk==='running') throw new Error('stage-poll 终态响应状态非法：'+(st||'（空）'));
        result=sk; externalRunActive=false; break;
      }
      /* done:false：服务端长轮询窗口耗尽未到终态，立即续发下一次（等待窗口由服务端持有，本地不再 sleep） */
    }
    while(pollVia==='direct'){
      const runs=await evaltokFetchRuns(e, resolvedTaskId, ctrl.signal); if(!ensureActive()) return;
      const current=runs.find(r=>String(r.run_id||r.id||'')===runId) || null;
      if(current) run=current;
      const st=current?String(run.status||run.state||run.phase||''):'';
      waitingStatus=st;
      const sk=current?evaltokStatusKind(st):'running';
      appendLiveLog(log,'# run '+runId+' status='+(current?st:'（等待运行记录）'));
      s._out=liveOutputSnapshot(log.live,{code:null,evaltokens:true,done:false}); lastLive=maybeRenderLiveDetail(rc,s,lastLive,1000);
      if(logSink) await logSink.flush();   // 归档网络慢时在轮询点施加背压，不让待写状态行 Promise 无界堆积
      if(!ensureActive()) return;
      if(sk!=='running'){ result=sk; externalRunActive=false; break; }
      await new Promise(function(resolve){
        let done=false, h=null;
        const stop=function(){ if(done) return; done=true; if(h!==null) clearTimeout(h); ctrl.signal.removeEventListener('abort',stop); resolve(); };
        h=setTimeout(stop,3000); if(!done){ if(ctrl.signal.aborted) stop(); else ctrl.signal.addEventListener('abort',stop,{once:true}); }
      });
      if(!ensureActive()) return;   // 中止立即唤醒轮询等待；迟回直接丢弃（与 runUrlStep 同规则）
    }
    if(rc.over||rc.token!==tk) return;
    if(rc.timer){clearInterval(rc.timer);rc.timer=null;}
    /* 运行对象规整成单行 JSON 喂给 parseStageVars/parseStageJson（与 HTTP 阶段响应体规则一致） */
    let bodyFull=''; try{ const o=JSON.parse(JSON.stringify(run)); if(o&&typeof o==='object') bodyFull=JSON.stringify(o); }catch(_){ bodyFull=String(run); }
    let bodyShow=bodyFull; if(bodyShow.length>65536) bodyShow=bodyShow.slice(0,65536)+'…(截断，仅展示；变量捕获用完整运行对象)';
    const ok=(result==='success');
    appendOutputProbe(outputProbe,bodyFull); const probed=finishOutputProbe(outputProbe);
    appendLiveLog(log,bodyShow,bodyFull);
    if(probed.fullTextOverflow) appendLiveLog(log,'[warn] 运行对象全文超过 128KiB，已跳过「*=全文」输出变量；请改用 KEY=VALUE 或 JSON 路径截取所需字段');
    appendLiveLog(log,'[EvalTokens result '+result+']');
    appendLiveLog(log,'📊 任务报告（EvalTokens 服务）→ '+evaltokReportUrl(e,runId));
    const reportFolder=(et.collectReport!==false)?archiveFolderFor(rc):null;
    const seq=stageSeq(rc.stages,i);
    const reportPendingLine=reportFolder?('📦 任务报告归档中 → '+reportFolder+'/'+evaltokReportFile(rc,seq,s.name,runId)):'⚠ 任务报告未归档：无法确定本次运行归档目录';
    if(et.collectReport!==false) appendLiveLog(log,reportPendingLine);
    /* 节流期间可能没有新的运行中刷新；终态快照前补一次，确保最后一条轮询状态也能回显。 */
    s._out=liveOutputSnapshot(log.live,{code:null,evaltokens:true,done:false});
    const liveRoot=rc&&rc.parallelParent?rc.parallelParent:rc;
    if(viewRc===liveRoot&&selectedId===s.id) renderDetail();
    const finalStdout=finishLiveLog(log);
    const terminalOut=liveOutputSnapshot(log.live,{stderr:ok?'':('EvalTokens '+result),code:ok?0:1,evaltokens:true,done:true});
    if(logSink) await logSink.flush();
    s._archiveOutputParts=null;   // 终态改用可被报告回调更新的 terminalOut，避免保留“归档中”旧分片
    s._out=terminalOut;
    const varsOut=Object.assign({},probed.vars); rc.vars=Object.assign(rc.vars||{},varsOut);
    applyOutVars(rc, outSpec, varsOut, probed.json||parseStageJson(bodyFull||finalStdout), probed.fullText);   // 输出变量映射：运行字段改名/JSON 路径；全文只在 128KiB 安全上限内保留
    const dur=(Date.now()-t0)/1000;
    const finalNode=Object.assign({}, rc.nodes[s.id], {status:ok?'success':'failed',progress:100,dur:dur,sub:{},script:label,varsIn:varsIn,varsOut:varsOut});
    let reportJob=null;
    if(et.collectReport!==false){
      const reportState={attempt:attempt,logFile:null};
      s._reportArchiveState=reportState;
      s._reportPendingAttempt=attempt;   // archiveRun 不抢先写尚未补齐报告结果的阶段日志
      const replaceReportLine=function(text){
        if(terminalOut.stdout) terminalOut.stdout=terminalOut.stdout.replace(reportPendingLine,text);
        if(logSink) logSink.append('\n'+text);
        const root=rc&&rc.parallelParent?rc.parallelParent:rc;
        if(s._evaltokAttempt===attempt&&s._out===terminalOut&&viewRc===root&&selectedId===s.id) renderDetail();
      };
      reportJob=archiveEvaltokensReport(e,rc,seq,s.name,runId).then(file=>{
        replaceReportLine(file?('📦 任务报告已归档 → '+file):'⚠ 任务报告未归档：无法确定本次运行归档目录');
      },reportErr=>{
        const msg=String(reportErr&&reportErr.message?reportErr.message:reportErr);
        replaceReportLine('⚠ 任务报告归档失败（不影响任务结果）：'+msg);
        console.warn('[archive] EvalTokens 任务报告归档失败（不影响任务结果）:', reportErr);
      }).then(async()=>{
        if(s._evaltokAttempt!==attempt) return;   // 已开始新一次尝试：旧 run 仅保留独立 HTML 报告，不覆写新阶段日志/标记
        try{
          if(logSink&&await logSink.flush()){
            reportState.logFile=logSink.file; s._logArchived=true; return;
          }
          const logStage=Object.assign({},s,{_out:terminalOut});
          const parts=buildLogParts(logStage,rc,finalNode)||[];
          const logFile=await archiveTaskLog(rc,seq,s.name,parts);
          reportState.logFile=logFile||null;
          if(logFile&&s._evaltokAttempt===attempt) s._logArchived=true;
        }catch(logErr){ console.warn('[archive] EvalTokens 阶段日志归档失败（不影响任务结果）:', logErr); }
      }).finally(()=>{
        if(s._evaltokAttempt===attempt&&s._reportPendingAttempt===attempt) s._reportPendingAttempt=null;
      });
      if(!rc.evaltokensReportWrites) rc.evaltokensReportWrites=[];
      rc.evaltokensReportWrites.push(reportJob);   // archiveRun 的汇总文件/归档脚本等待报告及本阶段日志收尾
    }
    rc.nodes[s.id]=finalNode;
    if(!reportJob) archiveStageLog(s,seq,rc);
    rcRender(rc);
    if(ok) advance(rc,i+1); else finish(rc,'failed');
  }catch(e){
    if(rc.over||rc.token!==tk) return;   // 迟回异常：不得覆盖节点状态、不得对旧阶段再 finish
    if(rc.timer){clearInterval(rc.timer);rc.timer=null;}
    const msg=timedOut?timeoutMessage():String(e&&e.message?e.message:e);
    appendLiveLog(log,'✗ '+msg);
    s._out=liveOutputSnapshot(log.live,{stderr:msg,code:1,evaltokens:true,done:true});
    if(logSink) await logSink.flush();
    s._archiveOutputParts=null;   // 正常异常收尾已由 sink 落盘；失败时 archiveStageLog 以页面尾窗兜底
    archiveStageLog(s, stageSeq(rc.stages,i), rc);   // 异常路径同样归档本阶段已产生的回显
    rc.nodes[s.id]=Object.assign({}, rc.nodes[s.id], {status:'failed',progress:100,dur:(Date.now()-t0)/1000,sub:{},script:label,varsIn:varsIn,varsOut:{}});
    rcRender(rc); finish(rc,'failed');
  }finally{
    if(deadlineTimer!==null) clearTimeout(deadlineTimer);
    ctrl.signal.removeEventListener('abort',scheduleStartAbort);
    if(startAbortTimer!==null) clearTimeout(startAbortTimer);
    if(!startCtrl.signal.aborted) startCtrl.abort();
    if(ctrl.signal.aborted&&externalRunActive&&service&&waitingRunId){
      if(rc._cascadeAbort){
        /* 并行组内兄弟阶段失败被连带中止：并非用户终止/超时，已启动的 EvalTokens run 保留在服务侧继续运行（结果可在服务报告页查看） */
        appendLiveLog(log,'# 并行组内其他阶段失败，本阶段被连带中止；EvalTokens run '+waitingRunId+' 未停止，仍在服务侧运行 → '+evaltokReportUrl(service,waitingRunId));
        s._out=liveOutputSnapshot(log.live,{code:null,evaltokens:true,done:true}); if(logSink) await logSink.flush();
      }else{
        try{ await evaltokStopRun(service,waitingRunId); appendLiveLog(log,'# stopped external run '+waitingRunId); if(logSink) await logSink.flush(); }
        catch(stopError){
          const stopMsg='EvalTokens 外部任务终止失败：'+String(stopError&&stopError.message?stopError.message:stopError);
          appendLiveLog(log,'[warn] '+stopMsg); s._out=liveOutputSnapshot(log.live,{stderr:stopMsg,code:1,evaltokens:true,done:true}); if(logSink) await logSink.flush();
          console.warn('[pipeline] '+stopMsg,stopError); try{ flashRunTip(stopMsg); }catch(e){}
        }
      }
    }
    if(rc.scriptAbort===ctrl) rc.scriptAbort=null;
  }
}
async function runScriptStep(rc, i){
  const stg=rc.stages; const s=stg[i]; const sc=s.script;
  const tk = rc.token;   // 运行令牌：await 期间若本次运行被中止/重置，下方比对丢弃迟回结果
  const varsIn = Object.assign({}, rc.vars||{});
  rc.nodes[s.id]={status:'running',progress:0,dur:0,sub:{},script:sc.name,varsIn,varsOut:{},startedAt:Date.now()};
  runSetSel(rc,s.id); rcRender(rc,true);
  const t0=Date.now();
  if(rc.timer) clearInterval(rc.timer);
  /* 进度推进并入全局共享 tick（stageTickRun，全页面唯一 500ms interval，不再每阶段各起定时器）；
     rc.timer 改存进度任务键作在途标记（既有 clearInterval/rc.timer=null 收尾路径语义不变） */
  const _tick=globalThis.__pipelineStageTick||(globalThis.__pipelineStageTick={tasks:{},seq:0,timer:null});
  Object.keys(_tick.tasks).forEach(function(_k){ const _t=_tick.tasks[_k]; if(_t.rc===rc&&_t.stageId===s.id) delete _tick.tasks[_k]; });   // 同运行同阶段重注册去重（中止/重置后立即重试等）
  rc.timer='st'+(++_tick.seq)+'-'+s.id;
  _tick.tasks[rc.timer]={rc:rc,stageId:s.id,t0:t0,last:t0,rate:2/300};   // 节奏同原 300ms 定时器（每 tick +2）
  if(!_tick.timer&&!(typeof document!=='undefined'&&document.hidden)) _tick.timer=setInterval(function(){ if(typeof stageTickRun==='function') stageTickRun(); else { clearInterval(_tick.timer); _tick.timer=null; _tick.tasks={}; } },500);   // 页面隐藏时不起表（恢复可见时 visibilitychange 立即补 tick 再走表）；沙盒未抽取 stageTickRun 时自毁防空转
  /* 流式回显：执行中把 stdout/stderr 写入本阶段实时快照（s._out，code:null）并刷新「阶段详情」。
     快速输出按 ~1000ms 节流重建；选中的正是本阶段时立即刷新（进度条/耗时文本另由共享 tick 轻量直改，不经全量渲染）。
     「中止」经 AbortController 断开会话，服务端随之终止对应子进程（见 execStreaming / 插件 exec-stream 路由）；
     旧插件构建降级为一次性执行，中止后结果丢弃（流程同旧逻辑）。 */
  const ctrl=new AbortController(); rc.scriptAbort=ctrl;
  const folder=archiveFolderFor(rc), logFile=folder ? folder+'/'+taskLogFile(rc,stageSeq(rc.stages,i),s.name) : null;   // 序号走 stageSeq（预设任务固定 00、正式阶段从 01 起），与 collectRunLogs / archiveStageLog 一致
  s._serverLogPending=!!logFile; s._serverLogExpectedFile=logFile; s._serverLogFile=null; s._logArchived=false;
  const live=createLiveOutputState(), probe=createOutputProbe(sc.outVars); let lastLive=-Infinity;
  const res=await execScript(sc, (s.timeout?s.timeout*1000:0), null, rc, m=>{   // 阶段级超时（编辑器「超时(分钟)」×60 存秒）；留空=0=无超时
    if(rc.over || rc.token!==tk) return;   // 迟回片段丢弃（运行已中止/重置）
    if(m.type==='log'){ s._serverLogPending=false; s._serverLogFile=m.logFile||null; return; }   // 接管确认：中止时也不可用浏览器快照覆盖服务端日志
    appendLiveOutput(live,m.type,m.text); if(m.type==='out') appendOutputProbe(probe,m.text);
    lastLive=publishLiveOutput(rc,s,live,lastLive,1000,{code:null});   // 追加与物化分别节流，避免每个小块都 join 尾窗
  }, ctrl.signal, logFile);
  if(rc.scriptAbort===ctrl) rc.scriptAbort=null;
  if(rc.over || rc.token!==tk){ console.warn('[pipeline] 脚本「'+sc.name+'」结果已丢弃：执行期间运行被重置/中止（流式执行已随会话断开终止子进程）。'); return; }   // 先验运行状态再写共享 stage 字段：并行重试已复位的新归档所有权不能被旧子上下文迟回覆盖
  s._serverLogPending=!!res.logPending; s._serverLogFile=res.logFile||null; s._logArchived=!!res.logFile;
  if(res.logError) console.warn('[archive] 服务端阶段日志写入失败，尝试页面兜底:',res.logError);
  if(rc.timer){ clearInterval(rc.timer); rc.timer=null; }
  if(res.code===null) return;   // AbortController 中止：中止流程已按「已中止」记账，这里直接退出
  const dur=(Date.now()-t0)/1000;
  if(!probe.seen && res.stdout) appendOutputProbe(probe,res.stdout);   // 旧插件一次性 /exec 兼容路径
  const probed=finishOutputProbe(probe), finalResult=boundedExecutionResult(res);
  if(probed.fullTextOverflow){
    const warning='[warn] stdout 全文超过 128KiB，已跳过「*=全文」输出变量；请改用 KEY=VALUE 或 JSON 路径截取所需字段';
    const errLive=createLiveOutputState(); appendLiveOutput(errLive,'err',finalResult.stderr||''); appendLiveOutput(errLive,'err',(finalResult.stderr?'\n':'')+warning);
    const errSnapshot=liveOutputSnapshot(errLive);
    finalResult.stderr=errSnapshot.stderr; finalResult._stderrTruncated=!!finalResult._stderrTruncated||errSnapshot._stderrTruncated;
  }
  s._out=finalResult;
  const varsOut=Object.assign({},probed.vars); rc.vars=Object.assign(rc.vars||{},varsOut);
  applyOutVars(rc, sc.outVars, varsOut, probed.json, probed.fullText);   // 变量在流到达时提取；超大全文不驻留浏览器，仅保留 KEY=VALUE / JSON 路径结果
  archiveStageLog(s, stageSeq(rc.stages,i), rc);   // 本阶段回显即时重定向到归档文件夹的独立日志文件
  if(res.code===0){ rc.nodes[s.id]=Object.assign({}, rc.nodes[s.id], {status:'success',progress:100,dur,sub:{},script:sc.name,varsIn,varsOut}); rcRender(rc); advance(rc,i+1); }
  else { rc.nodes[s.id]=Object.assign({}, rc.nodes[s.id], {status:'failed',progress:100,dur,sub:{},script:sc.name,varsIn,varsOut}); rcRender(rc); finish(rc,'failed'); }
}
function runStage(rc, i){
  const stg = rc.stages;
  if(i>=stg.length){ finish(rc,'success'); return; }
  const s=stg[i];
  const varsIn = Object.assign({}, rc.vars||{});
  rc.nodes[s.id]={status:'running',progress:0,dur:0,sub:{},varsIn,varsOut:{},startedAt:Date.now()};
  const root=rc&&rc.parallelParent?rc.parallelParent:rc;
  runSetSel(rc,s.id); if(viewRc===root){ renderFlow(); renderDetail(); }
  if(s.sub && s.sub.length){ s.sub.forEach(x=> rc.nodes[s.id].sub[x]='running'); }
  const start=Date.now();
  if(rc.timer) clearInterval(rc.timer);
  const total=Math.max(0,s.dur||0)*1000;
  if(total<=0){   /* 耗时 0=不设置：本地模拟不等待，运行即结束（归档/渲染与计时路径一致） */
    if(s.sub && s.sub.length){ s.sub.forEach(x=>{ rc.nodes[s.id].sub[x]='success'; }); }
    rc.nodes[s.id].status='success'; rc.nodes[s.id].progress=100;
    archiveStageLog(s, stageSeq(rc.stages,i), rc);
    rcRender(rc);
    advance(rc,i+1);
    return;
  }
  /* 本地模拟阶段的按耗时推进并入全局共享 tick：stageTickRun 按真实经过时间推进进度/子阶段翻牌/到点收尾推进，
     语义同原 120ms 定时器，不再单独起 interval；rc.timer 存进度任务键作在途标记 */
  const _tick=globalThis.__pipelineStageTick||(globalThis.__pipelineStageTick={tasks:{},seq:0,timer:null});
  Object.keys(_tick.tasks).forEach(function(_k){ const _t=_tick.tasks[_k]; if(_t.rc===rc&&_t.stageId===s.id) delete _tick.tasks[_k]; });   // 同运行同阶段重注册去重（中止/重置后立即重试等）
  rc.timer='st'+(++_tick.seq)+'-'+s.id;
  _tick.tasks[rc.timer]={rc:rc,stageId:s.id,sim:{start:start,total:total,subs:s.sub,index:i,stage:s,bucket:-1}};
  if(!_tick.timer&&!(typeof document!=='undefined'&&document.hidden)) _tick.timer=setInterval(function(){ if(typeof stageTickRun==='function') stageTickRun(); else { clearInterval(_tick.timer); _tick.timer=null; _tick.tasks={}; } },500);   // 页面隐藏时不起表（恢复可见时 visibilitychange 立即补 tick 再走表）；沙盒未抽取 stageTickRun 时自毁防空转
}
/* 「不执行」阶段：直接标记跳过（记入历史与归档，日志为跳过说明），推进到下一阶段 */
function skipStage(rc, i){
  const stg = rc.stages;
  const s=stg[i];
  const varsIn = Object.assign({}, rc.vars||{});
  rc.nodes[s.id]={status:'skipped',progress:100,dur:0,sub:{},varsIn,varsOut:{}};
  runSetSel(rc,s.id); rcRender(rc,true);
  archiveStageLog(s, stageSeq(rc.stages,i), rc);
  advance(rc,i+1);
}
/* 从失败阶段重试：保留本次运行上下文（commit/tag/环境），变量回滚到该阶段入口后从该阶段继续。
   重试前校验机器占用：该运行结束后其机器可能已被并行运行占去，冲突时拦截（可等占用结束后重试） */
function retryFromStage(stageId){
  const rc=viewRc;
  if(!rc || !rc.over) return;   // 仅「编排区展示的已结束运行」可重试（按钮也只在此态出现）
  const clickedIdx=rc.stages.findIndex(x=>x.id===stageId); if(clickedIdx<0) return;
  const failedNode=rc.nodes[stageId]; if(!failedNode || failedNode.status!=='failed') return;
  if(activeRuns.length>=MAX_ACTIVE_RUNS){ flashRunTip('当前已占满 '+MAX_ACTIVE_RUNS+' 个并发槽位，请等待一条运行结束后重试'); return; }
  if(conflictsActive(rc)){ flashRunTip('目标机器正被其他运行占用，暂不能重试（可等其完成后再试）'); return; }
  const group=pipelineStageGroupAt(rc.stages,clickedIdx);
  const retryGroup=!!(group&&group.parallel&&group.end-group.start>1), idx=retryGroup?group.start:clickedIdx;
  const entryNode=rc.nodes[rc.stages[idx].id];
  rc.vars=Object.assign({},(entryNode&&entryNode.varsIn)||{});
  if(retryGroup){
    for(let j=idx;j<rc.stages.length;j++){
      const stage=rc.stages[j], oldNode=rc.nodes[stage.id];
      stage._out=null; stage._archiveStdout=null; stage._archiveOutputParts=null;
      stage._logArchived=false; stage._serverLogPending=false; stage._serverLogFile=null;
      stage._promT0=null; stage._promT1=null; stage._promCollected=false; stage._promGroupCollected=false;
      rc.nodes[stage.id]={status:'idle',progress:0,dur:0,sub:{},varsIn:(oldNode&&oldNode.varsIn)||{},varsOut:{}};
    }
  }else{
    rc.stages[idx]._out=null; rc.stages[idx]._archiveStdout=null;
    for(let j=idx;j<rc.stages.length;j++){ rc.stages[j]._logArchived=false; rc.stages[j]._promT0=null; rc.stages[j]._promT1=null; rc.stages[j]._promCollected=false; rc.stages[j]._promGroupCollected=false; if(j>idx) rc.stages[j]._archiveStdout=null; const oldNode=rc.nodes[rc.stages[j].id]; rc.nodes[rc.stages[j].id]={status:'idle',progress:0,dur:0,sub:{},varsIn:(oldNode&&oldNode.varsIn)||{},varsOut:{}}; }
  }   // 并行组重试清空整组及下游运行态；串行阶段保持原有重试清理范围
  rc.over=false;
  activeRuns.push(rc); syncRunState();
  rcOverall(rc,'运行中…（重试）','dshell-badgeWait');
  runSetSel(rc,rc.stages[idx].id); rcRender(rc);
  advance(rc,idx);
}
/* 运行历史 envNodes 字段（与服务端写入契约一致）：由运行上下文选中节点映射为 {name,ip,nodeIp}，
   name 与 ip 均为空的条目丢弃、最多 50 条，绝不含 user/pass 等凭据；无选中节点时为空数组。
   与 rec.env（中文逗号 IP 串，enterHistoryReplay/rerunFromHistory 依赖其回填环境）互补，互不改写。 */
/* 运行启动即写入运行历史（status:'running'，展示「进行中」）：点「运行流水线」后历史立刻有记录，
   不必等运行结束。finish 按 tag 原地更新为终态；重置（disposeRunForReset）撤回本条不计入历史。
   终态前 logs/prom 尚不齐全，回放会显示空日志；点击该行优先切回实时编排视图（见 renderHistory）。 */
function beginRunHistory(rc){
  if(!rc || !rc.tag) return null;
  const exists=history.find(h=>h&&h.tag===rc.tag);
  if(exists) return exists;
  buildNo++;
  const rec={no:buildNo, pipeline:rc.pipelineName||curPipeline().name, env:rc.env, commit:(rc.commit||'').slice(0,7),
    status:'running', dur:'0s', time:'今天 '+nowHM(), ts:Date.now(), startTs:rc.startTs||Date.now(), by:rc.by||'anonymous',
    pipelineId:rc.pipelineId||null, repoId:rc.repoId||null, branch:rc.branch||'main', strategy:rc.strategy||'', weightsPath:rc.weightsPath||'',
    envNodes: historyEnvNodesOf(rc), prom:null, logs:[], tag:rc.tag, archive:archiveFolderFor(rc)};
  history.unshift(rec); if(history.length>500) history.length=500;
  histPage=0; selHistoryIdx=0;
  renderHistory(); renderStats();
  persistState();
  return rec;
}
function historyEnvNodesOf(rc){
  const envs=(rc && rc.envs) || [];
  const out=[];
  for(let i=0;i<envs.length && out.length<50;i++){
    const e=envs[i]||{};
    const item={name:String(e.name||''), ip:String(e.ip||''), nodeIp:String(e.nodeIp||'')};
    if(!item.name && !item.ip) continue;
    out.push(item);
  }
  return out;
}
function finish(rc, result){
  if(rc&&rc.parallelParent){ settleParallelStage(rc,result); return; }
  rc.over=true;
  try{ taskPromFinalize(rc); }catch(e){ console.warn('[pipeline] 任务级普罗采集触发异常（已兜底，不阻断收尾）:', e); }   // 失败阶段（成功路径已在 advance 触发）勾选「收集普罗数据」时按任务起止采集
  if(rc.timer){ clearInterval(rc.timer); rc.timer=null; }
  if(rc.leaseTimer){ clearInterval(rc.leaseTimer); rc.leaseTimer=null; }
  if(rc.leaseId){ releaseNodeLease(rc.leaseId, rc.leaseIps); rc.leaseId=null; }   // 释放节点租约：等待同节点的排队任务（含他端）随即可启动
  /* 后缀休眠计划从未激活（本地阶段失败/中止/重置）：清掉定时页占位，避免永不触发的残留计划 */
  if(rc.suffixPlanHeld && typeof discardHeldSuffixPlan==='function'){ try{ discardHeldSuffixPlan(rc); }catch(e){} }
  activeRuns=activeRuns.filter(r=>r!==rc);
  /* 正常终态化登记（完成/中止都经 finish）：条目从在场快照消失属正常，上报 completed 豁免孤儿判定。
     typeof 守卫：extractFn 抽取 finish 的测试沙盒无此函数时按旧行为运行 */
  if(typeof queueFinishedNote==='function'){ queueFinishedNote(rc&&rc.id); if(rc&&rc.originQueueId) queueFinishedNote(rc.originQueueId); }
  syncRunState();
  /* 收尾（徽标 / 历史 / 统计 / 持久化 / 归档 / 详情）尽力而为：任一步异常都不得跳过下方的
     drainQueue()——否则排队任务会卡在「待启动」永远不跑（renderQueue 自愈仅在此处确实调到时才兜底）。
     buildLog 等同步步骤在此前未被 try 包裹（archiveStageLog 内部已包），故这里统一兜底。 */
  try{
    refreshArchiveTip();   // 运行结束：目标回退到历史选中行（未选中则提示选择，不再回退本次运行归档）
    const elapsed=(Date.now()-rc.startTs)/1000;
    if(result==='success'){ rcOverall(rc,'✓ 已完成','dshell-badgeDone'); }
    else if(result==='aborted'){ rcOverall(rc,'⏏ 终止','','var(--st-idle)'); }   // 与运行历史行/阶段徽标同色（灰）
    else { rcOverall(rc,'✗ 错误','','var(--st-err)'); }
    const status=result==='success'?'success':(result==='aborted'?'aborted':'failed');
    const rec={pipeline:rc.pipelineName||curPipeline().name, env:rc.env, commit:rc.commit.slice(0,7),
      status,
      dur: fmtDur(elapsed), time:'今天 '+nowHM(), ts:Date.now(), startTs:rc.startTs, by:rc.by||'anonymous',
      pipelineId:rc.pipelineId||null, repoId:rc.repoId||null, branch:rc.branch||'main', strategy:rc.strategy||'', weightsPath:rc.weightsPath||'', source:'local',
      envNodes: historyEnvNodesOf(rc),   // 选中环境节点快照（不含凭据；rec.env 保持中文逗号 IP 串不回填改写）
      prom: promSnapshotForRun(rc),
      logs: collectRunLogs(rc),   // 预设任务已随阶段列表展开进执行序列（expandRunStages），日志与阶段一并收集；本地执行阶段带 local:true
      tag:rc.tag, archive:archiveFolderFor(rc)};
    /* 混合编排（本地前缀 + 定时后缀）历史只留一条：本条先承载本地部分（本地执行阶段带 local:true），
       移交成功后由 markHistorySuffixRunning 保持「进行中」，服务端后缀写同 tag 记录落终态并补齐
       后缀阶段（按阶段名并集合并，记录身份保留本条）；关页时在跑运行经 fail-run 路由把同 tag 的
       「进行中」记录原地终态化为失败。无同 tag 走新增兜底。 */
    const existing=rec.tag?history.find(h=>h&&h.tag===rec.tag):null;
    if(existing){
      rec.no=existing.no;
      const prevLogs=Array.isArray(existing.logs)?existing.logs:[];
      const nextLogs=Array.isArray(rec.logs)?rec.logs:[];
      Object.assign(existing, rec);
      existing.logs=mergeStageLogsForHistory(prevLogs, nextLogs);
      selHistoryIdx=history.indexOf(existing);   // 选中本次运行（仅选中不进入回放，保持本次运行的实时编排/详情视图）
    }else{
      buildNo++;
      rec.no=buildNo;
      history.unshift(rec); if(history.length>500) history.length=500;   // 条数上限与服务端一致（服务端 PUT 合并会保留页面未知的记录，页面别再按 200 截）
      histPage=0;
      selHistoryIdx=0;   // 运行完成：自然选中运行历史第一条（本次运行，仅选中不进入回放，保持本次运行的实时编排/详情视图），便于直接对选中行做分析/收集普罗/打开归档
    }
    renderHistory(); renderStats();
    refreshArchiveTip();   // 归档目录目标跟随刚选中的本次运行记录刷新
    persistState();
    archiveRun(rc, result);
    if(viewRc===rc) renderDetail();   // 本运行已结束：失败阶段补出「从本阶段重试」按钮
  }catch(e){ console.warn('[pipeline] finish 收尾异常（已兜底，不阻断队列排空）:', e); }
  try{ drainQueue(); }catch(e){ console.warn('[pipeline] 排空队列失败（交由 renderQueue 自愈兜底）:', e); }   // startRun 抛错时吞掉：被移除的该项丢弃，剩余由下方 renderQueue 自愈逐个补排
  renderQueue();
}
/* 预设任务（系统预设 + 自定义预设）：随阶段列表按编排位置执行（见 advance 分发），
   脚本为设置页配置在启动时的快照（expandRunStages → presetRuntime）；未配置脚本=跳过（不阻断）；
   block=true 的预设任务（环境检查，及勾选「失败阻断」的自定义预设）不通过（脚本非零退出）时阻断后续阶段、按失败计入历史，
   其余预设任务失败不阻断。日志随任务即时归档为 00 号任务日志（见 stageSeq） */
async function runPresetStep(rc, i){
  const stg=rc.stages; const s=stg[i]; const def=(typeof presetDefOf==='function'?presetDefOf(s.pkey):PRESET_DEF[s.pkey])||{name:s.name, block:false, noScript:'未配置「'+s.name+'」脚本'};   // 沙盒单独抽取本函数时没有 presetDefOf，退回 PRESET_DEF 直查
  const tk = rc.token;   // 运行令牌：await 期间若本次运行被中止/重置，下方比对丢弃迟回结果
  const sc=s.script;
  if(!sc || !sc.path){   // 未配置脚本：标记跳过并推进（不阻断）
    rc.nodes[s.id]={status:'skipped',progress:100,dur:0,sub:{}};
    runSetSel(rc,s.id); rcRender(rc);
    advance(rc,i+1); return;
  }
  rcOverall(rc,def.name+'中…','dshell-badgeWait');
  rc.nodes[s.id]={status:'running',progress:0,dur:0,sub:{},startedAt:Date.now()};
  runSetSel(rc,s.id); rcRender(rc,true);
  const t0=Date.now();
  if(rc.timer) clearInterval(rc.timer);
  /* 进度推进并入全局共享 tick（stageTickRun，全页面唯一 500ms interval，不再每阶段各起定时器）；
     rc.timer 改存进度任务键作在途标记（既有 clearInterval/rc.timer=null 收尾路径语义不变） */
  const _tick=globalThis.__pipelineStageTick||(globalThis.__pipelineStageTick={tasks:{},seq:0,timer:null});
  Object.keys(_tick.tasks).forEach(function(_k){ const _t=_tick.tasks[_k]; if(_t.rc===rc&&_t.stageId===s.id) delete _tick.tasks[_k]; });   // 同运行同阶段重注册去重（中止/重置后立即重试等）
  rc.timer='st'+(++_tick.seq)+'-'+s.id;
  _tick.tasks[rc.timer]={rc:rc,stageId:s.id,t0:t0,last:t0,rate:2/300};   // 节奏同原 300ms 定时器（每 tick +2）
  if(!_tick.timer&&!(typeof document!=='undefined'&&document.hidden)) _tick.timer=setInterval(function(){ if(typeof stageTickRun==='function') stageTickRun(); else { clearInterval(_tick.timer); _tick.timer=null; _tick.tasks={}; } },500);   // 页面隐藏时不起表（恢复可见时 visibilitychange 立即补 tick 再走表）；沙盒未抽取 stageTickRun 时自毁防空转
  /* 流式回显与 runScriptStep 同一套（实时快照 s._out + AbortController 断开 + 服务端日志接管确认） */
  const ctrl=new AbortController(); rc.scriptAbort=ctrl;
  const folder=archiveFolderFor(rc), logFile=folder ? folder+'/'+taskLogFile(rc,0,s.name) : null;   // 预设任务固定 00 号任务日志（文件名含任务名，互不冲突）
  s._serverLogPending=!!logFile; s._serverLogExpectedFile=logFile; s._serverLogFile=null; s._logArchived=false;
  const live=createLiveOutputState(); let lastLive=-Infinity;
  const res=await execScript(sc, 120000, null, rc, m=>{
    if(rc.over || rc.token!==tk) return;   // 迟回片段丢弃（运行已中止/重置）
    if(m.type==='log'){ s._serverLogPending=false; s._serverLogFile=m.logFile||null; return; }
    appendLiveOutput(live,m.type,m.text);
    lastLive=publishLiveOutput(rc,s,live,lastLive,1000,{code:null});   // 高频小块只在刷新时点物化尾窗
  }, ctrl.signal, logFile);
  s._serverLogPending=!!res.logPending; s._serverLogFile=res.logFile||null; s._logArchived=!!res.logFile;
  if(rc.scriptAbort===ctrl) rc.scriptAbort=null;
  if(rc.over || rc.token!==tk){ console.warn('[pipeline] 预设任务「'+sc.name+'」结果已丢弃：执行期间运行被重置/中止（流式执行已随会话断开终止子进程）。'); return; }
  if(rc.timer){ clearInterval(rc.timer); rc.timer=null; }
  if(res.code===null) return;   // AbortController 中止：中止流程已按「已中止」记账，这里直接退出
  const dur=(Date.now()-t0)/1000;
  s._out=boundedExecutionResult(res);
  archiveStageLog(s, 0, rc);   // 预设任务回显即时归档（00 号任务日志，见 stageSeq）
  if(res.code===0){
    rc.nodes[s.id]=Object.assign({}, rc.nodes[s.id], {status:'success',progress:100,dur,sub:{}});
    rcOverall(rc,'运行中…','dshell-badgeWait'); rcRender(rc); advance(rc,i+1);
  } else {
    rc.nodes[s.id]=Object.assign({}, rc.nodes[s.id], {status:'failed',progress:100,dur,sub:{}});
    rcRender(rc);
    if(def.block){   // 阻断型预设任务不通过：阻断后续阶段，按失败计入历史
      finish(rc,'failed');
      rcOverall(rc,'✗ '+def.name+'未通过','','var(--st-err)');
    } else {
      rcOverall(rc,'运行中…','dshell-badgeWait'); advance(rc,i+1);   // 清理/Profiling 失败不阻断
    }
  }
}
