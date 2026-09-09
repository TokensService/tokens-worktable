// src/index.ts
import { execFile, spawn } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { readdir, readFile, mkdir as fsMkdir, open as fsOpen, stat as fsStat } from "node:fs/promises";
import { basename, dirname, resolve as pathResolve, sep } from "node:path";
import { createRequire } from "node:module";
import { homedir, networkInterfaces } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// template/dshell.css
var dshell_default = `/* tokens-worktable \u539F\u751F\u76AE\u80A4 \xB7 DSH \u8BBE\u8BA1\u7CFB\u7EDF\u7EC4\u4EF6\u5E93
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
var dshell_default2 = '<!doctype html>\n<!-- tokens-worktable \u539F\u751F\u76AE\u80A4\u6A21\u677F\uFF1A\u65B0\u9875\u9762\u4EE5\u6B64\u4E3A\u57FA\u7840\uFF0C\u66FF\u6362\u4E0B\u9762\u793A\u4F8B\u5185\u5BB9\u5373\u53EF\u3002\n     \u6837\u5F0F\u8868\u7531\u63D2\u4EF6\u63D0\u4F9B\uFF08\u968F\u4E3B\u9898\u81EA\u52A8\u9002\u914D\uFF09\uFF0C\u4E0D\u8981\u590D\u5236\u6216\u6539\u5199\u5B83\u3002 -->\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>\u6211\u7684\u7A97\u53E3</title>\n  <link rel="stylesheet" href="/api/worktable/template/dshell.css" />\n</head>\n<body>\n  <div class="dshell">\n    <!-- \u6807\u9898\u533A -->\n    <h1 class="dshell-title">\u7A97\u53E3\u6807\u9898</h1>\n    <p class="dshell-sub">\u4E00\u53E5\u8BDD\u8BF4\u660E\u8FD9\u4E2A\u7A97\u53E3\u505A\u4EC0\u4E48\u3002</p>\n\n    <!-- \u72B6\u6001\u5FBD\u6807\uFF1A\u5DF2\u5B8C\u6210 dshell-badgeDone / \u8FDB\u884C\u4E2D dshell-badgeWait / \u9ED8\u8BA4 -->\n    <div>\n      <span class="dshell-badge dshell-badgeDone">\u5DF2\u5B8C\u6210</span>\n      <span class="dshell-badge dshell-badgeWait">\u8FDB\u884C\u4E2D</span>\n      <span class="dshell-badge">\u672A\u5F00\u59CB</span>\n    </div>\n\n    <!-- \u6807\u7B7E\u9875 -->\n    <div class="dshell-tabs">\n      <button class="dshell-tab dshell-tabOn">\u6982\u89C8</button>\n      <button class="dshell-tab">\u8BE6\u60C5</button>\n      <button class="dshell-tab">\u8BBE\u7F6E</button>\n    </div>\n\n    <!-- \u7EDF\u8BA1\u5361\u7247\u7F51\u683C -->\n    <div class="dshell-grid">\n      <div class="dshell-stat">\n        <div class="dshell-statLabel">\u603B\u6570</div>\n        <div class="dshell-statValue">128</div>\n        <div class="dshell-statDelta">+12.4%</div>\n      </div>\n      <div class="dshell-stat">\n        <div class="dshell-statLabel">\u8FDB\u884C\u4E2D</div>\n        <div class="dshell-statValue">7</div>\n      </div>\n      <div class="dshell-stat">\n        <div class="dshell-statLabel">\u5DF2\u5B8C\u6210</div>\n        <div class="dshell-statValue">121</div>\n      </div>\n    </div>\n\n    <!-- \u5217\u8868 -->\n    <div class="dshell-list">\n      <div class="dshell-listItem">\n        <span class="dshell-listItemTitle">\u6761\u76EE\u4E00\uFF1A\u793A\u4F8B\u5185\u5BB9\u6807\u9898</span>\n        <span class="dshell-listItemMeta">\u6628\u5929</span>\n      </div>\n      <div class="dshell-listItem">\n        <span class="dshell-listItemTitle">\u6761\u76EE\u4E8C\uFF1A\u793A\u4F8B\u5185\u5BB9\u6807\u9898</span>\n        <span class="dshell-badge dshell-badgeDone">\u5DF2\u53D1\u5E03</span>\n      </div>\n    </div>\n\n    <!-- \u5361\u7247 + \u952E\u503C\u5BF9 -->\n    <div class="dshell-card">\n      <h2 class="dshell-sub" style="margin:0 0 8px">\u8BE6\u60C5</h2>\n      <div class="dshell-kv">\n        <div class="dshell-kvRow"><span class="dshell-kvKey">\u5B57\u6BB5 A</span><span class="dshell-kvValue">\u503C A</span></div>\n        <div class="dshell-kvRow"><span class="dshell-kvKey">\u5B57\u6BB5 B</span><span class="dshell-kvValue">\u503C B</span></div>\n      </div>\n      <div class="dshell-divider"></div>\n      <div class="dshell-progress"><div class="dshell-progressBar" style="width:72%"></div></div>\n    </div>\n\n    <!-- \u64CD\u4F5C\u533A -->\n    <div style="display:flex;gap:8px">\n      <button class="dshell-btn">\u4E3B\u8981\u64CD\u4F5C</button>\n      <button class="dshell-btn dshell-btnGhost">\u6B21\u8981\u64CD\u4F5C</button>\n    </div>\n  </div>\n</body>\n</html>\n';

// src/index.ts
var PLUGIN_VERSION = false ? "dev" : "1.0.3";
var name = "tokens-worktable";
var inject = ["webServer", "sessions"];
var PLUGIN_DIR = (() => {
  try {
    return pathResolve(realpathSync(dirname(fileURLToPath(import.meta.url))), "..");
  } catch {
  }
  try {
    return pathResolve(dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
  }
  return process.cwd();
})();
function inferDshHomeFromModuleDir(libDir) {
  let pkgDir = pathResolve(libDir, "..");
  if (basename(dirname(pkgDir)).startsWith("@")) pkgDir = dirname(pkgDir);
  const nmDir = dirname(pkgDir);
  if (basename(nmDir) !== "node_modules") return null;
  const profilesDir = dirname(dirname(nmDir));
  if (basename(profilesDir) !== "profiles") return null;
  return dirname(profilesDir);
}
function resolveDshHomeEnv(raw, home) {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (v === "~") return pathResolve(home);
  if (v.startsWith("~/") || v.startsWith("~\\")) return pathResolve(home, v.slice(2));
  return pathResolve(v);
}
var DSH_HOME = (() => {
  try {
    const h = inferDshHomeFromModuleDir(dirname(fileURLToPath(import.meta.url)));
    if (h) return h;
  } catch {
  }
  try {
    const h = inferDshHomeFromModuleDir(realpathSync(dirname(fileURLToPath(import.meta.url))));
    if (h) return h;
  } catch {
  }
  return resolveDshHomeEnv(process.env.DSH_HOME, homedir()) ?? pathResolve(homedir(), ".dsh");
})();
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
    const profilesDir = pathResolve(DSH_HOME, "profiles");
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
async function readLocalFile(abs, tailBytesRaw) {
  const stat = await fsStat(abs);
  const requested = Number.parseInt(tailBytesRaw || "", 10);
  if (!Number.isFinite(requested) || requested <= 0) {
    if (stat.size > 256 * 1024 * 1024) {
      const err = new Error("file too large");
      err.statusCode = 413;
      throw err;
    }
    return { data: await readFile(abs), size: stat.size, truncated: false };
  }
  const tailBytes = Math.min(Math.max(requested, 1024), 4 * 1024 * 1024);
  if (stat.size <= tailBytes) return { data: await readFile(abs), size: stat.size, truncated: false };
  const handle = await fsOpen(abs, "r");
  try {
    const data = Buffer.allocUnsafe(tailBytes + 1);
    const { bytesRead } = await handle.read(data, 0, tailBytes + 1, stat.size - tailBytes - 1);
    const startsAtLine = data[0] === 10;
    let tail = data.subarray(1, bytesRead);
    if (!startsAtLine) {
      const firstNewline = tail.indexOf(10);
      if (firstNewline >= 0 && firstNewline < tail.length - 1) tail = tail.subarray(firstNewline + 1);
    }
    return { data: tail, size: stat.size, truncated: true };
  } finally {
    await handle.close();
  }
}
function cleanPipelineHistory(history) {
  const transient = /* @__PURE__ */ new Set(["_lc", "_lm", "_ll", "_profChecked"]);
  return history.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return record;
    const clean = {};
    for (const [key, value] of Object.entries(record)) if (!transient.has(key)) clean[key] = value;
    return clean;
  });
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
  ctx.logger?.info?.("[tokens-worktable] term deps: ws=" + (wsMod ? "ok" : "MISSING") + " node-pty=" + (ptyMod ? "ok" : "MISSING"));
  if (!wsMod || !ptyMod) {
    ctx.logger?.warn("[tokens-worktable] \u7EC8\u7AEF\u8DEF\u7531\u672A\u6CE8\u518C\uFF1Aws/node-pty \u4E0D\u53EF\u7528");
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
  }), "tokens-worktable: terminal upgrade");
}
function apply(ctx) {
  const webServer = ctx.webServer;
  if (!webServer) {
    ctx.logger?.warn("[tokens-worktable] ctx.webServer \u4E0D\u53EF\u7528\uFF08headless profile\uFF1F\uFF09\uFF0C\u8DF3\u8FC7\u670D\u52A1\u7AEF\u8DEF\u7531");
    return;
  }
  webServer.register({
    kind: "exact",
    path: HEALTH_PATH,
    handler: (_req, res) => {
      json(res, 200, { plugin: "tokens-worktable", version: PLUGIN_VERSION, dir: PLUGIN_DIR, home: DSH_HOME, ok: true });
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
        const file = await readLocalFile(abs, u.searchParams.get("tailBytes"));
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
        res.writeHead(200, {
          "content-type": FILE_TYPES[ext] ?? "application/octet-stream",
          "cache-control": "no-store",
          "x-worktable-file-size": String(file.size),
          "x-worktable-file-truncated": file.truncated ? "tail" : "none"
        });
        res.end(file.data);
      } catch (err) {
        json(res, err?.statusCode === 413 ? 413 : 404, { error: String(err) });
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
        const file = pathResolve(DSH_HOME, "storages", "workspace.json");
        const raw = await readFile(file, "utf8");
        json(res, 200, JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw));
      } catch (err) {
        json(res, 404, { error: String(err) });
      }
    }
  });
  const PROJECTS_STORE = pathResolve(DSH_HOME, "storages", "worktable-projects.json");
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
            folders: p.folders && typeof p.folders === "object" ? p.folders : {},
            workspaces: p.workspaces && typeof p.workspaces === "object" ? p.workspaces : {},
            prompts: p.prompts && typeof p.prompts === "object" ? p.prompts : {}
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
          const workspaces = {};
          if (body.workspaces && typeof body.workspaces === "object") {
            for (const [k, v] of Object.entries(body.workspaces)) if (typeof v === "string") workspaces[k] = v;
          }
          const prompts = {};
          if (body.prompts && typeof body.prompts === "object") {
            for (const [k, v] of Object.entries(body.prompts)) if (typeof v === "string") prompts[k] = v;
          }
          const text = JSON.stringify({ layouts, folders, workspaces, prompts });
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
  const PIPELINE_STORE = pathResolve(DSH_HOME, "storages", "worktable-pipeline.json");
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
            history: Array.isArray(p.history) ? cleanPipelineHistory(p.history) : []
          });
          return;
        }
        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          const config = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config : {};
          const history = Array.isArray(body.history) ? cleanPipelineHistory(body.history.slice(0, 500)) : [];
          await withStoreLock(async () => {
            const disk = await readPipelineStore();
            const diskCfg = disk.config && typeof disk.config === "object" && !Array.isArray(disk.config) ? disk.config : {};
            const diskHistory = Array.isArray(disk.history) ? cleanPipelineHistory(disk.history) : [];
            const clearedAt = Math.max(Number(config.histClearedAt) || 0, Number(diskCfg.histClearedAt) || 0);
            if (clearedAt) config.histClearedAt = clearedAt;
            config.buildNo = Math.max(Number(config.buildNo) || 0, Number(diskCfg.buildNo) || 0);
            const keyOf = (r) => r && r.tag ? "tag:" + r.tag : r && r.ts ? "ts:" + r.ts : "no:" + (r && r.no) + ":" + (r && r.pipeline);
            const seen = new Set(history.map(keyOf));
            const serverOnly = diskHistory.filter((r) => !seen.has(keyOf(r)) && (clearedAt ? (Number(r && r.ts) || 0) > clearedAt : true));
            const merged = history.concat(serverOnly);
            merged.sort((a, b) => (Number(b && b.ts) || 0) - (Number(a && a.ts) || 0));
            if (merged.length > 500) merged.length = 500;
            let text = JSON.stringify({ config, history: merged });
            while (text.length > 20 * 1024 * 1024 && merged.length > 1) {
              merged.pop();
              text = JSON.stringify({ config, history: merged });
            }
            await writeJsonAtomic(PIPELINE_STORE, text);
          });
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
  const PLANS_STORE = pathResolve(DSH_HOME, "storages", "worktable-pipeline-plans.json");
  async function writeJsonAtomic(file, text) {
    const fsx = await import("node:fs/promises");
    await fsx.mkdir(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    await fsx.writeFile(tmp, text, "utf8");
    await fsx.rename(tmp, file);
  }
  let storeChain = Promise.resolve();
  function withStoreLock(fn) {
    const p = storeChain.then(fn);
    storeChain = p.then(() => void 0, () => void 0);
    return p;
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
  const queuePresence = /* @__PURE__ */ new Map();
  const QUEUE_PRESENCE_CAP = 100;
  const QUEUE_PRESENCE_TTL = 45 * 1e3;
  function cleanQueueEntry(e, timeKey) {
    if (!e || typeof e !== "object") return null;
    const o = {};
    for (const k of ["by", "pipelineName", "env", "source"]) o[k] = String(e[k] ?? "").slice(0, 200);
    const t = Number(e[timeKey]);
    o[timeKey] = Number.isFinite(t) ? t : 0;
    return o;
  }
  webServer.register({
    kind: "exact",
    path: "/api/worktable/pipeline/queue",
    handler: async (req, res) => {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          const body = await readJsonBody(req);
          const id = typeof body.id === "string" ? body.id.slice(0, 64) : "";
          if (!id) {
            json(res, 400, { error: "missing id" });
            return;
          }
          const running = body.running === null || body.running === void 0 ? null : cleanQueueEntry(body.running, "startedAt");
          const queue = (Array.isArray(body.queue) ? body.queue : []).slice(0, 20).map((q) => cleanQueueEntry(q, "queuedAt")).filter((q) => !!q);
          if (queuePresence.size >= QUEUE_PRESENCE_CAP && !queuePresence.has(id)) {
            let oldestKey = "", oldestAt = Infinity;
            for (const [k, v] of queuePresence) if (v.seenAt < oldestAt) {
              oldestAt = v.seenAt;
              oldestKey = k;
            }
            if (oldestKey) queuePresence.delete(oldestKey);
          }
          queuePresence.set(id, {
            id,
            label: (typeof body.label === "string" ? body.label : "").slice(0, 64),
            running,
            queue,
            seenAt: Date.now()
          });
          json(res, 200, { ok: true });
          return;
        }
        if (req.method === "GET") {
          const now = Date.now();
          for (const [k, v] of queuePresence) if (now - v.seenAt > QUEUE_PRESENCE_TTL) queuePresence.delete(k);
          const clients = [];
          for (const v of queuePresence.values()) {
            if (!v.running && !v.queue.length) continue;
            clients.push({ id: v.id, label: v.label, seenAgo: Math.max(0, Math.round((now - v.seenAt) / 1e3)), running: v.running, queue: v.queue });
          }
          json(res, 200, { clients });
          return;
        }
        res.writeHead(405);
        res.end();
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
    }
  });
  const LOGDUMP_FILE = pathResolve(DSH_HOME, "storages", "worktable-pipeline-logs.md");
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
  function parseHostPort(ip) {
    const m = /^([^:]+):(\d+)$/.exec(ip.trim());
    if (m) return { host: m[1], port: m[2] };
    return { host: ip.trim(), port: "" };
  }
  async function queryGpu(ip, user, pass) {
    let out;
    const { host, port } = parseHostPort(ip);
    if (localAddrs().has(host)) {
      out = await execText("bash", ["-c", GPU_PROBE]);
    } else {
      const target = user ? user + "@" + host : host;
      const remoteCmd = "echo " + Buffer.from(GPU_PROBE).toString("base64") + " | base64 -d | bash";
      const sshArgs = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=8", ...port ? ["-p", port] : [], target, remoteCmd];
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
  function parseStageVars(stdout) {
    const out = {};
    String(stdout || "").split("\n").forEach((line) => {
      const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m) {
        let v = m[2].replace(/\r$/, "");
        if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1);
        out[m[1]] = v;
        return;
      }
      const t = line.trim();
      if (t.length < 2 || t.charAt(0) !== "{" || t.charAt(t.length - 1) !== "}") return;
      try {
        const o = JSON.parse(t);
        if (!o || typeof o !== "object" || Array.isArray(o)) return;
        for (const k in o) {
          const v = o[k];
          if (v === null || v === void 0 || typeof v === "object") continue;
          out[k] = String(v);
        }
      } catch {
      }
    });
    return out;
  }
  function parseStageJson(stdout) {
    let found = null;
    String(stdout || "").split("\n").forEach((line) => {
      const t = line.trim();
      if (t.length < 2) return;
      const c0 = t.charAt(0), c1 = t.charAt(t.length - 1);
      if (!(c0 === "{" && c1 === "}" || c0 === "[" && c1 === "]")) return;
      try {
        const o = JSON.parse(t);
        if (o && typeof o === "object") found = o;
      } catch {
      }
    });
    return found;
  }
  function jsonPathGet(obj, path) {
    const p = String(path || "").trim().replace(/^\$\.?/, "");
    if (!p) return void 0;
    const tokens = p.match(/[^.\[\]]+|\[-?\d+\]/g);
    if (!tokens) return void 0;
    let cur = obj;
    for (const t of tokens) {
      if (cur === null || cur === void 0) return void 0;
      const idx = /^\[(-?\d+)\]$/.exec(t);
      if (Array.isArray(cur)) {
        const i = parseInt(idx ? idx[1] : t, 10);
        if (isNaN(i)) return void 0;
        const at = i < 0 ? cur.length + i : i;
        if (at < 0 || at >= cur.length) return void 0;
        cur = cur[at];
      } else if (typeof cur === "object") {
        if (idx) return void 0;
        cur = cur[t];
      } else return void 0;
    }
    return cur === null || cur === void 0 ? void 0 : cur;
  }
  function applyOutVars(spec, pool, jsonCtx, fullText) {
    String(spec || "").split(",").forEach((pair) => {
      const p = pair.trim();
      if (!p) return;
      const eq = p.indexOf("=");
      const dst = (eq >= 0 ? p.slice(0, eq) : p).trim(), src = (eq >= 0 ? p.slice(eq + 1) : p).trim();
      if (!dst) return;
      let val;
      if (src === "*" || eq >= 0 && src === "") val = fullText;
      else {
        val = pool[src];
        if (val === void 0 && jsonCtx) {
          if (/[.\[\]$]/.test(src)) val = jsonPathGet(jsonCtx, src);
          else if (!Array.isArray(jsonCtx) && Object.prototype.hasOwnProperty.call(jsonCtx, src)) val = jsonCtx[src];
        }
      }
      if (val === void 0 || val === null) return;
      pool[dst] = typeof val === "object" ? JSON.stringify(val) : String(val);
    });
  }
  function substRunVars(v, look) {
    const s = String(v === void 0 || v === null ? "" : v);
    if (s.indexOf("${") < 0) return s;
    const single = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(s);
    if (single && look[single[1]] === void 0) return "";
    return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => look[k] !== void 0 ? String(look[k]) : m);
  }
  const ENV_VAL_LIMIT = 128 * 1024;
  function dropOversizeEnv(env) {
    const dropped = [];
    for (const k of Object.keys(env)) {
      const size = Buffer.byteLength(k) + 1 + Buffer.byteLength(env[k]);
      if (size >= ENV_VAL_LIMIT) {
        dropped.push(k + "\uFF08" + size + " \u5B57\u8282\uFF09");
        delete env[k];
      }
    }
    return dropped.length ? "[warn] \u73AF\u5883\u53D8\u91CF " + dropped.join("\u3001") + " \u8D85\u8FC7\u5355\u53D8\u91CF 128KiB \u4E0A\u9650\uFF0C\u672A\u6CE8\u5165\uFF1B\u8BF7\u7528\u300C\u8F93\u51FA\u53D8\u91CF\u300DJSON \u8DEF\u5F84\u622A\u53D6\u6240\u9700\u5B57\u6BB5\uFF08\u5982 XDS_BRANCH=items.0.name\uFF09" : null;
  }
  function runStageScript(sc, runCtx, scriptsDir, varsPool, timeoutSec) {
    const pool = varsPool || {};
    const ctx0 = runCtx.envs && runCtx.envs[0] || null;
    const look = {};
    if (ctx0 && ctx0.ip || runCtx.env) look.TARGET_IP = String(ctx0 && ctx0.ip || runCtx.env || "");
    if (runCtx.envs) look.TARGET_IPS = JSON.stringify((runCtx.envs || []).map((e) => e.ip));
    if (runCtx.image) look.IMAGE_NAME = String(runCtx.image);
    if (runCtx.tag) look.IMAGE_TAG = String(runCtx.tag);
    if (runCtx.pipelineName) look.PIPELINE_NAME = String(runCtx.pipelineName);
    if (runCtx.branch) look.GIT_BRANCH = String(runCtx.branch);
    if (runCtx.strategy) look.DEPLOY_STRATEGY = String(runCtx.strategy);
    if (runCtx.archive) {
      look.ARCHIVE_DIR = String(runCtx.archive);
      look.ARCHIVE_FOLDER = String(runCtx.archive);
    }
    Object.assign(look, pool);
    const args = [];
    const env = {};
    for (const p of sc.params || []) {
      const hasVal = sc.values && sc.values[p.key] !== void 0;
      const v = substRunVars(hasVal ? sc.values[p.key] : "", look);
      if (p.kind === "pos") args.push(String(v));
      else if (String(v) !== "") env[p.key] = String(v);
    }
    for (const k of Object.keys(pool)) {
      if (env[k] === void 0) env[k] = String(pool[k]);
    }
    if (env.TARGET_IP === void 0) env.TARGET_IP = String(ctx0 && ctx0.ip || runCtx.env || "");
    if (env.TARGET_IPS === void 0 && runCtx.envs) env.TARGET_IPS = JSON.stringify((runCtx.envs || []).map((e) => e.ip));
    if (env.TARGET_HOSTS === void 0 && runCtx.envs) env.TARGET_HOSTS = JSON.stringify((runCtx.envs || []).map((e) => ({ ip: e.ip, user: e.user || "", pass: e.pass || "" })));
    if (env.IMAGE_NAME === void 0 && runCtx.image) env.IMAGE_NAME = String(runCtx.image);
    if (env.IMAGE_TAG === void 0 && runCtx.tag) env.IMAGE_TAG = String(runCtx.tag);
    if (env.PIPELINE_NAME === void 0 && runCtx.pipelineName) env.PIPELINE_NAME = String(runCtx.pipelineName);
    if (env.GIT_BRANCH === void 0 && runCtx.branch) env.GIT_BRANCH = String(runCtx.branch);
    if (env.DEPLOY_STRATEGY === void 0 && runCtx.strategy) env.DEPLOY_STRATEGY = String(runCtx.strategy);
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
    const oversizeWarn = dropOversizeEnv(env);
    const timeoutMs = timeoutSec ? Math.min(Math.max(Number(timeoutSec), 1), 3600) * 1e3 : 0;
    return new Promise((resolve) => {
      const isPy = sc.lang === "py" || /\.py$/i.test(sc.name || "");
      execFile(
        isPy ? "python3" : "bash",
        [sc.path, ...args],
        { cwd: scriptsDir || void 0, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? typeof err.code === "number" ? err.code : 1 : 0;
          let errText = String(stderr || "");
          if (err && err.killed) {
            const why = err.code === "ENOBUFS" ? "\u8F93\u51FA\u8D85\u8FC7 256MB \u7F13\u51B2\u4E0A\u9650\uFF08ENOBUFS\uFF09\uFF0C\u8FDB\u7A0B\u88AB\u7EC8\u6B62" : "exec timed out after " + Math.round(timeoutMs / 1e3) + "s\uFF08\u9636\u6BB5\u8D85\u65F6\uFF0C\u8FDB\u7A0B\u88AB\u7EC8\u6B62\uFF1B\u53EF\u5728\u6D41\u6C34\u7EBF\u7F16\u8F91\u5668\u8C03\u5927\u8BE5\u9636\u6BB5\u300C\u8D85\u65F6(\u5206\u949F)\u300D\uFF09";
            errText = (errText ? errText + "\n" : "") + why;
          }
          resolve({ code, stdout: String(stdout || ""), stderr: (oversizeWarn ? oversizeWarn + "\n" : "") + errText });
        }
      );
    });
  }
  function stageLogText(name2, r) {
    const interp = /\.py$/i.test(name2) ? "python3" : "bash";
    let t = "$ " + interp + " " + name2 + "\n" + (r.stdout || "");
    if (r.stderr) t += "\n\u2717 " + r.stderr.split("\n").join("\n\u2717 ");
    return t + "\n[exit " + r.code + "]";
  }
  async function appendPipelineHistory(rec) {
    await withStoreLock(async () => {
      const j = await readPipelineStore();
      const cfg = j.config && typeof j.config === "object" && !Array.isArray(j.config) ? j.config : {};
      const history = Array.isArray(j.history) ? cleanPipelineHistory(j.history) : [];
      const no = Math.max(Number(cfg.buildNo) || 0, ...history.map((h) => Number(h && h.no) || 0), 0) + 1;
      cfg.buildNo = no;
      rec.no = no;
      if (!rec.ts) rec.ts = Date.now();
      history.unshift(rec);
      let text = JSON.stringify({ config: cfg, history: history.slice(0, 500) });
      while (text.length > 20 * 1024 * 1024 && history.length > 1) {
        history.pop();
        text = JSON.stringify({ config: cfg, history: history.slice(0, 500) });
      }
      await writeJsonAtomic(PIPELINE_STORE, text);
    });
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
    const runCtx = { env: pl.env || "", envs: Array.isArray(pl.envs) ? pl.envs : [], archive: folder, tag, pipelineName: pipeName, image: pl.image || "", branch: pl.branch || "", strategy: pl.strategy || "" };
    const varsPool = {};
    if (pl.vars && typeof pl.vars === "object" && !Array.isArray(pl.vars)) {
      for (const k of Object.keys(pl.vars)) {
        const v = pl.vars[k];
        if (v !== void 0 && v !== null) varsPool[k] = String(v);
      }
    }
    const logs = [];
    const histLogs = [];
    const profileStages = [];
    let status = "success";
    const pushHist = (stage, st, text, logFile, durSec) => {
      const e = { stage, status: st, dur: durSec };
      if (logFile) e.logFile = logFile;
      else e.log = text;
      histLogs.push(e);
    };
    if (cfg.cleanupEnabled && cfg.cleanupScript && cfg.cleanupScript.path) {
      const st0 = Date.now();
      const r = await runStageScript(cfg.cleanupScript, runCtx, scriptsDir, varsPool);
      const text = stageLogText(cfg.cleanupScript.name, r);
      const logFile = folder ? await writeTaskLogFile(folder, tag, 0, "\u73AF\u5883\u6E05\u7406", text) : null;
      logs.push({ stage: "\u73AF\u5883\u6E05\u7406", status: r.code === 0 ? "success" : "failed", log: text });
      pushHist("\u73AF\u5883\u6E05\u7406", r.code === 0 ? "success" : "failed", text, logFile, Math.round((Date.now() - st0) / 100) / 10);
      profileStages.push({ id: "__cleanup__", name: "\u73AF\u5883\u6E05\u7406", status: r.code === 0 ? "success" : "failed", durSec: Math.round((Date.now() - st0) / 100) / 10, script: cfg.cleanupScript.name || null, logFile });
    }
    let seq = baseSeq + 1;
    for (const s of pl.stages || []) {
      const st0 = Date.now();
      let entry = null;
      if (s.skip || s.gate) {
        entry = { status: "skipped", text: "[\u5B9A\u65F6\u6267\u884C] \u672C\u9636\u6BB5\u914D\u7F6E\u4E3A\u4E0D\u6267\u884C\uFF0C\u5DF2\u8DF3\u8FC7" };
      } else if (s.kind === "http" || s.kind === "url" || s.kind === "jenkins" || s.kind === "evaltokens") {
        entry = { status: "success", text: "[\u5B9A\u65F6\u6267\u884C] HTTP/EvalTokens \u9636\u6BB5\uFF1A\u5B9A\u65F6\u89E6\u53D1\u6682\u4E0D\u652F\u6301\uFF0C\u5DF2\u8DF3\u8FC7" };
      } else if (s.script && s.script.path) {
        const r = await runStageScript(s.script, runCtx, scriptsDir, varsPool, s.timeout);
        Object.assign(varsPool, parseStageVars(r.stdout));
        applyOutVars(s.script.outVars, varsPool, parseStageJson(r.stdout), r.stdout);
        entry = { status: r.code === 0 ? "success" : "failed", text: stageLogText(s.script.name, r) };
        if (r.code !== 0) status = "failed";
      } else {
        await sleepMs(Math.min(Math.max(1, Number(s.dur) || 5), 60) * 1e3);
        entry = { status: "success", text: "[\u5B9A\u65F6\u6267\u884C] \u6A21\u62DF\u9636\u6BB5\u5B8C\u6210" };
      }
      const logFile = folder ? await writeTaskLogFile(folder, tag, seq, s.name, entry.text) : null;
      logs.push({ stage: s.name, status: entry.status, log: entry.text });
      pushHist(s.name, entry.status, entry.text, logFile, Math.round((Date.now() - st0) / 100) / 10);
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
        if (Object.keys(varsPool).length) profile.vars = Object.assign({}, profile.vars || {}, varsPool);
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
      logs: histLogs,
      ts: Date.now(),
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
          const rest = (await readPlansFile()).filter((x) => !x || x.id !== p.id || Number(x.createdAt) !== Number(p.createdAt));
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
  async function openExecLog(requested, header) {
    const logFile = typeof requested === "string" && requested ? pathResolve(requested) : null;
    let file = null;
    let logError = "";
    let pending = Promise.resolve();
    let ended = false;
    let lastNewline = true;
    if (logFile) {
      try {
        await fsMkdir(dirname(logFile), { recursive: true });
        file = await fsOpen(logFile, "w");
      } catch (e) {
        logError = String(e);
      }
    }
    const write = (text) => {
      if (!file || ended || !text || logError) return;
      lastNewline = text.endsWith("\n");
      pending = pending.then(async () => {
        if (!logError) await file.writeFile(text, "utf8");
      }).catch((e) => {
        logError = String(e);
      });
    };
    write(header + "\n");
    return {
      info: () => logFile ? logError ? { logError } : { logFile } : {},
      write,
      async close(marker) {
        if (!ended) {
          write((lastNewline ? "" : "\n") + marker + "\n");
          ended = true;
          await pending;
          try {
            await file?.close();
          } catch (e) {
            logError = String(e);
          }
        }
        return logFile ? logError ? { logError } : { logFile } : {};
      }
    };
  }
  webServer.register({
    kind: "exact",
    path: "/api/worktable/exec",
    handler: async (req, res) => {
      let failedLog = null;
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
        const timeoutMs = Number(body.timeoutMs) > 0 ? Math.min(Math.max(Number(body.timeoutMs), 1e3), 36e5) : 0;
        const interp = /\.py$/i.test(path) ? "python3" : "bash";
        const oversizeWarn = dropOversizeEnv(env);
        const log = await openExecLog(body.logFile, "$ " + interp + " " + path + (args.length ? " " + args.join(" ") : ""));
        failedLog = log;
        if (oversizeWarn) log.write(oversizeWarn + "\n");
        const child = execFile(
          interp,
          [path, ...args],
          { cwd, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
          // 256MB：与 runStageScript 一致，日志保全量，不得因缓冲上限杀进程丢输出
          async (err, stdout, stderr) => {
            const code = err ? typeof err.code === "number" ? err.code : 1 : 0;
            const errorText = (oversizeWarn ? oversizeWarn + "\n" : "") + String(stderr || "");
            if (err?.killed) log.write("\nexec terminated (timeout or output limit)\n");
            const logged = await log.close("[exit " + code + "]");
            if (!res.destroyed) json(res, 200, { code, stdout: String(stdout || ""), stderr: errorText, ...logged });
          }
        );
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (text) => log.write(text));
        child.stderr?.on("data", (text) => log.write(text));
      } catch (err) {
        await failedLog?.close("[error] " + String(err));
        json(res, 500, { error: String(err && err.message ? err.message : err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/exec-stream",
    handler: async (req, res) => {
      let failExecution = null;
      try {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        const scriptPath = typeof body.path === "string" ? body.path : "";
        if (!scriptPath) {
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
        const timeoutMs = Number(body.timeoutMs) > 0 ? Math.min(Math.max(Number(body.timeoutMs), 1e3), 36e5) : 0;
        const interp = /.py$/i.test(scriptPath) ? "python3" : "bash";
        const oversizeWarn = dropOversizeEnv(env);
        let disconnected = false;
        let child = null;
        let killTimer = null;
        let abortTimer = null;
        let finished = false;
        const killTree = (sig) => {
          try {
            if (process.platform !== "win32" && child?.pid) process.kill(-child.pid, sig);
            else child?.kill(sig);
          } catch {
          }
        };
        res.on("close", () => {
          if (finished) return;
          disconnected = true;
          killTree("SIGTERM");
          if (child) abortTimer = setTimeout(() => killTree("SIGKILL"), 1e3);
        });
        const log = await openExecLog(body.logFile, "$ " + interp + " " + scriptPath + (args.length ? " " + args.join(" ") : ""));
        failExecution = async (err) => {
          finished = true;
          clearTimeout(killTimer);
          clearTimeout(abortTimer);
          killTree("SIGKILL");
          await log.close("[error] " + String(err));
        };
        if (disconnected || res.destroyed) {
          finished = true;
          await log.close("[aborted]");
          return;
        }
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", "x-worktable-log": log.info().logFile ? "server" : "none" });
        const send = (obj) => {
          if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(obj) + "\n");
        };
        if (body.logFile) send({ type: "log", ...log.info() });
        child = spawn(interp, [scriptPath, ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true, detached: process.platform !== "win32" });
        if (oversizeWarn) {
          log.write(oversizeWarn + "\n");
          send({ type: "err", text: oversizeWarn + "\n" });
        }
        let timedOut = false;
        killTimer = timeoutMs > 0 ? setTimeout(() => {
          timedOut = true;
          killTree("SIGKILL");
        }, timeoutMs) : null;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (text) => {
          log.write(text);
          send({ type: "out", text });
        });
        child.stderr.on("data", (text) => {
          log.write(text);
          send({ type: "err", text });
        });
        child.on("error", async (err) => {
          if (finished) return;
          finished = true;
          clearTimeout(killTimer);
          clearTimeout(abortTimer);
          log.write(String(err.message) + "\n");
          const logged = await log.close("[exit 1]");
          send({ type: "error", message: String(err && err.message ? err.message : err) });
          send({ type: "done", code: 1, ...logged });
          res.end();
        });
        child.on("close", async (code) => {
          if (finished) return;
          finished = true;
          clearTimeout(killTimer);
          clearTimeout(abortTimer);
          if (timedOut) {
            const message = "exec timed out after " + Math.round(timeoutMs / 1e3) + "s";
            log.write("\n" + message + "\n");
            send({ type: "error", message });
          }
          const exitCode = typeof code === "number" ? code : 1;
          const logged = await log.close(disconnected ? "[aborted]" : "[exit " + exitCode + "]");
          send({ type: "done", code: exitCode, ...logged });
          res.end();
        });
      } catch (err) {
        await failExecution?.(err);
        try {
          if (!res.writableEnded) res.end();
        } catch {
        }
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
        if (content.length > 256 * 1024 * 1024) {
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
    path: "/api/worktable/scan-projects",
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
        const dirents = await readdir(abs, { withFileTypes: true });
        const isHtml = (n) => /\.html?$/i.test(n);
        const projects = [];
        const readDeclaredIcon = async (dir, entry) => {
          try {
            const head = (await readFile(pathResolve(dir, entry), "utf8")).slice(0, 65536);
            const tag = head.match(/<meta\b[^>]*>/gi)?.find((t) => /\bname\s*=\s*(["'])worktable-icon\1/i.test(t));
            const icon = tag?.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i)?.[2]?.trim();
            return icon ? icon.slice(0, 16) : void 0;
          } catch {
            return void 0;
          }
        };
        for (const d of dirents) {
          if (d.name.startsWith(".")) continue;
          if (d.isDirectory()) {
            const sub = pathResolve(abs, d.name);
            let htmls = [];
            try {
              htmls = (await readdir(sub, { withFileTypes: true })).filter((f) => f.isFile() && isHtml(f.name)).map((f) => f.name).sort((a, b) => a.localeCompare(b, void 0, { sensitivity: "base" }));
            } catch {
              continue;
            }
            if (htmls.length === 0) continue;
            const named = d.name.toLowerCase() + ".html";
            const entry = htmls.find((h) => h.toLowerCase() === "index.html") ?? htmls.find((h) => h.toLowerCase() === named) ?? htmls[0];
            const icon = await readDeclaredIcon(sub, entry);
            projects.push(icon ? { name: d.name, dir: sub, entry, icon } : { name: d.name, dir: sub, entry });
          } else if (d.isFile() && isHtml(d.name)) {
            const icon = await readDeclaredIcon(abs, d.name);
            const name2 = d.name.replace(/\.html?$/i, "");
            projects.push(icon ? { name: name2, dir: abs, entry: d.name, icon } : { name: name2, dir: abs, entry: d.name });
          }
        }
        projects.sort((a, b) => a.name.localeCompare(b.name, void 0, { sensitivity: "base" }));
        json(res, 200, { path: abs, projects });
      } catch (err) {
        json(res, 500, { error: String(err) });
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
        const useProxy = body.useProxy === true;
        const fwdHeaders = {};
        for (const [k, v] of Object.entries(headers)) {
          const lk = k.toLowerCase();
          if (lk === "host" || lk === "content-length" || lk === "connection") continue;
          fwdHeaders[k] = v;
        }
        const reqLib = await (target.protocol === "https:" ? import("node:https") : import("node:http"));
        const result = await new Promise((resolve, reject) => {
          const r = reqLib.request(urlStr, useProxy ? { method, headers: fwdHeaders } : { method, headers: fwdHeaders, agent: new reqLib.Agent() }, (resp) => {
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
