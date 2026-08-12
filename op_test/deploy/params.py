from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DeployRequest:
    executor: str
    action: str = "deploy"
    pipeline_steps: str = "true," * 16
    deploy_node_ips: str = ""
    arch_name: str = ""
    arch_content: str = ""
    model_path: str = ""
    image: str = ""
    code_branch: str = ""


@dataclass(frozen=True)
class UninstallRequest:
    build_number: int
    executor: str = "agent"
    job_name: str = "xds-local-deploy"


def build_deploy_params(request: DeployRequest) -> dict[str, str]:
    if request.action not in {"deploy", "check"}:
        raise ValueError("DeployRequest.action must be 'deploy' or 'check'")

    params = {
        "ACTION": request.action,
        "EXECUTOR": request.executor,
        "PIPELINE_STEPS": request.pipeline_steps,
    }
    if request.action in {"deploy", "check"}:
        params["ARCH_NAME"] = request.arch_name
        params["MODEL_PATH"] = request.model_path
        if request.arch_content:
            params["ARCH_CONTENT"] = request.arch_content
    if request.action == "deploy":
        ips = ",".join(part.strip() for part in request.deploy_node_ips.split(",") if part.strip())
        params["DEPLOY_NODE_IPS"] = ips
    if request.image:
        params["IMAGE"] = request.image
    if request.code_branch:
        params["CODE_BRANCH"] = request.code_branch
    return params


def build_uninstall_params(request: UninstallRequest) -> dict[str, str]:
    build_tag = f"jenkins-{request.job_name}-{request.build_number}"
    return {
        "ACTION": "uninstall",
        "EXECUTOR": request.executor,
        "PIPELINE_STEPS": "uninstall",
        "UNINSTALL_SOURCE_BUILD_TAG": build_tag,
        "UNINSTALL_SOURCE_BUILD_NUMBER": str(request.build_number),
    }
