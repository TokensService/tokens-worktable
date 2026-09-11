const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');
function load(a,b,ctx){ vm.runInContext(source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a))),ctx); }
test('预设任务请求断网不覆盖仍在服务端写入的文件',async()=>{
  let uploads=0;
  const s={id:'__cleanup__',name:'环境清理',preset:true,pkey:'cleanup',script:{name:'cleanup',path:'/tmp/cleanup.sh'}};
  /* 多运行上下文并行重构后：引擎函数显式接收运行上下文 rc（不再读写 curRun/runStages/nodes/selectedId/timer 全局）；
     curRun 仅是视图别名回退（execScript 的 runCtx||curRun），这里不提供以验证被测路径不依赖它。 */
  const rc={id:'r1',stages:[s],nodes:{},selId:null,timer:null,over:false,overall:null,token:1,vars:{},
    env:'',envs:[],image:'',release:null,commit:null,tag:'t1',startTs:Date.now(),by:'tester',source:'test',
    pipelineId:'p1',pipelineName:'P',repoId:null,repoName:null,repoUrl:null,giturl:null,repoUser:null,repoPass:null,
    branch:null,strategy:null,prom:null,archive:null};
  const ctx={scriptsDir:'/tmp',PRESET_DEF:{cleanup:{name:'环境清理',block:false}},
    viewRc:rc,selectedId:null,   // 视图别名：流式回调里 viewRc===rc && selectedId===s.id 才实时刷详情
    runSetSel:(r,id)=>{r.selId=id; if(ctx.viewRc===r) ctx.selectedId=id;},   // 与实现一致：聚焦时同步视图选中
    rcRender(){},rcOverall:(r,txt,cls,color)=>{r.overall={txt:txt,cls:cls,color:color||''};},
    advance(){},finish(){},
    archiveFolderFor:()=>'/logs',taskLogFile:()=> 'cleanup.log',buildLog:()=>['partial'],buildLogParts:()=>['partial'],
    archiveTaskLog:async()=>{uploads++;},fetch:async()=>{throw new Error('disconnected');},
    AbortController,TextDecoder,setInterval,clearInterval,renderDetail(){},console};
  vm.createContext(ctx);load('function createLiveOutputState(', '/* 流式执行：POST',ctx);load('async function execStreaming(', 'function jkJobPath(',ctx);
  load('async function runPresetStep(', '/* ---------- 产物归档',ctx);
  load('function archiveStageLog(', 'function archiveRun(',ctx);
  const result=await ctx.execScript(s.script,0,null,rc,null,null,'/logs/cleanup.log');
  assert.equal(result.logPending,true);
  await ctx.runPresetStep(rc,0);assert.equal(uploads,0);
  assert.equal(rc.timer,null,'收尾应清掉本运行的 rc.timer');
  assert.equal(rc.scriptAbort,null,'收尾应释放本运行的 rc.scriptAbort');
  ctx.fetch=async()=>({json:async()=>({code:0,stdout:'legacy'})});
  s._serverLogPending=false;s._serverLogFile=null;s._logArchived=false;   // 第二次执行：模拟旧插件一次性响应
  await ctx.runPresetStep(rc,0);assert.equal(uploads,1,'旧插件正常响应仍兜底');
});
test('首条事件之前断流仍保留响应头声明的服务端日志归属',async()=>{
  const ctx={TextDecoder,fetch:async()=>new Response(new ReadableStream({start(c){c.error(new Error('disconnected'));}}),{headers:{'x-worktable-log':'server'}})};
  vm.createContext(ctx);load('function createLiveOutputState(', '/* 流式执行：POST',ctx);load('async function execStreaming(', 'async function execScript(',ctx);
  const res=await ctx.execStreaming('/script',[],{},'/tmp',0,()=>{},null,'/logs/stage.log');
  assert.equal(res.code,1);assert.equal(res.logFile,'/logs/stage.log');
});
test('响应头之前断网不假定旧插件，也不允许覆盖在途日志',async()=>{
  const ctx={TextDecoder,fetch:async()=>{throw new Error('disconnected');}};
  vm.createContext(ctx);load('function createLiveOutputState(', '/* 流式执行：POST',ctx);load('async function execStreaming(', 'async function execScript(',ctx);
  const res=await ctx.execStreaming('/script',[],{},'/tmp',0,()=>{},null,'/logs/stage.log');
  assert.equal(res.logPending,true);
});
test('旧插件在输出前解除 pending，中止时仍可归档已有输出',async()=>{
  const events=[],ctx={TextDecoder,fetch:async()=>new Response('{"type":"out","text":"partial"}\n')};
  vm.createContext(ctx);load('function createLiveOutputState(', '/* 流式执行：POST',ctx);load('async function execStreaming(', 'async function execScript(',ctx);
  const res=await ctx.execStreaming('/script',[],{},'/tmp',0,e=>events.push(e),null,'/logs/stage.log');
  assert.equal(events[0].type,'log');assert.equal(events[0].logFile,undefined);
  assert.equal(events[1].text,'partial');assert.equal(res.logPending,undefined);
});
test('服务端日志接管信息逐块传给阶段，结束保留归档路径',async()=>{
  const events=[],ctx={TextDecoder,fetch:async(_url,opts)=>{
    assert.equal(JSON.parse(opts.body).logFile,'/logs/stage.log');
    return new Response('{"type":"log","logFile":"/logs/stage.log"}\n{"type":"out","text":"hello"}\n{"type":"done","code":0,"logFile":"/logs/stage.log"}\n');
  }};
  vm.createContext(ctx);load('function createLiveOutputState(', '/* 流式执行：POST',ctx);load('async function execStreaming(', 'async function execScript(',ctx);
  const res=await ctx.execStreaming('/script',[],{},'/tmp',0,e=>events.push(e),null,'/logs/stage.log');
  assert.equal(res.code,0);assert.equal(res.logFile,'/logs/stage.log');assert.equal(res.stdout,'hello');assert.equal(events[0].type,'log');
});
test('流式执行返回值只保留 stdout/stderr 尾窗',async()=>{
  const chunk='x'.repeat(200*1024);
  const lines=[];
  for(let i=0;i<6;i++) lines.push(JSON.stringify({type:'out',text:chunk}));
  lines.push(JSON.stringify({type:'done',code:0}));
  const ctx={TextDecoder,fetch:async()=>new Response(lines.join('\n')+'\n')};
  vm.createContext(ctx);load('function createLiveOutputState(', '/* 流式执行：POST',ctx);load('async function execStreaming(', 'async function execScript(',ctx);
  const res=await ctx.execStreaming('/script',[],{},'/tmp',0,()=>{},null,null);
  assert.equal(res.code,0);assert.ok(res.stdout.length<=256*1024);assert.equal(res._stdoutTruncated,true);
});
test('完成时写入失败必须撤销早期接管确认',async()=>{
  const ctx={TextDecoder,fetch:async()=>new Response('{"type":"log","logFile":"/logs/stage.log"}\n{"type":"done","code":0,"logError":"disk full"}')};
  vm.createContext(ctx);load('function createLiveOutputState(', '/* 流式执行：POST',ctx);load('async function execStreaming(', 'async function execScript(',ctx);
  const res=await ctx.execStreaming('/script',[],{},'/tmp',0,()=>{},null,'/logs/stage.log');
  assert.equal(res.logFile,undefined);assert.equal(res.logError,'disk full');
});
test('在途和已落盘的服务端日志不被中止/收尾的浏览器归档覆盖',()=>{
  let uploads=0;
  const ctx={curRun:{},nodes:{},archiveFolderFor:()=>'/logs',buildLog:()=>['partial'],buildLogParts:()=>['partial'],archiveTaskLog:()=>{uploads++;return Promise.resolve();}};
  vm.createContext(ctx);load('function archiveStageLog(', 'function archiveRun(',ctx);
  ctx.archiveStageLog({id:'a',name:'A',_serverLogPending:true},1);
  ctx.archiveStageLog({id:'a',name:'A',_serverLogFile:'/logs/a.log'},1);
  assert.equal(uploads,0);
  ctx.archiveStageLog({id:'a',name:'A'},1);assert.equal(uploads,1,'旧插件仍须补写');
});
test('浏览器归档兜底直接传递日志分片，不先构建逐行数组',async()=>{
  const expected=['header\n','x'.repeat(1024*1024),'\n[exit 0]'];let uploaded=null;
  const ctx={curRun:{nodes:{a:{status:'success'}}},nodes:{},archiveFolderFor:()=>'/logs',
    buildLog:()=>{throw new Error('归档路径不应调用逐行 buildLog');},buildLogParts:()=>expected,
    archiveTaskLog:async(_rc,_seq,_name,parts)=>{uploaded=parts;}};
  vm.createContext(ctx);load('function archiveStageLog(', 'function archiveRun(',ctx);
  ctx.archiveStageLog({id:'a',name:'A'},1,ctx.curRun);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(uploaded,expected);
});
