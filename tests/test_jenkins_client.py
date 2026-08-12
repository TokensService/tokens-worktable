from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx

from op_test.jenkins.client import JenkinsClient, JenkinsConfig


def make_client(handler):
    http = httpx.Client(
        base_url="http://jenkins.local",
        auth=("user", "pass"),
        follow_redirects=True,
        transport=httpx.MockTransport(handler),
    )
    return JenkinsClient(
        JenkinsConfig(
            url="http://jenkins.local",
            user="user",
            password="pass",
            job_name="deploy-job",
        ),
        http_client=http,
    )


def test_submit_build_fetches_crumb_retries_403_and_returns_queue_id():
    calls: list[tuple[str, str, str | None]] = []
    post_attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal post_attempts
        calls.append((request.method, request.url.path, request.headers.get("Jenkins-Crumb")))
        if request.url.path == "/crumbIssuer/api/json":
            return httpx.Response(
                200,
                json={"crumbRequestField": "Jenkins-Crumb", "crumb": f"crumb-{len(calls)}"},
            )
        if request.url.path == "/job/deploy-job/buildWithParameters":
            post_attempts += 1
            form = parse_qs(request.content.decode())
            assert form["ACTION"] == ["deploy"]
            if post_attempts == 1:
                return httpx.Response(403)
            return httpx.Response(
                201,
                headers={"Location": "http://jenkins.local/queue/item/12345/"},
            )
        return httpx.Response(404)

    with make_client(handler) as client:
        queue_id = client.submit_build({"ACTION": "deploy"})

    assert queue_id == 12345
    assert calls == [
        ("GET", "/crumbIssuer/api/json", None),
        ("POST", "/job/deploy-job/buildWithParameters", "crumb-1"),
        ("GET", "/crumbIssuer/api/json", None),
        ("POST", "/job/deploy-job/buildWithParameters", "crumb-3"),
    ]


def test_get_build_info_requests_expected_tree():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/job/deploy-job/136/api/json"
        assert "building,result,displayName" in request.url.params["tree"]
        return httpx.Response(200, json={"building": False, "result": "SUCCESS"})

    with make_client(handler) as client:
        assert client.get_build_info(136) == {"building": False, "result": "SUCCESS"}


def test_progressive_log_returns_text_next_offset_and_more_flag():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/job/deploy-job/136/logText/progressiveText"
        assert request.url.params["start"] == "10"
        return httpx.Response(
            200,
            text="new log",
            headers={"X-Text-Size": "42", "X-More-Data": "true"},
        )

    with make_client(handler) as client:
        assert client.get_progressive_log(136, 10) == ("new log", 42, True)


def test_get_live_log_url_uses_build_tag():
    with make_client(lambda request: httpx.Response(500)) as client:
        assert (
            client.get_live_log_url(136)
            == "http://jenkins.local/userContent/xds-live-logs/jenkins-deploy-job-136/index.html"
        )


def test_get_node_gpu_status_returns_json():
    payload = {"nodes": {"192.168.0.78": {"gpu_free": 4}}}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/userContent/xds-node-gpu-status/status.json"
        return httpx.Response(200, content=json.dumps(payload).encode())

    with make_client(handler) as client:
        assert client.get_node_gpu_status() == payload
