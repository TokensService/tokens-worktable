// 运行历史行提供独立的「查看流水线」入口：定位流水线、筛选任务列表，且不触发行回放。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8');

function extractFunction(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `pipeline.html 缺少函数 ${name}`);
  const start = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error(`无法提取函数 ${name}`);
}

function load() {
  const nodes = {};
  for (const id of ['plFilterKw', 'plFilterOwner', 'plFilterFavorite', 'pipelineTaskCard']) {
    nodes[id] = { value: '', scrollIntoView: () => { nodes[id].scrolled = true; } };
  }
  const calls = [];
  const context = {
    pipelines: [
      { id: 'p1', name: '部署流水线' },
      { id: 'p2', name: '构建流水线' },
    ],
    plFilter: { kw: '旧关键词', owner: 'mine', favorite: 'favorite' },
    plPage: 4,
    currentUsername: '',
    findPipeline: id => context.pipelines.find(p => p.id === id) || null,
    selectPipeline: id => calls.push(['selectPipeline', id]),
    savePlFilter: () => calls.push(['savePlFilter']),
    renderPipelines: () => calls.push(['renderPipelines']),
    $: id => nodes[id] || null,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('plOwnerFilterLabel') + '\n' + extractFunction('showPipelineFromHistory'), context);
  return { context, nodes, calls };
}

test('历史行查看流水线会定位流水线并筛选任务列表', () => {
  const { context, nodes, calls } = load();
  context.showPipelineFromHistory({ pipelineId: 'p2', pipeline: '构建流水线' });
  assert.deepEqual({ ...context.plFilter }, { kw: '构建流水线', owner: 'all', favorite: 'all' });
  assert.equal(context.plPage, 0);
  assert.equal(nodes.plFilterKw.value, '构建流水线');
  assert.equal(nodes.plFilterOwner.value, '全部', '拥有者组合框回显「全部」模式标签');
  assert.equal(nodes.plFilterFavorite.value, 'all');
  assert.deepEqual(calls, [['selectPipeline', 'p2'], ['savePlFilter'], ['renderPipelines']]);
  assert.equal(nodes.pipelineTaskCard.scrolled, true);
});

test('流水线已删除时仍按历史名称筛选任务列表并定位任务卡', () => {
  const { context, nodes, calls } = load();
  context.showPipelineFromHistory({ pipeline: '已删除流水线' });
  assert.equal(context.plFilter.kw, '已删除流水线');
  assert.equal(context.plPage, 0);
  assert.deepEqual(calls, [['savePlFilter'], ['renderPipelines']]);
  assert.equal(nodes.pipelineTaskCard.scrolled, true);
});

test('缺少流水线名称时查看入口不改变当前状态', () => {
  const { context, nodes, calls } = load();
  context.showPipelineFromHistory({});
  assert.deepEqual({ ...context.plFilter }, { kw: '旧关键词', owner: 'mine', favorite: 'favorite' });
  assert.equal(context.plPage, 4);
  assert.deepEqual(calls, []);
  assert.equal(nodes.pipelineTaskCard.scrolled, undefined);
});

test('运行历史使用三点菜单承载查看流水线操作', () => {
  assert.match(source, /data-history-menu/);
  assert.match(source, /id="historyRowMenuPanel"/);
  assert.match(source, /id="historyRowMenuViewPipeline"[^>]*>查看流水线/);
  assert.doesNotMatch(source, /data-history-pipeline/);
});
