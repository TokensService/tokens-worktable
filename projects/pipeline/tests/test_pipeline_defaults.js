/* 流水线默认运行参数：旧数据归一化、运行时默认值解析与显式覆盖。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function extractFunction(name){
  const match=new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match,`pipeline.html 缺少函数 ${name}`);
  const bodyStart=source.indexOf('{',match.index);let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    else if(source[i]==='}'&&--depth===0) return source.slice(match.index,i+1);
  }
  throw new Error(`无法提取函数 ${name}`);
}

function loadDefaults(overrides={}){
  const start=source.indexOf('/* ---------- 流水线默认运行参数 ---------- */');
  const end=source.indexOf('/* ---------- 流水线默认运行参数结束 ---------- */',start);
  assert.ok(start>=0&&end>start,'pipeline.html 缺少流水线默认运行参数实现');
  /* currentUsername：执行人只读、固定取登录用户后的唯一读取点；runPipeline 用例统一按 operator 桩 */
  const ctx=Object.assign({Array,Object,String,Set,currentUsername:'operator'},overrides);
  vm.createContext(ctx);
  vm.runInContext(source.slice(start,end),ctx);
  return ctx;
}
const J=value=>JSON.parse(JSON.stringify(value));

test('默认运行参数归一化并过滤重复、空值和未知预设',()=>{
  const ctx=loadDefaults();
  assert.deepEqual(J(ctx.normalizePipelineDefaults(null)),{
    environmentIds:[],repositoryId:'',branch:'main',strategy:'',presets:[],
  });
  assert.deepEqual(J(ctx.normalizePipelineDefaults({
    environmentIds:['env-b',' env-a ','env-b',''],repositoryId:' repo-app ',branch:' release ',strategy:' canary ',
    presets:['profiling','cleanup','profiling','root-shell'],
  })),{
    environmentIds:['env-b','env-a'],repositoryId:'repo-app',branch:'release',strategy:'canary',presets:['profiling','cleanup'],
  });
});

test('列表直接运行采用有效默认值；仅旧流水线缺省时回退首项',()=>{
  const ctx=loadDefaults({
    environments:[{id:'env-a',ip:'10.0.0.1'},{id:'env-b',ip:'10.0.0.2'}],
    repositories:[{id:'repo-a',url:'a.git'},{id:'repo-b',name:'仓库 B',url:'b.git'}],
  });
  const resolved=ctx.pipelineDefaultRunOptions({defaults:{
    environmentIds:['env-b'],repositoryId:'repo-b',branch:'release',strategy:'blue-green',presets:['check'],
  }});
  assert.deepEqual(J(resolved),{
    envs:[{id:'env-b',ip:'10.0.0.2'}],repoId:'repo-b',branch:'release',strategy:'blue-green',presets:['check'],
  });

  const fallback=ctx.pipelineDefaultRunOptions({});
  assert.deepEqual(J(fallback),{
    envs:[{id:'env-a',ip:'10.0.0.1'}],repoId:'repo-a',branch:'main',strategy:'',presets:[],
  });
});

test('列表运行检测失效的默认环境和代码仓，不静默改投首项',()=>{
  const ctx=loadDefaults({
    environments:[{id:'env-a',ip:'10.0.0.1'},{id:'env-b',ip:'10.0.0.2'}],
    repositories:[{id:'repo-a',url:'a.git'},{id:'repo-b',url:'b.git'}],
  });
  assert.match(ctx.pipelineDefaultRunIssue({defaults:{environmentIds:['env-b','missing'],repositoryId:'repo-b'}}),/missing/);
  assert.match(ctx.pipelineDefaultRunIssue({defaults:{environmentIds:['env-b'],repositoryId:'missing-repo'}}),/missing-repo/);
  assert.equal(ctx.pipelineDefaultRunIssue({defaults:{environmentIds:['env-b'],repositoryId:'repo-b'}}),'');
  assert.equal(ctx.pipelineDefaultRunIssue({}),'');
});

test('显式运行参数可以逐项覆盖流水线默认值，包括空策略和空预设',()=>{
  const ctx=loadDefaults({
    environments:[{id:'env-a',ip:'10.0.0.1'},{id:'env-b',ip:'10.0.0.2'}],
    repositories:[{id:'repo-a',url:'a.git'},{id:'repo-b',url:'b.git'}],
  });
  const pipeline={defaults:{environmentIds:['env-b'],repositoryId:'repo-b',branch:'release',strategy:'blue-green',presets:['check']}};
  const explicitEnv={id:'env-a',ip:'10.0.0.1'};
  assert.deepEqual(J(ctx.resolvePipelineRunOptions(pipeline,{
    useDefaults:true,envs:[explicitEnv],repoId:'repo-a',branch:'feature/api',strategy:'',presets:[],by:'alice',
  })),{
    envs:[explicitEnv],repoId:'repo-a',branch:'feature/api',strategy:'',presets:[],by:'alice',
  });
});

test('runPipeline 把列表运行的流水线默认参数完整快照到本次运行',()=>{
  let started=null;
  const pipeline={id:'pipe-b',name:'发布',stages:[{id:'deploy',name:'部署'}],defaults:{
    environmentIds:['env-b'],repositoryId:'repo-b',branch:'release',strategy:'blue-green',presets:['check'],
  }};
  const els={triggeredBy:{value:'operator',focus(){}},repoSel:{value:'repo-a'},branchName:{value:'main'}};
  const ctx=loadDefaults({
    Date,Math,
    environments:[{id:'env-a',ip:'10.0.0.1'},{id:'env-b',ip:'10.0.0.2'}],
    repositories:[{id:'repo-a',url:'a.git'},{id:'repo-b',name:'仓库 B',url:'b.git'}],
  });
  Object.assign(ctx,{
    DEFAULT_IMAGE:'app',QUEUE_CAP:8,queue:[],
    $:id=>els[id],alert(){},findPipeline:id=>id===pipeline.id?pipeline:null,curPipeline:()=>pipeline,curPipelineId:pipeline.id,
    resolveRepo:id=>ctx.repositories.find(repo=>repo.id===id),
    curEnvs:()=>[ctx.environments[0]],curStrategy:()=>'current-strategy',runtimePipelineProm:()=>({enabled:false}),
    conflictsActive:()=>false,machineConflict:()=>false,renderQueue(){},startRun:item=>{started=item;return true;},
  });
  vm.runInContext(extractFunction('runPipeline'),ctx);
  assert.equal(ctx.runPipeline({pipelineId:'pipe-b',useDefaults:true}),true);
  assert.deepEqual(J(started.envs),[{id:'env-b',ip:'10.0.0.2'}]);
  assert.equal(started.repoId,'repo-b');
  assert.equal(started.repoName,'仓库 B');
  assert.equal(started.branch,'release');
  assert.equal(started.strategy,'blue-green');
  assert.deepEqual(J(started.presets),['check']);
});

test('runPipeline 遇到失效默认引用时提示并阻止列表直接运行',()=>{
  let started=false,alerted='';
  const pipeline={id:'pipe-b',name:'发布',stages:[],defaults:{environmentIds:['removed-env'],repositoryId:'repo-b'}};
  const els={triggeredBy:{value:'operator',focus(){}},repoSel:{value:'repo-a'},branchName:{value:'main'}};
  const ctx=loadDefaults({
    Date,Math,
    environments:[{id:'env-a',ip:'10.0.0.1'}],
    repositories:[{id:'repo-a',url:'a.git'},{id:'repo-b',url:'b.git'}],
  });
  Object.assign(ctx,{
    DEFAULT_IMAGE:'app',QUEUE_CAP:8,queue:[],
    $:id=>els[id],alert:msg=>{alerted=msg;},findPipeline:id=>id===pipeline.id?pipeline:null,curPipeline:()=>pipeline,curPipelineId:pipeline.id,
    resolveRepo:id=>ctx.repositories.find(repo=>repo.id===id),
    curEnvs:()=>[ctx.environments[0]],curStrategy:()=>'',runtimePipelineProm:()=>({enabled:false}),
    conflictsActive:()=>false,machineConflict:()=>false,renderQueue(){},startRun:()=>{started=true;},
  });
  vm.runInContext(extractFunction('runPipeline'),ctx);
  assert.equal(ctx.runPipeline({pipelineId:'pipe-b',useDefaults:true}),'invalid-defaults');
  assert.equal(started,false);
  assert.match(alerted,/removed-env/);
});

test('显式环境与代码仓参数可覆盖失效默认引用并继续运行',()=>{
  let started=null,alerted='';
  const pipeline={id:'pipe-b',name:'发布',stages:[],defaults:{environmentIds:['removed-env'],repositoryId:'removed-repo',branch:'release'}};
  const explicitEnv={id:'env-a',ip:'10.0.0.1'};
  const els={triggeredBy:{value:'operator',focus(){}},repoSel:{value:'repo-a'},branchName:{value:'main'}};
  const ctx=loadDefaults({Date,Math,environments:[explicitEnv],repositories:[{id:'repo-a',name:'仓库 A',url:'a.git'}]});
  Object.assign(ctx,{
    DEFAULT_IMAGE:'app',QUEUE_CAP:8,queue:[],
    $:id=>els[id],alert:msg=>{alerted=msg;},findPipeline:id=>id===pipeline.id?pipeline:null,curPipeline:()=>pipeline,curPipelineId:pipeline.id,
    resolveRepo:id=>ctx.repositories.find(repo=>repo.id===id),
    curEnvs:()=>[explicitEnv],curStrategy:()=>'',runtimePipelineProm:()=>({enabled:false}),
    conflictsActive:()=>false,machineConflict:()=>false,renderQueue(){},startRun:item=>{started=item;return true;},
  });
  vm.runInContext(extractFunction('runPipeline'),ctx);
  assert.equal(ctx.runPipeline({pipelineId:'pipe-b',useDefaults:true,envs:[explicitEnv],repoId:'repo-a'}),true);
  assert.equal(alerted,'');
  assert.deepEqual(J(started.envs),[explicitEnv]);
  assert.equal(started.repoId,'repo-a');
  assert.equal(started.repoName,'仓库 A');
  assert.equal(started.branch,'release');
});

test('页面已有 4 条活跃流水线时，无机器冲突的新运行也进入队列',()=>{
  let starts=0;
  const pipeline={id:'pipe-b',name:'发布',stages:[]};
  const env={id:'env-new',ip:'10.0.0.99'};
  const els={triggeredBy:{value:'operator',focus(){}},repoSel:{value:'repo-a'},branchName:{value:'main'}};
  const ctx=loadDefaults({Date,Math,environments:[env],repositories:[{id:'repo-a',name:'仓库 A',url:'a.git'}]});
  Object.assign(ctx,{
    DEFAULT_IMAGE:'app',QUEUE_CAP:8,MAX_ACTIVE_RUNS:4,queue:[],activeRuns:Array.from({length:4},(_,i)=>({id:'r'+i,envs:[{ip:'10.0.0.'+(i+1)}]})),
    $:id=>els[id],alert(){},findPipeline:id=>id===pipeline.id?pipeline:null,curPipeline:()=>pipeline,curPipelineId:pipeline.id,
    resolveRepo:id=>ctx.repositories.find(repo=>repo.id===id),curEnvs:()=>[env],curStrategy:()=>'',runtimePipelineProm:()=>({enabled:false}),
    conflictsActive:()=>false,machineConflict:()=>false,renderQueue(){},startRun:()=>{starts++;return true;},
  });
  vm.runInContext(extractFunction('runPipeline'),ctx);
  assert.equal(ctx.runPipeline({pipelineId:'pipe-b',presets:[]}),'queued');
  assert.equal(starts,0);
  assert.equal(ctx.queue.length,1);
});

test('队列排空在达到 4 个全局槽位后停止，释放槽位后继续启动',()=>{
  const ctx={
    MAX_ACTIVE_RUNS:4,activeRuns:Array.from({length:3},(_,i)=>({id:'r'+i})),queue:[{id:'q1'},{id:'q2'}],
    conflictsActive:()=>false,machineConflict:()=>false,console,
  };
  ctx.startRun=item=>{ ctx.activeRuns.push(item); };
  vm.createContext(ctx); vm.runInContext(extractFunction('drainQueue'),ctx);
  ctx.drainQueue();
  assert.equal(ctx.activeRuns.length,4); assert.equal(ctx.queue.length,1);
  ctx.activeRuns.pop(); ctx.drainQueue();
  assert.equal(ctx.activeRuns.length,4); assert.equal(ctx.queue.length,0);
});

test('编辑器表单完整收集环境、代码仓、分支、策略和预设任务',()=>{
  const presetInputs=[
    {checked:true,getAttribute:()=> 'cleanup'},
    {checked:false,getAttribute:()=> 'check'},
    {checked:true,getAttribute:()=> 'profiling'},
  ];
  const els={
    plDefaultRepo:{value:'repo-b'},plDefaultBranch:{value:' release '},plDefaultStrategy:{value:' blue-green '},
    plDefaultPresets:{querySelectorAll:()=>presetInputs},
  };
  const ctx=loadDefaults({$:id=>els[id],editDefaults:{environmentIds:['env-b','env-a']}});
  assert.equal(typeof ctx.collectPipelineDefaultForm,'function');
  assert.deepEqual(J(ctx.collectPipelineDefaultForm()),{
    environmentIds:['env-b','env-a'],repositoryId:'repo-b',branch:'release',strategy:'blue-green',presets:['cleanup','profiling'],
  });
});

test('编辑器默认配置进入草稿和流水线持久化对象',()=>{
  assert.match(source,/defaults\s*:\s*editDefaults/,'草稿必须保存默认配置');
  assert.match(source,/p\.defaults\s*=\s*defaults/,'编辑已有流水线时必须持久化默认配置');
  assert.match(source,/name\s*,\s*stages\s*,\s*defaults\s*,\s*builtIn:false/,'新建流水线时必须持久化默认配置');
});

test('编辑器移除载入脚本下方旧说明并提供默认环境配置区',()=>{
  assert.ok(!source.includes('阶段名匹配 检出 / 校验 / 审批 / 构建镜像 / 推送镜像 / 部署到 K8s / 健康检查 时显示对应真实日志。'));
  assert.match(source,/默认环境/);
  ['plDefaultEnvMultiBtn','plDefaultRepo','plDefaultBranch','plDefaultStrategy','plDefaultPresets'].forEach(id=>{
    assert.ok(source.includes('id="'+id+'"'),'缺少默认配置控件 '+id);
  });
});
