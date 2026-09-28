// 流水线任务列表行内 ⋯ 菜单「运行历史」入口：#plRowMenuPanel 新增 plRowMenuHistory 列表项（收藏项之后，
// 与置顶/收藏同款 pl-row-menu-item 列表行）；点击后先 closePlRowMenu 收起菜单，showPipelineHistory 把运行历史
// 筛选整体重置为 {kw:'',status:'',pipeline:<该流水线名>} 并经 saveHistFilter 落盘（localStorage pip-histFilter）、
// histPage 归 0、清空关键字输入框与状态下拉、重渲筛选候选与历史表、以 false 从服务端刷新历史，
// 最后把运行历史卡片 #histCard 平滑滚动到视口顶部；openPlRowMenu 展开时动态刷新该列表项 title（含流水线名）。
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

/* 与 test_pipeline_pin.js 同款假 DOM 的精简版：本功能不重渲任务表（无需行内 button 解析），
   但补 textContent/title（列表项文案与提示）、value（筛选输入框/下拉）、style（悬浮层开合）；
   histCard 的 scrollIntoView spy 由 load() 挂载 */
class FakeNode{
  constructor(tag){ this.tag=tag; this.children=[]; this.handlers={}; this._html=''; this.className=''; this.title=''; this.textContent=''; this.value=''; this.style={}; this.offsetWidth=0; }
  set innerHTML(value){ this._html=value; if(!value) this.children=[]; }
  get innerHTML(){ return this._html; }
  appendChild(node){ this.children.push(node); }
  addEventListener(type,handler){ this.handlers[type]=handler; }
}

/* vm 内新建对象是 vm realm 的 Object 原型，assert/strict 的 deepEqual 会校验原型——经 JSON 回到本 realm 再比较 */
const histFilterOf=ctx=>JSON.parse(JSON.stringify(ctx.histFilter));

/* 切片区域：let plMenuOpenId + closePlRowMenu + openPlRowMenu（含 historyItem 守卫与动态 title），
   加源码抽取的 findPipeline / saveHistFilter / showPipelineHistory，
   外加文件尾的「运行历史」列表项绑定单行（同一脚本运行，词法绑定互通——与 test_pipeline_pin.js 的置顶绑定同款做法）。
   histFilter/histPage 直接在 ctx 预置为全局属性（不取 let 声明切片），vm 内赋值即写回 ctx，便于宿主侧断言；
   关键字输入框/状态下拉预置残留值、histPage 预置非 0，用于验证「既有筛选被清空」。 */
function load(opts){
  opts=opts||{};
  const panel=new FakeNode('div'); panel.style.display='none';   // 与页面内联样式一致：默认收起
  const pinItem=new FakeNode('div');
  const favoriteItem=new FakeNode('div');
  const historyItem=new FakeNode('div');
  const kwInp=new FakeNode('input'); kwInp.value='残留关键字';
  const stSel=new FakeNode('select'); stSel.value='failed';
  const card=new FakeNode('div');
  const calls={renderOpts:0,renderHist:0,refresh:[],scroll:[]};
  card.scrollIntoView=arg=>{ calls.scroll.push(arg); };
  const lsWrites=[];
  const localStorage={
    _m:{},
    getItem(k){ return Object.prototype.hasOwnProperty.call(this._m,k)?this._m[k]:null; },
    setItem(k,v){ const s=String(v); this._m[k]=s; lsWrites.push([k,s]); },
    removeItem(k){ delete this._m[k]; },
  };
  const ctx={
    pipelines:[
      {id:'pipe-1',name:'内置流水线',stages:[{name:'检出'}],builtIn:true},
      {id:'pipe-2',name:'流水线二',stages:[{name:'构建'}],builtIn:false},
      {id:'pipe-3',name:'流水线三',stages:[{name:'部署'}],builtIn:false},
    ],
    currentUsername:'',
    isPipelineFavorite:()=>false,
    histFilter:{kw:'',status:'',pipeline:''},
    histPage:7,   // 预置非 0：验证触发后归 0；无效 id 时保持 7
    localStorage,
    renderHistFilterOptions:()=>{ calls.renderOpts+=1; },
    renderHistory:()=>{ calls.renderHist+=1; },
    refreshHistoryFromServer:arg=>{ calls.refresh.push(arg); },
    $:id=>({plRowMenuPanel:panel, plRowMenuPin:pinItem, plRowMenuFavorite:favoriteItem,
      plRowMenuHistory:opts.missingHistoryItem?undefined:historyItem,
      histFilterKw:kwInp, histFilterStatus:stSel, histCard:card})[id]||null,
  };
  vm.createContext(ctx);
  const start=source.indexOf('/* 行内「⋯」菜单当前展开项');
  const end=source.indexOf('function togglePipelinePin',start);
  assert.ok(start>=0&&end>start,'⋯ 菜单代码区域未找到');
  let script=source.slice(start,end)+'\n'
    +extractFunction('findPipeline')+'\n'
    +extractFunction('saveHistFilter')+'\n'
    +extractFunction('showPipelineHistory');
  let bindLine='';
  if(!opts.missingHistoryItem){   // 缺 history 项的守卫场景不跑绑定行（$('plRowMenuHistory') 为空会抛错，与页面守卫语义无关）
    const bindStart=source.indexOf("$('plRowMenuHistory').addEventListener");
    const bindEnd=source.indexOf('\n',bindStart);
    assert.ok(bindStart>=0&&bindEnd>bindStart,'「运行历史」列表项绑定未找到');
    bindLine=source.slice(bindStart,bindEnd);
    script+='\n'+bindLine;
  }
  vm.runInContext(script,ctx);
  return {ctx,panel,pinItem,favoriteItem,historyItem,kwInp,stSel,card,calls,lsWrites,bindLine};
}

test('静态：#plRowMenuPanel 内「收藏」之后有「运行历史」列表项、历史卡片带 id="histCard"、尾部有点击绑定',()=>{
  const panelIdx=source.indexOf('id="plRowMenuPanel"');
  assert.ok(panelIdx>=0,'缺少 #plRowMenuPanel 悬浮菜单层');
  const block=source.slice(panelIdx,panelIdx+1200);   // 菜单层块内（含长内联样式的开标签 + 三个列表项）
  const pinIdx=block.indexOf('id="plRowMenuPin"');
  const favIdx=block.indexOf('id="plRowMenuFavorite"');
  const histIdx=block.indexOf('id="plRowMenuHistory"');
  assert.ok(pinIdx>=0&&favIdx>=0,'菜单缺少既有置顶/收藏列表项');
  assert.ok(histIdx>=0,'#plRowMenuPanel 块内缺少 id="plRowMenuHistory" 的「运行历史」列表项');
  assert.ok(pinIdx<favIdx&&favIdx<histIdx,'「运行历史」列表项应位于「收藏」项之后');
  assert.match(block,/<div\s+id="plRowMenuHistory"\s+class="pl-row-menu-item"\s*>\s*运行历史\s*<\/div>/,
    '「运行历史」应为 pl-row-menu-item 列表项（与置顶/收藏同款列表行，非圆边按钮）');
  const cardTag=/<div\b[^>]*\bid="histCard"[^>]*>/.exec(source);
  assert.ok(cardTag,'运行历史卡片缺少 id="histCard"');
  assert.match(cardTag[0],/class="[^"]*\bdshell-card\b/,'histCard 应为 dshell-card 卡片');
  assert.match(source.slice(cardTag.index,cardTag.index+400),/<h2\b[^>]*>\s*运行历史/,'histCard 应包裹「运行历史」标题行');
  assert.ok(source.includes("$('plRowMenuHistory').addEventListener('click'"),'文件尾缺少「运行历史」列表项点击绑定');
  assert.ok(/function\s+showPipelineHistory\s*\(/.test(source),'缺少 showPipelineHistory 顶层函数');
  const opener=extractFunction('openPlRowMenu');
  assert.ok(opener.includes("$('plRowMenuHistory')"),'openPlRowMenu 应查找 plRowMenuHistory 并纳入守卫');
  assert.ok(/historyItem\.title\s*=/.test(opener),'openPlRowMenu 应动态设置「运行历史」列表项 title');
});

test('点「运行历史」列表项：筛选重置落盘、历史区刷新并滚动到位、菜单收起',()=>{
  const {ctx,panel,historyItem,kwInp,stSel,calls,lsWrites,bindLine}=load();
  assert.ok(bindLine.includes('stopPropagation')&&bindLine.includes('closePlRowMenu')&&bindLine.includes('showPipelineHistory'),
    '绑定行应：阻止冒泡 → 收起菜单 → 打开该流水线运行历史');
  ctx.openPlRowMenu('pipe-2',{getBoundingClientRect:()=>({right:500,bottom:100})});
  assert.equal(panel.style.display,'block','⋯ 展开悬浮菜单（pipe-2）');
  const evt={stopped:false,stopPropagation(){ this.stopped=true; }};
  historyItem.handlers.click(evt);   // 点「运行历史」列表项
  assert.equal(evt.stopped,true,'点击阻止冒泡（不触发行选用/文档级监听）');
  assert.deepEqual(histFilterOf(ctx),{kw:'',status:'',pipeline:'流水线二'},'histFilter 整体重置并锁定目标流水线名');
  assert.equal(ctx.histPage,0,'历史分页归 0');
  assert.deepEqual(lsWrites,[['pip-histFilter',JSON.stringify({kw:'',status:'',pipeline:'流水线二'})]],
    'saveHistFilter 被调用：localStorage 写入 pip-histFilter');
  assert.equal(kwInp.value,'','关键字输入框清空');
  assert.equal(stSel.value,'','状态下拉清空');
  assert.equal(calls.renderOpts,1,'renderHistFilterOptions 调用一次');
  assert.equal(calls.renderHist,1,'renderHistory 调用一次');
  assert.deepEqual(calls.refresh,[false],'refreshHistoryFromServer 以 false 调用一次');
  assert.equal(calls.scroll.length,1,'histCard.scrollIntoView 调用一次');
  assert.equal(calls.scroll[0].block,'start','滚动对齐卡片顶部');
  assert.equal(calls.scroll[0].behavior,'smooth','平滑滚动');
  assert.equal(panel.style.display,'none','菜单收起');
  assert.strictEqual(vm.runInContext('plMenuOpenId',ctx),null,'展开项 id 清空');
});

test('既有运行历史筛选被清空：kw/status 归零、pipeline 换成目标流水线名',()=>{
  const {ctx,historyItem,kwInp,stSel,calls}=load();
  ctx.histFilter={kw:'abc',status:'failed',pipeline:'别的'};
  ctx.histPage=3;
  ctx.openPlRowMenu('pipe-3',{});
  historyItem.handlers.click({stopPropagation(){}});
  assert.deepEqual(histFilterOf(ctx),{kw:'',status:'',pipeline:'流水线三'},'旧筛选不留存，整体换成目标流水线');
  assert.equal(ctx.histPage,0,'旧页码归 0');
  assert.equal(kwInp.value,'','输入框残留清空');
  assert.equal(stSel.value,'','下拉残留清空');
  assert.equal(calls.renderHist,1,'历史表重渲一次');
});

test('流水线 id 无效：showPipelineHistory 不动作（各 spy 未调用、筛选态不变）；菜单未展开时点击空转',()=>{
  const {ctx,panel,historyItem,calls,lsWrites}=load();
  const before={kw:'abc',status:'failed',pipeline:'别的'};
  ctx.histFilter={kw:before.kw,status:before.status,pipeline:before.pipeline};
  ctx.showPipelineHistory('pipe-x');   // findPipeline 落空 → 提前 return
  assert.deepEqual(histFilterOf(ctx),before,'histFilter 不变');
  assert.equal(ctx.histPage,7,'histPage 不变');
  assert.equal(calls.renderOpts+calls.renderHist+calls.refresh.length+calls.scroll.length,0,'渲染/刷新/滚动均未触发');
  assert.equal(lsWrites.length,0,'未落盘');
  ctx.openPlRowMenu('pipe-x',{});   // 无效 id：菜单同样不展开
  assert.equal(panel.style.display,'none');
  historyItem.handlers.click({stopPropagation(){}});   // plMenuOpenId 为空 → close 提前 return、showPipelineHistory 不触发
  assert.deepEqual(histFilterOf(ctx),before,'点击空转后 histFilter 仍不变');
  assert.equal(calls.renderOpts+calls.renderHist+calls.refresh.length+calls.scroll.length,0,'点击空转后仍无任何调用');
  assert.equal(lsWrites.length,0,'点击空转后仍未落盘');
  assert.equal(panel.style.display,'none','面板保持收起');
});

test('openPlRowMenu 动态设置「运行历史」列表项 title（含流水线名）；缺 history 项时守卫整体不展开',()=>{
  const {ctx,panel,pinItem,historyItem}=load();
  ctx.openPlRowMenu('pipe-2',{getBoundingClientRect:()=>({right:500,bottom:100})});
  assert.equal(panel.style.display,'block');
  assert.ok(historyItem.title.indexOf('查看流水线「流水线二」的运行历史')===0,'title 含目标流水线名：'+historyItem.title);
  ctx.openPlRowMenu('pipe-1',{});   // 换一条重开，title 跟随刷新
  assert.ok(historyItem.title.indexOf('查看流水线「内置流水线」的运行历史')===0,'title 随展开项刷新：'+historyItem.title);
  const g=load({missingHistoryItem:true});   // 守卫：plRowMenuHistory 缺失时与 pin/favorite 同款整体防御
  g.ctx.openPlRowMenu('pipe-2',{});
  assert.equal(g.panel.style.display,'none','缺 history 列表项时菜单不展开');
  assert.equal(g.pinItem.textContent,'','提前 return：连置顶项文案都未设置');
  assert.strictEqual(vm.runInContext('plMenuOpenId',g.ctx),null,'展开项 id 未置位');
});
