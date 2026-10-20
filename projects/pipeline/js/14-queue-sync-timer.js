/* ===== 14-queue-sync-timer.js · 服务端权威队列实时同步与运行定时（周期/一次性） =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 6211–6813）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */

/* ---------- 服务端权威运行队列实时同步 ---------- */
/* 浏览器标签：从 userAgent 粗判浏览器 + id 后 4 位，回答「哪个浏览器的哪个标签页」 */
function browserTag(){
  const ua=navigator.userAgent||''; let b='浏览器';
  if(/Edg\//.test(ua)) b='Edge'; else if(/Chrome\//.test(ua)) b='Chrome'; else if(/Firefox\//.test(ua)) b='Firefox'; else if(/Safari\//.test(ua)) b='Safari';
  return b+'·'+QCLIENT_ID.slice(-4);
}
function queueStagePresence(stage){
  if(!stage||stage.id===undefined||stage.id===null) return null;
  const out={id:String(stage.id),name:String(stage.name||'')};
  if(stage.preset===true) out.preset=true;
  if(stage.local===true) out.local=true;
  if(stage.prefix===true) out.prefix=true;
  if(stage.pkey) out.pkey=String(stage.pkey);
  if(stage.parallel===true) out.parallel=true;
  if(stage.skip===true) out.skip=true;
  if(Array.isArray(stage.sub)&&stage.sub.length) out.sub=stage.sub.map(name=>String(name));
  /* 任务日志路径作为属性随快照同步：其他浏览器直接读 logFile，无需本地推算 */
  const lf=stage._serverLogFile||stage._serverLogExpectedFile;
  if(lf) out.logFile=String(lf);
  return out;
}
function queueNodePresence(node){
  const valid=['idle','running','success','failed','skipped','aborted'];
  const raw=node&&typeof node==='object'?node:{};
  const status=valid.indexOf(raw.status)>=0?raw.status:'idle';
  const progress=Number(raw.progress), dur=Number(raw.dur), startedAt=Number(raw.startedAt);
  const out={status:status,progress:Number.isFinite(progress)?Math.max(0,Math.min(100,progress)):0,dur:Number.isFinite(dur)?Math.max(0,dur):0};
  /* 阶段开始时间（纪元毫秒，通常为服务端时钟）随快照透传：远端预览据此折算运行中阶段的实时已耗时 */
  if(Number.isFinite(startedAt)&&startedAt>0) out.startedAt=startedAt;
  if(raw.sub&&typeof raw.sub==='object'){
    const sub={}; Object.keys(raw.sub).forEach(name=>{ const value=raw.sub[name]; if(valid.indexOf(value)>=0) sub[String(name)]=value; });
    if(Object.keys(sub).length) out.sub=sub;
  }
  return out;
}
function queuePresenceEntry(item,timeKey,stages,nodes){
  const out={};
  ['id','originQueueId','pipelineId','pipelineName','by','env','repoName','branch','strategy','source','archive','tag'].forEach(key=>{
    if(item&&item[key]!==undefined&&item[key]!==null) out[key]=String(item[key]);
  });
  const time=Number(item&&item[timeKey]); out[timeKey]=Number.isFinite(time)?time:0;
  out.stages=(Array.isArray(stages)?stages:[]).map(queueStagePresence).filter(Boolean);
  out.nodes={};
  out.stages.forEach(stage=>{ out.nodes[stage.id]=queueNodePresence(nodes&&nodes[stage.id]); });
  return out;
}
function runningPresenceEntry(rc){ return queuePresenceEntry(Object.assign({},rc,{startedAt:rc&&rc.startTs}),'startedAt',rc&&rc.stages,rc&&rc.nodes); }
function queuedPresenceEntry(item){
  const stages=expandRunStages(item&&item.stages||[],item&&item.presets);
  return queuePresenceEntry(item,'queuedAt',stages,null);
}
function queueFinishedPrune(){ const cut=Date.now()-QUEUE_FINISHED_TTL_MS; queueFinished=queueFinished.filter(e=>e.ts>=cut).slice(-QUEUE_FINISHED_CAP); }
function queueFinishedSave(){ try{ sessionStorage.setItem('pip-qfinished',JSON.stringify(queueFinished)); }catch(e){} }
function queueFinishedNote(id){
  if(id===undefined||id===null||id==='') return;
  queueFinishedPrune();
  queueFinished.push({id:String(id),ts:Date.now()});
  if(queueFinished.length>QUEUE_FINISHED_CAP) queueFinished=queueFinished.slice(-QUEUE_FINISHED_CAP);
  queueFinishedSave();
}
function queueFinishedIds(){ queueFinishedPrune(); return queueFinished.map(e=>e.id); }
/* 上报快照体（PUT 与 pagehide beacon 共用同一组装）：schemaVersion 3 起携带 completed——最近正常终态化
   的条目 id；另把当前在跑运行的 originQueueId 一并并入：排队项启动后条目 id 由 q… 换成 r…，
   q 条目从快照「消失」其实是正常移交（runningPresenceEntry 的 originQueueId 仍携带它），不并入会被
   服务端误判为孤儿中断。
   opts.excludeIds：从 runs/queue 剔除并强制并入 completed 的条目 id（关页收尾用）——关页后在跑运行
   已按失败落史、排队条目已移交服务端，不得留在最终快照里：否则在场 TTL 过期清扫会把它们登记成
   「已中断」孤儿。 */
function queuePublishBody(opts){
  const exclude=opts&&Array.isArray(opts.excludeIds)?new Set(opts.excludeIds.map(String)):null;
  const keep=(e)=>!exclude||!exclude.has(String(e&&e.id||''));
  const runsSnap=activeRuns.map(runningPresenceEntry).filter(keep);
  const completed=queueFinishedIds();
  activeRuns.forEach(rc=>{ const qid=String(rc&&rc.originQueueId||''); if(qid&&completed.indexOf(qid)<0) completed.push(qid); });
  if(exclude) exclude.forEach(id=>{ if(id&&completed.indexOf(id)<0) completed.push(String(id)); });
  return {schemaVersion:3,id:QCLIENT_ID,label:browserTag(),
    running:runsSnap.length?runsSnap[0]:null,   // 兼容旧客户端：首条仍在跑的运行仍按单条 running 上报
    runs:runsSnap,queue:localQueueItems().map(queuedPresenceEntry).filter(keep),completed:completed};
}
/* 上报本页在场快照：仅「签名变化」或距上次上报超 10 秒（心跳保活，防服务端 45 秒过期）时真正发请求 */
function publishQueue(force){
  const body=queuePublishBody();
  const sig=JSON.stringify([body.runs,body.queue]);
  const now=Date.now();
  if(!force && sig===_qPubSig && now-_qPubAt<10000) return;
  _qPubSig=sig; _qPubAt=now;
  fetch('/api/worktable/pipeline/queue',{method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)})
    .catch(e=>{ if(!_qPubWarned){ _qPubWarned=true; console.warn('[queue] 在场快照上报失败（不影响本地队列）:', e); } });
}
/* renderQueue 渲染很频繁（运行期逐帧），上报走 500ms 防抖合并，避免状态抖动时连续发请求 */
function scheduleQueuePublish(){ if(_qPubTimer) clearTimeout(_qPubTimer); _qPubTimer=setTimeout(()=>{ _qPubTimer=null; publishQueue(false); },500); }
/* 移除孤儿登记：POST dismiss；成功（dismissed）与已被他人移除（missing）都算了结，重拉快照刷新展示。
   权限在点击处按 canControlRun(entry.by) 拦截（与队列区服务端任务取消同一口径）。 */
async function dismissOrphanQueueItem(ownerId,id){
  try{
    const response=await fetch('/api/worktable/pipeline/queue',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'dismiss',ownerId:String(ownerId||''),id:String(id||'')}),
    });
    let result={}; try{ result=await response.json(); }catch(e){}
    if(!response.ok&&response.status!==404) throw new Error((result&&result.error)||('HTTP '+response.status));
    await pullRemoteQueue();
    return result;
  }catch(error){
    alert('移除中断登记失败：'+String(error&&error.message||error));
    await pullRemoteQueue();
    return null;
  }
}
/* 按孤儿条目的最后已知参数重新发起运行：pipelineId 找流水线，找不到说明流水线已删除、不可重跑
   （队列区「重跑」按钮同步置灰并提示）；envs 从条目 env 字符串按「，」/、/半角逗号拆出 IP，按 e.ip
   精确匹配回当前节点列表，匹配不到的环境对象用 {id:'',ip,name:ip} 兜底（保留原目标，不静默换成当前
   选择）。阶段编排取流水线当前完整定义（不传 stages 快照——快照只是白名单在场字段，sched/脚本绑定
   已剥掉，直接跑会退化成纯模拟）；全为服务端可执行阶段时经 runPipeline 分流到 submitServerRun
   （「非本地运行任务的动作在服务端完成」），含「需本地运行」阶段时维持本地队列。重跑是一次新的手动
   运行（source:'manual'，执行人取当前登录用户）；重跑成功（已启动/已入队/已提交）后顺手 dismiss 该孤儿登记。 */
function rerunOrphanQueueItem(ownerId,id){
  const orphan=orphanQueueItem(ownerId,id); if(!orphan) return;
  const pl=typeof findPipeline==='function'?findPipeline(orphan.pipelineId):null;
  if(!pl){ alert('找不到该次运行的流水线「'+(orphan.pipelineName||'')+'」（可能已删除），无法重跑。'); return; }
  const ips=String(orphan.env||'').split(/[，、,]/).map(s=>s.trim()).filter(Boolean);
  const envs=ips.map(ip=>environments.find(e=>e.ip===ip)||{id:'',ip:ip,name:ip});
  const r=runPipeline({pipelineId:pl.id, envs:envs, branch:orphan.branch||'main', strategy:orphan.strategy||'', source:'manual'});
  if(r===false){ alert('本地队列已满（上限 '+QUEUE_CAP+'），请等待当前任务完成或取消部分排队任务。'); return; }
  if(r==='no-by') return;   // 执行人必填拦截：runPipeline 已弹提示，不再给「已开始」误导提示
  flashRunTip(r==='queued'?('已加入本地队列（第 '+queue.length+' 位）'):(r==='submitted'?('已提交服务端运行队列（重跑「'+(orphan.pipelineName||'')+'」）'):('已开始重跑「'+(orphan.pipelineName||'')+'」')));
  dismissOrphanQueueItem(ownerId,id);   // 重跑成功：顺手移除孤儿登记
}
/* 取消服务端权威任务：运行中会中止，排队中会从队列移除；任一已登录浏览器均可操作。 */
async function cancelServerRun(runId){
  try{
    const response=await fetch('/api/worktable/pipeline/queue',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'cancel',runId:String(runId||'')}),
    });
    let result={}; try{ result=await response.json(); }catch(e){}
    if(!response.ok) throw new Error((result&&result.error)||('HTTP '+response.status));
    await pullRemoteQueue();
    return result;
  }catch(error){
    alert('取消服务端运行失败：'+String(error&&error.message||error));
    await pullRemoteQueue();
    return null;
  }
}
/* 跨浏览器终止他端在场条目（「其他浏览器」分组）：条目仍在来源页执行引擎里，服务端无法直接杀，
   经取消信箱转达；来源页下一轮 pullRemoteQueue 认领后本地 cancelQueue/abortRun。 */
async function cancelRemotePresence(clientId,itemId){
  try{
    const response=await fetch('/api/worktable/pipeline/queue',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'cancel-presence',clientId:String(clientId||''),itemId:String(itemId||''),by:currentUsername||''}),
    });
    let result={}; try{ result=await response.json(); }catch(e){}
    if(!response.ok) throw new Error((result&&result.error)||('HTTP '+response.status));
    flashRunTip('已请求终止：转达来源页执行，稍候条目将从队列消失');
    await pullRemoteQueue();
    return result;
  }catch(error){
    alert('跨浏览器终止失败：'+String(error&&error.message||error));
    await pullRemoteQueue();
    return null;
  }
}
/* 认领取消信箱：目标为本页 QCLIENT_ID 的请求，在本地真正中止/取消。条目已不在则忽略；
   处理后下一次在场上报不再携带该条目，服务端出箱。 */
function applyPresenceCancelRequests(reqs){
  if(!Array.isArray(reqs)||!reqs.length) return;
  let acted=false;
  for(const req of reqs){
    if(!req||String(req.clientId||'')!==QCLIENT_ID) continue;
    const itemId=String(req&&req.itemId||'');
    if(!itemId) continue;
    const q=(typeof queue!=='undefined'&&queue||[]).find(x=>String(x&&x.id||'')===itemId);
    if(q){ cancelQueue(itemId); acted=true; continue; }
    const rc=(typeof activeRuns!=='undefined'&&activeRuns||[]).find(r=>String(r&&r.id||'')===itemId);
    if(rc){ abortRun(rc); acted=true; continue; }
  }
  if(acted && typeof renderQueue==='function') renderQueue();
}
async function pullRemoteQueueLog(){
  const rc=viewRc, stageId=String(selectedId||'');
  if(!rc||rc.remotePreview!==true||rc.remoteFinished||rc.remoteClientId!=='server'||rc.remoteKind!=='running'||!stageId) return null;   // remoteFinished：已进入终态的服务端运行，日志轮询停止（运行结束后服务端不再提供该 run 的日志通道）
  const runId=String(rc.remoteItemId||'');
  if(!runId) return null;
  const key=runId+'\n'+stageId;
  if(_remoteLogPullPromise&&_remoteLogPullKey===key) return _remoteLogPullPromise;
  const seq=++_remoteLogPullSeq;
  const request=(async()=>{
    try{
      const cached=rc.remoteLogs&&rc.remoteLogs[stageId];
      const knownRevision=Number(cached&&cached.revision);
      const knownEnd=Number(cached&&cached.endLen);
      let url='/api/worktable/pipeline/queue?runId='+encodeURIComponent(runId)+'&stageId='+encodeURIComponent(stageId);
      if(Number.isSafeInteger(knownRevision)&&knownRevision>=0){
        url+='&revision='+knownRevision;
        if(Number.isSafeInteger(knownEnd)&&knownEnd>=0) url+='&sinceEnd='+knownEnd;
      }
      url+='&tailLines='+LIVE_LOG_TAIL_LINES;   // 全量/替换回退时服务端只回末尾 N 行，不传整段尾窗
      const response=await fetch(url,{cache:'no-store'});
      if(response.status===304) return cached||null;
      if(!response.ok) return null;
      const data=await response.json();
      const current=viewRc;
      if(seq!==_remoteLogPullSeq||!current||current.remotePreview!==true||current.remoteClientId!=='server'||current.remoteKind!=='running'||String(current.remoteItemId||'')!==runId||String(selectedId||'')!==stageId) return null;
      if(!current.remoteLogs) current.remoteLogs={};
      const old=current.remoteLogs[stageId];
      const revision=Number(data&&data.revision);
      let text,truncated,endLen;
      if(data&&typeof data.append==='string'&&old&&typeof old.text==='string'&&Number.isFinite(old.endLen)){
        text=old.text+data.append;   // 后缀增量：服务端已确认 sinceEnd 仍在窗口内且无 replace
        truncated=!!(data&&data.truncated);
        endLen=Number(data&&data.endLen);
        if(!Number.isFinite(endLen)) endLen=old.endLen+data.append.length;
      }else{
        text=String(data&&data.text||'');
        truncated=!!(data&&data.truncated);
        endLen=Number(data&&data.endLen);
        if(!Number.isFinite(endLen)){
          const baseLen=Number(data&&data.baseLen);
          endLen=Number.isFinite(baseLen)?baseLen+text.length:text.length;
        }
      }
      /* 本地展示缓存与历史回放同限：只留末尾 LIVE_LOG_TAIL_LINES 行，防止增量拼接下无界增长；
         endLen 单独记账，与展示截断无关（sinceEnd 对齐逻辑日志流，不依赖 text 长度）。
         split 对结尾 \n 多出的空串不算内容行，只裁内容行并保留结尾换行。 */
      if(LIVE_LOG_TAIL_LINES>0){
        const parts=text.split('\n');
        const trail=parts.length>0&&parts[parts.length-1]===''?1:0;
        const content=parts.length-trail;
        if(content>LIVE_LOG_TAIL_LINES) text=parts.slice(content-LIVE_LOG_TAIL_LINES,content).join('\n')+(trail?'\n':'');
      }
      const log={text:text,truncated:truncated,revision:Number.isFinite(revision)?revision:0,endLen:endLen};
      if(old&&old.text===log.text&&old.truncated===log.truncated&&old.revision===log.revision) return log;
      current.remoteLogs[stageId]=log;
      _detailKey=''; renderDetail();
      return log;
    }catch(e){ return null; }
  })();
  _remoteLogPullKey=key; _remoteLogPullPromise=request;
  try{ return await request; }
  finally{ if(_remoteLogPullPromise===request){ _remoteLogPullPromise=null; _remoteLogPullKey=''; } }
}
/* 队列快照签名：远端快照剔除 seenAgo（服务端每秒必变、页面不展示）后整体序列化；另覆盖编排区
   查看焦点（「查看中」高亮依赖 viewRc 身份）与本页排队项的相对时间显示文字（fmtRelative 分桶，
   标签翻转才算变化）；本页有排队项在等节点租约时附加 5 秒桶，保持 nodeWait 到点重试节奏
   （重试由 renderQueue 自愈入口的 drainQueue 驱动）。一次序列化成本远低于 DOM 重建；
   全局依赖一律 typeof 兜底，供抽取测试缺省。 */
function queuePollSig(clients,orphans,finished){
  const list=Array.isArray(clients)?clients:[];
  const rel=typeof fmtRelative==='function'?fmtRelative:function(){return '';};
  const parts=[JSON.stringify(list.map(c=>!c||typeof c!=='object'?c:{id:c.id,label:c.label,schemaVersion:c.schemaVersion,running:c.running,runs:c.runs,queue:c.queue}))];
  const times=[];   // 远端条目的相对时间显示文字：标签翻转同样算内容变化
  list.forEach(c=>{
    (Array.isArray(c&&c.queue)?c.queue:[]).forEach(q=>times.push(rel(q&&q.queuedAt)));
    (Array.isArray(c&&c.runs)?c.runs:[]).forEach(r=>times.push(rel(r&&r.startedAt)));
    if(c&&c.running) times.push(rel(c.running.startedAt));
  });
  /* 孤儿登记簿（旧服务端无此数据时调用方传空/缺省）：内容变化（新增/移除/复活）必须触发重绘；
     orphanedAt 的相对时间文字翻转同样算变化 */
  const orph=Array.isArray(orphans)?orphans:[];
  parts.push('o:'+JSON.stringify(orph));
  orph.forEach(o=>times.push(rel(o&&o.orphanedAt)));
  /* 服务端执行池终态登记（server.finished，旧服务端无此数据时调用方传空/缺省）：新终态出现与
     TTL 消失都必须触发重绘（终态行随 TTL 自动消失）；endedAt 的相对时间文字翻转同样算变化 */
  const fin=Array.isArray(finished)?finished:[];
  parts.push('f:'+JSON.stringify(fin));
  fin.forEach(e=>times.push(rel(e&&e.endedAt)));
  parts.push('t:'+times.join(','));
  if(typeof viewRc!=='undefined'&&viewRc){
    parts.push('v:'+(viewRc.remotePreview===true?('r:'+viewRc.remoteClientId+':'+viewRc.remoteKind+':'+viewRc.remoteItemId):String(viewRc.id||'')));
  } else parts.push('v:');
  if(typeof localQueueItems==='function'){
    let wait=false;
    parts.push('l:'+localQueueItems().map(q=>{ if(q&&q.nodeWait) wait=true; return String(q&&q.id||'')+':'+rel(q&&q.queuedAt); }).join(','));
    if(wait) parts.push('w:'+Math.floor(Date.now()/5000));
  }
  return parts.join('|');
}
/* 消费服务端执行池终态登记（server.finished）：新出现（未见过 id）的条目——
   ① 记入本页终态登记 queueFinishedNote（completed 随在场快照上报，完成≠失联：这些 id 绝不计入孤儿）；
   ② 立即触发一次历史刷新（不等 3s 轮询），让服务端运行的历史记录尽快可见。
   已消费 id 集随服务端 TTL 窗口滚动重建：窗口内同一 id 不重复消费，消失即释放（服务端不会复活同一 id）。
   queueFinishedNote/refreshHistoryFromServer 经 typeof 兜底供抽取测试缺省。 */
function noteServerFinished(list){
  const arr=Array.isArray(list)?list:[];
  const prev=(typeof _serverFinishedSeen!=='undefined'&&_serverFinishedSeen)||{};
  const fresh=[];
  arr.forEach(e=>{ const id=String(e&&e.id||''); if(id&&!prev[id]) fresh.push(id); });
  const seen={}; arr.forEach(e=>{ const id=String(e&&e.id||''); if(id) seen[id]=1; });
  if(typeof _serverFinishedSeen!=='undefined') _serverFinishedSeen=seen;
  if(!fresh.length) return;
  if(typeof queueFinishedNote==='function') fresh.forEach(id=>queueFinishedNote(id));
  if(typeof refreshHistoryFromServer==='function'){ try{ refreshHistoryFromServer(false); }catch(e){} }
}
/* 手动刷新与每秒轮询共用同一个在途请求（与 refreshHistoryFromServer 同一写法）：服务器响应慢于
   1 秒时，重叠 tick 复用 pending Promise 而非堆积并发 fetch——签名守卫只省渲染不省请求，慢服务器上
   并发拉取正是 CPU/连接尖峰与「偶尔卡顿」的来源。 */
async function pullRemoteQueue(){
  if(_queuePullPromise) return _queuePullPromise;
  const request=(async()=>{
  try{
    const r=await fetch('/api/worktable/pipeline/queue');
    if(r.ok){
      const j=await r.json();
      const clients=(Array.isArray(j.clients)?j.clients:[]).filter(c=>c && c.id!==QCLIENT_ID);
      const server=j&&j.server;
      const serverActive=server&&((Array.isArray(server.runs)&&server.runs.length)||(Array.isArray(server.queue)&&server.queue.length));
      const next=(serverActive?[server]:[]).concat(clients);
      /* 运行中阶段的已耗时由阶段 startedAt（纪元毫秒，服务端时钟）按本地时钟在每轮轮询实时折算：
         dur 每秒前进 → 快照签名随之变化 → 队列区与远端预览每秒刷出实时已耗时（签名降耗仍覆盖
         无运行中阶段的静态快照）；无 startedAt 的旧数据保持原 dur 不动，时钟偏差折出负值钳到 0 */
      const stampStageElapsed=item=>{ const ns=item&&item.nodes; if(!ns||typeof ns!=='object') return;
        for(const k of Object.keys(ns)){ const n=ns[k], startedAt=n&&Number(n.startedAt);
          if(n&&n.status==='running'&&Number.isFinite(startedAt)&&startedAt>0) n.dur=Math.max(0,(Date.now()-startedAt)/1000); } };
      next.forEach(c=>{ (Array.isArray(c&&c.runs)?c.runs:[]).forEach(stampStageElapsed); if(c&&c.running) stampStageElapsed(c.running); (Array.isArray(c&&c.queue)?c.queue:[]).forEach(stampStageElapsed); });
      /* 孤儿登记簿：GET 响应顶层 orphans（恒存在、可空）；旧服务端无此键——Array.isArray 特性探测，
         缺失即跳过（remoteOrphans 保持原值，优雅降级不报错） */
      const orphans=Array.isArray(j.orphans)?j.orphans:null;
      /* 服务端执行池终态登记：GET 响应 server.finished（旧服务端无此键→null 保持原值优雅降级） */
      const finished=server&&Array.isArray(server.finished)?server.finished:null;
      const sig=queuePollSig(next,orphans||[],finished||[]);
      if(sig!==_queuePullSig){
        _queuePullSig=sig;
        remoteQueueClients=next;
        if(orphans) remoteOrphans=orphans;
        if(finished) remoteServerFinished=finished;
        if(typeof applyOrphanPreviewRefresh==='function') applyOrphanPreviewRefresh();   // 正在预览的孤儿被移除/复活消失时，编排区自愈回空闲编排
        const planSig=planActiveSig();
        if(planSig!==_planActiveSig){ _planActiveSig=planSig; renderPlanList(); }   // 计划的活动执行（运行中/排队中）集合变化时同步重绘「定时」页，「终止」按钮随执行出现/消失
        applyRemoteQueuePreviewRefresh();
        renderQueue();
      }
      if(finished) noteServerFinished(finished);   // 新终态条目：登记 completed（完成≠失联）+ 历史即刷；按 id 去重，签名未变时幂等
      /* 取消信箱：每轮都认领（与签名无关——请求可能在快照未变化时到达）；旧服务端无此键跳过 */
      if(Array.isArray(j.cancelRequests)) applyPresenceCancelRequests(j.cancelRequests);
      if(typeof followPendingServerRun==='function') followPendingServerRun();   // 提交后自动跟随：runId 在本次快照可见即切编排区焦点（含超时清理，每轮都执行）
    }
  }catch(e){}
  /* 拉取失败/内容未变本轮不重绘：远端数据无更新，本地队列变化各有渲染入口（启动/取消/排空等） */
  })();
  _queuePullPromise=request;
  try{ await request; } finally{ if(_queuePullPromise===request) _queuePullPromise=null; }
  /* 日志尾部有自己的在途请求复用；不能让一个卡住的日志接口占住队列快照单飞守卫。 */
  try{ await pullRemoteQueueLog(); }catch(e){}
}

/* ---------- 运行定时（周期 / 一次性，服务端调度，关闭页面也会执行） ---------- */
async function loadPlans(){
  try{ const r=await fetch('/api/worktable/pipeline/plans'); if(r.ok){ const j=await r.json(); serverPlans=Array.isArray(j.plans)?j.plans:[]; } }catch(e){}
  renderPlanList();
}
async function pushPlans(){
  try{ await fetch('/api/worktable/pipeline/plans',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({plans:serverPlans})}); }catch(e){}
}
/* 计划归属执行人：创建计划时 by 追加的「 ⏰」只是定时来源标记（展示语义同 sourceLabel），权限比对前剥掉——
   否则非管理员按署名精确匹配永远失败，连自己的定时运行也无法终止（canControlRun 语义见运行队列）。 */
function planOwnerBy(p){ return String(p&&p.by||'').replace(/\s*⏰\s*$/,''); }
/* 计划在服务端执行池中的活动执行（运行中/排队中）：计划触发后执行条目 id 即计划 id
   （服务端 runIdOf 取 plan.runId||plan.id，定时计划不带 runId），按 id 精确匹配；仅看服务端权威池 */
function planActiveExec(p){
  const id=String(p&&p.id||''); if(!id) return null;
  const server=(remoteQueueClients||[]).find(c=>String(c&&c.id||'')==='server');
  if(!server) return null;
  const run=remoteRunsOf(server).find(x=>String(x&&x.id||'')===id);
  if(run) return {kind:'running', item:run};
  const queued=(Array.isArray(server.queue)?server.queue:[]).find(x=>String(x&&x.id||'')===id);
  if(queued) return {kind:'queued', item:queued};
  return null;
}
function planActiveSig(){ return serverPlans.map(p=>{ const a=planActiveExec(p); return a?p.id+':'+a.kind:null; }).filter(Boolean).join(','); }
function renderPlanList(){
  const el=$('planList'); if(!el) return;
  _planActiveSig=planActiveSig();
  $('planCount').textContent = serverPlans.length? '('+serverPlans.length+')':'';
  if(!serverPlans.length){ el.innerHTML='<div class="dshell-muted" style="padding:4px 2px;">暂无定时计划。</div>'; return; }
  let h='<div style="overflow:auto;"><table class="dshell-table"><thead><tr><th>流水线</th><th>方式</th><th>环境</th><th>分支</th><th>执行人</th><th>创建时间</th><th>操作</th></tr></thead><tbody>';
  serverPlans.forEach(p=>{
    const active=planActiveExec(p);
    const state=active?'<span class="dshell-badge dshell-badgeWait">'+(active.kind==='queued'?'排队中':'运行中')+'</span> ':'';
    const stop=active?'<button class="dshell-btn dshell-btnGhost mini" data-planstop="'+esc(p.id)+'" title="终止该计划当前'+(active.kind==='queued'?'排队中':'运行中')+'的执行：进行中的脚本进程会被杀掉，本次运行按「终止」计入历史；周期计划本身保留，下个周期仍会触发（不再触发请用「取消」删除计划）">终止</button> ':'';
    h+='<tr><td style="font-weight:600">'+esc(p.pipelineName||'')+'</td><td>'+esc(p.desc||'')+'</td><td class="dshell-muted">'+esc(p.env||'')+'</td><td class="dshell-muted">'+esc(p.branch||'')+'</td><td class="dshell-muted">'+esc(p.by||'')+'</td><td class="dshell-muted">'+(p.createdAt?new Date(p.createdAt).toLocaleString():'')+'</td><td>'+state+stop+'<button class="dshell-btn dshell-btnGhost mini" data-plandel="'+esc(p.id)+'">取消</button></td></tr>';
  });
  el.innerHTML=h+'</tbody></table></div>';
  el.querySelectorAll('[data-plandel]').forEach(b=>b.addEventListener('click',()=>cancelPlan(b.getAttribute('data-plandel'))));
  el.querySelectorAll('[data-planstop]').forEach(b=>b.addEventListener('click',()=>terminatePlan(b.getAttribute('data-planstop'))));
}
/* 终止计划当前执行：经 cancelServerRun 走服务端执行池取消（排队项直接移除；运行中 AbortController 中止、
   脚本进程树被杀，运行按「终止」计入历史），不动计划本身——周期计划到点仍触发，彻底停掉用「取消」。
   无活动执行时「终止」按钮本不渲染，竞态点击则提示并刷新列表。 */
async function terminatePlan(id){
  const p=serverPlans.find(x=>x&&x.id===id); if(!p) return;
  const active=planActiveExec(p);
  if(!active){ alert('该计划当前没有正在运行或排队的执行。'); renderPlanList(); return; }
  if(!canControlRun(planOwnerBy(p))){ alert('无权限：仅管理员可终止其他用户（'+planOwnerBy(p)+'）的定时运行。'); return; }
  if(!confirm('确定终止「'+(p.pipelineName||'')+'」当前'+(active.kind==='queued'?'排队中':'运行中')+'的执行？\n进行中的脚本进程将被终止，本次运行按「终止」计入历史；周期计划本身保留，下个周期仍会触发。')) return;
  const r=await cancelServerRun(id);
  if(r&&r.ok) renderPlanList();
}
function cancelPlan(id){
  const p=serverPlans.find(x=>x&&x.id===id);
  const active=p&&planActiveExec(p);
  if(active&&!confirm('该计划当前有'+(active.kind==='queued'?'排队中':'运行中')+'的执行，取消计划不会终止它。\n\n确定仅删除计划、保留当前执行？（要终止当前执行请先用「终止」）')) return;
  serverPlans=serverPlans.filter(x=>x.id!==id); pushPlans(); renderPlanList();
}
/* 阶段级定时后缀：混合编排（需本地运行前缀 + 定时后缀）不再等分界/关页才登记——
   启动（startSimRun）即把后缀阶段整体预登记为一条休眠服务端计划（kind:'once' 且 at=0，
   服务端 planTick 对 at 非正数的 once 计划不触发），本地前缀跑完只做「激活」（补 vars 快照 + at=now），
   关页/分界不再走重型移交，避免移交过程丢上下文、keepalive 丢包等问题。
   id 带本次运行 tag 逐次运行独立登记：每次运行各自执行、各自归档，重跑不再互替——
   旧版稳定 id 会被「执行完按 id 移除计划」的服务端清理误删执行中登记的新计划，导致该次运行后缀不执行、
   归档文件夹缺失每任务独立日志）。阶段不再单独配置周期：周期性由流水线级定时计划
   （「定时」页）决定，计划触发时服务端执行包含定时阶段在内的完整流水线。
   服务端 15s 轮询到期即在服务端执行（脚本真跑/模拟等待；HTTP/Jenkins/EvalTokens 阶段执行并等待终态；「不执行」阶段自动跳过），
   关闭页面也会执行。登记的计划会出现在「定时」页，可像普通计划一样取消。
   opts.activate=false 生成休眠计划（at=0，仅登记不执行）；缺省/true 为立即执行（at=now）。
   休眠计划等待期间页面关闭：在跑本地前缀经 fail-run 按失败落史，服务端同路由按 tag 清掉该休眠计划
   （后缀不再触发）；fail-run 未送达时由「进行中」历史清扫判死并清理（sweepStaleRunningHistory）。
   返回 true=登记成功；接口不可达/写计划失败返回 false——调用方据此弹窗并按失败收尾，后缀不得静默丢失。 */
function buildSuffixPlan(rc, startIdx, opts){
  const activate=!(opts&&opts.activate===false);
  const stages=[];
  for(let i=startIdx;i<rc.stages.length;i++){
    const st=rc.stages[i]; if(!st || st.preset) continue;   // 预设任务是页面运行期概念，不进服务端计划
    /* 仅 http 且勾选「本地运行」（sched=null）的阶段留在浏览器本地、不进服务端后缀计划；
       非 http 阶段（simulate/shell/python/evaltokens）即使存量数据残留 sched=null 也一律进服务端计划（跟随流水线定时计划） */
    if(st.kind==='http' && !st.sched) continue;
    const ps={...st}; delete ps.sched;   // 计划只承载执行所需字段，去掉 sched 标记
    stages.push(ps);
  }
  if(!stages.length) return null;
  const sid='stimer-'+(rc.pipelineId||'pl')+'-'+(rc.tag||Date.now())+'-suffix';   // 逐次运行唯一：同一次运行内重复登记（如从失败阶段重试再到分界）仍按同 id 替换去重
  // 把本次运行的归档上下文（文件夹/tag/起始序号）随计划交给服务端：
  // 定时后缀各任务回显由服务端写入同一归档文件夹、独立任务日志（run-<tag>-NN-任务名.log），与前缀日志连贯编号
  //（baseSeq=分界前的正式阶段数，预设任务不占阶段序号，见 stageSeq）
  /* 本地前缀已完成阶段快照（展示用，含本地执行标识）：随计划交给服务端，写进同 tag 历史与终态 stages，
     远端/他端查看该次运行详情时能看到完整阶段列表（本地前缀 + 服务端后缀），而非只有后缀。 */
  const prefixStages=[];
  for(let i=0;i<startIdx;i++){
    const st=rc.stages[i]; if(!st || st.preset) continue;
    const n=rc.nodes&&rc.nodes[st.id];
    if(!n || n.status==='running') continue;
    prefixStages.push({id:st.id, name:st.name, status:n.status||'success', dur:(n.dur||0), local:true});
  }
  return { id:sid, pipelineId:rc.pipelineId||null, pipelineName:(rc.pipelineName||'')+' · 定时后缀',
    stages, prefixStages, env:rc.env, envs:rc.envs, image:rc.image, repoId:rc.repoId||null, repository:runRepositorySnapshot(rc),
    branch:rc.branch||'main', strategy:rc.strategy||'', weightsPath:rc.weightsPath||'', by:(rc.by||'anonymous')+' ⏰', createdAt:Date.now(),
    /* 显式 presets:[]（不执行预设任务）：后缀是本次运行的延续，预设已在本地前缀按勾选展开执行过
       （或不执行）；不带 presets 字段会被服务端当作旧计划，落入「配置了清理脚本即执行」的兼容回退，
       未勾选环境清理的运行历史也会多出一个环境清理阶段（且在后缀起点重复执行） */
    presets:[],
    archive:rc.archive||null, tag:rc.tag||null,
    /* 历史合并为一条：服务端 execPlan 把后缀写进同 tag 历史记录（appendPipelineHistory 同 tag 原地
       合并，保留页面本地前缀记录的运行身份，阶段日志按名并集补齐后缀）——本地执行与非本地
       （服务端）执行的任务在运行历史里只留一条记录。旧版页面登记的计划即便带拆分标记字段，
       新版服务端也不再读取，同样合并同 tag。 */
    baseSeq:stageSeq(rc.stages||[], startIdx)-1,
    vars:Object.assign({}, rc.vars||{}),   // 上游阶段变量快照：后缀在服务端执行（execPlan），随计划带过去注入后续阶段
    settings: rc.settings || (typeof runSettingsSnapshot==='function' ? runSettingsSnapshot() : null),   // 设置页配置运行级副本：服务端执行后缀时按提交时设置，不受后续修改影响
    kind:'once', at:activate?Date.now():0,   // at=0 休眠：服务端 planTick 不触发，待本地前缀完成后再激活
    desc:'阶段定时 · 后缀 '+stages.length+' 阶段 · '+(rc.tag||'')+(activate?' · 立即（周期跟随流水线计划）':' · 已预登记（待本地阶段完成）') };
}
/* 计划单条 upsert（POST /api/worktable/pipeline/plans）：按 id 替换、保留他人计划，
   与关页移交同一条通道（不做 GET 合并再全量 PUT，避免竞态冲掉并发改动）。 */
async function upsertServerPlan(plan){
  if(!plan) return false;
  try{
    const w=await fetch('/api/worktable/pipeline/plans',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan})});
    if(!w||!w.ok) throw new Error('plans http '+(w&&w.status));
    const rest=(typeof serverPlans!=='undefined'&&serverPlans?serverPlans:[]).filter(p=>!p || p.id!==plan.id);
    serverPlans=rest.concat([plan]); renderPlanList();
    return true;
  }catch(e){ console.warn('[stage-timer] 登记失败：', e); return false; }
}
async function registerStageTimers(rc, startIdx, opts){
  return await upsertServerPlan(buildSuffixPlan(rc, startIdx, opts));
}
/* 启动即预登记定时后缀为休眠计划（at=0）：阶段定义/代码仓/归档上下文等重负载在页面健康时上送，
   分界只补 vars 与 at，缩小移交面。同步记录计划 id，供分界激活与失败清理定位同一条计划
   （关页时由 fail-run 路由按 tag 清理休眠计划，见「浏览器关闭」小节）。
   本地前缀可能瞬间跑完（dur=0 模拟等）在预登记请求落地前就激活后缀：请求完成后再看 suffixPlanHeld，
   若已被激活则补发一次激活写入，避免休眠体（at=0）后到覆盖已激活计划、一直挂到关页才触发。 */
function preRegisterSchedSuffix(rc, startIdx){
  const plan=buildSuffixPlan(rc, startIdx, {activate:false});
  if(!plan) return null;
  rc.suffixPlanId=plan.id;
  rc.suffixPlanHeld=true;
  registerStageTimers(rc, startIdx, {activate:false}).then(ok=>{   // 异步上送：不阻断本地启动；失败时分界/关页回退全量登记
    if(ok && rc && rc.suffixPlanHeld===false && !rc.over){ registerStageTimers(rc, startIdx).catch(()=>{}); }   // 竞态：分界已激活，后到休眠体不得生效——补发激活覆盖
  }).catch(()=>{});
  return plan.id;
}
/* 运行失败/中止/重置且后缀从未激活时，清掉休眠计划，避免定时页残留永不触发的占位计划 */
async function discardHeldSuffixPlan(rc){
  if(!rc || !rc.suffixPlanHeld || !rc.suffixPlanId) return false;
  rc.suffixPlanHeld=false;
  const sid=String(rc.suffixPlanId||''); if(!sid) return false;
  try{
    const r=await fetch('/api/worktable/pipeline/plans');
    let fresh=[]; if(r.ok){ const j=await r.json(); fresh=Array.isArray(j.plans)?j.plans:[]; }
    const kept=fresh.filter(p=>!p || p.id!==sid);
    const w=await fetch('/api/worktable/pipeline/plans',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({plans:kept})});
    if(!w||!w.ok) throw new Error('plans http '+(w&&w.status));
    serverPlans=kept; renderPlanList();
    return true;
  }catch(e){ console.warn('[stage-timer] 清理休眠后缀计划失败：', e); return false; }
}
/* 定时分界：本地前缀跑完后激活预登记的休眠后缀计划（补当前 vars 快照 + at=now，同 id 覆盖），
   不再做重型移交登记。预登记失败/缺失时回退全量登记（registerStageTimers）。
   后缀各阶段在编排区标记为「移交服务端」（skipped 渲染，结果由服务端写同 tag 历史记录合并补齐，
   见 buildSuffixPlan）；
   激活成功：toast 轻提示告知（不打断操作），本次运行本地部分按成功收尾，历史记录保持「进行中」
   待服务端后缀落终态（markHistorySuffixRunning）；失败：弹窗告知后缀未执行、分界阶段标 failed
   （可从失败阶段重试），本次运行按失败收尾——后缀不得静默丢失，也不得改在本地落地执行
   （定时阶段语义=服务端执行，见 runPipeline 分流）。 */
/* 混合编排移交成功后：本次运行的历史记录（同 tag 一条）保持「进行中」，待服务端后缀跑完由
   execPlan 落终态——本地前缀完成 ≠ 整条运行完成；若这里落定 success，刷新合并
   （applyHistoryRefreshPayload 本地终态优先于远端 running）会压住服务端后缀的「进行中」，
   后缀执行期间历史误显「已完成」。服务端终态写入后经 3s 历史刷新收敛。
   翻回 running 时同步 bump ts：合并层（mergePipelineHistoryForWrite）「终态不可逆」规则要求
   客户端 ts 严格大于磁盘 ts 才允许终态→running 翻转，本函数是这个设计内翻转的唯一入口。 */
function markHistorySuffixRunning(rc){
  const rec=rc&&rc.tag?history.find(h=>h&&h.tag===rc.tag):null;
  if(!rec||rec.status==='running') return;
  rec.status='running';
  rec.ts=Date.now();
  renderHistory(); renderStats(); persistState();
}
async function handoffSchedSuffix(rc, i){
  const stg=rc.stages;
  let count=0;
  for(let j=i;j<stg.length;j++){
    const st=stg[j]; if(!st||st.preset) continue;
    /* 仅 http 且勾选「本地运行」（sched=null）的阶段不算可移交定时阶段；非 http 阶段即使存量残留 sched=null
       也按支持定时计数并移交服务端（与 buildSuffixPlan 收录口径一致） */
    if(st.sched || st.kind!=='http') count++;
    rc.nodes[st.id]={status:'skipped',progress:100,dur:0,sub:{},varsIn:Object.assign({},rc.vars||{}),varsOut:{}};
  }
  rcRender(rc,true);
  if(!count){ finish(rc,'success'); return; }   // 分界后只剩预设任务：无后缀可移交，直接收尾（防御，正常不会走到）
  rc.handoffFromIdx=i;   // 后缀起点：collectRunLogs 不再写本地占位，同 tag 合并时由服务端补齐完整阶段
  const ok=await registerStageTimers(rc,i);   // 激活/回退全量登记：同 id 覆盖休眠计划，vars 取当前快照
  if(rc.over) return;   // 等待登记期间被中止/重置：中止路径已收尾，不再提示不再写状态
  if(ok){
    if(rc.suffixPlanHeld) rc.suffixPlanHeld=false;   // 已激活：finish 不再清理
    finish(rc,'success');
    rcOverall(rc,'✓ 已完成（后缀 '+count+' 个定时阶段已移交服务端）','dshell-badgeDone');
    markHistorySuffixRunning(rc);   // 历史保持「进行中」，待服务端后缀落终态（单条记录承载本地+服务端全程）
    if(typeof toast==='function') toast('本地阶段已完成，后续 '+count+' 个定时阶段已移交服务端执行（约 15 秒内开始，可在「定时」页查看或取消）。');
  }else{
    const boundary=stg[i];
    if(boundary&&!boundary.preset) rc.nodes[boundary.id]={status:'failed',progress:100,dur:0,sub:{},varsIn:Object.assign({},rc.vars||{}),varsOut:{}};
    alert('定时阶段移交服务端失败：计划接口不可达，后续 '+count+' 个阶段未执行。请检查 dsh 服务后从失败阶段重试。');
    finish(rc,'failed');
  }
}
