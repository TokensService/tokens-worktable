# 基于本机已有的 CI 运行容器（BNT3: Ubuntu24.04 + CUDA13.0 + Python3.12）派生的
# CUDA wheel 构建镜像：在镜像构建阶段预装官方 docker/mooncake.Dockerfile builder
# 阶段所需的系统依赖，运行时不再动态 apt install。
#
# 背景：build_cuda_peermem0_wheel.sh 在 CI 容器内动态 apt install 因容器 DNS 不可用
# 失败。本镜像把依赖前置到构建期（构建期走本机 127.0.0.1:8118 代理，最终镜像清除代理）。
#
# 参考官方: https://github.com/kvcache-ai/Mooncake/blob/main/docker/mooncake.Dockerfile
ARG BASE_IMAGE=swr.cn-southwest-2.myhuaweicloud.com/dataartsfabric/xds:0830_dev_bnt3_mtp_check.20260821090355.BNT3.x86_64
FROM ${BASE_IMAGE}

# 底座镜像默认 USER=service（非 root），构建期需要 root 权限改 apt 源 / 装依赖；
# CI 运行时（docker run -u root）同样以 root 执行
USER root

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# 构建期代理（仅 RUN 阶段有效），最终镜像清除
ARG http_proxy=http://127.0.0.1:8118
ARG https_proxy=http://127.0.0.1:8118
ARG no_proxy=localhost,127.0.0.1
ENV http_proxy=${http_proxy} \
    https_proxy=${https_proxy} \
    no_proxy=${no_proxy}

# 1) apt 源切到可达的官方 Ubuntu 源，禁用不可达的内外网额外源
#    （内网镜像 mirrors.tools.huawei.com 在本机构建环境 NXDOMAIN，
#     cuda/deadsnakes 源无外网出口，均会导致 apt-get update 报错拖慢构建）
RUN rm -f /etc/apt/sources.list.d/cuda.list \
          /etc/apt/sources.list.d/deadsnakes-ubuntu-ppa-noble.sources \
 && sed -i 's#http://mirrors.tools.huawei.com/ubuntu/#http://archive.ubuntu.com/ubuntu/#g' \
        /etc/apt/sources.list.d/ubuntu.sources

# 2) 预装官方 builder 阶段依赖。本容器已含 ninja/cmake/gcc/g++/curl/python3-dev，
#    apt 会跳过已装的包；此处补齐 git/pkg-config/go/python3-venv 及 9 个 libXX-dev。
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        pkg-config \
        golang-go \
        python3-venv \
        libasio-dev \
        libgflags-dev \
        libgoogle-glog-dev \
        libhiredis-dev \
        libjsoncpp-dev \
        libssl-dev \
        liburing-dev \
        libyaml-cpp-dev && \
    rm -rf /var/lib/apt/lists/*

# 3) 清除构建期代理，避免污染最终镜像运行环境
ENV http_proxy= \
    https_proxy= \
    no_proxy= \
    HTTP_PROXY= \
    HTTPS_PROXY= \
    NO_PROXY=

CMD ["/bin/bash"]