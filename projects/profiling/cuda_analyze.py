#!/usr/bin/env python3
"""CUDA 二进制 profiling 专用工具分析器。
按扩展名调用专门的 NVIDIA 工具并把结果汇总成 JSON 写到 stdout：
  .nsys-rep / .qdrep  -> nsys stats（cuda_gpu_kern_sum / cuda_gpu_mem_time_sum / cuda_api_sum）
  .ncu-rep            -> ncu --import --csv --page raw
输出：{kind:'cuda-analysis', ok, tool, file, kernels[], mems[], apis[], metrics{}, error?, hint?}
kernels 元素：{name, count, totalNs, avgNs, pct}。页面侧按累计耗时降序渲染与瓶颈分析。
工具缺失或失败时输出 {ok:false, error, hint, detail}，绝不让页面拿到裸二进制乱码。"""
import csv
import io
import json
import os
import shutil
import subprocess
import sys

KERNEL_REPORT_COLS = {
    "total": ("total time (ns)", "total time", "total (ns)", "total"),
    "count": ("instances", "count", "calls", "num calls"),
    "avg": ("avg (ns)", "average (ns)", "avg", "average", "mean (ns)"),
}


def run(cmd, timeout=600):
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, errors="replace")
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def find_col(header, keys):
    low = [str(h).strip().lower() for h in header]
    for k in keys:
        for i, h in enumerate(low):
            if h == k or k in h:
                return i
    return None


def parse_csv_report(text):
    """nsys stats --format csv 的输出前可能有 ** 开头的说明行，定位首个含逗号的表头再解析。"""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    start = None
    for i, ln in enumerate(lines):
        s = ln.strip()
        if s.startswith("*") or s.startswith("#"):
            continue
        if "," in s:
            start = i
            break
    if start is None:
        return [], []
    rdr = csv.reader(io.StringIO("\n".join(lines[start:])))
    rows = [r for r in rdr if r]
    if not rows:
        return [], []
    return rows[0], rows[1:]


def to_float(s):
    try:
        return float(str(s).replace(",", "").strip().rstrip("%"))
    except Exception:  # noqa: BLE001
        return None


def analyze_nsys(path):
    if not shutil.which("nsys"):
        return {"ok": False, "tool": "nsys", "error": "nsys 未安装",
                "hint": "在服务器安装 NVIDIA Nsight Systems（CUDA Toolkit 附带）并加入 PATH 后重试"}
    kernels = []
    rc, out, err = run(["nsys", "stats", "--report", "cuda_gpu_kern_sum", "--format", "csv", path])
    header, rows = parse_csv_report(out)
    if header and rows:
        i_name = find_col(header, ("name", "kernel"))
        i_total = find_col(header, KERNEL_REPORT_COLS["total"])
        i_count = find_col(header, KERNEL_REPORT_COLS["count"])
        i_avg = find_col(header, KERNEL_REPORT_COLS["avg"])
        i_pct = find_col(header, ("time (%)", "time%", "pct"))
        for r in rows:
            if i_name is None or i_name >= len(r):
                continue
            total_ns = to_float(r[i_total]) if i_total is not None and i_total < len(r) else None
            count = to_float(r[i_count]) if i_count is not None and i_count < len(r) else None
            avg_ns = to_float(r[i_avg]) if i_avg is not None and i_avg < len(r) else None
            pct = to_float(r[i_pct]) if i_pct is not None and i_pct < len(r) else None
            if total_ns is None and avg_ns is not None and count:
                total_ns = avg_ns * count
            kernels.append({
                "name": r[i_name].strip(),
                "count": int(count or 1),
                "totalNs": total_ns or 0,
                "avgNs": avg_ns or 0,
                "pct": pct,
            })
        kernels.sort(key=lambda k: -k["totalNs"])
        kernels = kernels[:40]
    mems = []
    rc2, out2, _ = run(["nsys", "stats", "--report", "cuda_gpu_mem_time_sum", "--format", "csv", path])
    h2, r2 = parse_csv_report(out2)
    if h2 and r2:
        i_op = find_col(h2, ("operation", "name"))
        i_total = find_col(h2, KERNEL_REPORT_COLS["total"])
        i_count = find_col(h2, KERNEL_REPORT_COLS["count"])
        for r in r2[:10]:
            if i_op is None or i_op >= len(r):
                continue
            mems.append({
                "name": r[i_op].strip(),
                "count": int(to_float(r[i_count]) or 1) if i_count is not None and i_count < len(r) else 1,
                "totalNs": (to_float(r[i_total]) or 0) if i_total is not None and i_total < len(r) else 0,
            })
    apis = []
    rc3, out3, _ = run(["nsys", "stats", "--report", "cuda_api_sum", "--format", "csv", path])
    h3, r3 = parse_csv_report(out3)
    if h3 and r3:
        i_name = find_col(h3, ("name", "api"))
        i_total = find_col(h3, KERNEL_REPORT_COLS["total"])
        i_count = find_col(h3, KERNEL_REPORT_COLS["count"])
        for r in r3[:10]:
            if i_name is None or i_name >= len(r):
                continue
            apis.append({
                "name": r[i_name].strip(),
                "count": int(to_float(r[i_count]) or 1) if i_count is not None and i_count < len(r) else 1,
                "totalNs": (to_float(r[i_total]) or 0) if i_total is not None and i_total < len(r) else 0,
            })
    if not kernels and not mems and not apis:
        return {"ok": False, "tool": "nsys", "error": "nsys stats 未产出数据",
                "detail": (err or out)[-500:], "hint": "确认报告文件完整，或手工执行 nsys stats <file> 检查"}
    return {"ok": True, "tool": "nsys", "kernels": kernels, "mems": mems, "apis": apis}


def analyze_ncu(path):
    if not shutil.which("ncu"):
        return {"ok": False, "tool": "ncu", "error": "ncu 未安装",
                "hint": "在服务器安装 NVIDIA Nsight Compute 并加入 PATH 后重试"}
    rc, out, err = run(["ncu", "--import", path, "--csv", "--page", "raw"], timeout=900)
    header, rows = parse_csv_report(out)
    if not header or not rows:
        return {"ok": False, "tool": "ncu", "error": "ncu 未产出 raw 页数据",
                "detail": (err or out)[-500:], "hint": "手工执行 ncu --import <file> --page raw 检查"}
    i_name = find_col(header, ("kernel name", "kernel", "name"))
    i_dur = find_col(header, ("gpu__time_duration.sum", "gpu__time_duration.avg", "gpu__time_duration", "duration"))
    i_sm = find_col(header, ("sm__throughput.avg.pct_of_peak_sustained_elapsed", "sm__throughput", "sm busy"))
    i_mem = find_col(header, ("gpu__compute_memory_throughput", "memory throughput", "dram__throughput"))
    i_occ = find_col(header, ("achieved_occupancy", "sm__warps_active.avg.pct"))
    kernels = []
    sm_vals, mem_vals, occ_vals = [], [], []
    for r in rows:
        if i_name is None or i_name >= len(r):
            continue
        dur = to_float(r[i_dur]) if i_dur is not None and i_dur < len(r) else None
        kernels.append({
            "name": r[i_name].strip(),
            "count": 1,
            "totalNs": dur or 0,
            "avgNs": dur or 0,
            "pct": None,
        })
        if i_sm is not None and i_sm < len(r):
            v = to_float(r[i_sm])
            if v is not None:
                sm_vals.append(v)
        if i_mem is not None and i_mem < len(r):
            v = to_float(r[i_mem])
            if v is not None:
                mem_vals.append(v)
        if i_occ is not None and i_occ < len(r):
            v = to_float(r[i_occ])
            if v is not None:
                occ_vals.append(v)
    kernels.sort(key=lambda k: -k["totalNs"])
    metrics = {}
    if sm_vals:
        metrics["SM 利用率均值"] = round(sum(sm_vals) / len(sm_vals), 1)
    if mem_vals:
        metrics["显存带宽利用均值"] = round(sum(mem_vals) / len(mem_vals), 1)
    if occ_vals:
        metrics["Achieved Occupancy 均值"] = round(sum(occ_vals) / len(occ_vals), 1)
    metrics["采集内核数"] = len(kernels)
    return {"ok": True, "tool": "ncu", "kernels": kernels[:40], "metrics": metrics}


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: cuda_analyze.py <file>"}, ensure_ascii=False))
        return 2
    path = sys.argv[1]
    if not os.path.isfile(path):
        print(json.dumps({"ok": False, "error": "file not found: " + path}, ensure_ascii=False))
        return 1
    low = path.lower()
    try:
        if low.endswith((".nsys-rep", ".qdrep")):
            d = analyze_nsys(path)
        elif low.endswith(".ncu-rep"):
            d = analyze_ncu(path)
        else:
            d = {"ok": False, "error": "不支持的二进制类型",
                 "hint": "仅支持 .nsys-rep / .qdrep（nsys）与 .ncu-rep（ncu）"}
    except subprocess.TimeoutExpired:
        d = {"ok": False, "error": "分析超时", "hint": "文件过大时可先在服务器手工执行工具命令"}
    except Exception as e:  # noqa: BLE001
        d = {"ok": False, "error": str(e)}
    d["kind"] = "cuda-analysis"
    d["file"] = path
    json.dump(d, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
