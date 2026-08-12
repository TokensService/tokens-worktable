from __future__ import annotations

import json

from op_test.cli import main
from op_test.service.orchestrator import BuildSummary


class FakeOrchestrator:
    def deploy_and_wait(self, request, *, auto_uninstall_on_failure=False):
        assert request.executor == "agent-api"
        assert request.deploy_node_ips == "192.168.0.78"
        assert auto_uninstall_on_failure is True
        return BuildSummary(queue_id=11, build_number=136, building=False, result="SUCCESS")

    def uninstall_and_wait(self, request):
        assert request.build_number == 136
        return BuildSummary(queue_id=12, build_number=137, building=False, result="SUCCESS")

    def get_status(self, build_number):
        assert build_number == 136
        return BuildSummary(queue_id=None, build_number=136, building=False, result="SUCCESS")

    def get_logs(self, build_number, offset=0):
        return {"text": "logs", "next_offset": 4, "has_more": False}

    def get_gpu_status(self):
        return {"nodes": {"192.168.0.78": {"gpu_free": 4}}}

    def select_gpu_nodes(self, required_gpus):
        return ["192.168.0.78"]


def factory():
    return FakeOrchestrator()


def test_cli_deploy_prints_json_summary(capsys):
    code = main(
        [
            "deploy",
            "--executor",
            "agent-api",
            "--node-ips",
            "192.168.0.78",
            "--auto-uninstall-on-failure",
        ],
        orchestrator_factory=factory,
    )

    assert code == 0
    assert json.loads(capsys.readouterr().out) == {
        "queue_id": 11,
        "build_number": 136,
        "building": False,
        "result": "SUCCESS",
        "live_log_url": "",
        "build_info": {},
        "stages": [],
    }


def test_cli_gpu_can_select_nodes(capsys):
    code = main(["gpu", "--required-gpus", "2"], orchestrator_factory=factory)

    assert code == 0
    assert json.loads(capsys.readouterr().out)["selected_node_ips"] == ["192.168.0.78"]
