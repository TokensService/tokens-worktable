/* ===== 06-node-refresh.js · 刷新在途旋转反馈与节点信息手动刷新 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 3097–3212）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* ---------- 刷新按钮在途旋转反馈 ---------- */
/* 页面级「↻/⟳ 刷新」按钮（流水线任务/运行队列/运行历史/节点信息/设备状态）共用：操作在途期间
   给按钮挂 rf-busy，CSS 只旋转 .rf-ico 图标、不转文字；落定后摘除。最短展示 500ms，防快速请求
   下一闪而过看不见反馈；计数挂在按钮元素上，重叠在途（含最短展示尾窗内再次触发）只在全部落定后
   才摘除。无 classList 的调用环境（测试桩）静默跳过。 */
function beginRefreshSpin(btn){
  if(!btn || !btn.classList) return {stop(){}};
  btn._rfSpinN=(btn._rfSpinN||0)+1;
  if(btn._rfSpinN===1) btn.classList.add('rf-busy');
  const t0=Date.now(); let stopped=false;
  return { stop(){ if(stopped) return; stopped=true;
    setTimeout(()=>{
      btn._rfSpinN=Math.max(0,(btn._rfSpinN||0)-1);
      if(!btn._rfSpinN) btn.classList.remove('rf-busy');
    }, Math.max(0,500-(Date.now()-t0)));
  } };
}
/* 「⟳ 设备状态」：全部节点查询在途期间按钮禁用 + 图标旋转（逐节点 ⟳ 行内按钮不受影响，仍可单点） */
function refreshGpuAll(){
  const b=typeof $==='function'?$('gpuRefreshAll'):null; if(b) b.disabled=true;
  const sp=beginRefreshSpin(b);
  return Promise.all(environments.map(e=>fetchGpu(e))).finally(()=>{ if(b) b.disabled=false; sp.stop(); });
}
/* 设备详情弹层：完整状态 + 失败原因 */
function openGpuDetail(e){
  const st=gpuStatus[e.id];
  const body=$('gpuDetailBody'); if(!body) return;
  let h='<div style="margin-bottom:8px;"><b>'+esc(e.name)+'</b> <span class="dshell-muted">'+esc(e.ip)+'</span>'+(e.user?(' <span class="dshell-muted">· '+esc(e.user)+'</span>'):'')+'</div>';
  if(!st){ h+='<div class="dshell-muted">尚未查询，点 ⟳ 刷新。</div>'; }
  else if(st.error){
    h+='<div style="color:var(--st-err);font-weight:600;margin-bottom:6px;">查询失败</div>'
      +'<div class="logbox" style="max-height:220px;white-space:pre-wrap;">'+esc(st.error)+'</div>';
  } else {
    h+='<div style="margin-bottom:8px;">GPU 共 <b>'+st.total+'</b> 张，正在使用 <b>'+st.used+'</b> 张，空闲 <b>'+((st.total||0)-(st.used||0))+'</b> 张</div>';
    if(st.gpus && st.gpus.length){
      h+='<table class="dshell-table" style="margin-bottom:8px;"><thead><tr><th>GPU</th><th>利用率</th><th>显存(MiB)</th></tr></thead><tbody>';
      st.gpus.forEach(g=>{ h+='<tr><td>'+esc(g.index)+'</td><td>'+esc(g.util)+'%</td><td>'+esc(g.mem)+'</td></tr>'; });
      h+='</tbody></table>';
    }
    if(st.procs && st.procs.length){
      h+='<div class="dshell-muted" style="margin-bottom:4px;">占用进程 / 容器：</div>'
        +'<table class="dshell-table"><thead><tr><th>PID</th><th>GPU</th><th>进程</th><th>容器</th></tr></thead><tbody>';
      st.procs.forEach(p=>{ h+='<tr><td>'+esc(p.pid)+'</td><td class="dshell-muted" style="font-size:10px">'+esc((p.uuid||'').replace('GPU-','').slice(0,8))+'</td><td>'+esc(p.proc)+'</td><td>'+(p.container?('<b>'+esc(p.container)+'</b>'):'<span class="dshell-muted">—</span>')+'</td></tr>'; });
      h+='</tbody></table>';
    } else if(gpuBusy(st)) { h+='<div class="dshell-muted">有 '+(st.used||0)+' 张卡被占用，但未列出占用进程（可能为其他用户进程，查询权限不足）。</div>'; }
    else { h+='<div class="dshell-muted">当前无进程占用（全部空闲）</div>'; }
  }
  body.innerHTML=h;
  $('gpuDetail').style.display='flex';
}
function startEnvEdit(id){ const e=environments.find(x=>x.id===id); if(!e) return; envEditId=id; $('envName').value=e.name; $('envIp').value=e.ip; $('envNodeIp').value=e.nodeIp||''; $('envLlmAddr').value=e.llmAddr||''; $('envUser').value=e.user||''; $('envPass').value=e.pass||''; $('envAdd').textContent='保存'; $('envCancelEdit').style.display=''; }
function resetEnvForm(){ envEditId=null; $('envName').value=''; $('envIp').value=''; $('envNodeIp').value=''; $('envLlmAddr').value=''; $('envUser').value=''; $('envPass').value=''; $('envAdd').textContent='添加'; $('envCancelEdit').style.display='none'; }
function saveEnvForm(){
  if(!envConfigEditable()){ alert('节点环境仅 admin 用户可配置'); return; }   /* 兜底拦截：UI 已对非 admin 隐藏表单，防程序化直调（服务端 environmentsWriteDeny 同为硬门禁） */
  const name=$('envName').value.trim(); const ip=$('envIp').value.trim(); const nodeIp=$('envNodeIp').value.trim(); const llmAddr=$('envLlmAddr').value.trim(); const user=$('envUser').value.trim(); const pass=$('envPass').value;
  if(!ip){ alert('请填写 IP 地址'); return; }
  // 支持「IP:端口」（如 115.33.98.101:2222）：单个冒号时其后须为数字端口；多冒号（IPv6）或无冒号原样保留
  const cc=(ip.match(/:/g)||[]).length;
  if(cc===1 && !/^([^:]+):(\d+)$/.test(ip)){ alert('端口格式不正确：冒号后须为数字端口，如 115.33.98.101:2222'); return; }
  if(nodeIp && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(nodeIp)){ alert('内网 IP 必须是 IPv4 地址'); return; }
  // LLM服务地址（可选）：IPv4:端口，如 192.168.31.175:8000
  if(llmAddr && !/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(llmAddr)){ alert('LLM服务地址必须是 IPv4:端口 格式（如 192.168.31.175:8000）'); return; }
  if(envEditId){ const e=environments.find(x=>x.id===envEditId); if(e){ e.name=name||ip; e.ip=ip; e.nodeIp=nodeIp; e.llmAddr=llmAddr; e.user=user; e.pass=pass; } }
  else { environments.push({id:'env-'+Date.now().toString(36), name:name||ip, ip, nodeIp, llmAddr, user, pass}); }
  saveEnvs(); resetEnvForm(); renderEnvs(); renderEnvOptions();
}
function delEnv(id){ if(!envConfigEditable()){ alert('节点环境仅 admin 用户可配置'); return; } if(!confirm('删除该环境？')) return; environments=environments.filter(e=>e.id!==id); if(!environments.length){ environments=[{id:'env-1',name:'默认',ip:'127.0.0.1',user:'',pass:''}]; } saveEnvs(); renderEnvs(); renderEnvOptions(); }
/* 复制节点环境：拷贝名称/IP/内网IP/LLM服务地址/凭据生成不重名的「副本」，新 id 避免与源节点的设备状态缓存串号 */
function copyEnv(id){
  if(!envConfigEditable()){ alert('节点环境仅 admin 用户可配置'); return; }   /* 兜底拦截（UI 已对非 admin 隐藏入口） */
  const src=environments.find(x=>x.id===id); if(!src) return;
  const base=(src.name||'').replace(/（副本( \d+)?）$/,'');   /* 去掉已有副本后缀，避免链式累加 */
  const taken=new Set(environments.map(e=>e.name));
  let name=base+'（副本）';
  if(taken.has(name)){ let n=2; while(taken.has(base+'（副本 '+n+'）')) n++; name=base+'（副本 '+n+'）'; }
  const idx=environments.indexOf(src);
  environments.splice(idx+1, 0, {id:'env-'+Date.now().toString(36), name, ip:src.ip, nodeIp:src.nodeIp||'', llmAddr:src.llmAddr||'', user:src.user||'', pass:src.pass||''});
  saveEnvs(); renderEnvs(); renderEnvOptions();
}
function applyEnvCredAll(){
  // 把当前表单（添加/编辑区）里填写的用户名/密码应用到所有节点
  if(!envConfigEditable()){ alert('节点环境仅 admin 用户可配置'); return; }   /* 兜底拦截（UI 已对非 admin 隐藏表单区） */
  const u=$('envUser').value.trim(); const p=$('envPass').value;
  if(!u && !p){ alert('请先在上面的用户名/密码框里填写要统一设置的凭据'); return; }
  if(!environments.length){ alert('暂无节点'); return; }
  if(!confirm('将用户名「'+(u||'(空)')+'」/密码 应用到全部 '+environments.length+' 个节点？')) return;
  environments.forEach(e=>{ e.user=u; e.pass=p; });
  saveEnvs(); renderEnvs();
}
/* ---------- 节点信息手动刷新 ---------- */
/* 从服务端配置重拉节点环境列表（与「流水线任务」的「↻ 刷新」同一交互——不自动刷新，用户点按钮才拉取；
   只覆盖共享的节点环境定义，不动本页设备状态缓存与运行行临时选择）。环境列表与 loadServerState 同口径：
   服务端有非空 environments 即按 id 三方合并（mergeEnvironmentsFromServer——他端新增/修改/删除同步进来，
   本地未落盘的新增/修改不被这次手动刷新冲掉），并把基线 serverConfigBase.environments 推进到刚拉到的
   服务端快照（用户显式以服务端为准；不推进则下次保存按旧基线把刚同步进来的他端条目误报为本端改动），
   同步 localStorage 离线缓存后重渲染表格与多选面板。 */
async function refreshEnvsFromServer(){
  const b=$('envInfoRefresh'); if(b) b.disabled=true;
  const sp=beginRefreshSpin(b);
  try{
    const st=await fetchPipelineStateFresh();
    if(!st) throw new Error('服务端配置拉取失败');
    const cfg=(st.config && typeof st.config==='object' && !Array.isArray(st.config)) ? st.config : {};
    if(!Array.isArray(cfg.environments) || !cfg.environments.length) throw new Error('服务端暂无节点环境');
    const prevBase=(typeof serverConfigBase!=='undefined' && serverConfigBase && Array.isArray(serverConfigBase.environments)) ? serverConfigBase.environments : [];
    environments=mergeEnvironmentsFromServer(prevBase, environments, cfg.environments);
    if(typeof serverConfigBase!=='undefined' && serverConfigBase && typeof serverConfigBase==='object' && !Array.isArray(serverConfigBase)){
      serverConfigBase.environments=JSON.parse(JSON.stringify(cfg.environments));
    }
    try{ localStorage.setItem('pip-envs', JSON.stringify(environments)); }catch(e){}
    renderEnvs();
    renderEnvOptions();
    if(typeof toast==='function') toast('节点信息已刷新（'+environments.length+' 个节点）');
  }catch(e){ alert('刷新节点信息失败：'+String(e && e.message || e)); }
  finally{ if(b) b.disabled=false; sp.stop(); }
}
