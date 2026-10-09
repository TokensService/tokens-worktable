// 流水线任务列表「拥有者」筛选（可搜索组合框 input+datalist）：显示文本↔模式键映射与回显、
// 用户名精确匹配、非精确输入的子串搜索（大小写不敏感）、datalist 选项填充、localStorage 旧值兼容。
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

function loadHelpers(){
  const ctx={};
  vm.createContext(ctx);
  vm.runInContext(extractFunction('plOwnerFilterLabel')+'\n'+extractFunction('plOwnerFilterValue'),ctx);
  return ctx;
}

/* 与 test_pipeline_favorites.js 同一套路：截取筛选控件绑定区段，节点为 input+datalist 形态桩 */
function loadFilterBindings(owner){
  const nodes={};
  ['plFilterKw','plFilterOwner','plFilterFavorite','plFilterClear'].forEach(id=>{
    nodes[id]={value:'',handlers:{},addEventListener(type,handler){ this.handlers[type]=handler; }};
  });
  nodes.plFilterOwner.list='plOwnerList';   /* 拥有者筛选为 input+datalist 组合框形态 */
  const saves=[],renders=[];
  const ctx={
    plFilter:{kw:'',owner,favorite:'all'},
    plPage:2,
    $:id=>nodes[id],
    savePlFilter:()=>saves.push(Object.assign({},ctx.plFilter)),
    renderPipelines:()=>renders.push(1),
  };
  vm.createContext(ctx);
  const start=source.indexOf('/* 流水线任务筛选：关键字 + 拥有者');
  const end=source.indexOf('function labelOf',start);
  assert.ok(start>=0&&end>start,'流水线筛选控件绑定区域未找到');
  vm.runInContext(source.slice(start,end),ctx);
  return {ctx,nodes,saves,renders};
}

function loadMatcher(owner){
  const ctx={
    pipelines:[
      {id:'p1',name:'甲',stages:[],createdBy:'alice'},
      {id:'p2',name:'乙',stages:[],createdBy:'alicia'},
      {id:'p3',name:'丙',stages:[],createdBy:'bob'},
      {id:'p4',name:'丁',stages:[],builtIn:true},
      {id:'p5',name:'戊',stages:[]},
    ],
    currentUsername:'alice',
    plFilter:{kw:'',owner,favorite:'all'},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('plOwnerOf')+'\n'+extractFunction('plFilterMatch'),ctx);
  return ctx;
}

function loadOwnerOptions(pipelines,owner){
  const inp={value:''};
  const list={_html:'',set innerHTML(v){ this._html=v; },get innerHTML(){ return this._html; }};
  const ctx={
    pipelines,
    plFilter:{kw:'',owner:owner||'mine',favorite:'all'},
    _plOwnerSig:'',
    document:{activeElement:null},
    esc:String,
    $:id=>({plFilterOwner:inp,plOwnerList:list})[id]||null,
  };
  vm.createContext(ctx);
  vm.runInContext([
    extractFunction('plOwnerOf'),
    extractFunction('plOwnerFilterLabel'),
    extractFunction('renderPlFilterOptions'),
  ].join('\n'),ctx);
  return {ctx,inp,list};
}

function loadPlFilterFromStorage(stored){
  const ctx={localStorage:{getItem:k=>k==='pip-plFilter'?stored:null,setItem(){}}};
  vm.createContext(ctx);
  const start=source.indexOf('/* 流水线任务筛选状态');
  const end=source.indexOf('function savePlFilter',start);
  assert.ok(start>=0&&end>start,'plFilter 状态声明区域未找到');
  return vm.runInContext(source.slice(start,end)+';plFilter;',ctx);
}

test('筛选栏为「拥有者」input+datalist 组合框（不再是 select）',()=>{
  assert.match(source,/>拥有者\s*<input id="plFilterOwner"[^>]*list="plOwnerList"/);
  assert.match(source,/<datalist id="plOwnerList"><\/datalist>/);
  assert.doesNotMatch(source,/<select id="plFilterOwner"/);
});

test('显示文本 ↔ 模式键映射：特殊标签往返、用户名原样、空输入回退 mine',()=>{
  const ctx=loadHelpers();
  assert.equal(ctx.plOwnerFilterLabel('mine'),'我的（含预置）');
  assert.equal(ctx.plOwnerFilterLabel('all'),'全部');
  assert.equal(ctx.plOwnerFilterLabel('builtin'),'仅预置');
  assert.equal(ctx.plOwnerFilterLabel('unknown'),'未署名');
  assert.equal(ctx.plOwnerFilterLabel('alice'),'alice','用户名原样显示');
  assert.equal(ctx.plOwnerFilterValue('我的（含预置）'),'mine');
  assert.equal(ctx.plOwnerFilterValue('全部'),'all');
  assert.equal(ctx.plOwnerFilterValue('仅预置'),'builtin');
  assert.equal(ctx.plOwnerFilterValue('未署名'),'unknown');
  assert.equal(ctx.plOwnerFilterValue('alice'),'alice','用户名原样通过');
  assert.equal(ctx.plOwnerFilterValue('  alice  '),'alice','首尾空白裁剪');
  assert.equal(ctx.plOwnerFilterValue(''),'mine','空输入回退默认模式');
  assert.equal(ctx.plOwnerFilterValue('   '),'mine');
  for(const m of ['mine','all','builtin','unknown']) assert.equal(ctx.plOwnerFilterValue(ctx.plOwnerFilterLabel(m)),m,'特殊模式标签↔键往返');
});

test('组合框初始化回显：模式键→中文标签，用户名原样',()=>{
  assert.equal(loadFilterBindings('mine').nodes.plFilterOwner.value,'我的（含预置）');
  assert.equal(loadFilterBindings('all').nodes.plFilterOwner.value,'全部');
  assert.equal(loadFilterBindings('builtin').nodes.plFilterOwner.value,'仅预置');
  assert.equal(loadFilterBindings('unknown').nodes.plFilterOwner.value,'未署名');
  assert.equal(loadFilterBindings('bob').nodes.plFilterOwner.value,'bob');
});

test('组合框输入：标签解析为模式键、用户名原样写入、归首页并保存重绘',()=>{
  const {ctx,nodes,saves,renders}=loadFilterBindings('mine');
  assert.equal(typeof nodes.plFilterOwner.handlers.input,'function');
  assert.equal(typeof nodes.plFilterOwner.handlers.change,'function');
  nodes.plFilterOwner.handlers.input({target:{value:'全部'}});
  assert.equal(ctx.plFilter.owner,'all');
  assert.equal(ctx.plPage,0,'筛选条件变化后回到第一页');
  nodes.plFilterOwner.handlers.input({target:{value:'carol'}});
  assert.equal(ctx.plFilter.owner,'carol');
  assert.equal(renders.length,2);
  nodes.plFilterOwner.handlers.change({target:{value:'仅预置'}});   /* change 兜底（datalist 点选） */
  assert.equal(ctx.plFilter.owner,'builtin');
  assert.equal(renders.length,3);
  assert.equal(saves.length,3);
  nodes.plFilterClear.handlers.click();
  assert.equal(ctx.plFilter.owner,'mine');
  assert.equal(nodes.plFilterOwner.value,'我的（含预置）','清除后回显默认模式标签');
});

test('拥有者筛选：特殊模式键 mine/all/builtin/unknown 语义不变',()=>{
  let ctx=loadMatcher('mine');
  assert.deepEqual(ctx.pipelines.filter(ctx.plFilterMatch).map(p=>p.id),['p1','p4'],'mine=内置+本用户拥有');
  ctx=loadMatcher('all');
  assert.equal(ctx.pipelines.filter(ctx.plFilterMatch).length,5);
  ctx=loadMatcher('builtin');
  assert.deepEqual(ctx.pipelines.filter(ctx.plFilterMatch).map(p=>p.id),['p4']);
  ctx=loadMatcher('unknown');
  assert.deepEqual(ctx.pipelines.filter(ctx.plFilterMatch).map(p=>p.id),['p5'],'未署名=非内置且无拥有者');
});

test('拥有者筛选：等于已知用户名时精确匹配（不因子串波及前缀相近的其他用户）',()=>{
  const ctx=loadMatcher('alice');
  assert.deepEqual(ctx.pipelines.filter(ctx.plFilterMatch).map(p=>p.id),['p1'],'alice 为已知用户名，只精确命中，不波及 alicia');
  const bob=loadMatcher('bob');
  assert.deepEqual(bob.pipelines.filter(bob.plFilterMatch).map(p=>p.id),['p3']);
});

test('拥有者筛选：非已知用户名的输入按子串大小写不敏感搜索',()=>{
  let ctx=loadMatcher('ALI');
  assert.deepEqual(ctx.pipelines.filter(ctx.plFilterMatch).map(p=>p.id),['p1','p2'],'片段大小写不敏感命中 alice 与 alicia');
  ctx=loadMatcher('lic');
  assert.deepEqual(ctx.pipelines.filter(ctx.plFilterMatch).map(p=>p.id),['p1','p2']);
  ctx=loadMatcher('BOB');
  assert.deepEqual(ctx.pipelines.filter(ctx.plFilterMatch).map(p=>p.id),['p3']);
  ctx=loadMatcher('nobody');
  assert.deepEqual(ctx.pipelines.filter(ctx.plFilterMatch).map(p=>p.id),[],'无命中则空列表');
});

test('datalist 选项：特殊项 + 去重排序的拥有者用户名；无未署名流水线时不含「未署名」',()=>{
  const {ctx,list}=loadOwnerOptions([
    {id:'p1',name:'',stages:[],createdBy:'zoe'},
    {id:'p2',name:'',stages:[],createdBy:'amy'},
    {id:'p3',name:'',stages:[],createdBy:'zoe'},
    {id:'p4',name:'',stages:[],builtIn:true},
  ]);
  ctx.renderPlFilterOptions();
  const opts=[...list.innerHTML.matchAll(/<option value="([^"]*)"><\/option>/g)].map(m=>m[1]);
  assert.deepEqual(opts,['我的（含预置）','全部','仅预置','amy','zoe'],'特殊项在前，用户名去重排序');
});

test('datalist 选项：存在未署名流水线时追加「未署名」；签名去重避免无谓重建',()=>{
  const {ctx,list}=loadOwnerOptions([
    {id:'p1',name:'',stages:[],createdBy:'amy'},
    {id:'p2',name:'',stages:[]},
  ]);
  ctx.renderPlFilterOptions();
  assert.ok(list.innerHTML.includes('<option value="未署名"></option>'));
  const first=list.innerHTML;
  ctx.renderPlFilterOptions();
  assert.equal(list.innerHTML,first,'拥有者集合未变不重建');
  ctx.pipelines.push({id:'p3',name:'',stages:[],createdBy:'bob'});
  ctx.renderPlFilterOptions();
  assert.ok(list.innerHTML.includes('<option value="bob"></option>'),'新增拥有者触发重建');
  ctx.pipelines.splice(1,1);   /* 移除未署名流水线 */
  ctx.renderPlFilterOptions();
  assert.ok(!list.innerHTML.includes('未署名'),'未署名流水线消失后重建去掉「未署名」');
});

test('回显幂等且不打扰输入：聚焦时不回写，非聚焦时同步显示当前筛选',()=>{
  const {ctx,inp}=loadOwnerOptions([{id:'p1',name:'',stages:[],createdBy:'amy'}]);
  ctx.renderPlFilterOptions();
  assert.equal(inp.value,'我的（含预置）','非聚焦回显当前模式标签');
  ctx.renderPlFilterOptions();
  assert.equal(inp.value,'我的（含预置）','重复调用幂等');
  ctx.plFilter.owner='amy'; inp.value='正在输入'; ctx.document.activeElement=inp;
  ctx.renderPlFilterOptions();
  assert.equal(inp.value,'正在输入','聚焦（搜索输入中）不回写');
  ctx.document.activeElement=null;
  ctx.renderPlFilterOptions();
  assert.equal(inp.value,'amy','失焦后回显用户名原文');
});

test('localStorage 旧值兼容：特殊模式键与旧用户名载入后照常生效',()=>{
  for(const owner of ['mine','all','builtin','unknown','legacy-user']){
    const f=loadPlFilterFromStorage(JSON.stringify({kw:'',owner,favorite:'all'}));
    assert.equal(f.owner,owner,'旧值 '+owner+' 原样载入');
  }
  /* 旧用户名载入后仍能筛选：等于某条流水线署名时精确命中 */
  const ctx=loadMatcher('legacy-user');
  ctx.pipelines.push({id:'p6',name:'旧',stages:[],createdBy:'legacy-user'});
  assert.deepEqual(ctx.pipelines.filter(ctx.plFilterMatch).map(p=>p.id),['p6']);
  /* 存「all」旧值回显为「全部」标签（接线初始化路径） */
  assert.equal(loadFilterBindings(loadPlFilterFromStorage(JSON.stringify({kw:'',owner:'all',favorite:'all'})).owner).nodes.plFilterOwner.value,'全部');
});
