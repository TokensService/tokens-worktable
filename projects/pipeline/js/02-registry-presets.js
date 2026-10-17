/* ===== 02-registry-presets.js · 流水线注册表、默认运行参数、预设任务定义与编排渲染 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 1786–1962）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */

/* ---------- 流水线注册表（多条流水线） ---------- */
/* ---------- 流水线默认运行参数 ---------- */
/* ---------- 预设任务定义（必须在 loadPipelines/normalizePipelineDefaults 之前声明） ---------- */
/* PRESET_DEF / presetDefOf 被 normalizePipelineDefaults 在顶层 loadPipelines() 中调用；
   若声明在 loadPipelines 之后，const PRESET_DEF 会因暂时性死区（TDZ）抛
   "Cannot access 'PRESET_DEF' before initialization"，整页脚本中断、流水线列表不渲染。 */
/* 旧版识别器会把静态 :-默认值 预填进 values 作为显式值（压过运行级注入）；现默认值填入参数框可编辑、未改动不预填不下发。
   加载存量数据时清掉与识别默认值相同的 values 项（视为预填产物），回到「留空=注入值/脚本默认兜底」语义 */
function cleanScriptValues(params, values){
  const out={};
  for(const k in (values||{})){
    const p=(params||[]).find(o=>o.key===k);
    if(p && String(values[k])===String(p.def||'')) continue;
    out[k]=values[k];
  }
  return out;
}

/* ---------- 自定义预设任务（设置页「预设任务设置」添加/配置；与系统预设同一机制：主控勾选启用、编排位置执行、仅页面运行支持） ---------- */
/* 数据形状：{key:'c'+时间戳36进制（保证唯一）, name, script:{name,path,params,values}|null, block, pos:'first'|'last', enabled}；
   持久化：localStorage 键 pip-customPresets + 服务端 config 字段 customPresets（collectConfig/loadServerState/导入设置三通道）；
   customPresets 任何变更都经 saveCustomPresets 落盘并重建名称表/面板/按钮/设置页专区 */
function normalizeCustomPresets(list){
  const out=[], seen={};
  (Array.isArray(list)?list:[]).forEach(item=>{
    if(!item || typeof item!=='object' || Array.isArray(item)) return;   // 非对象项剔除
    const name=(typeof item.name==='string'?item.name:'').trim();
    if(!name) return;   // 无名项剔除
    let key=(typeof item.key==='string')?item.key.trim():'';
    if(key && seen[key]) return;   // key 去重：同 key 只保留首项
    if(!key){ let n=out.length+1; do{ key='c'+(n++).toString(36); }while(seen[key]); }   // key 补缺：按位置生成并保证表内唯一
    seen[key]=1;
    let script=null;
    const sc=item.script;
    if(sc && typeof sc==='object' && typeof sc.name==='string' && sc.name.trim()){
      script={name:sc.name, path:(typeof sc.path==='string'?sc.path:''), params:(sc.params!==undefined?sc.params:[]), values:(sc.values!==undefined?sc.values:{})};   // 仅保留 {name,path,params,values}
    }
    out.push({key:key, name:name, script:script, block:!!item.block, pos:(item.pos==='last'?'last':'first'), enabled:!!item.enabled});
  });
  return out;
}

/* ---------- 渲染流水线编排 ---------- */
/* 预设定义统一查询：系统 pkey 返回 PRESET_DEF 项本身；自定义 key 由 customPresets 派生（script 取该项配置的 getter）；
   未知 pkey 返回 null（调用方兜底）。customPresets 在沙盒单独抽取本段时可能不存在，typeof 兜底视同空数组 */
function presetDefOf(pkey){
  if(PRESET_DEF[pkey]) return PRESET_DEF[pkey];
  const cp=((typeof customPresets!=='undefined'&&Array.isArray(customPresets))?customPresets:[]).find(c=>c && c.key===pkey);
  if(!cp) return null;
  return {id:'__custom_'+cp.key+'__', el:'presetCustom_'+cp.key, name:cp.name, script:()=>cp.script, block:!!cp.block, noScript:'未配置「'+cp.name+'」脚本', custom:true};
}
/* 面板勾选项与按钮文案的枚举顺序：系统三项在前，自定义按 customPresets 数组顺序在后 */
function presetOrderAll(){ return PRESET_ORDER.concat(((typeof customPresets!=='undefined'&&Array.isArray(customPresets))?customPresets:[]).map(c=>c.key)); }
function rebuildPresetNameMap(){
  Object.keys(PRESET_BY_NAME).forEach(n=>{ delete PRESET_BY_NAME[n]; });   // 原地重建：delete 旧键再填入，保持对象引用
  PRESET_ORDER.forEach(k=>{ PRESET_BY_NAME[PRESET_DEF[k].name]=k; });
  ((typeof customPresets!=='undefined'&&Array.isArray(customPresets))?customPresets:[]).forEach(c=>{ if(c && c.name) PRESET_BY_NAME[c.name]=c.key; });
}
function pipelineDefaultStringList(value){
  if(!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(v=>typeof v==='string').map(v=>v.trim()).filter(Boolean)));
}
function normalizePipelineDefaults(value){
  const d=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  return {
    environmentIds:pipelineDefaultStringList(d.environmentIds),
    repositoryId:typeof d.repositoryId==='string'?d.repositoryId.trim():'',
    branch:typeof d.branch==='string'&&d.branch.trim()?d.branch.trim():'main',
    strategy:typeof d.strategy==='string'?d.strategy.trim():'',
    presets:pipelineDefaultStringList(d.presets).filter((typeof presetDefOf==='function')?presetDefOf:(k=>PIPELINE_DEFAULT_PRESET_KEYS.indexOf(k)>=0)),   /* 页面内经 presetDefOf 判定（系统 + 自定义预设）；vm 沙盒单独抽取本段时没有 presetDefOf，退回系统三项白名单 */
  };
}
function migratePipelineDefaults(p){ if(p&&typeof p==='object'){ p.defaults=normalizePipelineDefaults(p.defaults); if(typeof p.createdBy!=='string') p.createdBy=''; if(typeof p.owner!=='string') p.owner=''; if(typeof p.updatedBy!=='string') p.updatedBy=''; p.favoriteUsers=pipelineFavoriteUsers(p); } return p; }
/* 仅旧流水线从未保存过默认环境引用（无 environmentIds 字段）时回退当前首项；编辑器保存过的空环境
   列表 = 显式不选择任何节点（无目标节点运行）；已保存但失效的引用由 pipelineDefaultRunIssue 阻断。 */
function pipelineDefaultRunOptions(pl){
  const raw=pl&&pl.defaults&&typeof pl.defaults==='object'&&!Array.isArray(pl.defaults)?pl.defaults:null;
  const d=normalizePipelineDefaults(raw);
  const envs=(raw&&Array.isArray(raw.environmentIds))?d.environmentIds.map(id=>environments.find(e=>e.id===id)).filter(Boolean):environments.slice(0,1);
  const repo=d.repositoryId?repositories.find(r=>r.id===d.repositoryId):(repositories[0]||null);
  return {envs,repoId:repo?repo.id:'',branch:d.branch,strategy:d.strategy,presets:d.presets.slice()};
}
function pipelineDefaultRunIssue(pl,overrides){
  const d=normalizePipelineDefaults(pl&&pl.defaults),issues=[];
  const hasEnvOverride=!!(overrides&&((Array.isArray(overrides.envs)&&overrides.envs.length)||overrides.env));
  const hasRepoOverride=!!(overrides&&typeof overrides.repoId==='string'&&overrides.repoId);
  const missingEnvs=hasEnvOverride?[]:d.environmentIds.filter(id=>!environments.some(e=>e.id===id));
  if(missingEnvs.length) issues.push('默认环境已失效：'+missingEnvs.join('、'));
  /* 节点预留：默认环境当前被预留给他人时同样拦截（仅未提供环境覆盖时检查默认口径；
     有覆盖时的实际节点由 runPipeline 自行检查）。typeof 守卫：vm 抽取测试无该函数时跳过 */
  if(!hasEnvOverride && typeof envReservationIssue==='function'){
    const resIssue=envReservationIssue(d.environmentIds.map(id=>environments.find(e=>e.id===id)).filter(Boolean));
    if(resIssue) issues.push(resIssue);
  }
  if(!hasRepoOverride&&d.repositoryId&&!repositories.some(r=>r.id===d.repositoryId)) issues.push('默认代码仓已失效：'+d.repositoryId);
  return issues.join('；');
}
function resolvePipelineRunOptions(pl,opts){
  const input=Object.assign({},opts||{});
  if(!input.useDefaults) return input;
  delete input.useDefaults;
  return Object.assign(pipelineDefaultRunOptions(pl),input);
}
function collectPipelineDefaultForm(){
  const wrap=$('plDefaultPresets');
  const presets=wrap ? Array.from(wrap.querySelectorAll('[data-pldefaultpreset]')).filter(el=>el.checked).map(el=>el.getAttribute('data-pldefaultpreset')) : [];
  return normalizePipelineDefaults({
    environmentIds:editDefaults&&Array.isArray(editDefaults.environmentIds)?editDefaults.environmentIds:[],
    repositoryId:$('plDefaultRepo')?$('plDefaultRepo').value:'',
    branch:$('plDefaultBranch')?$('plDefaultBranch').value:'main',
    strategy:$('plDefaultStrategy')?$('plDefaultStrategy').value:'',
    presets,
  });
}
function currentPipelineDefaultSeed(){
  return normalizePipelineDefaults({
    environmentIds:curEnvs().map(e=>e.id).filter(Boolean),
    repositoryId:($('repoSel')&&$('repoSel').value)||(curRepo()&&curRepo().id)||'',
    branch:($('branchName')&&$('branchName').value)||'main',
    strategy:curStrategy(),
    presets:selectedPresetKeys(),
  });
}
function currentPipelineRunOptions(){
  const seed=currentPipelineDefaultSeed();
  return {
    envs:seed.environmentIds.map(id=>environments.find(env=>env.id===id)).filter(Boolean),
    repoId:seed.repositoryId,
    branch:seed.branch,
    strategy:seed.strategy,
    weightsPath:curWeightsPath(),   // 权重路径是运行行临时配置（不进流水线默认值）：弹窗默认继承主控当前值
    presets:seed.presets.slice(),
  };
}
function renderPipelineDefaultForm(){
  editDefaults=normalizePipelineDefaults(editDefaults);
  renderEnvMulti({btnId:'plDefaultEnvMultiBtn',panelId:'plDefaultEnvMultiPanel',
    getIds:()=>editDefaults.environmentIds,
    setIds:ids=>{ editDefaults.environmentIds=ids.slice(); },
    after:()=>{ editDefaults=collectPipelineDefaultForm(); schedulePlDraftSave(); }});
  const repoSel=$('plDefaultRepo');
  repoSel.innerHTML='';
  repositories.forEach(r=>{ const o=document.createElement('option'); o.value=r.id; o.textContent=r.name||r.url||r.id; repoSel.appendChild(o); });
  if(repositories.some(r=>r.id===editDefaults.repositoryId)) repoSel.value=editDefaults.repositoryId;
  else if(repositories[0]){ repoSel.value=repositories[0].id; editDefaults.repositoryId=repositories[0].id; }
  $('plDefaultBranch').value=editDefaults.branch;
  $('plDefaultStrategy').value=editDefaults.strategy;
  $('plDefaultPresets').querySelectorAll('[data-pldefaultpreset]').forEach(el=>{ el.checked=editDefaults.presets.indexOf(el.getAttribute('data-pldefaultpreset'))>=0; });
}
/* ---------- 流水线默认运行参数结束 ---------- */
