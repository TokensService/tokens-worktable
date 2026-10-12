/* 节点选择默认行为：主控「选择 IP」、定时页与流水线编辑器「默认环境」均默认不选择任何节点，
   允许手动全部取消勾选（不选即按无目标节点运行）；旧流水线未保存过默认环境字段时维持回退首项兼容。
   环境多选面板另支持搜索（名称 / IP / 用户名 / InternalIP）与已选节点排序（名称 / IP / 设备状态 + ↑↓ 调序），
   顺序写回 ids，决定 TARGET_IP / TARGET_IPS 注入顺序。 */
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
const ENVS=[
  {id:'env-a',name:'开发',ip:'10.0.0.1'},
  {id:'env-b',name:'生产',ip:'10.0.0.2'},
  {id:'env-c',name:'测试',ip:'10.0.0.10',user:'ops'},
];

test('curEnvs 默认（无存储选择）与显式空选择均返回空列表，不再回退首个节点',()=>{
  const ctx={environments:ENVS,selectedEnvIds:null};
  vm.createContext(ctx); vm.runInContext(extractFunction('curEnvs'),ctx);
  assert.equal(ctx.curEnvs().length,0,'从未选择过时不选择任何节点');
  ctx.selectedEnvIds=[];
  assert.equal(ctx.curEnvs().length,0,'显式空选择保留为空');
  ctx.selectedEnvIds=['env-b'];
  assert.deepEqual(ctx.curEnvs().map(e=>e.id),['env-b']);
});

test('curEnvs 按选中顺序返回（TARGET_IPS 顺序跟随面板排序/调序结果）',()=>{
  const ctx={environments:ENVS,selectedEnvIds:['env-c','env-a','env-b']};
  vm.createContext(ctx); vm.runInContext(extractFunction('curEnvs'),ctx);
  assert.deepEqual(ctx.curEnvs().map(e=>e.id),['env-c','env-a','env-b'],'按 selectedEnvIds 顺序，而非 environments 原序');
});

test('主控初始选择读取本地存储：空数组按显式空保留，不再强制非空',()=>{
  assert.match(source,/pip-envSel'\)\);\s*return Array\.isArray\(a\)\?a:null/,'存储的空数组选择应原样生效');
  assert.ok(!source.includes('至少保留一个'),'不得再强制至少保留一个选中节点');
});

function elStub(tag){
  const el={
    tag:tag||'div',style:{},children:[],attributes:{},_listeners:{},
    innerHTML:'',textContent:'',title:'',placeholder:'',value:'',type:'',className:'',autocomplete:'',
    checked:false, disabled:false,
    setAttribute(n,v){this.attributes[n]=String(v); if(n==='data-envcb') this._envcb=String(v);},
    getAttribute(n){return Object.prototype.hasOwnProperty.call(this.attributes,n)?this.attributes[n]:null;},
    appendChild(c){this.children.push(c); c.parentNode=this; return c;},
    querySelector(sel){return this.querySelectorAll(sel)[0]||null;},
    querySelectorAll(sel){
      const sels=sel.split(',').map(s=>s.trim()).filter(Boolean);
      const matchOne=(node,s)=>{
        const m=/^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(s);
        if(!m) return false;
        const name=m[1], val=m[2];
        const got=node.getAttribute(name);
        if(got==null) return false;
        return val===undefined||got===val;
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
function loadRenderEnvMulti(btn,panel){
  const ctx={
    document:{createElement:(tag)=>elStub(tag)},
    gpuStatus:{}, gpuBusy:()=>false,
    esc:s=>String(s),
    $:id=>({envMultiBtn:btn,envMultiPanel:panel})[id]||null,
    environments:ENVS,
    envMultiSearch:{}, envMultiSelSort:{},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('envMultiFilterMatch'),ctx);
  vm.runInContext(extractFunction('envMultiSortVal'),ctx);
  vm.runInContext(extractFunction('envMultiSortList'),ctx);
  vm.runInContext(extractFunction('renderEnvMulti'),ctx);
  return ctx;
}
function optLabels(panel){
  return panel.children.filter(c=>c.getAttribute&&c.getAttribute('data-envopt'));
}

test('环境多选面板空选择时不自动勾选首项，按钮显示占位「选择 IP」',()=>{
  const btn=elStub(),panel=elStub();
  const writes=[];
  const ctx=loadRenderEnvMulti(btn,panel);
  ctx.renderEnvMulti({btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>[],setIds:ids=>writes.push(ids)});
  assert.equal(btn.textContent,'选择 IP');
  assert.equal(writes.length,0,'空选择不得自动改写为首项');
  assert.equal(optLabels(panel).length,ENVS.length,'面板仍列出全部可选节点');
  assert.ok(optLabels(panel).every(l=>l.innerHTML.indexOf('checked')<0),'默认没有任何勾选');
});

test('环境多选面板允许取消最后一个勾选（不选择任何节点）',()=>{
  const btn=elStub(),panel=elStub();
  let current=['env-a'];
  const ctx=loadRenderEnvMulti(btn,panel);
  const render=()=>ctx.renderEnvMulti({btnId:'envMultiBtn',panelId:'envMultiPanel',
    getIds:()=>current,setIds:ids=>{current=ids.slice();}});
  render();
  assert.equal(btn.textContent,'10.0.0.1');
  const cbA=panel.querySelectorAll('[data-envcb]').find(c=>c.getAttribute('data-envcb')==='env-a');
  assert.ok(cbA,'面板应含 env-a 复选框');
  cbA.checked=false; cbA.fire('change');
  assert.deepEqual(current,[],'取消最后一个勾选后保持空选择');
  assert.equal(btn.textContent,'选择 IP');
  const cbB=panel.querySelectorAll('[data-envcb]').find(c=>c.getAttribute('data-envcb')==='env-b');
  cbB.checked=true; cbB.fire('change');
  assert.deepEqual(current,['env-b'],'空选择后仍可正常勾选一个节点');
});

test('环境多选面板支持搜索：按名称 / IP / 用户名 / InternalIP 过滤节点列表',()=>{
  const btn=elStub(),panel=elStub();
  const ctx=loadRenderEnvMulti(btn,panel);
  const opts={btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>[],setIds:()=>{}};
  ctx.renderEnvMulti(opts);
  const search=panel.querySelectorAll('[data-envmulti-search]')[0];
  assert.ok(search,'面板应含搜索框');

  search.value='生产'; search.fire('input');
  const visible=optLabels(panel).filter(l=>l.style.display!=='none');
  assert.deepEqual(visible.map(l=>l.getAttribute('data-envopt')),['env-b'],'名称命中');

  search.value='10.0.0.10'; search.fire('input');
  assert.deepEqual(optLabels(panel).filter(l=>l.style.display!=='none').map(l=>l.getAttribute('data-envopt')),['env-c'],'IP 命中');

  search.value='ops'; search.fire('input');
  assert.deepEqual(optLabels(panel).filter(l=>l.style.display!=='none').map(l=>l.getAttribute('data-envopt')),['env-c'],'用户名命中');

  search.value='zzz-no-match'; search.fire('input');
  assert.equal(optLabels(panel).filter(l=>l.style.display!=='none').length,0,'无匹配时全部隐藏');
  const emptyTip=panel.querySelectorAll('[data-envmulti-empty]')[0];
  assert.ok(emptyTip&&emptyTip.style.display!=='none','无匹配时显示空提示');
});

test('已选节点按 IP 排序并写回 ids（TARGET_IPS 顺序跟随）',()=>{
  const btn=elStub(),panel=elStub();
  let current=['env-c','env-a','env-b'];   // 故意乱序：10.0.0.10 / 10.0.0.1 / 10.0.0.2
  const ctx=loadRenderEnvMulti(btn,panel);
  const render=()=>ctx.renderEnvMulti({btnId:'envMultiBtn',panelId:'envMultiPanel',
    getIds:()=>current,setIds:ids=>{current=ids.slice();}});
  render();
  assert.equal(btn.textContent,'10.0.0.10，10.0.0.1，10.0.0.2','按钮按选中顺序显示');

  const sortIp=panel.querySelectorAll('[data-envmulti-sort]').find(b=>b.getAttribute('data-envmulti-sort')==='ip');
  assert.ok(sortIp,'应有 IP 排序按钮');
  sortIp.fire('click');
  assert.deepEqual(current,['env-a','env-b','env-c'],'按 IP 升序写回 ids');
  assert.equal(btn.textContent,'10.0.0.1，10.0.0.2，10.0.0.10');

  const sortIp2=panel.querySelectorAll('[data-envmulti-sort]').find(b=>b.getAttribute('data-envmulti-sort')==='ip');
  sortIp2.fire('click');
  assert.deepEqual(current,['env-c','env-b','env-a'],'再点一次降序');
});

test('已选节点 ↑↓ 手动调序并同步按钮文案',()=>{
  const btn=elStub(),panel=elStub();
  let current=['env-a','env-b'];
  const ctx=loadRenderEnvMulti(btn,panel);
  const render=()=>ctx.renderEnvMulti({btnId:'envMultiBtn',panelId:'envMultiPanel',
    getIds:()=>current,setIds:ids=>{current=ids.slice();}});
  render();
  const down=panel.querySelectorAll('[data-envmulti-down]').find(b=>b.getAttribute('data-envmulti-down')==='env-a');
  assert.ok(down,'应有 env-a 的下移按钮');
  down.fire('click');
  assert.deepEqual(current,['env-b','env-a'],'下移后顺序更新');
  assert.equal(btn.textContent,'10.0.0.2，10.0.0.1');

  const up=panel.querySelectorAll('[data-envmulti-up]').find(b=>b.getAttribute('data-envmulti-up')==='env-a');
  up.fire('click');
  assert.deepEqual(current,['env-a','env-b'],'上移后顺序还原');
});

test('已选节点 × 取消选中；搜索词按面板实例隔离',()=>{
  const btn=elStub(),panel=elStub();
  let current=['env-a','env-b'];
  const ctx=loadRenderEnvMulti(btn,panel);
  const opts={btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>current,setIds:ids=>{current=ids.slice();}};
  ctx.renderEnvMulti(opts);
  const rm=panel.querySelectorAll('[data-envmulti-rm]').find(b=>b.getAttribute('data-envmulti-rm')==='env-a');
  assert.ok(rm);
  rm.fire('click');
  assert.deepEqual(current,['env-b'],'× 取消选中');

  const search=panel.querySelectorAll('[data-envmulti-search]')[0];
  search.value='生产'; search.fire('input');
  assert.equal(ctx.envMultiSearch.envMultiPanel,'生产','搜索词记入当前面板');
  assert.equal(ctx.envMultiSearch.otherPanel,undefined,'不影响其他面板实例');
});

function loadDefaultsSection(){
  const start=source.indexOf('/* ---------- 流水线默认运行参数 ---------- */');
  const end=source.indexOf('/* ---------- 流水线默认运行参数结束 ---------- */',start);
  assert.ok(start>=0&&end>start,'pipeline.html 缺少流水线默认运行参数实现');
  const ctx={Array,Object,String,Set,environments:ENVS,repositories:[{id:'repo-a',url:'a.git'}]};
  vm.createContext(ctx); vm.runInContext(source.slice(start,end),ctx);
  return ctx;
}

test('编辑器默认环境：显式保存的空列表=不选择任何节点，旧流水线缺省仍回退首项',()=>{
  const ctx=loadDefaultsSection();
  const explicit=ctx.pipelineDefaultRunOptions({defaults:{environmentIds:[],repositoryId:'',branch:'main',strategy:'',presets:[]}});
  assert.deepEqual(explicit.envs,[],'编辑器保存的空环境列表不得改投首项');
  const legacy=ctx.pipelineDefaultRunOptions({});
  assert.deepEqual(legacy.envs.map(e=>e.id),['env-a'],'旧流水线未保存过默认环境字段时维持回退首项');
  const named=ctx.pipelineDefaultRunOptions({defaults:{environmentIds:['env-b']}});
  assert.deepEqual(named.envs.map(e=>e.id),['env-b']);
});

test('定时页环境跟随主控，均未选择时同样不选择任何节点',()=>{
  const ctx={environments:ENVS,schedEnvIds:null,curEnvs:()=>[]};
  vm.createContext(ctx); vm.runInContext(extractFunction('schedEnvs'),ctx);
  assert.equal(ctx.schedEnvs().length,0);
  ctx.curEnvs=()=>[ENVS[0]];
  assert.deepEqual(ctx.schedEnvs().map(e=>e.id),['env-a'],'未单独选择时跟随主控');
  ctx.schedEnvIds=['env-c','env-b'];
  assert.deepEqual(ctx.schedEnvs().map(e=>e.id),['env-c','env-b'],'单独选择优先且按选择顺序');
});
