from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol

from op_test.deploy import (
    DeployRequest,
    UninstallRequest,
    build_deploy_params,
    build_uninstall_params,
)


class JenkinsLikeClient(Protocol):
    def submit_build(self, params: dict[str, str]) -> int: ...

    def get_queue_item(self, queue_id: int) -> dict[str, Any]: ...

    def get_build_info(self, build_number: int) -> dict[str, Any]: ...

    def get_stage_view(self, build_number: int) -> dict[str, Any]: ...

    def get_progressive_log(self, build_number: int, offset: int = 0) -> tuple[str, int, bool]: ...

    def get_node_gpu_status(self) -> dict[str, Any]: ...

    def get_live_log_url(self, build_number: int) -> str: ...


@dataclass(frozen=True)
class BuildSummary:
    queue_id: int | None
    build_number: int | None
    building: bool
    result: str | None
    live_log_url: str = ""
    build_info: dict[str, Any] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class DeploymentOrchestrator:
    def __init__(
        self,
        client: JenkinsLikeClient,
        *,
        poll_interval: float = 5.0,
        queue_timeout: float = 300.0,
        build_timeout: float = 3600.0,
    ) -> None:
        self._client = client
        self._poll_interval = poll_interval
        self._queue_timeout = queue_timeout
        self._build_timeout = build_timeout

    def submit_deploy(self, request: DeployRequest) -> int:
        return self._client.submit_build(build_deploy_params(request))

    def submit_uninstall(self, request: UninstallRequest) -> int:
        return self._client.submit_build(build_uninstall_params(request))

    def wait_for_build_number(self, queue_id: int, *, timeout: float | None = None) -> int:
        deadline = time.monotonic() + (self._queue_timeout if timeout is None else timeout)
        while True:
            item = self._client.get_queue_item(queue_id)
            if item.get("cancelled"):
                raise RuntimeError(f"Queue item {queue_id} was cancelled")
            executable = item.get("executable")
            if executable:
                return int(executable["number"])
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Build never started for queue {queue_id}")
            time.sleep(self._poll_interval)

    def wait_for_completion(self, build_number: int, *, timeout: float | None = None) -> BuildSummary:
        deadline = time.monotonic() + (self._build_timeout if timeout is None else timeout)
        last_info: dict[str, Any] = {}
        while True:
            last_info = self._client.get_build_info(build_number)
            if not last_info.get("building", False):
                return self._build_summary(None, build_number, last_info)
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Build {build_number} did not finish before timeout")
            time.sleep(self._poll_interval)

    def deploy_and_wait(
        self,
        request: DeployRequest,
        *,
        auto_uninstall_on_failure: bool = False,
    ) -> BuildSummary:
        queue_id = self.submit_deploy(request)
        build_number = self.wait_for_build_number(queue_id)
        summary = self.wait_for_completion(build_number)
        summary = BuildSummary(
            queue_id=queue_id,
            build_number=summary.build_number,
            building=summary.building,
            result=summary.result,
            live_log_url=summary.live_log_url,
            build_info=summary.build_info,
            stages=summary.stages,
        )
        if auto_uninstall_on_failure and summary.result in {"FAILURE", "ABORTED"}:
            self.submit_uninstall(
                UninstallRequest(build_number=build_number, executor="auto-uninstall")
            )
        return summary

    def uninstall_and_wait(self, request: UninstallRequest) -> BuildSummary:
        queue_id = self.submit_uninstall(request)
        build_number = self.wait_for_build_number(queue_id)
        summary = self.wait_for_completion(build_number)
        return BuildSummary(
            queue_id=queue_id,
            build_number=summary.build_number,
            building=summary.building,
            result=summary.result,
            live_log_url=summary.live_log_url,
            build_info=summary.build_info,
            stages=summary.stages,
        )

    def get_status(self, build_number: int) -> BuildSummary:
        return self._build_summary(None, build_number, self._client.get_build_info(build_number))

    def get_logs(self, build_number: int, offset: int = 0) -> dict[str, Any]:
        text, next_offset, has_more = self._client.get_progressive_log(build_number, offset)
        return {"text": text, "next_offset": next_offset, "has_more": has_more}

    def get_gpu_status(self) -> dict[str, Any]:
        return self._client.get_node_gpu_status()

    def select_gpu_nodes(self, required_gpus: int) -> list[str]:
        status = self.get_gpu_status()
        nodes = status.get("nodes", {})
        candidates: list[tuple[str, int]] = []
        for ip, info in nodes.items():
            free = int(info.get("gpu_free", 0))
            if free >= required_gpus and info.get("status") != "error":
                candidates.append((ip, free))
        candidates.sort(key=lambda item: item[1], reverse=True)
        return [ip for ip, _ in candidates]

    def _build_summary(
        self,
        queue_id: int | None,
        build_number: int,
        build_info: dict[str, Any],
    ) -> BuildSummary:
        stage_view = self._client.get_stage_view(build_number)
        return BuildSummary(
            queue_id=queue_id,
            build_number=build_number,
            building=bool(build_info.get("building", False)),
            result=build_info.get("result"),
            live_log_url=self._client.get_live_log_url(build_number),
            build_info=build_info,
            stages=stage_view.get("stages", []),
        )
