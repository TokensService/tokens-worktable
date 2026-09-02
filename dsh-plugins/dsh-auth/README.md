# dsh-auth —— dsh web 登录守卫

为 dsh web（OPTEST）提供登录界面：品牌化登录页 + scrypt 口令校验 + 会话 Cookie，并借宿主
webserver 的前置守卫钩子（`registerGuard`）把**所有** HTTP 路由、SPA fallback 与 WebSocket
upgrade 统一拦在会话校验之后。仅 `/login` 与 `/api/auth/logout` 匿名可达。

## 前提

宿主 deepseek-harness 必须已应用守卫钩子补丁并重建（本仓库 `./apply-branding.sh` 会一并应用
`patches/webserver-guard.patch`）。缺少钩子时本插件加载即报错。

## 配置

配置写在 profile 用户覆写层 `$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- id: dsh-auth
  config:
    passwordHash: 'scrypt$16384$8$1$....$....'   # 必填，npm run hash 生成
    sessionTtlHours: 12        # 会话有效期（小时），默认 12
    secureCookie: false        # 经 HTTPS 暴露时置 true（Cookie 加 Secure）
    maxAttempts: 10            # 单 IP 窗口内允许的失败次数，默认 10
    windowMinutes: 10          # 限流窗口（分钟），默认 10
```

改完 `./dsh.sh restart` 生效。

## 行为

- 未认证的浏览器导航（GET + Accept: text/html）302 到 `/login?next=<原地址>`；API 请求答 401
  JSON；WebSocket upgrade 直接拒绝协商。
- 登录成功签发 256 位随机会话 token（HttpOnly + SameSite=Lax Cookie），进程内保存，**重启 dsh web
  后全部会话失效**。
- 单 IP 失败超限后 429，窗口滑过自动解除。
- 登录页自带 CSP（`default-src 'none'` 等）、no-store、nosniff、no-referrer 安全头。
- 登出：`GET/POST /api/auth/logout`（清除会话与 Cookie）。

## 安全说明

- 口令只存 scrypt 哈希，明文不落盘；校验用 timingSafeEqual。
- 公网暴露时**务必**再前置 HTTPS（反代终止 TLS 即可），并把 `secureCookie` 置 true。
- 会话为进程内单实例，不支撑多副本部署。

## 构建与安装

```bash
npm install && npm run build   # 产出 lib/index.js
npm run hash                   # 生成 passwordHash
```

安装由仓库根 `./install-plugins.sh` 统一完成（构建 → `dsh plugin add link:` → 重启 web）。
