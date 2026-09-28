/* 流水线归属编辑限制：仅创建者可编辑/删除（admin 无例外），他人只读可「复制」为副本；
   未署名存量全员可编辑（保存时补署创建者）；auth 探测在途对署名流水线保守只读，
   探测完成仍无登录用户（token 共享模式/未装认证插件/探测失败）退化为全权。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function extractFunction(name){
  const match=new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match,`pipeline.html 缺少函数 ${name}`);
  const bodyStart=source.indexOf('{',match.index);let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    else if(source[i]==='}'&&--depth===0) return source.slice(match.index,i+1);
  }
  throw new Error(`无法提取函数 ${name}`);
}

/* plEditable 提取运行（真实 plOwnerOf 一并提取）：按需注入 currentUsername/authReady/currentUserIsAdmin */
function loadPlEditable(globals){
  const ctx=Object.assign({String},globals||{});
  vm.createContext(ctx);
  vm.runInContext(extractFunction('plOwnerOf')+'\n'+extractFunction('plEditable'),ctx);
  return ctx;
}

test('plEditable：内置视同可信（非 admin 只读）；未署名存量全员可编辑',()=>{
  const ctx=loadPlEditable({currentUsername:'alice',authReady:true});
  assert.equal(ctx.plEditable(null),false,'无流水线对象安全返回只读');
  assert.equal(ctx.plEditable({id:'p0',builtIn:true,createdBy:'alice'}),false,'内置流水线视同可信：无 admin 标记时按非 admin 只读');
  assert.equal(ctx.plEditable({id:'p1'}),true,'未署名存量全员可编辑（保存时补署创建者）');
  assert.equal(ctx.plEditable({id:'p2',createdBy:'  '}),true,'空白署名按未署名处理');
});

test('plEditable：仅创建者本人可编辑；admin 编辑他人流水线同样受限',()=>{
  const mine=loadPlEditable({currentUsername:'alice',authReady:true});
  assert.equal(mine.plEditable({id:'p1',createdBy:'alice'}),true,'本人创建可编辑');
  assert.equal(mine.plEditable({id:'p2',createdBy:'bob'}),false,'他人创建只读');
  const admin=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:true});
  assert.equal(admin.plEditable({id:'p3',createdBy:'bob'}),false,'admin 无例外：同样只能编辑自己创建的流水线');
});

test('plEditable：无登录用户时按 authReady 区分——探测在途保守只读，探测完成（token 模式）退化全权',()=>{
  const pending=loadPlEditable({currentUsername:'',authReady:false});
  assert.equal(pending.plEditable({id:'p1',createdBy:'bob'}),false,'auth 探测在途：署名流水线保守只读');
  assert.equal(pending.plEditable({id:'p2'}),true,'auth 探测在途：未署名流水线仍可编辑');
  const token=loadPlEditable({currentUsername:'',authReady:true});
  assert.equal(token.plEditable({id:'p3',createdBy:'bob'}),true,'探测完成仍无用户（token 模式/探测失败）：退化为全权');
});

test('plEditable：测试桩全局缺失（无 currentUsername/authReady）时退化为全权',()=>{
  const ctx=loadPlEditable();
  assert.equal(ctx.plEditable({id:'p1',builtIn:true}),true,'内置流水线视同可信：守卫缺失时按 token 模式退化全权');
  assert.equal(ctx.plEditable({id:'p2',createdBy:'bob'}),true,'守卫缺失时保持全权，不误伤旧测试桩');
});

/* openPlForm 的依赖较多，这里按职责打桩（同 test_pipeline_readonly.js）：
   只关心只读标志、标题、草稿恢复与只读应用；plEditable/plOwnerOf 用真实实现 */
function loadOpenPlForm({pipeline,draft,username,authReady:ready,stateLoaded=true}){
  const calls={applyRO:0,renderEditor:0,renderDefaults:0,focus:0,alerts:[]};
  const els={
    plForm:{style:{},dataset:{}},
    plFormTitle:{textContent:''},
    scriptsDir:{value:''},
    plName:{value:'',focus(){calls.focus+=1;}},
  };
  const ctx={
    Object,Array,Promise,String,
    stateLoaded,
    currentUsername:username||'',
    authReady:ready!==false,
    alert:message=>calls.alerts.push(String(message)),
    editFocusIdx:-1,editSelStage:null,editStages:[],editDefaults:null,plFormReadOnly:false,
    scriptsDir:'/srv/scripts',
    $:id=>els[id]||null,
    findPipeline:id=>(pipeline&&pipeline.id===id)?pipeline:null,
    curPipeline:()=>pipeline||null,
    normalizePipelineDefaults:d=>Object.assign({},d),
    normalizeStageKind:s=>s,
    evaltokensStageConfig:et=>Object.assign({},et),
    normalizePipelineProm:p=>p||{},
    currentPipelineDefaultSeed:()=>({}),
    newStage:name=>({id:'',name}),
    withPresetMarkers:stages=>stages,
    loadPlDraft:()=>draft||null,
    renderPipelineDefaultForm:()=>{calls.renderDefaults+=1;},
    loadScripts:()=>({then(cb){cb();}}),
    renderStageEditor:()=>{calls.renderEditor+=1;},
    detectStageParams:()=>null,
    detectEvaltokStageParams:()=>null,
    applyPlFormReadOnly:()=>{calls.applyRO+=1;},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('plOwnerOf')+'\n'+extractFunction('plEditable')+'\n'+extractFunction('openPlForm'),ctx);
  return {ctx,els,calls};
}

const MINE={id:'pl-mine',name:'我的流水线',createdBy:'alice',updatedBy:'alice',defaults:{branch:'main'},stages:[{id:'s1',name:'部署'}]};
const OTHERS={id:'pl-bob',name:'他人流水线',createdBy:'bob',updatedBy:'bob',defaults:{branch:'main'},stages:[{id:'s1',name:'构建'}]};

test('他人创建的流水线打开为只读查看：标志置位、标题标注创建者、不恢复草稿、不抢焦点',()=>{
  const draft={editId:'pl-bob',stages:[{id:'d1',name:'草稿改动'}],name:'草稿名',scriptsDir:'/draft',defaults:{branch:'dev'}};
  const {ctx,els,calls}=loadOpenPlForm({pipeline:OTHERS,draft,username:'alice'});
  ctx.openPlForm('pl-bob');
  assert.equal(ctx.plFormReadOnly,true,'他人创建的流水线必须进入只读模式');
  assert.match(els.plFormTitle.textContent,/查看流水线（创建者 @bob·只读）：他人流水线/);
  assert.equal(els.plName.value,'他人流水线','只读查看展示定义真值，不恢复草稿名');
  assert.equal(els.scriptsDir.value,'/srv/scripts','只读查看不恢复草稿脚本目录');
  assert.deepEqual(ctx.editStages.map(s=>s.name),['构建'],'阶段列表来自流水线定义而非草稿');
  assert.equal(calls.applyRO,1,'openPlForm 须应用一次只读');
  assert.equal(calls.focus,0,'只读模式不聚焦名称输入框');
});

test('本人创建的流水线保持可编辑：标题为编辑、草稿照常恢复、聚焦名称框',()=>{
  const draft={editId:'pl-mine',stages:[{id:'d1',name:'草稿阶段'}],name:'草稿名',scriptsDir:'/draft',defaults:{branch:'dev'}};
  const {ctx,els,calls}=loadOpenPlForm({pipeline:MINE,draft,username:'alice'});
  ctx.openPlForm('pl-mine');
  assert.equal(ctx.plFormReadOnly,false,'本人创建的流水线不得进入只读模式');
  assert.match(els.plFormTitle.textContent,/编辑流水线：我的流水线/);
  assert.equal(els.plName.value,'草稿名','草稿照常恢复');
  assert.equal(els.scriptsDir.value,'/draft');
  assert.deepEqual(ctx.editStages.map(s=>s.name),['草稿阶段']);
  assert.equal(calls.focus,1);
});

test('auth 探测在途时打开他人署名流水线同样只读（保守，探测结束重绘后由身份决定）',()=>{
  const {ctx,els,calls}=loadOpenPlForm({pipeline:OTHERS,username:'',authReady:false});
  ctx.openPlForm('pl-bob');
  assert.equal(ctx.plFormReadOnly,true);
  assert.match(els.plFormTitle.textContent,/查看流水线（创建者 @bob·只读）：他人流水线/);
  assert.equal(calls.focus,0);
});

test('savePlForm 兜底：他人创建的流水线被拦截，定义不被改写',async()=>{
  const pipeline={id:'pl-bob',name:'他人流水线',builtIn:false,createdBy:'bob',updatedBy:'bob',stages:[{id:'s1',name:'构建'}]};
  const before=JSON.parse(JSON.stringify(pipeline));
  const alerts=[];
  const ctx={
    Object,Array,Promise,String,JSON,
    currentUsername:'alice',authReady:true,
    $:id=>({plForm:{dataset:{editId:'pl-bob'}},plName:{value:'改写名'}}[id]||null),
    findPipeline:id=>(id==='pl-bob'?pipeline:null),
    alert:msg=>alerts.push(String(msg)),
    editStages:[{id:'s2',name:'篡改阶段'}],
    savePipelines:()=>{ throw new Error('被拦截时不得走到落盘'); },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('plOwnerOf')+'\n'+extractFunction('plEditable')+'\n'+extractFunction('savePlForm'),ctx);
  await ctx.savePlForm();
  assert.equal(alerts.length,1);
  assert.match(alerts[0],/由 @bob 创建，仅创建者可编辑保存/);
  assert.match(alerts[0],/复制.*副本/,'提示应引导复制副本后编辑');
  assert.deepEqual(JSON.parse(JSON.stringify(pipeline)),before,'被拦截后流水线定义不得改写');
});

test('deletePipeline：他人创建的流水线被拦截且不删除；本人创建的流水线正常删除',()=>{
  const others={id:'pl-bob',name:'他人流水线',builtIn:false,createdBy:'bob',stages:[{id:'s1',name:'构建'}]};
  const mine={id:'pl-mine',name:'我的流水线',builtIn:false,createdBy:'alice',stages:[{id:'s1',name:'部署'}]};
  const alerts=[],saves=[];
  const ctx={
    Object,Array,Promise,String,JSON,
    currentUsername:'alice',authReady:true,
    pipelines:[others,mine],
    findPipeline:id=>ctx.pipelines.find(p=>p.id===id)||null,
    running:false,
    confirm:()=>true,
    alert:msg=>alerts.push(String(msg)),
    savePipelines:()=>saves.push(1),
    curPipelineId:'pl-xds',
    renderPipelines:()=>{},renderFlow:()=>{},renderDetail:()=>{},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('plOwnerOf')+'\n'+extractFunction('plEditable')+'\n'+extractFunction('deletePipeline'),ctx);
  ctx.deletePipeline('pl-bob');
  assert.equal(alerts.length,1);
  assert.match(alerts[0],/仅创建者可删除/);
  assert.equal(ctx.pipelines.length,2,'他人创建的流水线不得被删除');
  assert.equal(saves.length,0,'拦截发生在落盘之前');
  ctx.deletePipeline('pl-mine');
  assert.deepEqual(ctx.pipelines.map(p=>p.id),['pl-bob'],'本人创建的流水线正常删除');
  assert.equal(saves.length,1);
});

/* fillExecutorFromAuth 切片（同 test_executor_auth_default.js）：探测结束（含失败）都置位
   authReady 并无条件重绘任务列表——行按钮「编辑/查看/删除」依赖身份，探测到达后必须刷新 */
test('fillExecutorFromAuth：探测成功/失败都置位 authReady 并无条件重绘流水线任务列表',async()=>{
  const start=source.indexOf('/* ---------- 执行人固定取 dsh 登录用户（只读） ---------- */');
  const end=source.indexOf('/* ---------- 执行人固定取 dsh 登录用户（只读）结束 ---------- */',start);
  assert.ok(start>=0&&end>start,'pipeline.html 缺少执行人固定取登录用户实现');
  const load=fetchImpl=>{
    let renders=0;
    const ctx={
      currentUsername:'',authReady:false,
      $:()=>({textContent:''}),
      fetch:fetchImpl,
      renderPipelines:()=>{renders+=1;},
    };
    vm.createContext(ctx);
    vm.runInContext(source.slice(start,end),ctx);
    return {ctx,renders:()=>renders};
  };
  const ok=load(async()=>({ok:true,json:async()=>({authenticated:true,username:'alice'})}));
  await ok.ctx.fillExecutorFromAuth();
  assert.equal(ok.ctx.currentUsername,'alice');
  assert.equal(ok.ctx.authReady,true,'探测成功后置位 authReady');
  assert.equal(ok.renders(),1,'探测成功后无条件重绘一次任务列表');
  const bad=load(async()=>{throw new Error('network');});
  await bad.ctx.fillExecutorFromAuth();
  assert.equal(bad.ctx.currentUsername,'','失败保持无用户（token 模式退化全权）');
  assert.equal(bad.ctx.authReady,true,'探测失败同样置位 authReady（不再保守只读）');
  assert.equal(bad.renders(),1,'探测失败也无条件重绘一次任务列表');
});
