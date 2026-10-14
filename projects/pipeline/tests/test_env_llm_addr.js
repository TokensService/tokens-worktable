/* 节点环境「内网IP」改名（原 K8s InternalIP）+ 新增可选「LLM服务地址（IP:端口）」字段：
   - 节点页表单/表头/说明文案改名与新增列、输入框静态契约；
   - normalizeEnv/sameEnvEntry 规范字段含 llmAddr（三方合并不丢该字段）；
   - saveEnvForm 校验（内网IP IPv4、LLM服务地址 IPv4:端口）、编辑回填、复制携带；
   - 节点筛选与环境多选面板搜索均可按 内网IP / LLM服务地址 命中；
   - renderEnvs 行渲染 llmAddr 单元格；execScript 运行时注入 TARGET_LLM_ADDR_MAP
     （SSH 地址 → LLM服务地址，仅填了的节点，脚本显式同名参数优先）。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');
const J=x=>JSON.parse(JSON.stringify(x));

function extractFunction(name){
  const match=new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match,`pipeline.html 缺少函数 ${name}`);
  const bodyStart=source.indexOf('{',match.index);let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    else if(source[i]==='}'&&--depth===0) return source.slice(match.index,i+1);
  }
  throw new Error(`无法提取函数 ${name}`);
}
function elStub(tag){
  return {tag:tag||'div',style:{},children:[],attributes:{},innerHTML:'',textContent:'',title:'',placeholder:'',value:'',
    checked:false,disabled:false,
    setAttribute(n,v){this.attributes[n]=String(v);},getAttribute(n){return this.attributes[n]!==undefined?this.attributes[n]:null;},
    appendChild(c){this.children.push(c);return c;},
    querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){}};
}

/* ---------- 静态契约 ---------- */
test('静态契约：节点页「K8s InternalIP」改名「内网IP」，新增「LLM服务地址」输入框与列',()=>{
  assert.ok(!source.includes('K8s InternalIP（可选）'),'表单占位不再使用「K8s InternalIP」');
  assert.ok(!/<th[^>]*>K8s InternalIP<\/th>/.test(source),'表头不再使用「K8s InternalIP」');
  assert.ok(source.includes('placeholder="内网IP（可选）"'),'envNodeIp 占位应为「内网IP（可选）」');
  assert.ok(source.includes('<th>内网IP</th><th>LLM服务地址</th>'),'表头应为相邻的「内网IP」「LLM服务地址」两列');
  assert.match(source,/id="envLlmAddr"[^>]*placeholder="LLM服务地址（可选）"/,'应有 envLlmAddr 输入框');
  const iNode=source.indexOf('id="envNodeIp"'), iLlm=source.indexOf('id="envLlmAddr"'), iUser=source.indexOf('id="envUser"');
  assert.ok(iNode>0 && iNode<iLlm && iLlm<iUser,'envLlmAddr 输入框应位于 envNodeIp 与 envUser 之间');
  assert.ok(source.includes('TARGET_LLM_ADDR_MAP'),'节点页说明应注明运行时注入 TARGET_LLM_ADDR_MAP');
  assert.ok(extractFunction('normalizeEnv').includes('llmAddr'),'normalizeEnv 规范字段应含 llmAddr');
  assert.ok(extractFunction('sameEnvEntry').includes('llmAddr'),'sameEnvEntry 比对应含 llmAddr');
  assert.ok(extractFunction('execScript').includes('TARGET_LLM_ADDR_MAP'),'execScript 应注入 TARGET_LLM_ADDR_MAP');
  assert.ok(extractFunction('renderEnvs').includes('llmAddr'),'renderEnvs 行渲染应含 llmAddr');
  assert.ok(extractFunction('saveEnvForm').includes('envLlmAddr'),'saveEnvForm 应读取 envLlmAddr');
});

/* ---------- normalizeEnv / sameEnvEntry ---------- */
test('normalizeEnv：llmAddr 保留、缺省补空串、多余字段剔除；sameEnvEntry 对 llmAddr 差异敏感',()=>{
  const ctx={};
  vm.createContext(ctx);
  vm.runInContext(extractFunction('normalizeEnv')+'\n'+extractFunction('sameEnvEntry'),ctx);
  assert.deepEqual(J(ctx.normalizeEnv({id:'e1',name:'n',ip:'10.0.0.1',llmAddr:'10.0.0.1:8000',junk:1})),
    {id:'e1',name:'n',ip:'10.0.0.1',nodeIp:'',llmAddr:'10.0.0.1:8000',user:'',pass:''});
  assert.equal(ctx.normalizeEnv({id:'e2',name:'',ip:'10.0.0.2'}).llmAddr,'');
  const a={id:'e1',name:'n',ip:'10.0.0.1',nodeIp:'',llmAddr:'',user:'',pass:''};
  assert.ok(ctx.sameEnvEntry(a,Object.assign({},a)),'全字段一致为同');
  assert.ok(!ctx.sameEnvEntry(a,Object.assign({},a,{llmAddr:'10.0.0.1:8000'})),'仅 llmAddr 不同即判不同');
});

/* ---------- 表单：校验 / 编辑回填 / 复制 ---------- */
function formCtx(envs){
  const els={};
  ['envName','envIp','envNodeIp','envLlmAddr','envUser','envPass','envAdd','envCancelEdit'].forEach(id=>{ els[id]=elStub(); });
  const out={alerts:[],saved:0,rendered:0,options:0};
  const ctx={
    environments:envs, envEditId:null, Date,
    $:id=>els[id]||null,
    alert:m=>out.alerts.push(String(m)),
    saveEnvs:()=>{out.saved++;}, resetEnvForm:null,
    renderEnvs:()=>{out.rendered++;}, renderEnvOptions:()=>{out.options++;},
  };
  vm.createContext(ctx);
  vm.runInContext(['startEnvEdit','resetEnvForm','saveEnvForm','copyEnv'].map(extractFunction).join('\n'),ctx);
  return {ctx,els,out};
}
function fill(els,o){
  els.envName.value=o.name||''; els.envIp.value=o.ip||''; els.envNodeIp.value=o.nodeIp||'';
  els.envLlmAddr.value=o.llmAddr||''; els.envUser.value=o.user||''; els.envPass.value=o.pass||'';
}

test('saveEnvForm：LLM服务地址 合法（IPv4:端口）随节点保存；非法形态 alert 拦截',()=>{
  const {ctx,els,out}=formCtx([]);
  fill(els,{name:'甲',ip:'10.0.0.1',llmAddr:'10.0.0.1:8000',user:'root'});
  ctx.saveEnvForm();
  assert.deepEqual(out.alerts,[]);
  assert.equal(ctx.environments.length,1);
  assert.equal(ctx.environments[0].llmAddr,'10.0.0.1:8000','llmAddr 入列');
  assert.equal(out.saved,1,'保存落盘');
  assert.equal(els.envLlmAddr.value,'','保存后表单复位');

  ['10.0.0.1','10.0.0.1:abc','abc:8000','10.0.0.1:'].forEach(bad=>{
    const f=formCtx([]);
    fill(f.els,{ip:'10.0.0.1',llmAddr:bad});
    f.ctx.saveEnvForm();
    assert.equal(f.ctx.environments.length,0,'非法 llmAddr 不入列：'+bad);
    assert.match(f.out.alerts[0],/LLM服务地址必须是 IPv4:端口 格式/);
  });

  const f2=formCtx([]);
  fill(f2.els,{ip:'10.0.0.1',nodeIp:'not-an-ip'});
  f2.ctx.saveEnvForm();
  assert.match(f2.out.alerts[0],/内网 IP 必须是 IPv4 地址/,'内网IP 校验文案随改名');
  assert.equal(f2.ctx.environments.length,0);
});

test('startEnvEdit 回填 llmAddr，保存更新该字段；copyEnv 副本携带 nodeIp/llmAddr',()=>{
  const {ctx,els}=formCtx([{id:'env-1',name:'生产',ip:'10.0.0.1',nodeIp:'172.16.0.1',llmAddr:'172.16.0.1:8000',user:'root',pass:'p'}]);
  ctx.startEnvEdit('env-1');
  assert.equal(els.envLlmAddr.value,'172.16.0.1:8000','编辑表单回填 llmAddr');
  els.envLlmAddr.value='172.16.0.1:9000';
  ctx.saveEnvForm();
  assert.equal(ctx.environments[0].llmAddr,'172.16.0.1:9000','编辑保存更新 llmAddr');
  assert.equal(ctx.envEditId,null,'保存后退出编辑态');

  ctx.copyEnv('env-1');
  assert.equal(ctx.environments.length,2);
  assert.equal(ctx.environments[1].name,'生产（副本）');
  assert.equal(ctx.environments[1].nodeIp,'172.16.0.1','副本携带内网IP');
  assert.equal(ctx.environments[1].llmAddr,'172.16.0.1:9000','副本携带 LLM服务地址');
});

/* ---------- 节点筛选 / 面板搜索 ---------- */
test('envFilterMatch：节点页筛选可按 内网IP / LLM服务地址 命中',()=>{
  const ctx={envFilterText:'',gpuStatus:{}};
  vm.createContext(ctx);
  vm.runInContext(extractFunction('envFilterMatch'),ctx);
  const e={id:'e1',name:'生产',ip:'10.0.0.1',nodeIp:'172.16.0.1',llmAddr:'172.16.0.1:8000',user:'root'};
  ctx.envFilterText='172.16'; assert.ok(ctx.envFilterMatch(e),'内网IP 命中');
  ctx.envFilterText=':8000'; assert.ok(ctx.envFilterMatch(e),'LLM服务地址命中');
  ctx.envFilterText='不存在'; assert.ok(!ctx.envFilterMatch(e),'无匹配过滤掉');
});

test('envMultiFilterMatch：环境多选面板搜索可按 内网IP / LLM服务地址 命中',()=>{
  const ctx={};
  vm.createContext(ctx);
  vm.runInContext(extractFunction('envMultiFilterMatch'),ctx);
  const e={id:'e1',name:'生产',ip:'10.0.0.1',nodeIp:'172.16.0.1',llmAddr:'172.16.0.1:8000',user:'ops'};
  assert.ok(ctx.envMultiFilterMatch(e,'172.16'),'内网IP 命中');
  assert.ok(ctx.envMultiFilterMatch(e,'8000'),'LLM服务地址命中');
  assert.ok(!ctx.envMultiFilterMatch(e,'zzz'),'无匹配');
  assert.ok(ctx.envMultiFilterMatch(e,''),'空词不过滤');
});

/* ---------- renderEnvs 行渲染 ---------- */
test('renderEnvs：行渲染含 llmAddr 单元格（内网IP 列之后），缺省显示 —',()=>{
  const tbody=elStub('tbody');
  const table=elStub('table');
  table.querySelector=sel=>sel==='tbody'?tbody:null;
  table.querySelectorAll=()=>[];
  const els={envCount:elStub(),envTable:table};
  const ctx={
    environments:[
      {id:'env-1',name:'生产',ip:'10.0.0.1',nodeIp:'172.16.0.1',llmAddr:'172.16.0.1:8000',user:'root',pass:''},
      {id:'env-2',name:'开发',ip:'10.0.0.2',user:'',pass:''},
    ],
    envFilterText:'',gpuStatus:{},envSort:{key:null,dir:1},
    $:id=>els[id]||null,
    document:{createElement:t=>elStub(t)},
    esc:s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),
    gpuCellFull:()=>'GPUCELL', envResSummaryHtml:()=>'RES',
  };
  vm.createContext(ctx);
  vm.runInContext(['envFilterMatch','envSortVal','envSortList','renderEnvs'].map(extractFunction).join('\n'),ctx);
  ctx.renderEnvs();
  assert.equal(tbody.children.length,2);
  const row1=tbody.children[0].innerHTML, row2=tbody.children[1].innerHTML;
  assert.ok(row1.includes('>172.16.0.1<'),'内网IP 单元格');
  assert.ok(row1.indexOf('>172.16.0.1<')<row1.indexOf('>172.16.0.1:8000<'),'LLM服务地址 列在 内网IP 列之后');
  assert.ok(row1.includes('>172.16.0.1:8000<'),'LLM服务地址 单元格');
  assert.ok(row2.includes('>—<'),'缺省 llmAddr 显示 —');
});

/* ---------- execScript 注入 TARGET_LLM_ADDR_MAP ---------- */
/* execScript 依赖的 substRunVars 函数体含 '${' 字面量（不成对花括号），本套件的简易花括号提取器无法切取；
   这里用恒等桩替代（本组用例的参数值均无 ${...} 引用，行为等价）。 */
function execCtx(envs){
  const captured=[];
  const ctx={
    curRun:null, scriptsDir:'',
    substRunVars:v=>String(v===undefined||v===null?'':v),
    fetch:async(url,o)=>{ captured.push({url,body:JSON.parse(o.body)}); return {json:async()=>({code:0,stdout:'ok',stderr:''})}; },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('execScript'),ctx);
  return {ctx,captured};
}
const SC={path:'/scripts/x.sh',params:[],values:{}};

test('execScript：注入 TARGET_LLM_ADDR_MAP（仅填了 LLM服务地址 的节点；全部未填则不注入）',async()=>{
  const {ctx,captured}=execCtx();
  const rc={env:'10.0.0.1',envs:[
    {id:'e1',name:'甲',ip:'10.0.0.1',llmAddr:'172.16.0.1:8000',user:'root',pass:''},
    {id:'e2',name:'乙',ip:'10.0.0.2',nodeIp:'172.16.0.2',user:'root',pass:''},   // 无 llmAddr 不进映射
  ],vars:{}};
  await ctx.execScript(SC,0,null,rc);
  const env=captured[0].body.env;
  assert.equal(env.TARGET_LLM_ADDR_MAP,JSON.stringify({'10.0.0.1':'172.16.0.1:8000'}),'SSH 地址 → LLM服务地址 映射');
  assert.equal(env.TARGET_NODE_IP_MAP,JSON.stringify({'10.0.0.2':'172.16.0.2'}),'既有 TARGET_NODE_IP_MAP 注入不受影响');
  assert.equal(env.TARGET_IP,'10.0.0.1');

  const none=execCtx();
  await none.ctx.execScript(SC,0,null,{env:'10.0.0.1',envs:[{id:'e1',ip:'10.0.0.1',user:'',pass:''}],vars:{}});
  assert.ok(!('TARGET_LLM_ADDR_MAP' in none.captured[0].body.env),'全部节点未填 llmAddr 时整体不注入');
});

test('execScript：脚本显式配置的 TARGET_LLM_ADDR_MAP 参数优先，不被运行级注入覆盖',async()=>{
  const {ctx,captured}=execCtx();
  const sc={path:'/scripts/x.sh',params:[{key:'TARGET_LLM_ADDR_MAP',kind:'env'}],values:{TARGET_LLM_ADDR_MAP:'{"custom":"1.2.3.4:1"}'}};
  await ctx.execScript(sc,0,null,{env:'10.0.0.1',envs:[{id:'e1',ip:'10.0.0.1',llmAddr:'172.16.0.1:8000'}],vars:{}});
  assert.equal(captured[0].body.env.TARGET_LLM_ADDR_MAP,'{"custom":"1.2.3.4:1"}','显式参数优先');
});
