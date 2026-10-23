/* ===== 16-run-engine.js · 运行引擎、阶段进度共享 tick、阶段间变量传递 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 7339–7963）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */

/* ---------- 运行引擎 ---------- */
/* ---------- 阶段进度共享 tick ----------
   合并前：每个执行中阶段各自 setInterval（脚本/预设 300ms、HTTP 500ms、EvalTokens 1000ms、本地模拟 120ms），
   每个 tick 都走 rcRender → applyStatusClasses+renderDetail 全量重绘；并行阶段定时器成倍，页面切后台仍空转。
   合并后：全页面仅一个 500ms interval 统一推进所有运行的 running 阶段。执行器把进度任务注册进
   globalThis.__pipelineStageTick（走全局对象载体的原因：执行器函数体会被测试沙盒按名单独抽取进 vm 运行，
   体内不能引用本块新增的顶层函数，注册/起表逻辑只能在执行器内联直写；驱动与落 DOM 只被 tick 回调
   延迟引用，抽取沙盒里 interval 回调不触发即不求值）。rc.timer 改存进度任务键作在途标记，
   既有 clearInterval(rc.timer)/rc.timer=null 收尾路径保持原样，过期任务由驱动器自查摘除、全部摘除即停表。
   tick 内只直改进度条宽度/节点进度文本/详情进度条（stageTickPaint），不再每 tick 全量重绘详情/日志——
   仅本地模拟阶段在跨 25% 日志档位或子阶段翻牌时补一次 rcRender（健康回显与子阶段徽标随进度变化）。
   页面隐藏（visibilitychange）时停表，恢复可见时立即补一次 tick 再继续走表。 */
function stageTickStore(){ const g=globalThis; return g.__pipelineStageTick||(g.__pipelineStageTick={tasks:{},seq:0,timer:null}); }
function stageTickEnsure(){
  const T=stageTickStore();
  /* 页面隐藏时不起表（待恢复可见时补 tick 再走表）；回调 typeof 守卫：测试沙盒未抽取 stageTickRun 时自毁防空转 */
  if(!T.timer&&Object.keys(T.tasks).length&&!(typeof document!=='undefined'&&document.hidden))
    T.timer=setInterval(function(){ if(typeof stageTickRun==='function') stageTickRun(); else { clearInterval(T.timer); T.timer=null; T.tasks={}; } },500);
}
function stageTickRun(){
  const T=stageTickStore(), now=Date.now();
  Object.keys(T.tasks).forEach(k=>{
    const t=T.tasks[k], rc=t.rc, n=rc&&rc.nodes?rc.nodes[t.stageId]:null;
    /* 终态/中止/重置的任务自查摘除（执行器收尾已清 rc.timer 在途标记，这里摘掉注册项防泄漏） */
    if(!rc||rc.over||!n||n.status!=='running'){ delete T.tasks[k]; return; }
    if(t.sim){
      /* 本地模拟阶段：按真实经过时间推进（语义同原 120ms 定时器：有子阶段按 1.2× 耗时拉长时间轴） */
      let p=(now-t.sim.start)/(t.sim.subs&&t.sim.subs.length?t.sim.total*1.2:t.sim.total)*100;
      if(p>=100) p=100;
      n.progress=p; n.dur=(now-t.sim.start)/1000;
      let flipped=false;
      if(t.sim.subs&&t.sim.subs.length) t.sim.subs.forEach((x,idx)=>{ if(p> 50*(idx+1)&&n.sub[x]!=='success'){ n.sub[x]='success'; flipped=true; } });
      if(p>=100){
        delete T.tasks[k];
        if(rc.timer===k) rc.timer=null;   // 收尾清在途标记（对齐原定时器路径：阶段结束 timer 置空）
        n.status='success'; n.progress=100;
        archiveStageLog(t.sim.stage, stageSeq(rc.stages,t.sim.index), rc);   // 本地模拟阶段的回显同样归档
        rcRender(rc);
        advance(rc,t.sim.index+1);
        return;
      }
      /* 跨 25% 日志档位或子阶段翻牌时补一次全量渲染（详情区健康回显/子阶段徽标随进度变化）；其余 tick 只轻量直改 */
      const bucket=Math.floor(p/25);
      if(flipped||bucket!==t.sim.bucket){ t.sim.bucket=bucket; rcRender(rc); return; }
      stageTickPaint(t,n);
      return;
    }
    /* 按真实经过时间等比推进，节奏与各执行器原定时器一致（脚本/预设 ≈+2/300ms、HTTP +1/500ms、EvalTokens +1/1000ms） */
    n.progress=Math.min(95,(n.progress||0)+(now-t.last)*t.rate); n.dur=(now-t.t0)/1000; t.last=now;
    stageTickPaint(t,n);
  });
  if(!Object.keys(T.tasks).length&&T.timer){ clearInterval(T.timer); T.timer=null; }   // 全部摘除即停表
}
/* tick 内轻量直改 DOM（不触发详情/日志全量渲染）：仅任务所属运行正被编排区展示时落 DOM；
   更新编排节点进度条宽度与进度文本（等价 applyStatusClasses 的运行态子集），选中该阶段时同步详情进度条宽度 */
function stageTickPaint(t, n){
  const root=rootRunContext(t.rc);
  if(viewRc!==root) return;
  const el=flowNodeElementById(t.stageId);
  if(el){
    const bar=el.querySelector('.pipeline-bar > i'); if(bar) bar.style.width=(n.progress||0)+'%';
    const meta=el.querySelector('.pipeline-nodeMeta'); if(meta) meta.textContent=Math.round(n.progress||0)+'% · '+fmtDur(n.dur||0);
  }
  if(root.selId===t.stageId){ const b=$('detailBar'); if(b) b.style.width=(n.progress||0)+'%'; }
}
/* 每个运行独立编排（rc 内串行推进各阶段；不同机器的运行并行）：有脚本的步骤执行脚本，其余本地模拟 */
function createParallelStageContext(parent,index,varsSnapshot){
  const child=Object.assign({},parent,{timer:null,scriptAbort:null,vars:Object.assign({},varsSnapshot||parent.vars||{}),parallelParent:parent,parallelIndex:index,parallelGroup:null,parallelSettled:false,parallelStatus:null,parallelResolve:null,parallelPromise:null});
  child.parallelPromise=new Promise(resolve=>{ child.parallelResolve=resolve; });
  return child;
}
function cancelParallelStage(child,reason,cascade){
  if(!child || !child.parallelParent || child.parallelSettled) return;
  child.over=true;
  if(cascade) child._cascadeAbort=true;   // 兄弟阶段失败导致的级联中止：非用户终止，各阶段 finally 据此保留已启动的外部任务（EvalTokens run 不 stop）
  if(child.scriptAbort){ try{ child.scriptAbort.abort(); }catch(e){} }
  if(child.timer){ clearInterval(child.timer); child.timer=null; }
  const stage=child.stages[child.parallelIndex], node=stage&&child.nodes[stage.id];
  if(stage && node && node.status==='running'){
    archiveStageLog(stage,stageSeq(child.stages,child.parallelIndex),child);
    child.nodes[stage.id]=Object.assign({}, node, {status:'aborted',progress:node.progress||0,dur:node.dur||0,sub:{},script:node.script,varsIn:node.varsIn||{},varsOut:node.varsOut||{}});
  }
  settleParallelStage(child,reason||'aborted');
}
function cancelParallelGroup(parent,exceptChild,cascade){
  const active=parent&&parent.parallelGroup;
  if(!active) return;
  active.children.forEach(child=>{ if(child!==exceptChild) cancelParallelStage(child,'aborted',cascade); });
}
function disposeRunForReset(rc){
  if(!rc) return;
  cancelParallelGroup(rc);
  if(rc.scriptAbort){ try{ rc.scriptAbort.abort(); }catch(e){} }
  if(rc.timer){ clearInterval(rc.timer); rc.timer=null; }
  if(rc.leaseTimer){ clearInterval(rc.leaseTimer); rc.leaseTimer=null; }
  if(rc.leaseId){ releaseNodeLease(rc.leaseId, rc.leaseIps); rc.leaseId=null; }   // 重置（不计入历史）同样释放节点租约
  if(rc.suffixPlanHeld && typeof discardHeldSuffixPlan==='function'){ try{ discardHeldSuffixPlan(rc); }catch(e){} }   // 重置：未激活的休眠后缀计划一并清理
  rc.over=true;
  /* 重置不计入历史：撤回启动时写入的「进行中」记录（beginRunHistory），避免残留永远跑不完的条目 */
  if(rc.tag && typeof history!=='undefined' && Array.isArray(history)){
    const i=history.findIndex(h=>h&&h.tag===rc.tag && h.status==='running');
    if(i>=0){
      history.splice(i,1);
      if(typeof selHistoryIdx!=='undefined'){
        if(selHistoryIdx===i) selHistoryIdx=-1;
        else if(selHistoryIdx>i) selHistoryIdx--;
      }
      try{ if(typeof renderHistory==='function') renderHistory(); if(typeof renderStats==='function') renderStats(); if(typeof persistState==='function') persistState(); }catch(e){}
    }
  }
}
function settleParallelStage(child,status){
  if(!child || !child.parallelParent || child.parallelSettled) return;
  child.parallelSettled=true; child.parallelStatus=status;
  if(status==='success'||status==='failed'){
    const stage=child.stages[child.parallelIndex];
    if(stage) stage._promT1=Date.now();
  }
  const parent=child.parallelParent, active=parent.parallelGroup;
  if(status==='failed' && active && active.children.indexOf(child)>=0 && !active.failed){ active.failed=true; cancelParallelGroup(parent,child,true); }   // 级联中止（兄弟失败）：仅收编编排，兄弟阶段已启动的外部任务保留（与用户主动中止区分）
  if(child.parallelResolve) child.parallelResolve(status);
}
function runParallelStageGroup(parent,group){
  if(parent.parallelGroup) return parent.parallelGroup.promise;
  const varsSnapshot=Object.assign({},parent.vars||{});
  const children=[];
  for(let i=group.start;i<group.end;i++) children.push(createParallelStageContext(parent,i,varsSnapshot));
  const active={group:group,children:children,promise:null}; parent.parallelGroup=active;
  children.forEach(child=>startStageAt(child,child.parallelIndex));
  active.promise=Promise.all(children.map(child=>child.parallelPromise)).then(statuses=>{
    if(parent.over || parent.parallelGroup!==active) return;
    const succeeded=!active.failed&&statuses.every(status=>status==='success');
    if(succeeded) children.forEach(child=>{
      const stage=parent.stages[child.parallelIndex], node=parent.nodes[stage.id];
      if(node && node.varsOut) Object.assign(parent.vars,node.varsOut);
    });
    parent.parallelGroup=null;
    taskPromFinalize(parent);
    if(succeeded) advance(parent,group.end);
    else finish(parent,'failed');
  });
  return active.promise;
}
function startStageAt(rc,i){
  const stg=rc.stages;
  const s=stg[i];
  if(s.preset){ runPresetStep(rc,i); return; }   // 预设任务（系统 + 自定义）：脚本取设置页配置，见 runPresetStep
  if(s.skip){ skipStage(rc,i); return; }   // 配置「不执行」：标记跳过并推进（脚本/URL请求/模拟阶段一视同仁）
  if(s.promCollect) s._promT0=Date.now();   // 任务级普罗采集：记录任务开始时间，进入终态后按「开始→结束」时段采集（见 taskPromFinalize）
  if((s.kind==='http'||s.kind==='url'||s.kind==='jenkins') && stageUrlOf(s)){ runUrlStep(rc,i); return; }   // 兼容旧数据 kind:'url'/'jenkins'
  if(s.kind==='evaltokens'){ runEvaltokensStep(rc,i); return; }   // EvalTokens 任务轮询阶段：匹配任务并等待终态（见 runEvaltokensStep）
  /* 脚本路径按名回填（与服务端 resolveServerStageScript 同口径）：内置种子/分享导入/旧数据的脚本绑定
     path 可能留空——rebindBuiltinScriptPaths 只补内置流水线，自定义阶段 path 留空时这里兜底按名解析，
     否则 shell/python 阶段会落入本地模拟静默跳过（脚本根本没跑却显示成功）。rc.stages 已是运行副本，可改。 */
  if(s.script && !s.script.path && s.script.name && typeof scriptByName==='function'){
    const sc=scriptByName(s.script.name);
    if(sc) s.script=Object.assign({}, s.script, {path:sc.path, lang:s.script.lang||sc.lang});
  }
  if(s.script && s.script.path){ runScriptStep(rc,i); return; }
  runStage(rc,i);
}
function advance(rc,i){
  if(rc.parallelParent){ settleParallelStage(rc,'success'); return; }
  const stg=rc.stages;
  taskPromFinalize(rc);   // 已进入终态（成功/失败）且勾选「收集普罗数据」的任务：按任务起止后台采集普罗数据（去重见 _promCollected）
  if(i>=stg.length){ finish(rc,'success'); return; }
  if(stg[i] && stg[i].sched && !stg[i].preset){ handoffSchedSuffix(rc,i); return; }   // 定时分界：本地前缀已跑完，定时后缀移交服务端执行并 toast 告知（原设计，见 handoffSchedSuffix）
  const group=pipelineStageGroups(stg).find(g=>g.start===i);
  if(group&&group.parallel&&group.end-group.start>1){ runParallelStageGroup(rc,group); return; }
  startStageAt(rc,i);
}
/* ---------- 阶段间变量传递（上游 stdout / URL 响应体（Jenkins 控制台）的 KEY=VALUE 行、单行 JSON 对象注入下游） ---------- */
/* 提取规则：逐行匹配 ^\s*([A-Z_][A-Z0-9_]*)=(.*)$；值取首个 = 之后全部，
   去尾 \r；首尾双引号包裹则去引号。累计到 curRun.vars（粘性：后续阶段可见，同 key 后写覆盖）。
   另支持整行为 JSON 对象（{"KEY":"VALUE",...}，Jenkins 任务常见的 key=value 结果回显）：
   取顶层标量（字符串/数字/布尔）字段作为变量，键保持原名；与 KEY=VALUE 行可混排，同 key 后写覆盖。 */
function forEachOutputLine(output, visit){
  const text=String(output||'');
  let start=0;
  while(start<=text.length){
    let end=text.indexOf('\n',start);
    if(end<0) end=text.length;
    visit(text.slice(start,end));
    if(end===text.length) break;
    start=end+1;
  }
}
function parseStageVars(stdout){
  const out={};
  if(!stdout) return out;
  forEachOutputLine(stdout,line=>{
    const m=/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if(m){
      let v=m[2].replace(/\r$/,'');
      if(v.length>=2 && v.charAt(0)==='"' && v.charAt(v.length-1)==='"') v=v.slice(1,-1);
      out[m[1]]=v;
      return;
    }
    /* 单行 JSON 对象：取顶层标量字段；解析失败 / 非对象 / 嵌套值（对象、数组、null）一律忽略 */
    const t=line.trim();
    if(t.length<2 || t.charAt(0)!=='{' || t.charAt(t.length-1)!=='}') return;
    try{
      const o=JSON.parse(t);
      if(!o || typeof o!=='object' || Array.isArray(o)) return;
      for(const k in o){ const v=o[k]; if(v===null||v===undefined||typeof v==='object') continue; out[k]=String(v); }
    }catch(e){}
  });
  return out;
}
/* 解析本阶段 stdout 的 KEY=VALUE 行 / 单行 JSON 对象，累计到 rc.vars；返回本阶段产出的变量集（供 varsOut 展示） */
function mergeStageVars(rc, stdout){
  if(!rc) return {};
  const v=parseStageVars(stdout);
  rc.vars=Object.assign(rc.vars||{}, v);
  return v;
}
/* 提取输出里的单行 JSON（对象或数组；数组仅供「输出变量」JSON 路径取值，顶层标量提取仍只认对象，
   见 parseStageVars）：逐行尝试解析，同一输出里多处 JSON 时最后一处为准。 */
function parseStageJson(stdout){
  if(!stdout) return null;
  let found=null;
  forEachOutputLine(stdout,function(line){
    const t=line.trim();
    if(t.length<2) return;
    const c0=t.charAt(0), c1=t.charAt(t.length-1);
    if(!((c0==='{'&&c1==='}')||(c0==='['&&c1===']'))) return;
    try{ const o=JSON.parse(t); if(o&&typeof o==='object') found=o; }catch(e){}
  });
  return found;
}
/* JSON 路径取值（「输出变量」的来源写法，如 items.0.name / $.items[-1].name / [0].name）：
   点号分段，数组段可用数字下标或 [N]（负数从尾部取，-1=最后一项）；路径不存在 / 终点为 null 一律
   undefined；终点为对象/数组时原样返回，由调用方（applyOutVars）序列化成 JSON 字符串后赋值。 */
function jsonPathGet(obj, path){
  const p=String(path||'').trim().replace(/^\$\.?/,'');
  if(!p) return undefined;
  const tokens=p.match(/[^.\[\]]+|\[-?\d+\]/g);
  if(!tokens) return undefined;
  let cur=obj;
  for(const t of tokens){
    if(cur===null||cur===undefined) return undefined;
    const idx=/^\[(-?\d+)\]$/.exec(t);
    if(Array.isArray(cur)){
      const i=parseInt(idx?idx[1]:t,10);
      if(isNaN(i)) return undefined;
      const at=i<0?cur.length+i:i;
      if(at<0||at>=cur.length) return undefined;
      cur=cur[at];
    }else if(typeof cur==='object'){
      if(idx) return undefined;   // 对象段不能用 [N] 下标
      cur=cur[t];
    }else return undefined;
  }
  if(cur===null||cur===undefined) return undefined;
  return cur;
}
/* 输出变量映射（阶段编辑器「输出变量」，逗号分隔，如 IMAGE_URL=image, ARCH）：把变量池里捕获到的 key
   改名/声明为目标名补充进 curRun.vars（来源含本阶段产出与更早的上游变量）；原 key 仍保留下传。
   来源还可写：
   - * 或留空（RESP=* / RESP=）：把本阶段返回值全文（URL 响应体 / 脚本 stdout，fullText，不受日志
     展示截断影响）整体赋给目标变量——只需要「返回结果原样进一个变量」时用这种，不必逐字段声明。
   - JSON 路径（含 . / [N] / 前导 $，如 XDS_BRANCH=items.0.name）：从本阶段 stdout / 响应体里的
     单行 JSON（jsonCtx，见 parseStageJson）按路径取嵌套字段——分页列表类接口（{"items":[...]}）的
     顶层标量提取拿不到数组内容，需用路径显式指定；终点为对象/数组时序列化为 JSON 字符串。
     裸名（如 BRANCHES=items）在变量池未捕获到时，也会回退取单行 JSON 的同名顶层字段（含容器整体）。
   脚本 / HTTP 阶段通用；varsOut 同步补充，供运行详情展示本阶段产出。 */
function applyOutVars(rc, spec, varsOut, jsonCtx, fullText){
  String(spec||'').split(',').forEach(function(pair){
    const p=pair.trim(); if(!p) return;
    const eq=p.indexOf('=');
    const dst=(eq>=0?p.slice(0,eq):p).trim(), src=(eq>=0?p.slice(eq+1):p).trim();
    if(!dst || !rc || !rc.vars) return;
    let val;
    if(src==='*' || (eq>=0 && src==='')) val=fullText;   // 整段返回值全文（URL 响应体 / 脚本 stdout）
    else{
      val=rc.vars[src];
      if(val===undefined && jsonCtx){
        if(/[.\[\]$]/.test(src)) val=jsonPathGet(jsonCtx, src);   // JSON 路径取嵌套字段
        else if(!Array.isArray(jsonCtx) && Object.prototype.hasOwnProperty.call(jsonCtx, src)) val=jsonCtx[src];   // 顶层容器字段（parseStageVars 只提取标量，对象/数组字段经此整体取出序列化，如 BRANCHES=items）
      }
    }
    if(val===undefined||val===null) return;
    const out=(typeof val==='object')?JSON.stringify(val):String(val);
    rc.vars[dst]=out; if(varsOut) varsOut[dst]=out;
  });
}
/* 参数值 ${VAR} 引用替换：取值来源 = 运行级注入变量（TARGET_IP/IMAGE_NAME/ARCHIVE_DIR 等）+ 上游阶段变量
   （curRun.vars，同名时上游优先）。供脚本阶段在参数值里显式引用上游产出（如 ${IMAGE_URL}）。
   未定义的引用原样保留；整值即单个 ${VAR} 且未定义时按空值处理（env 参数空 = 继承上游同名变量）。 */
function substRunVars(v, rc){
  v=String(v===undefined||v===null?'':v);
  if(v.indexOf('${')<0) return v;
  const look={};
  if(rc){
    const c0=(rc.envs&&rc.envs[0])||null;
    look.TARGET_IP=(c0&&c0.ip)||rc.env||'';
    if(rc.envs) look.TARGET_IPS=JSON.stringify(rc.envs.map(function(e){return e.ip;}));
    if(rc.image) look.IMAGE_NAME=rc.image;
    if(rc.tag) look.IMAGE_TAG=rc.tag;
    if(rc.pipelineName) look.PIPELINE_NAME=rc.pipelineName;
    if(rc.repoUrl) look.GIT_URL=rc.repoUrl;
    if(rc.branch) look.GIT_BRANCH=rc.branch;
    if(rc.strategy) look.DEPLOY_STRATEGY=rc.strategy;   // 部署策略（普罗 xds_namespace 默认 ${DEPLOY_STRATEGY}-${BY} 用）；未选择（空串）不注入，保持占位符未解析
    if(rc.by) look.BY=rc.by;   // 执行人（普罗 xds_namespace 默认 ${DEPLOY_STRATEGY}-${BY} 用，= 执行人拼音）
    if(rc.weightsPath) look.MODEL_PATH=rc.weightsPath;   // 权重路径（主控可选填写）；未填写不注入，保持占位符未解析
    if(rc.presets) look.PIPELINE_PRESETS=JSON.stringify(rc.presets);   // 本次运行勾选的预设任务 key（JSON 数组）
    if(rc.archive){ look.ARCHIVE_DIR=rc.archive; look.ARCHIVE_FOLDER=rc.archive; }
    if(rc.vars) Object.assign(look, rc.vars);   // 上游阶段变量同名优先
  }
  const single=/^\${([A-Za-z_][A-Za-z0-9_]*)}$/.exec(v);
  if(single && look[single[1]]===undefined) return '';
  return v.replace(/\${([A-Za-z_][A-Za-z0-9_]*)}/g, function(m,k){ return look[k]!==undefined?String(look[k]):m; });
}
/* 普罗 model/namespace 占位模板（${MODEL_PATH} / ${DEPLOY_STRATEGY}-${BY}）采集时点解析：
   替换后仍残留未解析 ${...} 占位（未选部署策略、无执行人等）按「解析不出则不注入」处理（返回空）。 */
function substPromTemplate(v, rc){ const out=substRunVars(v, rc).trim(); return out.indexOf('${')>=0?'':out; }
/* 所有长时间 / 高输出阶段共用的实时快照：页面只持有两路各 256 KiB 尾部，
   _outputRevision 每次追加递增，让详情缓存不依赖有碰撞可能的文本采样。 */
function createLiveOutputState(){
  const tail=()=>({chunks:[],head:0,chars:0,truncated:false,revision:0,cache:'',cacheRevision:-1});
  return {stdout:tail(),stderr:tail(),revision:0};
}
function appendLiveOutput(state,type,value){
  const text=String(value||''); if(!text) return state;
  const tail=type==='err'?state.stderr:state.stdout, limit=256*1024;
  if(text.length>=limit){
    const hadText=tail.chars>0;
    tail.chunks.length=0; tail.head=0; tail.chunks.push(text.slice(-limit)); tail.chars=limit;
    tail.truncated=tail.truncated||hadText||text.length>limit;
  }else{
    tail.chunks.push(text); tail.chars+=text.length;
    let overflow=tail.chars-limit;
    if(overflow>0) tail.truncated=true;
    while(overflow>0 && tail.head<tail.chunks.length){
      const first=tail.chunks[tail.head];
      if(first.length<=overflow){ tail.chunks[tail.head]=''; tail.head++; tail.chars-=first.length; overflow-=first.length; }
      else{ tail.chunks[tail.head]=first.slice(overflow); tail.chars-=overflow; overflow=0; }
    }
    if(tail.head>1024 && tail.head*2>tail.chunks.length){ tail.chunks.splice(0,tail.head); tail.head=0; }
  }
  tail.revision++; tail.cacheRevision=-1;
  state.revision=(state.revision||0)+1;
  return state;
}
function liveOutputTailText(tail){
  if(tail.cacheRevision!==tail.revision){ tail.cache=tail.chunks.slice(tail.head).join(''); tail.cacheRevision=tail.revision; }
  return tail.cache;
}
function liveOutputSnapshot(state,extra){
  return Object.assign({
    stdout:liveOutputTailText(state.stdout),stderr:liveOutputTailText(state.stderr),
    _stdoutTruncated:!!state.stdout.truncated,_stderrTruncated:!!state.stderr.truncated,
    _outputRevision:state.revision||0
  },extra||{});
}
function boundedExecutionResult(result){
  result=result||{};
  const live=createLiveOutputState();
  appendLiveOutput(live,'out',result.stdout||''); appendLiveOutput(live,'err',result.stderr||'');
  const snapshot=liveOutputSnapshot(live,result);
  snapshot.stdout=liveOutputTailText(live.stdout); snapshot.stderr=liveOutputTailText(live.stderr);
  snapshot._stdoutTruncated=!!result._stdoutTruncated||!!live.stdout.truncated;
  snapshot._stderrTruncated=!!result._stderrTruncated||!!live.stderr.truncated;
  return snapshot;
}
/* 轮询型阶段同样只保存 256 KiB 原始分片尾窗，避免 Jenkins / EvalTokens 长任务常驻全文。 */
function createLiveLog(first,sink){
  const log={parts:[],partHead:0,partChars:0,truncated:false,hasContent:false,live:createLiveOutputState(),sink:sink||null};
  if(first!==undefined) appendLiveLog(log,first);
  return log;
}
function appendLiveLogPart(log,text){
  const limit=256*1024;
  if(text.length>=limit){
    const hadText=log.partChars>0;
    log.parts.length=0; log.partHead=0; log.parts.push(text.slice(-limit)); log.partChars=limit;
    log.truncated=log.truncated||hadText||text.length>limit;
    return;
  }
  log.parts.push(text); log.partChars=(log.partChars||0)+text.length;
  let overflow=log.partChars-limit;
  if(overflow>0) log.truncated=true;
  while(overflow>0 && log.partHead<log.parts.length){
    const first=log.parts[log.partHead];
    if(first.length<=overflow){ log.parts[log.partHead]=''; log.partHead++; log.partChars-=first.length; overflow-=first.length; }
    else{ log.parts[log.partHead]=first.slice(overflow); log.partChars-=overflow; overflow=0; }
  }
  if(log.partHead>1024&&log.partHead*2>log.parts.length){ log.parts.splice(0,log.partHead); log.partHead=0; }
}
function appendLiveLog(log,value,archiveValue){
  const prefix=log.hasContent?'\n':'',text=prefix+String(value==null?'':value),archiveText=prefix+String(archiveValue===undefined?value:archiveValue); log.hasContent=true;
  if(log.sink) log.sink.append(archiveText);
  appendLiveLogPart(log,text); appendLiveOutput(log.live,'out',text); return log;
}
/* Jenkins progressiveText 返回的 text 已是连续原始字节流；后续分片不能像普通日志行一样
   自动补换行，否则相邻轮询恰好落在一行中间时会篡改控制台内容。 */
function appendLiveChunk(log,value){
  const text=String(value==null?'':value); if(!text) return log;
  log.hasContent=true; if(log.sink) log.sink.append(text); appendLiveLogPart(log,text); appendLiveOutput(log.live,'out',text); return log;
}
function finishLiveLog(log){ return log.parts.slice(log.partHead||0).join(''); }
/* stdout 到达时增量提取变量，避免为 KEY=VALUE / 单行 JSON 再保留一份完整输出。
   单行与全文映射都以 128 KiB 为界：更大的值无法安全注入单个进程环境变量。 */
function outputProbeNeedsFull(spec){
  return String(spec||'').split(',').some(function(pair){ const p=pair.trim(),eq=p.indexOf('='); if(eq<0) return false; const src=p.slice(eq+1).trim(); return src===''||src==='*'; });
}
function outputProbeUtf8Size(text){
  let n=0;
  for(let i=0;i<text.length;i++){ const c=text.charCodeAt(i); if(c<0x80)n++; else if(c<0x800)n+=2; else if(c>=0xD800&&c<=0xDBFF&&i+1<text.length&&text.charCodeAt(i+1)>=0xDC00&&text.charCodeAt(i+1)<=0xDFFF){n+=4;i++;}else n+=3; }
  return n;
}
function createOutputProbe(spec){
  return {vars:{},json:null,line:'',lineOverflow:false,seen:false,finished:false,captureFull:outputProbeNeedsFull(spec),fullParts:[],fullBytes:0,fullTextOverflow:false};
}
function consumeOutputProbeLine(probe,line){
  const m=/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
  if(m){ let v=m[2].replace(/\r$/,''); if(v.length>=2&&v.charAt(0)==='"'&&v.charAt(v.length-1)==='"') v=v.slice(1,-1); probe.vars[m[1]]=v; }
  const t=line.trim(); if(t.length<2) return;
  const c0=t.charAt(0),c1=t.charAt(t.length-1);
  if(!((c0==='{'&&c1==='}')||(c0==='['&&c1===']'))) return;
  try{
    const value=JSON.parse(t); if(!value||typeof value!=='object') return;
    probe.json=value;
    if(!Array.isArray(value)) for(const k in value){ const v=value[k]; if(v!==null&&v!==undefined&&typeof v!=='object') probe.vars[k]=String(v); }
  }catch(e){}
}
function appendOutputProbe(probe,value){
  const text=String(value==null?'':value); if(!text||probe.finished) return probe;
  probe.seen=true;
  if(probe.captureFull&&!probe.fullTextOverflow){
    const bytes=outputProbeUtf8Size(text);
    if(probe.fullBytes+bytes<=128*1024){ probe.fullParts.push(text); probe.fullBytes+=bytes; }
    else{ probe.fullParts.length=0; probe.fullBytes=0; probe.fullTextOverflow=true; }
  }
  let start=0;
  for(;;){
    const end=text.indexOf('\n',start), stop=end<0?text.length:end, part=text.slice(start,stop);
    if(!probe.lineOverflow){
      if(probe.line.length+part.length<=128*1024) probe.line+=part;
      else{ probe.line=''; probe.lineOverflow=true; }
    }
    if(end<0) break;
    if(!probe.lineOverflow) consumeOutputProbeLine(probe,probe.line);
    probe.line=''; probe.lineOverflow=false; start=end+1;
  }
  return probe;
}
function finishOutputProbe(probe){
  if(!probe.finished){ if(!probe.lineOverflow&&probe.line) consumeOutputProbeLine(probe,probe.line); probe.finished=true; }
  return {vars:probe.vars,json:probe.json,fullText:probe.captureFull&&!probe.fullTextOverflow?probe.fullParts.join(''):undefined,fullTextOverflow:!!probe.fullTextOverflow};
}
function maybeRenderLiveDetail(rc,stage,lastLive,minInterval){
  const now=Date.now(), wait=Math.max(0,Number(minInterval)||1000);
  const root=rc&&rc.parallelParent?rc.parallelParent:rc;
  if(viewRc===root && selectedId===stage.id && now-lastLive>=wait){ renderDetail(); return now; }
  return lastLive;
}
function publishLiveOutput(rc,stage,live,lastPublished,minInterval,extra){
  const now=Date.now(),wait=Math.max(0,Number(minInterval)||1000);
  if(now-lastPublished<wait) return lastPublished;
  stage._out=liveOutputSnapshot(live,extra||{code:null});
  if(viewRc===rc&&selectedId===stage.id) renderDetail();
  return now;
}
/* 流式执行：POST /api/worktable/exec-stream（插件服务端 spawn 后按行回传 NDJSON：
   {"type":"out"|"err","text":…} / {"type":"done","code":N} / {"type":"error","message":…}）。
   逐行解析并回调 onStream({type,text})；累计 stdout/stderr，结束时返回 {code,stdout,stderr}。
   流中断（网络异常 / 响应非 200 / 被 signal 中止）时已收到的输出原样带回：
   AbortController 中止返回 code:null（调用方按令牌丢弃），其余中断按失败返回；
   接口不存在（旧插件构建未含该路由）返回 null，由 execScript 降级为一次性执行。 */
async function execStreaming(path, args, env, cwd, timeoutMs, onStream, signal, logFile){
  const output=createLiveOutputState(); let hasStderr=false;
  let logInfo=logFile?{logPending:true}:{};
  const recordLog=m=>{
    if(m.logFile) logInfo={logFile:m.logFile};
    if(m.logError) logInfo={logError:m.logError};
  };
  const emit=(type,text)=>{ if(typeof onStream==='function' && text) onStream({type,text}); };
  const append=(type,text)=>{ text=String(text||''); if(text){ appendLiveOutput(output,type,text); if(type==='err') hasStderr=true; } return text; };
  const result=(code,extra)=>liveOutputSnapshot(output,{code,...logInfo,...(extra||{})});
  const appendError=message=>{ append('err',(hasStderr?'\n':'')+String(message||'执行流错误')); };
  try{
    const r=await fetch('/api/worktable/exec-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,args,env,cwd,timeoutMs,logFile}),signal});
    if(!r.ok || !r.body){ await r.json().catch(()=>null); return null; }   // 旧插件构建无此路由：降级为一次性执行
    // 响应头先确认日志归属，避免首条数据前断流触发页面覆盖；旧插件仍可归档中止快照。
    logInfo=r.headers && r.headers.get('x-worktable-log')==='server' ? {logFile} : {};
    if(logFile && typeof onStream==='function') onStream({type:'log',...logInfo});
    const reader=r.body.getReader();
    const dec=new TextDecoder();
    let buf='';
    for(;;){
      let chunk;
      try{ chunk=await reader.read(); }
      catch(e){ if(e && e.name==='AbortError') return result(null); throw e; }
      if(chunk.done) break;
      buf+=dec.decode(chunk.value,{stream:true});
      let idx;
      while((idx=buf.indexOf('\n'))>=0){
        const line=buf.slice(0,idx).trim(); buf=buf.slice(idx+1);
        if(!line) continue;
        let m=null; try{ m=JSON.parse(line); }catch(e){ continue; }
        if(m.type==='log'){ recordLog(m); if(typeof onStream==='function') onStream(m); }
        else if(m.type==='out'){ const text=append('out',m.text); emit('out',text); }
        else if(m.type==='err'){ const text=append('err',m.text); emit('err',text); }
        else if(m.type==='error'){ const txt=m.message||'执行流错误'; appendError(txt); emit('err', txt); }
        else if(m.type==='done'){ recordLog(m); return result((typeof m.code==='number')?m.code:1); }
      }
    }
    if(buf.trim()){   // 末尾残余（流结束前未换行的最后一块）
      let m=null; try{ m=JSON.parse(buf.trim()); }catch(e){}
      if(m && m.type==='out'){ const text=append('out',m.text); emit('out',text); }
      else if(m && m.type==='err'){ const text=append('err',m.text); emit('err',text); }
      else if(m && m.type==='error'){ const txt=m.message||'执行流错误'; appendError(txt); emit('err', txt); }
      else if(m && m.type==='done'){ recordLog(m); return result((typeof m.code==='number')?m.code:1); }
    }
    appendError('（输出流意外中断，未收到完成标记）');
    return result(1);
  }catch(e){
    appendError('（执行流中断：'+(e&&e.message?e.message:e)+'）');
    return result(1);
  }
}
async function execScript(sc, timeoutMs, extraEnv, runCtx, onStream, signal, logFile){
  const rc=runCtx||curRun;   // 归档脚本等异步调用方传入已结束运行的快照上下文，避免运行队列切换后读到新运行的 curRun
  const args=[]; const env={};
  (sc.params||[]).forEach(p=>{
    /* 参数值支持 ${VAR} 引用上游产出 / 运行级变量（见 substRunVars）；整值单个未定义引用按空值处理（env 参数空 = 继承上游同名变量）。
       识别到的 :-默认值（静态/动态 dyn 一律）不下发：仅在编辑页参数框展示（未改动不写入 values）；留空由运行级注入值/上游同名变量兜底，
       都未注入时交由脚本自身 :- 展开（dyn 表达式注入后 shell 不会二次展开，也不能按字面值下发）；位置参数同理（留空传空串）。 */
    const hasVal=(sc.values && sc.values[p.key]!==undefined);
    const raw=hasVal?sc.values[p.key]:'';
    const v=substRunVars(raw, rc);
    if(p.kind==='pos') args.push(v);
    // Empty stage fields mean "inherit" so rendered artifact paths from an
    // upstream script are not overwritten with an empty environment value.
    else if(v!=='') env[p.key]=v;
  });
  /* 阶段间变量传递：上游阶段 stdout 的 KEY=VALUE 行累计在 curRun.vars，
     作为环境变量注入后续阶段。优先级：阶段显式参数 > 上游变量 > 运行级全局默认 */
  if(rc && rc.vars){
    for(const k in rc.vars){ if(env[k]===undefined) env[k]=rc.vars[k]; }
  }
  /* 归档脚本等异步调用方经 extraEnv 注入的运行级变量（ARCHIVE_* 等）：须先于下方运行级默认注入应用，
     否则归档脚本的 ARCHIVE_DIR=归档根目录会被 rc.archive 默认注入（=本次运行文件夹）提前占位挡住，
     host 节点环境日志（<ip>.log/controller.log）就会错写进单次运行文件夹；脚本显式参数仍最优先 */
  if(extraEnv){ for(const k in extraEnv){ if(env[k]===undefined) env[k]=extraEnv[k]; } }
  // 注入流水线运行信息（脚本显式配置的同名参数优先）：
  //   TARGET_IP=首个目标节点 IP；TARGET_IPS=全部目标 IP（JSON 数组）
  //   TARGET_HOSTS=全部节点 [{ip,user,pass}]（JSON 数组，多节点各自凭据）
  //   TARGET_NODE_IP_MAP=SSH 地址 → 内网IP 映射（仅填了内网IP的节点）；TARGET_LLM_ADDR_MAP=SSH 地址 → LLM服务地址 映射（仅填了的节点）
  //   注意（安全）：TARGET_HOSTS/GIT_PASSWORD 等含明文凭据，对所有脚本可见；
  //   且阶段 stdout 的 KEY=VALUE 会粘性注入下游并随历史/归档持久化——脚本切勿 echo 密码类变量。
  //   TARGET_USER/TARGET_PASSWORD=首个节点登录凭据；IMAGE_NAME/IMAGE_TAG=镜像名与本次 tag；PIPELINE_NAME=流水线名
  const ctx0=(rc && rc.envs && rc.envs[0]) || null;
  if(rc){
    if(env.TARGET_IP===undefined) env.TARGET_IP=(ctx0 && ctx0.ip) || rc.env || '';
    if(env.TARGET_IPS===undefined && rc.envs) env.TARGET_IPS=JSON.stringify(rc.envs.map(e=>e.ip));
    if(env.TARGET_HOSTS===undefined && rc.envs) env.TARGET_HOSTS=JSON.stringify(rc.envs.map(e=>({ip:e.ip, user:e.user||'', pass:e.pass||''})));
    if(env.TARGET_NODE_IP_MAP===undefined && rc.envs){
      const nodeIpMap={};
      rc.envs.forEach(e=>{ if(e.ip && e.nodeIp) nodeIpMap[e.ip]=e.nodeIp; });
      if(Object.keys(nodeIpMap).length) env.TARGET_NODE_IP_MAP=JSON.stringify(nodeIpMap);
    }
    if(env.TARGET_LLM_ADDR_MAP===undefined && rc.envs){
      const llmAddrMap={};
      rc.envs.forEach(e=>{ if(e.ip && e.llmAddr) llmAddrMap[e.ip]=e.llmAddr; });
      if(Object.keys(llmAddrMap).length) env.TARGET_LLM_ADDR_MAP=JSON.stringify(llmAddrMap);
    }
    if(env.IMAGE_NAME===undefined && rc.image) env.IMAGE_NAME=rc.image;
    if(env.IMAGE_TAG===undefined && rc.tag) env.IMAGE_TAG=rc.tag;
    if(env.PIPELINE_NAME===undefined && rc.pipelineName) env.PIPELINE_NAME=rc.pipelineName;
    if(env.GIT_URL===undefined && rc.repoUrl) env.GIT_URL=rc.repoUrl;
    if(env.GIT_BRANCH===undefined && rc.branch) env.GIT_BRANCH=rc.branch;
    if(env.DEPLOY_STRATEGY===undefined && rc.strategy) env.DEPLOY_STRATEGY=rc.strategy;
    if(env.GIT_USER===undefined && rc.repoUser) env.GIT_USER=rc.repoUser;
    if(env.GIT_PASSWORD===undefined && rc.repoPass) env.GIT_PASSWORD=rc.repoPass;
    /* 权重路径（主控「权重路径」可选填写）：非空时作为 MODEL_PATH 注入（脚本显式参数与上游阶段产出优先），
       供 deploy/register 等脚本读取；留空不注入，由脚本自身 :- 默认值兜底。
       PIPELINE_PRESETS=本次运行勾选的预设任务 key（JSON 数组，如 ["cleanup","profiling"]；含自定义预设 key），
       脚本可据此判断预设任务是否启用（如 echo "$PIPELINE_PRESETS" | grep -q profiling）。 */
    if(env.MODEL_PATH===undefined && rc.weightsPath) env.MODEL_PATH=rc.weightsPath;
    if(env.PIPELINE_PRESETS===undefined && rc.presets) env.PIPELINE_PRESETS=JSON.stringify(rc.presets);
    /* 归档路径：启动时已快照到 rc.archive（archiveFolderFor），按「流水线名称_年月日时分秒」文件夹注入各阶段，
       供脚本把本阶段产物直接写入归档目录；脚本显式参数优先。留空（未配置归档）则不注入。
       此处 ARCHIVE_DIR/ARCHIVE_FOLDER 均=本次运行归档文件夹；注意末尾 archiveRun 注入归档脚本的
       ARCHIVE_DIR 为归档根目录（host 节点环境日志写到根目录，见 scripts/collect_logs.sh），两处语义不同。 */
    if(rc.archive){
      if(env.ARCHIVE_DIR===undefined) env.ARCHIVE_DIR=rc.archive;
      if(env.ARCHIVE_FOLDER===undefined) env.ARCHIVE_FOLDER=rc.archive;
      if(env.ARCHIVE_PIPELINE===undefined && rc.pipelineName) env.ARCHIVE_PIPELINE=rc.pipelineName;
      if(env.ARCHIVE_TAG===undefined && rc.tag) env.ARCHIVE_TAG=rc.tag;
    }
  }
  if(ctx0){ if(ctx0.user && env.TARGET_USER===undefined) env.TARGET_USER=ctx0.user; if(ctx0.pass && env.TARGET_PASSWORD===undefined) env.TARGET_PASSWORD=ctx0.pass; }
  /* 流式回显（默认）：调用方传入 onStream 时走 /api/worktable/exec-stream，执行中逐块实时回调；
     接口不可用（旧插件构建返回非 200）时返回 null，降级走下方一次性 /api/worktable/exec */
  if(typeof onStream==='function'){
    const st=await execStreaming(sc.path, args, env, (typeof runScriptsDir==='function')?runScriptsDir(rc):scriptsDir, timeoutMs||0, onStream, signal, logFile);   // timeoutMs 0/缺省=无超时（服务端同语义）；cwd 取本运行设置快照
    if(st) return st;
  }
  try{
    const r=await fetch('/api/worktable/exec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:sc.path, args, env, cwd:(typeof runScriptsDir==='function')?runScriptsDir(rc):scriptsDir, timeoutMs:timeoutMs||0,logFile}),signal});   // 0=无超时
    const j=await r.json();
    if(j && j.error) return {code:1, stdout:'', stderr:String(j.error)};
    return {code:(j&&j.code!==undefined)?j.code:1, stdout:(j&&j.stdout)||'', stderr:(j&&j.stderr)||'',logFile:j&&j.logFile,logError:j&&j.logError};
  }catch(e){ return {code:1, stdout:'', stderr:String(e.message||e),logPending:!!logFile}; }
}
async function readBrowserResponseText(response,maxBytes){
  const limit=Math.max(1,Number(maxBytes)||20*1024*1024);
  const declared=Number(response&&response.headers&&response.headers.get?response.headers.get('content-length'):0);
  if(Number.isFinite(declared)&&declared>limit){ try{ await response.body?.cancel(); }catch(e){} throw new Error('响应正文过大（上限 '+limit+' 字节）'); }
  if(response&&response.body&&typeof response.body.getReader==='function'){
    const reader=response.body.getReader(),decoder=new TextDecoder(),parts=[]; let size=0;
    try{
      for(;;){ const item=await reader.read(); if(item.done) break; size+=item.value.byteLength; if(size>limit){ try{await reader.cancel();}catch(e){} throw new Error('响应正文过大（上限 '+limit+' 字节）'); } parts.push(decoder.decode(item.value,{stream:true})); }
      parts.push(decoder.decode()); return parts.join('');
    }finally{ try{reader.releaseLock();}catch(e){} }
  }
  const text=String(await response.text()),bytes=(typeof TextEncoder!=='undefined'?new TextEncoder().encode(text).byteLength:text.length);
  if(bytes>limit) throw new Error('响应正文过大（上限 '+limit+' 字节）');
  return text;
}
