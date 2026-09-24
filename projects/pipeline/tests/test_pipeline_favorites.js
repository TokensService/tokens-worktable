// 流水线收藏：按登录用户名隔离，随流水线配置同步；收藏筛选只匹配当前用户，复制副本不继承收藏。
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

function loadFavoriteActions(username, favoriteUsers){
  const pipeline={id:'pipe-1',name:'流水线一',stages:[],favoriteUsers:favoriteUsers.slice()};
  const saves=[],renders=[],alerts=[];
  const ctx={
    pipelines:[pipeline],
    currentUsername:username,
    findPipeline:id=>id===pipeline.id?pipeline:null,
    savePipelines:()=>saves.push(JSON.stringify(pipeline.favoriteUsers)),
    renderPipelines:()=>renders.push(1),
    alert:message=>alerts.push(message),
  };
  vm.createContext(ctx);
  vm.runInContext([
    extractFunction('pipelineFavoriteUsers'),
    extractFunction('isPipelineFavorite'),
    extractFunction('togglePipelineFavorite'),
  ].join('\n'),ctx);
  return {ctx,pipeline,saves,renders,alerts};
}

function loadFavoriteFilter(username){
  const ctx={currentUsername:username,plFilter:{kw:'',owner:'all',favorite:'favorite'}};
  vm.createContext(ctx);
  vm.runInContext([
    extractFunction('plOwnerOf'),
    extractFunction('pipelineFavoriteUsers'),
    extractFunction('isPipelineFavorite'),
    extractFunction('plFilterMatch'),
  ].join('\n'),ctx);
  return ctx;
}

function loadFilterBindings(initialFilter){
  const nodes={};
  ['plFilterKw','plFilterOwner','plFilterFavorite','plFilterClear'].forEach(id=>{
    nodes[id]={value:'',handlers:{},addEventListener(type,handler){ this.handlers[type]=handler; }};
  });
  const saves=[],renders=[];
  const ctx={
    plFilter:Object.assign({},initialFilter),
    plPage:3,
    $:id=>nodes[id],
    savePlFilter:()=>saves.push(Object.assign({},ctx.plFilter)),
    renderPipelines:()=>renders.push(1),
  };
  vm.createContext(ctx);
  const start=source.indexOf('/* 流水线任务筛选：关键字 + 创建者');
  const end=source.indexOf('function labelOf',start);
  assert.ok(start>=0&&end>start,'流水线筛选控件绑定区域未找到');
  vm.runInContext(source.slice(start,end),ctx);
  return {ctx,nodes,saves,renders};
}

class FakeNode{
  constructor(tag){ this.tag=tag; this.children=[]; this.handlers={}; this._html=''; this.className=''; this.title=''; this.textContent=''; this.style={}; this.offsetWidth=88; }
  set innerHTML(value){ this._html=value; if(!value) this.children=[]; }
  get innerHTML(){ return this._html; }
  appendChild(node){ this.children.push(node); }
  addEventListener(type,handler){ this.handlers[type]=handler; }
  querySelectorAll(selector){
    const attr=/^\[([^\]]+)\]$/.exec(selector)[1],buttons=[];
    this.children.forEach(row=>{
      const re=/<button\s+([^>]*)>([^<]*)<\/button>/g;let match;
      while((match=re.exec(row.innerHTML))){
        const valueMatch=new RegExp(attr+'="([^"]+)"').exec(match[1]);
        if(!valueMatch) continue;
        const key=attr+':'+valueMatch[1];
        row._buttons=row._buttons||{};
        const button=row._buttons[key]||new FakeNode('button');
        button.attributes={[attr]:valueMatch[1]};
        button.textContent=match[2];
        button.getAttribute=name=>button.attributes[name]||null;
        row._buttons[key]=button;
        buttons.push(button);
      }
    });
    return buttons;
  }
}

function loadFavoriteUi(username){
  const tbody=new FakeNode('tbody'),table={querySelector:selector=>selector==='tbody'?tbody:null};
  const panel=new FakeNode('div'),pinItem=new FakeNode('div'),favoriteItem=new FakeNode('div'),historyItem=new FakeNode('div');   // historyItem：openPlRowMenu 守卫纳入「运行历史」菜单项后的配套桩
  const select=new FakeNode('select'),count=new FakeNode('span'),tip=new FakeNode('span');
  panel.style.display='none';
  const saves=[];
  const ctx={
    pipelines:[
      {id:'pipe-a',name:'Alice 收藏',stages:[{name:'构建'}],builtIn:false,pinnedAt:0,favoriteUsers:['alice']},
      {id:'pipe-b',name:'Bob 收藏',stages:[{name:'部署'}],builtIn:false,pinnedAt:0,favoriteUsers:['bob']},
    ],
    curPipelineId:'pipe-a',currentUsername:username,plFilter:{kw:'',owner:'all',favorite:'all'},
    plFilterMatch:()=>true,renderPlFilterOptions:()=>{},plOwnerOf:()=>'',plUpdaterOf:()=>'',
    plEditable:p=>!p||!p.builtIn,   // 归属桩：收藏测试不涉及归属限制，等价「仅内置只读」旧行为
    pipelineQueueCounts:()=>({}),pipelineQueueCountHtml:()=>'—',   // 收藏用例隔离运行队列计数
    document:{createElement:tag=>new FakeNode(tag)},
    $:id=>({plTable:table,pipelineSel:select,plCount:count,plFilterTip:tip,plRowMenuPanel:panel,plRowMenuPin:pinItem,plRowMenuFavorite:favoriteItem,plRowMenuHistory:historyItem})[id],
    esc:String,curPipeline:()=>ctx.pipelines[0],findPipeline:id=>ctx.pipelines.find(p=>p.id===id),
    runPipeline:()=>true,showPipelineApi:()=>{},selectPipeline:()=>{},openPlForm:()=>{},copyPipeline:()=>{},deletePipeline:()=>{},
    savePipelines:()=>saves.push(1),flashRunTip:()=>{},alert:()=>{},
  };
  vm.createContext(ctx);
  const start=source.indexOf('/* 行内「⋯」菜单当前展开项');
  const end=source.indexOf('function selectPipeline',start);
  assert.ok(start>=0&&end>start,'流水线菜单与列表区域未找到');
  vm.runInContext([
    extractFunction('pipelineFavoriteUsers'),
    extractFunction('isPipelineFavorite'),
    extractFunction('togglePipelineFavorite'),
    source.slice(start,end),
  ].join('\n'),ctx);
  ctx.renderPipelines();
  return {ctx,tbody,panel,pinItem,favoriteItem,saves};
}

function bindFavoriteMenu(ctx){
  const start=source.indexOf("$('plRowMenuFavorite').addEventListener");
  const end=source.indexOf('\n',start);
  assert.ok(start>=0&&end>start,'收藏菜单点击绑定未找到');
  vm.runInContext(source.slice(start,end),ctx);
}

function migrateFavoriteUsers(pipeline){
  const ctx={PIPELINE_DEFAULT_PRESET_KEYS:['cleanup','check','profiling']};
  vm.createContext(ctx);
  vm.runInContext(extractFunction('pipelineFavoriteUsers')+'\n'+extractFunction('pipelineDefaultStringList')+'\n'+extractFunction('normalizePipelineDefaults')+'\n'+extractFunction('migratePipelineDefaults'),ctx);
  return ctx.migratePipelineDefaults(pipeline);
}

test('收藏切换只增删当前用户，保留其他用户并经保存链路同步',()=>{
  const {ctx,pipeline,saves,renders}=loadFavoriteActions('alice',['bob']);
  assert.equal(ctx.isPipelineFavorite(pipeline),false);

  ctx.togglePipelineFavorite('pipe-1');
  assert.deepEqual(Array.from(pipeline.favoriteUsers),['bob','alice']);
  assert.equal(ctx.isPipelineFavorite(pipeline),true);
  assert.equal(saves.length,1,'收藏经 savePipelines 同步本地与服务端');
  assert.equal(renders.length,1,'收藏后立即重绘列表');

  ctx.togglePipelineFavorite('pipe-1');
  assert.deepEqual(Array.from(pipeline.favoriteUsers),['bob'],'取消收藏不能清除 Bob 的收藏');
  assert.equal(ctx.isPipelineFavorite(pipeline),false);
  assert.equal(saves.length,2);
  assert.equal(renders.length,2);
});

test('未获取登录用户名时拒绝收藏且不写入空用户',()=>{
  const {ctx,pipeline,saves,renders,alerts}=loadFavoriteActions('',['bob']);
  ctx.togglePipelineFavorite('pipe-1');
  assert.deepEqual(Array.from(pipeline.favoriteUsers),['bob']);
  assert.equal(saves.length,0);
  assert.equal(renders.length,0);
  assert.deepEqual(alerts,['未获取到当前登录用户，无法收藏流水线。']);
});

test('仅看收藏按当前登录用户筛选共享流水线',()=>{
  const ctx=loadFavoriteFilter('alice');
  const aliceFavorite={id:'pipe-a',name:'构建',stages:[],builtIn:false,createdBy:'bob',favoriteUsers:['alice']};
  const bobFavorite={id:'pipe-b',name:'部署',stages:[],builtIn:false,createdBy:'bob',favoriteUsers:['bob']};
  assert.equal(ctx.plFilterMatch(aliceFavorite),true);
  assert.equal(ctx.plFilterMatch(bobFavorite),false,'不能显示仅由其他用户收藏的流水线');

  ctx.currentUsername='bob';
  assert.equal(ctx.plFilterMatch(aliceFavorite),false);
  assert.equal(ctx.plFilterMatch(bobFavorite),true);
});

test('收藏筛选控件恢复、保存选择，清除时回到全部',()=>{
  const {ctx,nodes,saves,renders}=loadFilterBindings({kw:'部署',owner:'all',favorite:'favorite'});
  assert.equal(nodes.plFilterFavorite.value,'favorite','刷新后恢复仅看收藏');
  assert.equal(typeof nodes.plFilterFavorite.handlers.change,'function');

  nodes.plFilterFavorite.handlers.change({target:{value:'all'}});
  assert.equal(ctx.plFilter.favorite,'all');
  assert.equal(ctx.plPage,0,'筛选条件变化后回到第一页');
  assert.deepEqual(saves.at(-1),{kw:'部署',owner:'all',favorite:'all'});
  assert.equal(renders.length,1);

  ctx.plPage=2;
  nodes.plFilterClear.handlers.click();
  assert.deepEqual(Object.assign({},ctx.plFilter),{kw:'',owner:'mine',favorite:'all'});
  assert.equal(ctx.plPage,0,'清除筛选后回到第一页');
  assert.equal(nodes.plFilterFavorite.value,'all');
  assert.equal(saves.length,2);
  assert.equal(renders.length,2);
});

test('列表星标与更多菜单只反映当前用户的收藏状态',()=>{
  const {tbody,favoriteItem}=loadFavoriteUi('alice');
  assert.match(tbody.children[0].innerHTML,/★ 收藏/,'Alice 收藏的流水线显示星标');
  assert.doesNotMatch(tbody.children[1].innerHTML,/★ 收藏/,'Bob 的个人收藏不应展示给 Alice');

  const menuButtons=tbody.querySelectorAll('[data-plmenu]');
  menuButtons[0].getBoundingClientRect=()=>({right:500,bottom:100});
  menuButtons[0].handlers.click({stopPropagation(){}});
  assert.equal(favoriteItem.textContent,'取消收藏');
  menuButtons[1].getBoundingClientRect=()=>({right:500,bottom:130});
  menuButtons[1].handlers.click({stopPropagation(){}});
  assert.equal(favoriteItem.textContent,'收藏');
});

test('点击收藏菜单项切换当前用户收藏并收起菜单',()=>{
  const {ctx,tbody,panel,favoriteItem,saves}=loadFavoriteUi('alice');
  bindFavoriteMenu(ctx);
  const button=tbody.querySelectorAll('[data-plmenu]')[1];
  button.getBoundingClientRect=()=>({right:500,bottom:100});
  button.handlers.click({stopPropagation(){}});
  assert.equal(panel.style.display,'block');

  const event={stopped:false,stopPropagation(){ this.stopped=true; }};
  favoriteItem.handlers.click(event);
  assert.equal(event.stopped,true);
  assert.equal(panel.style.display,'none');
  assert.deepEqual(Array.from(ctx.pipelines[1].favoriteUsers),['bob','alice']);
  assert.equal(saves.length,1);
});

test('复制流水线不继承任何用户的收藏',()=>{
  const sourcePipeline={id:'pipe-a',name:'源',stages:[],builtIn:false,pinnedAt:10,createdBy:'alice',updatedBy:'alice',favoriteUsers:['alice','bob']};
  const ctx={
    pipelines:[sourcePipeline],currentUsername:'carol',running:false,
    findPipeline:id=>id===sourcePipeline.id?sourcePipeline:null,
    savePipelines:()=>{},selectPipeline:()=>{},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('uniqueCopyName')+'\n'+extractFunction('copyPipeline'),ctx);
  ctx.copyPipeline('pipe-a');
  assert.equal(ctx.pipelines.length,2);
  assert.deepEqual(Array.from(ctx.pipelines[1].favoriteUsers),[]);
});

test('加载或导入时把收藏用户迁移为去重的有效用户名数组',()=>{
  const migrated=migrateFavoriteUsers({defaults:{},favoriteUsers:[' alice ','alice',null,'','bob',42]});
  assert.deepEqual(Array.from(migrated.favoriteUsers),['alice','bob']);
  const legacy=migrateFavoriteUsers({defaults:{}});
  assert.deepEqual(Array.from(legacy.favoriteUsers),[],'旧流水线补空收藏数组');
});
