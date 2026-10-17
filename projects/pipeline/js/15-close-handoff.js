/* ===== 15-close-handoff.js · 浏览器关闭：在跑任务判失败、排队条目移交服务端 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 6814–7338）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* ---------- 浏览器关闭：在跑本地任务关页即失败，排队条目移交服务端 ----------
   手动运行含「需本地运行」阶段时整条由浏览器编排（runPipeline → startSimRun → advance）。关页后
   exec-stream 随连接断开被服务端杀掉、advance 不再推进，当前任务已不可能续跑（「需本地运行」语义
   本来就是目标只保证浏览器可达，移交服务端重跑也只会报错）：pagehide 时把在跑运行直接按失败落史——
   终态记录（status=failed + 中断原因 closeError + 各阶段真实状态）经 keepalive POST 直送
   /api/worktable/pipeline/history/fail-run（卸载路径不 await），运行历史立即体现「错误」与中断原因；
   未送达（进程被杀 / 断网）时由在场 TTL 孤儿登记 + 「进行中」历史清扫判死兜底，错误同样体现在运行状态。
   排队中的本地队列条目尚未开始执行、不属于「没执行完的任务」：仍登记为「立即执行一次」的服务端计划
   移交服务端执行池继续跑完（keepalive POST 单条 upsert，不做 GET 合并，避免卸载竞态覆盖他人计划）。 */
function currentStageIndex(rc){
  if(!rc || !Array.isArray(rc.stages) || !rc.nodes) return -1;
  for(let i=0;i<rc.stages.length;i++){
    const st=rc.stages[i]; if(!st) continue;
    const n=rc.nodes[st.id];
    if(n && n.status==='running') return i;
  }
  for(let i=0;i<rc.stages.length;i++){
    const st=rc.stages[i]; if(!st) continue;
    const n=rc.nodes[st.id];
    if(!n || (n.status!=='success' && n.status!=='failed' && n.status!=='skipped' && n.status!=='aborted')) return i;
  }
  return -1;
}
/* 代码仓快照进移交计划：服务端 execPlan/runStageScript 据此注入 GIT_URL/GIT_USER/GIT_PASSWORD。
   缺 url 时只留 repoId（如队列条目），由服务端按配置仓库补齐——否则 git 类脚本会卡在凭据交互提示上。 */
function runRepositorySnapshot(src){
  if(!src) return null;
  const repo=src.repository&&typeof src.repository==='object'&&!Array.isArray(src.repository)?src.repository:null;
  const url=src.repoUrl||(repo&&repo.url)||'';
  if(!url) return null;
  return {
    id: src.repoId||(repo&&repo.id)||null,
    name: src.repoName||(repo&&repo.name)||'',
    url: url,
    user: src.repoUser||(repo&&repo.user)||'',
    pass: src.repoPass||(repo&&repo.pass)||'',
  };
}
/* 本地队列条目的关页移交计划（条目尚未开始执行、不是「没执行完的任务」，整段移交服务端执行池）：
   阶段去掉 sched 标记、预设不进计划；无 url 的代码仓只留 repoId，由服务端按配置仓库补齐——
   否则 git 类脚本会卡在凭据交互提示上。 */
function buildUnloadHandoffPlan(item){
  const src=item||{};
  const stages=[];
  const raw=Array.isArray(src.stages)?src.stages:[];
  for(let i=0;i<raw.length;i++){
    const st=raw[i]; if(!st || st.preset) continue;
    const ps={...st}; delete ps.sched;
    stages.push(ps);
  }
  if(!stages.length) return null;
  return {
    id: 'unload-'+String(src.id||('q'+Date.now())),
    pipelineId: src.pipelineId||null,
    pipelineName: (src.pipelineName||'(自定义)')+' · 关页移交',
    stages, env: src.env||'', envs: Array.isArray(src.envs)?src.envs:[], image: src.image||'',
    repoId: src.repoId||null, repository: runRepositorySnapshot(src),
    branch: src.branch||'main', strategy: src.strategy||'',
    by: (src.by||'anonymous')+' ⏰',
    createdAt: Date.now(),
    archive: null, tag: null, baseSeq: 0,
    /* 显式 presets:[]（不执行预设任务）：移交的是排队条目的全部阶段，预设是页面运行期概念不随计划跑；
       不带 presets 字段会被服务端当作旧计划，落入「配置了清理脚本即执行」的兼容回退，
       未勾选环境清理的运行历史也会多出一个环境清理阶段 */
    presets: [],
    vars: {},
    settings: src.settings || (typeof runSettingsSnapshot==='function' ? runSettingsSnapshot() : null),   // 设置页配置运行级副本随移交计划带走
    kind:'once', at: Date.now(),
    desc: '浏览器关闭移交 · '+stages.length+' 阶段 · '+(src.pipelineName||'')+' · 立即（含需本地运行阶段，脚本在服务端执行）',
  };
}
/* 关页即失败的终态历史记录（形态与 finish 写入的历史记录一致）：当前在跑阶段标记 failed，其后未开始
   阶段标记 skipped（未执行），已完成阶段保留真实状态；closeError 携带中断原因（回放详情 KV 展示）。
   直接在 rc.nodes 上落终态再收集日志：pagehide 路径页面随即销毁，节点状态不再有人维护。 */
function buildCloseFailRecord(rc){
  const stg=Array.isArray(rc&&rc.stages)?rc.stages:[];
  const idx=currentStageIndex(rc);
  stg.forEach((st,i)=>{
    if(!st || !rc.nodes) return;
    const n=rc.nodes[st.id];
    if(i===idx) rc.nodes[st.id]=Object.assign({}, n, {status:'failed',progress:100,dur:(n&&n.dur)||0,sub:(n&&n.sub)||{},varsIn:(n&&n.varsIn)||{},varsOut:(n&&n.varsOut)||{}});
    else if(i>idx && (!n || n.status==='running' || n.status==='idle')) rc.nodes[st.id]={status:'skipped',progress:0,dur:0,sub:{}};
  });
  const logs=(typeof collectRunLogs==='function'?collectRunLogs(rc,-1):[]);
  /* 中断原因进失败阶段日志条目：无归档日志文件（未配置归档 / 模拟阶段）时内联兜底、回放直接可见；
     有归档文件时由 fail-run 路由把中断行追加进归档日志（回放尾窗与「打开日志」均可见），此处不内联覆盖 */
  const failedStage=idx>=0?stg[idx]:null;
  if(failedStage){
    const e=logs.find(l=>l && l.stage===failedStage.name);
    if(e && !e.logFile) e.log=(typeof e.log==='string'&&e.log? e.log+'\n':'')+CLOSE_FAIL_TEXT;
  }
  /* keepalive 上传体受浏览器 64KB 限制：内联日志只留尾部片段（全量日志的唯一实体本是归档文件） */
  logs.forEach(l=>{ if(l && typeof l.log==='string' && l.log.length>4096) l.log=l.log.slice(-4096); });
  const elapsed=(Date.now()-(rc.startTs||Date.now()))/1000;
  return {pipeline:rc.pipelineName||'(自定义)', env:rc.env||'', commit:String(rc.commit||'').slice(0,7),
    status:'failed', dur:(typeof fmtDur==='function'?fmtDur(elapsed):(Math.max(0,Math.round(elapsed))+'s')),
    time:(typeof nowHM==='function'?('今天 '+nowHM()):''), ts:Date.now(), startTs:rc.startTs||Date.now(), by:rc.by||'anonymous',
    pipelineId:rc.pipelineId||null, repoId:rc.repoId||null, branch:rc.branch||'main', strategy:rc.strategy||'', source:'local',
    envNodes:(typeof historyEnvNodesOf==='function'?historyEnvNodesOf(rc):[]),
    prom:(typeof promSnapshotForRun==='function'?promSnapshotForRun(rc):null),
    logs:logs, closeError:CLOSE_FAIL_TEXT,
    tag:rc.tag||null, archive:(typeof archiveFolderFor==='function'?archiveFolderFor(rc):null)};
}
/* pagehide 时收尾：在跑运行按失败落史（keepalive POST fail-run，fire-and-forget 不 await），
   本地队列条目整体移交服务端。同时 beacon 批量释放本页持有的节点租约——不释放的话移交计划要等
   死页面租约 TTL（90s）才拿得到节点，表现成「关页后阶段卡住」。
   返回本次「已了结」的条目 id 列表（已落史 / 无剩余阶段 / 并行子上下文随父收尾 / 队列已移交）：
   调用方据此把它们从最终在场快照剔除并列入 completed，否则在场 TTL 过期清扫会把它们误登记成
   「已中断」孤儿。 */
function handoffRunsOnPageHide(){
  const post=(plan)=>{
    if(!plan) return;
    try{
      fetch('/api/worktable/pipeline/plans',{
        method:'POST', keepalive:true,
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({plan}),
      }).catch(()=>{});
    }catch(e){ /* unload 路径吞掉：服务端 TTL/孤儿簿兜底 */ }
  };
  const leaseOwners=[];
  const noteLease=(id)=>{ if(id && leaseOwners.indexOf(String(id))<0) leaseOwners.push(String(id)); };
  const concluded=[];
  const noteConcluded=(id)=>{
    if(id===undefined||id===null||id==='') return;
    const sid=String(id);
    if(concluded.indexOf(sid)<0) concluded.push(sid);
    try{ if(typeof queueFinishedNote==='function') queueFinishedNote(sid); }catch(e){}
  };
  const failRecords=[];
  try{
    (typeof activeRuns!=='undefined'&&activeRuns?activeRuns:[]).forEach(rc=>{
      noteLease(rc&&rc.leaseId);
      if(!rc || rc.over || rc.parallelParent){ noteConcluded(rc&&rc.id); return; }   // 已结束 / 并行子随父收尾：同样不得进孤儿簿
      const idx=currentStageIndex(rc);
      if(idx<0){ noteConcluded(rc.id); return; }   // 无剩余阶段：本地已跑完，不是失联中断
      if(rc.scriptAbort){ try{ rc.scriptAbort.abort(); }catch(e){} }   // 在途 exec-stream 断开即杀进程
      try{ failRecords.push(buildCloseFailRecord(rc)); }catch(e){ console.warn('[pipeline] 关页失败记录组装失败（孤儿簿兜底）:', e); }
      noteConcluded(rc.id);   // 已按失败落史：本地条目了结，豁免孤儿
    });
    if(failRecords.length){
      try{
        fetch('/api/worktable/pipeline/history/fail-run',{
          method:'POST', keepalive:true,
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({records:failRecords}),
        }).catch(()=>{});
      }catch(e){ /* unload 路径吞掉：孤儿登记 + 「进行中」历史清扫兜底 */ }
    }
    const seen=new Set();
    const handoffItem=(item)=>{
      if(!item || !item.id || seen.has(item.id)) return;
      seen.add(item.id);
      noteLease(item.id);   // startRun 以排队项 id 作为租约持有方
      post(buildUnloadHandoffPlan(item));
      noteConcluded(item.id);   // 队列条目移交服务端执行：本地排队快照了结，豁免孤儿
    };
    (typeof queue!=='undefined'&&queue?queue:[]).forEach(handoffItem);
    (typeof pendingLeaseStarts!=='undefined'&&pendingLeaseStarts?pendingLeaseStarts:[]).forEach(p=>{ if(p&&p.queueItem) handoffItem(p.queueItem); });
  }catch(e){ console.warn('[pipeline] pagehide 收尾失败（服务端孤儿簿兜底）:', e); }
  if(leaseOwners.length){
    try{
      navigator.sendBeacon('/api/worktable/pipeline/leases',
        JSON.stringify({action:'release', runIds:leaseOwners}));
    }catch(e){ /* unload 路径吞掉：TTL 到期自动清理 */ }
  }
  return concluded;
}
function saveSchedEnvSel(){ try{ localStorage.setItem('pip-schedEnvSel', JSON.stringify(schedEnvIds)); }catch(e){} persistState(); }
function schedEnvs(){
  const ids=(schedEnvIds && schedEnvIds.length) ? schedEnvIds : curEnvs().map(e=>e.id);   // 未单独选择时跟随主控（多选 IP 不丢失）；都不选即无目标节点
  /* 按 ids 顺序返回（与选中/排序结果一致），决定定时计划 envs 的 TARGET_IPS 顺序 */
  return ids.map(id=>environments.find(e=>e.id===id)).filter(Boolean);
}
function renderSchedEnvOptions(){
  renderEnvMulti({btnId:'schedEnvMultiBtn', panelId:'schedEnvMultiPanel',
    getIds:()=> (schedEnvIds && schedEnvIds.length) ? schedEnvIds : curEnvs().map(e=>e.id),
    setIds:(ids)=>{ schedEnvIds=ids; saveSchedEnvSel(); }});
}
/* 定时页表单：选项跟随流水线 / 环境 / 代码仓数据（设置项与主控「运行流水线」保持一致），切换进页面时刷新并尽量保留已选值 */
function renderSchedForm(){
  const pl=$('schedPipeline'); if(!pl) return;
  const curPl=pl.value || curPipelineId; pl.innerHTML='';
  pipelines.forEach(p=>{ const o=document.createElement('option'); o.value=p.id; o.textContent=p.name; if(p.id===curPl) o.selected=true; pl.appendChild(o); });
  renderSchedEnvOptions();   // 环境（多选）：面板选项跟随节点环境数据
  const repo=$('schedRepo'); const curRepoId2=repo.value || curRepo().id; repo.innerHTML='';
  repositories.forEach(r=>{ const o=document.createElement('option'); o.value=r.id; o.textContent=r.name; if(r.id===curRepoId2) o.selected=true; repo.appendChild(o); });
  $('schedCleanupEnv').checked=$('cleanupEnv').checked;   // 「清理环境」与主控同一开关（全局配置，服务端定时执行同样生效）
  if(!$('schedBy').value.trim()) $('schedBy').value=currentUsername||'';
}
function addPlan(){
  const mode=$('runSched').value;
  const schedBy=$('schedBy').value.trim();
  if(!schedBy){ alert('请先填写「执行人」再创建定时计划。'); $('schedBy').focus(); return; }
  const pl=findPipeline($('schedPipeline').value) || curPipeline();
  const envs=schedEnvs();   // 环境（多选）：与「运行流水线」设置一致，快照多 IP 节点对象（服务端按 envs 注入 TARGET_IPS 等）
  /* 节点预留拦截（客户端体验层，真正门禁在服务端）：定时目标节点当前被预留给他人时 alert 明细并不创建计划。
     typeof 守卫：vm 抽取测试无该函数时按无预留处理 */
  if(typeof envReservationIssue==='function'){
    const resIssue=envReservationIssue(envs);
    if(resIssue){ alert(resIssue); return; }
  }
  const base={
    id:'plan'+Date.now().toString(36)+Math.random().toString(16).slice(2,4),
    pipelineId:pl.id, pipelineName:pl.name, stages:(pl.stages||[]).filter(s=>!s.preset),   // 预设任务标记不进定时计划：服务端按计划阶段执行（环境检查/Profiling 仅页面运行支持）
    /* 清理按本页「清理环境」勾选显式下发（勾选=cleanup 预设随计划在服务端最前执行；不勾选=显式空数组不执行）：
       不带 presets 字段的计划会被服务端当作旧计划，落入「配置了清理脚本即执行」的兼容回退，勾选框形同虚设 */
    presets:($('schedCleanupEnv')&&$('schedCleanupEnv').checked)?['cleanup']:[],
    env:envs.map(e=>e.ip).join('，'), envs:envs.map(e=>({...e})), image:DEFAULT_IMAGE, repoId:$('schedRepo').value, branch:($('schedBranch').value.trim()||'main'),
    strategy:($('schedStrategy').value.trim()||''),   // 部署策略：随计划快照，服务端定时执行时与运行队列同样注入
    by:schedBy+' ⏰', createdAt:Date.now(),
  };
  if(mode==='once'){
    const v=$('runSchedAt').value; const t=v?new Date(v).getTime():NaN;
    if(isNaN(t)||t<=Date.now()){ alert('「一次性」请选择一个未来的时间'); return; }
    serverPlans.push(Object.assign({}, base, {kind:'once', at:t, desc:'一次性 '+v.replace('T',' ')}));
  } else if(mode==='interval'){
    const every=Math.max(1,parseInt($('runSchedEvery').value)||1);
    const unitEl=$('runSchedUnit'); const unit=(unitEl&&unitEl.value)||'min';
    const UNIT_LABEL={min:'分钟',hour:'小时',day:'天',week:'周',month:'月',year:'年'};
    const UNIT_MIN={min:1,hour:60,day:1440,week:10080};   // 月/年无固定分钟数，由服务端按日历步进
    let desc='每 '+every+' '+(UNIT_LABEL[unit]||'分钟');
    const extra={};
    const sv=$('runSchedStart').value;
    if(sv){ const st=new Date(sv).getTime(); if(!isNaN(st) && st>Date.now()){ extra.startAt=st; desc+=' · 自 '+sv.replace('T',' ')+' 起'; } }
    const iv={kind:'interval', every:every, everyUnit:unit};
    if(UNIT_MIN[unit]) iv.everyMin=every*UNIT_MIN[unit];   // 固定单位保留 everyMin，兼容旧服务端
    serverPlans.push(Object.assign({}, base, iv, extra, {desc:desc}));
  } else return;
  pushPlans(); renderPlanList();
}
function fmtRelative(ts){ if(!ts) return ''; const d=Math.round((Date.now()-ts)/1000); if(d<60) return '刚刚'; if(d<3600) return Math.floor(d/60)+'分钟前'; if(d<86400) return Math.floor(d/3600)+'小时前'; return Math.floor(d/86400)+'天前'; }
/* 队列条目运行信息行：环境/代码仓/分支/部署策略（执行人、来源在标题行）。
   远端旧客户端快照没有 repoName/branch/strategy 字段，按 — 占位展示 */
function runInfoLine(o){
  return '<div class="dshell-muted" style="font-size:10px;font-weight:normal;white-space:normal;">'
    +'环境 '+esc(o.env||'—')+' · 代码仓 '+esc(o.repoName||'—')+' · 分支 '+esc(o.branch||'—')+' · 部署策略 '+esc(o.strategy||'（不使用）')+'</div>';
}
function remoteQueueViewAttrs(client,item,kind,title){
  if(!remoteQueueDetailAvailable(item)) return '';
  return ' data-qremote-client="'+esc(client&&client.id||'')+'" data-qremote-id="'+esc(item.id)+'" data-qremote-kind="'+kind+'" title="'+title+'" style="cursor:pointer;"';
}
/* 流水线任务列表的运行队列计数：本页运行/排队（含节点租约申请中）与服务端、其他浏览器
   快照统一按稳定 pipelineId 汇总；自定义运行没有 pipelineId，不归到同名流水线，避免重名误计。 */
function pipelineQueueCounts(){
  const counts=Object.create(null);
  const add=(item,kind)=>{
    const id=String(item&&item.pipelineId||''); if(!id) return;
    if(!counts[id]) counts[id]={running:0,queued:0};
    counts[id][kind]+=1;
  };
  activeRuns.forEach(item=>add(item,'running'));
  localQueueItems().forEach(item=>add(item,'queued'));
  remoteQueueClients.forEach(client=>{
    remoteRunsOf(client).forEach(item=>add(item,'running'));
    (Array.isArray(client&&client.queue)?client.queue:[]).forEach(item=>add(item,'queued'));
  });
  return counts;
}
function pipelineQueueCountHtml(count){
  const running=Number(count&&count.running)||0, queued=Number(count&&count.queued)||0;
  if(!running&&!queued) return '—';
  const parts=[];
  if(running) parts.push('<span class="dshell-badge dshell-badgeWait" style="color:var(--st-run)">运行 '+running+'</span>');
  if(queued) parts.push('<span class="dshell-badge dshell-badgeWait" style="color:var(--st-wait)">排队 '+queued+'</span>');
  return parts.join(' ');
}
function refreshPipelineQueueCounts(){
  if(typeof document==='undefined'||typeof document.querySelectorAll!=='function') return;
  const counts=pipelineQueueCounts();
  document.querySelectorAll('[data-plqueue]').forEach(cell=>{
    const count=counts[cell.getAttribute('data-plqueue')]||{running:0,queued:0};
    cell.innerHTML=pipelineQueueCountHtml(count);
    cell.title=(count.running||count.queued)?('运行 '+count.running+' · 排队 '+count.queued):'当前无运行或排队任务';
  });
}
function renderQueue(){
  const list=$('queueList'); if(!list) return;
  /* 排队预览自愈：预览中的排队项已出队（被取消/清空，或启动校验失败被移出队列）时，编排区回到当前流水线
     空闲编排。正常启动不走这里——startSimRun 已先把焦点切到真实运行 rc，viewRc 不再是预览 */
  if(viewRc && viewRc.queuedPreview===true && viewRc.serverSubmitting!==true && !localQueueItems().some(q=>q.id===viewRc.id)){
    viewRc=null; syncViewRun(); applyRunOverall(null);
    refreshArchiveTip();
    resetNodes();   // 空闲编排重建（内部重置 _detailKey 并重绘流程/详情）
  }
  /* 自愈排空：仍有排队任务时尝试排空（在跑运行结束却未触发 drainQueue 的异常竞态，或并行槽位已释放）。
     drainQueue 只启动机器不相交的项，全部相交时空转无副作用；startSimRun 末尾也会调 renderQueue，
     那时在跑集合已含新运行，不会重复启动，故无重入死循环。 */
  if(queue.length){ try{ drainQueue(); }catch(e){ console.warn('[queue] 自愈排空失败（不影响渲染）:', e); } }
  const localItems=localQueueItems();   // drainQueue 可能刚把排队项转成租约申请中，排空后重新取一次
  list.innerHTML='';
  const serverClient=remoteQueueClients.find(client=>String(client&&client.id||'')==='server');
  const legacyClients=remoteQueueClients.filter(client=>String(client&&client.id||'')!=='server');
  const serverRunningCount=remoteRunsOf(serverClient).length;
  const serverQueuedCount=serverClient&&Array.isArray(serverClient.queue)?serverClient.queue.length:0;
  const legacyRunningCount=legacyClients.reduce((sum,client)=>sum+remoteRunsOf(client).length,0);
  const legacyQueuedCount=legacyClients.reduce((sum,client)=>sum+(Array.isArray(client&&client.queue)?client.queue.length:0),0);
  const remoteRunningCount=serverRunningCount+legacyRunningCount;
  const remoteQueuedCount=serverQueuedCount+legacyQueuedCount;
  /* 孤儿中断条目（服务端登记簿；typeof 兜底供抽取测试缺省）：计入队列卡片头部计数与状态 */
  const orphans=(typeof remoteOrphans!=='undefined'&&Array.isArray(remoteOrphans))?remoteOrphans:[];
  const orphanCount=orphans.length;
  /* 服务端执行池终态登记（server.finished；typeof 兜底供抽取测试缺省）：短暂展示用，不计入头部计数
     （终态行随服务端 TTL 约 120s 自动消失，非待办项） */
  const serverFinishedRows=(typeof remoteServerFinished!=='undefined'&&Array.isArray(remoteServerFinished))?remoteServerFinished:[];
  const serverFinishedCount=serverFinishedRows.length;
  const totalQueueItems=activeRuns.length+localItems.length+remoteRunningCount+remoteQueuedCount+orphanCount;
  $('queueCount').textContent = totalQueueItems?'('+totalQueueItems+' 项)':'';
  /* 明细列表在本页有运行/排队、其他浏览器有活动、有中断登记或有服务端终态行时展开，空态由独立卡片首行的「空闲」徽标表达 */
  list.style.display = (running||localItems.length||remoteQueueClients.length||orphanCount||serverFinishedCount)?'':'none';
  /* 正在编排区查看的条目（本页在跑/排队预览/他端只读预览）：整框背景高亮，与运行历史选中行
     背景色保持一致（#historyTable tbody tr.sel td 同一 rgba(79,142,247,.12)），呼应「（查看中）」标记 */
  const markViewing=it=>{ it.style.background='rgba(79,142,247,.12)'; };
  /* 整行可点选中：点击条目空白处等同于点击标题（在编排区查看该流水线阶段详情）。
     标题/徽标/按钮等自带点击行为的区域命中时返回 true，行级处理直接放行，不重复触发 */
  const rowInnerHit=e=>{
    const t=e&&e.target;
    if(!t||typeof t.closest!=='function') return true;
    return !!(t.closest('.dshell-listItemTitle')||t.closest('[data-qreason]')||t.closest('[data-qcancel]')||t.closest('[data-qabort]')||t.closest('button'));
  };
  let status='空闲', cls='';
  if(running){
    status=activeRuns.length+' 运行中'+(localItems.length?' · '+localItems.length+' 排队':''); cls='dshell-badgeWait';
  } else if(localItems.length){ status=localItems.length+' 排队（待启动）'; cls='dshell-badgeWait'; }
  if(remoteRunningCount||remoteQueuedCount){
    const statusParts=[];
    if(status!=='空闲') statusParts.push('本页 '+status);
    if(serverRunningCount||serverQueuedCount){
      const serverStatus=[];
      if(serverRunningCount) serverStatus.push(serverRunningCount+' 运行');
      if(serverQueuedCount) serverStatus.push(serverQueuedCount+' 排队');
      statusParts.push('服务端 '+serverStatus.join(' · '));
    }
    if(legacyRunningCount||legacyQueuedCount){
      const legacyStatus=[];
      if(legacyRunningCount) legacyStatus.push(legacyRunningCount+' 运行');
      if(legacyQueuedCount) legacyStatus.push(legacyQueuedCount+' 排队');
      statusParts.push('其他浏览器 '+legacyStatus.join(' · '));
    }
    status=statusParts.join(' · ');
    cls='dshell-badgeWait';
  }
  if(orphanCount){
    status=(status==='空闲'?'':status+' · ')+'已中断 '+orphanCount;
    cls='dshell-badgeWait';
  }
  const qs=$('queueStatus'); qs.className='dshell-badge '+cls; qs.textContent=status;
  qs.style.color=orphanCount?'var(--st-err)':''; qs.style.borderColor=orphanCount?'color-mix(in srgb, var(--st-err) 40%, transparent)':'';   // 有中断登记时头部徽标转错误色提请注意
  /* 排队项「等待节点」标注：节点被他端（其他标签页/浏览器/API/定时）运行占用时展示占用节点与占用者，
     租约释放后 drainQueue 自动重启该项 */
  const nodeWaitText=q=>{
    const w=q&&q.nodeWait; if(!w) return '';
    const cs=Array.isArray(w.conflicts)?w.conflicts:[];
    if(!cs.length) return ' <span class="dshell-muted" style="font-size:10px" title="节点被其他运行占用，释放后自动启动">等待节点空闲</span>';
    return ' <span class="dshell-muted" style="font-size:10px" title="节点被其他运行占用，释放后自动启动">等待节点 '+cs.map(c=>esc(c.ip)+(c.by||c.label?'（'+esc([c.by,c.label].filter(Boolean).join(' · '))+'）':'')).join('、')+'</span>';
  };
  /* 排队原因（点击「排队中/申请节点中」徽标展开/收起）：按当前调度状态即时推算——租约被他端占用
     （nodeWait 快照）> 同机在跑 > 同机前排 > 并发槽位满 > 调度中。自包含实现，不依赖引擎函数 */
  const reasonOpenSet=(typeof queueReasonOpen!=='undefined')?queueReasonOpen:null;   // typeof 兼容测试/旧页面片段抽取
  const qIps=x=>{ const s=new Set(); (((x&&x.envs)||[])).forEach(e=>{ const ip=String((e&&e.ip)||'').trim(); if(ip) s.add(ip); }); return s; };
  const qIpHit=(a,b)=>{ for(const ip of a){ if(b.has(ip)) return ip; } return null; };
  const slotCount=()=>activeRuns.length+(typeof pendingLeaseStarts!=='undefined'?pendingLeaseStarts.length:0);
  const queueReasonText=(q,idx)=>{
    if(isPendingQueueItem(q)) return '正在向服务端申请节点租约，通常几秒内完成；节点被他端占用时自动转为等待节点，拿到后自动启动。';
    const w=q&&q.nodeWait;
    if(w&&Array.isArray(w.conflicts)&&w.conflicts.length) return '节点 '+w.conflicts.map(c=>esc(c.ip)+(c.by||c.label?'（'+esc([c.by,c.label].filter(Boolean).join(' · '))+'）':'')).join('、')+' 被他端运行占用，租约释放后自动启动（每 5 秒重试）。';
    const mine=qIps(q);
    if(!mine.size) return activeRuns.length?'未选择目标节点的运行按串行处理：等待在跑任务全部结束后启动。':'调度中，即将自动启动。';
    for(let i=0;i<activeRuns.length;i++){ const hit=qIpHit(mine,qIps(activeRuns[i])); if(hit) return '节点 '+esc(hit)+' 上正在运行「'+esc(activeRuns[i].pipelineName||'')+'」（'+esc(activeRuns[i].by||'')+'）：同一节点同一时间只跑一条流水线，等其结束后自动启动。'; }
    for(let j=0;j<idx;j++){ const prev=localItems[j]; if(!prev||prev===q) continue; const hit=qIpHit(mine,qIps(prev)); if(hit) return '同机任务「'+esc(prev.pipelineName||'')+'」（#'+(activeRuns.length+j+1)+' · '+esc(prev.by||'')+'）排在前面：同一节点先入先出，等其启动并结束后轮到自己。'; }
    if(typeof MAX_ACTIVE_RUNS!=='undefined'&&slotCount()>=MAX_ACTIVE_RUNS) return '并发槽位已满（'+slotCount()+'/'+MAX_ACTIVE_RUNS+'）：目标机器不冲突，等待在跑任务结束空出槽位后立即启动。';
    return '调度中，即将自动启动（目标机器不冲突且有并发空槽时立即运行）。';
  };
  const queueReasonLine=q=>'<div class="dshell-muted" style="font-size:10px;font-weight:normal;white-space:normal;">排队原因：'+queueReasonText(q,localItems.indexOf(q))+'</div>';
  /* 展示倒序：后加入的排队项显示在上面（仅展示顺序；编号仍按入队先后递增，先入队者排在队列首部） */
  for(let i=localItems.length-1;i>=0;i--){
    const q=localItems[i];
    const it=document.createElement('div'); it.className='dshell-listItem';
    const viewing=viewRc&&viewRc.queuedPreview===true&&viewRc.id===q.id;
    const pending=isPendingQueueItem(q);
    const reasonOpen=reasonOpenSet&&reasonOpenSet.has(q.id);
    if(viewing) markViewing(it);
    it.innerHTML='<span class="dshell-listItemTitle" data-qview="'+q.id+'" title="点击查看该排队流水线的详情（阶段编排与运行参数快照）" style="cursor:pointer;"><span class="dshell-muted">#'+(activeRuns.length+i+1)+'</span> '+esc(q.by)+' · '+esc(q.pipelineName||'')+' <span class="dshell-muted">'+sourceLabel(q.source)+'</span> <span class="dshell-muted" style="font-size:10px">'+fmtRelative(q.queuedAt)+'</span>'+(viewing?' <span class="dshell-muted" style="font-size:10px">（查看中）</span>':'')+(pending?'':nodeWaitText(q))+runInfoLine(q)+(reasonOpen?queueReasonLine(q):'')+'</span>'+(pending?'<span class="dshell-badge dshell-badgeWait" data-qreason="'+q.id+'" title="点击查看排队原因" style="cursor:pointer;">申请节点中</span>':'<span class="dshell-badge dshell-badgeWait" data-qreason="'+q.id+'" title="点击查看排队原因" style="cursor:pointer;">排队中</span>'+(canControlRun(q.by)?' <button class="dshell-btn dshell-btnGhost mini" data-qcancel="'+q.id+'">取消</button>':''));
    it.addEventListener('click',e=>{ if(rowInnerHit(e)) return; focusQueueItem(q.id); });   // 空白处点击同标题：查看该排队流水线详情
    list.appendChild(it);
  }
  /* 队列编号把在跑项排在排队项之前，因此展示时先画编号更大的排队项、再画在跑项，
     使整个列表严格按编号倒序，最早开始的 #1 固定在底部；只改展示，不改数组与 FIFO 调度顺序。 */
  if(running){
    for(let i=activeRuns.length-1;i>=0;i--){
      const rc=activeRuns[i];
      const it=document.createElement('div'); it.className='dshell-listItem';
      if(viewRc===rc) markViewing(it);
      it.innerHTML='<span class="dshell-listItemTitle" data-qfocus="'+rc.id+'" title="点击在编排区查看本次运行的阶段详情" style="cursor:pointer;"><span class="dshell-muted">#'+(i+1)+'</span> '+esc(rc.by)+' · '+esc(rc.pipelineName||'')+' <span class="dshell-muted">'+sourceLabel(rc.source)+'</span>'+(viewRc===rc?' <span class="dshell-muted" style="font-size:10px">（查看中）</span>':'')+runInfoLine(rc)+'</span><span class="dshell-badge dshell-badgeWait">运行中</span>'+(canControlRun(rc.by)?' <button class="dshell-btn dshell-btnGhost mini" data-qabort="'+rc.id+'">中止</button>':'');
      it.addEventListener('click',e=>{ if(rowInnerHit(e)) return; focusRun(rc); });   // 空白处点击同标题：选中该运行
      list.appendChild(it);
    }
  }
  /* 有控制权（本人署名 / admin）的任务可从任一浏览器中止/取消：服务端权威任务直接取消执行池条目；
     他端在场条目经服务端取消信箱转达来源页本地中止/取消。标题前带来源标签（服务端或 Chrome·a1b2）以区分归属。 */
  if(remoteQueueClients.length){
    const sep=document.createElement('div'); sep.className='dshell-listItem';
    sep.innerHTML='<span class="dshell-muted" style="font-size:10px">— 服务端队列 / 其他浏览器 —</span>';
    list.appendChild(sep);
    /* 远端条目取消/中止按钮：本人或 admin 可见；服务端条目走 cancelServerRun，他端条目走取消信箱 */
    const remoteCancelBtn=(c,item,kind)=>{
      if(!item||!canControlRun(item.by)) return '';
      const label=kind==='running'?'中止':'取消';
      const tip=(kind==='running'?'中止该运行：进行中的脚本进程会被杀掉，本次运行按「终止」计入历史':'取消该排队任务：出队后不再启动');
      if(String(c&&c.id||'')==='server') return ' <button class="dshell-btn dshell-btnGhost mini" data-qserver-cancel="'+esc(item.id)+'" title="'+tip+'">'+label+'</button>';
      return ' <button class="dshell-btn dshell-btnGhost mini" data-qremote-cancel="'+esc(c.id)+'" data-qremote-cancel-id="'+esc(item.id)+'" title="'+tip+'（跨浏览器：经服务端转达来源页执行）">'+label+'</button>';
    };
    remoteQueueClients.forEach(c=>{
      const tag='<span class="dshell-muted" style="font-size:10px">['+esc(c.label||c.id)+']</span> ';
      /* 他端与服务端同样先画较新的排队项、再画较早的在跑项，让整组从新到旧展示。 */
      (Array.isArray(c.queue)?c.queue:[]).slice().reverse().forEach(q=>{
        const it=document.createElement('div'); it.className='dshell-listItem';
        const viewing=viewRc&&viewRc.remotePreview===true&&viewRc.remoteClientId===String(c.id)&&viewRc.remoteItemId===String(q.id)&&viewRc.remoteKind==='queued';
        if(viewing) markViewing(it);
        it.innerHTML='<span class="dshell-listItemTitle"'+remoteQueueViewAttrs(c,q,'queued','点击查看该排队流水线的阶段详情')+'>'+tag+esc(q.by)+' · '+esc(q.pipelineName||'')+' <span class="dshell-muted">'+esc(sourceLabel(q.source))+'</span> <span class="dshell-muted" style="font-size:10px">'+fmtRelative(q.queuedAt)+'</span>'+(viewing?' <span class="dshell-muted" style="font-size:10px">（查看中）</span>':'')+runInfoLine(q)+remoteQueueDetailHint(q)+'</span><span class="dshell-badge dshell-badgeWait">排队中</span>'+remoteCancelBtn(c,q,'queued');
        if(remoteQueueDetailAvailable(q)) it.addEventListener('click',e=>{ if(rowInnerHit(e)) return; focusRemoteQueueItem(String(c.id),String(q.id),'queued'); });   // 空白处点击同标题
        list.appendChild(it);
      });
      remoteRunsOf(c).slice().reverse().forEach(rn=>{
        const it=document.createElement('div'); it.className='dshell-listItem';
        const viewing=viewRc&&viewRc.remotePreview===true&&viewRc.remoteClientId===String(c.id)&&viewRc.remoteItemId===String(rn.id)&&viewRc.remoteKind==='running';
        if(viewing) markViewing(it);
        it.innerHTML='<span class="dshell-listItemTitle"'+remoteQueueViewAttrs(c,rn,'running','点击查看该运行的阶段详情')+'>'+tag+esc(rn.by)+' · '+esc(rn.pipelineName||'')+' <span class="dshell-muted">'+esc(sourceLabel(rn.source))+'</span> <span class="dshell-muted" style="font-size:10px">'+fmtRelative(rn.startedAt)+'</span>'+(viewing?' <span class="dshell-muted" style="font-size:10px">（查看中）</span>':'')+runInfoLine(rn)+remoteQueueDetailHint(rn)+'</span><span class="dshell-badge dshell-badgeWait">运行中</span>'+remoteCancelBtn(c,rn,'running');
        if(remoteQueueDetailAvailable(rn)) it.addEventListener('click',e=>{ if(rowInnerHit(e)) return; focusRemoteQueueItem(String(c.id),String(rn.id),'running'); });   // 空白处点击同标题
        list.appendChild(it);
      });
    });
  }
  /* 「服务端最近完成」分组（排在「服务端队列 / 其他浏览器」之后、「已中断」之前，仅 server.finished
     非空时渲染）：服务端执行池终态的权威下发（完成≠失联），随服务端 TTL（约 120s）自动消失；
     只读展示，成功/失败/取消徽标样式区分，新条目已由 noteServerFinished 登记并触发历史即刷。 */
  if(serverFinishedCount){
    const sep=document.createElement('div'); sep.className='dshell-listItem';
    sep.innerHTML='<span class="dshell-muted" style="font-size:10px" title="服务端执行池最近结束的运行（服务端权威终态下发，约 2 分钟后自动消失；完整记录见运行历史）">— 服务端最近完成 —</span>';
    list.appendChild(sep);
    serverFinishedRows.forEach(fe=>{
      const fid=String(fe&&fe.id||''); if(!fid) return;
      const it=document.createElement('div'); it.className='dshell-listItem';
      const fst=String(fe&&fe.status||'');
      const badgeLabel=fst==='success'?'成功':(fst==='failure'?'失败':(fst==='cancelled'?'已取消':'已结束'));
      const badgeColor=fst==='success'?'var(--st-ok)':(fst==='failure'?'var(--st-err)':'var(--st-idle)');
      const fdur=Number(fe&&fe.dur);
      it.innerHTML='<span class="dshell-listItemTitle">'+esc(fe&&fe.by||'—')+' · '+esc(fe&&fe.pipelineName||'')+' <span class="dshell-muted">'+esc(sourceLabel(fe&&fe.source))+'</span> <span class="dshell-muted" style="font-size:10px" title="结束时间：'+(fe&&fe.endedAt?new Date(fe.endedAt).toLocaleString():'')+'">'+fmtRelative(fe&&fe.endedAt)+'</span>'+(Number.isFinite(fdur)&&fdur>0?' <span class="dshell-muted" style="font-size:10px">耗时 '+esc(typeof fmtDur==='function'?fmtDur(fdur):Math.round(fdur)+'s')+'</span>':'')+'</span>'
        +'<span class="dshell-badge" style="color:'+badgeColor+';border-color:color-mix(in srgb, '+badgeColor+' 40%, transparent);">'+badgeLabel+'</span>';
      list.appendChild(it);
    });
  }
  /* 「已中断」分组（排在「服务端队列 / 其他浏览器」之后，仅 orphans 非空时渲染）：来源页面刷新/关闭后
     执行引擎随页面销毁而中断的运行/排队条目（服务端孤儿登记簿）。条目为最后已知的白名单快照，
     点击只读预览阶段编排；可「重跑」（按流水线当前定义 + 最后已知的环境/分支/策略经 runPipeline 重新发起）或「移除」（dismiss 登记）。
     自己页面刷新/关闭导致中断的运行也会列在这里（同标签页刷新后 QCLIENT_ID 不变，ownerId 匹配本页）。 */
  if(orphanCount){
    const sep=document.createElement('div'); sep.className='dshell-listItem';
    sep.innerHTML='<span class="dshell-muted" style="font-size:10px" title="来源页面已刷新或关闭、执行随之中断的运行/排队任务；自己页面刷新或关闭导致中断的运行也会列在这里">— 已中断（页面刷新/关闭）—</span>';
    list.appendChild(sep);
    orphans.forEach(o=>{
      const oid=String(o&&o.id||''), oowner=String(o&&o.ownerId||'');
      if(!oid) return;
      const it=document.createElement('div'); it.className='dshell-listItem';
      const queued=o&&o.kind==='queued';
      const viewing=viewRc&&viewRc.orphanPreview===true&&viewRc.remoteClientId===oowner&&viewRc.remoteItemId===oid;
      if(viewing) markViewing(it);
      const otag='<span class="dshell-muted" style="font-size:10px">['+esc((o&&(o.ownerLabel||o.ownerId))||'来源页面')+']</span> ';
      const timeTs=queued?o&&o.queuedAt:o&&o.startedAt;
      const gone=typeof findPipeline==='function'?!findPipeline(o&&o.pipelineId):false;   // 流水线已删除：重跑置灰
      it.innerHTML='<span class="dshell-listItemTitle" data-qorphan-view="'+esc(oid)+'" data-qorphan-owner="'+esc(oowner)+'" title="点击查看最后已知的阶段编排与运行参数快照（来源页面已刷新/关闭，执行中断；日志不可拉取，产物见归档目录）" style="cursor:pointer;">'+otag+esc(o&&o.by||'—')+' · '+esc(o&&o.pipelineName||'')+' <span class="dshell-muted">'+esc(sourceLabel(o&&o.source))+'</span> <span class="dshell-muted" style="font-size:10px" title="中断时间（来源页面失联）：'+(o&&o.orphanedAt?new Date(o.orphanedAt).toLocaleString():'')+'">'+fmtRelative(timeTs||o&&o.orphanedAt)+'</span>'+(viewing?' <span class="dshell-muted" style="font-size:10px">（查看中）</span>':'')+runInfoLine(o||{})+'</span>'
        +'<span class="dshell-badge" style="color:var(--st-err);border-color:color-mix(in srgb, var(--st-err) 40%, transparent);">'+(queued?'排队中断':'已中断')+'</span>'
        +' <button class="dshell-btn dshell-btnGhost mini" data-qorphan-rerun="'+esc(oid)+'" data-qorphan-owner="'+esc(oowner)+'"'+(gone?' disabled title="找不到该次运行的流水线（可能已删除），无法重跑"':' title="按流水线当前定义与最后已知的环境/分支/策略参数重新发起运行（执行人取当前登录用户）"')+'>重跑</button>'
        +' <button class="dshell-btn dshell-btnGhost mini" data-qorphan-dismiss="'+esc(oid)+'" data-qorphan-owner="'+esc(oowner)+'" title="从运行队列移除该中断登记">移除</button>';
      it.addEventListener('click',e=>{ if(rowInnerHit(e)) return; focusOrphanQueueItem(oowner,oid); });   // 空白处点击同标题：只读预览
      list.appendChild(it);
    });
  }
  list.querySelectorAll('[data-qcancel]').forEach(b=>b.addEventListener('click',()=>{ const q=queue.find(x=>x.id===b.getAttribute('data-qcancel')); if(q && !canControlRun(q.by)){ alert('无权限：仅管理员可取消其他用户（'+esc(q.by||'')+'）的排队任务。'); return; } cancelQueue(b.getAttribute('data-qcancel')); }));
  list.querySelectorAll('[data-qserver-cancel]').forEach(b=>b.addEventListener('click',()=>{
    const id=b.getAttribute('data-qserver-cancel');
    const server=remoteQueueClients.find(c=>String(c&&c.id||'')==='server');
    const item=remoteRunsOf(server).concat(server&&Array.isArray(server.queue)?server.queue:[]).find(x=>String(x&&x.id||'')===String(id));
    if(item && !canControlRun(item.by)){ alert('无权限：仅管理员可中止或取消其他用户（'+esc(item.by||'')+'）的流水线。'); return; }
    cancelServerRun(id);
  }));
  /* 他端在场条目的跨浏览器取消/中止：权限口径同上，经取消信箱转达来源页 */
  list.querySelectorAll('[data-qremote-cancel]').forEach(b=>b.addEventListener('click',()=>{
    const clientId=b.getAttribute('data-qremote-cancel');
    const itemId=b.getAttribute('data-qremote-cancel-id');
    const client=remoteQueueClients.find(c=>String(c&&c.id||'')===String(clientId));
    const item=(client?remoteRunsOf(client).concat(Array.isArray(client.queue)?client.queue:[]):[]).find(x=>String(x&&x.id||'')===String(itemId));
    if(item && !canControlRun(item.by)){ alert('无权限：仅管理员可中止或取消其他用户（'+esc(item.by||'')+'）的流水线。'); return; }
    cancelRemotePresence(clientId, itemId);
  }));
  list.querySelectorAll('[data-qabort]').forEach(b=>b.addEventListener('click',()=>{ const rc=activeRuns.find(r=>r.id===b.getAttribute('data-qabort')); if(!rc) return; if(!canControlRun(rc.by)){ alert('无权限：仅管理员可中止其他用户（'+esc(rc.by||'')+'）的流水线。'); return; } abortRun(rc); }));
  list.querySelectorAll('[data-qfocus]').forEach(el=>el.addEventListener('click',()=>{ const rc=activeRuns.find(r=>r.id===el.getAttribute('data-qfocus')); if(rc) focusRun(rc); }));
  list.querySelectorAll('[data-qview]').forEach(el=>el.addEventListener('click',()=>focusQueueItem(el.getAttribute('data-qview'))));   // 排队项点击：编排区预览其阶段编排与参数快照
  /* 「排队中/申请节点中」徽标点击：展开/收起排队原因（只影响展示，不触碰调度与详情预览焦点） */
  list.querySelectorAll('[data-qreason]').forEach(el=>el.addEventListener('click',()=>{
    if(!reasonOpenSet) return;
    const id=el.getAttribute('data-qreason');
    if(reasonOpenSet.has(id)) reasonOpenSet.delete(id); else reasonOpenSet.add(id);
    renderQueue();
  }));
  list.querySelectorAll('[data-qremote-id]').forEach(el=>el.addEventListener('click',()=>focusRemoteQueueItem(el.getAttribute('data-qremote-client'),el.getAttribute('data-qremote-id'),el.getAttribute('data-qremote-kind'))));
  list.querySelectorAll('[data-qorphan-view]').forEach(el=>el.addEventListener('click',()=>focusOrphanQueueItem(el.getAttribute('data-qorphan-owner'),el.getAttribute('data-qorphan-view'))));
  list.querySelectorAll('[data-qorphan-rerun]').forEach(b=>b.addEventListener('click',()=>{ if(b.disabled) return; rerunOrphanQueueItem(b.getAttribute('data-qorphan-owner'),b.getAttribute('data-qorphan-rerun')); }));
  /* 「移除」中断登记：权限口径与队列区现有按钮一致（canControlRun(entry.by)，无权限 alert 提示，
     参照 data-qserver-cancel 的写法） */
  list.querySelectorAll('[data-qorphan-dismiss]').forEach(b=>b.addEventListener('click',()=>{
    const o=orphanQueueItem(b.getAttribute('data-qorphan-owner'),b.getAttribute('data-qorphan-dismiss'));
    if(o && !canControlRun(o.by)){ alert('无权限：仅管理员可移除其他用户（'+esc(o.by||'')+'）的中断登记。'); return; }
    dismissOrphanQueueItem(b.getAttribute('data-qorphan-owner'),b.getAttribute('data-qorphan-dismiss'));
  }));
  scheduleQueuePublish();   // 队列/运行态每次重绘都可能变化：防抖上报本页在场快照（见「服务端权威运行队列实时同步」区块）
  refreshPipelineQueueCounts();   // 每秒队列同步只更新现有计数单元格，不重建任务表（保留筛选与行交互）
}
/* 远端客户端的在跑运行列表：新版上报 runs 数组；旧版只有单条 running，按一条计 */
function remoteRunsOf(c){ if(!c) return []; if(Array.isArray(c.runs)&&c.runs.length) return c.runs; return c.running?[c.running]:[]; }
