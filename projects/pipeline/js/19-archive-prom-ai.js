/* ===== 19-archive-prom-ai.js · 产物归档、普罗数据采集与 AI 分析 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 9200–9837）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* ---------- 产物归档（任务日志 + 运行日志 + profiling，按「流水线名称_年月日时分秒」文件夹） ---------- */
function sanitizeFsName(s){ return String(s||'pipeline').replace(/[\\/:*?"<>|\s]+/g,'-').replace(/^-+|-+$/g,'') || 'pipeline'; }
function nowCompact(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return ''+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds()); }
async function apiMkdir(p){
  try{
    const r=await fetch('/api/worktable/mkdir',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p})});
    const j=await r.json(); return !(j && j.error);
  }catch(e){ return false; }
}
async function apiWrite(p, content){
  return trackArchiveWrite(p.slice(0,p.lastIndexOf('/')), async()=>{
    const r=await fetch('/api/worktable/write',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p, content})});
    const j=await r.json(); if(!r.ok || (j && j.error)) throw new Error((j&&j.error)||('HTTP '+r.status));
  });
}
async function apiWriteParts(p,parts){
  return trackArchiveWrite(p.slice(0,p.lastIndexOf('/')),async()=>{
    const body=new Blob((parts||[]).map(value=>String(value==null?'':value)),{type:'text/plain;charset=utf-8'});
    const r=await fetch('/api/worktable/write-stream?path='+encodeURIComponent(p),{method:'POST',headers:{'Content-Type':'text/plain; charset=utf-8'},body:body});
    const j=await r.json().catch(()=>null); if(!r.ok || (j && j.error)) throw new Error((j&&j.error)||('HTTP '+r.status));
  });
}
async function apiAppendParts(p,parts,append){
  const body=new Blob((parts||[]).map(value=>String(value==null?'':value)),{type:'text/plain;charset=utf-8'});
  const mode=append?'&mode=append':'';
  const r=await fetch('/api/worktable/write-stream?path='+encodeURIComponent(p)+mode,{method:'POST',headers:{'Content-Type':'text/plain; charset=utf-8'},body:body});
  const j=await r.json().catch(()=>null); if(!r.ok||(j&&j.error)) throw new Error((j&&j.error)||('HTTP '+r.status));
}
async function apiConcatFile(p,segments){
  const r=await fetch('/api/worktable/concat-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p,segments:segments||[]})});
  const j=await r.json().catch(()=>null); if(!r.ok||(j&&j.error)) throw new Error((j&&j.error)||('HTTP '+r.status));
}
function trackArchiveWrite(folder, task){
  let jobs=archiveWrites.get(folder);
  if(!jobs){ jobs=new Set(); archiveWrites.set(folder,jobs); }
  const job=Promise.resolve().then(task); jobs.add(job);
  const cleanup=()=>{ jobs.delete(job); if(!jobs.size&&archiveWrites.get(folder)===jobs) archiveWrites.delete(folder); };
  job.then(cleanup,error=>{
    cleanup(); archiveWriteErrors.delete(folder); archiveWriteErrors.set(folder,error);
    while(archiveWriteErrors.size>100) archiveWriteErrors.delete(archiveWriteErrors.keys().next().value);
  });
  return job;
}
async function waitArchiveWrites(folder){
  while(archiveWrites.has(folder)){
    const jobs=archiveWrites.get(folder);
    const pending=Array.from(jobs), results=await Promise.allSettled(pending);
    const failed=results.find(r=>r.status==='rejected');
    pending.forEach(job=>jobs.delete(job));
    if(!jobs.size && archiveWrites.get(folder)===jobs) archiveWrites.delete(folder);
    if(failed){ archiveWriteErrors.delete(folder); throw failed.reason; }
  }
  if(archiveWriteErrors.has(folder)){ const error=archiveWriteErrors.get(folder); archiveWriteErrors.delete(folder); throw error; }
}
function createClientStageLogSink(stage,ctx,seq,name){
  const folder=archiveFolderFor(ctx); if(!folder) return null;
  const file=folder+'/'+taskLogFile(ctx,seq,name);
  stage._serverLogPending=true; stage._serverLogExpectedFile=file; stage._serverLogFile=null; stage._logArchived=false;
  let tail=Promise.resolve(),first=true,failure=null,pendingCount=0,wroteAny=false;
  return {
    file,
    append(value){
      const text=String(value==null?'':value); if(!text) return tail;
      const previous=tail,appendMode=!first; first=false;
      pendingCount++; stage._serverLogPending=true;
      const next=trackArchiveWrite(folder,async()=>{
        await previous; if(failure) throw failure;
        if(!appendMode) await ensureArchiveFolder(folder);
        await apiAppendParts(file,[text],appendMode);
      });
      tail=next;
      next.then(()=>{ wroteAny=true; pendingCount--; stage._serverLogPending=pendingCount>0; stage._serverLogFile=file; stage._logArchived=true; },error=>{
        failure=error; pendingCount--; stage._serverLogPending=pendingCount>0; stage._serverLogFile=wroteAny?file:null; stage._logArchived=wroteAny;
        console.warn('[archive] 轮询任务日志流式写入失败'+(wroteAny?'，已保留此前完整前缀':'，改用页面尾窗兜底')+':',error);
      });
      return next;
    },
    async flush(){ try{ await tail; return failure?(wroteAny?file:null):file; }catch(e){ return wroteAny?file:null; } },
  };
}
/* 是否显式配置了归档根目录（留空=走保底，见 fallbackArchiveRoot） */
function archiveConfigured(){ return !!(archiveDir||'').trim(); }
/* 保底归档根：未配置 archiveDir 时，归档落到 scripts 目录同级的 runs/（仅当 scriptsDir 为绝对路径时可用）。
   仍按「流水线名称_年月日时分秒」文件夹组织，写 run-<tag>.log/.profile.json；但不执行归档脚本（归档脚本是「已配置归档」的专属能力，见 archiveRun）。 */
function fallbackArchiveRoot(){
  try{
    const sd=(scriptsDir||'').trim();
    if(!sd || sd.charAt(0)!=='/') return null;   // 相对路径（非 site 路由场景）无法可靠解析，降级为不归档
    const dir=sd.replace(/\/+$/,'').replace(/\/[^/]*$/,'');   // scriptsDir 同级目录（即 pipeline 目录）
    return (dir||'/')+'/runs';
  }catch(e){ return null; }
}
function archiveFolderFor(ctx){
  // 运行启动时已把归档文件夹快照到 ctx.archive，全程复用：保证各阶段注入的环境变量与
  // 末尾 archiveRun 写入 run-<tag>.log/.profile.json 的目录完全一致（运行中 archiveDir 改动不致漂移）。
  if(ctx && ctx.archive!==undefined) return ctx.archive;
  if(!ctx) return null;
  const sub=sanitizeFsName(ctx.pipelineName||curPipeline().name)+'_'+nowCompact();   // 「流水线名称_年月日时分秒」
  const root=(archiveDir||'').trim().replace(/\/+$/,'');
  if(root) return root+'/'+sub;
  // 未配置归档：保底落到 scripts 同级的 runs/，仍写 run-<tag>.log/.profile.json（不执行归档脚本）
  const fb=fallbackArchiveRoot();
  return fb ? fb+'/'+sub : null;
}
/* 确保归档文件夹存在：/api/worktable/mkdir 非递归（插件要求父目录已存在），失败时先补建父目录再重试 */
async function ensureArchiveFolder(folder){
  if(await apiMkdir(folder)) return true;
  await apiMkdir(folder.slice(0, folder.lastIndexOf('/')));
  return apiMkdir(folder);
}
/* 任务级日志归档：每个任务（阶段 / 预设任务）的回显即时写入归档文件夹的独立日志文件，
   命名 run-<tag>-NN-任务名.log（NN 为 01 起的阶段序号，00 为预设任务：系统预设 + 自定义预设）；失败仅告警，不影响运行结果。 */
/* 归档序号：预设任务固定 00（文件名含任务名，互不冲突）；正式阶段按剔除预设任务后的位置从 01 起，
   预设任务在阶段列表中的位置（编排顺序）不影响阶段编号 */
function stageSeq(stg, i){ let n=0; for(let j=0;j<=i&&j<stg.length;j++){ if(stg[j] && !stg[j].preset) n++; } return (stg[i] && stg[i].preset) ? 0 : n; }
function taskLogFile(ctx, seq, name){ return 'run-'+ctx.tag+'-'+String(seq).padStart(2,'0')+'-'+sanitizeFsName(name)+'.log'; }
async function archiveTaskLog(ctx, seq, name, content){
  const folder=archiveFolderFor(ctx);
  if(!folder) return null;
  return trackArchiveWrite(folder, async()=>{
    await ensureArchiveFolder(folder);
    const file=folder+'/'+taskLogFile(ctx, seq, name);
    if(Array.isArray(content)) await apiWriteParts(file,content); else await apiWrite(file,content);
    return file;
  });
}
/* EvalTokens 终态报告：按阶段序号/名称/run_id 独立命名，内容为 /api/v1/report 返回的完整 HTML。 */
function evaltokReportFile(ctx, seq, stageName, runId){
  return 'run-'+ctx.tag+'-'+String(seq).padStart(2,'0')+'-'+sanitizeFsName(stageName)+'-evaltokens-'+sanitizeFsName(runId)+'-report.html';
}
async function archiveEvaltokensReport(e, ctx, seq, stageName, runId){
  const folder=archiveFolderFor(ctx);
  if(!folder) return null;
  return trackArchiveWrite(folder,async()=>{
    const report=await evaltokFetchReport(e,runId);
    await ensureArchiveFolder(folder);
    const file=folder+'/'+evaltokReportFile(ctx, seq, stageName, runId);
    await apiWriteParts(file,[report]);   // HTML 可能接近 20MiB：走原始流，避免 JSON 转义再复制整份正文
    return file;
  });
}
/* 阶段完成即把本阶段回显重定向到归档文件夹的独立日志文件（内容同详情面板 buildLog）。
   _logArchived 去重：archiveRun 末尾对未即时归档的已完成阶段统一补齐；
   归档失败重置标记，交由末尾补齐重试；「从失败阶段重试」复位标记以便重写（见 retryFromStage）。 */
function archiveStageLog(stage, seq, ctx){
  ctx=ctx||curRun;
  if(stage._serverLogPending || stage._serverLogFile) return;   // 在途/已落盘的服务端日志不能由浏览器覆写
  if(!ctx || stage._logArchived || (stage._reportPendingAttempt&&stage._reportPendingAttempt===stage._evaltokAttempt)) return;
  if(!archiveFolderFor(ctx)) return;   // 未配置归档且保底根不可用：不归档
  stage._logArchived=true;
  const n=((ctx&&ctx.nodes)?ctx.nodes:nodes)[stage.id]||{status:'idle'};   // 运行上下文自带节点表（并行运行各归各）；缺省回退视图节点表
  let parts=[];
  /* URL 超大响应体的 _archiveOutputParts / 旧 _archiveStdout 由 buildLogParts 优先使用。 */
  try{ parts=buildLogParts(stage,ctx,n)||[]; }catch(e){}
  const job=archiveTaskLog(ctx, seq, stage.name, parts); stage._logArchivePromise=job;
  job.then(file=>{
    if(stage._logArchivePromise===job) stage._logArchivePromise=null;
    if(file){ stage._serverLogFile=file; stage._serverLogPending=false; stage._logArchived=true; }
  },e=>{
    if(stage._logArchivePromise===job) stage._logArchivePromise=null;
    stage._logArchived=false; console.warn('[archive] 阶段「'+stage.name+'」日志归档失败（不影响运行结果）:', e);
  });
  return job;
}
function archiveRun(rc, result){
  const folder=archiveFolderFor(rc);
  if(!folder) return;
  const ctx=rc, stages=rc.stages, runNodes=rc.nodes, reportWrites=(ctx.evaltokensReportWrites||[]).slice();
  const finalizeGeneration=(ctx._archiveFinalizeGeneration||0)+1; ctx._archiveFinalizeGeneration=finalizeGeneration;
  const previousFinalize=ctx._archiveFinalizeTail||Promise.resolve();   // 失败后重试会再次 finish：串行写入，保证最新结果最后落盘
  // 兜底补齐任务级日志：即时归档未覆盖的已完成阶段（如归档失败后重试）统一补写；
  // 未执行且无任何回显的阶段不归档；被中止的任务（running 时被置为 aborted 但已有部分回显）照常归档
  stages.forEach((s,idx)=>{
    const n=runNodes[s.id]||{status:'idle'};
    if(n.status==='running') return;
    const hasEcho=!!(s._out && (s._out.stdout || s._out.stderr));
    if(n.status==='idle' && !hasEcho) return;
    archiveStageLog(s, stageSeq(stages,idx), ctx);
  });
  const pendingTaskWrites=Array.from(archiveWrites.get(folder)||[]);   // finalize 入队前快照，避免把自己纳入等待造成死锁
  const endTs=Date.now(), pipelineName=ctx.pipelineName||curPipeline().name;
  const ctxSnapshot=Object.assign({},ctx,{vars:Object.assign({},ctx.vars||{})});
  const stageSnapshots=stages.map(s=>{
    const state=(s._reportArchiveState&&s._reportArchiveState.attempt===s._evaltokAttempt)?s._reportArchiveState:null;
    return {stage:Object.assign({},s,{_out:s._out}),node:Object.assign({},runNodes[s.id]||{status:'idle'},{varsOut:Object.assign({},(runNodes[s.id]&&runNodes[s.id].varsOut)||{})}),reportState:state};
  });
  const finalizeWrite=trackArchiveWrite(folder, async()=>{
    if(pendingTaskWrites.length) await Promise.allSettled(pendingTaskWrites);
    if(reportWrites.length) await Promise.allSettled(reportWrites);   // 报告及其阶段日志先落盘，归档脚本随后才能收集到完整目录
    await previousFinalize.catch(()=>{});
    if(ctx._archiveFinalizeGeneration!==finalizeGeneration) return false;   // 旧 finish 尚在等报告时又发生重试：只由最新 finish 写 canonical 汇总
    // 运行日志：等报告回调替换「归档中」后再生成；阶段/节点为 finish 时快照，不受后续重试或队列运行改写。
    /* exec-stream 在建目录/打开日志时可能尚未返回响应头；中止汇总仍引用请求发出前已知的预期路径。
       /concat-stream 与 writer 共用路径锁，会等 [aborted] 写入并 close 后再读，避免页面尾窗覆盖全量日志。 */
    const stageLogFiles=stageSnapshots.map((item,idx)=>item.reportState?.logFile||stages[idx]._serverLogFile||(stages[idx]._serverLogPending?stages[idx]._serverLogExpectedFile:null)||null);
    const logSegments=[];
    stageSnapshots.forEach((item,idx)=>{
      const s=item.stage, n=item.node;
      logSegments.push({text:'===== '+s.name+' ['+(n.status||'idle')+'] =====\n'});
      if(stageLogFiles[idx]) logSegments.push({path:stageLogFiles[idx]});
      else{
        const fallback=[]; buildLogParts(s,ctxSnapshot,n).forEach(part=>appendArchivePart(fallback,part));
        logSegments.push({text:fallback.join('')});
      }
      logSegments.push({text:'\n\n'});
    });
    logSegments.push({text:'[result] '+result+'\n'});
    // profiling：各阶段耗时/状态 + 总耗时等运行元数据
    const profile={
      pipeline: ctxSnapshot.pipelineName||null, tag: ctxSnapshot.tag, commit: ctxSnapshot.commit,
      env: ctxSnapshot.env, image: ctxSnapshot.image, by: ctxSnapshot.by, source: ctxSnapshot.source, result,
      startTime: new Date(ctxSnapshot.startTs).toISOString(),
      totalDurSec: Math.round((endTs-ctxSnapshot.startTs)/100)/10,
      vars: ctxSnapshot.vars||{},
      stages: stageSnapshots.map((item,idx)=>{
        const s=item.stage, n=item.node;
        const rec={ id:s.id, name:s.name, status:n.status||'idle', durSec:Math.round((n.dur||0)*10)/10, progress:Math.round(n.progress||0), script:(s.script&&s.script.name)||null, varsOut:n.varsOut||{} };
        const logFile=stageLogFiles[idx];
        if(logFile) rec.logFile=logFile;   // 本阶段独立回显日志（任务级归档）
        return rec;
      }),
    };
    await ensureArchiveFolder(folder);
    await apiConcatFile(folder+'/run-'+ctxSnapshot.tag+'.log',logSegments);
    await apiWrite(folder+'/run-'+ctxSnapshot.tag+'.profile.json', JSON.stringify(profile, null, 2));
    return true;
  });
  ctx._archiveFinalizeTail=finalizeWrite.catch(()=>false);
  finalizeWrite.then(async(wrote)=>{
    if(!wrote||ctx._archiveFinalizeGeneration!==finalizeGeneration) return;
    // 归档脚本：写完日志/profiling 后执行（可选），收集额外日志；
    //   注入 ARCHIVE_DIR=归档根目录（host 节点环境日志写到根目录，跨运行共享，不进单次运行文件夹）/
    //   ARCHIVE_FOLDER=本次运行归档文件夹/ARCHIVE_LOG_FILE/ARCHIVE_PROFILE_FILE 等，失败不影响运行结果。
    //   经 runCtx=ctx 传入已结束运行的快照，避免运行队列切换后读到新运行的 TARGET_*/IMAGE_*。
    //   脚本不存在（如默认 collect_logs.sh 尚未创建）时 scriptByName 返回 null，自动跳过。
    const scName=(((typeof runArchiveScriptName==='function')?runArchiveScriptName(ctxSnapshot):archiveScriptName)||'').trim();
    if(scName && archiveConfigured()){   // 归档脚本是「已配置归档」专属；保底归档（archiveDir 留空）不执行，避免关归档时仍跑节点日志收集
      const asc=scriptByName(scName);
      if(asc){
        try{
          const aroot=folder.slice(0, folder.lastIndexOf('/'))||'/';   // 归档根目录：由本次运行文件夹快照回推，运行中 archiveDir 改动不致漂移
          const ar=await execScript({name:asc.name,path:asc.path,params:[],values:{}},120000,{
            ARCHIVE_DIR:aroot, ARCHIVE_FOLDER:folder,
            ARCHIVE_LOG_FILE:folder+'/run-'+ctxSnapshot.tag+'.log',
            ARCHIVE_PROFILE_FILE:folder+'/run-'+ctxSnapshot.tag+'.profile.json',
            ARCHIVE_PIPELINE:pipelineName,
            ARCHIVE_TAG:ctxSnapshot.tag, ARCHIVE_RESULT:result
          }, ctxSnapshot);
          if(ar && ar.code!==0) console.warn('[archive] 归档脚本退出码 '+ar.code+'（不影响运行结果）');
        }catch(ee){ console.warn('[archive] 归档脚本执行失败（不影响运行结果）:', ee); }
      }else{ console.warn('[archive] 归档脚本未找到，跳过：', scName); }
    }
  }).catch(e=>console.warn('[archive] 归档失败（不影响运行结果）:', e));
}
/* ---------- 收集普罗数据：任务级采集（阶段勾选「收集普罗数据」）+ 手动补采（「📊 收集普罗数据」对话框） ----------
   脚本在「设置 → 普罗数据服务配置 → 收集脚本」按名选用（scripts 目录，留空=不启用）。
   任务级采集：编辑器勾选「收集普罗数据」的任务进入终态（成功/失败）后，按「任务开始→结束」时段后台调用收集脚本，
   产物写入本次运行归档目录的 {任务名}-{阶段序号}-普罗数据 文件夹（见 taskPromCollect），失败不阻断流水线。
   手动补采：「流水线编排」右下角「收集普罗数据」按钮作用于选中行（或运行中的流水线）：弹出对话框，起止时间
   默认取本次运行的开始时间与最后一个任务结束后的时间（运行中取当前时刻），可在对话框覆盖。
   收集时注入环境变量：PROM_START/PROM_END（ISO 带 Z）、VLLM_METRICS_START/VLLM_METRICS_END
   （Unix 秒，collect_vllm_metrics.py 的 --start/--end 默认取此）、PROMETHEUS_URL、
   MODEL_NAME/NAMESPACE/XDS_NAMESPACE（按默认占位 ${MODEL_PATH} / ${DEPLOY_STRATEGY}-${BY} 在采集时点解析，解析不出则不注入）、
   METRICS_OUTPUT_DIR（任务级={任务名}-{阶段序号}-普罗数据 文件夹，手动补采=归档文件夹/metrics）；
   时间经 execStreaming 流式回显到对话框日志区（接口不可用时降级一次性 exec）。
   打开对话框时先按产物目录检测该运行是否已收集（summary.json 或 snapshots/<时间戳>/summary.json），
   已在状态行展示收集归档目录。 */
function promSnapshotForRun(rc){   // 手动补采用：把默认 model_name/xds_namespace 占位按本次运行上下文解析为实际值，随历史记录保存（都解析不出则不注入）
  if(!rc) return null;
  const modelName=substPromTemplate(DEFAULT_PIPELINE_PROM.modelName, rc), xdsNamespace=substPromTemplate(DEFAULT_PIPELINE_PROM.xdsNamespace, rc);
  if(!modelName && !xdsNamespace) return null;
  return { enabled:true, modelName, xdsNamespace, startTime:'', endTime:'' };
}
function parseDurSec(s){   // 解析 fmtDur 输出（如 2m30s / 45s）为秒，用于旧记录无 startTs 时回推起点
  s=String(s||'').trim(); if(!s) return 0;
  let m=/^(\d+)m(\d+)s$/.exec(s); if(m) return parseInt(m[1],10)*60+parseInt(m[2],10);
  if((m=/^(\d+)m$/.exec(s))) return parseInt(m[1],10)*60;
  if((m=/^(\d+)s$/.exec(s))) return parseInt(m[1],10);
  return 0;
}
function msToDTLocal(ms){   // 毫秒 → datetime-local 本地时间值（YYYY-MM-DDTHH:MM:SS）
  if(!ms) return '';
  const d=new Date(ms); const p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}
function dtLocalToMs(s){   // datetime-local 值 → 毫秒（无时区按本地时间解析，非法返回 0）
  if(!s) return 0; const t=new Date(s).getTime(); return isNaN(t)?0:t;
}
function pmcContext(){   // 取收集目标运行上下文：编排区展示的在跑运行取该运行；否则取历史选中行（旧记录无 startTs 时用 ts-dur 回推）。起止时间先取运行起止，编辑器设了固定时段则覆盖（留空=自动）
  let startMs=0, endMs=0, ps=null, archive='', label='';
  if(viewActive() && curRun){
    startMs=curRun.startTs; endMs=Date.now(); ps=promSnapshotForRun(curRun); archive=curRun.archive||'';
    label='运行中 · '+esc(curRun.pipelineName||'')+' '+esc(curRun.env||'')+' · 执行人 '+esc(curRun.by||'');
  }else if(selHistoryIdx>=0 && history[selHistoryIdx]){
    const rec=history[selHistoryIdx];
    startMs=rec.startTs || (rec.ts ? rec.ts-parseDurSec(rec.dur)*1000 : 0);   // 旧记录无 startTs：用 ts-dur 回推
    endMs=rec.ts||0; ps=rec.prom||null; archive=rec.archive||'';
    label='#'+rec.no+' '+esc(rec.pipeline||'')+' '+esc(rec.env||'')+' · 执行人 '+esc(rec.by||'')+' · '+labelOf(rec.status);
  }else return null;
  if(ps && ps.enabled){   // 编辑器设了固定时段则覆盖运行起止（默认留空=自动取运行起止）
    const cs=ps.startTime ? dtLocalToMs(ps.startTime) : 0;
    const ce=ps.endTime ? dtLocalToMs(ps.endTime) : 0;
    if(cs) startMs=cs;
    if(ce) endMs=ce;
  }
  return { label, startMs, endMs, prom:ps, archive };
}
function buildPromCollectEnv(ctx, startMs, endMs, promCfg){   // 收集普罗数据注入脚本的环境变量：时间段（ISO + Unix 秒）+ 数据源 + 模型/命名空间 + 归档目录
  const p=promCfg||prom;   // 优先传本运行设置快照；缺省回落当前设置
  const env={
    METRICS_ACTION:'collect',
    PROM_START:new Date(startMs).toISOString(),
    PROM_END:new Date(endMs).toISOString(),
    VLLM_METRICS_START:String(Math.floor(startMs/1000)),
    VLLM_METRICS_END:String(Math.floor(endMs/1000)),
    PROMETHEUS_URL:(p&&p.url||'').trim(),
  };
  /* collect_vllm_metrics.py 的 --model-name 取 ARCH_NAME、--namespace 取 NAMESPACE；MODEL_NAME / XDS_NAMESPACE 为兼容其他脚本的同值副本 */
  if(ctx.prom && ctx.prom.enabled){
    if(ctx.prom.modelName){ env.ARCH_NAME=ctx.prom.modelName; env.MODEL_NAME=ctx.prom.modelName; }
    if(ctx.prom.xdsNamespace){ env.NAMESPACE=ctx.prom.xdsNamespace; env.XDS_NAMESPACE=ctx.prom.xdsNamespace; }
  }
  if(ctx.archive){ env.ARCHIVE_FOLDER=ctx.archive; env.METRICS_OUTPUT_DIR=promOutputDir(ctx); }   // 采集产物落入本次运行归档文件夹的 metrics 子目录（未归档则由脚本默认取 cwd 下 vllm-metrics）
  return env;
}
function promOutputDir(ctx){   // 收集产物目录：与 buildPromCollectEnv 注入的 METRICS_OUTPUT_DIR 一致——有归档=归档文件夹/metrics；未归档=脚本目录下 vllm-metrics（exec cwd=scriptsDir，脚本默认输出 cwd/vllm-metrics）
  if(ctx && ctx.archive) return ctx.archive.replace(/\/+$/,'')+'/metrics';
  const sd=(typeof runScriptsDir==='function')?runScriptsDir(ctx):scriptsDir;
  return (sd||'').replace(/\/+$/,'')+'/vllm-metrics';
}
/* 任务级普罗采集：勾选「收集普罗数据」的阶段进入终态（成功/失败）后，按「任务开始→结束」时段后台调用
   设置页收集脚本，产物目录=归档文件夹/{任务名}-{阶段序号}-普罗数据（未配置归档=脚本目录 vllm-metrics 下同规则）。
   采集不阻断流水线（后台进行，输出落产物目录 collect.log，失败仅告警）；_promT0 在 advance 分发时记录（开始时间），
   _promCollected 去重（advance/finish 各扫一次）；「从失败阶段重试」复位标记后重跑会重新采集。 */
function taskPromFolderName(name, seq){ return sanitizeFsName(name)+'-'+String(seq).padStart(2,'0')+'-普罗数据'; }
function taskPromOutputDir(rc, name, seq){
  const base=(rc && rc.archive) ? rc.archive.replace(/\/+$/,'') : (((typeof runScriptsDir==='function')?runScriptsDir(rc):scriptsDir)||'').replace(/\/+$/,'')+'/vllm-metrics';
  return base+'/'+taskPromFolderName(name, seq);
}
async function taskPromCollect(rc, s, seq, startMs, endMs){
  const dir=taskPromOutputDir(rc, s.name, seq);
  const promCfg=(typeof runPromCfg==='function')?runPromCfg(rc):prom;
  const scName=((promCfg&&promCfg.collectScript)||'').trim();
  if(!scName){ console.warn('[pipeline] 任务「'+s.name+'」已勾选收集普罗数据，但未在「设置 → 普罗数据服务配置」配置收集脚本，已跳过采集'); return; }
  const sc=scriptByName(scName);
  if(!sc || !sc.path){ console.warn('[pipeline] 任务「'+s.name+'」收集普罗数据跳过：收集脚本「'+scName+'」未在 scripts 目录找到'); return; }
  if(!(endMs>startMs)) endMs=startMs+1;
  const ps={enabled:true, modelName:substPromTemplate(DEFAULT_PIPELINE_PROM.modelName, rc), xdsNamespace:substPromTemplate(DEFAULT_PIPELINE_PROM.xdsNamespace, rc)};   // 默认占位按采集时点解析（与手动补采一致）
  const env=buildPromCollectEnv({prom:ps, archive:(rc&&rc.archive)||''}, startMs, endMs, promCfg);   // 时间段 + 数据源 + 模型/命名空间 + 归档目录（数据源取本运行设置快照）
  env.METRICS_OUTPUT_DIR=dir;   // 任务级产物目录覆盖默认 metrics 子目录：{任务名}-{阶段序号}-普罗数据
  const res=await execScript(sc, 0, env, rc, function(){}, null, dir+'/collect.log');   // 强制走流式接口：完整输出直接落 collect.log，页面不接收一次性大 JSON
  if(!res || res.code!==0) console.warn('[pipeline] 任务「'+s.name+'」收集普罗数据失败（exit '+(res&&res.code)+'，不影响流水线结果），输出见 '+dir+'/collect.log');
  else console.warn('[pipeline] 任务「'+s.name+'」普罗数据已收集 → '+dir);
}
function parallelPromCandidate(rc,group){
  if(!rc || !group) return null;
  let picked=null;
  for(let index=group.start;index<group.end;index++){
    const stage=rc.stages[index], node=stage&&rc.nodes[stage.id];
    if(!stage || !stage.promCollect || !stage._promT0 || !stage._promT1 || !node || (node.status!=='success'&&node.status!=='failed')) continue;
    const candidate={stage,index,startMs:stage._promT0,endMs:stage._promT1};
    if(!picked || candidate.endMs-candidate.startMs>picked.endMs-picked.startMs) picked=candidate;   // 相同耗时保留更早编排项
  }
  return picked;
}
function taskPromFinalize(rc){
  if(!rc || !rc.stages) return;
  pipelineStageGroups(rc.stages).forEach(group=>{
    const parallelGroup=group.parallel&&group.end-group.start>1;
    if(parallelGroup){
      const first=rc.stages[group.start];
      if(!first || first._promGroupCollected) return;
      const terminal=group.stages.every(stage=>{
        const node=stage&&rc.nodes[stage.id];
        return node&&(node.status==='success'||node.status==='failed'||node.status==='skipped'||node.status==='aborted');
      });
      if(!terminal) return;
      const picked=parallelPromCandidate(rc,group);
      if(!picked) return;
      group.stages.forEach(stage=>{ if(stage&&stage.promCollect) stage._promCollected=true; });
      first._promGroupCollected=true;
      taskPromCollect(rc,picked.stage,stageSeq(rc.stages,picked.index),picked.startMs,picked.endMs).catch(e=>console.warn('[pipeline] 任务「'+picked.stage.name+'」收集普罗数据异常（不影响流水线结果）:', e));
      return;
    }
    const index=group.start, stage=rc.stages[index];
    if(!stage || stage.preset || !stage.promCollect || !stage._promT0 || stage._promCollected) return;
    const node=rc.nodes[stage.id]; if(!node || (node.status!=='success'&&node.status!=='failed')) return;   // 串行/单成员并行任务保持逐任务采集
    stage._promCollected=true;
    taskPromCollect(rc,stage,stageSeq(rc.stages,index),stage._promT0,Date.now()).catch(e=>console.warn('[pipeline] 任务「'+stage.name+'」收集普罗数据异常（不影响流水线结果）:', e));
  });
}
function pmcResetLog(text){
  const log=$('pmcLog'); if(!log) return;
  const value=String(text==null?'':text), limit=256*1024;
  log.textContent=value.length>limit?value.slice(-limit):value;
  log._pmcChars=log.textContent.length; log._pmcTruncated=value.length>limit;
}
function pmcSay(text, cls){   // 追加文本到收集对话框日志区（cls: ''/ok/warn/err）；总文本与节点同步限制为 256 KiB
  const log=$('pmcLog'); if(!log) return;
  const limit=256*1024,nodeLimit=1000; let value=String(text==null?'':text); if(!value) return;
  if(value.length>=limit){ log.textContent=''; log._pmcChars=0; log._pmcTruncated=true; value=value.slice(-limit); }
  let overflow=(Number(log._pmcChars)||0)+value.length-limit;
  while(overflow>0 && log.firstChild){
    const first=log.firstChild, size=String(first.textContent||'').length;
    if(size<=overflow){ log.removeChild(first); log._pmcChars=Math.max(0,(Number(log._pmcChars)||0)-size); overflow-=size; }
    else{ first.textContent=String(first.textContent||'').slice(overflow); log._pmcChars=Math.max(0,(Number(log._pmcChars)||0)-overflow); overflow=0; }
    log._pmcTruncated=true;
  }
  const style=cls||'',last=log.lastChild;
  if(last&&last._pmcClass===style&&String(last.textContent||'').length+value.length<=32*1024) last.textContent=String(last.textContent||'')+value;
  else{
    const span=document.createElement('span'); if(cls) span.className=cls;
    span._pmcClass=style; span.textContent=value; log.appendChild(span);
  }
  log._pmcChars=(Number(log._pmcChars)||0)+value.length;
  while(((log.children&&log.children.length)||0)>nodeLimit&&log.firstChild){
    const first=log.firstChild,size=String(first.textContent||'').length; log.removeChild(first);
    log._pmcChars=Math.max(0,(Number(log._pmcChars)||0)-size); log._pmcTruncated=true;
  }
  log.scrollTop=log.scrollHeight;
}
async function pmcDetectExisting(ctx){
  const el=$('pmcStatus'); if(!el) return;
  const dir=promOutputDir(ctx);
  const seq=++pmcDetectSeq;
  const show=(t,c)=>{ if(seq!==pmcDetectSeq || el!==$('pmcStatus')) return; el.textContent=t; el.style.color=c||''; };
  if(!dir || dir==='/vllm-metrics'){ show(''); return; }
  show('正在检测该运行是否已收集普罗数据…');
  try{
    await apiWrite(PMC_CHECK, PMC_CHECK_SCRIPT);   // 幂等重写助手脚本（内容固定）
    const r=await fetch('/api/worktable/exec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:PMC_CHECK,args:[dir],timeoutMs:10000})});
    const j=await r.json();
    if(j && j.error){ show('⚠ 已收集检测失败：'+String(j.error).slice(0,120),'var(--log-warn)'); return; }
    if(j.code===0){
      const found=String(j.stdout||'').trim().split('\n').pop()||dir;   // 助手脚本回显检出的产物目录
      show('✓ 该运行已收集普罗数据，收集归档目录：'+found,'var(--log-ok)');
    }else show('未检测到已收集的普罗数据（本次收集产物目录：'+dir+'）');
  }catch(e){ show('⚠ 已收集检测失败：'+String(e.message||e).slice(0,120),'var(--log-warn)'); }
}
function pmcShow(){
  const ctx=pmcContext();
  const dlg=$('pmcDialog'), meta=$('pmcMeta'), log=$('pmcLog');
  pmcResetLog('配置收集脚本后点「收集」执行（输出实时回显）。'); log.style.color='';
  pmcCtxCurrent=ctx;
  if(!ctx){
    meta.textContent='⚠ 请先点击选择一条运行历史，或运行一条流水线后再收集。'; meta.style.color='var(--log-warn)';
    $('pmcStatus').textContent=''; $('pmcStatus').style.color=''; pmcDetectSeq++;
    $('pmcStart').value=''; $('pmcEnd').value=''; $('pmcRun').disabled=true; $('pmcResetTimes').disabled=true;
  }else{
    const ps=ctx.prom && ctx.prom.enabled;
    meta.textContent=ctx.label + (ps ? ' · 收集普罗数据：model_name='+(ctx.prom.modelName||'(空)')+(ctx.prom.xdsNamespace?(' · xds_namespace='+ctx.prom.xdsNamespace):'') : ' · 未解析到 MODEL_NAME/NAMESPACE（不注入）');
    meta.style.color='';
    $('pmcStart').value=msToDTLocal(ctx.startMs);
    $('pmcEnd').value=msToDTLocal(ctx.endMs);
    $('pmcRun').disabled=false; $('pmcResetTimes').disabled=false;
  }
  $('pmcRun').textContent='▶ 收集';
  dlg.style.display='flex';
  if(ctx) pmcDetectExisting(ctx);   // 先检测该运行是否已收集普罗数据并展示目录
}
function pmcResetTimes(){   // 「还原」：恢复为本次运行的起止时间
  if(!pmcCtxCurrent) return;
  $('pmcStart').value=msToDTLocal(pmcCtxCurrent.startMs);
  $('pmcEnd').value=msToDTLocal(pmcCtxCurrent.endMs);
}
async function pmcCollect(){
  const ctx=pmcCtxCurrent;
  if(!ctx || pmcRunning) return;
  const scName=(prom.collectScript||'').trim();
  const log=$('pmcLog');
  pmcResetLog('');
  if(!scName){ pmcSay('✗ 未配置收集脚本：请在「设置 → 普罗数据服务配置 → 收集脚本」选用 scripts 目录中的脚本（如 collect_vllm_metrics.py）。\n','err'); return; }
  const sc=scriptByName(scName);
  if(!sc || !sc.path){ pmcSay('✗ 收集脚本「'+scName+'」未在 scripts 目录找到（已配置目录：'+(scriptsDir||'（未配置）')+'）。\n','err'); return; }
  const startMs=dtLocalToMs($('pmcStart').value), endMs=dtLocalToMs($('pmcEnd').value);
  if(!startMs || !endMs){ pmcSay('✗ 起止时间不完整：请填写开始时间与结束时间。\n','err'); return; }
  if(startMs>=endMs){ pmcSay('✗ 时间参数错误：开始时间必须早于结束时间。\n','err'); return; }
  const env=buildPromCollectEnv(ctx, startMs, endMs);   // 时间段 + 数据源 + 模型/命名空间 + 归档目录（见 buildPromCollectEnv）
  pmcRunning=true; pmcAbort=new AbortController();
  const btn=$('pmcRun'); btn.textContent='采集中…'; btn.disabled=true;
  pmcSay('$ '+sc.name+'  PROM_START='+env.PROM_START+'  PROM_END='+env.PROM_END+'\n','');
  const onStream=(m)=>{ pmcSay((m.type==='err'?'✗ ':'')+m.text, m.type==='err'?'err':''); };
  let res=null;
  try{
    res=await execStreaming(sc.path, [], env, scriptsDir, 0, onStream, pmcAbort.signal);
    if(!res){   // 旧插件构建无 exec-stream 路由：降级一次性 exec，回放已收到的输出
      try{
        const r=await fetch('/api/worktable/exec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:sc.path,args:[],env,cwd:scriptsDir,timeoutMs:0}),signal:pmcAbort.signal});
        const j=await r.json();
        if(j && j.error) res={code:1, stdout:'', stderr:String(j.error)};
        else res={code:(j&&j.code!==undefined)?j.code:1, stdout:(j&&j.stdout)||'', stderr:(j&&j.stderr)||''};
        if(res.stdout) onStream({type:'out', text:res.stdout});
        if(res.stderr) onStream({type:'err', text:res.stderr});
      }catch(e){ if(e && e.name==='AbortError') return; res={code:1, stdout:'', stderr:String(e.message||e)}; onStream({type:'err', text:res.stderr}); }
    }
  }catch(e){
    if(e && e.name==='AbortError') return;
    res={code:1, stdout:'', stderr:String(e.message||e)}; onStream({type:'err', text:res.stderr});
  }finally{
    pmcRunning=false; pmcAbort=null;
    btn.textContent='▶ 收集'; btn.disabled=false;
  }
  if(res && res.code!==null && res.code!==undefined){
    pmcSay('\n[exit '+(res.code)+']'+(res.code===0?' ✓ 采集完成':' ✗ 采集失败'), res.code===0?'ok':'err');
    if(res.code===0) pmcDetectExisting(ctx);   // 采集成功后刷新状态行为「已收集 + 目录」
  }
}
/* ---------- AI 分析（历史标题行按钮 / 阶段详情「🔍 AI 分析」→ 新建 AI 会话；提示词在「分析配置」页维护） ---------- */
function loadPrompts(){ try{ const p=JSON.parse(localStorage.getItem('pip-analysisPrompts')); if(p && typeof p==='object') return Object.assign({}, DEFAULT_PROMPTS, p); }catch(e){} return Object.assign({}, DEFAULT_PROMPTS); }
function savePrompts(){ try{ localStorage.setItem('pip-analysisPrompts', JSON.stringify(analysisPrompts)); }catch(e){} persistState(); }
/* 分析选择与回放选择相互独立：tag 是运行主键；旧记录无 tag 时用稳定元数据拼接，支持跨分页保留勾选。 */
function analysisHistoryKey(rec){
  if(rec && rec.tag) return 'tag:'+rec.tag;
  return 'run:'+[(rec&&rec.ts)||'',(rec&&rec.no)||'',(rec&&rec.pipeline)||'',(rec&&rec.commit)||''].join(':');
}
function toggleAnalysisHistory(rec, checked){
  const key=analysisHistoryKey(rec), pos=analysisHistoryKeys.indexOf(key);
  if(checked && pos<0){
    if(analysisHistoryKeys.length>=2){ alert('运行历史分析最多选择 2 条。'); return false; }
    analysisHistoryKeys.push(key);
  }else if(!checked && pos>=0) analysisHistoryKeys.splice(pos,1);
  renderHistory();
  return true;
}
function selectedAnalysisHistory(){
  return analysisHistoryKeys.map(key=>history.find(rec=>analysisHistoryKey(rec)===key)).filter(Boolean);
}
function pruneAnalysisHistory(){
  const valid=new Set(history.map(analysisHistoryKey));
  analysisHistoryKeys=analysisHistoryKeys.filter(key=>valid.has(key)).slice(0,2);
}
function analysisSummary(rec){ return '#'+rec.no+' 流水线「'+rec.pipeline+'」 环境 '+rec.env+' · 执行人 '+rec.by+' · 状态 '+labelOf(rec.status)+' · 耗时 '+rec.dur+' · '+fmtHistTime(rec)+' · commit '+rec.commit; }
function buildAnalysisPrompt(kind, rec, extra){
  const tpl = analysisPrompts[kind] || DEFAULT_PROMPTS[kind] || '';
  const archive = rec.archive || '';
  const vars = {
    no:rec.no, pipeline:rec.pipeline, env:rec.env, by:rec.by, commit:rec.commit,
    status:labelOf(rec.status), dur:rec.dur, time:fmtHistTime(rec), tag:rec.tag||'',
    archive: archive || '（未归档）',
    summary: analysisSummary(rec),
    logFile: archive ? archive+'/run-'+rec.tag+'.log' : '（未归档）',
    profileFile: archive ? archive+'/run-'+rec.tag+'.profile.json' : '（未归档）',
  };
  /* 额外占位符（如阶段详情的 {stage}/{stageLogFile}）：调用方按场景注入，覆盖同名内置变量 */
  if(extra && typeof extra==='object') Object.keys(extra).forEach(k=>{ if(extra[k]!==undefined && extra[k]!==null) vars[k]=String(extra[k]); });
  return tpl.replace(/\{(\w+)\}/g, (m,k)=> vars[k]!==undefined ? String(vars[k]) : m);
}
function buildComparisonPrompt(kind, records){
  const focus=COMPARE_FOCUS[kind]||'关键结果与异常';
  const archived=records.filter(rec=>String((rec&&rec.archive)||'').trim()).length;
  const readGuide=archived===2
    ? '请先读取两次运行各自列出的归档文件'
    : (archived===1?'仅一条运行有归档，请读取该归档，并将另一条按运行摘要做有限对比':'两次运行均未归档，请基于运行摘要做有限对比并明确数据限制');
  return '请比较下面两次流水线运行，重点分析'+focus+'；明确指出改善、退化、可能原因和下一步优化建议。\n\n'
    +'===== 运行 A（基准） =====\n'+buildAnalysisPrompt(kind,records[0])+'\n\n'
    +'===== 运行 B（对比） =====\n'+buildAnalysisPrompt(kind,records[1])+'\n\n'
    +readGuide+'，再按「结论、关键差异、改善/退化、原因、建议」给出对比结果。';
}
function commonAnalysisArchiveFolder(records){
  const paths=records.map(rec=>String((rec&&rec.archive)||'').trim().replace(/\/+$/,'')).filter(Boolean);
  if(!paths.length) return archiveRootFolder()||null;
  if(paths.length===1) return paths[0];
  const absolute=paths.every(path=>path[0]==='/');
  const parts=paths.map(path=>path.split('/').filter(Boolean));
  const common=[];
  for(let i=0;i<parts[0].length;i++){
    if(parts.every(pathParts=>pathParts[i]===parts[0][i])) common.push(parts[0][i]);
    else break;
  }
  if(!common.length) return paths[0];
  const folder=(absolute?'/':'')+common.join('/');
  return folder==='/'?paths[0]:folder;
}
function buildAnalysisRequest(kind, records, extra){
  const recs=(Array.isArray(records)?records:[records]).filter(Boolean).slice(0,2);
  if(!recs.length) return {text:'',cwd:archiveRootFolder()||null};
  /* extra 额外占位符（阶段详情的 {stage}/{stageLogFile}）只对单运行分析生效；双运行对比不注入 */
  if(recs.length===1) return {text:buildAnalysisPrompt(kind,recs[0],extra),cwd:(recs[0].archive||'').trim()||archiveRootFolder()||null};
  /* 双运行从记录自身路径推导共同目录；配置后来改变时仍能读取旧归档。 */
  return {text:buildComparisonPrompt(kind,recs),cwd:commonAnalysisArchiveFolder(recs)};
}
/* 优先经父页面（工作台）暴露的 __dshNewChatSessionForCurrentProject 新建会话：
   会话归入当前项目设置的工作区；未设置/已失效时由工作台弹出本项目工作区选择，选定后继续；
   会话聊天列关闭时先打开。单次/双运行仍按归档目录生成 cwd 提示，绝对路径写进提示词供读取；
   提示词只填入输入框草稿（不自动提交，用户确认后手动发送）。旧版插件无新桥时依次退化为
   __dshNewChatSessionAt（归档目录 cwd + 草稿）及 __dshSessions/__dshPromptIntoSession（自动发送）路径。 */
async function createAnalysisChat(kind, records, extra){
  const P = window.parent;
  const request = buildAnalysisRequest(kind, records, extra);
  const text = request.text, cwd = request.cwd;
  if(P && typeof P.__dshNewChatSessionForCurrentProject==='function'){
    try{ await P.__dshNewChatSessionForCurrentProject(text, cwd || null); }
    catch(e){ alert('创建 AI 会话失败：'+(e && e.message ? e.message : e)); }
    return;
  }
  if(P && typeof P.__dshNewChatSessionAt==='function'){
    try{ await P.__dshNewChatSessionAt(text, cwd || null); }
    catch(e){ alert('创建 AI 会话失败：'+(e && e.message ? e.message : e)); }
    return;
  }
  const sessions = P && P.__dshSessions;
  if(!sessions || typeof sessions.create!=='function' || typeof P.__dshPromptIntoSession!=='function'){
    alert('无法创建 AI 会话：请在 DSH 工作台中打开本页面。'); return;
  }
  const sid = await sessions.create(cwd ? {cwd: cwd} : {});
  try{ if(P.__dshOpenSession) await P.__dshOpenSession(sid); }catch(e){}
  await P.__dshPromptIntoSession(sid, text);
}

/* ---------- 历史 & 统计 ---------- */
