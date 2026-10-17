/* 环境多选面板「可用节点优先」与面板宽高自适应：
   - 候选列表按 预留给自己 → 未分配 → 预留给他人 分组排序（组内保持节点原序）：envAvailGroup / envMultiAvailSort；
   - 筛选行「预留给我 / 未分配」「GPU 空闲」可单独或同时勾选（同时勾选取交集），只过滤候选列表：
     envMultiListFilterMatch / envMultiGpuIdle（已查询、未失败、无占用才算空闲）；
   - 静态契约：四处环境多选面板（主控/定时/编辑器默认环境/运行弹窗）width:max-content 自适应宽度
     + max-height 调大，候选行 white-space:nowrap（一个节点的全部信息一行显示全）。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=require('./_page-source.cjs').loadPageSource();

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
/* 元素桩（与 test_env_selection_default_none.js 同款）：属性选择器查询 + 事件捕获 */
function elStub(tag){
  const el={
    tag:tag||'div',style:{},children:[],attributes:{},_listeners:{},
    textContent:'',title:'',placeholder:'',value:'',type:'',className:'',autocomplete:'',
    checked:false, disabled:false,
    setAttribute(n,v){this.attributes[n]=String(v);},
    getAttribute(n){return Object.prototype.hasOwnProperty.call(this.attributes,n)?this.attributes[n]:null;},
    appendChild(c){this.children.push(c); c.parentNode=this; return c;},
    querySelector(sel){return this.querySelectorAll(sel)[0]||null;},
    querySelectorAll(sel){
      const sels=sel.split(',').map(s=>s.trim()).filter(Boolean);
      const matchOne=(node,s)=>{
        const m=/^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(s);
        if(!m) return false;
        const got=node.getAttribute(m[1]);
        if(got==null) return false;
        return m[2]===undefined||got===m[2];
      };
      const out=[];
      const walk=(n)=>{
        if(!n||!n.children) return;
        n.children.forEach(c=>{
          if(sels.some(s=>matchOne(c,s))) out.push(c);
          walk(c);
        });
      };
      walk(this);
      return out;
    },
    addEventListener(type,fn){(this._listeners[type]=this._listeners[type]||[]).push(fn);},
    fire(type,ev){(this._listeners[type]||[]).forEach(fn=>fn(ev||{preventDefault(){},stopPropagation(){}}));},
  };
  Object.defineProperty(el,'innerHTML',{
    get(){ return this._html||''; },
    set(v){ this._html=v; this.children=[]; },   // 清空子树（与真实 innerHTML='' 一致）
  });
  return el;
}
/* 节点：env-a 预留给他人 / env-b 未分配 / env-c 预留给我 / env-d 未分配（原始顺序故意打乱分组） */
const ENVS=[
  {id:'env-a',name:'甲节点',ip:'10.0.0.1'},
  {id:'env-b',name:'乙节点',ip:'10.0.0.2'},
  {id:'env-c',name:'丙节点',ip:'10.0.0.3'},
  {id:'env-d',name:'丁节点',ip:'10.0.0.4'},
];
const RES={
  'env-a':{reserved:true,users:['u1','u2'],until:'2026-10-15T00:00:00.000Z'},
  'env-c':{reserved:true,users:['me'],until:'2026-10-15T00:00:00.000Z'},
};
function loadCtx(btn,panel,globals){
  const ctx=Object.assign({
    document:{createElement:(tag)=>elStub(tag)},
    gpuStatus:{}, gpuBusy:st=>(st.containers||[]).length>0||(Number(st.used)||0)>0,
    esc:s=>String(s),
    $:id=>({envMultiBtn:btn,envMultiPanel:panel})[id]||null,
    environments:ENVS,
    envMultiSearch:{}, envMultiSelSort:{}, envMultiListFilter:{},
    currentUsername:'me',
    envReservationInfo:(e)=>RES[e.id]||{reserved:false,users:[],until:null},
    fmtResTime:()=>'10-15 00:00',
  }, globals||{});
  vm.createContext(ctx);
  ['envAvailGroup','envMultiAvailSort','envMultiGpuIdle','envMultiListFilterMatch','envMultiFilterMatch','envMultiSortVal','envMultiSortList','renderEnvMulti']
    .forEach(n=>vm.runInContext(extractFunction(n),ctx));
  return ctx;
}
const optIds=panel=>panel.querySelectorAll('[data-envopt]').map(l=>l.getAttribute('data-envopt'));
const visibleOptIds=panel=>panel.querySelectorAll('[data-envopt]').filter(l=>l.style.display!=='none').map(l=>l.getAttribute('data-envopt'));
const filterCb=(panel,key)=>panel.querySelectorAll('[data-envmulti-filter]').find(f=>f.getAttribute('data-envmulti-filter')===key);

test('静态契约：四处环境多选面板 width:max-content 自适应 + 高度调大，候选行不换行、带筛选行',()=>{
  ['envMultiPanel','schedEnvMultiPanel','plDefaultEnvMultiPanel','pipelineRunEnvMultiPanel'].forEach(id=>{
    const m=new RegExp(`id="${id}" style="([^"]*)"`).exec(source);
    assert.ok(m,`缺少面板 #${id}`);
    assert.ok(m[1].includes('width:max-content'),`${id} 应 width:max-content 自适应宽度`);
    assert.ok(m[1].includes('max-width:min(92vw,880px)'),`${id} 应有宽度上限（超出横向滚动）`);
    assert.ok(m[1].includes('max-height:min(60vh,560px)'),`${id} 最大高度应调大为 min(60vh,560px)`);
  });
  const fn=extractFunction('renderEnvMulti');
  assert.ok(fn.includes('white-space:nowrap'),'候选节点行应 white-space:nowrap（一个节点信息一行显示全）');
  assert.ok(fn.includes("setAttribute('data-envmulti-filter', fkey)"),'筛选行复选框应带 data-envmulti-filter');
  assert.ok(fn.includes('预留给我 / 未分配')&&fn.includes('GPU 空闲'),'筛选行应含「预留给我 / 未分配」与「GPU 空闲」');
  assert.ok(fn.includes('envMultiAvailSort('),'候选列表应经 envMultiAvailSort 分组排序');
});

test('envAvailGroup：预留给自己=0、未分配=1、预留给他人=2；缺预留函数/无登录身份按守卫退化',()=>{
  const ctx=loadCtx(elStub(),elStub());
  assert.equal(ctx.envAvailGroup(ENVS[2]),0,'当前生效预留含我（预留给自己）排最前');
  assert.equal(ctx.envAvailGroup(ENVS[1]),1,'无生效预留（未分配）其次');
  assert.equal(ctx.envAvailGroup(ENVS[0]),2,'预留给他人最后');
  const noFn=loadCtx(elStub(),elStub(),{envReservationInfo:undefined});
  assert.equal(noFn.envAvailGroup(ENVS[0]),1,'无预留函数（vm 抽取测试桩）一律按未分配处理（typeof 守卫）');
  const noMe=loadCtx(elStub(),elStub(),{currentUsername:''});
  assert.equal(noMe.envAvailGroup(ENVS[0]),2,'无登录身份（token 共享模式）下被预留节点归入「预留给他人」');
  assert.equal(noMe.envAvailGroup(ENVS[1]),1,'无登录身份下未分配节点仍归未分配');
});

test('envMultiGpuIdle：仅「已查询、未失败、无占用」算空闲（占用/容器占用/查询失败/未查询均不算）',()=>{
  const ctx=loadCtx(elStub(),elStub(),{gpuStatus:{
    'env-a':{used:0,total:8,containers:[]},      // 空闲
    'env-b':{used:2,total:8,containers:[]},      // 占用（已用卡数）
    'env-c':{used:0,total:8,containers:['x']},   // 占用（关联容器）
    'env-d':{error:'ssh failed'},                // 查询失败
  }});
  assert.equal(ctx.envMultiGpuIdle(ENVS[0]),true,'已查询无占用=空闲');
  assert.equal(ctx.envMultiGpuIdle(ENVS[1]),false,'按已用卡数占用不算空闲');
  assert.equal(ctx.envMultiGpuIdle(ENVS[2]),false,'按关联容器占用不算空闲');
  assert.equal(ctx.envMultiGpuIdle(ENVS[3]),false,'查询失败不算空闲');
  assert.equal(ctx.envMultiGpuIdle({id:'env-none'}),false,'未查询不算空闲');
  const noFn=loadCtx(elStub(),elStub(),{gpuBusy:undefined,gpuStatus:undefined});
  assert.equal(noFn.envMultiGpuIdle(ENVS[0]),false,'缺 gpuBusy/gpuStatus 全局按不算空闲退化（typeof 守卫）');
});

test('候选列表分组排序：预留给自己与未分配排最前（组内保持原序），预留给他人最后且徽标保留',()=>{
  const btn=elStub(),panel=elStub();
  const ctx=loadCtx(btn,panel);
  ctx.renderEnvMulti({btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>[],setIds:()=>{}});
  assert.deepEqual(optIds(panel),['env-c','env-b','env-d','env-a'],'预留给我最前 → 未分配其次（保持原序）→ 预留给他人最后');
  const labA=panel.querySelectorAll('[data-envopt]').find(l=>l.getAttribute('data-envopt')==='env-a');
  const badge=labA.children.find(c=>c.textContent&&c.textContent.indexOf('预留中')>=0);
  assert.ok(badge,'排序后预留给他人节点的预留徽标仍显示');
  assert.ok(String(labA.style.cssText).indexOf('white-space:nowrap')>=0,'候选行经 style.cssText 置 white-space:nowrap');
});

test('筛选行：两个复选框默认不勾选；「预留给我 / 未分配」滤掉预留给他人且不写勾选态',()=>{
  const btn=elStub(),panel=elStub();
  const ctx=loadCtx(btn,panel);
  let writes=0;
  const opts={btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>[],setIds:()=>{writes++;}};
  ctx.renderEnvMulti(opts);
  const filters=panel.querySelectorAll('[data-envmulti-filter]');
  assert.deepEqual(filters.map(f=>f.getAttribute('data-envmulti-filter')),['avail','gpuIdle'],'筛选行含两个复选框且按序');
  assert.ok(filters.every(f=>f.checked===false),'默认均不勾选');

  filterCb(panel,'avail').checked=true;
  filterCb(panel,'avail').fire('change');
  assert.deepEqual(optIds(panel),['env-c','env-b','env-d'],'预留给他人被滤掉');
  assert.equal(ctx.envMultiListFilter.envMultiPanel.avail,true,'筛选状态记入当前面板实例');
  assert.equal(filterCb(panel,'avail').checked,true,'整树重绘后勾选保持');
  assert.equal(writes,0,'筛选切换不改勾选态（不写回 ids）');

  filterCb(panel,'avail').checked=false;
  filterCb(panel,'avail').fire('change');
  assert.deepEqual(optIds(panel),['env-c','env-b','env-d','env-a'],'取消筛选恢复全部（仍按分组排序）');
});

test('「GPU 空闲」筛选：仅显示已查询且空闲的节点；无匹配时显示空提示',()=>{
  const btn=elStub(),panel=elStub();
  const ctx=loadCtx(btn,panel,{gpuStatus:{
    'env-a':{used:0,total:8,containers:[]},
    'env-b':{used:1,total:8,containers:[]},
    'env-c':{error:'x'},
    // env-d 未查询
  }});
  const opts={btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>[],setIds:()=>{}};
  ctx.renderEnvMulti(opts);
  filterCb(panel,'gpuIdle').checked=true;
  filterCb(panel,'gpuIdle').fire('change');
  assert.deepEqual(optIds(panel),['env-a'],'只有 env-a 空闲；占用/查询失败/未查询均不显示');

  vm.runInContext(`gpuStatus['env-a']={used:8,total:8,containers:['c']}`,ctx);   // 全部转为非空闲
  ctx.renderEnvMulti(opts);
  assert.deepEqual(optIds(panel),[],'全部非空闲时列表为空');
  const emptyTip=panel.querySelectorAll('[data-envmulti-empty]')[0];
  assert.ok(emptyTip&&emptyTip.style.display!=='none','无匹配节点时显示空提示');
});

test('两个筛选同时勾选取交集（预留给我/未分配 且 GPU 空闲）',()=>{
  const btn=elStub(),panel=elStub();
  const ctx=loadCtx(btn,panel,{gpuStatus:{
    'env-a':{used:0,total:8,containers:[]},   // 预留给他人·空闲
    'env-b':{used:0,total:8,containers:[]},   // 未分配·空闲
    'env-c':{used:0,total:8,containers:[]},   // 预留给我·空闲
    'env-d':{used:3,total:8,containers:[]},   // 未分配·占用
  }});
  const opts={btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>[],setIds:()=>{}};
  ctx.renderEnvMulti(opts);
  filterCb(panel,'avail').checked=true; filterCb(panel,'avail').fire('change');
  filterCb(panel,'gpuIdle').checked=true; filterCb(panel,'gpuIdle').fire('change');
  assert.deepEqual(optIds(panel),['env-c','env-b'],'交集：滤掉预留给他人（env-a）与未分配但占用（env-d）');
  filterCb(panel,'avail').checked=false; filterCb(panel,'avail').fire('change');
  assert.deepEqual(optIds(panel),['env-c','env-b','env-a'],'取消 avail 后仅剩 GPU 空闲约束（组序仍生效）');
});

test('搜索与筛选叠加：input 事件的行显隐同时遵守筛选勾选',()=>{
  const btn=elStub(),panel=elStub();
  const ctx=loadCtx(btn,panel);
  const opts={btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>[],setIds:()=>{}};
  ctx.renderEnvMulti(opts);
  filterCb(panel,'avail').checked=true; filterCb(panel,'avail').fire('change');
  const search=panel.querySelectorAll('[data-envmulti-search]')[0];
  assert.ok(search,'面板应含搜索框');
  search.value=''; search.fire('input');
  assert.deepEqual(visibleOptIds(panel),['env-c','env-b','env-d'],'空搜索词下仍滤掉预留给他人');
  search.value='丁'; search.fire('input');
  assert.deepEqual(visibleOptIds(panel),['env-d'],'搜索词与筛选共同生效');
  search.value='zzz'; search.fire('input');
  assert.deepEqual(visibleOptIds(panel),[],'无匹配时全部隐藏');
  const emptyTip=panel.querySelectorAll('[data-envmulti-empty]')[0];
  assert.ok(emptyTip&&emptyTip.style.display!=='none','无匹配时显示空提示');
});

test('筛选状态按面板实例隔离：另一面板实例不受影响',()=>{
  const btn1=elStub(),panel1=elStub();
  const ctx=loadCtx(btn1,panel1);
  const btn2=elStub(),panel2=elStub();
  ctx.$=id=>({envMultiBtn:btn1,envMultiPanel:panel1,schedEnvMultiBtn:btn2,schedEnvMultiPanel:panel2})[id]||null;
  ctx.renderEnvMulti({btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>[],setIds:()=>{}});
  filterCb(panel1,'avail').checked=true; filterCb(panel1,'avail').fire('change');
  assert.deepEqual(optIds(panel1),['env-c','env-b','env-d'],'主控面板已按筛选过滤');
  ctx.renderEnvMulti({btnId:'schedEnvMultiBtn',panelId:'schedEnvMultiPanel',getIds:()=>[],setIds:()=>{}});
  assert.deepEqual(optIds(panel2),['env-c','env-b','env-d','env-a'],'定时页面板未开筛选，仍列全部（分组排序生效）');
});

/* ==================== availOnly（运行弹窗）：默认勾选 + 预留给他人禁选 ==================== */
test('availOnly（运行弹窗）：「预留给我 / 未分配」默认勾选；预留给他人节点不可勾选（含 admin）',()=>{
  const btn=elStub(),panel=elStub();
  const ctx=loadCtx(btn,panel,{currentUserIsAdmin:true});   // admin 同样受限
  ctx.renderEnvMulti({btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>[],setIds:()=>{},availOnly:true});
  assert.equal(filterCb(panel,'avail').checked,true,'「预留给我 / 未分配」默认勾选');
  assert.deepEqual(optIds(panel),['env-c','env-b','env-d'],'默认只显示预留给我/未分配');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.envMultiListFilter.envMultiPanel)),{avail:true,gpuIdle:false},'默认筛选物化进面板状态');

  filterCb(panel,'avail').checked=false; filterCb(panel,'avail').fire('change');
  assert.deepEqual(optIds(panel),['env-c','env-b','env-d','env-a'],'取消勾选后全部可见（分组排序仍生效）');
  const cbOf=id=>panel.querySelectorAll('[data-envcb]').find(c=>c.getAttribute('data-envcb')===id);
  assert.equal(cbOf('env-a').disabled,true,'预留给他人节点不可勾选（admin 同样受限）');
  assert.equal(cbOf('env-b').disabled,false,'未分配节点可勾选');
  assert.equal(cbOf('env-c').disabled,false,'预留给我节点可勾选');
  const labA=panel.querySelectorAll('[data-envopt]').find(l=>l.getAttribute('data-envopt')==='env-a');
  assert.equal(labA.title,'该节点当前预留给他人，不可选择','禁选行带悬停提示');
});

test('availOnly：已选中的预留给他人节点保留可取消（筛选遮蔽时走已选区 ×；取消筛选后 checkbox 可取消）',()=>{
  const btn=elStub(),panel=elStub();
  const ctx=loadCtx(btn,panel);
  let current=['env-a'];
  const opts={btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>current,setIds:ids=>{current=ids.slice();},availOnly:true};
  ctx.renderEnvMulti(opts);
  assert.equal(panel.querySelectorAll('[data-envcb]').find(c=>c.getAttribute('data-envcb')==='env-a'),undefined,'默认筛选下被遮蔽节点无候选行');
  const rm=panel.querySelectorAll('[data-envmulti-rm]').find(b=>b.getAttribute('data-envmulti-rm')==='env-a');
  assert.ok(rm,'已选区有 × 可取消');
  rm.fire('click');
  assert.deepEqual(current,[],'已选区 × 摘掉');

  current=['env-a'];   // 模拟再次继承自默认环境/运行框的选择
  filterCb(panel,'avail').checked=false; filterCb(panel,'avail').fire('change');
  const cbA=panel.querySelectorAll('[data-envcb]').find(c=>c.getAttribute('data-envcb')==='env-a');
  assert.ok(cbA && cbA.disabled===false,'取消筛选后，已选中的被拦节点 checkbox 不禁用（可取消）');
  cbA.checked=false; cbA.fire('change');
  assert.deepEqual(current,[],'checkbox 取消勾选摘掉');
});

test('availOnly：勾选「GPU 空闲」不丢默认勾选的「预留给我 / 未分配」（交集成效）',()=>{
  const btn=elStub(),panel=elStub();
  const ctx=loadCtx(btn,panel,{gpuStatus:{
    'env-a':{used:0,total:8,containers:[]},   // 预留给他人·空闲
    'env-b':{used:0,total:8,containers:[]},   // 未分配·空闲
    'env-c':{used:0,total:8,containers:[]},   // 预留给我·空闲
    'env-d':{used:3,total:8,containers:[]},   // 未分配·占用
  }});
  const opts={btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>[],setIds:()=>{},availOnly:true};
  ctx.renderEnvMulti(opts);
  filterCb(panel,'gpuIdle').checked=true; filterCb(panel,'gpuIdle').fire('change');
  assert.equal(ctx.envMultiListFilter.envMultiPanel.avail,true,'勾选 GPU 空闲不丢 avail 默认勾选');
  assert.deepEqual(optIds(panel),['env-c','env-b'],'交集：滤掉预留给他人（env-a）与占用（env-d）');
});

test('非 availOnly 面板：无默认勾选；本桩无 envReservedForOthers 时预留给他人节点可勾选（既有拦截口径由 test_node_reservations 覆盖）',()=>{
  const btn=elStub(),panel=elStub();
  const ctx=loadCtx(btn,panel,{currentUserIsAdmin:true});
  ctx.renderEnvMulti({btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>[],setIds:()=>{}});
  assert.equal(filterCb(panel,'avail').checked,false,'筛选默认不勾选');
  assert.deepEqual(optIds(panel),['env-c','env-b','env-d','env-a'],'全部可见');
  const cbA=panel.querySelectorAll('[data-envcb]').find(c=>c.getAttribute('data-envcb')==='env-a');
  assert.equal(cbA.disabled,false,'无 availOnly 时不下禁选');
  assert.equal(ctx.envMultiListFilter.envMultiPanel,undefined,'非 availOnly 不物化默认筛选');
});
