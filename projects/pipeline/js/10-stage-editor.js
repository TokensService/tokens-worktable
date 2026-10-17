/* ===== 10-stage-editor.js · 结构化阶段编辑器、阶段动作行、阶段定时配置行 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 4454–4832）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* ---------- 结构化阶段编辑器（结构 + 脚本绑定一体，绑定跟随阶段） ---------- */
/* EvalTokens 阶段持久化字段：collectReport 缺省按 true 兼容旧流水线，使新增能力默认开启；
   values=编辑器内显式设置的任务输入参数覆盖值（随流水线持久化，运行时作为输入覆盖随 run 启动请求下发，见 runEvaltokensStep）；
   params（识别到的参数定义）不持久化，编辑器打开 / 点「识别参数」时重新识别（见 openPlForm/detectEvaltokStageParams）。 */
function evaltokensStageConfig(et){
  et=et||{};
  const values={}; if(et.values && typeof et.values==='object') Object.keys(et.values).forEach(k=>{ if(k) values[k]=String(et.values[k]); });
  return {taskId:et.taskId||'', taskName:et.taskName||'', outVars:et.outVars||'', collectReport:et.collectReport!==false, values:values};
}
/* 旧数据兼容：Jenkins 阶段先改为 URL 请求阶段、再统一改为 HTTP 阶段——kind:'jenkins'/'url' 归为 'http'，jenkins.job 迁入 url.url
   （「拉取参数」的 params/values 随之下线，参数改由 URL 的 {GIT_BRANCH} 等占位符传递，见 migrateStageUrl）；
   evaltokens 阶段持有 evaltokens{taskId,taskName,outVars,collectReport,values}；未带 kind 的阶段按 url/script/evaltokens 字段推断；补齐 script.lang */
function normalizeStageKind(s){
  if(!s) return s;
  if(s.kind==='jenkins'||s.kind==='url') s.kind='http';
  if(s.jenkins){ if(!s.url) s.url={url:s.jenkins.job||'', outVars:s.jenkins.outVars||''}; s.jenkins=null; }
  if(!s.kind){
    if(s.evaltokens && (s.evaltokens.taskId||s.evaltokens.taskName)) s.kind='evaltokens';
    else if(s.url && s.url.url) s.kind='http';
    else if(s.script && s.script.path) s.kind=(s.script.lang==='py'||/\.py$/i.test(s.script.name||''))?'python':'shell';
    else s.kind='simulate';
  }
  if(s.kind==='http'){ if(!s.url) s.url={url:'',outVars:''}; if(!s.script) s.script=null; if(!s.evaltokens) s.evaltokens=null; }
  else if(s.kind==='evaltokens'){ const ps=s.evaltokens&&s.evaltokens.params; s.evaltokens=evaltokensStageConfig(s.evaltokens); s.evaltokens.params=Array.isArray(ps)?ps:[]; if(!s.script) s.script=null; if(!s.url) s.url=null; }
  else { if(!s.url) s.url=null; if(!s.evaltokens) s.evaltokens=null; if(s.script){ s.script.lang=(s.script.lang==='py'||/\.py$/i.test(s.script.name||''))?'py':'sh'; } }
  /* 定时标记归一：sched 仅作「支持定时」标记（{}），周期跟随流水线定时计划；旧数据 true / {mode...} 一律归一为 {}，非法置空 */
  s.sched = s.sched ? {} : null;
  return s;
}
function scriptLangOf(sc){ return (sc && (sc.lang==='py'||/\.py$/i.test(sc.name||''))) ?'py':'sh'; }
function newStage(name){ return {id:'', name:name||'新阶段', dur:0, timeout:null, skip:false, parallel:false, sub:[], kind:'simulate', script:null, url:null, evaltokens:null, sched:{}}; } /* dur 默认 0=不设置耗时（本地模拟不等待，运行即结束）；阶段默认支持定时（跟随流水线定时计划），勾选「需本地运行」后 sched 置空 */
/* 存储/分享的 stages → 编辑器草稿 editStages：预设标记行原样带入，其余按类型归一（兼容旧 jenkins 字段）；
   evaltokens.params 不持久化（编辑器打开时自动重新识别），values（参数覆盖值）随定义带入。最后补齐预设标记行。 */
function editStagesFromStored(stages){
  return withPresetMarkers((stages||[]).map(s=> (s && s.preset) ? {id:s.id, name:s.name, preset:true, pkey:s.pkey}
    : normalizeStageKind({id:s.id, name:s.name, dur:s.dur, timeout:s.timeout||null, skip:!!(s.skip||s.gate), parallel:s.parallel===true, promCollect:!!s.promCollect, sched: s.sched?{}:null, sub:(s.sub||[]), kind:s.kind, script:s.script?{name:s.script.name,path:s.script.path,lang:s.script.lang,params:(s.script.params||[]),values:(s.script.values||{}),outVars:(s.script.outVars||'')}:null, url:s.url?{url:s.url.url,outVars:(s.url.outVars||'')}:null, evaltokens:s.evaltokens?Object.assign(evaltokensStageConfig(s.evaltokens),{params:[]}):null, jenkins:s.jenkins?{job:s.jenkins.job,outVars:(s.jenkins.outVars||'')}:null})));
}
function applyEditSel(){
  const wrap=$('plStageList'); if(!wrap||!wrap.children) return;
  for(let i=0;i<wrap.children.length;i+=1){
    const row=wrap.children[i]; const sel=!!(editStages[i] && editStages[i]===editSelStage);
    const on=!!(sel && !plFormReadOnly);   // 只读查看（内置流水线对非 admin 只读）保留选中高亮，但不出「+」插入按钮
    row.classList.toggle('plstage-sel', sel);
    const has=!!row.querySelector('.plstage-ins');
    if(on && !has){
      row.insertAdjacentHTML('beforeend','<button type="button" class="plstage-ins plstage-ins-top" data-act="insBefore" title="在其上方插入新阶段">+</button><button type="button" class="plstage-ins plstage-ins-bottom" data-act="insAfter" title="在其下方插入新阶段">+</button>');
    }else if(!on && has){
      row.querySelectorAll('.plstage-ins').forEach(b=>b.remove());
    }
  }
}
function selectEditStage(i){
  const s=(i>=0 && i<editStages.length) ? editStages[i] : null;
  if(editSelStage===s) return;
  editSelStage=s; applyEditSel();
}
/* 在 i 号任务卡上/下方插入新阶段：选中新卡，并走 editFocusIdx 通道聚焦滚动到可见 */
function insertEditStage(i, after){
  if(!editStages.length || !Number.isFinite(i) || i<0 || i>=editStages.length) return;
  const at=after?i+1:i;
  const ns=newStage();
  editStages.splice(at,0,ns);
  editSelStage=ns; editFocusIdx=at;
  renderStageEditor();
}
/* 编辑器统一重排入口：序号、上下移与拖拽都只修改 editStages 草稿，点「保存」后再持久化。 */
function moveEditStage(from,to){
  from=parseInt(from,10); to=parseInt(to,10);
  if(!editStages.length || !Number.isFinite(from) || from<0 || from>=editStages.length) return from;
  to=Math.max(0,Math.min(editStages.length-1,Number.isFinite(to)?to:from));
  if(to===from) return from;
  const moved=editStages.splice(from,1)[0]; editStages.splice(to,0,moved);
  return to;
}
/* 目标卡上半区=插到它前面，下半区=插到它后面；源卡移除会让后方插槽左移一位。 */
function stageDropTarget(from,over,after){
  let to=over+(after?1:0);
  if(from<to) to-=1;
  return Math.max(0,Math.min(editStages.length-1,to));
}
function clearStageDragMarks(){
  const wrap=$('plStageList'); if(!wrap||!wrap.children) return;
  for(let i=0;i<wrap.children.length;i+=1) wrap.children[i].classList.remove('plstage-dragging','plstage-drag-before','plstage-drag-after');
}
/* 整卡 draggable 会抢占卡内控件的手势：在 input/textarea/summary 等控件上按下拖动时浏览器发起整卡拖拽，
   输入框文字无法划选。mousedown 时按落点切换 draggable——落在交互控件上即临时关拖拽（走原生划选/控件交互），
   落在卡片空白处保持可拖；下次按下重新判定，无需恢复 */
function stageCardMouseDown(e){
  const t=e.target;
  e.currentTarget.draggable=!(t && t.closest && t.closest('input,textarea,select,button,a,label,summary,[contenteditable="true"]'));
}
function stageCardDragStart(e){
  const row=e.currentTarget; stageDragFrom=parseInt(row.dataset.idx,10);
  clearStageDragMarks(); row.classList.add('plstage-dragging');
  if(e.dataTransfer){ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',String(stageDragFrom)); }
}
function stageCardDragOver(e){
  if(stageDragFrom<0) return;
  e.preventDefault(); if(e.dataTransfer) e.dataTransfer.dropEffect='move';
  const row=e.currentTarget, over=parseInt(row.dataset.idx,10); clearStageDragMarks();
  const source=$('plStageList').children[stageDragFrom]; if(source) source.classList.add('plstage-dragging');
  if(over===stageDragFrom) return;
  const rect=row.getBoundingClientRect(), after=e.clientY>=rect.top+rect.height/2;
  row.classList.add(after?'plstage-drag-after':'plstage-drag-before');
}
function stageCardDrop(e){
  if(stageDragFrom<0) return;
  e.preventDefault();
  const from=stageDragFrom, row=e.currentTarget, over=parseInt(row.dataset.idx,10);
  const rect=row.getBoundingClientRect(), after=e.clientY>=rect.top+rect.height/2;
  const to=stageDropTarget(from,over,after); stageDragFrom=-1; clearStageDragMarks();
  if(to!==from){ editFocusIdx=moveEditStage(from,to); renderStageEditor(); schedulePlDraftSave(); }
}
function stageCardDragEnd(){ stageDragFrom=-1; clearStageDragMarks(); }
function renderStageEditor(){
  const wrap=$('plStageList'); if(!wrap) return; wrap.innerHTML='';
  editStages.forEach((s,i)=>{
    const row=document.createElement('div'); row.className='plstage'; row.dataset.idx=i;
    row.draggable=true;
    row.addEventListener('mousedown',stageCardMouseDown);
    row.addEventListener('dragstart',stageCardDragStart);
    row.addEventListener('dragover',stageCardDragOver);
    row.addEventListener('drop',stageCardDrop);
    row.addEventListener('dragend',stageCardDragEnd);
    /* 高亮只有 plstage-sel 一个通道（applyEditSel 按 editSelStage 原地切换），不再随 editFocusIdx 内联
       accent 边框/阴影——内联样式随 DOM 留存到下次整表重渲染，移动未选中卡或插入后再改选会出现两张卡同时
       显亮；editFocusIdx 仅保留末尾的聚焦滚动 */
    row.style.cssText='border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 9px;display:flex;flex-direction:column;gap:7px;';
    /* 预设任务行：仅可调整执行顺序（序号/上移/下移），内容与脚本在设置页配置，不可改名/删除 */
    if(s.preset){
      const def=(typeof presetDefOf==='function'&&presetDefOf(s.pkey))||{name:s.name,block:false};   // 沙盒单独抽取本函数时没有 presetDefOf，退回最小定义
      row.innerHTML='<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">'
        +'<input class="dshell-input" data-f="ord" type="number" min="1" max="'+editStages.length+'" value="'+(i+1)+'" title="顺序：直接输入目标序号后回车" style="width:52px;" />'
        +'<button class="dshell-btn dshell-btnGhost mini" type="button" data-act="up" '+(i===0?'disabled':'')+'>↑</button>'
        +'<button class="dshell-btn dshell-btnGhost mini" type="button" data-act="down" '+(i===editStages.length-1?'disabled':'')+'>↓</button>'
        +'<span style="font-weight:600;">'+esc(def.name)+'</span>'
        +'<span class="pipeline-preset">'+(def.custom?'🔒 预设任务（自定义）':'🔒 系统预设')+'</span>'
        +'<span class="dshell-muted" style="font-size:11px;">'+(def.custom?'由主控「预设任务」勾选启用，脚本在设置页「预设任务设置」配置；此处仅调整执行顺序':'由主控「预设任务」勾选启用，脚本在设置页配置；此处仅调整执行顺序')+(def.block?'；不通过（脚本非零退出）会阻断后续阶段':'')+'</span>'
        +'</div>';
      wrap.appendChild(row);
      return;
    }
    row.innerHTML='<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">'
      +'<input class="dshell-input" data-f="ord" type="number" min="1" max="'+editStages.length+'" value="'+(i+1)+'" title="顺序：直接输入目标序号后回车" style="width:52px;" />'
      +'<button class="dshell-btn dshell-btnGhost mini" type="button" data-act="up" '+(i===0?'disabled':'')+'>↑</button>'
      +'<button class="dshell-btn dshell-btnGhost mini" type="button" data-act="down" '+(i===editStages.length-1?'disabled':'')+'>↓</button>'
      +'<input class="dshell-input" data-f="name" value="'+esc(s.name)+'" placeholder="阶段名" style="width:128px;" />'
      +'<label class="dshell-muted" style="display:flex;align-items:center;gap:3px;font-size:11px;" title="模拟阶段的等待时长（分钟），内部按秒存储；0=不设置耗时，运行即结束">耗时(分钟)<input class="dshell-input" data-f="dur" type="number" min="0" step="0.1" value="'+secToMinInput(s.dur||0)+'" style="width:84px;" /></label>'
      +'<label class="dshell-muted" style="display:flex;align-items:center;gap:3px;font-size:11px;" title="阶段执行超时（分钟），脚本与 HTTP/EvalTokens 阶段均生效；留空=无超时">超时(分钟)<input class="dshell-input" data-f="timeout" type="number" min="0.1" step="0.1" value="'+(s.timeout?secToMinInput(s.timeout):'')+'" placeholder="不限" style="width:84px;" /></label>'
      +'<label class="dshell-muted" style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer;" title="勾选后运行到本阶段直接跳过"><input type="checkbox" data-f="skip" '+(s.skip?'checked':'')+'/> 不执行</label>'
      +'<label class="dshell-muted" style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer;" title="与相邻的并行任务同时执行；连续的普通任务会显示为一个并行组"><input type="checkbox" data-f="parallel" '+(s.parallel===true?'checked':'')+'/> 并行执行</label>'
      +'<label class="dshell-muted" style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer;" title="勾选后本任务进入终态（成功/失败）时，按本任务开始→结束时段调用「设置 → 普罗数据服务配置」的收集脚本采集普罗指标，产物写入本次运行归档目录的 {任务名}-{阶段序号}-普罗数据 文件夹（后台采集，失败不阻断流水线）"><input type="checkbox" data-f="promCollect" '+(s.promCollect?'checked':'')+'/> 收集普罗数据</label>'
      +'<span style="flex:1"></span>'
      +'<button class="dshell-btn dshell-btnDanger mini" type="button" data-act="del">删除</button>'
      +'</div>'
      +'<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">'
      +'<span class="dshell-muted" style="font-size:11px;">类型</span>'
      +'<div class="jk-mode" role="group" style="display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;">'
      +['simulate','shell','python','http','evaltokens'].map(function(k){return '<button type="button" class="dshell-btn dshell-btnGhost mini jk-modeBtn'+(s.kind===k?' sel':'')+'" data-act="kind" data-kind="'+k+'">'+STAGE_KIND_LABEL[k]+'</button>';}).join('')
      +'</div>'
      +'</div>'
      +'<div data-action style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;"></div>'
      +'<details class="plstage-params" data-param-panel style="display:none;">'
      +'<summary data-param-summary>任务参数（0）</summary>'
      +'<div data-params style="display:flex;gap:10px;flex-wrap:wrap;"></div>'
      +'</details>'
      +'<div data-sched style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;"></div>';
    wrap.appendChild(row);
    renderStageActionRow(i);
    renderStageParams(i);
    renderStageSched(i);
  });
  applyEditSel();   // 重渲染后 DOM 已重建，恢复选中卡高亮与上/下缘「+」插入按钮
  if(editFocusIdx>=0 && wrap.children && wrap.children[editFocusIdx]){ const fr=wrap.children[editFocusIdx]; if(fr.scrollIntoView) fr.scrollIntoView({block:'nearest'}); }
  editFocusIdx=-1;
  applyPlFormReadOnly();   // 只读模式（内置流水线对非 admin 只读）：禁用卡内全部编辑控件并禁止拖拽，每次重渲染后重复应用
}
function renderStageParams(i){
  const wrap=$('plStageList'); const row=(wrap && wrap.children) ? wrap.children[i] : null; if(!row) return;
  const panel=row.querySelector('[data-param-panel]');
  const panelTitle=panel&&panel.querySelector('[data-param-summary]');
  function setPanelCount(count){
    if(!panel) return;
    panel.style.display=count?'':'none';
    if(panelTitle) panelTitle.textContent='任务参数（'+count+'）';
  }
  setPanelCount(0);
  const box=row.querySelector('[data-params]'); if(!box) return; box.innerHTML='';
  const s=editStages[i]; if(!s) return;
  /* 模拟阶段无参数；HTTP 参数经 URL 的 {GIT_BRANCH} 等占位符传递。切换类型时会保留旧 script 元数据，
     因此脚本参数分支须按当前 kind 限定，不能仅凭 s.script 是否存在判断。 */
  if(s.kind==='simulate'||s.kind==='http') return;
  /* EvalTokens 阶段：任务输入参数可设置——识别到的任务原值填入框中（未改动时弱化色显示，仅展示、不下发），
     修改后写入 evaltokens.values 随流水线持久化，运行时作为输入覆盖随 run 启动请求下发（见 runEvaltokensStep）；
     清空或改回与任务原值一致=不覆盖（任务按创建时的输入运行）。「识别参数」重新识别时保留已设置的值不刷新 */
  if(s.kind==='evaltokens'){
    const et=s.evaltokens; const ps=et && et.params;
    if(!ps || !ps.length) return;
    setPanelCount(ps.length);
    et.values=et.values||{};
    const title=document.createElement('span'); title.className='dshell-muted'; title.style.fontSize='11px'; title.textContent='任务输入参数（自动识别，可设置覆盖）';
    box.appendChild(title);
    ps.forEach(p=>{
      const hasV=et.values[p.key]!==undefined;
      const v=hasV?et.values[p.key]:(p.def||'');
      const lab=document.createElement('label'); lab.className='dshell-muted';
      lab.style.cssText='display:flex;align-items:center;gap:4px;font-size:11px;';
      const name=document.createElement('span'); name.textContent=p.label;
      const inp=document.createElement('input'); inp.className='dshell-input'; inp.setAttribute('data-etpkey',p.key);
      inp.value=v; inp.placeholder=p.def||'';
      inp.title='任务创建时的输入参数（选中任务后自动识别），可直接修改：修改后作为输入覆盖随 run 启动请求下发（支持 ${VAR} 引用上游产出/运行级变量）；清空或改回与原值一致=不覆盖（按任务创建输入运行）；点动作行「识别参数」重新识别时已设置的值保留不刷新';
      inp.style.cssText='width:150px;font-size:11px;';
      if(!hasV && p.def) inp.style.color='var(--dsw-alias-label-tertiary)';   // 未改动的任务原值弱化显示（主题变量适配浅色/深色）
      inp.addEventListener('input',()=>{ inp.style.color=''; });
      inp.addEventListener('change',()=>{ commitEvaltokParamValue(et,p.key,inp.value,p.def); renderStageParams(i); });
      lab.appendChild(name); lab.appendChild(document.createTextNode(' ')); lab.appendChild(inp);
      box.appendChild(lab);
    });
    return;
  }
  if((s.kind!=='shell'&&s.kind!=='python')||!s.script||!s.script.params) return;
  setPanelCount(s.script.params.length);
  s.script.params.forEach(p=>{
    /* 识别到的默认值以可编辑文本填入框中（未改动时弱化色显示，仅为展示：不写进 values、不随执行下发，
       留空语义=继承运行级注入值（TARGET_IP/IMAGE_NAME 等）/上游同名变量，未注入则由脚本自身 :- 默认兜底；
       dyn 表达式（含 $引用/$(命令)）未改动时同样不下发——注入后 shell 不会二次展开，也不能按字面值下发）。
       在框中修改后作为显式值下发（优先级最高，见 execScript）；清空或改回与默认一致=恢复留空语义 */
    const hasV=!!(s.script.values&&s.script.values[p.key]!==undefined);
    const v=hasV?s.script.values[p.key]:(p.def||'');
    const lab=document.createElement('label'); lab.className='dshell-muted';
    lab.style.cssText='display:flex;align-items:center;gap:4px;font-size:11px;';
    lab.innerHTML=esc(p.label)+(p.required?'<span style="color:var(--st-err)" title="必填">*</span>':'')
      +' <input class="dshell-input" data-pkey="'+esc(p.key)+'" value="'+esc(v)+'" placeholder="'+esc(p.def||'')+'" title="识别默认值已填入框中、可直接修改：修改后作为显式值下发（优先级最高）；清空或改回与默认一致=继承运行级注入值（TARGET_IP/IMAGE_NAME 等）/上游同名变量，未注入则由脚本自身 :- 默认值兜底" style="width:150px;font-size:11px;'+(p.required&&!String(v).trim()?'border-color:var(--st-err);':'')+'" />';
    const inp=lab.querySelector('input');
    if(!hasV && p.def) inp.style.color='var(--dsw-alias-label-tertiary)';   // 未改动的默认值弱化显示（主题变量适配浅色/深色）
    inp.addEventListener('input',()=>{ inp.style.color=''; });
    inp.addEventListener('change',()=>{ s.script.values=s.script.values||{}; if(!inp.value||inp.value===p.def) delete s.script.values[p.key]; else s.script.values[p.key]=inp.value; renderStageParams(i); });
    box.appendChild(lab);
  });
}
/* EvalTokens 参数值提交：与脚本参数同一规则——清空或改回与任务原值（def）一致即删除显式值（恢复不覆盖语义），否则写入 values */
function commitEvaltokParamValue(et, key, value, def){
  et.values=et.values||{};
  if(!value || value===def) delete et.values[key]; else et.values[key]=value;
}
async function setStageScript(i, name){
  const s=editStages[i]; if(!s) return;
  const sc=scriptByName(name);
  if(!name || !sc){ s.script=null; renderStageParams(i); return; }
  const keep=(s.script && s.script.name===sc.name)?s.script:null;
  s.script={name:sc.name, path:sc.path, lang:sc.lang, params:(keep?keep.params:[]), values:(keep?keep.values:{}), outVars:((s.script&&s.script.outVars)||'')};   // 输出变量映射随脚本选择保留
  await detectStageParams(i);
}
/* keepOnError：打开编辑器时的自动重新识别置 true——脚本暂不可读（如 scriptsDir 在另一台机器）时
   保留已存参数不清空；「识别参数」按钮手动触发仍按失败清空（与脚本报不存在告警一致） */
async function detectStageParams(i, keepOnError){
  const s=editStages[i]; if(!s||!s.script||!s.script.path) return;
  try{
    const src=await readScriptSrc(s.script.path);
    const det=detectParams(src, s.script.lang);
    const oldParams=s.script.params||[]; const oldVals=s.script.values||{};
    s.script.params=det; s.script.values=s.script.values||{};
    det.forEach(p=>{
      const oldP=oldParams.find(o=>o.key===p.key);
      const oldV=oldVals[p.key];
      // 仅保留用户真实改动：旧值存在且不等于旧默认值（即用户手动改过）才保留；
      // 旧值等于旧默认（旧版识别器预填产物）则丢弃，回到「留空=注入值/脚本默认兜底」语义
      if(oldV!==undefined && oldP && String(oldV)!==String(oldP.def||'')) s.script.values[p.key]=oldV;
    });
  }catch(e){ if(!keepOnError) s.script.params=[]; }
  renderStageParams(i);
  applyPlFormReadOnly();   // 异步重识别重建了参数输入框，只读模式下需重新禁用
}

/* 「输出变量」旁的 ? 帮助徽标：区分来源格式与映射写法；srcTxt 为产出全文来源描述 */
function mkOutVarHelp(srcTxt){
  const b=document.createElement('span'); b.textContent='?';
  b.style.cssText='display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;margin-left:3px;border-radius:50%;border:1px solid var(--dsw-alias-state-accent-primary,#4f8ef7);color:var(--dsw-alias-state-accent-primary,#4f8ef7);font-size:10px;line-height:1;cursor:help;vertical-align:1px;';
  b.title=[
    '映射写法：目标变量名=来源，多条映射用英文逗号分隔，例如 IMAGE_URL=image, XDS_BRANCH=items.0.name, RESP=*。',
    '等号左侧是下游使用的变量名，区分大小写，建议使用大写字母/数字/下划线，不以数字开头。右侧可以是捕获的 key、JSON 路径（items.0.name，数组支持 [-1] 倒数），或 * / 留空（把'+srcTxt+'全文赋给该变量）。',
    '本框整体留空：捕获的 key 全部按原名下传；填写映射不会过滤其他已捕获变量。下游脚本可直接读取环境变量，脚本参数值可写 ${IMAGE_URL}，URL 可写 {IMAGE_URL}；下游同名参数未填写时继承上游值。'
  ].join('\n\n');
  if(srcTxt==='stdout') b.title+='\n\n'+[
    '脚本实际输出格式（只填写本框不会改变脚本输出）：',
    '推荐单行 JSON，支持小写变量名和多个变量：\necho \'{"key1":"1","key2":"2","key3":"2 3 4"}\'\n映射填写：key1=key1, key2=key2, key3=key3\n下游读取：echo "$key1"、echo "$key2"、echo "$key3"。',
    '也支持每行一个大写 KEY=VALUE：\necho "KEY1=1"\necho "KEY2=2"\n下游读取：echo "$KEY1"、echo "$KEY2"。',
    '不支持把 key1=1 key2=2 写在同一行当作多个变量；普通 key=value 行的小写键也不会被捕获。JSON 必须是单行合法 JSON，键和字符串值用双引号；多行 JSON 不会自动按完整对象解析。',
    '自动捕获仅提取 JSON 顶层字符串/数字/布尔值；嵌套字段或对象/数组需在映射中用 JSON 路径取值。变量来自 stdout，不解析 stderr。'
  ].join('\n\n');
  return b;
}
/* ---------- 阶段动作行（按类型渲染绑定：模拟/Shell/Python/HTTP/EvalTokens） ---------- */
function renderStageActionRow(i){
  const wrap=$('plStageList'); const row=(wrap && wrap.children) ? wrap.children[i] : null; if(!row) return;
  const box=row.querySelector('[data-action]'); if(!box) return; box.innerHTML='';
  const s=editStages[i]; if(!s) return;
  if(s.kind==='simulate'){
    const sp=document.createElement('span'); sp.className='dshell-muted'; sp.style.cssText='font-size:11px;'; sp.textContent='本地模拟（按耗时等待，0=不等待）'; box.appendChild(sp); return;
  }
  if(s.kind==='http'){
    const lab=document.createElement('span'); lab.className='dshell-muted'; lab.style.fontSize='11px'; lab.textContent='请求 URL';
    const inp=document.createElement('input'); inp.className='dshell-input'; inp.setAttribute('data-f','stageUrl'); inp.value=(s.url&&s.url.url)||''; inp.placeholder='http(s)://…（支持 {GIT_BRANCH} 等 {变量} 占位符）'; inp.style.width='320px';
    inp.title='粘贴完整请求地址（如 Jenkins 任务 …/job/app/job/{GIT_BRANCH}/buildWithParameters?token=xxx，或任意 webhook 地址）；URL 中可用 {GIT_BRANCH}、{IMAGE_NAME} 等 {变量} 占位符传参，运行时用注入的环境变量/上游产出替换（URL 编码），未定义的变量原样保留；触发为对完整地址直接 GET（等价 curl，URL 自含鉴权如 token 参数，不附加全局凭据）；URL 指向标准 Jenkins 任务路径时仍轮询构建结果，非标准路径按触发成功处理；连接模式（本地直连/服务端代连）走「Jenkins 服务配置」';
    const outLab=document.createElement('span'); outLab.className='dshell-muted'; outLab.style.fontSize='11px'; outLab.textContent='输出变量'; outLab.appendChild(mkOutVarHelp('响应体'));
    const outInp=document.createElement('input'); outInp.className='dshell-input'; outInp.setAttribute('data-f','urlOutVars'); outInp.value=(s.url&&s.url.outVars)||''; outInp.placeholder='如 IMAGE_URL=image, XDS_BRANCH=items.0.name, RESP=*'; outInp.style.width='200px';
    outInp.title='本请求响应体（Jenkins 控制台）产出变量的下传命名（逗号分隔）：留空=捕获的 KEY=VALUE / 单行 JSON 顶层字段全部按原名下传；IMAGE_URL=image 表示把响应体的 image 改名为 IMAGE_URL；来源也可写 JSON 路径取单行 JSON 的嵌套字段（如 XDS_BRANCH=items.0.name，数组支持 [-1] 倒数，终点为对象/数组则整体序列化），或填 * / 留空把响应体全文整体赋给指定变量（如 RESP=*）；下游阶段参数值可填 ${IMAGE_URL} 引用、URL 可填 {IMAGE_URL} 占位符引用';
    box.appendChild(lab); box.appendChild(inp); box.appendChild(outLab); box.appendChild(outInp); return;
  }
  if(s.kind==='evaltokens'){
    const lab=document.createElement('span'); lab.className='dshell-muted'; lab.style.fontSize='11px'; lab.textContent='EvalTokens 任务';
    /* 输入框 + 下拉面板置于同一 relative 容器：聚焦输入框自动拉取任务列表（可搜索），
       选中后回填 taskId/taskName 并自动识别任务输入参数；点容器外关闭面板。
       输入框优先显示任务标题（taskName）而非 taskId，便于辨认；手动输入时回退为所填值 */
    const pickWrap=document.createElement('span'); pickWrap.style.cssText='position:relative;display:inline-flex;align-items:center;gap:4px;';
    const inp=document.createElement('input'); inp.className='dshell-input'; inp.setAttribute('data-f','etTaskId'); inp.value=(s.evaltokens&&(s.evaltokens.taskName||s.evaltokens.taskId))||''; inp.placeholder='任务 ID 或名称（聚焦自动加载列表，支持 ${VAR}）'; inp.style.width='200px';
    inp.title='EvalTokens 服务（「设置」页配置地址/令牌/连接模式）中要运行的任务：填任务 ID（优先）或名称；聚焦输入框自动拉取任务列表供选择，选中后自动识别任务输入参数；支持 ${VAR} 引用上游阶段产出变量（如前序脚本输出 TASK_ID=xxx 后此处填 ${TASK_ID}），运行时替换后匹配任务（未定义的单个引用按空值处理）；运行时按连接模式（本地直连/服务端代连）+ Bearer 令牌启动一次新 run，并只等待该 run 到终态（成功/失败）后推进，捕获运行字段为输出变量';
    const panel=document.createElement('div'); panel.setAttribute('data-etpick-panel','1'); panel.style.cssText='display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:30;min-width:280px;max-height:260px;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.35);';
    pickWrap.appendChild(inp); pickWrap.appendChild(panel);
    inp.addEventListener('focus', ()=>{ if(panel.style.display==='none') openEvaltokPicker(i); });
    inp.addEventListener('input', ()=>{ if(panel.style.display!=='none') renderEvaltokPickerPanel(i, inp.value); });
    /* 「识别参数」：强制刷新任务列表缓存后重新识别输入参数（刷新参数定义与任务原值）；已设置的参数值保留、不被刷新 */
    const detBtn=document.createElement('button'); detBtn.className='dshell-btn dshell-btnGhost mini'; detBtn.type='button'; detBtn.textContent='识别参数';
    detBtn.title='重新拉取任务列表并识别该任务的输入参数（刷新参数定义与任务原值）；已在下方设置的参数值保留、不被刷新';
    detBtn.addEventListener('click', ()=>{ evaltokTasksCache={tasks:null,ts:0}; detectEvaltokStageParams(i,false); });
    const outLab=document.createElement('span'); outLab.className='dshell-muted'; outLab.style.fontSize='11px'; outLab.textContent='输出变量'; outLab.appendChild(mkOutVarHelp('任务字段'));
    const outInp=document.createElement('input'); outInp.className='dshell-input'; outInp.setAttribute('data-f','etOutVars'); outInp.value=(s.evaltokens&&s.evaltokens.outVars)||''; outInp.placeholder='如 STATUS=status, TASK_ID=*, CREATED=created_at'; outInp.style.width='200px';
    outInp.title='本任务字段产出变量的下传命名（逗号分隔）：留空=任务顶层标量字段全部按原名下传；STATUS=status 表示把任务 status 改名为 STATUS；来源也可写 JSON 路径取任务对象的嵌套字段（如 items.0.name，数组支持 [-1] 倒数，终点为对象/数组则整体序列化），或填 * / 留空把整条任务 JSON 整体赋给指定变量（如 TASK=*）；下游阶段参数值可填 ${STATUS} 引用';
    const reportLab=document.createElement('label'); reportLab.className='dshell-muted'; reportLab.style.cssText='display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer;'; reportLab.title='任务进入成功或失败终态后，把本次 run 的完整 HTML 报告写入流水线本次运行的归档目录；归档失败不改变任务结果';
    const reportInp=document.createElement('input'); reportInp.type='checkbox'; reportInp.setAttribute('data-f','etCollectReport'); reportInp.checked=!(s.evaltokens&&s.evaltokens.collectReport===false);
    reportLab.appendChild(reportInp); reportLab.appendChild(document.createTextNode(' 收集任务报告'));
    box.appendChild(lab); box.appendChild(pickWrap); box.appendChild(detBtn); box.appendChild(outLab); box.appendChild(outInp); box.appendChild(reportLab); return;
  }
  // shell / python
  const lab=document.createElement('span'); lab.className='dshell-muted'; lab.style.fontSize='11px'; lab.textContent='脚本';
  const inp=document.createElement('input'); inp.className='dshell-input'; inp.setAttribute('list','scriptsList'); inp.setAttribute('data-f','script'); inp.value=(s.script&&s.script.name)||''; inp.placeholder=(s.kind==='python'?'选择 .py 脚本（可搜索）':'选择 .sh 脚本（可搜索，留空=模拟）'); inp.style.width='216px';
  const btn=document.createElement('button'); btn.className='dshell-btn dshell-btnGhost mini'; btn.type='button'; btn.setAttribute('data-act','detect'); btn.textContent='识别参数';
  const outLab=document.createElement('span'); outLab.className='dshell-muted'; outLab.style.fontSize='11px'; outLab.textContent='输出变量'; outLab.appendChild(mkOutVarHelp('stdout'));
  const outInp=document.createElement('input'); outInp.className='dshell-input'; outInp.setAttribute('data-f','scriptOutVars'); outInp.value=(s.script&&s.script.outVars)||''; outInp.placeholder='如 IMAGE_URL=image, XDS_BRANCH=items.0.name, RESP=*'; outInp.style.width='200px';
  outInp.title='本阶段脚本 stdout 产出变量的下传命名（逗号分隔）：留空=捕获的 KEY=VALUE / 单行 JSON 顶层字段全部按原名下传；IMAGE_URL=image 表示把产出的 image 改名为 IMAGE_URL；来源也可写 JSON 路径取单行 JSON 的嵌套字段（如 XDS_BRANCH=items.0.name，数组支持 [-1] 倒数，终点为对象/数组则整体序列化），或填 * / 留空把 stdout 全文整体赋给指定变量（如 RESP=*）；下游阶段参数值可填 ${IMAGE_URL} 引用';
  box.appendChild(lab); box.appendChild(inp); box.appendChild(btn); box.appendChild(outLab); box.appendChild(outInp);
}
/* ---------- 阶段定时配置行（默认支持定时：跟随流水线定时计划，由服务端触发，关闭页面仍执行；勾选「本地运行」则不支持定时） ---------- */
function renderStageSched(i){
  const wrap=$('plStageList'); const row=(wrap && wrap.children) ? wrap.children[i] : null; if(!row) return;
  const box=row.querySelector('[data-sched]'); if(!box) return; box.innerHTML='';
  const s=editStages[i]; if(!s) return;
  const on=!!s.sched;
  let h='<label class="dshell-muted" style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer;"><input type="checkbox" data-f="sched" '+(!on?'checked':'')+'/> 本地运行</label><span class="dshell-muted" style="font-size:11px;cursor:help;margin-left:2px;" title="本地运行任务不支持定时任务">ⓘ</span>';
  if(on){
    h+='<span class="dshell-muted" style="font-size:11px;">跟随流水线定时计划执行（周期/一次性在「定时」页配置）；本地运行阶段须排在本阶段之前，否则保存报错；运行时前缀走运行队列，本阶段及之后由服务端触发</span>';
  }
  box.innerHTML=h;
}
function setStageKind(i,k){
  const s=editStages[i]; if(!s) return;
  if(['simulate','shell','python','http','evaltokens'].indexOf(k)<0) return;
  s.kind=k;
  if(k==='http'){ if(!s.url) s.url={url:'',outVars:''}; }
  else if(k==='evaltokens'){ if(!s.evaltokens) s.evaltokens=evaltokensStageConfig(null); if(!s.evaltokens.params) s.evaltokens.params=[]; }
  else if(k!=='simulate' && s.script){ s.script.lang=(k==='python')?'py':'sh'; }
  /* 类型按钮选中态同步：整行不重渲染（避免输入失焦），仅切换 .sel 类 */
  const wrap=$('plStageList'); if(wrap && wrap.children && wrap.children[i]){
    wrap.children[i].querySelectorAll('.jk-modeBtn').forEach(function(b){ b.classList.toggle('sel', b.getAttribute('data-kind')===k); });
  }
  renderStageActionRow(i); renderStageParams(i);
}
function setStageUrl(i, val){
  const s=editStages[i]; if(!s) return;
  if(!s.url) s.url={url:'',outVars:''};
  s.url.url=(val||'').trim();
}
