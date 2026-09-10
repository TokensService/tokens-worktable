const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');
function load(a,b,ctx){const start=source.indexOf(a);vm.runInContext(source.slice(start,source.indexOf(b,start)),ctx);}
function context(){
  const flow={innerHTML:'',children:[],appendChild(n){this.children.push(n);}};
  const checkbox={checked:true},checkBox={checked:false},profilingBox={checked:false};
  const ctx={curRun:null,runStages:null,replayRec:null,cleanupScript:{name:'clean.sh',path:'/tmp/clean.sh'},checkScript:null,profilingScript:null,running:false,
    viewRc:null,selectedId:null,   // 多运行上下文：编排区焦点运行（null=无运行视图）与视图层选中
    curPipeline:()=>({}),
    activeStages:()=>[{id:'first',name:'First'},{id:'second',name:'Second'}],$:id=>id==='flow'?flow:(id==='checkEnv'?checkBox:(id==='profilingEnv'?profilingBox:checkbox)),
    document:{createElement:()=>({dataset:{},addEventListener(type,fn){this[type]=fn;}})},esc:String,
    applyStatusClasses(){},renderDetail(){},openPlForm(_pid,i){ctx.edited=i;},curPipelineId:'pl',
    viewActive:()=>!!(ctx.viewRc&&!ctx.viewRc.over),
    setSel:id=>{ctx.selectedId=id;if(ctx.viewRc)ctx.viewRc.selId=id;}};
  vm.createContext(ctx);load('/* ---------- 渲染流水线编排 ---------- */','function applyStatusClasses(',ctx);
  return {ctx,flow,checkbox,checkBox,profilingBox};
}
test('勾选后首位显示清理，取消后移除，普通任务可编辑（编辑器内预设行占位，焦点序号含预设行）',()=>{
  const {ctx,flow,checkbox}=context();ctx.renderFlow();
  assert.match(flow.children[0].innerHTML,/环境清理/);
  flow.children[2].dblclick();assert.equal(ctx.edited,2);   // 编辑器行序：环境清理/环境检查两行预设在前，First 为第 3 行（序号 2）
  checkbox.checked=false;flow.children=[];ctx.renderFlow();
  assert.match(flow.children[0].innerHTML,/First/);
});
test('勾选检查后清理仍在首位、检查次之（执行顺序：清理 → 检查），预设节点双击均不可编辑',()=>{
  const {ctx,flow,checkBox}=context();checkBox.checked=true;ctx.renderFlow();
  assert.match(flow.children[0].innerHTML,/环境清理/);
  assert.match(flow.children[2].innerHTML,/环境检查/);
  flow.children[0].dblclick();assert.equal(ctx.edited,undefined);   // 预设任务不可在编排区双击编辑（顺序在流水线编辑中调整）
  flow.children[2].dblclick();assert.equal(ctx.edited,undefined);
  flow.children[4].dblclick();assert.equal(ctx.edited,2);
});
test('Profiling 默认排在流水线最后（预设任务默认位置：清理/检查最前、Profiling 最后）',()=>{
  const {ctx,flow,profilingBox}=context();profilingBox.checked=true;ctx.renderFlow();
  // [环境清理, conn, First, conn, Second, conn, Profiling]
  assert.match(flow.children[6].innerHTML,/Profiling/);
});
test('旧流水线的收集普罗数据预设标记行随预设下线过滤，不再展开进编排与运行',()=>{
  const {ctx,flow}=context();
  ctx.activeStages=()=>[{id:'__prom_collect__',name:'收集普罗数据',preset:true,pkey:'promCollect'},{id:'first',name:'First'}];
  ctx.renderFlow();
  assert.equal(flow.children.filter(n=>/收集普罗数据/.test(n.innerHTML)).length,0);
  assert.deepEqual(ctx.expandRunStages(ctx.activeStages(),[]).map(s=>s.id),['first']);
});
test('预设任务按流水线保存的位置展开（编排调序后 Profiling 可排到中间）',()=>{
  const {ctx,flow,checkBox,profilingBox}=context();checkBox.checked=true;profilingBox.checked=true;
  ctx.activeStages=()=>[{id:'first',name:'First'},{id:'__profiling__',name:'Profiling',preset:true,pkey:'profiling'},{id:'second',name:'Second'}];
  ctx.renderFlow();
  // [环境清理, conn, 环境检查, conn, First, conn, Profiling, conn, Second]
  assert.match(flow.children[0].innerHTML,/环境清理/);
  assert.match(flow.children[2].innerHTML,/环境检查/);
  assert.match(flow.children[4].innerHTML,/First/);
  assert.match(flow.children[6].innerHTML,/Profiling/);
  assert.match(flow.children[8].innerHTML,/Second/);
});
test('未勾选的预设任务不进编排（开关控制启用，位置控制顺序）',()=>{
  const {ctx,flow,checkbox}=context();checkbox.checked=false;ctx.renderFlow();
  assert.equal(flow.children.filter(n=>/环境清理|环境检查|Profiling/.test(n.innerHTML)).length,0);
  assert.match(flow.children[0].innerHTML,/First/);
});
test('运行参数携带预设列表时覆盖当前主控复选框',()=>{
  const {ctx,checkbox,checkBox}=context();checkbox.checked=true;checkBox.checked=false;
  const stages=ctx.expandRunStages([{id:'first',name:'First'}],['check']);
  assert.deepEqual(stages.map(s=>s.id),['__check__','first']);
});
test('运行快照和历史中的预设节点不受当前开关影响',()=>{
  const {ctx,flow,checkbox,checkBox}=context();checkbox.checked=false;checkBox.checked=false;
  // 运行态：runStages 已在启动时按勾选展开（含运行态预设节点），flowStages 原样返回
  ctx.runStages=[{id:'__cleanup__',name:'环境清理',preset:true,pkey:'cleanup',script:null}].concat(ctx.activeStages());
  ctx.curRun={token:1};
  ctx.renderFlow();assert.match(flow.children[0].innerHTML,/环境清理/);assert.match(flow.children[2].innerHTML,/First/);
  // 回放态：按历史 logs 里出现过的预设任务展开
  ctx.curRun=null;ctx.replayRec={logs:[{stage:'环境清理',status:'success'}]};flow.children=[];
  ctx.renderFlow();assert.match(flow.children[0].innerHTML,/环境清理/);assert.match(flow.children[2].innerHTML,/First/);
});
test('修改清理配置不能抹掉失败阶段的重试上下文',()=>{
  const {ctx}=context();
  // 已结束运行的重试上下文：viewRc 指向该运行（over=true），失败阶段状态留在 rc.nodes
  const rc={id:'r1',stages:ctx.activeStages(),nodes:{first:{status:'failed',varsIn:{KEY:'value'}}},selId:null,timer:null,over:true,overall:null,token:1,vars:{KEY:'value'}};
  ctx.viewRc=rc;ctx.curRun=rc;ctx.runStages=rc.stages;ctx.nodes=rc.nodes;
  Object.assign(ctx,{localStorage:{setItem(){}},persistState(){},resetNodes(){ctx.nodes={};}});
  load('function renderPresetMultiBtn(', 'function renderCleanupParams(',ctx);
  ctx.saveCleanup();
  assert.equal(ctx.viewRc,rc);assert.equal(ctx.curRun,rc);assert.equal(ctx.nodes.first.status,'failed');
});
const PRESET_DEF_STUB={cleanup:{name:'环境清理',block:false},check:{name:'环境检查',block:true},profiling:{name:'Profiling',block:false}};
function presetCtx(s){
  const calls={advance:[],finish:[],overall:[],exec:[]};
  // 多运行上下文：被测引擎函数签名已改为接收 rc，状态全部挂在 rc 上（stages/nodes/selId/timer/over/vars/token…）
  const rc={id:'r1',stages:[s,{id:'next',name:'Next'}],nodes:{},selId:null,timer:null,over:false,overall:null,token:1,vars:{},
    env:null,envs:null,image:'',release:'',commit:'',tag:'t',startTs:0,by:'test',source:'manual',pipelineId:'pl',pipelineName:'pl',archive:''};
  const ctx={rc,viewRc:rc,selectedId:null,console,AbortController,setInterval,clearInterval,
    PRESET_DEF:PRESET_DEF_STUB,
    renderFlow(){},renderDetail(){},applyStatusClasses(){},
    runSetSel:(rc_,id)=>{rc_.selId=id;if(ctx.viewRc===rc_)ctx.selectedId=id;},   // 引擎层选中：写 rc，聚焦时同步视图
    rcRender(){},rcOverall:(rc_,txt,cls,color)=>{rc_.overall={txt:txt,cls:cls,color:color||''};calls.overall.push(txt);},
    advance:(rc_,i)=>{calls.advance.push(i);},finish:(rc_,r)=>{calls.finish.push(r);},
    $:()=>({firstChild:null}),
    archiveFolderFor:()=>'/logs',taskLogFile:()=> 'preset.log',archiveStageLog(){},
    execScript:async(sc,t,e,_r,stream)=>{calls.exec.push({sc,t,e});if(stream)stream({type:'out',text:'live\n'});return new Promise(r=>{ctx._complete=r;});}};
  vm.createContext(ctx);
  load('function createLiveOutputState(', '/* 流式执行：POST',ctx);
  load('async function runPresetStep(', '/* ---------- 产物归档',ctx);
  return {ctx,calls,rc};
}
test('预设任务实时回显到独立节点，失败不阻断（清理/Profiling）并推进下一阶段',async()=>{
  const s={id:'__cleanup__',name:'环境清理',preset:true,pkey:'cleanup',script:{name:'clean.sh',path:'/tmp/clean.sh'}};
  const {ctx,calls,rc}=presetCtx(s);
  const done=ctx.runPresetStep(rc,0);
  try{
    assert.equal(rc.nodes[s.id]?.status,'running');assert.equal(s._out?.stdout,'live\n');assert.equal(rc.selId,s.id);
  }finally{ctx._complete({code:7,stdout:'live\n',stderr:'bad',logFile:'/logs/preset.log'});await done;}
  assert.equal(rc.nodes[s.id].status,'failed');
  assert.deepEqual(calls.advance,[1]);   // 失败不阻断，推进下一阶段
  assert.deepEqual(calls.finish,[]);
});
test('环境检查不通过（非零退出）阻断后续阶段并按失败收尾',async()=>{
  const s={id:'__check__',name:'环境检查',preset:true,pkey:'check',script:{name:'check.sh',path:'/tmp/check.sh'}};
  const {ctx,calls,rc}=presetCtx(s);
  const done=ctx.runPresetStep(rc,0);
  ctx._complete({code:1,stdout:'',stderr:'boom',logFile:'/logs/preset.log'});await done;
  assert.equal(rc.nodes[s.id].status,'failed');
  assert.deepEqual(calls.advance,[]);assert.deepEqual(calls.finish,['failed']);
  assert.ok(calls.overall.some(t=>t.indexOf('环境检查未通过')>=0));
});
test('未配置预设脚本时按跳过处理并推进（不阻断）',async()=>{
  const s={id:'__profiling__',name:'Profiling',preset:true,pkey:'profiling',script:null};
  const {ctx,calls,rc}=presetCtx(s);
  await ctx.runPresetStep(rc,0);
  assert.equal(rc.nodes[s.id].status,'skipped');assert.deepEqual(calls.advance,[1]);
});
test('预设任务中止后的迟回不能修改新运行或清掉新计时器',async()=>{
  const s={id:'__cleanup__',name:'环境清理',preset:true,pkey:'cleanup',script:{path:'/tmp/clean.sh'}};
  const {ctx,calls,rc}=presetCtx(s);
  const done=ctx.runPresetStep(rc,0);
  // 中止本运行（abortRun/重置的记账）：断流、清本运行计时器、标 over
  rc.scriptAbort.abort();clearInterval(rc.timer);rc.timer=null;rc.over=true;
  // 新运行是独立上下文：有自己的计时器与节点表；编排区焦点已切到新运行
  const rc2={id:'r2',stages:[{id:'other',name:'Other'}],nodes:{other:{status:'running'}},selId:null,timer:123,over:false,overall:null,token:2,vars:{}};
  ctx.viewRc=rc2;ctx.curRun=rc2;
  ctx._complete({code:null,stdout:'partial',stderr:''});await done;
  assert.equal(ctx.viewRc,rc2);assert.equal(rc2.timer,123);assert.equal(rc2.nodes.other.status,'running');
  assert.deepEqual(calls.advance,[]);assert.deepEqual(calls.finish,[]);
});
test('预设任务多选按钮文案跟随勾选（全不选显示「（不执行）」）',()=>{
  const btn={textContent:'',title:''},cleanupBox={checked:true},checkBox={checked:false},profilingBox={checked:false};
  const ctx={$:id=>id==='presetMultiBtn'?btn:(id==='checkEnv'?checkBox:(id==='profilingEnv'?profilingBox:cleanupBox))};
  vm.createContext(ctx);load('function renderPresetMultiBtn(', 'function saveCleanup(',ctx);
  ctx.renderPresetMultiBtn();assert.equal(btn.textContent,'环境清理');
  checkBox.checked=true;profilingBox.checked=true;ctx.renderPresetMultiBtn();assert.equal(btn.textContent,'环境清理、环境检查、Profiling');assert.equal(btn.title,btn.textContent);
  cleanupBox.checked=false;checkBox.checked=false;profilingBox.checked=false;ctx.renderPresetMultiBtn();assert.equal(btn.textContent,'（不执行）');
});

test('流水线编辑器普通任务卡展示「收集普罗数据」开关（勾选态随阶段保存）',()=>{
  const wrap={innerHTML:'',children:[],appendChild(n){this.children.push(n);}};
  const ctx={editStages:[{id:'a',name:'构建',kind:'simulate',promCollect:true},{id:'b',name:'测试',kind:'simulate'}],editFocusIdx:-1,
    plFormReadOnly:false,applyPlFormReadOnly(){},
    $:id=>id==='plStageList'?wrap:null,esc:String,secToMinInput:s=>String((s||0)/60),
    STAGE_KIND_LABEL:{simulate:'模拟',shell:'Shell',python:'Python',http:'HTTP',evaltokens:'EvalTokens'},
    stageCardMouseDown(){},stageCardDragStart(){},stageCardDragOver(){},stageCardDrop(){},stageCardDragEnd(){},
    renderStageActionRow(){},renderStageParams(){},renderStageSched(){},
    document:{createElement:()=>({dataset:{},style:{},innerHTML:'',classList:{toggle(){},add(){},remove(){},contains(){return false;}},addEventListener(){},querySelector(){return null;}})}};
  vm.createContext(ctx);load('let editSelStage', 'function renderStageParams(',ctx);ctx.renderStageEditor();
  assert.match(wrap.children[0].innerHTML,/data-f="promCollect" checked[^>]*\/> 收集普罗数据/);
  assert.match(wrap.children[1].innerHTML,/data-f="promCollect" \/> 收集普罗数据/);
});

/* 任务级普罗采集（taskPromFinalize/taskPromCollect）：勾选「收集普罗数据」的任务进入终态后，
   按「任务开始→结束」时段后台调用收集脚本，产物落 {任务名}-{阶段序号}-普罗数据 目录 */
function taskPromCtx(rc,collectScript){
  const calls=[];
  const ctx={
    console:{warn(){console.warn.apply(null,arguments);}},scriptsDir:'/scripts',
    prom:{collectScript:collectScript===undefined?'collect.py':collectScript},
    scriptByName:n=>({name:n,path:'/scripts/'+n}),
    DEFAULT_PIPELINE_PROM:{modelName:'${MODEL_PATH}',xdsNamespace:'${DEPLOY_STRATEGY}-${BY}'},
    substRunVars:(v,rc_)=>String(v).replace('${MODEL_PATH}',(rc_.vars&&rc_.vars.MODEL_PATH)||'').replace('${DEPLOY_STRATEGY}','arch-a').replace('${BY}','lhf'),
    buildPromCollectEnv:(c,s,e)=>({PROM_START:String(s),PROM_END:String(e),MODEL_NAME:c.prom.modelName,XDS_NAMESPACE:c.prom.xdsNamespace}),
    execScript:async(sc,t,env,_r,_os,_sig,logFile)=>{calls.push({sc:sc.name,t,env,logFile});return {code:0,stdout:'',stderr:''};},
    stageSeq:(stg,i)=>i+1,
    sanitizeFsName:s=>String(s).replace(/\s+/g,'-'),
  };
  vm.createContext(ctx);load('function taskPromFolderName(','function pmcSay(',ctx);
  return {ctx,calls};
}
test('勾选收集普罗数据的任务进入终态后按其起止采集到 {任务名}-{阶段序号}-普罗数据 目录',async()=>{
  const rc={stages:[
    {id:'a',name:'构建',promCollect:true,_promT0:1000},
    {id:'b',name:'测试'},   // 未勾选：不采
  ],nodes:{a:{status:'success'},b:{status:'running'}},archive:'/arch/run',vars:{MODEL_PATH:'/models/demo'}};
  const {ctx,calls}=taskPromCtx(rc);
  ctx.taskPromFinalize(rc);
  await new Promise(r=>setImmediate(r));
  assert.equal(rc.stages[0]._promCollected,true);
  assert.equal(rc.stages[1]._promCollected,undefined);
  assert.equal(calls.length,1);
  assert.equal(calls[0].sc,'collect.py');
  assert.equal(calls[0].t,0);   // 与手动收集一致不设超时
  assert.equal(calls[0].env.PROM_START,'1000');
  assert.equal(calls[0].env.MODEL_NAME,'/models/demo');
  assert.equal(calls[0].env.METRICS_OUTPUT_DIR,'/arch/run/构建-01-普罗数据');
  assert.equal(calls[0].logFile,'/arch/run/构建-01-普罗数据/collect.log');
  ctx.taskPromFinalize(rc);   // 去重：二次扫描不再采集
  await new Promise(r=>setImmediate(r));
  assert.equal(calls.length,1);
});
test('任务级普罗采集：非终态（运行中/跳过）与未配置收集脚本都不发起采集',async()=>{
  const rc={stages:[{id:'a',name:'构建',promCollect:true,_promT0:1000},{id:'b',name:'测试',promCollect:true,_promT0:2000}],nodes:{a:{status:'running'},b:{status:'skipped'}},archive:'',vars:{}};
  const {ctx,calls}=taskPromCtx(rc);
  ctx.taskPromFinalize(rc);
  await new Promise(r=>setImmediate(r));
  assert.equal(calls.length,0);
  const rc2={stages:[{id:'a',name:'构建',promCollect:true,_promT0:1000}],nodes:{a:{status:'failed'}},archive:'/arch/run',vars:{}};
  const noScript=taskPromCtx(rc2,'');
  noScript.ctx.taskPromFinalize(rc2);
  await new Promise(r=>setImmediate(r));
  assert.equal(noScript.calls.length,0);
  assert.equal(rc2.stages[0]._promCollected,true);   // 未配置脚本同样标记已处理（采集跳过仅告警）
});
