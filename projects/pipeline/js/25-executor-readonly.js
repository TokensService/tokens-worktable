/* ===== 25-executor-readonly.js · 执行人固定取 dsh 登录用户（只读）等页面尾部逻辑 =====
   阶段一（函数声明）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 12088–12232）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* ---------- 执行人固定取 dsh 登录用户（只读） ---------- */
/* 「执行人」只读展示、不可编辑，每次加载都以 dsh-auth-gate 当前登录用户为准：
   /auth/status 是同源探针、只认会话 cookie；不做任何本地/服务端持久化恢复（共享配置曾把
   历史记录作者长期错署为执行人）。token 共享模式（username 恒 null）、未装认证插件
   （SPA 兜底非 JSON）、未登录或探测失败时留空，运行的必填校验按「未获取到登录用户」拦截。 */
async function fillExecutorFromAuth(){
  let username='';
  try{
  try{
    const res=await fetch('/auth/status');
    if(!res || !res.ok) return;
    const data=await res.json();
    if(data && data.authenticated && typeof data.username==='string') username=data.username.trim();
  }catch(e){ return; }
  if(!username) return;
  currentUsername=username;   // 缓存当前登录用户，供流水线署名与默认筛选「我的」取用
  const el=$('triggeredBy');   // 右上角纯文本展示（span）：探测成功即更新为登录用户名
  if(el) el.textContent=username;
  /* 探测 admin 角色：/auth/users 由 dsh-auth-gate-wt-admin-role 注册（password 模式专属），
     GET 对任意会话开放，返回 {users:[{username,admin,current,...}]}。未装该插件 / token 模式
     → 404 或非 JSON，currentUserIsAdmin 维持 false（currentUsername 为空时 canControlRun
     退化为全权，故 token 模式不受限）。失败不阻断主流程。 */
  try{
    const ru=await fetch('/auth/users');
    if(ru && ru.ok){
      const ud=await ru.json();
      if(ud && Array.isArray(ud.users)){
        const me=ud.users.find(u=>u && u.current===true);
        if(me && me.admin===true) currentUserIsAdmin=true;
      }
    }
  }catch(e){ /* admin 探测失败：按非 admin 退化，不影响其他功能 */ }
  /* admin 角色可能晚于队列渲染到达——拿到后重绘队列按钮（中止/取消按权限显隐） */
  if(typeof renderQueue==='function') renderQueue();
  }finally{
    /* 无论探测成功/失败/提前返回，结束时都置位 authReady 并无条件重绘流水线任务列表：
       行按钮「编辑/查看/删除」与编辑器只读归属判断（plEditable）都依赖身份——探测在途时
       署名流水线保守只读，探测结束后必须重绘刷新（原先仅在「我的/仅看收藏」筛选时重绘，
       已并入此无条件重绘；「我的」筛选初次加载按「内置+未署名」退化渲染，身份到达后由
       本次重绘纠正）。节点预留的选择拦截（envReservedForOthers：探测在途不拦、admin 旁路）
       同样依赖身份，节点表「预留」列与环境多选面板一并重绘纠正。typeof 守卫：独立测试片段里可能没有这些全局。 */
    authReady=true;
    /* 节点配置门禁：身份到达后按 admin/非 admin 切换节点编辑区显隐，非 admin 并把本地节点列表对齐服务端基线 */
    if(typeof applyEnvAdminGate==='function') applyEnvAdminGate();
    if(typeof renderPipelines==='function') renderPipelines();
    if(typeof renderEnvs==='function') renderEnvs();
    if(typeof renderEnvOptions==='function') renderEnvOptions();
  }
}
/* ---------- 执行人固定取 dsh 登录用户（只读）结束 ---------- */

/* 初始化：renderAll 只做纯 DOM 渲染；全环境 GPU 查询（每个环境一次慢 SSH+nvidia-smi，ConnectTimeout 最坏 8s）
   剥离到首屏之后且只触发一次——原先 renderAll 在首屏同步调用 + loadServerState 成功后重渲染再调用，会发起两轮
   全环境 GPU 查询，浏览器同源 6 路并发限制下排队，首屏长时间卡在「查询中…」。改为首屏后延迟单次刷新 */
function renderAll(){
  applyTheme();
  resetNodes();
  loadScripts();
  renderHistory();
  renderStats();
  renderPipelines();
  renderEnvOptions();
  renderEnvs();
  renderRepoOptions();
  renderRepos();
  renderQueue();
  renderDetail();
  renderPresetMultiBtn();
  fillCfgForm();
  renderScriptsDirCfg();
  applyJenkinsForm();
  applyEvaltokForm();
  applyPromForm();
}
function scheduleGpuRefresh(){
  if(_gpuInited) return;
  _gpuInited=true;
  const kick=()=>{ saveGpuSession(); refreshGpuAll(); };
  if('requestIdleCallback' in window) requestIdleCallback(kick,{timeout:1500});
  else setTimeout(kick,200);
}
function startQueuePolling(){
  if(_queuePollTimer!==null) return;
  _queuePollTimer=setInterval(()=>{ if(document.hidden===true) return; pullRemoteQueue(); },QUEUE_POLL_MS);
}
function stopQueuePolling(){
  if(_queuePollTimer===null) return;
  clearInterval(_queuePollTimer); _queuePollTimer=null;
}
function syncQueuePolling(){
  if(document.hidden===true){ stopQueuePolling(); return; }
  pullRemoteQueue();   // 恢复可见：立即补拉一次，随后恢复周期拉取
  startQueuePolling();
}
