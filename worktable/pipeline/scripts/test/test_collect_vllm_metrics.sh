#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/collect_vllm_metrics.py"

python3 - "$SCRIPT" <<'PY'
import csv
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

script = Path(sys.argv[1])
requests = []


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/v1/query_range":
            self.send_error(404)
            return
        query = parse_qs(parsed.query).get("query", [""])[0]
        requests.append((query, parse_qs(parsed.query)))
        body = json.dumps(
            {
                "status": "success",
                "data": {
                    "resultType": "matrix",
                    "result": [
                        {
                            "metric": {"__name__": "vllm:mooncake_xfer_time_seconds_bucket"},
                            "values": [["1704067200", "1"], ["1704067260", "2"]],
                        }
                    ],
                },
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

with tempfile.TemporaryDirectory() as temp_dir:
    output_dir = Path(temp_dir) / "metrics"
    result = subprocess.run(
        [
            str(script),
            "--action",
            "collect",
            "--prometheus-url",
            f"http://127.0.0.1:{server.server_port}",
            "--start",
            "2024-01-01T00:00:00Z",
            "--end",
            "2024-01-01T00:10:00Z",
            "--step",
            "60s",
            "--namespace",
            "xds-test",
            "--model-name",
            "GLM-5.2-NVFP4-W4A4-MG39-BNT3",
            "--job-regex",
            ".*vllmp.*",
            "--metric",
            "vllm:mooncake_xfer_time_seconds_bucket",
            "--output-dir",
            str(output_dir),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"
    assert len(requests) == 1
    query, params = requests[0]
    assert 'xds_namespace="xds-test"' in query
    assert 'model_name="/home/service/works/models_ssd/GLM-5.2-NVFP4-W4A4-MG39-BNT3/v1"' in query
    assert 'exported_job=~".*vllmp.*"' in query
    assert params["start"] == ["1704067200"]
    assert params["end"] == ["1704067800"]
    assert params["step"] == ["60s"]

    summary = json.loads((output_dir / "summary.json").read_text())
    assert summary["successful_queries"] == 1
    assert summary["failed_queries"] == 0
    assert summary["results"][0]["series_count"] == 1
    assert summary["results"][0]["sample_count"] == 2

    with (output_dir / "summary.csv").open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["metric"] == "vllm:mooncake_xfer_time_seconds_bucket"

    absolute_output_dir = Path(temp_dir) / "absolute-model"
    absolute_model_name = "/home/service/works/models_ssd/GLM-5.2-NVFP4-W4A4-MG39-BNT3/v1"
    absolute = subprocess.run(
        [
            str(script),
            "--action",
            "collect",
            "--prometheus-url",
            f"http://127.0.0.1:{server.server_port}",
            "--start",
            "2024-01-01T00:00:00Z",
            "--end",
            "2024-01-01T00:10:00Z",
            "--model-name",
            absolute_model_name,
            "--metric",
            "vllm:mooncake_xfer_time_seconds_bucket",
            "--output-dir",
            str(absolute_output_dir),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert absolute.returncode == 0, f"stdout={absolute.stdout}\nstderr={absolute.stderr}"
    absolute_query, _ = requests[-1]
    assert f'model_name="{absolute_model_name}"' in absolute_query
    assert f'model_name="{absolute_model_name}/v1"' not in absolute_query

    continuous_dir = Path(temp_dir) / "continuous"
    env = os.environ.copy()
    env.update(
        {
            "PROMETHEUS_URL": f"http://127.0.0.1:{server.server_port}",
            "METRICS_ACTION": "collect",
            "VLLM_METRICS_START": "2024-01-01T00:00:00Z",
            "VLLM_METRICS_STEP": "5s",
            "NAMESPACE": "xds-env",
            "ARCH_NAME": "model-env",
            "VLLM_METRICS_JOB_REGEX": ".*vllmp.*",
            "VLLM_METRICS_METRICS": "vllm:mooncake_xfer_time_seconds_bucket",
            "VLLM_METRICS_OUTPUT_DIR": str(continuous_dir),
            "VLLM_METRICS_MAX_ITERATIONS": "1",
        }
    )
    continuous = subprocess.run([str(script)], text=True, capture_output=True, check=False, env=env)
    assert continuous.returncode == 0, f"stdout={continuous.stdout}\nstderr={continuous.stderr}"
    snapshots = list((continuous_dir / "snapshots").glob("*/summary.json"))
    assert len(snapshots) == 1
    continuous_summary = json.loads(snapshots[0].read_text())
    assert continuous_summary["namespace"] == "xds-env"
    assert continuous_summary["model_name"] == "model-env"

    legacy_dir = Path(temp_dir) / "legacy-aliases"
    legacy_env = env.copy()
    legacy_env.pop("NAMESPACE", None)
    legacy_env.pop("ARCH_NAME", None)
    legacy_env.update(
        {
            "VLLM_METRICS_NAMESPACE": "legacy-namespace",
            "VLLM_METRICS_MODEL_NAME": "legacy-model",
            "VLLM_METRICS_OUTPUT_DIR": str(legacy_dir),
            "VLLM_METRICS_MAX_ITERATIONS": "1",
        }
    )
    legacy = subprocess.run([str(script)], text=True, capture_output=True, check=False, env=legacy_env)
    assert legacy.returncode == 0, f"stdout={legacy.stdout}\nstderr={legacy.stderr}"
    legacy_summary = json.loads(next((legacy_dir / "snapshots").glob("*/summary.json")).read_text())
    assert legacy_summary["namespace"] is None
    assert legacy_summary["model_name"] is None

    lifecycle_dir = Path(temp_dir) / "lifecycle"
    lifecycle_pid = lifecycle_dir / "collector.pid"
    lifecycle_env = env | {
        "METRICS_ACTION": "start",
        "METRICS_OUTPUT_DIR": str(lifecycle_dir),
        "METRICS_PID_FILE": str(lifecycle_pid),
        "VLLM_METRICS_MAX_ITERATIONS": "0",
    }
    started = subprocess.run([str(script)], text=True, capture_output=True, check=False, env=lifecycle_env)
    assert started.returncode == 0, f"stdout={started.stdout}\nstderr={started.stderr}"
    assert lifecycle_pid.is_file()
    deadline = time.monotonic() + 5
    while len(requests) < 3 and time.monotonic() < deadline:
        time.sleep(0.05)
    stopped = subprocess.run(
        [str(script)],
        text=True,
        capture_output=True,
        check=False,
        env=lifecycle_env | {"METRICS_ACTION": "stop"},
    )
    assert stopped.returncode == 0, f"stdout={stopped.stdout}\nstderr={stopped.stderr}"
    assert not lifecycle_pid.exists()

server.shutdown()
print("collect vLLM metrics test passed")
PY
