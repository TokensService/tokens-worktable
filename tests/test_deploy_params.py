from op_test.deploy.params import (
    DeployRequest,
    UninstallRequest,
    build_deploy_params,
    build_uninstall_params,
)


def test_deploy_params_normalize_ips_and_include_deploy_fields():
    request = DeployRequest(
        executor="agent-api",
        deploy_node_ips=" 192.168.0.78, ,192.168.0.102 ",
        arch_name="1p1d",
        arch_content='{"prefill": {"resources": {"gpu": 4}}}',
        model_path="/data/models/GLM-5.2-NVFP4",
        image="registry.local/xds:latest",
        code_branch="main",
    )

    params = build_deploy_params(request)

    assert params == {
        "ACTION": "deploy",
        "EXECUTOR": "agent-api",
        "PIPELINE_STEPS": "true," * 16,
        "ARCH_NAME": "1p1d",
        "ARCH_CONTENT": '{"prefill": {"resources": {"gpu": 4}}}',
        "MODEL_PATH": "/data/models/GLM-5.2-NVFP4",
        "DEPLOY_NODE_IPS": "192.168.0.78,192.168.0.102",
        "IMAGE": "registry.local/xds:latest",
        "CODE_BRANCH": "main",
    }


def test_check_params_do_not_include_deploy_node_ips():
    request = DeployRequest(
        action="check",
        executor="agent-api",
        deploy_node_ips="192.168.0.78",
        arch_name="1p1d",
        model_path="/data/models/model",
    )

    params = build_deploy_params(request)

    assert params["ACTION"] == "check"
    assert params["ARCH_NAME"] == "1p1d"
    assert params["MODEL_PATH"] == "/data/models/model"
    assert "DEPLOY_NODE_IPS" not in params


def test_uninstall_params_include_source_build_identity():
    request = UninstallRequest(build_number=136, executor="cleanup-agent")

    params = build_uninstall_params(request)

    assert params == {
        "ACTION": "uninstall",
        "EXECUTOR": "cleanup-agent",
        "PIPELINE_STEPS": "uninstall",
        "UNINSTALL_SOURCE_BUILD_TAG": "jenkins-xds-local-deploy-136",
        "UNINSTALL_SOURCE_BUILD_NUMBER": "136",
    }
