/* 每条流水线的 API 调用说明：端点、按运行框当前填写的参数动态生成的请求体和可复制 curl。 */
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
  const ctx=Object.assign({Array,Object,String,Set,JSON,encodeURIComponent,environments:[],repositories:[],
    $:()=>null,curEnvs:()=>[],curStrategy:()=>'',selectedPresetKeys:()=>[]},overrides);
  vm.createContext(ctx);vm.runInContext(code,ctx);return ctx;
}
function form(values){ const map=values||{}; return id=>({value:map[id]||''}); }
const J=value=>JSON.parse(JSON.stringify(value));

test('API 请求体与 curl 按运行框当前填写的参数动态生成',()=>{
  const ctx=context({
    $:form({repoSel:'repo-app',branchName:'release',triggeredBy:'alice'}),
    curEnvs:()=>[{id:'env-prod',ip:'10.0.0.8'}],
    curStrategy:()=>'blue-green',
    selectedPresetKeys:()=>['cleanup','check'],
  });
  const spec=ctx.pipelineApiSpec({id:'release 2026',name:'发布',defaults:{branch:'ignored-branch',presets:['profiling']}},'https://dsh.example');
  assert.equal(spec.endpoint,'/api/worktable/pipeline/run/release%202026');
  assert.deepEqual(J(spec.body),{
    environmentIds:['env-prod'],repositoryId:'repo-app',branch:'release',strategy:'blue-green',presets:['cleanup','check'],by:'alice',
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
    environmentIds:['env-dev'],repositoryId:'repo-app',branch:'main',strategy:'',presets:[],by:'api',
  });
});

test('当前未选中环境/代码仓时省略对应字段并给出警告（显式空值会被服务端 400 拒绝）',()=>{
  const ctx=context({$:form({branchName:'dev'})});
  const spec=ctx.pipelineApiSpec({id:'pl-2'},'https://dsh.example');
  assert.ok(!('environmentIds' in spec.body),'无有效环境时应省略 environmentIds，由服务端回退默认配置');
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
