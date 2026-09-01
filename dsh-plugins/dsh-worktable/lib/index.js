// src/index.ts
import { execFile } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve as pathResolve, sep } from "node:path";
import { createRequire } from "node:module";
import { homedir, networkInterfaces } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// template/dshell.css
var dshell_default = `/* dsh-worktable \u539F\u751F\u76AE\u80A4 \xB7 DSH \u8BBE\u8BA1\u7CFB\u7EDF\u7EC4\u4EF6\u5E93
   \u7528\u6CD5\uFF1A<link rel="stylesheet" href="/api/worktable/template/dshell.css">
   \u6240\u6709\u989C\u8272\u8D70 DSH \u4E3B\u9898\u53D8\u91CF\uFF08--dsw-alias-*\uFF09\uFF0C\u81EA\u52A8\u9002\u914D\u660E\u6697\u4E3B\u9898\u3002 */
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--dsw-alias-bg-base, #0b0e14);
  color: var(--dsw-alias-label-primary, #e6e8eb);
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.6;
}
.dshell { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; min-height: 100%; }
/* \u6587\u5B57\u5C42\u7EA7 */
.dshell-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e8eb); }
.dshell-sub { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #9aa4b2); }
.dshell-muted { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11.5px; }
/* \u5361\u7247 */
.dshell-card { border: 1px solid var(--dsw-alias-border-l1, #262b36); border-radius: 10px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.02)); padding: 12px 14px; }
.dshell-card + .dshell-card { margin-top: 10px; }
/* \u6309\u94AE\uFF08\u7EFF\u8272\u4E3B\u6309\u94AE / \u5E7D\u7075\u6309\u94AE / \u5371\u9669\uFF09 */
.dshell-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 999px; border: 1px solid transparent; background: #3fb950; color: #0b0e14; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.dshell-btn:hover { filter: brightness(1.08); }
.dshell-btnGhost { background: transparent; border-color: var(--dsw-alias-border-l1, #262b36); color: var(--dsw-alias-label-secondary, #9aa4b2); }
.dshell-btnGhost:hover { color: var(--dsw-alias-label-primary, #e6e8eb); border-color: var(--dsw-alias-border-l2, #3a4150); }
.dshell-btnDanger { background: transparent; border-color: #f85149; color: #f85149; }
/* \u72B6\u6001\u5FBD\u6807\uFF08\u5706\u70B9 + \u6587\u5B57\uFF1B\u7EFF=\u5DF2\u5B8C\u6210 \u9EC4=\u5F85\u529E/\u5F85\u53D1\u5E03 \u7070=\u672A\u5F00\u59CB\uFF09 */
.dshell-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, #262b36); font-size: 11.5px; color: var(--dsw-alias-label-secondary, #9aa4b2); background: var(--dsw-alias-fill-l1, rgba(255,255,255,.03)); }
.dshell-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #6b7280); }
.dshell-badgeDone { color: #3fb950; border-color: rgba(63,185,80,.4); }
.dshell-badgeDone::before { background: #3fb950; box-shadow: 0 0 5px #3fb950; }
.dshell-badgeWait { color: #d29922; border-color: rgba(210,153,34,.4); }
.dshell-badgeWait::before { background: #d29922; box-shadow: 0 0 5px #d29922; }
.dshell-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #6b7280); }
.dshell-dotDone { background: #3fb950; box-shadow: 0 0 5px #3fb950; }
.dshell-dotWait { background: #d29922; box-shadow: 0 0 5px #d29922; }
/* \u6807\u7B7E\u9875 */
.dshell-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l1, #262b36); }
.dshell-tab { padding: 7px 12px; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #9aa4b2); cursor: pointer; border: none; background: none; font: inherit; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.dshell-tabOn { color: var(--dsw-alias-label-primary, #e6e8eb); border-bottom-color: var(--dsw-alias-state-accent-primary, #4f8ef7); }
/* \u5217\u8868 */
.dshell-list { display: flex; flex-direction: column; gap: 6px; }
.dshell-listItem { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1, #262b36); border-radius: 8px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.02)); cursor: pointer; }
.dshell-listItem:hover { border-color: var(--dsw-alias-border-l2, #3a4150); background: var(--dsw-alias-fill-l1, rgba(255,255,255,.05)); }
.dshell-listItemTitle { font-size: 12.5px; color: var(--dsw-alias-label-primary, #e6e8eb); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshell-listItemMeta { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); }
/* \u7F51\u683C / \u7EDF\u8BA1 */
.dshell-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.dshell-stat { padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #262b36); border-radius: 10px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.02)); }
.dshell-statLabel { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa4b2); }
.dshell-statValue { font-size: 20px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e8eb); }
.dshell-statDelta { font-size: 11px; color: #3fb950; }
/* \u8FDB\u5EA6\u6761 */
.dshell-progress { height: 6px; border-radius: 3px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.06)); overflow: hidden; }
.dshell-progressBar { height: 100%; border-radius: 3px; background: #3fb950; }
/* \u8F93\u5165 */
.dshell-input, .dshell-textarea { width: 100%; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l1, #262b36); border-radius: 8px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.03)); color: var(--dsw-alias-label-primary, #e6e8eb); font: inherit; font-size: 12.5px; outline: none; }
.dshell-input:focus, .dshell-textarea:focus { border-color: var(--dsw-alias-state-accent-primary, #4f8ef7); }
/* \u8868\u683C */
.dshell-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dshell-table th, .dshell-table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #262b36); }
.dshell-table th { color: var(--dsw-alias-label-secondary, #9aa4b2); font-weight: 500; }
/* \u952E\u503C\u5BF9 */
.dshell-kv { display: flex; flex-direction: column; gap: 6px; }
.dshell-kvRow { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
.dshell-kvKey { color: var(--dsw-alias-label-secondary, #9aa4b2); }
.dshell-kvValue { color: var(--dsw-alias-label-primary, #e6e8eb); text-align: right; }
/* \u5206\u5272\u7EBF */
.dshell-divider { height: 1px; background: var(--dsw-alias-border-l1, #262b36); margin: 6px 0; }
/* \u6EDA\u52A8\u6761 */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 5px; }
::-webkit-scrollbar-track { background: transparent; }
`;

// template/dshell.html
var dshell_default2 = '<!doctype html>\n<!-- dsh-worktable \u539F\u751F\u76AE\u80A4\u6A21\u677F\uFF1A\u65B0\u9875\u9762\u4EE5\u6B64\u4E3A\u57FA\u7840\uFF0C\u66FF\u6362\u4E0B\u9762\u793A\u4F8B\u5185\u5BB9\u5373\u53EF\u3002\n     \u6837\u5F0F\u8868\u7531\u63D2\u4EF6\u63D0\u4F9B\uFF08\u968F\u4E3B\u9898\u81EA\u52A8\u9002\u914D\uFF09\uFF0C\u4E0D\u8981\u590D\u5236\u6216\u6539\u5199\u5B83\u3002 -->\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>\u6211\u7684\u7A97\u53E3</title>\n  <link rel="stylesheet" href="/api/worktable/template/dshell.css" />\n</head>\n<body>\n  <div class="dshell">\n    <!-- \u6807\u9898\u533A -->\n    <h1 class="dshell-title">\u7A97\u53E3\u6807\u9898</h1>\n    <p class="dshell-sub">\u4E00\u53E5\u8BDD\u8BF4\u660E\u8FD9\u4E2A\u7A97\u53E3\u505A\u4EC0\u4E48\u3002</p>\n\n    <!-- \u72B6\u6001\u5FBD\u6807\uFF1A\u5DF2\u5B8C\u6210 dshell-badgeDone / \u8FDB\u884C\u4E2D dshell-badgeWait / \u9ED8\u8BA4 -->\n    <div>\n      <span class="dshell-badge dshell-badgeDone">\u5DF2\u5B8C\u6210</span>\n      <span class="dshell-badge dshell-badgeWait">\u8FDB\u884C\u4E2D</span>\n      <span class="dshell-badge">\u672A\u5F00\u59CB</span>\n    </div>\n\n    <!-- \u6807\u7B7E\u9875 -->\n    <div class="dshell-tabs">\n      <button class="dshell-tab dshell-tabOn">\u6982\u89C8</button>\n      <button class="dshell-tab">\u8BE6\u60C5</button>\n      <button class="dshell-tab">\u8BBE\u7F6E</button>\n    </div>\n\n    <!-- \u7EDF\u8BA1\u5361\u7247\u7F51\u683C -->\n    <div class="dshell-grid">\n      <div class="dshell-stat">\n        <div class="dshell-statLabel">\u603B\u6570</div>\n        <div class="dshell-statValue">128</div>\n        <div class="dshell-statDelta">+12.4%</div>\n      </div>\n      <div class="dshell-stat">\n        <div class="dshell-statLabel">\u8FDB\u884C\u4E2D</div>\n        <div class="dshell-statValue">7</div>\n      </div>\n      <div class="dshell-stat">\n        <div class="dshell-statLabel">\u5DF2\u5B8C\u6210</div>\n        <div class="dshell-statValue">121</div>\n      </div>\n    </div>\n\n    <!-- \u5217\u8868 -->\n    <div class="dshell-list">\n      <div class="dshell-listItem">\n        <span class="dshell-listItemTitle">\u6761\u76EE\u4E00\uFF1A\u793A\u4F8B\u5185\u5BB9\u6807\u9898</span>\n        <span class="dshell-listItemMeta">\u6628\u5929</span>\n      </div>\n      <div class="dshell-listItem">\n        <span class="dshell-listItemTitle">\u6761\u76EE\u4E8C\uFF1A\u793A\u4F8B\u5185\u5BB9\u6807\u9898</span>\n        <span class="dshell-badge dshell-badgeDone">\u5DF2\u53D1\u5E03</span>\n      </div>\n    </div>\n\n    <!-- \u5361\u7247 + \u952E\u503C\u5BF9 -->\n    <div class="dshell-card">\n      <h2 class="dshell-sub" style="margin:0 0 8px">\u8BE6\u60C5</h2>\n      <div class="dshell-kv">\n        <div class="dshell-kvRow"><span class="dshell-kvKey">\u5B57\u6BB5 A</span><span class="dshell-kvValue">\u503C A</span></div>\n        <div class="dshell-kvRow"><span class="dshell-kvKey">\u5B57\u6BB5 B</span><span class="dshell-kvValue">\u503C B</span></div>\n      </div>\n      <div class="dshell-divider"></div>\n      <div class="dshell-progress"><div class="dshell-progressBar" style="width:72%"></div></div>\n    </div>\n\n    <!-- \u64CD\u4F5C\u533A -->\n    <div style="display:flex;gap:8px">\n      <button class="dshell-btn">\u4E3B\u8981\u64CD\u4F5C</button>\n      <button class="dshell-btn dshell-btnGhost">\u6B21\u8981\u64CD\u4F5C</button>\n    </div>\n  </div>\n</body>\n</html>\n';

// src/index.ts
var PLUGIN_VERSION = false ? "dev" : "0.2.2";
var name = "dsh-worktable";
var inject = ["webServer", "sessions"];
var HEALTH_PATH = "/api/worktable/health";
var PROXY_PATH = "/api/worktable/proxy";
function isLocalTarget(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "dsh.internal" || h === "host.docker.internal" || h.endsWith(".local")) return true;
  const nums = h.split(".").map((s) => s && /^\d+$/.test(s) ? Number(s) : NaN);
  if (nums.length === 4 && nums.every((n) => !Number.isNaN(n) && n >= 0 && n <= 255)) {
    if (nums[0] === 127) return true;
    if (nums[0] === 10) return true;
    if (nums[0] === 192 && nums[1] === 168) return true;
    if (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) return true;
    if (nums[0] === 169 && nums[1] === 254) return true;
    if (nums[0] === 0 && nums[1] === 0 && nums[2] === 0 && nums[3] === 0) return true;
    return false;
  }
  if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fd")) return true;
  return false;
}
var MAX_ENTRIES = 500;
var FILE_TYPES = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm"
};
var SITE_PREFIX = "/api/worktable/site";
var TEMPLATE_PREFIX = "/api/worktable/template";
function loadPkg(pkg) {
  const starts = /* @__PURE__ */ new Set();
  try {
    starts.add(dirname(fileURLToPath(import.meta.url)));
  } catch {
  }
  try {
    starts.add(realpathSync(dirname(fileURLToPath(import.meta.url))));
  } catch {
  }
  for (const start of starts) {
    let dir = start;
    while (dir && dir !== pathResolve(dir, "..")) {
      try {
        const req = createRequire(pathToFileURL(pathResolve(dir, "__wt_probe__.js")).href);
        return req(pkg);
      } catch {
      }
      dir = pathResolve(dir, "..");
    }
  }
  try {
    const profilesDir = pathResolve(homedir(), ".dsh", "profiles");
    for (const profile of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!profile.isDirectory() && !profile.isSymbolicLink()) continue;
      const nm = pathResolve(profilesDir, profile.name, "node_modules");
      try {
        const req = createRequire(pathToFileURL(pathResolve(nm, "__wt_probe__.js")).href);
        return req(pkg);
      } catch {
      }
    }
  } catch {
  }
  return null;
}
function serverCwd(ctx, sessionId, clientCwd) {
  if (sessionId) {
    try {
      const headerCwd = ctx.sessions?.get?.(sessionId)?.header?.cwd;
      if (typeof headerCwd === "string" && headerCwd) return headerCwd;
    } catch {
    }
  }
  if (typeof clientCwd === "string" && clientCwd) return clientCwd;
  return process.cwd();
}
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
async function listDirectory(path) {
  const abs = pathResolve(path);
  const dirents = await readdir(abs, { withFileTypes: true });
  const entries = dirents.map((d) => ({ name: d.name, path: abs + sep + d.name, isDir: d.isDirectory(), hidden: d.name.startsWith(".") })).sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, void 0, { sensitivity: "base" });
  });
  const truncated = entries.length > MAX_ENTRIES;
  return { path: abs, entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated };
}
function gitExec(args, cwd) {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise(stdout);
    });
  });
}
async function gitStatus(cwd) {
  try {
    const branchRaw = await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const porcelain = await gitExec(["status", "--porcelain=v1", "-z"], cwd);
    const entries = porcelain.split("\0").filter((s) => s.length > 2).map((s) => ({ xy: s.slice(0, 2), path: s.slice(3) }));
    return { isRepo: true, branch: branchRaw.trim() || "HEAD", entries };
  } catch {
    return { isRepo: false, branch: void 0, entries: [] };
  }
}
function setupTerminal(webServer, ctx) {
  if (typeof webServer.registerUpgrade !== "function") return;
  const wsMod = loadPkg("ws");
  const ptyMod = loadPkg("node-pty");
  ctx.logger?.info?.("[dsh-worktable] term deps: ws=" + (wsMod ? "ok" : "MISSING") + " node-pty=" + (ptyMod ? "ok" : "MISSING"));
  if (!wsMod || !ptyMod) {
    ctx.logger?.warn("[dsh-worktable] \u7EC8\u7AEF\u8DEF\u7531\u672A\u6CE8\u518C\uFF1Aws/node-pty \u4E0D\u53EF\u7528");
    return;
  }
  const WebSocketServer = wsMod.WebSocketServer ?? wsMod.default?.WebSocketServer;
  if (!WebSocketServer) return;
  const pty = ptyMod.default ?? ptyMod;
  const wss = new WebSocketServer({ noServer: true });
  const spawnShell = () => process.platform === "win32" ? { cmd: "powershell.exe", args: ["-NoLogo", "-NoProfile"] } : { cmd: process.env.SHELL || "/bin/bash", args: [] };
  const clampDim = (v, fallback) => Math.min(1024, Math.max(2, Number.isFinite(v) ? v : fallback));
  ctx.effect(() => webServer.registerUpgrade({
    path: "/api/worktable/term",
    handler: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const u = new URL(req.url ?? "/", "http://dsh.internal");
        const cwd = serverCwd(ctx, u.searchParams.get("sessionId") || void 0, u.searchParams.get("cwd") || void 0);
        const cols = clampDim(Number(u.searchParams.get("cols")), 80);
        const rows = clampDim(Number(u.searchParams.get("rows")), 24);
        let term = null;
        try {
          const shell = spawnShell();
          term = pty.spawn(shell.cmd, shell.args, { name: "xterm-256color", cols, rows, cwd, env: process.env });
        } catch (err) {
          try {
            ws.send("\r\n[worktable] \u7EC8\u7AEF\u542F\u52A8\u5931\u8D25\uFF1A" + String(err));
          } catch {
          }
          try {
            ws.close();
          } catch {
          }
          return;
        }
        term.onData((d) => {
          try {
            ws.send(d);
          } catch {
          }
        });
        term.onExit(() => {
          try {
            ws.close();
          } catch {
          }
        });
        ws.on("message", (raw) => {
          const text = String(raw);
          try {
            const msg = JSON.parse(text);
            if (msg && msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
              term.resize(clampDim(msg.cols, cols), clampDim(msg.rows, rows));
              return;
            }
          } catch {
          }
          try {
            term.write(text);
          } catch {
          }
        });
        ws.on("close", () => {
          try {
            term.kill();
          } catch {
          }
        });
      });
    }
  }), "dsh-worktable: terminal upgrade");
}
function apply(ctx) {
  const webServer = ctx.webServer;
  if (!webServer) {
    ctx.logger?.warn("[dsh-worktable] ctx.webServer \u4E0D\u53EF\u7528\uFF08headless profile\uFF1F\uFF09\uFF0C\u8DF3\u8FC7\u670D\u52A1\u7AEF\u8DEF\u7531");
    return;
  }
  webServer.register({
    kind: "exact",
    path: HEALTH_PATH,
    handler: (_req, res) => {
      json(res, 200, { plugin: "dsh-worktable", version: PLUGIN_VERSION, ok: true });
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/file",
    handler: async (req, res) => {
      try {
        const u = new URL(req.url ?? "/", "http://dsh.internal");
        const p = u.searchParams.get("path") || "";
        if (!p) {
          json(res, 400, { error: "missing path" });
          return;
        }
        const abs = pathResolve(p);
        const stat = await import("node:fs/promises").then((m) => m.stat(abs));
        if (stat.size > 20 * 1024 * 1024) {
          json(res, 413, { error: "file too large" });
          return;
        }
        const data = await readFile(abs);
        const ext = (abs.split(".").pop() || "").toLowerCase();
        const types = {
          html: "text/html; charset=utf-8",
          htm: "text/html; charset=utf-8",
          css: "text/css; charset=utf-8",
          js: "text/javascript; charset=utf-8",
          mjs: "text/javascript; charset=utf-8",
          json: "application/json; charset=utf-8",
          md: "text/markdown; charset=utf-8",
          markdown: "text/markdown; charset=utf-8",
          txt: "text/plain; charset=utf-8",
          log: "text/plain; charset=utf-8",
          pdf: "application/pdf",
          svg: "image/svg+xml",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          bmp: "image/bmp",
          ico: "image/x-icon"
        };
        res.writeHead(200, { "content-type": FILE_TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" });
        res.end(data);
      } catch (err) {
        json(res, 404, { error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "prefix",
    path: TEMPLATE_PREFIX,
    handler: (req, res) => {
      try {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
        const rel = pathname.slice(TEMPLATE_PREFIX.length);
        if (rel === "/dshell.css") {
          res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
          res.end(dshell_default);
        } else {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(dshell_default2);
        }
      } catch (err) {
        res.writeHead(404);
        res.end(String(err));
      }
    }
  });
  webServer.register({
    kind: "prefix",
    path: SITE_PREFIX,
    handler: async (req, res) => {
      try {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
        const segs = pathname.slice(SITE_PREFIX.length).split("/").filter(Boolean);
        const rootToken = decodeURIComponent(segs.shift() ?? "");
        const rel = segs.map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return s;
          }
        }).join("/");
        if (!rootToken) {
          json(res, 400, { error: "missing root" });
          return;
        }
        const root = pathResolve(rootToken);
        let abs = pathResolve(root, rel);
        if (abs !== root && !abs.startsWith(root + sep)) {
          json(res, 403, { error: "outside root" });
          return;
        }
        const statMod = await import("node:fs/promises");
        let info = await statMod.stat(abs).catch(() => null);
        if (info && info.isDirectory()) {
          abs = pathResolve(abs, "index.html");
          info = await statMod.stat(abs).catch(() => null);
        }
        if (!info || !info.isFile()) {
          json(res, 404, { error: "not found" });
          return;
        }
        if (info.size > 40 * 1024 * 1024) {
          json(res, 413, { error: "file too large" });
          return;
        }
        const data = await readFile(abs);
        const ext = (abs.split(".").pop() || "").toLowerCase();
        res.writeHead(200, { "content-type": FILE_TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" });
        res.end(data);
      } catch (err) {
        json(res, 404, { error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/fs",
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const path = typeof body.path === "string" && body.path ? body.path : serverCwd(ctx, body.sessionId, body.cwd);
        json(res, 200, await listDirectory(path));
      } catch (err) {
        json(res, 500, { path: "", entries: [], truncated: false, error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/workspaces",
    handler: async (_req, res) => {
      try {
        const file = pathResolve(homedir(), ".dsh", "storages", "workspace.json");
        const raw = await readFile(file, "utf8");
        json(res, 200, JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw));
      } catch (err) {
        json(res, 404, { error: String(err) });
      }
    }
  });
  const PROJECTS_STORE = pathResolve(homedir(), ".dsh", "storages", "worktable-projects.json");
  webServer.register({
    kind: "exact",
    path: "/api/worktable/projects",
    handler: async (req, res) => {
      try {
        if (req.method === "GET") {
          let raw = "";
          try {
            raw = await readFile(PROJECTS_STORE, "utf8");
          } catch {
          }
          const p = raw ? JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw) : {};
          json(res, 200, {
            layouts: Array.isArray(p.layouts) ? p.layouts : [],
            folders: p.folders && typeof p.folders === "object" ? p.folders : {}
          });
          return;
        }
        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          const layouts = Array.isArray(body.layouts) ? body.layouts.filter((l) => l && typeof l.id === "string" && typeof l.title === "string" && Array.isArray(l.main)) : [];
          const folders = {};
          if (body.folders && typeof body.folders === "object") {
            for (const [k, v] of Object.entries(body.folders)) if (typeof v === "string") folders[k] = v;
          }
          const text = JSON.stringify({ layouts, folders });
          if (text.length > 1024 * 1024) {
            json(res, 413, { error: "too large" });
            return;
          }
          const fsx = await import("node:fs/promises");
          await fsx.mkdir(dirname(PROJECTS_STORE), { recursive: true });
          const tmp = PROJECTS_STORE + ".tmp";
          await fsx.writeFile(tmp, text, "utf8");
          await fsx.rename(tmp, PROJECTS_STORE);
          json(res, 200, { ok: true });
          return;
        }
        res.writeHead(405);
        res.end();
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
    }
  });
  const PIPELINE_STORE = pathResolve(homedir(), ".dsh", "storages", "worktable-pipeline.json");
  webServer.register({
    kind: "exact",
    path: "/api/worktable/pipeline",
    handler: async (req, res) => {
      try {
        if (req.method === "GET") {
          let raw = "";
          try {
            raw = await readFile(PIPELINE_STORE, "utf8");
          } catch {
          }
          const p = raw ? JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw) : {};
          json(res, 200, {
            config: p.config && typeof p.config === "object" && !Array.isArray(p.config) ? p.config : {},
            history: Array.isArray(p.history) ? p.history : []
          });
          return;
        }
        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          const config = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config : {};
          const history = Array.isArray(body.history) ? body.history.slice(0, 500) : [];
          const text = JSON.stringify({ config, history });
          if (text.length > 20 * 1024 * 1024) {
            json(res, 413, { error: "too large" });
            return;
          }
          const fsx = await import("node:fs/promises");
          await fsx.mkdir(dirname(PIPELINE_STORE), { recursive: true });
          const tmp = PIPELINE_STORE + ".tmp";
          await fsx.writeFile(tmp, text, "utf8");
          await fsx.rename(tmp, PIPELINE_STORE);
          json(res, 200, { ok: true });
          return;
        }
        res.writeHead(405);
        res.end();
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
    }
  });
  const PLANS_STORE = pathResolve(homedir(), ".dsh", "storages", "worktable-pipeline-plans.json");
  async function writeJsonAtomic(file, text) {
    const fsx = await import("node:fs/promises");
    await fsx.mkdir(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    await fsx.writeFile(tmp, text, "utf8");
    await fsx.rename(tmp, file);
  }
  async function readPlansFile() {
    try {
      const raw = await readFile(PLANS_STORE, "utf8");
      const j = JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw);
      return Array.isArray(j.plans) ? j.plans : [];
    } catch {
      return [];
    }
  }
  async function readPipelineStore() {
    try {
      const raw = await readFile(PIPELINE_STORE, "utf8");
      return JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw);
    } catch {
      return {};
    }
  }
  webServer.register({
    kind: "exact",
    path: "/api/worktable/pipeline/plans",
    handler: async (req, res) => {
      try {
        if (req.method === "GET") {
          json(res, 200, { plans: await readPlansFile() });
          return;
        }
        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          const plans = Array.isArray(body.plans) ? body.plans.filter((p) => p && typeof p.id === "string" && (p.kind === "once" || p.kind === "interval")).slice(0, 100) : [];
          const text = JSON.stringify({ plans });
          if (text.length > 1024 * 1024) {
            json(res, 413, { error: "too large" });
            return;
          }
          await writeJsonAtomic(PLANS_STORE, text);
          json(res, 200, { ok: true });
          return;
        }
        res.writeHead(405);
        res.end();
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
    }
  });
  const LOGDUMP_FILE = pathResolve(homedir(), ".dsh", "storages", "worktable-pipeline-logs.md");
  webServer.register({
    kind: "exact",
    path: "/api/worktable/pipeline/logdump",
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        const content = typeof body.content === "string" ? body.content : "";
        if (!content) {
          json(res, 400, { error: "missing content" });
          return;
        }
        if (content.length > 20 * 1024 * 1024) {
          json(res, 413, { error: "too large" });
          return;
        }
        await writeJsonAtomic(LOGDUMP_FILE, content);
        json(res, 200, { ok: true, path: LOGDUMP_FILE });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
    }
  });
  function localAddrs() {
    const set = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "::1"]);
    try {
      const ifs = networkInterfaces();
      for (const list of Object.values(ifs)) for (const it of list || []) if (it && it.address) set.add(it.address);
    } catch {
    }
    return set;
  }
  function execText(cmd, args) {
    return new Promise((resolvePromise, reject) => {
      execFile(cmd, args, { timeout: 6e4, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const why = err.killed ? "\uFF08\u6267\u884C\u8D85\u8FC7 60s \u88AB\u7EC8\u6B62\uFF09" : "";
          reject(new Error((String(stderr || "").trim() || String(err.message || err)) + why));
        } else resolvePromise(String(stdout || ""));
      });
    });
  }
  const GPU_PROBE = 'nvidia-smi --query-gpu=index,uuid,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits; echo ===; nvidia-smi --query-compute-apps=pid,gpu_uuid,process_name --format=csv,noheader; echo ===; for p in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null); do echo "$p:$(cat /proc/$p/cgroup 2>/dev/null | grep -oE "[0-9a-f]{64}" | head -1)"; done; echo ===; (docker ps --format "{{.ID}}|{{.Names}}|{{.RunningFor}}" 2>/dev/null; nerdctl --namespace k8s.io ps --format "{{.ID}}|{{.Names}}|{{.RunningFor}}" 2>/dev/null; nerdctl ps --format "{{.ID}}|{{.Names}}|{{.RunningFor}}" 2>/dev/null; true)';
  async function queryGpu(ip, user, pass) {
    let out;
    if (localAddrs().has(ip)) {
      out = await execText("bash", ["-c", GPU_PROBE]);
    } else {
      const target = user ? user + "@" + ip : ip;
      const remoteCmd = "echo " + Buffer.from(GPU_PROBE).toString("base64") + " | base64 -d | bash";
      const sshArgs = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=8", target, remoteCmd];
      out = pass ? await execText("sshpass", ["-p", pass, "ssh", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1", ...sshArgs]) : await execText("ssh", ["-o", "BatchMode=yes", ...sshArgs]);
    }
    const secs = out.split(/^===\s*$/m);
    const gpus = (secs[0] || "").trim().split("\n").filter(Boolean).map((l) => {
      const p = l.split(",").map((s) => s.trim());
      return { index: p[0], uuid: p[1] || "", util: p[2] || "0", mem: p[3] || "0" };
    });
    if (!gpus.length) return { error: "nvidia-smi \u65E0\u8F93\u51FA\uFF08\u672A\u5B89\u88C5\u9A71\u52A8\u6216\u65E0 GPU\uFF09" };
    const procs = (secs[1] || "").trim().split("\n").filter(Boolean).map((l) => {
      const p = l.split(",").map((s) => s.trim());
      return { pid: p[0], uuid: p[1] || "", proc: p[2] || "" };
    });
    const cg = {};
    for (const l of (secs[2] || "").trim().split("\n")) {
      const m = /^(\S+):([0-9a-f]{64})$/.exec(l.trim());
      if (m) cg[m[1]] = m[2];
    }
    const dockers = (secs[3] || "").trim().split("\n").filter(Boolean).map((l) => {
      const p = l.trim().split("|");
      return { id: (p[0] || "").trim(), name: (p[1] || "").trim(), up: (p.slice(2).join("|") || "").trim() };
    });
    const procsOut = procs.map((p) => {
      let container = "", up = "";
      const hex = cg[p.pid];
      if (hex) {
        const d = dockers.find((x) => x.id && hex.indexOf(x.id) === 0);
        if (d) {
          container = d.name;
          up = d.up;
        }
      }
      return { pid: p.pid, uuid: p.uuid, proc: p.proc, container, up };
    });
    const busyUuids = new Set(procs.map((p) => p.uuid));
    const used = gpus.filter((g) => busyUuids.has(g.uuid) || Number(g.mem) > 1024).length;
    const containers = Array.from(new Set(procsOut.map((p) => p.container).filter(Boolean)));
    return { total: gpus.length, used, gpus: gpus.map((g) => ({ index: g.index, util: g.util, mem: g.mem })), procs: procsOut, containers };
  }
  webServer.register({
    kind: "exact",
    path: "/api/worktable/gpu",
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        const ip = typeof body.ip === "string" ? body.ip.trim() : "";
        if (!ip) {
          json(res, 400, { error: "missing ip" });
          return;
        }
        const r = await queryGpu(ip, typeof body.user === "string" ? body.user.trim() : "", typeof body.pass === "string" ? body.pass : "");
        json(res, 200, r);
      } catch (err) {
        json(res, 200, { error: String(err && err.message ? err.message : err) });
      }
    }
  });
  const planRunning = /* @__PURE__ */ new Set();
  const planLastRun = /* @__PURE__ */ new Map();
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const randHex = (n) => Math.random().toString(16).slice(2, 2 + n);
  const hhmm = () => {
    const d = /* @__PURE__ */ new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };
  const durText = (sec) => sec < 60 ? Math.round(sec) + "s" : Math.floor(sec / 60) + "m" + Math.round(sec % 60) + "s";
  const truncLog = (t) => t.length > 8192 ? t.slice(0, 8192) + "\n\u2026(\u622A\u65AD)" : t;
  const sanitizeFsName = (s) => String(s || "pipeline").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "pipeline";
  const nowCompactFull = () => {
    const d = /* @__PURE__ */ new Date();
    const p = (n) => String(n).padStart(2, "0");
    return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  };
  const stripSuffixName = (name2) => String(name2 || "").replace(/\s*·\s*定时后缀\s*$/, "") || "pipeline";
  async function writeTaskLogFile(folder, tag, seq, name2, text) {
    try {
      const fsx = await import("node:fs/promises");
      await fsx.mkdir(folder, { recursive: true });
      const file = folder + "/run-" + tag + "-" + String(seq).padStart(2, "0") + "-" + sanitizeFsName(name2) + ".log";
      await fsx.writeFile(file, text, "utf8");
      return file;
    } catch (e) {
      console.warn("[archive] \u5B9A\u65F6\u4EFB\u52A1\u65E5\u5FD7\u5F52\u6863\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u6267\u884C\uFF09:", e);
      return null;
    }
  }
  function runStageScript(sc, runCtx, scriptsDir) {
    const args = [];
    const env = {};
    for (const p of sc.params || []) {
      const v = sc.values && sc.values[p.key] !== void 0 ? sc.values[p.key] : p.def || "";
      if (p.kind === "pos") args.push(String(v));
      else env[p.key] = String(v);
    }
    const ctx0 = runCtx.envs && runCtx.envs[0] || null;
    if (runCtx.env && env.TARGET_IP === void 0) env.TARGET_IP = String(runCtx.env);
    if (ctx0) {
      if (ctx0.user && env.TARGET_USER === void 0) env.TARGET_USER = String(ctx0.user);
      if (ctx0.pass && env.TARGET_PASSWORD === void 0) env.TARGET_PASSWORD = String(ctx0.pass);
    }
    if (runCtx.archive) {
      if (env.ARCHIVE_DIR === void 0) env.ARCHIVE_DIR = String(runCtx.archive);
      if (env.ARCHIVE_FOLDER === void 0) env.ARCHIVE_FOLDER = String(runCtx.archive);
      if (runCtx.pipelineName && env.ARCHIVE_PIPELINE === void 0) env.ARCHIVE_PIPELINE = String(runCtx.pipelineName);
      if (runCtx.tag && env.ARCHIVE_TAG === void 0) env.ARCHIVE_TAG = String(runCtx.tag);
    }
    return new Promise((resolve) => {
      const isPy = sc.lang === "py" || /\.py$/i.test(sc.name || "");
      execFile(
        isPy ? "python3" : "bash",
        [sc.path, ...args],
        { cwd: scriptsDir || void 0, env: { ...process.env, ...env }, timeout: 12e4, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? typeof err.code === "number" ? err.code : 1 : 0;
          resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
        }
      );
    });
  }
  function stageLogText(name2, r) {
    const interp = /\.py$/i.test(name2) ? "python3" : "bash";
    let t = "$ " + interp + " " + name2 + "\n" + (r.stdout || "");
    if (r.stderr) t += "\n\u2717 " + r.stderr.split("\n").join("\n\u2717 ");
    return truncLog(t + "\n[exit " + r.code + "]");
  }
  async function appendPipelineHistory(rec) {
    const j = await readPipelineStore();
    const cfg = j.config && typeof j.config === "object" && !Array.isArray(j.config) ? j.config : {};
    const history = Array.isArray(j.history) ? j.history : [];
    const no = Math.max(Number(cfg.buildNo) || 0, ...history.map((h) => Number(h && h.no) || 0), 0) + 1;
    cfg.buildNo = no;
    rec.no = no;
    history.unshift(rec);
    const text = JSON.stringify({ config: cfg, history: history.slice(0, 500) });
    if (text.length > 20 * 1024 * 1024) return;
    await writeJsonAtomic(PIPELINE_STORE, text);
  }
  async function execPlan(pl) {
    const t0 = Date.now();
    const store = await readPipelineStore();
    const cfg = store.config && typeof store.config === "object" && !Array.isArray(store.config) ? store.config : {};
    const scriptsDir = typeof cfg.scriptsDir === "string" ? cfg.scriptsDir : "";
    const pipeName = stripSuffixName(pl.pipelineName);
    const tag = typeof pl.tag === "string" && pl.tag ? pl.tag : hhmm().replace(":", "") + "-" + randHex(5);
    const baseSeq = Math.max(0, Number(pl.baseSeq) || 0);
    const isSuffixRun = typeof pl.archive === "string" && !!pl.archive;
    let archiveRoot = typeof cfg.archiveDir === "string" ? cfg.archiveDir.trim().replace(/\/+$/, "") : "";
    if (!archiveRoot && scriptsDir && scriptsDir.charAt(0) === "/") {
      const dir = scriptsDir.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
      archiveRoot = (dir || "/") + "/runs";
    }
    const folder = isSuffixRun ? String(pl.archive) : archiveRoot ? archiveRoot + "/" + sanitizeFsName(pipeName) + "_" + nowCompactFull() : null;
    const runCtx = { env: pl.env || "", envs: Array.isArray(pl.envs) ? pl.envs : [], archive: folder, tag, pipelineName: pipeName };
    const logs = [];
    const profileStages = [];
    let status = "success";
    if (cfg.cleanupEnabled && cfg.cleanupScript && cfg.cleanupScript.path) {
      const st0 = Date.now();
      const r = await runStageScript(cfg.cleanupScript, runCtx, scriptsDir);
      const text = stageLogText(cfg.cleanupScript.name, r);
      const logFile = folder ? await writeTaskLogFile(folder, tag, 0, "\u73AF\u5883\u6E05\u7406", text) : null;
      logs.push({ stage: "\u73AF\u5883\u6E05\u7406", status: r.code === 0 ? "success" : "failed", log: text });
      profileStages.push({ id: "__cleanup__", name: "\u73AF\u5883\u6E05\u7406", status: r.code === 0 ? "success" : "failed", durSec: Math.round((Date.now() - st0) / 100) / 10, script: cfg.cleanupScript.name || null, logFile });
    }
    let seq = baseSeq + 1;
    for (const s of pl.stages || []) {
      const st0 = Date.now();
      let entry = null;
      if (s.gate) {
        entry = { status: "success", text: "[\u5B9A\u65F6\u6267\u884C] \u5BA1\u6279\u95E8\u81EA\u52A8\u901A\u8FC7" };
      } else if (s.kind === "jenkins") {
        entry = { status: "success", text: "[\u5B9A\u65F6\u6267\u884C] Jenkins \u9636\u6BB5\uFF1A\u5B9A\u65F6\u89E6\u53D1\u6682\u4E0D\u652F\u6301\uFF0C\u5DF2\u8DF3\u8FC7" };
      } else if (s.script && s.script.path) {
        const r = await runStageScript(s.script, runCtx, scriptsDir);
        entry = { status: r.code === 0 ? "success" : "failed", text: stageLogText(s.script.name, r) };
        if (r.code !== 0) status = "failed";
      } else {
        await sleepMs(Math.min(Math.max(1, Number(s.dur) || 5), 60) * 1e3);
        entry = { status: "success", text: "[\u5B9A\u65F6\u6267\u884C] \u6A21\u62DF\u9636\u6BB5\u5B8C\u6210" };
      }
      const logFile = folder ? await writeTaskLogFile(folder, tag, seq, s.name, entry.text) : null;
      logs.push({ stage: s.name, status: entry.status, log: entry.text });
      profileStages.push({ id: s.id, name: s.name, status: entry.status, durSec: Math.round((Date.now() - st0) / 100) / 10, script: s.script && s.script.name || null, logFile });
      seq++;
      if (status === "failed") break;
    }
    if (folder) {
      try {
        const fsx = await import("node:fs/promises");
        await fsx.mkdir(folder, { recursive: true });
        const sumFile = folder + "/run-" + tag + ".log";
        let prev = "";
        try {
          prev = await fsx.readFile(sumFile, "utf8");
        } catch {
        }
        prev = prev.replace(/\s*\[result\][^\n]*\s*$/, "");
        const lines = [];
        if (prev.trim()) lines.push(prev.replace(/\s+$/, ""), "", "----- \u5B9A\u65F6\u6267\u884C\uFF08\u670D\u52A1\u7AEF\uFF09 -----");
        logs.forEach((l) => {
          lines.push("===== " + l.stage + " [" + l.status + "] =====");
          l.log.split("\n").forEach((x) => lines.push(x));
          lines.push("");
        });
        lines.push("[result] " + status);
        await fsx.writeFile(sumFile, lines.join("\n") + "\n", "utf8");
      } catch (e) {
        console.warn("[archive] \u5B9A\u65F6\u8FD0\u884C\u65E5\u5FD7\u6C47\u603B\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u6267\u884C\uFF09:", e);
      }
      try {
        const fsx = await import("node:fs/promises");
        const profFile = folder + "/run-" + tag + ".profile.json";
        let profile = null;
        try {
          profile = JSON.parse(await fsx.readFile(profFile, "utf8"));
        } catch {
        }
        if (!profile || typeof profile !== "object") profile = {};
        profile.pipeline = pipeName;
        profile.tag = tag;
        if (!profile.commit) profile.commit = randHex(7);
        profile.env = pl.env || "";
        profile.image = pl.image || "";
        profile.by = pl.by || "schedule";
        profile.source = isSuffixRun ? "\u5B9A\u65F6\u540E\u7F00" : "\u5B9A\u65F6\u8BA1\u5212";
        profile.result = status;
        if (!profile.startTime) profile.startTime = new Date(t0).toISOString();
        profile.totalDurSec = Math.round((Date.now() - t0) / 100) / 10;
        if (!Array.isArray(profile.stages)) profile.stages = [];
        profileStages.forEach((rec) => {
          const idx = profile.stages.findIndex((x) => x && (x.id === rec.id || x.name === rec.name));
          if (idx >= 0) profile.stages[idx] = { ...profile.stages[idx], ...rec };
          else profile.stages.push(rec);
        });
        await fsx.writeFile(profFile, JSON.stringify(profile, null, 2), "utf8");
      } catch (e) {
        console.warn("[archive] \u5B9A\u65F6\u8FD0\u884C profiling \u5199\u5165\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u6267\u884C\uFF09:", e);
      }
      const archiveScriptName = typeof cfg.archiveScript === "string" ? cfg.archiveScript.trim() : "";
      if (archiveScriptName && archiveRoot && typeof cfg.archiveDir === "string" && cfg.archiveDir.trim()) {
        try {
          await new Promise((resolve) => {
            execFile("bash", [pathResolve(scriptsDir, archiveScriptName)], {
              cwd: scriptsDir || void 0,
              env: { ...process.env, ARCHIVE_DIR: folder, ARCHIVE_FOLDER: folder, ARCHIVE_LOG_FILE: folder + "/run-" + tag + ".log", ARCHIVE_PROFILE_FILE: folder + "/run-" + tag + ".profile.json", ARCHIVE_PIPELINE: pipeName, ARCHIVE_TAG: tag, ARCHIVE_RESULT: status },
              timeout: 12e4,
              maxBuffer: 4 * 1024 * 1024,
              windowsHide: true
            }, (err) => {
              if (err) console.warn("[archive] \u5F52\u6863\u811A\u672C\u9000\u51FA\u7801 " + (err.code ?? err) + "\uFF08\u4E0D\u5F71\u54CD\u6267\u884C\uFF09");
              resolve();
            });
          });
        } catch (e) {
          console.warn("[archive] \u5F52\u6863\u811A\u672C\u6267\u884C\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u6267\u884C\uFF09:", e);
        }
      }
    }
    await appendPipelineHistory({
      no: 0,
      pipeline: pl.pipelineName || "",
      env: pl.env || "",
      commit: randHex(7),
      status,
      dur: durText((Date.now() - t0) / 1e3),
      time: "\u4ECA\u5929 " + hhmm(),
      by: pl.by || "schedule",
      logs,
      tag,
      archive: folder || null
    });
  }
  async function planTick() {
    const plans = await readPlansFile();
    const now = Date.now();
    for (const p of plans) {
      if (!p || typeof p.id !== "string" || planRunning.has(p.id)) continue;
      if (p.kind === "once") {
        if (!(Number(p.at) > 0) || Number(p.at) > now) continue;
        planRunning.add(p.id);
        execPlan(p).catch(() => {
        }).finally(async () => {
          planRunning.delete(p.id);
          const rest = (await readPlansFile()).filter((x) => x && x.id !== p.id);
          await writeJsonAtomic(PLANS_STORE, JSON.stringify({ plans: rest })).catch(() => {
          });
        });
      } else if (p.kind === "interval") {
        const unit = typeof p.everyUnit === "string" && p.everyUnit ? p.everyUnit : "min";
        const every = Math.max(1, Number(p.every) || Number(p.everyMin) || 10);
        const startAt = Number(p.startAt) || 0;
        if (startAt && now < startAt) continue;
        const base = startAt || Number(p.createdAt) || now;
        const last = planLastRun.get(p.id) || (startAt ? base - 1 : base);
        const FIXED_MS = { min: 6e4, hour: 36e5, day: 864e5, week: 6048e5 };
        let next;
        if (FIXED_MS[unit]) {
          const step = FIXED_MS[unit] * every;
          next = base + (Math.floor((last - base) / step) + 1) * step;
        } else {
          next = base;
          const d = new Date(base);
          let guard = 0;
          while (next <= last && guard++ < 5e3) {
            if (unit === "year") d.setFullYear(d.getFullYear() + every);
            else d.setMonth(d.getMonth() + every);
            next = d.getTime();
          }
        }
        if (next > now) continue;
        planLastRun.set(p.id, now);
        planRunning.add(p.id);
        execPlan(p).catch(() => {
        }).finally(() => planRunning.delete(p.id));
      }
    }
  }
  setInterval(() => {
    planTick().catch(() => {
    });
  }, 15e3);
  webServer.register({
    kind: "exact",
    path: "/api/worktable/exec",
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        const path = typeof body.path === "string" ? body.path : "";
        if (!path) {
          json(res, 400, { error: "missing path" });
          return;
        }
        const args = Array.isArray(body.args) ? body.args.map((a) => String(a)) : [];
        const envIn = body.env && typeof body.env === "object" ? body.env : {};
        const env = {};
        for (const k of Object.keys(envIn)) {
          const v = envIn[k];
          if (v !== void 0 && v !== null) env[k] = String(v);
        }
        const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : void 0;
        const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 12e4, 1e3), 36e5);
        const interp = /\.py$/i.test(path) ? "python3" : "bash";
        execFile(
          interp,
          [path, ...args],
          { cwd, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) => {
            const code = err ? typeof err.code === "number" ? err.code : 1 : 0;
            json(res, 200, { code, stdout: String(stdout || ""), stderr: String(stderr || "") });
          }
        );
      } catch (err) {
        json(res, 500, { error: String(err && err.message ? err.message : err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/write",
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        const p = typeof body.path === "string" ? body.path : "";
        const content = typeof body.content === "string" ? body.content : "";
        if (!p) {
          json(res, 400, { error: "missing path" });
          return;
        }
        if (content.length > 20 * 1024 * 1024) {
          json(res, 413, { error: "content too large" });
          return;
        }
        const abs = pathResolve(p);
        await import("node:fs/promises").then((m) => m.writeFile(abs, content, "utf8"));
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/mkdir",
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        const p = typeof body.path === "string" ? body.path.trim() : "";
        if (!p) {
          json(res, 400, { error: "missing path" });
          return;
        }
        const abs = pathResolve(p);
        const fsx = await import("node:fs/promises");
        const parent = dirname(abs);
        try {
          await fsx.access(parent);
        } catch {
          json(res, 400, { error: "parent not found" });
          return;
        }
        await fsx.mkdir(abs);
        json(res, 200, { ok: true, path: abs });
      } catch (err) {
        json(res, err?.code === "EEXIST" ? 200 : 500, err?.code === "EEXIST" ? { ok: true, exists: true } : { error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/git",
    handler: async (req, res) => {
      const body = await readJsonBody(req);
      const cwd = serverCwd(ctx, body.sessionId, body.cwd);
      json(res, 200, await gitStatus(cwd));
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/git-remote",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      const url = typeof body.url === "string" ? body.url.trim() : "";
      const user = typeof body.user === "string" ? body.user : "";
      const pass = typeof body.pass === "string" ? body.pass : "";
      if (!url) {
        json(res, 400, { ok: false, error: "missing url" });
        return;
      }
      let fetchUrl = url;
      if ((user || pass) && /^https?:\/\//i.test(url)) {
        try {
          const u = new URL(url);
          if (user) u.username = user;
          if (pass) u.password = pass;
          fetchUrl = u.toString();
        } catch {
        }
      }
      const args = ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "ls-remote", "--heads", "--tags", fetchUrl];
      const r = await new Promise((resolve) => {
        execFile("git", args, { timeout: 2e4, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          const code = err ? typeof err.code === "number" ? err.code : 1 : 0;
          resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
        });
      });
      if (r.code === 0) {
        const branches = [];
        const tags = [];
        for (const line of r.stdout.split("\n")) {
          const s = line.trim();
          let m = /^[0-9a-f]+\trefs\/heads\/(.+)$/.exec(s);
          if (m) {
            if (!branches.includes(m[1])) branches.push(m[1]);
            continue;
          }
          m = /^[0-9a-f]+\trefs\/tags\/([^^]+)$/.exec(s);
          if (m) {
            if (!tags.includes(m[1])) tags.push(m[1]);
          }
        }
        json(res, 200, { ok: true, branches, tags });
      } else {
        json(res, 200, { ok: false, error: (r.stderr || r.stdout || "git ls-remote failed").trim().slice(0, 2e3) });
      }
    }
  });
  setupTerminal(webServer, ctx);
  webServer.register({
    kind: "exact",
    path: PROXY_PATH,
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        const urlStr = typeof body.url === "string" ? body.url.trim() : "";
        const method = (typeof body.method === "string" ? body.method : "GET").toUpperCase();
        if (!urlStr) {
          json(res, 400, { error: "missing url" });
          return;
        }
        let target;
        try {
          target = new URL(urlStr);
        } catch {
          json(res, 400, { error: "bad url" });
          return;
        }
        if (!/^https?:$/.test(target.protocol)) {
          json(res, 400, { error: "unsupported protocol" });
          return;
        }
        if (!isLocalTarget(target.hostname)) {
          json(res, 403, { error: "only loopback/private targets allowed" });
          return;
        }
        const headers = {};
        if (body.headers && typeof body.headers === "object") {
          for (const [k, v] of Object.entries(body.headers)) {
            if (typeof v === "string") headers[k] = v;
          }
        }
        const reqBody = method === "GET" || method === "HEAD" ? void 0 : typeof body.body === "string" ? body.body : void 0;
        const fwdHeaders = {};
        for (const [k, v] of Object.entries(headers)) {
          const lk = k.toLowerCase();
          if (lk === "host" || lk === "content-length" || lk === "connection") continue;
          fwdHeaders[k] = v;
        }
        const reqLib = await (target.protocol === "https:" ? import("node:https") : import("node:http"));
        const result = await new Promise((resolve, reject) => {
          const r = reqLib.request(urlStr, { method, headers: fwdHeaders }, (resp) => {
            const chunks = [];
            resp.on("data", (c) => chunks.push(c));
            resp.on("end", () => resolve({ status: resp.statusCode ?? 0, headers: resp.headers, body: Buffer.concat(chunks) }));
            resp.on("error", reject);
          });
          r.on("error", reject);
          r.setTimeout(2e4, () => {
            try {
              r.destroy(new Error("timeout"));
            } catch {
            }
          });
          if (reqBody) r.write(reqBody);
          r.end();
        });
        if (result.body.length > 20 * 1024 * 1024) {
          json(res, 502, { error: "response too large" });
          return;
        }
        const outHeaders = {};
        for (const k of Object.keys(result.headers)) outHeaders[k] = String(result.headers[k]);
        json(res, 200, {
          status: result.status,
          statusText: "",
          headers: outHeaders,
          contentType: String(result.headers["content-type"] ?? ""),
          finalUrl: urlStr,
          body: result.body.toString("utf8")
        });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
    }
  });
}
export {
  HEALTH_PATH,
  PROXY_PATH,
  apply,
  inject,
  name
};
