/* 在流水线工作台页面的浏览器 Console 里粘贴执行（需先 F12 打开控制台）。
   验证 http://7.242.105.149:18081/api/xds/archs/latest?code_ref=0730_dev_bnt3 浏览器直连是否可用 */
(async () => {
  const url = 'http://7.242.105.149:18081/api/xds/archs/latest?code_ref=0730_dev_bnt3';
  console.log('[xds-test] 请求:', url);
  const t0 = performance.now();
  try {
    const resp = await fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit' });
    const ms = (performance.now() - t0).toFixed(0);
    console.log('[xds-test] HTTP', resp.status, resp.statusText, '· 耗时', ms + 'ms');
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = null; }
    if (data) {
      const items = Array.isArray(data.items) ? data.items : [];
      console.log('[xds-test] ✓ JSON 解析成功 · total=' + data.total + ' · next_offset=' + data.next_offset + ' · items=' + items.length);
      console.log('[xds-test] 前 10 个策略:', items.slice(0, 10).map(it => (it && (it.arch_name !== undefined ? it.arch_name : it.name)) || it));
      console.log('[xds-test] 完整响应:', data);
    } else {
      console.warn('[xds-test] 响应不是 JSON，前 300 字符:', text.slice(0, 300));
    }
  } catch (e) {
    console.error('[xds-test] ✗ fetch 失败:', e);
    console.error('[xds-test] 若是 TypeError: Failed to fetch / NetworkError，通常是：① 目标未返回 CORS 头（需服务端加 Access-Control-Allow-Origin）；② 页面是 https 而目标是 http（混合内容拦截）；③ 网络不可达');
  }
})();
