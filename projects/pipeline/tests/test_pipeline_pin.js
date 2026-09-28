// 流水线任务列表置顶：行尾「⋯」调出全局悬浮菜单（fixed 定位——悬浮最上层、不被表格 overflow 裁剪、不撑大行高；
// 菜单项为列表行形态非圆边按钮），置顶/取消置顶切换 pinnedAt，置顶项排列表与选用下拉最前（多条按置顶时间新→旧），
// pinnedAt 经 savePipelines→persistState 随服务端同步；复制副本不继承。
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

/* 与 test_pipeline_row_run.js 同款假 DOM：只解析行内 <button>，按钮对象按「属性:值」缓存，
   使 renderPipelines 注册的事件处理器可在测试侧取回触发；另补 style/offsetWidth 供悬浮层定位 */
class FakeNode{
  constructor(tag){ this.tag=tag; this.children=[]; this.handlers={}; this._html=''; this.className=''; this.title=''; this.style={}; this.offsetWidth=0; }
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

/* 切片区域：let plMenuOpenId + closePlRowMenu + openPlRowMenu + togglePipelinePin + renderPipelines + renderPipelineSel，
   外加文件尾的「置顶」列表项绑定单行（同一脚本运行，词法绑定互通）。pinStates：{流水线id: pinnedAt}，预置置顶态。 */
function load(pinStates){
  const tbody=new FakeNode('tbody');
  const table={querySelector:sel=>sel==='tbody'?tbody:null};
  const count={textContent:''};
  const selNode=new FakeNode('select');
  const panel=new FakeNode('div'); panel.style.display='none';   // 与页面内联样式一致：默认收起
  const pinItem=new FakeNode('div');
  const favoriteItem=new FakeNode('div');
  const saves=[];
  const ctx={
    pipelines:[
      {id:'pipe-1',name:'内置流水线',stages:[{name:'检出'}],builtIn:true,pinnedAt:(pinStates&&pinStates['pipe-1'])||0},
      {id:'pipe-2',name:'流水线二',stages:[{name:'构建'}],builtIn:false,pinnedAt:(pinStates&&pinStates['pipe-2'])||0},
      {id:'pipe-3',name:'流水线三',stages:[{name:'部署'}],builtIn:false,pinnedAt:(pinStates&&pinStates['pipe-3'])||0},
    ],
    curPipelineId:'pipe-1',
    plFilter:{kw:'',owner:'all'},
    plFilterMatch:()=>true,   // 筛选桩：置顶测试不涉及筛选语义，全部行进视图
    renderPlFilterOptions:()=>{},
    plOwnerOf:()=>'', plUpdaterOf:()=>'',   // 署名桩：置顶测试不涉及署名展示
    plEditable:p=>!p||!p.builtIn,   // 归属桩：置顶测试不涉及归属限制，等价「仅内置只读」旧行为
    isPipelineFavorite:()=>false,
    pipelineQueueCounts:()=>({}), pipelineQueueCountHtml:()=>'—',   // 置顶测试不涉及队列计数
    currentUsername:'',
    document:{createElement:tag=>new FakeNode(tag)},
    $:id=>({plTable:table, pipelineSel:selNode, plRowMenuPanel:panel, plRowMenuPin:pinItem, plRowMenuFavorite:favoriteItem})[id]||count,
    esc:String,
    curPipeline:()=>null,
    runPipeline:()=>true,
    showPipelineApi:()=>{},
    findPipeline:id=>ctx.pipelines.find(p=>p.id===id),
    selectPipeline:()=>{},
    openPlForm(){}, copyPipeline(){}, deletePipeline(){},
    savePipelines:()=>{ saves.push(1); },
    flashRunTip:()=>{},
    alert:()=>{},
    QUEUE_CAP:16,
    queue:[],
  };
  vm.createContext(ctx);
  const start=source.indexOf('/* 行内「⋯」菜单当前展开项');
  const end=source.indexOf('function selectPipeline',start);
  const bindStart=source.indexOf("$('plRowMenuPin').addEventListener");
  const bindEnd=source.indexOf('\n',bindStart);
  assert.ok(start>=0&&end>start,'置顶相关代码区域未找到');
  assert.ok(bindStart>=0&&bindEnd>bindStart,'「置顶」列表项绑定未找到');
  vm.runInContext(source.slice(start,end)+'\n'+source.slice(bindStart,bindEnd),ctx);
  ctx.renderPipelines();
  return {ctx,tbody,selNode,panel,pinItem,saves};
}

test('未置顶时保持数组原序，行尾有 ⋯ 按钮，菜单不嵌在行内、悬浮层默认收起',()=>{
  const {tbody,selNode,panel}=load();
  assert.equal(tbody.children.length,3);
  assert.match(tbody.children[0].innerHTML,/内置流水线/);
  assert.match(tbody.children[1].innerHTML,/流水线二/);
  assert.match(tbody.children[2].innerHTML,/流水线三/);
  assert.doesNotMatch(tbody.children[0].innerHTML,/>置顶<\/span>/,'未置顶不显示置顶徽标');
  const menus=tbody.querySelectorAll('[data-plmenu]');
  assert.equal(menus.length,3);
  assert.equal(menus[1].textContent,'⋯');
  assert.doesNotMatch(tbody.children[1].innerHTML,/plmenupanel|pl-row-menu-item/,'菜单层不嵌在行内（不占文档流、不撑大行高）');
  assert.equal(panel.style.display,'none','悬浮菜单层默认收起');
  assert.deepEqual(selNode.children.map(o=>o.value),['pipe-1','pipe-2','pipe-3'],'运行框下拉同数组原序');
});

test('预置 pinnedAt：置顶排最前，多条按置顶时间新→旧，下拉同步',()=>{
  const {tbody,selNode}=load({'pipe-2':100,'pipe-3':200});
  assert.match(tbody.children[0].innerHTML,/流水线三/,'置顶时间新的在最前');
  assert.match(tbody.children[1].innerHTML,/流水线二/);
  assert.match(tbody.children[2].innerHTML,/内置流水线/,'未置顶的内置保持原数组首位');
  assert.match(tbody.children[0].innerHTML,/>置顶<\/span>/,'置顶行显示置顶徽标');
  assert.doesNotMatch(tbody.children[2].innerHTML,/>置顶<\/span>/);
  assert.deepEqual(selNode.children.map(o=>o.value),['pipe-3','pipe-2','pipe-1']);
});

test('点 ⋯ 展开悬浮菜单：fixed 定位对齐锚按钮、列表项文案随置顶态；再点收起',()=>{
  const {tbody,panel,pinItem}=load();
  panel.offsetWidth=88;
  const btn=tbody.querySelectorAll('[data-plmenu]')[1];
  btn.getBoundingClientRect=()=>({right:500,bottom:100});
  const evt={stopped:false,stopPropagation(){ this.stopped=true; }};
  btn.handlers.click(evt);
  assert.equal(evt.stopped,true,'⋯ 点击阻止冒泡（不触发行选用）');
  assert.equal(panel.style.display,'block','悬浮层展开');
  assert.equal(panel.style.left,'412px','右缘对齐 ⋯ 按钮（500-88）');
  assert.equal(panel.style.top,'104px','下缘贴按钮底部');
  assert.equal(pinItem.textContent,'置顶','未置顶时列表项为「置顶」');
  assert.match(pinItem.title,/置顶到列表最前/);
  assert.match(tbody.children[1].innerHTML,/流水线二/,'开合菜单不重渲染任务表');
  tbody.querySelectorAll('[data-plmenu]')[1].handlers.click({stopPropagation(){}});
  assert.equal(panel.style.display,'none','再点 ⋯ 收起');
});

test('列表项置顶：pinnedAt 置位并落盘、排最前、菜单收起；取消置顶恢复原序',()=>{
  const {ctx,tbody,selNode,panel,pinItem,saves}=load();
  tbody.querySelectorAll('[data-plmenu]')[1].handlers.click({stopPropagation(){}});   // 展开（pipe-2）
  pinItem.handlers.click({stopPropagation(){}});   // 点「置顶」列表项
  const p2=ctx.pipelines.find(p=>p.id==='pipe-2');
  assert.ok(p2.pinnedAt>0,'置顶写入 pinnedAt 时间戳');
  assert.equal(saves.length,1,'置顶经 savePipelines 落盘（localStorage + 服务端同步）');
  assert.equal(panel.style.display,'none','切换后菜单收起');
  assert.match(tbody.children[0].innerHTML,/流水线二/,'置顶后排列表最前');
  assert.match(tbody.children[0].innerHTML,/>置顶<\/span>/,'置顶徽标展示');
  assert.deepEqual(selNode.children.map(o=>o.value),['pipe-2','pipe-1','pipe-3'],'运行框下拉同步置顶序');
  tbody.querySelectorAll('[data-plmenu]')[0].handlers.click({stopPropagation(){}});   // 展开（已在首位的 pipe-2）
  assert.equal(pinItem.textContent,'取消置顶','已置顶时列表项为「取消置顶」');
  pinItem.handlers.click({stopPropagation(){}});   // 点「取消置顶」
  assert.equal(p2.pinnedAt,0,'取消置顶清空 pinnedAt');
  assert.equal(saves.length,2,'取消置顶同样落盘');
  assert.equal(panel.style.display,'none');
  assert.match(tbody.children[0].innerHTML,/内置流水线/,'取消置顶恢复数组原序');
  assert.deepEqual(selNode.children.map(o=>o.value),['pipe-1','pipe-2','pipe-3']);
});

test('复制流水线：副本不继承置顶',()=>{
  const srcPipe={id:'pl-a',name:'源',builtIn:false,pinnedAt:12345,createdBy:'alice',updatedBy:'alice',stages:[{id:'s1',name:'构建'}]};
  const ctx={
    findPipeline:id=>(id==='pl-a'?srcPipe:null),
    pipelines:[srcPipe],
    currentUsername:'bob',
    savePipelines:()=>{},
    running:false,
    selectPipeline:()=>{},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('uniqueCopyName')+'\n'+extractFunction('copyPipeline'),ctx);
  ctx.copyPipeline('pl-a');
  assert.equal(ctx.pipelines.length,2);
  assert.equal(ctx.pipelines[1].pinnedAt,0,'副本 pinnedAt 清零，不占置顶位');
});
