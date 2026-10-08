/* 初始化/重拉不再产生自动全量 PUT（修复「每次打开页面都自动 PUT 一次」）：
   触发源是 applyTheme 末尾一次无条件 persistState——它随 renderAll 在首屏初始化（文件尾部
   renderAll()）、loadServerState 成功重渲染、409/403 自愈重拉时被反复调用，400ms 防抖后合成
   一次整表 PUT；本地相对刚应用的服务端快照并无任何实际变化，多人在场时每个访客的这次自动写
   都是潜在 409 冲突源。修复后口径：初始化/重拉路径只在有真实差异时才持久化。
   覆盖：
   a. 服务端非空且本地应用后一致（含 scriptsDir、无待迁移内嵌日志）→ 首屏 renderAll +
      loadServerState 全程零 persistState；
   b. 两个正当写路径不破——服务端 config 为空（本地默认状态迁移上去）仍 persistState；
      内嵌日志迁移确有变更（migrateInlineLogs changed）仍 persistState；
      （脚本目录兜底确实改写走 saveScriptsDir，由 test_scripts_dir_default.js 覆盖）；
   c. 409/403 自愈重拉同口径：再次 loadServerState 同一快照仍零写；
   d. 源码契约：applyTheme 不带写、主题下拉 change 监听器显式持久化、pushState 的 403/409
      自愈块只重拉渲染不再排写。 */
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
    else if(source[i]==='}'&&--depth===0) return source.slice(match.index,i+1);
  }
  throw new Error(`无法提取函数 ${name}`);
}

/* 与服务端完全一致时应有的配置快照（模拟 71 条流水线场景的缩小版：含 scriptsDir，无内嵌日志） */
const SERVER_CONFIG={
  pipelines:[
    {id:'pl-xds',name:'安装部署XDS',builtIn:true,stages:[{id:'s0',name:'检出'}]},
    {id:'p1',name:'发布流水线',stages:[{id:'s1',name:'部署'}]},
  ],
  environments:[{id:'env-a',name:'节点A',ip:'10.0.0.1'}],
  repositories:[{id:'repo-a',name:'仓库A',url:'a.git'}],
  scriptsDir:'/installed/pkg/projects/pipeline/scripts',
  theme:'auto', buildNo:7,
  cleanupEnabled:false, checkEnabled:false, profilingEnabled:false,
  jenkins:{url:'http://127.0.0.1:28080',mode:'local'},
  archiveDir:'/var/log/op_test', archiveScriptName:'collect_logs.sh',
};

/* 把 loadServerState + renderAll + applyTheme + migrateInlineLogs 真实实现装进同一 vm 上下文：
   persistState 用记录桩；迁移/归一化与其余渲染成员按恒等/空桩注入；fetch 按 URL 区分存储接口与
   文件接口（migrateInlineLogs 的 /api/worktable/fs 列目录）。 */
function makeCtx(serverState){
  const calls={persist:0, adoptScriptsDir:0, apiWrite:[]};
  const els={};
  const ctx={
    console, JSON, Object, Array, Number, String, Set, Date, Math,
    $:id=>els[id]||(els[id]={value:'',checked:false}),
    localStorage:{setItem(){},getItem(){return null;}},
    document:{documentElement:{setAttribute(){}}},
    persistState:()=>{ calls.persist+=1; },
    persistTimer:null,
    stateLoaded:false,
    serverConfigBase:null,
    /* loadServerState 的流水线/字段依赖（恒等桩：本组用例不验证迁移行为本身） */
    DEFAULT_PIPELINE_ID:'pl-xds',
    defaultPipeline:()=>({id:'pl-xds',name:'安装部署XDS',builtIn:true,stages:[{id:'s0',name:'检出'}]}),
    migrateGate:p=>p, migrateStageUrl:p=>p, migratePrefillDefaults:p=>p, migratePipelineDefaults:p=>p, migratePromPreset:p=>p,
    normalizeEnv:e=>e, normalizeRepo:r=>r,
    /* 全局状态初值 */
    pipelines:[], environments:[], repositories:[],
    scriptsDir:'/installed/pkg/projects/pipeline/scripts', scriptsDirIsFallback:false,
    themePref:'auto', buildNo:7,
    cleanupScript:null, checkScript:null, profilingScript:null,
    jenkins:{}, evaltok:{}, prom:{},
    archiveDir:'/var/log/op_test', archiveScriptName:'collect_logs.sh',
    analysisPrompts:{}, histClearedAt:0,
    history:[], runStages:null, selectedId:null,
    curPipelineId:'pl-xds', selectedEnvIds:null, curRepoId:'',
    curPipeline:()=>ctx.pipelines.find(p=>p.id===ctx.curPipelineId)||ctx.pipelines[0],
    DEFAULT_JENKINS:{url:'',linkUrl:'',user:'',token:'',mode:'local'},
    DEFAULT_EVALTOK:{}, DEFAULT_PROM:{}, DEFAULT_PROMPTS:{},
    maybeAdoptInstalledScriptsDir:()=>{ calls.adoptScriptsDir+=1; },
    historyMarkSynced:()=>{},
    renderCleanupParams(){}, renderCheckParams(){}, renderProfilingParams(){},
    /* renderAll 成员桩（applyTheme 用真实实现，systemDark 桩定浅色） */
    systemDark:()=>false,
    resetNodes(){}, loadScripts(){}, renderHistory(){}, renderStats(){},
    renderPipelines(){}, renderEnvOptions(){}, renderEnvs(){}, renderRepoOptions(){},
    renderRepos(){}, renderQueue(){}, renderDetail(){}, renderPresetMultiBtn(){},
    fillCfgForm(){}, renderScriptsDirCfg(){}, applyJenkinsForm(){}, applyEvaltokForm(){}, applyPromForm(){},
    /* migrateInlineLogs 依赖 */
    apiWrite:async p=>{ calls.apiWrite.push(p); },
    fetch:async url=>{
      if(String(url).indexOf('/api/worktable/fs')===0) return {ok:true,json:async()=>({entries:[]})};
      return {ok:true,json:async()=>JSON.parse(JSON.stringify(serverState))};
    },
  };
  vm.createContext(ctx);
  ['applyTheme','renderAll','loadServerState','migrateInlineLogs','sanitizeFsName','stripPipelineSharedMeta','mergePipelinesFromServer']
    .forEach(n=>vm.runInContext(extractFunction(n),ctx));
  ctx.__calls=calls;
  return ctx;
}

test('初始化：本地与服务端一致时，首屏 renderAll + loadServerState 全程零 persistState',async()=>{
  const ctx=makeCtx({config:SERVER_CONFIG,history:[]});
  vm.runInContext('renderAll()',ctx);   // 首屏初始化渲染（loadServerState 完成前，文件尾部入口）
  assert.equal(ctx.__calls.persist,0,'首屏渲染不得排写');
  await vm.runInContext('loadServerState()',ctx);
  assert.equal(ctx.stateLoaded,true,'成功拉到服务端响应后写入门打开');
  assert.equal(ctx.__calls.persist,0,'服务端状态应用后不得排写（本地相对服务端无实际变化）');
  assert.equal(ctx.__calls.adoptScriptsDir,0,'服务端已配置 scriptsDir：不走安装默认兜底改写');
  assert.equal(ctx.scriptsDir,SERVER_CONFIG.scriptsDir);
  assert.equal(ctx.pipelines.length,2,'服务端流水线已应用（内置置顶 + 自定义）');
});

test('自愈重拉：409/403 后再次 loadServerState 同一服务端快照仍零 persistState',async()=>{
  const ctx=makeCtx({config:SERVER_CONFIG,history:[]});
  await vm.runInContext('loadServerState()',ctx);
  await vm.runInContext('loadServerState()',ctx);   // pushState/pushPipelineOne 自愈分支的重拉
  assert.equal(ctx.__calls.persist,0,'自愈重拉后不得跟着排一次写');
});

test('正当写路径：服务端 config 为空时仍 persistState（本地默认状态迁移上去）',async()=>{
  const ctx=makeCtx({config:{},history:[]});
  await vm.runInContext('loadServerState()',ctx);
  assert.equal(ctx.stateLoaded,true);
  assert.equal(ctx.__calls.persist,1,'服务端为空：排一次写把本地默认迁移上去');
});

test('正当写路径：内嵌日志迁移确有变更时 persistState 回写引用形态',async()=>{
  const ctx=makeCtx({config:SERVER_CONFIG,history:[]});
  ctx.history=[{tag:'20261008-120000',archive:'/arch/run-1',logs:[{stage:'构建镜像',status:'success',dur:3,log:'line1\nline2'}]}];
  await vm.runInContext('migrateInlineLogs()',ctx);
  assert.equal(ctx.__calls.persist,1,'迁移产生真实变更：回写引用形态');
  assert.deepEqual(ctx.__calls.apiWrite,['/arch/run-1/run-20261008-120000-01-构建镜像.log']);
  assert.equal(ctx.history[0].logs[0].logFile,'/arch/run-1/run-20261008-120000-01-构建镜像.log');
  assert.equal('log' in ctx.history[0].logs[0],false,'内嵌全文已替换为 logFile 引用');
});

test('内嵌日志迁移：无待迁移内嵌（logFile 引用/演示记录）时不写',async()=>{
  const ctx=makeCtx({config:SERVER_CONFIG,history:[]});
  ctx.history=[
    {tag:'t2',archive:'/arch/run-2',logs:[{stage:'部署',status:'success',logFile:'/arch/run-2/run-t2-01-部署.log'}]},
    {demo:true,tag:'t3',archive:'/arch/run-3',logs:[{stage:'构建',log:'演示内嵌不迁移'}]},
  ];
  await vm.runInContext('migrateInlineLogs()',ctx);
  assert.equal(ctx.__calls.persist,0);
  assert.equal(ctx.__calls.apiWrite.length,0);
});

test('源码契约：applyTheme 不带写，主题下拉 change 监听器显式 persistState',()=>{
  const fn=extractFunction('applyTheme');
  assert.ok(!/persistState|savePipelines|pushState/.test(fn),'applyTheme 只应用主题，不得带写服务端');
  assert.match(source,
    /\$\('theme'\)\.addEventListener\('change',\s*e=>\{\s*themePref=e\.target\.value;\s*applyTheme\(\);\s*persistState\(\);/,
    '用户改选主题仍应显式持久化');
});

test('源码契约：pushState 的 403/409 自愈块只重拉渲染，不再排写',()=>{
  const push=extractFunction('pushState');
  for(const marker of ['r.status===403','r.status===409 && !(options&&options.silentConflict)']){
    const idx=push.indexOf(marker);
    assert.ok(idx>0,'pushState 缺少 '+marker+' 分支');
    const block=push.slice(idx,idx+900);
    assert.ok(block.indexOf('loadServerState')>0,marker+' 分支应重拉服务端状态自愈');
    assert.ok(!/persistState\(|savePipelines\(/.test(block),marker+' 自愈重拉后不得再排写');
  }
});
