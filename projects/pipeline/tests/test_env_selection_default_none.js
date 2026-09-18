/* 节点选择默认行为：主控「选择 IP」、定时页与流水线编辑器「默认环境」均默认不选择任何节点，
   允许手动全部取消勾选（不选即按无目标节点运行）；旧流水线未保存过默认环境字段时维持回退首项兼容。 */
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
const ENVS=[{id:'env-a',name:'开发',ip:'10.0.0.1'},{id:'env-b',name:'生产',ip:'10.0.0.2'}];

test('curEnvs 默认（无存储选择）与显式空选择均返回空列表，不再回退首个节点',()=>{
  const ctx={environments:ENVS,selectedEnvIds:null};
  vm.createContext(ctx); vm.runInContext(extractFunction('curEnvs'),ctx);
  assert.deepEqual(ctx.curEnvs(),[],'从未选择过时不选择任何节点');
  ctx.selectedEnvIds=[];
  assert.deepEqual(ctx.curEnvs(),[],'显式空选择保留为空');
  ctx.selectedEnvIds=['env-b'];
  assert.deepEqual(ctx.curEnvs().map(e=>e.id),['env-b']);
});

test('主控初始选择读取本地存储：空数组按显式空保留，不再强制非空',()=>{
  assert.match(source,/pip-envSel'\)\);\s*return Array\.isArray\(a\)\?a:null/,'存储的空数组选择应原样生效');
  assert.ok(!source.includes('至少保留一个'),'不得再强制至少保留一个选中节点');
});

function elStub(){
  return {style:{},children:[],innerHTML:'',textContent:'',title:'',
    appendChild(c){this.children.push(c);},querySelectorAll(){return this._qsa||[];},addEventListener(){}};
}
function cbStub(id,checked){
  return {checked,_listeners:{},getAttribute:name=>name==='data-envcb'?id:null,
    addEventListener(type,fn){(this._listeners[type]=this._listeners[type]||[]).push(fn);},
    fireChange(){(this._listeners.change||[]).forEach(fn=>fn());}};
}
function loadRenderEnvMulti(btn,panel){
  const ctx={document:{createElement:()=>elStub()},gpuStatus:{},esc:s=>String(s),
    $:id=>({envMultiBtn:btn,envMultiPanel:panel})[id]||null,environments:ENVS};
  vm.createContext(ctx); vm.runInContext(extractFunction('renderEnvMulti'),ctx);
  return ctx;
}

test('环境多选面板空选择时不自动勾选首项，按钮显示占位「选择 IP」',()=>{
  const btn=elStub(),panel=elStub();
  const writes=[];
  const ctx=loadRenderEnvMulti(btn,panel);
  ctx.renderEnvMulti({btnId:'envMultiBtn',panelId:'envMultiPanel',getIds:()=>[],setIds:ids=>writes.push(ids)});
  assert.equal(btn.textContent,'选择 IP');
  assert.equal(writes.length,0,'空选择不得自动改写为首项');
  assert.equal(panel.children.length,ENVS.length,'面板仍列出全部可选节点');
  assert.ok(panel.children.every(l=>l.innerHTML.indexOf('checked')<0),'默认没有任何勾选');
});

test('环境多选面板允许取消最后一个勾选（不选择任何节点）',()=>{
  const btn=elStub(),panel=elStub();
  let current=['env-a'];
  const cbA=cbStub('env-a',true),cbB=cbStub('env-b',false);
  panel._qsa=[cbA,cbB];
  const ctx=loadRenderEnvMulti(btn,panel);
  const render=()=>ctx.renderEnvMulti({btnId:'envMultiBtn',panelId:'envMultiPanel',
    getIds:()=>current,setIds:ids=>{current=ids.slice();}});
  render();
  assert.equal(btn.textContent,'10.0.0.1');
  cbA.checked=false; cbA.fireChange();
  assert.deepEqual(current,[],'取消最后一个勾选后保持空选择');
  assert.equal(cbA.checked,false,'不得强制重新勾选');
  assert.equal(btn.textContent,'选择 IP');
  cbB.checked=true; cbB.fireChange();
  assert.deepEqual(current,['env-b'],'空选择后仍可正常勾选一个节点');
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
  assert.deepEqual(ctx.schedEnvs(),[]);
  ctx.curEnvs=()=>[ENVS[0]];
  assert.deepEqual(ctx.schedEnvs().map(e=>e.id),['env-a'],'未单独选择时跟随主控');
  ctx.schedEnvIds=['env-b'];
  assert.deepEqual(ctx.schedEnvs().map(e=>e.id),['env-b'],'单独选择优先');
});
