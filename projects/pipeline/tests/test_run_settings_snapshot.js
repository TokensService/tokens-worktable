/* 运行级设置快照（一运行一份副本）：入队/启动时深拷贝脚本目录 / Jenkins / EvalTokens / 普罗 / 归档设置，
   本次运行各阶段只读快照——下一次运行前对设置页的修改不影响已经开跑/排队的流水线；
   阶段定义同样深拷贝，避免编辑流水线嵌套字段渗进在跑副本。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function extractFunction(name){
  const match=new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match,`pipeline.html 缺少函数 ${name}`);
  const bodyStart=source.indexOf('{',match.index);
  let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    if(source[i]==='}'){ depth-=1; if(depth===0) return source.slice(match.index,i+1); }
  }
  throw new Error(`无法提取函数 ${name}`);
}
const J=x=>JSON.parse(JSON.stringify(x));

function settingsCtx(overrides){
  const ctx=Object.assign({
    scriptsDir:'/srv/scripts',
    jenkins:{url:'http://jk',user:'u',token:'t',mode:'local'},
    evaltok:{url:'http://et',token:'et',mode:'local'},
    prom:{url:'http://prom',collectScript:'collect.py',modelName:'m'},
    archiveDir:'/var/log/op_test',
    archiveScriptName:'collect_logs.sh',
  }, overrides||{});
  vm.createContext(ctx);
  for(const fn of ['runSettingsSnapshot','runSettingsOf','runScriptsDir','runJenkinsCfg','runEvaltokCfg','runPromCfg','runArchiveDir','runArchiveScriptName']){
    vm.runInContext(extractFunction(fn),ctx);
  }
  return ctx;
}

test('runSettingsSnapshot：深拷贝全部运行相关设置，改全局不影响已取快照',()=>{
  const ctx=settingsCtx();
  const snap=J(ctx.runSettingsSnapshot());
  assert.equal(snap.scriptsDir,'/srv/scripts');
  assert.deepEqual(snap.jenkins,{url:'http://jk',user:'u',token:'t',mode:'local'});
  assert.equal(snap.evaltok.url,'http://et');
  assert.equal(snap.prom.collectScript,'collect.py');
  assert.equal(snap.archiveDir,'/var/log/op_test');
  assert.equal(snap.archiveScriptName,'collect_logs.sh');
  ctx.scriptsDir='/other'; ctx.jenkins.url='http://jk2'; ctx.prom.collectScript='other.py'; ctx.archiveScriptName='x.sh';
  assert.equal(snap.scriptsDir,'/srv/scripts','快照后改 scriptsDir 不影响副本');
  assert.equal(snap.jenkins.url,'http://jk','快照后改 Jenkins 不影响副本');
  assert.equal(snap.prom.collectScript,'collect.py','快照后改普罗收集脚本不影响副本');
  assert.equal(snap.archiveScriptName,'collect_logs.sh','快照后改归档脚本不影响副本');
});

test('run* 取值优先读 rc.settings 快照，无快照回落当前设置',()=>{
  const ctx=settingsCtx();
  const rc={settings:J(ctx.runSettingsSnapshot())};
  ctx.scriptsDir='/changed'; ctx.jenkins={url:'http://new'}; ctx.evaltok={url:'http://new-et'}; ctx.prom={url:'http://new-prom',collectScript:'n.py'}; ctx.archiveDir='/new'; ctx.archiveScriptName='n.sh';
  assert.equal(ctx.runScriptsDir(rc),'/srv/scripts');
  assert.equal(ctx.runJenkinsCfg(rc).url,'http://jk');
  assert.equal(ctx.runEvaltokCfg(rc).url,'http://et');
  assert.equal(ctx.runPromCfg(rc).collectScript,'collect.py');
  assert.equal(ctx.runArchiveDir(rc),'/var/log/op_test');
  assert.equal(ctx.runArchiveScriptName(rc),'collect_logs.sh');
  /* 无 settings 的运行上下文回落当前设置（历史回放 / 旧队列项） */
  assert.equal(ctx.runScriptsDir({}),'/changed');
  assert.equal(ctx.runJenkinsCfg({}).url,'http://new');
});

test('expandRunStages：普通阶段深拷贝，改流水线定义不影响已展开副本',()=>{
  const ctx={
    customPresets:[],
    withPresetMarkers:s=>s,
    presetOn:()=>false,
    presetRuntime:()=>null,
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('expandRunStages'),ctx);
  const stages=[{id:'s1',name:'构建',script:{name:'build.sh',params:[{key:'A'}],values:{A:'1'}}}];
  const out=ctx.expandRunStages(stages,[]);
  assert.equal(out.length,1);
  assert.notEqual(out[0],stages[0],'展开结果不得与原阶段共享引用');
  assert.notEqual(out[0].script,stages[0].script,'嵌套 script 必须深拷贝');
  stages[0].script.values.A='hacked';
  stages[0].name='改名';
  assert.equal(out[0].script.values.A,'1','编辑原阶段参数不影响运行副本');
  assert.equal(out[0].name,'构建');
});

test('静态契约：入队/启动取 settings 副本，exec/移交按快照执行',()=>{
  assert.match(source,/settings:\s*opts\.settings\s*\|\|\s*\(typeof runSettingsSnapshot===/,'startRun 入队/启动须取设置副本');
  assert.match(source,/settings:c\.settings\s*\|\|\s*\(\(typeof runSettingsSnapshot===/,'startSimRun 须把设置副本写入 rc');
  assert.match(extractFunction('execScript'),/runScriptsDir\(rc\)/,'execScript 的 cwd 取本运行设置快照');
  assert.match(extractFunction('runUrlStep'),/runJenkinsCfg\(rc\)/,'HTTP 阶段 Jenkins 配置取本运行设置快照');
  assert.match(extractFunction('runEvaltokensStep'),/runEvaltokCfg\(rc\)/,'EvalTokens 阶段配置取本运行设置快照');
  assert.match(extractFunction('taskPromCollect'),/runPromCfg\(rc\)/,'任务级普罗采集配置取本运行设置快照');
  assert.match(extractFunction('buildSuffixPlan'),/settings:\s*rc\.settings/,'定时后缀计划须携带设置副本');
  assert.match(extractFunction('buildUnloadHandoffPlan'),/settings:/,'关页移交计划须携带设置副本');
});

test('runPipeline：入队项携带 settings，出队启动沿用入队时副本',()=>{
  const calls={start:[]};
  const ctx={
    currentUsername:'alice',
    curPipelineId:'p1',
    findPipeline:()=>({id:'p1',name:'流水线',stages:[{id:'s1',name:'A'}]}),   // 无 sched=需本地运行，走 startRun 本地路径
    curPipeline:()=>({id:'p1',name:'流水线',stages:[{id:'s1',name:'A'}]}),
    resolvePipelineRunOptions:(pl,opts)=>Object.assign({},opts,{by:'alice'}),
    curEnvs:()=>[{id:'e1',ip:'10.0.0.1'}],
    resolveEnv:e=>e,
    resolveRepo:id=>({id,name:'repo',url:'https://git'}),
    selectedPresetKeys:()=>[],
    curStrategy:()=>'',curWeightsPath:()=>'',
    DEFAULT_IMAGE:'img',
    $:()=>({value:''}),
    scriptsDir:'/snap/scripts',
    jenkins:{url:'http://snap-jk'},
    evaltok:{url:'http://snap-et'},
    prom:{collectScript:'snap.py'},
    archiveDir:'/snap',
    archiveScriptName:'snap.sh',
    pendingLeaseStarts:[],
    MAX_ACTIVE_RUNS:2,
    activeRuns:[],
    queue:[],
    conflictsActive:()=>false,
    machineConflict:()=>false,
    startRun:item=>{ calls.start.push(item); return true; },
    submitServerRun:()=>{},
    renderQueue:()=>{},
    isPendingQueueItem:()=>false,
    focusQueueItem:()=>{},
  };
  vm.createContext(ctx);
  for(const fn of ['runSettingsSnapshot','runSettingsOf','runScriptsDir','runJenkinsCfg','runEvaltokCfg','runPromCfg','runArchiveDir','runArchiveScriptName','runPipeline']){
    vm.runInContext(extractFunction(fn),ctx);
  }
  const r=ctx.runPipeline({pipelineId:'p1'});
  assert.equal(r,true);
  const item=calls.start[0];
  assert.ok(item.settings,'入队/启动项必须带 settings 快照');
  assert.equal(item.settings.scriptsDir,'/snap/scripts');
  assert.equal(item.settings.jenkins.url,'http://snap-jk');
  ctx.scriptsDir='/after'; ctx.jenkins.url='http://after';
  assert.equal(item.settings.scriptsDir,'/snap/scripts','启动后改设置不影响该项快照');
  assert.equal(item.settings.jenkins.url,'http://snap-jk');
});
