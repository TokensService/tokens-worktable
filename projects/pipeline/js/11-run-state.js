/* ===== 11-run-state.js · 运行状态、运行期设置快照、主视图节点拖拽改序 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 4833–5219）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */


/* ---------- 运行状态 ----------
   并行运行：不同流水线跑在不同机器（目标环境 IP 不相交）时可同时入队运行；同一机器的任务仍串行排队。
   每个在跑运行持有独立上下文 rc（stages/nodes/selId/timer/vars/token/over 等），引擎函数一律经参数
   操作 rc，不读写下方视图别名；curRun/runStages/nodes/selectedId 是「编排区当前展示运行」（viewRc，
   含已结束但留作结果视图的运行）的别名，视图切换时经 syncViewRun 重绑定。 */
function viewRun(){ return viewRc; }
function viewActive(){ return !!(viewRc && !viewRc.over); }   // 编排区展示的运行仍在跑（区别于「任一运行在跑」的 running）
/* 非 admin 用户不可中止/重置他人的流水线：admin 全权；password 模式下非 admin 仅可控制
   自己署名（by）的运行；token 模式（无用户身份）退化为全权，与既有行为一致。runOwner
   缺省时按「无法判定归属」处理——admin 仍可控制，非 admin 视为他人（拒绝）。 */
function canControlRun(by){
  if(!currentUsername) return true;                  // token 模式 / 未装 admin 插件：无用户身份概念，退化为全权
  if(currentUserIsAdmin) return true;                // admin 可控制任意运行
  return !!(by && by===currentUsername);             // 非 admin 仅可控制自己署名的运行
}
function runPreviewReadOnly(rc){
  return !!(rc && (rc.queuedPreview===true || rc.remotePreview===true));
}
function syncRunState(){ running = activeRuns.length>0; syncRunBtn(); }
/* 视图别名重绑定：curRun/runStages/nodes/selectedId 指向当前展示运行的对应字段（对象同引用，引擎写入即见） */
function syncViewRun(){
  const rc=viewRc;
  curRun=rc; runStages=rc?rc.stages:null; nodes=rc?rc.nodes:{};
  selectedId=rc?rc.selId:(curPipeline().stages[0]?curPipeline().stages[0].id:null);
}
function setSel(id){ selectedId=id; if(viewRc) viewRc.selId=id; }          // 视图层选中：写穿到 rc
function rootRunContext(rc){ return rc&&rc.parallelParent?rc.parallelParent:rc; }
function runSetSel(rc,id){ const root=rootRunContext(rc); rc.selId=id; if(root) root.selId=id; if(viewRc===root) selectedId=id; }   // 引擎层选中：聚焦时同步视图
/* 引擎侧渲染：仅当该运行正被编排区展示时落 DOM；rc.nodes/rc.stages 的写入不经过这里，始终生效 */
function rcRender(rc, withFlow){ const root=rootRunContext(rc); if(viewRc!==root) return; applyStatusClasses(); if(withFlow) renderFlow(); renderDetail(); }
/* 总状态徽标按运行各自留存：切换查看时恢复（含失败/终止的徽标配色） */
function rcOverall(rc,txt,cls,color){ const root=rootRunContext(rc); root.overall={txt:txt,cls:cls,color:color||''}; if(viewRc===root) applyRunOverall(root); }
function applyRunOverall(rc){
  const ov=rc?rc.overall:null;
  if(!rc || !ov){ setOverall('未运行',''); $('overallBy').textContent=''; return; }
  setOverall(ov.txt,ov.cls);
  if(ov.color){ const o=$('overall').firstChild; if(o){ o.style.color=ov.color; o.style.borderColor='color-mix(in srgb, '+ov.color+' 40%, transparent)'; } }
  $('overallBy').textContent='执行人：'+rc.by+(rc.source&&rc.source!=='manual'?' · 定时触发':'');
}
/* 切换编排区展示的运行（运行队列条目点击；排队项的只读详情预览也经此进入，见 focusQueueItem/queuePreviewRc）：退出历史回放、重绑别名、恢复徽标/归档提示 */
function focusRun(rc){
  if(viewRc===rc) return;
  if(replayRec){ replayRec=null; const rt=$('replayTip'); if(rt) rt.textContent=''; }
  viewRc=rc||null; syncViewRun(); applyRunOverall(viewRc);
  _detailKey='';
  refreshArchiveTip();
  renderFlow(); renderDetail(); renderQueue();
}
function lsGet(k, def){ try{ return localStorage.getItem(k) || def; }catch(e){ return def; } }
function randCommit(){ return Math.random().toString(16).slice(2,9); }
function nowHM(){ const d=new Date(); return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0'); }
function fmtDur(s){ if(s<60) return Math.round(s)+'s'; return Math.floor(s/60)+'m'+Math.round(s%60)+'s'; }
/* 阶段开始时间（纪元毫秒）→ 紧凑本地「MM-DD HH:MM:SS」；缺省/非法返回空串（调用方据此决定不展示） */
function fmtStageStart(ts){ const t=Number(ts); if(!Number.isFinite(t)||t<=0) return ''; const d=new Date(t); const p=n=>String(n).padStart(2,'0'); return p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
/* 阶段开始时间打点/沿用：进入 running 时写 startedAt；终态/中止/关页重建节点对象时以
   Object.assign({}, 旧节点, {终态字段}) 合并旧节点的方式沿用同一时刻（旧节点无该字段则不携带） */
/* 阶段「耗时/超时」内部一律按秒存储；编辑器输入框按分钟显示与填写（×60 换算，四舍五入回秒） */
function secToMinInput(sec){ const m=sec/60; return (m===Math.floor(m)) ? String(m) : String(Math.round(m*100)/100); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* 勾选判定：有 DOM checkbox（主控面板勾选项）读其 checked；自定义预设无 DOM（面板尚未渲染/沙盒）时回退配置的
   enabled；系统预设无 DOM 不回退（false） */
function presetOn(pkey){
  const def=presetDefOf(pkey); if(!def) return false;
  const el=$(def.el); if(el) return !!el.checked;
  if(def.custom){ const cp=((typeof customPresets!=='undefined'&&Array.isArray(customPresets))?customPresets:[]).find(c=>c && c.key===pkey); return !!(cp && cp.enabled); }
  return false;
}
function selectedPresetKeys(){ return presetOrderAll().filter(presetOn); }
/* 预设任务运行态节点：脚本取设置页当前配置的快照；未知 pkey 返回 null（调用方兜底） */
function presetRuntime(pkey){ const def=presetDefOf(pkey); if(!def) return null; const sc=def.script(); return {id:def.id, name:def.name, preset:true, pkey:pkey, script:sc?JSON.parse(JSON.stringify(sc)):null}; }
function presetMarker(pkey){ const def=presetDefOf(pkey); if(!def) return null; return {id:def.id, name:def.name, preset:true, pkey:pkey}; }
/* 阶段列表补齐缺失的预设标记（不改动原数组）：已有的保持原位置；缺失的按默认位置补——
   环境清理补到最前、环境检查紧跟环境清理、pos='first' 的自定义按数组顺序依次插到环境检查之后、
   Profiling 补到最后、pos='last' 的自定义按数组顺序插到已编排位置的 Profiling 标记之前（Profiling 未编排过位置则补到末尾）；
   pkey 已失效的预设标记行一律过滤（自定义预设被删除，或旧流水线的 promCollect 标记——已随「收集普罗数据」预设下线，见 migratePromPreset） */
function withPresetMarkers(stages){
  const out=(stages||[]).filter(s=>!(s && s.preset && !presetDefOf(s.pkey)));
  const has={}; out.forEach(s=>{ if(s && s.preset && s.pkey) has[s.pkey]=1; });
  if(!has.cleanup) out.unshift(presetMarker('cleanup'));
  if(!has.check){ const ci=out.findIndex(s=>s && s.preset && s.pkey==='cleanup'); out.splice(ci>=0?ci+1:0, 0, presetMarker('check')); }
  const customs=(typeof customPresets!=='undefined'&&Array.isArray(customPresets))?customPresets:[];
  let ai=out.findIndex(s=>s && s.preset && s.pkey==='check');
  customs.forEach(c=>{ if(c && c.pos!=='last' && !has[c.key]){ ai+=1; out.splice(ai,0,presetMarker(c.key)); } });
  if(!has.profiling) out.push(presetMarker('profiling'));
  const lasts=customs.filter(c=>c && c.pos==='last' && !has[c.key]);
  if(lasts.length){
    const pi=has.profiling ? out.findIndex(s=>s && s.preset && s.pkey==='profiling') : -1;
    lasts.forEach((c,idx)=>{ out.splice(pi>=0?pi+idx:out.length, 0, presetMarker(c.key)); });
  }
  return out;
}
/* ---------- 运行期设置快照（运行级隔离） ----------
   设置页配置（脚本目录 / Jenkins / EvalTokens / 普罗 / 归档）此前由各阶段执行时读全局变量：
   运行中途或下一次运行前的修改会渗进已经开跑的流水线（改 scriptsDir、换 Jenkins 令牌、换收集脚本等）。
   现在一次运行在入队/启动时深拷贝一份设置快照（rc.settings / 队列项 settings / 服务端 plan.settings），
   本次运行各阶段只读快照——下一次运行才取新设置。设置本身仍是用户隔离（运行行临时配置仅浏览器本地），
   此处在其上叠加「一运行一份副本」。 */
function runSettingsSnapshot(){
  const copy=(x)=>{ if(x==null) return x; try{ return JSON.parse(JSON.stringify(x)); }catch(e){ return null; } };
  return {
    scriptsDir: typeof scriptsDir==='string'?scriptsDir:'',
    jenkins: copy(jenkins)||{},
    evaltok: copy(evaltok)||{},
    prom: copy(prom)||{},
    archiveDir: typeof archiveDir==='string'?archiveDir:'',
    archiveScriptName: typeof archiveScriptName==='string'?archiveScriptName:'',
  };
}
function runSettingsOf(rc){ return (rc && rc.settings && typeof rc.settings==='object' && !Array.isArray(rc.settings)) ? rc.settings : null; }
function runScriptsDir(rc){
  const s=runSettingsOf(rc);
  return (s && typeof s.scriptsDir==='string' && s.scriptsDir) ? s.scriptsDir : (typeof scriptsDir==='string'?scriptsDir:'');
}
function runJenkinsCfg(rc){
  const s=runSettingsOf(rc);
  return (s && s.jenkins && typeof s.jenkins==='object' && !Array.isArray(s.jenkins)) ? s.jenkins : jenkins;
}
function runEvaltokCfg(rc){
  const s=runSettingsOf(rc);
  return (s && s.evaltok && typeof s.evaltok==='object' && !Array.isArray(s.evaltok)) ? s.evaltok : evaltokConfig();
}
function runPromCfg(rc){
  const s=runSettingsOf(rc);
  return (s && s.prom && typeof s.prom==='object' && !Array.isArray(s.prom)) ? s.prom : prom;
}
function runArchiveDir(rc){
  const s=runSettingsOf(rc);
  return (s && typeof s.archiveDir==='string') ? s.archiveDir : (typeof archiveDir==='string'?archiveDir:'');
}
function runArchiveScriptName(rc){
  const s=runSettingsOf(rc);
  return (s && typeof s.archiveScriptName==='string') ? s.archiveScriptName : (typeof archiveScriptName==='string'?archiveScriptName:'');
}
/* 预设任务展开（运行启动时）：阶段列表中的预设标记（旧流水线先按默认位置补齐）按主控「预设任务」
   勾选展开为本次运行的执行项（脚本取设置页当前配置快照）；未勾选/pkey 已失效的预设不进本次运行。
   普通阶段同样深拷贝——运行期不得与流水线定义共享嵌套对象（script/url/evaltokens/sub），
   否则下一次运行前对阶段的编辑会渗进已经开跑的副本。 */
function expandRunStages(rawStages, presetKeys){
  const hasPresetSnapshot=Array.isArray(presetKeys);
  const cloneStage=(s)=>{ try{ return JSON.parse(JSON.stringify(s)); }catch(e){ return {...s}; } };
  return withPresetMarkers(rawStages).flatMap(s=>{
    if(!s || !s.preset) return [cloneStage(s)];
    const enabled=hasPresetSnapshot ? presetKeys.indexOf(s.pkey)>=0 : presetOn(s.pkey);   // 队列传入开关快照时不受出队前 UI 改动影响
    const rt=enabled ? presetRuntime(s.pkey) : null;
    return rt ? [rt] : [];
  });
}
// 预设任务随阶段列表进入编排序列（位置即执行顺序）：展示时按勾选（空闲）/运行快照（运行态）/历史日志（回放）展开。
function flowStages(){
  if(replayRec){   // 回放：按该次运行历史里出现过的预设任务展开
    const logs=replayRec.logs||[];
    return (runStages||[]).flatMap(s=>{
      if(!s || !s.preset) return [s];
      if(!logs.some(l=>l && l.stage===s.name)) return [];
      const rt=presetRuntime(s.pkey); return rt?[rt]:[];
    });
  }
  if(runStages) return runStages;   // 运行态/运行后快照：启动时已按勾选展开（见 expandRunStages）
  return withPresetMarkers(activeStages()).flatMap(s=>{
    if(!s.preset) return [s];
    if(!presetOn(s.pkey)) return [];
    const rt=presetRuntime(s.pkey); return rt?[rt]:[];
  });
}
function pipelineStageGroups(stages){
  const list=Array.isArray(stages)?stages:[], groups=[];
  for(let i=0;i<list.length;){
    const first=list[i];
    if(first && !first.preset && first.parallel===true){
      let end=i+1;
      while(end<list.length && list[end] && !list[end].preset && list[end].parallel===true) end++;
      groups.push({start:i,end:end,parallel:true,stages:list.slice(i,end)}); i=end;
    }else{
      groups.push({start:i,end:i+1,parallel:false,stages:[first]}); i++;
    }
  }
  return groups;
}
function pipelineStageGroupAt(stages,index){
  return pipelineStageGroups(stages).find(group=>index>=group.start&&index<group.end)||null;
}
/* ===== 主视图节点拖拽改序（空闲态）：无需进编辑器即可调整执行顺序 =====
   复用编辑器的预设标记补齐（withPresetMarkers）与持久化（savePipelines）通道；
   运行中/运行后快照/历史回放/结果视图均为只读，由 flowDraggable() 统一守卫。 */
function flowDraggable(){ const p=curPipeline(); return !running && !runStages && !replayRec && !viewActive() && (!p || plEditable(p)); }   // 内置（视同可信，仅 admin 可编辑）与他人拥有的流水线对非 admin 只读（plEditable），主视图同样禁止拖拽改序
/* 工作列表：当前流水线阶段补齐缺失的预设标记（与 flowStages 同源）。
   真实阶段保留对象引用（含 script/url 等全部字段，原样回写）；预设标记按 id/name/pkey 轻量保存。 */
function flowWorkList(){ return withPresetMarkers((curPipeline().stages||[]).slice()); }
function clearFlowDragMarks(){
  document.querySelectorAll('#flow .pipeline-node').forEach(n=>n.classList.remove('flow-dragging','flow-drag-before','flow-drag-after'));
}
function flowNodeDragStart(e){
  const n=e.currentTarget; flowDragFromId=n.dataset.id;
  clearFlowDragMarks(); n.classList.add('flow-dragging');
  if(e.dataTransfer){ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',String(flowDragFromId||'')); }
}
function flowNodeDragOver(e){
  if(!flowDragFromId) return;
  e.preventDefault(); if(e.dataTransfer) e.dataTransfer.dropEffect='move';
  const n=e.currentTarget, overId=n.dataset.id; clearFlowDragMarks();
  const src=document.querySelector('#flow .pipeline-node.flow-dragging'); if(src) src.classList.add('flow-dragging');
  if(overId===flowDragFromId) return;   // 拖到自身：不提示插入位
  const rect=n.getBoundingClientRect(), after=e.clientX>=rect.left+rect.width/2;   // 横向：右半区=插到它后面
  n.classList.add(after?'flow-drag-after':'flow-drag-before');
}
function flowNodeDrop(e){
  if(!flowDragFromId) return;
  e.preventDefault();
  const fromId=flowDragFromId, overId=e.currentTarget.dataset.id;
  flowDragFromId=null; clearFlowDragMarks();
  if(fromId===overId) return;
  const work=flowWorkList();
  const fromW=work.findIndex(s=>s.id===fromId), overW=work.findIndex(s=>s.id===overId);
  if(fromW<0||overW<0) return;
  const rect=e.currentTarget.getBoundingClientRect(), after=e.clientX>=rect.left+rect.width/2;
  let to=overW+(after?1:0);   // 源卡移除会让后方插槽左移一位
  if(fromW<to) to-=1;
  to=Math.max(0,Math.min(work.length-1,to));
  if(to===fromW) return;
  const moved=work.splice(fromW,1)[0]; work.splice(to,0,moved);
  persistFlowOrder(work);
}
function flowNodeDragEnd(){ flowDragFromId=null; clearFlowDragMarks(); }
/* 落盘：工作列表回写为 stages（预设标记随位置保存，并清掉旧顶层 prom），与编辑器 savePlForm 的归一化一致 */
function persistFlowOrder(orderedWork){
  const p=curPipeline(); if(!p||!plEditable(p)) return;   // 内置（视同可信）与他人拥有的流水线对非 admin 只读（plEditable），不写回（入口已由 flowDraggable 拦截，此处兜底）
  p.stages=orderedWork.map(s=> s.preset
    ? {id:s.id,name:s.name,preset:true,pkey:s.pkey}
    : s);
  delete p.prom;
  /* 拖拽改序也是一次修改：署名最后修改人（typeof 守卫：独立测试片段里可能没有这些全局） */
  const me=(typeof currentUsername!=='undefined'&&currentUsername)||'';
  if(me) p.updatedBy=me;
  savePipelines();
  renderPipelines(); renderFlow(); renderDetail();
}
function createFlowNode(s, i){
    const n=document.createElement('div');
    n.className='pipeline-node';
    n.dataset.id=s.id;
    n.innerHTML =
      '<div class="pipeline-nodeName">'+(s.parallel===true&&!s.preset?'<span title="并行任务">⚡</span> ':'')+(s.sched?'<span style="color:var(--st-wait)" title="定时阶段（跟随流水线定时计划）">⏰</span> ':'')+(s.promCollect?'<span title="收集普罗数据：本任务进入终态（成功/失败）后按其起止时段采集普罗指标到归档目录">📊</span> ':'')+esc(s.name)+'</div>'+
      (s.preset?'<span class="pipeline-preset" title="预设任务，执行顺序在流水线编辑中调整；脚本在设置页配置">🔒 系统预设</span>':'')+
      '<div class="pipeline-bar"><i></i></div>'+
      '<div class="pipeline-nodeMeta"></div>'+
      (s.sub&&s.sub.length?('<div class="pipeline-sub">'+s.sub.map(x=>'<span data-sub="'+esc(x)+'">'+esc(x)+'</span>').join('')+'</div>'):'');
    /* 选中态由 applyStatusClasses 更新即可；不能在这里 renderFlow()，
       否则第一次单击就重建节点元素，第二次单击落在新元素上，dblclick 永远触发不了 */
    n.addEventListener('click',()=>{
      setSel(s.id); applyStatusClasses(); renderDetail();
      if(typeof pullRemoteQueueLog==='function') pullRemoteQueueLog();
      if(replayRec){
        const rec=replayRec;
        loadReplayLog(rec,s.name).then(()=>{ if(replayRec===rec && selectedId===s.id){ _detailKey=''; renderDetail(); } });
      }
    });
    /* 双击编辑：编排区可能显示某次运行的快照（runStages），此时编辑对象应是该次运行的流水线，
       而不是主控当前选中的流水线；openPlForm 内另有 id 失效兜底 */
    n.addEventListener('dblclick',()=>{
      if(viewActive() || replayRec || runPreviewReadOnly(curRun) || s.preset) return;   // 系统预设任务、排队/他端快照与回放态只读
      const pid=(runStages && curRun && curRun.pipelineId && findPipeline(curRun.pipelineId)) ? curRun.pipelineId : curPipelineId;
      openPlForm(pid, withPresetMarkers(activeStages()).findIndex(x=>x.id===s.id));   // 焦点序号按补齐预设标记后的列表计算，与编辑器行序一致
    });
    const plNodeCur=curPipeline();   // 节点 title 按归属区分：内置/可信（非 admin）只读 / 他人拥有的只读（标注拥有者，经 plOwnerOf 取值）/ 可编辑
    n.title=s.preset?('系统预设任务，单击查看详情；执行顺序在流水线编辑中调整，脚本在设置页配置'):((plNodeCur&&plNodeCur.builtIn&&!plEditable(plNodeCur))?'单击查看详情，双击查看该阶段（可信流水线只读：仅 admin 可编辑）':((plNodeCur&&!plEditable(plNodeCur))?'单击查看详情，双击查看该阶段（拥有者 @'+plOwnerOf(plNodeCur)+'，只读）':'单击查看详情，双击编辑该阶段'));
    /* 空闲态主视图直接拖拽改序：置 draggable 并挂载处理器；运行/回放态只读，不挂载 */
    if(flowDraggable()){
      n.draggable=true; n.title+='；可拖拽调整执行顺序';
      n.addEventListener('dragstart',flowNodeDragStart);
      n.addEventListener('dragover',flowNodeDragOver);
      n.addEventListener('drop',flowNodeDrop);
      n.addEventListener('dragend',flowNodeDragEnd);
    }
    return n;
}
function renderFlow(){
  const f = $('flow'); f.innerHTML='';
  pipelineStageGroups(flowStages()).forEach(group=>{
    if(f.children.length){ const c=document.createElement('div'); c.className='pipeline-conn'; f.appendChild(c); }
    if(group.parallel && group.stages.length>1){
      const box=document.createElement('div'); box.className='pipeline-parallelGroup'; box.style.gap='0';
      const title=document.createElement('div'); title.className='pipeline-parallelTitle'; title.innerHTML='⚡ 并行组'; box.appendChild(title);
      const railIn=document.createElement('div'); railIn.className='pipeline-parallelRailIn'; railIn.style.borderRight='2px solid var(--dsw-alias-border-l2)'; box.appendChild(railIn);
      const tasks=document.createElement('div'); tasks.className='pipeline-parallelTasks'; tasks.style.flexDirection='column';
      group.stages.forEach((s,offset)=>{
        const row=document.createElement('div'); row.className='pipeline-parallelTaskRow'; row.style.display='flex';
        const branchIn=document.createElement('div'); branchIn.className='pipeline-parallelBranchIn'; row.appendChild(branchIn);
        row.appendChild(createFlowNode(s,group.start+offset));
        const branchOut=document.createElement('div'); branchOut.className='pipeline-parallelBranchOut'; row.appendChild(branchOut);
        tasks.appendChild(row);
      });
      box.appendChild(tasks);
      const railOut=document.createElement('div'); railOut.className='pipeline-parallelRailOut'; railOut.style.borderLeft='2px solid var(--dsw-alias-border-l2)'; box.appendChild(railOut);
      f.appendChild(box);
    }else{
      f.appendChild(createFlowNode(group.stages[0],group.start));
    }
  });
  applyStatusClasses();
}
/* 阶段 id / 子阶段名可能来自其他浏览器的在场快照；按 dataset 精确比较，避免把不可信值拼进 CSS selector。 */
function flowNodeElementById(id){
  const wanted=String(id), all=document.querySelectorAll('.pipeline-node[data-id]');
  for(let i=0;i<all.length;i++) if(all[i].dataset&&all[i].dataset.id===wanted) return all[i];
  return null;
}
function flowSubElementByName(node,name){
  const wanted=String(name), all=node.querySelectorAll('.pipeline-sub span[data-sub]');
  for(let i=0;i<all.length;i++) if(all[i].dataset&&all[i].dataset.sub===wanted) return all[i];
  return null;
}
function applyStatusClasses(){
  flowStages().forEach(s=>{
    const el = flowNodeElementById(s.id);
    if(!el) return;
    const st = nodes[s.id] ? nodes[s.id].status : 'idle';
    el.classList.remove('run','ok','fail','skip','abort','sel');
    if(st==='running') el.classList.add('run');
    if(st==='success') el.classList.add('ok');
    if(st==='failed')  el.classList.add('fail');
    if(st==='skipped') el.classList.add('skip');
    if(st==='aborted') el.classList.add('abort');
    if(st==='idle' && s.skip) el.classList.add('skip');   // 配置「不执行」：未运行即以虚线/弱化样式提示（运行后由 skipStage 置 skipped）
    if(s.id===selectedId) el.classList.add('sel');
    const bar = el.querySelector('.pipeline-bar > i');
    const nd = nodes[s.id];
    if(nd){ bar.style.width=(nd.progress||0)+'%';
      if(st==='success') bar.style.width='100%';
    } else { bar.style.width='0%'; }
    const meta = el.querySelector('.pipeline-nodeMeta');
    meta.textContent = metaFor(s.id);
    if(s.sub && s.sub.length){
      s.sub.forEach(x=>{
        const sp = flowSubElementByName(el,x);
        if(sp){ sp.className=''; const ss=nodes[s.id]&&nodes[s.id].sub?nodes[s.id].sub[x]:'idle';
          if(ss==='running') sp.classList.add('run');
          else if(ss==='success') sp.classList.add('ok');
          else if(ss==='failed') sp.classList.add('fail');
        }
      });
    }
  });
}
function metaFor(id){
  const n=nodes[id], st=n?n.status:'idle';
  if(st==='success') return '✓ '+fmtDur(n.dur);
  if(st==='failed')  return '✗ 错误 · '+fmtDur(n.dur||0);
  if(st==='skipped') return '⏭ 跳过';
  if(st==='aborted') return '⏏ 终止 · '+fmtDur(n.dur||0);
  if(st==='running') return Math.round(n.progress||0)+'% · '+fmtDur(n.dur||0);
  if(st==='idle'){ const s=activeStages().find(x=>x.id===id); if(s&&s.skip) return '⊘ 不执行'; }   // 未运行且配置「不执行」：编排区节点元信息显示
  return '';
}
