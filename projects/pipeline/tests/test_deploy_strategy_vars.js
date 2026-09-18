const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');
/* 与 test_stage_variable_precedence.js 同一切片：substRunVars（含普罗模板解析 substPromTemplate）到 execScript 之间 */
const start=source.indexOf('function substRunVars(v, rc)');
const end=source.indexOf('async function runScriptStep(rc, i)',start);
if(start<0||end<0)throw new Error('substRunVars/execScript not found');
function load(){
  const ctx={JSON};
  vm.createContext(ctx);
  vm.runInContext(`let curRun = null; let scriptsDir = "/tmp/scripts";\n${source.slice(start,end)}`,ctx);
  return ctx;
}
test('未选择部署策略时 ${DEPLOY_STRATEGY} 保持未解析，不再静默解析为空串',()=>{
  const ctx=load();
  const rc={strategy:'',by:'lhf',vars:{}};   // 运行上下文一律把未选择的策略兜底为空串
  // 复合引用：占位符原样保留（修复前 look.DEPLOY_STRATEGY='' 使结果被静默清空为 'arch='）
  assert.equal(ctx.substRunVars('arch=${DEPLOY_STRATEGY}',rc),'arch=${DEPLOY_STRATEGY}');
  // 整值单个未解析引用按空值处理（env 参数空 = 继承上游/运行级同名变量）
  assert.equal(ctx.substRunVars('${DEPLOY_STRATEGY}',rc),'');
  // 选择策略后正常替换
  assert.equal(ctx.substRunVars('arch=${DEPLOY_STRATEGY}',{strategy:'arch-a',by:'lhf'}),'arch=arch-a');
  // 上游阶段变量同名优先：stdout 产出的 DEPLOY_STRATEGY 即使未选策略也生效
  assert.equal(ctx.substRunVars('arch=${DEPLOY_STRATEGY}',{strategy:'',vars:{DEPLOY_STRATEGY:'from-upstream'}}),'arch=from-upstream');
});
test('普罗命名空间模板在部署策略/执行人解析不出时按不注入处理（substPromTemplate）',()=>{
  const ctx=load();
  // 未选策略：整体解析不出（修复前得到 '-lhf' 残段并当作有效值注入 NAMESPACE/XDS_NAMESPACE）
  assert.equal(ctx.substPromTemplate('${DEPLOY_STRATEGY}-${BY}',{strategy:'',by:'lhf'}),'');
  // 有策略无执行人：同样解析不出
  assert.equal(ctx.substPromTemplate('${DEPLOY_STRATEGY}-${BY}',{strategy:'arch-a'}),'');
  // 策略 + 执行人：正常解析
  assert.equal(ctx.substPromTemplate('${DEPLOY_STRATEGY}-${BY}',{strategy:'arch-a',by:'lhf'}),'arch-a-lhf');
  // 上游产出 MODEL_PATH 正常解析；未产出按不注入处理
  assert.equal(ctx.substPromTemplate('${MODEL_PATH}',{strategy:'s',by:'b',vars:{MODEL_PATH:'/models/x'}}),'/models/x');
  assert.equal(ctx.substPromTemplate('${MODEL_PATH}',{strategy:'s',by:'b'}),'');
});
