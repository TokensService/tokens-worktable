/* 「设置」视图状态与定时环境随服务端配置持久化、运行行临时配置仅本地的契约测试：
   - collectConfig：repositories 保留 pass；携带 schedEnvIds/histFilter/plFilter/histPageSize/plPageSize
     （null 环境多选按空数组上送）；不携带 curPipelineId/selectedEnvIds/curRepoId/branch/strategy/
     cleanupEnabled/checkEnabled/profilingEnabled（运行行临时配置仅本地）；
   - loadServerState：视图状态键存在（含空串/空数组）一律以服务端为准；旧版服务端缺键且启动时
     localStorage 有对应旧值（legacyLocalKeys 快照）→ 保留本地值并 persistState 回推一次（迁移）；
     代码仓服务端 pass 为空而本地有同 id 令牌 → 回填并回推；运行行临时配置不从服务端覆盖；
   - 导入导出：视图状态新键随 config 携带，运行行临时配置只在 local 块（导出→导入 roundtrip）。 */
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
/* vm 上下文产出的对象原型与宿主不同，deepEqual 前做 JSON 往返 */
const J=x=>JSON.parse(JSON.stringify(x));
const LEGACY_ALL={'pip-schedEnvSel':true,'pip-histFilter':true,'pip-plFilter':true,'pip-histPageSize':true,'pip-plPageSize':true};

test('collectConfig：repositories 保留 pass，携带视图状态/定时环境键；运行行临时配置不上送',()=>{
  const els={branchName:{value:'0830_dev'},deployStrategyName:{value:'arch-a'},
    cleanupEnv:{checked:true},checkEnv:{checked:false},profilingEnv:{checked:true}};
  const ctx={
    $:id=>els[id]||null,
    pipelines:[{id:'pl-xds'}], environments:[{id:'env-a',name:'开发',ip:'10.0.0.1',user:'root',pass:'node-pass'}],
    repositories:[{id:'r1',name:'myapp',url:'https://git.example/a.git',user:'u',pass:'git-token'}],
    scriptsDir:'/srv/scripts', themePref:'dark', buildNo:7,
    cleanupScript:null, checkScript:null, profilingScript:null, customPresets:[],
    jenkins:{url:'http://jk'}, evaltok:{url:'http://et',token:'et-token'}, prom:{}, archiveDir:'/a', archiveScriptName:'c.sh',
    analysisPrompts:{}, histClearedAt:0,
    curPipelineId:'pl-xds', curRepoId:'r1',
    selectedEnvIds:['env-a'], schedEnvIds:['env-s1'],
    histFilter:{kw:'err',status:'failed',pipeline:'构建'}, plFilter:{kw:'x',owner:'all',favorite:'favorite'},
    histPageSize:20, plPageSize:50,
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('collectConfig'),ctx);
  const cfg=J(ctx.collectConfig());
  assert.equal(cfg.repositories[0].pass,'git-token','代码仓访问令牌 pass 随服务端持久化（不再剔除）');
  assert.ok(!('curPipelineId' in cfg),'运行行临时配置 curPipelineId 不上送服务端');
  assert.ok(!('curRepoId' in cfg),'运行行临时配置 curRepoId 不上送服务端');
  assert.ok(!('selectedEnvIds' in cfg),'运行行临时配置 selectedEnvIds 不上送服务端');
  assert.ok(!('branch' in cfg),'运行行临时配置 branch 不上送服务端');
  assert.ok(!('strategy' in cfg),'运行行临时配置 strategy 不上送服务端');
  assert.ok(!('cleanupEnabled' in cfg),'运行行预设勾选 cleanupEnabled 不上送服务端');
  assert.ok(!('checkEnabled' in cfg),'运行行预设勾选 checkEnabled 不上送服务端');
  assert.ok(!('profilingEnabled' in cfg),'运行行预设勾选 profilingEnabled 不上送服务端');
  assert.deepEqual(cfg.schedEnvIds,['env-s1'],'定时页环境选择仍随服务端共享');
  assert.deepEqual(cfg.histFilter,{kw:'err',status:'failed',pipeline:'构建'});
  assert.deepEqual(cfg.plFilter,{kw:'x',owner:'all',favorite:'favorite'});
  assert.equal(cfg.histPageSize,20);
  assert.equal(cfg.plPageSize,50);
});

/* ---------- loadServerState：服务端为准 / 旧版迁移 ---------- */
function plXds(){ return {id:'pl-xds',name:'安装部署XDS',builtIn:true,stages:[{id:'s0',name:'检出'}]}; }

function loadStateFixture(serverConfig,opts){
  opts=opts||{};
  const storage=Object.assign({},opts.storage);
  const calls={persist:0,renderAll:0};
  const els={};
  const ctx={
    persistInFlight:null, stateFetchEpoch:0, stateLoaded:false,
    serverConfigBase:opts.base!==undefined?opts.base:null,
    DEFAULT_PIPELINE_ID:'pl-xds',
    defaultPipeline:plXds,
    migrateGate:p=>p, migrateStageUrl:p=>p, migratePrefillDefaults:p=>p, migratePipelineDefaults:p=>p, migratePromPreset:p=>p,
    pipelines:opts.localPipelines||[plXds()],
    environments:[], repositories:opts.localRepos||[],
    scriptsDir:'/srv/scripts', scriptsDirIsFallback:false,
    maybeAdoptInstalledScriptsDir:()=>{},
    themePref:'auto', buildNo:1,
    cleanupScript:null, checkScript:null, profilingScript:null,
    jenkins:{}, evaltok:{}, prom:{}, archiveDir:'', archiveScriptName:'', analysisPrompts:{},
    histClearedAt:0, history:[],
    historyMarkSynced:()=>{},
    curPipelineId:opts.curPipelineId!==undefined?opts.curPipelineId:'pl-xds',
    selectedEnvIds:opts.selectedEnvIds!==undefined?opts.selectedEnvIds:null,
    curRepoId:opts.curRepoId||'',
    schedEnvIds:opts.schedEnvIds!==undefined?opts.schedEnvIds:null,
    histFilter:opts.histFilter||{kw:'',status:'',pipeline:''},
    plFilter:opts.plFilter||{kw:'',owner:'mine',favorite:'all'},
    histPageSize:opts.histPageSize||10, plPageSize:opts.plPageSize||10,
    runStages:null, selectedId:null, nodes:{}, curRun:null,
    legacyLocalKeys:opts.legacy||{},
    $:id=>els[id]||(els[id]={value:'',checked:false,style:{},textContent:'',dataset:{}}),
    renderCleanupParams:()=>{}, renderCheckParams:()=>{}, renderProfilingParams:()=>{},
    renderAll:()=>{ calls.renderAll+=1; }, migrateInlineLogs:()=>{},
    persistState:()=>{ calls.persist+=1; },
    localStorage:{getItem:k=>(k in storage?storage[k]:null),setItem:(k,v)=>{storage[k]=String(v);},removeItem:k=>{delete storage[k];}},
    fetch:async()=>({ok:true,status:200,json:async()=>({config:JSON.parse(JSON.stringify(serverConfig)),history:[]})}),
  };
  vm.createContext(ctx);
  vm.runInContext(['stripPipelineSharedMeta','mergePipelinesFromServer','fetchPipelineStateFresh',
    'normalizeFetchMode','normalizeEnv','normalizeRepo','curPipeline','plOwnerFilterLabel','loadServerState',
  ].map(extractFunction).join('\n'),ctx);
  return {ctx,calls,storage,els};
}

test('loadServerState：视图状态/定时环境以服务端为准；运行行临时配置不被服务端覆盖',async()=>{
  const plB={id:'pl-b',name:'发布流水线',stages:[{id:'sb',name:'构建'}]};
  const f=loadStateFixture({
    pipelines:[plXds(),plB],
    repositories:[{id:'r1',name:'myapp',url:'u',user:'u',pass:'srv-token'}],
    curPipelineId:'pl-b', selectedEnvIds:['env-srv'], curRepoId:'r2', branch:'main', strategy:'',
    schedEnvIds:['env-s1'], histFilter:{kw:'x',status:'failed',pipeline:'P'}, plFilter:{kw:'y',owner:'all',favorite:'favorite'},
    histPageSize:20, plPageSize:50,
  },{
    localPipelines:[plXds(),plB],
    localRepos:[{id:'r1',name:'myapp',url:'u',user:'u',pass:'local-token'}],
    curPipelineId:'pl-xds', selectedEnvIds:['env-l'], curRepoId:'r1',
    schedEnvIds:null,
    histFilter:{kw:'local',status:'',pipeline:''}, plFilter:{kw:'l',owner:'mine',favorite:'all'},
    histPageSize:10, plPageSize:10,
    legacy:Object.assign({},LEGACY_ALL),
  });
  await f.ctx.loadServerState();
  assert.equal(f.ctx.stateLoaded,true,'成功拉到服务端后写入门打开');
  assert.equal(f.ctx.curPipelineId,'pl-xds','运行行临时配置：当前流水线不被服务端覆盖');
  assert.deepEqual(J(f.ctx.selectedEnvIds),['env-l'],'运行行临时配置：环境多选不被服务端覆盖');
  assert.equal(f.ctx.curRepoId,'r1','运行行临时配置：当前代码仓不被服务端覆盖');
  assert.deepEqual(J(f.ctx.schedEnvIds),['env-s1'],'定时环境选择以服务端为准');
  assert.deepEqual(J(f.ctx.histFilter),{kw:'x',status:'failed',pipeline:'P'});
  assert.equal(f.els.histFilterKw.value,'x');
  assert.equal(f.els.histFilterStatus.value,'failed');
  assert.deepEqual(J(f.ctx.plFilter),{kw:'y',owner:'all',favorite:'favorite'});
  assert.equal(f.els.plFilterKw.value,'y');
  assert.equal(f.els.plFilterOwner.value,'全部','拥有者组合框回写显示标签');
  assert.equal(f.els.plFilterFavorite.value,'favorite');
  assert.equal(f.ctx.histPageSize,20);
  assert.equal(f.els.histPageSize.value,'20');
  assert.equal(f.ctx.plPageSize,50);
  assert.equal(f.els.plPageSize.value,'50');
  assert.equal(f.ctx.repositories[0].pass,'srv-token','服务端已有令牌以服务端为准（本地令牌不复活）');
  assert.equal(f.calls.persist,0,'视图状态键齐全：无迁移、不回推');
  assert.equal(f.calls.renderAll,1);
  /* localStorage 离线缓存同步为视图状态的服务端值 */
  assert.deepEqual(J(JSON.parse(f.storage['pip-histFilter'])),{kw:'x',status:'failed',pipeline:'P'});
  assert.deepEqual(J(JSON.parse(f.storage['pip-plFilter'])),{kw:'y',owner:'all',favorite:'favorite'});
  assert.equal(f.storage['pip-plPageSize'],'50');
  assert.equal(f.storage['pip-schedEnvSel'],'["env-s1"]');
});

test('loadServerState 迁移：旧版服务端缺新键而本地有旧值 → 保留本地并回推一次；服务端空令牌 + 本地有令牌 → 回填并回推',async()=>{
  const plB={id:'pl-b',name:'发布流水线',stages:[{id:'sb'}]};
  const f=loadStateFixture({
    pipelines:[plXds(),plB],
    repositories:[{id:'r1',name:'myapp',url:'u',user:'u',pass:''},{id:'r2',name:'tools',url:'v',user:'',pass:''}],
    theme:'dark',
  },{
    localPipelines:[plXds(),plB],
    localRepos:[{id:'r1',name:'myapp',url:'u',user:'u',pass:'local-token'},{id:'r2',name:'tools',url:'v',user:'',pass:''}],
    curPipelineId:'pl-b', selectedEnvIds:['env-l1','env-l2'], curRepoId:'r1',
    schedEnvIds:['env-s'],
    histFilter:{kw:'本地',status:'success',pipeline:'A'}, plFilter:{kw:'q',owner:'alice',favorite:'all'},
    histPageSize:50, plPageSize:20,
    legacy:Object.assign({},LEGACY_ALL),
    storage:{'pip-branch':'feat/local','pip-strategy':'arch-local'},
  });
  /* 分支/部署策略的本地旧值由页面启动时的 IIFE 从 localStorage 回填进输入框（pipeline.html 尾部） */
  f.ctx.$('branchName').value='feat/local';
  f.ctx.$('deployStrategyName').value='arch-local';
  await f.ctx.loadServerState();
  assert.equal(f.ctx.curPipelineId,'pl-b','本地当前流水线保留（服务端无此键）');
  assert.deepEqual(J(f.ctx.selectedEnvIds),['env-l1','env-l2']);
  assert.equal(f.ctx.curRepoId,'r1');
  assert.equal(f.els.branchName.value,'feat/local','分支输入框保留本地旧值');
  assert.equal(f.els.deployStrategyName.value,'arch-local');
  assert.deepEqual(J(f.ctx.schedEnvIds),['env-s']);
  assert.deepEqual(J(f.ctx.histFilter),{kw:'本地',status:'success',pipeline:'A'});
  assert.deepEqual(J(f.ctx.plFilter),{kw:'q',owner:'alice',favorite:'all'});
  assert.equal(f.ctx.histPageSize,50);
  assert.equal(f.ctx.plPageSize,20);
  assert.equal(f.ctx.themePref,'dark','服务端已有的其余键正常以服务端为准');
  const repos=J(f.ctx.repositories);
  assert.equal(repos[0].pass,'local-token','服务端空令牌 + 本地同 id 令牌 → 回填');
  assert.equal(repos[1].pass,'','本地无该 id 令牌：保持空（不标记）');
  assert.equal(f.calls.persist,1,'全部迁移合并为一次 persistState 回推');
  assert.equal(f.calls.renderAll,1);
});

test('loadServerState：旧版服务端缺键且本地也无旧值 → 不回推（不会用默认值覆盖服务端）',async()=>{
  const f=loadStateFixture({
    pipelines:[plXds()],
    repositories:[{id:'r1',name:'a',url:'u',user:'',pass:''}],
  },{ legacy:{}, localRepos:[{id:'r1',name:'a',url:'u',user:'',pass:''}] });
  await f.ctx.loadServerState();
  assert.equal(f.ctx.stateLoaded,true);
  assert.equal(f.calls.persist,0,'本地无旧值可迁移：不回推');
});

test('loadServerState：服务端 curPipelineId 指向已删除流水线 → 保留本地选择且不迁移',async()=>{
  const f=loadStateFixture({ pipelines:[plXds()], curPipelineId:'pl-gone' },{ legacy:{'pip-curPipeline':true} });
  await f.ctx.loadServerState();
  assert.equal(f.ctx.curPipelineId,'pl-xds','服务端值不在合并后的流水线列表中：保留本地');
  assert.equal(f.calls.persist,0,'键存在（只是失效）：按服务端为准处理，不算缺键迁移');
});

test('loadServerState：服务端不可达时不打开写入门、不应用任何新键（stateLoaded 门控不变）',async()=>{
  const f=loadStateFixture(null,{ legacy:Object.assign({},LEGACY_ALL) });
  f.ctx.fetch=async()=>{ throw new Error('network down'); };
  await f.ctx.loadServerState();
  assert.equal(f.ctx.stateLoaded,false,'拉取失败不打开写入门');
  assert.equal(f.calls.persist,0,'服务端不可达：不得用本地默认值覆盖服务端');
  assert.equal(f.calls.renderAll,0);
});

/* ---------- 导入导出：新键随 config 携带（roundtrip）+ 旧版文件兼容 ---------- */
function elStub(){ return {value:'',checked:false,style:{},textContent:'',dataset:{}}; }
function elMapStub(els){ return id=>els[id]||(els[id]=elStub()); }

function exportCtx(){
  const els={branchName:{value:'0830_dev'},deployStrategyName:{value:'arch-a'},
    cleanupEnv:{checked:true},checkEnv:{checked:false},profilingEnv:{checked:false}};
  const ctx={
    $:elMapStub(els),
    pipelines:[{id:'pl-xds',builtIn:true,stages:[{id:'s0'}]},{id:'pl-b',name:'B',stages:[{id:'sb'}]}],
    environments:[{id:'env-a',name:'开发',ip:'10.0.0.1',user:'root',pass:'node-pass'}],
    repositories:[{id:'r1',name:'myapp',url:'https://git.example/a.git',user:'u',pass:'git-token'}],
    scriptsDir:'/srv/scripts', themePref:'dark', buildNo:7,
    cleanupScript:null, checkScript:null, profilingScript:null, customPresets:[],
    jenkins:{}, evaltok:{}, prom:{}, archiveDir:'', archiveScriptName:'', analysisPrompts:{}, histClearedAt:0,
    curPipelineId:'pl-b', curRepoId:'r1',
    selectedEnvIds:['env-a'], schedEnvIds:['env-a'],
    histFilter:{kw:'err',status:'failed',pipeline:'构建'}, plFilter:{kw:'x',owner:'all',favorite:'favorite'},
    histPageSize:20, plPageSize:50,
  };
  vm.createContext(ctx);
  vm.runInContext(['collectConfig','collectSettingsForExport','ioTimestamp','buildSettingsExport'].map(extractFunction).join('\n'),ctx);
  return ctx;
}

function importCtx(overrides){
  const saved=[];
  const els={};
  const store={};
  const ctx=Object.assign({
    DEFAULT_JENKINS:{url:'http://127.0.0.1:28080',linkUrl:'',user:'',token:'',mode:'local'},
    DEFAULT_EVALTOK:{url:'http://1.95.87.43:9000',linkUrl:'',token:'',mode:'local'},
    DEFAULT_PROM:{url:'http://192.168.10.6:25889',linkUrl:'',mode:'local',collectScript:''},
    DEFAULT_PROMPTS:{log:'L',prof:'P',perf:'F'},
    $:elMapStub(els),
    localStorage:{getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}},
    pipelines:[{id:'pl-xds',builtIn:true,stages:[{id:'s0'}]},{id:'pl-b',name:'B',stages:[{id:'sb'}]}],
    environments:[], repositories:[],
    scriptsDir:'/old', scriptsDirIsFallback:false, themePref:'auto', buildNo:1,
    cleanupScript:null, checkScript:null, profilingScript:null, customPresets:[],
    jenkins:{}, evaltok:{}, prom:{}, archiveDir:'', archiveScriptName:'', analysisPrompts:{}, histClearedAt:0,
    curPipelineId:'pl-xds', curRepoId:'', selectedEnvIds:null, schedEnvIds:null,
    histFilter:{kw:'',status:'',pipeline:''}, plFilter:{kw:'',owner:'mine',favorite:'all'},
    histPageSize:10, plPageSize:10,
    viewRc:null, runStages:null, selectedId:null, nodes:{}, curRun:null,
    renderCleanupParams:()=>{}, renderCheckParams:()=>{}, renderProfilingParams:()=>{}, renderAll:()=>{},
    normalizeCustomPresets:v=>v, rebuildPresetNameMap:()=>{}, renderPresetMultiPanel:()=>{}, renderPresetMultiBtn:()=>{}, renderCustomPresetZone:()=>{},
  },overrides||{});
  ['saveEnvs','saveEnvSel','saveRepos','saveRepoSel','saveScriptsDir','saveCleanup','saveCheck','saveProfiling',
   'saveJenkins','saveEvaltok','saveProm','saveArchiveDir','saveArchiveScript','savePrompts',
   'saveSchedEnvSel','saveRunSelLS','saveHistFilter','savePlFilter','saveCustomPresets'].forEach(n=>{ ctx[n]=()=>saved.push(n); });
  vm.createContext(ctx);
  vm.runInContext(['normalizeFetchMode','normalizeEnv','normalizeRepo','curPipeline','syncViewRun','plOwnerFilterLabel','applyImportedSettings'].map(extractFunction).join('\n'),ctx);
  return {ctx,saved,els,store};
}

test('导出设置→导入 roundtrip：视图状态随 config 携带（含 pass 明文），运行行临时配置只在 local 块',()=>{
  const data=J(exportCtx().buildSettingsExport());
  assert.equal(data.kind,'pipeline-settings');
  assert.ok(!('pipelines' in data.config),'设置导出不含流水线');
  assert.equal(data.config.repositories[0].pass,'git-token','config 携带访问令牌明文');
  ['schedEnvIds','histFilter','plFilter','histPageSize','plPageSize'].forEach(k=>{
    assert.ok(k in data.config,`config 应携带视图状态键 ${k}`);
  });
  ['curPipelineId','selectedEnvIds','curRepoId','branch','strategy','cleanupEnabled','checkEnabled','profilingEnabled'].forEach(k=>{
    assert.ok(!(k in data.config),`config 不携带运行行临时配置 ${k}`);
    assert.ok(k in data.local,`local 块携带运行行临时配置 ${k}`);
  });
  assert.deepEqual(data.config.histFilter,{kw:'err',status:'failed',pipeline:'构建'});
  assert.deepEqual(data.config.plFilter,{kw:'x',owner:'all',favorite:'favorite'});
  assert.equal(data.config.histPageSize,20);
  assert.equal(data.config.plPageSize,50);
  assert.deepEqual(J(data.local),{curPipelineId:'pl-b',selectedEnvIds:['env-a'],curRepoId:'r1',schedEnvIds:['env-a'],
    branch:'0830_dev',strategy:'arch-a',histFilter:{kw:'err',status:'failed',pipeline:'构建'},histPageSize:20,
    cleanupEnabled:true,checkEnabled:false,profilingEnabled:false},
    'local 块携带运行行临时配置（向后兼容旧版页面导入）');

  const f=importCtx();
  f.ctx.applyImportedSettings(data.config,data.local);
  assert.equal(f.ctx.curPipelineId,'pl-b');
  assert.deepEqual(J(f.ctx.selectedEnvIds),['env-a']);
  assert.equal(f.ctx.curRepoId,'r1');
  assert.deepEqual(J(f.ctx.schedEnvIds),['env-a']);
  assert.equal(f.els.branchName.value,'0830_dev');
  assert.equal(f.els.deployStrategyName.value,'arch-a');
  assert.equal(f.els.cleanupEnv.checked,true);
  assert.equal(f.els.checkEnv.checked,false);
  assert.equal(f.els.profilingEnv.checked,false);
  assert.deepEqual(J(f.ctx.histFilter),{kw:'err',status:'failed',pipeline:'构建'});
  assert.deepEqual(J(f.ctx.plFilter),{kw:'x',owner:'all',favorite:'favorite'});
  assert.equal(f.els.plFilterOwner.value,'全部');
  assert.equal(f.ctx.histPageSize,20);
  assert.equal(f.ctx.plPageSize,50);
  assert.equal(f.els.plPageSize.value,'50');
  assert.equal(J(f.ctx.repositories)[0].pass,'git-token','代码仓令牌随导入恢复');
  assert.ok(f.saved.includes('savePlFilter'),'导入后统一落盘含流水线筛选');
  assert.equal(f.store['pip-plPageSize'],'50','页大小写入 localStorage 离线缓存');
});

test('导入：config 与 local 同名键冲突时 config 优先；旧版导出文件（键仅在 local）仍可导入',()=>{
  const f=importCtx();
  f.ctx.applyImportedSettings(
    {curPipelineId:'pl-b',branch:'cfg-branch',plFilter:{kw:'cfg',owner:'all',favorite:'all'},plPageSize:100},
    {curPipelineId:'pl-xds',selectedEnvIds:['env-l'],curRepoId:'r-loc',schedEnvIds:['env-l'],branch:'loc-branch',strategy:'loc-strategy',histFilter:{kw:'loc',status:'',pipeline:''},histPageSize:50}
  );
  assert.equal(f.ctx.curPipelineId,'pl-b','config 优先于 local');
  assert.equal(f.els.branchName.value,'cfg-branch','config 的分支优先');
  assert.equal(f.els.deployStrategyName.value,'loc-strategy','config 未含的键回退 local 块');
  assert.deepEqual(J(f.ctx.selectedEnvIds),['env-l']);
  assert.deepEqual(J(f.ctx.histFilter),{kw:'loc',status:'',pipeline:''});
  assert.equal(f.ctx.histPageSize,50);
  assert.deepEqual(J(f.ctx.plFilter),{kw:'cfg',owner:'all',favorite:'all'});
  assert.equal(f.ctx.plPageSize,100);

  /* 旧版文件两处都没有 plFilter/plPageSize：保持当前值（缺省键不覆盖语义） */
  const g=importCtx({plFilter:{kw:'保持',owner:'bob',favorite:'all'},plPageSize:20});
  g.ctx.applyImportedSettings({theme:'dark'},{curPipelineId:'pl-b'});
  assert.deepEqual(J(g.ctx.plFilter),{kw:'保持',owner:'bob',favorite:'all'},'文件未含 plFilter：保持当前值');
  assert.equal(g.ctx.plPageSize,20,'文件未含 plPageSize：保持当前值');
  assert.equal(g.ctx.curPipelineId,'pl-b');
  assert.equal(g.ctx.themePref,'dark');
});
