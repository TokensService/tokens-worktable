from __future__ import annotations

from op_test.deploy import DeployRequest, UninstallRequest
from op_test.service.orchestrator import DeploymentOrchestrator


class ScriptedJenkinsClient:
    def __init__(self) -> None:
        self.submitted: list[dict[str, str]] = []
        self.queue_calls = 0
        self.build_calls = 0

    def submit_build(self, params: dict[str, str]) -> int:
        self.submitted.append(params)
        return 10 + len(self.submitted)

    def get_queue_item(self, queue_id: int) -> dict:
        self.queue_calls += 1
        if self.queue_calls == 1:
            return {"executable": None}
        return {"executable": {"number": 136}}

    def get_build_info(self, build_number: int) -> dict:
        self.build_calls += 1
        if self.build_calls == 1:
            return {"building": True, "result": None, "displayName": f"#{build_number}"}
        return {"building": False, "result": "SUCCESS", "displayName": f"#{build_number}"}

    def get_stage_view(self, build_number: int) -> dict:
        return {"stages": [{"name": "helm_deploy", "status": "SUCCESS", "durationMillis": 1000}]}

    def get_progressive_log(self, build_number: int, offset: int = 0) -> tuple[str, int, bool]:
        return ("log chunk", offset + 9, False)

    def get_node_gpu_status(self) -> dict:
        return {
            "nodes": {
                "192.168.0.78": {"gpu_total": 8, "gpu_free": 4, "status": "ok"},
                "192.168.0.102": {"gpu_total": 8, "gpu_free": 1, "status": "busy"},
            }
        }

    def get_live_log_url(self, build_number: int) -> str:
        return f"http://jenkins/live/{build_number}"


def test_deploy_and_wait_returns_completed_summary():
    client = ScriptedJenkinsClient()
    orchestrator = DeploymentOrchestrator(client, poll_interval=0)

    summary = orchestrator.deploy_and_wait(
        DeployRequest(
            executor="agent-api",
            deploy_node_ips="192.168.0.78",
            arch_name="1p1d",
            model_path="/models/model",
        )
    )

    assert summary.queue_id == 11
    assert summary.build_number == 136
    assert summary.result == "SUCCESS"
    assert summary.live_log_url == "http://jenkins/live/136"
    assert summary.stages == [{"name": "helm_deploy", "status": "SUCCESS", "durationMillis": 1000}]
    assert client.submitted[0]["ACTION"] == "deploy"


def test_select_gpu_nodes_returns_enough_free_nodes_in_order():
    orchestrator = DeploymentOrchestrator(ScriptedJenkinsClient(), poll_interval=0)

    assert orchestrator.select_gpu_nodes(required_gpus=2) == ["192.168.0.78"]


def test_get_logs_returns_next_offset_and_text():
    orchestrator = DeploymentOrchestrator(ScriptedJenkinsClient(), poll_interval=0)

    assert orchestrator.get_logs(136, offset=4) == {
        "text": "log chunk",
        "next_offset": 13,
        "has_more": False,
    }


def test_failed_deploy_auto_uninstalls_source_build():
    class FailingClient(ScriptedJenkinsClient):
        def get_build_info(self, build_number: int) -> dict:
            return {"building": False, "result": "FAILURE", "displayName": f"#{build_number}"}

    client = FailingClient()
    orchestrator = DeploymentOrchestrator(client, poll_interval=0)

    summary = orchestrator.deploy_and_wait(
        DeployRequest(executor="agent-api", deploy_node_ips="192.168.0.78"),
        auto_uninstall_on_failure=True,
    )

    assert summary.result == "FAILURE"
    assert len(client.submitted) == 2
    assert client.submitted[1] == {
        "ACTION": "uninstall",
        "EXECUTOR": "auto-uninstall",
        "PIPELINE_STEPS": "uninstall",
        "UNINSTALL_SOURCE_BUILD_TAG": "jenkins-xds-local-deploy-136",
        "UNINSTALL_SOURCE_BUILD_NUMBER": "136",
    }


def test_submit_uninstall_uses_uninstall_params():
    client = ScriptedJenkinsClient()
    orchestrator = DeploymentOrchestrator(client, poll_interval=0)

    queue_id = orchestrator.submit_uninstall(UninstallRequest(build_number=136, executor="agent-api"))

    assert queue_id == 11
    assert client.submitted[0]["ACTION"] == "uninstall"
    assert client.submitted[0]["UNINSTALL_SOURCE_BUILD_NUMBER"] == "136"
