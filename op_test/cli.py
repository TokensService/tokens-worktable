from __future__ import annotations

import argparse
import json
from typing import Callable

from op_test.deploy import DeployRequest, UninstallRequest
from op_test.jenkins import JenkinsClient
from op_test.service import DeploymentOrchestrator


def default_orchestrator_factory() -> DeploymentOrchestrator:
    return DeploymentOrchestrator(JenkinsClient())


def main(
    argv: list[str] | None = None,
    *,
    orchestrator_factory: Callable[[], DeploymentOrchestrator] = default_orchestrator_factory,
) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "serve":
        import uvicorn

        uvicorn.run("op_test.api.app:create_app", factory=True, host=args.host, port=args.port)
        return 0

    orchestrator = orchestrator_factory()
    payload = run_command(args, orchestrator)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="op-test")
    subparsers = parser.add_subparsers(dest="command", required=True)

    deploy = subparsers.add_parser("deploy")
    deploy.add_argument("--executor", required=True)
    deploy.add_argument("--node-ips", default="")
    deploy.add_argument("--arch-name", default="")
    deploy.add_argument("--arch-content", default="")
    deploy.add_argument("--model-path", default="")
    deploy.add_argument("--image", default="")
    deploy.add_argument("--code-branch", default="")
    deploy.add_argument("--auto-uninstall-on-failure", action="store_true")

    uninstall = subparsers.add_parser("uninstall")
    uninstall.add_argument("build_number", type=int)
    uninstall.add_argument("--executor", default="agent-api")

    status = subparsers.add_parser("status")
    status.add_argument("build_number", type=int)

    logs = subparsers.add_parser("logs")
    logs.add_argument("build_number", type=int)
    logs.add_argument("--offset", type=int, default=0)

    gpu = subparsers.add_parser("gpu")
    gpu.add_argument("--required-gpus", type=int, default=0)

    serve = subparsers.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    return parser


def run_command(args: argparse.Namespace, orchestrator: DeploymentOrchestrator) -> dict:
    if args.command == "deploy":
        summary = orchestrator.deploy_and_wait(
            DeployRequest(
                executor=args.executor,
                deploy_node_ips=args.node_ips,
                arch_name=args.arch_name,
                arch_content=args.arch_content,
                model_path=args.model_path,
                image=args.image,
                code_branch=args.code_branch,
            ),
            auto_uninstall_on_failure=args.auto_uninstall_on_failure,
        )
        return summary.to_dict()
    if args.command == "uninstall":
        return orchestrator.uninstall_and_wait(
            UninstallRequest(build_number=args.build_number, executor=args.executor)
        ).to_dict()
    if args.command == "status":
        return orchestrator.get_status(args.build_number).to_dict()
    if args.command == "logs":
        return orchestrator.get_logs(args.build_number, args.offset)
    if args.command == "gpu":
        status = orchestrator.get_gpu_status()
        if args.required_gpus > 0:
            status = dict(status)
            status["selected_node_ips"] = orchestrator.select_gpu_nodes(args.required_gpus)
        return status
    raise ValueError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
