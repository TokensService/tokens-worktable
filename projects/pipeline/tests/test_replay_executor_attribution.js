// 执行人归属回归：历史回放/重跑不得把记录作者（如内置演示数据的 release-manager）当作当前用户。
// 背景：enterHistoryReplay 曾把 rec.by 回填进「执行人」输入框，该值随后被配置/localStorage 持久化，
// 使 fillExecutorFromAuth 因输入框非空而跳过 /auth/status 探测，执行人长期错署为历史记录作者。
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function extractFunction(name){
  const match=new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match,`pipeline.html 缺少函数 ${name}`);
  const bodyStart=source.indexOf('{',match.index);let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    else if(source[i]==='}'&&--depth===0) return source.slice(match.index,i+1);
  }
  throw new Error(`无法提取函数 ${name}`);
}

test('历史回放不回填「执行人」输入框，原执行人仅在回放状态行展示',async()=>{
  const els={
    triggeredBy:{value:'alice'},
    branchName:{value:''},
    deployStrategyName:{value:''},
    overall:{firstChild:null},
    overallBy:{textContent:''},
    replayTip:{textContent:''},
    stopBtn:{disabled:false},
    repoSel:{value:''},
  };
  const ctx={
    viewRc:null, curRun:null, replayRec:null, runStages:null, selectedId:null, _detailKey:'x',
    pipelines:[{id:'pl-a',name:'K8s 应用安装',stages:[{id:'s1',name:'构建'}]}],
    curPipelineId:'pl-a',
    findPipeline:id=>ctx.pipelines.find(p=>p.id===id)||null,
    renderPipelineSel:()=>{}, renderPipelines:()=>{},
    withPresetMarkers:stages=>stages,
    PRESET_BY_NAME:{}, presetMarker:()=>({}),
    rebuildReplayNodes:()=>{},
    environments:[], selectedEnvIds:[], renderEnvOptions:()=>{},
    repositories:[], curRepoId:'',
    $:id=>els[id]||null,
    labelOf:s=>s, setOverall:()=>{},
    renderFlow:()=>{}, renderDetail:()=>{},
    loadReplayLogs:async()=>{},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('enterHistoryReplay'),ctx);
  ctx.enterHistoryReplay({no:46, pipeline:'K8s 应用安装', pipelineId:'pl-a', env:'', status:'success', time:'今天 09:14', by:'release-manager', demo:true, logs:[]});
  assert.equal(els.triggeredBy.value,'alice','回放不得把历史记录作者写回执行人输入框（含演示数据 release-manager）');
  assert.match(els.overallBy.textContent,/release-manager/,'原执行人仍在回放状态行展示');
  assert.match(els.overallBy.textContent,/历史回放/);
});

test('历史重跑不沿用记录作者：执行人由 runPipeline 取当前输入框值；必填拦截时不误报「已开始」',()=>{
  const calls={opts:[],tips:[],alerts:[]};
  const ctx={
    findPipeline:()=>null,
    pipelines:[{id:'pl-a',name:'K8s 应用安装'}],
    environments:[], repositories:[],
    runPipeline:opts=>{ calls.opts.push(opts); return true; },
    alert:t=>calls.alerts.push(t),
    flashRunTip:t=>calls.tips.push(t),
    QUEUE_CAP:8, queue:[],
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('rerunFromHistory'),ctx);
  ctx.rerunFromHistory({no:46, pipeline:'K8s 应用安装', by:'release-manager', branch:'main', strategy:'', env:''});
  assert.equal(calls.opts.length,1);
  assert.ok(!('by' in calls.opts[0]),'重跑不得把历史记录作者作为执行人传给 runPipeline（应取当前输入框值）');
  assert.match(calls.tips[0],/已开始重跑 #46/);

  /* 执行人必填被 runPipeline 拦截（返回 no-by）时，不再叠加「已开始重跑」误导提示 */
  calls.opts.length=0; calls.tips.length=0;
  ctx.runPipeline=()=>'no-by';
  ctx.rerunFromHistory({no:47, pipeline:'K8s 应用安装', by:'release-manager', branch:'main', strategy:'', env:''});
  assert.deepEqual(calls.tips,[],'no-by 拦截时不得闪「已开始重跑」提示');
});
