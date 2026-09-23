#!/usr/bin/env bash
# LMCache 流水线 step 主脚本（shell step，无参调用）。
#
# 用法：在流水线中 pull_render_config 之前插入本 step 并配置下方参数。
# 本 step 做两件事：入参校验（fail-fast，错误判本 step 失败）+ 契约输出
# （stdout KEY=VALUE，平台注入下游 step 环境），下游渲染自动点亮
# LMCache sidecar。不加本 step 则默认全关，pull_render_config 自身
# 不需要任何 LMCache 配置（老流水线直配这些变量仍兼容）。
#
# 校验与默认值解析委托 lib/render-lmcache.sh（同一处真相，避免规则漂移）。
# 单测：test/test_lmcache_config.sh。
set -uo pipefail

SCRIPT_NAME='lmcache-config'

# ---- step 参数声明（平台「识别参数」按声明与紧邻注释扫描）----
# ENABLE_LMCACHE = LMCache 总开关，缺省 true 即开启，显式 false 临时关闭
ENABLE_LMCACHE="${ENABLE_LMCACHE:-true}"
# LMCACHE_OTLP_ENDPOINT = tracing 上报地址，缺省 http://192.168.10.6:4320
LMCACHE_OTLP_ENDPOINT="${LMCACHE_OTLP_ENDPOINT:-http://192.168.10.6:4320}"
# LMCACHE_L2_ENABLED = L2 磁盘缓存开关，缺省 true
LMCACHE_L2_ENABLED="${LMCACHE_L2_ENABLED:-true}"
# LMCACHE_LOG_LEVEL = sidecar 日志级别，缺省 INFO
LMCACHE_LOG_LEVEL="${LMCACHE_LOG_LEVEL:-INFO}"
# LMCACHE_EXTRA_ARGS = 额外 sidecar 命令行参数，实验钩子渲染后注入 chart，留空不注入
LMCACHE_EXTRA_ARGS="${LMCACHE_EXTRA_ARGS:-}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 规范化后的值必须显式导出给子进程：平台注入的 env 不含脚本内兜底的
# 默认值，不导出则 lib/render-lmcache.sh 看到的是空环境。
defaults="$(export ENABLE_LMCACHE LMCACHE_OTLP_ENDPOINT LMCACHE_L2_ENABLED \
  LMCACHE_LOG_LEVEL LMCACHE_EXTRA_ARGS; \
  bash "$script_dir/lib/render-lmcache.sh" defaults)" || exit $?

printf 'ENABLE_LMCACHE=%s\n' "$ENABLE_LMCACHE"
# LMCACHE_SIDECAR_ENABLED 是渲染内部占位符名，不进平台契约。
printf '%s\n' "$defaults" | grep -v '^LMCACHE_SIDECAR_ENABLED='
