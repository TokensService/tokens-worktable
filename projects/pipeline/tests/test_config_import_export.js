/* 设置 / 流水线导入导出（标题区右上角「导入导出」菜单）的契约测试：
   导出形状（设置剔除流水线并补回代码仓令牌 / 流水线独立导出）、导入归一化与整体恢复语义、坏文件校验 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function extractFunction(name){
  const marker=new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match=marker.exec(source);
  assert.ok(match,`pipeline.html 缺少函数 ${name}`);
  const start=match.index;
  const bodyStart=source.indexOf('{',start);
  let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    if(source[i]==='}'){ depth-=1; if(depth===0) return source.slice(start,i+1); }
  }
  throw new Error(`无法提取函数 ${name}`);
}

function makeCtx(overrides={},names=[]){
  const ctx=Object.assign({
    console, JSON, Object, Array, String, Number, Boolean, Date, Math, RegExp, Error, Promise, Set, Map,
    parseInt, isFinite, URL, Blob,
    DEFAULT_PIPELINE_ID:'pl-xds',
    DEFAULT_JENKINS:{url:'http://127.0.0.1:28080',linkUrl:'',user:'',token:'',mode:'local'},
    DEFAULT_EVALTOK:{url:'http://1.95.87.43:9000',linkUrl:'',token:'',mode:'local'},
    DEFAULT_PROM:{url:'http://192.168.10.6:25889',linkUrl:'',mode:'local',collectScript:''},
    DEFAULT_PROMPTS:{log:'L',prof:'P',perf:'F'},
    defaultPipeline:()=>({id:'pl-xds',name:'安装部署XDS',stages:[{id:'s0',name:'检出'}],builtIn:true}),
  },overrides);
  vm.createContext(ctx);
  if(names.length) vm.runInContext(names.map(extractFunction).join('\n'),ctx);
  return ctx;
}

function elStub(){ return {value:'',checked:false,style:{},textContent:''}; }
function elMapStub(els){ return id=>{ if(!els[id]) els[id]=elStub(); return els[id]; }; }
/* vm 上下文产出的对象原型与宿主不同，deepEqual 前做 JSON 往返 */
const J=x=>JSON.parse(JSON.stringify(x));

test('导出设置：剔除流水线（独立导出）、补回代码仓访问令牌（区别于上送服务端时剔除 pass）',()=>{
  const ctx=makeCtx({
    collectConfig:()=>({pipelines:[{id:'pl-xds'}],repositories:[{id:'r1',name:'a',pass:''}],theme:'dark',cleanupEnabled:true}),
    repositories:[{id:'r1',name:'a',url:'https://git.example.com/a.git',user:'u',pass:'secret-token'}],
  },['collectSettingsForExport']);
  const cfg=ctx.collectSettingsForExport();
  assert.ok(!('pipelines' in cfg),'设置导出不得包含流水线（流水线走独立导出）');
  assert.equal(cfg.repositories[0].pass,'secret-token','导出必须补回仅存本浏览器的代码仓访问令牌');
  assert.equal(cfg.theme,'dark');
  assert.equal(cfg.cleanupEnabled,true);
});

test('导出文件形状：设置带 config+local（含运行选择），流水线带 pipelines 列表',()=>{
  const downloads=[];
  const els={branchName:{value:'0830_dev'},deployStrategyName:{value:'arch-a'},triggeredBy:{value:'lhf'}};
  const shared={
    downloadJson:(name,data)=>downloads.push({name,data}),
    ioTipShow:()=>{},
    $:elMapStub(els),
    repositories:[{id:'r1',pass:'tk'}],
    pipelines:[{id:'pl-xds',builtIn:true,stages:[{id:'s0'}]},{id:'pl-custom',name:'自定义',stages:[{id:'s1'}]}],
    curPipelineId:'pl-custom', selectedEnvIds:['env-dev'], curRepoId:'r1', schedEnvIds:['env-prod'],
    histFilter:{kw:'x',status:'',pipeline:''}, histPageSize:20,
    collectConfig:()=>({pipelines:[{id:'pl-xds'}],repositories:[{id:'r1',pass:''}]}),
  };
  const ctx=makeCtx(shared,['collectSettingsForExport','ioTimestamp','exportSettings','exportPipelines']);
  ctx.exportSettings();
  ctx.exportPipelines();
  assert.equal(downloads.length,2);
  const [s,p]=downloads;
  assert.match(s.name,/^pipeline-settings-\d{8}-\d{6}\.json$/);
  assert.equal(s.data.app,'worktable-pipeline');
  assert.equal(s.data.kind,'pipeline-settings');
  assert.equal(s.data.version,1);
  assert.ok(typeof s.data.exportedAt==='string' && s.data.exportedAt.length>0);
  assert.equal(s.data.config.repositories[0].pass,'tk');
  assert.deepEqual(J(s.data.local),{curPipelineId:'pl-custom',selectedEnvIds:['env-dev'],curRepoId:'r1',schedEnvIds:['env-prod'],branch:'0830_dev',strategy:'arch-a',by:'lhf',histFilter:{kw:'x',status:'',pipeline:''},histPageSize:20});
  assert.match(p.name,/^pipeline-pipelines-\d{8}-\d{6}\.json$/);
  assert.equal(p.data.kind,'pipeline-pipelines');
  assert.equal(p.data.pipelines.length,2);
});

test('导入流水线归一化：内置默认置顶、剔除非法项、执行旧数据迁移；非法列表返回 null',()=>{
  const ctx=makeCtx({},['migrateGate','migrateStageUrl','cleanScriptValues','migratePrefillDefaults','normalizeImportedPipelines']);
  assert.equal(ctx.normalizeImportedPipelines([]),null);
  assert.equal(ctx.normalizeImportedPipelines([{id:'x'}]),null,'没有任何带 stages 的流水线视为非法文件');
  assert.equal(ctx.normalizeImportedPipelines('not-array'),null);
  const out=ctx.normalizeImportedPipelines([
    {id:'pl-a',name:'A',stages:[{id:'s1',name:'构建',kind:'url',jenkins:{job:'http://jk/job/a'}},{id:'s2',name:'审批',gate:true}]},
    {id:'pl-xds',name:'安装部署XDS',builtIn:true,stages:[{id:'s0',name:'检出'}]},
    null,
  ]);
  assert.equal(out.length,2,'null 项被剔除');
  assert.equal(out[0].id,'pl-xds','内置流水线置顶');
  assert.equal(out[1].stages[0].kind,'http','旧 url 阶段迁移为 http');
  assert.equal(out[1].stages[0].url.url,'http://jk/job/a','旧 jenkins.job 迁入 url.url');
  assert.equal(out[1].stages[1].skip,true,'旧 gate 迁移为 skip');
  assert.ok(!('gate' in out[1].stages[1]));
  /* 文件缺内置流水线时补默认内置 */
  const noBuiltin=ctx.normalizeImportedPipelines([{id:'pl-a',name:'A',stages:[{id:'s1'}]}]);
  assert.equal(noBuiltin[0].id,'pl-xds');
  assert.equal(noBuiltin[0].builtIn,true);
});

test('导入设置：按文件整体恢复（含令牌），缺省键保持当前值，统一落盘并重渲染',()=>{
  const els={};
  const saved=[],rendered=[];
  const store={};
  const ctx=makeCtx({
    $:elMapStub(els),
    localStorage:{getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}},
    pipelines:[{id:'pl-xds',builtIn:true,stages:[{id:'s0'}]},{id:'pl-custom',name:'自定义',stages:[{id:'s9'}]}],
    environments:[{id:'env-old',name:'旧',ip:'1.1.1.1',user:'root',pass:'old'}],
    repositories:[{id:'r-old',name:'old',url:'',user:'',pass:'old-pass'}],
    scriptsDir:'/old/scripts', themePref:'auto', buildNo:47,
    cleanupScript:{name:'old.sh'}, checkScript:null, profilingScript:null,
    jenkins:{url:'http://old-jk',linkUrl:'',user:'',token:'',mode:'local'},
    evaltok:{url:'http://old-et',linkUrl:'',token:'old-et-token',mode:'local'},
    prom:{url:'http://old-pm',linkUrl:'',mode:'local',collectScript:''},
    archiveDir:'/old/archive', archiveScriptName:'old_collect.sh',
    analysisPrompts:{log:'oldL',prof:'oldP',perf:'oldF'}, histClearedAt:0,
    curPipelineId:'pl-xds', selectedEnvIds:null, curRepoId:'r-old', schedEnvIds:null,
    histFilter:{kw:'',status:'',pipeline:''}, histPageSize:10,
    viewRc:{stages:[{id:'s0'}],nodes:{},selId:'s0',token:'t0',over:false,vars:{},timer:null}, runStages:null, selectedId:'s0',
    curPipeline:function(){ return this.pipelines.find(p=>p.id===this.curPipelineId)||this.pipelines[0]; },
  },['normalizeFetchMode','normalizeEnv','normalizeRepo','syncViewRun','applyImportedSettings']);
  ['saveEnvs','saveEnvSel','saveRepos','saveRepoSel','saveScriptsDir','saveCleanup','saveCheck','saveProfiling','savePromCollectPreset','saveJenkins','saveEvaltok','saveProm','saveArchiveDir','saveArchiveScript','savePrompts','saveSchedEnvSel','saveRunSelLS','saveHistFilter'].forEach(n=>{ ctx[n]=()=>saved.push(n); });
  ['renderCleanupParams','renderCheckParams','renderProfilingParams','renderAll'].forEach(n=>{ ctx[n]=()=>rendered.push(n); });
  vm.runInContext('curPipeline=function(){ return pipelines.find(p=>p.id===curPipelineId)||pipelines[0]; };',ctx);

  ctx.applyImportedSettings({
    environments:[{id:'env-dev',name:'开发',ip:'192.168.1.10',user:'root',pass:'new-pass',extra:'drop'}],
    repositories:[{id:'r1',name:'myapp',url:'https://git.example.com/a.git',user:'u',pass:'new-token',fetchMode:'jenkins'}],
    scriptsDir:'/new/scripts', theme:'dark', buildNo:99,
    cleanupScript:null, cleanupEnabled:true, checkScript:{name:'check.sh',params:[]}, checkEnabled:true,
    profilingEnabled:true, promCollectEnabled:true,
    jenkins:{url:'http://new-jk',token:'jk-token',mode:'remote'},
    evaltok:{url:'http://new-et',token:'et-token',mode:'remote'},
    prom:{url:'http://new-pm',collectScript:'collect.py'},
    archiveDir:'/new/archive', archiveScriptName:'collect_logs.sh',
    analysisPrompts:{log:'newL'}, histClearedAt:123,
  },{
    curPipelineId:'pl-custom', selectedEnvIds:['env-dev'], curRepoId:'r1', schedEnvIds:['env-dev'],
    branch:'main', strategy:'arch-b', by:'alice',
    histFilter:{kw:'err',status:'fail',pipeline:'A'}, histPageSize:50,
  });

  assert.deepEqual(J(ctx.environments),[{id:'env-dev',name:'开发',ip:'192.168.1.10',user:'root',pass:'new-pass'}],'环境按文件恢复并归一化（多余字段剔除）');
  assert.equal(ctx.repositories[0].pass,'new-token','代码仓访问令牌按文件内容恢复');
  assert.equal(ctx.repositories[0].fetchMode,'jenkins-browser','fetchMode 归一化（旧 jenkins 值→jenkins-browser）');
  assert.equal(ctx.scriptsDir,'/new/scripts');
  assert.equal(ctx.themePref,'dark');
  assert.equal(els.theme.value,'dark','主题下拉同步回填');
  assert.equal(ctx.buildNo,99);
  assert.equal(ctx.cleanupScript,null,'文件里 cleanupScript 为 null 时同样恢复（清空）');
  assert.equal(ctx.checkScript.name,'check.sh');
  assert.equal(els.cleanupEnv.checked,true);
  assert.equal(els.checkEnv.checked,true);
  assert.equal(els.profilingEnv.checked,true);
  assert.equal(els.promCollectEnv.checked,true);
  assert.deepEqual(J(ctx.jenkins),{url:'http://new-jk',linkUrl:'',user:'',token:'jk-token',mode:'remote'},'Jenkins 配置与默认值合并');
  assert.deepEqual(J(ctx.evaltok),{url:'http://new-et',linkUrl:'',token:'et-token',mode:'remote'});
  assert.deepEqual(J(ctx.prom),{url:'http://new-pm',linkUrl:'',mode:'local',collectScript:'collect.py'});
  assert.equal(ctx.archiveDir,'/new/archive');
  assert.deepEqual(J(ctx.analysisPrompts),{log:'newL',prof:'P',perf:'F'},'提示词与内置默认值合并（文件缺省键回落默认，与 loadServerState 一致）');
  assert.equal(ctx.histClearedAt,123);
  assert.equal(ctx.curPipelineId,'pl-custom');
  assert.equal(ctx.viewRc,null,'切换当前流水线后清空编排区运行视图绑定（旧 runStages 单例重置的新形态）');
  assert.equal(ctx.selectedId,'s9','切换当前流水线后选中阶段重置（viewRc 为空时 syncViewRun 回落当前流水线首阶段）');
  assert.deepEqual(J(ctx.selectedEnvIds),['env-dev']);
  assert.equal(ctx.curRepoId,'r1');
  assert.deepEqual(J(ctx.schedEnvIds),['env-dev']);
  assert.equal(els.branchName.value,'main');
  assert.equal(els.deployStrategyName.value,'arch-b');
  assert.equal(els.triggeredBy.value,'alice');
  assert.deepEqual(J(ctx.histFilter),{kw:'err',status:'fail',pipeline:'A'});
  assert.equal(els.histFilterKw.value,'err');
  assert.equal(ctx.histPageSize,50);
  assert.equal(els.histPageSize.value,'50');
  ['saveEnvs','saveEnvSel','saveRepos','saveRepoSel','saveScriptsDir','saveCleanup','saveCheck','saveProfiling','savePromCollectPreset','saveJenkins','saveEvaltok','saveProm','saveArchiveDir','saveArchiveScript','savePrompts','saveSchedEnvSel','saveRunSelLS','saveHistFilter'].forEach(n=>{
    assert.ok(saved.includes(n),`导入后必须调用 ${n} 落盘`);
  });
  ['renderCleanupParams','renderCheckParams','renderProfilingParams','renderAll'].forEach(n=>{
    assert.ok(rendered.includes(n),`导入后必须调用 ${n} 重渲染`);
  });
  assert.equal(store['pip-theme'],'dark','主题写入 localStorage');
  assert.equal(store['pip-curPipeline'],'pl-custom');
  assert.equal(store['pip-histPageSize'],'50');

  /* 缺省键保持当前值 + 非法 curPipelineId 不生效 */
  const before=JSON.parse(JSON.stringify({envs:ctx.environments,repos:ctx.repositories,theme:ctx.themePref}));
  ctx.applyImportedSettings({theme:'light'},{curPipelineId:'pl-not-exists',selectedEnvIds:[]});
  assert.deepEqual(J(ctx.environments),before.envs,'文件未含的键保持当前值');
  assert.deepEqual(J(ctx.repositories),before.repos);
  assert.equal(ctx.themePref,'light');
  assert.equal(ctx.curPipelineId,'pl-custom','文件里的当前流水线不存在时保持原选择');
  assert.equal(ctx.selectedEnvIds,null,'空环境多选恢复为 null（跟随默认首节点）');
});

test('导入文件校验：坏 JSON / 非本页导出 / kind 不符时提示且不触碰配置',async()=>{
  const tips=[],applied=[];
  const ctx=makeCtx({
    ioTipShow:(msg,bad)=>tips.push({msg,bad}),
    confirm:()=>{ throw new Error('校验失败不得走到 confirm'); },
    stateLoaded:true,
    loadServerState:async()=>{ throw new Error('校验失败不得加载服务端'); },
    applyImportedSettings:()=>applied.push(1),
    normalizeImportedPipelines:()=>{ throw new Error('kind 不符不得进入归一化'); },
  },['importSettingsFile','importPipelinesFile']);
  const file=obj=>({text:async()=>typeof obj==='string'?obj:JSON.stringify(obj)});
  await ctx.importSettingsFile(file('not-json'));
  await ctx.importSettingsFile(file({app:'other',kind:'pipeline-settings',config:{}}));
  await ctx.importSettingsFile(file({app:'worktable-pipeline',kind:'pipeline-pipelines',pipelines:[]}));
  await ctx.importSettingsFile(file({app:'worktable-pipeline',kind:'pipeline-settings',config:'junk'}));
  await ctx.importPipelinesFile(file('{bad'));
  await ctx.importPipelinesFile(file({app:'worktable-pipeline',kind:'pipeline-settings',config:{}}));
  assert.equal(tips.length,6);
  tips.forEach(t=>assert.equal(t.bad,true));
  assert.equal(applied.length,0);
});

test('导入流水线成功路径：覆盖流水线列表、修正当前选择、落盘重渲染',async()=>{
  const store={},saved=[],rendered=[];
  const ctx=makeCtx({
    ioTipShow:()=>{},
    confirm:()=>true,
    stateLoaded:true,
    loadServerState:async()=>{ throw new Error('stateLoaded 后不得再加载'); },
    localStorage:{getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}},
    pipelines:[{id:'pl-xds',builtIn:true,stages:[{id:'s0'}]}],
    curPipelineId:'pl-gone',
    viewRc:{stages:[{id:'s9'}],nodes:{},selId:'s9',token:'t9',over:false,vars:{},timer:null}, runStages:null, selectedId:'s9',
    savePipelines:()=>saved.push('savePipelines'),
    renderAll:()=>rendered.push('renderAll'),
  },['migrateGate','migrateStageUrl','cleanScriptValues','migratePrefillDefaults','normalizeImportedPipelines','syncViewRun','importPipelinesFile']);
  vm.runInContext('curPipeline=function(){ return pipelines.find(p=>p.id===curPipelineId)||pipelines[0]; };',ctx);
  const data={app:'worktable-pipeline',kind:'pipeline-pipelines',version:1,pipelines:[
    {id:'pl-xds',name:'安装部署XDS',builtIn:true,stages:[{id:'s0'}]},
    {id:'pl-new',name:'新流水线',stages:[{id:'s7'}]},
  ]};
  await ctx.importPipelinesFile({text:async()=>JSON.stringify(data)});
  assert.equal(ctx.pipelines.length,2);
  assert.equal(ctx.pipelines[1].id,'pl-new');
  assert.equal(ctx.curPipelineId,'pl-xds','当前流水线不在导入列表中回退到首条');
  assert.equal(ctx.viewRc,null,'导入覆盖流水线后清空编排区运行视图绑定');
  assert.equal(ctx.selectedId,'s0','选中阶段随视图重绑回落到新当前流水线首阶段');
  assert.ok(saved.includes('savePipelines'));
  assert.ok(rendered.includes('renderAll'));
  assert.equal(store['pip-curPipeline'],'pl-xds');
});

test('页面存在右上角导入导出菜单与全部入口元素',()=>{
  ['ioMenu','ioMenuBtn','ioMenuPanel','ioTip','ioExpSettings','ioImpSettings','ioExpPipelines','ioImpPipelines','ioImpSettingsFile','ioImpPipelinesFile'].forEach(id=>{
    assert.ok(source.includes(`id="${id}"`),`pipeline.html 缺少元素 #${id}`);
  });
  const navIdx=source.indexOf('id="navMain"');
  const menuIdx=source.indexOf('id="ioMenu"');
  assert.ok(menuIdx>0 && menuIdx<navIdx,'导入导出菜单应在标题区（页面导航之前，即右上角）');
});
