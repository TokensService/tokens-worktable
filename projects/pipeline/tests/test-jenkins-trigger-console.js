/* 在流水线工作台页面的浏览器 Console 里粘贴执行（需先 F12 打开控制台）。
   验证流水线编辑器里 Jenkins 任务的触发方式：必须 POST buildWithParameters（GET 会报 HTTP 405）。
   复用页面全局的 jenkins 连接配置与 jkJobPath / jkFetchCrumb / jkTriggerBuild（来自 pipeline.html 内联脚本）。 */
(async () => {
  const s = activeStages().find(function (x) { return x.jenkins; });
  if (!s) { console.error('[jk-test] ✗ 当前流水线没有 Jenkins 阶段，请先在流水线编辑器里添加一个'); return; }
  const jk = s.jenkins;
  console.log('[jk-test] 目标: ' + (jenkins.url || '').replace(/\/+$/, '') + jkJobPath(jk.job) + 'buildWithParameters · mode=' + jenkins.mode);
  const auth = (jenkins.user || jenkins.token) ? { Authorization: 'Basic ' + btoa(jenkins.user + ':' + jenkins.token) } : {};
  try {
    const crumb = await jkFetchCrumb(jenkins, auth);
    console.log('[jk-test] crumb: ' + (crumb ? '✓ 已获取（CSRF 防护开启）' : '未获取（API token 通常豁免，跳过）'));
  } catch (e) {
    console.warn('[jk-test] crumb 获取异常（忽略，直接 POST）:', e);
  }
  try {
    await jkTriggerBuild(jk.job, {});
    console.log('[jk-test] ✓ 触发成功（POST），可打开 Jenkins 确认队列中出现新构建');
  } catch (e) {
    console.error('[jk-test] ✗ 触发失败: ' + (e && e.message ? e.message : e));
    console.error('[jk-test] 排查: ① 405=仍用了 GET（本修复后应为 POST）；② 403=缺 crumb 或凭据无构建权限；③ 404=任务名/路径不对');
  }
})();
