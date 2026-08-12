from __future__ import annotations

from typing import Any, Protocol, TypedDict

from op_test.deploy.params import DeployRequest, build_deploy_params


class DeploymentClient(Protocol):
    def submit_build(self, params: dict[str, str]) -> int: ...

    def get_queue_item(self, queue_id: int) -> dict[str, Any]: ...

    def get_build_info(self, build_number: int) -> dict[str, Any]: ...

    def get_stage_view(self, build_number: int) -> dict[str, Any]: ...

    def get_live_log_url(self, build_number: int) -> str: ...


class DeploymentOrchestratorLike(Protocol):
    def deploy_and_wait(
        self,
        request: DeployRequest,
        *,
        auto_uninstall_on_failure: bool = False,
    ) -> Any: ...


class DeploymentState(TypedDict, total=False):
    client: DeploymentClient
    orchestrator: DeploymentOrchestratorLike
    deploy_request: DeployRequest
    auto_uninstall_on_failure: bool
    queue_id: int
    build_number: int
    building: bool
    result: str | None
    build_info: dict[str, Any]
    stages: list[dict[str, Any]]
    live_log_url: str


def _require_client(state: DeploymentState) -> DeploymentClient:
    client = state.get("client")
    if client is None:
        raise ValueError("Deployment state requires a client")
    return client


def submit_deploy_node(state: DeploymentState) -> dict[str, int]:
    request = state.get("deploy_request")
    if request is None:
        raise ValueError("Deployment state requires a deploy_request")
    queue_id = _require_client(state).submit_build(build_deploy_params(request))
    return {"queue_id": queue_id}


def resolve_build_number_node(state: DeploymentState) -> dict[str, int]:
    queue_id = state.get("queue_id")
    if queue_id is None:
        raise ValueError("Deployment state requires a queue_id")
    item = _require_client(state).get_queue_item(queue_id)
    if item.get("cancelled"):
        raise RuntimeError(f"Queue item {queue_id} was cancelled")
    executable = item.get("executable")
    if not executable:
        return {}
    return {"build_number": executable["number"]}


def refresh_build_status_node(state: DeploymentState) -> dict[str, Any]:
    build_number = state.get("build_number")
    if build_number is None:
        raise ValueError("Deployment state requires a build_number")
    client = _require_client(state)
    stage_view = client.get_stage_view(build_number)
    return {
        "build_info": client.get_build_info(build_number),
        "stages": stage_view.get("stages", []),
        "live_log_url": client.get_live_log_url(build_number),
    }


def run_deploy_service_node(state: DeploymentState) -> dict[str, Any]:
    orchestrator = state.get("orchestrator")
    if orchestrator is None:
        raise ValueError("Deployment state requires an orchestrator")
    request = state.get("deploy_request")
    if request is None:
        raise ValueError("Deployment state requires a deploy_request")
    summary = orchestrator.deploy_and_wait(
        request,
        auto_uninstall_on_failure=state.get("auto_uninstall_on_failure", False),
    )
    data = summary.to_dict()
    return {
        "queue_id": data.get("queue_id"),
        "build_number": data.get("build_number"),
        "build_info": data.get("build_info", {}),
        "stages": data.get("stages", []),
        "live_log_url": data.get("live_log_url", ""),
        "result": data.get("result"),
        "building": data.get("building", False),
    }


def create_deploy_graph():
    from langgraph.graph import END, StateGraph

    graph = StateGraph(DeploymentState)
    graph.add_node("submit_deploy", submit_deploy_node)
    graph.add_node("resolve_build_number", resolve_build_number_node)
    graph.add_node("refresh_build_status", refresh_build_status_node)
    graph.set_entry_point("submit_deploy")
    graph.add_edge("submit_deploy", "resolve_build_number")
    graph.add_edge("resolve_build_number", "refresh_build_status")
    graph.add_edge("refresh_build_status", END)
    return graph.compile()


def create_deploy_service_graph():
    from langgraph.graph import END, StateGraph

    graph = StateGraph(DeploymentState)
    graph.add_node("run_deploy", run_deploy_service_node)
    graph.set_entry_point("run_deploy")
    graph.add_edge("run_deploy", END)
    return graph.compile()
