/* ===== 17-stage-http-poll.js · HTTP 阶段（{VAR} 替换与触发轮询）、阶段完成状态服务端轮询 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 7964–8501）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* ---------- HTTP 阶段：{VAR} 占位符替换后 GET 触发 + 轮询结果（本地直连 / 远程走 proxy；复用连接模式） ----------
   变量传递：上游阶段变量（curRun.vars）自动注入为占位符取值；URL 响应体 / 任务控制台输出的 KEY=VALUE 行 /
   单行 JSON 对象（{"KEY":"VALUE"}）经 mergeStageVars 累计回 curRun.vars，传递给后续阶段。 */
function jkJobPath(job){ return '/job/'+String(job).split('/').map(encodeURIComponent).join('/job/')+'/'; }
/* 阶段填完整请求 URL（如 http://jenkins/job/app/job/{GIT_BRANCH}/buildWithParameters?token=xxx）：
   {VAR} 占位符由环境变量（GIT_BRANCH、IMAGE_NAME、上游产出变量等）替换并做 URL 编码，
   未定义的变量原样保留；URL 触发为对替换后的完整地址直接发 GET（等价 curl，URL 自含鉴权如 token 参数，
   不附加「Jenkins 服务配置」的用户名/令牌）；jkJobRef 仅取 URL 路径（剥掉尾部 build/buildWithParameters
   触发动作段），供轮询构建结果使用。 */
function jkIsUrl(job){ return /^https?:\/\//i.test(String(job||'').trim()); }
function jkSubstUrl(url, vars){
  return String(url||'').replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, function(m,k){
    const v=vars?vars[k]:undefined;
    return (v===undefined||v===null||v==='')?m:encodeURIComponent(String(v));
  });
}
function jkJobRef(job, vars){
  const raw=String(job||'').trim();
  if(!jkIsUrl(raw)) return jkJobPath(raw);
  const u=jkSubstUrl(raw, vars);
  /* URL 触发直接 GET 完整地址；这里仅取路径供轮询，尾部 build/buildWithParameters 动作段需剥掉 */
  try{ return new URL(u).pathname.replace(/\/+$/,'').replace(/\/(buildWithParameters|build)$/i,'')+'/'; }catch(e){ return u; }
}
/* 旧格式兼容：阶段仍填 Jenkins 任务 fullName（非 URL）时按 buildWithParameters 触发。
   Jenkins 触发构建必须 POST（GET 会返回 405 Method Not Allowed）。
   参数放在 form-urlencoded 请求体中（等价于旧版 query 传参）；
   CSRF 防护开启时需带 crumb——先经 crumbIssuer 尝试获取（API token 认证通常豁免，拿不到则直接 POST）。 */
async function jkFetchCrumb(j, auth, signal){
  const url=(j.url||'').replace(/\/+$/,'')+'/crumbIssuer/api/json';
  try{
    if(j.mode==='remote'){
      const r=await fetch('/api/worktable/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,method:'GET',headers:auth}),signal:signal});
      const p=await r.json(); if(p&&p.error) return null;
      if((p.status||0)!==200) return null;
      const c=JSON.parse(p.body||'{}'); if(c&&c.crumbRequestField&&c.crumb){ const h={}; h[c.crumbRequestField]=c.crumb; return h; }
      return null;
    }
    const r=await fetch(url,{headers:auth,cache:'no-store',signal:signal});
    if(!r.ok) return null;
    const c=await r.json(); if(c&&c.crumbRequestField&&c.crumb){ const h={}; h[c.crumbRequestField]=c.crumb; return h; }
  }catch(e){ if(signal&&signal.aborted) throw e; }
  return null;
}
/* jobPath 为已解析的任务路径（fullName 经 jkJobPath / URL 经 jkJobRef 得到，占位符已替换） */
async function jkTriggerBuild(jobPath, params, preflightSignal, dispatchSignal, j){
  j=j||jenkins; const base=(j.url||'').replace(/\/+$/,'');
  const body=Object.keys(params).map(function(k){ return encodeURIComponent(k)+'='+encodeURIComponent(params[k]); }).join('&');
  const url=base+jobPath+'buildWithParameters';
  const auth=(j.user||j.token)?{Authorization:'Basic '+btoa(j.user+':'+j.token)}:{};
  const crumb=await jkFetchCrumb(j, auth, preflightSignal);
  if(preflightSignal&&preflightSignal.aborted){ const aborted=new Error('aborted'); aborted.name='AbortError'; throw aborted; }
  const headers=Object.assign({}, auth, crumb||{}, {'Content-Type':'application/x-www-form-urlencoded'});
  const signal=dispatchSignal||preflightSignal;
  if(j.mode==='remote'){
    const r=await fetch('/api/worktable/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,method:'POST',headers:headers,body:body}),signal:signal});
    const p=await r.json(); if(p&&p.error) throw new Error(p.error);
    if((p.status||0)>=400 && (p.status||0)!==302 && (p.status||0)!==303) throw new Error('HTTP '+(p.status||0));
    return {body:'',location:jkHeaderValue(p.headers,'location')};
  }
  const r=await fetch(url,{method:'POST',headers:headers,body:body,cache:'no-store',signal:signal});
  if(!r.ok && r.status!==302 && r.status!==303) throw new Error('HTTP '+r.status);
  return {body:'',location:jkHeaderValue(r.headers,'location')};
}
/* 任务 URL 触发：{VAR} 占位符替换后直接 GET 完整地址（等价 curl——此类 URL 本身就是 GET 触发的接口地址）。
   URL 视为自包含：不拼 buildWithParameters、不带 crumb、不附加「Jenkins 服务配置」的用户名/令牌（鉴权信息如
   token 由 URL 自带）；连接模式仍生效：本地=浏览器直连（需 CORS/同源），远程=经 /api/worktable/proxy 代连。 */
async function jkTriggerGet(url, signal, j){
  j=j||jenkins;
  if(j.mode==='remote'){
    const r=await fetch('/api/worktable/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,method:'GET'}),signal:signal});
    const p=await r.json(); if(p&&p.error) throw new Error(p.error);
    if((p.status||0)>=400) throw new Error('HTTP '+(p.status||0));
    return {body:typeof p.body==='string'?p.body:'',location:jkHeaderValue(p.headers,'location')};   // 响应体供变量解析，Location 精确关联本次 queue item
  }
  const r=await fetch(url,{cache:'no-store',signal:signal});
  if(!r.ok) throw new Error('HTTP '+r.status);
  let body='';
  try{ body=await readBrowserResponseText(r,20*1024*1024); }catch(e){ if(/响应正文过大/.test(String(e&&e.message||e))) throw e; }   // 跨域无 CORS 读不到体时不阻断触发成功
  return {body:body,location:jkHeaderValue(r.headers,'location')};
}
async function jkGetText(path, signal, j){
  j=j||jenkins; const base=(j.url||'').replace(/\/+$/,'');
  const url=base+path;
  const auth=(j.user||j.token)?{Authorization:'Basic '+btoa(j.user+':'+j.token)}:{};
  if(j.mode==='remote'){
    const r=await fetch('/api/worktable/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,method:'GET',headers:auth}),signal:signal});
    const p=await r.json(); if(p&&p.error) throw new Error(p.error); return p.body||'';
  }
  const r=await fetch(url,{headers:auth,cache:'no-store',signal:signal}); return readBrowserResponseText(r,20*1024*1024);
}
function jkHeaderValue(headers,name){
  if(!headers) return '';
  if(typeof headers.get==='function') return headers.get(name)||'';
  const want=String(name||'').toLowerCase();
  for(const key in headers){ if(String(key).toLowerCase()===want) return String(headers[key]||''); }
  return '';
}
/* Jenkins 官方 progressiveText 接口按服务端 offset 只返回新增控制台内容。
   404/405 或读不到 X-Text-Size（如 CORS 未 expose 响应头）时降级到 consoleText；不能按响应体长度
   猜 offset，因为 Jenkins 会把原始 LF 规范化成 CRLF 后再返回，而头里的 offset 仍指向原始日志。 */
async function jkGetProgressiveText(buildPath,start,signal){
  const j=jenkins; const base=(j.url||'').replace(/\/+$/,'');
  const path=String(buildPath||'').replace(/\/+$/,'')+'/logText/progressiveText?start='+encodeURIComponent(String(start||0));
  const url=base+path;
  const auth=(j.user||j.token)?{Authorization:'Basic '+btoa(j.user+':'+j.token)}:{};
  let status=0, headers=null, text='';
  if(j.mode==='remote'){
    const r=await fetch('/api/worktable/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,method:'GET',headers:auth}),signal:signal});
    const p=await r.json(); if(p&&p.error) throw new Error(p.error);
    status=Number(p&&p.status)||0; headers=p&&p.headers; text=String((p&&p.body)||'');
  }else{
    const r=await fetch(url,{headers:auth,cache:'no-store',signal:signal});
    status=r.status; headers=r.headers; text=await readBrowserResponseText(r,20*1024*1024);
  }
  if(status===404||status===405) return null;
  if(status<200||status>=300) throw new Error('HTTP '+status);
  const nextHeader=jkHeaderValue(headers,'x-text-size');
  const rawNext=nextHeader!==''?Number(nextHeader):NaN;
  if(!Number.isFinite(rawNext)||rawNext<start||(text&&rawNext===start)) return null;
  return {text:text,next:rawNext};
}
async function jkReadConsoleDelta(buildPath,start,useProgressive,signal){
  if(useProgressive){
    const delta=await jkGetProgressiveText(buildPath,start,signal);
    if(delta) return {text:delta.text||'',next:delta.next,progressive:true};
  }
  const full=await jkGetText(String(buildPath||'').replace(/\/+$/,'')+'/consoleText',signal);
  return {text:full.length>start?full.slice(start):'',next:full.length,progressive:false};
}
/* Jenkins 外部任务终止：已拿到构建号时 POST build/stop；仍在队列时按触发响应的 queue Location
   调 cancelItem。取消请求使用独立网络生命周期，不能复用已 aborted 的阶段 signal。 */
async function jkPostAction(url, signal){
  const j=jenkins; const auth=(j.user||j.token)?{Authorization:'Basic '+btoa(j.user+':'+j.token)}:{};
  const actionCtrl=signal?null:new AbortController(); const actionSignal=signal||(actionCtrl&&actionCtrl.signal);
  const timeout=actionCtrl?setTimeout(function(){ actionCtrl.abort(); },10000):null;
  try{
    const crumb=await jkFetchCrumb(j,auth,actionSignal); const headers=Object.assign({},auth,crumb||{});
    if(j.mode==='remote'){
      const r=await fetch('/api/worktable/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,method:'POST',headers:headers,body:''}),signal:actionSignal});
      const p=await r.json(); if(p&&p.error) throw new Error(p.error); const status=Number(p&&p.status)||0;
      if(status<200||status>=400) throw new Error('HTTP '+status);
      return;
    }
    const r=await fetch(url,{method:'POST',headers:headers,body:'',cache:'no-store',signal:actionSignal});
    if(!r.ok&&r.status!==302&&r.status!==303) throw new Error('HTTP '+r.status);
  }finally{
    if(timeout!==null) clearTimeout(timeout);
  }
}
async function jkCancelExecution(jobPath,buildNum,queueLocation){
  const base=(jenkins.url||'').replace(/\/+$/,'');
  const cancelCtrl=new AbortController(); const timeout=setTimeout(function(){ cancelCtrl.abort(); },10000);
  try{
    if(buildNum!=null){ await jkPostAction(base+jobPath+buildNum+'/stop',cancelCtrl.signal); return; }
    let queuePath='';
    try{ const u=new URL(queueLocation,base||undefined); const at=u.pathname.indexOf('/queue/item/'); if(at>=0) queuePath=u.pathname.slice(at).replace(/\/+$/,''); }catch(e){}
    const m=/\/queue\/item\/([^/]+)/.exec(queuePath);
    if(m){
      try{ await jkPostAction(base+'/queue/cancelItem?id='+encodeURIComponent(decodeURIComponent(m[1])),cancelCtrl.signal); return; }
      catch(cancelError){
        try{ const info=await jkFetchJson(jenkins,base+queuePath+'/api/json',cancelCtrl.signal); const n=Number(info&&info.executable&&info.executable.number); if(Number.isInteger(n)&&n>0){ await jkPostAction(base+jobPath+n+'/stop',cancelCtrl.signal); return; } }catch(e){ if(cancelCtrl.signal.aborted) throw e; }
        throw cancelError;
      }
    }
    throw new Error('Jenkins 取消缺少 queue item 或构建号');
  }finally{
    clearTimeout(timeout);
  }
}
function abortablePipelineDelay(ms,signal){
  return new Promise(function(resolve,reject){
    let timer=null,done=false;
    const cleanup=function(){ if(signal) signal.removeEventListener('abort',abort); };
    const finish=function(){ if(done) return; done=true; cleanup(); resolve(); };
    const abort=function(){
      if(done) return; done=true; if(timer!==null) clearTimeout(timer); cleanup();
      const error=new Error('aborted'); error.name='AbortError'; reject(error);
    };
    if(signal&&signal.aborted){ abort(); return; }
    timer=setTimeout(finish,Math.max(0,Number(ms)||0));
    if(signal) signal.addEventListener('abort',abort,{once:true});
  });
}
/* ---------- 阶段完成状态的服务端轮询（stage-poll） ----------
   「任务是否完成的轮询在服务端完成」：Jenkins/EvalTokens 阶段触发动作仍由本页发起（本地运行任务豁免），
   触发后的完成判定改为循环调用服务端长轮询端点——浏览器不再直连目标服务轮询；服务端持有等待窗口
   （最长 25s，可用 timeoutMs 调小）、增量控制台续传与上游连败兜底（30 次判败，{done:true,failed:'poll'}）。
   端点不可用时回退浏览器直连轮询（原实现保留在阶段内直连分支）：404=旧服务端无此路由；
   403=目标非内网（浏览器本可直连的公网服务，服务端策略不放行）。回退一次阶段内只发生一次并 console.warn。 */
async function stagePollRequest(path, body, signal){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal});
  if(r.status===404||r.status===403){ const err=new Error('stage-poll 不可用（HTTP '+r.status+'）'); err.stagePollFallback=r.status; throw err; }
  let j=null; try{ j=await r.json(); }catch(e){}
  if(!r.ok) throw new Error('stage-poll HTTP '+r.status+(j&&j.error?('：'+String(j.error)):''));
  if(!j||typeof j!=='object'||Array.isArray(j)) throw new Error('stage-poll 响应格式非法');
  return j;
}
async function runUrlStep(rc, i){
  const stg=rc.stages; const s=stg[i];
  const jkCfg=(typeof runJenkinsCfg==='function')?runJenkinsCfg(rc):jenkins;   // 本运行设置快照：Jenkins 地址/凭据/连接模式在启动时定格
  const raw=stageUrlOf(s);   // 兼容旧数据 kind:'url'/'jenkins' / jenkins.job（见 stageUrlOf）
  const outSpec=(s.url&&s.url.outVars)||(s.jenkins&&s.jenkins.outVars)||'';
  const tk=rc.token;
  const varsIn=Object.assign({},rc.vars||{});
  rc.nodes[s.id]={status:'running',progress:0,dur:0,sub:{},script:'HTTP · '+raw,varsIn:varsIn,varsOut:{},startedAt:Date.now()};
  runSetSel(rc,s.id); rcRender(rc,true);
  const t0=Date.now();
  const deadline=s.timeout?t0+s.timeout*1000:0;
  let deadlineTimer=null, startAbortTimer=null, timedOut=false, triggerCtrl=new AbortController();
  let cancelJobPath='', cancelQueueLocation='', cancelBuildNum=null, externalJenkinsActive=false;
  const ctrl=new AbortController(); rc.scriptAbort=ctrl;   // 停止按钮和阶段 deadline 共用：取消触发、轮询与控制台请求
  const scheduleTriggerAbort=function(){
    if(startAbortTimer===null&&!triggerCtrl.signal.aborted) startAbortTimer=setTimeout(function(){ triggerCtrl.abort(); },10000);
  };
  ctrl.signal.addEventListener('abort',scheduleTriggerAbort,{once:true});   // 给已发出的触发请求 10s 清理宽限，尽量取回 queue Location 后再取消
  const timeoutMessage=()=> 'HTTP/Jenkins 阶段超时（'+Math.max(0,Number(s.timeout)||0)+' 秒）';
  const ensureActive=()=>{
    if(rc.over||rc.token!==tk) return false;
    if(timedOut||(deadline&&Date.now()>=deadline)){ timedOut=true; if(!ctrl.signal.aborted) ctrl.abort(); throw new Error(timeoutMessage()); }
    return true;
  };
  const waitForPoll=()=>new Promise(function(resolve){
    let done=false, waitTimer=null;
    const stop=function(){ if(done) return; done=true; if(waitTimer!==null) clearTimeout(waitTimer); ctrl.signal.removeEventListener('abort',stop); resolve(); };
    if(ctrl.signal.aborted){ resolve(); return; }
    ctrl.signal.addEventListener('abort',stop,{once:true});
    waitTimer=setTimeout(stop,2000);
  });
  if(deadline) deadlineTimer=setTimeout(function(){ timedOut=true; if(!ctrl.signal.aborted) ctrl.abort(); },Math.max(0,deadline-Date.now()));
  if(rc.timer) clearInterval(rc.timer);
  /* 进度推进并入全局共享 tick（stageTickRun，全页面唯一 500ms interval，不再每阶段各起定时器）；
     rc.timer 改存进度任务键作在途标记（既有 clearInterval/rc.timer=null 收尾路径语义不变） */
  const _tick=globalThis.__pipelineStageTick||(globalThis.__pipelineStageTick={tasks:{},seq:0,timer:null});
  Object.keys(_tick.tasks).forEach(function(_k){ const _t=_tick.tasks[_k]; if(_t.rc===rc&&_t.stageId===s.id) delete _tick.tasks[_k]; });   // 同运行同阶段重注册去重（中止/重置后立即重试等）
  rc.timer='st'+(++_tick.seq)+'-'+s.id;
  _tick.tasks[rc.timer]={rc:rc,stageId:s.id,t0:t0,last:t0,rate:1/500};   // 节奏同原 500ms 定时器（每 tick +1）
  if(!_tick.timer&&!(typeof document!=='undefined'&&document.hidden)) _tick.timer=setInterval(function(){ if(typeof stageTickRun==='function') stageTickRun(); else { clearInterval(_tick.timer); _tick.timer=null; _tick.tasks={}; } },500);   // 页面隐藏时不起表（恢复可见时 visibilitychange 立即补 tick 再走表）；沙盒未抽取 stageTickRun 时自毁防空转
  const isUrl=jkIsUrl(raw);
  const logSink=createClientStageLogSink(s,rc,stageSeq(rc.stages,i),s.name);
  const log=createLiveLog('$ '+(isUrl?'GET':'POST')+' '+raw+(isUrl?'':'（旧格式 fullName，建议改为完整 URL，参数经 {GIT_BRANCH} 等占位符传递）'),logSink);
  const outputProbe=createOutputProbe(outSpec);
  /* 运行中详情与中止兜底只保留有界尾窗；完整分片由服务端日志 sink 持续落盘。 */
  s._archiveOutputParts=log.parts; s._archiveStdout=null;
  try{
    /* 占位符取值池（旧 fullName 触发时兼作构建参数）：上游阶段（脚本 stdout / URL 响应体）产出的
       KEY=VALUE / 单行 JSON 变量累计在 rc.vars，叠加运行级注入（TARGET_IP/IMAGE_NAME/GIT_BRANCH/ARCHIVE_DIR 等），
       优先级：上游变量 > 运行级全局默认（与脚本阶段一致）。 */
    const vars={};
    if(rc.vars){
      for(const k in rc.vars){ if(vars[k]===undefined) vars[k]=String(rc.vars[k]); }
    }
    const ctx0=(rc.envs&&rc.envs[0])||null;
    if(ctx0&&ctx0.ip&&vars.TARGET_IP===undefined) vars.TARGET_IP=ctx0.ip;
    if(rc.envs&&vars.TARGET_IPS===undefined) vars.TARGET_IPS=JSON.stringify(rc.envs.map(function(e){return e.ip;}));
    if(rc.image&&vars.IMAGE_NAME===undefined) vars.IMAGE_NAME=rc.image;
    if(rc.tag&&vars.IMAGE_TAG===undefined) vars.IMAGE_TAG=rc.tag;
    if(rc.pipelineName&&vars.PIPELINE_NAME===undefined) vars.PIPELINE_NAME=rc.pipelineName;
    if(rc.repoUrl&&vars.GIT_URL===undefined) vars.GIT_URL=rc.repoUrl;
    if(rc.branch&&vars.GIT_BRANCH===undefined) vars.GIT_BRANCH=rc.branch;
    if(rc.strategy&&vars.DEPLOY_STRATEGY===undefined) vars.DEPLOY_STRATEGY=rc.strategy;
    if(rc.weightsPath&&vars.MODEL_PATH===undefined) vars.MODEL_PATH=rc.weightsPath;   // 权重路径（主控可选填写）
    if(rc.presets&&vars.PIPELINE_PRESETS===undefined) vars.PIPELINE_PRESETS=JSON.stringify(rc.presets);   // 本次运行勾选的预设任务 key
    /* 归档路径：同脚本阶段注入，供下游作业把产物写入归档目录。 */
    if(rc.archive){
      if(vars.ARCHIVE_DIR===undefined) vars.ARCHIVE_DIR=rc.archive;
      if(vars.ARCHIVE_FOLDER===undefined) vars.ARCHIVE_FOLDER=rc.archive;
      if(rc.pipelineName&&vars.ARCHIVE_PIPELINE===undefined) vars.ARCHIVE_PIPELINE=rc.pipelineName;
      if(rc.tag&&vars.ARCHIVE_TAG===undefined) vars.ARCHIVE_TAG=rc.tag;
    }
    /* {VAR} 占位符用上面注入完成的环境变量替换（URL 编码）后，对完整 URL 直接 GET 触发（等价 curl）；
       jobPath 仅取 URL 路径（已剥掉触发动作段），构建身份一律由本次响应的 queue Location 解析。 */
    const jobPath=jkJobRef(raw, vars);
    const pollable=/\/job\//.test(jobPath);   // 非标准任务路径（如 webhook 触发地址）无法定位任务，跳过轮询
    cancelJobPath=jobPath;
    appendLiveLog(log,'# vars: '+Object.keys(vars).map(function(k){return k+'='+vars[k];}).join(' '));
    if(isUrl) appendLiveLog(log,'# trigger url: '+jkSubstUrl(raw, vars));
    s._out=liveOutputSnapshot(log.live,{code:null,url:true,done:false}); rcRender(rc);
    let triggerBody='', triggered=null;
    if(isUrl){ triggered=await jkTriggerGet(jkSubstUrl(raw, vars),pollable?triggerCtrl.signal:ctrl.signal, jkCfg); }
    else{ triggered=await jkTriggerBuild(jobPath, vars,ctrl.signal,triggerCtrl.signal, jkCfg); }   // crumb 属触发前准备，随流水线立即中止；只有已发出的 build POST 获得清理宽限
    triggerBody=triggered&&typeof triggered.body==='string'?triggered.body:'';
    cancelQueueLocation=triggered&&typeof triggered.location==='string'?triggered.location:'';
    externalJenkinsActive=pollable;
    if(!ensureActive()) return;
    let queuePath='';
    if(pollable){
      try{ const u=new URL(cancelQueueLocation,(jkCfg.url||'').replace(/\/+$/,'')||undefined); const at=u.pathname.indexOf('/queue/item/'); if(at>=0) queuePath=u.pathname.slice(at).replace(/\/+$/,''); }catch(e){}
      if(!queuePath) throw new Error('Jenkins 触发响应缺少 queue Location，无法安全关联或终止本次构建（请确保 CORS 暴露 Location 响应头）');
    }
    appendLiveLog(log,'# 已触发请求'+(queuePath?(' '+queuePath):'')+(pollable?'，等待执行…':'（非标准任务路径，无法轮询构建状态，按 GET 触发成功处理）')); s._out=liveOutputSnapshot(log.live,{code:null,url:true,done:false}); rcRender(rc);
    let result=null, buildNum=null, building=true;
    let consoleRead=0, consoleStarted=false, consoleProgressive=true, consoleDisabled=false, consoleError='', lastLive=0;   // 控制台增量回显：优先按 Jenkins 服务端 offset 拉取新增部分
    if(!pollable){ building=false; result='SUCCESS'; }
    /* 完成判定优先经服务端 stage-poll 长轮询（浏览器只循环调服务端端点）；404/403 时回退下方浏览器直连
       轮询（原实现），一次阶段内只回退一次。直连路径的持续性故障（「Jenkins 服务配置」地址不对 / 桥接未启动 /
       CORS 拦截 / 401·403）不得静默无限重试：连续失败计数、首次与每 15 次回显原因、持续失败较长时间
       （约 pollFailCap 次）按阶段失败收尾
       按阶段失败收尾，成功一次即清零。服务端路径的连败兜底由服务端承载（{done:true,failed:'poll'}），
       本页只对「浏览器↔dsh 服务端」的传输故障沿用同一计数/告警/30 次兜底口径。 */
    let pollFails=0;
    const pollFailCap=30;
    let pollVia='server';
    let pollFailWarned=0;   // 服务端连败告警水位（failures 单调递增，服务端清零/终态后不再重复告警）
    const jkPollAuth=(jkCfg.user||jkCfg.token)?{Authorization:'Basic '+btoa(jkCfg.user+':'+jkCfg.token)}:{};
    /* 轮询目标 URL：优先按触发响应的 queue Location 还原绝对地址（保留实际 Jenkins 主机），
       缺省时退回「Jenkins 服务配置」地址（与直连轮询同一基准） */
    let queueItemUrl='';
    if(pollable){ try{ queueItemUrl=new URL(cancelQueueLocation,(jkCfg.url||'').replace(/\/+$/,'')||undefined).href.replace(/\/+$/,''); }catch(e){} }
    const jkPollBase=(queueItemUrl&&/\/queue\/item\//.test(queueItemUrl))?queueItemUrl.replace(/\/queue\/item\/.*$/,''):(jkCfg.url||'').replace(/\/+$/,'');
    const queuePollUrl=queueItemUrl?(queueItemUrl+'/api/json'):(jkPollBase+queuePath+'/api/json');
    const buildPollUrl=()=>jkPollBase+jobPath+buildNum+'/api/json?tree=number,building,result,duration';
    const stagePollFallbackToDirect=why=>{
      if(pollVia!=='server') return false;
      pollVia='direct'; pollFails=0;
      console.warn('[pipeline] Jenkins 阶段轮询回退浏览器直连：stage-poll '+why);
      appendLiveLog(log,'# stage-poll 服务端轮询不可用（'+why+'），回退浏览器直连轮询');
      s._out=liveOutputSnapshot(log.live,{code:null,url:true,done:false}); lastLive=maybeRenderLiveDetail(rc,s,lastLive,1000);
      return true;
    };
    /* 调服务端 stage-poll；返回 null 表示端点不可用且已回退直连（调用方下轮起走直连分支）。
       其余异常（传输故障/AbortError）原样上抛，由调用方按 ensureActive/计数口径处理。 */
    const stagePollJenkins=async body=>{
      try{ return await stagePollRequest(STAGE_POLL_JENKINS_PATH, body, ctrl.signal); }
      catch(e){
        if(e&&e.stagePollFallback&&pollVia==='server'){ stagePollFallbackToDirect('HTTP '+e.stagePollFallback); return null; }
        throw e;
      }
    };
    /* 服务端路径的传输故障与上游连败告警（直连分支的告警文本保持原样）：复用同一计数与收尾口径 */
    const stagePollTransportError=(phase,e)=>{
      const pollErr=String(e&&e.message?e.message:e).slice(0,512);
      pollFails+=1;
      if(pollFails===1||pollFails%15===0){
        appendLiveLog(log,'[warn] '+(phase==='queue'?'Jenkins queue 状态轮询':'构建状态轮询')+'连续失败 '+pollFails+' 次（stage-poll 传输）：'+pollErr);
        s._out=liveOutputSnapshot(log.live,{code:null,url:true,done:false}); lastLive=maybeRenderLiveDetail(rc,s,lastLive,1000);
      }
      if(pollFails>=pollFailCap) throw new Error((phase==='queue'?'Jenkins queue 状态轮询':'构建状态轮询')+'持续失败（stage-poll 传输，连续 '+pollFails+' 次）：'+pollErr);
    };
    const stagePollUpstreamWarn=(phase,fails)=>{
      if(fails<=0||fails===pollFailWarned||(fails!==1&&fails%15!==0)) return;
      pollFailWarned=fails;
      appendLiveLog(log,'[warn] '+(phase==='queue'?'Jenkins queue 状态轮询':'构建状态轮询')+'连续失败 '+fails+' 次（服务端轮询兜底中，连续 '+pollFailCap+' 次将判失败）');
      s._out=liveOutputSnapshot(log.live,{code:null,url:true,done:false}); lastLive=maybeRenderLiveDetail(rc,s,lastLive,1000);
    };
    while(pollable && buildNum==null){
      if(pollVia==='server'){
        let pr=null;
        try{ pr=await stagePollJenkins({phase:'queue', url:queuePollUrl, headers:jkPollAuth}); }
        catch(e){ if(!ensureActive()) return; stagePollTransportError('queue',e); await waitForPoll(); continue; }   // 传输故障快速失败：与直连同节奏退避，避免对 dsh 服务端紧打
        if(!pr) continue;   // 已回退浏览器直连：下轮起走直连分支
        if(!ensureActive()) return;
        pollFails=0;
        stagePollUpstreamWarn('queue',Number(pr.failures)||0);
        if(pr.done===true){
          if(pr.cancelled){ const cancelled=new Error('Jenkins 队列任务已取消'); cancelled.queueTerminal=true; throw cancelled; }
          if(pr.failed) throw new Error('Jenkins queue 状态轮询持续失败（服务端持续失败已超时，已兜底判败）');
          const exact=Number(pr.buildNumber);
          if(!Number.isInteger(exact)||exact<=0) throw new Error('stage-poll queue 阶段完成但未返回有效构建号');
          buildNum=exact; cancelBuildNum=exact;
        }
        /* done:false：服务端长轮询窗口耗尽未等到构建号，立即续发下一次（等待窗口由服务端持有，本地不再 sleep） */
      }else{
        await waitForPoll();
        if(!ensureActive()) return;   // 迟回直接丢弃：不得动本运行 timer 之外的全局状态（见 runScriptStep 同规则）
        try{
          const info=await jkFetchJson(jkCfg,(jkCfg.url||'').replace(/\/+$/,'')+queuePath+'/api/json',ctrl.signal);
          if(!ensureActive()) return;
          pollFails=0;
          if(info&&info.cancelled){ const cancelled=new Error('Jenkins 队列任务已取消'); cancelled.queueTerminal=true; throw cancelled; }
          const exact=Number(info&&info.executable&&info.executable.number);
          if(Number.isInteger(exact)&&exact>0){ buildNum=exact; cancelBuildNum=exact; }
        }catch(e){
          if(!ensureActive()) return;
          if(e&&e.queueTerminal) throw e;
          const pollErr=String(e&&e.message?e.message:e).slice(0,512);
          pollFails+=1;
          if(pollFails===1||pollFails%15===0){
            appendLiveLog(log,'[warn] Jenkins queue 状态轮询连续失败 '+pollFails+' 次：'+pollErr+'（检查「Jenkins 服务配置」地址/凭据/连接模式；本地浏览器连接需目标 Jenkins 允许 CORS）');
            s._out=liveOutputSnapshot(log.live,{code:null,url:true,done:false}); lastLive=maybeRenderLiveDetail(rc,s,lastLive,1000);
          }
          if(pollFails>=pollFailCap) throw new Error('Jenkins queue 状态轮询持续失败（连续 '+pollFails+' 次）：'+pollErr);
        }
      }
    }
    pollFails=0; pollFailWarned=0;
    while(pollable && building){
      if(pollVia==='server'){
        let pr=null;
        try{ pr=await stagePollJenkins({phase:'build', url:buildPollUrl(), headers:jkPollAuth, console:!consoleDisabled, offset:consoleRead, timeoutMs:STAGE_POLL_BUILD_WINDOW_MS}); }
        catch(e){ if(!ensureActive()) return; stagePollTransportError('build',e); await waitForPoll(); continue; }
        if(!pr) continue;   // 已回退浏览器直连：下轮起走直连分支（控制台续传由直连 delta 通道接管，offset 语义一致）
        if(!ensureActive()) return;
        pollFails=0;
        stagePollUpstreamWarn('build',Number(pr.failures)||0);
        /* 服务端增量控制台续传（console:{text, offset}）：与直连 progressiveText 同一渲染体验 */
        if(pr.console&&typeof pr.console==='object'){
          const chunk=String(pr.console.text||'');
          const nextOffset=Number(pr.console.offset);
          if(Number.isFinite(nextOffset)&&nextOffset>=0) consoleRead=nextOffset;
          if(chunk){
            if(!consoleStarted){ consoleStarted=true; appendLiveLog(log,''); }
            appendOutputProbe(outputProbe,chunk);
            appendLiveChunk(log,chunk);   // 原始连续分片，不额外插入换行
            s._out=liveOutputSnapshot(log.live,{code:null,url:true,done:false});
            lastLive=maybeRenderLiveDetail(rc,s,lastLive,1000);
            if(logSink) await logSink.flush();   // 归档慢于 Jenkins 输出时暂停下一轮拉取，避免待写 Promise/分片无界排队
            if(rc.over||rc.token!==tk) return;
          }
        }
        if(pr.done===true){
          if(pr.failed) throw new Error('构建状态轮询持续失败（服务端持续失败已超时，已兜底判败）');
          building=false; if(pr.result) result=String(pr.result);
        }
        if(rc.over||rc.token!==tk) return;
        const n=rc.nodes[s.id]; if(n){ n.dur=(Date.now()-t0)/1000; n.progress=Math.min(95,(n.progress||0)+2); rcRender(rc); }
      }else{
        await waitForPoll();
        if(!ensureActive()) return;
        try{
          const info=await jkFetchJson(jkCfg,(jkCfg.url||'').replace(/\/+$/,'')+jobPath+buildNum+'/api/json?tree=number,building,result,duration',ctrl.signal);
          if(!ensureActive()) return;
          pollFails=0;
          if(Number(info&&info.number)===buildNum){ building=!!info.building; if(info.result) result=info.result; }
        }catch(e){
          if(!ensureActive()) return;
          const pollErr=String(e&&e.message?e.message:e).slice(0,512); pollFails+=1;
          if(pollFails===1||pollFails%15===0){
            appendLiveLog(log,'[warn] 构建状态轮询连续失败 '+pollFails+' 次：'+pollErr+'（检查「Jenkins 服务配置」地址/凭据/连接模式；本地浏览器连接需目标 Jenkins 允许 CORS）');
            s._out=liveOutputSnapshot(log.live,{code:null,url:true,done:false}); lastLive=maybeRenderLiveDetail(rc,s,lastLive,1000);
          }
          if(pollFails>=pollFailCap) throw new Error('构建状态轮询持续失败（连续 '+pollFails+' 次）：'+pollErr);
        }
        /* 实时回显：优先走 progressiveText 服务端 offset，只传输新增控制台内容；旧 Jenkins 返回
           404/405 时本次阶段永久降级为 consoleText 全量取回 + 本地差分。 */
        if(buildNum!=null && !consoleDisabled){
          try{
            const delta=await jkReadConsoleDelta(jobPath+buildNum+'/',consoleRead,consoleProgressive,ctrl.signal);
            if(!ensureActive()) return;
            consoleError='';
            consoleRead=delta.next; consoleProgressive=delta.progressive;
            if(delta.text){
              if(!consoleStarted){ consoleStarted=true; appendLiveLog(log,''); }
              appendOutputProbe(outputProbe,delta.text);
              appendLiveChunk(log,delta.text);   // 原始连续分片，不额外插入换行
              s._out=liveOutputSnapshot(log.live,{code:null,url:true,done:false});
              lastLive=maybeRenderLiveDetail(rc,s,lastLive,1000);
              if(logSink) await logSink.flush();   // 归档慢于 Jenkins 输出时暂停下一轮拉取，避免待写 Promise/分片无界排队
              if(rc.over||rc.token!==tk) return;
            }
          }catch(e){
            if(!ensureActive()) return;
            consoleError=String(e&&e.message?e.message:e).slice(0,512);
            if(/响应正文过大/.test(consoleError)) consoleDisabled=true;   // 同一 offset 重试仍会下载同一超大块，立即止损
          }
        }
        if(rc.over||rc.token!==tk) return;
        const n=rc.nodes[s.id]; if(n){ n.dur=(Date.now()-t0)/1000; n.progress=Math.min(95,(n.progress||0)+2); rcRender(rc); }
      }
    }
    externalJenkinsActive=false;
    if(rc.over||rc.token!==tk) return;   // 先验令牌再动本运行 timer（中止已由 finish 清过）
    if(rc.timer){clearInterval(rc.timer);rc.timer=null;}
    let consoleText='', bodyFull='';
    if(buildNum!=null && !consoleDisabled && pollVia==='server'){
      /* 服务端轮询收尾：终态响应已带增量控制台；再补一轮立即返回的 drain（构建已终态，服务端不持有窗口），
         取回终态落定的尾段。失败不阻断结果判定（同直连路径的 consoleError 兜底语义）。 */
      try{
        const pr=await stagePollRequest(STAGE_POLL_JENKINS_PATH,{phase:'build', url:buildPollUrl(), headers:jkPollAuth, console:true, offset:consoleRead},ctrl.signal);
        if(!ensureActive()) return;
        if(pr&&pr.console&&typeof pr.console==='object'){
          consoleText=String(pr.console.text||'');
          const nextOffset=Number(pr.console.offset); if(Number.isFinite(nextOffset)&&nextOffset>=0) consoleRead=nextOffset;
        }
      }catch(e){ if(!ensureActive()) return; consoleError=String(e&&e.message?e.message:e).slice(0,512); }
    }
    else if(buildNum!=null && !consoleDisabled){ try{ const delta=await jkReadConsoleDelta(jobPath+buildNum+'/',consoleRead,consoleProgressive,ctrl.signal); if(!ensureActive()) return; consoleError=''; consoleText=delta.text; consoleRead=delta.next; consoleProgressive=delta.progressive; }catch(e){ if(!ensureActive()) return; consoleError=String(e&&e.message?e.message:e).slice(0,512); } }
    else if(triggerBody){
      /* URL 触发的 API 返回体当 consoleText 喂给 parseStageVars：多行 JSON 规整成单行
         （与脚本阶段「单行 JSON 对象」规则一致，数组响应同样规整，供输出变量 JSON 路径取值）。
         超大体仅展示前 64K 防归档膨胀；变量捕获用完整 bodyFull——截断会切烂 JSON 导致整行解析失败 */
      let body=triggerBody;
      try{ const o=JSON.parse(body); if(o&&typeof o==='object') body=JSON.stringify(o); }catch(e){}
      bodyFull=body;
      if(body.length>65536) body=body.slice(0,65536)+'…(截断，仅展示；变量捕获用完整响应体)';
      consoleText=body;
    }
    if(rc.over||rc.token!==tk) return;   // 收尾拉取控制台（上方 await）期间被中止：变量/归档/节点状态不得再写入
    const ok=(result==='SUCCESS');
    if(consoleText){
      if(!consoleStarted) appendLiveLog(log,'');
      appendOutputProbe(outputProbe,bodyFull||consoleText);
      if(buildNum!=null) appendLiveChunk(log,consoleText); else appendLiveLog(log,consoleText,bodyFull||consoleText);
    }
    if(consoleError) appendLiveLog(log,'[warn] Jenkins 控制台读取失败，任务结果仍以 Jenkins 状态为准，日志可能不完整：'+consoleError);
    const probed=finishOutputProbe(outputProbe);
    if(probed.fullTextOverflow) appendLiveLog(log,'[warn] 控制台全文超过 128KiB，已跳过「*=全文」输出变量；请改用 KEY=VALUE 或 JSON 路径截取所需字段');
    appendLiveLog(log,'[HTTP result '+result+']');
    const finalStdout=finishLiveLog(log);   // 结束时合并一次；轮询期间从不重复拼接旧日志
    s._out=liveOutputSnapshot(log.live,{stderr:(result&&result!=='SUCCESS')?('HTTP 请求 '+result):'',code:ok?0:1,url:true,done:true});
    if(logSink) await logSink.flush();
    s._archiveOutputParts=null;   // 正常终态完整日志已由 sink 落盘；页面释放运行中尾窗别名
    const varsOut=Object.assign({},probed.vars); rc.vars=Object.assign(rc.vars||{},varsOut);
    if(bodyFull && bodyFull!==consoleText) Object.assign(varsOut, mergeStageVars(rc, bodyFull));   // 响应体被截断展示时，顶层标量改从完整体捕获
    archiveStageLog(s, stageSeq(rc.stages,i), rc);   // 本阶段回显即时重定向到归档文件夹的独立日志文件
    applyOutVars(rc, outSpec, varsOut, bodyFull?parseStageJson(bodyFull):(probed.json||parseStageJson(finalStdout)), probed.fullText);   // 输出变量映射：控制台增量捕获 key/JSON；正文可用 JSON 路径，全文仅在 128KiB 安全上限内保留
    const dur=(Date.now()-t0)/1000;
    if(ok){ rc.nodes[s.id]=Object.assign({}, rc.nodes[s.id], {status:'success',progress:100,dur:dur,sub:{},script:'HTTP · '+raw,varsIn:varsIn,varsOut:varsOut}); rcRender(rc); advance(rc,i+1); }
    else{ rc.nodes[s.id]=Object.assign({}, rc.nodes[s.id], {status:'failed',progress:100,dur:dur,sub:{},script:'HTTP · '+raw,varsIn:varsIn,varsOut:varsOut}); rcRender(rc); finish(rc,'failed'); }
  }catch(e){
    if(rc.over||rc.token!==tk) return;   // 迟回异常（中止后）：不得覆盖节点状态、不得对旧阶段再 finish
    if(rc.timer){clearInterval(rc.timer);rc.timer=null;}
    const msg=timedOut?timeoutMessage():String(e&&e.message?e.message:e);
    appendLiveLog(log,'✗ '+msg);
    s._out=liveOutputSnapshot(log.live,{stderr:msg,code:1,url:true,done:true});
    if(logSink) await logSink.flush();
    s._archiveOutputParts=null;   // 异常终态也由 sink 落盘；失败时 archiveStageLog 以页面尾窗兜底
    archiveStageLog(s, stageSeq(rc.stages,i), rc);   // 异常路径同样归档本阶段已产生的回显
    rc.nodes[s.id]=Object.assign({}, rc.nodes[s.id], {status:'failed',progress:100,dur:(Date.now()-t0)/1000,sub:{},script:'HTTP · '+raw,varsIn:varsIn,varsOut:{}});
    rcRender(rc); finish(rc,'failed');
  }finally{
    if(deadlineTimer!==null) clearTimeout(deadlineTimer);
    ctrl.signal.removeEventListener('abort',scheduleTriggerAbort);
    if(startAbortTimer!==null) clearTimeout(startAbortTimer);
    if(!triggerCtrl.signal.aborted) triggerCtrl.abort();
    if(ctrl.signal.aborted&&externalJenkinsActive){
      try{ await jkCancelExecution(cancelJobPath,cancelBuildNum,cancelQueueLocation); }
      catch(stopError){
        const stopMsg='Jenkins 外部任务终止失败：'+String(stopError&&stopError.message?stopError.message:stopError);
        appendLiveLog(log,'[warn] '+stopMsg); s._out=liveOutputSnapshot(log.live,{stderr:stopMsg,code:1,url:true,done:true}); if(logSink) await logSink.flush();
        console.warn('[pipeline] '+stopMsg,stopError); try{ flashRunTip(stopMsg); }catch(e){}
      }
    }
    if(rc.scriptAbort===ctrl) rc.scriptAbort=null;
  }
}
