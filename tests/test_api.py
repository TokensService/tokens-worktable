from __future__ import annotations

import httpx
import pytest

from op_test.api.app import create_app
from op_test.service.orchestrator import BuildSummary


class FakeOrchestrator:
    def deploy_and_wait(self, request, *, auto_uninstall_on_failure=False):
        return BuildSummary(
            queue_id=11,
            build_number=136,
            building=False,
            result="SUCCESS",
            live_log_url="http://jenkins/live/136",
        )

    def uninstall_and_wait(self, request):
        return BuildSummary(queue_id=12, build_number=137, building=False, result="SUCCESS")

    def get_status(self, build_number):
        return BuildSummary(queue_id=None, build_number=build_number, building=True, result=None)

    def get_logs(self, build_number, offset=0):
        return {"text": f"log-{build_number}-{offset}", "next_offset": offset + 5, "has_more": True}

    def get_gpu_status(self):
        return {"nodes": {"192.168.0.78": {"gpu_free": 4, "gpu_total": 8, "status": "ok"}}}

    def select_gpu_nodes(self, required_gpus):
        return ["192.168.0.78"]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def make_async_client():
    app = create_app(orchestrator_factory=lambda: FakeOrchestrator())
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


@pytest.mark.anyio
async def test_api_deploy_returns_summary():
    async with make_async_client() as client:
        response = await client.post(
            "/api/deploy",
            json={
                "executor": "agent-api",
                "deploy_node_ips": "192.168.0.78",
                "auto_uninstall_on_failure": True,
            },
        )

    assert response.status_code == 200
    assert response.json()["build_number"] == 136
    assert response.json()["result"] == "SUCCESS"


@pytest.mark.anyio
async def test_api_status_logs_gpu_and_root_page():
    async with make_async_client() as client:
        status = await client.get("/api/builds/136")
        log_response = await client.get("/api/builds/136/logs", params={"offset": 2})
        gpu_response = await client.get("/api/gpu", params={"required_gpus": 2})
        root = await client.get("/")
        deploy_page = await client.get("/deploy")
        app_js = await client.get("/static/app.js")

    assert status.json()["building"] is True
    assert log_response.json() == {"text": "log-136-2", "next_offset": 7, "has_more": True}
    assert gpu_response.json()["selected_node_ips"] == ["192.168.0.78"]
    assert root.status_code == 200
    assert "Profiling 优化流程" in root.text
    assert 'id="deployForm"' not in root.text
    assert deploy_page.status_code == 200
    assert "Jenkins 部署模块" in deploy_page.text
    assert 'id="deployForm"' in deploy_page.text
    assert app_js.status_code == 200


@pytest.mark.anyio
async def test_api_uninstall_returns_summary():
    async with make_async_client() as client:
        response = await client.post(
            "/api/uninstall",
            json={"build_number": 136, "executor": "agent-api"},
        )

    assert response.status_code == 200
    assert response.json()["queue_id"] == 12
    assert response.json()["build_number"] == 137
