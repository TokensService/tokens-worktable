const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { execFileSync, spawnSync } = require("node:child_process");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

/* vm 域对象与宿主域原型不同，deepEqual 前统一 JSON 往返 */
const J = (x) => JSON.parse(JSON.stringify(x));

/* 整段抽取 KERNEL-ANALYZER 标记块（自包含，不依赖页面其余符号） */
function analyzerContext() {
  const m = html.match(/\/\* ==KERNEL-ANALYZER-BEGIN== \*\/([\s\S]*?)\/\* ==KERNEL-ANALYZER-END== \*\//);
  assert.ok(m, "index.html 应包含 KERNEL-ANALYZER 标记段");
  const context = vm.createContext({});
  vm.runInContext(m[1], context);
  return context;
}

/* 从页面抽取单个函数（含函数体括号配平） */
function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `index.html 应定义 ${name}()`);
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
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/") {
      const prefix = html.slice(start, i).trimEnd();
      const prev = prefix.at(-1) || "";
      const word = prefix.match(/([a-zA-Z_$][\w$]*)$/)?.[1] || "";
      if (!prefix || "([{:;,=!?&|".includes(prev) || word === "return") { regex = true; continue; }
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`${name}() 函数体不完整`);
}

/* 合成 trace：主 rank(pid 2) 10 个内核，含跨流重叠、暴露通信、elementwise 隐藏、
   融合证据（silu_and_mul 已在跑；rmsnorm+quant 拆分共现），decode 注释窗口全覆盖，
   最大空闲段（1100-1200）内有 host 同步事件（cudaStreamSynchronize）供空闲归因 */
function makeFixture() {
  const ev = [];
  const push = (o) => ev.push(o);
  /* cpu_op（External id → 算子名） */
  push({ ph: "X", cat: "cpu_op", pid: 1, tid: 11, ts: 900, dur: 300, name: "aten::mm", args: { "External id": 10 } });
  push({ ph: "X", cat: "cpu_op", pid: 1, tid: 11, ts: 1300, dur: 100, name: "aten::all_reduce", args: { "External id": 13 } });
  push({ ph: "X", cat: "cpu_op", pid: 1, tid: 11, ts: 1500, dur: 80, name: "aten::rms_norm", args: { "External id": 12 } });
  /* host 同步事件：落在最大 GPU 空闲段 1100-1200 内 */
  push({ ph: "X", cat: "cuda_runtime", pid: 1, tid: 11, ts: 1105, dur: 60, name: "cudaStreamSynchronize" });
  /* decode 阶段注释窗口 1000-3000 */
  push({ ph: "X", cat: "user_annotation", pid: 1, tid: 11, ts: 1000, dur: 2000, name: "decode step" });
  /* 主 rank 内核（pid 2） */
  const k = (name, ts, dur, stream, extra) => push({ ph: "X", cat: extra && extra.cat || "kernel", pid: 2, tid: 100 + stream, ts, dur, name, args: Object.assign({ stream }, extra && extra.args) });
  k("void cutlass_80_simt_sgemm_256x128_8x4_tn_align8(0x7f12ab00)", 1000, 100, 7, { args: { "External id": 10 } });
  k("vectorized_elementwise_kernel<mul>", 1005, 30, 8);          // 被 gemm 完全遮住
  k("flash_attn_fwd_kernel", 1200, 50, 7);
  k("ncclDevKernel_AllReduce_Sum_bf16", 1300, 80, 9, { args: { "External id": 13 } });
  k("silu_and_mul_kernel", 1400, 40, 7);
  k("rmsnorm_kernel", 1500, 20, 7, { args: { "External id": 12 } });
  k("quant_fp8_kernel", 1525, 15, 7);
  k("Memset (Device)", 1600, 10, 7, { cat: "gpu_memset" });
  k("Memcpy DtoD (Device -> Device)", 1620, 12, 7, { cat: "gpu_memcpy" });
  k("ncclDevKernel_AllReduce_Sum_bf16", 1700, 80, 9, { args: { "External id": 13 } });
  /* 次 rank（pid 3）应被主 rank 选择忽略 */
  push({ ph: "X", cat: "kernel", pid: 3, tid: 100, ts: 1000, dur: 20, name: "flash_attn_fwd_kernel", args: { stream: 7 } });
  return { traceEvents: ev };
}

const EXPECT_GPU = { window: 780, busy: 407, sum: 437, idle: 373, overlap: 30, serial: 377, maxConcurrent: 2, streams: 3, kernelCount: 10 };

/* 空闲段 TOP3：1100-1200（100µs，含 cudaStreamSynchronize ×1）、1632-1700（68µs）、1440-1500（60µs） */
function assertIdleGaps(g) {
  assert.equal(g.idleGaps.length, 3);
  assert.equal(g.idleGaps[0].dur, 100);
  assert.equal(g.idleGaps[0].ts, 1100);
  assert.deepEqual(J(g.idleGaps[0].hosts), [["cudaStreamSynchronize", 1]]);
  assert.equal(g.idleGaps[1].dur, 68);
  assert.equal(g.idleGaps[2].dur, 60);
}

function assertGpuStats(g) {
  assert.ok(g, "应有 gpu 口径");
  for (const [key, val] of Object.entries(EXPECT_GPU)) assert.equal(g[key], val, `gpu.${key}`);
  assert.ok(Math.abs(g.idlePct - (373 / 780) * 100) < 0.01, "gpu.idlePct");
  assert.equal(g.stageUs.decode, 437, "stageUs.decode");
  assert.equal(g.stageUs.prefill, 0);
  assert.equal(g.stageUs.all, 0);
  assertIdleGaps(g);
}

test("classifyKernel 算子族分类覆盖 skill 模式表", () => {
  const ctx = analyzerContext();
  const cases = [
    ["flash_attn_fwd_kernel", "attention"],
    ["ncclDevKernel_AllReduce_Sum_bf16", "communication"],
    ["Memcpy DtoD (Device -> Device)", "memory"],
    ["Memset (Device)", "memory"],
    ["vectorized_elementwise_kernel<mul>", "elementwise"],
    ["rmsnorm_kernel", "norm"],
    ["silu_and_mul_kernel", "activation"],
    ["void cutlass_80_simt_sgemm_256x128_8x4_tn_align8", "gemm"],
    ["fused_moe_kernel", "moe"],
    ["_router_triton_kernel", "router"],
    ["apply_rotary_pos_emb_kernel", "rope"],
    ["quant_fp8_kernel", "quantize"],
    ["triton_poi_fused_copy_1", "memory"],       // copy 弱信号且无 compute 提示
    ["mamba_selective_scan_kernel", "hybrid_linear"],
    ["topk_kernel", "reduce_topk"],
    ["topk_softmax_kernel", "softmax"],           // softmax 组先于 reduce_topk 命中（与 skill 同序）
  ];
  for (const [name, fam] of cases) assert.equal(ctx.classifyKernel(name), fam, name);
});

test("canonicalKernelName 归一地址并剥掉 CUTLASS 模板参数", () => {
  const ctx = analyzerContext();
  assert.equal(
    ctx.canonicalKernelName("void cutlass_80_simt_sgemm_256x128_8x4_tn_align8(0x7f12ab00)"),
    "void cutlass_80_simt_sgemm_256x128_8x4_tn_align8",
  );
  assert.equal(ctx.canonicalKernelName("flash_attn_fwd_kernel"), "flash_attn_fwd_kernel");
  assert.equal(ctx.canonicalKernelName("sm90_xmma_0xdeadbeef"), "sm90_xmma_0xADDR");
});

test("analyzeTraceKernels：GPU 口径 / 主 rank 选择 / 内核归因表", () => {
  const ctx = analyzerContext();
  const ka = ctx.analyzeTraceKernels(makeFixture().traceEvents, 2000000);
  assertGpuStats(ka.gpu);
  const names = ka.kernels.map((x) => x.name);
  assert.deepEqual(J(names.slice(0, 5)), [
    "ncclDevKernel_AllReduce_Sum_bf16",
    "void cutlass_80_simt_sgemm_256x128_8x4_tn_align8",
    "flash_attn_fwd_kernel",
    "silu_and_mul_kernel",
    "vectorized_elementwise_kernel<mul>",
  ]);
  const top = ka.kernels[0];
  assert.equal(top.family, "communication");
  assert.equal(top.count, 2);
  assert.equal(top.cpuOp, "aten::all_reduce");
  assert.ok(Math.abs(top.share - (160 / 437) * 100) < 0.01);
  const gemm = ka.kernels[1];
  assert.equal(gemm.family, "gemm");
  assert.equal(gemm.cpuOp, "aten::mm");
  /* 次 rank(pid 3) 的 20µs 不计入 */
  assert.ok(!ka.kernels.some((x) => x.total === 20 && x.name === "flash_attn_fwd_kernel" && x.count === 1));
});

test("analyzeTraceKernels：重叠机会（headroom 排序 + low-roi-hidden）", () => {
  const ctx = analyzerContext();
  const ka = ctx.analyzeTraceKernels(makeFixture().traceEvents, 2000000);
  assert.equal(ka.overlap.length, 6);
  const head = ka.overlap[0];
  assert.equal(head.name, "ncclDevKernel_AllReduce_Sum_bf16");
  assert.equal(head.verdict, "headroom");
  assert.equal(head.prio, "P1");
  assert.equal(head.rec, "try overlap");
  assert.equal(head.dep, "low");
  assert.equal(head.exclusiveRatio, 1);
  assert.ok(Math.abs(head.share - (160 / 407) * 100) < 0.01, "share 分母为 busy 并集");
  /* compute 类整体排在非 compute 之后，top5 截断 */
  assert.ok(!ka.overlap.slice(0, 5).some((o) => o.bucket === "compute"), "top5 无 compute fallback");
  const lowroi = ka.overlap[5];
  assert.equal(lowroi.verdict, "low-roi-hidden");
  assert.equal(lowroi.name, "vectorized_elementwise_kernel<mul>");
  assert.equal(lowroi.prio, "P4");
  assert.equal(lowroi.rec, "skip");
  assert.equal(lowroi.hiddenRatio, 1);
});

test("analyzeTraceKernels：融合候选（active → Confirmed，split 共现达阈）", () => {
  const ctx = analyzerContext();
  const ka = ctx.analyzeTraceKernels(makeFixture().traceEvents, 2000000);
  const byName = new Map(ka.fusion.map((f) => [f.pattern, f]));
  const act = byName.get("Fused activation-and-mul (SwiGLU/GeGLU)");
  assert.ok(act, "silu_and_mul 应命中 active");
  assert.equal(act.confidence, "Confirmed");
  assert.equal(act.relatedUs, 40);
  const rq = byName.get("Fused RMSNorm + quant");
  assert.ok(rq, "rmsnorm + quant 拆分共现应命中");
  assert.equal(rq.confidence, "Confirmed");       // 8.0% ≥ likelyShare 1.5
  assert.equal(rq.relatedUs, 35);
  const ar = byName.get("AllReduce + RMSNorm fusion（需 TP≥2）");
  assert.ok(ar, "allreduce + rmsnorm 拆分共现应命中");
  assert.equal(ar.confidence, "Confirmed");
  assert.ok(!byName.get("Fused residual add + RMSNorm"), "无 active 证据不应出现");
  assert.ok(!byName.get("Fused QK RMSNorm + RoPE"), "rope 缺失不应出现");
});

test("analyzeTraceKernels：无内核事件返回空形态", () => {
  const ctx = analyzerContext();
  const ka = ctx.analyzeTraceKernels([{ ph: "X", cat: "cpu_op", pid: 1, tid: 1, ts: 0, dur: 5, name: "aten::add" }], 100);
  assert.equal(ka.gpu, null);
  assert.deepEqual(J(ka.kernels), []);
  assert.deepEqual(J(ctx.analyzeTraceKernels(null)), { kernels: [], gpu: null, overlap: [], fusion: [] });
});

test("normalizeTrace 透传 kernelAnalysis（无内核计数则丢弃）", () => {
  const context = vm.createContext({});
  vm.runInContext(functionSource("fmtDur"), context);
  vm.runInContext(functionSource("fmtUs"), context);
  vm.runInContext(functionSource("normalizeTrace"), context);
  const withKa = context.normalizeTrace({ kind: "chrome-trace", totalUs: 1, top: [{ cat: "kernel", name: "k", totalUs: 1, count: 1 }], kernelAnalysis: { gpu: { kernelCount: 3 }, kernels: [], overlap: [], fusion: [] } }, "t", "server");
  assert.ok(withKa.kernelAnalysis, "有内核分析应透传");
  const withoutKa = context.normalizeTrace({ kind: "chrome-trace", totalUs: 1, top: [], kernelAnalysis: { gpu: null, kernels: [], overlap: [], fusion: [] } }, "t", "server");
  assert.equal(withoutKa.kernelAnalysis, undefined);
});

test("kernelFindings：空闲（含 host 归因）/ 通信暴露 / 融合识别派生瓶颈发现", () => {
  const context = vm.createContext({});
  vm.runInContext(functionSource("fmtDur"), context);
  vm.runInContext(functionSource("fmtUs"), context);
  vm.runInContext(functionSource("kernelFindings"), context);
  const ctx = analyzerContext();
  const ka = ctx.analyzeTraceKernels(makeFixture().traceEvents, 2000000);
  const fs2 = context.kernelFindings(ka);
  const titles = fs2.map((f) => f.title).join("\n");
  assert.ok(titles.includes("GPU 空闲占比 48%"), "应报告 GPU 空闲（47.8%→48%）");
  const idleFinding = fs2.find((f) => f.title.includes("GPU 空闲占比"));
  assert.ok(idleFinding.detail.includes("cudaStreamSynchronize"), "空闲发现应含 host 同步归因");
  assert.ok(idleFinding.detail.includes("最大空闲段 100µs"), "空闲发现应含最大空闲段");
  assert.ok(fs2.some((f) => f.level === "high" && f.title.includes("通信内核暴露")), "应有通信暴露 high");
  assert.ok(titles.includes("融合模式识别：已在跑 5 · 可融合 0"), "融合统计");
  assert.ok(!titles.includes("内核累计显著大于忙碌并集"), "437 < 407×1.3 不触发口径提醒");
  assert.ok(!titles.includes("单流串行"), "本 fixture 有 3 条流，不报单流串行");
  assert.deepEqual(J(context.kernelFindings(null)), []);
  assert.deepEqual(J(context.kernelFindings({ gpu: null })), []);
});

test("单流 trace：全部内核串行（重叠为 0、serial=busy）并给出单流提示", () => {
  const ctx = analyzerContext();
  const single = [
    { ph: "X", cat: "kernel", pid: 1, tid: 1, ts: 0, dur: 100, name: "gemm_a", args: { stream: 7 } },
    { ph: "X", cat: "kernel", pid: 1, tid: 1, ts: 200, dur: 100, name: "flash_attn_b", args: { stream: 7 } },
    { ph: "X", cat: "kernel", pid: 1, tid: 1, ts: 500, dur: 50, name: "silu_c", args: { stream: 7 } },
  ];
  const ka = ctx.analyzeTraceKernels(single, 1000);
  assert.equal(ka.gpu.streams, 1);
  assert.equal(ka.gpu.overlap, 0);
  assert.equal(ka.gpu.serial, 250);
  assert.equal(ka.gpu.busy, 250);
  assert.equal(ka.gpu.maxConcurrent, 1);
  const context = vm.createContext({});
  vm.runInContext(functionSource("fmtDur"), context);
  vm.runInContext(functionSource("fmtUs"), context);
  vm.runInContext(functionSource("kernelFindings"), context);
  const fs2 = context.kernelFindings(ka);
  assert.ok(fs2.some((f) => f.title === "单流串行执行"), "单流应给出串行提示");
});

test("traceEventSide / aggregateTraceEvents：CPU/GPU 分侧聚合", () => {
  const context = vm.createContext({});
  vm.runInContext(functionSource("traceEventSide"), context);
  vm.runInContext(functionSource("aggregateTraceEvents"), context);
  assert.equal(context.traceEventSide("kernel"), "gpu");
  assert.equal(context.traceEventSide("gpu_memcpy"), "gpu");
  assert.equal(context.traceEventSide("cpu_op"), "cpu");
  assert.equal(context.traceEventSide("cuda_runtime"), "cpu");
  assert.equal(context.traceEventSide("user_annotation"), "cpu");
  const agg = context.aggregateTraceEvents(makeFixture().traceEvents, 2000000);
  assert.equal(agg.gpuTotalUs, 457, "GPU 侧累计=主 rank 437 + 次 rank 20");
  assert.equal(agg.cpuTotalUs, 2540, "CPU 侧累计=cpu_op 480 + 同步 60 + 注释 2000");
  assert.equal(agg.totalUs, 457 + 2540);
  assert.equal(agg.topGpu[0].name, "ncclDevKernel_AllReduce_Sum_bf16");
  assert.equal(agg.topCpu[0].name, "decode step");
  assert.ok(agg.topGpu.every((r) => context.traceEventSide(r.cat) === "gpu"));
  assert.ok(agg.topCpu.every((r) => context.traceEventSide(r.cat) === "cpu"));
});

test("normalizeTrace：分侧视图（hasSideSplit / sideTotals / total 取 wall 跨度）", () => {
  const context = vm.createContext({});
  vm.runInContext(functionSource("fmtDur"), context);
  vm.runInContext(functionSource("fmtUs"), context);
  vm.runInContext(functionSource("traceEventSide"), context);
  vm.runInContext(functionSource("aggregateTraceEvents"), context);
  vm.runInContext(functionSource("normalizeTrace"), context);
  const agg = context.aggregateTraceEvents(makeFixture().traceEvents, 2000000);
  const p = context.normalizeTrace(agg, "t", "browser");
  assert.equal(p.hasSideSplit, true);
  assert.ok(p.sideTotals.gpu > 0 && p.sideTotals.cpu > 0);
  assert.equal(p.total, 2100 / 1e6, "总耗时取 wall 跨度 2100µs，不是混合累计");
  assert.ok(p.stages.every((s) => s.side === "gpu" || s.side === "cpu"));
  assert.ok(p.stages.filter((s) => s.side === "gpu")[0].name.startsWith("ncclDevKernel"));
  assert.equal(p.meta["GPU 事件累计"], "457µs");
  assert.equal(p.meta["CPU/Host 事件累计"], "2.54ms");
  /* 旧汇总器输出（无 topGpu/topCpu）回退单表 */
  const legacy = context.normalizeTrace({ kind: "chrome-trace", totalUs: 5, top: [{ cat: "cpu_op", name: "aten::add", totalUs: 5, count: 1 }] }, "t", "server");
  assert.equal(legacy.hasSideSplit, undefined);
});

test("analyzeStages：分侧后 GPU/CPU 分开定位，不再混合定性", () => {
  const context = vm.createContext({});
  vm.runInContext(functionSource("fmtDur"), context);
  vm.runInContext(functionSource("fmtUs"), context);
  vm.runInContext(functionSource("traceEventSide"), context);
  vm.runInContext(functionSource("aggregateTraceEvents"), context);
  vm.runInContext(functionSource("normalizeTrace"), context);
  vm.runInContext(functionSource("analyzeSide"), context);
  vm.runInContext(functionSource("analyzeStages"), context);  const agg = context.aggregateTraceEvents(makeFixture().traceEvents, 2000000);
  const p = context.normalizeTrace(agg, "t", "browser");
  const fs2 = context.analyzeStages(p);
  const titles = fs2.map((f) => f.title).join("\n");
  assert.ok(titles.includes("GPU 侧"), "瓶颈应带侧标签");
  assert.ok(!titles.includes("严重瓶颈：decode step"), "CPU 注释事件不得被定名为全程瓶颈");
  /* 非分侧（流水线 JSON）路径行为不变 */
  const pl = { stages: [{ name: "构建", status: "done", durSec: 90 }, { name: "测试", status: "done", durSec: 10 }], total: 100 };
  const fs3 = context.analyzeStages(pl);
  assert.ok(fs3.some((f) => f.title.includes("严重瓶颈：构建")), "流水线路径保持原判定");
});

test("页面静态契约：内核三表卡片 / 分侧表格 / 渲染函数 / AI 提示词", () => {
  for (const needle of [
    'id="kernelCard"', 'id="kernelTable"', 'id="overlapWrap"', 'id="fusionWrap"', 'id="gpuStatGrid"', 'id="gpuNoteLine"',
    'id="stageGpuHead"', 'id="stageTableCpu"', 'id="stageCpuWrap"', "CPU · Host 事件",
    "function renderKernelAnalysis()", "function kernelFindings(ka)", "function analyzeSide(", "function traceEventSide(",
    "hasSideSplit", "串行(单流)",
    "renderStages(); renderFindings(); renderCharts(); renderKernelAnalysis();",
    "agg.kernelAnalysis = analyzeTraceKernels(data.traceEvents, 2000000);",
    "### 融合候选", "### 重叠机会", "### 内核归因 TOP 10", "## GPU 设备事件耗时", "## CPU/Host 事件耗时",
    "llm-torch-profiler-analysis",
  ]) assert.ok(html.includes(needle), `index.html 缺少 ${needle}`);
});

test("trace_summary.py 服务端汇总器产出同款内核分析（对拍）", (t) => {
  const tmp = path.join(os.tmpdir(), `pf-trace-fixture-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(makeFixture()));
  let out;
  try {
    out = execFileSync("python3", [path.join(__dirname, "trace_summary.py"), tmp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    t.skip(`python3 不可执行：${e.message}`);
    return;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const d = JSON.parse(out);
  assert.equal(d.kind, "chrome-trace");
  assert.equal(d.events, makeFixture().traceEvents.length);
  assert.ok(d.kernelAnalysis, "汇总器应输出 kernelAnalysis");
  assertGpuStats(d.kernelAnalysis.gpu);
  assert.equal(d.kernelAnalysis.kernels[0].name, "ncclDevKernel_AllReduce_Sum_bf16");
  assert.equal(d.kernelAnalysis.kernels[0].family, "communication");
  assert.equal(d.kernelAnalysis.overlap[0].prio, "P1");
  assert.equal(d.kernelAnalysis.overlap[0].rec, "try overlap");
  const patterns = d.kernelAnalysis.fusion.map((f) => f.pattern);
  assert.ok(patterns.includes("Fused activation-and-mul (SwiGLU/GeGLU)"));
  assert.ok(patterns.includes("Fused RMSNorm + quant"));
  /* 与浏览器内分析器对拍：GPU 口径与内核表顺序一致 */
  const ctx = analyzerContext();
  const kaJs = ctx.analyzeTraceKernels(makeFixture().traceEvents, 2000000);
  for (const key of Object.keys(EXPECT_GPU)) assert.equal(d.kernelAnalysis.gpu[key], kaJs.gpu[key], `对拍 gpu.${key}`);
  assert.deepEqual(J(d.kernelAnalysis.gpu.idleGaps), J(kaJs.gpu.idleGaps), "空闲段归因一致");
  assert.deepEqual(
    J(d.kernelAnalysis.kernels.map((k2) => k2.name)),
    J(kaJs.kernels.map((k2) => k2.name)),
    "内核表顺序一致",
  );
  assert.deepEqual(
    J(d.kernelAnalysis.overlap.map((o) => [o.name, o.prio, o.rec])),
    J(kaJs.overlap.map((o) => [o.name, o.prio, o.rec])),
    "重叠机会一致",
  );
  assert.deepEqual(
    J(d.kernelAnalysis.fusion.map((f) => [f.pattern, f.confidence])),
    J(kaJs.fusion.map((f) => [f.pattern, f.confidence])),
    "融合候选一致",
  );
});

test("trace_summary.py 兼容旧行为：无内核 trace 只出汇总、非法输入报错", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-summary-"));
  try {
    const plain = path.join(dir, "plain.json");
    fs.writeFileSync(plain, JSON.stringify({ traceEvents: [{ ph: "X", cat: "cpu_op", pid: 1, tid: 1, ts: 0, dur: 5, name: "aten::add" }] }));
    const d = JSON.parse(execFileSync("python3", [path.join(__dirname, "trace_summary.py"), plain], { encoding: "utf8" }));
    assert.equal(d.kind, "chrome-trace");
    assert.equal(d.kernelAnalysis, undefined, "无内核不应输出 kernelAnalysis");
    assert.equal(d.top[0].name, "aten::add");
    /* 非法输入：退出码 1 且 stdout 报 error（execFileSync 对非零退出会抛，故用 spawnSync） */
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{\"x\":1}");
    const r = spawnSync("python3", [path.join(__dirname, "trace_summary.py"), bad], { encoding: "utf8" });
    assert.equal(r.status, 1, "非法输入退出码应为 1");
    assert.ok(JSON.parse(r.stdout).error, "缺 traceEvents 应报错");
  } catch (e) {
    t.skip(`python3 不可执行：${e.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


/* ============ Perfetto UI 集成（PERFETTO-BRIDGE 标记块 + 握手会话 + 静态契约） ============ */

/* 整段抽取 PERFETTO-BRIDGE 标记块（自包含，不依赖页面其余符号） */
function perfettoContext() {
  const m = html.match(/\/\* ==PERFETTO-BRIDGE-BEGIN== \*\/([\s\S]*?)\/\* ==PERFETTO-BRIDGE-END== \*\//);
  assert.ok(m, "index.html 应包含 PERFETTO-BRIDGE 标记段");
  const context = vm.createContext({});
  vm.runInContext(m[1], context);
  return context;
}

/* 握手会话假对象：host（message 事件总线）、target（postMessage 收集）、计时器（手动推进） */
function fakeHost() {
  const listeners = new Set();
  return {
    addEventListener: (t, f) => { if (t === "message") listeners.add(f); },
    removeEventListener: (t, f) => { listeners.delete(f); },
    emit: (e) => { for (const f of [...listeners]) f(e); },
    count: () => listeners.size,
  };
}
function fakeTarget() {
  const sent = [];
  return { sent, postMessage: (msg, origin) => sent.push({ msg, origin }) };
}
function fakeTimers() {
  const ivs = new Map(), tos = new Map();
  let seq = 0;
  return {
    setInterval: (f) => { const id = ++seq; ivs.set(id, f); return id; },
    clearInterval: (id) => { ivs.delete(id); },
    setTimeout: (f) => { const id = ++seq; tos.set(id, f); return id; },
    clearTimeout: (id) => { tos.delete(id); },
    tickIntervals: () => { for (const f of [...ivs.values()]) f(); },
    runTimeouts: () => { for (const f of [...tos.values()]) f(); },
    pending: () => ({ intervals: ivs.size, timeouts: tos.size }),
  };
}
function makeSession(ctx) {
  const host = fakeHost(), target = fakeTarget(), timers = fakeTimers();
  const states = [];
  const session = ctx.createPerfettoSession({
    host, target,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    onState: (s, d) => states.push([s, d]),
  });
  return { host, target, timers, states, session };
}
const pong = (target, origin) => ({ source: target, origin: origin || "https://ui.perfetto.dev", data: "PONG" });

test("isPerfettoTraceName / perfettoEligible：trace 判定口径", () => {
  const ctx = perfettoContext();
  for (const yes of ["a.pt.trace.json", "a.pt.trace.json.gz", "TRACE_2024.JSON", "xtrace-y.json.gz"])
    assert.ok(ctx.isPerfettoTraceName(yes), yes);
  for (const no of ["run-1.profile.json", "x.ncu-rep", "x.nsys-rep", "server.log", "config.json"])
    assert.ok(!ctx.isPerfettoTraceName(no), no);
  assert.ok(ctx.perfettoEligible({ name: "x.pt.trace.json", binary: false, path: "/p", data: null }), "服务端 trace 路径条目");
  assert.ok(ctx.perfettoEligible({ name: "weird.json", binary: false, data: { traceEvents: [] } }), "已解析出 traceEvents");
  assert.ok(!ctx.perfettoEligible({ name: "x.pt.trace.json", binary: true }), "二进制报告排除");
  assert.ok(!ctx.perfettoEligible({ name: "run.profile.json", binary: false, data: { stages: [] } }), "流水线 JSON 排除");
  assert.ok(!ctx.perfettoEligible(null));
});

test("resolvePerfettoTargets：勾选集优先（按列表顺序、滤掉不可开），无勾选回退当前条目", () => {
  const ctx = perfettoContext();
  const trace = (id) => ({ id, name: id + ".pt.trace.json", binary: false, path: "/p/" + id, data: null });
  const nonTrace = { id: "n", name: "run.profile.json", binary: false, data: { stages: [] } };
  const list = [trace("a"), nonTrace, trace("b"), trace("c")];
  const ids = (arr) => [...arr].map(x => x.id);   /* vm 上下文返回的数组是跨 realm 对象，展开回主 realm 再断言 */
  /* 勾选优先：按列表顺序、非 trace 被过滤 */
  assert.deepEqual(ids(ctx.resolvePerfettoTargets(list, new Set(["c", "a", "n"]), null)), ["a", "c"]);
  /* 无勾选回退当前条目 */
  assert.deepEqual(ids(ctx.resolvePerfettoTargets(list, new Set(), { item: trace("b") })), ["b"]);
  /* 勾选为空集且当前条目不可开 → 空 */
  assert.deepEqual(ids(ctx.resolvePerfettoTargets(list, new Set(), { item: nonTrace })), []);
  assert.deepEqual(ids(ctx.resolvePerfettoTargets(list, new Set(), null)), []);
  /* picks 为 null/undefined 安全 */
  assert.deepEqual(ids(ctx.resolvePerfettoTargets(list, null, { item: trace("a") })), ["a"]);
});

test("pfAscii / perfettoNeedsTrustHint / buildPerfettoTraceMessage", () => {
  const ctx = perfettoContext();
  assert.equal(ctx.pfAscii("run-01.pt.trace.json"), "run-01.pt.trace.json");
  assert.equal(ctx.pfAscii("解码 trace.pt.trace.json"), "_ trace.pt.trace.json");
  assert.equal(ctx.pfAscii(""), "trace");
  assert.equal(ctx.pfAscii(null), "trace");
  assert.equal(ctx.perfettoNeedsTrustHint("127.0.0.1"), false);
  assert.equal(ctx.perfettoNeedsTrustHint("localhost"), false);
  assert.equal(ctx.perfettoNeedsTrustHint("[::1]"), false);
  assert.equal(ctx.perfettoNeedsTrustHint("192.168.1.5"), true);
  const buf = new Uint8Array([1, 2, 3]).buffer;
  const m = ctx.buildPerfettoTraceMessage(buf, "压测A run-01", "解码 trace.json");
  assert.equal(m.perfetto.buffer, buf, "buffer 原样引用");
  assert.equal(m.perfetto.title, "_A run-01", "title 经 pfAscii 清洗");
  assert.equal(m.perfetto.fileName, "_ trace.json");
  assert.equal(m.perfetto.keepApiOpen, true, "保活以支持同会话多次投递");
});

test("createPerfettoSession：PING 立即+周期发送，PONG 需来源/origin/数据三重匹配", () => {
  const ctx = perfettoContext();
  const { host, target, timers, states, session } = makeSession(ctx);
  assert.deepEqual(target.sent.map((x) => x.msg), ["PING"], "创建即 PING");
  assert.equal(target.sent[0].origin, "https://ui.perfetto.dev", "PING 目标 origin 恒为 Perfetto");
  timers.tickIntervals();
  timers.tickIntervals();
  assert.deepEqual(target.sent.map((x) => x.msg), ["PING", "PING", "PING"], "周期 PING");
  assert.deepEqual(timers.pending(), { intervals: 1, timeouts: 1 });
  /* 三重不匹配的 PONG 一律忽略 */
  host.emit({ source: {}, origin: "https://ui.perfetto.dev", data: "PONG" });
  host.emit(pong(target, "https://evil.example.com"));
  host.emit({ source: target, origin: "https://ui.perfetto.dev", data: "PING" });
  assert.equal(session.isReady(), false);
  assert.ok(!states.length);
  host.emit(pong(target));
  assert.equal(session.isReady(), true);
  assert.deepEqual(states, [["ready", undefined]]);
  assert.deepEqual(timers.pending(), { intervals: 0, timeouts: 0 }, "就绪后 PING 与超时计时器都停");
  const n = target.sent.length;
  timers.tickIntervals();
  assert.equal(target.sent.length, n, "就绪后不再 PING");
  session.dispose();
  assert.equal(host.count(), 0, "dispose 摘除 message 监听");
});

test("createPerfettoSession：send 在握手前排队、就绪后立即投递，同会话可多次投递", () => {
  const ctx = perfettoContext();
  const { host, target, states, session } = makeSession(ctx);
  const buf1 = new Uint8Array([1]).buffer, buf2 = new Uint8Array([2]).buffer;
  session.send(buf1, "first", "a.pt.trace.json");
  assert.equal(target.sent.filter((x) => x.msg !== "PING").length, 0, "就绪前不投递");
  host.emit(pong(target));
  const sent = target.sent.filter((x) => x.msg !== "PING");
  assert.equal(sent.length, 1, "就绪后补投排队消息");
  assert.equal(sent[0].origin, "https://ui.perfetto.dev");
  assert.equal(sent[0].msg.perfetto.buffer, buf1);
  assert.equal(sent[0].msg.perfetto.fileName, "a.pt.trace.json");
  assert.equal(sent[0].msg.perfetto.keepApiOpen, true);
  session.send(buf2, "second", "b.pt.trace.json.gz");
  const sent2 = target.sent.filter((x) => x.msg !== "PING");
  assert.equal(sent2.length, 2, "keepApiOpen：就绪后可继续投递");
  assert.equal(sent2[1].msg.perfetto.buffer, buf2);
  assert.deepEqual(states, [["ready", undefined], ["send", "a.pt.trace.json"], ["send", "b.pt.trace.json.gz"]]);
  session.dispose();
});

test("createPerfettoSession：握手超时进入 error 并自dispose，dispose 后 send 报错", () => {
  const ctx = perfettoContext();
  const { host, target, timers, states, session } = makeSession(ctx);
  timers.runTimeouts();
  assert.equal(session.isReady(), false);
  assert.equal(states.length, 1);
  assert.equal(states[0][0], "error");
  assert.ok(String(states[0][1]).includes("超时") && String(states[0][1]).includes("ui.perfetto.dev"));
  assert.equal(host.count(), 0, "超时后监听已摘除");
  const pings = target.sent.length;
  timers.tickIntervals();
  assert.equal(target.sent.length, pings, "超时后不再 PING");
  session.send(new Uint8Array([1]).buffer, "t", "f");
  assert.equal(states.length, 2);
  assert.deepEqual(states[1], ["error", "Perfetto 会话已关闭"]);
  assert.equal(target.sent.filter((x) => x.msg !== "PING").length, 0, "dispose 后不投递");
});

test("页面静态契约：Perfetto 模态框 / 入口按钮 / 桥接段 / 取数与接线", () => {
  for (const needle of [
    "==PERFETTO-BRIDGE-BEGIN==", "==PERFETTO-BRIDGE-END==",
    "https://ui.perfetto.dev", "keepApiOpen: true", "'PING'", "'PONG'",
    "function createPerfettoSession(", "function perfettoEligible(", "function isPerfettoTraceName(",
    "function buildPerfettoTraceMessage(", "function pfAscii(", "function perfettoNeedsTrustHint(",
    'id="perfModal"', 'id="perfBody"', 'id="perfStatus"', 'id="perfTitle"',
    'id="perfRetryBtn"', 'id="perfPopBtn"', 'id="perfCloseBtn"',
    'id="perfettoOpenBtn"', "$('perfettoOpenBtn').addEventListener('click', async () => {",
    "async function perfettoTraceBuffer(", "async fileBuffer(",
    "function closePerfetto(", "e.key === 'Escape'", "perfettoNeedsTrustHint(location.hostname)",
    "window.open(PERFETTO_ORIGIN, '_blank')",
    /* 握手等待计时：慢网加载期间状态栏逐秒刷新，避免「读取 trace…」假象卡死 */
    "function perfWaitBegin(", "function perfWaitStop(", "等待 Perfetto UI 就绪… 已等待 ",
    "perf.session.isReady()) perfWaitBegin()",
    /* 大文件：上限放宽到 2GiB；超限给「下载到本地」兜底（拖入 Perfetto 窗口打开） */
    "const PERFETTO_MAX_BYTES = 2 * 1024 * 1024 * 1024", "err.oversize = true",
    'id="perfDownloadBtn"', "perfDownloadBtn').addEventListener('click'", "大文件解析可能需要数分钟",
    /* 服务端大文件：/file 走 raw=1 流式（绕开 256MB 全量读上限）；读取失败后晚到 PONG 不覆盖错误 */
    "encodeURIComponent(path) + '&raw=1'", "encodeURIComponent(it.path) + '&raw=1'", "perf.failed = true", "perf.failed) return",
    /* 入口按钮固定在列表卡标题行，勾选集优先于当前选中条目，两者皆空才禁用 */
    ">Perfetto打开<", "$('perfettoOpenBtn').disabled = !resolvePerfettoTargets(items, perfPicks, cur).length",
    /* 点击先保存到本地再打开；内嵌 iframe 走 embedded 模式关侧边栏 */
    "function downloadTraceFile(", "PERFETTO_EMBED_URL", "mode=embedded&hideSidebar=true",
    "已保存 trace 到本地下载目录",
    /* 服务端保存目录：按服务器节点独立保存（saveDirByNode）+ 浏览选择 + copy 落盘 / 远程 rfetch dstDir 落点 + 存在跳过 */
    'id="tab-settings"', 'data-tab="settings"', 'id="saveDirPath"', 'id="saveDirSaveBtn"', 'id="saveDirClearBtn"',
    'id="saveDirNodeLabel"', 'id="saveDirBrowseBtn"', 'id="saveDirBrowser"', 'id="saveDirPickCurBtn"', 'id="saveDirAll"',
    "dsh.profiling.saveDirByNode", "function saveDirForNode(", "function saveTraceToServerDir(", "/api/worktable/copy",
    "保存目录已存在，跳过", "dstDir", 'data-save-dir-clear',
    /* 本地保存目录：FS API 目录选择器 + IndexedDB 句柄 + 流式 pipeTo 落盘 + 同名同大小跳过并回读复用 */
    'id="saveDirLocalPickBtn"', 'id="saveDirLocalClearBtn"', 'id="saveDirLocalLabel"',
    "showDirectoryPicker", "perfettoSaveDir", "function saveTraceToLocalDir(", "resp.body.pipeTo(w)",
    "本地保存目录已有该文件，跳过下载", "已保存到本地目录",
    /* 多选同时打开 + 默认下载去重 */
    "function resolvePerfettoTargets(", "perfPicks", 'class="pf-pick"', "function downloadWithDedupe(", "此前已下载过，跳过重复下载",
    "已保存到 ",
    /* 服务器选择支持搜索（隐藏 select 存值 + 输入过滤候选面板） */
    'id="srvNodeSearch"', 'id="srvNodePanel"', 'data-node-pick', "pf-nodePicker", "function renderSrvNodePanel(", "function srvNodeText(",
  ]) assert.ok(html.includes(needle), `index.html 缺少 ${needle}`);
  /* 「清空本地」按钮已删除（标记、处理器均不再存在） */
  assert.ok(!html.includes('clearLocalBtn'), "「清空本地」按钮及其处理器应已移除");
  assert.ok(!html.includes('在 Perfetto 中打开</button>'), "概览卡内的旧按钮注入已移除");
});

test("页面静态契约：「本地文件」来源已移除（条目全部走服务端/远程路径）", () => {
  for (const gone of [
    'data-tab="local"', 'id="tab-local"', 'id="pickLocalBtn"', 'id="localFileInput"',
    "source: 'local'", "source === 'local'", "it.file", "'local:'",
  ]) assert.ok(!html.includes(gone), `index.html 仍残留 ${gone}`);
});

test("页面静态契约：列表项删除（× 按钮 / 墓碑防扫描带回 / 显式重加清墓碑）", () => {
  for (const needle of [
    'data-role="del"', "function deleteItem(", "dsh.profiling.deleted", "function untombstone(",
    "!deleted[tk]", "ev.target.closest('[data-role=\"del\"]')",
    "已删除：", "服务端目录扫描将不再带回",
  ]) assert.ok(html.includes(needle), `index.html 缺少 ${needle}`);
  /* 显式加载入口清墓碑（loadSrvPath 本机/远程两分支 + 定义处） */
  const loads = html.match(/untombstone\(/g) || [];
  assert.ok(loads.length >= 3, "loadSrvPath 本机与远程两分支 / untombstone 定义 应至少 3 处引用");
});

test("页面静态契约：服务端标签合并（文件/文件夹一体）+ 服务器下拉 + 远程缓存拉取", () => {
  for (const needle of [
    'data-tab="server"', 'id="tab-server"', 'id="srvNode"', 'id="srvNodeRefresh"', 'id="srvPath"',
    'id="srvLoadBtn"', 'id="srvRescanBtn"', 'id="srvBrowseBtn"', 'id="srvPickDirBtn"',
    "dsh.profiling.srvNode", "/api/worktable/pipeline", "config.environments",
    "/api/worktable/rfs", "/api/worktable/rfetch", "remote-cache",
    "function ensureLocalPath(", "function tombKeyOf(", "remote:", "remote.rpath",
  ]) assert.ok(html.includes(needle), `index.html 缺少 ${needle}`);
  /* 旧的两个标签与 id 已移除 */
  for (const gone of ['data-tab="serverFile"', 'data-tab="serverDir"', 'id="srvFilePath"', 'id="srvDirPath"', 'id="loadSrvFileBtn"', 'id="scanDirBtn"', 'id="dirBrowser"'])
    assert.ok(!html.includes(gone), `index.html 仍残留 ${gone}`);
});
