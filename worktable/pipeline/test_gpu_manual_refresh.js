// GPU 仅当前浏览器标签页首次载入自动刷新，项目 iframe 重建后只允许手动刷新。
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/pipeline.html','utf8');
function context(storage){
  const ctx={sessionStorage:storage,window:{},auto:[],calls:0,
    setTimeout(fn){ctx.auto.push(fn);},refreshGpuAll(){ctx.calls++;}};
  vm.createContext(ctx);
  const a=source.indexOf('/* 节点设备状态查询'), b=source.indexOf('/* 占用判定',a);
  vm.runInContext(source.slice(a,b),ctx);
  const c=source.indexOf('let _gpuInited='), d=source.indexOf('/* 从服务端拉取配置与历史',c);
  vm.runInContext(source.slice(c,d),ctx);
  return ctx;
}
test('首次载入一次，重建 iframe 不查询，手动刷新仍生效',()=>{
  const store=new Map(),storage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)};
  const first=context(storage);
  first.scheduleGpuRefresh(); first.scheduleGpuRefresh();
  assert.equal(first.auto.length,1); first.auto.shift()(); assert.equal(first.calls,1);
  const reopened=context(storage);
  reopened.scheduleGpuRefresh(); assert.equal(reopened.auto.length,0);
  reopened.refreshGpuAll(); assert.equal(reopened.calls,1);
});
test('禁用存储时仍仅在当前页面首次自动刷新',()=>{
  const ctx=context({getItem(){throw new Error('disabled');},setItem(){throw new Error('disabled');}});
  ctx.scheduleGpuRefresh();ctx.scheduleGpuRefresh();
  assert.equal(ctx.auto.length,1);ctx.auto.shift()();assert.equal(ctx.calls,1);
});
test('重新打开项目保留上次查询结果',()=>{
  const store=new Map(),storage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)};
  const first=context(storage);
  vm.runInContext('gpuStatus={node1:{total:8,used:2}}; saveGpuSession();',first);
  const reopened=context(storage);
  assert.equal(vm.runInContext('gpuStatus.node1.used',reopened),2);
  reopened.scheduleGpuRefresh();assert.equal(reopened.auto.length,0);
});
