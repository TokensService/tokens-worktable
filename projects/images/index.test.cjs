/* 镜像仓库管理页（index.html）静态契约：
   - dshell.css 原生皮肤 + 背景三态（跟随 / 深色 / 浅色，color-scheme 随主题同步）
   - 镜像浏览：/v2/_catalog 全量取回（跟随 Link rel=next）+ 本地搜索过滤、tags/list 按需预取
   - 删除标签：GET manifest（OCI Accept 四类型）→ DELETE manifests/<digest>
   - 远程缓存任务：exec-stream 流式跑 registry_cache.sh（env 注入凭证），NDJSON 帧回显 / 中止 / 历史
   - 设置页：仓库地址 / 账号密码 / 超时 本机 localStorage，测试连接经 proxy 探活
   - GC：write .gc.sh + exec 执行；会话 401 给出重登提示 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
const cacheSh = fs.readFileSync(path.join(dir, 'registry_cache.sh'), 'utf8');
const testSh = fs.readFileSync(path.join(dir, 'registry_test.sh'), 'utf8');

test('皮肤走工作台 dshell.css 模板', () => {
  assert.ok(html.includes('/api/worktable/template/dshell.css'));
});

test('背景三态：跟随 / 深色 / 浅色，color-scheme 由 JS 随主题同步', () => {
  assert.ok(html.includes('id="themeSel"'));
  assert.ok(html.includes('<option value="follow">背景：跟随</option>'));
  assert.ok(html.includes('<option value="dark">背景：深色</option>'));
  assert.ok(html.includes('<option value="light">背景：浅色</option>'));
  assert.ok(script.includes('documentElement.style.colorScheme'), 'JS 应随主题设置 color-scheme');
  assert.ok(script.includes('prefers-color-scheme'), '"跟随"应监听系统明暗');
  assert.ok(html.includes('body[data-theme="dark"]') && html.includes('body[data-theme="light"]'));
  assert.ok(!/:root\s*\{[^}]*color-scheme/.test(html.replace(/<style>[\s\S]*?<\/style>/g, m => m.replace(':root { color-scheme', ':root-ignore { color-scheme')) ) || true, '占位');
  // 主题变量只挂 body[data-theme]：dshell.css 自带 :root color-scheme:dark，页面不得在 :root 覆盖色值
  const styleBlock = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  assert.ok(!/(?:^|\})\s*:root\s*\{[^}]*--dsw-alias/s.test(styleBlock), '主题变量不得常驻 :root（浅色下 UA 控件仍按深色渲染的根因）');
});

test('镜像浏览：_catalog 全量取回跟随 Link rel=next，本地搜索过滤', () => {
  assert.ok(script.includes('/v2/_catalog?n='), '应请求 catalog 分页接口');
  assert.ok(script.includes('rel="?next"') || script.includes('rel=\\?\"next\\?"') || /rel=\\?"next/.test(script), '应跟随 Link rel=next');
  assert.ok(script.includes('function filteredRepos'), '应在已加载全量上本地过滤');
  assert.ok(script.includes("id=\"searchBox\"") || html.includes('id="searchBox"'));
  assert.ok(html.includes('id="loadRepoBtn"'));
  assert.ok(script.includes("/tags/list"), '应加载仓库标签');
  assert.ok(html.includes('id="autoTags"'), '标签自动加载应可切换');
});

test('删除标签：GET manifest（OCI Accept 四类型）→ DELETE manifests/<digest>', () => {
  assert.ok(script.includes('application/vnd.oci.image.index.v1+json'), 'Accept 必须含 OCI index');
  assert.ok(script.includes('application/vnd.oci.image.manifest.v1+json'), 'Accept 必须含 OCI manifest');
  assert.ok(script.includes('application/vnd.docker.distribution.manifest.v2+json'), 'Accept 必须含 docker manifest v2');
  assert.ok(script.includes('docker-content-digest'), '应从响应头取 digest');
  assert.ok(/\/manifests\/' \+ encodeURIComponent\(dg\)/.test(script) || script.includes("manifests/' + encodeURIComponent(dg)"), 'DELETE 目标应为 digest');
  assert.ok(script.includes("'DELETE'"), '应发 DELETE 请求');
});

test('所有 Registry 请求经服务端 /api/worktable/proxy 代连（不直连上游）', () => {
  assert.ok(script.includes("'/api/worktable/proxy'"));
  assert.ok(!/fetch\((['"`])(https?:)?\/\//.test(script), '页面不得直连任意外部 http(s) 地址');
});

test('远程缓存任务：exec-stream 流式 + registry_cache.sh + 凭证 env 注入', () => {
  assert.ok(script.includes("'/api/worktable/exec-stream'"));
  assert.ok(script.includes('registry_cache.sh'));
  assert.ok(script.includes('REG_HOST') && script.includes('REG_USER') && script.includes('REG_PASS'), '凭证应经 env 注入');
  assert.ok(script.includes('AbortController'), '中止应断开 fetch（服务端随之杀进程组）');
  assert.ok(script.includes("f.type === 'out'") && script.includes("f.type === 'done'"), '应按 NDJSON 帧回显');
  assert.ok(script.includes("f.type === 'err'") && script.includes("f.type === 'error'"));
  // 历史与草稿
  assert.ok(script.includes('ir_jobs_v1'));
  assert.ok(script.includes('ir_jobdraft_v1'), '任务表单草稿应跨刷新保留');
  assert.ok(script.includes("status = 'aborted'"), '用户中止应记 aborted');
  assert.ok(script.includes('sessionStorage'), '草稿用 sessionStorage');
});

/* 页面超时上限曾是 120 分钟，而服务端 exec-stream 把 timeoutMs 硬夹到 60 分钟——用户填 120 被静默
   截断且无任何提示；默认 30 分钟更连 9GB 压缩层的下载（实测 40+ 分钟）都不够，任务必在 push 前被
   SIGKILL，页面只看到一行英文 exec timed out。以下守住「上限对齐服务端 + 可表达不限时 + 归因可操作」。 */
test('页面：任务超时上限与服务端一致，且支持「留空/0 = 不限时」', () => {
  assert.ok(html.includes('max="1440"'), '上限应为 1440 分钟（= 服务端 EXEC_TIMEOUT_CAP_MS 24h）');
  assert.ok(!html.includes('max="120"'), '不得再留 120 分钟旧上限（会被服务端静默截断）');
  assert.ok(html.includes('min="0"'), '应允许 0（不限时）');
  assert.ok(/Math\.min\(1440, Math\.floor\(rawTimeoutMin\)\)/.test(script), 'JS 夹取上限应与 markup 一致');
  assert.ok(!/Math\.min\(120,/.test(script), '不得再按 120 夹取');
  assert.ok(script.includes('rawTimeoutMin') && /timeoutMin = .*: 0;/.test(script), '留空/0/非法值应得到 0（服务端 0 = 不挂超时 kill）');
  assert.ok(script.includes('timeoutMs: timeoutMin * 60000'), '0 分钟应如实传 0，不得回落成默认值');
  assert.ok(!/Math\.max\(1, Math\.min\(/.test(script), '不得再把超时强制抬到至少 1 分钟（否则无法表达不限时）');
  assert.ok(script.includes("logLine('', '超时: '"), '任务日志应回显实际生效的超时');
  assert.ok(script.includes('不限时'), '不限时应在 UI 明示');
});

test('页面：超时被杀给出可操作归因（区别于网络/凭证失败）', () => {
  assert.ok(/timed out\/i\.test/.test(script), '应识别服务端超时错误帧');
  assert.ok(script.includes('任务因超时被终止'), '应点明是超时而非网络/凭证问题');
  assert.ok(script.includes('重跑是续传而非从头下载'), '应说明重跑可续传');
});

test('页面：默认超时足以覆盖大镜像，且草稿能还原「不限时」', () => {
  assert.ok(html.includes('value="180"'), '默认应为 180 分钟（旧默认 30 分钟连下载都不够）');
  assert.ok(html.includes('重跑即续传'), '表单说明应告知超时被杀不是白跑');
  assert.ok(/if \(typeof d\.timeout === 'string'\)/.test(script), '空串（不限时）也应从草稿还原');
  assert.ok(!/if \(d\.timeout\) \$\('jobTimeout'\)/.test(script), '不得用真值判断（会吞掉空串、退回默认值）');
});

test('registry_cache.sh：pull → login(--password-stdin) → tag → push → 清理临时 tag', () => {
  assert.ok(cacheSh.startsWith('#!/bin/bash'));
  assert.ok(cacheSh.includes('docker pull'));
  assert.ok(cacheSh.includes('--password-stdin'), '登录必须走 stdin，避免口令落进程列表');
  assert.ok(cacheSh.includes('docker tag') && cacheSh.includes('docker push'));
  assert.ok(cacheSh.includes('docker rmi'), '完成后应清临时 tag');
  assert.ok(cacheSh.includes('CACHE_OK'), '成功应有明确标记');
  assert.ok(/\bexit 1[0-3]\b/.test(cacheSh), '各段失败应有非零退出码');
});

test('registry_cache.sh：login 失败排障（stderr 不吞 + 原因分类 + 归一化）', () => {
  assert.ok(!/password-stdin >\/dev\/null 2>&1/.test(cacheSh), 'login stderr 不得丢弃（否则任务日志看不到原因）');
  assert.ok(cacheSh.includes('docker login 失败'), '失败应有明确标记');
  assert.ok(cacheSh.includes('401 Unauthorized') && cacheSh.includes('账号或密码不对'), '401 应归因到凭证');
  assert.ok(cacheSh.includes('TLS handshake') && cacheSh.includes('insecure-registries'), 'TLS 失败应提示 insecure-registries');
  assert.ok(cacheSh.includes('connection refused'), '端口不可达应有归因');
  assert.ok(cacheSh.includes('${REG_HOST#http://}') && cacheSh.includes('${REG_HOST#https://}'), '地址应剥协议前缀');
  assert.ok(cacheSh.includes("REG_PASS%$'\\n'"), '密码应剥尾随换行');
  assert.ok(cacheSh.includes('未配置镜像仓库地址'), '仓库地址为空应在 login 前拦截（否则退到 Docker Hub）');
});

/* 大镜像（如 vllm/vllm-openai:v0.31.0：40 层 / 9GB 压缩 / 32GB 解压）经公网 mirror 拉取时，
   blob 被 302 到境外 CDN，实测只有 3~4MB/s → 光下载就要 40 分钟以上。此前 pull 失败只有一句
   「[FAIL] docker pull 失败」，与 login 失败的四类归因严重不对称，用户分不清是超时、网络还是拼错标签。 */
test('registry_cache.sh：pull 失败排障（原因分类 + 用时 + 续传提示）', () => {
  assert.ok(cacheSh.includes('docker pull 失败'), 'pull 失败应有明确标记');
  assert.ok(/exit=\$PULL_CODE/.test(cacheSh), '失败应带 docker 退出码');
  assert.ok(cacheSh.includes('拉取用时'), '应回报拉取用时，供用户校准超时设置');
  assert.ok(cacheSh.includes('manifest unknown'), 'manifest unknown 应归因到镜像名/标签不存在');
  assert.ok(cacheSh.includes('no space left on device'), '磁盘不足应有归因');
  assert.ok(cacheSh.includes('docker image prune'), '磁盘不足应给出清理动作');
  assert.ok(cacheSh.includes('proxyconnect'), '代理不可达应有归因');
  assert.ok(cacheSh.includes('toomanyrequests'), 'mirror 限流应有归因');
  assert.ok(cacheSh.includes('authentication required'), '源仓库要认证应归因到需先登录源仓库');
  assert.ok(cacheSh.includes('重跑本任务即为续传'), '必须说明重跑是续传而非从头下载');
  assert.ok(cacheSh.includes('调大或留空（不限时）'), '网络类/长耗时失败应指路调大超时');
  // 不得用裸状态码匹配：层 ID 是 12 位十六进制，"503" / "EOF" 会误命中
  assert.ok(!/\*"503"\*/.test(cacheSh) && !/\*"EOF"\*/.test(cacheSh), '不得用裸 "503"/"EOF" 匹配（会误命中十六进制层 ID）');
  assert.ok(cacheSh.includes('503 Service Unavailable'), '应匹配完整错误措辞');
});

test('registry_cache.sh：pull 必须流式回显（大镜像不得整体缓冲）', () => {
  assert.ok(/docker pull "\$SRC" 2>&1 \| tee/.test(cacheSh), 'pull 应经 tee 边跑边回显');
  assert.ok(cacheSh.includes('PIPESTATUS[0]'), '管道后应取 docker 的退出码而非 tee 的');
  assert.ok(!/\$\(\s*docker pull/.test(cacheSh), '不得用命令替换整体缓冲 pull 输出（40 分钟全程无回显）');
  assert.ok(cacheSh.includes('mktemp') && cacheSh.includes('rm -f "$PULL_LOG"'), '归因用的临时日志应清理');
});

test('registry_cache.sh：中止语义（TERM/INT trap 打断 docker 子进程，避免残留）', () => {
  assert.ok(/trap 'trap - TERM INT; kill -INT -\$\$/s.test(cacheSh), '应 trap TERM/INT 并向进程组转发 INT（打断 docker pull/push）');
  assert.ok(cacheSh.includes('exit 143'), '被中止应以 143（128+SIGTERM）退出');
});

test('页面：提交前校验仓库地址 + 归一化 host + 回显登录目标', () => {
  assert.ok(script.includes('regHost'), '提交任务应使用归一化后的 host');
  assert.ok(script.includes('先到「设置」页填写镜像仓库地址'), '空地址应拦截并引导到设置页');
  assert.ok(script.includes('目标仓库:'), '任务日志应回显实际登录目标');
  assert.ok(script.includes('密码未填'), '密码未填应提示 push 可能 401');
  assert.ok(script.includes("replace(/^https?:\\/\\//, '')"), 'regBase 应剥 scheme 残留');
});

test('registry_test.sh：test 探活 / gc 容器内垃圾回收（CLI 助手）', () => {
  assert.ok(testSh.startsWith('#!/bin/bash'));
  assert.ok(testSh.includes('garbage-collect'));
  assert.ok(testSh.includes('/v2/_catalog'));
  assert.ok(testSh.includes('REG_OK'));
  assert.ok(testSh.includes('docker ps'), 'gc 前应确认 registry 容器在跑');
});

test('设置页：地址 / 账号密码 / 超时 本机 localStorage（不上传服务端）', () => {
  assert.ok(script.includes('ir_cfg_v1'));
  assert.ok(html.includes('id="setHost"') && html.includes('id="setUser"') && html.includes('id="setPass"'));
  assert.ok(html.includes('id="setTimeoutSec"'), '代连超时可配置');
  assert.ok(script.includes("'/v2/_catalog?n=1'"), '测试连接应探活');
  assert.ok(!script.includes('localStorage.setItem') || script.includes('不上传') || html.includes('不上传服务端'), '设置仅本机');
  assert.ok(html.includes('不上传服务端'), '需明示不上传');
});

test('GC 运维：write .gc.sh + exec 执行，日志内联', () => {
  assert.ok(script.includes("'/api/worktable/write'"), '应写入临时 GC 脚本');
  assert.ok(script.includes("'/api/worktable/exec'"), '应经 exec 执行');
  assert.ok(script.includes('garbage-collect'), 'GC 命令在页面内组装');
  assert.ok(html.includes('id="gcBtn"') && html.includes('id="gcLog"'));
});

test('会话 401 给出重登提示（不静默）', () => {
  assert.ok(script.includes('401'));
  assert.ok(script.includes('会话未登录或已过期'));
  assert.ok(script.includes('e401.session = true'), 'proxy 层 401 应标记为会话问题');
});

/* 仓库开启 htpasswd 认证后，页面曾只剩一条「仓库列表加载失败：HTTP 401」——
   既没说是仓库在要认证、也没说去哪儿填密码，整页看起来像坏了。以下守住归因与出口。 */
test('仓库 401 精确归因：区分「仓库要认证」与「DSH 会话失效」', () => {
  assert.ok(script.includes('function registryAuthError'), '应有上游 401 归因函数');
  assert.ok(script.includes('www-authenticate'), '应从上游响应头取 Basic realm 作为证据');
  assert.ok(script.includes('registryAuth = true'), '认证类错误应打标，供 UI 决定出口');
  assert.ok(script.includes('镜像仓库要求认证'), '文案必须点明是仓库在要认证');
  assert.ok(script.includes('请在「设置」页填写仓库账号密码'), '必须给出下一步动作');
  assert.ok(script.includes('与镜像仓库凭证无关'), '会话失效的 401 应与仓库认证区分开');
  assert.ok(script.includes('function registryError'), '上游非 200 应统一造错');
  assert.ok(/registryError\(d\)/.test(script), 'catalog / tags / manifest 路径应复用统一归因');
  assert.ok(script.includes('当前未填写仓库密码') && script.includes('密码不被仓库接受'), '应区分「没填密码」与「密码错」两种成因');
});

test('401 时错误条挂出「去设置填密码」按钮且不自动消失', () => {
  assert.ok(html.includes('id="errAction"'), 'markup 应有认证错误的动作按钮');
  assert.ok(html.includes('填写仓库账号密码'), '按钮文案应直指动作');
  assert.ok(html.includes('id="errText"'), '错误文案与按钮分离（textContent 不会抹掉按钮）');
  assert.ok(script.includes("action === 'registry-auth'"), 'showErr 应按 action 决定是否挂按钮');
  assert.ok(script.includes('errAction.style.display'), '按钮显隐应随错误类型切换');
  assert.ok(/if \(msg && !needAuth\) errTimer/.test(script), '认证类错误不应 7 秒自动隐藏（排障线索会丢）');
  assert.ok(script.includes("errAction.addEventListener('click'"), '按钮应接线');
  assert.ok(script.includes("p.classList.add('ir-needAuth')"), '跳转后应高亮待填的密码框');
  assert.ok(/switchTab\('settings'\);\s*\n\s*var p = \$\('setPass'\)/.test(script), '点按钮应切到设置页并聚焦密码框');
});

test('密码为空时不发半截 Authorization（避免 invalid credential / 误挡匿名仓库）', () => {
  assert.ok(/if \(!cfg\.pass\) return \{\};/.test(script), 'authHeader 应在无密码时直接返回空头');
  assert.ok(!/if \(!cfg\.user && !cfg\.pass\)/.test(script), '不得再按「账号与密码都空」判断（会发出 "admin:" 半截凭证）');
});

test('设置页「登录状态」先如实反映凭证是否已配置', () => {
  assert.ok(script.includes('function renderAuthState'), '应有登录状态渲染');
  assert.ok(script.includes('renderAuthState()'), 'renderSettings 应带出登录状态');
  assert.ok(script.includes('未填密码 · 仓库若开启认证会 401'), '未配置口令时应直接提示');
  assert.ok(script.includes('认证未通过（401）'), '测试连接失败应区分认证失败与其它失败');
  assert.ok(html.includes('仓库已开启 htpasswd 认证'), '设置页应说明仓库需要认证');
});

test('页面不内置仓库口令（凭据只来自本机设置）', () => {
  assert.ok(/pass: ''/.test(script), 'CFG_DEFAULT 的密码必须为空');
  assert.ok(!/pass:\s*'[A-Za-z0-9!@#$%^&*._-]{6,}'/.test(script), '不得硬编码任何仓库口令');
  assert.ok(html.includes('本页不内置任何密码'), '设置页应明示口令不随页面分发');
  assert.ok(!/REG_PASS=[A-Za-z0-9]{6,}/.test(cacheSh), '缓存脚本不得内置口令');
});

test('三标签结构：镜像仓库 / 远程缓存 / 设置', () => {
  assert.ok(html.includes('data-tab="repo"'));
  assert.ok(html.includes('data-tab="cache"'));
  assert.ok(html.includes('data-tab="settings"'));
  assert.ok(script.includes('function switchTab'));
  assert.ok(html.includes('id="toSettingsBtn"'), '页头应有直达设置入口（markup）');
  assert.ok(script.includes("$('toSettingsBtn')"), '设置入口应接线切标签');
});

test('脚本路径从 site 托管 URL 反解（页面可定位同目录脚本）', () => {
  assert.ok(script.includes('function projectScriptPath'));
  assert.ok(script.includes('/api\\/worktable\\/site\\/'));
  assert.ok(script.includes('decodeURIComponent'));
});

test('JS 语法：脚本整体可解析', () => {
  assert.ok(script.length > 1000, '页面脚本不应为空');
  assert.doesNotThrow(() => new Function(script), '内联脚本应能通过语法解析');
});
