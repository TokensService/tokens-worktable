/* ===== 24-import-export.js · 设置页导入导出、剪贴板与服务端备份 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 11721–12082）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */

/* ---------- 设置 / 流水线导入导出（标题区右上角「导入导出」菜单） ----------
   导出设置 = 设置页全部配置（collectConfig 去掉 pipelines——流水线走独立导出）：节点密码与代码仓/服务
             访问令牌明文、视图状态与定时环境（schedEnvIds/histFilter/plFilter/histPageSize/plPageSize）随 config
             携带（与服务端持久化同口径）；运行行临时配置（curPipelineId/selectedEnvIds/curRepoId/branch/strategy/
             weightsPath/预设勾选）只在 local 块输出（仅本地，不进 config/服务端）；
   导出流水线 = 全部流水线定义（含预置流水线上的编辑）。
   每个导出 / 导入都有「浏览器本地文件」「服务端备份」与「剪贴板」三个去向：本地下载 / 文件选择框、
   落盘 / 读取 dsh 服务器 storages/pipeline-exports/ 目录（见下方「服务端备份」区块），或复制 JSON /
   粘贴导入（见下方「剪贴板」区块）；三种去向共用同一份 payload 与恢复逻辑。
   导入按文件内容整体恢复（文件为权威，未出现在文件中的配置项保持当前值）：导入设置不动流水线，导入流水线不动其余设置；
   运行历史不参与导入导出。导出文件含节点密码与令牌明文，勿提交仓库、勿外传。 */
function ioTimestamp(){ const d=new Date(), p=n=>String(n).padStart(2,'0'); return ''+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds()); }
function downloadJson(filename, data){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  a.download=filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}
function ioTipShow(msg, bad){ const t=$('ioTip'); if(!t) return; t.style.color=bad?'var(--log-err)':'var(--log-ok)'; t.textContent=msg; }
function collectSettingsForExport(){
  const cfg=collectConfig();
  delete cfg.pipelines;   /* 流水线独立导出，见 exportPipelines */
  /* collectConfig 已携带代码仓访问令牌 pass（与服务端持久化同口径）：导出文件即完整备份，含明文令牌、勿外传 */
  return cfg;
}
function buildSettingsExport(){
  return {
    app:'worktable-pipeline', kind:'pipeline-settings', version:1, exportedAt:new Date().toISOString(),
    config:collectSettingsForExport(),
    /* 运行行临时配置只在 local 块输出（不进 config/服务端）；兼容旧版导入：旧文件里这些键在 config，pick 仍可取到 */
    local:{ curPipelineId, selectedEnvIds, curRepoId, schedEnvIds, branch:$('branchName').value, strategy:$('deployStrategyName').value, weightsPath:$('weightsPath').value, histFilter, histPageSize,
      cleanupEnabled:!!($('cleanupEnv')&&$('cleanupEnv').checked), checkEnabled:!!($('checkEnv')&&$('checkEnv').checked), profilingEnabled:!!($('profilingEnv')&&$('profilingEnv').checked) },
  };
}
function exportSettings(){
  downloadJson('pipeline-settings-'+ioTimestamp()+'.json', buildSettingsExport());
  ioTipShow('✓ 已导出设置配置');
}
function buildPipelinesExport(){
  return {
    app:'worktable-pipeline', kind:'pipeline-pipelines', version:1, exportedAt:new Date().toISOString(),
    pipelines:pipelines,
  };
}
function exportPipelines(){
  downloadJson('pipeline-pipelines-'+ioTimestamp()+'.json', buildPipelinesExport());
  ioTipShow('✓ 已导出 '+pipelines.length+' 条流水线');
}
/* 导入的流水线列表归一化：与 loadServerState 同一套迁移（内置置顶重组 + gate/url/预填默认值迁移）；非法列表返回 null */
function normalizeImportedPipelines(list){
  if(!Array.isArray(list) || !list.some(p=>p && Array.isArray(p.stages))) return null;
  return regroupBuiltinPipelines(list).map(migrateGate).map(migrateStageUrl).map(migratePrefillDefaults).map(migratePipelineDefaults).map(migratePromPreset);
}
/* 应用导入的设置配置（不含流水线）：文件为权威，缺省键保持当前值；随后统一落 localStorage + persistState 推服务端 + 全量重渲染 */
function applyImportedSettings(cfg, loc){
  cfg=cfg||{}; loc=loc||{};
  /* 节点环境仅 admin 可经导入覆盖：非 admin 跳过 environments（服务端 environmentsWriteDeny 会 403 整包
     拒绝，跳过可保住其余设置的导入）；调用方据 envConfigEditable 给「未导入节点环境」提示 */
  if(Array.isArray(cfg.environments) && envConfigEditable()) environments=cfg.environments.map(normalizeEnv);
  if(Array.isArray(cfg.repositories)) repositories=cfg.repositories.map(normalizeRepo);   /* 访问令牌按文件内容恢复（含空值） */
  if(typeof cfg.scriptsDir==='string' && cfg.scriptsDir){ scriptsDir=cfg.scriptsDir; scriptsDirIsFallback=false; }   /* 导入文件为权威：含 scriptsDir 即转为显式配置 */
  if(typeof cfg.theme==='string' && ['auto','dark','light'].indexOf(cfg.theme)>=0){ themePref=cfg.theme; $('theme').value=themePref; }
  if(Number.isFinite(cfg.buildNo)) buildNo=cfg.buildNo;
  if(cfg.cleanupScript===null || (cfg.cleanupScript && typeof cfg.cleanupScript.name==='string')) cleanupScript=cfg.cleanupScript;
  if(cfg.checkScript===null || (cfg.checkScript && typeof cfg.checkScript.name==='string')) checkScript=cfg.checkScript;
  if(cfg.profilingScript===null || (cfg.profilingScript && typeof cfg.profilingScript.name==='string')) profilingScript=cfg.profilingScript;
  if(Array.isArray(cfg.customPresets)) customPresets=normalizeCustomPresets(cfg.customPresets);   /* 自定义预设任务按文件恢复；落盘与名称表/面板/专区重建由下方 saveCustomPresets 统一完成 */
  if(cfg.jenkins && typeof cfg.jenkins==='object') jenkins=Object.assign({}, DEFAULT_JENKINS, cfg.jenkins);
  if(cfg.evaltok && typeof cfg.evaltok==='object') evaltok=Object.assign({}, DEFAULT_EVALTOK, cfg.evaltok);
  else if(cfg.evalscope && typeof cfg.evalscope==='object') evaltok=Object.assign({}, DEFAULT_EVALTOK, cfg.evalscope);   /* 兼容旧 EvalScope 配置快照 */
  if(cfg.prom && typeof cfg.prom==='object') prom=Object.assign({}, DEFAULT_PROM, cfg.prom);
  if(typeof cfg.archiveDir==='string') archiveDir=cfg.archiveDir;
  if(typeof cfg.archiveScriptName==='string') archiveScriptName=cfg.archiveScriptName;
  if(cfg.analysisPrompts && typeof cfg.analysisPrompts==='object') analysisPrompts=Object.assign({}, DEFAULT_PROMPTS, cfg.analysisPrompts);
  if(Number.isFinite(cfg.histClearedAt)) histClearedAt=cfg.histClearedAt;
  /* 运行行临时配置与视图状态：新版导出在 local 块（预设勾选/流水线/环境/代码仓/分支/策略/权重路径）或 config
     （schedEnvIds/筛选/页大小），旧版导出在 config——config 优先、local 兜底；两处都没有保持当前值 */
  const pick=k=> cfg[k]!==undefined ? cfg[k] : loc[k];
  const impCur=pick('curPipelineId');
  if(typeof impCur==='string' && pipelines.some(p=>p.id===impCur)){ curPipelineId=impCur; viewRc=null; syncViewRun(); }
  const impEnvSel=pick('selectedEnvIds');
  if(Array.isArray(impEnvSel)) selectedEnvIds=impEnvSel.length?impEnvSel.filter(id=>typeof id==='string'):null;
  const impRepo=pick('curRepoId');
  if(typeof impRepo==='string') curRepoId=impRepo;
  const impSchedEnv=pick('schedEnvIds');
  if(Array.isArray(impSchedEnv)) schedEnvIds=impSchedEnv.length?impSchedEnv.filter(id=>typeof id==='string'):null;
  const impBranch=pick('branch');
  if(typeof impBranch==='string') $('branchName').value=impBranch;
  const impStrategy=pick('strategy');
  if(typeof impStrategy==='string') $('deployStrategyName').value=impStrategy;
  const impWeights=pick('weightsPath');
  if(typeof impWeights==='string') $('weightsPath').value=impWeights;
  const impCleanup=pick('cleanupEnabled');
  if(typeof impCleanup==='boolean') $('cleanupEnv').checked=impCleanup;
  const impCheck=pick('checkEnabled');
  if(typeof impCheck==='boolean') $('checkEnv').checked=impCheck;
  const impProfiling=pick('profilingEnabled');
  if(typeof impProfiling==='boolean') $('profilingEnv').checked=impProfiling;
  /* 旧配置里的 loc.by（执行人）不再恢复：执行人只读、固定取当前登录用户（fillExecutorFromAuth） */
  const impHistFilter=pick('histFilter');
  if(impHistFilter && typeof impHistFilter==='object'){
    histFilter={kw:String(impHistFilter.kw||''),status:String(impHistFilter.status||''),pipeline:String(impHistFilter.pipeline||'')};
    $('histFilterKw').value=histFilter.kw; $('histFilterStatus').value=histFilter.status; $('histFilterPipeline').value=histFilter.pipeline;
  }
  const impHistSize=pick('histPageSize');
  if(Number.isFinite(impHistSize)){ histPageSize=Math.max(1,parseInt(impHistSize,10)||10); $('histPageSize').value=String(histPageSize); }
  const impPlFilter=pick('plFilter');
  if(impPlFilter && typeof impPlFilter==='object'){
    plFilter={kw:String(impPlFilter.kw||''),owner:String(impPlFilter.owner||'mine'),favorite:impPlFilter.favorite==='favorite'?'favorite':'all'};
    $('plFilterKw').value=plFilter.kw; $('plFilterOwner').value=typeof plOwnerFilterLabel==='function'?plOwnerFilterLabel(plFilter.owner):plFilter.owner; $('plFilterFavorite').value=plFilter.favorite;
  }
  const impPlSize=pick('plPageSize');
  if(Number.isFinite(impPlSize)){ plPageSize=Math.max(1,parseInt(impPlSize,10)||10); $('plPageSize').value=String(plPageSize); }
  /* 统一落盘：localStorage（含本地令牌/选择）+ debounce 推服务端 */
  saveEnvs(); saveEnvSel(); saveRepos(); saveRepoSel(); saveScriptsDir();
  try{ localStorage.setItem('pip-theme', themePref); localStorage.setItem('pip-curPipeline', curPipelineId); }catch(e){}
  saveCleanup(); saveCheck(); saveProfiling();
  if(typeof saveCustomPresets==='function') saveCustomPresets();   /* 自定义预设任务同一落口（沙盒单独抽取本函数时跳过） */
  saveJenkins(); saveEvaltok(); saveProm(); saveArchiveDir(); saveArchiveScript(); savePrompts();
  saveSchedEnvSel(); saveRunSelLS(); saveHistFilter();
  if(typeof savePlFilter==='function') savePlFilter();   /* 流水线筛选同一落口（沙盒单独抽取本函数时跳过） */
  try{ localStorage.setItem('pip-histPageSize', String(histPageSize)); if(typeof plPageSize!=='undefined') localStorage.setItem('pip-plPageSize', String(plPageSize)); }catch(e){}
  /* 设置页各表单回填 + 全量重渲染（与 loadServerState 同一收尾） */
  $('cleanupScriptName').value=cleanupScript?cleanupScript.name:''; renderCleanupParams();
  $('checkScriptName').value=checkScript?checkScript.name:''; renderCheckParams();
  $('profilingScriptName').value=profilingScript?profilingScript.name:''; renderProfilingParams();
  $('archiveDir').value=archiveDir; $('archiveScriptName').value=archiveScriptName;
  renderAll();
}
/* 导入设置数据（已解析的 JSON，本地文件与服务端备份共用）：返回 ok / ok-noenvs（非 admin 跳过节点环境）/ cancel / invalid 供调用方给提示 */
async function importSettingsData(data){
  if(!data || data.app!=='worktable-pipeline' || data.kind!=='pipeline-settings' || !data.config || typeof data.config!=='object') return 'invalid';
  /* 节点环境仅 admin 可经导入覆盖（applyImportedSettings 内跳过 environments）：非 admin 且文件含节点环境时
     确认文案点名排除，返回值区分提示（服务端 environmentsWriteDeny 为硬门禁，跳过可保住其余设置的导入） */
  const skipEnvs=!envConfigEditable() && Array.isArray(data.config.environments);
  if(!confirm('导入将按文件内容覆盖当前设置（'+(skipEnvs?'':'节点环境 / ')+'代码仓 / 脚本与服务配置等，含文件中的令牌），流水线与运行历史不受影响。'+(skipEnvs?'节点环境仅 admin 可配置，本次不导入。':'')+'确定导入？')) return 'cancel';
  if(!stateLoaded){ await loadServerState(); }   /* 等服务端状态落定再覆盖，避免 pushState 写前重载把导入内容冲掉 */
  applyImportedSettings(data.config, data.local);
  return skipEnvs?'ok-noenvs':'ok';
}
async function importSettingsFile(file){
  let data=null; try{ data=JSON.parse(await file.text()); }catch(e){}
  const r=await importSettingsData(data);
  if(r==='ok') ioTipShow('✓ 设置已导入并保存');
  else if(r==='ok-noenvs') ioTipShow('✓ 设置已导入并保存（节点环境仅 admin 可配置，未导入）');
  else if(r==='invalid') ioTipShow('✗ 不是「导出设置」生成的有效文件', true);
}
/* 导入流水线数据（已解析的 JSON，本地文件与服务端备份共用）：返回 ok / cancel / invalid */
async function importPipelinesData(data){
  const list=(data && data.app==='worktable-pipeline' && data.kind==='pipeline-pipelines') ? normalizeImportedPipelines(data.pipelines) : null;
  if(!list) return 'invalid';
  if(!confirm('导入将按文件内容覆盖当前全部流水线（含预置流水线上的改动），其余设置与运行历史不受影响。确定导入？')) return 'cancel';
  if(!stateLoaded){ await loadServerState(); }
  pipelines=list;
  if(!pipelines.some(p=>p.id===curPipelineId)) curPipelineId=pipelines[0].id;
  viewRc=null; syncViewRun();
  savePipelines();
  try{ localStorage.setItem('pip-curPipeline', curPipelineId); }catch(e){}
  renderAll();
  return 'ok';
}
async function importPipelinesFile(file){
  let data=null; try{ data=JSON.parse(await file.text()); }catch(e){}
  const r=await importPipelinesData(data);
  if(r==='ok') ioTipShow('✓ 已导入 '+pipelines.length+' 条流水线');
  else if(r==='invalid') ioTipShow('✗ 不是「导出流水线」生成的有效文件', true);
}
/* ---------- 剪贴板（与本地文件 / 服务端备份并列的第三条去向） ----------
   导出：与本地下载同一份 payload（buildSettingsExport / buildPipelinesExport）序列化后写入剪贴板；
   导入：textarea 粘贴 JSON，按 kind 自动识别设置 / 流水线，复用 importSettingsData / importPipelinesData
   的校验、确认与恢复逻辑。不走 clipboard.readText，避免权限弹窗，粘贴内容以用户手动粘贴为准。 */
function ioClipTipShow(msg, bad){ const t=$('ioClipTip'); if(!t) return; t.style.color=bad?'var(--log-err)':'var(--log-ok)'; t.textContent=msg; }
function exportSettingsToClipboard(){
  copyText(JSON.stringify(buildSettingsExport(),null,2), $('ioExpSettingsClip'));
  ioTipShow('✓ 设置已复制到剪贴板');
}
function exportPipelinesToClipboard(){
  copyText(JSON.stringify(buildPipelinesExport(),null,2), $('ioExpPipelinesClip'));
  ioTipShow('✓ '+pipelines.length+' 条流水线已复制到剪贴板');
}
function openIoClipImport(){
  const d=$('ioClipDialog'); if(!d) return;
  const ta=$('ioClipText'); if(ta) ta.value='';
  ioClipTipShow('');
  d.style.display='flex';
}
function closeIoClipImport(){ const d=$('ioClipDialog'); if(d) d.style.display='none'; }
/* 从剪贴板文本导入：坏 JSON / 非本页备份给 ✗ 提示并留在对话框内供修正；
   识别后走与文件 / 服务端导入相同的数据入口，成功关闭对话框并给 ✓ 提示 */
async function importFromClipboardText(text){
  let data=null;
  try{ data=JSON.parse(String(text==null?'':text).trim()); }catch(e){}
  if(!data || typeof data!=='object' || Array.isArray(data)){ ioClipTipShow('✗ 粘贴内容不是有效 JSON', true); return 'invalid'; }
  const kind=(data.app==='worktable-pipeline') ? data.kind : '';
  if(kind==='pipeline-settings'){
    const r=await importSettingsData(data);
    if(r==='ok'||r==='ok-noenvs'){ closeIoClipImport(); ioTipShow(r==='ok-noenvs'?'✓ 设置已从剪贴板导入并保存（节点环境仅 admin 可配置，未导入）':'✓ 设置已从剪贴板导入并保存'); return 'ok'; }
    if(r==='invalid'){ ioClipTipShow('✗ 不是「导出设置」生成的有效内容', true); return 'invalid'; }
    return 'cancel';
  }
  if(kind==='pipeline-pipelines'){
    const r=await importPipelinesData(data);
    if(r==='ok'){ closeIoClipImport(); ioTipShow('✓ 已从剪贴板导入 '+pipelines.length+' 条流水线'); return 'ok'; }
    if(r==='invalid'){ ioClipTipShow('✗ 不是「导出流水线」生成的有效内容', true); return 'invalid'; }
    return 'cancel';
  }
  ioClipTipShow('✗ 不是本页「导出设置 / 导出流水线」生成的内容', true);
  return 'invalid';
}
/* ---------- 服务端备份（导入导出文件存于 dsh 服务器 storages/pipeline-exports/） ----------
   导出到服务端与浏览器本地下载共用同一份 payload（buildSettingsExport / buildPipelinesExport），经
   /api/worktable/pipeline/io/save 落盘；「从服务端导入…」列出服务端备份，读取后按 kind 自动识别
   设置 / 流水线，复用与文件导入完全相同的校验、确认与恢复逻辑（importSettingsData / importPipelinesData）。 */
function ioSrvTipShow(msg, bad){ const t=$('ioSrvTip'); if(!t) return; t.style.color=bad?'var(--log-err)':'var(--log-ok)'; t.textContent=msg; }
/* 文件名规整：缺省补 .json；与服务端 pipelineIoName 同一套白名单（禁路径分隔符 / .. / 前导点，≤120 字），无效返回 null */
function ioSrvNormalizeName(name){
  let n=String(name==null?'':name).trim();
  if(!n) return null;
  if(!/\.json$/i.test(n)) n+='.json';
  if(n.length>120 || n.indexOf('..')>=0 || n.indexOf('/')>=0 || n.indexOf('\\')>=0 || n.charAt(0)==='.') return null;
  return n;
}
async function ioSrvPost(path, body){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error((d && d.error)||('HTTP '+r.status));
  return d;
}
function exportSettingsToServer(){
  const input=prompt('导出到 dsh 服务器的文件名（保存在 storages/pipeline-exports/ 下；文件含密码与令牌明文）：','pipeline-settings-'+ioTimestamp()+'.json');
  if(input===null || input===undefined) return;
  const name=ioSrvNormalizeName(input);
  if(!name){ ioTipShow('✗ 文件名无效：需 120 字以内、不含路径分隔符', true); return; }
  ioSrvPost('/api/worktable/pipeline/io/save',{name:name,payload:buildSettingsExport()})
    .then(d=>ioTipShow('✓ 已导出到服务端：'+d.name))
    .catch(e=>ioTipShow('✗ 导出到服务端失败：'+e.message, true));
}
function exportPipelinesToServer(){
  const input=prompt('导出到 dsh 服务器的文件名（保存在 storages/pipeline-exports/ 下）：','pipeline-pipelines-'+ioTimestamp()+'.json');
  if(input===null || input===undefined) return;
  const name=ioSrvNormalizeName(input);
  if(!name){ ioTipShow('✗ 文件名无效：需 120 字以内、不含路径分隔符', true); return; }
  ioSrvPost('/api/worktable/pipeline/io/save',{name:name,payload:buildPipelinesExport()})
    .then(d=>ioTipShow('✓ 已导出 '+pipelines.length+' 条流水线到服务端：'+d.name))
    .catch(e=>ioTipShow('✗ 导出到服务端失败：'+e.message, true));
}
/* 从服务端导入：读取备份内容，按 kind 自动分流到设置 / 流水线导入；kind 不符或形状非法给 ✗ 提示 */
async function importFromServer(name){
  try{
    const d=await ioSrvPost('/api/worktable/pipeline/io/load',{name:name});
    const data=d && d.data;
    const kind=(data && data.app==='worktable-pipeline') ? data.kind : '';
    if(kind==='pipeline-settings'){
      const r=await importSettingsData(data);
      if(r==='ok') ioSrvTipShow('✓ 已从服务端导入设置：'+name);
      else if(r==='ok-noenvs') ioSrvTipShow('✓ 已从服务端导入设置：'+name+'（节点环境仅 admin 可配置，未导入）');
      else if(r==='invalid') ioSrvTipShow('✗ 不是「导出设置」生成的有效文件', true);
    }else if(kind==='pipeline-pipelines'){
      const r=await importPipelinesData(data);
      if(r==='ok') ioSrvTipShow('✓ 已从服务端导入 '+pipelines.length+' 条流水线：'+name);
      else if(r==='invalid') ioSrvTipShow('✗ 不是「导出流水线」生成的有效文件', true);
    }else{
      ioSrvTipShow('✗ 不是本页「导出设置 / 导出流水线」生成的备份文件', true);
    }
  }catch(e){ ioSrvTipShow('✗ 从服务端导入失败：'+e.message, true); }
}
function ioSrvFmtMeta(f){
  const p=n=>String(n).padStart(2,'0');
  const t=f && f.mtime ? new Date(f.mtime) : null;
  const ts=t?(''+t.getFullYear()+p(t.getMonth()+1)+p(t.getDate())+' '+p(t.getHours())+':'+p(t.getMinutes())):'';
  const sz=(f && f.size>=1048576)?(f.size/1048576).toFixed(1)+'M':(f && f.size>=1024?Math.round(f.size/1024)+'K':(f && f.size||0)+'B');
  return (ts?ts+' · ':'')+sz;
}
function renderIoSrvList(d){
  const box=$('ioSrvList'); if(!box) return;
  box.innerHTML='';
  if($('ioSrvDir')) $('ioSrvDir').textContent=(d && d.dir)||'';
  const files=(d && Array.isArray(d.files)) ? d.files : [];
  if(!files.length){
    const empty=document.createElement('div');
    empty.className='dshell-muted'; empty.style.padding='8px 6px';
    empty.textContent='（服务端还没有备份文件）';
    box.appendChild(empty); return;
  }
  files.forEach(function(f){
    const row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;gap:8px;padding:4px 6px;border-top:1px solid var(--dsw-alias-border-l2);';
    const nm=document.createElement('span');
    nm.style.cssText='flex:1;word-break:break-all;font-family:monospace;font-size:12px;';
    nm.textContent=f.name; nm.title=f.name;
    const meta=document.createElement('span');
    meta.className='dshell-muted'; meta.style.cssText='font-size:11px;white-space:nowrap;';
    meta.textContent=ioSrvFmtMeta(f);
    const btn=document.createElement('button');
    btn.type='button'; btn.className='dshell-btn dshell-btnGhost mini'; btn.textContent='⤒ 导入';
    btn.title='按文件内容自动识别设置 / 流水线并导入';
    btn.addEventListener('click',function(){ importFromServer(f.name); });
    row.appendChild(nm); row.appendChild(meta); row.appendChild(btn);
    box.appendChild(row);
  });
}
function refreshIoSrvList(){
  const box=$('ioSrvList');
  if(box) box.innerHTML='<div class="dshell-muted" style="padding:8px 6px;">加载中…</div>';
  fetch('/api/worktable/pipeline/io/list')
    .then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(renderIoSrvList)
    .catch(e=>{ if(box) box.innerHTML=''; ioSrvTipShow('✗ 读取服务端备份列表失败：'+(e && e.message || e), true); });
}
function toggleIoSrvPanel(show){
  const p=$('ioSrvPanel'); if(!p) return;
  p.style.display=show?'block':'none';
  if(show){ ioSrvTipShow(''); refreshIoSrvList(); }
}
/* 运行设置（分支 / 部署策略）为运行行临时配置，只存浏览器 localStorage、不上送服务端（不影响他人）；
   刷新后从 localStorage 回填。change 即时存，pagehide 兜底（分支面板点选为程序化赋值、不触发 change，靠 pagehide 持久化）。
   执行人不参与持久化——它只读、固定取当前登录用户（见下方 fillExecutorFromAuth）。 */
function saveRunSelLS(){ try{ localStorage.setItem('pip-branch',$('branchName').value); localStorage.setItem('pip-strategy',$('deployStrategyName').value); localStorage.setItem('pip-weightsPath',$('weightsPath').value); }catch(e){} }   /* 运行行临时配置仅本地，不上送服务端 */
