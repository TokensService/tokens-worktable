/* 执行人固定取 dsh 登录用户（只读、不可编辑）：每次加载都以 /auth/status 探测结果为准并覆盖
   任何既有值；不做本地/服务端持久化恢复；token 共享模式、未登录与探测失败保持留空（运行按
   「未获取到登录用户」拦截）。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function loadSection(overrides={}){
  const start=source.indexOf('/* ---------- 执行人固定取 dsh 登录用户（只读） ---------- */');
  const end=source.indexOf('/* ---------- 执行人固定取 dsh 登录用户（只读）结束 ---------- */',start);
  assert.ok(start>=0&&end>start,'pipeline.html 缺少执行人固定取登录用户实现');
  const ctx=Object.assign({},overrides);
  vm.createContext(ctx);
  vm.runInContext(source.slice(start,end),ctx);
  return ctx;
}
const authFetch=(body,ok=true)=>async()=>({ok,json:async()=>body});

test('以 dsh 登录用户名填充执行人展示文本，并缓存 currentUsername 供署名/筛选取用',async()=>{
  const el={textContent:'未登录'};
  const ctx=loadSection({$:id=>(id==='triggeredBy'?el:null),fetch:authFetch({authenticated:true,username:'lhf'}),currentUsername:''});
  await ctx.fillExecutorFromAuth();
  assert.equal(el.textContent,'lhf');
  assert.equal(ctx.currentUsername,'lhf');
});

test('既有值一律被当前登录用户覆盖（不再有「已保存值优先」），且必然发起探测',async()=>{
  const el={textContent:'saved-user'};
  let called=false;
  const ctx=loadSection({$:()=>el,fetch:async()=>{called=true;return {ok:true,json:async()=>({authenticated:true,username:'lhf'})};},currentUsername:'saved-user'});
  await ctx.fillExecutorFromAuth();
  assert.equal(called,true);
  assert.equal(el.textContent,'lhf','执行人只读：任何残留展示都被登录用户覆盖');
  assert.equal(ctx.currentUsername,'lhf');
});

test('登录用户名首尾空白会被裁剪；裁剪后为空则保持原状不覆盖',async()=>{
  const a={textContent:'未登录'};
  const ctxA=loadSection({$:()=>a,fetch:authFetch({authenticated:true,username:'  zs  '}),currentUsername:''});
  await ctxA.fillExecutorFromAuth();
  assert.equal(a.textContent,'zs');
  const b={textContent:'未登录'};
  const ctxB=loadSection({$:()=>b,fetch:authFetch({authenticated:true,username:'   '}),currentUsername:'keep'});
  await ctxB.fillExecutorFromAuth();
  assert.equal(b.textContent,'未登录','取不到用户时展示文本保持「未登录」');
  assert.equal(ctxB.currentUsername,'keep','取不到用户时不动既有缓存');
});

test('token 共享模式（username 为 null）与未登录保持留空',async()=>{
  for(const body of [{authenticated:true,username:null},{authenticated:false,username:null},{authenticated:true}]){
    const el={textContent:'未登录'};
    const ctx=loadSection({$:()=>el,fetch:authFetch(body),currentUsername:''});
    await ctx.fillExecutorFromAuth();
    assert.equal(el.textContent,'未登录',JSON.stringify(body));
    assert.equal(ctx.currentUsername,'',JSON.stringify(body));
  }
});

test('探测失败（非 200 / 网络异常 / 非法 JSON）静默保持留空',async()=>{
  for(const bad of [authFetch(null,false),async()=>{throw new Error('network');},async()=>({ok:true,json:async()=>{throw new Error('bad json');}})]){
    const el={textContent:'未登录'};
    const ctx=loadSection({$:()=>el,fetch:bad,currentUsername:''});
    await ctx.fillExecutorFromAuth();
    assert.equal(el.textContent,'未登录');
    assert.equal(ctx.currentUsername,'');
  }
});

test('拿到登录用户后按「我的」筛选视图重绘流水线列表',async()=>{
  const el={textContent:'未登录'};
  let renders=0;
  const ctx=loadSection({
    $:()=>el,
    fetch:authFetch({authenticated:true,username:'lhf'}),
    currentUsername:'',
    plFilter:{kw:'',owner:'mine'},
    renderPipelines:()=>{renders+=1;},
  });
  await ctx.fillExecutorFromAuth();
  assert.equal(renders,1);
});
