/* ===== 21-task-list.js · 流水线任务手动刷新与筛选（关键字/拥有者/收藏） =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 10686–10866）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */

/* ---------- 流水线任务手动刷新 ---------- */
/* 只刷新共享的流水线定义，不覆盖当前浏览器本地保存的环境/仓库选择与访问令牌；
   默认不自动刷新，用户点击「↻ 刷新」时才从服务端拉取。 */
function applyPipelineRefreshPayload(st){
  const cfg=(st && st.config && typeof st.config==='object' && !Array.isArray(st.config)) ? st.config : {};
  if(!Array.isArray(cfg.pipelines) || !cfg.pipelines.length) return false;
  /* 与 loadServerState 同口径（此前整表替换且不动基线，两个坑：① 在途的本地新增/修改被快照冲掉——
     改名 save-one 在途时点刷新，响应合入时发现本地已无改名，按「在途期间被改」回退成旧名；
     ② 共同基线停留旧快照——基线之后落盘的条目（复制副本、他端新增）在磁盘有而基线无，后续
     save-one 永久 phantom 409（baseOne=null ≠ 磁盘条目），改名被反复回滚且误报「被其他浏览器修改」）：
     按 id 三方合并保留本页在途改动，并以本次新鲜快照推进共同基线（含 keptBaseEntries 补回，口径见
     loadServerState），基线本来就是「最近一次成功 GET/PUT 的服务端配置」的缓存。 */
  const prevBasePipelines=(serverConfigBase&&Array.isArray(serverConfigBase.pipelines))?serverConfigBase.pipelines:[];
  const merged=mergePipelinesFromServer(prevBasePipelines, pipelines, cfg.pipelines);
  serverConfigBase=JSON.parse(JSON.stringify(cfg));
  stateFetchEpoch+=1;   // 基线前进（新鲜快照应用）：在途 GET 快照自此视为过期（见 fetchPipelineStateFresh）
  pipelines=regroupBuiltinPipelines(merged.pipelines).map(migrateGate).map(migrateStageUrl).map(migratePrefillDefaults).map(migratePipelineDefaults).map(migratePromPreset);
  rebindBuiltinScriptPaths();   /* 刷新替换内置条目后，按名对齐当前 scriptsDir 的脚本路径 */
  if(merged.keptBaseEntries.length) serverConfigBase.pipelines=(Array.isArray(serverConfigBase.pipelines)?serverConfigBase.pipelines:[]).concat(merged.keptBaseEntries.map(p=>JSON.parse(JSON.stringify(p))));
  if(!findPipeline(curPipelineId)) curPipelineId=pipelines[0].id;
  try{
    localStorage.setItem('pip-pipelines', JSON.stringify(pipelines));
    localStorage.setItem('pip-curPipeline', curPipelineId);
  }catch(e){}
  return true;
}
async function refreshPipelinesFromServer(){
  if(running){ alert('流水线运行中，暂不能刷新流水线任务。'); return; }
  const b=$('pipelineRefresh'); b.disabled=true;
  const sp=beginRefreshSpin(b);
  try{
    const st=await fetchPipelineStateFresh();   // 过期快照重拉（在途保存先于快照落盘时），见 fetchPipelineStateFresh
    if(!st) throw new Error('服务端配置拉取失败');
    /* 请求在途时仍可能从运行按钮启动任务：迟到响应不得改写运行快照与节点状态。 */
    if(running){ alert('流水线已开始运行，本次刷新已取消。'); return; }
    const keepSelectedId=selectedId;   // 响应提交前再取，保留请求在途期间用户新切换的阶段
    if(!applyPipelineRefreshPayload(st)) throw new Error('服务端暂无流水线任务');
    /* 完成态的 runStages 用于展示结果/失败重试，历史回放也依赖自己的阶段快照；
       两者只刷新任务列表，不重置当前阶段视图。纯空闲态才按新定义重建节点。 */
    if(!runStages && !replayRec){
      const stages=curPipeline().stages||[];
      selectedId=stages.some(s=>s && s.id===keepSelectedId) ? keepSelectedId : (stages[0] ? stages[0].id : null);
      resetNodes();
    }
    renderPipelines();
  }catch(e){ alert('刷新流水线任务失败：'+String(e && e.message || e)); }
  finally{ b.disabled=false; sp.stop(); }
}

/* ---------- 流水线任务筛选（关键字 + 拥有者 + 当前用户收藏） ---------- */
/* plFilter / savePlFilter / currentUsername 声明在前（紧随 histFilter），
   此处仅定义筛选匹配与下拉渲染函数。 */
/* 拥有者（编辑权限归属）：优先 owner 字段（新建/复制/补署时写入），存量流水线无 owner 字段时
   回退创建者（createdBy）；自包含实现——独立测试片段（vm 提取单函数）不依赖 plCreatorOf */
function plOwnerOf(p){ if(!p) return ''; const owner=(typeof p.owner==='string' && p.owner.trim()) ? p.owner.trim() : ''; return owner || ((typeof p.createdBy==='string' && p.createdBy.trim()) ? p.createdBy.trim() : ''); }
function plCreatorOf(p){ return (p && typeof p.createdBy==='string' && p.createdBy.trim()) ? p.createdBy.trim() : ''; }   /* 创建者：创建时定死的历史署名（数据属性），不再参与权限判定 */
function plUpdaterOf(p){ return (p && typeof p.updatedBy==='string' && p.updatedBy.trim()) ? p.updatedBy.trim() : ''; }   /* 最后修改人：与创建者同源（/auth/status 登录用户），保存/拖拽改序时刷新 */
/* 流水线归属编辑限制（仅页面侧判断；服务端无用户身份概念，与 canControlRun 同一约定）：
   仅拥有者可编辑/删除，消除多人编辑同一条流水线的竞争；他人可只读查看并「复制」为自己的副本。
   - 内置流水线视同可信：仅 admin 可编辑，其他用户只读（仍可运行）；任何人（含 admin）不可删除
     （见 deletePipeline），行菜单的标记可信入口对内置隐藏（内置无需切换，见 openPlRowMenu）；
   - 可信流水线（trusted，admin 标记）：仅 admin 可编辑/删除——admin 权限优先于「仅拥有者可编辑」；
     非 admin（含拥有者本人）只读，但仍可运行；行菜单的标记入口只对 admin 显示（见 openPlRowMenu）；
   - 未署名（owner 与 createdBy 均空白）的存量流水线全员可编辑，保存时按既有逻辑补署创建者与拥有者（见 savePlForm）；
   - auth 探测未完成（authReady 未置位）时对署名/可信/内置流水线保守只读；探测完成仍无登录用户
     （token 共享模式/未装认证插件/探测失败）退化为全权：页面无法判定 admin，trusted/内置不限制编辑、
     标记入口也不显示；
   - admin 例外：admin 可编辑/删除任意非可信流水线——拥有者账号注销/改名后流水线不致锁死；
     非 admin 仍仅拥有者可编辑。
   typeof 守卫：独立测试片段（vm 提取单函数）里可能没有这些全局；守卫缺失时按「探测完成仍无用户」
   退化全权处理。 */
function plEditable(p){
  if(!p) return false;
  if(p.builtIn || p.trusted){
    /* 内置流水线视同可信，与可信流水线同一规则：仅「auth 探测成功（password 模式）且为 admin」
       可编辑；探测在途保守只读，token 模式（探测完成仍无用户）退化为全权。 */
    const meTrusted=(typeof currentUsername!=='undefined') ? (currentUsername||'') : '';
    if(!meTrusted) return (typeof authReady==='undefined') ? true : !!authReady;
    return (typeof currentUserIsAdmin!=='undefined') ? !!currentUserIsAdmin : false;
  }
  const owner=(typeof plOwnerOf==='function') ? plOwnerOf(p) : ((typeof p.createdBy==='string' && p.createdBy.trim()) ? p.createdBy.trim() : '');
  if(!owner) return true;   // 未署名存量流水线：全员可编辑（保存时补署创建者与拥有者）
  const me=(typeof currentUsername!=='undefined') ? (currentUsername||'') : '';
  if(!me){
    /* 无登录用户：探测在途（authReady 未置位）对署名流水线保守只读；探测完成仍无用户
       （token 模式等）退化为全权。authReady 全局缺失（旧测试桩）按探测已完成处理。 */
    return (typeof authReady==='undefined') ? true : !!authReady;
  }
  if(owner===me) return true;   // 拥有者本人可编辑
  return (typeof currentUserIsAdmin!=='undefined') ? !!currentUserIsAdmin : false;   /* admin 例外：可编辑/删除他人拥有的非可信流水线——拥有者账号注销/改名后流水线不致锁死；非 admin 仍只读 */
}
function pipelineFavoriteUsers(p){
  const users=p&&Array.isArray(p.favoriteUsers)?p.favoriteUsers:[];
  return Array.from(new Set(users.filter(u=>typeof u==='string').map(u=>u.trim()).filter(Boolean)));
}
function isPipelineFavorite(p){
  const me=(currentUsername||'').trim();
  return !!me && pipelineFavoriteUsers(p).indexOf(me)>=0;
}
function togglePipelineFavorite(id){
  const p=findPipeline(id); if(!p) return;
  const me=(currentUsername||'').trim();
  if(!me){ alert('未获取到当前登录用户，无法收藏流水线。'); return; }
  const users=pipelineFavoriteUsers(p);
  p.favoriteUsers=users.indexOf(me)>=0?users.filter(u=>u!==me):users.concat(me);
  savePipelines();
  renderPipelines();
}
function plFilterMatch(p){
  const kw=plFilter.kw.trim().toLowerCase();
  if(kw){
    const hay=[p.name,p.id].concat((p.stages||[]).map(s=>s&&s.name).filter(Boolean)).join(' ').toLowerCase();
    if(hay.indexOf(kw)<0) return false;
  }
  if(plFilter.favorite==='favorite' && !isPipelineFavorite(p)) return false;
  const owner=plFilter.owner;
  if(owner==='all') return true;
  if(owner==='builtin') return !!p.builtIn;
  if(owner==='unknown') return !p.builtIn && !plOwnerOf(p);   /* 未署名：非内置且无拥有者 */
  if(owner && owner!=='mine'){
    const o=plOwnerOf(p);
    if(o===owner) return true;   /* 精确命中具体拥有者用户名 */
    /* 搜索口径：输入文本既非特殊标签（接线时已解析为模式键）、也不等于任何已知拥有者用户名时，
       按子串大小写不敏感匹配拥有者——输入片段即可过滤；等于某个已知用户名时只认精确相等（上面已判）。
       typeof 守卫：独立测试片段（vm 提取单函数）里可能没有 pipelines 全局，缺失时退化为纯子串匹配 */
    if((typeof pipelines!=='undefined'?pipelines:[]).some(q=>plOwnerOf(q)===owner)) return false;
    return !!o && o.toLowerCase().indexOf(owner.toLowerCase())>=0;
  }
  /* mine（默认）：内置流水线 + 本用户拥有的流水线 */
  if(!!p.builtIn) return true;
  const me=currentUsername||'';
  const o=plOwnerOf(p);
  return me ? (o===me) : !o;   /* 未取到当前用户时退化为「内置 + 未署名」，避免把列表整列隐藏 */
}
/* 拥有者候选名单缓存：特殊项（我的/全部/仅预置，存在未署名流水线时加「未署名」）
   + 全部已知拥有者用户名（pipelines.map(plOwnerOf) 去重排序）；签名去重避免无谓重算。
   每项 {key,label}：key 为筛选值（特殊项=模式键，用户名原样），label 为面板展示文本 */
function plOwnerOptions(){
  const owners=Array.from(new Set(pipelines.map(plOwnerOf).filter(Boolean))).sort();
  const hasUnknown=pipelines.some(p=>!p.builtIn && !plOwnerOf(p));
  const sig=owners.join('\u0001')+(hasUnknown?'\u0001u':'');
  if(sig!==_plOwnerSig){
    _plOwnerSig=sig;
    _plOwnerListCache=[{key:'mine',label:'我的（含预置）'},{key:'all',label:'全部'},{key:'builtin',label:'仅预置'}]
      .concat(owners.map(u=>({key:u,label:u})))
      .concat(hasUnknown?[{key:'unknown',label:'未署名'}]:[]);
  }
  return _plOwnerListCache;
}
/* 拥有者筛选候选面板：showAll 显示全量候选（聚焦弹出），否则按输入框文本子串过滤（大小写不敏感）；
   点选/回车提交精确项（key 直接作为 plFilter.owner，特殊项已是模式键） */
function renderPlOwnerPanel(showAll){
  const panel=$('plOwnerPanel'); const inp=$('plFilterOwner'); if(!panel||!inp) return;
  const q=showAll?'':inp.value.trim().toLowerCase();
  const list=plOwnerOptions().filter(it=>!q || it.label.toLowerCase().indexOf(q)>=0 || String(it.key).toLowerCase().indexOf(q)>=0);
  const item=it=>'<div data-plowner="'+esc(it.key)+'" style="padding:3px 8px;cursor:pointer;border-radius:5px;font-size:12px;white-space:nowrap;'+(it.key===plFilter.owner?'color:var(--dsw-alias-state-accent-primary);font-weight:600;':'')+'">'+esc(it.label)+'</div>';
  let h=list.map(item).join('');
  if(!list.length) h='<div class="dshell-muted" style="font-size:11px;padding:4px 6px;">无匹配候选</div>';
  panel.innerHTML=h; panel.style.display='block';
  _plOwnerActive=-1;
  /* preventDefault：避免 label 激活把焦点拉回输入框导致面板被 focus 处理器重新打开 */
  panel.querySelectorAll('[data-plowner]').forEach(el=>el.addEventListener('click',e=>{ e.preventDefault(); pickPlOwner(el.getAttribute('data-plowner')); }));
}
function plOwnerPanelItems(){ const panel=$('plOwnerPanel'); return panel?Array.from(panel.querySelectorAll('[data-plowner]')):[]; }
/* 拥有者筛选回显与面板同步：幂等回显（模式键→中文标签、用户名原样）；输入框聚焦（搜索输入中）时不回写，
   避免定时自动刷新打断输入。面板展开时随候选名单变化重绘 */
function renderPlFilterOptions(){
  const inp=$('plFilterOwner'); if(!inp) return;
  plOwnerOptions();   /* 候选名单随流水线集合刷新（签名去重） */
  if(document.activeElement!==inp){
    const want=plOwnerFilterLabel(plFilter.owner);
    if(inp.value!==want) inp.value=want;
  }
  const panel=$('plOwnerPanel');
  if(panel && panel.style.display==='block') renderPlOwnerPanel();
}
