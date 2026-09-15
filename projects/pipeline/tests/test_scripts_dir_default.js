/* 脚本目录默认值与设置页配置（pipeline.html）：默认路径=插件安装后的 scripts 路径
   （/api/worktable/health 的 dir + /projects/pipeline/scripts）；localStorage/服务端设置
   文件已配置时不被安装默认覆盖；设置页保存/重置语义（留空=恢复安装默认） */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function extractFunction(name){
  const marker=new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match=marker.exec(source);
  assert.ok(match,`pipeline.html 缺少函数 ${name}`);
  const start=match.index;
  const bodyStart=source.indexOf('{',start);
  let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    if(source[i]==='}'){ depth-=1; if(depth===0) return source.slice(start,i+1); }
  }
  throw new Error(`无法提取函数 ${name}`);
}

/* 把脚本目录相关函数装进同一 vm 上下文：overrides 提供初始全局（scriptsDir/scriptsDirIsFallback/
   installedScriptsDir 与 saveScriptsDir/loadScripts/renderScriptsDirCfg stub 等） */
function makeCtx(overrides={}){
  const calls={save:0,load:0,render:0};
  const ctx=Object.assign({
    console,
    scriptsDir:'scripts',
    scriptsDirIsFallback:true,
    installedScriptsDir:null,
    saveScriptsDir:()=>{ calls.save+=1; },
    loadScripts:()=>{ calls.load+=1; },
    renderScriptsDirCfg:()=>{ calls.render+=1; },
  },overrides);
  ctx.__calls=calls;
  vm.createContext(ctx);
  ['detectScriptsDir','scriptsDirDefault','maybeAdoptInstalledScriptsDir','applyScriptsDirInput'].forEach(n=>vm.runInContext(extractFunction(n),ctx));
  return ctx;
}

test('detectScriptsDir：无 location 兜底相对 scripts；site 路由按页面目录推导', ()=>{
  const ctx=makeCtx();
  assert.equal(vm.runInContext('detectScriptsDir()',ctx),'scripts');
  const enc=encodeURIComponent('/opt/tokens-worktable/projects/pipeline');
  const ctx2=makeCtx({location:{pathname:'/api/worktable/site/'+enc+'/pipeline.html'}});
  assert.equal(vm.runInContext('detectScriptsDir()',ctx2),'/opt/tokens-worktable/projects/pipeline/scripts');
});

test('scriptsDirDefault：安装默认已解析优先，否则退回 URL 嗅探', ()=>{
  const ctx=makeCtx({installedScriptsDir:'/installed/pkg/projects/pipeline/scripts'});
  assert.equal(vm.runInContext('scriptsDirDefault()',ctx),'/installed/pkg/projects/pipeline/scripts');
  const ctx2=makeCtx();
  assert.equal(vm.runInContext('scriptsDirDefault()',ctx2),'scripts');
});

test('maybeAdoptInstalledScriptsDir：fallback 态 + 安装默认到达 → 升级并落盘刷新', ()=>{
  const ctx=makeCtx({scriptsDir:'scripts',scriptsDirIsFallback:true,installedScriptsDir:'/installed/scripts'});
  vm.runInContext('maybeAdoptInstalledScriptsDir()',ctx);
  assert.equal(ctx.scriptsDir,'/installed/scripts');
  assert.deepEqual(ctx.__calls,{save:1,load:1,render:1});
});

test('maybeAdoptInstalledScriptsDir：已配置（非 fallback）或无安装默认时不动', ()=>{
  const configured=makeCtx({scriptsDir:'/custom/scripts',scriptsDirIsFallback:false,installedScriptsDir:'/installed/scripts'});
  vm.runInContext('maybeAdoptInstalledScriptsDir()',configured);
  assert.equal(configured.scriptsDir,'/custom/scripts');
  assert.deepEqual(configured.__calls,{save:0,load:0,render:0});
  const noDefault=makeCtx({scriptsDir:'scripts',scriptsDirIsFallback:true,installedScriptsDir:null});
  vm.runInContext('maybeAdoptInstalledScriptsDir()',noDefault);
  assert.equal(noDefault.scriptsDir,'scripts');
  assert.deepEqual(noDefault.__calls,{save:0,load:0,render:0});
  const same=makeCtx({scriptsDir:'/installed/scripts',scriptsDirIsFallback:true,installedScriptsDir:'/installed/scripts'});
  vm.runInContext('maybeAdoptInstalledScriptsDir()',same);
  assert.deepEqual(same.__calls,{save:0,load:0,render:0},'已是安装默认不重复落盘');
});

test('applyScriptsDirInput：自定义值保存为显式配置；留空恢复安装默认并回到 fallback 态', ()=>{
  const ctx=makeCtx({installedScriptsDir:'/installed/scripts'});
  vm.runInContext(`applyScriptsDirInput('  /srv/my-scripts  ')`,ctx);
  assert.equal(ctx.scriptsDir,'/srv/my-scripts');
  assert.equal(ctx.scriptsDirIsFallback,false);
  vm.runInContext(`applyScriptsDirInput('')`,ctx);
  assert.equal(ctx.scriptsDir,'/installed/scripts','留空=恢复安装默认');
  assert.equal(ctx.scriptsDirIsFallback,true);
  assert.deepEqual(ctx.__calls,{save:2,load:2,render:2});
});

test('renderScriptsDirCfg：回显生效值与安装默认路径', ()=>{
  const inp={value:'',active:false};
  const tip={textContent:''};
  const els={cfgScriptsDir:inp,cfgScriptsDirTip:tip};
  const ctx=vm.createContext(Object.assign({
    $:id=>els[id]||null,
    document:{activeElement:null},
    scriptsDir:'/custom/scripts',
    scriptsDirIsFallback:false,
    installedScriptsDir:'/installed/scripts',
  }));
  vm.runInContext(extractFunction('renderScriptsDirCfg'),ctx);
  vm.runInContext('renderScriptsDirCfg()',ctx);
  assert.equal(inp.value,'/custom/scripts');
  assert.match(tip.textContent,/安装默认：\/installed\/scripts/);
  assert.ok(!/当前生效/.test(tip.textContent),'自定义态不标注「当前生效」');
  /* 输入框聚焦时不回写（避免打断编辑）；fallback 态标注「当前生效」 */
  const ctx2=vm.createContext(Object.assign({
    $:id=>els[id]||null,
    document:{activeElement:inp},
    scriptsDir:'/installed/scripts',
    scriptsDirIsFallback:true,
    installedScriptsDir:'/installed/scripts',
  }));
  vm.runInContext(extractFunction('renderScriptsDirCfg'),ctx2);
  inp.value='(编辑中)';
  vm.runInContext('renderScriptsDirCfg()',ctx2);
  assert.equal(inp.value,'(编辑中)');
  assert.match(tip.textContent,/（当前生效）/);
});

test('源码契约：服务端配置无 scriptsDir 时 loadServerState 走安装默认兜底', ()=>{
  const m=/if\(typeof cfg\.scriptsDir==='string' && cfg\.scriptsDir\)\{ scriptsDir=cfg\.scriptsDir; scriptsDirIsFallback=false; \}\s*\n\s*else maybeAdoptInstalledScriptsDir\(\);/.exec(source);
  assert.ok(m,'loadServerState 应在服务端未配置 scriptsDir 时调用 maybeAdoptInstalledScriptsDir');
});
