const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/pipeline.html','utf8');
function load(a,b,ctx){const start=source.indexOf(a);vm.runInContext(source.slice(start,source.indexOf(b,start)),ctx);}
function context(){
  const flow={innerHTML:'',children:[],appendChild(n){this.children.push(n);}};
  const checkbox={checked:true},checkBox={checked:false},profilingBox={checked:false},promBox={checked:false};
  const ctx={curRun:null,runStages:null,replayRec:null,cleanupScript:{name:'clean.sh',path:'/tmp/clean.sh'},checkScript:null,profilingScript:null,running:false,
    prom:{collectScript:''},scriptByName:()=>null,
    normalizePipelineProm:p=>Object.assign({modelName:'',xdsNamespace:'${DEPLOY_STRATEGY}-${BY}',startTime:'',endTime:''},p||{}),
    curPipeline:()=>({prom:null}),
    activeStages:()=>[{id:'first',name:'First'},{id:'second',name:'Second'}],$:id=>id==='flow'?flow:(id==='checkEnv'?checkBox:(id==='profilingEnv'?profilingBox:(id==='promCollectEnv'?promBox:checkbox))),
    document:{createElement:()=>({dataset:{},addEventListener(type,fn){this[type]=fn;}})},esc:String,
    applyStatusClasses(){},renderDetail(){},openPlForm(_pid,i){ctx.edited=i;},curPipelineId:'pl'};
  vm.createContext(ctx);load('/* ---------- 渲染流水线编排 ---------- */','function applyStatusClasses(',ctx);
  return {ctx,flow,checkbox,checkBox,profilingBox,promBox};
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
test('收集普罗数据是可选的预设任务，默认排在流水线最后',()=>{
  const {ctx,flow,checkbox,promBox}=context();checkbox.checked=false;promBox.checked=true;ctx.renderFlow();
  assert.match(flow.children[4].innerHTML,/收集普罗数据/);
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
test('已入队的收集普罗任务按入队开关快照展开，不受当前复选框变化影响',()=>{
  const {ctx,promBox}=context();promBox.checked=false;
  const stages=ctx.expandRunStages([{id:'first',name:'First'}],{enabled:true,modelName:'queued-model'});
  const task=stages.find(s=>s.pkey==='promCollect');
  assert.ok(task);assert.equal(task.prom.modelName,'queued-model');
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
  const run={token:1,vars:{KEY:'value'}};
  ctx.curRun=run;ctx.runStages=ctx.activeStages();ctx.nodes={first:{status:'failed',varsIn:{KEY:'value'}}};
  Object.assign(ctx,{localStorage:{setItem(){}},persistState(){},resetNodes(){ctx.nodes={};}});
  load('function renderPresetMultiBtn(', 'function renderCleanupParams(',ctx);
  ctx.saveCleanup();
  assert.equal(ctx.curRun,run);assert.equal(ctx.nodes.first.status,'failed');
});
const PRESET_DEF_STUB={cleanup:{name:'环境清理',block:false},check:{name:'环境检查',block:true},profiling:{name:'Profiling',block:false},promCollect:{name:'收集普罗数据',block:false}};
function presetCtx(s){
  const calls={advance:[],finish:[],overall:[],exec:[]};
  const ctx={curRun:{token:1},nodes:{},running:true,AbortController,setInterval,clearInterval,timer:null,selectedId:null,
    PRESET_DEF:PRESET_DEF_STUB,activeStages:()=>[s,{id:'next',name:'Next'}],
    normalizePipelineProm:p=>Object.assign({modelName:'',xdsNamespace:'${DEPLOY_STRATEGY}-${BY}',startTime:'',endTime:''},p||{}),
    renderFlow(){},renderDetail(){},applyStatusClasses(){},
    setOverall(t){calls.overall.push(t);},advance(i){calls.advance.push(i);},finish(r){calls.finish.push(r);},
    $:()=>({firstChild:null}),
    archiveFolderFor:()=>'/logs',taskLogFile:()=> 'preset.log',archiveStageLog(){},
    buildPromCollectEnv:(promCtx,startMs,endMs)=>({PROM_START:String(startMs),PROM_END:String(endMs),MODEL_NAME:promCtx.prom.modelName}),
    dtLocalToMs:()=>0,
    execScript:async(sc,t,e,_r,stream)=>{calls.exec.push({sc,t,e});if(stream)stream({type:'out',text:'live\n'});return new Promise(r=>{ctx._complete=r;});}};
  vm.createContext(ctx);load('async function runPresetStep(', '/* ---------- 产物归档',ctx);
  return {ctx,calls};
}
test('预设任务实时回显到独立节点，失败不阻断（清理/Profiling）并推进下一阶段',async()=>{
  const s={id:'__cleanup__',name:'环境清理',preset:true,pkey:'cleanup',script:{name:'clean.sh',path:'/tmp/clean.sh'}};
  const {ctx,calls}=presetCtx(s);
  const done=ctx.runPresetStep(0);
  try{
    assert.equal(ctx.nodes[s.id]?.status,'running');assert.equal(s._out?.stdout,'live\n');assert.equal(ctx.selectedId,s.id);
  }finally{ctx._complete({code:7,stdout:'live\n',stderr:'bad',logFile:'/logs/preset.log'});await done;}
  assert.equal(ctx.nodes[s.id].status,'failed');
  assert.deepEqual(calls.advance,[1]);   // 失败不阻断，推进下一阶段
  assert.deepEqual(calls.finish,[]);
});
test('环境检查不通过（非零退出）阻断后续阶段并按失败收尾',async()=>{
  const s={id:'__check__',name:'环境检查',preset:true,pkey:'check',script:{name:'check.sh',path:'/tmp/check.sh'}};
  const {ctx,calls}=presetCtx(s);
  const done=ctx.runPresetStep(0);
  ctx._complete({code:1,stdout:'',stderr:'boom',logFile:'/logs/preset.log'});await done;
  assert.equal(ctx.nodes[s.id].status,'failed');
  assert.deepEqual(calls.advance,[]);assert.deepEqual(calls.finish,['failed']);
  assert.ok(calls.overall.some(t=>t.indexOf('环境检查未通过')>=0));
});
test('未配置预设脚本时按跳过处理并推进（不阻断）',async()=>{
  const s={id:'__profiling__',name:'Profiling',preset:true,pkey:'profiling',script:null};
  const {ctx,calls}=presetCtx(s);
  await ctx.runPresetStep(0);
  assert.equal(ctx.nodes[s.id].status,'skipped');assert.deepEqual(calls.advance,[1]);
});
test('收集普罗预设任务执行时注入该任务的采集配置，失败不阻断',async()=>{
  const s={id:'__prom_collect__',name:'收集普罗数据',preset:true,pkey:'promCollect',script:{name:'collect.py',path:'/tmp/collect.py'},prom:{modelName:'model-a',xdsNamespace:'ns-a',startTime:'',endTime:''}};
  const {ctx,calls}=presetCtx(s);ctx.curRun.startTs=1000;ctx.curRun.archive='/logs/run';
  const done=ctx.runPresetStep(0);
  ctx._complete({code:2,stdout:'partial',stderr:'bad',logFile:'/logs/preset.log'});await done;
  assert.deepEqual(calls.exec[0].e,{PROM_START:'1000',PROM_END:String(calls.exec[0].e.PROM_END),MODEL_NAME:'model-a'});
  assert.equal(calls.exec[0].t,0);
  assert.equal(ctx.nodes[s.id].status,'failed');assert.deepEqual(calls.advance,[1]);assert.deepEqual(calls.finish,[]);
});
test('收集普罗预设任务拒绝开始时间不早于结束时间的配置',async()=>{
  const s={id:'__prom_collect__',name:'收集普罗数据',preset:true,pkey:'promCollect',script:{name:'collect.py',path:'/tmp/collect.py'},prom:{modelName:'model-a',xdsNamespace:'ns-a',startTime:'later',endTime:'earlier'}};
  const {ctx,calls}=presetCtx(s);ctx.curRun.startTs=1000;ctx.curRun.archive='/logs/run';
  ctx.dtLocalToMs=v=>v==='later'?3000:2000;
  ctx.execScript=async(...args)=>{calls.exec.push(args);return {code:0,stdout:'',stderr:''};};
  await ctx.runPresetStep(0);
  assert.equal(calls.exec.length,0);
  assert.equal(ctx.nodes[s.id].status,'failed');assert.match(s._out.stderr,/开始时间必须早于结束时间/);
  assert.deepEqual(calls.advance,[1]);assert.deepEqual(calls.finish,[]);
});
test('预设任务中止后的迟回不能修改新运行或清掉新计时器',async()=>{
  const s={id:'__cleanup__',name:'环境清理',preset:true,pkey:'cleanup',script:{path:'/tmp/clean.sh'}};
  const {ctx,calls}=presetCtx(s);
  const done=ctx.runPresetStep(0),oldRun=ctx.curRun;
  oldRun.scriptAbort.abort();clearInterval(ctx.timer);
  const newRun={token:2};ctx.curRun=newRun;ctx.timer=123;ctx.nodes={other:{status:'running'}};
  ctx._complete({code:null,stdout:'partial',stderr:''});await done;
  assert.equal(ctx.curRun,newRun);assert.equal(ctx.timer,123);assert.equal(ctx.nodes.other.status,'running');
  assert.deepEqual(calls.advance,[]);assert.deepEqual(calls.finish,[]);
});
test('预设任务多选按钮文案跟随勾选（全不选显示「（不执行）」）',()=>{
  const btn={textContent:'',title:''},cleanupBox={checked:true},checkBox={checked:false},profilingBox={checked:false},promBox={checked:false};
  const ctx={$:id=>id==='presetMultiBtn'?btn:(id==='checkEnv'?checkBox:(id==='profilingEnv'?profilingBox:(id==='promCollectEnv'?promBox:cleanupBox)))};
  vm.createContext(ctx);load('function renderPresetMultiBtn(', 'function saveCleanup(',ctx);
  ctx.renderPresetMultiBtn();assert.equal(btn.textContent,'环境清理');
  checkBox.checked=true;profilingBox.checked=true;ctx.renderPresetMultiBtn();assert.equal(btn.textContent,'环境清理、环境检查、Profiling');assert.equal(btn.title,btn.textContent);
  promBox.checked=true;ctx.renderPresetMultiBtn();assert.equal(btn.textContent,'环境清理、环境检查、Profiling、收集普罗数据');
  cleanupBox.checked=false;checkBox.checked=false;profilingBox.checked=false;promBox.checked=false;ctx.renderPresetMultiBtn();assert.equal(btn.textContent,'（不执行）');
});

test('流水线编辑器在收集普罗预设任务行内展示 model/namespace/起止时间',()=>{
  const wrap={innerHTML:'',children:[],appendChild(n){this.children.push(n);}};
  const ctx={editStages:[{id:'__prom_collect__',name:'收集普罗数据',preset:true,pkey:'promCollect',prom:{modelName:'model-a',xdsNamespace:'ns-a',startTime:'2026-09-08T10:00',endTime:'2026-09-08T11:00'}}],editFocusIdx:-1,
    $:id=>id==='plStageList'?wrap:null,esc:String,
    normalizePipelineProm:p=>Object.assign({modelName:'',xdsNamespace:'${DEPLOY_STRATEGY}-${BY}',startTime:'',endTime:''},p||{}),
    document:{createElement:()=>({dataset:{},style:{},innerHTML:'',querySelector(){return null;}})}};
  vm.createContext(ctx);load('function renderStageEditor(', 'function renderStageParams(',ctx);ctx.renderStageEditor();
  const html=wrap.children[0].innerHTML;
  assert.match(html,/data-f="promModelName"[^>]*value="model-a"/);
  assert.match(html,/data-f="promXdsNamespace"[^>]*value="ns-a"/);
  assert.match(html,/data-f="promStart"[^>]*value="2026-09-08T10:00"/);
  assert.match(html,/data-f="promEnd"[^>]*value="2026-09-08T11:00"/);
});
