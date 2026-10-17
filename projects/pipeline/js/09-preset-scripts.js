/* ===== 09-preset-scripts.js · 环境清理 / 环境检查 / Profiling / 自定义预设任务 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 4000–4453）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */

/* ---------- 环境清理脚本（在「设置」页配置；勾选主控「预设任务」中的「环境清理」后按编排位置执行） ---------- */
/* 预设任务多选（系统预设：环境清理/环境检查/Profiling + 自定义预设）：按钮文案跟随勾选，与「环境」多选同一交互 */
function renderPresetMultiBtn(){
  const b=$('presetMultiBtn'); if(!b) return;
  /* 勾选名列表经 presetOrderAll/presetOn/presetDefOf 生成（含自定义预设）；沙盒单独抽取本函数（无这几个函数）时退回系统三项直读 */
  const on=(typeof presetOrderAll==='function' && typeof presetOn==='function' && typeof presetDefOf==='function')
    ? presetOrderAll().filter(presetOn).map(k=>presetDefOf(k).name)
    : [['cleanupEnv','环境清理'],['checkEnv','环境检查'],['profilingEnv','Profiling']].filter(x=>{ const el=$(x[0]); return !!(el && el.checked); }).map(x=>x[1]);
  b.textContent=on.length?on.join('、'):'（不执行）';
  b.title=b.textContent;   // 限宽省略时悬浮可见完整列表
}
function saveCleanup(){
  try{
    localStorage.setItem('pip-cleanupScript', JSON.stringify(cleanupScript));
    localStorage.setItem('pip-cleanupEnabled', $('cleanupEnv').checked?'1':'');
  }catch(e){}
  const sc=$('schedCleanupEnv'); if(sc) sc.checked=$('cleanupEnv').checked;   // 定时页「清理环境」与主控同一开关，保持双向同步
  renderPresetMultiBtn();
  persistState();
  if(!viewActive() && !replayRec){ _detailKey=''; renderFlow(); renderDetail(); }
}
function renderCleanupParams(){
  const box=$('cleanupParams'); if(!box) return; box.innerHTML='';
  if(!cleanupScript || !Array.isArray(cleanupScript.params) || !cleanupScript.params.length) return;
  cleanupScript.params.forEach(p=>{
    /* 识别到的默认值以可编辑文本填入框中（未改动时弱化色显示，仅为展示：不写进 values、不随执行下发，
       留空语义=自动注入的同名变量/脚本自身 :- 默认兜底，dyn 表达式未改动时同样不下发——注入后 shell 不会二次展开）；
       在框中修改后作为显式值下发（优先级最高，与 renderStageParams 同一规则，见 execScript）；清空或改回与默认一致=恢复留空语义 */
    const hasV=!!(cleanupScript.values && cleanupScript.values[p.key]!==undefined);
    const v=hasV?cleanupScript.values[p.key]:(p.def||'');
    const lab=document.createElement('label'); lab.className='dshell-muted';
    lab.style.cssText='display:flex;align-items:center;gap:4px;font-size:11px;';
    lab.innerHTML=esc(p.label)+(p.required?'<span style="color:var(--st-err)" title="必填">*</span>':'')
      +' <input class="dshell-input" data-cpkey="'+esc(p.key)+'" value="'+esc(v)+'" placeholder="'+esc(p.def||'')+'" title="识别默认值已填入框中、可直接修改：修改后作为显式值下发（优先级最高）；清空或改回与默认一致=自动注入的同名变量兜底，未注入则由脚本自身 :- 默认值兜底" style="width:150px;font-size:11px;'+(p.required&&!String(v).trim()?'border-color:var(--st-err);':'')+'" />';
    const inp=lab.querySelector('input');
    if(!hasV && p.def) inp.style.color='var(--dsw-alias-label-tertiary)';   // 未改动的默认值弱化显示（主题变量适配浅色/深色）
    inp.addEventListener('input',()=>{ inp.style.color=''; });
    inp.addEventListener('change',()=>{ cleanupScript.values=cleanupScript.values||{}; if(!inp.value||inp.value===p.def) delete cleanupScript.values[p.key]; else cleanupScript.values[p.key]=inp.value; renderCleanupParams(); saveCleanup(); });
    box.appendChild(lab);
  });
}
async function setCleanupScript(name){
  const sc=scriptByName(name);
  if(!name || !sc){ cleanupScript=null; renderCleanupParams(); saveCleanup(); return; }
  const keep=(cleanupScript && cleanupScript.name===sc.name)?cleanupScript:null;
  cleanupScript={name:sc.name, path:sc.path, params:(keep?keep.params:[]), values:(keep?keep.values:{})};
  await detectCleanupParams();
  saveCleanup();
}
async function detectCleanupParams(){
  if(!cleanupScript || !cleanupScript.path){ renderCleanupParams(); return; }
  try{
    const src=await readScriptSrc(cleanupScript.path);
    const det=detectParams(src);
    const oldParams=cleanupScript.params||[]; const oldVals=cleanupScript.values||{};
    cleanupScript.params=det; cleanupScript.values=cleanupScript.values||{};
    det.forEach(p=>{
      const oldP=oldParams.find(o=>o.key===p.key);
      const oldV=oldVals[p.key];
      // 仅保留用户真实改动：旧值等于旧默认（旧版识别器预填产物）则丢弃，回到「留空=注入值/脚本默认兜底」语义
      if(oldV!==undefined && oldP && String(oldV)!==String(oldP.def||'')) cleanupScript.values[p.key]=oldV;
    });
  }catch(e){ cleanupScript.params=[]; }
  renderCleanupParams();
}
/* ---------- 环境检查脚本（在「设置」页配置；勾选主控「预设任务」中的「环境检查」后按编排位置执行，不通过则阻断后续阶段） ---------- */
function saveCheck(){
  try{
    localStorage.setItem('pip-checkScript', JSON.stringify(checkScript));
    localStorage.setItem('pip-checkEnabled', $('checkEnv').checked?'1':'');
  }catch(e){}
  renderPresetMultiBtn();
  persistState();
  if(!viewActive() && !replayRec){ _detailKey=''; renderFlow(); renderDetail(); }
}
function renderCheckParams(){
  const box=$('checkParams'); if(!box) return; box.innerHTML='';
  if(!checkScript || !Array.isArray(checkScript.params) || !checkScript.params.length) return;
  checkScript.params.forEach(p=>{
    const hasV=!!(checkScript.values && checkScript.values[p.key]!==undefined);
    const v=hasV?checkScript.values[p.key]:(p.def||'');
    const lab=document.createElement('label'); lab.className='dshell-muted';
    lab.style.cssText='display:flex;align-items:center;gap:4px;font-size:11px;';
    lab.innerHTML=esc(p.label)+(p.required?'<span style="color:var(--st-err)" title="必填">*</span>':'')
      +' <input class="dshell-input" data-cpkey="'+esc(p.key)+'" value="'+esc(v)+'" placeholder="'+esc(p.def||'')+'" title="识别默认值已填入框中、可直接修改：修改后作为显式值下发（优先级最高）；清空或改回与默认一致=自动注入的同名变量兜底，未注入则由脚本自身 :- 默认值兜底" style="width:150px;font-size:11px;'+(p.required&&!String(v).trim()?'border-color:var(--st-err);':'')+'" />';
    const inp=lab.querySelector('input');
    if(!hasV && p.def) inp.style.color='var(--dsw-alias-label-tertiary)';   // 未改动的默认值弱化显示（主题变量适配浅色/深色）
    inp.addEventListener('input',()=>{ inp.style.color=''; });
    inp.addEventListener('change',()=>{ checkScript.values=checkScript.values||{}; if(!inp.value||inp.value===p.def) delete checkScript.values[p.key]; else checkScript.values[p.key]=inp.value; renderCheckParams(); saveCheck(); });
    box.appendChild(lab);
  });
}
async function setCheckScript(name){
  const sc=scriptByName(name);
  if(!name || !sc){ checkScript=null; renderCheckParams(); saveCheck(); return; }
  const keep=(checkScript && checkScript.name===sc.name)?checkScript:null;
  checkScript={name:sc.name, path:sc.path, params:(keep?keep.params:[]), values:(keep?keep.values:{})};
  await detectCheckParams();
  saveCheck();
}
async function detectCheckParams(){
  if(!checkScript || !checkScript.path){ renderCheckParams(); return; }
  try{
    const src=await readScriptSrc(checkScript.path);
    const det=detectParams(src);
    const oldParams=checkScript.params||[]; const oldVals=checkScript.values||{};
    checkScript.params=det; checkScript.values=checkScript.values||{};
    det.forEach(p=>{
      const oldP=oldParams.find(o=>o.key===p.key);
      const oldV=oldVals[p.key];
      // 仅保留用户真实改动：旧值等于旧默认（旧版识别器预填产物）则丢弃，回到「留空=注入值/脚本默认兜底」语义
      if(oldV!==undefined && oldP && String(oldV)!==String(oldP.def||'')) checkScript.values[p.key]=oldV;
    });
  }catch(e){ checkScript.params=[]; }
  renderCheckParams();
}
/* ---------- Profiling 脚本（在「设置」页配置；勾选主控「预设任务」中的「Profiling」后按编排位置执行，默认在流水线的最后，失败不阻断） ---------- */
function saveProfiling(){
  try{
    localStorage.setItem('pip-profilingScript', JSON.stringify(profilingScript));
    localStorage.setItem('pip-profilingEnabled', $('profilingEnv').checked?'1':'');
  }catch(e){}
  renderPresetMultiBtn();
  persistState();
  if(!viewActive() && !replayRec){ _detailKey=''; renderFlow(); renderDetail(); }
}
function renderProfilingParams(){
  const box=$('profilingParams'); if(!box) return; box.innerHTML='';
  if(!profilingScript || !Array.isArray(profilingScript.params) || !profilingScript.params.length) return;
  profilingScript.params.forEach(p=>{
    const hasV=!!(profilingScript.values && profilingScript.values[p.key]!==undefined);
    const v=hasV?profilingScript.values[p.key]:(p.def||'');
    const lab=document.createElement('label'); lab.className='dshell-muted';
    lab.style.cssText='display:flex;align-items:center;gap:4px;font-size:11px;';
    lab.innerHTML=esc(p.label)+(p.required?'<span style="color:var(--st-err)" title="必填">*</span>':'')
      +' <input class="dshell-input" data-cpkey="'+esc(p.key)+'" value="'+esc(v)+'" placeholder="'+esc(p.def||'')+'" title="识别默认值已填入框中、可直接修改：修改后作为显式值下发（优先级最高）；清空或改回与默认一致=自动注入的同名变量兜底，未注入则由脚本自身 :- 默认值兜底" style="width:150px;font-size:11px;'+(p.required&&!String(v).trim()?'border-color:var(--st-err);':'')+'" />';
    const inp=lab.querySelector('input');
    if(!hasV && p.def) inp.style.color='var(--dsw-alias-label-tertiary)';   // 未改动的默认值弱化显示（主题变量适配浅色/深色）
    inp.addEventListener('input',()=>{ inp.style.color=''; });
    inp.addEventListener('change',()=>{ profilingScript.values=profilingScript.values||{}; if(!inp.value||inp.value===p.def) delete profilingScript.values[p.key]; else profilingScript.values[p.key]=inp.value; renderProfilingParams(); saveProfiling(); });
    box.appendChild(lab);
  });
}
async function setProfilingScript(name){
  const sc=scriptByName(name);
  if(!name || !sc){ profilingScript=null; renderProfilingParams(); saveProfiling(); return; }
  const keep=(profilingScript && profilingScript.name===sc.name)?profilingScript:null;
  profilingScript={name:sc.name, path:sc.path, params:(keep?keep.params:[]), values:(keep?keep.values:{})};
  await detectProfilingParams();
  saveProfiling();
}
async function detectProfilingParams(){
  if(!profilingScript || !profilingScript.path){ renderProfilingParams(); return; }
  try{
    const src=await readScriptSrc(profilingScript.path);
    const det=detectParams(src);
    const oldParams=profilingScript.params||[]; const oldVals=profilingScript.values||{};
    profilingScript.params=det; profilingScript.values=profilingScript.values||{};
    det.forEach(p=>{
      const oldP=oldParams.find(o=>o.key===p.key);
      const oldV=oldVals[p.key];
      // 仅保留用户真实改动：旧值等于旧默认（旧版识别器预填产物）则丢弃，回到「留空=注入值/脚本默认兜底」语义
      if(oldV!==undefined && oldP && String(oldV)!==String(oldP.def||'')) profilingScript.values[p.key]=oldV;
    });
  }catch(e){ profilingScript.params=[]; }
  renderProfilingParams();
}
/* ---------- 自定义预设任务：状态管理与参数表单（与 cleanup 的 saveCleanup/renderCleanupParams/setCleanupScript/detectCleanupParams 同构） ---------- */
/* 统一落口：customPresets 任何变更都经这里——localStorage + 名称表重建 + 主控面板/按钮 + 设置页专区 + persistState +
   空闲态重渲染（同 saveCleanup；服务端 config 同步由 persistState → collectConfig 的 customPresets 字段携带） */
function saveCustomPresets(){
  try{ localStorage.setItem('pip-customPresets', JSON.stringify(customPresets)); }catch(e){}
  rebuildPresetNameMap();
  renderPresetMultiPanel();
  renderPresetMultiBtn();
  renderCustomPresetZone();
  persistState();
  if(!viewActive() && !replayRec){ _detailKey=''; renderFlow(); renderDetail(); }
}
/* 主控「预设任务」面板的自定义勾选项（系统三项为静态 HTML 不动）：checkbox 与设置页「默认勾选」同一状态（cp.enabled） */
function renderPresetMultiPanel(){
  const box=$('presetCustomList'); if(!box) return; box.innerHTML='';
  customPresets.forEach(cp=>{
    const lab=document.createElement('label'); lab.className='dshell-muted';
    lab.style.cssText='display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;border-radius:6px;';
    if(cp.block) lab.title='不通过（脚本非零退出）则阻断后续阶段';
    lab.innerHTML='<input type="checkbox" id="presetCustom_'+esc(cp.key)+'" '+(cp.enabled?'checked':'')+'/> '+esc(cp.name);
    const inp=lab.querySelector('input');
    inp.addEventListener('change',()=>{ cp.enabled=!!inp.checked; saveCustomPresets(); });
    box.appendChild(lab);
  });
}
/* 添加自定义预设任务：名称非空且不与系统预设/其他自定义预设同名；key 取 'c'+时间戳36进制保证唯一 */
function addCustomPreset(){
  const inp=$('customPresetName'); if(!inp) return;
  const name=(inp.value||'').trim();
  if(!name){ alert('请填写新预设任务名称'); return; }
  if(PRESET_BY_NAME[name]){ alert('预设任务名称「'+name+'」与'+(PRESET_DEF[PRESET_BY_NAME[name]]?'系统预设任务':'自定义预设任务')+'同名，请修改'); return; }
  customPresets.push({key:'c'+Date.now().toString(36), name:name, script:null, block:false, pos:'first', enabled:false});
  inp.value='';
  saveCustomPresets();
}
/* 设置页「预设任务设置」专区列表：每项两行——第一行名称/脚本/识别参数/失败阻断/默认位置/默认勾选/删除，第二行参数容器 */
function renderCustomPresetZone(){
  const box=$('customPresetList'); if(!box) return; box.innerHTML='';
  customPresets.forEach(cp=>{
    const item=document.createElement('div');
    item.style.cssText='border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 9px;display:flex;flex-direction:column;gap:7px;';
    item.innerHTML='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'
      +'<input class="dshell-input" data-cpname value="'+esc(cp.name)+'" placeholder="预设任务名称" title="预设任务名称（主控「预设任务」面板与流水线编辑器中显示；不可与系统预设/其他自定义预设同名）" style="width:150px;" />'
      +'<span class="dshell-muted" style="font-size:11px;">脚本</span>'
      +'<input class="dshell-input" data-cpscript list="scriptsList" placeholder="选择脚本（可搜索，留空=不执行）" value="'+esc(cp.script?cp.script.name:'')+'" style="width:216px;" />'
      +'<button class="dshell-btn dshell-btnGhost mini" type="button" data-cpdetect>识别参数</button>'
      +'<label class="dshell-muted" style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer;" title="不通过（脚本非零退出）则阻断后续阶段"><input type="checkbox" data-cpblock '+(cp.block?'checked':'')+'/> 失败阻断</label>'
      +'<label class="dshell-muted" style="display:flex;align-items:center;gap:3px;font-size:11px;" title="未在流水线中编排过位置时的默认插入位置"><select class="dshell-input" data-cppos>'
      +'<option value="first"'+(cp.pos!=='last'?' selected':'')+'>最前（环境检查之后）</option>'
      +'<option value="last"'+(cp.pos==='last'?' selected':'')+'>最后（Profiling 之前）</option>'
      +'</select> 默认位置</label>'
      +'<label class="dshell-muted" style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer;" title="与主控「预设任务」面板中的勾选同一状态"><input type="checkbox" data-cpenabled '+(cp.enabled?'checked':'')+'/> 默认勾选</label>'
      +'<span style="flex:1"></span>'
      +'<button class="dshell-btn dshell-btnDanger mini" type="button" data-cpdel>删除</button>'
      +'</div>'
      +'<div id="customPresetParams_'+esc(cp.key)+'" style="display:flex; gap:10px; flex-wrap:wrap;"></div>';
    box.appendChild(item);
    const nameInp=item.querySelector('[data-cpname]');
    nameInp.addEventListener('change',()=>{   // 重命名：非空、不与系统预设名及其他自定义名重复；违反则回退输入框值
      const name=(nameInp.value||'').trim();
      if(!name){ alert('预设任务名称不能为空'); nameInp.value=cp.name; return; }
      if(PRESET_BY_NAME[name] && PRESET_BY_NAME[name]!==cp.key){ alert('预设任务名称「'+name+'」与'+(PRESET_DEF[PRESET_BY_NAME[name]]?'系统预设任务':'自定义预设任务')+'同名，请修改'); nameInp.value=cp.name; return; }
      if(name!==cp.name){ cp.name=name; saveCustomPresets(); } else nameInp.value=cp.name;
    });
    const scriptInp=item.querySelector('[data-cpscript]');
    scriptInp.addEventListener('change',()=>{ setCustomPresetScript(cp.key, scriptInp.value.trim()); });
    item.querySelector('[data-cpdetect]').addEventListener('click',()=>{ detectCustomPresetParams(cp.key).then(saveCustomPresets); });
    const blockInp=item.querySelector('[data-cpblock]');
    blockInp.addEventListener('change',()=>{ cp.block=!!blockInp.checked; saveCustomPresets(); });
    const posSel=item.querySelector('[data-cppos]');
    posSel.addEventListener('change',()=>{ cp.pos=(posSel.value==='last'?'last':'first'); saveCustomPresets(); });
    const enabledInp=item.querySelector('[data-cpenabled]');
    enabledInp.addEventListener('change',()=>{ cp.enabled=!!enabledInp.checked; saveCustomPresets(); });
    item.querySelector('[data-cpdel]').addEventListener('click',()=>{
      if(!confirm('删除自定义预设任务「'+cp.name+'」？流水线编排中它的标记行将一并失效。')) return;
      const idx=customPresets.findIndex(c=>c.key===cp.key); if(idx>=0) customPresets.splice(idx,1);
      saveCustomPresets();
    });
    renderCustomPresetParams(cp.key);
  });
}
/* 参数表单：识别默认值仅展示、显式值才下发（与 renderCleanupParams 同一规则） */
function renderCustomPresetParams(key){
  const box=$('customPresetParams_'+key); if(!box) return; box.innerHTML='';
  const cp=customPresets.find(c=>c.key===key);
  if(!cp || !cp.script || !Array.isArray(cp.script.params) || !cp.script.params.length) return;
  cp.script.params.forEach(p=>{
    const hasV=!!(cp.script.values && cp.script.values[p.key]!==undefined);
    const v=hasV?cp.script.values[p.key]:(p.def||'');
    const lab=document.createElement('label'); lab.className='dshell-muted';
    lab.style.cssText='display:flex;align-items:center;gap:4px;font-size:11px;';
    lab.innerHTML=esc(p.label)+(p.required?'<span style="color:var(--st-err)" title="必填">*</span>':'')
      +' <input class="dshell-input" data-cpkey="'+esc(p.key)+'" value="'+esc(v)+'" placeholder="'+esc(p.def||'')+'" title="识别默认值已填入框中、可直接修改：修改后作为显式值下发（优先级最高）；清空或改回与默认一致=自动注入的同名变量兜底，未注入则由脚本自身 :- 默认值兜底" style="width:150px;font-size:11px;'+(p.required&&!String(v).trim()?'border-color:var(--st-err);':'')+'" />';
    const inp=lab.querySelector('input');
    if(!hasV && p.def) inp.style.color='var(--dsw-alias-label-tertiary)';   // 未改动的默认值弱化显示（主题变量适配浅色/深色）
    inp.addEventListener('input',()=>{ inp.style.color=''; });
    inp.addEventListener('change',()=>{ cp.script.values=cp.script.values||{}; if(!inp.value||inp.value===p.def) delete cp.script.values[p.key]; else cp.script.values[p.key]=inp.value; renderCustomPresetParams(key); saveCustomPresets(); });
    box.appendChild(lab);
  });
}
async function setCustomPresetScript(key, name){
  const cp=customPresets.find(c=>c.key===key); if(!cp) return;
  const sc=scriptByName(name);
  if(!name || !sc){ cp.script=null; renderCustomPresetParams(key); saveCustomPresets(); return; }
  const keep=(cp.script && cp.script.name===sc.name)?cp.script:null;
  cp.script={name:sc.name, path:sc.path, params:(keep?keep.params:[]), values:(keep?keep.values:{})};
  await detectCustomPresetParams(key);
  saveCustomPresets();
}
async function detectCustomPresetParams(key){
  const cp=customPresets.find(c=>c.key===key); if(!cp) return;
  if(!cp.script || !cp.script.path){ renderCustomPresetParams(key); return; }
  try{
    const src=await readScriptSrc(cp.script.path);
    const det=detectParams(src);
    const oldParams=cp.script.params||[]; const oldVals=cp.script.values||{};
    cp.script.params=det; cp.script.values=cp.script.values||{};
    det.forEach(p=>{
      const oldP=oldParams.find(o=>o.key===p.key);
      const oldV=oldVals[p.key];
      // 仅保留用户真实改动：旧值等于旧默认（旧版识别器预填产物）则丢弃，回到「留空=注入值/脚本默认兜底」语义
      if(oldV!==undefined && oldP && String(oldV)!==String(oldP.def||'')) cp.script.values[p.key]=oldV;
    });
  }catch(e){ cp.script.params=[]; }
  renderCustomPresetParams(key);
}
async function loadScripts(){
  try{
    const r=await fetch('/api/worktable/fs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:scriptsDir})});
    const j=await r.json();
    const ents=(j.entries||[]).filter(e=>!e.isDir && /\.(sh|py)$/i.test(e.name));   // .sh + .py（README 等文档不进脚本列表）
    availableScripts=ents.map(e=>({name:e.name, path:e.path, lang:/\.py$/i.test(e.name)?'py':'sh'}));
  }catch(e){ availableScripts=[]; }
  rebindBuiltinScriptPaths();
  fillScriptsDatalist();
}
function fillScriptsDatalist(){
  const dl=$('scriptsList'); if(!dl) return; dl.innerHTML='';
  availableScripts.forEach(s=>{ const o=document.createElement('option'); o.value=s.name; dl.appendChild(o); });
}
function scriptByName(name){ return availableScripts.find(s=>s.name===name)||null; }
/* 内置流水线的脚本绑定按名落种子（path 留空），scripts 目录列表就绪后按名回填真实路径：
   种子随代码分发、不知安装后的 scripts 绝对路径；服务端存储版内置（admin 保存过）同样按名
   对齐当前 scriptsDir（脚本目录迁移后旧绝对路径自动修复）。仅处理内置流水线（自定义流水线
   的缺脚本路径由编辑器告警负责）；scripts 目录暂无该脚本时保持原 path（编辑器照常告警）。 */
function rebindBuiltinScriptPaths(){
  if(typeof pipelines==='undefined'||!Array.isArray(pipelines)) return;
  BUILTIN_PIPELINE_DEFS.forEach(def=>{
    const pl=pipelines.find(p=>p && p.builtIn && p.id===def.id);
    if(!pl || !Array.isArray(pl.stages)) return;
    pl.stages.forEach(s=>{
      if(!s || !s.script || !s.script.name) return;
      const sc=scriptByName(s.script.name);
      if(sc && s.script.path!==sc.path){ s.script.path=sc.path; if(!s.script.lang) s.script.lang=sc.lang; }
    });
  });
}
function fillJenkinsJobsDatalist(){
  const dl=$('jenkinsJobsList'); if(!dl) return; dl.innerHTML='';
  availableJenkinsJobs.forEach(j=>{ const o=document.createElement('option'); o.value=j.name; dl.appendChild(o); });
}
function jkJobByName(name){ return availableJenkinsJobs.find(j=>j.name===name)||null; }
async function readScriptSrc(path){
  const r=await fetch('/api/worktable/file?path='+encodeURIComponent(path));
  return r.text();
}
/* 从脚本源码识别参数：位置参数 $1..$N/${N:-def} + 环境变量 ${VAR:-def}/${VAR}/$VAR */
/* 统一扫描 $ 引用：${...} 的默认值按花括号配平截取，${A:-${B}/x} 嵌套不截断；
   默认值内部的 $ 引用递归扫描（${A:-$B} 里的 B 同样是可配置项），覆盖面与旧的逐字正则一致。
   返回 [{key, isPos, op, def}]，op 为 '' | ':-' | ':?' */
function scanShellRefs(src){
  const refs=[]; let i=0; const n=src.length;
  while(i<n){
    if(src[i]!=='$'){ i++; continue; }
    let j=i+1; let braced=false;
    if(src[j]==='{'){ braced=true; j++; }
    const m=/^([A-Za-z_][A-Za-z0-9_]*|\d+)/.exec(src.slice(j));
    if(!m){ i++; continue; }
    const key=m[1]; j+=key.length;
    let op=''; let def='';
    if(braced){
      if(src[j]===':'&&(src[j+1]==='-'||src[j+1]==='?')){
        op=':'+src[j+1];
        let depth=1; let k=j+2;
        while(k<n && depth>0){ const ch=src[k]; if(ch==='{')depth++; else if(ch==='}')depth--; k++; }
        def=src.slice(j+2, depth===0?k-1:n); j=k;
      } else if(src[j]==='}'){ j++; }
    }
    refs.push({key:key, isPos:/^\d+$/.test(key), op:op, def:def});
    if(def.indexOf('$')>=0) refs.push.apply(refs, scanShellRefs(def));
    i=j;
  }
  return refs;
}
/* 动态默认值：含 $引用/${}/$() 的 shell 表达式不做字面值预填/注入（注入后 shell 不会二次展开），
   页面留空、原表达式显示在 placeholder，运行时由脚本自身 :- 展开 */
function isDynDef(def){ return /\$(\(|\{?[A-Za-z_])/.test(def||''); }
/* 从注释提取语义化标签：# 位置参数 $1 = 模型架构名 / # 环境变量 XDS_URL = XDS 网关地址（支持一行多个 VAR = 说明） */
function parseCommentLabels(src){
  const posLabels={}, envLabels={};
  src.split('\n').forEach(line=>{
    const c=/^\s*#\s*(.*)$/.exec(line); if(!c) return;
    const t=c[1];
    /* 标签分隔符：= / ：/ 半角冒号后跟空白 / 两格以上对齐空格；避免把 docker pull $IMAGE:$TAG 这类文本里的冒号当分隔符 */
    let m=/位置参数\s*\$(\d+)(?:\s*[=：]|\s*:(?=\s)| {2,})\s*([^（(；;，,\n]+)/.exec(t) || /\$(\d+)(?:\s*[=：]|\s*:(?=\s)| {2,})\s*([^（(；;，,\n]+)/.exec(t);
    if(m && m[2]) posLabels[m[1]]=m[2].trim();
    const envRe=/([A-Z_][A-Z0-9_]*)(?:\s*[=：]|\s*:(?=\s)| {2,})\s*([^（(；;，,\n]+)/g;
    while((m=envRe.exec(t))){ if(m[2] && !envLabels[m[1]]) envLabels[m[1]]=m[2].trim(); }
  });
  return {posLabels, envLabels};
}
/* 扫描脚本内部赋值：VAR=... 且右侧不含自引用 ${VAR}/$VAR 的，视为内部变量（不是外部参数） */
function internalAssignedVars(src){
  const internal={};
  const re=/^\s*(?:declare\s+(?:-[a-zA-Z]+\s+)?|local\s+|export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/gm;
  let m;
  while((m=re.exec(src))){
    const v=m[1]; const rhs=m[2].trim().replace(/^["']|["']$/g,'');
    const selfRef=new RegExp('\\$\\{?'+v+'\\b');
    if(!selfRef.test(rhs)) internal[v]=true;
  }
  return internal;
}
/* Python 脚本参数识别：位置参数 sys.argv[N] + 环境变量 os.environ['KEY']/os.environ.get('KEY','默认')/os.getenv('KEY','默认')。
   os.environ['KEY']（下标访问、无默认）视为必填；getenv/get 带默认值视为可选。argparse --opt 不映射（与位置/环境参数模型不直接对应），如需可手动补。 */
function detectPythonParams(src){
  const pos={}; let m;
  const argvRe=/sys\.argv\[(\d+)\]/g;
  while((m=argvRe.exec(src))){ const n=parseInt(m[1],10); if(n>=1 && !(n in pos)) pos[n]={def:'',required:false}; }
  const maxPos=Object.keys(pos).length?Math.max.apply(null,Object.keys(pos).map(Number)):0;
  const posParams=[];
  for(let i=1;i<=maxPos;i++) posParams.push({kind:'pos',key:String(i),label:'参数 '+i,def:'',required:false});
  const envSeen={}; const envOrder=[];
  const envRe=/os\.environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"](?:\s*,\s*([^)]+))?\)|os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"](?:\s*,\s*([^)]+))?\)|os\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;
  while((m=envRe.exec(src))){
    const v=m[1]||m[3]||m[5]; if(!v) continue;
    const rawDef=m[2]||m[4]||'';
    const def=rawDef?String(rawDef).replace(/^["']|["']$/g,'').trim():'';
    const req=!rawDef && (m[5]!==undefined);   // 仅 os.environ['KEY']（下标访问、无默认）视为必填
    if(!(v in envSeen)){ envSeen[v]={def,required:req}; envOrder.push(v); }
    else { if(def && !envSeen[v].def) envSeen[v].def=def; if(req) envSeen[v].required=true; }
  }
  const envParams=envOrder.map(v=>({kind:'env',key:v,label:v,def:envSeen[v].def,required:!!envSeen[v].required}));
  return posParams.concat(envParams);
}
function detectParams(src, lang){
  if(lang==='py') return detectPythonParams(src);
  const noPositionalArgs=/^\s*#\s*pipeline:\s*no-positional-args\s*$/mi.test(src);
  const labels=parseCommentLabels(src);
  const internal=internalAssignedVars(src);
  const pos={}; const envSeen={}; const envOrder=[];
  const BUILT=/^(PATH|HOME|PWD|OLDPWD|USER|SHELL|LANG|TERM|RANDOM|LINENO|IFS|PPID|UID|EUID|BASH|BASH_VERSION|BASH_SOURCE|BASH_LINENO|FUNCNAME|PIPESTATUS|OSTYPE|HOSTNAME|HOSTTYPE|SHLVL|_|SECONDS|EPOCHREALTIME)$/;
  scanShellRefs(src).forEach(r=>{
    const req=(r.op===':?');
    /* 带 :-默认值 的参数记录 def 供参数框展示（未改动不预填、不随执行下发，见 renderStageParams/execScript）；
       含 $引用/$(命令) 的动态默认值（dyn）同样仅框内展示（见 isDynDef） */
    const def=(r.op===':-')?r.def.replace(/^["']|["']$/g,'').trim():'';
    const dyn=(r.op===':-')&&isDynDef(def);
    if(r.isPos){
      if(noPositionalArgs) return;
      const n=parseInt(r.key,10); if(n<1) return;
      if(!(n in pos)) pos[n]={def:def, required:req, dyn:dyn};
      else { if(def && !pos[n].def){ pos[n].def=def; pos[n].dyn=dyn; } if(req) pos[n].required=true; }
      return;
    }
    const v=r.key;
    /* 带 :-/:? 默认值声明（VAR="${VAR:-...}"）的变量是明确的外部参数声明，即使脚本内另有普通重赋值
       （如 if 分支里 VALUES_FILE="$DEPLOY_VALUES_FILE" 致 internalAssignedVars 误判为内部变量）也不过滤 */
    if(!/^[A-Z_][A-Z0-9_]*$/.test(v)||BUILT.test(v)||(internal[v]&&!r.op)) return;   // 环境参数沿用旧规则：仅全大写名
    if(!(v in envSeen)){ envSeen[v]={def:def, required:req, dyn:dyn}; envOrder.push(v); }
    else { if(def && !envSeen[v].def){ envSeen[v].def=def; envSeen[v].dyn=dyn; } if(req) envSeen[v].required=true; }
  });
  const maxPos=Object.keys(pos).length?Math.max.apply(null,Object.keys(pos).map(Number)):0;
  const posParams=[];
  for(let i=1;i<=maxPos;i++) posParams.push({kind:'pos', key:String(i), label:labels.posLabels[i]||('位置参数 '+i), def:(pos[i]&&pos[i].def)||'', required:!!(pos[i]&&pos[i].required), dyn:!!(pos[i]&&pos[i].dyn)});
  const envParams=envOrder.map(v=>({kind:'env', key:v, label:labels.envLabels[v]||v, def:envSeen[v].def, required:!!envSeen[v].required, dyn:!!envSeen[v].dyn}));
  return posParams.concat(envParams);
}
