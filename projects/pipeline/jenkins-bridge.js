#!/usr/bin/env node
// jenkins-bridge.js — 本地 Jenkins CORS 桥接（工作台「流水线」项目专用）
// 监听 127.0.0.1:28081（默认），把请求转发到上游 Jenkins（默认 http://127.0.0.1:28080，
// 该地址通常是 ssh -L 隧道），并为所有响应附加 CORS 头、把响应里的绝对 Jenkins 地址
// 改写为桥接地址。这样浏览器页面（工作台 :3051）即可跨域直连本机 Jenkins，
// 全程不出本机、无需配置任何代理、无需改动 Jenkins 本身。
// 启动：  node jenkins-bridge.js            （日志写 bridge.log，pid 写 bridge.pid）
// 环境变量：BRIDGE_BIND（默认 127.0.0.1）、BRIDGE_PORT（默认 28081）、
//          BRIDGE_TARGET（默认 http://127.0.0.1:28080）、BRIDGE_REWRITE（额外改写地址，逗号分隔）
'use strict';
const http = require('http');

const BIND   = process.env.BRIDGE_BIND   || '127.0.0.1';
const PORT   = parseInt(process.env.BRIDGE_PORT || '28081', 10);
const TARGET = (process.env.BRIDGE_TARGET || 'http://127.0.0.1:28080').replace(/\/+$/, '');
const EXTRA  = (process.env.BRIDGE_REWRITE || '').split(',').map(s => s.trim()).filter(Boolean);

const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer',
  'transfer-encoding','upgrade','host','content-length','accept-encoding']);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Jenkins-Crumb, X-Requested-With, Accept',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  if (req.method === 'OPTIONS') {                       // CORS 预检：直接应答，不打扰上游
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, corsHeaders()));
    res.end('ok');
    console.log(`[bridge] OPTIONS ${req.url} -> 200 preflight`);
    return;
  }
  const myBase = 'http://' + (req.headers.host || (BIND === '0.0.0.0' ? '127.0.0.1:' + PORT : BIND + ':' + PORT));
  const upstream = TARGET + req.url;
  const headers = {};
  for (const k of Object.keys(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP.has(lk)) continue;
    headers[k] = req.headers[k];
  }
  const preq = http.request(upstream, { method: req.method, headers }, (pres) => {
    const status = pres.statusCode || 502;
    const out = Object.assign({}, corsHeaders());
    if (pres.headers.location) out.location = String(pres.headers.location).split(TARGET).join(myBase);
    for (const k of Object.keys(pres.headers)) {
      const lk = k.toLowerCase();
      if (HOP.has(lk) || lk === 'location' || lk === 'content-encoding' || lk === 'content-length') continue;
      out[k] = pres.headers[k];
    }
    const type = String(pres.headers['content-type'] || '');
    const chunks = [];
    let size = 0, overflow = false;
    pres.on('data', (c) => {
      if (overflow) return;
      size += c.length;
      if (size > 8 * 1024 * 1024) { overflow = true; chunks.length = 0; res.writeHead(status, out); pres.pipe(res); return; }
      chunks.push(c);
    });
    pres.on('end', () => {
      if (overflow) return;
      let body = Buffer.concat(chunks);
      if (/json|text|javascript/.test(type)) {
        let s = body.toString('utf8');
        const repl = (from) => { if (from && s.indexOf(from) >= 0) s = s.split(from).join(myBase); };
        repl(TARGET); EXTRA.forEach(repl);
        if (body.length !== Buffer.byteLength(s, 'utf8')) body = Buffer.from(s, 'utf8');
      }
      out['content-length'] = String(body.length);
      res.writeHead(status, out);
      res.end(body);
      console.log(`[bridge] ${req.method} ${req.url} -> ${status} ${body.length}B ${Date.now() - t0}ms`);
    });
    pres.on('error', (e) => { try { res.writeHead(502, Object.assign({ 'Content-Type': 'text/plain' }, corsHeaders())); res.end('upstream error: ' + e.message); } catch (_) {} });
  });
  preq.on('error', (e) => {
    try { res.writeHead(502, Object.assign({ 'Content-Type': 'text/plain' }, corsHeaders())); res.end('Cannot reach Jenkins (' + TARGET + '): ' + e.message); } catch (_) {}
    console.error('[bridge] upstream error', req.url, e.message);
  });
  req.pipe(preq);
});

server.listen(PORT, BIND, () => {
  console.log(`[bridge] listening on http://${BIND}:${PORT} -> ${TARGET}`);
});
