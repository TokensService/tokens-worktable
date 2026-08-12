from __future__ import annotations

from pathlib import Path
from typing import Callable

from fastapi import Depends, FastAPI
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel

from op_test.deploy import DeployRequest, UninstallRequest
from op_test.jenkins import JenkinsClient
from op_test.service import DeploymentOrchestrator


class DeployPayload(BaseModel):
    executor: str
    deploy_node_ips: str = ""
    arch_name: str = ""
    arch_content: str = ""
    model_path: str = ""
    image: str = ""
    code_branch: str = ""
    auto_uninstall_on_failure: bool = False


class UninstallPayload(BaseModel):
    build_number: int
    executor: str = "agent-api"


def default_orchestrator_factory() -> DeploymentOrchestrator:
    return DeploymentOrchestrator(JenkinsClient())


def create_app(
    orchestrator_factory: Callable[[], DeploymentOrchestrator] | None = None,
) -> FastAPI:
    factory = orchestrator_factory or default_orchestrator_factory
    app = FastAPI(title="op_test deployment")
    static_dir = Path(__file__).resolve().parents[1] / "web" / "static"

    async def get_orchestrator() -> DeploymentOrchestrator:
        return factory()

    @app.get("/")
    async def index():
        return HTMLResponse((static_dir / "index.html").read_text(encoding="utf-8"))

    @app.get("/deploy")
    async def deploy_page():
        return HTMLResponse((static_dir / "deploy.html").read_text(encoding="utf-8"))

    @app.get("/static/{asset_name}")
    async def static_asset(asset_name: str):
        allowed_types = {
            "app.js": "application/javascript; charset=utf-8",
            "styles.css": "text/css; charset=utf-8",
        }
        if asset_name not in allowed_types:
            return Response(status_code=404)
        return Response(
            (static_dir / asset_name).read_text(encoding="utf-8"),
            media_type=allowed_types[asset_name],
        )

    @app.get("/api/gpu")
    async def get_gpu(
        required_gpus: int = 0,
        orchestrator: DeploymentOrchestrator = Depends(get_orchestrator),
    ):
        status = orchestrator.get_gpu_status()
        if required_gpus > 0:
            status = dict(status)
            status["selected_node_ips"] = orchestrator.select_gpu_nodes(required_gpus)
        return status

    @app.post("/api/deploy")
    async def deploy(
        payload: DeployPayload,
        orchestrator: DeploymentOrchestrator = Depends(get_orchestrator),
    ):
        summary = orchestrator.deploy_and_wait(
            DeployRequest(
                executor=payload.executor,
                deploy_node_ips=payload.deploy_node_ips,
                arch_name=payload.arch_name,
                arch_content=payload.arch_content,
                model_path=payload.model_path,
                image=payload.image,
                code_branch=payload.code_branch,
            ),
            auto_uninstall_on_failure=payload.auto_uninstall_on_failure,
        )
        return summary.to_dict()

    @app.post("/api/uninstall")
    async def uninstall(
        payload: UninstallPayload,
        orchestrator: DeploymentOrchestrator = Depends(get_orchestrator),
    ):
        return orchestrator.uninstall_and_wait(
            UninstallRequest(build_number=payload.build_number, executor=payload.executor)
        ).to_dict()

    @app.get("/api/builds/{build_number}")
    async def get_build(
        build_number: int,
        orchestrator: DeploymentOrchestrator = Depends(get_orchestrator),
    ):
        return orchestrator.get_status(build_number).to_dict()

    @app.get("/api/builds/{build_number}/logs")
    async def get_logs(
        build_number: int,
        offset: int = 0,
        orchestrator: DeploymentOrchestrator = Depends(get_orchestrator),
    ):
        return orchestrator.get_logs(build_number, offset)

    return app
