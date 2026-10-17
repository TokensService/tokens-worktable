/* ===== 12-detail-panel.js · 阶段详情面板（日志 / 变量 / AI 分析入口） =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 5220–5676）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */

/* ---------- 详情面板 ---------- */
/* 把行数组增量同步到日志容器，同步完成后 DOM 内容与 lines 完全一致：
   1) 纯追加（持续输出最常见）：只挂载新增行；
   2) 触顶窗口平移：淘汰头部 k 行再追加新行——候选 k 由端点比对筛出后逐行全量校验重叠区，
      校验不过绝不接受，杜绝错误对齐导致的错行；
   3) 中部替换（如 stderr 块前的 stdout 增长、状态行就地变化）；
   4) 其余情形（首帧、内容整体更换、DOM 被外部改写）回退全量重建。
   行着色 class 与文本与全量重建路径完全一致。 */
function syncDetailLogLines(log,lines){
  const makeNode=ln=>{ const div=document.createElement('div'); div.className=logClass(ln); div.textContent=ln; return div; };
  const prev=_detailLogCache;
  const rebuild=()=>{
    log.innerHTML='';
    const fragment=document.createDocumentFragment();
    for(let i=0;i<lines.length;i++) fragment.appendChild(makeNode(lines[i]));
    log.appendChild(fragment);
  };
  /* 行数守卫：缓存行数必须与 DOM 实际节点数一致，否则说明日志区被外部（回放渲染等）改写过 */
  if(!prev || !prev.length || !lines.length || log.childNodes.length!==prev.length){ rebuild(); _detailLogCache=lines; return; }
  /* 公共前缀；前缀覆盖全部旧行即纯追加 */
  let head=0; const maxHead=Math.min(prev.length,lines.length);
  while(head<maxHead && prev[head]===lines[head]) head++;
  if(head===prev.length){
    const fragment=document.createDocumentFragment();
    for(let i=head;i<lines.length;i++) fragment.appendChild(makeNode(lines[i]));
    log.appendChild(fragment);
    _detailLogCache=lines; return;
  }
  /* 公共后缀（不与前缀重叠） */
  let tail=0; const maxTail=maxHead-head;
  while(tail<maxTail && prev[prev.length-1-tail]===lines[lines.length-1-tail]) tail++;
  if(prev.length-head-tail>0){
    /* 窗口平移检测：日志触顶后每次刷新淘汰头部 k 行、尾部新增若干行 */
    const regionPrev=prev.length-head, regionLines=lines.length-head;
    let shifted=0;
    if(regionLines>0){
      const maxK=Math.min(regionPrev,2048);
      for(let k=1;k<=maxK;k++){
        const overlap=regionPrev-k;
        if(overlap<0||overlap>regionLines) continue;
        if(overlap>0 && prev[head+k]!==lines[head]) continue;
        if(overlap>1 && prev[prev.length-1]!==lines[head+overlap-1]) continue;
        let ok=true;
        for(let j=0;j<overlap;j++){ if(prev[head+k+j]!==lines[head+j]){ ok=false; break; } }
        if(ok){ shifted=k; break; }
      }
    }
    if(shifted>0){
      for(let i=0;i<shifted;i++) log.removeChild(log.childNodes[head]);
      const from=head+regionPrev-shifted;
      const fragment=document.createDocumentFragment();
      for(let i=from;i<lines.length;i++) fragment.appendChild(makeNode(lines[i]));
      log.appendChild(fragment);
      _detailLogCache=lines; return;
    }
  }
  if(head+tail>0){
    /* 中部替换：移除 prev[head, prev.length-tail)，原位插入 lines[head, lines.length-tail) */
    const remove=prev.length-head-tail;
    for(let i=0;i<remove;i++) log.removeChild(log.childNodes[head]);
    const insert=lines.length-head-tail;
    if(insert>0){
      const fragment=document.createDocumentFragment();
      for(let i=head;i<head+insert;i++) fragment.appendChild(makeNode(lines[i]));
      const ref=log.childNodes[head]||null;
      if(ref) log.insertBefore(fragment,ref); else log.appendChild(fragment);
    }
    _detailLogCache=lines; return;
  }
  rebuild();
  _detailLogCache=lines;
}
function detailLogLinesFor(stage,ctx,node){
  if(ctx&&ctx.remotePreview===true){
    /* 孤儿中断预览：来源页面已刷新/关闭，日志通道不存在（pullRemoteQueueLog 只服务 server 客户端） */
    if(ctx.orphanPreview===true) return ['来源页面已刷新/关闭，执行中断，以上为最后已知的阶段状态；运行日志不可拉取，已产出的日志与产物请查看归档目录。'];
    if(ctx.remoteClientId!=='server') return ['其他浏览器仅同步阶段状态、进度和耗时；运行日志、脚本参数和凭据不会跨浏览器传输。'];
    const live=ctx.remoteLogs&&ctx.remoteLogs[stage.id];
    if(!live) return ['正在获取该阶段的最新运行日志…'];
    const shown=stageOutputLines({stdout:live.text,_stdoutTruncated:live.truncated},LIVE_LOG_TAIL_LIMIT);
    const lines=[];
    if(shown.omitted) lines.push('… 详情仅显示服务端日志末尾 '+LIVE_LOG_TAIL_LINES+' 行，完整内容请查看运行归档。');
    shown.lines.forEach(line=>lines.push(line));
    if(!lines.length) lines.push('该阶段暂时没有日志输出。');
    return lines;
  }
  return buildLog(stage,ctx,node,DETAIL_LOG_LIMIT);
}
/* 本地执行标识：阶段详情徽标旁展示「本地执行」。判定口径——历史日志条目 / 阶段快照带 local:true
   （浏览器编排执行的本地前缀），或本页实时本地运行（非远端只读预览）的全部阶段。 */
function isLocalExecStage(stage, entry, ctx){
  if(entry && entry.local) return true;
  if(stage && stage.local) return true;
  if(ctx && ctx.remotePreview===true) return false;
  if(entry && (entry.local===false || entry.local===null)) return false;
  /* 实时本地运行：非远端预览且有运行上下文即视为本地执行（服务端预览的阶段由快照 local 标记） */
  return !!(ctx && ctx.remotePreview!==true && (ctx.id||ctx.tag||ctx.stages));
}
function appendLocalExecBadge(badge, isLocal){
  if(!badge || !isLocal) return;
  const b=document.createElement('span');
  b.className='dshell-badge';
  b.style.cssText='margin-left:6px;color:var(--dsw-alias-state-accent-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-accent-primary) 40%, transparent);font-size:10px;';
  b.textContent='本地执行';
  b.title='本阶段由浏览器本地执行（非服务端）';
  badge.appendChild(b);
}
function detailContextRows(stage,statusText,ctx){
  const rows = [
    ['阶段', stage.name],
    ['状态', statusText],
    ['流水线', ctx.pipelineName||curPipeline().name],
    ['分支', ctx.branch||'main'],
    ['策略', ctx.strategy||'—'],
    ['执行人', ctx.by||'—'],
    ['环境', ctx.env],
    ['执行方式', isLocalExecStage(stage, null, ctx)?'本地执行':'服务端执行'],
  ];
  if(ctx.remotePreview===true) rows.push(['镜像','未同步'],['Commit','未同步']);
  else rows.push(['镜像',(ctx.registry||REGISTRY)+'/'+ctx.image+':'+ctx.tag],['Commit',ctx.commit]);
  return rows;
}
/* 阶段详情「日志文件」行的路径解析：优先阶段上已落盘的服务端日志（_serverLogFile），
   其次执行前算出的预期路径（_serverLogExpectedFile，运行中未落盘时先给出预期位置），
   都没有则按运行上下文现算（归档目录 + run-<tag>-NN-任务名.log）；运行无归档返回 null。
   页面函数声明提升不受定义顺序限制（archiveFolderFor/stageSeq/taskLogFile 在本文件后部）。 */
function stageLogFileFor(stage, rc){
  if(stage && stage._serverLogFile) return stage._serverLogFile;
  if(stage && stage._serverLogExpectedFile) return stage._serverLogExpectedFile;
  /* 跨浏览器快照同步的日志路径属性：其他浏览器直接读，无需本地推算 */
  if(stage && stage.logFile) return stage.logFile;
  /* 跨浏览器只读预览无 logFile 属性时不得用本页 archiveDir + 当前时间戳拼假日志路径 */
  if(rc && rc.remotePreview===true) return null;
  const folder=archiveFolderFor(rc);
  if(!folder) return null;
  const idx=rc && rc.stages ? rc.stages.indexOf(stage) : -1;
  if(idx<0) return null;
  return folder+'/'+taskLogFile(rc, stageSeq(rc.stages, idx), stage.name);
}
/* 阶段详情「AI 分析」按钮的作用记录：回放态取当前回放行；实时态按 tag 找回本次运行的
   历史记录（启动即写入「进行中」条目，见 beginRunHistory）；都没有返回 null（按钮随之禁用）。 */
function currentStageAnalysisRec(){
  if(replayRec) return replayRec;
  if(curRun && curRun.tag) return history.find(h=>h.tag && h.tag===curRun.tag) || null;
  return null;
}
/* 阶段详情「日志文件」行：展示本阶段归档日志文件路径，右侧提供「AI 分析」「打开日志」
   两个按钮；过程/结果提示写入紧随其后的提示行（#stageLogTipRow，默认隐藏）。
   path 与 rec 都为空时不渲染本行（实时态未配置归档且运行未入历史、回放态旧记录无独立日志文件等）。
   「📄 打开日志」打开本阶段归档日志文件本身（文件尚未生成/已清理时才回退打开所在目录，
   此时效果同「📂 打开归档目录」）；「🔍 AI 分析」对本阶段发起阶段级日志分析（提示词含本阶段
   日志文件路径，模板见「设置」页分析配置「阶段日志分析」），详见两按钮的 title。 */
function appendStageLogRow(kv, stage, path, rec){
  if(!path && !rec) return;
  const replayMode=typeof replayRec!=='undefined' && !!replayRec;
  const row=document.createElement('div');
  row.className='dshell-kvRow'; row.id='stageLogRow'; row.style.alignItems='center';
  const key=document.createElement('span'); key.className='dshell-kvKey'; key.textContent='日志文件';
  const value=document.createElement('span'); value.className='dshell-kvValue'; value.id='stageLogPath';
  value.style.flex='1'; value.style.textAlign='left'; value.style.overflow='hidden';
  value.style.textOverflow='ellipsis'; value.style.whiteSpace='nowrap';
  value.textContent=path || '—';
  value.title=path || (replayMode ? '旧版内嵌日志记录，无独立日志文件' : '本阶段日志尚未归档（未配置归档目录或尚未执行）');
  const btns=document.createElement('span');
  btns.style.display='flex'; btns.style.gap='6px'; btns.style.alignItems='center'; btns.style.flex='none';
  const aiBtn=document.createElement('button');
  aiBtn.className='dshell-btn dshell-btnGhost mini'; aiBtn.type='button'; aiBtn.id='stageLogAiBtn';
  aiBtn.textContent='🔍 AI 分析';
  aiBtn.title='对本阶段发起 AI 日志分析：新建 AI 会话并填入阶段级提示词草稿，提示词含本阶段归档日志文件路径（需手动确认发送，不自动提交；提示词模板见「设置」页分析配置「阶段日志分析」）；本次运行尚未写入运行历史时禁用。';
  aiBtn.disabled=!rec;
  aiBtn.addEventListener('click', ()=>stageDetailAnalysis(stage, path));
  const openBtn=document.createElement('button');
  openBtn.className='dshell-btn dshell-btnGhost mini'; openBtn.type='button'; openBtn.id='stageLogOpenBtn';
  openBtn.textContent='📄 打开日志';
  openBtn.title='打开本阶段产生的归档日志文件本身（而非所在目录）：优先经 dsh-better-sidebar 侧边栏把日志开为编辑器标签（未装该插件或桥不可用时回退新浏览器标签页打开，弹窗被拦截会在下方提示行给出链接）；打开前等待日志落盘，文件尚未生成或已清理时回退打开所在目录（效果同「📂 打开归档目录」）；本阶段暂无归档日志文件时禁用。';
  openBtn.disabled=!path;
  openBtn.addEventListener('click', ()=>openStageLogFile(path));
  btns.appendChild(aiBtn); btns.appendChild(openBtn);
  row.appendChild(key); row.appendChild(value); row.appendChild(btns);
  kv.appendChild(row);
  const tipRow=document.createElement('div');
  tipRow.className='dshell-kvRow'; tipRow.id='stageLogTipRow'; tipRow.style.display='none';
  const tipKey=document.createElement('span'); tipKey.className='dshell-kvKey';
  const tip=document.createElement('span'); tip.className='dshell-kvValue dshell-muted'; tip.id='stageLogTip'; tip.style.fontSize='10px';
  tipRow.appendChild(tipKey); tipRow.appendChild(tip);
  kv.appendChild(tipRow);
}
/* 「🔍 AI 分析」点击：对本阶段发起阶段级 AI 日志分析（新建 AI 会话并填入提示词草稿，
   提示词含本阶段归档日志文件路径——即「日志文件」行展示的路径，经 extra 占位符 {stage}/{stageLogFile}
   注入「阶段日志分析」模板；与运行历史标题行分析按钮同一入口 createAnalysisChat，不自动发送）。 */
function stageDetailAnalysis(stage, logFile){
  const rec=currentStageAnalysisRec();
  if(!rec){ alert('未找到本次运行的历史记录，暂不能发起 AI 分析。'); return; }
  createAnalysisChat('stage',[rec],{ stage:(stage && stage.name)||'', stageLogFile:logFile||'（未归档）' });
}
function renderDetail(){
  if(replayRec){ renderReplayDetail(replayRec); return; }   // 历史回放态：详情/回显改由 renderReplayDetail 从 rec.logs 渲染
  const s = flowStages().find(x=>x.id===selectedId) || flowStages()[0];
  if(!s) return;
  const n = nodes[s.id] || {status:'idle'};
  const ctx = curRun || {commit:'—',env:'dev',branch:'main',image:DEFAULT_IMAGE,release:DEFAULT_IMAGE,tag:'—',by:'—',pipelineName:curPipeline().name,giturl:GITURL};
  const out=s._out;
  const textKey=value=>{ const text=String(value||''); return text.length+':'+text.slice(0,24)+':'+text.slice(-96); };
  const outputRevision=out && out._outputRevision!==undefined ? '|rev:'+String(out._outputRevision) : '';
  const outKey=out ? textKey(out.stdout)+'|'+textKey(out.stderr)+'|'+String(out.code)+'|'+String(out.done)+'|'+(out._stdoutTruncated?1:0)+(out._stderrTruncated?1:0)+outputRevision : '-';
  /* 脚本/HTTP/EvalTokens 的回显只由 _out 变化驱动；进度 tick 只改进度条。模拟阶段的 health 回显
     会随进度跨 25% 档位变化，因此仅为无 _out 的普通阶段保留分档键。先比键再 buildLog，避免长任务
     在日志静止后仍每 300ms 拆分完整 stdout。 */
  const progressLogKey=out || (s.script&&s.script.path) || s.kind==='http' || s.kind==='url' || s.kind==='jenkins' || s.kind==='evaltokens' ? '' : Math.floor((n.progress||0)/25);
  const key = s.id+'|'+n.status+'|'+outKey+'|'+progressLogKey+'|'+Object.keys(n.varsIn||{}).length+'|'+Object.keys(n.varsOut||{}).length+'|'+(curRun?curRun.tag:'-')+'|'+(viewActive()?1:0)+'|'+(curRun?String(stageLogFileFor(s,curRun)||'-'):'-')+'|'+(currentStageAnalysisRec()?1:0)+'|'+String(n.startedAt||0);
  if(key===_detailKey){ const b0=$('detailBar'); if(b0) b0.style.width=(n.status==='success'?100:(n.progress||0))+'%'; return; }
  _detailKey=key;
  const lines = detailLogLinesFor(s, ctx, n);
  $('detailTitle').textContent = s.name + ' · 阶段详情';
  const badge = $('detailBadge'); badge.innerHTML='';
  const map = {idle:['未开始',''], running:['进行中','dshell-badgeWait'], skipped:['跳过',''],
    success:['已完成','dshell-badgeDone'], failed:['错误','dshell-badgeDone'], aborted:['终止','']};
  const [txt,cls] = map[n.status]||['未开始',''];
  const b=document.createElement('span');
  if(n.status==='failed'){ b.className='dshell-badge'; b.style.color='var(--st-err)'; b.style.borderColor='color-mix(in srgb, var(--st-err) 40%, transparent)'; }
  else if(n.status==='skipped'){ b.className='dshell-badge'; b.style.color='var(--dsw-alias-label-tertiary)'; b.style.borderColor='var(--dsw-alias-border-l2)'; }
  else if(n.status==='aborted'){ b.className='dshell-badge'; b.style.color='var(--st-idle)'; b.style.borderColor='color-mix(in srgb, var(--st-idle) 40%, transparent)'; }   // 与运行历史徽标同色（灰）
  else b.className='dshell-badge '+cls;
  b.textContent=txt; badge.appendChild(b);
  appendLocalExecBadge(badge, isLocalExecStage(s, null, ctx));
  /* 失败阶段：可从本阶段重试（保留本次运行上下文，变量回滚到该阶段入口） */
  if(n.status==='failed' && !viewActive() && curRun && runStages && !runPreviewReadOnly(curRun) && !s.preset){
    const rb=document.createElement('button'); rb.className='dshell-btn dshell-btnGhost mini'; rb.style.marginLeft='6px';
    rb.textContent='↻ 从本阶段重试'; rb.title='保留本次运行的 commit/tag/环境，从本阶段继续执行';
    rb.addEventListener('click', ()=>retryFromStage(s.id));
    badge.appendChild(rb);
  }

  const kv = $('detailKv'); kv.innerHTML='';
  const rows = detailContextRows(s,txt,ctx);
  const _st0=Number(n.startedAt);
  if(Number.isFinite(_st0)&&_st0>0&&n.status!=='idle') rows.push(['开始时间', fmtStageStart(_st0)]);   // 未开始/跳过（从未启动）的阶段不展示
  if(n.status==='running') rows.push(['耗时', fmtDur(n.dur||0)]);
  if(n.status==='success'||n.status==='failed'||n.status==='aborted') rows.push(['耗时', fmtDur(n.dur)]);
  rows.forEach(([k,v])=>{ const r=document.createElement('div'); r.className='dshell-kvRow';
    r.innerHTML='<span class="dshell-kvKey">'+esc(k)+'</span><span class="dshell-kvValue">'+esc(v)+'</span>'; kv.appendChild(r); });
  /* 日志文件行：实时运行态展示本阶段归档日志文件路径，附 AI 分析与打开日志目录按钮 */
  if(curRun) appendStageLogRow(kv, s, stageLogFileFor(s,curRun), currentStageAnalysisRec());
  /* 阶段间变量传递：上游 stdout 的 KEY=VALUE 行注入下游；此处展示本阶段接收/产出的变量 */
  (function(){
    const vIn=n.varsIn, vOut=n.varsOut;
    const hasIn=vIn&&Object.keys(vIn).length, hasOut=vOut&&Object.keys(vOut).length;
    if(!hasIn&&!hasOut) return;
    const hdr=document.createElement('div'); hdr.className='dshell-kvRow'; hdr.style.marginTop='6px';
    hdr.innerHTML='<span class="dshell-kvKey" style="color:var(--dsw-alias-label-secondary)">传递变量</span><span class="dshell-kvValue dshell-muted" style="font-size:11px;">stdout KEY=VALUE 注入下游</span>';
    kv.appendChild(hdr);
    const cap=12, truncV=s=>{ s=String(s==null?'':s); return s.length>48?s.slice(0,48)+'…':s; };
    const rowsFrom=(obj,arrow,color)=>{ const all=Object.keys(obj); all.slice(0,cap).forEach(k=>{ const r=document.createElement('div'); r.className='dshell-kvRow'; r.innerHTML='<span class="dshell-kvKey" style="color:'+color+'">'+arrow+' '+esc(k)+'</span><span class="dshell-kvValue dshell-muted" style="font-size:11px">'+esc(truncV(obj[k]))+'</span>'; kv.appendChild(r); }); if(all.length>cap){ const r=document.createElement('div'); r.className='dshell-kvRow'; r.innerHTML='<span class="dshell-kvKey"></span><span class="dshell-kvValue dshell-muted" style="font-size:10px">…还有 '+(all.length-cap)+' 个</span>'; kv.appendChild(r); } };
    if(hasIn) rowsFrom(vIn,'←','var(--dsw-alias-label-tertiary)');
    if(hasOut) rowsFrom(vOut,'→','var(--log-ok)');
  })();

  const bar=$('detailBar'); const wrap=$('detailBarWrap');
  const pct = (n.status==='success'||n.status==='skipped')?100:(n.progress||0);
  bar.style.width=pct+'%';
  bar.style.background = n.status==='failed'?'var(--st-err)':(n.status==='success'?'var(--st-ok)':(n.status==='skipped'||n.status==='aborted'?'var(--st-idle)':'var(--st-run)'));
  wrap.style.display = (n.status==='running'||n.status==='success'||n.status==='failed'||n.status==='skipped'||n.status==='aborted')?'block':'none';

  const log=$('detailLog');
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;   // 用户停留在底部附近时才跟随最新日志
  syncDetailLogLines(log, lines);   // 增量渲染：只追加/淘汰变化的行，不再整区重建
  if(n.status==='idle' && !lines.length){ log.textContent='该阶段尚未运行。'; _detailLogCache=null; }   // textContent 覆盖了子节点，增量缓存一并失效
  if(stick) log.scrollTop = log.scrollHeight;
}
/* 日志行着色分类（详情面板与流式回显共用，两处规则保持一致勿单改） */
function logClass(ln){
  let cls='dim';
  if(/✓|✅|成功|passed|通过/.test(ln)) cls='ok';
  if(/✗|failed|失败|timed out|Rollback|回滚/.test(ln)) cls='err';
  if(/^\[Pipeline\]/.test(ln) || /docker|helm|kubectl/.test(ln)) cls='hi';
  return cls;
}
/* 详情回显只取有界尾部；未传 limit 的归档/汇总调用仍拿完整内容。stdout/stderr 的旧展示顺序保持不变。 */
function stageOutputLines(out, limit){
  const entries=[];
  let omitted=!!(out && (out._stdoutTruncated||out._stderrTruncated));
  const add=(text,prefix)=>{
    const raw=String(text||'');
    if(!raw) return;
    if(!limit){ raw.split('\n').forEach(l=>{ if(l!=='') entries.push(prefix+l); }); return; }
    const maxChars=Math.max(1024,Number(limit.maxChars)||256*1024);
    let start=Math.max(0,raw.length-maxChars);
    if(start>0){
      omitted=true;
      const newline=raw.indexOf('\n',start);
      if(newline>=0 && newline<raw.length-1) start=newline+1;
    }
    raw.slice(start).split('\n').forEach(l=>{ if(l!=='') entries.push(prefix+l); });
  };
  add(out&&out.stdout,''); add(out&&out.stderr,'✗ ');
  if(!limit) return {lines:entries,omitted};
  const maxLines=Math.max(1,Number(limit.maxLines)||1000);
  const maxChars=Math.max(1024,Number(limit.maxChars)||256*1024);
  let chars=0,start=entries.length;
  while(start>0 && entries.length-start<maxLines){
    const next=entries[start-1].length+1;
    if(chars+next>maxChars && start<entries.length) break;
    chars+=next; start--;
  }
  if(start>0) omitted=true;
  return {lines:entries.slice(start),omitted};
}
function buildLog(stage, ctx, n, displayLimit){
  const id=stage.id;
  if(stage.preset && (!stage.script || !stage.script.path)) return [(PRESET_DEF[stage.pkey]||{}).noScript || ('未配置「'+stage.name+'」脚本')];
  if(stage.skip || n.status==='skipped'){ return ["[Pipeline] stage { ("+stage.name+")", '⏭ 本阶段配置为不执行，已跳过。']; }
  if((stage.kind==='http'||stage.kind==='url'||stage.kind==='jenkins') && stageUrlOf(stage)){   // 兼容旧数据 kind:'url'/'jenkins'
    const lines=['$ GET '+stageUrlOf(stage)];
    const out=stage._out;
    if(!out||!out.done){
      // 请求中/被中止：已轮询到的部分回显也输出（归档时保留被中断任务的独立日志）
      const shown=stageOutputLines(out,displayLimit);
      if(shown.omitted) lines.push('… 详情仅显示日志末尾，完整内容请查看运行归档。');
      shown.lines.forEach(l=>lines.push(l));
      lines.push(n.status==='aborted'?'（HTTP 请求已中止）':'（HTTP 请求进行中…）');
    }
    else{
      const shown=stageOutputLines(out,displayLimit);
      if(shown.omitted) lines.push('… 详情仅显示日志末尾，完整内容请查看运行归档。');
      shown.lines.forEach(l=>lines.push(l));
      lines.push('[exit '+(out.code===undefined?'?':out.code)+']');
    }
    return lines;
  }
  if(stage.kind==='evaltokens' && stage.evaltokens){   // EvalTokens 任务运行阶段：启动新 run 并等待终态
    const et=stage.evaltokens;
    const lines=['$ EvalTokens run '+(et.taskId||et.taskName||'')];
    const out=stage._out;
    if(!out||!out.done){
      const shown=stageOutputLines(out,displayLimit);
      if(shown.omitted) lines.push('… 详情仅显示日志末尾，完整内容请查看运行归档。');
      shown.lines.forEach(l=>lines.push(l));
      lines.push(n.status==='aborted'?'（EvalTokens 轮询已中止）':'（EvalTokens 轮询进行中…）');
    }
    else{
      const shown=stageOutputLines(out,displayLimit);
      if(shown.omitted) lines.push('… 详情仅显示日志末尾，完整内容请查看运行归档。');
      shown.lines.forEach(l=>lines.push(l));
      lines.push('[exit '+(out.code===undefined?'?':out.code)+']');
    }
    return lines;
  }
  if(stage.script && stage.script.path){
    const sc=stage.script;
    const argStr=(sc.params||[]).filter(p=>p.kind==='pos').map(p=>(sc.values&&sc.values[p.key]!==undefined)?sc.values[p.key]:'').join(' ').replace(/\s+$/,'');   // 与 execScript 一致：仅展示显式值，识别到的默认值（参数框展示）未改动不预填/下发
    const interp=/\.py$/i.test(sc.name)?'python3':'bash';
    const lines=['$ '+interp+' '+sc.name+(argStr?(' '+argStr):'')];
    /* 与 execScript 下发规则一致：只展示显式配置的 env 参数（未配置的不下发，由运行级注入/脚本默认兜底） */
    const envPairs=(sc.params||[]).filter(p=>p.kind==='env'&&sc.values&&sc.values[p.key]!==undefined&&String(sc.values[p.key])!=='').map(p=>p.key+'='+sc.values[p.key]);
    if(envPairs.length) lines.push('# env: '+envPairs.join(' '));
    const out=stage._out;
    if(!out){ lines.push('（脚本执行中…）'); }
    else{
      /* 执行中实时回显：流式期间 s._out 为 {code:null} 的增量快照，stdout/stderr 照常展示；
         [exit] 仅在拿到退出码后（完成/失败）输出，避免执行中显示占位退出码 */
      const shown=stageOutputLines(out,displayLimit);
      if(shown.omitted) lines.push('… 详情仅显示日志末尾，完整内容请查看运行归档。');
      shown.lines.forEach(l=>lines.push(l));
      if(typeof out.code==='number') lines.push('[exit '+out.code+']');
    }
    return lines;
  }
  const fill = t => (t||'')
    .replace(/\{\{registry\}\}/g,REGISTRY).replace(/\{\{giturl\}\}/g,ctx.giturl||GITURL)
    .replace(/\{\{image\}\}/g,ctx.image).replace(/\{\{release\}\}/g,ctx.release)
    .replace(/\{\{tag\}\}/g,ctx.tag).replace(/\{\{commit\}\}/g,ctx.commit).replace(/\{\{env\}\}/g,ctx.env).replace(/\{\{by\}\}/g,ctx.by||'—').replace(/\{\{branch\}\}/g,ctx.branch||'main');
  let lines;
  if(LOGS[id]){ lines = LOGS[id].map(fill); }
  else {
    lines = ["[Pipeline] stage { ("+stage.name+")"];
    lines.push("执行步骤…");
  }
  if(id==='health'){
    if(n.status==='success'){
      lines.push('deployment "'+ctx.release+'" 已成功滚动发布');
      lines.push('NAME      READY   UP-TO-DATE   AVAILABLE   AGE');
      lines.push(ctx.release+'   3/3     3            3           1m');
      lines.push('✅ 安装成功：'+REGISTRY+'/'+ctx.image+':'+ctx.tag+' -> '+ctx.env+'/'+ctx.release);
    } else if(n.status==='failed'){
      lines.push('等待 deployment "'+ctx.release+'" 滚动更新完成：2/3 副本已更新…');
      lines.push('✗ 滚动更新超时');
      lines.push('');
      lines.push(...(LOGS.rollback.map(fill)));
    } else if(n.status==='running'){
      lines.push('等待 deployment "'+ctx.release+'" 滚动更新完成：'+Math.floor((n.progress||0)/25)+'/3 副本已更新…');
    }
  } else if(n.status==='success' && !LOGS[id]){
    lines.push('✓ '+stage.name+' 完成 ('+fmtDur(n.dur)+')');
  } else if(n.status==='failed' && !LOGS[id]){
    lines.push('✗ '+stage.name+' 失败');
  }
  return lines;
}
/* 归档不需要逐行 DOM 数组：保留 stdout 等大字符串的原始分片，仅插入少量命令 / 状态分隔。
   详情面板继续用 buildLog + 有界行数；任务日志和汇总日志用本函数交给 Blob 流式上传。 */
function appendArchivePart(parts,value){
  const text=String(value==null?'':value); if(!text) return;
  if(parts.length){ const prev=String(parts[parts.length-1]||''); if(!prev.endsWith('\n')&&!text.startsWith('\n')) parts.push('\n'); }
  parts.push(text);
}
function appendArchiveOutput(parts,stage,out){
  const archiveParts=stage._archiveOutputParts;
  if(Array.isArray(archiveParts)){
    /* _archiveOutputParts 是已经排好边界的连续原始流（Jenkins 分片可落在同一行中间）：
       仅在归档命令与首片之间补分隔，后续分片必须逐字拼接。 */
    let first=true;
    archiveParts.forEach(value=>{
      const text=String(value==null?'':value); if(!text) return;
      if(first){ appendArchivePart(parts,text); first=false; } else parts.push(text);
    });
  }else appendArchivePart(parts,stage._archiveStdout!=null?stage._archiveStdout:(out&&out.stdout));
  const stderr=String(out&&out.stderr||'');
  if(stderr) appendArchivePart(parts,'✗ '+stderr.replace(/\n(?=.)/g,'\n✗ '));
}
function buildLogParts(stage,ctx,n){
  const id=stage.id;
  if(stage.preset && (!stage.script || !stage.script.path)) return [(PRESET_DEF[stage.pkey]||{}).noScript || ('未配置「'+stage.name+'」脚本')];
  if(stage.skip || n.status==='skipped') return ["[Pipeline] stage { ("+stage.name+")\n⏭ 本阶段配置为不执行，已跳过。"];
  if((stage.kind==='http'||stage.kind==='url'||stage.kind==='jenkins') && stageUrlOf(stage)){
    const parts=['$ GET '+stageUrlOf(stage)],out=stage._out;
    appendArchiveOutput(parts,stage,out);
    appendArchivePart(parts,!out||!out.done?(n.status==='aborted'?'（HTTP 请求已中止）':'（HTTP 请求进行中…）'):'[exit '+(out.code===undefined?'?':out.code)+']');
    return parts;
  }
  if(stage.kind==='evaltokens' && stage.evaltokens){
    const et=stage.evaltokens,parts=['$ EvalTokens run '+(et.taskId||et.taskName||'')],out=stage._out;
    appendArchiveOutput(parts,stage,out);
    appendArchivePart(parts,!out||!out.done?(n.status==='aborted'?'（EvalTokens 轮询已中止）':'（EvalTokens 轮询进行中…）'):'[exit '+(out.code===undefined?'?':out.code)+']');
    return parts;
  }
  if(stage.script && stage.script.path){
    const sc=stage.script;
    const argStr=(sc.params||[]).filter(p=>p.kind==='pos').map(p=>(sc.values&&sc.values[p.key]!==undefined)?sc.values[p.key]:'').join(' ').replace(/\s+$/,'');
    const interp=/\.py$/i.test(sc.name)?'python3':'bash',parts=['$ '+interp+' '+sc.name+(argStr?(' '+argStr):'')];
    const envPairs=(sc.params||[]).filter(p=>p.kind==='env'&&sc.values&&sc.values[p.key]!==undefined&&String(sc.values[p.key])!=='').map(p=>p.key+'='+sc.values[p.key]);
    if(envPairs.length) appendArchivePart(parts,'# env: '+envPairs.join(' '));
    const out=stage._out;
    if(!out) appendArchivePart(parts,'（脚本执行中…）');
    else{ appendArchiveOutput(parts,stage,out); if(typeof out.code==='number') appendArchivePart(parts,'[exit '+out.code+']'); }
    return parts;
  }
  return [(buildLog(stage,ctx,n)||[]).join('\n')];
}
