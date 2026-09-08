const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/pipeline.html','utf8');
function load(a,b,ctx){ vm.runInContext(source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a))),ctx); }
test('预设任务请求断网不覆盖仍在服务端写入的文件',async()=>{
  let uploads=0;
  const s={id:'__cleanup__',name:'环境清理',preset:true,pkey:'cleanup',script:{name:'cleanup',path:'/tmp/cleanup.sh'}};
  const ctx={curRun:{token:1},scriptsDir:'/tmp',PRESET_DEF:{cleanup:{name:'环境清理',block:false}},
    activeStages:()=>[s],advance(){},finish(){},setOverall(){},$:()=>({firstChild:null}),
    archiveFolderFor:()=>'/logs',taskLogFile:()=> 'cleanup.log',buildLog:()=>['partial'],
    archiveTaskLog:async()=>{uploads++;},fetch:async()=>{throw new Error('disconnected');}};
  Object.assign(ctx,{running:true,nodes:{},timer:null,selectedId:null,AbortController,TextDecoder,setInterval,clearInterval,renderFlow(){},renderDetail(){},applyStatusClasses(){}});
  vm.createContext(ctx);load('async function execStreaming(', 'function jkJobPath(',ctx);
  load('async function runPresetStep(', '/* ---------- 产物归档',ctx);
  load('function archiveStageLog(', 'function archiveRun(',ctx);
  const result=await ctx.execScript(s.script,0,null,null,null,null,'/logs/cleanup.log');
  assert.equal(result.logPending,true);
  await ctx.runPresetStep(0);assert.equal(uploads,0);
  ctx.fetch=async()=>({json:async()=>({code:0,stdout:'legacy'})});
  s._serverLogPending=false;s._serverLogFile=null;s._logArchived=false;   // 第二次执行：模拟旧插件一次性响应
  await ctx.runPresetStep(0);assert.equal(uploads,1,'旧插件正常响应仍兜底');
});
test('首条事件之前断流仍保留响应头声明的服务端日志归属',async()=>{
  const ctx={TextDecoder,fetch:async()=>new Response(new ReadableStream({start(c){c.error(new Error('disconnected'));}}),{headers:{'x-worktable-log':'server'}})};
  vm.createContext(ctx);load('async function execStreaming(', 'async function execScript(',ctx);
  const res=await ctx.execStreaming('/script',[],{},'/tmp',0,()=>{},null,'/logs/stage.log');
  assert.equal(res.code,1);assert.equal(res.logFile,'/logs/stage.log');
});
test('响应头之前断网不假定旧插件，也不允许覆盖在途日志',async()=>{
  const ctx={TextDecoder,fetch:async()=>{throw new Error('disconnected');}};
  vm.createContext(ctx);load('async function execStreaming(', 'async function execScript(',ctx);
  const res=await ctx.execStreaming('/script',[],{},'/tmp',0,()=>{},null,'/logs/stage.log');
  assert.equal(res.logPending,true);
});
test('旧插件在输出前解除 pending，中止时仍可归档已有输出',async()=>{
  const events=[],ctx={TextDecoder,fetch:async()=>new Response('{"type":"out","text":"partial"}\n')};
  vm.createContext(ctx);load('async function execStreaming(', 'async function execScript(',ctx);
  const res=await ctx.execStreaming('/script',[],{},'/tmp',0,e=>events.push(e),null,'/logs/stage.log');
  assert.equal(events[0].type,'log');assert.equal(events[0].logFile,undefined);
  assert.equal(events[1].text,'partial');assert.equal(res.logPending,undefined);
});
test('服务端日志接管信息逐块传给阶段，结束保留归档路径',async()=>{
  const events=[],ctx={TextDecoder,fetch:async(_url,opts)=>{
    assert.equal(JSON.parse(opts.body).logFile,'/logs/stage.log');
    return new Response('{"type":"log","logFile":"/logs/stage.log"}\n{"type":"out","text":"hello"}\n{"type":"done","code":0,"logFile":"/logs/stage.log"}\n');
  }};
  vm.createContext(ctx);load('async function execStreaming(', 'async function execScript(',ctx);
  const res=await ctx.execStreaming('/script',[],{},'/tmp',0,e=>events.push(e),null,'/logs/stage.log');
  assert.equal(res.code,0);assert.equal(res.logFile,'/logs/stage.log');assert.equal(res.stdout,'hello');assert.equal(events[0].type,'log');
});
test('完成时写入失败必须撤销早期接管确认',async()=>{
  const ctx={TextDecoder,fetch:async()=>new Response('{"type":"log","logFile":"/logs/stage.log"}\n{"type":"done","code":0,"logError":"disk full"}')};
  vm.createContext(ctx);load('async function execStreaming(', 'async function execScript(',ctx);
  const res=await ctx.execStreaming('/script',[],{},'/tmp',0,()=>{},null,'/logs/stage.log');
  assert.equal(res.logFile,undefined);assert.equal(res.logError,'disk full');
});
test('在途和已落盘的服务端日志不被中止/收尾的浏览器归档覆盖',()=>{
  let uploads=0;
  const ctx={curRun:{},nodes:{},archiveFolderFor:()=>'/logs',buildLog:()=>['partial'],archiveTaskLog:()=>{uploads++;return Promise.resolve();}};
  vm.createContext(ctx);load('function archiveStageLog(', 'function archiveRun(',ctx);
  ctx.archiveStageLog({id:'a',name:'A',_serverLogPending:true},1);
  ctx.archiveStageLog({id:'a',name:'A',_serverLogFile:'/logs/a.log'},1);
  assert.equal(uploads,0);
  ctx.archiveStageLog({id:'a',name:'A'},1);assert.equal(uploads,1,'旧插件仍须补写');
});
