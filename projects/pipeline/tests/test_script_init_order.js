// 主脚本顶层初始化顺序守卫：const $ 声明（约 3985 行）之前不得出现顶层 $(...) 语句。
// 背景：envInfoRefresh 的点击绑定曾写在「节点信息手动刷新」小节末尾（const $ 声明前约 1600 行），
// 顶层执行时 $ 仍处于暂时性死区，抛 "Cannot access '$' before initialization"，
// 整段脚本中断、流水线列表/编排/历史全部不渲染。本测试以静态契约防同类回归。
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.PIPELINE_HTML||__dirname+'/../pipeline.html','utf8');

test('顶层初始化顺序：const $ 声明之前无列 0 顶层 $(...) 语句',()=>{
  const declIdx=source.indexOf('const $ =');
  assert.ok(declIdx>=0,'未找到 const $ 声明');
  const head=source.slice(0,declIdx);
  const offenders=[];
  head.split('\n').forEach((line,i)=>{
    // 本文件顶层语句一律顶格书写；函数体内的 $( 均有缩进，不在此列
    if(/^\$\(/.test(line)) offenders.push((i+1)+': '+line.trim());
  });
  assert.deepEqual(offenders,[],'const $ 声明之前存在顶层 $(...) 语句，将触发 TDZ 中断整页脚本：\n'+offenders.join('\n'));
});

test('顶层初始化顺序：envInfoRefresh 点击绑定在 const $ 声明之后',()=>{
  const declIdx=source.indexOf('const $ =');
  const bindIdx=source.indexOf("$('envInfoRefresh').addEventListener('click', refreshEnvsFromServer)");
  assert.ok(declIdx>=0 && bindIdx>=0,'const $ 声明或 envInfoRefresh 绑定缺失');
  assert.ok(bindIdx>declIdx,'envInfoRefresh 绑定必须在 const $ 声明之后');
});
