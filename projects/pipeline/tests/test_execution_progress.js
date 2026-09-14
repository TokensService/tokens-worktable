// 回归：后台探测不得占满连接；手动执行不中途转交计划；打开目录须等日志落盘。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname+'/../pipeline.html', 'utf8');
function load(start, end, context){
  const a=source.indexOf(start), b=source.indexOf(end,a);
  assert.ok(a>=0 && b>a);
  vm.runInNewContext(source.slice(a,b),context);
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('六个慢节点及重复刷新不阻塞流水线请求', async()=>{
  const pending=[];
  const ctx={console, environments:Array.from({length:6},(_,id)=>({id})), gpuStatus:{},
    document:{querySelector:()=>null}, renderEnvOptions(){}, saveGpuSession(){}, envFilterText:'', envSort:{},
    fetch(){ return new Promise(resolve=>pending.push(()=>resolve({json:async()=>({total:1})}))); }};
  load('async function fetchGpu(e)', '/* 设备详情弹层',ctx);
  ctx.refreshGpuAll(); ctx.refreshGpuAll();
  await tick();
  assert.ok(pending.length<=2, 'GPU 查询占满同源连接：'+pending.length);
  let count=0;
  while(pending.length){ pending.shift()(); count++; await tick(); }
  assert.equal(count,6,'重复刷新应复用已排队查询');
});

test('混合 sched 标记的手动流水线立即进入第二个脚本',()=>{
  const called=[];
  const rc={id:'r1',stages:[{script:{path:'/gen.sh'}},{sched:{},script:{path:'/print.sh'}}],nodes:[],selId:null,
    timer:null,over:false,overall:null,token:'t1',vars:{},by:'tester',source:'manual'};
  const ctx={runPresetStep(){},skipStage(){},stageUrlOf:()=>'',runUrlStep(){},runEvaltokensStep(){},
    runScriptStep:(rc,i)=>called.push(i),runStage(){},finish(){},taskPromFinalize(){}};
  load('function pipelineStageGroups(stages)', '/* ===== 主视图节点拖拽改序',ctx);
  load('function startStageAt(rc,i)', 'function advance(rc,i)',ctx);
  load('function advance(rc,i)', '/* ---------- 阶段间变量传递',ctx);
  ctx.advance(rc,1);
  assert.deepEqual(called,[1]);
});

test('运行中打开日志目录保留执行页面',async()=>{
  let closed=false, opened=false;
  const ctx={running:true,console,$:()=>({style:{}}),archiveTargetFolder:()=>'/logs/run',archiveRootFolder:()=>'/logs',
    waitArchiveWrites:async()=>{},window:{parent:{__dshOpenFolderInSidebar(){opened=true;return true;},
      async __dshNewChatSessionAtFolder(){closed=true;}}}};
  load('async function openArchiveFolder()', "$('openArchiveBtn')",ctx);
  await ctx.openArchiveFolder();
  assert.equal(opened,true); assert.equal(closed,false);
});

test('打开目录前等待写入',async()=>{
  let release, opened=false;
  const ctx={console,fetch:url=>String(url).indexOf('/api/worktable/fs')>=0
    ? Promise.resolve({ok:true,json:async()=>({entries:[]})})   // 打开前的目录存在性预检直接放行
    : new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({ok:true})});})};
  load('async function apiWrite(', '/* 是否显式配置',ctx);
  Object.assign(ctx,{running:false,$:()=>({style:{}}),archiveTargetFolder:()=>'/logs/run',archiveRootFolder:()=>'/logs',
    window:{parent:{__dshOpenFolderInSidebar(){opened=true;return true;},async __dshNewChatSessionAtFolder(){}}}});
  load('async function openArchiveFolder()', "$('openArchiveBtn')",ctx);
  const write=ctx.apiWrite('/logs/run/run.log','hello');
  const open=ctx.openArchiveFolder(); await tick();
  assert.equal(opened,false,'尚未落盘就打开了目录');
  release(); await write; await open; assert.equal(opened,true);
});

test('日志写入失败时提示错误并保留页面',async()=>{
  const tip={style:{}}; let opened=false;
  const ctx={console,fetch:async()=>({ok:false,status:500,json:async()=>({error:'disk full'})})};
  load('async function apiWrite(', '/* 是否显式配置',ctx);
  Object.assign(ctx,{running:false,$:()=>tip,archiveTargetFolder:()=>'/logs/run',archiveRootFolder:()=>'/logs',
    window:{parent:{__dshOpenFolderInSidebar(){opened=true;return true;}}}});
  load('async function openArchiveFolder()', "$('openArchiveBtn')",ctx);
  await assert.rejects(ctx.apiWrite('/logs/run/run.log','hello'),/disk full/);
  await ctx.openArchiveFolder();
  assert.equal(opened,false); assert.match(tip.textContent,/disk full/);
});

test('历史归档只打开一次目录，不创建或切换会话',async()=>{
  const folders=[],tip={style:{}}; let sessions=0;
  const ctx={running:false,console,$:()=>tip,archiveTargetFolder:()=>'/logs/selected',archiveRootFolder:()=>'/logs',
    waitArchiveWrites:async()=>{},window:{parent:{
      __dshOpenFolderInSidebar(folder){folders.push(folder);return true;},
      async __dshNewChatSessionAtFolder(){sessions++;}
    }}};
  load('async function openArchiveFolder()', "$('openArchiveBtn')",ctx);
  await ctx.openArchiveFolder();
  assert.equal(sessions,0);assert.deepEqual(folders,['/logs/selected']);
  assert.match(tip.textContent,/已在侧边栏打开/);
});

test('侧边窗打开成功后关闭侧边会话窗',async()=>{
  const folders=[],tip={style:{}}; let chatClosed=0;
  const ctx={running:false,console,$:()=>tip,archiveTargetFolder:()=>'/logs/selected',archiveRootFolder:()=>'/logs',
    waitArchiveWrites:async()=>{},window:{parent:{
      __dshOpenFolderInSidebar(folder){folders.push(folder);return true;},
      __dshCloseSideChat(){chatClosed++;}
    }}};
  load('async function openArchiveFolder()', "$('openArchiveBtn')",ctx);
  await ctx.openArchiveFolder();
  assert.deepEqual(folders,['/logs/selected']);
  assert.equal(chatClosed,1,'侧边窗打开成功应关闭侧边会话窗');
  assert.match(tip.textContent,/已在侧边栏打开/);
});

test('侧边栏不可用时回退系统文件管理器且不关会话窗',async()=>{
  const folders=[],tip={style:{}}; let chatClosed=0;
  const ctx={running:false,console,$:()=>tip,archiveTargetFolder:()=>'/logs/selected',archiveRootFolder:()=>'/logs',
    waitArchiveWrites:async()=>{},openFolderViaFileManager:async folder=>folders.push(folder),
    window:{parent:{
      __dshOpenFolderInSidebar(){throw new Error('unavailable');},
      __dshCloseSideChat(){chatClosed++;}
    }}};
  load('async function openArchiveFolder()', "$('openArchiveBtn')",ctx);
  await ctx.openArchiveFolder();
  assert.deepEqual(folders,['/logs/selected']);
  assert.equal(chatClosed,0,'回退系统文件管理器时不得关会话窗');
});

test('侧边栏不可用时回退系统文件管理器，不创建会话',async()=>{
  const folders=[],tip={style:{}};let sessions=0;
  const ctx={running:false,console,$:()=>tip,archiveTargetFolder:()=>'/logs/selected',archiveRootFolder:()=>'/logs',
    waitArchiveWrites:async()=>{},openFolderViaFileManager:async folder=>folders.push(folder),
    window:{parent:{__dshOpenFolderInSidebar(){throw new Error('unavailable');},
      async __dshNewChatSessionAtFolder(){sessions++;}}}};
  load('async function openArchiveFolder()', "$('openArchiveBtn')",ctx);
  await ctx.openArchiveFolder();
  assert.equal(sessions,0);assert.deepEqual(folders,['/logs/selected']);
});

/* 目录存在性预检：/api/worktable/fs 对目标 500（不存在）、对父目录 200（存在）。 */
const fsProbeFallback=(missing,existing)=>async(url,opt)=>{
  const p=JSON.parse(opt.body).path;
  if(p===missing) return {ok:false,status:500,json:async()=>({error:'ENOENT'})};
  if(p===existing) return {ok:true,json:async()=>({entries:[]})};
  throw new Error('unexpected probe '+p);
};

test('目标归档目录已清理时回退打开归档根（侧边栏路径）',async()=>{
  const folders=[],tip={style:{}}; let sessions=0;
  const ctx={running:false,console,$:()=>tip,archiveTargetFolder:()=>'/logs/selected_run',archiveRootFolder:()=>'/logs',
    waitArchiveWrites:async()=>{},fetch:fsProbeFallback('/logs/selected_run','/logs'),
    window:{parent:{__dshOpenFolderInSidebar(f){folders.push(f);return true;},
      async __dshNewChatSessionAtFolder(){sessions++;}}}};
  load('async function openArchiveFolder()', "$('openArchiveBtn')",ctx);
  await ctx.openArchiveFolder();
  assert.equal(sessions,0);
  assert.deepEqual(folders,['/logs'],'应以归档根为回退目标打开');
  assert.match(tip.textContent,/目标目录不存在，已回退打开 \/logs/);
});

test('目标与归档根都不存在时报错且不打开',async()=>{
  const folders=[],tip={style:{}};
  const ctx={running:false,console,$:()=>tip,archiveTargetFolder:()=>'/logs/selected_run',archiveRootFolder:()=>'/logs',
    waitArchiveWrites:async()=>{},fetch:async()=>({ok:false,status:500,json:async()=>({error:'ENOENT'})}),
    window:{parent:{__dshOpenFolderInSidebar(f){folders.push(f);return true;}}}};
  load('async function openArchiveFolder()', "$('openArchiveBtn')",ctx);
  await ctx.openArchiveFolder();
  assert.deepEqual(folders,[],'目录不存在时不得打开侧边栏窗口');
  assert.match(tip.textContent,/✗ 目录不存在（含归档根目录）：\/logs\/selected_run/);
});

test('存在性探测请求失败时按存在处理，不阻断打开',async()=>{
  const folders=[],tip={style:{}};
  const ctx={running:false,console,$:()=>tip,archiveTargetFolder:()=>'/logs/selected',archiveRootFolder:()=>'/logs',
    waitArchiveWrites:async()=>{},fetch:async()=>{throw new Error('network down');},
    window:{parent:{__dshOpenFolderInSidebar(f){folders.push(f);return true;}}}};
  load('async function openArchiveFolder()', "$('openArchiveBtn')",ctx);
  await ctx.openArchiveFolder();
  assert.deepEqual(folders,['/logs/selected']);
  assert.match(tip.textContent,/已在侧边栏打开/);
});
