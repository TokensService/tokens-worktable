/* 代码仓「部署策略」脚本来源：配置归一化、来源解析、缓存 key、脚本输出解析与执行拉取。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function extractFunction(name){
  const marker=new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match=marker.exec(source);
  assert.ok(match,`pipeline.html 缺少函数 ${name}`);
  const bodyStart=source.indexOf('{',match.index);let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    else if(source[i]==='}'&&--depth===0) return source.slice(match.index,i+1);
  }
  throw new Error(`无法提取函数 ${name}`);
}

function makeCtx(overrides={},names){
  const ctx=Object.assign({
    JSON, Object, Array, String, Number, Boolean, Promise, Set,
  },overrides);
  vm.createContext(ctx);
  vm.runInContext(names.map(extractFunction).join('\n'),ctx);
  return ctx;
}
const J=x=>JSON.parse(JSON.stringify(x));

test('normalizeRepo：旧数据缺省 URL 模式，脚本模式与脚本名随配置保留',()=>{
  const ctx=makeCtx({},['normalizeFetchMode','normalizeRepo']);
  const old=ctx.normalizeRepo({id:'r1',name:'a',url:'https://git.example.com/a.git'});
  assert.equal(old.strategyMode,'url');
  assert.equal(old.strategyScript,'');
  assert.equal(old.strategyUrl,'');
  const sc=ctx.normalizeRepo({id:'r2',strategyMode:'script',strategyScript:'list_strategies.sh',strategyUrl:'http://x/{branch}'});
  assert.equal(sc.strategyMode,'script');
  assert.equal(sc.strategyScript,'list_strategies.sh');
  assert.equal(sc.strategyUrl,'http://x/{branch}');
  assert.equal(ctx.normalizeRepo({id:'r3',strategyMode:'weird'}).strategyMode,'url');
});

test('strategySourceOf：按模式取 URL/脚本，对应值为空或未配置返回 null',()=>{
  const ctx=makeCtx({},['strategySourceOf']);
  assert.deepEqual(J(ctx.strategySourceOf({strategyMode:'url',strategyUrl:' http://x/{branch} '})),{mode:'url',url:'http://x/{branch}'});
  assert.deepEqual(J(ctx.strategySourceOf({strategyMode:'script',strategyScript:' st.sh '})),{mode:'script',script:'st.sh'});
  assert.equal(ctx.strategySourceOf({strategyMode:'url',strategyUrl:''}),null);
  assert.equal(ctx.strategySourceOf({strategyMode:'script',strategyScript:'  '}),null);
  assert.equal(ctx.strategySourceOf(null),null);
  assert.equal(ctx.strategySourceOf({}),null);
});

test('deployStrategyKey：缓存 key 含来源，改配置后旧缓存自动失效',()=>{
  const ctx=makeCtx({},['strategySourceOf','deployStrategyKey']);
  const repo={id:'r1',strategyMode:'url',strategyUrl:'http://x/{branch}'};
  const k1=ctx.deployStrategyKey(repo,'main');
  assert.notEqual(k1,ctx.deployStrategyKey({id:'r1',strategyMode:'script',strategyScript:'st.sh'},'main'));
  assert.notEqual(k1,ctx.deployStrategyKey({id:'r1',strategyMode:'url',strategyUrl:'http://y/{branch}'},'main'));
  assert.notEqual(k1,ctx.deployStrategyKey(repo,'dev'));
});

test('parseStrategyScriptOutput：每行一个策略，去空白、跳过空行、按序去重',()=>{
  const ctx=makeCtx({},['parseStrategyScriptOutput']);
  assert.deepEqual(J(ctx.parseStrategyScriptOutput(' low-latency \n\nhigh-throughput\nlow-latency\n  \ngray\n')),
    ['low-latency','high-throughput','gray']);
  assert.deepEqual(J(ctx.parseStrategyScriptOutput('')),[]);
  assert.deepEqual(J(ctx.parseStrategyScriptOutput(null)),[]);
});

test('fetchDeployStrategiesByScript：注入 GIT_* 执行脚本并解析 stdout',async ()=>{
  let seen=null;
  const fetchStub=async (url,opt)=>{ seen={url,body:JSON.parse(opt.body)}; return {json:async()=>({code:0,stdout:'s1\ns2\ns1\n',stderr:''})}; };
  const ctx=makeCtx({
    fetch:fetchStub,
    scriptByName:n=>n==='st.sh'?{name:'st.sh',path:'/scripts/st.sh'}:null,
    scriptsDir:'/scripts',
  },['parseStrategyScriptOutput','fetchDeployStrategiesByScript']);
  const repo={url:'https://git.example.com/a.git',user:'oauth2',pass:'tok'};
  const st=await ctx.fetchDeployStrategiesByScript('st.sh',repo,'feat/x');
  assert.equal(st.error,'');
  assert.deepEqual(J(st.items),['s1','s2']);
  assert.equal(seen.url,'/api/worktable/exec');
  assert.equal(seen.body.path,'/scripts/st.sh');
  assert.equal(seen.body.cwd,'/scripts');
  assert.deepEqual(J(seen.body.env),{GIT_BRANCH:'feat/x',GIT_URL:repo.url,GIT_USER:'oauth2',GIT_PASSWORD:'tok'});
});

test('fetchDeployStrategiesByScript：脚本缺失 / 非零退出 / 空输出 / 接口报错均为失败',async ()=>{
  const base={
    scriptByName:n=>n==='st.sh'?{name:'st.sh',path:'/scripts/st.sh'}:null,
    scriptsDir:'/scripts',
  };
  const missing=makeCtx({...base,fetch:async()=>{throw new Error('不应执行');}},['parseStrategyScriptOutput','fetchDeployStrategiesByScript']);
  assert.match((await missing.fetchDeployStrategiesByScript('gone.sh',{},'main')).error,/脚本不存在/);

  const nonZero=makeCtx({...base,fetch:async()=>({json:async()=>({code:2,stdout:'',stderr:'boom'})})},['parseStrategyScriptOutput','fetchDeployStrategiesByScript']);
  const st1=await nonZero.fetchDeployStrategiesByScript('st.sh',{},'main');
  assert.match(st1.error,/退出码 2/); assert.match(st1.error,/boom/); assert.deepEqual(J(st1.items),[]);

  const empty=makeCtx({...base,fetch:async()=>({json:async()=>({code:0,stdout:'  \n',stderr:''})})},['parseStrategyScriptOutput','fetchDeployStrategiesByScript']);
  assert.match((await empty.fetchDeployStrategiesByScript('st.sh',{},'main')).error,/未输出任何策略/);

  const apiErr=makeCtx({...base,fetch:async()=>({json:async()=>({error:'exec disabled'})})},['parseStrategyScriptOutput','fetchDeployStrategiesByScript']);
  assert.match((await apiErr.fetchDeployStrategiesByScript('st.sh',{},'main')).error,/exec disabled/);

  const netErr=makeCtx({...base,fetch:async()=>{throw new Error('network down');}},['parseStrategyScriptOutput','fetchDeployStrategiesByScript']);
  assert.match((await netErr.fetchDeployStrategiesByScript('st.sh',{},'main')).error,/network down/);
});
