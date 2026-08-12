# op_test

自动化测试工具。当前第一阶段实现 Jenkins 驱动的模型环境部署能力，后续 profiling 阶段可以接在 LangGraph 部署节点之后。

## 安装

```bash
pip install -e ".[test]"
```

## Jenkins 配置

默认值来自现有内部 Jenkins：

| 环境变量 | 默认值 |
| --- | --- |
| `OP_TEST_JENKINS_URL` | `http://10.112.32.240:28080` |
| `OP_TEST_JENKINS_JOB_NAME` | `xds-local-deploy` |
| `OP_TEST_JENKINS_TIMEOUT` | `30.0` |

## 提交部署

```python
from op_test.deploy import DeployRequest, build_deploy_params
from op_test.jenkins import JenkinsClient, JenkinsConfig

request = DeployRequest(
    executor="agent-api",
    deploy_node_ips="192.168.0.78",
    arch_name="1p1d",
    arch_content='{"prefill": {"resources": {"gpu": 4}}, "decode": {"resources": {"gpu": 4}}}',
    model_path="/data/models/GLM-5.2-NVFP4",
)

with JenkinsClient(JenkinsConfig.from_env()) as client:
    queue_id = client.submit_build(build_deploy_params(request))
    print(queue_id)
```

## 提交卸载

```python
from op_test.deploy import UninstallRequest, build_uninstall_params
from op_test.jenkins import JenkinsClient

with JenkinsClient() as client:
    queue_id = client.submit_build(
        build_uninstall_params(UninstallRequest(build_number=136, executor="agent-api"))
    )
    print(queue_id)
```

## LangGraph 部署图

```python
from op_test.deploy import DeployRequest
from op_test.graph.deploy import create_deploy_graph
from op_test.jenkins import JenkinsClient

graph = create_deploy_graph()

with JenkinsClient() as client:
    result = graph.invoke({
        "client": client,
        "deploy_request": DeployRequest(
            executor="agent-api",
            deploy_node_ips="192.168.0.78",
            arch_name="1p1d",
            model_path="/data/models/GLM-5.2-NVFP4",
        ),
    })

print(result["queue_id"], result.get("build_number"), result.get("live_log_url"))
```

## GPU 状态

```python
from op_test.jenkins import JenkinsClient

with JenkinsClient() as client:
    print(client.get_node_gpu_status())
```

## CLI

```bash
op-test gpu --required-gpus 4

op-test deploy \
  --executor agent-api \
  --node-ips 192.168.0.78 \
  --arch-name 1p1d \
  --model-path /data/models/GLM-5.2-NVFP4 \
  --auto-uninstall-on-failure

op-test status 136
op-test logs 136 --offset 0
op-test uninstall 136 --executor agent-api
```

所有 CLI 命令默认输出 JSON。

## Web 界面

启动本地服务：

```bash
op-test serve --host 127.0.0.1 --port 8000
```

然后访问 `http://127.0.0.1:8000/`。页面包含部署表单、GPU 节点状态、构建状态、阶段视图、增量日志和卸载按钮。

## REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/gpu?required_gpus=4` | 查询 GPU 状态并可返回候选节点 |
| `POST` | `/api/deploy` | 提交部署并等待构建完成 |
| `POST` | `/api/uninstall` | 提交卸载并等待构建完成 |
| `GET` | `/api/builds/{build_number}` | 查询构建状态和阶段 |
| `GET` | `/api/builds/{build_number}/logs?offset=0` | 获取增量日志 |
