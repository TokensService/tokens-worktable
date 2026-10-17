/* ===== 13-queue-lease.js · 运行队列、调度与节点占用租约（服务端权威互斥） =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 5677–6210）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */

/* ---------- 运行队列 + 调度 ---------- */
function resetNodes(){
  /* 视图感知：展示某次运行（在跑/结果视图）时重置的是该运行的节点表；空闲态重置当前流水线的空闲编排 */
  if(viewRc){ viewRc.nodes={}; nodes=viewRc.nodes; }
  else nodes={};
  flowStages().forEach(s=> nodes[s.id]={status:'idle',progress:0,dur:0,sub:{}});
  _detailKey='';   // 节点全部重建，详情渲染缓存一并失效
  renderFlow(); renderDetail();
}
function setOverall(txt,cls){
  const o=$('overall'); o.innerHTML='';
  const b=document.createElement('span'); b.className='dshell-badge '+cls; b.textContent=txt; o.appendChild(b);
}
/* 运行按钮不随运行禁用：运行中点击即并行启动（机器不相交）或把当前配置入队（见 runPipeline），文案与提示随运行态切换 */
function syncRunBtn(){
  const b=$('runBtn'); b.disabled=false;
  if(running){ b.textContent='▶ 入队运行'; b.title='有流水线运行中：目标机器不冲突且未占满 '+MAX_ACTIVE_RUNS+' 个并发槽位时立即运行，否则加入队列等待（上限 '+QUEUE_CAP+' 个）'; }
  else { b.textContent='▶ 运行流水线'; b.title=''; }
}
function startRun(opts){
  opts = opts || {};
  let pl;
  if(opts.stages){ pl={stages:opts.stages, id:opts.pipelineId||null, name:opts.pipelineName||'(自定义)'}; }
  else { pl = findPipeline(opts.pipelineId||curPipelineId) || curPipeline(); }
  const envs = Array.isArray(opts.envs) ? opts.envs              // 队列/弹窗/定时快照：复用显式节点数组；空数组=不选择节点
    : opts.env ? [resolveEnv(opts.env)] : curEnvs();             // 未显式传节点时才读取主运行框选择
  const env = envs.map(e=>e.ip).join('，');
  const image = opts.image || DEFAULT_IMAGE;
  const release = image;                 // Release 字段已移除，内部以镜像名作为 release
  const repo = resolveRepo(opts.repoId || $('repoSel').value);
  const branch = opts.branch || ($('branchName').value.trim()||'main');
  const by = opts.by || (currentUsername||'anonymous');
  const strategy = opts.strategy!==undefined ? opts.strategy : curStrategy();
  /* 权重路径（可选）：显式快照（含空串）优先，未传时读主控当前值（见 runPipeline 同名解析） */
  const weightsPath = opts.weightsPath!==undefined ? String(opts.weightsPath||'').trim() : curWeightsPath();
  const c = {env, envs, image, release, repo, branch, by, strategy, weightsPath, presets:Array.isArray(opts.presets)?opts.presets.slice():selectedPresetKeys(), source:opts.source||'manual', originQueueId:opts.originQueueId||opts.id||'',
    settings: opts.settings || (typeof runSettingsSnapshot==='function' ? runSettingsSnapshot() : null)};   // 运行级设置副本：入队时已带快照则沿用，否则启动即取当前设置
  /* 节点占用租约：目标节点（环境 IP）先向服务端申请租约，拿到才真正开跑——同一节点同一时间
     只跑一条流水线（跨标签页/跨浏览器/API/定时统一互斥，见「节点占用租约」区块）。无目标 IP
     时没有可互斥的节点，保持旧行为直接启动；抽取测试环境无租约实现时同样按旧行为处理。 */
  const leaseIps=Array.from(runIps(c));
  if(!leaseIps.length || typeof nodeLeaseRequest!=='function'){ startSimRun(pl, c); return true; }
  c.leaseId=(opts.id||'')||('q'+Date.now().toString(36)+Math.random().toString(16).slice(2,5));
  c.leaseIps=leaseIps;
  /* 租约申请在途期间占一个调度槽位并参与机器冲突判定（conflictsActive/runPipeline），
     防止快速连续运行/同一次 drain 越过页内互斥 */
  const pend={envs:c.envs,queueItem:opts};   // 申请期间仍按排队快照上报，避免他端详情在 q → r 过渡中闪断
  if(typeof pendingLeaseStarts!=='undefined') pendingLeaseStarts.push(pend);
  const settle=()=>{ if(typeof pendingLeaseStarts!=='undefined'){ const i=pendingLeaseStarts.indexOf(pend); if(i>=0) pendingLeaseStarts.splice(i,1); } };
  nodeLeaseRequest({action:'acquire', runId:c.leaseId, ips:leaseIps, label:pl.name||'', by:c.by}).then(r=>{
    settle();
    if(r && r.ok===false){
      /* 节点被预留（服务端 403 reserved）：alert 服务端说明并按启动失败收尾——不进入运行、不回队等待 */
      if(r.reserved){ alert(r.message||'节点已被预留，当前时段不可运行。'); renderQueue(); return; }
      /* 节点被他端运行占用：回队等待（nodeWait 供队列区展示与重试节流，drainQueue 到点重新申请） */
      if(opts && opts.id){
        opts.nodeWait={until:Date.now()+(typeof NODE_WAIT_RETRY_MS==='undefined'?5000:NODE_WAIT_RETRY_MS), conflicts:Array.isArray(r.conflicts)?r.conflicts:[]};
        if(!queue.some(q=>q.id===opts.id)) queue.unshift(opts);
      } else console.warn('[pipeline] 节点被占用且排队项无 id，无法回队等待:', r.conflicts);
      renderQueue();
      return;
    }
    startSimRun(pl, c);
  }).catch(e=>{
    settle();   // 服务端不可达/旧插件无租约路由：降级为仅页内互斥的旧行为，不阻断运行
    console.warn('[pipeline] 节点租约申请失败，按仅页内互斥的旧行为直接启动:', e);
    startSimRun(pl, c);
  });
  return true;
}
function startSimRun(pl, c){
  replayRec=null; const rt0=$('replayTip'); if(rt0) rt0.textContent='';   // 新运行优先：退出历史回放态
  /* 预设任务按编排位置展开进执行序列（未勾选的不进本次运行），清理/检查/Profiling 与普通阶段统一经 advance 串行推进 */
  const stages = expandRunStages(pl.stages, c.presets);
  /* 运行时兜底校验：本地运行（不支持定时）阶段不能排在定时阶段之后（与保存校验一致，防本地数据被外部改坏）；预设任务不参与定时校验 */
  {
    let started=false, badIdx=-1;
    for(let i=0;i<stages.length;i++){ if(stages[i].preset) continue; const has=!!stages[i].sched; if(has) started=true; else if(started){ badIdx=i; break; } }
    if(badIdx>=0){ alert('阶段「'+stages[badIdx].name+'」需本地运行却排在定时阶段之后，无法运行。请在流水线编辑器修正。'); releaseNodeLease(c.leaseId, c.leaseIps); drainQueue(); return; }   // 启动校验失败：已拿到的节点租约立即释放
  }
  const commit=randCommit(), tag=nowHM().replace(':','')+'-'+commit.slice(0,5);
  // 浏览器本地执行路径：含「需本地运行」阶段的手动运行与历史重跑由 runPipeline 分流到这里。
  const rc={id:'r'+Date.now().toString(36)+Math.random().toString(16).slice(2,5),
    stages:stages, nodes:{}, selId:stages.length?stages[0].id:null, timer:null, over:false, overall:null,
    leaseTimer:null, leaseId:c.leaseId||null, leaseIps:c.leaseIps||[],   // 节点占用租约：finish/中止/重置时释放
    env:c.env, envs:c.envs, image:c.image, release:c.release, commit, tag, startTs:Date.now(), by:c.by, source:c.source||'manual', originQueueId:c.originQueueId||'',
    pipelineId:pl.id||null, pipelineName:pl.name, repoId:c.repo.id||null, repoName:c.repo.name, repoUrl:c.repo.url, giturl:c.repo.url||GITURL,
    repoUser:c.repo.user||'', repoPass:c.repo.pass||'', branch:c.branch, strategy:c.strategy||'', weightsPath:c.weightsPath||'', presets:(c.presets||[]).slice(), vars:{}, token:++runSeq,
    settings:c.settings||((typeof runSettingsSnapshot==='function')?runSettingsSnapshot():null)};   // 设置页配置运行级副本：本次运行各阶段只读它，后续修改不影响本运行
  stages.forEach(s=>{ rc.nodes[s.id]={status:'idle',progress:0,dur:0,sub:{}}; });
  rc.archive = archiveFolderFor(rc);   // 启动即快照归档文件夹：供各阶段经环境变量写入产物（见 execScript/runUrlStep），末尾 archiveRun 复用同一路径
  if(rc.archive){   // 启动即预建归档文件夹：此前目录要等首个任务日志落盘才创建，运行初期点「打开归档目录」会报「✗ 目录不存在」
    ensureArchiveFolder(rc.archive).then(ok=>{ if(!ok) console.warn('[archive] 预建归档文件夹失败（不影响运行结果）:', rc.archive); });
  }
  activeRuns.push(rc);
  /* 持有节点租约的运行：周期续租（服务端 TTL 90s，25s 心跳容忍丢失；续租失败静默——finish/中止/重置
     显式释放，页面崩溃由租约到期自动清理） */
  if(rc.leaseId && rc.leaseIps.length){
    rc.leaseTimer=setInterval(()=>{ nodeLeaseRequest({action:'acquire', runId:rc.leaseId, ips:rc.leaseIps, label:rc.pipelineName||'', by:rc.by||''}).catch(()=>{}); }, NODE_LEASE_RENEW_MS);
  }
  viewRc=rc; syncViewRun(); syncRunState();   // 新运行获得编排区焦点
  _detailKey='';   // 视图切到新运行，详情渲染缓存一并失效
  refreshArchiveTip();   // 运行期间「打开归档目录」目标切到本次运行归档（见 archiveTargetFolder）
  rcOverall(rc,'运行中…','dshell-badgeWait');
  beginRunHistory(rc);   // 启动即写入运行历史（状态「进行中」），finish 按 tag 原地更新为终态
  renderFlow(); renderDetail();
  /* 混合编排（本地前缀 + 定时后缀）：启动即把后缀预登记为休眠服务端计划（at=0，见 preRegisterSchedSuffix），
     分界/关页只做激活，不再等移交——防止移交过程中丢上下文/请求丢失。
     纯本地（无 sched 阶段）不预登记；无本地任务（后缀前没有需本地运行阶段）不留休眠计划，
     直接以 at=now 登记为可执行服务端任务，避免休眠计划与分界激活竞态、一直挂到关页才触发。 */
  {
    let firstSched=-1, hasLocalPrefix=false;
    for(let i=0;i<stages.length;i++){
      const st=stages[i]; if(!st||st.preset) continue;
      if(st.sched){ if(firstSched<0) firstSched=i; }
      else if(firstSched<0) hasLocalPrefix=true;   // 定时分界之前存在需本地运行阶段，才需要休眠等待
    }
    if(firstSched>=0){
      try{
        if(hasLocalPrefix) preRegisterSchedSuffix(rc, firstSched);
        else registerStageTimers(rc, firstSched);   // 无本地任务：立刻激活为服务端任务，不等关页
      }catch(e){ console.warn('[pipeline] 定时后缀登记失败（分界/关页回退全量登记）:', e); }
    }
  }
  advance(rc,0);
  renderQueue();
}
/* 全部阶段均支持服务端执行的手动运行只把参数提交给服务端权威执行池。请求体只含配置引用和运行参数；
   阶段定义、节点/代码仓凭据均由服务端从已保存配置解析。keepalive 保证用户点击后立即关闭/跳转页面时提交仍可送达。
   未选择任何节点时 environmentIds 为显式空数组（= 不选择任何节点，无目标节点运行），不回退流水线默认环境。 */
async function submitServerRun(item){
  const body={
    environmentIds:(Array.isArray(item&&item.envs)?item.envs:[]).map(e=>e&&e.id).filter(Boolean),
    repositoryId:item&&item.repoId||undefined,
    branch:item&&item.branch||'main',
    strategy:item&&item.strategy||'',
    presets:Array.isArray(item&&item.presets)?item.presets:[],
    weightsPath:item&&item.weightsPath||'',   // 权重路径（可选）：非空时服务端按 MODEL_PATH 注入本次运行各任务
    image:item&&item.image||DEFAULT_IMAGE,
    by:item&&item.by||'',
    /* 触发来源透传（runPipeline 已按 opts.source||'manual' 归一）：历史/孤儿重跑语义上是「新的手动运行」
       （执行人取当前登录用户，调用方显式传 'manual'）；今后若有 schedule 系来源经 runPipeline 分流到
       服务端，也能保留来源语义而不是被硬编码吞掉。 */
    source:item&&item.source||'manual',
  };
  /* POST/服务端排队可能需要数秒；先用本次参数快照切到“提交中”，避免按钮点击后界面毫无变化。 */
  if(typeof focusRun==='function') focusRun(serverSubmissionPreviewRc(item));
  try{
    const response=await fetch('/api/worktable/pipeline/run/'+encodeURIComponent(item&&item.pipelineId||''),{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),keepalive:true,
    });
    let result={}; try{ result=await response.json(); }catch(e){}
    if(!response.ok) throw new Error((result&&result.error)||('HTTP '+response.status));
    /* 提交成功即自动跟随本次运行：runId 在服务端权威快照（排队/在跑）中可见后，
       把编排区/阶段详情切过去；快照未刷新前跨轮询等待（见 followPendingServerRun） */
    if(result&&result.runId&&typeof followPendingServerRun==='function'&&typeof SERVER_RUN_FOCUS_MS==='number'){
      pendingServerRunFocus={runId:String(result.runId),until:Date.now()+SERVER_RUN_FOCUS_MS,previewId:String(item&&item.id||'')};
    }
    await pullRemoteQueue();
    if(typeof pendingServerRunFocus!=='undefined'&&pendingServerRunFocus){
      followPendingServerRun();
    }
    return result;
  }catch(error){
    if(typeof clearServerSubmissionPreview==='function') clearServerSubmissionPreview(item&&item.id);
    alert('提交服务端运行失败：'+String(error&&error.message||error));
    return null;
  }
}
function runPipeline(opts){
  opts = opts || {};
  let pl;
  if(opts.stages){ /* from queue snapshot already */ }
  else { pl = findPipeline(opts.pipelineId||curPipelineId) || curPipeline(); }
  if(opts.useDefaults){ const issue=pipelineDefaultRunIssue(pl,opts); if(issue){ alert(issue+'。请先编辑流水线并重新保存默认参数。'); return 'invalid-defaults'; } }
  opts=resolvePipelineRunOptions(pl,opts);
  /* 执行人必填：取当前登录用户（只读），未获取到时弹窗拦截（队列/定时快照自带 opts.by，不受影响；历史重跑同样按当前登录用户校验） */
  if(!opts.by && !currentUsername){ alert('未获取到当前登录用户：「执行人」取 dsh 登录用户。请确认已登录后刷新页面重试。'); return 'no-by'; }
  const envs = Array.isArray(opts.envs) ? opts.envs           // 与 startRun 一致：显式空数组=不选择节点，不回退主运行框
    : opts.env ? [resolveEnv(opts.env)] : curEnvs();
  /* 节点预留拦截（客户端体验层，真正门禁在服务端）：本次实际目标节点当前被预留给他人时
     alert 明细并中止启动；返回 'reserved' 供调用方区分（运行弹窗保持打开，可摘掉被预留节点后重试）。
     typeof 守卫：vm 抽取测试无该函数时按无预留处理 */
  if(typeof envReservationIssue==='function'){
    const resIssue=envReservationIssue(envs);
    if(resIssue){ alert(resIssue); return 'reserved'; }
  }
  const env = envs.map(e=>e.ip).join('，');
  const image = opts.image || DEFAULT_IMAGE;
  const release = image;
  const repoId = opts.repoId || $('repoSel').value;
  const branch = opts.branch || ($('branchName').value.trim()||'main');
  const by = opts.by || (currentUsername||'anonymous');
  const strategy = opts.strategy!==undefined ? opts.strategy : curStrategy();
  const presets = Array.isArray(opts.presets) ? opts.presets.slice() : selectedPresetKeys();
  /* 权重路径（可选）：显式传参（弹窗/队列快照，含空串=不注入）优先，否则读主控「权重路径」当前值 */
  const weightsPath = opts.weightsPath!==undefined ? String(opts.weightsPath||'').trim() : curWeightsPath();
  const item={id:'q'+Date.now().toString(36)+Math.random().toString(16).slice(2,5),
    env, envs, image, release, repoId, repoName:(resolveRepo(repoId)||{}).name||'', branch, strategy, presets, weightsPath, by, source:opts.source||'manual', queuedAt:Date.now(),
    settings: opts.settings || (typeof runSettingsSnapshot==='function' ? runSettingsSnapshot() : null)};   // 入队即取设置副本：出队启动沿用入队时设置，不受排队期间修改影响
  if(opts.stages){ item.stages=opts.stages; item.pipelineName=opts.pipelineName||'(自定义)'; item.pipelineId=opts.pipelineId||null; }
  else { item.stages=pl.stages.map(s=>{ try{ return JSON.parse(JSON.stringify(s)); }catch(e){ return {...s}; } }); item.pipelineName=pl.name; item.pipelineId=pl.id; }
  /* 「需本地运行」意味着目标服务只保证浏览器可达，不能交给 dsh 服务进程 fetch；复用既有页内并发、
     机器互斥和节点租约调度。全部普通阶段都支持定时时，仍提交服务端权威队列。 */
  if(Array.isArray(item.stages) && item.stages.some(s=>s && !s.preset && !s.sched)){
    const pendingLeaseCount=(typeof pendingLeaseStarts==='undefined')?0:pendingLeaseStarts.length;
    const slotAvailable=(typeof MAX_ACTIVE_RUNS==='undefined'||typeof activeRuns==='undefined'||activeRuns.length+pendingLeaseCount<MAX_ACTIVE_RUNS);
    if(slotAvailable && !conflictsActive(item) && !queue.some(q=>machineConflict(q,item))){
      const started=startRun(item);
      /* 节点租约在途（队列区「申请节点中」）也立即把编排区/阶段详情切到该次任务的排队预览；
         租约拿到后 startSimRun 接过焦点。无租约环节同步启动时焦点已是真实运行，不再覆盖回预览。 */
      if(typeof isPendingQueueItem==='function'&&typeof focusQueueItem==='function'&&isPendingQueueItem(item)) focusQueueItem(item.id);
      return started;
    }
    if(queue.length+pendingLeaseCount>=QUEUE_CAP) return false;
    queue.push(item);
    renderQueue();
    if(typeof focusQueueItem==='function') focusQueueItem(item.id);   // 手动运行入队即把编排区/阶段详情切到该次排队（只读预览）；启动后 startSimRun 跟随成运行视图
    return 'queued';
  }
  submitServerRun(item);
  return 'submitted';
}
/* 机器占用判定：按目标环境 IP 集合是否相交。任一方无目标 IP（未选环境）时按冲突处理——
   无目标信息的运行保持旧版串行语义，不与任何运行并行 */
function runIps(x){ const s=new Set(); (((x&&x.envs)||[])).forEach(e=>{ const ip=String((e&&e.ip)||'').trim(); if(ip) s.add(ip); }); return s; }
function machineConflict(a,b){
  const A=runIps(a), B=runIps(b);
  if(!A.size || !B.size) return true;
  for(const ip of A){ if(B.has(ip)) return true; }
  return false;
}
function conflictsActive(item){
  if(activeRuns.some(rc=>machineConflict(rc,item))) return true;
  /* 租约申请在途的启动同样视为占用：startRun 异步等租约期间运行尚未进 activeRuns，
     不占住的话快速连续运行/同一次 drain 会越过页内互斥（测试沙盒无此变量时按无在途处理） */
  if(typeof pendingLeaseStarts!=='undefined' && pendingLeaseStarts.some(p=>machineConflict(p,item))) return true;
  return false;
}

/* ---------- 节点占用租约（服务端权威互斥） ---------- */
async function nodeLeaseRequest(body){
  const resp=await fetch(NODE_LEASE_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(resp.ok) return await resp.json();
  /* 节点预留冲突（403 {error:'reserved', message}）：不能走下方「服务端不可达」抛错降级
     （acquire 调用方会把异常当作旧插件无租约路由而照跑不误），以 {ok:false, reserved:true, message}
     返回，由 acquire 调用方 alert 服务端说明并按启动失败收尾（不进入运行、不回队等待——
     预留期内回队重试必然同样被拒，只会反复打扰） */
  let payload=null; try{ payload=await resp.json(); }catch(e){}
  if(resp.status===403 && payload && payload.error==='reserved') return {ok:false, reserved:true, message:String(payload.message||'节点已被预留')};
  throw new Error('node lease http '+resp.status);
}
function releaseNodeLease(leaseId, ips){
  if(!leaseId) return;
  nodeLeaseRequest({action:'release', runId:leaseId, ips:ips||[]}).catch(()=>{});   // 失败静默：TTL 到期自动清理
}
/* 并行排空：从头扫描队列，目标机器与「在跑运行 + 排在前面的排队任务」均不相交的项立即启动；
   相交项留在队列等待（同一机器保持先进先出，不同机器的排队任务可被后来者超越）。
   每启动一项就重新扫描：startRun 可能同步结束运行（全跳过阶段）或校验失败递归 drainQueue，队列/在跑集合已变 */
function drainQueue(){
  let again=true;
  while(again){
    const pendingLeaseCount=(typeof pendingLeaseStarts==='undefined')?0:pendingLeaseStarts.length;
    if(activeRuns.length+pendingLeaseCount>=MAX_ACTIVE_RUNS) return;
    again=false;
    for(let i=0;i<queue.length;i++){
      const it=queue[i];
      if(it.nodeWait && it.nodeWait.until>Date.now()) continue;   // 节点被他端占用刚被拒：节流重试（到点后重新申请租约）；不阻塞异机后来者
      if(conflictsActive(it)) continue;
      let blocked=false;
      for(let j=0;j<i;j++){ if(machineConflict(queue[j],it)){ blocked=true; break; } }
      if(blocked) continue;
      queue.splice(i,1);
      try{ startRun(it); }catch(e){ console.warn('[queue] 排队任务启动失败（继续排空其余任务）:', e); }
      again=true; break;
    }
  }
}
function cancelQueue(id){ if(typeof queueFinishedNote==='function') queueFinishedNote(id);   // 排队取消属正常终态化：登记进 completed，豁免孤儿判定
  queue=queue.filter(q=>q.id!==id); if(typeof queueReasonOpen!=='undefined') queueReasonOpen.delete(id); renderQueue(); }
function sourceLabel(s){ if(!s||s==='manual') return '手动'; if(s==='local') return '本地执行'; if(s==='schedule'||s.indexOf('schedule:')===0) return '定时'; return s; }

/* 本地运行队列视图还包含「已出队、正在申请节点租约、尚未进入 activeRuns」的短暂状态。
   统一从这里取数，确保列表、点击预览与跨浏览器快照对该过渡状态口径一致。 */
function localQueueItems(){
  const items=queue.slice();
  if(typeof pendingLeaseStarts!=='undefined') pendingLeaseStarts.forEach(p=>{
    const item=p&&p.queueItem;
    if(item&&!items.some(q=>q===item||(String(item.id||'')&&String(q&&q.id||'')===String(item.id)))) items.push(item);
  });
  return items;
}
function isPendingQueueItem(item){
  if(typeof pendingLeaseStarts==='undefined') return false;
  return pendingLeaseStarts.some(p=>p&&p.queueItem&&(p.queueItem===item||(String(item&&item.id||'')&&String(p.queueItem.id||'')===String(item.id))));
}

/* 排队项详情预览：点击队列中的排队任务，编排区只读展示该次排队的阶段编排（预设任务按入队勾选快照展开，
   与 startSimRun 同一 expandRunStages 路径）与运行参数快照（环境/仓库/分支/策略/执行人）。
   预览 rc 不进 activeRuns、带 queuedPreview 标记、over=true——引擎不感知，停止/重试/归档目标均不指向它；
   该项启动时 startSimRun 把焦点切给真实运行，被取消/启动失败时由 renderQueue 开头的自愈清回空闲编排 */
function queuePreviewRc(item){
  const stages=expandRunStages(item.stages||[], item.presets);
  const rc={id:item.id, queuedPreview:true, over:true,
    stages:stages, nodes:{}, selId:stages.length?stages[0].id:null, timer:null,
    env:item.env, envs:item.envs, image:item.image||DEFAULT_IMAGE, release:item.release||item.image||DEFAULT_IMAGE,
    commit:'—', tag:'—', archive:null, startTs:item.queuedAt||Date.now(), by:item.by, source:item.source||'manual',
    pipelineId:item.pipelineId||null, pipelineName:item.pipelineName||'(自定义)',
    repoId:item.repoId||null, repoName:item.repoName||'', repoUrl:'', giturl:GITURL,
    branch:item.branch||'main', strategy:item.strategy||'', vars:{}, token:0,
    overall:{txt:'排队中（预览）', cls:'dshell-badgeWait', color:''}};
  stages.forEach(s=>{ rc.nodes[s.id]={status:'idle',progress:0,dur:0,sub:{}}; });
  return rc;
}
function serverSubmissionPreviewRc(item){
  const rc=queuePreviewRc(item);
  rc.serverSubmitting=true;
  rc.overall={txt:'提交中…',cls:'dshell-badgeWait',color:''};
  return rc;
}
function clearServerSubmissionPreview(itemId){
  if(!viewRc||viewRc.serverSubmitting!==true||(itemId&&String(viewRc.id)!==String(itemId))) return;
  viewRc=null;
  if(typeof syncViewRun==='function') syncViewRun();
  if(typeof applyRunOverall==='function') applyRunOverall(null);
  if(typeof refreshArchiveTip==='function') refreshArchiveTip();
  if(typeof resetNodes==='function') resetNodes();
}
function focusQueueItem(id){
  if(viewRc && viewRc.queuedPreview===true && viewRc.id===id) return;   // 已在预览该排队项，避免重复重建
  const item=localQueueItems().find(q=>q.id===id); if(!item) return;
  focusRun(queuePreviewRc(item));
}

/* 服务端权威队列与旧浏览器在场条目的详情：只消费服务端白名单后的阶段/状态快照，不进入本页执行引擎。
   running 展示实时状态，queued 展示全部 idle 的待运行编排；普通队列快照不传日志、脚本参数和凭据，
   仅在用户查看服务端运行时按 runId + stageId 单独拉取该阶段的有界日志尾部。 */
function remoteQueueDetailAvailable(item){
  return !!(item&&String(item.id||'').trim()&&Array.isArray(item.stages)&&item.stages.some(stage=>stage&&String(stage.id||'').trim()));
}
function remoteQueueDetailHint(item){
  return remoteQueueDetailAvailable(item)?'':'<div class="dshell-muted" style="font-size:10px;font-weight:normal;">来源页面需刷新，暂无阶段快照</div>';
}
/* 在 server.finished 终态登记中按 id 查条目（完成≠失联的服务端权威依据；抽取测试缺省全局时按未登记处理） */
function remoteFinishedOf(runId){
  const id=String(runId||''); if(!id) return null;
  const list=(typeof remoteServerFinished!=='undefined'&&Array.isArray(remoteServerFinished))?remoteServerFinished:[];
  return list.find(e=>String(e&&e.id||'')===id)||null;
}
/* 正在查看的服务端运行进入终态后的收尾预览：保留最后已知阶段快照（终态条目 stages:[{stage,status,dur}]
   摘要按阶段名/id 对应上的节点收尾到终态），overall 换成终态徽标；rc.remoteFinished 标记终态——
   pullRemoteQueueLog 据此停止日志轮询，预览与快照脱钩保持只读展示（直到用户切换视图），
   不再因条目 TTL 消失而被重置回空闲编排。 */
function remoteFinishedPreviewRc(previous, fin){
  const next=Object.assign({}, previous);
  const status=String(fin&&fin.status||'');
  next.remoteFinished={id:String(fin&&fin.id||''), status:status, endedAt:Number(fin&&fin.endedAt)||0};
  next.over=true;
  const label={success:'成功',failure:'失败',cancelled:'已取消'}[status]||'已结束';
  next.overall={txt:'服务端运行已结束：'+label+'（只读）', cls:'dshell-badgeDone', color:status==='failure'?'var(--st-err)':(status==='cancelled'?'var(--st-idle)':'')};
  /* 终态条目 stages 的 stage 字段是阶段名（服务端契约，状态已按白名单归一：success/failed/skipped/aborted/idle）；
     按 id 优先、名称兜底对应预览阶段节点；只把运行中/未开始的节点收尾到终态，已完成节点保持原样 */
  const stageStatus={success:'success',failure:'failed',failed:'failed',cancelled:'aborted',aborted:'aborted',skipped:'skipped'};
  (Array.isArray(fin&&fin.stages)?fin.stages:[]).forEach(fs=>{
    const key=String(fs&&fs.stage||'');
    const mapped=stageStatus[String(fs&&fs.status||'').toLowerCase()]||'';
    if(!key||!mapped||!next.nodes) return;
    let stg=(Array.isArray(next.stages)?next.stages:[]).find(x=>String(x&&x.id||'')===key)||(Array.isArray(next.stages)?next.stages:[]).find(x=>String(x&&x.name||'')===key);
    /* 终态条目里有、预览阶段列表缺（如混合编排本地前缀未进快照）：补进列表，远端详情展示完整阶段 */
    if(!stg){
      stg={id:key, name:key, ...(fs.local?{local:true}:{})};
      if(!Array.isArray(next.stages)) next.stages=[];
      next.stages.push(stg);
    }else if(fs.local && stg.local===undefined){
      stg=Object.assign({}, stg, {local:true});
      next.stages=next.stages.map(x=>x===stg||String(x&&x.id||'')===String(stg.id||'')?stg:x);
    }
    const sid=stg?String(stg.id||''):'';
    if(!sid) return;
    if(!next.nodes[sid]) next.nodes[sid]={status:'idle',progress:0,dur:0,sub:{}};
    const node=Object.assign({}, next.nodes[sid]);
    if(node.status==='running'||node.status==='idle'){ node.status=mapped; if(mapped==='success') node.progress=100; }
    const d=Number(fs&&fs.dur); if(Number.isFinite(d)&&d>0) node.dur=d;
    const st0=Number(fs&&fs.startedAt); if(Number.isFinite(st0)&&st0>0) node.startedAt=st0;   // 终态摘要携带的阶段开始时间补进预览节点
    next.nodes[sid]=node;
  });
  return next;
}
function remoteQueuePreviewRc(client,item,kind){
  const stages=(Array.isArray(item&&item.stages)?item.stages:[]).map(queueStagePresence).filter(Boolean);
  const incomingNodes=item&&item.nodes&&typeof item.nodes==='object'?item.nodes:{};
  const previewNodes={};
  /* 运行中阶段带 startedAt（纪元毫秒）时按本地时钟把 dur 折算为实时已耗时（服务端快照运行期 dur 恒为 0；
     时钟偏差折出负值时钳到 0），无 startedAt 的旧数据保持原 dur 不动 */
  stages.forEach(s=>{ const n=previewNodes[s.id]=queueNodePresence(incomingNodes[s.id]);
    if(n.status==='running'&&Number.isFinite(n.startedAt)&&n.startedAt>0) n.dur=Math.max(0,(Date.now()-n.startedAt)/1000); });
  const runningKind=kind==='running';
  const serverOwned=String(client&&client.id||'')==='server';
  return {id:'remote:'+String(client&&client.id||'')+':'+kind+':'+String(item&&item.id||''), remotePreview:true, over:true,
    remoteClientId:String(client&&client.id||''), remoteClientLabel:String(client&&(client.label||client.id)||'其他浏览器'),
    remoteItemId:String(item&&item.id||''), remoteKind:runningKind?'running':'queued',
    stages:stages, nodes:previewNodes, remoteLogs:{}, selId:stages.length?stages[0].id:null, timer:null,
    env:item&&item.env||'', envs:[], image:'', release:'',
    archive:(item&&item.archive)||null,   // 归档目录随快照透传：跨浏览器可展示/打开正确日志路径（未同步时为 null，stageLogFileFor 返回空）
    commit:'—', tag:(item&&item.tag)||'—', startTs:(runningKind?item&&item.startedAt:item&&item.queuedAt)||Date.now(), by:item&&item.by||'—', source:item&&item.source||'manual',
    pipelineId:item&&item.pipelineId||null, pipelineName:item&&item.pipelineName||'(自定义)',
    repoId:null, repoName:item&&item.repoName||'', repoUrl:'', giturl:GITURL,
    branch:item&&item.branch||'main', strategy:item&&item.strategy||'', vars:{}, token:0,
    overall:{txt:serverOwned?(runningKind?'服务端运行中（只读）':'服务端排队中（只读）'):(runningKind?'他端运行中（只读）':'他端排队中（只读）'), cls:'dshell-badgeWait', color:''}};
}
function remoteQueueItem(clientId,itemId,kind){
  const client=remoteQueueClients.find(c=>String(c&&c.id||'')===String(clientId));
  if(!client) return null;
  const items=kind==='running'?remoteRunsOf(client):(Array.isArray(client.queue)?client.queue:[]);
  const item=items.find(entry=>String(entry&&entry.id||'')===String(itemId));
  return item&&remoteQueueDetailAvailable(item)?{client,item}:null;
}
function focusRemoteQueueItem(clientId,itemId,kind){
  if(viewRc&&viewRc.remotePreview===true&&viewRc.remoteClientId===String(clientId)&&viewRc.remoteItemId===String(itemId)&&viewRc.remoteKind===kind) return;
  const found=remoteQueueItem(clientId,itemId,kind); if(!found) return;
  focusRun(remoteQueuePreviewRc(found.client,found.item,kind));
  if(typeof pullRemoteQueueLog==='function') pullRemoteQueueLog();
}
function focusServerRunById(runId){
  const id=String(runId||''); if(!id) return false;
  if(remoteQueueItem('server',id,'running')){ focusRemoteQueueItem('server',id,'running'); return true; }
  if(remoteQueueItem('server',id,'queued')){ focusRemoteQueueItem('server',id,'queued'); return true; }
  return false;
}
function followPendingServerRun(){
  const pend=pendingServerRunFocus; if(!pend) return;
  if(Date.now()>pend.until){ pendingServerRunFocus=null; clearServerSubmissionPreview(pend.previewId); return; }
  if(focusServerRunById(pend.runId)) pendingServerRunFocus=null;
}
function refreshRemoteQueuePreviewRc(previous){
  if(!previous||previous.remotePreview!==true) return previous||null;
  /* 已进入终态的服务端运行预览：与快照脱钩保持展示（终态收尾在首次进入 finished 的那次刷新完成，
     remoteFinished 标记后日志轮询已停）；条目 TTL 消失也不再重置视图，直到用户切换。 */
  if(previous.remoteFinished) return previous;
  let kind=previous.remoteKind;
  let found=remoteQueueItem(previous.remoteClientId,previous.remoteItemId,kind);
  /* 服务端权威条目排队→在跑沿用同一 runId，按同 id 直接续看；旧浏览器在场条目启动后另分配 r... id，
     用入队 id 关联 q... → r...，避免正在查看的排队详情在任务启动的那次轮询里突然消失。 */
  if(!found&&kind==='queued'){
    const client=remoteQueueClients.find(c=>String(c&&c.id||'')===String(previous.remoteClientId));
    const runs=client?remoteRunsOf(client):[];
    const item=runs.find(entry=>String(entry&&entry.id||'')===String(previous.remoteItemId)&&remoteQueueDetailAvailable(entry))
      ||runs.find(entry=>String(entry&&entry.originQueueId||'')===String(previous.remoteItemId)&&remoteQueueDetailAvailable(entry));
    if(item){ found={client,item}; kind='running'; }
  }
  if(!found){
    /* 服务端条目从快照消失：优先查 server.finished 权威终态（完成≠失联），优雅收尾展示终态，
       而不是把正在查看的编排区清空回空闲；旧服务端无 finished 数据时维持原消失即重置行为。 */
    const fin=previous.remoteClientId==='server'?remoteFinishedOf(previous.remoteItemId):null;
    if(fin) return remoteFinishedPreviewRc(previous,fin);
    return null;
  }
  const next=remoteQueuePreviewRc(found.client,found.item,kind);
  if(next.stages.some(s=>s.id===previous.selId)) next.selId=previous.selId;
  next.remoteLogs=previous.remoteLogs||{};
  return next;
}
function applyRemoteQueuePreviewRefresh(){
  if(!viewRc||viewRc.remotePreview!==true||viewRc.orphanPreview===true) return;   // 孤儿预览由 applyOrphanPreviewRefresh 照看（条目在 remoteOrphans，不在 remoteQueueClients）
  const next=refreshRemoteQueuePreviewRc(viewRc);
  if(!next){
    viewRc=null; syncViewRun(); applyRunOverall(null);
    refreshArchiveTip(); resetNodes();
    return;
  }
  viewRc=next; syncViewRun(); applyRunOverall(next); _detailKey='';
  refreshArchiveTip(); renderFlow(); renderDetail();
}

/* 孤儿中断条目（服务端孤儿登记簿）：来源页面刷新/关闭后，其上报快照里的运行/排队条目失去宿主
   （执行引擎随页面销毁，属于中断），服务端把它们登记为孤儿供各浏览器找回。这里提供只读预览：
   复用 remoteQueuePreviewRc 的快照→rc 机制（rc 标记 orphanPreview，兼带 remotePreview 只读语义；
   详情日志走 detailLogLinesFor 的中断文案，不经 pullRemoteQueueLog——日志通道只服务 server 客户端）。 */
function orphanQueueItem(ownerId,id){
  const list=(typeof remoteOrphans!=='undefined'&&Array.isArray(remoteOrphans))?remoteOrphans:[];
  return list.find(o=>String(o&&o.ownerId||'')===String(ownerId)&&String(o&&o.id||'')===String(id))||null;
}
function orphanPreviewRc(orphan){
  const stages=(Array.isArray(orphan&&orphan.stages)?orphan.stages:[]).map(queueStagePresence).filter(Boolean);
  const incomingNodes=orphan&&orphan.nodes&&typeof orphan.nodes==='object'?orphan.nodes:{};
  const previewNodes={};
  stages.forEach(s=>{ previewNodes[s.id]=queueNodePresence(incomingNodes[s.id]); });
  const queued=orphan&&orphan.kind==='queued';
  return {id:'orphan:'+String(orphan&&orphan.ownerId||'')+':'+String(orphan&&orphan.id||''), remotePreview:true, orphanPreview:true, over:true,
    remoteClientId:String(orphan&&orphan.ownerId||''), remoteClientLabel:String(orphan&&(orphan.ownerLabel||orphan.ownerId)||'来源页面'),
    remoteItemId:String(orphan&&orphan.id||''), remoteKind:queued?'queued':'running',
    stages:stages, nodes:previewNodes, remoteLogs:{}, selId:stages.length?stages[0].id:null, timer:null,
    env:orphan&&orphan.env||'', envs:[], image:'', release:'',
    archive:(orphan&&orphan.archive)||null,   // 归档目录随孤儿快照透传（来源页面登记时已含）；未同步时为 null
    commit:'—', tag:(orphan&&orphan.tag)||'—', startTs:(queued?orphan&&orphan.queuedAt:orphan&&orphan.startedAt)||orphan&&orphan.orphanedAt||Date.now(), by:orphan&&orphan.by||'—', source:orphan&&orphan.source||'manual',
    pipelineId:orphan&&orphan.pipelineId||null, pipelineName:orphan&&orphan.pipelineName||'(自定义)',
    repoId:null, repoName:orphan&&orphan.repoName||'', repoUrl:'', giturl:GITURL,
    branch:orphan&&orphan.branch||'main', strategy:orphan&&orphan.strategy||'', vars:{}, token:0,
    overall:{txt:queued?'排队中断（只读·最后已知状态）':'已中断（只读·最后已知状态）', cls:'dshell-badgeWait', color:''}};
}
function focusOrphanQueueItem(ownerId,id){
  if(viewRc&&viewRc.orphanPreview===true&&viewRc.remoteClientId===String(ownerId)&&viewRc.remoteItemId===String(id)) return;
  const orphan=orphanQueueItem(ownerId,id); if(!orphan) return;
  focusRun(orphanPreviewRc(orphan));
  /* 中断条目的日志不可拉取（pullRemoteQueueLog 只服务 server 客户端），这里刻意不触发日志拉取 */
}
/* 正在预览的孤儿被移除（dismiss）或复活（来源页面重新上报同 id）而从登记簿消失时，编排区自愈回
   空闲编排（处理口径同 applyRemoteQueuePreviewRefresh 的条目消失分支）。孤儿快照在服务端登记时已
   冻结，不随轮询变化，故只需处理「消失」，内容无需重建。 */
function applyOrphanPreviewRefresh(){
  if(!viewRc||viewRc.orphanPreview!==true) return;
  if(orphanQueueItem(viewRc.remoteClientId,viewRc.remoteItemId)) return;
  viewRc=null; syncViewRun(); applyRunOverall(null);
  refreshArchiveTip(); resetNodes();
}
