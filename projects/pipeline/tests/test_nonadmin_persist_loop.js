/* #73：非 admin 看可信流水线时的 persist→403→重拉 死循环。
   动机：migrateInlineLogs 把旧版"内嵌日志全文"迁成"归档文件引用"并 persist 落盘——本是好的存量迁移。
   bug：非 admin 看可信流水线时 persist 必 403；migrate 在 loadServerState 末尾每次重跑→persist→403→
        403 分支重拉 loadServerState→服务端仍返回原始内嵌日志(persist 没落盘)→又重跑 migrate→…
        每秒一圈 229KB GET + 403 PUT + 整页重渲染 = CPU 17-19%。
   修复：migrateInlineLogs 加会话闩锁(_migrateInlineLogsDone)，每会话最多跑一次。
   代价：只读用户的迁移不在本会话完成——但只读用户本就写不进去，迁移对他们从不会成功，无真实损失；
        有写权限者(admin)打开时迁移照常落盘。瞬态错误重试推迟到下次刷新，可接受。
   本测=闩锁本身：服务端反复返回内嵌日志时迁移只触发一次 persist。配合既有 pushState 403 测
   (403→loadServerState 重拉)即证循环断：重拉后 migrate 被闩住、不再 persist、不再 403。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=require('./_page-source.cjs').loadPageSource();

function extractFunction(name){
  const match=new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match,`pipeline.html 缺少函数 ${name}`);
  const bodyStart=source.indexOf('{',match.index);let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    else if(source[i]==='}'&&--depth===0) return source.slice(match.index,i+1);
  }
  throw new Error(`无法提取函数 ${name}`);
}

/* 一条带内嵌日志全文的旧版历史记录（migrateInlineLogs 要迁它的目标） */
function inlineLogHistory(){
  return [{ tag:'run-1', archive:'/arc/run-1', logs:[{stage:'拉取镜像',status:'success',dur:1,log:'[Pipeline] stage { (拉取镜像)\n…内嵌日志全文…\n[Pipeline] }'}] }];
}

function makeCtx(){
  const persists=[], writes=[], fsCalls=[];
  const ctx={
    Object,Array,Promise,String,JSON,Set,
    PRESET_BY_NAME:{},
    sanitizeFsName:s=>String(s).replace(/[^\w.-]/g,'_'),
    apiWrite:async(fp,content)=>{ writes.push(fp); return {ok:true}; },
    persistState:()=>{ persists.push(1); },
    fetch:async(url,options)=>{ fsCalls.push(url); return {ok:true,json:async()=>({entries:[]})}; },
  };
  ctx.history=inlineLogHistory();
  vm.createContext(ctx);
  vm.runInContext('let _migrateInlineLogsDone=false;\n'+extractFunction('migrateInlineLogs'),ctx);
  return {ctx,persists,writes,fsCalls};
}

test('migrateInlineLogs 会话闩锁：服务端反复返回内嵌日志(persist 被 403 挡住落不了盘)时，迁移只触发一次 persist，不再每秒死循环 (#73)', async ()=>{
  const {ctx,persists,writes}=makeCtx();

  // 第 1 次 = 首次 loadServerState 末尾：发现内嵌日志→写归档文件→persist(随后 403，引用没存回服务端)
  await ctx.migrateInlineLogs();
  assert.equal(persists.length,1,'首次迁移触发一次 persist');
  assert.ok(writes.length>=1,'归档文件已写出');

  // 403 自愈重拉 loadServerState：服务端仍返回原始内嵌日志(persist 没落盘)，history 被重置为带内嵌日志
  ctx.history=inlineLogHistory();
  // 第 2 次：闩锁生效，直接返回，不再 persist——死循环断
  await ctx.migrateInlineLogs();
  assert.equal(persists.length,1,'闩锁：重拉后第二次不再触发 persist（否则就是每秒一圈 229KB GET+403 PUT 死循环）');
  assert.equal(writes.length,1,'闩锁：不重复写归档文件');

  ctx.history=inlineLogHistory();
  await ctx.migrateInlineLogs();
  assert.equal(persists.length,1,'闩锁持续生效：第三次仍不触发');
});

test('migrateInlineLogs 闩锁不误杀首迁移：有内嵌日志时该写该 persist 仍正常（证明闩锁只挡重试，不挡正经迁移）', async ()=>{
  const {ctx,persists,writes}=makeCtx();
  await ctx.migrateInlineLogs();
  assert.equal(persists.length,1,'首迁移正常触发 persist');
  assert.ok(writes.length>=1,'首迁移正常写归档文件');
  assert.equal(typeof ctx.history[0].logs[0].logFile,'string','内嵌 log 已替换为 logFile 路径引用');
  assert.equal(ctx.history[0].logs[0].log,undefined,'原内嵌 log 字段已移除');
});
