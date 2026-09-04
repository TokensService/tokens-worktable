#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/collect_vllm_metrics.py"

python3 - "$SCRIPT" <<'PY'
import csv
import http.server
import json
import subprocess
import sys
import tempfile
import threading
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
            "model-test",
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
    assert 'model_name="model-test"' in query
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

server.shutdown()
print("collect vLLM metrics test passed")
PY
