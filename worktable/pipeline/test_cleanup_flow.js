const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/pipeline.html','utf8');
function load(a,b,ctx){const start=source.indexOf(a);vm.runInContext(source.slice(start,source.indexOf(b,start)),ctx);}
function context(){
  const flow={innerHTML:'',children:[],appendChild(n){this.children.push(n);}};
  const checkbox={checked:true};
  const ctx={curRun:null,runStages:null,replayRec:null,cleanupScript:{name:'clean.sh',path:'/tmp/clean.sh'},running:false,
    activeStages:()=>[{id:'first',name:'First'},{id:'second',name:'Second'}],$:id=>id==='flow'?flow:checkbox,
    document:{createElement:()=>({dataset:{},addEventListener(type,fn){this[type]=fn;}})},esc:String,
    applyStatusClasses(){},renderDetail(){},openPlForm(_pid,i){ctx.edited=i;},curPipelineId:'pl'};
  vm.createContext(ctx);load('/* ---------- 渲染流水线编排 ---------- */','function applyStatusClasses(',ctx);
  return {ctx,flow,checkbox};
}
test('勾选后首位显示清理，取消后移除，普通任务编辑索引不偏移',()=>{
  const {ctx,flow,checkbox}=context();ctx.renderFlow();
  assert.match(flow.children[0].innerHTML,/环境清理/);
  flow.children[2].dblclick();assert.equal(ctx.edited,0);
  checkbox.checked=false;flow.children=[];ctx.renderFlow();
  assert.match(flow.children[0].innerHTML,/First/);
});
test('运行快照和历史清理节点不受当前开关影响',()=>{
  const {ctx,flow,checkbox}=context();checkbox.checked=false;
  ctx.runStages=ctx.activeStages();ctx.curRun={cleanupStage:{id:'__cleanup__',name:'环境清理',cleanup:true}};
  ctx.renderFlow();assert.match(flow.children[0].innerHTML,/环境清理/);
  ctx.curRun=null;ctx.replayRec={logs:[{stage:'环境清理',status:'success'}]};flow.children=[];
  ctx.renderFlow();assert.match(flow.children[0].innerHTML,/环境清理/);
});
test('修改清理配置不能抹掉失败阶段的重试上下文',()=>{
  const {ctx}=context();
  const run={token:1,vars:{KEY:'value'}};
  ctx.curRun=run;ctx.runStages=ctx.activeStages();ctx.nodes={first:{status:'failed',varsIn:{KEY:'value'}}};
  Object.assign(ctx,{localStorage:{setItem(){}},persistState(){},resetNodes(){ctx.nodes={};}});
  load('function saveCleanup(', 'function renderCleanupParams(',ctx);
  ctx.saveCleanup();
  assert.equal(ctx.curRun,run);assert.equal(ctx.nodes.first.status,'failed');
});
test('清理实时回显到独立节点，完成后保留状态与单份归档',async()=>{
  const s={id:'__cleanup__',name:'环境清理',cleanup:true,script:{name:'clean.sh',path:'/tmp/clean.sh'}};
  let complete,uploads=0;
  const ctx={curRun:{token:1,cleanupStage:s},cleanupScript:s.script,nodes:{},running:true,AbortController,
    setInterval,clearInterval,timer:null,selectedId:null,renderFlow(){},renderDetail(){},applyStatusClasses(){},
    archiveFolderFor:()=>'/logs',taskLogFile:()=> 'cleanup.log',archiveTaskLog:async()=>{uploads++;},
    execScript:async(_sc,_timeout,_env,_rc,stream)=>{stream?.({type:'out',text:'live\n'});return new Promise(r=>{complete=r;});}};
  vm.createContext(ctx);load('async function runCleanupBefore(', 'function sanitizeFsName(',ctx);
  const done=ctx.runCleanupBefore();
  try{
    assert.equal(ctx.nodes[s.id]?.status,'running');assert.equal(s._out?.stdout,'live\n');assert.equal(ctx.selectedId,s.id);
  }finally{complete({code:7,stdout:'live\n',stderr:'bad',logFile:'/logs/cleanup.log'});await done;}
  assert.equal(ctx.nodes[s.id].status,'failed');assert.equal(ctx.curRun.cleanupLog.status,'failed');assert.equal(uploads,0);
});
test('清理中止后的迟回不能修改新运行或清掉新计时器',async()=>{
  const s={id:'__cleanup__',name:'环境清理',script:{path:'/tmp/clean.sh'}};
  let complete;
  const ctx={curRun:{token:1,cleanupStage:s},nodes:{},running:true,AbortController,setInterval,clearInterval,timer:null,
    renderFlow(){},renderDetail(){},applyStatusClasses(){},archiveFolderFor:()=>null,
    execScript:async()=>new Promise(r=>{complete=r;})};
  vm.createContext(ctx);load('async function runCleanupBefore(', 'function sanitizeFsName(',ctx);
  const done=ctx.runCleanupBefore(),oldRun=ctx.curRun;
  oldRun.scriptAbort.abort();clearInterval(ctx.timer);
  oldRun.cleanupLog.status='aborted';
  const newRun={token:2};ctx.curRun=newRun;ctx.timer=123;ctx.nodes={other:{status:'running'}};
  complete({code:null,stdout:'partial',stderr:''});await done;
  assert.equal(ctx.curRun,newRun);assert.equal(ctx.timer,123);assert.equal(ctx.nodes.other.status,'running');
  assert.equal(oldRun.cleanupLog.status,'aborted');
});
