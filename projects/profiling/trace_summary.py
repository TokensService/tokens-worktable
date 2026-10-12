#!/usr/bin/env python3
"""Chrome/PyTorch trace（.pt.trace.json[.gz]）汇总器。
按 (cat, name) 聚合 ph=X 事件的累计时长与次数，stdout 输出紧凑 JSON：
{kind:'chrome-trace', events, spanUs, totalUs, categories[], top[], kernelAnalysis?}

附带 GPU 内核三表分析（参考 llm-torch-profiler-analysis skill 简化移植，与页面
index.html 内 KERNEL-ANALYZER 段同款逻辑、同形输出）：
  ① kernels 内核归因表（算子族分类 + External id → cpu_op 归属）
  ② gpu 时间口径（window=wall / busy=各流区间并集 / sum=内核累计 / idle / overlap /
    maxConcurrent / stageUs）
  ③ overlap 重叠机会（headroom 暴露 + low-roi-hidden + 依赖风险 + P1/P2/P4 建议）
  ④ fusion 融合候选（active 关键词 → Confirmed；split 组共现达阈 → Candidate）
页面侧据此渲染阶段耗时、瓶颈分析与内核三表。仅标准库。"""
import sys
import json
import gzip
import re
from collections import defaultdict

KERNEL_CATEGORY_PATTERNS = [
    ('router', ['_router_triton_kernel', 'moe_fused_gate']),
    ('attention', ['flash_attn', 'flashattention', 'flash_attention', 'fmha', 'attention', 'mla', 'paged_attention', 'decode_attention']),
    ('hybrid_linear', ['gdn', 'gated_delta', 'mamba', 'selective_scan', 'causal_conv', 'ssd', 'ssm']),
    ('moe', ['fused_moe', 'grouped_mm', 'groupgemm', 'group_gemm', 'moe', 'expert', 'groupproblemshape']),
    ('gemm', ['gemm', 'gemv', 'matmul', 'cublas', 'wgmma', 'mma', 'bmm', 'nvjet']),
    ('norm', ['rmsnorm', 'layernorm', '_norm_', ' norm', 'normkernel']),
    ('rope', ['rotary', 'rope', 'mrope']),
    ('softmax', ['softmax']),
    ('activation', ['silu', 'gelu', 'relu', 'act_and_mul', 'sigmoid']),
    ('quantize', ['quant', 'fp8', 'mxfp', 'nvfp4', 'dequant', 'cvt']),
    ('reduce_topk', ['topk', 'reduce', 'argmax', 'argtopk', 'sampling', 'multinomial']),
    ('elementwise', ['elementwise', 'vectorized_elementwise_kernel', 'unrolled_elementwise_kernel', 'gpu_kernel_impl', 'binary_internal', 'unaryfunctor', 'add_kernel', 'sub_kernel', 'mul_kernel', 'div_', 'floor_kernel', 'log_kernel', 'neg_kernel']),
]
KERNEL_COMPUTE_HINTS = ['gemm', 'gemv', 'matmul', 'cublas', 'cutlass', 'wgmma', 'mma', 'bmm', 'nvjet', 'fmha', 'attention', 'flash_attn', 'flashattention', 'flash_attention', 'grouped_mm', 'groupgemm', 'moe', 'expert']
RE_COMM_STRONG = re.compile(r'nccl|allreduce|all_reduce|reduce_scatter|allgather|all_gather|alltoall|all_to_all|cross_device_reduce|deepep|mooncake')
RE_MEM_STRONG = re.compile(r'memcpy|memset|dma|prefetch')
RE_COMM_WEAK = re.compile(r'broadcast|dispatch|combine')
RE_TP0 = re.compile(r'tp0|tp-0|tp00', re.I)
RE_DECODE = re.compile(r'decode|generation_1')
RE_PREFILL = re.compile(r'prefill|generation_0|extend')
RE_HEX_ADDR = re.compile(r'0x[0-9a-fA-F]+')


def classify_kernel(name):
    n = str(name or '').lower()
    if not n:
        return 'other'
    if RE_COMM_STRONG.search(n):
        return 'communication'
    if RE_MEM_STRONG.search(n):
        return 'memory'
    has_compute = any(k in n for k in KERNEL_COMPUTE_HINTS)
    if ('copy' in n or 'fill' in n) and not has_compute:
        return 'memory'
    for fam, pats in KERNEL_CATEGORY_PATTERNS:
        if any(p in n for p in pats):
            return fam
    if RE_COMM_WEAK.search(n) and not has_compute:
        return 'communication'
    return 'other'


def kernel_bucket(family):
    if family in ('communication', 'memory', 'other'):
        return family
    if family in ('gemm', 'attention', 'moe', 'hybrid_linear', 'router'):
        return 'compute'
    return 'elementwise'


def canonical_kernel_name(name):
    s = RE_HEX_ADDR.sub('0xADDR', str(name or ''))
    if s.startswith('void ') and s.endswith(')'):
        depth = 0
        cut = -1
        for i in range(len(s) - 1, -1, -1):
            if s[i] == ')':
                depth += 1
            elif s[i] == '(':
                depth -= 1
                if depth == 0:
                    cut = i
                    break
        if cut > 5:
            s = s[:cut]
    return s


FUSION_PATTERNS = [
    {'name': 'Fused residual add + RMSNorm', 'active': ['fused_add_rmsnorm', 'fused_add_rms_norm', 'gemma_fused_add_rmsnorm', 'npu_add_rms_norm', 'add_rmsnorm_bias'], 'splits': [], 'minShare': 0.1, 'likelyShare': 1.0, 'note': '残差加与 RMSNorm 融合，省一次显存往返'},
    {'name': 'Fused activation-and-mul (SwiGLU/GeGLU)', 'active': ['silu_and_mul', 'gelu_and_mul', 'npu_swiglu'], 'splits': [], 'minShare': 0.1, 'likelyShare': 1.0, 'note': '激活与乘门融合'},
    {'name': 'Fused QK RMSNorm + RoPE', 'active': ['fused_qknorm_rope', 'fused_qk_norm_rope'], 'splits': [['apply_qk_norm', 'q_norm', 'k_norm', 'qknorm'], ['apply_rope', 'rotary', 'rope', 'mrope']], 'minShare': 0.3, 'likelyShare': 2.0, 'note': 'QK 归一化与旋转位置编码融合'},
    {'name': 'Fused RoPE + KV cache store', 'active': ['fused_set_kv_buffer', 'reshape_and_cache', 'fused_qk_rope_reshape_and_cache'], 'splits': [['rotary', 'rope'], ['reshape', 'set_kv', 'kv_cache', 'cache write', 'paged']], 'minShare': 0.3, 'likelyShare': 1.5, 'note': 'RoPE 与 KV cache 写入融合'},
    {'name': 'Fused MoE router / top-k', 'active': ['fused_moe_router', 'fusedmoerouter', 'moe_fused_gate', '_router_triton_kernel'], 'splits': [['router', 'gate'], ['topk', 'softmax', 'softcap']], 'minShare': 0.3, 'likelyShare': 1.5, 'note': '路由与 top-k/softmax 融合'},
    {'name': 'Fused MoE activation + quant', 'active': ['silu_and_mul_scaled_fp4', 'swiglu_quant', 'npu_dequant_swiglu_quant', 'fused_silu_mul_block_quant', 'act_quant_fusion'], 'splits': [['silu', 'gelu', 'act_and_mul'], ['quant', 'fp8', 'fp4', 'dequant']], 'minShare': 0.3, 'likelyShare': 1.5, 'note': 'MoE 激活与量化/重量化融合'},
    {'name': 'Fused RMSNorm + quant', 'active': ['fused_add_rms_norm_static_fp8_quant', 'rms_quant_fusion', 'norm_quant', 'fused_rms_fp8_group_quant'], 'splits': [['rmsnorm', 'layernorm'], ['quant', 'fp8', 'fp4']], 'minShare': 0.3, 'likelyShare': 1.5, 'note': '归一化与量化融合'},
    {'name': 'AllReduce + RMSNorm fusion（需 TP≥2）', 'active': ['allreduce_fusion', 'fusedaddrmsnormkernel', 'tensor_model_parallel_fused_allreduce_rmsnorm', 'custom_fused_ar_rms'], 'splits': [['allreduce', 'all_reduce', 'cross_device_reduce'], ['rmsnorm', 'layernorm', 'fused_add_rmsnorm']], 'minShare': 0.5, 'likelyShare': 4.0, 'note': '通信与归一化融合，TP≥2 才有收益'},
    {'name': 'Fused MoE sum + all-reduce（需 TP≥2）', 'active': ['fuse_sum_all_reduce'], 'splits': [['fused_moe', 'moe', 'expert'], ['allreduce', 'all_reduce']], 'minShare': 0.4, 'likelyShare': 2.0, 'note': 'MoE 求和与 all-reduce 融合'},
    {'name': 'Attention + quantization', 'active': ['merge_attn_states', 'attn_quant_fusion', 'output_scale'], 'splits': [['attention', 'flash_attn', 'fmha'], ['quant', 'fp8', 'fp4']], 'minShare': 0.3, 'likelyShare': 1.5, 'note': '注意力输出与量化融合'},
    {'name': 'MLA fused projection + norm + RoPE', 'active': ['qkv_proj_with_rope_fused_weight', 'fused_qkv_a_proj_with_mqa', 'forward_absorb_fused_mla_rope'], 'splits': [['mla', 'qkv_a_proj', 'q_a_proj'], ['qknorm', 'rmsnorm', 'apply_qk_norm'], ['rope', 'rotary']], 'minShare': 0.4, 'likelyShare': 2.0, 'note': 'DeepSeek MLA 投影+归一化+RoPE 融合'},
    {'name': 'FP8 scaled-MM（nvjet fallback 气泡）', 'active': ['cutlass_scaled_mm', 'fp8_scaled_mm'], 'splits': [['nvjet', '_scaled_mm'], ['memset', 'memcpy']], 'minShare': 0.1, 'likelyShare': 1.0, 'note': 'scaled_mm 走 nvjet fallback 时 memset/memcpy 气泡显著'},
]

KERNEL_CAT_RE = re.compile(r'kernel|^gpu_')


def analyze_trace_kernels(events, cap=2000000):
    empty = {'kernels': [], 'gpu': None, 'overlap': [], 'fusion': []}
    if not isinstance(events, list):
        return empty
    # 第一遍：主 rank 选择 + cpu_op（External id → 算子名）+ 阶段注释窗口
    pid_us = defaultdict(float)
    cpu_ops = {}
    annos = []
    scanned = 0
    for e in events:
        if not isinstance(e, dict) or e.get('ph') != 'X':
            continue
        scanned += 1
        if scanned > cap:
            break
        cat = str(e.get('cat') or '')
        try:
            dur = float(e.get('dur') or 0)
        except Exception:  # noqa: BLE001
            dur = 0.0
        if dur <= 0:
            continue
        if KERNEL_CAT_RE.search(cat):
            pid_us[str(e.get('pid'))] += dur
        elif cat == 'cpu_op':
            args = e.get('args') if isinstance(e.get('args'), dict) else {}
            ext = args.get('External id')
            if ext is not None and ext not in cpu_ops:
                cpu_ops[ext] = str(e.get('name') or '')
        elif cat in ('user_annotation', 'gpu_user_annotation'):
            nm = str(e.get('name') or '').lower()
            st = ''
            if RE_DECODE.search(nm):
                st = 'decode'
            elif RE_PREFILL.search(nm):
                st = 'prefill'
            if st:
                ts = float(e.get('ts') or 0)
                annos.append({'ts': ts, 'end': ts + dur, 'st': st})
    if not pid_us:
        return empty
    main_pid = max(pid_us.items(), key=lambda kv: kv[1])[0]
    for pid in pid_us:
        if RE_TP0.search(pid):
            main_pid = pid
            break
    # 阶段窗口合并：同阶段相邻（间隔 ≤1e-3 µs）并窗
    annos.sort(key=lambda a: (a['ts'], a['end']))
    windows = []
    for a in annos:
        if windows and windows[-1]['st'] == a['st'] and a['ts'] - windows[-1]['end'] <= 1e-3:
            windows[-1]['end'] = max(windows[-1]['end'], a['end'])
        else:
            windows.append(dict(a))

    def stage_of(ts):
        best = None
        best_dist = float('inf')
        for w in windows:
            if w['ts'] <= ts <= w['end']:
                return w['st']
            d = w['ts'] - ts if ts < w['ts'] else ts - w['end']
            if d < best_dist:
                best_dist = d
                best = w
        return best['st'] if best and best_dist <= 20000 else 'all'

    # 第二遍：收集主 rank 内核实例
    kers = []
    scanned = 0
    for e in events:
        if not isinstance(e, dict) or e.get('ph') != 'X':
            continue
        scanned += 1
        if scanned > cap:
            break
        cat = str(e.get('cat') or '')
        if not KERNEL_CAT_RE.search(cat):
            continue
        try:
            dur = float(e.get('dur') or 0)
        except Exception:  # noqa: BLE001
            dur = 0.0
        if dur <= 0 or str(e.get('pid')) != main_pid:
            continue
        args = e.get('args') if isinstance(e.get('args'), dict) else {}
        try:
            ts = float(e.get('ts') or 0)
        except Exception:  # noqa: BLE001
            ts = 0.0
        ext = args.get('External id')
        stream = args.get('stream')
        if stream is None:
            stream = args.get('cuda_stream')
        kers.append({
            'name': str(e.get('name') or '?'), 'ts': ts, 'end': ts + dur, 'dur': dur,
            'stream': str(stream if stream is not None else 'tid=' + str(e.get('tid'))),
            'cpuOp': cpu_ops.get(ext, '') if ext is not None else '',
        })
        if len(kers) >= 100000:
            break
    if not kers:
        return empty
    kers.sort(key=lambda k: (k['ts'], k['end']))
    # 同名聚合（canonical 名）
    agg = {}
    kernel_sum = 0.0
    stage_us = {'decode': 0.0, 'prefill': 0.0, 'all': 0.0}
    for k in kers:
        canon = canonical_kernel_name(k['name'])
        a = agg.get(canon)
        if a is None:
            a = {'name': canon, 'family': classify_kernel(k['name']), 'total': 0.0, 'count': 0,
                 'hidden': 0.0, 'exclusive': 0.0, 'hiddenByCompute': 0.0, 'depRank': -1,
                 'cpuOps': defaultdict(int), 'stages': {'decode': 0.0, 'prefill': 0.0, 'all': 0.0}}
            agg[canon] = a
        a['total'] += k['dur']
        a['count'] += 1
        if k['cpuOp']:
            a['cpuOps'][k['cpuOp']] += 1
        st = stage_of(k['ts'])
        a['stages'][st] += k['dur']
        stage_us[st] += k['dur']
        k['a'] = a
        k['bucket'] = kernel_bucket(a['family'])
        kernel_sum += k['dur']
    # 扫描线：busy 并集 / 跨流重叠 / 每内核 hidden（被异流遮住）与 exclusive（暴露）
    pts = []
    for i, k in enumerate(kers):
        pts.append((k['ts'], 1, i))
        pts.append((k['end'], 0, i))
    pts.sort(key=lambda p: (p[0], p[1]))
    active = set()
    active_streams = defaultdict(int)
    prev_t = None
    busy = 0.0
    overlap_t = 0.0
    max_conc = 0
    min_ts = kers[0]['ts']
    max_end = max(k['end'] for k in kers)
    for t, s, i in pts:
        if prev_t is not None and t > prev_t and active:
            seg = t - prev_t
            busy += seg
            if len(active_streams) >= 2:
                overlap_t += seg
                for ai in active:
                    kers[ai]['a']['hidden'] += seg
                    for aj in active:
                        if aj != ai and kers[aj]['stream'] != kers[ai]['stream'] and kers[aj]['bucket'] == 'compute':
                            kers[ai]['a']['hiddenByCompute'] += seg
                            break
            else:
                for ai in active:
                    kers[ai]['a']['exclusive'] += seg
        if s == 1:
            active.add(i)
            active_streams[kers[i]['stream']] += 1
            if len(active_streams) > max_conc:
                max_conc = len(active_streams)
        else:
            active.discard(i)
            c = active_streams.get(kers[i]['stream'], 1) - 1
            if c <= 0:
                active_streams.pop(kers[i]['stream'], None)
            else:
                active_streams[kers[i]['stream']] = c
        prev_t = t
    window = max_end - min_ts
    idle = max(0.0, window - busy)
    # 同流紧邻依赖风险
    by_stream = defaultdict(list)
    for i, k in enumerate(kers):
        by_stream[k['stream']].append(i)
    DEP_LOW, DEP_UNCLEAR, DEP_HIGH = 0, 1, 2
    for arr in by_stream.values():
        for x in range(len(arr)):
            k = kers[arr[x]]
            a = k['a']
            tight = max(2.0, min(20.0, k['dur'] * 0.15))
            for nb in (arr[x - 1] if x > 0 else None, arr[x + 1] if x + 1 < len(arr) else None):
                if nb is None:
                    continue
                n = kers[nb]
                gap = k['ts'] - n['end'] if nb == (arr[x - 1] if x > 0 else None) else n['ts'] - k['end']
                if gap < 0 or gap > tight:
                    continue
                same_op = k['cpuOp'] and n['cpuOp'] and k['cpuOp'] == n['cpuOp']
                dep_like = (k['bucket'] == 'communication' and n['bucket'] != 'communication') or \
                    (k['bucket'] in ('elementwise', 'memory') and n['bucket'] in ('compute', 'communication', 'elementwise', 'memory'))
                rank = DEP_HIGH if (same_op or dep_like) else DEP_UNCLEAR
                if rank > a['depRank']:
                    a['depRank'] = rank
    # 重叠机会（share 分母 = busy 并集）
    denom = busy or kernel_sum or 1.0
    WEIGHT = {'communication': 1.3, 'memory': 1.15, 'elementwise': 1.0, 'compute': 0.35, 'other': 0.8}
    headroom = []
    lowroi = []
    for a in agg.values():
        if a['total'] < 5:
            continue
        share = a['total'] / denom * 100
        if share < 1:
            continue
        excl_r = a['exclusive'] / a['total']
        hid_r = a['hidden'] / a['total']
        bucket = kernel_bucket(a['family'])
        dep = 'high' if a['depRank'] == DEP_HIGH else ('unclear' if a['depRank'] == DEP_UNCLEAR else 'low')
        if excl_r >= 0.45:
            headroom.append({
                'verdict': 'headroom', 'name': a['name'], 'family': a['family'], 'bucket': bucket,
                'total': a['total'], 'share': share, 'exclusiveRatio': excl_r, 'hiddenRatio': hid_r, 'dep': dep,
                'prio': 'P1' if dep == 'low' else 'P2',
                'rec': ('try overlap' if bucket == 'communication' else 'try fusion') if dep == 'low' else 'check deps',
                'score': a['exclusive'] * WEIGHT.get(bucket, 0.8),
            })
        elif bucket in ('elementwise', 'memory') and hid_r >= 0.65:
            lowroi.append({
                'verdict': 'low-roi-hidden', 'name': a['name'], 'family': a['family'], 'bucket': bucket,
                'total': a['total'], 'share': share, 'exclusiveRatio': excl_r, 'hiddenRatio': hid_r,
                'dep': dep, 'prio': 'P4', 'rec': 'skip',
                'score': a['hidden'] * (1 + a['hiddenByCompute'] / max(a['hidden'], 1.0)),
            })
    headroom.sort(key=lambda o: ((1 if o['bucket'] == 'compute' else 0), -o['score']))
    lowroi.sort(key=lambda o: -o['score'])
    overlap = [{k2: v for k2, v in o.items() if k2 != 'score'} for o in (headroom[:5] + lowroi[:5])]
    # 融合候选：匹配文本 = canonical 内核名 + CPU 算子名（小写）
    krows = list(agg.values())

    def row_text(a):
        return (a['name'] + ' ' + ' '.join(a['cpuOps'].keys())).lower()

    fusion = []
    for p in FUSION_PATTERNS:
        active_rows = [a for a in krows if any(kw in row_text(a) for kw in p['active'])]
        conf = ''
        related = active_rows
        if active_rows:
            conf = 'Confirmed'
        elif p['splits']:
            hit_sets = [[a for a in krows if any(kw in row_text(a) for kw in g)] for g in p['splits']]
            if all(hit_sets):
                uniq = {}
                for hs in hit_sets:
                    for a in hs:
                        uniq[a['name']] = a
                related = list(uniq.values())
                rel = sum(a['total'] for a in related)
                share_pct = rel / (kernel_sum or 1.0) * 100
                if share_pct >= p['minShare']:
                    conf = 'Confirmed' if share_pct >= p['likelyShare'] else 'Candidate'
        if not conf:
            continue
        rel = sum(a['total'] for a in related)
        related_sorted = sorted(related, key=lambda a: -a['total'])
        fusion.append({
            'pattern': p['name'], 'confidence': conf, 'relatedUs': rel,
            'share': rel / (kernel_sum or 1.0) * 100,
            'evidence': [a['name'] for a in related_sorted[:3]], 'note': p['note'],
        })
    # 内核归因表（share 分母 = 内核累计）
    kernels = []
    for a in sorted(krows, key=lambda a: -a['total'])[:30]:
        cpu_op = ''
        if a['cpuOps']:
            cpu_op = sorted(a['cpuOps'].items(), key=lambda kv: -kv[1])[0][0]
        kernels.append({
            'name': a['name'], 'family': a['family'], 'total': a['total'], 'count': a['count'],
            'share': a['total'] / (kernel_sum or 1.0) * 100,
            'cpuOp': cpu_op, 'stages': a['stages'],
            'exclusiveRatio': a['exclusive'] / a['total'] if a['total'] else 0,
            'hiddenRatio': a['hidden'] / a['total'] if a['total'] else 0,
        })
    return {
        'kernels': kernels, 'overlap': overlap, 'fusion': fusion,
        'gpu': {
            'window': window, 'busy': busy, 'sum': kernel_sum, 'idle': idle,
            'idlePct': idle / window * 100 if window > 0 else 0,
            'overlap': overlap_t, 'maxConcurrent': max_conc, 'streams': len(by_stream),
            'kernelCount': len(kers), 'stageUs': stage_us,
        },
    }


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: trace_summary.py <file>"}))
        return 2
    path = sys.argv[1]
    try:
        if path.endswith('.gz'):
            f = gzip.open(path, 'rt', encoding='utf-8', errors='replace')
        else:
            f = open(path, 'r', encoding='utf-8', errors='replace')
        with f:
            data = json.load(f)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e)}))
        return 1
    events = data.get('traceEvents')
    if not isinstance(events, list):
        print(json.dumps({"error": "no traceEvents array"}))
        return 1

    agg = defaultdict(lambda: [0.0, 0])
    cats = defaultdict(lambda: [0.0, 0])
    ts_min = None
    ts_max = 0.0
    n_x = 0
    for e in events:
        if not isinstance(e, dict) or e.get('ph') != 'X':
            continue
        try:
            dur = float(e.get('dur') or 0)
        except Exception:  # noqa: BLE001
            dur = 0.0
        cat = str(e.get('cat') or 'other')
        name = str(e.get('name') or '?')
        key = (cat, name)
        agg[key][0] += dur
        agg[key][1] += 1
        cats[cat][0] += dur
        cats[cat][1] += 1
        n_x += 1
        ts = e.get('ts')
        if ts is not None:
            try:
                ts = float(ts)
                ts_min = ts if ts_min is None else min(ts_min, ts)
                ts_max = max(ts_max, ts + dur)
            except Exception:  # noqa: BLE001
                pass

    top = sorted(agg.items(), key=lambda kv: -kv[1][0])[:40]
    out = {
        "kind": "chrome-trace",
        "events": n_x,
        "spanUs": round(ts_max - ts_min, 3) if ts_min is not None else 0,
        "totalUs": round(sum(v[0] for v in agg.values()), 3),
        "categories": [
            {"cat": k, "totalUs": round(v[0], 3), "count": v[1]}
            for k, v in sorted(cats.items(), key=lambda kv: -kv[1][0])[:20]
        ],
        "top": [
            {"cat": k[0], "name": k[1], "totalUs": round(v[0], 3), "count": v[1]}
            for k, v in top
        ],
    }
    try:
        ka = analyze_trace_kernels(events)
        if ka.get('gpu'):
            out["kernelAnalysis"] = ka
    except Exception:  # noqa: BLE001（内核分析失败不影响既有汇总输出）
        pass
    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


sys.exit(main())
