/* plEditable 的 admin 例外：非可信/非内置流水线，创建者之外的登录用户仅当 currentUserIsAdmin 时可编辑
   （解决创建者账号注销/改名后流水线对所有人锁死的问题）；内置/可信流水线仍仅 admin 可编辑
   （创建者本人也无例外）；未署名存量全员可编辑（保存时补署创建者）；auth 探测在途保守只读，
   探测完成仍无登录用户（token 共享模式/未装认证插件/探测失败）退化为全权；
   currentUserIsAdmin 全局缺失（旧测试桩环境）按非 admin 处理。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

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

/* plEditable 提取运行（真实 plOwnerOf 一并提取，走 typeof plOwnerOf==='function' 的主路径，更贴近真实）：
   按场景注入 currentUsername/authReady/currentUserIsAdmin 三个全局；
   需覆盖「全局未定义」场景时不放对应键（走 typeof 守卫分支）。 */
function loadPlEditable(globals){
  const ctx=Object.assign({String},globals||{});
  vm.createContext(ctx);
  vm.runInContext(extractFunction('plOwnerOf')+'\n'+extractFunction('plEditable'),ctx);
  return ctx;
}

test('plEditable：无流水线对象（null/undefined）安全返回只读',()=>{
  const ctx=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:true});
  assert.equal(ctx.plEditable(null),false,'null 安全返回只读');
  assert.equal(ctx.plEditable(undefined),false,'undefined 安全返回只读');
});

test('plEditable：内置/可信流水线无登录用户——探测在途（authReady=false）保守只读，探测完成（token 模式退化）全权',()=>{
  const pending=loadPlEditable({currentUsername:'',authReady:false});
  assert.equal(pending.plEditable({id:'pl-bi',name:'x',builtIn:true}),false,'内置：探测在途保守只读');
  assert.equal(pending.plEditable({id:'pl-tr',name:'x',trusted:true}),false,'可信：探测在途保守只读');
  const token=loadPlEditable({currentUsername:'',authReady:true});
  assert.equal(token.plEditable({id:'pl-bi',name:'x',builtIn:true}),true,'内置：token 模式退化全权');
  assert.equal(token.plEditable({id:'pl-tr',name:'x',trusted:true}),true,'可信：token 模式退化全权');
});

test('plEditable：内置/可信流水线有登录用户——仅 admin 可编辑，非 admin（含创建者本人）只读',()=>{
  const admin=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:true});
  assert.equal(admin.plEditable({id:'pl-bi',name:'x',builtIn:true}),true,'admin 可编辑内置流水线');
  assert.equal(admin.plEditable({id:'pl-tr',name:'x',trusted:true,createdBy:'bob'}),true,'admin 可编辑可信流水线');
  const plain=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:false});
  assert.equal(plain.plEditable({id:'pl-bi',name:'x',builtIn:true,createdBy:'alice'}),false,'非 admin 即使是创建者也不能编辑内置流水线');
  assert.equal(plain.plEditable({id:'pl-tr',name:'x',trusted:true,createdBy:'alice'}),false,'非 admin 即使是创建者也不能编辑可信流水线');
});

test('plEditable：未署名（无 createdBy）存量流水线任意身份均可编辑',()=>{
  const pending=loadPlEditable({currentUsername:'',authReady:false});
  assert.equal(pending.plEditable({id:'pl-a',name:'x'}),true,'探测在途：未署名仍可编辑');
  assert.equal(pending.plEditable({id:'pl-b',name:'x',createdBy:'  '}),true,'空白署名按未署名处理');
  const token=loadPlEditable({currentUsername:'',authReady:true});
  assert.equal(token.plEditable({id:'pl-c',name:'x'}),true,'token 模式：未署名可编辑');
  const plain=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:false});
  assert.equal(plain.plEditable({id:'pl-d',name:'x'}),true,'非 admin 登录用户可编辑未署名流水线');
  const admin=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:true});
  assert.equal(admin.plEditable({id:'pl-e',name:'x'}),true,'admin 可编辑未署名流水线');
});

test('plEditable：署名=当前用户（创建者本人）可编辑',()=>{
  const plain=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:false});
  assert.equal(plain.plEditable({id:'pl-a',name:'x',createdBy:'alice'}),true,'本人创建可编辑');
  const admin=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:true});
  assert.equal(admin.plEditable({id:'pl-b',name:'x',createdBy:'alice'}),true,'admin 编辑本人创建的流水线不受影响');
});

test('plEditable：署名=他人且当前用户非 admin 时只读',()=>{
  const plain=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:false});
  assert.equal(plain.plEditable({id:'pl-a',name:'x',createdBy:'bob'}),false,'他人创建的非可信流水线对非 admin 只读');
});

test('admin 可编辑他人创建的非可信流水线（创建者注销不锁死）',()=>{
  const admin=loadPlEditable({currentUsername:'alice',authReady:true,currentUserIsAdmin:true});
  assert.equal(admin.plEditable({id:'pl-a',name:'x',createdBy:'bob'}),true,'admin 可编辑他人创建的非可信流水线');
  assert.equal(admin.plEditable({id:'pl-b',name:'y',createdBy:'carol'}),true,'创建者账号已注销（仅留署名）时 admin 仍可编辑');
});

test('plEditable：署名流水线无登录用户——探测在途（authReady=false）保守只读，探测完成（token 模式）退化全权',()=>{
  const pending=loadPlEditable({currentUsername:'',authReady:false});
  assert.equal(pending.plEditable({id:'pl-a',name:'x',createdBy:'bob'}),false,'探测在途：署名流水线保守只读');
  const token=loadPlEditable({currentUsername:'',authReady:true});
  assert.equal(token.plEditable({id:'pl-a',name:'x',createdBy:'bob'}),true,'探测完成仍无用户（token 模式）：退化为全权');
});

test('plEditable：currentUserIsAdmin 全局未定义（旧测试桩环境）时，署名=他人有登录用户仍只读',()=>{
  const ctx=loadPlEditable({currentUsername:'alice',authReady:true});   // 不放 currentUserIsAdmin 键，走 typeof 守卫
  assert.equal(vm.runInContext('typeof currentUserIsAdmin',ctx),'undefined','前提：currentUserIsAdmin 全局确实未定义');
  assert.equal(ctx.plEditable({id:'pl-a',name:'x',createdBy:'bob'}),false,'admin 全局缺失按非 admin 处理：他人创建只读');
  assert.equal(ctx.plEditable({id:'pl-b',name:'x',createdBy:'alice'}),true,'admin 全局缺失不影响创建者本人编辑');
});
