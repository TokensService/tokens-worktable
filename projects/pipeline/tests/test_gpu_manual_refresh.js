// GPU 仅当前浏览器标签页首次载入自动刷新，项目 iframe 重建后只允许手动刷新。
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {extractFunction,extractStatement}=require('./_page-source.cjs');
function context(storage){
  const ctx={sessionStorage:storage,window:{},auto:[],calls:0,
    setTimeout(fn){ctx.auto.push(fn);},refreshGpuAll(){ctx.calls++;}};
  vm.createContext(ctx);
  // 页面脚本拆分后，状态语句（boot 分片）与函数声明（功能域分片）不再文本相邻，
  // 故按名逐条取出本页所需的状态与函数，替代原先「按相邻注释标记切片」的写法。
  vm.runInContext([
    extractStatement('const GPU_SESSION_KEY='),
    extractStatement('const gpuSession='),
    extractStatement('let gpuStatus='),
    extractFunction('saveGpuSession'),
    extractStatement('let _gpuInited='),
    extractFunction('scheduleGpuRefresh'),
  ].join('\n'),ctx);
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
