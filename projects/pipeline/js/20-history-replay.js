/* ===== 20-history-replay.js · 历史与统计、历史回放 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 9838–10685）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* ---------- 历史回放：点击运行历史行，把该次运行同步到编排区 / 回显框 / 主控控件 ----------
   replayRec 非空 = 正在回放该条历史：编排区显示该次运行的阶段快照（runStages 语义）与状态/耗时，
   详情与回显取自 rec.logs；再次点击该行、手动切换流水线、新运行或「重置」退出回放。 */
/* 回放日志按当前选中阶段懒加载：详情只展示最后 20 行，故请求文件末尾 64KiB，避免全量读取/传输大日志。
   旧插件不识别 tailBytes 时仍会返回全文，页面逻辑保持兼容；缓存到 rec._lc，_lm 记录是否截尾及原文件大小。 */
async function loadReplayLog(rec, stageName){
  const logs=Array.isArray(rec.logs)?rec.logs:[];
  if(!rec._lc) rec._lc={};
  if(!rec._lm) rec._lm={};
  if(!rec._ll) rec._ll={};
  const l=logs.find(x=>x && x.stage===stageName);
  if(!l || typeof l.log==='string' || !l.logFile || typeof rec._lc[l.stage]==='string') return;
  if(rec._ll[l.stage]) return rec._ll[l.stage];
  const job=fetch('/api/worktable/file?path='+encodeURIComponent(l.logFile)+'&tailBytes=65536')
    .then(async r=>{
      if(!r.ok) return null;
      const size=parseInt((r.headers&&r.headers.get('x-worktable-file-size'))||'',10);
      rec._lm[l.stage]={truncated:!!(r.headers&&r.headers.get('x-worktable-file-truncated')==='tail'),size:Number.isFinite(size)?size:null};
      return r.text();
    })
    .then(t=>{ rec._lc[l.stage]=t; })
    .catch(()=>{ rec._lc[l.stage]=null; })
    .finally(()=>{ delete rec._ll[l.stage]; });
  rec._ll[l.stage]=job;
  return job;
}
function applyReplayProfileStages(rec,profileStages){
  if(!rec||!Array.isArray(rec.logs)||!Array.isArray(profileStages)) return;
  const byName={}; profileStages.forEach(stage=>{ if(stage&&stage.name) byName[stage.name]=stage; });
  const logNames={};
  rec.logs.forEach(log=>{
    const stage=log&&byName[log.stage];
    if(log&&log.stage) logNames[log.stage]=true;
    if(!stage||!stage.status) return;
    log.status=stage.status;
    if(typeof stage.durSec==='number') log.dur=stage.durSec;
    if(Number.isFinite(Number(stage.startedAt))&&Number(stage.startedAt)>0&&log.startedAt===undefined) log.startedAt=Number(stage.startedAt);   // profile 携带的阶段开始时间回填历史条目
    if(stage.local && log.local===undefined) log.local=true;
  });
  /* profile 里有、logs 缺的阶段补进列表：混合编排同 tag 被整条替换冲掉本地前缀时的兜底，
     远端运行详情仍能展示完整阶段信息。 */
  profileStages.forEach(stage=>{
    if(!stage||!stage.name||logNames[stage.name]) return;
    const e={stage:stage.name, status:stage.status||'idle', dur:(typeof stage.durSec==='number'?stage.durSec:0)};
    if(Number.isFinite(Number(stage.startedAt))&&Number(stage.startedAt)>0) e.startedAt=Number(stage.startedAt);
    if(stage.logFile) e.logFile=stage.logFile;
    if(stage.local) e.local=true;
    rec.logs.push(e);
    logNames[stage.name]=true;
  });
}
async function loadReplayLogs(rec){
  const jobs=[];
  const selected=flowStages().find(s=>s.id===selectedId);
  if(selected) jobs.push(loadReplayLog(rec,selected.name));
  /* 阶段状态校正：服务端定时执行的真实结果写入了归档目录的 run-<tag>.profile.json；
     历史条目里的阶段状态可能因页面/服务端记录按 tag 合并而被回退为 idle（未反映服务端实际执行），
     回放时按 profile.stages 覆盖各阶段 status/dur，使详情如实展示「已完成/跳过/错误/终止」。 */
  if(rec.archive && rec.tag){
    let state=rec._profState;
    if(!state||typeof state!=='object'){
      state={checked:!!rec._profChecked,promise:null,stages:null};
      rec._profState=state;
    }
    if(Array.isArray(state.stages)) applyReplayProfileStages(rec,state.stages);
    else{
      if(!state.checked&&!state.promise){
        state.checked=true; rec._profChecked=true;
        state.promise=fetch('/api/worktable/file?path='+encodeURIComponent(rec.archive+'/run-'+rec.tag+'.profile.json'))
          .then(r=>r.ok?r.text():null)
          .then(text=>{ if(!text) return; let profile; try{ profile=JSON.parse(text); }catch(e){ return; } if(profile&&Array.isArray(profile.stages)) state.stages=profile.stages; })
          .catch(()=>{})
          .finally(()=>{ state.promise=null; });
      }
      /* state 在同 tag 的刷新前后共享：无论 profile 已完成还是仍在途，每个回放对象都从同一结果重放校正。 */
      if(state.promise) jobs.push(state.promise.then(()=>{ if(Array.isArray(state.stages)) applyReplayProfileStages(rec,state.stages); }));
    }
  }
  if(jobs.length) await Promise.all(jobs);
}
/* 回放态：从历史 logs 重建各阶段节点状态（首次进入回放 + loadReplayLogs 校正状态后重算，
   使编排区节点状态/进度与详情面板一致）。阶段按名称匹配 logs；无记录视为未开始（idle）。 */
function rebuildReplayNodes(rec){
  if(!runStages) return;
  const logs=Array.isArray(rec.logs)?rec.logs:[];
  const byName={}; logs.forEach(l=>{ if(l && l.stage) byName[l.stage]=l; });
  nodes={};
  flowStages().forEach(s=>{
    const l=byName[s.name];
    const st=l?(l.status||'idle'):'idle';
    const node={status:st, progress:st==='success'?100:0, dur:(l && l.dur)||0, sub:{}};
    const st0=Number(l&&l.startedAt); if(Number.isFinite(st0)&&st0>0) node.startedAt=st0;   // 阶段开始时间随历史条目回填，回放详情展示
    nodes[s.id]=node;
  });
}
function enterHistoryReplay(rec){
  /* 回放是独立的查看模式：脱离当前运行视图（在跑运行转入后台继续，队列区仍可见可中止） */
  viewRc=null; curRun=null;
  replayRec=rec;
  /* 编排区：切到该次运行的流水线（按 id/名称匹配；不写 localStorage，避免回放污染偏好），
     阶段状态/耗时按阶段名从历史 logs 回填；流水线已删除时按日志阶段名重建只读编排 */
  const pl=(rec.pipelineId && findPipeline(rec.pipelineId)) || pipelines.find(p=>p.name===rec.pipeline) || null;
  if(pl && pl.id!==curPipelineId){ curPipelineId=pl.id; renderPipelineSel(); renderPipelines(); }
  const logs=Array.isArray(rec.logs)?rec.logs:[];
  /* 补齐预设标记（旧流水线未存过预设顺序）：回放按 logs 里出现过的预设任务展开节点（见 flowStages） */
  runStages = pl ? withPresetMarkers(pl.stages).map(s=>({...s}))
    : logs.map((l,i)=> PRESET_BY_NAME[l.stage] ? presetMarker(PRESET_BY_NAME[l.stage]) : ({id:'replay-st'+i, name:l.stage, dur:5, sub:[]}));
  rebuildReplayNodes(rec);
  selectedId=runStages.length?runStages[0].id:null;
  /* 主控区其余项同步为该次运行的取值：环境多选按 IP 匹配（同历史重跑），仓库/分支/策略直接回填；
     执行人不回填——回放只是查看模式，原执行人已在下方 overallBy 行展示；且执行人只读、固定取当前
     登录用户（fillExecutorFromAuth），写回历史记录作者只会造成错署 */
  const ips=String(rec.env||'').split('，').map(x=>x.trim()).filter(Boolean);
  const envs=ips.map(ip=>environments.find(e=>e.ip===ip)).filter(Boolean);
  if(envs.length){ selectedEnvIds=envs.map(e=>e.id); renderEnvOptions(); }
  if(rec.repoId && repositories.some(r=>r.id===rec.repoId)){ curRepoId=rec.repoId; const rs=$('repoSel'); if(rs) rs.value=rec.repoId; }
  if(rec.branch) $('branchName').value=rec.branch;
  if($('deployStrategyName')) $('deployStrategyName').value=rec.strategy||'';
  /* 总状态徽标 + 编排区回放提示 */
  setOverall(labelOf(rec.status)+' · 回放 #'+rec.no, rec.status==='success'?'dshell-badgeDone':'');
  if(rec.status==='failed'){ const o=$('overall').firstChild; if(o){ o.style.color='var(--st-err)'; o.style.borderColor='color-mix(in srgb, var(--st-err) 40%, transparent)'; } }
  else if(rec.status==='aborted'){ const o=$('overall').firstChild; if(o){ o.style.color='var(--st-idle)'; o.style.borderColor='color-mix(in srgb, var(--st-idle) 40%, transparent)'; } }   // 与运行历史行/阶段徽标同色（灰）
  $('overallBy').textContent='执行人：'+(rec.by||'—')+' · '+rec.time+'（历史回放）';
  const rt=$('replayTip'); if(rt) rt.textContent='正在回放历史 #'+rec.no+'「'+rec.pipeline+'」 · 再次点击该行退出';
  _detailKey='';   // 详情渲染缓存失效，强制按回放数据重绘
  renderFlow(); renderDetail();
  loadReplayLogs(rec).then(()=>{ if(replayRec===rec){ rebuildReplayNodes(rec); _detailKey=''; renderFlow(); renderDetail(); } });   // 按需拉取归档日志 + 校正阶段状态，完成后重算节点并重绘编排/详情
}
function exitHistoryReplay(){
  if(!replayRec) return;
  replayRec=null; const rt=$('replayTip'); if(rt) rt.textContent='';
  /* 退出回放：有在跑运行则回看最近一个（其节点表保持引擎实写状态，不可重置），否则回到当前流水线的空闲编排 */
  viewRc=activeRuns.length?activeRuns[activeRuns.length-1]:null;
  syncViewRun(); applyRunOverall(viewRc);
  refreshArchiveTip();
  if(viewRc){ _detailKey=''; renderFlow(); renderDetail(); }
  else resetNodes();   // 空闲态：恢复主控当前流水线的空闲编排（内部重置 _detailKey 并重绘流程/详情）
}
/* 回放态详情渲染：结构与 renderDetail 一致，数据取自历史记录（logs 按阶段名匹配选中阶段） */
function renderReplayDetail(rec){
  const s=flowStages().find(x=>x.id===selectedId) || flowStages()[0];
  if(!s) return;
  const logs=Array.isArray(rec.logs)?rec.logs:[];
  const entry=logs.find(l=>l && l.stage===s.name) || null;
  const n=nodes[s.id] || {status:'idle'};
  $('detailTitle').textContent = s.name + ' · 阶段详情';
  const badge=$('detailBadge'); badge.innerHTML='';
  const map={idle:['未开始',''], running:['进行中','dshell-badgeWait'], skipped:['跳过',''],
    success:['已完成','dshell-badgeDone'], failed:['错误','dshell-badgeDone'], aborted:['终止','']};
  const [txt,cls]=map[n.status]||['未开始',''];
  const b=document.createElement('span');
  if(n.status==='failed'){ b.className='dshell-badge'; b.style.color='var(--st-err)'; b.style.borderColor='color-mix(in srgb, var(--st-err) 40%, transparent)'; }
  else if(n.status==='skipped'){ b.className='dshell-badge'; b.style.color='var(--dsw-alias-label-tertiary)'; b.style.borderColor='var(--dsw-alias-border-l2)'; }
  else if(n.status==='aborted'){ b.className='dshell-badge'; b.style.color='var(--st-idle)'; b.style.borderColor='color-mix(in srgb, var(--st-idle) 40%, transparent)'; }   // 与运行历史徽标同色（灰）
  else b.className='dshell-badge '+cls;
  b.textContent=txt; badge.appendChild(b);
  appendLocalExecBadge(badge, isLocalExecStage(s, entry, rec));
  const kv=$('detailKv'); kv.innerHTML='';
  const rows=[['阶段',s.name],['状态',txt],['流水线',rec.pipeline||'—'],['分支',rec.branch||'main'],['策略',rec.strategy||'—'],
    ['执行人',rec.by||'—'],['环境',rec.env||'—'],['Commit',rec.commit||'—'],['运行时间',rec.time||'—']];
  rows.push(['执行方式', isLocalExecStage(s, entry, rec)?'本地执行':'服务端执行']);
  if(rec.closeError) rows.push(['中断原因', rec.closeError]);   // 关页即失败的运行：中断原因随记录落史，回放详情直接可见
  const _st0=Number(entry&&entry.startedAt);   // 阶段开始时间随历史条目持久化（collectRunLogs/服务端 pushHist）；旧记录无该字段不展示
  if(Number.isFinite(_st0)&&_st0>0) rows.push(['开始时间', fmtStageStart(_st0)]);
  if(n.status==='success'||n.status==='failed'||n.status==='aborted') rows.push(['耗时', fmtDur(n.dur||0)]);
  /* 不再单独展示「归档目录」行：归档路径已由「📂 打开归档目录」按钮旁的状态提示展示（refreshArchiveTip），避免长路径挤压回显日志区 */
  rows.forEach(([k,v])=>{ const r=document.createElement('div'); r.className='dshell-kvRow';
    r.innerHTML='<span class="dshell-kvKey">'+esc(k)+'</span><span class="dshell-kvValue">'+esc(v)+'</span>'; kv.appendChild(r); });
  /* 日志文件行：回放态取日志条目里的 logFile（旧版内嵌日志记录无独立文件时路径为空），附 AI 分析与打开日志目录按钮 */
  appendStageLogRow(kv, s, (entry && entry.logFile) || null, rec);
  const bar=$('detailBar'); const wrap=$('detailBarWrap');
  const pct=(n.status==='success'||n.status==='skipped')?100:(n.progress||0);
  bar.style.width=pct+'%';
  bar.style.background = n.status==='failed'?'var(--st-err)':(n.status==='success'?'var(--st-ok)':(n.status==='skipped'||n.status==='aborted'?'var(--st-idle)':'var(--st-run)'));
  wrap.style.display = (n.status==='running'||n.status==='success'||n.status==='failed'||n.status==='skipped'||n.status==='aborted')?'block':'none';
  const log=$('detailLog'); _detailLogCache=null; log.innerHTML='';   // 回放改写了日志区，详情增量渲染缓存一并失效
  /* 日志来源：旧版记录内嵌 entry.log 直接用；新版条目只存 logFile 路径，由 loadReplayLog 按当前阶段拉取并缓存到 rec._lc */
  let text=(entry && typeof entry.log==='string') ? entry.log : undefined;
  if(entry && text===undefined && entry.logFile){
    const cached=rec._lc ? rec._lc[entry.stage] : undefined;
    if(typeof cached==='string') text=cached;
    else log.textContent = cached===null ? ('日志文件读取失败或不存在：'+entry.logFile) : '（日志加载中…）';
  }
  /* 阶段详情只回显最后 20 行；新插件从服务端仅取末尾 64KiB，旧插件返回全文时仍在页面截取。 */
  const TAIL=20;
  const all=text!==undefined ? String(text).split('\n') : [];
  const lines=all.length>TAIL ? all.slice(all.length-TAIL) : all;
  const meta=entry && rec._lm ? rec._lm[entry.stage] : null;
  if(!all.length && !log.textContent){ log.textContent = rec.demo ? '预置演示数据未记录回显日志。' : '该阶段未记录回显日志（未运行或为旧版数据）。'; }
  else{
    if(meta && meta.truncated){ const tip=document.createElement('div'); tip.className='dim'; tip.textContent='… 已按需加载日志末尾 64 KiB'+(meta.size?('（文件共 '+(meta.size/1024/1024).toFixed(1)+' MiB）'):'')+'，仅显示最后 '+TAIL+' 行；全量见归档日志文件'; log.appendChild(tip); }
    else if(all.length>TAIL){ const tip=document.createElement('div'); tip.className='dim'; tip.textContent='… 仅显示最后 '+TAIL+' 行（共 '+all.length+' 行，全量见归档日志文件）'; log.appendChild(tip); }
    lines.forEach(ln=>{
      const div=document.createElement('div'); let cls='dim';
      if(/✓|✅|成功|passed|通过/.test(ln)) cls='ok';
      if(/✗|failed|失败|timed out|Rollback|回滚/.test(ln)) cls='err';
      if(/^\[Pipeline\]/.test(ln) || /docker|helm|kubectl/.test(ln)) cls='hi';
      div.className=cls; div.textContent=ln; log.appendChild(div);
    });
  }
}
function saveHistFilter(){ try{ localStorage.setItem('pip-histFilter', JSON.stringify(histFilter)); }catch(e){} persistState(); }
function savePlFilter(){ try{ localStorage.setItem('pip-plFilter', JSON.stringify(plFilter)); }catch(e){} persistState(); }
function filteredHistory(){
  const kw=histFilter.kw.trim().toLowerCase();
  if(!kw && !histFilter.status && !histFilter.pipeline) return history;
  return history.filter(h=>{
    if(histFilter.status && h.status!==histFilter.status) return false;
    if(histFilter.pipeline && (h.pipeline||'')!==histFilter.pipeline) return false;
    if(kw){ const hay=[('#'+(h.no||'')),(h.pipeline||''),(h.by||'')].join(' ').toLowerCase(); if(hay.indexOf(kw)<0) return false; }
    return true;
  });
}
/* 输入框回显值：筛选名在候选名单内才显示，否则置空（沿用旧下拉「名单不含该项时置空」语义；筛选状态本身不改写） */
function histPipelineDisplay(){ return (histFilter.pipeline && _histPipelineNames.indexOf(histFilter.pipeline)>=0)?histFilter.pipeline:''; }
function renderHistFilterOptions(){
  const inp=$('histFilterPipeline'); if(!inp) return;
  const names=Array.from(new Set([].concat(history.map(h=>h.pipeline).filter(Boolean), pipelines.map(p=>p&&p.name).filter(Boolean))));
  const sig=names.join('\u0001');
  if(sig!==_histFilterPipelineSig){ _histFilterPipelineSig=sig; _histPipelineNames=names; }
  /* 始终以筛选状态为权威源同步输入框；输入框聚焦（搜索输入中）时不回写，避免定时自动刷新打断输入 */
  if(document.activeElement!==inp) inp.value=histPipelineDisplay();
  /* 面板展开时随名单变化重绘候选 */
  const panel=$('histPipelinePanel');
  if(panel && panel.style.display==='block') renderHistPipelinePanel();
}
/* 流水线过滤候选面板：showAll 显示全量候选，否则按输入框文本子串过滤（大小写不敏感）；点选候选提交精确名 */
function renderHistPipelinePanel(showAll){
  const panel=$('histPipelinePanel'); const inp=$('histFilterPipeline'); if(!panel||!inp) return;
  const q=showAll?'':inp.value.trim().toLowerCase();
  const list=_histPipelineNames.filter(n=>!q || n.toLowerCase().indexOf(q)>=0);
  const item=(v,label)=>'<div data-histpl="'+esc(v)+'" style="padding:3px 8px;cursor:pointer;border-radius:5px;font-size:12px;white-space:nowrap;'+(v===histFilter.pipeline?'color:var(--dsw-alias-state-accent-primary);font-weight:600;':'')+'">'+esc(label)+'</div>';
  let h=item('','全部流水线')+list.map(n=>item(n,n)).join('');
  if(!list.length) h+='<div class="dshell-muted" style="font-size:11px;padding:4px 6px;">无匹配候选</div>';
  panel.innerHTML=h; panel.style.display='block';
  _histPipelineActive=-1;
  panel.querySelectorAll('[data-histpl]').forEach(el=>el.addEventListener('click',()=>pickHistPipeline(el.getAttribute('data-histpl'))));
}
function histPipelinePanelItems(){ const panel=$('histPipelinePanel'); return panel?Array.from(panel.querySelectorAll('[data-histpl]')):[]; }
/* 选中候选（'' = 全部流水线）：提交精确名到筛选状态并持久化，归首页后重绘 */
function pickHistPipeline(name){
  const inp=$('histFilterPipeline'); const panel=$('histPipelinePanel');
  histFilter.pipeline=name||'';
  if(inp) inp.value=histFilter.pipeline;
  if(panel) panel.style.display='none';
  histPage=0; saveHistFilter(); renderHistory();
}
/* 历史表「环境节点」单元格内容：优先 envNodes 数组（服务端/本地 finish 写入的 {name,ip,nodeIp}），
   无该字段的遗留记录回退解析 rec.env（按中文/英文逗号拆分，IP 串或环境名字符串都直接展示）；
   两者皆空显示 —。文本：节点名（name 为空回退 ip）以「、」连接，超过 2 个折叠为「A、B 等N个」；
   title 逐行「节点名（ip）」，name/ip 为空时省略对应部分（如「（192.168.1.1）」或「生产」）。 */
function historyEnvNodesCell(rec){
  let nodes=Array.isArray(rec&&rec.envNodes)?rec.envNodes:null;
  if(!nodes) nodes=String((rec&&rec.env)||'').split(/[，,]/).map(s=>s.trim()).filter(Boolean).map(s=>({name:s,ip:'',nodeIp:''}));
  nodes=nodes.filter(n=>n&&(n.name||n.ip));
  if(!nodes.length) return {text:'—',title:''};
  const names=nodes.map(n=>String(n.name||n.ip));
  const text=names.length>2?names.slice(0,2).join('、')+' 等'+names.length+'个':names.join('、');
  const title=nodes.map(n=>{
    const name=String(n.name||''), ip=String(n.ip||'');
    if(name&&ip) return name+'（'+ip+'）';
    return name||('（'+ip+'）');
  }).join('\n');
  return {text:text,title:title};
}
function renderHistory(){
  const tb=$('historyTable').querySelector('tbody'); tb.innerHTML='';
  if(selHistoryIdx>=history.length) selHistoryIdx=-1;
  pruneAnalysisHistory();
  const view=filteredHistory();
  renderHistFilterOptions();
  const fTip=$('histFilterTip'); if(fTip) fTip.textContent=(histFilter.kw||histFilter.status||histFilter.pipeline)?('已筛选 '+view.length+' / '+history.length+' 条'):'';
  if(!view.length){ const tr0=document.createElement('tr'); tr0.innerHTML='<td colspan="9" class="dshell-muted" style="text-align:center;padding:14px 0;">'+(history.length?'无匹配的运行历史':'暂无运行历史')+'</td>'; tb.appendChild(tr0); }
  const pages=Math.max(1, Math.ceil(view.length/histPageSize));
  if(histPage>pages-1) histPage=pages-1;
  if(histPage<0) histPage=0;
  view.slice(histPage*histPageSize, (histPage+1)*histPageSize).forEach((h,i)=>{
    const idx=history.indexOf(h);
    const tr=document.createElement('tr');
    const analysisChecked=analysisHistoryKeys.indexOf(analysisHistoryKey(h))>=0;
    tr.className=(idx===selHistoryIdx?'sel ':'')+(analysisChecked?'analysis-sel':'');
    const badge='<span class="dshell-badge '+(h.status==='success'?'dshell-badgeDone':(h.status==='running'?'dshell-badgeWait':''))+'"'+(h.status==='failed'?' style="color:var(--st-err);border-color:color-mix(in srgb, var(--st-err) 40%, transparent)"':h.status==='aborted'?' style="color:var(--st-idle)"':'')+'>'+labelOf(h.status)+'</span>';
    const envCell=historyEnvNodesCell(h);
    /* 在跑记录耗时按 startTs 实时算（历史自动刷新约 3s 重绘一次）；终态用 finish 写入的 dur */
    const durText=(h.status==='running'&&Number(h.startTs)>0)?fmtDur(Math.max(0,(Date.now()-h.startTs)/1000)):(h.dur||'');
    tr.innerHTML='<td><input type="checkbox" class="history-analysisPick" data-hist-analysis aria-label="选择运行 #'+esc(h.no)+' 用于 AI 分析或对比" title="选择用于 AI 分析（最多两条，勾选顺序为 A / B）" /></td><td>#'+h.no+'</td><td class="dshell-muted">'+esc(h.pipeline||'—')+'</td><td class="dshell-muted"'+(envCell.title?' title="'+esc(envCell.title)+'"':'')+'>'+esc(envCell.text)+'</td><td class="dshell-muted">'+esc(h.by)+'</td><td class="dshell-muted">'+esc(h.strategy||'—')+'</td><td>'+badge+'</td><td>'+esc(durText)+'</td><td class="dshell-muted">'+esc(fmtHistTime(h))+' <button class="dshell-btn dshell-btnGhost mini" type="button" data-history-menu title="更多操作" aria-label="运行 #'+esc(h.no)+' 更多操作">⋯</button></td>';
    const analysisPick=tr.querySelector('[data-hist-analysis]');
    analysisPick.checked=analysisChecked;
    analysisPick.addEventListener('click', e=>e.stopPropagation());
    analysisPick.addEventListener('change', e=>{ if(!toggleAnalysisHistory(h,e.target.checked)) e.target.checked=false; });
    const historyMenu=tr.querySelector('[data-history-menu]');
    if(historyMenu){
      historyMenu.addEventListener('click', e=>{ e.stopPropagation(); openHistoryRowMenu(h, historyMenu); });
    }
    tr.addEventListener('click', ()=>{
      selHistoryIdx = selHistoryIdx===idx?-1:idx;
      if(selHistoryIdx>=0){
        const rec=history[selHistoryIdx];
        /* 在跑记录（启动即入史）点选不进回放：回放会掏空实时编排且 logs 尚未齐全，
           改为切到该次运行的实时视图；已不在本页 activeRuns 的 running 记录仍走回放 */
        const live=(rec&&rec.tag&&typeof activeRuns!=='undefined'&&Array.isArray(activeRuns))
          ? activeRuns.find(r=>r&&r.tag===rec.tag) : null;
        if(live){
          replayRec=null;
          viewRc=live; syncViewRun(); applyRunOverall(live);
          _detailKey=''; renderFlow(); renderDetail();
          const rt=$('replayTip'); if(rt) rt.textContent='';
        }else enterHistoryReplay(rec);
      }
      else exitHistoryReplay();
      renderHistory();
      refreshArchiveTip();   // 「打开归档目录」目标跟随选中行刷新（运行中除外，见 archiveTargetFolder）
    });
    tb.appendChild(tr);
  });
  const info=$('histPageInfo'); if(info) info.textContent='第 '+(histPage+1)+'/'+pages+' 页 · 共 '+view.length+' 条';
  const pv=$('histPrev'), nx=$('histNext');
  if(pv) pv.disabled = histPage<=0;
  if(nx) nx.disabled = histPage>=pages-1;
  const tip=$('rowSelTip');
  if(tip){
    const picked=selectedAnalysisHistory();
    if(picked.length) tip.textContent='分析已选 '+picked.length+'/2：'+picked.map(rec=>'#'+rec.no).join(' → ')+(selHistoryIdx>=0&&history[selHistoryIdx]?(' · 回放 #'+history[selHistoryIdx].no):'');
    else if(selHistoryIdx>=0&&history[selHistoryIdx]) tip.textContent='回放 #'+history[selHistoryIdx].no+'（未勾选时分析此行）';
    else tip.textContent='勾选 1 条分析，或按顺序勾选 2 条对比';
  }
}
/* 打开归档目录的目标解析：运行中取当前运行归档；否则取历史选中行的归档目录。
   未运行且未选中历史行时不回退（不再打开最近一次运行或归档根目录），返回 null，
   由 openArchiveFolder 提示先选择一条运行历史。 */
function archiveTargetFolder(){
  if(viewActive() && curRun && curRun.archive) return curRun.archive;   // 编排区展示的在跑运行：打开其归档
  if(selHistoryIdx>=0 && history[selHistoryIdx] && history[selHistoryIdx].archive) return history[selHistoryIdx].archive;
  return null;
}
/* 归档根目录：设置的归档路径，留空=保底 runs/；供未归档历史的 AI 分析工作区兜底。 */
function archiveRootFolder(){ return (archiveDir||'').trim() || fallbackArchiveRoot() || ''; }
/* 历史行选中变化时刷新「打开归档目录」的状态提示：展示当前将打开的目录，清掉上一次打开结果的残留。
   未运行且未选中历史行时提示先选择一条运行历史（不再回退到归档根目录）。 */
function refreshArchiveTip(){
  const tip=$('archiveTip'); if(!tip) return;
  const f=archiveTargetFolder();
  tip.textContent = f ? ('归档目录：'+f) : '未选中运行，请点击历史行选择';
  tip.style.color='';
}
/* 服务端系统文件管理器回退路径（无 better-sidebar 时用）：助手脚本探测 xdg-open/gio/open。
   fellBack=true 表示传入的 folder 已是预检后的回退目录（原目标不存在），成功提示保持「回退」语义。 */
async function openFolderViaFileManager(folder, say, fellBack){
  try{
    await apiWrite(FM_HELPER, FM_SCRIPT);   // 幂等重写助手脚本（内容固定）
    const r=await fetch('/api/worktable/exec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:FM_HELPER,args:[folder],timeoutMs:10000})});
    const j=await r.json();
    if(j && j.error){ say('✗ '+String(j.error).slice(0,120),'var(--log-err)'); return; }
    if(j.code===0){
      const opened=String(j.stdout||'').trim().split('\n').pop()||folder;   // 助手脚本回显实际打开的目录
      if(opened===folder && !fellBack) say('✓ 已在服务端打开 '+opened,'var(--log-ok)');
      else say('✓ 目标目录不存在，已回退打开 '+opened,'var(--log-warn)');
    }
    else if(j.code===2) say('✗ 目录不存在（含归档根目录）：'+folder,'var(--log-err)');
    else if(j.code===3) say('✗ 服务端未找到文件管理器（xdg-open/gio/open）','var(--log-err)');
    else say('✗ 打开失败（退出码 '+j.code+'）'+(j.stderr?('：'+String(j.stderr).trim().slice(0,120)):''),'var(--log-err)');
  }catch(e){ say('✗ 请求失败：'+String(e.message||e).slice(0,120),'var(--log-err)'); }
}
async function openArchiveFolder(){
  const tip=$('archiveTip');
  const say=(t,c)=>{ if(tip){ tip.textContent=t; tip.style.color=c||''; } };
  const folder=archiveTargetFolder();
  if(!folder){ say('⚠ 请先点击选择一条运行历史（或运行一条流水线后再打开）','var(--log-warn)'); return; }
  await openFolderWithFeedback(folder, say);
}
/* 打开目录的完整反馈流程（「📂 打开归档目录」使用；阶段详情「📄 打开日志」在日志文件
   尚未生成/已清理时回退打开所在目录，也委托本流程）：
   等待日志落盘 → 预检目录存在性（不存在回退父目录）→ 优先经 dsh-better-sidebar 侧边窗打开
   （成功后关闭侧边会话窗让出空间），未装该插件或桥不可用时回退服务端系统文件管理器。 */
async function openFolderWithFeedback(folder, say){
  say('正在等待日志落盘并打开目录…');
  try{ await waitArchiveWrites(folder); }
  catch(e){ say('✗ 日志归档失败：'+String(e.message||e),'var(--log-err)'); return; }
  const res=await resolveExistingFolder(folder);   // 预检：不存在则回退归档根，避免侧边栏以不存在目录为根开出空文件树
  if(!res.folder){ say('✗ 目录不存在（含归档根目录）：'+folder,'var(--log-err)'); return; }
  const target=res.folder;
  const ok=(m)=>res.fellBack ? say('✓ 目标目录不存在，已回退打开 '+target,'var(--log-warn)') : say(m,'var(--log-ok)');
  const P=window.parent;
  // 经 dsh-better-sidebar 侧边窗打开归档目录；成功后关闭工作台侧边会话窗（聊天列）让出空间。
  // 保留本页与执行上下文；不再为浏览目录创建会话。
  if(P && typeof P.__dshOpenFolderInSidebar==='function'){
    try{
      if(P.__dshOpenFolderInSidebar(target)){
        try{ if(typeof P.__dshCloseSideChat==='function') P.__dshCloseSideChat(); }catch(e){}
        ok('✓ 已在侧边栏打开 '+target); return;
      }
    }catch(e){}
  }
  say('正在打开服务端文件管理器…');
  await openFolderViaFileManager(target, say, res.fellBack);
}
/* 阶段详情「📄 打开日志」：打开本阶段归档日志文件本身（而非所在目录）。
   等待落盘后先经 /api/worktable/file（tailBytes=1024 轻量探测）预检文件是否已生成：
   404 视为尚未生成/已清理，回退 openFolderWithFeedback 打开所在目录（效果同「📂 打开归档目录」）；
   探测本身失败（网络/服务端异常）按存在处理、不阻断打开。
   文件存在时优先经 __dshOpenFileInSidebar 桥（工作台插件暴露，dsh-better-sidebar 侧边栏把日志
   开为编辑器标签；成功后经 __dshCloseSideChat 关闭侧边会话窗让出空间）；桥不可用/拒绝时回退
   window.open 新浏览器标签页，弹窗被拦截则在提示行放可点击链接。
   反馈写入阶段详情的提示行 #stageLogTipRow/#stageLogTip，而非归档按钮旁的 archiveTip。 */
async function openStageLogFile(file){
  const tip=$('stageLogTip');
  const tipRow=$('stageLogTipRow');
  const say=(t,c)=>{ if(!tip) return; tip.textContent=t; tip.style.color=c||''; if(tipRow) tipRow.style.display=t?'':'none'; };
  if(!file){ say('⚠ 本阶段暂无归档日志文件','var(--log-warn)'); return; }
  const i=file.lastIndexOf('/');
  if(i<=0){ say('⚠ 无法确定日志所在目录：'+file,'var(--log-warn)'); return; }
  const folder=file.slice(0,i);
  say('正在等待日志落盘…');
  try{ await waitArchiveWrites(folder); }
  catch(e){ say('✗ 日志归档失败：'+String(e.message||e),'var(--log-err)'); return; }
  let missing=false;   // 轻量探测日志文件是否已生成；探测失败按存在处理、不阻断
  try{
    const r=await fetch('/api/worktable/file?path='+encodeURIComponent(file)+'&tailBytes=1024');
    missing=!r || r.status===404;
  }catch(e){}
  if(missing){
    say('⚠ 日志文件尚未生成或已清理，改为打开所在目录…','var(--log-warn)');
    await openFolderWithFeedback(folder, say);
    return;
  }
  const P=window.parent;
  // 经 dsh-better-sidebar 侧边栏把日志开为编辑器标签；成功后关闭工作台侧边会话窗（聊天列）让出空间。
  if(P && typeof P.__dshOpenFileInSidebar==='function'){
    try{
      if(P.__dshOpenFileInSidebar(file)){
        try{ if(typeof P.__dshCloseSideChat==='function') P.__dshCloseSideChat(); }catch(e){}
        say('✓ 已在侧边栏打开 '+file,'var(--log-ok)'); return;
      }
    }catch(e){}
  }
  const url='/api/worktable/file?path='+encodeURIComponent(file);
  const w=window.open(url,'_blank');
  if(w){ say('✓ 已在新标签页打开 '+file,'var(--log-ok)'); return; }
  // 弹窗被拦截：提示行改放可点击链接（DOM 构建，避免路径含引号时拼 innerHTML 注入）
  if(tip){
    tip.textContent='';
    tip.appendChild(document.createTextNode('⚠ 浏览器拦截了新标签页：'));
    const a=document.createElement('a');
    a.href=url; a.target='_blank'; a.rel='noopener'; a.textContent='点击打开日志';
    tip.appendChild(a);
    tip.style.color='var(--log-warn)';
    if(tipRow) tipRow.style.display='';
  }
}
/* 打开前预检目标目录是否存在（历史归档可能已清理、归档路径已改）：
   不存在时回退父目录（归档根），返回 {folder, fellBack}；连归档根都不存在返回 {folder:null}。
   探测请求本身失败（网络/服务端异常）按存在处理、不阻断打开。
   定义在 openArchiveFolder 之后：页面内函数声明提升不影响调用，测试切片同区间一并加载。 */
async function resolveExistingFolder(folder){
  async function exists(d){
    try{
      const r=await fetch('/api/worktable/fs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:d})});
      const j=await r.json().catch(()=>null);
      return !!(r.ok && j && !j.error);
    }catch(e){ return null; }   // null=探测失败（按存在处理）
  }
  if(await exists(folder)!==false) return {folder, fellBack:false};
  const parent=folder.slice(0, folder.lastIndexOf('/'))||'/';
  if(parent===folder) return {folder:null};
  if(await exists(parent)!==false) return {folder:parent, fellBack:true};
  return {folder:null};
}
/* 历史重跑：按选中行的流水线 + 环境 IP + 分支重新运行（运行中则入队）；
   执行人不沿用历史记录作者——重跑是一次新运行，执行人取「执行人」输入框当前值（即实际操作人），
   留空时由 runPipeline 的必填校验拦截 */
function rerunFromHistory(rec){
  const pl=(rec.pipelineId && findPipeline(rec.pipelineId)) || pipelines.find(p=>p.name===rec.pipeline);
  if(!pl){ alert('找不到该次运行的流水线「'+(rec.pipeline||'')+'」（可能已删除），无法重跑。'); return; }
  /* 环境按历史 IP 串匹配当前节点列表；匹配不到则退回当前所选环境 */
  const ips=String(rec.env||'').split('，').map(s=>s.trim()).filter(Boolean);
  const envs=ips.map(ip=>environments.find(e=>e.ip===ip)).filter(Boolean);
  const repoId=(rec.repoId && repositories.some(r=>r.id===rec.repoId)) ? rec.repoId : undefined;
  const r=runPipeline({pipelineId:pl.id, envs:envs.length?envs:undefined, repoId, branch:rec.branch, strategy:rec.strategy||'', weightsPath:rec.weightsPath||'', source:'manual'});   // 权重路径随历史记录重放（旧记录无此字段=不注入）
  if(r===false) alert('本地队列已满（上限 '+QUEUE_CAP+'），请等待当前任务完成或取消部分排队任务。');
  else if(r==='queued') flashRunTip('已加入本地队列（第 '+queue.length+' 位）');
  else if(r==='submitted') flashRunTip('已提交服务端重跑 #'+rec.no+'（'+pl.name+'）');
  else if(r===true) flashRunTip('已开始本地重跑 #'+rec.no+'（'+pl.name+'）');
  else if(r==='no-by'){ /* 执行人必填拦截：runPipeline 已弹提示，不再给「已开始」误导提示 */ }
}
/* 只应用同一清空版本下发起的刷新：请求在途时若本页清空过历史，迟到响应必须丢弃，不能复活旧记录。 */
function applyHistoryRefreshPayload(st, clearAtStart){
  if(histClearedAt!==clearAtStart) return false;
  const cfg=(st && st.config && typeof st.config==='object' && !Array.isArray(st.config)) ? st.config : {};
  const remoteClearedAt=Number.isFinite(cfg.histClearedAt)?cfg.histClearedAt:0;
  /* 本页刚清空但 400ms 防抖 PUT 尚未落盘时，服务端仍会返回旧版本；版本落后也必须丢弃，
     不能只防“请求发出后才清空”这一种竞态。 */
  if(remoteClearedAt<clearAtStart) return false;
  if(Number.isFinite(cfg.buildNo)) buildNo=Math.max(buildNo, cfg.buildNo);
  if(Number.isFinite(cfg.histClearedAt)) histClearedAt=Math.max(histClearedAt, cfg.histClearedAt);
  if(Array.isArray(st&&st.history) && st.history.length){
    const prev=history;
    history=st.history;
    /* 本页在跑/刚终态的运行记录以本地为准：服务端可能滞后（启动持久化在途、finish 刚写完未刷回）。
       同 tag：本地终态优先于远端 running（远端仍是启动时的「进行中」）；本地 running 且远端缺失时
       补回（启动持久化尚未落盘），避免 3s 自动刷新把刚写入的「进行中」条目冲掉。 */
    const localByTag=new Map();
    (Array.isArray(prev)?prev:[]).forEach(h=>{ if(h&&h.tag&&!h.demo) localByTag.set(h.tag,h); });
    let merged=history;
    if(localByTag.size){
      merged=history.slice();
      let injected=false;
      localByTag.forEach((local,tag)=>{
        const at=merged.findIndex(x=>x&&x.tag===tag);
        if(at>=0){
          const remote=merged[at];
          if(local.status!=='running' && remote.status==='running'){ merged[at]=Object.assign({},remote,local); injected=true; }
        }else if(local.status==='running'){
          /* 仅补回仍在本页跑的 running 记录；已不在 activeRuns（关页即失败落史后）由服务端记录收敛 */
          const live=(typeof activeRuns!=='undefined'&&Array.isArray(activeRuns))?activeRuns.some(r=>r&&r.tag===tag):true;
          if(live){ merged.unshift(local); injected=true; }
        }
      });
      history=merged;
      if(injected){ historySyncSig=''; return true; }   // 有本地覆盖：强制下次 persist 携带历史正文
    }
    historyMarkSynced();
  }
  else if(histClearedAt){ history=[]; historyMarkSynced(); }
  return true;
}
/* 服务端刷新会用新对象替换历史列表；把回放懒加载缓存移交给稳定主键对应的新对象，避免每 3 秒
   重读日志文件，也避免列表头部插入记录后按旧下标误选另一条运行。 */
function preserveHistoryRuntimeCache(previous,next){
  if(!previous||!next) return;
  ['_lc','_lm','_ll','_profChecked','_profState'].forEach(key=>{
    if(Object.prototype.hasOwnProperty.call(previous,key)) next[key]=previous[key];
  });
}
function rebindHistoryRefreshSelection(previousSelection,wasReplay){
  if(!previousSelection) return null;
  const key=analysisHistoryKey(previousSelection);
  const index=history.findIndex(rec=>analysisHistoryKey(rec)===key);
  if(index<0){ selHistoryIdx=-1; return null; }
  const next=history[index];
  preserveHistoryRuntimeCache(previousSelection,next);
  if(next._profState&&Array.isArray(next._profState.stages)) applyReplayProfileStages(next,next._profState.stages);
  selHistoryIdx=index;
  if(wasReplay) replayRec=next;
  return next;
}
/* 手动与自动刷新共用同一个在途请求。筛选、页码和分析勾选本来就是独立状态，只更新 history；
   当前回放按 tag（旧记录按稳定元数据）重新绑定，并保留已经加载的日志尾部。 */
async function refreshHistoryFromServer(showError){
  if(_historyRefreshPromise){ if(showError) _historyRefreshNotifyError=true; return _historyRefreshPromise; }
  _historyRefreshNotifyError=!!showError;
  const clearAtStart=histClearedAt;
  const previousSelection=(selHistoryIdx>=0&&history[selHistoryIdx])||replayRec||null;
  const wasReplay=!!replayRec;
  const request=(async()=>{
    try{
      const headers={}; if(_historyEtag) headers['If-None-Match']=_historyEtag;
      let response=await fetch(_historyLightApiMissing?'/api/worktable/pipeline':'/api/worktable/pipeline/history',{cache:'no-store',headers:headers});
      if(response.status===404&&!_historyLightApiMissing){
        /* 旧版插件无轻量历史路由：降级全量存储接口，清掉只对轻量接口有意义的 ETag。 */
        _historyLightApiMissing=true; _historyEtag='';
        response=await fetch('/api/worktable/pipeline',{cache:'no-store',headers:{}});
      }
      if(response.status===304) return true;
      if(!response.ok) throw new Error('HTTP '+response.status);
      const etag=_historyLightApiMissing?null:(response.headers&&response.headers.get('etag'));
      const state=await response.json();
      /* buildNo / histClearedAt 取双方较大值回填（与服务端合并、loadServerState 同规则）：
         防另一浏览器跑过后本地 buildNo 回退重号、清空标记回退复活旧记录。 */
      if(!applyHistoryRefreshPayload(state,clearAtStart)) return false;
      const rebound=rebindHistoryRefreshSelection(previousSelection,wasReplay);
      if(wasReplay){
        if(rebound){
          rebuildReplayNodes(rebound); _detailKey=''; renderFlow(); renderDetail();
          loadReplayLogs(rebound).then(()=>{ if(replayRec===rebound){ rebuildReplayNodes(rebound); _detailKey=''; renderFlow(); renderDetail(); } });
        }
        else exitHistoryReplay();
      }
      renderHistory(); renderStats(); refreshArchiveTip();
      if(etag) _historyEtag=etag;
      return true;
    }catch(error){
      if(_historyRefreshNotifyError) alert('从服务端拉取运行历史失败：'+String(error&&error.message||error));
      return false;
    }
  })();
  _historyRefreshPromise=request;
  try{ return await request; }
  finally{
    if(_historyRefreshPromise===request){ _historyRefreshPromise=null; _historyRefreshNotifyError=false; }
  }
}
function startHistoryAutoRefresh(){
  if(_historyRefreshTimer!==null) return;
  _historyRefreshTimer=setInterval(()=>{ if(document.hidden===true) return; refreshHistoryFromServer(false); },HISTORY_REFRESH_MS);
}
/* 流水线任务筛选：关键字 + 拥有者 + 当前用户收藏；默认「我的（含预置）」+ 全部收藏状态 */
/* 拥有者筛选组合框（input + 自定义候选面板，与运行历史「流水线」筛选同一套交互）的
   「显示文本 ↔ 模式键」映射：特殊模式用固定中文标签展示与点选，用户名原样显示；
   空输入/点外回显回退默认「我的（含预置）」。非标签文本的匹配口径见 plFilterMatch
   （等于已知拥有者用户名时精确匹配，否则按子串大小写不敏感搜索）。
   不用 input+datalist：预填模式标签后浏览器原生下拉会按当前文本过滤候选，用户点不到其他拥有者；
   自定义面板聚焦即展开全量候选，点选/回车可靠提交。 */
function plOwnerFilterLabel(v){
  if(v==='mine') return '我的（含预置）';
  if(v==='all') return '全部';
  if(v==='builtin') return '仅预置';
  if(v==='unknown') return '未署名';
  return String(v||'');
}
function plOwnerFilterValue(text){
  const t=String(text||'').trim();
  if(!t) return 'mine';
  if(t==='我的（含预置）') return 'mine';
  if(t==='全部') return 'all';
  if(t==='仅预置') return 'builtin';
  if(t==='未署名') return 'unknown';
  return t;
}
/* 点选候选提交精确模式键/用户名并归首页重绘；输入框显示文本走 plOwnerFilterLabel */
function pickPlOwner(value){
  const inp=$('plFilterOwner'); const panel=$('plOwnerPanel');
  plFilter.owner=plOwnerFilterValue(value);
  if(inp) inp.value=plOwnerFilterLabel(plFilter.owner);
  if(panel) panel.style.display='none';
  plPage=0; savePlFilter(); renderPipelines();
}
function labelOf(s){ return {running:'进行中',success:'已完成',failed:'错误',aborted:'终止'}[s]||s; }
/* 历史时间渲染：新记录存 ts 时间戳（今天→「今天 HH:MM」，更早→「MM-DD HH:MM」）；旧的字符串记录原样显示 */
function fmtHistTime(h){
  if(!h.ts) return h.time||'';
  const d=new Date(h.ts), now=new Date(); const p=n=>String(n).padStart(2,'0');
  const hm=p(d.getHours())+':'+p(d.getMinutes());
  const sameDay=d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate();
  return sameDay?('今天 '+hm):(p(d.getMonth()+1)+'-'+p(d.getDate())+' '+hm);
}
function renderStats(){
  const rows = history.filter(h=>!h.demo && h.status!=='running');   // 统计只计真实终态运行（进行中不计入成功率/均耗时）
  $('sTotal').textContent = rows.length;
  const succ = rows.filter(h=>h.status==='success').length;
  const rate = rows.length? Math.round(succ/rows.length*100):0;
  $('sRate').textContent = rows.length? rate+'%':'—';
  $('sRateDelta').textContent = rows.length? (rate>=80?'良好':'需关注'):'';
  $('sRateDelta').style.color = rate>=80?'var(--st-ok)':'var(--st-run)';
  const avg = rows.reduce((a,h)=>{ const m=/^(\d+)m(\d+)?/.exec(h.dur); const s=/^(\d+)s/.exec(h.dur);
    let sec=0; if(m) sec=parseInt(m[1])*60+(m[2]?parseInt(m[2]):0); else if(s) sec=parseInt(s[1]); return a+sec; },0);
  $('sAvg').textContent = rows.length? fmtDur(avg/rows.length):'—';
  $('sLast').textContent = rows.length? ('#'+rows[0].no+' '+rows[0].env):'—';
}
