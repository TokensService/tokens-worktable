const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/pipeline.html','utf8');

function loadReplayCode(ctx){
  const start=source.indexOf('async function loadReplayLog(');
  const end=source.indexOf('/* 回放态：从历史 logs 重建',start);
  assert.ok(start>=0 && end>start,'历史回放日志加载函数不存在');
  vm.createContext(ctx); vm.runInContext(source.slice(start,end),ctx);
}

function response(text,headers){ return {ok:true,text:async()=>text,headers:{get:k=>(headers||{})[k.toLowerCase()]||null}}; }

test('进入历史回放只拉取当前阶段日志和 profile',async()=>{
  const requests=[];
  const ctx={selectedId:'s2',flowStages:()=>[{id:'s1',name:'构建'},{id:'s2',name:'部署'}],fetch:async url=>{
    requests.push(url);
    return response(url.includes('profile.json')?'{}':'tail\n',{'x-worktable-file-truncated':'tail','x-worktable-file-size':'16777216'});
  }};
  loadReplayCode(ctx);
  const rec={archive:'/archive/run',tag:'t1',logs:[
    {stage:'构建',logFile:'/archive/build.log'},
    {stage:'部署',logFile:'/archive/deploy.log'},
    {stage:'测试',logFile:'/archive/test.log'},
  ]};
  await ctx.loadReplayLogs(rec);
  assert.equal(requests.length,2);
  assert.ok(requests.some(x=>x.includes(encodeURIComponent('/archive/deploy.log'))));
  assert.ok(requests.some(x=>x.includes('profile.json')));
  assert.ok(requests.every(x=>!x.includes(encodeURIComponent('/archive/build.log'))));
  assert.ok(requests.every(x=>!x.includes(encodeURIComponent('/archive/test.log'))));
  assert.match(requests.find(x=>x.includes('deploy.log')),/[?&]tailBytes=65536(?:&|$)/);
  assert.equal(rec._lc['部署'],'tail\n');
  assert.equal(rec._lm['部署'].truncated,true);
  assert.equal(rec._lm['部署'].size,16777216);
});

test('切换阶段后仅补载新选中的日志，已缓存阶段不重复请求',async()=>{
  const requests=[];
  const ctx={selectedId:'s1',flowStages:()=>[{id:'s1',name:'构建'},{id:'s2',name:'部署'}],fetch:async url=>{
    requests.push(url); return response('tail\n');
  }};
  loadReplayCode(ctx);
  const rec={_profChecked:true,logs:[
    {stage:'构建',logFile:'/archive/build.log'},
    {stage:'部署',logFile:'/archive/deploy.log'},
  ]};
  await ctx.loadReplayLogs(rec);
  ctx.selectedId='s2'; await ctx.loadReplayLogs(rec);
  ctx.selectedId='s1'; await ctx.loadReplayLogs(rec);
  assert.equal(requests.length,2);
  assert.ok(requests[0].includes('build.log'));
  assert.ok(requests[1].includes('deploy.log'));
});
