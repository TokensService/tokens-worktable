/* 自定义预设任务（feat/pipeline-custom-presets 并行实现契约）：
   normalizeCustomPresets 归一化（剔坏项/字段纠正/key 去重/script 剥离多余字段）、
   presetDefOf/presetOrderAll/rebuildPresetNameMap 定义查询、presetOn 勾选判定（DOM 优先、自定义回退 enabled）、
   withPresetMarkers 默认位置补齐与失效标记过滤、expandRunStages 勾选/显式快照展开（script 深拷贝隔离）、
   selectedPresetKeys 顺序子集、normalizePipelineDefaults 双模式 presets 过滤（系统白名单兜底 ↔ presetDefOf 判定）。
   函数名与行为严格按契约断言；pipeline.html 实现尚未落地时用例失败属正常中间态，不得放松断言迎合。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

function extractFunction(name){
  const match=new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match,`pipeline.html 缺少函数 ${name}（自定义预设契约尚未落地）`);
  const bodyStart=source.indexOf('{',match.index);let depth=0;
  for(let i=bodyStart;i<source.length;i+=1){
    if(source[i]==='{') depth+=1;
    else if(source[i]==='}'&&--depth===0) return source.slice(match.index,i+1);
  }
  throw new Error(`无法提取函数 ${name}`);
}

/* 系统预设桩：与 pipeline.html 现行 PRESET_DEF 同形（check 为阻断型 block:true）；
   script() 固定返回 null（不依赖设置页配置全局），系统预设展开快照 script:null */
const PRESET_DEF_STUB={
  cleanup:{id:'__cleanup__',el:'cleanupEnv',name:'环境清理',script:()=>null,block:false,noScript:'未配置环境清理脚本'},
  check:{id:'__check__',el:'checkEnv',name:'环境检查',script:()=>null,block:true,noScript:'未配置环境检查脚本'},
  profiling:{id:'__profiling__',el:'profilingEnv',name:'Profiling',script:()=>null,block:false,noScript:'未配置 Profiling 脚本'},
};
const PRESET_FUNCTIONS=['normalizeCustomPresets','presetDefOf','presetOrderAll','rebuildPresetNameMap','presetOn','presetMarker','presetRuntime','withPresetMarkers','expandRunStages','selectedPresetKeys'];
/* 契约函数依次抽进同一沙盒即可互相调用；customPresets/PRESET_DEF/PRESET_ORDER/PRESET_BY_NAME 与 $ 均以桩注入 */
function loadPresetCore(overrides={}){
  const ctx=Object.assign({
    Array,Object,String,Number,Boolean,JSON,Set,Map,
    PRESET_DEF:PRESET_DEF_STUB,PRESET_ORDER:['cleanup','check','profiling'],PRESET_BY_NAME:{},
    customPresets:[],$:()=>null,
  },overrides);
  vm.createContext(ctx);
  PRESET_FUNCTIONS.forEach(name=>{ vm.runInContext(extractFunction(name),ctx); });
  return ctx;
}
/* 造一个字段齐全的自定义预设项（默认 pos:'first'/enabled:true，overrides 覆盖） */
function customPreset(key,overrides={}){
  return Object.assign({key:key,name:key,script:null,block:false,pos:'first',enabled:true},overrides);
}
const J=value=>JSON.parse(JSON.stringify(value));

test('normalizeCustomPresets 剔除非对象/无名项并纠正字段：pos 归位、布尔化、name trim、key 去重、script 剥离多余字段',()=>{
  const ctx=loadPresetCore();
  const input=[
    null,42,'preset-string',                       // 非对象项剔除
    {key:'c-noname'},                              // 无名项剔除
    {key:'c-ok',name:'  数据备份  ',pos:'MIDDLE',block:1,enabled:1,script:{name:'backup.sh',path:'/s/backup.sh',params:'--full',values:{A:'1'},extra:'剥掉我'}},
    {key:'c-ok',name:'数据备份',pos:'first',block:true,enabled:true,script:{name:'backup.sh',path:'/s/backup.sh',params:'--full',values:{A:'1'}}},   // 重复 key：归一化后与首项相同，去重后只剩一项
    {key:'c-last',name:'末尾任务',pos:'last',block:0,enabled:0,script:'not-an-object'},
    {key:'c-nopos',name:'缺省位置',script:null},
  ];
  assert.deepEqual(J(ctx.normalizeCustomPresets(input)),[
    {key:'c-ok',name:'数据备份',script:{name:'backup.sh',path:'/s/backup.sh',params:'--full',values:{A:'1'}},block:true,pos:'first',enabled:true},
    {key:'c-last',name:'末尾任务',script:null,block:false,pos:'last',enabled:false},
    {key:'c-nopos',name:'缺省位置',script:null,block:false,pos:'first',enabled:false},
  ]);
});

test('presetDefOf 系统预设返回 PRESET_DEF 项、自定义 key 派生 def、未知返回 null',()=>{
  const ctx=loadPresetCore({customPresets:[
    customPreset('c-backup',{name:'数据备份',block:true,script:{name:'backup.sh',path:'/s/backup.sh',params:'--full',values:{B:'2'}}}),
  ]});
  const sys=ctx.presetDefOf('check');
  assert.equal(sys,ctx.PRESET_DEF.check,'系统 pkey 应返回 PRESET_DEF 项本身');
  assert.equal(sys.block,true);
  const def=ctx.presetDefOf('c-backup');
  assert.equal(def.custom,true);
  assert.equal(def.id,'__custom_c-backup__');
  assert.equal(def.el,'presetCustom_c-backup');
  assert.equal(def.name,'数据备份');
  assert.equal(def.block,true,'block 透传自定义配置');
  assert.equal(def.noScript,'未配置「数据备份」脚本');
  assert.equal(typeof def.script,'function');
  assert.deepEqual(J(def.script()),{name:'backup.sh',path:'/s/backup.sh',params:'--full',values:{B:'2'}});
  assert.equal(ctx.presetDefOf('no-such'),null);
});

test('presetOrderAll 系统三项在前、自定义按 customPresets 数组顺序在后',()=>{
  const ctx=loadPresetCore({customPresets:[customPreset('c-z'),customPreset('c-a')]});
  assert.deepEqual(ctx.presetOrderAll(),['cleanup','check','profiling','c-z','c-a']);
});

test('rebuildPresetNameMap 原地重建 PRESET_BY_NAME（同一引用），含系统名与自定义名',()=>{
  const map={'旧名字':'stale'};
  const ctx=loadPresetCore({PRESET_BY_NAME:map,customPresets:[customPreset('c-backup',{name:'数据备份'})]});
  ctx.rebuildPresetNameMap();
  assert.equal(ctx.PRESET_BY_NAME,map,'必须原地重建，不得换新对象');
  assert.equal(map['旧名字'],undefined,'重建应清掉旧条目');
  assert.equal(map['环境清理'],'cleanup');
  assert.equal(map['环境检查'],'check');
  assert.equal(map['Profiling'],'profiling');
  assert.equal(map['数据备份'],'c-backup');
});

test('presetOn 有 DOM 元素读 checked、自定义无 DOM 回退 enabled、未知 pkey 为 false',()=>{
  const els={cleanupEnv:{checked:true},'presetCustom_c-dom':{checked:true}};
  const ctx=loadPresetCore({
    $:id=>els[id]||null,
    customPresets:[
      customPreset('c-dom',{name:'DOM 优先',enabled:false}),   // DOM checked 覆盖 enabled:false
      customPreset('c-fb-on',{name:'回退启用',enabled:true}),
      customPreset('c-fb-off',{name:'回退关闭',enabled:false,pos:'last'}),
    ],
  });
  assert.equal(ctx.presetOn('cleanup'),true,'系统预设读 DOM checked');
  assert.equal(ctx.presetOn('c-dom'),true,'有 DOM 元素时以 DOM 为准（覆盖 enabled:false）');
  assert.equal(ctx.presetOn('c-fb-on'),true,'自定义无 DOM 元素回退 enabled 字段');
  assert.equal(ctx.presetOn('c-fb-off'),false);
  assert.equal(ctx.presetOn('check'),false,'系统预设无 DOM 元素时不回退（enabled 回退仅限自定义）');
  assert.equal(ctx.presetOn('no-such'),false,'未知 pkey 为 false');
});

test('withPresetMarkers 空 stages 按默认位置补齐：first 自定义在 check 后、last 自定义在 profiling 后',()=>{
  const ctx=loadPresetCore({customPresets:[
    customPreset('c1first',{name:'前置甲',pos:'first'}),
    customPreset('c2first',{name:'前置乙',pos:'first'}),
    customPreset('c3last',{name:'末尾丙',pos:'last'}),
  ]});
  const out=ctx.withPresetMarkers([]);
  assert.deepEqual(out.map(s=>s.pkey),['cleanup','check','c1first','c2first','profiling','c3last']);
  assert.deepEqual(J(out[0]),{id:'__cleanup__',name:'环境清理',preset:true,pkey:'cleanup'});
  assert.deepEqual(J(out[2]),{id:'__custom_c1first__',name:'前置甲',preset:true,pkey:'c1first'});
});

test('withPresetMarkers 已存在的乱序标记保持原位置，缺失的才按默认位置插入',()=>{
  const ctx=loadPresetCore({customPresets:[customPreset('c1first',{name:'前置甲',pos:'first'})]});
  const out=ctx.withPresetMarkers([
    {id:'__profiling__',name:'Profiling',preset:true,pkey:'profiling'},
    {id:'a',name:'A'},
    {id:'__cleanup__',name:'环境清理',preset:true,pkey:'cleanup'},
  ]);
  /* profiling 已在首位、cleanup 已在普通阶段之后：均不重排；check 插到 cleanup 后、c1first 插到 check 后 */
  assert.deepEqual(out.map(s=>s.pkey||s.id),['profiling','a','cleanup','check','c1first']);
});

test('withPresetMarkers 过滤 pkey 已失效（从 customPresets 删除后）与旧 promCollect 的标记行',()=>{
  const ctx=loadPresetCore({customPresets:[
    customPreset('c1first',{name:'前置甲',pos:'first'}),
    customPreset('c3last',{name:'末尾丙',pos:'last'}),
  ]});
  const out=ctx.withPresetMarkers([
    {id:'__custom_c-gone__',name:'已删除的自定义',preset:true,pkey:'c-gone'},
    {id:'a',name:'A'},
    {id:'__prom_collect__',name:'收集普罗数据',preset:true,pkey:'promCollect'},
  ]);
  assert.ok(!out.some(s=>s.pkey==='c-gone'||s.pkey==='promCollect'),'失效 pkey 的标记行必须被过滤');
  assert.deepEqual(out.map(s=>s.pkey||s.id),['cleanup','check','c1first','a','profiling','c3last']);
});

test('expandRunStages 无 DOM 时自定义按 enabled 回退展开为 script 深拷贝快照，disabled 不展开',()=>{
  const ctx=loadPresetCore({customPresets:[
    customPreset('c-en',{name:'数据备份',pos:'first',enabled:true,script:{name:'backup.sh',path:'/s/backup.sh',params:'--full',values:{TOKEN:'abc'}}}),
    customPreset('c-dis',{name:'关闭项',pos:'last',enabled:false,script:{name:'off.sh',path:'/s/off.sh',params:'',values:{}}}),
  ]});
  const normal={id:'build',name:'构建镜像'};
  const out=ctx.expandRunStages([normal]);
  assert.equal(out.length,2,'系统预设无 DOM 不展开、disabled 自定义消失，只剩 enabled 自定义与普通阶段');
  assert.deepEqual(J(out[0]),{id:'__custom_c-en__',name:'数据备份',preset:true,pkey:'c-en',script:{name:'backup.sh',path:'/s/backup.sh',params:'--full',values:{TOKEN:'abc'}}});
  assert.deepEqual(J(out[1]),normal,'普通阶段 {...s} 透传（J() 消除沙盒域原型差异）');
  assert.notEqual(out[1],normal,'普通阶段按 {...s} 浅拷贝而非原引用');
  ctx.customPresets[0].script.values.TOKEN='tampered';   // 深拷贝隔离：改源配置不影响已展开快照
  assert.equal(out[0].script.values.TOKEN,'abc');
});

test('expandRunStages 显式 presetKeys 快照数组优先，不受 enabled 回退影响',()=>{
  const ctx=loadPresetCore({customPresets:[
    customPreset('c-en',{name:'数据备份',pos:'first',enabled:true,script:{name:'backup.sh',path:'/s/backup.sh',params:'--full',values:{TOKEN:'abc'}}}),
  ]});
  const normal={id:'build',name:'构建镜像'};
  const out=ctx.expandRunStages([normal],['cleanup']);
  assert.deepEqual(out.map(s=>s.pkey||s.id),['cleanup','build'],'只展开快照数组列出的 cleanup；enabled 自定义不因回退展开');
  assert.deepEqual(J(out[0]),{id:'__cleanup__',name:'环境清理',preset:true,pkey:'cleanup',script:null},'系统桩 script() 返回 null → 快照 script:null');
});

test('selectedPresetKeys 输出与 presetOrderAll 同序的勾选子集',()=>{
  const els={cleanupEnv:{checked:true},checkEnv:{checked:false},profilingEnv:{checked:true}};
  const ctx=loadPresetCore({
    $:id=>els[id]||null,
    customPresets:[customPreset('c-on',{enabled:true}),customPreset('c-off',{enabled:false,pos:'last'})],
  });
  assert.deepEqual(ctx.presetOrderAll(),['cleanup','check','profiling','c-on','c-off']);
  assert.deepEqual(ctx.selectedPresetKeys(),['cleanup','profiling','c-on']);
});

/* 流水线默认运行参数段单独抽取：段内自带系统白名单兜底；向 ctx 注入 presetDefOf 桩后改经它判定（自定义 key 合法保留） */
function loadDefaultsSection(overrides={}){
  const start=source.indexOf('/* ---------- 流水线默认运行参数 ---------- */');
  const end=source.indexOf('/* ---------- 流水线默认运行参数结束 ---------- */',start);
  assert.ok(start>=0&&end>start,'pipeline.html 缺少流水线默认运行参数实现');
  const ctx=Object.assign({Array,Object,String,Set},overrides);
  vm.createContext(ctx);
  vm.runInContext(source.slice(start,end),ctx);
  return ctx;
}
test('normalizePipelineDefaults presets 过滤：无 presetDefOf 走系统白名单，注入后经它放行自定义 key',()=>{
  const ctx=loadDefaultsSection();
  assert.deepEqual(ctx.normalizePipelineDefaults({presets:['cleanup','c-x','root-shell']}).presets,['cleanup'],'沙盒单独抽取该段时退回 PIPELINE_DEFAULT_PRESET_KEYS 白名单');
  ctx.presetDefOf=k=>k==='root-shell'?null:{id:'__stub_'+k+'__',name:k};
  assert.deepEqual(ctx.normalizePipelineDefaults({presets:['cleanup','c-x','root-shell']}).presets,['cleanup','c-x'],'有 presetDefOf 时经它判定，自定义 key 合法保留');
});
