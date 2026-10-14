// 页面级「↻/⟳ 刷新」按钮的在途旋转反馈（rf-busy + pipSpin 只转图标），
// 以及节点页筛选框从右侧移到标题行左侧（跟随刷新按钮排列）的静态契约与行为测试。
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

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

function fakeButton(){
  const classes=new Set();
  return { disabled:false,
    classList:{ add:c=>classes.add(c), remove:c=>classes.delete(c), contains:c=>classes.has(c) } };
}

test('静态契约：五个页面级刷新按钮的 ↻/⟳ 图标包裹 rf-ico（旋转只动图标、不转文字）',()=>{
  ['queueRefresh','pipelineRefresh','histRefresh','envInfoRefresh','gpuRefreshAll'].forEach(id=>{
    const m=new RegExp('id="'+id+'"[^>]*>\\s*<span class="rf-ico">(↻|⟳)</span>').exec(source);
    assert.ok(m, id+' 的刷新图标应包裹 <span class="rf-ico">…</span>');
  });
});

test('静态契约：pipSpin 关键帧与 rf-busy 旋转规则齐备',()=>{
  assert.match(source,/@keyframes pipSpin \{/);
  assert.match(source,/\.rf-ico \{ display:inline-block/);
  assert.match(source,/\.rf-busy \.rf-ico \{ animation:pipSpin [^}]*infinite/);
});

test('静态契约：五个刷新路径都在在途期间 beginRefreshSpin 并在收尾 stop',()=>{
  ['queueRefresh','histRefresh'].forEach(id=>{
    const i=source.indexOf(`$('${id}').addEventListener`);
    assert.ok(i>=0, id+' 缺少点击绑定');
    const block=source.slice(i,i+400);
    assert.match(block,/beginRefreshSpin\(b\)/, id+' 点击应挂 rf-busy');
    assert.match(block,/sp\.stop\(\)/, id+' 收尾应 stop()');
  });
  ['refreshEnvsFromServer','refreshPipelinesFromServer','refreshGpuAll'].forEach(name=>{
    const fn=extractFunction(name);
    assert.ok(fn.includes('beginRefreshSpin('), name+' 应挂 rf-busy');
    assert.ok(fn.includes('sp.stop()'), name+' 收尾应 stop()');
  });
  /* 设备状态刷新在途期间禁用按钮（防连点堆积），并返回在途 Promise 供测试/调用方等待 */
  assert.match(extractFunction('refreshGpuAll'),/b\.disabled=true/);
});

test('静态契约：节点页筛选框移到标题行左侧（紧跟刷新按钮），不再被两端对齐顶到最右',()=>{
  const s=source.indexOf('<div id="pageNode"');
  const e=source.indexOf('<!-- /pageNode -->',s);
  assert.ok(s>=0 && e>s,'缺少 pageNode 容器');
  const region=source.slice(s,e);
  const iGpu=region.indexOf('id="gpuRefreshAll"');
  const iFilter=region.indexOf('id="envFilter"');
  const iH2End=region.indexOf('</h2>');
  const iEnvName=region.indexOf('id="envName"');
  assert.ok(iGpu>0 && iFilter>iGpu && iFilter<iH2End,'envFilter 应在标题行 h2 内、⟳ 设备状态按钮之后');
  assert.ok(iEnvName>iH2End,'envName 添加表单仍在标题行之后');
  const header=region.slice(0, region.indexOf('</div>', region.indexOf('id="envCount"')));
  assert.ok(!/justify-content:space-between/.test(header),'标题行不再两端对齐（筛选框不再被顶到最右）');
});

test('beginRefreshSpin：在途挂 rf-busy，落定后最短展示 500ms 再摘除；重叠在途只摘一次',async()=>{
  const ctx={ setTimeout };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('beginRefreshSpin'),ctx);
  const btn=fakeButton();
  const sp1=ctx.beginRefreshSpin(btn);
  assert.ok(btn.classList.contains('rf-busy'),'开始后立即旋转');
  sp1.stop();
  await sleep(80);
  assert.ok(btn.classList.contains('rf-busy'),'最短展示 500ms：提前落定仍保持');
  await sleep(600);
  assert.ok(!btn.classList.contains('rf-busy'),'最短展示期后摘除');

  const a=ctx.beginRefreshSpin(btn), b=ctx.beginRefreshSpin(btn);
  assert.ok(btn.classList.contains('rf-busy'));
  a.stop(); await sleep(650);
  assert.ok(btn.classList.contains('rf-busy'),'第二个操作仍在途，保持旋转');
  b.stop(); await sleep(650);
  assert.ok(!btn.classList.contains('rf-busy'),'全部落定后才摘除');

  const c=ctx.beginRefreshSpin(btn); c.stop(); c.stop();   /* stop 幂等：重复 stop 不重复减计数 */
  await sleep(650);
  assert.ok(!btn.classList.contains('rf-busy'));

  const d=ctx.beginRefreshSpin({disabled:false}); d.stop();   /* 无 classList 的桩静默跳过 */
});

test('refreshGpuAll：全部节点查询在途期间禁用并旋转，全部落定后恢复',async()=>{
  const jobs=[];
  const btn=fakeButton();
  const ctx={
    environments:[{id:'e1'},{id:'e2'}],
    fetchGpu:()=>{ let r; const p=new Promise(res=>{r=res;}); jobs.push(r); return p; },
    $:id=>id==='gpuRefreshAll'?btn:null,
    setTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('beginRefreshSpin')+'\n'+extractFunction('refreshGpuAll'),ctx);
  const done=ctx.refreshGpuAll();
  assert.equal(btn.disabled,true,'在途禁用');
  assert.ok(btn.classList.contains('rf-busy'),'在途旋转');
  jobs[0]();
  await sleep(30);
  assert.equal(btn.disabled,true,'部分落定仍禁用');
  assert.ok(btn.classList.contains('rf-busy'),'部分落定仍旋转');
  jobs[1]();
  await done;
  assert.equal(btn.disabled,false,'全部落定即恢复可用');
  assert.ok(btn.classList.contains('rf-busy'),'最短展示期内仍旋转');
  await sleep(600);
  assert.ok(!btn.classList.contains('rf-busy'),'最短展示期后摘除');
});

test('refreshEnvsFromServer：拉取在途期间挂 rf-busy，落定恢复并toast',async()=>{
  const btn=fakeButton();
  let resolveFetch;
  const toasts=[];
  const ctx={
    environments:[{id:'env-old',name:'旧节点',ip:'10.0.0.1',nodeIp:'',user:'',pass:''}],
    serverConfigBase:{environments:[{id:'env-old',name:'旧节点',ip:'10.0.0.1',nodeIp:'',user:'',pass:''}]},
    localStorage:{setItem(){}},
    $:id=>id==='envInfoRefresh'?btn:null,
    fetchPipelineStateFresh:()=>new Promise(r=>{resolveFetch=r;}),
    normalizeEnv:e=>({id:e.id,name:e.name,ip:e.ip,nodeIp:e.nodeIp||'',llmAddr:e.llmAddr||'',user:e.user||'',pass:e.pass||''}),
    renderEnvs(){}, renderEnvOptions(){},
    toast:m=>toasts.push(String(m)),
    alert:m=>{ throw new Error('不应告警: '+m); },
    setTimeout,
  };
  vm.createContext(ctx);
  const s0=source.indexOf('/* ---------- 节点信息手动刷新 ---------- */');
  const s1=source.indexOf('/* ---------- 代码仓配置',s0);
  assert.ok(s0>=0 && s1>s0,'节点信息手动刷新逻辑未找到');
  vm.runInContext(extractFunction('sameEnvEntry')+'\n'+extractFunction('mergeEnvironmentsFromServer')+'\n'+extractFunction('beginRefreshSpin')+'\n'+source.slice(s0,s1),ctx);
  const p=ctx.refreshEnvsFromServer();
  assert.equal(btn.disabled,true,'在途禁用');
  assert.ok(btn.classList.contains('rf-busy'),'拉取在途旋转');
  resolveFetch({config:{environments:[{id:'env-old',name:'旧节点',ip:'10.0.0.1',user:''}]}});
  await p;
  assert.equal(btn.disabled,false,'落定恢复可用');
  assert.equal(toasts.length,1,'刷新成功 toast');
  assert.ok(btn.classList.contains('rf-busy'),'最短展示期内仍旋转');
  await sleep(600);
  assert.ok(!btn.classList.contains('rf-busy'),'最短展示期后摘除');
});
