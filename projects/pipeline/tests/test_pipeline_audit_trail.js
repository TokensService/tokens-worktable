// 流水线任务署名审计：创建者 + 最后修改人（来源 dsh-auth-gate /auth/status 登录用户）的记录、迁移与列表展示。
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

/* savePlForm 的依赖按职责打桩：只关心署名字段的写入，校验/渲染/落盘全部旁路（单一普通阶段必然通过内容校验） */
function loadSavePlForm({editId,pipeline,username}){
  const els={
    plForm:{style:{},dataset:{editId:editId||''}},
    plName:{value:'审计流水线'},
    scriptsDir:{value:''},
    triggeredBy:{value:''},
  };
  const saved=[];
  const ctx={
    alert:msg=>{ throw new Error('不应触发校验告警：'+msg); },
    confirm:()=>true,
    PRESET_BY_NAME:{},
    editStages:[{id:'s1',name:'构建'}],
    scriptsDir:'',
    $:id=>els[id]||null,
    findPipeline:id=>(pipeline&&pipeline.id===id)?pipeline:null,
    pipelines:pipeline?[pipeline]:[],
    currentUsername:username||'',
    stageIdFor:()=>'',
    collectPipelineDefaultForm:()=>({}),
    saveScriptsDir:()=>{},
    savePipelines:()=>{ saved.push(1); },
    clearPlDraft:()=>{},
    running:false,
    curPipelineId:'',
    selectPipeline:()=>{},
    renderPipelines:()=>{},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('plOwnerOf')+'\n'+extractFunction('plUpdaterOf')+'\n'+extractFunction('savePlForm'),ctx);
  return {ctx,saved};
}

test('迁移：旧流水线补齐空 updatedBy，已有值原样保留',()=>{
  const ctx={normalizePipelineDefaults:d=>d||{}};
  vm.createContext(ctx);
  vm.runInContext(extractFunction('migratePipelineDefaults'),ctx);
  const p=ctx.migratePipelineDefaults({id:'pl-a',createdBy:'alice'});
  assert.equal(p.createdBy,'alice','已有创建者不受影响');
  assert.equal(p.updatedBy,'','旧数据补空 updatedBy');
  const q=ctx.migratePipelineDefaults({id:'pl-b',updatedBy:'bob'});
  assert.equal(q.updatedBy,'bob','已有 updatedBy 原样保留');
  assert.equal(ctx.migratePipelineDefaults(null),null,'非对象输入安全返回');
});

test('新建流水线：创建者与最后修改人均署当前登录用户',()=>{
  const {ctx,saved}=loadSavePlForm({editId:'',pipeline:null,username:'alice'});
  ctx.savePlForm();
  assert.equal(ctx.pipelines.length,1);
  const p=ctx.pipelines[0];
  assert.equal(p.createdBy,'alice');
  assert.equal(p.updatedBy,'alice','新建即该流水线的最后一次修改');
  assert.equal(saved.length,1);
});

test('编辑保存：创建者不动，最后修改人刷新为当前用户',()=>{
  const p={id:'pl-a',name:'旧名',builtIn:false,createdBy:'alice',updatedBy:'alice',stages:[{id:'s0',name:'检出'}]};
  const {ctx}=loadSavePlForm({editId:'pl-a',pipeline:p,username:'bob'});
  ctx.savePlForm();
  assert.equal(p.createdBy,'alice','已署名创建者不被覆盖');
  assert.equal(p.updatedBy,'bob','每次保存刷新最后修改人');
});

test('编辑存量未署名流水线：补署创建者并刷新最后修改人',()=>{
  const p={id:'pl-b',name:'旧',builtIn:false,stages:[{id:'s0',name:'检出'}]};
  const {ctx}=loadSavePlForm({editId:'pl-b',pipeline:p,username:'carol'});
  ctx.savePlForm();
  assert.equal(p.createdBy,'carol','存量未署名流水线编辑时补署本用户');
  assert.equal(p.updatedBy,'carol');
});

test('未取到登录用户：编辑不改动既有署名，新建留空',()=>{
  const p={id:'pl-c',name:'旧',builtIn:false,createdBy:'alice',updatedBy:'alice',stages:[{id:'s0',name:'检出'}]};
  const {ctx}=loadSavePlForm({editId:'pl-c',pipeline:p,username:''});
  ctx.savePlForm();
  assert.equal(p.createdBy,'alice');
  assert.equal(p.updatedBy,'alice','取不到用户时保持原最后修改人');

  const blank=loadSavePlForm({editId:'',pipeline:null,username:''});
  blank.ctx.savePlForm();
  assert.equal(blank.ctx.pipelines[0].createdBy,'');
  assert.equal(blank.ctx.pipelines[0].updatedBy,'');
});

test('复制流水线：副本创建者与最后修改人均为复制者，不继承源署名',()=>{
  const src={id:'pl-a',name:'源',builtIn:false,createdBy:'alice',updatedBy:'alice',stages:[{id:'s1',name:'构建'}]};
  const ctx={
    findPipeline:id=>(id==='pl-a'?src:null),
    pipelines:[src],
    currentUsername:'bob',
    $:id=>({triggeredBy:{value:''}}[id]||null),
    savePipelines:()=>{},
    running:false,
    selectPipeline:()=>{},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('uniqueCopyName')+'\n'+extractFunction('copyPipeline'),ctx);
  ctx.copyPipeline('pl-a');
  assert.equal(ctx.pipelines.length,2);
  const clone=ctx.pipelines[1];
  assert.notEqual(clone.id,src.id);
  assert.equal(clone.createdBy,'bob');
  assert.equal(clone.updatedBy,'bob');
});

test('拖拽改序：最后修改人刷新为当前用户；取不到用户时不署名',()=>{
  const custom={id:'pl-a',name:'x',builtIn:false,createdBy:'alice',updatedBy:'alice',stages:[{id:'a',name:'甲'},{id:'b',name:'乙'}]};
  function load(username){
    const ctx={
      curPipeline:()=>custom,
      savePipelines:()=>{}, renderPipelines:()=>{}, renderFlow:()=>{}, renderDetail:()=>{},
    };
    if(username){ ctx.currentUsername=username; ctx.$=id=>({triggeredBy:{value:''}}[id]||null); }
    vm.createContext(ctx);
    vm.runInContext(extractFunction('persistFlowOrder'),ctx);
    return ctx;
  }
  load('bob').persistFlowOrder([custom.stages[1],custom.stages[0]]);
  assert.equal(custom.updatedBy,'bob','改序刷新最后修改人');
  assert.equal(custom.createdBy,'alice','改序不动创建者');
  load('').persistFlowOrder([custom.stages[1],custom.stages[0]]);
  assert.equal(custom.updatedBy,'bob','取不到用户时保持原最后修改人');
});

/* 列表行署名展示：复用 test_pipeline_row_run 的假 DOM 套路，只关心行内文本 */
class FakeNode{
  constructor(tag){ this.tag=tag; this.children=[]; this.handlers={}; this._html=''; this.className=''; this.title=''; }
  set innerHTML(value){ this._html=value; if(!value) this.children=[]; }
  get innerHTML(){ return this._html; }
  appendChild(node){ this.children.push(node); }
  addEventListener(type,handler){ this.handlers[type]=handler; }
  querySelectorAll(selector){
    const attr=/^\[([^\]]+)\]$/.exec(selector)[1];
    const buttons=[];
    this.children.forEach(row=>{
      const re=/<button\s+([^>]*)>([^<]*)<\/button>/g;
      let match;
      while((match=re.exec(row.innerHTML))){
        const valueMatch=new RegExp(attr+'="([^"]+)"').exec(match[1]);
        if(!valueMatch) continue;
        const button=new FakeNode('button');
        button.attributes={[attr]:valueMatch[1]};
        button.getAttribute=name=>button.attributes[name]||null;
        buttons.push(button);
      }
    });
    return buttons;
  }
}

function loadRender(pipelines){
  const tbody=new FakeNode('tbody');
  const table={querySelector:selector=>selector==='tbody'?tbody:null};
  const count={textContent:''};
  const ctx={
    pipelines,
    curPipelineId:'',
    activeRuns:[],
    viewRc:null,
    plFilter:{kw:'',owner:'all'},
    plFilterMatch:()=>true,
    renderPlFilterOptions:()=>{},
    currentUsername:'alice',
    document:{createElement:tag=>new FakeNode(tag)},
    $:id=>id==='plTable'?table:count,
    esc:String,
    runPipeline:()=>true,
    showPipelineApi:()=>{},
    findPipeline:id=>pipelines.find(p=>p.id===id),
    selectPipeline:()=>{},
    runsOfPipeline:()=>[],
    latestRunOfPipeline:()=>null,
    focusRun:()=>{},
    openPlForm(){}, copyPipeline(){}, deletePipeline(){}, renderPipelineSel(){},
    flashRunTip:()=>{},
    alert:()=>{},
    QUEUE_CAP:8,
    queue:[],
  };
  vm.createContext(ctx);
  const start=source.indexOf('function renderPipelines(){');
  const end=source.indexOf('/* 运行框流水线下拉',start);
  assert.ok(start>=0&&end>start,'renderPipelines not found');
  vm.runInContext(extractFunction('plOwnerOf')+'\n'+extractFunction('plUpdaterOf')+'\n'+source.slice(start,end),ctx);
  ctx.renderPipelines();
  return {tbody};
}

test('列表行展示创建者与最后修改人：同人免重复、内置与未署名不显示',()=>{
  const {tbody}=loadRender([
    {id:'p1',name:'仅创建',stages:[{name:'构建'}],builtIn:false,createdBy:'alice',updatedBy:'alice'},
    {id:'p2',name:'被修改',stages:[{name:'构建'}],builtIn:false,createdBy:'alice',updatedBy:'bob'},
    {id:'p3',name:'内置',stages:[{name:'检出'}],builtIn:true},
    {id:'p4',name:'未署名',stages:[{name:'构建'}],builtIn:false},
  ]);
  assert.equal(tbody.children.length,4);
  assert.match(tbody.children[0].innerHTML,/创建 @alice/);
  assert.ok(!/修改 @/.test(tbody.children[0].innerHTML),'修改人与创建者相同不重复显示');
  assert.match(tbody.children[1].innerHTML,/创建 @alice · 修改 @bob/,'创建者与修改人不同则都显示');
  assert.ok(!/创建 @|修改 @/.test(tbody.children[2].innerHTML),'内置流水线不显示署名');
  assert.ok(!/创建 @|修改 @/.test(tbody.children[3].innerHTML),'未署名流水线不显示');
});
