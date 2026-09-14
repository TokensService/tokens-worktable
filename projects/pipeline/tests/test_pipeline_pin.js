// 流水线任务列表置顶：行内「⋯」菜单调出置顶/取消置顶，置顶项排列表与运行框下拉最前（多条按置顶时间新→旧），
// pinnedAt 经 savePipelines→persistState 随服务端同步；复制副本不继承置顶。
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
   使 renderPipelines 注册的事件处理器可在测试侧取回触发（重渲染后旧行对象随 innerHTML 清空失效） */
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

/* 切片区域：let plMenuOpenId + togglePipelinePin + renderPipelines + renderPipelineSel（同一脚本运行，词法绑定互通）。
   pinStates：{流水线id: pinnedAt}，预置置顶态。 */
function load(pinStates){
  const tbody=new FakeNode('tbody');
  const table={querySelector:sel=>sel==='tbody'?tbody:null};
  const count={textContent:''};
  const selNode=new FakeNode('select');
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
    currentUsername:'',
    document:{createElement:tag=>new FakeNode(tag)},
    $:id=>id==='plTable'?table:(id==='pipelineSel'?selNode:count),
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
  assert.ok(start>=0&&end>start,'置顶相关代码区域未找到');
  vm.runInContext(source.slice(start,end),ctx);
  ctx.renderPipelines();
  return {ctx,tbody,selNode,saves};
}

test('未置顶时保持数组原序，每行右侧带 ⋯ 菜单（默认收起）',()=>{
  const {tbody,selNode}=load();
  assert.equal(tbody.children.length,3);
  assert.match(tbody.children[0].innerHTML,/内置流水线/);
  assert.match(tbody.children[1].innerHTML,/流水线二/);
  assert.match(tbody.children[2].innerHTML,/流水线三/);
  assert.doesNotMatch(tbody.children[0].innerHTML,/>置顶<\/span>/,'未置顶不显示置顶徽标');
  const menus=tbody.querySelectorAll('[data-plmenu]');
  assert.equal(menus.length,3);
  assert.equal(menus[1].textContent,'⋯');
  assert.match(tbody.children[1].innerHTML,/data-plmenupanel="pipe-2" style="display:none;/,'菜单面板默认收起');
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

test('点 ⋯ 展开/收起行内菜单，不触发行选用',()=>{
  const {tbody}=load();
  const evt={stopped:false,stopPropagation(){ this.stopped=true; }};
  tbody.querySelectorAll('[data-plmenu]')[1].handlers.click(evt);
  assert.equal(evt.stopped,true,'⋯ 点击阻止冒泡（不选用流水线）');
  assert.match(tbody.children[1].innerHTML,/data-plmenupanel="pipe-2" style="display:block;/,'重渲染后面板展开');
  assert.match(tbody.children[0].innerHTML,/data-plmenupanel="pipe-1" style="display:none;/,'其他行菜单保持收起');
  assert.equal(tbody.querySelectorAll('[data-plpin]')[1].textContent,'置顶','未置顶时菜单项为「置顶」');
  tbody.querySelectorAll('[data-plmenu]')[1].handlers.click({stopPropagation(){}});
  assert.match(tbody.children[1].innerHTML,/data-plmenupanel="pipe-2" style="display:none;/,'再点 ⋯ 收起');
});

test('菜单置顶：pinnedAt 置位并落盘、排最前、菜单收起；取消置顶恢复原序',()=>{
  const {ctx,tbody,selNode,saves}=load();
  tbody.querySelectorAll('[data-plmenu]')[1].handlers.click({stopPropagation(){}});   // 展开 pipe-2 菜单
  tbody.querySelectorAll('[data-plpin]')[1].handlers.click({stopPropagation(){}});   // 点「置顶」
  const p2=ctx.pipelines.find(p=>p.id==='pipe-2');
  assert.ok(p2.pinnedAt>0,'置顶写入 pinnedAt 时间戳');
  assert.equal(saves.length,1,'置顶经 savePipelines 落盘（localStorage + 服务端同步）');
  assert.match(tbody.children[0].innerHTML,/流水线二/,'置顶后排列表最前');
  assert.match(tbody.children[0].innerHTML,/>置顶<\/span>/,'置顶徽标展示');
  assert.match(tbody.children[0].innerHTML,/data-plmenupanel="pipe-2" style="display:none;/,'置顶后菜单收起');
  assert.deepEqual(selNode.children.map(o=>o.value),['pipe-2','pipe-1','pipe-3'],'运行框下拉同步置顶序');
  assert.equal(tbody.querySelectorAll('[data-plpin]')[0].textContent,'取消置顶','已置顶时菜单项为「取消置顶」');
  tbody.querySelectorAll('[data-plmenu]')[0].handlers.click({stopPropagation(){}});   // 展开（已在首位的 pipe-2）菜单
  tbody.querySelectorAll('[data-plpin]')[0].handlers.click({stopPropagation(){}});   // 点「取消置顶」
  assert.equal(p2.pinnedAt,0,'取消置顶清空 pinnedAt');
  assert.equal(saves.length,2,'取消置顶同样落盘');
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
