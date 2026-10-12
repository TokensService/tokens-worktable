// 设置页「节点环境」手动刷新节点信息：点按钮从服务端配置重拉节点环境列表，覆盖本地缓存并重渲染。
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function context({remote,fetchError}={}){
  const stored=new Map();
  const alerts=[];
  const toasts=[];
  const calls={envs:0,options:0};
  const button={disabled:false,addEventListener(type,handler){ if(type==='click') this.click=handler; }};
  const ctx={
    environments:[{id:'env-old',name:'旧节点',ip:'10.0.0.1',nodeIp:'',user:'',pass:''}],
    localStorage:{setItem:(k,v)=>stored.set(k,v)},
    $:id=>id==='envInfoRefresh'?button:null,
    fetchPipelineStateFresh:async()=>{
      if(fetchError) throw fetchError;
      return remote;
    },
    normalizeEnv:e=>({id:e.id,name:e.name,ip:e.ip,nodeIp:e.nodeIp||'',user:e.user||'',pass:e.pass||''}),
    renderEnvs:()=>{ calls.envs++; },
    renderEnvOptions:()=>{ calls.options++; },
    toast:m=>toasts.push(String(m)),
    alert:m=>alerts.push(String(m)),
  };
  vm.createContext(ctx);
  /* 函数 + 紧随其后的按钮绑定（与「流水线任务手动刷新」同一切片口径） */
  const start=source.indexOf('/* ---------- 节点信息手动刷新 ---------- */');
  const end=source.indexOf('/* ---------- 代码仓配置',start);
  assert.ok(start>=0 && end>start,'节点信息手动刷新逻辑未找到');
  vm.runInContext(source.slice(start,end),ctx);
  return {ctx,stored,alerts,toasts,calls,button};
}

test('静态契约：节点环境标题行提供 envInfoRefresh 按钮并绑定手动刷新',()=>{
  assert.match(source,/id="envInfoRefresh"[^>]*>↻ 刷新节点信息</);
  assert.match(source,/\$\('envInfoRefresh'\)\.addEventListener\('click',\s*refreshEnvsFromServer\)/);
  assert.match(source,/async function refreshEnvsFromServer\s*\(/);
});

test('刷新节点信息：服务端列表整体替换本地环境并写离线缓存、重渲染',async()=>{
  const remote={config:{environments:[
    {id:'env-a',name:'开发',ip:'10.0.0.1',user:'ops'},
    {id:'env-b',name:'生产',ip:'10.0.0.2',nodeIp:'192.168.31.10',user:'root',pass:'p'},
  ]}};
  const {ctx,stored,alerts,toasts,calls,button}=context({remote});
  await ctx.refreshEnvsFromServer();
  assert.equal(ctx.environments.length,2);
  assert.equal(ctx.environments[0].name,'开发');
  assert.equal(ctx.environments[1].nodeIp,'192.168.31.10');
  assert.equal(ctx.environments[0].nodeIp,'','normalizeEnv 补齐缺省 nodeIp');
  assert.equal(stored.get('pip-envs'),JSON.stringify(ctx.environments));
  assert.equal(calls.envs,1);
  assert.equal(calls.options,1);
  assert.deepEqual(alerts,[]);
  assert.equal(toasts.length,1);
  assert.match(toasts[0],/2 个节点/);
  assert.equal(button.disabled,false,'完成后恢复按钮');
});

test('刷新节点信息：拉取失败 / 服务端无环境时 alert 且不改本地列表',async()=>{
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

test('刷新节点信息：按钮点击接线到 refreshEnvsFromServer',()=>{
  const {ctx,button}=context({remote:{config:{environments:[{id:'env-x',name:'X',ip:'1.1.1.1'}]}}});
  assert.equal(typeof button.click,'function','切片应包含按钮绑定');
  assert.equal(button.click,ctx.refreshEnvsFromServer);
});
