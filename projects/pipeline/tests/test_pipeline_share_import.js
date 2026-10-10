/* 流水线分享 / 从分享导入：行「⋯」菜单「分享」复制定义 JSON 到剪贴板，
   「新建流水线 → 从分享导入」弹出 textarea 输入框，粘贴还原到编辑器（名称/业务阶段/默认运行参数）。
   覆盖：分享载荷形状（不含实例元数据、不带预设任务）、解析合法/非法（预设剥除）、弹窗开关、
   textarea 导入填表、菜单与按钮 wiring。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function extractFunction(name){
  const match=new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match,`pipeline.html 缺少函数 ${name}`);
  const bodyStart=source.indexOf('{',match.index);
  let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    else if(source[i]==='}'&&--depth===0) return source.slice(match.index,i+1);
  }
  throw new Error(`无法提取函数 ${name}`);
}

function makeCtx(overrides={},names=[]){
  const ctx=Object.assign({
    console, JSON, Object, Array, String, Number, Boolean, Date, Math, RegExp, Error, Promise, Set, Map, parseInt, isFinite, navigator:{},
    PIPELINE_DEFAULT_PRESET_KEYS:['cleanup','check','profiling'],
    normalizePipelineDefaults:v=>{
      const d=v&&typeof v==='object'&&!Array.isArray(v)?v:{};
      return {
        environmentIds:Array.isArray(d.environmentIds)?d.environmentIds.filter(x=>typeof x==='string'):[],
        repositoryId:typeof d.repositoryId==='string'?d.repositoryId.trim():'',
        branch:typeof d.branch==='string'&&d.branch.trim()?d.branch.trim():'main',
        strategy:typeof d.strategy==='string'?d.strategy.trim():'',
        presets:Array.isArray(d.presets)?d.presets.filter(k=>['cleanup','check','profiling'].indexOf(k)>=0):[],
      };
    },
  },overrides);
  vm.createContext(ctx);
  if(names.length) vm.runInContext(names.map(extractFunction).join('\n'),ctx);
  return ctx;
}

const J=x=>JSON.parse(JSON.stringify(x));

function samplePipeline(){
  return {
    id:'pl-abc', name:'安装部署YDS', builtIn:false, pinnedAt:123, favoriteUsers:['alice'], trusted:true,
    createdBy:'alice', updatedBy:'bob', prom:{x:1},
    defaults:{environmentIds:['env-1'],repositoryId:'r1',branch:'0830_dev',strategy:'arch-a',presets:['cleanup']},
    stages:[
      {id:'',name:'环境清理',preset:true,pkey:'cleanup'},
      {id:'st0',name:'检出',dur:1,kind:'simulate',sub:[]},
      {id:'st1',name:'构建',dur:2,kind:'shell',script:{name:'build.sh',path:'/s/build.sh',lang:'sh',params:[{key:'IMG',required:true}],values:{IMG:'app:1'},outVars:'IMAGE=image'},sched:{}},
      {id:'',name:'Profiling',preset:true,pkey:'profiling'},
    ],
  };
}

test('分享载荷：kind=pipeline-share，只含名称/业务阶段/默认运行参数，不含 id/内置/置顶/收藏/可信/署名，也不带预设任务',()=>{
  const pl=samplePipeline();
  const ctx=makeCtx({},['buildPipelineShare']);
  const share=ctx.buildPipelineShare(pl);
  assert.equal(share.app,'worktable-pipeline');
  assert.equal(share.kind,'pipeline-share');
  assert.equal(share.version,1);
  assert.ok(typeof share.exportedAt==='string'&&share.exportedAt.length>0);
  assert.equal(share.pipeline.name,'安装部署YDS');
  assert.equal(share.pipeline.stages.length,2,'预设标记行不进分享载荷');
  assert.ok(share.pipeline.stages.every(s=>!s.preset),'分享阶段不得含预设标记行');
  assert.equal(share.pipeline.stages[1].script.values.IMG,'app:1');
  assert.deepEqual(J(share.pipeline.defaults),{environmentIds:['env-1'],repositoryId:'r1',branch:'0830_dev',strategy:'arch-a',presets:[]},'默认运行参数不带预设勾选');
  const flat=JSON.stringify(share);
  ['pl-abc','builtIn','pinnedAt','favoriteUsers','trusted','createdBy','updatedBy'].forEach(k=>{
    assert.ok(flat.indexOf(k)<0,`分享载荷不得包含实例字段 ${k}`);
  });
  assert.ok(flat.indexOf('pkey')<0&&flat.indexOf('环境清理')<0,'分享载荷不得出现预设任务痕迹');
  /* 深拷贝：改分享载荷不影响源流水线（预设行仍在源 stages 里） */
  share.pipeline.stages[0].name='改过';
  assert.equal(pl.stages[1].name,'检出');
  assert.equal(pl.stages.length,4,'源流水线 stages 不被分享载荷改动');
});

test('sharePipeline：把 pretty JSON 写入剪贴板并 toast 提示',()=>{
  const copied=[],toasts=[];
  const pl=samplePipeline();
  const ctx=makeCtx({
    findPipeline:id=>id===pl.id?pl:null,
    copyText:text=>copied.push(text),
    toast:msg=>toasts.push(msg),
  },['buildPipelineShare','sharePipeline']);
  ctx.sharePipeline('pl-abc');
  assert.equal(copied.length,1);
  const data=JSON.parse(copied[0]);
  assert.equal(data.kind,'pipeline-share');
  assert.equal(data.pipeline.name,'安装部署YDS');
  assert.ok(copied[0].indexOf('\n')>0,'分享内容应为缩进 pretty JSON，便于聊天工具粘贴');
  assert.equal(data.pipeline.stages.length,2,'剪贴板载荷不带预设标记行');
  assert.deepEqual(J(data.pipeline.defaults.presets),[],'剪贴板载荷不带默认预设勾选');
  assert.equal(toasts.length,1);
  assert.match(toasts[0],/分享内容/);
  /* 未知 id 不动作 */
  ctx.sharePipeline('nope');
  assert.equal(copied.length,1);
});

test('parsePipelineShare：envelope / 裸流水线对象 / 非法输入；预设标记行与默认勾选一律剥除',()=>{
  const ctx=makeCtx({},['parsePipelineShare']);
  const pl=samplePipeline();
  const envelope=JSON.stringify({app:'worktable-pipeline',kind:'pipeline-share',version:1,pipeline:{name:pl.name,stages:pl.stages,defaults:pl.defaults}});
  const ok=ctx.parsePipelineShare(envelope);
  assert.ok(ok,'envelope 应可解析');
  assert.equal(ok.name,'安装部署YDS');
  assert.equal(ok.stages.length,2,'含预设标记的旧载荷解析后只留业务阶段');
  assert.ok(ok.stages.every(s=>!s.preset));
  assert.equal(ok.defaults.branch,'0830_dev');
  assert.deepEqual(J(ok.defaults.presets),[],'默认预设勾选不随分享导入');
  /* 裸流水线对象（直接粘贴 stages） */
  const bare=ctx.parsePipelineShare(JSON.stringify({name:'裸的',stages:[{id:'a',name:'A'},{id:'',name:'环境清理',preset:true,pkey:'cleanup'}],defaults:{branch:'dev',presets:['check']}}));
  assert.ok(bare&&bare.name==='裸的'&&bare.stages.length===1,'裸对象同样剥掉预设标记行');
  assert.deepEqual(J(bare.defaults.presets),[]);
  /* 前后空白可解析 */
  assert.ok(ctx.parsePipelineShare('  '+envelope+'  '));
  /* 非法：非 JSON / 空 / 数组 / 无 stages / 仅预设行 / envelope 无 pipeline / stages 非对象元素 */
  ['', 'not-json', 'null', '[]', '{}', JSON.stringify({kind:'pipeline-share'}), JSON.stringify({stages:[]}), JSON.stringify({stages:['x']}),
   JSON.stringify({stages:[{id:'',name:'环境清理',preset:true,pkey:'cleanup'}]})].forEach(bad=>{
    assert.equal(ctx.parsePipelineShare(bad),null,`应判非法: ${String(bad).slice(0,40)}`);
  });
});

test('applyPipelineShareText：从 textarea 内容覆盖表单（名称/阶段/默认）并存草稿、关弹窗',async ()=>{
  const pl=samplePipeline();
  const shareText=JSON.stringify({app:'worktable-pipeline',kind:'pipeline-share',version:1,pipeline:{name:pl.name,stages:pl.stages,defaults:pl.defaults}},null,2);
  const els={
    plName:{value:''},
    plForm:{dataset:{editId:''}},
    plShareImportDialog:{style:{display:'flex'}},
    plShareImportTip:{textContent:'',style:{}},
  };
  const drafts=[],renders=[],toasts=[],tips=[];
  const shared={
    plFormReadOnly:false,
    editStages:[], editDefaults:null, editSelStage:{x:1}, editFocusIdx:3,
    $:id=>els[id]||{value:'',dataset:{},style:{}},
    toast:m=>toasts.push(m),
    plShareImportTipShow:(msg,bad)=>tips.push({msg,bad}),
    renderPipelineDefaultForm:()=>renders.push('defaults'),
    renderStageEditor:()=>renders.push('stages'),
    schedulePlDraftSave:()=>drafts.push(1),
    loadScripts:()=>Promise.resolve(),
    detectStageParams:async()=>null,
    detectEvaltokStageParams:async()=>null,
    normalizePipelineDefaults:null,
  };
  shared.normalizePipelineDefaults=makeCtx().normalizePipelineDefaults;
  const ctx=makeCtx(shared,['editStagesFromStored','parsePipelineShare','applyPipelineShareText','closePipelineShareImport']);
  /* editStagesFromStored 依赖的 normalizeStageKind / withPresetMarkers / evaltokensStageConfig 一并注入 */
  vm.runInContext([
    extractFunction('evaltokensStageConfig'),
    extractFunction('normalizeStageKind'),
    extractFunction('withPresetMarkers'),
    "function presetMarker(k){ return {id:'', name:'', preset:true, pkey:k}; }",
  ].join('\n'),ctx);
  const r=await ctx.applyPipelineShareText(shareText);
  assert.equal(r,'ok');
  assert.equal(els.plName.value,'安装部署YDS');
  assert.equal(ctx.editStages.length,5,'两业务阶段 + cleanup/check/profiling 预设标记（withPresetMarkers 按本端设置补齐）');
  assert.equal(ctx.editStages.filter(s=>!s.preset).length,2);
  assert.equal(ctx.editStages.filter(s=>!s.preset)[1].script.values.IMG,'app:1');
  assert.equal(ctx.editDefaults.branch,'0830_dev');
  assert.deepEqual(J(ctx.editDefaults.presets),[],'导入后默认预设勾选为空（分享不带预设任务）');
  assert.equal(ctx.editSelStage,null);
  assert.equal(ctx.editFocusIdx,-1);
  assert.ok(drafts.length>0,'导入后应写入编辑器草稿');
  assert.ok(renders.indexOf('defaults')>=0&&renders.indexOf('stages')>=0);
  assert.equal(toasts.length,1);
  assert.equal(els.plShareImportDialog.style.display,'none','导入成功应关闭弹窗');
  /* 内容非法 → 弹窗内 ✗ 提示，不改表单、不关弹窗 */
  els.plShareImportDialog.style.display='flex';
  els.plName.value='';
  const r2=await ctx.applyPipelineShareText('not-json');
  assert.equal(r2,'invalid');
  assert.equal(els.plName.value,'','非法内容不得改表单');
  assert.equal(tips.length,1);
  assert.equal(tips[0].bad,true);
  assert.match(tips[0].msg,/无效/);
  assert.equal(els.plShareImportDialog.style.display,'flex','非法内容应留在弹窗内供修正');
});

test('importPipelineShare：点按钮打开 textarea 弹窗；编辑已有流水线或只读模式下不打开',()=>{
  const opens=[];
  const els={plForm:{dataset:{editId:'pl-old'}},plName:{value:'原名'}};
  const ctx=makeCtx({
    plFormReadOnly:false,
    $:id=>els[id]||{value:'',dataset:{},style:{}},
    openPipelineShareImport:()=>opens.push(1),
  },['importPipelineShare']);
  ctx.importPipelineShare();
  assert.equal(opens.length,0,'编辑已有流水线时不得打开导入弹窗');
  els.plForm.dataset.editId='';
  ctx.importPipelineShare();
  assert.equal(opens.length,1,'新建流水线应打开导入弹窗');
  ctx.plFormReadOnly=true;
  ctx.importPipelineShare();
  assert.equal(opens.length,1,'只读模式不得打开导入弹窗');
});

test('openPipelineShareImport：清空 textarea、清提示并显示弹窗；close 反向收起',()=>{
  const els={
    plShareImportDialog:{style:{display:'none'}},
    plShareImportText:{value:'旧内容'},
    plShareImportTip:{textContent:'旧提示',style:{}},
  };
  const tips=[];
  const ctx=makeCtx({
    $:id=>els[id]||{value:'',dataset:{},style:{}},
    plShareImportTipShow:(msg,bad)=>tips.push({msg,bad}),
  },['openPipelineShareImport','closePipelineShareImport']);
  ctx.openPipelineShareImport();
  assert.equal(els.plShareImportDialog.style.display,'flex');
  assert.equal(els.plShareImportText.value,'','打开时应清空 textarea');
  assert.deepEqual(tips,[{msg:'',bad:undefined}]);
  ctx.closePipelineShareImport();
  assert.equal(els.plShareImportDialog.style.display,'none');
});

test('UI wiring：行菜单含「分享」入口、新建表单含「从分享导入」按钮（左侧）与 textarea 弹窗，事件绑定正确',()=>{
  assert.match(source,/<div id="plRowMenuShare" class="pl-row-menu-item"[^>]*>分享<\/div>/,'行菜单须有「分享」项');
  assert.match(source,/<button id="plImportShare"[^>]*>从分享导入<\/button>/,'新建表单须有「从分享导入」按钮');
  assert.match(source,/id="plShareImportDialog"/,'须有从分享导入弹窗 #plShareImportDialog');
  assert.match(source,/<textarea id="plShareImportText"/,'弹窗内须有 textarea #plShareImportText');
  assert.match(source,/\$\('plRowMenuShare'\)\.addEventListener\('click'/,'分享菜单须绑定 click');
  assert.match(source,/if\(id\) sharePipeline\(id\)/,'分享菜单点击调用 sharePipeline');
  assert.match(source,/\$\('plImportShare'\)\.addEventListener\('click'/,'导入按钮须绑定 click');
  assert.match(source,/importPipelineShare\(\)/,'导入按钮调用 importPipelineShare');
  assert.match(source,/importShareBtn\.style\.display=p\?'none':''/,'仅新建流水线显示「从分享导入」');
  assert.match(source,/\$\('plShareImportOk'\)\.addEventListener\('click'/,'弹窗「导入」须绑定 click');
  assert.match(source,/applyPipelineShareText\(/,'弹窗确认调用 applyPipelineShareText');
  /* 按钮须在底栏左侧：plImportShare 出现在 plDraftTip 之前 */
  const iBtn=source.indexOf('id="plImportShare"');
  const iTip=source.indexOf('id="plDraftTip"');
  assert.ok(iBtn>0&&iTip>iBtn,'「从分享导入」按钮应排在草稿提示之前（底栏左侧）');
});
