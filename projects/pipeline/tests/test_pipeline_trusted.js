/* 可信流水线（trusted）：admin 可把流水线标记为「可信」，非 admin 对可信流水线只读（编辑/删除/拖拽/保存全禁，
   仍可运行）；admin 编辑可信流水线时权限优先于「仅创建者可编辑」。token 共享模式（无用户体系/探测失败，
   页面无法判定 admin）退化为全权：trusted 不限制编辑、行菜单标记入口也不显示。
   保存被服务端 403（{error:'trusted', message, pipelineIds}）拦截时：toast 展示服务端 message 并
   loadServerState 重拉状态同步，403 不回退全量保存（那是给网络错误/冲突用的）。 */
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

/* ---------- plEditable：trusted 规则 ---------- */
function loadPlEditable(globals){
  const ctx=Object.assign({String},globals||{});
  vm.createContext(ctx);
  vm.runInContext(extractFunction('plOwnerOf')+'\n'+extractFunction('plEditable'),ctx);
  return ctx;
}

test('plEditable：可信流水线仅 admin 可编辑（admin 优先于「仅创建者可编辑」），内置仍恒只读',()=>{
  const admin=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:true});
  assert.equal(admin.plEditable({id:'p1',createdBy:'bob',trusted:true}),true,'admin 可编辑他人创建的可信流水线');
  assert.equal(admin.plEditable({id:'p2',createdBy:'alice',trusted:true}),true,'admin 可编辑自己创建的可信流水线');
  assert.equal(admin.plEditable({id:'p0',builtIn:true,trusted:true}),false,'内置流水线即便带 trusted 也恒只读');
  const user=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:false});
  assert.equal(user.plEditable({id:'p3',createdBy:'alice',trusted:true}),false,'非 admin：创建者本人对可信流水线同样只读');
  assert.equal(user.plEditable({id:'p4',createdBy:'bob',trusted:true}),false,'非 admin：他人创建的可信流水线只读');
});

test('plEditable：可信流水线在 token 模式退化为全权，auth 探测在途保守只读',()=>{
  const token=loadPlEditable({currentUsername:'',authReady:true,currentUserIsAdmin:false});
  assert.equal(token.plEditable({id:'p1',createdBy:'bob',trusted:true}),true,'探测完成仍无用户（token 模式/探测失败）：退化为全权');
  const pending=loadPlEditable({currentUsername:'',authReady:false,currentUserIsAdmin:false});
  assert.equal(pending.plEditable({id:'p2',createdBy:'bob',trusted:true}),false,'auth 探测在途：可信流水线保守只读');
  const stubs=loadPlEditable();   // 旧测试桩：身份全局全缺，退化为全权（与署名路径同一约定）
  assert.equal(stubs.plEditable({id:'p3',createdBy:'bob',trusted:true}),true,'测试桩全局缺失时退化全权，不误伤旧测试桩');
  const noAdminGlobal=loadPlEditable({currentUsername:'alice',authReady:true});   // currentUserIsAdmin 全局缺失：按非 admin 保守处理
  assert.equal(noAdminGlobal.plEditable({id:'p4',createdBy:'alice',trusted:true}),false,'admin 标记缺失时按非 admin 保守只读');
});

test('plEditable：未标记 trusted 的既有行为不变',()=>{
  const mine=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:false});
  assert.equal(mine.plEditable({id:'p1',createdBy:'alice'}),true,'本人创建可编辑');
  assert.equal(mine.plEditable({id:'p2',createdBy:'bob'}),false,'他人创建只读');
  assert.equal(mine.plEditable({id:'p3'}),true,'未署名存量全员可编辑');
  const admin=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:true});
  assert.equal(admin.plEditable({id:'p4',createdBy:'bob'}),false,'非可信流水线 admin 无例外：同样只能编辑自己创建的');
  assert.equal(admin.plEditable({id:'p5',builtIn:true}),false,'内置只读');
});

/* ---------- 行菜单「标记可信」可见性 ---------- */
function loadOpenPlRowMenu({pipeline,username,isAdmin,withAdminGlobal=true}){
  const els={
    plRowMenuPanel:{style:{}},
    plRowMenuPin:{textContent:'',title:''},
    plRowMenuFavorite:{textContent:'',title:''},
    plRowMenuTrusted:{style:{display:'none'},textContent:'',title:''},
  };
  const ctx={
    currentUsername:username,
    $:id=>els[id]||null,
    findPipeline:id=>(pipeline&&pipeline.id===id)?pipeline:null,
    isPipelineFavorite:()=>false,
  };
  if(withAdminGlobal) ctx.currentUserIsAdmin=isAdmin;
  vm.createContext(ctx);
  vm.runInContext(extractFunction('openPlRowMenu'),ctx);
  ctx.openPlRowMenu(pipeline.id,null);
  return {ctx,els};
}

test('行菜单「标记可信」：仅 password 模式 + admin + 非内置流水线显示，文案随 trusted 态切换',()=>{
  const admin=loadOpenPlRowMenu({pipeline:{id:'p1',name:'流水线一',createdBy:'bob'},username:'alice',isAdmin:true});
  assert.equal(admin.els.plRowMenuTrusted.style.display,'','admin 可见标记入口');
  assert.equal(admin.els.plRowMenuTrusted.textContent,'标记可信');
  assert.match(admin.els.plRowMenuTrusted.title,/仅 admin 可编辑/);
  const trusted=loadOpenPlRowMenu({pipeline:{id:'p1',name:'流水线一',createdBy:'bob',trusted:true},username:'alice',isAdmin:true});
  assert.equal(trusted.els.plRowMenuTrusted.style.display,'');
  assert.equal(trusted.els.plRowMenuTrusted.textContent,'取消可信','已可信时文案为「取消可信」');
  assert.match(trusted.els.plRowMenuTrusted.title,/恢复/);
});

test('行菜单「标记可信」：非 admin / token 模式 / 内置流水线 / admin 全局缺失均不显示',()=>{
  const user=loadOpenPlRowMenu({pipeline:{id:'p1',name:'流水线一',createdBy:'alice'},username:'alice',isAdmin:false});
  assert.equal(user.els.plRowMenuTrusted.style.display,'none','非 admin 不显示（创建者本人也一样）');
  const token=loadOpenPlRowMenu({pipeline:{id:'p1',name:'流水线一'},username:'',isAdmin:false});
  assert.equal(token.els.plRowMenuTrusted.style.display,'none','token 模式（无登录用户）不显示');
  const builtIn=loadOpenPlRowMenu({pipeline:{id:'p0',name:'内置',builtIn:true},username:'alice',isAdmin:true});
  assert.equal(builtIn.els.plRowMenuTrusted.style.display,'none','内置流水线不显示');
  const noGlobal=loadOpenPlRowMenu({pipeline:{id:'p1',name:'流水线一'},username:'alice',withAdminGlobal:false});
  assert.equal(noGlobal.els.plRowMenuTrusted.style.display,'none','currentUserIsAdmin 全局缺失（旧测试桩）不显示且不抛错');
});

/* ---------- togglePipelineTrusted：置位/清除 + 保存 + 403/失败处理 ---------- */
function loadToggleTrusted({pipeline,username='alice',isAdmin=true,saveResult}){
  const calls={saves:[],renders:0,toasts:[],alerts:[]};
  const ctx={
    Object,Array,Promise,String,JSON,
    currentUsername:username,currentUserIsAdmin:isAdmin,
    findPipeline:id=>(pipeline&&pipeline.id===id)?pipeline:null,
    savePipelines:options=>{ calls.saves.push(options); return Promise.resolve(saveResult||{ok:true}); },
    renderPipelines:()=>{ calls.renders+=1; },
    toast:msg=>calls.toasts.push(String(msg)),
    alert:msg=>calls.alerts.push(String(msg)),
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('togglePipelineTrusted'),ctx);
  return {ctx,calls};
}

test('togglePipelineTrusted：admin 标记置位 trusted=true 并立即保存、toast 反馈',async()=>{
  const pipeline={id:'p1',name:'流水线一',createdBy:'bob'};
  const {ctx,calls}=loadToggleTrusted({pipeline});
  await ctx.togglePipelineTrusted('p1');
  assert.equal(pipeline.trusted,true,'标记置位 trusted=true');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.saves)),[{immediate:true}],'经 savePipelines({immediate:true}) 立即落盘（需拿结果识别 403）');
  assert.equal(calls.renders,1,'乐观重绘一次');
  assert.equal(calls.alerts.length,0);
  assert.match(calls.toasts[0]||'',/已标记为可信/,'成功 toast 反馈');
});

test('togglePipelineTrusted：admin 取消标记删除 trusted 字段（保持数据干净，不写 false）',async()=>{
  const pipeline={id:'p1',name:'流水线一',createdBy:'bob',trusted:true};
  const {ctx,calls}=loadToggleTrusted({pipeline});
  await ctx.togglePipelineTrusted('p1');
  assert.equal('trusted' in pipeline,false,'取消标记删除字段而非置 false');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.saves)),[{immediate:true}]);
  assert.match(calls.toasts[0]||'',/已取消可信/);
});

test('togglePipelineTrusted：非 admin / token 模式兜底拦截，不改数据不落盘',async()=>{
  const pipeline={id:'p1',name:'流水线一',createdBy:'alice'};
  const denied=loadToggleTrusted({pipeline,username:'alice',isAdmin:false});
  await denied.ctx.togglePipelineTrusted('p1');
  assert.equal('trusted' in pipeline,false);
  assert.equal(denied.calls.saves.length,0,'拦截发生在落盘之前');
  assert.match(denied.calls.alerts[0]||'',/仅 admin/);
  const token=loadToggleTrusted({pipeline,username:'',isAdmin:false});
  await token.ctx.togglePipelineTrusted('p1');
  assert.equal(token.calls.saves.length,0,'token 模式（菜单本不显示）兜底同样拦截');
});

test('togglePipelineTrusted：保存被 403（trusted）拦截时不回滚不重复提示，交由 pushState 重拉状态',async()=>{
  const pipeline={id:'p1',name:'流水线一',createdBy:'bob'};
  const {ctx,calls}=loadToggleTrusted({pipeline,saveResult:{ok:false,status:403,trusted:true,error:'trusted'}});
  await ctx.togglePipelineTrusted('p1');
  assert.equal(calls.saves.length,1);
  assert.equal(calls.alerts.length,0,'403 不再 alert（pushState 已 toast 服务端 message 并 loadServerState 同步）');
  assert.equal(calls.toasts.length,0,'403 不再补成功 toast');
});

test('togglePipelineTrusted：网络/冲突等其他失败回滚本地标记并 alert',async()=>{
  const pipeline={id:'p1',name:'流水线一',createdBy:'bob'};
  const {ctx,calls}=loadToggleTrusted({pipeline,saveResult:{ok:false,error:'HTTP 500'}});
  await ctx.togglePipelineTrusted('p1');
  assert.equal('trusted' in pipeline,false,'非 403 失败回滚本地标记');
  assert.match(calls.alerts[0]||'',/标记可信失败.*HTTP 500/);
  assert.equal(calls.toasts.length,0);
});

test('行菜单「标记可信」列表项存在于悬浮层并已绑定点击（先收起菜单再切换）',()=>{
  assert.ok(/<div id="plRowMenuTrusted" class="pl-row-menu-item" style="display:none">标记可信<\/div>/.test(source),'悬浮层含标记可信列表项（默认隐藏）');
  assert.ok(source.indexOf("$('plRowMenuTrusted').addEventListener('click'")>=0,'列表项点击绑定存在');
});

/* ---------- 列表徽章与行按钮（renderPipelines 切片，同 test_pipeline_pin.js 假 DOM） ---------- */
class FakeNode{
  constructor(tag){ this.tag=tag; this.children=[]; this.handlers={}; this._html=''; this.className=''; this.title=''; this.style={}; this.offsetWidth=0; }
  set innerHTML(value){ this._html=value; if(!value) this.children=[]; }
  get innerHTML(){ return this._html; }
  appendChild(node){ this.children.push(node); }
  addEventListener(type,handler){ this.handlers[type]=handler; }
  querySelectorAll(){ return []; }
}

function loadPipelineRows(){
  const tbody=new FakeNode('tbody');
  const table={querySelector:sel=>sel==='tbody'?tbody:null};
  const count={textContent:''};
  const selNode=new FakeNode('select');
  const panel=new FakeNode('div'); panel.style.display='none';
  const ctx={
    pipelines:[
      {id:'pipe-1',name:'可信流水线',stages:[{name:'构建'}],builtIn:false,createdBy:'bob',trusted:true},
      {id:'pipe-2',name:'普通流水线',stages:[{name:'部署'}],builtIn:false,createdBy:'bob'},
    ],
    curPipelineId:'',
    plFilter:{kw:'',owner:'all'},
    plFilterMatch:()=>true,
    renderPlFilterOptions:()=>{},
    plOwnerOf:p=>p.createdBy||'', plUpdaterOf:()=>'',
    plEditable:p=>!p||!p.builtIn,   // 归属桩：徽章测试不涉及权限级联（plEditable 矩阵已单测）
    isPipelineFavorite:()=>false,
    pipelineQueueCounts:()=>({}), pipelineQueueCountHtml:()=>'—',
    currentUsername:'alice',
    document:{createElement:tag=>new FakeNode(tag)},
    $:id=>({plTable:table,pipelineSel:selNode,plRowMenuPanel:panel,plRowMenuPin:new FakeNode('div'),plRowMenuFavorite:new FakeNode('div'),plRowMenuTrusted:new FakeNode('div')})[id]||count,
    esc:String,
    curPipeline:()=>null,
    findPipeline:id=>ctx.pipelines.find(p=>p.id===id),
    selectPipeline:()=>{},
    savePipelines:()=>{},
    alert:()=>{},
  };
  vm.createContext(ctx);
  const start=source.indexOf('/* 行内「⋯」菜单当前展开项');
  const end=source.indexOf('function selectPipeline',start);
  assert.ok(start>=0&&end>start,'流水线菜单与列表区域未找到');
  vm.runInContext(source.slice(start,end),ctx);
  ctx.renderPipelines();
  return {ctx,tbody};
}

test('renderPipelines：可信流水线行内名称旁渲染「可信」徽章，只读行「查看」按钮带可信提示',()=>{
  const {tbody}=loadPipelineRows();
  assert.equal(tbody.children.length,2);
  assert.match(tbody.children[0].innerHTML,/>可信<\/span>/,'可信行渲染徽章');
  assert.match(tbody.children[0].innerHTML,/可信流水线：仅 admin 可编辑/,'只读行「查看」按钮带可信提示');
  assert.doesNotMatch(tbody.children[1].innerHTML,/>可信<\/span>/,'未标记行不渲染徽章');
  assert.doesNotMatch(tbody.children[1].innerHTML,/可信流水线：仅 admin 可编辑/);
});

/* ---------- 编辑器标题（openPlForm 切片，同 test_pipeline_owner_edit.js 桩） ---------- */
function loadOpenPlForm({pipeline,username,isAdmin}){
  const els={
    plForm:{style:{},dataset:{}},
    plFormTitle:{textContent:''},
    scriptsDir:{value:''},
    plName:{value:'',focus(){}},
  };
  const ctx={
    Object,Array,Promise,String,
    stateLoaded:true,
    currentUsername:username||'',
    currentUserIsAdmin:!!isAdmin,
    authReady:true,
    alert:()=>{},
    editFocusIdx:-1,editSelStage:null,editStages:[],editDefaults:null,plFormReadOnly:false,
    scriptsDir:'/srv/scripts',
    $:id=>els[id]||null,
    findPipeline:id=>(pipeline&&pipeline.id===id)?pipeline:null,
    curPipeline:()=>pipeline||null,
    normalizePipelineDefaults:d=>Object.assign({},d),
    normalizeStageKind:s=>s,
    evaltokensStageConfig:et=>Object.assign({},et),
    currentPipelineDefaultSeed:()=>({}),
    newStage:name=>({id:'',name}),
    withPresetMarkers:stages=>stages,
    loadPlDraft:()=>null,
    renderPipelineDefaultForm:()=>{},
    loadScripts:()=>({then(cb){cb();}}),
    renderStageEditor:()=>{},
    detectStageParams:()=>null,
    detectEvaltokStageParams:()=>null,
    applyPlFormReadOnly:()=>{},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('plOwnerOf')+'\n'+extractFunction('plEditable')+'\n'+extractFunction('openPlForm'),ctx);
  return {ctx,els};
}

const TRUSTED={id:'pl-trusted',name:'可信流水线',createdBy:'bob',updatedBy:'bob',trusted:true,defaults:{},stages:[{id:'s1',name:'构建'}]};

test('openPlForm：非 admin 打开可信流水线为只读查看，标题标注可信与创建者',()=>{
  const {ctx,els}=loadOpenPlForm({pipeline:TRUSTED,username:'alice',isAdmin:false});
  ctx.openPlForm('pl-trusted');
  assert.equal(ctx.plFormReadOnly,true,'非 admin（即便另有署名）对可信流水线只读');
  assert.match(els.plFormTitle.textContent,/查看流水线（可信·创建者 @bob·只读）：可信流水线/);
});

test('openPlForm：admin 打开可信流水线保持可编辑，标题标注可信',()=>{
  const {ctx,els}=loadOpenPlForm({pipeline:TRUSTED,username:'alice',isAdmin:true});
  ctx.openPlForm('pl-trusted');
  assert.equal(ctx.plFormReadOnly,false,'admin 对可信流水线可编辑（优先于创建者规则）');
  assert.match(els.plFormTitle.textContent,/编辑流水线（可信）：可信流水线/);
});

/* ---------- copyPipeline：副本不继承可信标记 ---------- */
test('copyPipeline：副本清除 trusted（复制品默认非可信）',()=>{
  const srcPipe={id:'pl-a',name:'源',builtIn:false,trusted:true,createdBy:'bob',updatedBy:'bob',stages:[{id:'s1',name:'构建'}]};
  const ctx={
    findPipeline:id=>(id==='pl-a'?srcPipe:null),
    pipelines:[srcPipe],
    currentUsername:'alice',
    savePipelines:()=>{},
    running:false,
    selectPipeline:()=>{},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('uniqueCopyName')+'\n'+extractFunction('copyPipeline'),ctx);
  ctx.copyPipeline('pl-a');
  assert.equal(ctx.pipelines.length,2);
  assert.equal('trusted' in ctx.pipelines[1],false,'副本不继承可信标记（字段删除而非置 false）');
  assert.equal(srcPipe.trusted,true,'源流水线可信标记不受影响');
});

/* ---------- savePlForm：trusted 兜底拦截与 403 收尾 ---------- */
test('savePlForm 兜底：非 admin 保存可信流水线被拦截，定义不被改写',async()=>{
  const pipeline={id:'p1',name:'可信流水线',builtIn:false,trusted:true,createdBy:'alice',updatedBy:'alice',stages:[{id:'s1',name:'构建'}]};
  const before=JSON.parse(JSON.stringify(pipeline));
  const alerts=[];
  const ctx={
    Object,Array,Promise,String,JSON,
    currentUsername:'alice',authReady:true,currentUserIsAdmin:false,
    $:id=>({plForm:{dataset:{editId:'p1'}},plName:{value:'改写名'}}[id]||null),
    findPipeline:id=>(id==='p1'?pipeline:null),
    alert:msg=>alerts.push(String(msg)),
    editStages:[{id:'s2',name:'篡改阶段'}],
    savePipelines:()=>{ throw new Error('被拦截时不得走到落盘'); },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('plOwnerOf')+'\n'+extractFunction('plEditable')+'\n'+extractFunction('savePlForm'),ctx);
  await ctx.savePlForm();
  assert.equal(alerts.length,1);
  assert.match(alerts[0],/已被管理员标记为可信，仅 admin 可编辑保存/);
  assert.match(alerts[0],/复制.*副本/,'提示应引导复制副本后编辑');
  assert.deepEqual(JSON.parse(JSON.stringify(pipeline)),before,'被拦截后流水线定义不得改写');
});

test('savePlForm：保存被 403（trusted）拒绝时关闭编辑器、清草稿、不重滚定义、不回退全量保存',async()=>{
  const oldPipeline={id:'p1',name:'旧名称',builtIn:false,trusted:true,createdBy:'alice',stages:[{id:'old',name:'旧阶段'}]};
  const alerts=[],calls={clear:0,render:0,select:0,one:null,full:null},timers=[];
  const els={
    plForm:{style:{display:'flex'},dataset:{editId:'p1'},inert:false},
    plName:{value:'新名称'},
    scriptsDir:{value:'/srv/scripts'},
    plSave:{disabled:false,textContent:'保存'},
    plDraftTip:{textContent:'',style:{}},
  };
  const ctx={
    alert:message=>alerts.push(String(message)), confirm:()=>true,
    PRESET_BY_NAME:{}, editStages:[{id:'new',name:'新阶段',kind:'simulate',dur:0}],
    scriptsDir:'/srv/scripts', scriptsDirIsFallback:false,
    serverConfigBase:{pipelines:[JSON.parse(JSON.stringify(oldPipeline))]},
    $:id=>els[id]||null,
    findPipeline:id=>ctx.pipelines.find(item=>item.id===id),
    pipelines:[JSON.parse(JSON.stringify(oldPipeline))], currentUsername:'alice', authReady:true, currentUserIsAdmin:true,   // admin 保存仍可能被 403（他端刚标记可信）
    plEditable:()=>true,
    stageIdFor:()=>'new', collectPipelineDefaultForm:()=>({branch:'main'}),
    saveScriptsDir:()=>{},
    pushPipelineOne:id=>{ calls.one=id; return Promise.resolve({ok:false,status:403,trusted:true,error:'trusted'}); },
    savePipelines:options=>{ calls.full=options; return Promise.resolve({ok:true}); },
    clearPlDraft:()=>{ calls.clear+=1; },
    running:false, curPipelineId:'p1',
    selectPipeline:()=>{ calls.select+=1; }, renderPipelines:()=>{ calls.render+=1; },
    plOwnerOf:p=>p.createdBy||'',
    setTimeout:(fn,ms)=>{ const timer={fn,ms}; timers.push(timer); return timer; },
    clearTimeout:timer=>{ const index=timers.indexOf(timer); if(index>=0) timers.splice(index,1); },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('savePlForm'),ctx);
  await ctx.savePlForm();
  assert.equal(calls.one,'p1','先走单条保存');
  assert.equal(calls.full,null,'403 不回退全量保存（回退是给网络错误/冲突用的）');
  assert.equal(els.plForm.style.display,'none','编辑器退出（定义以服务端为准）');
  assert.equal(calls.clear,1,'草稿清除');
  assert.equal(alerts.length,0,'不再 alert（403 已由 pushPipelineOne toast 并重拉状态）');
  assert.equal(calls.select,0,'不走成功保存的选用路径');
  assert.equal(ctx.pipelines[0].name,'新名称','不做本地回滚（服务端状态已由 loadServerState 重拉，回滚会覆盖刚同步的定义）');
});

/* ---------- pushState / pushPipelineOne：403 捕获 toast + 重拉状态 ---------- */
function pushFixture403(){
  const requests=[],timers=[],toasts=[],reloads=[],renders=[];
  const baseConfig={pipelines:[{id:'p1',name:'基线',stages:[]}],theme:'dark'};
  const clientConfig={pipelines:[{id:'p1',name:'本页修改',trusted:true,stages:[]}],theme:'dark'};
  const response={ok:false,status:403,json:async()=>({error:'trusted',message:'流水线已被管理员标记为可信，仅 admin 可编辑',pipelineIds:['p1']})};
  const ctx={
    stateLoaded:true,
    serverConfigBase:baseConfig,
    persistTimer:null,
    persistInFlight:null,
    collectConfig:()=>({...clientConfig,pipelines:JSON.parse(JSON.stringify(ctx.pipelines))}),
    historyForPersist:()=>[{tag:'run-1',ts:1}],
    historySyncSig:'',
    loadServerState:async()=>{ reloads.push(1); },
    renderPipelines:()=>{ renders.push(1); },
    toast:msg=>toasts.push(String(msg)),
    pipelines:JSON.parse(JSON.stringify(clientConfig.pipelines)),
    localStorage:{setItem(){}},
    migrateGate:v=>v, migrateStageUrl:v=>v, migratePrefillDefaults:v=>v, migratePipelineDefaults:v=>v, migratePromPreset:v=>v,
    fetch:async(url,options)=>{ requests.push({url,options}); return response; },
    AbortController,
    setTimeout:(fn,ms)=>{ const timer={fn,ms}; timers.push(timer); return timer; },
    clearTimeout:timer=>{ const index=timers.indexOf(timer); if(index>=0) timers.splice(index,1); },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('historyPersistSig')+'\n'+extractFunction('reconcilePipelinesAfterSave')+'\n'+extractFunction('pushState'),ctx);
  return {ctx,requests,toasts,reloads,renders};
}

test('pushState：403 可信拦截 toast 服务端 message、重拉服务端状态，返回可识别结果',async()=>{
  const f=pushFixture403();
  const result=await f.ctx.pushState();
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{ok:false,status:403,trusted:true,error:'trusted'});
  assert.deepEqual(f.toasts,['流水线已被管理员标记为可信，仅 admin 可编辑'],'toast 展示服务端 message');
  assert.equal(f.reloads.length,1,'loadServerState 重拉状态同步');
  assert.equal(f.renders.length,1,'同步后重绘任务列表');
  assert.equal(f.ctx.persistInFlight,null,'串行锁已释放');
});

test('pushPipelineOne：403 可信拦截 toast 服务端 message、重拉状态，不再发第二个请求（不回退全量）',async()=>{
  const requests=[],timers=[],toasts=[],reloads=[];
  const edited={id:'p1',name:'编辑后',trusted:true,stages:[{id:'s1'}]};
  const other={id:'p2',name:'其他',stages:[]};
  const response={ok:false,status:403,json:async()=>({error:'trusted',message:'流水线已被管理员标记为可信，仅 admin 可编辑',pipelineIds:['p1']})};
  const ctx={
    persistInFlight:null,
    serverConfigBase:{pipelines:[{id:'p1',name:'编辑前',stages:[{id:'s1'}]},other],buildNo:3},
    scriptsDir:'/srv/scripts',
    pipelines:[JSON.parse(JSON.stringify(edited)),other],
    findPipeline:id=>ctx.pipelines.find(item=>item.id===id),
    loadServerState:async()=>{ reloads.push(1); },
    renderPipelines:()=>{},
    toast:msg=>toasts.push(String(msg)),
    localStorage:{setItem(){}},
    migrateGate:v=>v, migrateStageUrl:v=>v, migratePrefillDefaults:v=>v, migratePipelineDefaults:v=>v, migratePromPreset:v=>v,
    fetch:async(url,options)=>{ requests.push({url,options}); return response; },
    AbortController,
    setTimeout:(fn,ms)=>{ const timer={fn,ms}; timers.push(timer); return timer; },
    clearTimeout:timer=>{ const index=timers.indexOf(timer); if(index>=0) timers.splice(index,1); },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('reconcilePipelinesAfterSave')+'\n'+extractFunction('pushPipelineOne'),ctx);
  const result=await ctx.pushPipelineOne('p1');
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{ok:false,status:403,trusted:true,error:'trusted'});
  assert.equal(result.unsupported,undefined,'403 不标记 unsupported（调用方不得回退全量保存）');
  assert.equal(requests.length,1,'只发单条保存请求');
  assert.equal(requests[0].url,'/api/worktable/pipeline/save-one');
  assert.deepEqual(toasts,['流水线已被管理员标记为可信，仅 admin 可编辑']);
  assert.equal(reloads.length,1);
  assert.equal(ctx.persistInFlight,null,'串行锁已释放');
});

/* ---------- toast 帮助函数 ---------- */
test('toast：懒创建浮层元素、展示文本并定时自动消隐',()=>{
  const timers=[];
  const el={style:{display:'none'},textContent:'',id:'',className:''};
  const body={children:[],appendChild(node){ this.children.push(node); }};
  const ctx={
    String,
    $:()=>null,
    document:{createElement:()=>el,body},
    setTimeout:(fn,ms)=>{ const timer={fn,ms}; timers.push(timer); return timer; },
    clearTimeout:timer=>{ const index=timers.indexOf(timer); if(index>=0) timers.splice(index,1); },
  };
  vm.createContext(ctx);
  vm.runInContext('let pageToastTimer=null;\n'+extractFunction('toast'),ctx);
  ctx.toast('流水线已被管理员标记为可信');
  assert.equal(body.children.length,1,'元素懒创建并挂上 body');
  assert.equal(el.id,'pageToast');
  assert.equal(el.className,'page-toast');
  assert.equal(el.textContent,'流水线已被管理员标记为可信');
  assert.equal(el.style.display,'block');
  assert.equal(timers.length,1);
  assert.equal(timers[0].ms,4000,'约 4 秒自动消隐');
  timers[0].fn();
  assert.equal(el.style.display,'none');
});
