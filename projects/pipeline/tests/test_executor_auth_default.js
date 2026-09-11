/* 执行人缺省取 dsh 登录用户：仅本地无记录时以 /auth/status 登录用户名兜底；
   已保存值、等待期间的手动输入不被覆盖；token 共享模式与探测失败保持留空。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function loadSection(overrides={}){
  const start=source.indexOf('/* ---------- 执行人缺省取 dsh 登录用户 ---------- */');
  const end=source.indexOf('/* ---------- 执行人缺省取 dsh 登录用户结束 ---------- */',start);
  assert.ok(start>=0&&end>start,'pipeline.html 缺少执行人缺省取登录用户实现');
  const ctx=Object.assign({},overrides);
  vm.createContext(ctx);
  vm.runInContext(source.slice(start,end),ctx);
  return ctx;
}
const authFetch=(body,ok=true)=>async()=>({ok,json:async()=>body});

test('本地无记录时以 dsh 登录用户名填充执行人',async()=>{
  const input={value:''};
  const ctx=loadSection({$:id=>(id==='triggeredBy'?input:null),fetch:authFetch({authenticated:true,username:'lhf'})});
  await ctx.fillExecutorFromAuth();
  assert.equal(input.value,'lhf');
});

test('登录用户名首尾空白会被裁剪；裁剪后为空则保持留空',async()=>{
  const a={value:''};
  const ctxA=loadSection({$:()=>a,fetch:authFetch({authenticated:true,username:'  zs  '})});
  await ctxA.fillExecutorFromAuth();
  assert.equal(a.value,'zs');
  const b={value:''};
  const ctxB=loadSection({$:()=>b,fetch:authFetch({authenticated:true,username:'   '})});
  await ctxB.fillExecutorFromAuth();
  assert.equal(b.value,'');
});

test('已保存的执行人不被覆盖，且不再发起探测请求',async()=>{
  const input={value:'saved-user'};
  let called=false;
  const ctx=loadSection({$:()=>input,fetch:async()=>{called=true;return {ok:true,json:async()=>({authenticated:true,username:'lhf'})};}});
  await ctx.fillExecutorFromAuth();
  assert.equal(input.value,'saved-user');
  assert.equal(called,false);
});

test('等待探测期间的手动输入优先，不被兜底值覆盖',async()=>{
  const input={value:''};
  let release;
  const gate=new Promise(r=>{release=r;});
  const ctx=loadSection({$:()=>input,fetch:async()=>{await gate;return {ok:true,json:async()=>({authenticated:true,username:'lhf'})};}});
  const pending=ctx.fillExecutorFromAuth();
  input.value='typed';
  release();
  await pending;
  assert.equal(input.value,'typed');
});

test('token 共享模式（username 为 null）与未登录保持留空',async()=>{
  for(const body of [{authenticated:true,username:null},{authenticated:false,username:null},{authenticated:true}]){
    const input={value:''};
    const ctx=loadSection({$:()=>input,fetch:authFetch(body)});
    await ctx.fillExecutorFromAuth();
    assert.equal(input.value,'',JSON.stringify(body));
  }
});

test('探测失败（非 200 / 网络异常 / 非法 JSON）静默保持留空',async()=>{
  const a={value:''};
  const ctxA=loadSection({$:()=>a,fetch:authFetch(null,false)});
  await ctxA.fillExecutorFromAuth();
  assert.equal(a.value,'');
  const b={value:''};
  const ctxB=loadSection({$:()=>b,fetch:async()=>{throw new Error('network');}});
  await ctxB.fillExecutorFromAuth();
  assert.equal(b.value,'');
  const c={value:''};
  const ctxC=loadSection({$:()=>c,fetch:async()=>({ok:true,json:async()=>{throw new Error('bad json');}})});
  await ctxC.fillExecutorFromAuth();
  assert.equal(c.value,'');
});
