from __future__ import annotations

import pytest

from op_test.deploy.params import DeployRequest
from op_test.graph.deploy import (
    DeploymentState,
    refresh_build_status_node,
    resolve_build_number_node,
    run_deploy_service_node,
    submit_deploy_node,
)


class FakeClient:
    def __init__(self) -> None:
        self.submitted_params: dict[str, str] | None = None

    def submit_build(self, params: dict[str, str]) -> int:
        self.submitted_params = params
        return 99

    def get_queue_item(self, queue_id: int) -> dict:
        assert queue_id == 99
        return {"executable": {"number": 136}}

    def get_build_info(self, build_number: int) -> dict:
        assert build_number == 136
        return {"building": False, "result": "SUCCESS", "displayName": "#136"}

    def get_stage_view(self, build_number: int) -> dict:
        assert build_number == 136
        return {"stages": [{"name": "helm_deploy", "status": "SUCCESS", "durationMillis": 1000}]}

    def get_live_log_url(self, build_number: int) -> str:
        assert build_number == 136
        return "http://jenkins.local/live"


def test_submit_deploy_node_submits_params_and_records_queue_id():
    client = FakeClient()
    state: DeploymentState = {
        "client": client,
        "deploy_request": DeployRequest(
            executor="agent-api",
            deploy_node_ips="192.168.0.78",
            arch_name="1p1d",
            model_path="/data/models/model",
        ),
    }

    updates = submit_deploy_node(state)

    assert updates == {"queue_id": 99}
    assert client.submitted_params is not None
    assert client.submitted_params["ACTION"] == "deploy"
    assert client.submitted_params["DEPLOY_NODE_IPS"] == "192.168.0.78"


def test_resolve_build_number_node_records_executable_number():
    state: DeploymentState = {"client": FakeClient(), "queue_id": 99}

    assert resolve_build_number_node(state) == {"build_number": 136}


def test_resolve_build_number_node_raises_when_queue_cancelled():
    class CancelledClient(FakeClient):
        def get_queue_item(self, queue_id: int) -> dict:
            return {"cancelled": True}

    with pytest.raises(RuntimeError, match="Queue item 99 was cancelled"):
        resolve_build_number_node({"client": CancelledClient(), "queue_id": 99})


def test_refresh_build_status_node_records_info_stages_and_live_log_url():
    updates = refresh_build_status_node({"client": FakeClient(), "build_number": 136})

    assert updates == {
        "build_info": {"building": False, "result": "SUCCESS", "displayName": "#136"},
        "stages": [{"name": "helm_deploy", "status": "SUCCESS", "durationMillis": 1000}],
        "live_log_url": "http://jenkins.local/live",
    }


def test_run_deploy_service_node_records_completed_summary():
    class FakeOrchestrator:
        def deploy_and_wait(self, request, *, auto_uninstall_on_failure=False):
            assert request.executor == "agent-api"
            assert auto_uninstall_on_failure is True

            class Summary:
                def to_dict(self):
                    return {
                        "queue_id": 99,
                        "build_number": 136,
                        "building": False,
                        "result": "SUCCESS",
                        "live_log_url": "http://jenkins/live",
                        "build_info": {},
                        "stages": [],
                    }

            return Summary()

    updates = run_deploy_service_node(
        {
            "orchestrator": FakeOrchestrator(),
            "deploy_request": DeployRequest(executor="agent-api"),
            "auto_uninstall_on_failure": True,
        }
    )

    assert updates == {
        "queue_id": 99,
        "build_number": 136,
        "build_info": {},
        "stages": [],
        "live_log_url": "http://jenkins/live",
        "result": "SUCCESS",
        "building": False,
    }
