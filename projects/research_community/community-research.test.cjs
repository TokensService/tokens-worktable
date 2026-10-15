const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "community-research.html"), "utf8");

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `community-research.html 应定义 ${name}()`);
  const open = html.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let regex = false;
  let escaped = false;
  for (let i = open; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (regex) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "/") regex = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/") {
      const prefix = html.slice(start, i).trimEnd();
      const prev = prefix.at(-1) || "";
      const word = prefix.match(/([a-zA-Z_$][\w$]*)$/)?.[1] || "";
      if (!prefix || "([{:;,=!?&|".includes(prev) || word === "return") {
        regex = true;
        continue;
      }
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`${name}() 函数体不完整`);
}

function loadFunctions(names) {
  const context = vm.createContext({ URL });
  names.forEach((name) => vm.runInContext(functionSource(name), context));
  return context;
}

test("社区链接页：输入区、列表、Agent 选择与对话控件齐备", () => {
  for (const id of [
    "linkName", "linkUrl", "linkNote", "btnAddLink", "linkHint",
    "linkList", "linkCount", "linkSelAll", "btnDelSel", "btnResetLinks",
    "agentPick", "promptPresets", "promptInput",
    "btnAnalyze", "btnStop", "btnNewChat", "btnCopy", "aiHint", "aiChat", "aiStateBadge",
  ])
    assert.ok(html.includes(`id="${id}"`), `community-research.html 应包含 #${id}`);
  for (const name of [
    "autoNameFromUrl", "normalizeLinkInput", "linksBlock",
    "buildAnalyzePrompt", "buildFollowupPrompt", "aiAgentCmd",
    "aiHistPush", "aiSend", "aiRunCli", "aiAppendStream",
  ])
    assert.notEqual(html.indexOf(`function ${name}(`), -1, `community-research.html 应定义 ${name}()`);
  /* 四个 AI Code Agent 都在选择区 */
  for (const id of ["kimi", "mimo", "codex", "claude"])
    assert.ok(html.includes(`id:'${id}'`), `Agent 列表应包含 ${id}`);
});

test("输入法组词的 Enter 不触发发送/添加，Shift+Enter 保持换行", () => {
  assert.ok(html.includes("e.isComposing || e.keyCode===229 || e.key==='Process'"), "应拦截输入法组词 Enter");
  assert.ok(html.includes("if(e.shiftKey) return;"), "Shift+Enter 应换行不发送");
  /* 提示词框与链接 URL 框两处都要有 IME 守卫 */
  const guards = html.split("e.isComposing || e.keyCode===229").length - 1;
  assert.ok(guards >= 2, "提示词框与链接输入框都应有 IME 守卫");
});

test("运行中锁定 Agent 切换：流式回显与续接标记按发起时 Agent 记账", () => {
  assert.ok(html.includes("rc-agentPick-lock"), "运行中应锁定 Agent 选择样式");
  assert.ok(html.includes("if(AI_RUNNING) return;"), "运行中应拦截 Agent 切换点击");
  assert.ok(html.includes("function aiAppendStream(aid,text)"), "流式回显应显式按发起时 Agent 记账");
  assert.ok(html.includes("var aid=AI_AGENT;"), "aiRunCli 应锚定发起时的 Agent");
});

test("AI Agent 命令行：首轮开新会话，续聊带各 CLI 的会话续接参数", () => {
  const ctx = loadFunctions(["aiAgentCmd"]);

  assert.equal(ctx.aiAgentCmd("kimi", false), 'kimi -p "$PROMPT" < /dev/null');
  assert.equal(ctx.aiAgentCmd("kimi", true), 'kimi -c -p "$PROMPT" < /dev/null');
  assert.equal(ctx.aiAgentCmd("mimo", false), 'mimo run "$PROMPT" < /dev/null');
  assert.equal(ctx.aiAgentCmd("mimo", true), 'mimo run -c "$PROMPT" < /dev/null');
  assert.equal(ctx.aiAgentCmd("codex", false), 'codex exec --skip-git-repo-check "$PROMPT" < /dev/null');
  assert.equal(ctx.aiAgentCmd("codex", true), 'codex exec resume --last --skip-git-repo-check "$PROMPT" < /dev/null');
  assert.equal(ctx.aiAgentCmd("claude", false), 'claude -p "$PROMPT" < /dev/null');
  assert.equal(ctx.aiAgentCmd("claude", true), 'claude -p -c "$PROMPT" < /dev/null');
  /* 未知 Agent 回退 Claude Code 首轮命令；stdin 必须重定向（exec-stream 悬空管道会让 CLI 等待） */
  assert.equal(ctx.aiAgentCmd("nope", false), 'claude -p "$PROMPT" < /dev/null');
  for (const id of ["kimi", "mimo", "codex", "claude", "nope"]) {
    assert.ok(ctx.aiAgentCmd(id, false).endsWith(" < /dev/null"), `${id} 命令应重定向 stdin`);
    assert.ok(ctx.aiAgentCmd(id, true).endsWith(" < /dev/null"), `${id} 续聊命令应重定向 stdin`);
  }
});

test("链接输入归一化：缺协议补 https、空名按 URL 推导、非法拒绝", () => {
  const ctx = loadFunctions(["autoNameFromUrl", "normalizeLinkInput"]);

  /* URL 缺协议自动补全，空名称取 GitHub org/repo */
  let r = ctx.normalizeLinkInput("", "github.com/vllm-project/vllm", "高吞吐");
  assert.equal(r.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(r.link)),
    { name: "vllm-project/vllm", url: "https://github.com/vllm-project/vllm", note: "高吞吐" },
  );
  /* 显式名称优先；非 GitHub 站点取主机名 */
  r = ctx.normalizeLinkInput("SGLang 官网", "https://sglang.ai/", "");
  assert.equal(r.ok, true);
  assert.equal(r.link.name, "SGLang 官网");
  assert.equal(r.link.url, "https://sglang.ai/");
  r = ctx.normalizeLinkInput("", "https://docs.example.com/llm/intro", "");
  assert.equal(r.ok, true);
  assert.equal(r.link.name, "docs.example.com/llm");
  /* 空 URL / 非法 URL 拒绝 */
  assert.equal(ctx.normalizeLinkInput("x", "", "").ok, false);
  assert.equal(ctx.normalizeLinkInput("", "not a url", "").ok, false);
  assert.equal(ctx.normalizeLinkInput("", "ftp://example.com/x", "").ok, false);
});

test("链接清单格式：序号 + 名称 — URL，备注缩进行", () => {
  const ctx = loadFunctions(["linksBlock"]);
  const block = ctx.linksBlock([
    { name: "vLLM", url: "https://github.com/vllm-project/vllm", note: "推理引擎" },
    { name: "", url: "https://sglang.ai/", note: "" },
  ]);
  assert.equal(
    block,
    "1. vLLM — https://github.com/vllm-project/vllm\n   备注：推理引擎\n2. https://sglang.ai/ — https://sglang.ai/",
  );
});

test("首轮分析提示词：任务说明 + 分析对象链接清单 + 用户提示词", () => {
  const ctx = loadFunctions(["linksBlock", "buildAnalyzePrompt"]);
  const links = [
    { name: "vLLM", url: "https://github.com/vllm-project/vllm", note: "推理引擎" },
    { name: "SGLang", url: "https://github.com/sgl-project/sglang", note: "" },
  ];
  const p = ctx.buildAnalyzePrompt(links, "对比这两个社区的技术方向");

  assert.ok(p.startsWith("# 社区链接分析任务"), "应有任务标题");
  assert.ok(p.includes("AI Code Agent"), "应说明 Agent 可自行抓取链接");
  assert.ok(p.includes("## 分析对象（2 个社区链接）"), "应标注链接数量");
  assert.ok(p.includes("1. vLLM — https://github.com/vllm-project/vllm"), "应列出链接清单");
  assert.ok(p.includes("2. SGLang — https://github.com/sgl-project/sglang"));
  assert.ok(p.includes("## 我的分析要求\n对比这两个社区的技术方向"), "应原样带上用户提示词");
  assert.ok(p.includes("Markdown"), "应要求 Markdown 输出");
});

test("续聊提示词：默认只发追问，勾选变化时附更新后的分析对象", () => {
  const ctx = loadFunctions(["linksBlock", "buildFollowupPrompt"]);

  /* 无勾选变化：纯追问文本，不重复灌链接 */
  assert.equal(ctx.buildFollowupPrompt("第二轮问题？", null), "第二轮问题？");
  assert.equal(ctx.buildFollowupPrompt("第二轮问题？", []), "第二轮问题？");
  /* 勾选变化：附上更新清单并以本轮请求收尾 */
  const p = ctx.buildFollowupPrompt("第二轮问题？", [{ name: "vLLM", url: "https://github.com/vllm-project/vllm", note: "" }]);
  assert.ok(p.startsWith("## 分析对象更新"), "应以对象更新块开头");
  assert.ok(p.includes("1. vLLM — https://github.com/vllm-project/vllm"), "应附上勾选变化后的清单");
  assert.ok(p.endsWith("## 本轮请求\n第二轮问题？"), "应以本轮请求收尾");
});

test("AI 对话历史上限：超出条数从头部丢弃", () => {
  const ctx = loadFunctions(["aiHist", "aiHistPush"]);
  ctx.AI_HIST = {};
  ctx.AI_HIST_MAX = 3;
  let saved = 0;
  ctx.lsSet = () => { saved += 1; };

  for (let i = 0; i < 5; i += 1) ctx.aiHistPush("claude", { role: "user", text: "m" + i });

  assert.equal(ctx.AI_HIST.claude.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.AI_HIST.claude.map((m) => m.text))), ["m2", "m3", "m4"]);
  assert.equal(saved, 5);
});

test("默认四个社区链接、工作目录与运行脚本约定", () => {
  /* 默认链接不含 DeepSpeed-FastGen（PR #218 结论），四个主流推理框架 */
  assert.ok(html.includes("DEFAULT_LINKS="), "应声明 DEFAULT_LINKS");
  for (const id of ["vllm", "sglang", "trtllm", "lmdeploy"])
    assert.ok(html.includes(`id:'${id}'`), `默认链接应包含 ${id}`);
  assert.ok(!/DeepSpeed/i.test(html), "不应再内置 DeepSpeed-FastGen");
  /* 运行目录固定在页面目录下，prompt/脚本按 Agent 分文件 */
  assert.ok(html.includes("+'/.ai-community'"), "应使用页面目录下 .ai-community 工作目录");
  assert.ok(html.includes("'/prompt-'+aid+'.md'"), "提示词文件应按 Agent 区分");
  assert.ok(html.includes("'/run-'+aid+'.sh'"), "运行脚本应按 Agent 区分");
  /* 提示词走文件传递，避免 shell 注入 */
  assert.ok(html.includes('PROMPT="$(cat'), "应经 PROMPT=\"$(cat …)\" 传入提示词");
  /* 发送前校验：首轮须勾选链接、全文长度上限 */
  assert.ok(html.includes("请先勾选要分析的社区链接"), "首轮未勾选链接应拦截并提示");
  assert.ok(html.includes("!selectedLinks().length"), "勾选数量校验应取数组 .length（.size 会误判恒空）");
  assert.ok(!html.includes("selectedLinks().size"), "selectedLinks() 返回数组，不得按 Set 取 .size");
  assert.ok(html.includes("40000"), "提示词应有长度上限");
});
