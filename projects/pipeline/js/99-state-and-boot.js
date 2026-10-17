/* ===== 99-state-and-boot.js · 页面状态与引导：全部非函数顶层语句（状态 let/const、事件绑定、启动渲染），严格按原脚本先后顺序 =====
   阶段二（状态与引导）。由 pipeline.html 原内联脚本按顶层语句拆出，未改写任何一行代码
   （原行范围 1015–12249）。
   classic script（非 ES module）：与其余分片共享同一全局作用域。
   两阶段约束：阶段一各文件只放 function 声明（加载即定义、不执行），阶段二只放其余顶层语句并保持原序——
   页面引导期会调用散布在各域的函数，单脚本靠整体提升成立，拆分后必须让全部声明先于任何执行代码加载。 */
/* ===== [state:S00] ===== */
const K8S_STAGES = [
  {id:'checkout',name:'检出',dur:5,sub:[]},
  {id:'validate',name:'校验',dur:9,sub:['代码检查','测试']},
  {id:'approval',name:'审批',dur:0,skip:true,prodOnly:true,sub:[]},
  {id:'build',name:'构建镜像',dur:13,sub:[]},
  {id:'push',name:'推送镜像',dur:6,sub:[]},
  {id:'deploy',name:'部署到 K8s',dur:10,sub:[]},
  {id:'health',name:'健康检查',dur:7,sub:[]},
];
const CI_STAGES = [
  {id:'checkout',name:'检出',dur:5,sub:[]},
  {id:'validate',name:'校验',dur:9,sub:['代码检查','测试']},
  {id:'build',name:'构建镜像',dur:12,sub:[]},
];
const CANARY_STAGES = [
  {id:'deploy',name:'部署到 K8s',dur:10,sub:[]},
  {id:'health',name:'健康检查',dur:7,sub:[]},
];
/* 默认「安装部署XDS」流水线（模型部署六步） */
const XDS_STAGES = [
  {id:'pull',name:'拉取镜像',dur:8,sub:[]},
  {id:'rendercfg',name:'模型部署配置渲染',dur:4,sub:[]},
  {id:'deploymodel',name:'部署模型',dur:12,sub:[]},
  {id:'register',name:'注册模型',dur:5,sub:[]},
  {id:'modelhealth',name:'模型健康检查',dur:6,sub:[]},
  {id:'modeltest',name:'测试',dur:8,sub:[]},
];
/* 内置「部署vLLM（原生P/D）」流水线：按 native_vllm_deployment_from_xds.md 第 12 节配方
   （vLLM 代码基线 TokensService/vllm 分支 v0.30.0.tokens），以原生 vLLM（VLLM_PLUGINS=""
   关闭 XDS 补丁）把模型部署为 Prefill(TP×PP) + Decode(TP×DP) + Mooncake Proxy 的 P/D 分离
   拓扑；阶段绑定 scripts/vllm-native-*.sh（种子 path 留空，loadScripts 后由
   rebindBuiltinScriptPaths 按名回填当前 scripts 目录的真实路径）。阶段参数值约定：
   部署/验证参数全部走脚本 :- 默认值（页面可覆盖）；仅 VLLM_ROLE 在阶段上显式区分。
   DEPLOY_MODE=standalone 时只部署 Prefill 基线，Decode/Proxy 阶段自动跳过。
   预设任务默认全不勾选（defaults.presets=[]）：本流水线的清理由 vllm-native-cleanup.sh
   承担（可按需绑为阶段或设置页清理脚本），不套用 XDS 的 cleanup-env.sh。 */
const VLLM_NATIVE_STAGES = [
  {id:'vlcheck',name:'vLLM环境检查',dur:0,sub:[],kind:'shell',timeout:600,
   script:{name:'vllm-native-check.sh',path:'',lang:'sh',params:[],values:{},outVars:''}},
  {id:'vlprepare',name:'vLLM节点准备',dur:0,sub:[],kind:'shell',timeout:600,
   script:{name:'vllm-native-prepare.sh',path:'',lang:'sh',params:[],values:{},outVars:''}},
  {id:'vlprefill',name:'部署Prefill(PP)',dur:0,sub:[],kind:'shell',timeout:900,
   script:{name:'vllm-native-deploy.sh',path:'',lang:'sh',params:[{kind:'env',key:'VLLM_ROLE',label:'部署角色',def:'',required:true}],values:{VLLM_ROLE:'prefill'},outVars:''}},
  {id:'vldecode',name:'部署Decode(DP)',dur:0,sub:[],kind:'shell',timeout:900,
   script:{name:'vllm-native-deploy.sh',path:'',lang:'sh',params:[{kind:'env',key:'VLLM_ROLE',label:'部署角色',def:'',required:true}],values:{VLLM_ROLE:'decode'},outVars:''}},
  {id:'vlwait',name:'等待服务就绪',dur:0,sub:[],kind:'shell',timeout:2700,
   script:{name:'vllm-native-wait.sh',path:'',lang:'sh',params:[],values:{},outVars:''}},
  {id:'vlproxy',name:'重建PD-Proxy',dur:0,sub:[],kind:'shell',timeout:600,
   script:{name:'vllm-native-deploy.sh',path:'',lang:'sh',params:[{kind:'env',key:'VLLM_ROLE',label:'部署角色',def:'',required:true}],values:{VLLM_ROLE:'proxy'},outVars:''}},
  {id:'vlverify',name:'P/D联调验证',dur:0,sub:[],kind:'shell',timeout:900,
   script:{name:'vllm-native-verify.sh',path:'',lang:'sh',params:[],values:{},outVars:''}},
];
// 每阶段真实日志模板（按阶段 id 匹配；自定义阶段走通用日志）
const LOGS = {
  checkout: [
    "[Pipeline] stage { (检出)",
    "代码仓: {{giturl}}",
    "git clone --branch {{branch}} {{giturl}}",
    "Cloning into 'myapp'…",
    "构建来源: {{branch}}@{{commit}}",
    "触发者: {{by}}",
    "目标镜像: {{registry}}/{{image}}:{{tag}}",
    "[Pipeline] }",
  ],
  validate: [
    "[Pipeline] stage { (校验)",
    "[Pipeline] { (代码检查)  ← 并行",
    "docker run --rm myapp-lint:latest --check",
    "✓ 代码检查通过 (12 项检查)",
    "[Pipeline] { (测试)  ← 并行",
    "pytest -q --maxfail=1",
    "..........  10 passed in 3.21s",
    "✓ 全部测试通过",
    "[Pipeline] }",
  ],
  approval: [
    "[Pipeline] stage { (审批)",
    "✓ 审批通过，继续发布 {{registry}}/{{image}}:{{tag}} -> {{env}}",
  ],
  build: [
    "[Pipeline] stage { (构建镜像)",
    "docker build \\",
    "  --label org.opencontainers.image.revision={{commit}} \\",
    "  --label org.opencontainers.image.source={{giturl}} \\",
    "  -t {{registry}}/{{image}}:{{tag}} .",
    "[+] Building 42.3s (12/12) FINISHED",
    " => exporting layers   => writing image",
    "✓ 镜像构建完成",
    "[Pipeline] }",
  ],
  push: [
    "[Pipeline] stage { (推送镜像)",
    "docker login {{registry}} -u $username -p ********",
    "The push refers to repository [{{registry}}/{{image}}]",
    "abc123f: Pushed",
    "✓ 推送完成",
    "docker logout {{registry}}",
    "[Pipeline] }",
  ],
  deploy: [
    "[Pipeline] stage { (部署到 K8s)",
    "helm upgrade --install {{release}} ./deploy/helm/myapp \\",
    "  --atomic --wait --namespace {{env}} \\",
    "  --set image.repository={{registry}}/{{image}} \\",
    "  --set image.tag={{tag}}",
    'Release "{{release}}" has been upgraded.',
    "✓ 已部署到 {{env}}/{{release}}",
    "[Pipeline] }",
  ],
  health: [
    "[Pipeline] stage { (健康检查)",
    "kubectl -n {{env}} rollout status deployment/{{release}} --timeout=180s",
  ],
  rollback: [
    "[Pipeline] post-failure { (自动回滚)",
    "helm history {{release}} --namespace {{env}} --max 5",
    "helm rollback {{release}} 0 --namespace {{env}} --wait --timeout 5m",
    "Rollback was a success.",
    "↩ 已回滚到上一版本",
    "[Pipeline] }",
  ],
};
/* ===== [state:S01] ===== */
/* localStorage 仍保留作离线缓存；服务端不可达时行为与原来一致。 */
let stateLoaded=false;   // loadServerState 成功后才允许 PUT，避免启动时用本地默认值覆盖服务端数据
let serverConfigBase=loadServerBaseLS();
/* 基线纪元：每次基线随「保存确认 / 新鲜快照应用」前进 +1。GET 快照若在「请求发出后、应用前」被一次
   基线前进反超（典型：复制副本的 save-one 先落盘并推进基线，首屏 GET 才带着落盘前的快照返回），
   按过期快照合并会把刚落盘的条目误判为「远端已删除」（基线有、远端无、本地==基线 → 随远端删除），
   副本从页面消失且基线被污染成「无此条目」——之后该条目每次 save-one 都 phantom 409
   （baseOne=null ≠ 磁盘条目）。loadServerState/手动刷新据此识别过期快照并重拉（fetchPipelineStateFresh）。 */
let stateFetchEpoch=0;
let persistTimer=null;
/* 同一页面内串行 PUT 的互斥锁链尾（Promise 链，见 pushState/pushPipelineOne 头部）：后一次必须基于前一次
   服务端确认后的新基线。旧写法 while(persistInFlight) await persistInFlight 是 check-then-set——两个并发
   等待者会在前序释放后同时通过检查、同进临界区（后进入者覆盖先进入者的锁 Promise），串行化失效 */
let persistInFlight=null;
/* 旧版本地配置键快照（页面启动时记录，此刻 localStorage 尚未被本页离线缓存回写）：供 loadServerState
   判定迁移条件——服务端缺某新键且启动时本地有对应旧值，才保留本地值并回推。不能用加载过程中的 LS 实时读：
   本页同步块会把应用后的值写回 LS，二次重拉会把「自己刚写的缓存」误判成「本地有旧值」而重复回推。 */
const legacyLocalKeys=(function(){ const m={}; try{ ['pip-schedEnvSel','pip-histFilter','pip-plFilter','pip-histPageSize','pip-plPageSize'].forEach(k=>{ m[k]=localStorage.getItem(k)!==null; }); }catch(e){} return m; })();
/* 历史上行签名：内容自上次确认同步后未变时，保存不再携带历史正文（服务端合并按磁盘保留），
   慢上行链路下「保存中…」不再为重复历史买单。双哈希降碰撞概率；空串初值保证首次保存必带历史
   （服务端为空时的本地迁移依赖它，见 loadServerState 末尾 persistState）。 */
let historySyncSig='';
let _migratedPersistDone=false;   // schema 迁移回推会话闩锁（见 loadServerState finally）：与 _migrateInlineLogsDone 同理断 403 死循环
/* 存量迁移：旧版记录内嵌的 logs 全文 → 补齐归档文件夹里对应的任务日志文件后改存 logFile 引用。
   已有同名文件不覆盖（归档文件才是全量实体，内嵌可能是旧版截断版）；归档目录不可读/写失败时保持内嵌。
   迁移完成后 persistState 一次，把引用形态推上服务端 */
let _migrateInlineLogsDone=false;   // 存量迁移会话闩锁（见 migrateInlineLogs 内说明）：断非 admin 看可信流水线时 migrate→persist→403→重拉 的死循环
/* ===== [state:S02] ===== */
/* 内置流水线注册表：固定 id + 种子工厂。登记即获得「内置置顶、服务端/本地存储版优先、
   不可删除、仅 admin 可编辑」语义；服务端按同一 id 集合保护（src/index.ts BUILTIN_PIPELINE_IDS）。
   DEFAULT_PIPELINE_ID 保留为首条内置 id（历史引用/兼容）。 */
const DEFAULT_PIPELINE_ID='pl-xds';
const BUILTIN_VLLM_PIPELINE_ID='pl-vllm-native';
const BUILTIN_PIPELINE_DEFS=[
  {id:DEFAULT_PIPELINE_ID, name:'安装部署XDS', stages:function(){ return XDS_STAGES.map(s=>({...s})); }},
  {id:BUILTIN_VLLM_PIPELINE_ID, name:'部署vLLM（原生P/D）', stages:function(){ return VLLM_NATIVE_STAGES.map(s=>JSON.parse(JSON.stringify(s))); }, defaults:{branch:'v0.30.0.tokens',presets:[]}},
];
/* ===== [state:S05] ===== */
let customPresets=(function(){ try{ const list=normalizeCustomPresets(JSON.parse(localStorage.getItem('pip-customPresets'))); list.forEach(c=>{ if(c.script && c.script.values) c.script.values=cleanScriptValues(c.script.params, c.script.values); }); return list; }catch(e){ return []; } })();
/* ===== [state:S06] ===== */
/* 预设任务定义：系统预设（环境清理/环境检查/Profiling）固定内置 + 设置页「预设任务设置」添加的自定义预设
   （customPresets），统一经 presetDefOf 取定义。顺序位置存进流水线阶段列表（preset 标记行，在流水线编辑器中
   可排序，见 openPlForm/savePlForm）；运行时按主控「预设任务」勾选展开为执行项（脚本取设置页当前配置快照，
   见 expandRunStages）。block=true 的预设任务失败会阻断后续阶段 */
const PRESET_DEF={
  cleanup:{id:'__cleanup__', el:'cleanupEnv', name:'环境清理', script:()=>cleanupScript, block:false, noScript:'未配置环境清理脚本'},
  check:{id:'__check__', el:'checkEnv', name:'环境检查', script:()=>checkScript, block:true, noScript:'未配置环境检查脚本'},
  profiling:{id:'__profiling__', el:'profilingEnv', name:'Profiling', script:()=>profilingScript, block:false, noScript:'未配置 Profiling 脚本'},
};
const PRESET_ORDER=['cleanup','check','profiling'];   // 系统预设默认位置顺序：清理/检查在最前，Profiling 在最后（自定义预设默认位置见其 pos 配置）
/* 名称 → pkey（系统 + 自定义）：savePlForm 拦同名阶段、日志回放/归档序号识别预设任务用；
   customPresets 任何变更后经 rebuildPresetNameMap 原地重建（保持对象引用） */
const PRESET_BY_NAME={};
rebuildPresetNameMap();

const PIPELINE_DEFAULT_PRESET_KEYS=['cleanup','check','profiling'];
/* ===== [state:S08] ===== */
let pipelineRunDialogPipelineId='';
let pipelineRunDialogEnvIds=[];
/* ===== [state:S10] ===== */
let pipelineApiCur=null;   // 弹窗当前展示的调用规范（{endpoint,body}，showPipelineApi 打开时冻结）：「直接调用」按展示内容原样发起
/* ===== [state:S11] ===== */
/* 普罗数据采集的默认 model/namespace 取值（任务级采集与「📊 收集普罗数据」手动补采共用）：
   modelName 默认 ${MODEL_PATH}（按上游 deploy 阶段产出的 MODEL_PATH 解析），
   xdsNamespace 默认 ${DEPLOY_STRATEGY}-${BY}（按当前部署策略与执行人解析），采集时点经 substRunVars 解析。 */
const DEFAULT_PIPELINE_PROM = { modelName:'${MODEL_PATH}', xdsNamespace:'${DEPLOY_STRATEGY}-${BY}' };
let pipelines = loadPipelines();
let curPipelineId = lsGet('pip-curPipeline', pipelines[0].id);
let runStages = null; // 运行期间快照；null 时用当前流水线
/* ===== [state:S12] ===== */
let environments = loadEnvs() || [
  {id:'env-dev', name:'开发', ip:'192.168.1.10', user:'root', pass:''},
  {id:'env-prod', name:'生产', ip:'192.168.1.20', user:'root', pass:''},
];
/* 环境多选（主控，可选多个目标 IP；默认不选择任何节点——不选即按无目标节点运行，排队按同机串行处理） */
let selectedEnvIds = (function(){ try{ const a=JSON.parse(localStorage.getItem('pip-envSel')); return Array.isArray(a)?a:null; }catch(e){ return null; } })();
/* 环境多选面板搜索词 / 已选节点排序状态（按面板实例隔离：主控 / 定时 / 默认环境 / 运行弹窗各自独立） */
const envMultiSearch={};
const envMultiSelSort={};   // panelId -> {key:'name'|'ip'|'gpu'|null, dir:1|-1}
/* 候选列表筛选状态（按面板实例隔离）：panelId -> {avail:仅「预留给我 / 未分配」, gpuIdle:仅「GPU 空闲」}；
   与搜索词同为会话内状态，不持久化，刷新页面即复位 */
const envMultiListFilter={};
let envEditId=null;
let envFilterText='';
/* 节点排序：点击表头切换 升序 → 降序 → 取消（恢复原始顺序） */
let envSort={key:null, dir:1};
/* ===== [state:S13] ===== */
/* 预留数据存服务端独立存储（/api/worktable/pipeline/reservations），不进 environments 条目、
   不随共享配置上送/下拉、不进「导入导出」配置文件——故 normalizeEnv/sameEnvEntry/三方合并均不涉及。
   记录形态：{id,nodeId,users,start,end,note,createdBy,createdAt,updatedAt}，start/end 为 ISO UTC 字符串。 */
let nodeReservations=[];   // 服务端全量预留记录；拉取失败静默保留旧值
let authUsersCache=null;   // /auth/users 用户名候选缓存（预留弹窗）；拉取失败保持 null，候选回退为「现有预留用户名并集 + 当前用户名」
let nodeResEdit=null;      // 预留弹窗编辑态：{envId, base, windows, readonly}；base=打开时该节点窗口快照（保存上送供服务端 409 比对）
/* ===== [state:S14] ===== */
/* 节点设备状态查询（经插件 /api/worktable/gpu；本机直连，远程走 ssh） */
const GPU_SESSION_KEY='pip-gpu-session-v1';
const gpuSession=(function(){
  try{ const s=JSON.parse(sessionStorage.getItem(GPU_SESSION_KEY)||'null'); if(s && typeof s==='object') return s; }catch(e){}
  return {};
})();
let gpuStatus=gpuSession.status && typeof gpuSession.status==='object' ? gpuSession.status : {};
/* 慢节点探测最多占两个同源连接，给执行流、配置和归档留出连接；重复刷新复用在途任务。 */
const gpuRequests=new Map(), gpuQueue=[];
let gpuActive=0;
/* ===== [state:S17] ===== */
/* 演示种子（myapp）只服务「服务端与本地缓存都没有代码仓」的首次体验：标记种子态，loadServerState
   拉到服务端非空代码仓时丢弃种子——否则新浏览器/清缓存后的首次保存会把演示仓库当本地新增推上
   团队共享的服务端配置（myapp 一度被写进 worktable-pipeline.json 并同步进所有人的列表）。 */
const cachedReposAtBoot=loadRepos();
let reposSeededByDefault = !cachedReposAtBoot;
let repositories = cachedReposAtBoot || [
  {id:'repo-1', name:'myapp', url:'https://git.example.com/dev/myapp.git', user:'', pass:'', fetchMode:'server'},
];
let curRepoId = lsGet('pip-curRepo', repositories[0].id);
let repoEditId=null;
/* 代码仓联通性检测 + 远程分支/Tag 列举：fetchMode='server'(默认)→/api/worktable/git-remote(git ls-remote)；'browser'→直连 /info/refs 解析 smart-HTTP（需服务器开 CORS）；'jenkins-browser'/'jenkins-server'→经配置的 Jenkins 多分支任务子任务名（浏览器直连 / 服务端代连） */
let repoBranches={};   // repoId -> {branches:[], tags:[], error:'', loading?}
/* ===== [state:S18] ===== */
/* URL 模式：仓库可配置 strategyUrl（{branch} 为分支占位符，如 http://127.0.0.1:18080/api/xds/archs/latest?code_refs={branch}）；
   返回分页 JSON {total,offset,limit,next_offset,items:[{arch_name}]}（arch_name 缺省时回退 name），跟 next_offset 逐页拉全。
   浏览器直连失败（多为 CORS 拦截或网络不可达）时自动改经 /api/worktable/proxy 由 DSH 服务端代取（仅允许回环/内网目标）。
   脚本模式：仓库可配置 strategyScript（scripts 目录中的脚本名），按分支经 /api/worktable/exec 执行
   （注入 GIT_BRANCH 当前分支与 GIT_URL/GIT_USER/GIT_PASSWORD 仓库凭据），stdout 每行一个策略名，非零退出视为失败。 */
let deployStrategies={};   // deployStrategyKey(repo,branch) -> {items:[], error:'', loading?}
/* ===== [state:S19] ===== */
let scriptsDir = (function(){ try{ return localStorage.getItem('pip-scriptsDir')||null; }catch(e){ return null; } })() || detectScriptsDir();
/* 脚本目录来源标记：true=当前值未经任何设置配置（localStorage/服务端设置文件都没有），
   允许安装默认路径（/api/worktable/health 的 dir 解析）到达后升级为安装后 scripts 路径 */
let scriptsDirIsFallback = !(function(){ try{ return localStorage.getItem('pip-scriptsDir')||null; }catch(e){ return null; } })();
let installedScriptsDir = null;   // 插件安装后的 scripts 绝对路径：<health.dir>/projects/pipeline/scripts
/* 归档根目录：留空=保底写到 scripts 同级 runs/（见 fallbackArchiveRoot）；归档按「流水线名称_年月日时分秒」文件夹组织（见 archiveRun） */
let archiveDir = lsGet('pip-archiveDir', '/var/log/op_test');
/* 归档脚本：归档写入日志/profiling 后执行（可选），收集额外日志；默认 scripts/collect_logs.sh，留空=不执行，脚本缺失自动跳过（见 archiveRun） */
let archiveScriptName = lsGet('pip-archiveScript', 'collect_logs.sh');
/* ===== [state:S20] ===== */
const DEFAULT_JENKINS = { url:'http://127.0.0.1:28080', linkUrl:'', user:'', token:'', mode:'local' };
let jenkins = loadJenkins();
/* ===== [state:S21] ===== */
const DEFAULT_EVALTOK = { url:'http://1.95.87.43:9000', linkUrl:'', token:'', mode:'local' };
let evaltok = loadEvaltok();
/* ===== [state:S22] ===== */
const DEFAULT_PROM = { url:'http://192.168.10.6:25889', linkUrl:'', mode:'local', collectScript:'' };
let prom = loadProm();
/* ===== [state:S24] ===== */
let cleanupScript=(function(){ try{ const cs=JSON.parse(localStorage.getItem('pip-cleanupScript')); if(cs && cs.values) cs.values=cleanScriptValues(cs.params, cs.values); return cs; }catch(e){ return null; } })() || null;
/* ===== [state:S25] ===== */
/* 状态与参数表单逻辑与环境清理脚本完全同构（识别默认值仅展示、显式值才下发，见 renderCleanupParams），仅存储键与 DOM id 不同 */
let checkScript=(function(){ try{ const cs=JSON.parse(localStorage.getItem('pip-checkScript')); if(cs && cs.values) cs.values=cleanScriptValues(cs.params, cs.values); return cs; }catch(e){ return null; } })() || null;
/* ===== [state:S26] ===== */
/* 状态与参数表单逻辑与环境清理脚本完全同构（识别默认值仅展示、显式值才下发，见 renderCleanupParams），仅存储键与 DOM id 不同 */
let profilingScript=(function(){ try{ const cs=JSON.parse(localStorage.getItem('pip-profilingScript')); if(cs && cs.values) cs.values=cleanScriptValues(cs.params, cs.values); return cs; }catch(e){ return null; } })() || null;
/* ===== [state:S27] ===== */
let availableScripts=[];   // [{name, path}]
/* Jenkins 任务列表（设置页「获取任务列表」后填充；供「代码仓」分支获取=Jenkins 时选择多分支任务） */
let availableJenkinsJobs=[];   // [{name: fullName}]
/* ===== [state:S28] ===== */
let editStages=[];   // [{id,name,dur,skip,sub,kind,script|null,url|null,sched|null}]
const STAGE_KIND_LABEL={simulate:'模拟',shell:'Shell',python:'Python',http:'HTTP',evaltokens:'EvalTokens'};
let stageDragFrom=-1;
/* 编辑器任务卡选中：editSelStage 以对象引用记录选中卡（拖拽/序号/上下移调序后仍跟随同一张卡；删除选中卡时清空；
   打开编辑器重建草稿时重置，见 openPlForm）。选中卡高亮并在上/下边框中点显示「+」插入按钮；
   选中刷新只原地切换 class 与按钮（不重渲染，不打断卡内输入）。 */
let editSelStage=null;
/* ===== [state:S31] ===== */
let nodes = {};
let selectedId = curPipeline().stages[0].id;
let running = false;   // 派生态：activeRuns.length>0，由 syncRunState 维护（勿直接赋值）
/* 运行编号计数器：从 0 起，首个真实运行即 #1（演示数据仅占界面示例、不入服务端编号空间；
   此前初始化为 47 会让真实历史从 #48 开始，看起来像丢了 #1–47）。服务端已有更高编号时
   loadServerState/历史刷新会按双方较大值回填，不会重号。 */
let buildNo = 0;
/* 历史清空时间戳：「清空」时记录，随 config 持久化；服务端 PUT 合并历史时以此区分「页面不知道的磁盘记录」
   与「已被清空的磁盘记录」（清空时间点之前的不再复活），加载时空历史 + 有清空标记则不复活演示数据 */
let histClearedAt = 0;
/* 内置演示数据（demo:true）：仅作首次打开时的界面示例——不推送到服务端、不计入统计，「清空」可一并移除 */
let history = [
  { no:46, pipeline:'K8s 应用安装', env:'prod',    commit:'9f2a1c0', status:'success', dur:'1m52s', time:'今天 09:14', by:'release-manager', demo:true },
  { no:45, pipeline:'CI 构建测试', env:'staging', commit:'3b7e8d2', status:'success', dur:'58s',   time:'昨天 22:07', by:'GitHub Push', demo:true },
  { no:44, pipeline:'K8s 应用安装', env:'prod',    commit:'3b7e2d2', status:'failed',  dur:'2m10s', time:'昨天 21:40', by:'release-manager', demo:true },
  { no:43, pipeline:'灰度发布',     env:'dev',     commit:'7c1d5af', status:'success', dur:'41s',   time:'昨天 18:33', by:'dev-li', demo:true },
];
let curRun = null;
/* 运行令牌：每次启动新运行递增；在途异步（脚本/清理）回来后比对，
   防止已中止运行的迟回结果污染下一次运行（中止无法真正中断已发出的脚本） */
let runSeq = 0;
/* 在跑运行集合 + 编排区焦点运行。viewRc 可指向已结束（over=true）的运行：结束后编排/详情
   保持该次运行结果视图（失败阶段可「从本阶段重试」），直到用户切换查看其他运行/历史回放/新运行启动 */
let activeRuns = [];
let viewRc = null;

const $ = id => document.getElementById(id);
const REGISTRY = 'registry.example.com';
const GITURL = 'https://git.example.com/dev/myapp';
const DEFAULT_IMAGE = 'myapp';   // 镜像名已不在主控填写，内部固定默认值（日志/详情/IMAGE_NAME 注入沿用）
/* ===== [state:S33] ===== */
let flowDragFromId=null;
/* ===== [state:S34] ===== */
/* 增量渲染：按内容指纹缓存，未变化时仅更新进度条宽度（流式回显节流与阶段状态变迁会高频调用本函数；
   运行进度 tick 不再走这里，改由共享 tick 直改进度条，见 stageTickPaint） */
let _detailKey='';
const DETAIL_LOG_LIMIT={maxLines:1000,maxChars:256*1024};
/* 日志区增量渲染缓存：上一次同步进 #detailLog 的行数组。日志增长时只做尾部追加 /
   头部淘汰等增量 DOM 操作，不再每次刷新 innerHTML 全量重建上千个行节点
   （全量重建引发整个日志区重排，是持续输出时页面 CPU 的主要来源）。 */
let _detailLogCache=null;
/* ===== [state:S35] ===== */
const QUEUE_CAP = 16;          // 本地等待上限：queue + 租约申请在途项合计，给被拒租约保留回队名额
const MAX_ACTIVE_RUNS = 4;   // 浏览器单标签页全局槽位：避免不同机器的大日志任务同时把 CPU/内存/连接打满
let queue = [];
/* 「排队中」徽标点击展开/收起排队原因（按条目 id 记忆展开态，重绘保留；条目出队后由 cancelQueue 清理） */
const queueReasonOpen=new Set();
/* ===== [state:S36] ===== */
/* 页内调度（machineConflict/drainQueue）只管本标签页；租约把「同一节点同一时间只跑一条流水线」
   扩到跨标签页/跨浏览器与服务端 API/定时计划：startRun 申请成功才开跑并周期续租，finish/中止/
   重置释放，服务端 TTL 90s 兜底页面崩溃未释放。服务端不可达（旧插件无此路由）时降级为仅页内互斥。 */
const NODE_LEASE_PATH='/api/worktable/pipeline/leases';
const NODE_LEASE_RENEW_MS=25000;   // 服务端 TTL 90s，25s 续租容忍几次丢失
const NODE_WAIT_RETRY_MS=5000;     // 租约被占用时回队重试间隔（drainQueue 到点重发申请）
const pendingLeaseStarts=[];       // 租约申请在途的启动：占调度槽位、参与机器冲突判定（见 conflictsActive/runPipeline）

/* 手动提交服务端运行后的自动跟随：提交响应的 runId 出现在服务端权威快照（排队或在跑）时，把编排区/
   阶段详情切到该次运行（只读预览；排队→在跑由 refreshRemoteQueuePreviewRc 平滑跟随）。快照每秒轮询
   才刷新，runId 未出现前跨轮询等待；超时自动放弃，不抢占用户后续手动切换的视图。 */
const SERVER_RUN_FOCUS_MS=15000;
let pendingServerRunFocus=null;   // {runId, until}
/* ===== [state:S37] ===== */
/* 新页面只向服务端提交运行参数，执行池及任务生命周期都由服务端持有；页面关闭不终止任务。
   GET /api/worktable/pipeline/queue 每秒返回服务端权威快照，同时保留旧页面的在场快照兼容展示。 */
const QCLIENT_ID=(function(){
  /* 同标签页内刷新/重开保持同一 id（避免刷新瞬间旧 id 未过期 + 新 id 入场造成短暂双份在场）；
     sessionStorage 不可用时退化为纯随机 id */
  const mk=()=>Math.random().toString(16).slice(2,6)+Date.now().toString(36).slice(-4);
  try{ let id=sessionStorage.getItem('pip-qclient'); if(!id){ id=mk(); sessionStorage.setItem('pip-qclient', id); } return id; }
  catch(e){ return mk(); }
})();
let remoteQueueClients=[];   // 其他标签页上报的在场快照（GET 拉取时已过滤掉自己）
/* 服务端孤儿登记簿快照（GET 响应顶层 orphans，旧服务端无此键→特性探测缺失即保持空数组、跳过渲染）：
   来源页面刷新/关闭后失联的运行/排队条目（原白名单快照字段 + ownerId/ownerLabel/kind/orphanedAt） */
let remoteOrphans=[];
/* 服务端执行池终态登记快照（GET 响应 server.finished，最新在前，服务端 TTL 约 120s 自动消失）：
   完成≠失联——服务端任务的完成状态由服务端权威下发，不再靠「从队列快照消失」推断。
   旧服务端无此键：特性探测缺失即保持空数组、不渲染终态行（优雅降级，与 orphans 同口径）。 */
let remoteServerFinished=[];
let _serverFinishedSeen={};   // 已消费（终态登记+历史即刷）的 finished id：随服务端 TTL 窗口滚动重建，窗口内不重复消费
let _qPubSig='', _qPubAt=0, _qPubTimer=null, _qPubWarned=false;
/* 最近正常终态登记（completed）：本页运行完成（finish，含中止）/重置与排队取消时记录条目 id，随上报的
   completed 告知服务端「这些条目是正常终态化、不是失联」，不参与孤儿判定。同步写 sessionStorage
   （pip-qfinished）跨同标签页刷新存活：配合 QCLIENT_ID 同标签页不变，刷新后第一帧上报就能把「刷新前
   刚正常完成的」排除出孤儿判定。读取即 prune：超过约 60 秒的旧记录丢弃，上限 64 条。 */
const QUEUE_FINISHED_TTL_MS=60000, QUEUE_FINISHED_CAP=64;
let queueFinished=[];
try{ const raw=sessionStorage.getItem('pip-qfinished'); const arr=raw?JSON.parse(raw):null; if(Array.isArray(arr)) queueFinished=arr.filter(e=>e&&typeof e.id==='string'&&Number.isFinite(e.ts)); }catch(e){}
/* 服务端在跑阶段的日志尾窗按「行」收紧到与历史回放一致的最后 20 行：
   传输（tailLines）与回显同限，完整内容走归档文件 / 历史回放，不在实时详情刷千行。 */
const LIVE_LOG_TAIL_LINES=20;
const LIVE_LOG_TAIL_LIMIT={maxLines:LIVE_LOG_TAIL_LINES,maxChars:256*1024};
/* 当前详情的服务端日志独立于普通队列快照拉取：同一阶段请求在途时复用 Promise；用户切换运行或
   阶段后，迟到响应按序号和当前选择双重丢弃，避免旧日志覆盖新详情。
   持续输出阶段每秒轮询若每次都全量重传 256KiB 尾窗会放大带宽与 JSON 解析开销，
   故带上 sinceEnd（已持有逻辑日志流末尾偏移）请求后缀增量：服务端只回 append，
   replaceLog 或窗口滑过客户端位置时才退回全量 text（见 src/index.ts log()）。
   本地缓存同样按 20 行截尾，避免长跑阶段缓存无界增长；endLen 单独记账，与展示截断无关。 */
let _remoteLogPullSeq=0, _remoteLogPullKey='', _remoteLogPullPromise=null;
/* 拉取服务端权威队列及旧标签页在场快照（过滤掉自己）并重绘队列区。
   降耗：快照签名与上轮一致（内容未变，效果等同 304）时跳过重绘——renderQueue 的 DOM 重建是
   每秒轮询的主要开销；当前详情的日志尾部走 pullRemoteQueueLog 自带的 revision/304 通道，不受此影响。 */
let _queuePullSig='';   // 上轮已应用渲染的队列快照签名（queuePollSig 产出）
let _queuePullPromise=null;
$('queueRefresh').addEventListener('click', async ()=>{
  const b=$('queueRefresh'); b.disabled=true;
  const sp=beginRefreshSpin(b);
  try{ await pullRemoteQueue(); } finally{ b.disabled=false; sp.stop(); }
});
/* ===== [state:S38] ===== */
let serverPlans=[];
let _planActiveSig='';   // 计划活动执行（运行中/排队中）的 id:状态 签名：队列快照 1s 轮询时据此决定是否重绘计划列表（无变化不重建 DOM）
/* ===== [state:S39] ===== */
/* 关页即失败的中断原因文案：进历史记录 closeError 字段（回放详情 KV 展示）与失败阶段日志
   （无归档文件时内联；有归档文件时由 fail-run 路由追加进归档日志）。 */
const CLOSE_FAIL_TEXT='浏览器页面已关闭，本地任务未执行完，本次运行按失败结束';
/* 定时页环境多选：与主控同一面板组件（renderEnvMulti），独立勾选状态持久化（随服务端配置 schedEnvIds 键同步，localStorage 为离线缓存）；未单独选择过则跟随主控当前环境 */
let schedEnvIds=(function(){ try{ const a=JSON.parse(localStorage.getItem('pip-schedEnvSel')); return Array.isArray(a)&&a.length?a:null; }catch(e){ return null; } })();
/* ===== [state:S41] ===== */
/* 页面隐藏时停表（tick 全停不空转），恢复可见时立即补一次 tick 再走表；hidden 期间脚本/HTTP/EvalTokens
   阶段的真实执行不受影响（推进靠各自 await，不靠 tick），仅进度展示暂停，模拟阶段收尾顺延到恢复可见 */
if(typeof document!=='undefined'&&typeof document.addEventListener==='function'){
  document.addEventListener('visibilitychange',function(){
    const T=stageTickStore();
    if(document.hidden){ if(T.timer){ clearInterval(T.timer); T.timer=null; } }   // 页面隐藏：停表
    else { stageTickRun(); stageTickEnsure(); }   // 恢复可见：立即补一次刷新再继续走表
  });
}
/* ===== [state:S44] ===== */
const STAGE_POLL_JENKINS_PATH='/api/worktable/pipeline/stage-poll/jenkins';
const STAGE_POLL_EVALTOKENS_PATH='/api/worktable/pipeline/stage-poll/evaltokens';
const STAGE_POLL_BUILD_WINDOW_MS=2500;   // build 阶段长轮询窗口调小：控制台增量回显保持原直连约 2s 的节奏（queue 阶段用服务端默认窗口）
/* ===== [state:S45] ===== */
/* 任务列表缓存（15s TTL，多阶段编辑器打开 / 多次聚焦输入框时避免重复拉取） */
let evaltokTasksCache={tasks:null, ts:0};
/* ===== [state:S46] ===== */
/* 按目录跟踪完整归档任务（含建目录），打开文件夹前等待落盘，避免切会话卸载页面打断请求。 */
const archiveWrites=new Map();
const archiveWriteErrors=new Map();   // 已落定失败与在途 Promise 分离；最多保留 100 个目录的最近错误
/* ===== [state:S47] ===== */
let pmcCtxCurrent=null;   // 当前对话框对应的运行上下文（运行中 / 历史选中行），供「还原」与「收集」复用
let pmcRunning=false, pmcAbort=null;
/* 打开对话框时先检测该运行是否已收集过普罗数据：复用「打开归档目录」的助手脚本模式
   （apiWrite 写固定脚本到 /tmp 再 exec），检出 summary.json（一次性采集）或
   snapshots/<时间戳>/summary.json（持续采集）即视为已收集，状态行展示收集归档目录 */
const PMC_CHECK='/tmp/op_test_prom_collect_check.sh';
const PMC_CHECK_SCRIPT='#!/bin/bash\n# pipeline.html「收集普罗数据」对话框：检测 $1 下是否已有采集产物\n'
  +'d="$1"\n'
  +'[ -n "$d" ] || exit 2\n'
  +'if [ -f "$d/summary.json" ] || ls "$d"/snapshots/*/summary.json >/dev/null 2>&1; then echo "$d"; exit 0; fi\n'
  +'exit 2\n';
let pmcDetectSeq=0;   // 检测序号：对话框重复打开/换行时丢弃过期结果，避免旧行检测结果覆盖新行
/* ===== [state:S48] ===== */
const DEFAULT_PROMPTS = {
  log:  '请分析下面这条流水线运行的日志，找出失败/异常点、关键告警与可优化环节，给出结论和建议。\n运行信息：{summary}\n完整日志文件夹：{archive}\n（请先用文件读取工具读完日志再分析；若文件不存在，说明本次运行未归档，请基于运行信息给出通用排查建议。）',
  prof: '请对下面这条流水线运行做 profiling 分析：解读各阶段耗时占比、找出瓶颈阶段，并给出优化建议。\n运行信息：{summary}\nprofiling 数据文件：{profileFile}\n（请先用文件读取工具读取该 JSON 再分析；若文件不存在，说明本次运行未归档，请基于运行信息做估算性分析。）',
  perf: '请对下面这条流水线运行做性能诊断：结合日志与 profiling 数据评估整体性能表现，定位耗时异常与改进点。\n运行信息：{summary}\n归档目录：{archive}\n（目录下 run-{tag}.log 为汇总日志、run-{tag}-NN-任务名.log 为各任务独立回显、run-{tag}.profile.json 为 profiling 数据，请先读取再分析；若目录不存在，说明本次运行未归档，请基于运行信息给出通用建议。）',
  /* 阶段详情「日志文件」行「🔍 AI 分析」：分析单个阶段，{stage}/{stageLogFile} 由按钮按当前阶段与展示路径注入 */
  stage:'请分析下面这条流水线运行中指定阶段的日志，找出失败/异常点、关键告警与可优化环节，给出结论和建议。\n运行信息：{summary}\n分析阶段：{stage}\n阶段日志文件：{stageLogFile}\n（请先用文件读取工具读取该阶段日志再分析；若文件不存在，说明本阶段日志尚未归档或已清理，可改读归档文件夹 {archive} 下的汇总日志 run-{tag}.log 与其它任务日志；都不可用时基于运行信息给出通用排查建议。）',
};
let analysisPrompts = loadPrompts();
const COMPARE_FOCUS = {
  log:'日志中的失败/异常点、关键告警及新增或消失的问题',
  prof:'profiling 数据中的阶段耗时占比与瓶颈变化',
  perf:'日志与 profiling 反映的整体性能、耗时异常及资源瓶颈',
};
/* ===== [state:S50] ===== */
let replayRec = null;
let selHistoryIdx=-1;   // 运行历史当前选中行（-1 = 未选中，全局下标）
let analysisHistoryKeys=[];   // AI 分析勾选（最多两条，顺序即对比的 A / B；与单行回放选择分离）
let histPage=0;
let histPageSize=Math.max(1, parseInt(lsGet('pip-histPageSize','10'),10)||10);
/* 运行历史筛选：关键字（# / 流水线 / 执行人，大小写不敏感）+ 状态 + 流水线名；随服务端配置 histFilter 键按登录用户隔离同步（localStorage 为离线缓存） */
let histFilter={kw:'',status:'',pipeline:''};
try{ const _f=JSON.parse(localStorage.getItem('pip-histFilter')); if(_f && typeof _f==='object') histFilter={kw:String(_f.kw||''),status:String(_f.status||''),pipeline:String(_f.pipeline||'')}; }catch(e){}
/* 流水线任务筛选状态（关键字 + 拥有者 + 当前用户收藏），与 histFilter 同样随服务端配置 plFilter 键按登录用户隔离同步（localStorage 为离线缓存）；
   在此提前声明，供下方筛选控件初始化与 renderPipelines 取用（声明顺序早于事件绑定）；
   owner 兼容旧值：mine/all/builtin/unknown 特殊模式键与历史版本存下的具体用户名均照常生效 */
let plFilter={kw:'',owner:'mine',favorite:'all'};
try{ const _pf=JSON.parse(localStorage.getItem('pip-plFilter')); if(_pf && typeof _pf==='object') plFilter={kw:String(_pf.kw||''),owner:String(_pf.owner||'mine'),favorite:_pf.favorite==='favorite'?'favorite':'all'}; }catch(e){}
let plPage=0;
let plPageSize=Math.max(1, parseInt(lsGet('pip-plPageSize','10'),10)||10);
/* 当前登录用户名：与「执行人」同源（/auth/status）。由 fillExecutorFromAuth 在页面加载时预取并缓存，
   供同步路径（新建/复制流水线署名、默认筛选「我的」）取用。声明在此处以保证声明顺序早于筛选事件绑定。 */
let currentUsername='';
/* auth 身份探测是否已结束：fillExecutorFromAuth 无论成功/失败/提前返回，结束时都置位。
   未置位时 plEditable 对署名流水线保守只读；置位后仍无登录用户（token 共享模式等）退化为全权。 */
let authReady=false;
/* 当前会话是否为 admin（仅 password 模式 + 已装 dsh-auth-gate-wt-admin-role 时为 true）。
   由 fillExecutorFromAuth 在拿到登录用户后异步探测 /auth/users 写入；token 模式 / 未装
   admin 插件 / 探测失败时为 false（此时 currentUsername 亦为空，canControlRun 退化为全权）。 */
let currentUserIsAdmin=false;
let _histFilterPipelineSig='';
let _histPipelineNames=[];   /* 流水线过滤候选名单缓存（签名命中时复用，避免每次重渲染重算） */
let _histPipelineActive=-1;  /* 候选面板键盘高亮下标（-1 = 无） */
/* 标题行分析按钮：优先作用于勾选的一至两条记录；未勾选时兼容原行为，使用当前回放行。 */
document.querySelectorAll('[data-ract]').forEach(b=>b.addEventListener('click', ()=>{
  const records=selectedAnalysisHistory();
  if(!records.length && selHistoryIdx>=0 && history[selHistoryIdx]) records.push(history[selHistoryIdx]);
  if(!records.length){ alert('请先勾选一至两条运行历史，或点击一行进入回放。'); return; }
  createAnalysisChat(b.getAttribute('data-ract'), records);
}));
/* 「📂 打开归档目录」：经 dsh-better-sidebar 侧边窗打开归档目录（__dshOpenFolderInSidebar
   桥由工作台插件暴露，开一个以归档目录为根的文件夹窗口）；打开成功后经 __dshCloseSideChat 桥
   关闭工作台侧边会话窗（聊天列）让出屏幕空间。未装 better-sidebar 或桥不可用时回退到
   服务端系统文件管理器（xdg-open/gio/open 依次探测，该回退路径不关会话窗）。保持当前页面与会话，
   避免新建会话的预设/模型查询和切换后的重复目录加载；需要 AI 分析时使用运行历史的分析按钮。
   目录选取（archiveTargetFolder）：运行中取当前运行的归档文件夹（页面展示的是实时运行）；
   否则取运行历史选中行的归档目录（点击历史行即刷新该目标，并经 refreshArchiveTip 同步提示）。
   未运行且未选中历史行时不回退（不再打开最近一次运行或归档根目录），返回 null，
   由 openArchiveFolder 提示先选择一条运行历史。
   目标目录不存在时（历史归档已清理、归档路径改过等）回退打开其父目录（归档根）：
   侧边栏路径由 resolveExistingFolder 预检后回退（此前不预检，会以不存在目录为根开出空文件树）；
   系统文件管理器路径下助手脚本同样回退到父目录，并把实际打开的目录回显在 stdout 供页面提示；
   连归档根都不存在才报「目录不存在」。
   上述「等待落盘 → 预检回退 → 侧边窗 / 系统文件管理器」流程抽为 openFolderWithFeedback，
   供本按钮直接使用；阶段详情「📄 打开日志」打开的是日志文件本身，仅当文件尚未生成/已清理时
   才回退复用该流程打开所在目录（此时文案与行为同本按钮）。 */
const FM_HELPER='/tmp/op_test_open_fm.sh';
const FM_SCRIPT='#!/bin/bash\n# pipeline.html「打开归档目录」生成的助手脚本：用系统文件管理器打开 $1\n'
  +'d="$1"\n'
  +'[ -n "$d" ] && [ -d "$d" ] || d="${d%/*}"\n'
  +'[ -n "$d" ] && [ -d "$d" ] || exit 2\n'
  +'echo "$d"\n'
  +'if command -v xdg-open >/dev/null 2>&1; then setsid nohup xdg-open "$d" >/dev/null 2>&1 & exit 0; fi\n'
  +'if command -v gio >/dev/null 2>&1; then setsid nohup gio open "$d" >/dev/null 2>&1 & exit 0; fi\n'
  +'if command -v open >/dev/null 2>&1; then open "$d" >/dev/null 2>&1 & exit 0; fi\n'
  +'exit 3\n';
$('openArchiveBtn').addEventListener('click', openArchiveFolder);
$('histRerun').addEventListener('click', ()=>{
  const rec=(selHistoryIdx>=0)?history[selHistoryIdx]:null;
  if(!rec){ alert('请先点击选择一条运行历史。'); return; }
  rerunFromHistory(rec);
});
/* 收集普罗数据：作用于运行中流水线或历史选中行（对话框内可改起止时间） */
$('histPromCollect').addEventListener('click', pmcShow);
$('pmcRun').addEventListener('click', pmcCollect);
$('pmcResetTimes').addEventListener('click', pmcResetTimes);
$('pmcClose').addEventListener('click', ()=>{ if(pmcRunning && pmcAbort){ try{ pmcAbort.abort(); }catch(e){} } $('pmcDialog').style.display='none'; });
/* 历史分页 */
$('histPageSize').value=String(histPageSize);
$('histPageSize').addEventListener('change', e=>{ histPageSize=Math.max(1,parseInt(e.target.value,10)||10); try{ localStorage.setItem('pip-histPageSize', String(histPageSize)); }catch(e){} histPage=0; persistState(); renderHistory(); });
$('histPrev').addEventListener('click', ()=>{ if(histPage>0){ histPage--; renderHistory(); } });
$('histNext').addEventListener('click', ()=>{ if((histPage+1)*histPageSize<filteredHistory().length){ histPage++; renderHistory(); } });
$('histClear').addEventListener('click', ()=>{ if(!history.length) return; if(!confirm('清空全部 '+history.length+' 条运行历史？（预置演示数据也会一并移除，且不可恢复）')) return; exitHistoryReplay(); history=[]; selHistoryIdx=-1; analysisHistoryKeys=[]; histPage=0; histClearedAt=Date.now(); renderHistory(); renderStats(); persistState(); refreshArchiveTip(); });   // histClearedAt 随 config 推服务端：合并历史时清空点之前的磁盘记录不再复活
let _historyRefreshPromise=null, _historyRefreshNotifyError=false;
let _historyEtag='';
/* 轻量历史接口（/pipeline/history）是后加的服务端路由：页面被工作台经 /api/worktable/site 从源码目录
   直接托管时，前端可能新于正在运行的旧版插件（如 v1.1.2 发行包无此路由）。首次收到 404 即永久降级为
   GET /api/worktable/pipeline 全量存储（与旧版手动刷新同一载荷，无 ETag 短路），本次会话内不再打缺失路由。 */
let _historyLightApiMissing=false;
const HISTORY_REFRESH_MS=3000;
/* 运行历史自动刷新：页面隐藏（document.hidden）时当次跳过——与运行队列轮询同一可见性策略
   （后台不轮询；队列轮询在文件尾部 startQueuePolling/syncQueuePolling，采用停表 + 恢复可见立即补拉，
   这里保留定时器、隐藏时早退，恢复可见后由下一拍自然补拉，ETag/304 保证无变化时不传正文）。 */
let _historyRefreshTimer=null;
/* 「↻ 刷新」仍保留即时手动入口；页面可见时还会每 3 秒自动同步其他浏览器与服务端运行新增的记录。 */
$('histRefresh').addEventListener('click', async ()=>{
  const b=$('histRefresh'); b.disabled=true;
  const sp=beginRefreshSpin(b);
  try{ await refreshHistoryFromServer(true); }
  finally{ b.disabled=false; sp.stop(); }
});
/* 流水线任务分页 */
/* 页大小规格与运行历史相同，但使用独立状态和本地存储键。 */
$('plPageSize').value=String(plPageSize);
$('plPageSize').addEventListener('change', e=>{ plPageSize=Math.max(1,parseInt(e.target.value,10)||10); try{ localStorage.setItem('pip-plPageSize', String(plPageSize)); }catch(e){} plPage=0; persistState(); renderPipelines(); });
$('plPrev').addEventListener('click', ()=>{ if(plPage>0){ plPage--; renderPipelines(); } });
$('plNext').addEventListener('click', ()=>{ if((plPage+1)*plPageSize<pipelines.filter(plFilterMatch).length){ plPage++; renderPipelines(); } });
/* 历史筛选：关键字实时过滤、状态下拉、流水线可搜索面板、清除筛选（条件变化时归首页） */
$('histFilterKw').value=histFilter.kw;
$('histFilterStatus').value=histFilter.status;
$('histFilterKw').addEventListener('input', e=>{ histFilter.kw=e.target.value; histPage=0; saveHistFilter(); renderHistory(); });
$('histFilterStatus').addEventListener('change', e=>{ histFilter.status=e.target.value; histPage=0; saveHistFilter(); renderHistory(); });
/* 流水线过滤（可搜索）：聚焦/方向键弹出全量候选，输入即时子串过滤（大小写不敏感；清空=全部流水线，即时提交），
   点选/Enter 提交候选精确名，方向键移动高亮，Esc/点外关闭面板并回显已提交值 */
$('histFilterPipeline').addEventListener('focus', ()=>renderHistPipelinePanel(true));
$('histFilterPipeline').addEventListener('input', e=>{
  if(!e.target.value.trim()){
    if(histFilter.pipeline){ histFilter.pipeline=''; histPage=0; saveHistFilter(); renderHistory(); }
    else renderHistPipelinePanel();
  } else renderHistPipelinePanel();
});
$('histFilterPipeline').addEventListener('keydown', e=>{
  const panel=$('histPipelinePanel'); if(!panel) return;
  const open=panel.style.display==='block';
  if(e.key==='Escape'){
    if(open){ panel.style.display='none'; e.target.value=histPipelineDisplay(); e.preventDefault(); }
    return;
  }
  if(e.key==='ArrowDown' || e.key==='ArrowUp'){
    e.preventDefault();
    if(!open){ renderHistPipelinePanel(true); return; }
    const items=histPipelinePanelItems(); if(!items.length) return;
    _histPipelineActive=(e.key==='ArrowDown')
      ? (_histPipelineActive<items.length-1 ? _histPipelineActive+1 : 0)
      : (_histPipelineActive>0 ? _histPipelineActive-1 : items.length-1);
    items.forEach((el,i)=>{ el.style.background=(i===_histPipelineActive)?'var(--dsw-alias-fill-l1)':''; });
    return;
  }
  if(e.key==='Enter' && open){
    const items=histPipelinePanelItems();
    let el=(_histPipelineActive>=0)?items[_histPipelineActive]:null;
    /* 未高亮时 Enter 提交与输入完全一致的候选 */
    if(!el){ const v=e.target.value.trim(); if(v) el=items.find(x=>x.getAttribute('data-histpl')===v)||null; }
    if(el){ pickHistPipeline(el.getAttribute('data-histpl')); e.preventDefault(); }
  }
});
document.addEventListener('click', e=>{
  const p=$('histPipelinePanel'); const m=$('histPipelinePick');
  if(p && m && p.style.display==='block' && !m.contains(e.target)){
    p.style.display='none';
    const inp=$('histFilterPipeline'); if(inp) inp.value=histPipelineDisplay();
  }
});
$('histFilterClear').addEventListener('click', ()=>{ histFilter={kw:'',status:'',pipeline:''}; $('histFilterKw').value=''; $('histFilterStatus').value=''; $('histFilterPipeline').value=''; saveHistFilter(); histPage=0; renderHistory(); });
$('plFilterKw').value=plFilter.kw;
$('plFilterOwner').value=plOwnerFilterLabel(plFilter.owner);
$('plFilterFavorite').value=plFilter.favorite;
$('plFilterKw').addEventListener('input', e=>{ plFilter.kw=e.target.value; plPage=0; savePlFilter(); renderPipelines(); });
$('plFilterOwner').addEventListener('focus', ()=>renderPlOwnerPanel(true));
/* 输入即时过滤候选面板并按当前文本提交筛选（子串/标签映射见 plFilterMatch / plOwnerFilterValue）；
   清空回退默认「我的（含预置）」。change 不再接线：提交统一走 pickPlOwner / input，避免重复重绘 */
$('plFilterOwner').addEventListener('input', e=>{
  const text=e.target.value;
  plFilter.owner=plOwnerFilterValue(text);
  plPage=0; savePlFilter();
  renderPipelines();
  renderPlOwnerPanel();
});
$('plFilterOwner').addEventListener('keydown', e=>{
  const panel=$('plOwnerPanel'); if(!panel) return;
  const open=panel.style.display==='block';
  if(e.key==='Escape'){
    if(open){ panel.style.display='none'; e.target.value=plOwnerFilterLabel(plFilter.owner); e.preventDefault(); }
    return;
  }
  if(e.key==='ArrowDown' || e.key==='ArrowUp'){
    e.preventDefault();
    if(!open){ renderPlOwnerPanel(true); return; }
    const items=plOwnerPanelItems(); if(!items.length) return;
    _plOwnerActive=(e.key==='ArrowDown')
      ? (_plOwnerActive<items.length-1 ? _plOwnerActive+1 : 0)
      : (_plOwnerActive>0 ? _plOwnerActive-1 : items.length-1);
    items.forEach((el,i)=>{ el.style.background=(i===_plOwnerActive)?'var(--dsw-alias-fill-l1)':''; });
    return;
  }
  if(e.key==='Enter' && open){
    const items=plOwnerPanelItems();
    let el=(_plOwnerActive>=0)?items[_plOwnerActive]:null;
    /* 未高亮时 Enter 提交与输入完全一致的候选（输入是显示文本，经 plOwnerFilterValue 归一到 key） */
    if(!el){
      const raw=e.target.value.trim();
      if(raw){ const v=plOwnerFilterValue(raw); el=items.find(x=>x.getAttribute('data-plowner')===v)||null; }
    }
    if(el){ pickPlOwner(el.getAttribute('data-plowner')); e.preventDefault(); }
  }
});
document.addEventListener('click', e=>{
  const p=$('plOwnerPanel'); const m=$('plOwnerPick');
  if(p && m && p.style.display==='block' && !m.contains(e.target)){
    p.style.display='none';
    const inp=$('plFilterOwner'); if(inp) inp.value=plOwnerFilterLabel(plFilter.owner);
  }
});
$('plFilterFavorite').addEventListener('change', e=>{ plFilter.favorite=e.target.value; plPage=0; savePlFilter(); renderPipelines(); });
$('plFilterClear').addEventListener('click', ()=>{ plFilter={kw:'',owner:'mine',favorite:'all'}; plPage=0; $('plFilterKw').value=''; $('plFilterOwner').value=plOwnerFilterLabel('mine'); $('plFilterFavorite').value='all'; savePlFilter(); renderPipelines(); });
/* ===== [state:S51] ===== */
$('pipelineRefresh').addEventListener('click', refreshPipelinesFromServer);
/* ===== [state:S52] ===== */
let _plOwnerSig='';
let _plOwnerActive=-1;   /* 拥有者候选面板键盘高亮下标（-1 = 无） */
let _plOwnerListCache=[{key:'mine',label:'我的（含预置）'},{key:'all',label:'全部'},{key:'builtin',label:'仅预置'}];
/* ===== [state:S53] ===== */
/* 行内「⋯」菜单当前展开项的流水线 id：菜单是全局悬浮层 #plRowMenuPanel（fixed 定位，悬浮最上层、不撑大行高），
   开合只动该层、不重渲染任务表；点 ⋯/置顶/收藏/运行历史项/菜单外任意处/滚动/缩放收起（绑定见文件尾） */
let plMenuOpenId=null;
let historyMenuOpenRec=null;
const historyRowMenuViewPipeline=$('historyRowMenuViewPipeline');
if(historyRowMenuViewPipeline && typeof historyRowMenuViewPipeline.addEventListener==='function') historyRowMenuViewPipeline.addEventListener('click', e=>{
  e.stopPropagation();
  const rec=historyMenuOpenRec;
  closeHistoryRowMenu();
  if(rec) showPipelineFromHistory(rec);
});
let editFocusIdx=-1;
let editDefaults=normalizePipelineDefaults(null);
/* 编辑器草稿自动存档：值有改动即写入 localStorage（仅本地，不上送服务端——草稿可能含未通过校验的半成品）。
   关闭/点遮罩/刷新浏览器都不清草稿，只有「保存」成功或「取消」显式丢弃才清，防止误操作退出丢失编辑。
   下次打开同一流水线（或新建）时自动恢复上次未提交的草稿。 */
let plDraftTimer=null, plDraftTipTimer=null;
/* 流水线只读查看（内置流水线视同可信——非 admin 只读 / 他人拥有的流水线）：openPlForm 按 plEditable(p) 置位，
   编辑器以只读模式打开——名称/脚本目录/默认环境与阶段卡内全部编辑控件禁用，保存/添加阶段入口隐藏，
   任务卡禁止拖拽，「+」插入按钮不出现（见 applyEditSel），仅保留「关闭/取消」退出；
   保存端另有 savePlForm 兜底拦截。因阶段参数识别等为异步重渲染，
   本函数在 openPlForm、renderStageEditor、detectStageParams、detectEvaltokStageParams 末尾重复应用（幂等）。 */
let plFormReadOnly=false;
/* ===== [state:S54] ===== */
let themePref = lsGet('pip-theme', 'auto');
$('theme').value = themePref;
$('theme').addEventListener('change', e=>{ themePref=e.target.value; applyTheme(); persistState(); });
if(window.matchMedia){ matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{ if(themePref==='auto') applyTheme(); }); }
/* ===== [state:S55] ===== */
/* 页面级轻提示（toast）：底部居中浮层、约 4 秒自动消隐，用于保存被拒（可信流水线 403）
   与「标记可信」反馈等瞬时提示。元素懒创建（.page-toast 样式见样式表）；测试桩无 DOM 时静默跳过。 */
let pageToastTimer=null;
/* 运行按钮旁短暂提示（入队 / 重跑反馈） */
let runTipTimer=null;
$('runBtn').addEventListener('click', ()=>{ const r=runPipeline(); if(r===false) alert('本地队列已满（上限 '+QUEUE_CAP+'），请等待当前任务完成或取消部分排队任务。'); else if(r==='queued') flashRunTip('已加入本地队列（第 '+queue.length+' 位）'); else if(r==='submitted') flashRunTip('已提交服务端运行队列'); });
$('schedCreateBtn').addEventListener('click', addPlan);
$('runSched').addEventListener('change', e=>{ const v=e.target.value; $('runSchedEveryWrap').style.display = v==='interval'?'flex':'none'; $('runSchedStartWrap').style.display = v==='interval'?'flex':'none'; $('runSchedAtWrap').style.display = v==='once'?'flex':'none'; });
$('resetBtn').addEventListener('click', ()=>{
  /* 非 admin 不可重置他人流水线：仅中止/清空自己署名（by）的运行与排队任务，他人条目原样保留。
     admin 全量重置（既有行为）。token 模式（currentUsername 为空）退化为全量。 */
  const adminAll = currentUserIsAdmin || !currentUsername;
  const mine = r=>canControlRun(r && r.by);
  const ownRuns = adminAll ? activeRuns : activeRuns.filter(mine);
  const ownQueue = adminAll ? queue : queue.filter(mine);
  const otherRunsN = adminAll ? 0 : activeRuns.length - ownRuns.length;
  const otherQueueN = adminAll ? 0 : queue.length - ownQueue.length;
  if(ownRuns.length || ownQueue.length){
    let msg='将中止 '+(adminAll?activeRuns.length:ownRuns.length)+' 个运行'+((adminAll?queue.length:ownQueue.length)?('并清空 '+(adminAll?queue.length:ownQueue.length)+' 个排队任务'):'')+'（进行中的脚本将终止，且不计入历史）。';
    if(!adminAll && (otherRunsN||otherQueueN)) msg+='\n其中他人的 '+otherRunsN+' 个运行 / '+otherQueueN+' 个排队任务无权清空，将保留。';
    if(!confirm(msg+'继续？')) return;
  }else if(!adminAll && (otherRunsN||otherQueueN)){
    alert('无可重置的本人流水线；其余 '+(otherRunsN+otherQueueN)+' 个为他人条目，仅管理员可重置。'); return;
  }
  exitHistoryReplay();   // 重置一并退出历史回放态
  /* 重置属正常终态化（不计入历史）：被清空的运行/排队条目登记进 completed，豁免孤儿判定 */
  if(typeof queueFinishedNote==='function'){
    ownRuns.forEach(rc=>{ queueFinishedNote(rc&&rc.id); if(rc&&rc.originQueueId) queueFinishedNote(rc.originQueueId); });
    ownQueue.forEach(q=>queueFinishedNote(q&&q.id));
  }
  ownRuns.forEach(disposeRunForReset);   // 先取消并行子任务，再标死父运行；在途迟回不得 finish 入账（重置不计入历史）
  if(adminAll){ activeRuns=[]; queue=[]; }
  else { activeRuns=activeRuns.filter(r=>!mine(r)); queue=queue.filter(q=>!mine(q)); }
  /* 编排区焦点若落在被清空的本人运行上则回到空闲；他人运行仍可保留为焦点（不重置其节点视图） */
  const clearView = !viewRc || (adminAll || mine(viewRc.by));
  if(clearView){ viewRc=null; syncViewRun(); syncRunState(); resetNodes(); applyRunOverall(null); }
  else { syncRunState(); renderFlow(); renderDetail(); }
  renderQueue();
  refreshArchiveTip();   // 运行已全部清空，「打开归档目录」目标回退到历史选中行（未选中则提示选择，不再回退归档根）
});
$('pipelineSel').addEventListener('change', e=>{ if(e.target.value) selectPipeline(e.target.value); });
$('addPlBtn').addEventListener('click', ()=>openPlForm(''));
$('pipelineRunClose').addEventListener('click',closePipelineRunDialog);
$('pipelineRunCancel').addEventListener('click',closePipelineRunDialog);
$('pipelineRunSubmit').addEventListener('click',submitPipelineRunDialog);
$('pipelineRunDialog').addEventListener('click',e=>{ if(e.target===$('pipelineRunDialog')) closePipelineRunDialog(); });
/* 节点预留分配弹窗：开关/点遮罩关闭沿用 pipelineRunDialog 模式；「添加时段」「手动添加用户」「保存」
   操作 nodeResEdit 编辑态（只读形态入口已隐藏，saveNodeResDialog 内另有 readonly 兜底） */
$('nodeResClose').addEventListener('click', closeNodeResDialog);
$('nodeResCancel').addEventListener('click', closeNodeResDialog);
$('nodeResCloseFooter').addEventListener('click', closeNodeResDialog);
$('nodeResDialog').addEventListener('click', e=>{ if(e.target===$('nodeResDialog')) closeNodeResDialog(); });
$('nodeResAddWindow').addEventListener('click', ()=>{
  if(!nodeResEdit||nodeResEdit.readonly) return;
  nodeResEdit.windows.push({id:'', start:'', end:'', users:(currentUsername?[currentUsername]:[]), note:''});   // 新时段默认勾选当前用户，保存校验仍要求至少 1 个用户
  renderNodeResWindows();
});
$('nodeResSave').addEventListener('click', saveNodeResDialog);
$('pipelineRunEnvMultiBtn').addEventListener('click',e=>{ e.stopPropagation(); const panel=$('pipelineRunEnvMultiPanel'); panel.style.display=panel.style.display==='none'?'block':'none'; if(panel.style.display==='block') positionPipelineRunPanel('pipelineRunEnvMultiPanel','pipelineRunEnvMultiBtn'); });
/* 点外关闭：面板已 portal 到 body（最上层 fixed 浮层），面板内部点击不算点外 */
document.addEventListener('click',e=>{ const panel=$('pipelineRunEnvMultiPanel'),wrap=$('pipelineRunEnvMulti'); if(panel&&wrap&&!wrap.contains(e.target)&&!panel.contains(e.target)) panel.style.display='none'; });
$('pipelineRunRepo').addEventListener('change',()=>{ const bp=$('pipelineRunBranchPanel'),sp=$('pipelineRunStrategyPanel'); if(bp) bp.style.display='none'; if(sp) sp.style.display='none'; loadDeployStrategies(true,'run'); });
$('pipelineRunBranch').addEventListener('focus',()=>{ const ctx=pickCtx('run'),repo=ctx.repo(); if(repo) loadRepoBranches(repo,false,'run').then(()=>renderBranchPanel(true,'run')); });
$('pipelineRunBranch').addEventListener('change',()=>loadDeployStrategies(false,'run'));
$('pipelineRunBranch').addEventListener('input',()=>{ const panel=$('pipelineRunBranchPanel'); if(panel.style.display==='none'){ loadRepoBranches(pickCtx('run').repo(),false,'run').then(()=>renderBranchPanel(false,'run')); } else renderBranchPanel(false,'run'); });
document.addEventListener('click',e=>{ const panel=$('pipelineRunBranchPanel'),wrap=$('pipelineRunBranchPick'); if(panel&&wrap&&!wrap.contains(e.target)&&!panel.contains(e.target)) panel.style.display='none'; });
$('pipelineRunStrategy').addEventListener('focus',()=>{ renderStrategyPanel(true,'run'); loadDeployStrategies(false,'run').then(()=>renderStrategyPanel(true,'run')); });
$('pipelineRunStrategy').addEventListener('input',()=>{ const panel=$('pipelineRunStrategyPanel'); if(panel.style.display==='none'){ loadDeployStrategies(false,'run').then(()=>renderStrategyPanel(false,'run')); } else renderStrategyPanel(false,'run'); });
document.addEventListener('click',e=>{ const panel=$('pipelineRunStrategyPanel'),wrap=$('pipelineRunStrategyPick'); if(panel&&wrap&&!wrap.contains(e.target)&&!panel.contains(e.target)) panel.style.display='none'; });
window.addEventListener('resize',positionPipelineRunPanels);
window.addEventListener('scroll',positionPipelineRunPanels,true);
$('pipelineApiClose').addEventListener('click',()=>$('pipelineApiDialog').style.display='none');
$('pipelineApiDialog').addEventListener('click',e=>{ if(e.target===$('pipelineApiDialog')) $('pipelineApiDialog').style.display='none'; });
$('pipelineApiCopyEndpoint').addEventListener('click',e=>copyText($('pipelineApiEndpoint').textContent,e.currentTarget));
$('pipelineApiCopyBody').addEventListener('click',e=>copyText($('pipelineApiBody').textContent,e.currentTarget));
$('pipelineApiCopyCurl').addEventListener('click',e=>copyText($('pipelineApiCurl').textContent,e.currentTarget));
$('pipelineApiInvoke').addEventListener('click',()=>{ invokePipelineApi(); });
$('plSave').addEventListener('click', savePlForm);
$('plCancel').addEventListener('click', ()=>{ clearPlDraft(); $('plForm').style.display='none'; });
$('plFormClose').addEventListener('click', ()=>{ $('plForm').style.display='none'; });   /* 关闭=保留草稿（误操作退出保护），仅「取消」显式丢弃 */
$('plForm').addEventListener('click', (e)=>{ if(e.target===$('plForm')) $('plForm').style.display='none'; });   /* 点遮罩同关闭：保留草稿 */
$('scriptsReload').addEventListener('click', ()=>{ scriptsDir=$('scriptsDir').value.trim()||scriptsDir; scriptsDirIsFallback=false; saveScriptsDir(); loadScripts().then(()=>renderStageEditor()); schedulePlDraftSave(); });
$('plName').addEventListener('input', schedulePlDraftSave);
$('scriptsDir').addEventListener('input', schedulePlDraftSave);
$('plDefaultEnvMultiBtn').addEventListener('click',e=>{ e.stopPropagation(); const p=$('plDefaultEnvMultiPanel'); p.style.display=p.style.display==='none'?'block':'none'; });
document.addEventListener('click',e=>{ const p=$('plDefaultEnvMultiPanel'),m=$('plDefaultEnvMulti'); if(p&&m&&!m.contains(e.target)) p.style.display='none'; });
$('plDefaultRepo').addEventListener('change',pipelineDefaultFormChanged);
$('plDefaultBranch').addEventListener('input',pipelineDefaultFormChanged);
$('plDefaultStrategy').addEventListener('input',pipelineDefaultFormChanged);
$('plDefaultPresets').querySelectorAll('[data-pldefaultpreset]').forEach(el=>el.addEventListener('change',pipelineDefaultFormChanged));
$('archiveDir').value = archiveDir;
$('archiveDir').addEventListener('change', e=>{ archiveDir=e.target.value.trim(); saveArchiveDir(); });
$('cfgScriptsDirSave').addEventListener('click', ()=>applyScriptsDirInput($('cfgScriptsDir').value));
$('cfgScriptsDirReset').addEventListener('click', ()=>applyScriptsDirInput(''));
$('archiveScriptName').value = archiveScriptName;
$('archiveScriptName').addEventListener('change', e=>{ archiveScriptName=e.target.value.trim(); saveArchiveScript(); });
$('plStageAdd').addEventListener('click', ()=>{ editStages.push(newStage()); renderStageEditor(); schedulePlDraftSave(); });
$('plImportShare').addEventListener('click', ()=>{ importPipelineShare(); });
$('plShareImportClose').addEventListener('click', closePipelineShareImport);
$('plShareImportCancel').addEventListener('click', closePipelineShareImport);
$('plShareImportDialog').addEventListener('click', (e)=>{ if(e.target===$('plShareImportDialog')) closePipelineShareImport(); });
$('plShareImportOk').addEventListener('click', ()=>{ const ta=$('plShareImportText'); applyPipelineShareText(ta?ta.value:''); });
/* 任务卡选中委托：点击卡上任意处（含卡内输入框/按钮）选中该卡，高亮并在上/下边框中点显示「+」插入按钮。
   必须先于下方 data-act 委托注册：选中只原地刷新（applyEditSel，不重渲染、不打断输入），随后按钮动作（含插入/删除）照常执行。 */
$('plStageList').addEventListener('click', (e)=>{
  const row=e.target.closest && e.target.closest('.plstage'); if(!row) return;
  selectEditStage(parseInt(row.dataset.idx,10));
});
/* 阶段编辑器：增删/上下移/识别参数/上/下缘插入（事件委托，动作后统一调度草稿自动保存） */
$('plStageList').addEventListener('click', (e)=>{
  const btn=e.target.closest && e.target.closest('[data-act]'); if(!btn) return;
  const row=btn.closest('.plstage'); const i=parseInt(row.dataset.idx,10);
  const act=btn.getAttribute('data-act');
  if(act==='del'){ if(editStages[i]===editSelStage) editSelStage=null; editStages.splice(i,1); renderStageEditor(); }
  else if(act==='insBefore'||act==='insAfter'){ insertEditStage(i, act==='insAfter'); }
  else if(act==='up' && i>0){ moveEditStage(i,i-1); renderStageEditor(); }
  else if(act==='down' && i<editStages.length-1){ moveEditStage(i,i+1); renderStageEditor(); }
  else if(act==='detect'){ detectStageParams(i); }
  else if(act==='kind'){ setStageKind(i, btn.getAttribute('data-kind')); }
  schedulePlDraftSave();
});
$('plStageList').addEventListener('change', updateStageFromEditor);
$('envFilter').addEventListener('input', ()=>{ envFilterText=$('envFilter').value; renderEnvs(); });
/* 节点环境表头排序：升序 → 降序 → 取消 */
document.querySelectorAll('#envTable th[data-sort]').forEach(th=>{
  th.addEventListener('click', ()=>{
    const k=th.getAttribute('data-sort');
    if(envSort.key!==k) envSort={key:k, dir:1};
    else if(envSort.dir>0) envSort.dir=-1;
    else envSort={key:null, dir:1};
    renderEnvs();
  });
});
$('envAdd').addEventListener('click', saveEnvForm);
$('envCancelEdit').addEventListener('click', resetEnvForm);
$('envAllApply').addEventListener('click', applyEnvCredAll);
$('repoSel').addEventListener('change', e=>{ curRepoId=e.target.value; saveRepoSel(); const bp=$('branchPanel'); if(bp) bp.style.display='none'; loadDeployStrategies(true); });
$('repoAdd').addEventListener('click', saveRepoForm);
$('repoCancelEdit').addEventListener('click', resetRepoForm);
$('repoAllApply').addEventListener('click', applyRepoCredAll);
$('repoFetchMode').addEventListener('change', toggleRepoJenkinsJobInput);
toggleRepoJenkinsJobInput();
$('repoStrategyMode').addEventListener('change', toggleRepoStrategyInput);
toggleRepoStrategyInput();
$('gpuRefreshAll').addEventListener('click', refreshGpuAll);
$('envInfoRefresh').addEventListener('click', refreshEnvsFromServer);
$('gpuDetailClose').addEventListener('click', ()=>{ $('gpuDetail').style.display='none'; });
$('gpuDetail').addEventListener('click', (e)=>{ if(e.target===$('gpuDetail')) $('gpuDetail').style.display='none'; });
/* 环境清理：开关与脚本配置（初始值取 localStorage，服务端状态就绪后会被覆盖） */
$('cleanupEnv').checked = lsGet('pip-cleanupEnabled','')==='1';
$('cleanupEnv').addEventListener('change', saveCleanup);
$('cleanupScriptName').value = cleanupScript?cleanupScript.name:'';
$('cleanupScriptName').addEventListener('change', (e)=>setCleanupScript(e.target.value.trim()));
$('cleanupDetect').addEventListener('click', ()=>{ detectCleanupParams().then(saveCleanup); });
renderCleanupParams();
/* 环境检查：开关与脚本配置（初始值取 localStorage，服务端状态就绪后会被覆盖）；仅手动/队列运行生效，定时计划由服务端执行、暂不支持检查 */
$('checkEnv').checked = lsGet('pip-checkEnabled','')==='1';
$('checkEnv').addEventListener('change', saveCheck);
$('checkScriptName').value = checkScript?checkScript.name:'';
$('checkScriptName').addEventListener('change', (e)=>setCheckScript(e.target.value.trim()));
$('checkDetect').addEventListener('click', ()=>{ detectCheckParams().then(saveCheck); });
renderCheckParams();
/* Profiling：开关与脚本配置（初始值取 localStorage，服务端状态就绪后会被覆盖）；仅手动/队列运行生效，定时计划由服务端执行、暂不支持 */
$('profilingEnv').checked = lsGet('pip-profilingEnabled','')==='1';
$('profilingEnv').addEventListener('change', saveProfiling);
$('profilingScriptName').value = profilingScript?profilingScript.name:'';
$('profilingScriptName').addEventListener('change', (e)=>setProfilingScript(e.target.value.trim()));
$('profilingDetect').addEventListener('click', ()=>{ detectProfilingParams().then(saveProfiling); });
renderProfilingParams();
/* 自定义预设任务：设置页「预设任务设置」专区与主控「预设任务」面板自定义勾选项（初始值取 localStorage，服务端状态就绪后会被覆盖） */
renderCustomPresetZone();
renderPresetMultiPanel();
$('customPresetAdd').addEventListener('click', addCustomPreset);
/* Jenkins 服务配置（设置页内卡片）：连接模式切换 / 测试连接 / 保存 */
applyJenkinsForm();
$('jkModeLocal').addEventListener('click', ()=>setJenkinsMode('local'));
$('jkModeRemote').addEventListener('click', ()=>setJenkinsMode('remote'));
$('jkTest').addEventListener('click', testJenkins);
$('jkSave').addEventListener('click', ()=>{
  jenkins = collectJenkinsForm(); saveJenkins();
  $('jkSavedTip').textContent='已保存。'; setTimeout(()=>{ $('jkSavedTip').textContent=''; },2000);
});
$('jkJobs').addEventListener('click', listJenkinsJobs);
/* EvalTokens 服务配置（设置页内卡片）：连接模式切换 / 测试连接 / 获取任务列表 / 保存 */
applyEvaltokForm();
$('etModeLocal').addEventListener('click', ()=>setEvaltokMode('local'));
$('etModeRemote').addEventListener('click', ()=>setEvaltokMode('remote'));
$('etTest').addEventListener('click', testEvaltok);
$('etOpen').addEventListener('click', listEvaltokTasks);
$('etSave').addEventListener('click', ()=>{
  evaltok = collectEvaltokForm(); saveEvaltok();
  $('etSavedTip').textContent='已保存。'; setTimeout(()=>{ $('etSavedTip').textContent=''; },2000);
});
/* 普罗数据（Prometheus）服务配置（设置页内卡片）：连接模式切换 / 测试连接 / 保存 */
applyPromForm();
$('pmModeLocal').addEventListener('click', ()=>setPromMode('local'));
$('pmModeRemote').addEventListener('click', ()=>setPromMode('remote'));
$('pmTest').addEventListener('click', testProm);
$('pmSave').addEventListener('click', ()=>{
  prom = collectPromForm(); saveProm();
  $('pmSavedTip').textContent='已保存。'; setTimeout(()=>{ $('pmSavedTip').textContent=''; },2000);
});
$('navMain').addEventListener('click', ()=>switchPage('main'));
$('navSched').addEventListener('click', ()=>switchPage('sched'));
$('navNode').addEventListener('click', ()=>switchPage('node'));
$('navEnv').addEventListener('click', ()=>switchPage('env'));
$('cfgSave').addEventListener('click', ()=>{
  analysisPrompts={log:$('cfgPromptLog').value, prof:$('cfgPromptProf').value, perf:$('cfgPromptPerf').value, stage:$('cfgPromptStage').value};
  savePrompts();
  $('cfgSavedTip').textContent='已保存。'; setTimeout(()=>{ $('cfgSavedTip').textContent=''; },2000);
});
$('cfgReset').addEventListener('click', ()=>{ analysisPrompts=Object.assign({},DEFAULT_PROMPTS); savePrompts(); fillCfgForm(); });
/* ===== [state:S59] ===== */
/* 菜单开合（点外关闭，与「环境」多选同一交互）+ 各入口 wiring；文件框选完即清空 value，保证重复选同一文件仍触发 change。
   点外关闭同时收起服务端备份列表面板（ioSrvPanel 与菜单同属 #ioMenu 容器，面板内点击不会误关） */
$('ioMenuBtn').addEventListener('click', (e)=>{ e.stopPropagation(); const p=$('ioMenuPanel'); p.style.display=p.style.display==='none'?'block':'none'; if(p.style.display==='block') ioTipShow(''); });
document.addEventListener('click', (e)=>{ const m=$('ioMenu'); if(m && !m.contains(e.target)){ const p=$('ioMenuPanel'); const s=$('ioSrvPanel'); if(p) p.style.display='none'; if(s) s.style.display='none'; } });
/* 流水线行内「⋯」菜单：「置顶 / 收藏 / 运行历史 / 标记可信」列表项对当前展开行切换对应状态或跳转（先收起菜单再执行）；
   点菜单外任意处 / 页面或表格容器滚动 / 缩放窗口时收起（fixed 层不跟随锚点滚动，开着会错位） */
$('plRowMenuPin').addEventListener('click', (e)=>{ e.stopPropagation(); const id=plMenuOpenId; closePlRowMenu(); if(id) togglePipelinePin(id); });
$('plRowMenuFavorite').addEventListener('click', (e)=>{ e.stopPropagation(); const id=plMenuOpenId; closePlRowMenu(); if(id) togglePipelineFavorite(id); });
$('plRowMenuHistory').addEventListener('click', (e)=>{ e.stopPropagation(); const id=plMenuOpenId; closePlRowMenu(); if(id) showPipelineHistory(id); });
$('plRowMenuShare').addEventListener('click', (e)=>{ e.stopPropagation(); const id=plMenuOpenId; closePlRowMenu(); if(id) sharePipeline(id); });
$('plRowMenuTrusted').addEventListener('click', (e)=>{ e.stopPropagation(); const id=plMenuOpenId; closePlRowMenu(); if(id) togglePipelineTrusted(id); });
document.addEventListener('click', closePlRowMenu);
document.addEventListener('click', closeHistoryRowMenu);
window.addEventListener('scroll', closePlRowMenu, true);   // 捕获阶段监听：页面与各 overflow 容器滚动都能收到
window.addEventListener('resize', closePlRowMenu);
window.addEventListener('resize', closeHistoryRowMenu);
$('ioExpSettings').addEventListener('click', exportSettings);
$('ioExpPipelines').addEventListener('click', exportPipelines);
$('ioImpSettings').addEventListener('click', ()=>{ $('ioImpSettingsFile').click(); });
$('ioImpPipelines').addEventListener('click', ()=>{ $('ioImpPipelinesFile').click(); });
$('ioImpSettingsFile').addEventListener('change', (e)=>{ const f=e.target.files && e.target.files[0]; e.target.value=''; if(f) importSettingsFile(f); });
$('ioImpPipelinesFile').addEventListener('change', (e)=>{ const f=e.target.files && e.target.files[0]; e.target.value=''; if(f) importPipelinesFile(f); });
/* 服务端备份入口：导出到服务端（文件名可改，自动补 .json）/ 打开服务端备份列表面板 */
$('ioExpSettingsSrv').addEventListener('click', exportSettingsToServer);
$('ioExpPipelinesSrv').addEventListener('click', exportPipelinesToServer);
$('ioImpSrv').addEventListener('click', (e)=>{ e.stopPropagation(); const p=$('ioSrvPanel'); toggleIoSrvPanel(!p || p.style.display==='none'); });
$('ioSrvRefresh').addEventListener('click', refreshIoSrvList);
$('ioSrvClose').addEventListener('click', ()=>toggleIoSrvPanel(false));
/* 剪贴板入口：复制导出 JSON 到剪贴板 / 打开粘贴导入对话框（点遮罩或关闭/取消收起） */
$('ioExpSettingsClip').addEventListener('click', exportSettingsToClipboard);
$('ioExpPipelinesClip').addEventListener('click', exportPipelinesToClipboard);
$('ioImpClip').addEventListener('click', (e)=>{ e.stopPropagation(); openIoClipImport(); });
$('ioClipClose').addEventListener('click', closeIoClipImport);
$('ioClipCancel').addEventListener('click', closeIoClipImport);
$('ioClipDialog').addEventListener('click', (e)=>{ if(e.target===$('ioClipDialog')) closeIoClipImport(); });
$('ioClipImport').addEventListener('click', ()=>{ const ta=$('ioClipText'); importFromClipboardText(ta?ta.value:''); });

/* 环境多选面板开合 */
$('envMultiBtn').addEventListener('click', (e)=>{ e.stopPropagation(); const p=$('envMultiPanel'); p.style.display = p.style.display==='none'?'block':'none'; });
document.addEventListener('click', (e)=>{ const p=$('envMultiPanel'); const m=$('envMulti'); if(p && m && !m.contains(e.target)) p.style.display='none'; });
/* 预设任务多选面板开合（与「环境」多选同一交互：点外关闭） */
$('presetMultiBtn').addEventListener('click', (e)=>{ e.stopPropagation(); const p=$('presetMultiPanel'); p.style.display = p.style.display==='none'?'block':'none'; });
document.addEventListener('click', (e)=>{ const p=$('presetMultiPanel'); const m=$('presetMulti'); if(p && m && !m.contains(e.target)) p.style.display='none'; });
(function(){ try{ const b=localStorage.getItem('pip-branch'); if(b!==null) $('branchName').value=b; const s=localStorage.getItem('pip-strategy'); if(s!==null) $('deployStrategyName').value=s; const w=localStorage.getItem('pip-weightsPath'); if(w!==null) $('weightsPath').value=w; }catch(e){} })();
$('branchName').addEventListener('change', saveRunSelLS);
$('deployStrategyName').addEventListener('change', saveRunSelLS);
$('weightsPath').addEventListener('change', saveRunSelLS);
window.addEventListener('pagehide', saveRunSelLS);
/* ===== [state:S61] ===== */
fillExecutorFromAuth();
/* 节点预留：首屏预取（节点表「预留」列摘要与环境多选面板的预留拦截/徽标依赖该数据；
   失败静默保留空列表——无预留数据时按「无预留」渲染，不产生误拦截） */
loadNodeReservations();
/* 分支搜索面板：聚焦/输入时按当前代码仓拉取并筛选远程分支；点外关闭 */
$('branchName').addEventListener('focus', ()=>{ loadRepoBranches(curRepo()).then(()=>renderBranchPanel(true)); });
$('branchName').addEventListener('change', ()=>loadDeployStrategies());
$('branchName').addEventListener('input', ()=>{ if($('branchPanel').style.display==='none'){ loadRepoBranches(curRepo()).then(()=>renderBranchPanel()); } else { renderBranchPanel(); } });
document.addEventListener('click', (e)=>{ const p=$('branchPanel'); const m=$('branchPick'); if(p && m && !m.contains(e.target)) p.style.display='none'; });
/* 部署策略搜索面板：聚焦/输入时按当前分支拉取并筛选策略；点外关闭（同分支/Tag 面板交互）。
   聚焦时先渲染面板再拉取：面板未打开时 loadDeployStrategies 不弹面板（初始化/预拉设计），
   若等拉完才渲染则整个加载过程无任何反馈，先渲染可立即看到「加载中」三点动画 */
$('deployStrategyName').addEventListener('focus', ()=>{ renderStrategyPanel(true); loadDeployStrategies().then(()=>renderStrategyPanel(true)); });
$('deployStrategyName').addEventListener('input', ()=>{ if($('strategyPanel').style.display==='none'){ loadDeployStrategies().then(()=>renderStrategyPanel()); } else { renderStrategyPanel(); } });
document.addEventListener('click', (e)=>{ const p=$('strategyPanel'); const m=$('strategyPick'); if(p && m && !m.contains(e.target)) p.style.display='none'; });
/* evalTokens 任务选择面板（阶段编辑器内动态生成）：点容器外关闭（输入框 + 面板在同一 relative 容器内） */
document.addEventListener('click', (e)=>{ document.querySelectorAll('[data-etpick-panel]').forEach(p=>{ const wrap=p.parentElement; if(p.style.display!=='none' && wrap && !wrap.contains(e.target)) p.style.display='none'; }); });
/* 定时页控制区：与主控同一套交互（环境多选 / 代码仓切换 / 分支Tag / 部署策略面板，点外关闭）；
   「清理环境」与主控同一开关——改定时页勾选即写回主控并持久化（saveCleanup 内反向同步显示） */
$('schedEnvMultiBtn').addEventListener('click', (e)=>{ e.stopPropagation(); const p=$('schedEnvMultiPanel'); p.style.display = p.style.display==='none'?'block':'none'; });
document.addEventListener('click', (e)=>{ const p=$('schedEnvMultiPanel'); const m=$('schedEnvMulti'); if(p && m && !m.contains(e.target)) p.style.display='none'; });
$('schedRepo').addEventListener('change', ()=>{ const bp=$('schedBranchPanel'); if(bp) bp.style.display='none'; loadDeployStrategies(true,'sched'); });
$('schedBranch').addEventListener('focus', ()=>{ loadRepoBranches(pickCtx('sched').repo(), false, 'sched').then(()=>renderBranchPanel(true,'sched')); });
$('schedBranch').addEventListener('change', ()=>loadDeployStrategies(false,'sched'));
$('schedBranch').addEventListener('input', ()=>{ if($('schedBranchPanel').style.display==='none'){ loadRepoBranches(pickCtx('sched').repo(), false, 'sched').then(()=>renderBranchPanel(false,'sched')); } else { renderBranchPanel(false,'sched'); } });
document.addEventListener('click', (e)=>{ const p=$('schedBranchPanel'); const m=$('schedBranchPick'); if(p && m && !m.contains(e.target)) p.style.display='none'; });
$('schedStrategy').addEventListener('focus', ()=>{ renderStrategyPanel(true,'sched'); loadDeployStrategies(false,'sched').then(()=>renderStrategyPanel(true,'sched')); });
$('schedStrategy').addEventListener('input', ()=>{ if($('schedStrategyPanel').style.display==='none'){ loadDeployStrategies(false,'sched').then(()=>renderStrategyPanel(false,'sched')); } else { renderStrategyPanel(false,'sched'); } });
document.addEventListener('click', (e)=>{ const p=$('schedStrategyPanel'); const m=$('schedStrategyPick'); if(p && m && !m.contains(e.target)) p.style.display='none'; });
$('schedCleanupEnv').addEventListener('change', (e)=>{ $('cleanupEnv').checked=e.target.checked; saveCleanup(); });
renderAll();
/* 解析插件安装目录：health 的 dir → 安装默认脚本目录；fallback 态生效值升级为安装默认（见 maybeAdoptInstalledScriptsDir），并刷新设置页回显 */
fetch('/api/worktable/health').then(r=>r.ok?r.json():null).then(h=>{
  if(h && typeof h.dir==='string' && h.dir.trim()) installedScriptsDir=h.dir.trim().replace(/\/+$/,'')+'/projects/pipeline/scripts';
  maybeAdoptInstalledScriptsDir();
  renderScriptsDirCfg();
}).catch(()=>{ renderScriptsDirCfg(); });
/* 当前浏览器标签页首次载入自动查询一次；切换项目重建 iframe 时复用结果，之后仅手动刷新。 */
let _gpuInited=!!gpuSession.initialized;
/* 从服务端拉取配置与历史（历史条目只含元数据 + 日志文件路径，全量日志在归档文件按需读取）；
   服务端有数据则覆盖本地并重渲染；拉取失败不打开写门（stateLoaded 保持 false，防覆盖服务端数据）。
   状态就绪（成功覆盖或失败保留本地）后用最终环境列表延迟刷新一次 GPU，不再阻塞首屏 */
loadServerState().finally(()=>{ scheduleGpuRefresh(); startHistoryAutoRefresh(); });
/* 从服务端拉取定时计划（服务端调度，关闭页面也会执行） */
loadPlans();
/* 服务端权威运行队列：启动即拉一次，之后每秒同步；旧浏览器在场快照仍兼容展示。
   降耗（与运行历史自动刷新同一可见性策略，后台不轮询）：页面隐藏（document.hidden）即停掉
   轮询定时器，visibilitychange 恢复可见时立即补拉一次并重启周期拉取——后台标签页零请求零重绘；
   定时器回调内仍保留 hidden 早退兜底（可见性事件未触达的环境不发请求）。 */
const QUEUE_POLL_MS=1000;
let _queuePollTimer=null;
document.addEventListener('visibilitychange',syncQueuePolling);
pullRemoteQueue();
startQueuePolling();
/* 在场保活心跳：独立 10 秒 interval 调 publishQueue(false)（签名未变且距上次上报 <10s 时自动跳过，
   恰好兜底服务端 45 秒在场 TTL）。刻意不随 document.hidden 暂停——页面隐藏时本地执行仍在继续，
   停心跳会被服务端误判失联、在跑条目被登记为孤儿中断；与上方 1 秒拉取轮询的可见性暂停策略刻意
   不同：拉取只是展示降耗，上报是存活证据。pagehide 时用 sendBeacon 补发最终快照（含 completed 且
   剔除已了结条目：关页时在跑运行已按失败落史、排队条目已移交服务端执行，本地快照不再携带它们，
   据此豁免孤儿判定；关闭瞬间刚正常终态化的条目同样经 completed 豁免；beacon 只能 POST，body 用
   text/plain Blob——服务端 readJsonBody 只按 JSON 解析正文、不校验 content-type）。 */
const QUEUE_PRESENCE_HEARTBEAT_MS=10000;
setInterval(()=>{ try{ publishQueue(false); }catch(e){} },QUEUE_PRESENCE_HEARTBEAT_MS);
window.addEventListener('pagehide',()=>{
  let handoffIds=[];
  try{ handoffIds=handoffRunsOnPageHide()||[]; }catch(e){}   // 在跑本地运行按失败落史（fail-run keepalive POST），排队条目移交服务端（见「浏览器关闭」小节）
  try{ navigator.sendBeacon('/api/worktable/pipeline/queue', new Blob([JSON.stringify(queuePublishBody({excludeIds:handoffIds}))],{type:'text/plain'})); }catch(e){}
});
