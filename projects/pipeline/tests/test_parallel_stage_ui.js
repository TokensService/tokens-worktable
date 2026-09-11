const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');

const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function extractFunction(name){
  const match=new RegExp('function\\s+'+name+'\\s*\\(').exec(source);
  assert.ok(match,'missing function '+name);
  const bodyStart=source.indexOf('{',match.index);
  let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    else if(source[i]==='}'&&--depth===0) return source.slice(match.index,i+1);
  }
  throw new Error('unterminated function '+name);
}

function install(ctx,...names){
  vm.createContext(ctx);
  names.forEach(name=>vm.runInContext(extractFunction(name),ctx));
  return ctx;
}

class FakeNode{
  constructor(tag){ this.tagName=tag; this.children=[]; this.dataset={}; this.style={}; this.listeners={}; this.className=''; this._innerHTML=''; this.fields={}; }
  set innerHTML(value){
    this._innerHTML=String(value); this.children=[]; this.fields={};
    const parallel=this._innerHTML.match(/<input[^>]*data-f="parallel"[^>]*>/);
    if(parallel) this.fields.parallel={checked:/\schecked(?:\s|=|\/|>)/.test(parallel[0])};
  }
  get innerHTML(){ return this._innerHTML; }
  appendChild(node){ this.children.push(node); return node; }
  addEventListener(type,fn){ this.listeners[type]=fn; }
  fire(type){ this.listeners[type]({currentTarget:this}); }
  querySelector(selector){ return selector==='[data-f="parallel"]'?(this.fields.parallel||null):null; }
}

function flowContext(stages){
  const flow=new FakeNode('div');
  const ctx={
    $:id=>id==='flow'?flow:null,
    document:{createElement:tag=>new FakeNode(tag)},
    esc:String,
    flowStages:()=>stages,
    flowDraggable:()=>false,
    curPipeline:()=>({}),
    withPresetMarkers:x=>x,
    activeStages:()=>stages,
    curPipelineId:'pl', runStages:null, curRun:null, replayRec:null,
    viewActive:()=>false, findPipeline:()=>true,
    selectedId:null, setSel(id){ ctx.selectedId=id; },
    applyStatusClasses(){ ctx.statusApplied=(ctx.statusApplied||0)+1; },
    renderDetail(){ ctx.details=(ctx.details||0)+1; },
  };
  install(ctx,'pipelineStageGroups','createFlowNode','renderFlow');
  return {ctx,flow};
}

test('连续 parallel 普通任务成组，预设任务和串行任务切断分组',()=>{
  const ctx=install({},'pipelineStageGroups');
  const groups=ctx.pipelineStageGroups([
    {id:'prepare'}, {id:'build',parallel:true}, {id:'test',parallel:true},
    {id:'__check__',preset:true,parallel:true}, {id:'eval',parallel:true}, {id:'deploy'},
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(group=>({start:group.start,end:group.end,parallel:group.parallel,ids:group.stages.map(stage=>stage.id)})))),[
    {start:0,end:1,parallel:false,ids:['prepare']},
    {start:1,end:3,parallel:true,ids:['build','test']},
    {start:3,end:4,parallel:false,ids:['__check__']},
    {start:4,end:5,parallel:true,ids:['eval']},
    {start:5,end:6,parallel:false,ids:['deploy']},
  ]);
});

test('多任务并行组渲染 fork、任务分支和 join，节点点击仍选中',()=>{
  const {ctx,flow}=flowContext([{id:'build',name:'构建',parallel:true},{id:'test',name:'测试',parallel:true}]);
  ctx.renderFlow();
  assert.equal(flow.children.length,1);
  const group=flow.children[0];
  assert.equal(group.className,'pipeline-parallelGroup');
  assert.deepEqual(group.children.map(node=>node.className),['pipeline-parallelTitle','pipeline-parallelRailIn','pipeline-parallelTasks','pipeline-parallelRailOut']);
  const tasks=group.children[2];
  assert.equal(tasks.style.flexDirection,'column');
  assert.deepEqual(tasks.children.map(row=>row.className),['pipeline-parallelTaskRow','pipeline-parallelTaskRow']);
  assert.ok(tasks.children.every(row=>row.style.display==='flex'));
  assert.deepEqual(tasks.children.map(row=>row.children.map(node=>node.className)),[
    ['pipeline-parallelBranchIn','pipeline-node','pipeline-parallelBranchOut'],
    ['pipeline-parallelBranchIn','pipeline-node','pipeline-parallelBranchOut'],
  ]);
  assert.deepEqual(tasks.children.map(row=>row.children[1].dataset.id),['build','test']);
  tasks.children[1].children[1].fire('click');
  assert.equal(ctx.selectedId,'test');
  assert.equal(ctx.details,1);
});

test('标记的单任务保持普通节点并带闪电，预设任务始终是屏障',()=>{
  const singleton=flowContext([{id:'build',name:'构建',parallel:true}]);
  singleton.ctx.renderFlow();
  assert.equal(singleton.flow.children[0].className,'pipeline-node');
  assert.match(singleton.flow.children[0].innerHTML,/⚡/);

  const barrier=flowContext([
    {id:'build',name:'构建',parallel:true},
    {id:'__check__',name:'检查',preset:true,parallel:true},
    {id:'test',name:'测试',parallel:true},
  ]);
  barrier.ctx.renderFlow();
  assert.equal(barrier.flow.children.filter(node=>node.className==='pipeline-parallelGroup').length,0);
  assert.deepEqual(barrier.flow.children.filter(node=>node.className==='pipeline-node').map(node=>node.dataset.id),['build','__check__','test']);
});

test('编辑器复选框、保存和重新打开保留 parallel 状态',()=>{
  const row=new FakeNode('div');
  const stageList=new FakeNode('div');
  const stage={id:'build',name:'构建',dur:0,timeout:null,skip:false,parallel:false,sub:[],kind:'simulate',script:null,url:null,evaltokens:null,sched:{}};
  const form={dataset:{editId:'pl-1'},style:{}};
  const nameInput={value:'并行',focus(){}};
  const pipeline={id:'pl-1',name:'并行',stages:[]};
  const ctx={
    editStages:[stage], editFocusIdx:-1, plFormReadOnly:false, editSelStage:null,
    $:id=>({plStageList:stageList,plForm:form,plFormTitle:{textContent:''},plName:nameInput,scriptsDir:{value:'/scripts'}}[id]||null),
    document:{createElement:tag=>new FakeNode(tag)}, esc:String, secToMinInput:s=>String((s||0)/60),
    STAGE_KIND_LABEL:{simulate:'模拟',shell:'Shell',python:'Python',http:'HTTP',evaltokens:'EvalTokens'},
    stageCardMouseDown(){},stageCardDragStart(){},stageCardDragOver(){},stageCardDrop(){},stageCardDragEnd(){},
    renderStageActionRow(){},renderStageParams(){},renderStageSched(){},applyEditSel(){},applyPlFormReadOnly(){},
    findPipeline:id=>id==='pl-1'?pipeline:null, PRESET_BY_NAME:{}, scriptByName:()=>null, confirm:()=>true, alert:msg=>{throw new Error(msg);},
    scriptLangOf:()=> 'sh', stageIdFor:()=> 'build', evaltokensStageConfig:x=>x, saveScriptsDir(){}, collectPipelineDefaultForm:()=>({}),
    savePipelines(){},clearPlDraft(){},schedulePlDraftSave(){},running:false,curPipelineId:'other',pipelines:[pipeline],renderPipelines(){},renderFlow(){},renderDetail(){},selectPipeline(){},
    normalizePipelineDefaults:x=>x||{}, normalizeStageKind:x=>x, withPresetMarkers:x=>x, currentPipelineDefaultSeed:()=>({}),loadPlDraft:()=>null,
    renderPipelineDefaultForm(){},loadScripts:()=>Promise.resolve(),
  };
  install(ctx,'renderStageEditor','updateStageFromEditor','savePlForm','openPlForm');
  ctx.renderStageEditor();
  assert.equal(ctx.$('plStageList').children[0].querySelector('[data-f="parallel"]').checked,false);
  ctx.updateStageFromEditor({target:{getAttribute:key=>key==='data-f'?'parallel':null,checked:true,closest:()=>({dataset:{idx:'0'}})}});
  assert.equal(stage.parallel,true);
  ctx.renderStageEditor();
  assert.equal(ctx.$('plStageList').children[0].querySelector('[data-f="parallel"]').checked,true);
  ctx.savePlForm();
  assert.equal(pipeline.stages[0].parallel,true);
  ctx.openPlForm('pl-1');
  assert.equal(ctx.editStages[0].parallel,true);
});

test('无效 parallel 值在编辑、保存和重新打开中保持串行',()=>{
  const stageList=new FakeNode('div');
  const invalid={id:'build',name:'构建',dur:0,timeout:null,skip:false,parallel:'false',sub:[],kind:'simulate',script:null,url:null,evaltokens:null,sched:{}};
  const form={dataset:{editId:'pl-1'},style:{}};
  const nameInput={value:'并行',focus(){}};
  const pipeline={id:'pl-1',name:'并行',stages:[]};
  const ctx={
    editStages:[invalid], editFocusIdx:-1, plFormReadOnly:false, editSelStage:null,
    $:id=>({plStageList:stageList,plForm:form,plFormTitle:{textContent:''},plName:nameInput,scriptsDir:{value:'/scripts'}}[id]||null),
    document:{createElement:tag=>new FakeNode(tag)}, esc:String, secToMinInput:s=>String((s||0)/60),
    STAGE_KIND_LABEL:{simulate:'模拟',shell:'Shell',python:'Python',http:'HTTP',evaltokens:'EvalTokens'},
    stageCardMouseDown(){},stageCardDragStart(){},stageCardDragOver(){},stageCardDrop(){},stageCardDragEnd(){},
    renderStageActionRow(){},renderStageParams(){},renderStageSched(){},applyEditSel(){},applyPlFormReadOnly(){},
    findPipeline:id=>id==='pl-1'?pipeline:null, PRESET_BY_NAME:{}, scriptByName:()=>null, confirm:()=>true, alert:msg=>{throw new Error(msg);},
    scriptLangOf:()=> 'sh', stageIdFor:()=> 'build', evaltokensStageConfig:x=>x, saveScriptsDir(){}, collectPipelineDefaultForm:()=>({}),
    savePipelines(){},clearPlDraft(){},schedulePlDraftSave(){},running:false,curPipelineId:'other',pipelines:[pipeline],renderPipelines(){},renderFlow(){},renderDetail(){},selectPipeline(){},
    normalizePipelineDefaults:x=>x||{}, normalizeStageKind:x=>x, withPresetMarkers:x=>x, currentPipelineDefaultSeed:()=>({}),loadPlDraft:()=>null,
    renderPipelineDefaultForm(){},loadScripts:()=>Promise.resolve(),
  };
  install(ctx,'renderStageEditor','savePlForm','openPlForm');
  ctx.renderStageEditor();
  assert.equal(stageList.children[0].querySelector('[data-f="parallel"]').checked,false);
  ctx.savePlForm();
  assert.equal(Object.hasOwn(pipeline.stages[0],'parallel'),false);
  pipeline.stages=[Object.assign({},invalid,{parallel:1})];
  ctx.openPlForm('pl-1');
  assert.equal(ctx.editStages[0].parallel,false);
});
