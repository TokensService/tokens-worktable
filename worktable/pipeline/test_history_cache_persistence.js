const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/pipeline.html','utf8');

test('服务端持久化历史剔除回放缓存但保留业务字段',()=>{
  const start=source.indexOf('function historyForPersist(');
  const end=source.indexOf('async function pushState(',start);
  assert.ok(start>=0 && end>start,'historyForPersist not found');
  const ctx={history:[
    {no:1,tag:'t1',pipeline:'部署',logs:[{stage:'构建',logFile:'/logs/a.log'}],_lc:{构建:'x'.repeat(1024)},_lm:{构建:{size:1024}},_ll:{构建:{}},_profChecked:true},
    {no:0,demo:true,_lc:{演示:'demo'}},
  ]};
  vm.createContext(ctx); vm.runInContext(source.slice(start,end),ctx);
  const out=ctx.historyForPersist();
  assert.equal(out.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(out[0])),{no:1,tag:'t1',pipeline:'部署',logs:[{stage:'构建',logFile:'/logs/a.log'}]});
  assert.ok(ctx.history[0]._lc,'内存缓存不得被清理函数原地删除');
});
