/* 每条流水线的 API 调用说明：端点、完整请求体和可复制 curl。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function section(begin,end){
  const start=source.indexOf(begin),finish=source.indexOf(end,start);
  assert.ok(start>=0&&finish>start,`缺少实现区段 ${begin}`);
  return source.slice(start,finish);
}
function context(overrides={}){
  const code=section('/* ---------- 流水线默认运行参数 ---------- */','/* ---------- 流水线默认运行参数结束 ---------- */')+'\n'+
    section('/* ---------- 流水线 API 调用说明 ---------- */','/* ---------- 流水线 API 调用说明结束 ---------- */');
  const ctx=Object.assign({Array,Object,String,Set,JSON,encodeURIComponent,environments:[],repositories:[]},overrides);vm.createContext(ctx);vm.runInContext(code,ctx);return ctx;
}
const J=value=>JSON.parse(JSON.stringify(value));

test('API 调用说明包含编码后的流水线端点与全部可覆盖参数',()=>{
  const ctx=context();
  const spec=ctx.pipelineApiSpec({id:'release 2026',name:'发布',defaults:{
    environmentIds:['env-prod'],repositoryId:'repo-app',branch:'release',strategy:'blue-green',presets:['cleanup','check'],
  }},'https://dsh.example');
  assert.equal(spec.endpoint,'/api/worktable/pipeline/run/release%202026');
  assert.deepEqual(J(spec.body),{
    environmentIds:['env-prod'],repositoryId:'repo-app',branch:'release',strategy:'blue-green',presets:['cleanup','check'],by:'api',
  });
  assert.match(spec.curl,/curl -X POST/);
  assert.match(spec.curl,/https:\/\/dsh\.example\/api\/worktable\/pipeline\/run\/release%202026/);
  assert.match(spec.curl,/-b cookies\.txt/,'受登录守卫保护的 API 示例应携带 cookie 文件');
  assert.match(spec.curl,/environmentIds/);
});

test('API 调用说明弹窗包含端点、JSON、curl 与复制入口',()=>{
  ['pipelineApiDialog','pipelineApiEndpoint','pipelineApiBody','pipelineApiCurl','pipelineApiCopyEndpoint','pipelineApiCopyBody','pipelineApiCopyCurl'].forEach(id=>{
    assert.ok(source.includes('id="'+id+'"'),'缺少 API 弹窗元素 '+id);
  });
});

test('旧流水线的 API 示例展示实际生效的首个环境和代码仓，而不是无效空 ID',()=>{
  const ctx=context({
    environments:[{id:'env-first',ip:'10.0.0.1'}],
    repositories:[{id:'repo-first',url:'first.git'}],
  });
  const spec=ctx.pipelineApiSpec({id:'legacy',name:'旧流水线'},'https://dsh.example');
  assert.deepEqual(J(spec.body.environmentIds),['env-first']);
  assert.equal(spec.body.repositoryId,'repo-first');
});
