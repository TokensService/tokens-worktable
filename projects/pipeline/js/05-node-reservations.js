/* ===== 05-node-reservations.js · 节点预留（按用户 + 日期时间段分配节点） =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 2649–3096）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* ---------- 节点预留（按用户 + 日期时间段分配节点；admin 维护、全员可见） ---------- */
async function loadNodeReservations(){
  try{
    const resp=await fetch('/api/worktable/pipeline/reservations');
    if(!resp||!resp.ok) return;   // 失败静默：保留旧值
    const data=await resp.json();
    if(data&&Array.isArray(data.reservations)) nodeReservations=data.reservations;
  }catch(e){ return; }   // 网络/解析失败同样静默保留旧值
  /* 预留影响节点表「预留」列与四处环境多选面板（主控/定时/编辑器默认环境/运行弹窗）的可勾选态：
     数据到达后重绘；vm 抽取测试无这些全局时跳过（typeof 守卫，不阻断数据本身） */
  if(typeof renderEnvs==='function' && typeof renderEnvOptions==='function'){ renderEnvs(); renderEnvOptions(); }
}
/* 某节点的全部预留记录，按开始时间升序（供「预留」列摘要与弹窗窗口列表） */
function reservationsForNode(nodeId){
  return nodeReservations.filter(r=>r&&String(r.nodeId)===String(nodeId)).slice()
    .sort((a,b)=>{ const ta=Date.parse(a&&a.start)||0, tb=Date.parse(b&&b.start)||0; return ta-tb; });
}
/* 预留时间显示：ISO UTC → 本地 MM-DD HH:mm；非法输入返回空串（调用方以 — 兜底） */
function fmtResTime(iso){
  const t=Date.parse(iso); if(isNaN(t)) return '';
  const d=new Date(t);
  const p2=n=>String(n).padStart(2,'0');
  return p2(d.getMonth()+1)+'-'+p2(d.getDate())+' '+p2(d.getHours())+':'+p2(d.getMinutes());
}
/* ISO UTC → datetime-local 输入框值（本地 YYYY-MM-DDTHH:mm）；非法输入返回空串 */
function isoToLocalInput(iso){
  const t=Date.parse(iso); if(isNaN(t)) return '';
  const d=new Date(t);
  const p2=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+'T'+p2(d.getHours())+':'+p2(d.getMinutes());
}
/* 节点当前预留态：windows=覆盖 nowMs 的记录（覆盖判定 Date.parse(start)<=nowMs<Date.parse(end)，
   即 T==start 覆盖、T==end 不覆盖）；users=覆盖记录 users 并集（保持出现顺序）；
   until=覆盖记录里最早的 end（无覆盖为 null）。nowMs 缺省取当前时刻。 */
function envReservationInfo(env, nowMs){
  const id=env&&env.id;
  const now=(typeof nowMs==='number')?nowMs:Date.now();
  const all=(id!==undefined&&id!==null)?reservationsForNode(id):[];
  const windows=all.filter(r=>{
    const s=Date.parse(r&&r.start), e=Date.parse(r&&r.end);
    return !isNaN(s)&&!isNaN(e)&&s<=now&&now<e;
  });
  const users=[];
  windows.forEach(r=>{ (Array.isArray(r.users)?r.users:[]).forEach(u=>{ if(users.indexOf(u)<0) users.push(u); }); });
  let until=null;
  windows.forEach(r=>{ if(until===null||Date.parse(r.end)<Date.parse(until)) until=r.end; });
  return {reserved:windows.length>0, users, until, windows};
}
/* 选择拦截判定：节点当前被预留给他人（不含当前用户）时非 admin 不可选。
   authReady 未置位（登录态探测在途）一律不拦，防加载前误灰；admin 全权旁路（UI 仍显示预留信息徽标）；
   无登录身份（currentUsername 空串：无 auth 服务的 token 共享模式）不拦——与服务端「无 auth 一律不强制」
   口径一致（该模式下服务端 PUT/运行/租约全部放行，客户端拦截只会造成两端口径分裂）；
   authReady/currentUserIsAdmin/currentUsername 全局缺失（旧测试桩环境）按保守口径退化。 */
function envReservedForOthers(env){
  if(typeof authReady!=='undefined' && !authReady) return false;
  if(typeof currentUserIsAdmin!=='undefined' && currentUserIsAdmin) return false;
  const info=envReservationInfo(env, Date.now());
  if(!info.reserved) return false;
  const me=(typeof currentUsername!=='undefined')?(currentUsername||''):'';
  if(!me) return false;
  return info.users.indexOf(me)<0;
}
/* 运行校验（客户端体验层，真正门禁在服务端）：envs 中被预留给他人的节点逐个列明细，全部可用返回 null */
function envReservationIssue(envs){
  const list=Array.isArray(envs)?envs:[];
  const blocked=[];
  list.forEach(e=>{
    if(!e||!envReservedForOthers(e)) return;
    const info=envReservationInfo(e, Date.now());
    blocked.push((e.name||e.ip||e.id)+'('+(e.ip||'')+') 预留给 '+info.users.join('、')+'，至 '+(fmtResTime(info.until)||'—'));
  });
  if(!blocked.length) return null;
  return '节点预留冲突：'+blocked.join('；');
}
/* 节点表「预留」列：逐时段一行、三列网格对齐（时间段 | 用户 | 备注），按开始时间升序；
   生效中时段整行高亮（st-run 色 + 600 字重，不加文字前缀，保持各行左缘对齐），
   已结束时段整行置灰并在备注格后缀「（已结束）」，未来时段普通样式；无预留显示 —。
   「分配」按钮在操作列（renderEnvs 行尾、「编辑」之前；admin 打开可编辑弹窗，非 admin 打开同弹窗只读形态），不在本列。
   用户名/备注等注入字段一律 esc 转义；单元格 white-space:nowrap 保证一个时段一行（长内容经表格外层 overflow 横向滚动）。 */
function envResSummaryHtml(e){
  const records=reservationsForNode(e.id);
  const now=Date.now();
  let summary;
  if(!records.length){
    summary='<span class="dshell-muted">—</span>';
  } else {
    summary='<div style="display:grid;grid-template-columns:auto auto 1fr;column-gap:10px;row-gap:2px;">'
      +records.map(r=>{
        const s=Date.parse(r&&r.start), t=Date.parse(r&&r.end);
        const range=esc(fmtResTime(r&&r.start)||'—')+' ~ '+esc(fmtResTime(r&&r.end)||'—');
        const users=(Array.isArray(r&&r.users)&&r.users.length?r.users:['—']).map(u=>esc(u)).join('、');
        const active=!isNaN(s)&&!isNaN(t)&&s<=now&&now<t, expired=!isNaN(t)&&t<=now;
        const cls=expired?' class="dshell-muted"':'';
        const st=active?'color:var(--st-run);font-weight:600;':'';
        const tip=active?' title="当前生效的预留时段"':(expired?' title="已结束的预留时段"':'');
        const note=(r&&r.note?esc(r.note):'')+(expired?'（已结束）':'');
        return '<span'+cls+' style="white-space:nowrap;'+st+'"'+tip+'>'+range+'</span>'
          +'<span'+cls+' style="white-space:nowrap;'+st+'"'+tip+'>'+users+'</span>'
          +'<span'+cls+' style="white-space:nowrap;'+st+'"'+tip+'>'+note+'</span>';
      }).join('')+'</div>';
  }
  return summary;
}
/* 候选用户回退集：现有预留用户名并集 + 当前用户名（/auth/users 拉取失败时使用；候选外的用户名也可在搜索框直接输入添加） */
function nodeResFallbackUsers(){
  const out=[];
  nodeReservations.forEach(r=>{ (Array.isArray(r&&r.users)?r.users:[]).forEach(u=>{ if(out.indexOf(u)<0) out.push(u); }); });
  const me=(typeof currentUsername!=='undefined')?(currentUsername||''):'';
  if(me && out.indexOf(me)<0) out.push(me);
  return out;
}
/* 预留弹窗候选用户：/auth/users（任意登录会话可读）缓存优先；失败保留 null 由调用方回退 */
async function ensureAuthUsers(){
  if(authUsersCache) return authUsersCache;
  try{
    const r=await fetch('/auth/users');
    if(r&&r.ok){
      const d=await r.json();
      if(d&&Array.isArray(d.users)) authUsersCache=d.users.map(u=>String(u&&u.username||'').trim()).filter(Boolean);
    }
  }catch(e){ /* 拉取失败：保持 null，候选回退现有预留用户名并集 + 当前用户名 */ }
  return authUsersCache;
}
/* 打开预留弹窗：admin 可编辑，非 admin 只读（全部输入禁用、底栏只留「关闭」，标题旁注明）；
   打开即快照该节点窗口为 base（保存时上送，供服务端比对 409）。窗口草稿的 start/end 用本地
   datetime-local 值（保存时统一 new Date(v).toISOString() 转 UTC）。 */
async function openNodeResDialog(envId){
  const e=environments.find(x=>String(x.id)===String(envId));
  if(!e) return;
  const canEdit=!!((typeof currentUserIsAdmin!=='undefined')&&currentUserIsAdmin);
  const records=reservationsForNode(e.id);
  nodeResEdit={
    envId:e.id,
    base:JSON.parse(JSON.stringify(records)),   // 打开时窗口快照（原始记录，含 id/start/end/users/note）
    windows:records.map(r=>({id:r.id, start:isoToLocalInput(r.start), end:isoToLocalInput(r.end), users:Array.isArray(r.users)?r.users.slice():[], note:typeof r.note==='string'?r.note:''})),
    readonly:!canEdit,
  };
  $('nodeResTitle').textContent='节点预留分配 — '+(e.name||e.ip)+'（'+e.ip+'）';
  $('nodeResReadonlyTip').style.display=canEdit?'none':'';
  /* 底栏与「添加时段」仅 admin 可见可用；只读形态底栏只留「关闭」 */
  $('nodeResSave').style.display=canEdit?'':'none';
  $('nodeResCancel').style.display=canEdit?'':'none';
  $('nodeResCloseFooter').style.display=canEdit?'none':'';
  $('nodeResAddWindow').style.display=canEdit?'':'none';
  await ensureAuthUsers();
  $('nodeResTip').textContent=authUsersCache?'':'用户列表拉取失败：候选回退为「现有预留用户名 + 当前用户」，也可直接在搜索框输入用户名添加。';
  renderNodeResWindows();
  $('nodeResDialog').style.display='flex';
}
function closeNodeResDialog(){
  nodeResEdit=null;
  $('nodeResDialog').style.display='none';
}
/* 快捷时段计算：sh~eh 整点时段（eh<=sh 为跨零点，结束落在次日）。基准日期取该行已填开始
   （datetime-local 本地值），未填则用 now；未填且当天该时段结束时间已过才推到次日
   （开始已过但结束未过的时段仍给当天——时段覆盖当前，仍是有效预留）。返回 {start,end}（datetime-local 本地值）。 */
function quickResRange(baseStart, sh, eh, nowMs){
  const now=(typeof nowMs==='number')?new Date(nowMs):new Date();
  const hasBase=(typeof baseStart==='string'&&!!baseStart);
  const base=hasBase?new Date(baseStart):now;
  const p2=n=>String(n).padStart(2,'0');
  const fmt=d=>d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+'T'+p2(d.getHours())+':'+p2(d.getMinutes());
  const start=new Date(base.getFullYear(), base.getMonth(), base.getDate(), sh, 0);
  if(!hasBase){
    const endToday=new Date(base.getFullYear(), base.getMonth(), base.getDate(), eh, 0);
    if(eh<=sh) endToday.setDate(endToday.getDate()+1);
    if(now>=endToday) start.setDate(start.getDate()+1);
  }
  const end=new Date(start.getFullYear(), start.getMonth(), start.getDate(), eh, 0);
  if(eh<=sh) end.setDate(end.getDate()+1);
  return {start:fmt(start), end:fmt(end)};
}
/* 重绘弹窗时段列表：每行 = 开始/结束（datetime-local）+ 快捷时段 + 用户标签搜索框 + 备注 + 删除本时段；
   已结束（end 已过当前时刻）的时段整行置灰并在首行标识「（已结束）」，编辑开始/结束即时重估（applyPastStyle）。
   候选 =（/auth/users 缓存 || 回退集）∪ 该行已选用户（保证已选用户名总在候选中）。
   控件一律 createElement + textContent，用户名不走 innerHTML，杜绝注入。只读形态全部禁用。 */
function renderNodeResWindows(){
  const st=nodeResEdit; const list=$('nodeResList'); if(!st||!list) return;
  const ro=!!st.readonly;
  list.innerHTML='';
  if(!st.windows.length){
    const empty=document.createElement('div');
    empty.className='dshell-muted';
    empty.style.cssText='font-size:11px;padding:4px 2px;';
    empty.textContent='暂无预留时段'+(ro?'':'，点下方「＋ 添加时段」新建。');
    list.appendChild(empty);
  }
  const baseCandidates=(authUsersCache||nodeResFallbackUsers());
  st.windows.forEach((w,i)=>{
    const row=document.createElement('div');
    row.setAttribute('data-reswindow', String(i));
    row.style.cssText='border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;';
    /* 第一行：开始 / 结束 / 「（已结束）」标识 / 快捷时段 / 删除本时段 */
    const line1=document.createElement('div');
    line1.style.cssText='display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
    const mkTime=(label,key)=>{
      const lab=document.createElement('label');
      lab.className='dshell-muted';
      lab.style.cssText='display:flex;align-items:center;gap:5px;font-size:11px;';
      lab.textContent=label;
      const inp=document.createElement('input');
      inp.type='datetime-local';
      inp.className='dshell-input';
      inp.setAttribute('data-res-'+key, String(i));
      inp.value=w[key]||'';
      inp.disabled=ro;
      inp.addEventListener('change',()=>{ w[key]=inp.value; applyPastStyle(); });
      lab.appendChild(inp);
      return lab;
    };
    line1.appendChild(mkTime('开始','start'));
    line1.appendChild(mkTime('结束','end'));
    /* 已结束（end 已过当前时刻）的时段整行置灰 + 首行「（已结束）」标识（mkTime 的 change 事件即时重估；
       与「预留」列的已结束置灰同一视觉语言；生效中/未来时段与新建空时段不置灰） */
    const pastTag=document.createElement('span');
    pastTag.className='dshell-muted';
    pastTag.setAttribute('data-res-past', String(i));
    pastTag.style.cssText='font-size:11px;display:none;';
    pastTag.textContent='（已结束）';
    line1.appendChild(pastTag);
    const applyPastStyle=()=>{
      const wEnd=Date.parse(w.end||'');
      const past=!isNaN(wEnd)&&wEnd<=Date.now();
      row.style.opacity=past?'0.55':'';
      row.title=past?'该时段已结束':'';
      pastTag.style.display=past?'':'none';
    };
    applyPastStyle();
    /* 快捷时段：9~14 / 14~19 / 19~22 / 22~9（跨零点）一键填充开始/结束（规则见 quickResRange） */
    if(!ro){
      const quick=document.createElement('span');
      quick.style.cssText='display:inline-flex;align-items:center;gap:4px;font-size:11px;';
      const qlab=document.createElement('span'); qlab.className='dshell-muted'; qlab.textContent='快捷'; quick.appendChild(qlab);
      [[9,14],[14,19],[19,22],[22,9]].forEach(([sh,eh])=>{
        const b=document.createElement('button');
        b.type='button'; b.className='dshell-btn dshell-btnGhost mini';
        b.style.cssText='padding:2px 7px;';
        b.textContent=sh+'~'+eh;
        b.setAttribute('data-res-quick', sh+'-'+eh);
        b.title='填为 '+String(sh).padStart(2,'0')+':00 ~ '+String(eh).padStart(2,'0')+':00'+(eh<=sh?'（次日）':'')+'；未填开始日期取今天（当天该时段已结束才取次日）';
        b.addEventListener('click',()=>{ const r=quickResRange(w.start, sh, eh); w.start=r.start; w.end=r.end; renderNodeResWindows(); });
        quick.appendChild(b);
      });
      line1.appendChild(quick);
    }
    const sep1=document.createElement('span'); sep1.style.flex='1'; line1.appendChild(sep1);
    if(!ro){
      const del=document.createElement('button');
      del.type='button'; del.className='dshell-btn dshell-btnDanger mini';
      del.setAttribute('data-res-del', String(i));
      del.textContent='删除本时段';
      del.addEventListener('click',()=>{ st.windows.splice(i,1); renderNodeResWindows(); });
      line1.appendChild(del);
    }
    row.appendChild(line1);
    /* 第二行：用户标签输入——不再平铺全部用户名。已选用户为标签（× 移除）；搜索框输入即时过滤
       候选下拉，点击/回车选中；逗号（,/，/;/；）即时提交前段为标签，一次可逗号分隔输入多个；
       候选外的用户名也可直接输入提交。添加只做局部 DOM 追加（不整行重绘），保持输入框焦点。 */
    const line2=document.createElement('div');
    line2.style.cssText='display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;';
    const who=document.createElement('span'); who.className='dshell-muted'; who.textContent='用户'; line2.appendChild(who);
    const chipsWrap=document.createElement('span');
    chipsWrap.style.cssText='display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap;';
    line2.appendChild(chipsWrap);
    const candidates=baseCandidates.concat(w.users).filter((v,idx,a)=>v&&a.indexOf(v)===idx);
    const makeChip=u=>{
      const chip=document.createElement('span');
      chip.setAttribute('data-res-chip', u);
      chip.style.cssText='display:inline-flex;align-items:center;gap:3px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;';
      const nm=document.createElement('span'); nm.textContent=u; chip.appendChild(nm);
      if(!ro){
        const x=document.createElement('button');
        x.type='button'; x.className='dshell-btn dshell-btnGhost mini';
        x.style.cssText='padding:0 2px;border:none;line-height:1;';
        x.textContent='×'; x.title='移除该用户';
        x.setAttribute('data-res-chip-rm', u);
        x.addEventListener('click',()=>{ w.users=w.users.filter(x2=>x2!==u); renderNodeResWindows(); });
        chip.appendChild(x);
      }
      return chip;
    };
    w.users.forEach(u=>chipsWrap.appendChild(makeChip(u)));
    const addUser=u=>{
      u=String(u||'').trim(); if(!u||w.users.indexOf(u)>=0) return;
      w.users.push(u); chipsWrap.appendChild(makeChip(u));
    };
    if(!ro){
      const wrap=document.createElement('span');
      wrap.style.cssText='position:relative;display:inline-block;';
      const inp=document.createElement('input');
      inp.className='dshell-input';
      inp.setAttribute('data-res-user-search', String(i));
      inp.placeholder='搜索/输入用户名，逗号分隔多个';
      inp.autocomplete='off';
      inp.style.cssText='width:200px;font-size:11px;padding:3px 8px;';
      const panel=document.createElement('div');
      panel.style.cssText='display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:40;min-width:180px;max-height:200px;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.35);';
      const renderPanel=()=>{
        const q=inp.value.trim().toLowerCase();
        panel.innerHTML='';
        candidates.filter(u=>w.users.indexOf(u)<0 && (!q || u.toLowerCase().indexOf(q)>=0)).slice(0,20).forEach(u=>{
          const it=document.createElement('div');
          it.setAttribute('data-res-candidate', u);
          it.style.cssText='padding:4px 8px;cursor:pointer;border-radius:6px;';
          it.textContent=u;
          it.addEventListener('mouseenter',()=>{ it.style.background='var(--dsw-alias-fill-l1)'; });
          it.addEventListener('mouseleave',()=>{ it.style.background=''; });
          /* mousedown + preventDefault：抢先 blur 提交，选中后保持输入框焦点可连续添加 */
          it.addEventListener('mousedown',ev=>{ if(ev&&ev.preventDefault) ev.preventDefault(); addUser(u); inp.value=''; renderPanel(); });
          panel.appendChild(it);
        });
        if(!panel.children.length){
          const empty=document.createElement('div');
          empty.className='dshell-muted'; empty.style.cssText='padding:4px 8px;';
          empty.textContent=q?'无匹配候选，回车直接添加为新用户':'无可选候选，可直接输入用户名';
          panel.appendChild(empty);
        }
      };
      const commitText=txt=>{ String(txt||'').split(/[,，;；]/).forEach(s=>addUser(s)); };
      inp.addEventListener('focus',()=>{ renderPanel(); panel.style.display='block'; });
      inp.addEventListener('input',()=>{
        const v=inp.value;
        if(/[,，;；]/.test(v)){
          const segs=v.split(/[,，;；]/);
          inp.value=segs.pop();   /* 最后一段继续编辑 */
          segs.forEach(s=>addUser(s));
        }
        renderPanel();
      });
      inp.addEventListener('keydown',ev=>{
        if(ev&&ev.key==='Enter'){ if(ev.preventDefault) ev.preventDefault(); const t=inp.value; inp.value=''; commitText(t); renderPanel(); }
        if(ev&&ev.key==='Escape'){ panel.style.display='none'; }
      });
      inp.addEventListener('blur',()=>{ const t=inp.value; inp.value=''; commitText(t); panel.style.display='none'; });
      renderPanel();
      wrap.appendChild(inp); wrap.appendChild(panel);
      line2.appendChild(wrap);
    }
    row.appendChild(line2);
    /* 第三行：备注（可选） */
    const noteInp=document.createElement('input');
    noteInp.className='dshell-input';
    noteInp.placeholder='备注（可选）';
    noteInp.setAttribute('data-res-note', String(i));
    noteInp.value=w.note||'';
    noteInp.disabled=ro;
    noteInp.addEventListener('input',()=>{ w.note=noteInp.value; });
    row.appendChild(noteInp);
    list.appendChild(row);
  });
}
/* 保存预留：客户端校验（每段 start<end、至少 1 个用户，不合法 alert 指明哪段）→
   datetime-local 值经 new Date(v).toISOString() 转 UTC → PUT /reservations/<nodeId> {windows, base}。
   成功：响应 reservations 全量替换本地、重绘节点表与多选面板、toast；
   409：已被他人修改 → 刷新最新数据后重开弹窗；403：alert 服务端 message。 */
async function saveNodeResDialog(){
  const st=nodeResEdit;
  if(!st||st.readonly) return;   // 只读形态无保存入口（按钮已隐藏），此处兜底
  for(let i=0;i<st.windows.length;i++){
    const w=st.windows[i];
    const s=Date.parse(w.start), e=Date.parse(w.end);
    if(isNaN(s)||isNaN(e)||!(s<e)){ alert('第 '+(i+1)+' 个时段的开始/结束时间不合法：需填写完整且开始早于结束。'); return; }
    if(!Array.isArray(w.users)||!w.users.length){ alert('第 '+(i+1)+' 个时段至少需要选择 1 个用户。'); return; }
  }
  const windows=st.windows.map(w=>({start:new Date(w.start).toISOString(), end:new Date(w.end).toISOString(), users:w.users.slice(), note:String(w.note||'')}));
  const envId=st.envId;
  let resp, data=null;
  try{
    resp=await fetch('/api/worktable/pipeline/reservations/'+encodeURIComponent(envId),{
      method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({windows, base:st.base}),
    });
    try{ data=await resp.json(); }catch(e){}
  }catch(err){ alert('保存节点预留失败：'+String(err&&err.message||err)); return; }
  if(resp.status===409){
    alert('预留已被他人修改，已为您刷新最新数据');
    await loadNodeReservations();
    await openNodeResDialog(envId);   // 用最新数据重开弹窗（base 重新快照）
    return;
  }
  if(resp.status===403){ alert((data&&data.message)||'仅 admin 可分配节点。'); return; }
  if(!resp.ok){ alert('保存节点预留失败：'+((data&&(data.message||data.error))||('HTTP '+resp.status))); return; }
  if(data&&Array.isArray(data.reservations)) nodeReservations=data.reservations;
  closeNodeResDialog();
  if(typeof renderEnvs==='function') renderEnvs();
  if(typeof renderEnvOptions==='function') renderEnvOptions();
  if(typeof toast==='function') toast('✓ 节点预留已保存');
}
/* ---------- 节点预留结束 ---------- */
function saveGpuSession(){
  try{ sessionStorage.setItem(GPU_SESSION_KEY, JSON.stringify({initialized:true,status:gpuStatus})); }catch(e){}
}
/* 占用判定：关联到容器，或 nvidia-smi 显示有卡被用（宿主机直跑进程关联不到容器，不能按空闲显示） */
function gpuBusy(st){ return (st.containers||[]).length>0 || (Number(st.used)||0)>0; }
function gpuCellHtml(st){
  if(!st) return '<span class="dshell-muted">—</span>';
  if(st.error) return '<span style="color:var(--st-err)">查询失败</span>';
  const cs=st.containers||[];
  let main;
  if(cs.length) main='<b>'+esc(cs.slice(0,2).join('、'))+(cs.length>2?' 等':'')+'</b>';
  else if(gpuBusy(st)) main='<b style="color:var(--st-run)">占用</b>';
  else main='<span class="dshell-muted">空闲</span>';
  return main+'<div class="dshell-muted" style="font-size:10px;">'+(st.total==undefined?'?':st.total)+' 卡 · 已用 '+(st.used==undefined?'?':st.used)+'</div>';
}
async function fetchGpu(e){
  if(gpuRequests.has(e.id)) return gpuRequests.get(e.id);
  const job=new Promise(resolve=>{ gpuQueue.push({e,resolve}); });
  gpuRequests.set(e.id, job);
  drainGpuQueue();
  return job;
}
function drainGpuQueue(){
  while(gpuActive<2 && gpuQueue.length){
    const {e,resolve}=gpuQueue.shift(); gpuActive++;
    queryGpu(e).catch(err=>console.warn('[gpu]',err)).finally(()=>{
      gpuActive--; gpuRequests.delete(e.id); resolve(); drainGpuQueue();
    });
  }
}
async function queryGpu(e){
  const cell=document.querySelector('[data-gpu="'+e.id+'"]');
  if(cell) cell.innerHTML='<span class="dshell-muted">查询中…</span>';
  try{
    const r=await fetch('/api/worktable/gpu',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip:e.ip,user:e.user,pass:e.pass})});
    const j=await r.json();
    gpuStatus[e.id]=j;
  }catch(err){ gpuStatus[e.id]={error:String(err.message||err)}; }
  saveGpuSession();
  const c2=document.querySelector('[data-gpu="'+e.id+'"]');
  if(c2){ c2.innerHTML=gpuCellFull(e); bindGpuCell(c2, e); }
  renderEnvOptions();   // 主控环境多选面板同步显示 GPU 占用/总数
  if((envFilterText && envFilterText.trim()) || envSort.key==='gpu') renderEnvs();   // 筛选命中设备状态文本或按设备状态排序时同步刷新列表
}
