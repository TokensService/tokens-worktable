/* 每条流水线的 API 调用说明：端点、按运行框当前填写的参数动态生成的请求体和可复制 curl，
   以及「▶ 直接调用」——页面内同源发起一次真实 POST 并内联展示结果（免导出 Cookie 验证）。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function section(begin,end){
  const start=source.indexOf(begin),finish=source.indexOf(end,start);
  assert.ok(start>=0&&finish>start,`缺少实现区段 ${begin}`);
  return source.slice(start,finish);
}
/* 运行框当前取值经 $/curEnvs/curStrategy/selectedPresetKeys 注入，模拟主控区已填写的运行参数 */
function context(overrides={}){
  const code=section('/* ---------- 流水线默认运行参数 ---------- */','/* ---------- 流水线默认运行参数结束 ---------- */')+'\n'+
    section('/* ---------- 流水线 API 调用说明 ---------- */','/* ---------- 流水线 API 调用说明结束 ---------- */');
  /* currentUsername：执行人只读、固定取登录用户后的唯一读取点；缺省留空（回退 api），用例按需覆盖 */
  const ctx=Object.assign({Array,Object,String,Set,JSON,encodeURIComponent,environments:[],repositories:[],currentUsername:'',
    $:()=>null,curEnvs:()=>[],curStrategy:()=>'',curWeightsPath:()=>'',selectedPresetKeys:()=>[]},overrides);
  vm.createContext(ctx);vm.runInContext(code,ctx);return ctx;
}
function form(values){ const map=values||{}; return id=>({value:map[id]||''}); }
const J=value=>JSON.parse(JSON.stringify(value));

test('API 请求体与 curl 按运行框当前填写的参数动态生成',()=>{
  const ctx=context({
    $:form({repoSel:'repo-app',branchName:'release'}),
    currentUsername:'alice',
    curEnvs:()=>[{id:'env-prod',ip:'10.0.0.8'}],
    curStrategy:()=>'blue-green',
    curWeightsPath:()=>'/models/glm52',
    selectedPresetKeys:()=>['cleanup','check'],
  });
  const spec=ctx.pipelineApiSpec({id:'release 2026',name:'发布',defaults:{branch:'ignored-branch',presets:['profiling']}},'https://dsh.example');
  assert.equal(spec.endpoint,'/api/worktable/pipeline/run/release%202026');
  assert.deepEqual(J(spec.body),{
    environmentIds:['env-prod'],repositoryId:'repo-app',branch:'release',strategy:'blue-green',weightsPath:'/models/glm52',presets:['cleanup','check'],by:'alice',
  });
  assert.equal(spec.warning,'');
  assert.match(spec.curl,/curl -X POST/);
  assert.match(spec.curl,/https:\/\/dsh\.example\/api\/worktable\/pipeline\/run\/release%202026/);
  assert.match(spec.curl,/-b cookies\.txt/,'受登录守卫保护的 API 示例应携带 cookie 文件');
  assert.match(spec.curl,/env-prod/,'curl 应携带运行框当前选中的环境');
});

test('分支与执行人留空时回退 main 与 api，空策略/空预设显式覆盖流水线默认值',()=>{
  const ctx=context({
    $:form({repoSel:'repo-app'}),
    curEnvs:()=>[{id:'env-dev'}],
  });
  const spec=ctx.pipelineApiSpec({id:'pl-1',defaults:{branch:'trunk',strategy:'canary',presets:['check']}},'https://dsh.example');
  assert.deepEqual(J(spec.body),{
    environmentIds:['env-dev'],repositoryId:'repo-app',branch:'main',strategy:'',weightsPath:'',presets:[],by:'api',
  });
});

test('当前未选中环境即显式空数组（不选择任何节点），未选中代码仓时省略该字段并给出警告',()=>{
  const ctx=context({$:form({branchName:'dev'})});
  const spec=ctx.pipelineApiSpec({id:'pl-2'},'https://dsh.example');
  assert.deepEqual(J(spec.body.environmentIds),[],'未选中环境时 environmentIds 为显式空数组（无目标节点运行）');
  assert.ok(!('repositoryId' in spec.body),'无有效代码仓时应省略 repositoryId，由服务端回退默认配置');
  assert.match(spec.warning,/目标环境/);
  assert.match(spec.warning,/代码仓/);
});

test('API 调用说明弹窗包含端点、JSON、curl 与复制入口',()=>{
  ['pipelineApiDialog','pipelineApiEndpoint','pipelineApiWarning','pipelineApiBody','pipelineApiCurl','pipelineApiCopyEndpoint','pipelineApiCopyBody','pipelineApiCopyCurl'].forEach(id=>{
    assert.ok(source.includes('id="'+id+'"'),'缺少 API 弹窗元素 '+id);
  });
  assert.match(source,/repository.*name\/url\/user\/pass/,'弹窗应说明一次性代码仓凭据覆盖字段');
  assert.match(source,/\$\('pipelineApiBody'\)\.textContent=spec\.bodyText/,'警告不能混入可复制的 JSON 请求体');
});

test('API 弹窗含「直接调用」按钮与内联结果区，点击经 invokePipelineApi 同源发起 POST 并接入运行跟随',()=>{
  ['pipelineApiInvoke','pipelineApiResult'].forEach(id=>assert.ok(source.includes('id="'+id+'"'),'缺少 API 弹窗元素 '+id));
  assert.match(source,/\$\('pipelineApiInvoke'\)\.addEventListener\('click'/,'「直接调用」按钮未接线');
  assert.match(source,/fetch\(spec\.endpoint,\{method:'POST',headers:\{'Content-Type':'application\/json'\},body:JSON\.stringify\(spec\.body\)\}\)/,'应按弹窗展示的端点与请求体原样 POST');
  assert.match(source,/pipelineApiCur=\{endpoint:spec\.endpoint,body:spec\.body\}/,'showPipelineApi 应冻结当前展示规范供直接调用');
  assert.match(source,/pendingServerRunFocus=\{runId:String\(result\.runId\)/,'202 受理后应接入运行跟随机制');
});

function fakeEl(){ return {textContent:'',style:{},disabled:false,value:''}; }

test('直接调用：按弹窗冻结的端点与请求体原样 POST，202 后内联展示 runId 并拉取队列跟随',async()=>{
  const els={}; const $=id=>els[id]||(els[id]=fakeEl());
  const calls=[];
  const ctx=context({
    $, location:{origin:'https://dsh.example'}, Promise, Date,
    fetch:async(url,opts)=>{ calls.push({url,opts}); return {status:202,json:async()=>({ok:true,accepted:true,runId:'api-x1',pipelineName:'发布'})}; },
    pullRemoteQueue:async()=>{ ctx.__pulled=(ctx.__pulled||0)+1; },
    followPendingServerRun:()=>{ ctx.__followed=(ctx.__followed||0)+1; },
    SERVER_RUN_FOCUS_MS:15000,
  });
  ctx.showPipelineApi({id:'pl-9',name:'发布',defaults:{branch:'trunk'}});
  await ctx.invokePipelineApi();
  assert.equal(calls.length,1,'应只发起一次调用');
  assert.equal(calls[0].url,'/api/worktable/pipeline/run/pl-9');
  assert.equal(calls[0].opts.method,'POST');
  assert.equal(calls[0].opts.headers['Content-Type'],'application/json');
  assert.deepEqual(J(JSON.parse(calls[0].opts.body)),J(JSON.parse(els.pipelineApiBody.textContent)),'请求体应与弹窗展示一致');
  assert.match(els.pipelineApiResult.textContent,/api-x1/,'结果区应展示 runId');
  assert.equal(els.pipelineApiResult.style.display,'','结果区应可见');
  assert.equal(els.pipelineApiInvoke.disabled,false,'结束后按钮恢复可用');
  assert.equal(els.pipelineApiInvoke.textContent,'▶ 直接调用');
  assert.equal(ctx.__pulled,1,'202 后应拉取远端队列');
  assert.equal(ctx.__followed,1,'202 后应触发运行跟随');
  assert.equal(ctx.pendingServerRunFocus&&ctx.pendingServerRunFocus.runId,'api-x1');
});

test('直接调用失败路径：非 202 内联展示服务端错误，网络异常不向外抛出',async()=>{
  const els={}; const $=id=>els[id]||(els[id]=fakeEl());
  const ctx=context({
    $, location:{origin:'https://dsh.example'}, Promise, Date,
    fetch:async()=>({status:403,json:async()=>({error:'reserved',message:'节点预留给他人'})}),
  });
  ctx.showPipelineApi({id:'pl-9',name:'发布'});
  await ctx.invokePipelineApi();
  assert.match(els.pipelineApiResult.textContent,/403/);
  assert.match(els.pipelineApiResult.textContent,/reserved|节点预留/);
  assert.equal(els.pipelineApiInvoke.disabled,false);
  // 网络异常
  const els2={}; const $2=id=>els2[id]||(els2[id]=fakeEl());
  const ctx2=context({ $:$2, location:{origin:'https://dsh.example'}, Promise, Date, fetch:async()=>{ throw new Error('conn refused'); } });
  ctx2.showPipelineApi({id:'pl-9',name:'发布'});
  await ctx2.invokePipelineApi();
  assert.match(els2.pipelineApiResult.textContent,/网络错误.*conn refused/);
  assert.equal(els2.pipelineApiInvoke.disabled,false);
});
