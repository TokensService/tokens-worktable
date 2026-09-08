#!/usr/bin/env python3
"""Collect vLLM/XDS Prometheus metrics for a specified time range.

Pipeline shared environment variables: NAMESPACE, ARCH_NAME, PROMETHEUS_URL,
RUN_DIR. Collector-specific controls use VLLM_METRICS_* or METRICS_*.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, build_opener


METRICS = (
    "chat_je_inbound_request_latency_count",
    "chat_je_inbound_request_latency_sum",
    "chat_je_num_of_requests_in",
    "chat_je_num_of_requests_out",
    "fe_inbound_request_iops",
    "fe_inbound_request_latency_count",
    "fe_inbound_request_latency_sum",
    "fe_num_inbound_requests",
    "fe_num_outbound_requests",
    "fe_outbound_request_latency_count",
    "fe_outbound_request_latency_sum",
    "fe_to_je_avg_latency",
    "fe_to_je_latency_count",
    "fe_to_je_latency_sum",
    "first_token_dte_to_fe_request_latency_count",
    "first_token_dte_to_fe_request_latency_sum",
    "first_token_latency_count",
    "first_token_latency_sum",
    "incremental_latency_count",
    "incremental_latency_sum",
    "inference_input_tokens_bucket",
    "inference_latency_count",
    "inference_latency_sum",
    "inference_reasoning_tokens_bucket",
    "inference_tokens_bucket",
    "je_avg_latency",
    "je_processor_avg_process_latency",
    "je_processor_avg_queue_latency",
    "je_to_te_latency_count",
    "je_to_te_latency_sum",
    "je_ts_avg_latency",
    "job_executor_state",
    "second_token_latency_count",
    "second_token_latency_sum",
    "task_executor_starting_nums",
    "task_executor_working_nums",
    "te_to_dp_actor_latency_count",
    "te_to_dp_actor_latency_sum",
    "vllm:e2e_request_latency_seconds_bucket",
    "vllm:e2e_request_latency_seconds_count",
    "vllm:e2e_request_latency_seconds_sum",
    "vllm:ems_exists_sdk_latency_ms_count",
    "vllm:ems_exists_sdk_latency_ms_sum",
    "vllm:ems_load_sdk_latency_ms_count",
    "vllm:ems_load_sdk_latency_ms_sum",
    "vllm:ems_nominal_hit_rate",
    "vllm:ems_num_exists_query_total",
    "vllm:ems_num_loaded_blocks_total",
    "vllm:ems_num_saved_blocks_total",
    "vllm:ems_num_to_load_blocks_total",
    "vllm:ems_num_to_save_blocks_total",
    "vllm:ems_real_hit_rate",
    "vllm:ems_save_sdk_latency_ms_count",
    "vllm:ems_save_sdk_latency_ms_sum",
    "vllm:external_prefix_cache_hits_total",
    "vllm:external_prefix_cache_queries_total",
    "vllm:generation_tokens_total",
    "vllm:gpu_cache_blocks_total",
    "vllm:inter_token_latency_seconds_bucket",
    "vllm:inter_token_latency_seconds_count",
    "vllm:inter_token_latency_seconds_sum",
    "vllm:kv_cache_usage_perc",
    "vllm:mooncake_bytes_transferred_count",
    "vllm:mooncake_bytes_transferred_sum",
    "vllm:mooncake_num_failed_recvs_total",
    "vllm:mooncake_num_failed_transfers_total",
    "vllm:mooncake_num_kv_expired_reqs_total",
    "vllm:mooncake_xfer_time_seconds_bucket",
    "vllm:mooncake_xfer_time_seconds_count",
    "vllm:mooncake_xfer_time_seconds_sum",
    "vllm:mtp_high_accept_requests_total",
    "vllm:mtp_low_accept_requests_total",
    "vllm:mtp_truncation_enabled",
    "vllm:num_preemptions_total",
    "vllm:num_requests_running",
    "vllm:num_requests_swapped",
    "vllm:num_requests_waiting",
    "vllm:prefix_cache_hits_total",
    "vllm:prefix_cache_queries_total",
    "vllm:prompt_tokens_total",
    "vllm:repetition_detected_requests_total",
    "vllm:request_decode_time_seconds_sum",
    "vllm:request_generation_tokens_bucket",
    "vllm:request_generation_tokens_sum",
    "vllm:request_prefill_time_seconds_count",
    "vllm:request_prefill_time_seconds_sum",
    "vllm:request_prompt_tokens_bucket",
    "vllm:request_queue_time_seconds_bucket",
    "vllm:request_queue_time_seconds_sum",
    "vllm:request_success_total",
    "vllm:request_time_per_output_token_seconds_bucket",
    "vllm:spec_decode_num_accepted_tokens_per_pos_total",
    "vllm:spec_decode_num_accepted_tokens_total",
    "vllm:spec_decode_num_drafts_total",
    "vllm:spec_decode_num_draft_tokens_total",
    "vllm:time_to_first_token_seconds_bucket",
    "vllm:time_to_first_token_seconds_count",
    "vllm:time_to_first_token_seconds_sum",
)

METRIC_PATTERN = re.compile(r"^[A-Za-z_:][A-Za-z0-9_:]*$")
MODELLESS_METRICS = {
    "vllm:mtp_high_accept_requests_total",
    "vllm:mtp_low_accept_requests_total",
    "vllm:mtp_truncation_enabled",
    "vllm:spec_decode_num_accepted_tokens_per_pos_total",
    "vllm:spec_decode_num_accepted_tokens_total",
    "vllm:spec_decode_num_drafts_total",
    "vllm:spec_decode_num_draft_tokens_total",
}
JOBLESS_METRICS = MODELLESS_METRICS | {
    "vllm:ems_exists_sdk_latency_ms_count",
    "vllm:ems_exists_sdk_latency_ms_sum",
    "vllm:ems_load_sdk_latency_ms_count",
    "vllm:ems_load_sdk_latency_ms_sum",
    "vllm:ems_nominal_hit_rate",
    "vllm:ems_num_exists_query_total",
    "vllm:ems_num_loaded_blocks_total",
    "vllm:ems_num_saved_blocks_total",
    "vllm:ems_num_to_load_blocks_total",
    "vllm:ems_num_to_save_blocks_total",
    "vllm:ems_real_hit_rate",
    "vllm:ems_save_sdk_latency_ms_count",
    "vllm:ems_save_sdk_latency_ms_sum",
}
MODEL_LABEL_ROOT = "/home/service/works/models_ssd"
MODEL_LABEL_VERSION = "v1"


def parse_time(value: str) -> int:
    if value.isdigit():
        return int(value)
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = dt.datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError("时间必须带时区，例如 2026-09-02T00:00:00Z")
    return int(parsed.timestamp())


def promql_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def normalize_model_label(model_name: str | None) -> str | None:
    """Turn a model identifier into the vLLM Prometheus label value.

    vLLM exposes relative model names as the model directory ending in ``/v1``.
    Callers that already provide an absolute label value retain full control.
    """
    if not model_name or model_name.startswith("/"):
        return model_name
    return f"{MODEL_LABEL_ROOT}/{model_name.rstrip('/')}/{MODEL_LABEL_VERSION}"


def build_query(metric: str, namespace: str | None, model_name: str | None, job_regex: str | None, model_path: str | None = None) -> str:
    labels: list[str] = []
    if namespace:
        labels.append(f'xds_namespace="{promql_string(namespace)}"')
    model_label = model_path if model_path else normalize_model_label(model_name)
    if metric.startswith("vllm:") and model_label and metric not in MODELLESS_METRICS:
        labels.append(f'model_name="{promql_string(model_label)}"')
    if job_regex and metric not in JOBLESS_METRICS:
        labels.append(f'exported_job=~"{promql_string(job_regex)}"')
    return metric if not labels else f"{metric}{{{','.join(labels)}}}"


def request_range(base_url: str, query: str, start: int, end: int, step: str, timeout: int) -> dict:
    params = urlencode({"query": query, "start": str(start), "end": str(end), "step": step})
    url = f"{base_url.rstrip('/')}/api/v1/query_range?{params}"
    # Prometheus is commonly an intranet endpoint; do not inherit shell proxy settings.
    with build_opener(ProxyHandler({})).open(url, timeout=timeout) as response:
        payload = json.load(response)
    if payload.get("status") != "success":
        raise RuntimeError(payload.get("error", "Prometheus 返回非 success 状态"))
    return payload


def safe_filename(metric: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", metric).strip("_") + ".json"


def step_seconds(value: str) -> float:
    match = re.fullmatch(r"(\d+(?:\.\d+)?)(ms|s|m|h)", value)
    if not match:
        raise ValueError("--step 必须是 Prometheus 时长，例如 30s、1m 或 1h")
    amount = float(match.group(1))
    unit = match.group(2)
    return amount * {"ms": 0.001, "s": 1, "m": 60, "h": 3600}[unit]


def env_value(*names: str, default: str | None = None) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return default


def default_output_dir() -> str:
    configured = env_value("METRICS_OUTPUT_DIR", "VLLM_METRICS_OUTPUT_DIR")
    if configured:
        return configured
    archive_folder = os.getenv("ARCHIVE_FOLDER")
    if archive_folder:
        return str(Path(archive_folder) / "metrics")
    run_dir = os.getenv("RUN_DIR")
    return str(Path(run_dir) / "vllm-metrics") if run_dir else "vllm-metrics"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=("start", "collect", "stop"),
                        default=env_value("METRICS_ACTION", "VLLM_METRICS_ACTION", default="start"),
                        help="start 后台启动，collect 前台采集，stop 终止后台采集；环境变量 METRICS_ACTION")
    parser.add_argument("--start", default=env_value("PROM_START", "VLLM_METRICS_START"),
                        help="开始时间；未设置时取启动时刻，环境变量 PROM_START（兼容 VLLM_METRICS_START）")
    parser.add_argument("--end", default=env_value("PROM_END", "VLLM_METRICS_END"),
                        help="结束时间；未设置时持续采集，环境变量 PROM_END（兼容 VLLM_METRICS_END）")
    parser.add_argument("--step", default=os.getenv("VLLM_METRICS_STEP", "5s"),
                        help="Prometheus 查询/采集周期，默认 5s；环境变量 VLLM_METRICS_STEP")
    parser.add_argument("--prometheus-url", default=env_value("PROMETHEUS_URL", "VLLM_METRICS_PROMETHEUS_URL", default="http://192.168.10.6:25889"),
                        help="环境变量 PROMETHEUS_URL（兼容 VLLM_METRICS_PROMETHEUS_URL）")
    parser.add_argument("--namespace", default=os.getenv("NAMESPACE"),
                        help="环境变量 NAMESPACE；未设置时不按命名空间筛选")
    parser.add_argument("--model-path", default=env_value("model_path", "MODEL_PATH"),
                        help="完整模型路径，原样作为 model_name 标签；优先于模型名，环境变量 model_path / MODEL_PATH")
    parser.add_argument("--model-name", default=env_value("model_name", "MODEL_NAME", "ARCH_NAME"),
                        help="环境变量 model_name / MODEL_NAME（兼容 ARCH_NAME）；相对模型名按 /home/service/works/models_ssd/<name>/v1 筛选，绝对路径原样使用")
    parser.add_argument("--job-regex", default=os.getenv("VLLM_METRICS_JOB_REGEX"))
    parser.add_argument("--metric", action="append", help="仅采集指定指标；可重复传入")
    parser.add_argument("--output-dir", default=default_output_dir(),
                        help="环境变量 METRICS_OUTPUT_DIR；未设置时使用 ARCHIVE_FOLDER/metrics 或 RUN_DIR/vllm-metrics")
    parser.add_argument("--timeout", type=int, default=os.getenv("VLLM_METRICS_TIMEOUT", "30"),
                        help="每个查询的 HTTP 超时秒数；环境变量 VLLM_METRICS_TIMEOUT")
    parser.add_argument("--max-iterations", type=int, default=os.getenv("VLLM_METRICS_MAX_ITERATIONS", "0"),
                        help="持续采集最大轮次；0 表示持续运行，环境变量 VLLM_METRICS_MAX_ITERATIONS")
    parser.add_argument("--pid-file", default=env_value("METRICS_PID_FILE", "VLLM_METRICS_PID_FILE"),
                        help="后台采集器 PID 文件；默认 <output-dir>/collector.pid")
    parser.add_argument("--log-file", default=env_value("METRICS_LOG_FILE", "VLLM_METRICS_LOG_FILE"),
                        help="后台采集器日志；默认 <output-dir>/collector.log")
    # 同时支持脚本名后面的 PROM_START=... PROM_END=... 参数。
    argv = []
    for arg in sys.argv[1:]:
        key, separator, value = arg.partition("=")
        if separator and key in ("PROM_START", "PROM_END"):
            argv.append(("--start=" if key == "PROM_START" else "--end=") + value)
        else:
            argv.append(arg)
    return parser.parse_args(argv)


def collect_once(args: argparse.Namespace, metrics: list[str], start: int, end: int, output_dir: Path) -> int:
    query_dir = output_dir / "queries"
    query_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []

    for index, metric in enumerate(metrics, start=1):
        query = build_query(metric, args.namespace, args.model_name, args.job_regex, args.model_path)
        result = {"metric": metric, "query": query, "status": "success", "series_count": 0, "sample_count": 0}
        try:
            payload = request_range(args.prometheus_url, query, start, end, args.step, args.timeout)
            data = payload.get("data", {})
            series = data.get("result", [])
            result["series_count"] = len(series)
            result["sample_count"] = sum(len(item.get("values", [])) for item in series)
            result["file"] = str(Path("queries") / safe_filename(metric))
            (query_dir / safe_filename(metric)).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        except (HTTPError, URLError, TimeoutError, ValueError, RuntimeError, OSError) as error:
            result["status"] = "failed"
            result["error"] = str(error)
        results.append(result)
        print(f"[{index}/{len(metrics)}] {metric}: {result['status']} series={result['series_count']} samples={result['sample_count']}")
        if result["status"] == "failed":
            print(f"  error: {result['error']}", file=sys.stderr)

    summary = {
        "prometheus_url": args.prometheus_url,
        "start": start,
        "end": end,
        "step": args.step,
        "namespace": args.namespace,
        "model_name": args.model_name,
        "model_path": args.model_path,
        "job_regex": args.job_regex,
        "successful_queries": sum(item["status"] == "success" for item in results),
        "failed_queries": sum(item["status"] == "failed" for item in results),
        "results": results,
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    with (output_dir / "summary.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["metric", "status", "series_count", "sample_count", "file", "error", "query"])
        writer.writeheader()
        writer.writerows(results)

    print(f"收集归档目录: {output_dir.resolve()}")
    return 1 if summary["failed_queries"] else 0


def collector_paths(args: argparse.Namespace) -> tuple[Path, Path]:
    output_dir = Path(args.output_dir)
    return (
        Path(args.pid_file) if args.pid_file else output_dir / "collector.pid",
        Path(args.log_file) if args.log_file else output_dir / "collector.log",
    )


def process_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        # os.kill(pid, 0) 对尚未被父进程回收的 zombie 仍会成功。
        if Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").split()[2] == "Z":
            return False
    except (FileNotFoundError, IndexError):
        return False
    return True


def start_collector(args: argparse.Namespace) -> int:
    pid_file, log_file = collector_paths(args)
    if pid_file.is_file():
        try:
            existing_pid = int(pid_file.read_text().strip())
        except ValueError:
            existing_pid = 0
        if existing_pid and process_running(existing_pid):
            print(f"采集器已在运行: pid={existing_pid} pid_file={pid_file}", file=sys.stderr)
            return 1
        pid_file.unlink(missing_ok=True)

    env = os.environ.copy()
    env.update({
        "METRICS_ACTION": "collect",
        "PROM_START": args.start or str(int(time.time())),
        "VLLM_METRICS_START": args.start or str(int(time.time())),
        "PROM_END": args.end or "",
        "VLLM_METRICS_END": args.end or "",
        "VLLM_METRICS_STEP": args.step,
        "PROMETHEUS_URL": args.prometheus_url,
        "NAMESPACE": args.namespace or "",
        "model_name": args.model_name or "",
        "MODEL_NAME": args.model_name or "",
        "ARCH_NAME": args.model_name or "",
        "model_path": args.model_path or "",
        "MODEL_PATH": args.model_path or "",
        "VLLM_METRICS_JOB_REGEX": args.job_regex or "",
        "METRICS_OUTPUT_DIR": args.output_dir,
        "VLLM_METRICS_TIMEOUT": str(args.timeout),
        "VLLM_METRICS_MAX_ITERATIONS": str(args.max_iterations),
        "METRICS_PID_FILE": str(pid_file),
        "METRICS_LOG_FILE": str(log_file),
    })
    if args.metric:
        env["VLLM_METRICS_METRICS"] = ",".join(args.metric)

    pid_file.parent.mkdir(parents=True, exist_ok=True)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with log_file.open("a", encoding="utf-8") as log_handle:
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--action", "collect"],
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    pid_file.write_text(f"{process.pid}\n", encoding="utf-8")
    print(f"采集器已启动: pid={process.pid} pid_file={pid_file} log_file={log_file}")
    return 0


def stop_collector(args: argparse.Namespace) -> int:
    pid_file, _ = collector_paths(args)
    if not pid_file.is_file():
        print(f"未发现运行中的采集器: pid_file={pid_file}")
        return 0
    try:
        pid = int(pid_file.read_text().strip())
    except ValueError:
        pid_file.unlink(missing_ok=True)
        print(f"已清理无效 PID 文件: {pid_file}")
        return 0
    if not process_running(pid):
        pid_file.unlink(missing_ok=True)
        print(f"采集器已退出，清理 PID 文件: {pid_file}")
        return 0
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 15
    while process_running(pid) and time.monotonic() < deadline:
        time.sleep(0.2)
    if process_running(pid):
        os.kill(pid, signal.SIGKILL)
        print(f"采集器未在 15 秒内退出，已强制终止: pid={pid}", file=sys.stderr)
    else:
        print(f"采集器已停止: pid={pid}")
    pid_file.unlink(missing_ok=True)
    return 0


def collect(args: argparse.Namespace) -> int:
    try:
        start = parse_time(args.start) if args.start else int(time.time())
        end = parse_time(args.end) if args.end else None
        interval = step_seconds(args.step)
    except ValueError as error:
        print(f"时间参数错误: {error}", file=sys.stderr)
        return 2
    if end is not None and start >= end:
        print("时间参数错误: --start 必须早于 --end", file=sys.stderr)
        return 2
    if args.timeout <= 0 or args.max_iterations < 0:
        print("参数错误: --timeout 必须大于 0，--max-iterations 不能小于 0", file=sys.stderr)
        return 2

    env_metrics = [item.strip() for item in os.getenv("VLLM_METRICS_METRICS", "").split(",") if item.strip()]
    metrics = args.metric or env_metrics or list(METRICS)
    invalid_metrics = [metric for metric in metrics if not METRIC_PATTERN.fullmatch(metric)]
    if invalid_metrics:
        print(f"指标名非法: {', '.join(invalid_metrics)}", file=sys.stderr)
        return 2

    output_dir = Path(args.output_dir)
    now = int(time.time())
    if end is not None and end <= now:
        return collect_once(args, metrics, start, end, output_dir)

    end_text = str(end) if end is not None else "无限"
    print(f"持续采集已启动: start={start} end={end_text} step={args.step}，Ctrl-C 停止")
    cursor = start
    iteration = 0
    failed = False
    try:
        while args.max_iterations == 0 or iteration < args.max_iterations:
            now = int(time.time())
            window_end = min(now, end) if end is not None else now
            if window_end <= cursor:
                if end is not None and now >= end:
                    print(f"达到截止时间 {end}，持续采集已结束")
                    break
                time.sleep(min(interval, max(1, cursor - now + 1)))
                continue
            iteration += 1
            snapshot_dir = output_dir / "snapshots" / dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            print(f"持续采集第 {iteration} 轮: {cursor} -> {window_end}")
            failed = collect_once(args, metrics, cursor, window_end, snapshot_dir) != 0 or failed
            cursor = window_end
            if end is not None and cursor >= end:
                print(f"达到截止时间 {end}，持续采集已结束")
                break
            if args.max_iterations == 0 or iteration < args.max_iterations:
                sleep_seconds = min(interval, max(0, end - time.time())) if end is not None else interval
                time.sleep(sleep_seconds)
    except KeyboardInterrupt:
        print("持续采集已停止", file=sys.stderr)
    print(f"收集归档目录: {output_dir.resolve()}")
    return 1 if failed else 0


def main() -> int:
    args = parse_args()
    if args.action == "start":
        return start_collector(args)
    if args.action == "stop":
        return stop_collector(args)
    return collect(args)


if __name__ == "__main__":
    raise SystemExit(main())
