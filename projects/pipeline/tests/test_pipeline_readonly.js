/* 内置（默认）流水线只读查看：编辑器只读模式、保存/拖拽写回兜底拦截。 */
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

/* openPlForm 的依赖较多，这里按职责打桩：只关心只读标志、标题、草稿恢复与只读应用 */
function loadOpenPlForm({pipeline,draft}){
  const calls={applyRO:0,renderEditor:0,renderDefaults:0,focus:0};
  const els={
    plForm:{style:{},dataset:{}},
    plFormTitle:{textContent:''},
    scriptsDir:{value:''},
    plName:{value:'',focus(){calls.focus+=1;}},
  };
  const ctx={
    Object,Array,Promise,String,
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
  vm.runInContext(extractFunction('openPlForm'),ctx);
  return {ctx,els,calls};
}

const BUILTIN={id:'pl-xds',name:'安装部署XDS',builtIn:true,defaults:{branch:'main'},stages:[{id:'s1',name:'检出'},{id:'s2',name:'构建镜像'}]};
const CUSTOM={id:'pl-a',name:'我的流水线',defaults:{branch:'main'},stages:[{id:'s1',name:'部署'}]};

test('内置流水线打开为只读查看：标志置位、标题标注只读、不恢复草稿、不抢焦点',()=>{
  const draft={editId:'pl-xds',stages:[{id:'d1',name:'草稿改动'}],name:'草稿名',scriptsDir:'/draft',defaults:{branch:'dev'}};
  const {ctx,els,calls}=loadOpenPlForm({pipeline:BUILTIN,draft});
  ctx.openPlForm('pl-xds');
  assert.equal(ctx.plFormReadOnly,true,'内置流水线必须进入只读模式');
  assert.match(els.plFormTitle.textContent,/查看流水线（内置·只读）：安装部署XDS/);
  assert.equal(els.plName.value,'安装部署XDS','只读查看展示内置定义真值，不恢复草稿名');
  assert.equal(els.scriptsDir.value,'/srv/scripts','只读查看不恢复草稿脚本目录');
  assert.deepEqual(ctx.editStages.map(s=>s.name),['检出','构建镜像'],'阶段列表来自内置定义而非草稿');
  assert.equal(calls.applyRO,1,'openPlForm 须应用一次只读');
  assert.equal(calls.focus,0,'只读模式不聚焦名称输入框');
});

test('普通流水线保持可编辑：标题为编辑、草稿照常恢复、聚焦名称框',()=>{
  const draft={editId:'pl-a',stages:[{id:'d1',name:'草稿阶段'}],name:'草稿名',scriptsDir:'/draft',defaults:{branch:'dev'}};
  const {ctx,els,calls}=loadOpenPlForm({pipeline:CUSTOM,draft});
  ctx.openPlForm('pl-a');
  assert.equal(ctx.plFormReadOnly,false,'普通流水线不得进入只读模式');
  assert.match(els.plFormTitle.textContent,/编辑流水线：我的流水线/);
  assert.equal(els.plName.value,'草稿名','草稿照常恢复');
  assert.equal(els.scriptsDir.value,'/draft');
  assert.deepEqual(ctx.editStages.map(s=>s.name),['草稿阶段']);
  assert.equal(calls.focus,1);
});

test('applyPlFormReadOnly：只读禁用全部编辑控件并隐藏保存/添加，退出只读完整恢复',()=>{
  const checks=[{disabled:false},{disabled:false}];
  const rowCtrls=[{disabled:false},{disabled:false}];
  const row={draggable:true,style:{},querySelectorAll:sel=>sel==='input,select,textarea,button'?rowCtrls:[]};
  const els={
    plForm:{style:{}},
    plName:{disabled:false},scriptsDir:{disabled:false},scriptsReload:{disabled:false},
    plDefaultEnvMultiBtn:{disabled:false},plDefaultRepo:{disabled:false},
    plDefaultBranch:{disabled:false},plDefaultStrategy:{disabled:false},
    plDefaultPresets:{querySelectorAll:()=>checks},
    plStageAdd:{style:{}},plSave:{style:{}},
    plStageList:{children:[row]},
  };
  const ctx={plFormReadOnly:true,$:id=>els[id]||null};
  vm.createContext(ctx);
  vm.runInContext(extractFunction('applyPlFormReadOnly'),ctx);

  ctx.applyPlFormReadOnly();
  ['plName','scriptsDir','scriptsReload','plDefaultEnvMultiBtn','plDefaultRepo','plDefaultBranch','plDefaultStrategy'].forEach(id=>{
    assert.equal(els[id].disabled,true,id+' 只读时必须禁用');
  });
  checks.forEach((c,i)=>assert.equal(c.disabled,true,'预设任务勾选 '+(i+1)+' 只读时必须禁用'));
  rowCtrls.forEach((c,i)=>assert.equal(c.disabled,true,'阶段卡控件 '+(i+1)+' 只读时必须禁用'));
  assert.equal(row.draggable,false,'只读时任务卡禁止拖拽');
  assert.equal(row.style.cursor,'default');
  assert.equal(els.plStageAdd.style.display,'none','只读时隐藏添加阶段');
  assert.equal(els.plSave.style.display,'none','只读时隐藏保存');

  ctx.plFormReadOnly=false;
  ctx.applyPlFormReadOnly();
  ['plName','scriptsDir','scriptsReload','plDefaultEnvMultiBtn','plDefaultRepo','plDefaultBranch','plDefaultStrategy'].forEach(id=>{
    assert.equal(els[id].disabled,false,id+' 退出只读后必须恢复可编辑');
  });
  checks.forEach(c=>assert.equal(c.disabled,false));
  assert.equal(row.draggable,true);
  assert.equal(row.style.cursor,'');
  assert.equal(els.plStageAdd.style.display,'');
  assert.equal(els.plSave.style.display,'');
});

test('savePlForm 兜底：任何路径都不得写回内置流水线，普通流水线不受影响',()=>{
  let alerted='';
  const ctx={
    $:id=>({plForm:{dataset:{editId:'pl-xds'}},plName:{value:'x'}}[id]||null),
    findPipeline:id=>(id==='pl-xds'?BUILTIN:null),
    alert:msg=>{alerted=msg;},
    editStages:[],
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('savePlForm'),ctx);
  ctx.savePlForm();
  assert.match(alerted,/只读/,'保存内置流水线必须被拦截并提示只读');

  alerted='';
  ctx.findPipeline=id=>(id==='pl-a'?CUSTOM:null);
  ctx.$=id=>({plForm:{dataset:{editId:'pl-a'}},plName:{value:'x'}}[id]||null);
  ctx.savePlForm();
  assert.match(alerted,/请至少添加一个阶段/,'普通流水线须通过只读兜底、进入后续校验');
});

test('flowDraggable：当前流水线为内置时主视图禁止拖拽改序',()=>{
  const ctx={
    running:false,runStages:null,replayRec:null,
    viewActive:()=>false,
    curPipeline:()=>BUILTIN,
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('flowDraggable'),ctx);
  assert.equal(ctx.flowDraggable(),false,'内置流水线主视图不可拖拽');
  ctx.curPipeline=()=>CUSTOM;
  assert.equal(ctx.flowDraggable(),true,'普通流水线空闲态仍可拖拽改序');
  ctx.curPipeline=()=>null;
  assert.equal(ctx.flowDraggable(),true,'无当前流水线时不因内置判断报错');
});

test('persistFlowOrder 兜底：内置流水线不落盘，普通流水线照常回写',()=>{
  let saved=0,renders=0;
  const ctx={
    curPipeline:()=>BUILTIN,
    normalizePipelineProm:p=>p||{},
    savePipelines:()=>{saved+=1;},
    renderPipelines:()=>{renders+=1;},renderFlow:()=>{},renderDetail:()=>{},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('persistFlowOrder'),ctx);
  const before=BUILTIN.stages.slice();
  ctx.persistFlowOrder([{id:'s2',name:'构建镜像'},{id:'s1',name:'检出'}]);
  assert.deepEqual(BUILTIN.stages,before,'内置流水线 stages 不得被改写');
  assert.equal(saved,0,'内置流水线不得触发持久化');

  const custom={id:'pl-b',name:'x',stages:[{id:'a',name:'甲'},{id:'b',name:'乙'}]};
  ctx.curPipeline=()=>custom;
  ctx.persistFlowOrder([custom.stages[1],custom.stages[0]]);
  assert.deepEqual(custom.stages.map(s=>s.id),['b','a'],'普通流水线按新顺序回写');
  assert.equal(saved,1);
  assert.ok(renders>=1);
});

/* 选中卡「+」插入按钮：只读模式不出现；已有的也要移除（复用 test_stage_insert_select 的假 DOM 套路） */
class FakeClassList{
  constructor(){this.values=new Set();}
  add(v){this.values.add(v);}
  remove(...vs){vs.forEach(v=>this.values.delete(v));}
  toggle(v,force){const on=force===undefined?!this.values.has(v):!!force;if(on)this.values.add(v);else this.values.delete(v);return on;}
  contains(v){return this.values.has(v);}
}
class FakeRow{
  constructor(index){this.dataset={idx:String(index)};this.classList=new FakeClassList();this.insCount=0;}
  insertAdjacentHTML(position,html){
    assert.equal(position,'beforeend');
    this.insCount+=(html.match(/class="plstage-ins /g)||[]).length;
  }
  querySelector(sel){return sel==='.plstage-ins'&&this.insCount>0?{fake:true}:null;}
  querySelectorAll(sel){
    if(sel!=='.plstage-ins') return [];
    const row=this;
    return Array.from({length:row.insCount},()=>({remove(){row.insCount-=1;}}));
  }
}

test('只读模式下选中任务卡不出现「+」插入按钮，高亮保留；退出只读恢复',()=>{
  const stages=[{id:'a'},{id:'b'}];
  const rows=stages.map((_,i)=>new FakeRow(i));
  const ctx={
    editStages:stages,editSelStage:stages[1],plFormReadOnly:true,
    $:id=>(id==='plStageList'?{children:rows}:null),
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('applyEditSel'),ctx);

  ctx.applyEditSel();
  assert.equal(rows[1].classList.contains('plstage-sel'),true,'只读模式保留选中高亮');
  assert.equal(rows[1].insCount,0,'只读模式不出现「+」插入按钮');

  rows[1].insCount=2;   // 模拟可编辑模式残留的插入按钮
  ctx.applyEditSel();
  assert.equal(rows[1].insCount,0,'只读模式下已有「+」按钮也被移除');

  ctx.plFormReadOnly=false;
  ctx.applyEditSel();
  assert.equal(rows[1].insCount,2,'可编辑模式恢复上/下缘「+」按钮');
});
