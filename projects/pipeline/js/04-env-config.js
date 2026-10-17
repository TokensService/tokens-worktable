/* ===== 04-env-config.js · 节点环境配置（名称/IP/内网IP/LLM地址/凭据） =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 2235–2648）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */

/* ---------- 环境配置（名称 + IP + 内网IP + LLM服务地址 + 用户名 + 密码） ---------- */
function normalizeEnv(e){ return {id:e.id, name:e.name, ip:e.ip, nodeIp:e.nodeIp||'', llmAddr:e.llmAddr||'', user:e.user||'', pass:e.pass||''}; }
function loadEnvs(){ try{ const a=JSON.parse(localStorage.getItem('pip-envs')); if(Array.isArray(a)&&a.length) return a.map(normalizeEnv); }catch(e){} return null; }
function saveEnvs(){ try{ localStorage.setItem('pip-envs', JSON.stringify(environments)); }catch(e){} persistState(); }
function curEnv(){ return environments[0] || {id:'',name:'默认',ip:'127.0.0.1',user:'',pass:''}; }
function resolveEnv(v){ if(!v) return curEnv(); return environments.find(e=>e.id===v)||environments.find(e=>e.ip===v)||environments.find(e=>e.name===v)||{id:'',name:String(v),ip:String(v),user:'',pass:''}; }
function envLabelOf(v){ const e=resolveEnv(v); return (e.name && e.name!==e.ip) ? (e.name+'（'+e.ip+'）') : e.ip; }
function saveEnvSel(){ try{ localStorage.setItem('pip-envSel', JSON.stringify(selectedEnvIds)); }catch(e){} }
function curEnvs(){
  /* 按选中顺序（selectedEnvIds）返回，而非节点列表原序——TARGET_IP/TARGET_IPS 顺序跟随面板里的选中/排序结果 */
  if(!selectedEnvIds) return [];
  return selectedEnvIds.map(id=>environments.find(e=>e.id===id)).filter(Boolean);
}
function envSelText(){ return curEnvs().map(e=>e.ip).join('，'); }
/* 候选可用分组排序键：0=当前生效预留含我（预留给自己）→ 1=无生效预留（未分配）→ 2=预留给他人；
   可用节点排最前面。vm 抽取测试无预留函数/登录全局时按未分配处理（typeof 守卫，退化口径同 envReservedForOthers） */
function envAvailGroup(e){
  if(typeof envReservationInfo!=='function') return 1;
  const info=envReservationInfo(e, Date.now());
  if(!info||!info.reserved) return 1;
  const me=(typeof currentUsername!=='undefined')?(currentUsername||''):'';
  return (me && info.users.indexOf(me)>=0)?0:2;
}
/* 候选列表按可用分组稳定排序：组内保持 environments 原序 */
function envMultiAvailSort(list){
  return list.map((e,i)=>({e,i})).sort((a,b)=>{
    const ga=envAvailGroup(a.e), gb=envAvailGroup(b.e);
    return ga!==gb?ga-gb:a.i-b.i;
  }).map(x=>x.e);
}
/* GPU 空闲判定：已查询、未失败且无占用（未查询 / 查询失败不算空闲） */
function envMultiGpuIdle(e){
  if(typeof gpuBusy!=='function'||typeof gpuStatus==='undefined') return false;
  const st=gpuStatus[e.id];
  return !!(st && !st.error && !gpuBusy(st));
}
/* 候选筛选谓词：avail=只看「预留给我 / 未分配」（滤掉预留给他人）；gpuIdle=只看 GPU 空闲；同时勾选取交集 */
function envMultiListFilterMatch(e, filt){
  if(!filt) return true;
  if(filt.avail && envAvailGroup(e)===2) return false;
  if(filt.gpuIdle && !envMultiGpuIdle(e)) return false;
  return true;
}
/* 面板搜索：匹配名称 / SSH 地址 / 用户名 / 内网IP / LLM服务地址（子串、大小写不敏感） */
function envMultiFilterMatch(e, kw){
  if(!kw) return true;
  return (String(e.name||'')+' '+String(e.ip||'')+' '+String(e.user||'')+' '+String(e.nodeIp||'')+' '+String(e.llmAddr||'')).toLowerCase().indexOf(kw)>=0;
}
/* 已选节点排序键：name/user 按小写文本、ip 去掉「:端口」后按段数值、gpu 按设备状态（查询失败→未查询→空闲→占用） */
function envMultiSortVal(e, key){
  if(key==='name') return String(e.name||'').toLowerCase();
  if(key==='user') return String(e.user||'').toLowerCase();
  if(key==='ip') return String(e.ip||'').replace(/:\d+$/,'').split('.').map(p=>String(parseInt(p,10)||0).padStart(3,'0')).join('.');
  if(key==='gpu'){
    const st=gpuStatus[e.id];
    if(!st) return 100000;
    if(st.error) return 0;
    const used=st.used==undefined?0:st.used;
    return (gpuBusy(st)?300000:200000)+used;
  }
  return '';
}
function envMultiSortList(list, sort){
  if(!sort || !sort.key) return list;
  return list.map((e,i)=>({e,i})).sort((a,b)=>{
    const va=envMultiSortVal(a.e,sort.key), vb=envMultiSortVal(b.e,sort.key);
    if(va<vb) return -1*sort.dir;
    if(va>vb) return 1*sort.dir;
    return a.i-b.i;
  }).map(x=>x.e);
}
/* 环境多选面板（主控、定时页、流水线编辑器「默认环境」与运行弹窗共用渲染）：
   - 勾选状态经 getIds/setIds 回调注入，切换后执行 after 附加动作；允许一个不选（默认即无目标节点运行）
   - 顶部搜索框按名称 / IP / 用户名 / 内网IP / LLM服务地址 过滤下方节点列表（已选区不受过滤影响）
   - 搜索框下筛选行：「预留给我 / 未分配」「GPU 空闲」可单独或同时勾选（同时勾选取交集），只过滤候选列表
   - 候选列表按可用分组排序：当前生效预留含我（预留给自己）→ 无生效预留（未分配）→ 预留给他人，组内保持节点原序
   - 面板宽度 max-content 自适应：候选行 white-space:nowrap，一个节点的全部信息（名称/IP/GPU/预留徽标）一行显示全；
     上限 max-width:min(92vw,880px)，超出横向滚动；高度 max-height:min(60vh,560px)
   - o.availOnly（运行弹窗）：「预留给我 / 未分配」筛选默认勾选，预留给他人节点一律禁选（含 admin）；
     运行弹窗面板并 portal 到 body 以 fixed/z-index 1000 显示在最上层（不被弹窗 overflow 裁剪）
   - 已选节点区支持排序（名称 / IP / 设备状态，点一次升序、再点降序）与 ↑↓ 手动调序；
     顺序写回 ids，决定 TARGET_IP（首个）/ TARGET_IPS 的注入顺序 */
function renderEnvMulti(o){
  const btn=$(o.btnId); const panel=$(o.panelId); if(!btn||!panel) return;
  const ids=o.getIds()||[];
  /* 按选中顺序映射（而非 environments 原序），按钮文案与 TARGET_IPS 顺序一致 */
  const sel=ids.map(id=>environments.find(e=>e.id===id)).filter(Boolean);
  btn.textContent = sel.map(e=>e.ip).join('，') || '选择 IP';
  btn.title = btn.textContent;   // 限宽省略时悬浮可见完整 IP 列表
  const pid=o.panelId;
  /* availOnly 模式（当前仅运行弹窗）：「预留给我 / 未分配」筛选默认勾选（仅首次渲染物化默认值，
     用户在会话内的勾选改动保持）；候选行另按 envAvailGroup 禁选预留给他人节点 */
  if(o.availOnly && !envMultiListFilter[pid]) envMultiListFilter[pid]={avail:true,gpuIdle:false};
  const kw=(envMultiSearch[pid]||'').trim().toLowerCase();
  const selSort=envMultiSelSort[pid]||{key:null,dir:1};
  const filt=envMultiListFilter[pid]||null;
  panel.innerHTML='';

  /* 搜索框（sticky 置顶）：只切换下方列表行显隐，不整树重绘，避免输入过程中丢焦点 */
  const searchWrap=document.createElement('div');
  searchWrap.style.cssText='position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-base);padding:0 0 6px;margin:0 -2px;';
  const searchInp=document.createElement('input');
  searchInp.type='search';
  searchInp.className='dshell-input';
  searchInp.setAttribute('data-envmulti-search','');
  searchInp.placeholder='搜索 名称 / IP / 用户名';
  searchInp.autocomplete='off';
  searchInp.style.cssText='width:100%;font-size:12px;padding:4px 8px;';
  searchInp.value=envMultiSearch[pid]||'';
  searchWrap.appendChild(searchInp);
  /* 筛选行（与搜索框同在 sticky 置顶区）：「预留给我 / 未分配」「GPU 空闲」可单独或同时勾选（同时勾选取交集）；
     切换走整树重绘（checkbox 无输入焦点顾虑），勾选状态读 envMultiListFilter[pid] */
  const filterRow=document.createElement('div');
  filterRow.style.cssText='display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 2px 0;';
  [['avail','预留给我 / 未分配','只显示当前预留给我或没有生效预留（未分配）的节点'],
   ['gpuIdle','GPU 空闲','只显示设备状态已查询且空闲的节点（未查询 / 查询失败不列入）']].forEach(def=>{
    const fkey=def[0];
    const flab=document.createElement('label');
    flab.style.cssText='display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;';
    flab.title=def[2];
    const fcb=document.createElement('input');
    fcb.type='checkbox';
    fcb.setAttribute('data-envmulti-filter', fkey);
    fcb.checked=!!(filt && filt[fkey]);
    const flabText=document.createElement('span');
    flabText.textContent=def[1];
    flab.appendChild(fcb); flab.appendChild(flabText);
    filterRow.appendChild(flab);
  });
  searchWrap.appendChild(filterRow);
  panel.appendChild(searchWrap);

  /* 已选节点区：排序按钮 + 序号 + ↑↓ 调序 + × 取消（交互控件走 createElement，避免 innerHTML 注入并便于测试挂钩） */
  if(sel.length){
    const selHead=document.createElement('div');
    selHead.style.cssText='display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:2px 2px 4px;font-size:10px;color:var(--dsw-alias-label-tertiary);';
    const headLabel=document.createElement('span');
    headLabel.textContent='已选 '+sel.length;
    selHead.appendChild(headLabel);
    [['name','名称'],['ip','IP'],['gpu','设备']].forEach(pair=>{
      const key=pair[0], label=pair[1];
      const b=document.createElement('button');
      b.type='button';
      b.className='dshell-btn dshell-btnGhost mini';
      b.style.cssText='padding:1px 6px;font-size:10px;';
      b.title='按'+label+'排序（点一次升序、再点降序）';
      b.setAttribute('data-envmulti-sort', key);
      b.textContent=label+(selSort.key===key?(selSort.dir>0?' ▲':' ▼'):'');
      selHead.appendChild(b);
    });
    panel.appendChild(selHead);
    sel.forEach((e,idx)=>{
      const row=document.createElement('div');
      row.style.cssText='display:flex;align-items:center;gap:4px;padding:2px 4px;border-radius:5px;font-size:11px;';
      const no=document.createElement('span');
      no.className='dshell-muted'; no.style.minWidth='14px'; no.textContent=(idx+1)+'.';
      const nameSpan=document.createElement('span');
      nameSpan.style.cssText='flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      nameSpan.title=e.name+'（'+e.ip+'）';
      nameSpan.textContent=e.name+' ';
      const ipSpan=document.createElement('span');
      ipSpan.className='dshell-muted'; ipSpan.style.fontSize='10px'; ipSpan.textContent=e.ip;
      nameSpan.appendChild(ipSpan);
      const mkBtn=(attr,val,title,txt,disabled)=>{
        const b=document.createElement('button');
        b.type='button'; b.className='dshell-btn dshell-btnGhost mini';
        b.style.cssText='padding:0 5px;'; b.title=title; b.textContent=txt;
        if(disabled) b.disabled=true;
        b.setAttribute(attr,val);
        return b;
      };
      row.appendChild(no); row.appendChild(nameSpan);
      row.appendChild(mkBtn('data-envmulti-up', e.id, '上移', '↑', idx===0));
      row.appendChild(mkBtn('data-envmulti-down', e.id, '下移', '↓', idx===sel.length-1));
      row.appendChild(mkBtn('data-envmulti-rm', e.id, '取消选中', '×', false));
      panel.appendChild(row);
    });
    const sep=document.createElement('div');
    sep.style.cssText='border-top:1px solid var(--dsw-alias-border-l1);margin:6px 0 4px;';
    panel.appendChild(sep);
  }

  /* 全部节点复选列表（搜索 + 筛选行过滤；已选项仍在列表中可直接取消；
     按可用分组排序：预留给自己 → 未分配 → 预留给他人，组内保持节点原序） */
  const list=envMultiAvailSort(environments.filter(e=>envMultiFilterMatch(e, kw)&&envMultiListFilterMatch(e, filt)));
  const empty=document.createElement('div');
  empty.className='dshell-muted';
  empty.setAttribute('data-envmulti-empty','');
  empty.style.cssText='font-size:11px;padding:4px 6px;'+(list.length?'display:none;':'');
  empty.textContent='无匹配节点';
  panel.appendChild(empty);
  list.forEach(e=>{
    const on = ids.indexOf(e.id)>=0;
    const st=gpuStatus[e.id];
    const gpu=(st && st.total!==undefined)?(' · GPU '+(st.used===undefined?'?':st.used)+'/'+st.total):(st && st.error?' · GPU 查询失败':'');
    const lab=document.createElement('label');
    lab.setAttribute('data-envopt', e.id);
    /* 行不换行（white-space:nowrap）：配合面板 width:max-content，一个节点的名称/IP/GPU/预留徽标一行显示全 */
    lab.style.cssText='display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;border-radius:6px;white-space:nowrap;';
    const cb=document.createElement('input');
    cb.type='checkbox';
    cb.setAttribute('data-envcb', e.id);
    cb.checked=!!on;
    /* 节点预留拦截：当前被预留给他人的节点（envReservedForOthers）在未选中态禁用；
       已选中的保留可取消勾选，便于用户摘掉。vm 抽取测试无预留函数时按无预留处理（typeof 守卫） */
    if((typeof envReservedForOthers==='function') && envReservedForOthers(e) && !on) cb.disabled=true;
    /* availOnly 模式（运行弹窗）：预留给他人（envAvailGroup===2）的节点一律不可勾选（含 admin）；
       已选中的保留可取消勾选（便于摘掉继承自默认环境/运行框的节点） */
    if(o.availOnly && envAvailGroup(e)===2 && !on) cb.disabled=true;
    if(cb.disabled) lab.title='该节点当前预留给他人，不可选择';
    const textSpan=document.createElement('span');
    textSpan.textContent=e.name+' ';
    const meta=document.createElement('span');
    meta.className='dshell-muted'; meta.style.fontSize='10px';
    meta.textContent=e.ip+gpu;
    textSpan.appendChild(meta);
    lab.appendChild(cb); lab.appendChild(textSpan);
    /* 预留信息徽标：当前生效的预留对所有人显示（admin 不被拦截但仍提示；被拦者凭徽标得知预留对象与截止时间） */
    const resInfo=(typeof envReservationInfo==='function')?envReservationInfo(e, Date.now()):null;
    if(resInfo && resInfo.reserved){
      const badge=document.createElement('span');
      badge.className='dshell-muted';
      badge.style.cssText='font-size:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;white-space:nowrap;';
      badge.textContent='预留中：'+resInfo.users.join('、')+'（至 '+((typeof fmtResTime==='function'?fmtResTime(resInfo.until):'')||'—')+'）';
      lab.appendChild(badge);
    }
    panel.appendChild(lab);
  });

  /* 事件绑定 */
  searchInp.addEventListener('input',()=>{
    envMultiSearch[pid]=searchInp.value;
    const q=searchInp.value.trim().toLowerCase();
    const curFilt=envMultiListFilter[pid]||null;   // 实时读：筛选勾选触发的整树重绘之后本输入框已换新，此处仅为稳妥
    panel.querySelectorAll('[data-envopt]').forEach(row=>{
      const e=environments.find(x=>x.id===row.getAttribute('data-envopt'));
      row.style.display=(e && envMultiFilterMatch(e, q) && envMultiListFilterMatch(e, curFilt))?'':'none';
    });
    const emptyTip=panel.querySelector('[data-envmulti-empty]');
    if(emptyTip){
      const shown=environments.some(e=>envMultiFilterMatch(e,q)&&envMultiListFilterMatch(e,curFilt));
      emptyTip.style.display=shown?'none':'';
    }
  });
  panel.querySelectorAll('[data-envmulti-filter]').forEach(fcb=>fcb.addEventListener('change',()=>{
    const fkey=fcb.getAttribute('data-envmulti-filter');
    const cur=Object.assign({avail:false,gpuIdle:false}, envMultiListFilter[pid]||{});
    cur[fkey]=fcb.checked;
    envMultiListFilter[pid]=cur;
    renderEnvMulti(o);   // 筛选切换整树重绘（不改勾选态，无需 after）
  }));
  panel.querySelectorAll('[data-envmulti-sort]').forEach(b=>b.addEventListener('click',(ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    const key=b.getAttribute('data-envmulti-sort');
    const prev=envMultiSelSort[pid]||{key:null,dir:1};
    envMultiSelSort[pid]= prev.key===key ? {key, dir: prev.dir>0?-1:1} : {key, dir:1};
    const sorted=envMultiSortList(sel, envMultiSelSort[pid]).map(e=>e.id);
    o.setIds(sorted); renderEnvMulti(o);
    if(o.after) o.after();
  }));
  panel.querySelectorAll('[data-envmulti-up],[data-envmulti-down]').forEach(b=>b.addEventListener('click',(ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    const upId=b.getAttribute('data-envmulti-up'), downId=b.getAttribute('data-envmulti-down');
    const id=upId||downId;
    const cur=(o.getIds()||[]).slice();
    const i=cur.indexOf(id);
    const j=upId?i-1:i+1;
    if(i<0||j<0||j>=cur.length) return;
    const tmp=cur[i]; cur[i]=cur[j]; cur[j]=tmp;
    o.setIds(cur); renderEnvMulti(o);
    if(o.after) o.after();
  }));
  panel.querySelectorAll('[data-envmulti-rm]').forEach(b=>b.addEventListener('click',(ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    const id=b.getAttribute('data-envmulti-rm');
    const cur=(o.getIds()||[]).filter(x=>x!==id);
    o.setIds(cur); renderEnvMulti(o);
    if(o.after) o.after();
  }));
  panel.querySelectorAll('[data-envcb]').forEach(cb=>cb.addEventListener('change',()=>{
    const id=cb.getAttribute('data-envcb');
    let cur=(o.getIds()||[]).slice();
    if(cb.checked){ if(cur.indexOf(id)<0) cur.push(id); }
    else { cur=cur.filter(x=>x!==id); }   // 允许全部取消：不选择任何节点即无目标节点运行
    o.setIds(cur); renderEnvMulti(o);
    if(o.after) o.after();
  }));
}
function renderEnvOptions(){
  renderEnvMulti({btnId:'envMultiBtn', panelId:'envMultiPanel',
    getIds:()=>selectedEnvIds, setIds:(ids)=>{ selectedEnvIds=ids; saveEnvSel(); },
    after:()=>{ if(activeStages().some(s=>s.skip)) renderFlow(); renderDetail(); }});
  renderSchedEnvOptions();   // 定时页环境多选与主控共用节点环境数据，一并刷新
}
function envSortVal(e, key){
  if(key==='name') return (e.name||'').toLowerCase();
  if(key==='user') return (e.user||'').toLowerCase();
  if(key==='ip') return String(e.ip||'').replace(/:\d+$/,'').split('.').map(p=>String(parseInt(p,10)||0).padStart(3,'0')).join('.');   // 按段数值排 IP（先去掉「:端口」再分段）
  if(key==='gpu'){
    const st=gpuStatus[e.id];
    if(!st) return 100000;                       // 未查询
    if(st.error) return 0;                       // 查询失败排最前
    const used=st.used==undefined?0:st.used;
    return (gpuBusy(st)?300000:200000)+used;   // 空闲 → 占用（占用内按已用卡数）
  }
  return '';
}
function envSortList(list){
  if(!envSort.key) return list;
  return list.map((e,i)=>({e,i})).sort((a,b)=>{
    const va=envSortVal(a.e,envSort.key), vb=envSortVal(b.e,envSort.key);
    if(va<vb) return -1*envSort.dir;
    if(va>vb) return 1*envSort.dir;
    return a.i-b.i;                              // 同值保持原顺序
  }).map(x=>x.e);
}
/* 节点筛选：匹配名称 / IP / 内网IP / LLM服务地址 / 用户名 / 预留用户与备注 / 设备状态文本（容器名、空闲、占用、查询失败、卡数）。
   预留口径与「预留」列展示一致：该节点全部时段（生效中 / 未来 / 已结束）的预留用户名与备注均参与命中。 */
function envFilterMatch(e){
  const kw=envFilterText.trim().toLowerCase();
  if(!kw) return true;
  let text=(e.name+' '+e.ip+' '+(e.nodeIp||'')+' '+(e.llmAddr||'')+' '+(e.user||'')).toLowerCase();
  const st=gpuStatus[e.id];
  if(st){
    if(st.error) text+=' 查询失败';
    else{
      text+=' '+(st.containers||[]).join(' ').toLowerCase();
      text+=' '+(st.total==undefined?'?':st.total)+'卡 已用'+(st.used==undefined?'?':st.used);
      text+=gpuBusy(st)?' 占用':' 空闲';
    }
  }
  /* 「预留」列数据一并参与命中：reservationsForNode 按 nodeId 取全部时段记录，用户与备注拼接进匹配文本 */
  reservationsForNode(e.id).forEach(r=>{
    if(Array.isArray(r&&r.users)) text+=' '+r.users.join(' ').toLowerCase();
    if(r&&typeof r.note==='string'&&r.note) text+=' '+r.note.toLowerCase();
  });
  return text.indexOf(kw)>=0;
}
/* 节点配置（新增/编辑/复制/删除/统一凭证/导入覆盖 environments）是否可写：仅「password 模式且当前会话
   为 admin」。token 共享模式 / 未装认证插件 / 探测失败（无登录用户）退化为全权——与服务端
   environmentsWriteDeny「无 auth 服务一律放行」口径一致；auth 探测在途（authReady 未置位）先不拦
   （与节点预留拦截同一纪律，防加载前误灰），探测结束后由 applyEnvAdminGate + 重绘纠正。
   typeof 守卫：独立测试片段（vm 提取单函数）里可能没有这些全局，守卫缺失时退化全权。 */
function envConfigEditable(){
  if(typeof authReady!=='undefined' && !authReady) return true;
  const me=(typeof currentUsername!=='undefined') ? (currentUsername||'') : '';
  if(!me) return true;
  return (typeof currentUserIsAdmin!=='undefined') ? !!currentUserIsAdmin : false;
}
/* 节点配置门禁应用：按当前会话身份切换「节点管理」页编辑区显隐（非 admin 隐藏添加/编辑表单，换只读提示）。
   非 admin 同时把本地节点列表对齐到服务端基线（丢弃本地未落盘的增删改）——服务端写保护会 403 拒绝
   非 admin 的环境变更，本地残留分歧会让随后每次保存（哪怕只改流水线）都撞 403。探测在途不动作；
   token 模式退化为全权（envConfigEditable=true，下方 snap 分支不进）。身份到达后由
   fillExecutorFromAuth 的 finally 调用（随后 renderEnvs/renderEnvOptions 重绘）。 */
function applyEnvAdminGate(){
  const editable=envConfigEditable();
  const bar=$('envEditBar'); if(bar) bar.style.display=editable?'flex':'none';
  const tip=$('envAdminOnlyTip'); if(tip) tip.style.display=editable?'none':'';
  if(editable || typeof authReady==='undefined' || !authReady) return;
  if(typeof serverConfigBase==='undefined' || !serverConfigBase || !Array.isArray(serverConfigBase.environments)) return;
  const base=serverConfigBase.environments;
  const byId=new Map(environments.map(e=>[String(e&&e.id),e]));
  const same=base.length===environments.length && base.every(b=>{ const l=byId.get(String(b&&b.id)); return !!l && sameEnvEntry(l,b); });
  if(same) return;
  environments=base.map(e=>normalizeEnv(JSON.parse(JSON.stringify(e))));
  try{ localStorage.setItem('pip-envs', JSON.stringify(environments)); }catch(e){}
}
function renderEnvs(){
  const list=envSortList(environments.filter(envFilterMatch));
  const canEditEnv=envConfigEditable();   /* 配节点仅 admin：非 admin 操作列只留「分配」（只读查看），编辑/复制/删除不渲染 */
  $('envCount').textContent = environments.length? (envFilterText.trim()? '('+list.length+'/'+environments.length+')' : '('+environments.length+')') :'';
  const tb=$('envTable').querySelector('tbody'); tb.innerHTML='';
  list.forEach(e=>{
    const tr=document.createElement('tr');
    tr.innerHTML='<td style="font-weight:600">'+esc(e.name)+'</td><td class="dshell-muted">'+esc(e.ip)+'</td><td class="dshell-muted">'+esc(e.nodeIp||'—')+'</td><td class="dshell-muted">'+esc(e.llmAddr||'—')+'</td><td class="dshell-muted">'+esc(e.user||'—')+'</td><td class="dshell-muted">'+(e.pass?'••••••':'—')+'</td>'+
      '<td data-gpu="'+e.id+'" style="min-width:170px;">'+gpuCellFull(e)+'</td>'+
      '<td style="white-space:nowrap">'+envResSummaryHtml(e)+'</td>'+
      '<td style="white-space:nowrap"><button class="dshell-btn dshell-btnGhost mini" data-envres="'+esc(e.id)+'" title="查看/分配该节点的预留时段（仅 admin 可保存，非 admin 为只读查看）">分配</button>'+(canEditEnv?' <button class="dshell-btn dshell-btnGhost mini" data-envedit="'+e.id+'">编辑</button> <button class="dshell-btn dshell-btnGhost mini" data-envcopy="'+e.id+'" title="复制该节点为可编辑副本">复制</button> <button class="dshell-btn dshell-btnDanger mini" data-envdel="'+e.id+'">删除</button>':'')+'</td>';
    tb.appendChild(tr);
  });
  tb.querySelectorAll('[data-envedit]').forEach(b=>b.addEventListener('click',()=>startEnvEdit(b.getAttribute('data-envedit'))));
  tb.querySelectorAll('[data-envres]').forEach(b=>b.addEventListener('click',()=>openNodeResDialog(b.getAttribute('data-envres'))));   /* 操作列「分配」按钮：admin 可编辑，非 admin 只读查看（openNodeResDialog 内分形态） */
  tb.querySelectorAll('[data-envcopy]').forEach(b=>b.addEventListener('click',()=>copyEnv(b.getAttribute('data-envcopy'))));
  tb.querySelectorAll('[data-envdel]').forEach(b=>b.addEventListener('click',()=>delEnv(b.getAttribute('data-envdel'))));
  tb.querySelectorAll('[data-gpurefresh]').forEach(b=>b.addEventListener('click',()=>{ const e=environments.find(x=>x.id===b.getAttribute('data-gpurefresh')); if(e) fetchGpu(e); }));
  tb.querySelectorAll('[data-gpudetail]').forEach(b=>b.addEventListener('click',()=>{ const e=environments.find(x=>x.id===b.getAttribute('data-gpudetail')); if(e) openGpuDetail(e); }));
  $('envTable').querySelectorAll('th[data-sort]').forEach(th=>{ th.querySelector('.env-sort-arrow').textContent = th.getAttribute('data-sort')===envSort.key ? (envSort.dir>0?'▲':'▼') : ''; });
}
function gpuCellFull(e){
  return gpuCellHtml(gpuStatus[e.id])
    +' <button class="dshell-btn dshell-btnGhost mini" data-gpurefresh="'+e.id+'" title="刷新设备状态" style="padding:2px 7px;">⟳</button>'
    +' <button class="dshell-btn dshell-btnGhost mini" data-gpudetail="'+e.id+'" title="查看设备状态与失败原因" style="padding:2px 7px;">详情</button>';
}
function bindGpuCell(cell, e){
  const rb=cell.querySelector('[data-gpurefresh]'); if(rb) rb.addEventListener('click',()=>fetchGpu(e));
  const db=cell.querySelector('[data-gpudetail]'); if(db) db.addEventListener('click',()=>openGpuDetail(e));
}
