// 设置页「节点环境」手动刷新节点信息：点按钮从服务端配置重拉节点环境列表，
// 按 id 三方合并（他端增删改同步进来、本地未落盘新增/修改保留），基线 environments 随之推进。
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');
/* vm 上下文产出的对象/数组原型与宿主不同，deepEqual 前做 JSON 往返 */
const J=x=>JSON.parse(JSON.stringify(x));

function extractFunction(name){
  const match=new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match,`pipeline.html 缺少函数 ${name}`);
  const bodyStart=source.indexOf('{',match.index);
  let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    else if(source[i]==='}'){ depth-=1; if(depth===0) return source.slice(match.index,i+1); }
  }
  throw new Error(`无法提取函数 ${name}`);
}

function context({remote,fetchError,local,base}={}){
  const stored=new Map();
  const alerts=[];
  const toasts=[];
  const calls={envs:0,options:0};
  const button={disabled:false,addEventListener(type,handler){ if(type==='click') this.click=handler; }};
  const ctx={
    environments:local||[{id:'env-old',name:'旧节点',ip:'10.0.0.1',nodeIp:'',user:'',pass:''}],
    serverConfigBase:base!==undefined?base:{environments:[{id:'env-old',name:'旧节点',ip:'10.0.0.1',nodeIp:'',user:'',pass:''}]},
    localStorage:{setItem:(k,v)=>stored.set(k,v)},
    $:id=>id==='envInfoRefresh'?button:null,
    fetchPipelineStateFresh:async()=>{
      if(fetchError) throw fetchError;
      return remote;
    },
    normalizeEnv:e=>({id:e.id,name:e.name,ip:e.ip,nodeIp:e.nodeIp||'',llmAddr:e.llmAddr||'',user:e.user||'',pass:e.pass||''}),
    renderEnvs:()=>{ calls.envs++; },
    renderEnvOptions:()=>{ calls.options++; },
    toast:m=>toasts.push(String(m)),
    alert:m=>alerts.push(String(m)),
  };
  vm.createContext(ctx);
  /* 只抽取函数本体；点击绑定在脚本尾部统一初始化区（const $ 声明之后），由静态契约覆盖 */
  const start=source.indexOf('/* ---------- 节点信息手动刷新 ---------- */');
  const end=source.indexOf('/* ---------- 代码仓配置',start);
  assert.ok(start>=0 && end>start,'节点信息手动刷新逻辑未找到');
  vm.runInContext(extractFunction('sameEnvEntry')+'\n'+extractFunction('mergeEnvironmentsFromServer')+'\n'+extractFunction('beginRefreshSpin')+'\n'+source.slice(start,end),ctx);
  return {ctx,stored,alerts,toasts,calls,button};
}

test('静态契约：节点环境标题行提供 envInfoRefresh 按钮并绑定手动刷新',()=>{
  assert.match(source,/id="envInfoRefresh"[^>]*><span class="rf-ico">↻<\/span> 刷新节点信息<\/button>/);
  assert.match(source,/\$\('envInfoRefresh'\)\.addEventListener\('click',\s*refreshEnvsFromServer\)/);
  assert.match(source,/async function refreshEnvsFromServer\s*\(/);
});

test('刷新节点信息：他端新增/修改同步进来，本地未落盘新增保留，基线推进到服务端快照',async()=>{
  const remote={config:{environments:[
    {id:'env-old',name:'旧节点-他端改名',ip:'10.0.0.1',user:'ops'},
    {id:'env-a',name:'开发',ip:'10.0.0.2',user:'ops'},
    {id:'env-b',name:'生产',ip:'10.0.0.3',nodeIp:'192.168.31.10',llmAddr:'192.168.31.10:8000',user:'root',pass:'p'},
  ]}};
  const localNew={id:'env-new',name:'本页刚加未落盘',ip:'10.0.0.9',nodeIp:'',user:'root',pass:'x'};
  const {ctx,stored,alerts,toasts,calls,button}=context({
    remote,
    local:[{id:'env-old',name:'旧节点',ip:'10.0.0.1',nodeIp:'',user:'',pass:''},localNew],
  });
  await ctx.refreshEnvsFromServer();
  assert.deepEqual(J(ctx.environments).map(e=>e.id),['env-old','env-a','env-b','env-new'],'远端序在前，本地未落盘新增追加保留');
  assert.equal(ctx.environments[0].name,'旧节点-他端改名','本地未改动的条目以服务端为准');
  assert.equal(ctx.environments[2].nodeIp,'192.168.31.10');
  assert.equal(ctx.environments[2].llmAddr,'192.168.31.10:8000','他端 LLM服务地址 同步进来');
  assert.equal(ctx.environments[0].nodeIp,'','normalizeEnv 补齐缺省 nodeIp');
  assert.equal(ctx.environments[0].llmAddr,'','normalizeEnv 补齐缺省 llmAddr');
  assert.deepEqual(J(ctx.serverConfigBase.environments).map(e=>e.id),['env-old','env-a','env-b'],'基线推进到服务端快照（不含本地未落盘新增）');
  assert.equal(stored.get('pip-envs'),JSON.stringify(ctx.environments));
  assert.equal(calls.envs,1);
  assert.equal(calls.options,1);
  assert.deepEqual(alerts,[]);
  assert.equal(toasts.length,1);
  assert.match(toasts[0],/4 个节点/);
  assert.equal(button.disabled,false,'完成后恢复按钮');
});

test('刷新节点信息：远端已删除且本地未改动的条目随远端删除；本地有改动（保存在途）的保留',async()=>{
  const remote={config:{environments:[{id:'env-a',name:'开发',ip:'10.0.0.2'}]}};
  const {ctx}=context({
    remote,
    base:{environments:[
      {id:'env-a',name:'开发',ip:'10.0.0.2'},
      {id:'env-gone',name:'他端已删',ip:'10.0.0.4'},
      {id:'env-editing',name:'本端在途改',ip:'10.0.0.5'},
    ]},
    local:[
      {id:'env-a',name:'开发',ip:'10.0.0.2',nodeIp:'',user:'',pass:''},
      {id:'env-gone',name:'他端已删',ip:'10.0.0.4',nodeIp:'',user:'',pass:''},
      {id:'env-editing',name:'本端在途改',ip:'10.0.0.5',nodeIp:'',user:'admin',pass:'changed'},
    ],
  });
  await ctx.refreshEnvsFromServer();
  assert.deepEqual(J(ctx.environments).map(e=>e.id),['env-a','env-editing'],'env-gone 随远端删除；env-editing 本地在途改动保留');
  assert.equal(ctx.environments[1].user,'admin');
});

test('刷新节点信息：拉取失败 / 服务端无环境时 alert 且不改本地列表、基线不动',async()=>{
  const before=[{id:'env-old',name:'旧节点',ip:'10.0.0.1',nodeIp:'',user:'',pass:''}];
  const fail=context({fetchError:new Error('网络断开')});
  await fail.ctx.refreshEnvsFromServer();
  assert.deepEqual(fail.ctx.environments,before);
  assert.equal(fail.stored.has('pip-envs'),false);
  assert.equal(fail.calls.envs,0);
  assert.match(fail.alerts[0],/刷新节点信息失败：网络断开/);
  assert.equal(fail.button.disabled,false);

  const empty=context({remote:{config:{environments:[]}}});
  await empty.ctx.refreshEnvsFromServer();
  assert.deepEqual(empty.ctx.environments,before);
  assert.match(empty.alerts[0],/服务端暂无节点环境/);

  const nullSt=context({remote:null});
  await nullSt.ctx.refreshEnvsFromServer();
  assert.deepEqual(nullSt.ctx.environments,before);
  assert.match(nullSt.alerts[0],/服务端配置拉取失败/);
});

test('刷新节点信息：按钮绑定位于 const $ 声明之后的统一初始化区（防 TDZ）',()=>{
  const decl=source.indexOf('const $ =');
  const bind=source.indexOf("$('envInfoRefresh').addEventListener('click', refreshEnvsFromServer)");
  assert.ok(decl>=0,'未找到 const $ 声明');
  assert.ok(bind>=0,'未找到 envInfoRefresh 点击绑定');
  assert.ok(bind>decl,'绑定必须出现在 const $ 声明之后，否则顶层执行触发 TDZ 中断整页脚本');
});
