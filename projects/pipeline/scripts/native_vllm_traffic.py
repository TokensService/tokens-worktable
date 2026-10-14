#!/usr/bin/env python3
"""Lightweight streaming load generator for the native vLLM/Mooncake endpoint."""

import csv
import json
import os
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


URL = os.getenv("VLLM_URL", "http://127.0.0.1:8000/v1/chat/completions")
MODEL = os.getenv("MODEL_NAME", "GLM-5.2-NVFP4-W4A4C8-MG40-BNT3")
MODEL_ENDPOINT = os.getenv("MODEL_ENDPOINT", "")
QPS = float(os.getenv("QPS", "1"))
CONCURRENCY = int(os.getenv("CONCURRENCY", "8"))
DURATION = float(os.getenv("DURATION_SECONDS", "60"))
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT_SECONDS", "600"))
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "1"))
PROMPT_REPETITIONS = int(os.getenv("PROMPT_REPETITIONS", "79988"))
OUTPUT = os.getenv("OUTPUT_CSV", f"native-vllm-traffic-{time.strftime('%Y%m%d_%H%M%S')}.csv")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def one_request(index: int) -> dict:
    request_id = f"native-{index}-{uuid.uuid4().hex[:8]}"
    prompt = f"请求编号 {request_id}。为了测试 prefill，请先完整阅读这段唯一文本：" + (" a" * PROMPT_REPETITIONS)
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": MAX_TOKENS,
        "stream": True,
    }
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if MODEL_ENDPOINT:
        headers["model_endpoint"] = MODEL_ENDPOINT
    started = time.monotonic()
    row = {
        "request_id": request_id,
        "started_at": now_iso(),
        "status_code": "",
        "ttft_ms": "",
        "total_ms": "",
        "prompt_tokens": "",
        "completion_tokens": "",
        "error": "",
    }
    first_byte = None
    body_parts = []
    try:
        request = Request(URL, data=json.dumps(payload).encode(), headers=headers, method="POST")
        with urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            row["status_code"] = response.status
            for raw_line in response:
                line = raw_line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                if first_byte is None:
                    first_byte = time.monotonic()
                    row["ttft_ms"] = f"{(first_byte - started) * 1000:.3f}"
                data = line[5:].strip()
                if data == "[DONE]":
                    continue
                body_parts.append(data)
                try:
                    item = json.loads(data)
                except json.JSONDecodeError:
                    continue
                usage = item.get("usage") or {}
                if usage.get("prompt_tokens") is not None:
                    row["prompt_tokens"] = usage["prompt_tokens"]
                if usage.get("completion_tokens") is not None:
                    row["completion_tokens"] = usage["completion_tokens"]
    except HTTPError as error:
        row["status_code"] = error.code
        row["error"] = error.read().decode("utf-8", "replace")[:1000]
    except (URLError, TimeoutError, OSError) as error:
        row["error"] = str(error)[:1000]
    finally:
        row["total_ms"] = f"{(time.monotonic() - started) * 1000:.3f}"
    return row


def main():
    if QPS <= 0 or CONCURRENCY <= 0 or DURATION <= 0:
        raise SystemExit("QPS, CONCURRENCY and DURATION_SECONDS must be positive")
    fields = [
        "request_id", "started_at", "status_code", "ttft_ms", "total_ms",
        "prompt_tokens", "completion_tokens", "error",
    ]
    print(f"[traffic] url={URL} model={MODEL} qps={QPS} concurrency={CONCURRENCY} duration={DURATION}s")
    print(f"[traffic] prompt_repetitions={PROMPT_REPETITIONS} max_tokens={MAX_TOKENS} output={OUTPUT}")
    active = set()
    next_submit = time.monotonic()
    stop_at = next_submit + DURATION
    index = 0
    lock = threading.Lock()
    with open(OUTPUT, "w", newline="", encoding="utf-8") as stream, ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        while time.monotonic() < stop_at or active:
            now = time.monotonic()
            while now < stop_at and len(active) < CONCURRENCY and now >= next_submit:
                index += 1
                active.add(pool.submit(one_request, index))
                next_submit += 1.0 / QPS
                now = time.monotonic()
            if not active:
                time.sleep(max(0.001, min(0.1, next_submit - time.monotonic())))
                continue
            done, active = wait(active, timeout=0.1, return_when=FIRST_COMPLETED)
            for future in done:
                row = future.result()
                with lock:
                    writer.writerow(row)
                    stream.flush()
                print(
                    f"[traffic] {row['request_id']} status={row['status_code'] or 'ERR'} "
                    f"ttft_ms={row['ttft_ms'] or '-'} total_ms={row['total_ms']} "
                    f"error={row['error'][:120]}",
                    flush=True,
                )
    print(f"[traffic] finished requests={index} csv={OUTPUT}")


if __name__ == "__main__":
    main()
