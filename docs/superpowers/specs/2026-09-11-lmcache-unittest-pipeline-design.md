# LMCache 单元测试流水线设计

## 目标

为已经人工制备完成的 `lmcache-vllm-openai-0.5.4-unitest` 镜像提供三阶段、可重试的 `nerdctl` 流水线：拉取镜像、克隆新代码并重新编译 LMCache、在同一 GPU 容器中执行 pytest。

## 范围与非目标

- 范围：在 `worktable/pipeline/scripts/` 增加三个 Bash 脚本及其静态契约测试。
- 范围：支持 NVIDIA GPU、宿主机 `/dev/shm`、GitCode 仓库、可选本地 HTTP(S) 代理。
- 非目标：制备或提交基础镜像；该镜像由操作者一次性人工创建。
- 非目标：消除由不支持的硬件、可选服务或缺失插件引起的 pytest skip。

## 三阶段

1. `lmcache-unittest-pull-image.sh` 拉取 `LMCACHE_UNITTEST_IMAGE`，创建一轮专属运行目录并写入非敏感状态。
2. `lmcache-unittest-rebuild.sh` 在宿主机通过代理克隆 `LMCACHE_UNITTEST_GIT_URL` 与分支，启动或复用容器，挂载源码和运行目录，容器内用 CUDA 参数重新 editable 安装 LMCache，并验证 `lmcache.cuda_ops`。
3. `lmcache-unittest-run-tests.sh` 复用相同容器与源码，以 `pytest -q -ra` 运行测试，将完整日志存入运行目录，并输出结果变量。

## 状态与变量契约

每轮使用 `LMCACHE_UNITTEST_RUN_DIR`，默认位于 `/tmp/lmcache-unittest/<时间戳>`。其中的 `state.env` 仅存储镜像、容器名、仓库目录、日志目录和构建状态；不写入 Git 凭据、代理地址或密码。

每一阶段读取调用者显式环境变量，并在存在时加载同一 `state.env`。阶段结束向 stdout 输出安全的 `KEY=VALUE`：

- `LMCACHE_UNITTEST_RUN_DIR`
- `LMCACHE_UNITTEST_IMAGE`
- `LMCACHE_UNITTEST_CONTAINER`
- `LMCACHE_UNITTEST_REPO_DIR`
- `LMCACHE_UNITTEST_BUILD_LOG`
- `LMCACHE_UNITTEST_TEST_LOG`
- `LMCACHE_UNITTEST_TEST_RESULT`

`LMCACHE_UNITTEST_HTTP_PROXY` 允许指定代理，默认 `http://127.0.0.1:8889`；该值只传给 Git/容器命令，不写入状态文件或 stdout。`NO_PROXY` 和 `no_proxy` 固定包含 `localhost,127.0.0.1`。

## 容器生命周期

重编译阶段以唯一的 `LMCACHE_UNITTEST_CONTAINER` 名称启动后台容器。测试阶段使用 `nerdctl exec`，确保编译产物与 pytest 使用同一环境。测试成功时默认删除容器但保留运行目录和日志；失败时保留容器和目录。`LMCACHE_UNITTEST_KEEP_CONTAINER=1` 保留成功容器，`LMCACHE_UNITTEST_CLEANUP=1` 在成功后删除运行目录。

## GPU 与构建

默认容器 GPU 参数为 `--gpus all`，允许以 `LMCACHE_NERDCTL_GPU_ARGS` 覆盖。构建阶段默认使用：

```bash
BUILD_WITH_CUDA=1
LMCACHE_CUDA_MAJOR=13
TORCH_CUDA_ARCH_LIST=9.0;10.0+PTX
ENABLE_CXX11_ABI=1
MAX_JOBS=8
```

所有值均允许以对应 `LMCACHE_UNITTEST_*` 变量覆盖。容器必须已经包含由人工制备过程提供的 venv、PyTorch、CUDA 和基础测试依赖。

## 错误处理与验证

- 任何阶段在缺失 `nerdctl`、镜像、容器、源码或 GPU 构建验证失败时以非零状态退出。
- 不输出密码、令牌或代理值。
- 新增 Bash 静态契约测试，以 fake `nerdctl`/`git` 验证参数、状态文件、清理策略与 pytest 命令。
- 在 128 节点执行脚本端到端验证；若远端构建或全量 pytest 因现有代码失败，保留日志并报告真实结果，不将失败包装为成功。
