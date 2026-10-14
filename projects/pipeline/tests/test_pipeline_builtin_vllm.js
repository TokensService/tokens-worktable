/* 内置「部署vLLM（原生P/D）」流水线专项契约测试：
   - VLLM_NATIVE_STAGES 种子形状（7 阶段、脚本绑定、VLLM_ROLE 显式值、超时）；
   - 内置注册表 BUILTIN_PIPELINE_DEFS / builtinPipelineSeed / builtinPipelineSeeds（vLLM 种子默认分支
     v0.30.0.tokens、预设任务默认全不勾选；XDS 种子行为不变）；
   - regroupBuiltinPipelines 多内置重组（存储版优先、缺省补种子、自定义随后、未登记内置丢弃）；
   - builtinSeedOmittable 纯净种子免上送判定（非 admin 首存不触发服务端 builtinCreate 403）；
   - collectConfig 集成：纯净且服务端未持久化的内置种子从全量写中略去；
   - rebindBuiltinScriptPaths 按名回填内置阶段的脚本 path（种子 path 留空 → scripts 目录真实路径）；
   - stageIdFor 内置阶段名 → 固定 id 映射（编辑器重存保持 id 稳定）。 */
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
/* 常量数组/块抽取：从 const NAME 起按方括号/花括号配平到语句结束（数组字面量以 ]; 收尾） */
function extractConstBlock(startMarker, endAfterMarker){
  const start=source.indexOf(startMarker);
  assert.ok(start>=0,`缺少源码块起点 ${startMarker}`);
  const end=source.indexOf(endAfterMarker,start);
  assert.ok(end>=0,`缺少源码块终点 ${endAfterMarker}`);
  return source.slice(start,end+endAfterMarker.length);
}
/* 内置注册表块：DEFAULT_PIPELINE_ID/BUILTIN_VLLM_PIPELINE_ID 常量 + BUILTIN_PIPELINE_DEFS 数组 */
const REGISTRY_BLOCK=extractConstBlock('const DEFAULT_PIPELINE_ID=','BUILTIN_PIPELINE_DEFS=[')
  +source.slice(source.indexOf('BUILTIN_PIPELINE_DEFS=[')+'BUILTIN_PIPELINE_DEFS=['.length, source.indexOf('];',source.indexOf('BUILTIN_PIPELINE_DEFS=['))+1)+';';
const XDS_STAGES_BLOCK=extractConstBlock('const XDS_STAGES = [','];');
const VLLM_STAGES_BLOCK=extractConstBlock('const VLLM_NATIVE_STAGES = [','];');

function makeCtx(overrides){
  const ctx=Object.assign({
    presetDefOf:undefined,   /* normalizePipelineDefaults 的 typeof 守卫回落系统三项白名单 */
    serverConfigBase:null,
    pipelines:[],
    availableScripts:[],
  },overrides||{});
  vm.createContext(ctx);
  vm.runInContext(
    [XDS_STAGES_BLOCK, VLLM_STAGES_BLOCK, REGISTRY_BLOCK].join('\n')+'\n'
    +[
    'pipelineDefaultStringList','normalizePipelineDefaults','pipelineFavoriteUsers','migratePipelineDefaults',
    'stripPipelineSharedMeta','deepEqLoose',
    'builtinPipelineSeed','defaultPipeline','builtinPipelineSeeds','regroupBuiltinPipelines','builtinSeedOmittable',
    'scriptByName','rebindBuiltinScriptPaths','slug','stageIdFor',
  ].map(extractFunction).join('\n'),ctx);
  return ctx;
}
const J=x=>JSON.parse(JSON.stringify(x));

test('VLLM_NATIVE_STAGES 种子形状：7 阶段、脚本绑定、角色显式值',()=>{
  const ctx=makeCtx();
  /* const 声明不挂 vm 全局对象，经 runInContext 读取 */
  const stages=J(vm.runInContext('VLLM_NATIVE_STAGES',ctx));
  assert.equal(stages.length,7);
  assert.deepEqual(stages.map(s=>s.id),['vlcheck','vlprepare','vlprefill','vldecode','vlwait','vlproxy','vlverify']);
  assert.deepEqual(stages.map(s=>s.name),['vLLM环境检查','vLLM节点准备','部署Prefill(PP)','部署Decode(DP)','等待服务就绪','重建PD-Proxy','P/D联调验证']);
  const scripts=stages.map(s=>s.script&&s.script.name);
  assert.deepEqual(scripts,['vllm-native-check.sh','vllm-native-prepare.sh','vllm-native-deploy.sh','vllm-native-deploy.sh','vllm-native-wait.sh','vllm-native-deploy.sh','vllm-native-verify.sh']);
  stages.forEach(s=>{
    assert.equal(s.kind,'shell',`${s.id} 应为 shell 阶段`);
    assert.ok(s.timeout>0,`${s.id} 应有超时`);
    assert.equal(s.script.lang,'sh');
    assert.equal(s.script.path,'','种子脚本 path 留空（由 rebindBuiltinScriptPaths 按名回填）');
  });
  assert.equal(stages[2].script.values.VLLM_ROLE,'prefill');
  assert.equal(stages[3].script.values.VLLM_ROLE,'decode');
  assert.equal(stages[5].script.values.VLLM_ROLE,'proxy');
  /* VLLM_ROLE 参数随种子声明（execScript 只下发 params 表内的显式值）；def 必须为空——
     否则 migratePrefillDefaults 会把「等于默认值的显式值」当预填产物剥掉 */
  stages.filter(s=>s.script.values.VLLM_ROLE).forEach(s=>{
    const p=s.script.params.find(o=>o.key==='VLLM_ROLE');
    assert.ok(p,`${s.id} 缺 VLLM_ROLE 参数声明`);
    assert.equal(p.def,'',`${s.id} 的 VLLM_ROLE 不得带默认值`);
    assert.equal(p.required,true);
  });
});

test('builtinPipelineSeed：vLLM 种子默认分支 v0.30.0.tokens、预设全不勾选；XDS 种子不变',()=>{
  const ctx=makeCtx();
  const vllm=J(ctx.builtinPipelineSeed('pl-vllm-native'));
  assert.equal(vllm.builtIn,true);
  assert.equal(vllm.name,'部署vLLM（原生P/D）');
  assert.equal(vllm.stages.length,7);
  assert.equal(vllm.defaults.branch,'v0.30.0.tokens','vLLM 种子默认分支');
  assert.deepEqual(vllm.defaults.presets,[],'vLLM 种子预设任务默认全不勾选（清理走 vllm-native-cleanup.sh，不套用 XDS cleanup）');
  assert.deepEqual(vllm.defaults.environmentIds,[]);
  const xds=J(ctx.builtinPipelineSeed('pl-xds'));
  assert.equal(xds.defaults.branch,'main','XDS 种子默认分支不变');
  assert.equal(ctx.builtinPipelineSeed('pl-ghost'),null,'未登记 id 返回 null');
  const seeds=J(ctx.builtinPipelineSeeds());
  assert.deepEqual(seeds.map(p=>p.id),['pl-xds','pl-vllm-native'],'注册表顺序即内置排序');
});

test('regroupBuiltinPipelines：空列表补双种子；存储版优先；自定义随后；未登记内置丢弃',()=>{
  const ctx=makeCtx();
  const fromEmpty=J(ctx.regroupBuiltinPipelines([]));
  assert.deepEqual(fromEmpty.map(p=>p.id),['pl-xds','pl-vllm-native'],'空列表 → 双内置种子');
  const storedVllm={id:'pl-vllm-native',name:'管理员改过的vLLM',builtIn:true,stages:[{id:'s1'}],defaults:{branch:'v0.30.0.tokens',presets:[]}};
  const custom={id:'pl-a',name:'自定义',stages:[]};
  const ghost={id:'pl-ghost',name:'未来内置',builtIn:true,stages:[]};
  const out=J(ctx.regroupBuiltinPipelines([custom,storedVllm,ghost]));
  assert.deepEqual(out.map(p=>p.id),['pl-xds','pl-vllm-native','pl-a'],'内置按注册表序置顶，自定义随后');
  assert.equal(out[1].name,'管理员改过的vLLM','存储版（admin 编辑）优先于种子');
  assert.ok(!out.some(p=>p.id==='pl-ghost'),'未登记 id 的 builtIn 条目丢弃（与旧口径一致）');
});

test('builtinSeedOmittable：纯净种子 + 服务端无此 id → 免上送；其余情形照常上送',()=>{
  const ctx=makeCtx();
  const vllmSeed=ctx.builtinPipelineSeed('pl-vllm-native');
  const xdsSeed=ctx.builtinPipelineSeed('pl-xds');
  assert.equal(ctx.builtinSeedOmittable(vllmSeed),true,'纯净 vLLM 种子且服务端无 → 免上送');
  assert.equal(ctx.builtinSeedOmittable(xdsSeed),true,'纯净 XDS 种子且服务端无 → 同样免上送');
  ctx.serverConfigBase={pipelines:[{id:'pl-xds',builtIn:true}]};
  assert.equal(ctx.builtinSeedOmittable(xdsSeed),false,'服务端已有该 id → 照常上送');
  assert.equal(ctx.builtinSeedOmittable(vllmSeed),true,'服务端只有另一条内置 → 本条仍免上送');
  const edited=JSON.parse(JSON.stringify(vllmSeed)); edited.name='管理员编辑版';
  assert.equal(ctx.builtinSeedOmittable(edited),false,'内容偏离种子（admin 编辑）→ 照常上送');
  const favored=JSON.parse(JSON.stringify(vllmSeed)); favored.favoriteUsers=['alice'];
  ctx.serverConfigBase=null;
  assert.equal(ctx.builtinSeedOmittable(favored),true,'收藏等共享元数据不影响纯净度判定');
  const rebound=JSON.parse(JSON.stringify(vllmSeed));
  rebound.stages.forEach(s=>{ if(s.script) s.script.path='/installed/projects/pipeline/scripts/'+s.script.name; });
  assert.equal(ctx.builtinSeedOmittable(rebound),true,'rebind 回填的脚本路径属环境适配，不影响纯净度判定');
  assert.equal(ctx.builtinSeedOmittable({id:'pl-a',name:'自定义',stages:[]}),false,'非内置条目不免上送');
});

test('collectConfig：纯净且未持久化的内置种子从全量写略去，其余条目保留',()=>{
  const ctx=makeCtx();
  Object.assign(ctx,{
    environments:[], repositories:[], scriptsDir:'/srv/scripts', themePref:'auto', buildNo:1,
    cleanupScript:null, checkScript:null, profilingScript:null, customPresets:[],
    jenkins:{}, evaltok:{}, prom:{}, archiveDir:'', archiveScriptName:'', analysisPrompts:{},
    histClearedAt:0, schedEnvIds:[], histFilter:{kw:'',status:'',pipeline:''},
    plFilter:{kw:'',owner:'mine',favorite:'all'}, histPageSize:10, plPageSize:10,
  });
  vm.runInContext(extractFunction('collectConfig'),ctx);
  const xdsSeed=ctx.builtinPipelineSeed('pl-xds');
  const vllmSeed=ctx.builtinPipelineSeed('pl-vllm-native');
  const custom={id:'pl-a',name:'自定义',stages:[]};
  ctx.pipelines=[xdsSeed,vllmSeed,custom];
  ctx.serverConfigBase=null;
  assert.deepEqual(ctx.collectConfig().pipelines.map(p=>p.id),['pl-a'],'服务端无任何内置：两条纯净种子都免上送（自定义条目保留）');
  ctx.serverConfigBase={pipelines:[JSON.parse(JSON.stringify(xdsSeed))]};
  assert.deepEqual(ctx.collectConfig().pipelines.map(p=>p.id),['pl-xds','pl-a'],'服务端已有 XDS：仅 vLLM 纯净种子免上送');
  const editedVllm=JSON.parse(JSON.stringify(vllmSeed)); editedVllm.name='管理员编辑版';
  ctx.pipelines=[xdsSeed,editedVllm,custom]; ctx.serverConfigBase=null;
  assert.deepEqual(ctx.collectConfig().pipelines.map(p=>p.id),['pl-vllm-native','pl-a'],'admin 编辑过的内置照常上送（admin 权限放行创建）');
});

test('rebindBuiltinScriptPaths：内置阶段脚本按名回填当前 scriptsDir 路径',()=>{
  const ctx=makeCtx();
  const vllmSeed=ctx.builtinPipelineSeed('pl-vllm-native');
  ctx.pipelines=[vllmSeed,{id:'pl-a',name:'自定义',stages:[{id:'s1',script:{name:'vllm-native-check.sh',path:'',lang:'sh'}}]}];
  ctx.availableScripts=[
    {name:'vllm-native-check.sh',path:'/installed/projects/pipeline/scripts/vllm-native-check.sh',lang:'sh'},
    {name:'vllm-native-deploy.sh',path:'/installed/projects/pipeline/scripts/vllm-native-deploy.sh',lang:'sh'},
  ];
  ctx.rebindBuiltinScriptPaths();
  assert.equal(ctx.pipelines[0].stages[0].script.path,'/installed/projects/pipeline/scripts/vllm-native-check.sh','内置阶段回填真实路径');
  assert.equal(ctx.pipelines[0].stages[2].script.path,'/installed/projects/pipeline/scripts/vllm-native-deploy.sh');
  assert.equal(ctx.pipelines[0].stages[1].script.path,'','scripts 目录缺失的脚本保持空 path（编辑器照常告警）');
  assert.equal(ctx.pipelines[1].stages[0].script.path,'','自定义流水线不动（其缺脚本路径由编辑器负责）');
  /* 路径迁移修复：内置条目存了旧绝对路径 → 按名对齐新 scriptsDir */
  ctx.pipelines[0].stages[0].script.path='/old/dir/vllm-native-check.sh';
  ctx.rebindBuiltinScriptPaths();
  assert.equal(ctx.pipelines[0].stages[0].script.path,'/installed/projects/pipeline/scripts/vllm-native-check.sh','旧路径按名修复');
});

test('stageIdFor：内置 vLLM 阶段名映射固定 id（编辑器重存 id 稳定）',()=>{
  const ctx=makeCtx();
  assert.equal(ctx.stageIdFor('vLLM环境检查'),'vlcheck');
  assert.equal(ctx.stageIdFor('vLLM节点准备'),'vlprepare');
  assert.equal(ctx.stageIdFor('部署Prefill(PP)'),'vlprefill');
  assert.equal(ctx.stageIdFor('部署Decode(DP)'),'vldecode');
  assert.equal(ctx.stageIdFor('等待服务就绪'),'vlwait');
  assert.equal(ctx.stageIdFor('重建PD-Proxy'),'vlproxy');
  assert.equal(ctx.stageIdFor('P/D联调验证'),'vlverify');
  assert.equal(ctx.stageIdFor('检出'),'checkout','既有映射不变');
});

test('静态契约：rebindBuiltinScriptPaths 挂到 loadScripts / loadServerState / 手动刷新三处',()=>{
  assert.ok(/function loadScripts\(\)[\s\S]{0,800}?rebindBuiltinScriptPaths\(\)/.test(source),'loadScripts 末尾回填内置脚本路径');
  for(const fn of ['loadServerState','applyPipelineRefreshPayload']){
    const body=extractFunction(fn);
    assert.ok(body.includes('rebindBuiltinScriptPaths()'),fn+' 重组后回填内置脚本路径');
  }
});

test('loadPipelines：空存储 → 双内置种子；含存储 → 重组保留自定义',()=>{
  const store={};
  const ctx={
    presetDefOf:undefined,
    localStorage:{getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);}},
  };
  vm.createContext(ctx);
  vm.runInContext(
    [XDS_STAGES_BLOCK, VLLM_STAGES_BLOCK, REGISTRY_BLOCK].join('\n')+'\n'
    +['pipelineDefaultStringList','normalizePipelineDefaults','pipelineFavoriteUsers','migratePipelineDefaults',
    'builtinPipelineSeed','defaultPipeline','builtinPipelineSeeds','regroupBuiltinPipelines',
    'migrateGate','migrateStageUrl','cleanScriptValues','migratePrefillDefaults','migratePromPreset','loadPipelines',
  ].map(extractFunction).join('\n'),ctx);
  const fresh=J(ctx.loadPipelines());
  assert.deepEqual(fresh.map(p=>p.id),['pl-xds','pl-vllm-native'],'空存储 → 双内置种子');
  store['pip-pipelines']=JSON.stringify([{id:'pl-a',name:'自定义',stages:[]}]);
  const loaded=J(ctx.loadPipelines());
  assert.deepEqual(loaded.map(p=>p.id),['pl-xds','pl-vllm-native','pl-a'],'存量存储 → 内置补齐置顶 + 自定义保留');
});
