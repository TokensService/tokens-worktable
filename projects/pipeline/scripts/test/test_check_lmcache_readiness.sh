#!/usr/bin/env bash
set -euo pipefail
script="$(cd "$(dirname "$0")/.." && pwd)/check-lmcache-readiness.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# 隔离函数加载：脚本主体无副作用，main 被去掉后单独驱动。
# 注意 TIMEOUT_SECONDS/POLL_SECONDS 是源码内部派生名，测试直接对它们赋值。
source <(sed '/^main "\$@"$/d' "$script")
LOG_FILE="$tmp/log"

status_json() { # $1=registered $2=healthy(0/1) $3=grace
    python3 - "$1" "$2" "$3" <<'PY'
import json, sys
registered, healthy, grace = int(sys.argv[1]), sys.argv[2] == "1", int(sys.argv[3])
print(json.dumps({
    "is_healthy": healthy,
    "registered_gpu_ids": [f"id{i}" for i in range(registered)],
    "worker_liveness": {"registration_grace_seconds": grace},
}))
PY
}

mock_common() { # $1=prefill-1 status 参数... 见各用例内联覆盖
    :
}

# --- 用例 1：全部注册且健康 → PASS（rc 0），契约齐全 ---
kubectl() { case "$*" in
    *"NAME:.metadata.name,CONTAINERS"*) printf '%s\n' 'prefill-1-pod ray-worker,lmcache-sidecar' 'prefill-2-pod ray-worker,lmcache-sidecar' 'decode-1-pod ray-worker' ;;
    *"ports.env"*) echo 5566 ;;
    *"prefill-1-pod"*) status_json 4 1 0 ;;
    *"prefill-2-pod"*) status_json 4 1 0 ;;
esac; }
: >"$LOG_FILE"
rc=0; out=$(NAMESPACE=x-ns TIMEOUT_SECONDS=5 POLL_SECONDS=1 main) || rc=$?
[[ $rc -eq 0 ]] || { echo "用例1应 PASS: rc=$rc" >&2; exit 1; }
[[ "$out" == *'LMCACHE_HEALTH=PASS'* ]] || { echo 'PASS 契约缺失' >&2; exit 1; }
[[ "$out" == *'LMCACHE_SIDECAR_PODS=2'* ]] || { echo 'POD 数契约缺失' >&2; exit 1; }
[[ "$out" == *'LMCACHE_GPU_WORKERS=4'* ]] || { echo 'GPU 契约缺失' >&2; exit 1; }
grep -q '2/2 就绪' "$LOG_FILE" || { echo '进度行缺失' >&2; exit 1; }
grep -q 'registration_grace_seconds' "$LOG_FILE" && { echo 'grace=0 不应提示' >&2; exit 1; }

# --- 用例 2：部分注册 → 继续轮询，补齐后 PASS ---
rm -f "$tmp/round2"
kubectl() { case "$*" in
    *"NAME:.metadata.name,CONTAINERS"*) printf '%s\n' 'prefill-1-pod ray-worker,lmcache-sidecar' 'prefill-2-pod ray-worker,lmcache-sidecar' ;;
    *"ports.env"*) echo 5566 ;;
    *"prefill-1-pod"*) status_json 4 1 0 ;;
    *"prefill-2-pod"*) if [[ -f "$tmp/round2" ]]; then status_json 4 1 0; else : >"$tmp/round2"; status_json 2 1 0; fi ;;
esac; }
: >"$LOG_FILE"
rc=0; NAMESPACE=x-ns TIMEOUT_SECONDS=10 POLL_SECONDS=1 main >/dev/null || rc=$?
[[ $rc -eq 0 ]] || { echo "补齐后应 PASS: rc=$rc" >&2; exit 1; }
grep -q '1/2 就绪' "$LOG_FILE" || { echo '首轮进度缺失' >&2; exit 1; }
grep -q '2/2 就绪' "$LOG_FILE" || { echo '末轮进度缺失' >&2; exit 1; }

# --- 用例 3：超时仍部分注册 → DEGRADED（rc 3）---
kubectl() { case "$*" in
    *"NAME:.metadata.name,CONTAINERS"*) printf '%s\n' 'prefill-1-pod ray-worker,lmcache-sidecar' 'prefill-2-pod ray-worker,lmcache-sidecar' ;;
    *"ports.env"*) echo 5566 ;;
    *"prefill-1-pod"*) status_json 4 1 0 ;;
    *"prefill-2-pod"*) status_json 2 1 0 ;;
esac; }
: >"$LOG_FILE"
rc=0; out=$(NAMESPACE=x-ns TIMEOUT_SECONDS=1 POLL_SECONDS=1 main) || rc=$?
[[ $rc -eq 3 ]] || { echo "部分注册应 DEGRADED: rc=$rc" >&2; exit 1; }
[[ "$out" == *'LMCACHE_HEALTH=DEGRADED'* ]] || { echo 'DEGRADED 契约缺失' >&2; exit 1; }

# --- 用例 4：注册满但子系统不健康 → DEGRADED ---
kubectl() { case "$*" in
    *"NAME:.metadata.name,CONTAINERS"*) printf '%s\n' 'prefill-1-pod ray-worker,lmcache-sidecar' ;;
    *"ports.env"*) echo 5566 ;;
    *"prefill-1-pod"*) status_json 4 0 0 ;;
esac; }
: >"$LOG_FILE"
rc=0; NAMESPACE=x-ns TIMEOUT_SECONDS=1 POLL_SECONDS=1 main >/dev/null || rc=$?
[[ $rc -eq 3 ]] || { echo "不健康应 DEGRADED: rc=$rc" >&2; exit 1; }

# --- 用例 5：零注册超时 → FAIL（rc 2）---
kubectl() { case "$*" in
    *"NAME:.metadata.name,CONTAINERS"*) printf '%s\n' 'prefill-1-pod ray-worker,lmcache-sidecar' ;;
    *"ports.env"*) echo 5566 ;;
    *"prefill-1-pod"*) status_json 0 0 0 ;;
esac; }
: >"$LOG_FILE"
rc=0; out=$(NAMESPACE=x-ns TIMEOUT_SECONDS=1 POLL_SECONDS=1 main) || rc=$?
[[ $rc -eq 2 ]] || { echo "零注册应 FAIL: rc=$rc" >&2; exit 1; }
[[ "$out" == *'LMCACHE_HEALTH=FAIL'* ]] || { echo 'FAIL 契约缺失' >&2; exit 1; }

# --- 用例 6：始终未发现 sidecar pod → FAIL（rc 2）---
kubectl() { case "$*" in
    *"NAME:.metadata.name,CONTAINERS"*) printf '%s\n' 'decode-1-pod ray-worker' ;;
esac; }
: >"$LOG_FILE"
rc=0; out=$(NAMESPACE=x-ns TIMEOUT_SECONDS=1 POLL_SECONDS=1 main) || rc=$?
[[ $rc -eq 2 ]] || { echo "无 sidecar 应 FAIL: rc=$rc" >&2; exit 1; }
[[ "$out" == *'LMCACHE_SIDECAR_PODS=0'* ]] || { echo '无 pod 契约应记 0' >&2; exit 1; }

# --- 用例 7：grace>0 → 输出回收风险提示 ---
kubectl() { case "$*" in
    *"NAME:.metadata.name,CONTAINERS"*) printf '%s\n' 'prefill-1-pod ray-worker,lmcache-sidecar' ;;
    *"ports.env"*) echo 5566 ;;
    *"prefill-1-pod"*) status_json 4 1 3600 ;;
esac; }
: >"$LOG_FILE"
rc=0; NAMESPACE=x-ns TIMEOUT_SECONDS=5 POLL_SECONDS=1 main >/dev/null || rc=$?
[[ $rc -eq 0 ]] || { echo "用例7应 PASS: rc=$rc" >&2; exit 1; }
grep -q 'registration_grace_seconds=3600' "$LOG_FILE" || { echo 'grace 提示缺失' >&2; exit 1; }

# --- 用例 8：/status 探活失败（容器未起）→ 按未就绪轮询，不崩溃 ---
kubectl() { case "$*" in
    *"NAME:.metadata.name,CONTAINERS"*) printf '%s\n' 'prefill-1-pod ray-worker,lmcache-sidecar' ;;
    *"ports.env"*) echo 5566 ;;
    *"prefill-1-pod"*) exit 1 ;;
esac; }
: >"$LOG_FILE"
rc=0; NAMESPACE=x-ns TIMEOUT_SECONDS=1 POLL_SECONDS=1 main >/dev/null || rc=$?
[[ $rc -eq 2 ]] || { echo "探活失败应 FAIL: rc=$rc" >&2; exit 1; }
grep -q '探活失败' "$LOG_FILE" || { echo '探活失败进度缺失' >&2; exit 1; }

# --- 用例 9：NAMESPACE 自动发现（全集群唯一）---
kubectl() { case "$*" in
    *"NS:.metadata.namespace,CONTAINERS"*) printf '%s\n' 'other-ns ray-worker' 'x-ns ray-worker,lmcache-sidecar' ;;
    *"NAME:.metadata.name,CONTAINERS"*) printf '%s\n' 'prefill-1-pod ray-worker,lmcache-sidecar' ;;
    *"ports.env"*) echo 5566 ;;
    *"prefill-1-pod"*) status_json 4 1 0 ;;
esac; }
: >"$LOG_FILE"
rc=0; NAMESPACE=x-ns TIMEOUT_SECONDS=5 POLL_SECONDS=1 main >/dev/null || rc=$?
[[ $rc -eq 0 ]] || { echo "自动发现应 PASS: rc=$rc" >&2; exit 1; }
grep -q '1/1 就绪' "$LOG_FILE" || { echo '自动发现后进度缺失' >&2; exit 1; }

# --- 用例 10：多候选命名空间 → 报错（rc 1）---
kubectl() { case "$*" in
    *"NS:.metadata.namespace,CONTAINERS"*) printf '%s\n' 'ns-a ray-worker,lmcache-sidecar' 'ns-b ray-worker,lmcache-sidecar' ;;
esac; }
rc=0; ( NAMESPACE= TIMEOUT_SECONDS=2 POLL_SECONDS=1 main ) >/dev/null 2>&1 || rc=$?
[[ $rc -eq 1 ]] || { echo "多候选应报错: rc=$rc" >&2; exit 1; }
unset -f kubectl

# --- 用例 11：CONTRACT_OUTPUT=0 抑制契约行，日志仍完整 ---
kubectl() { case "$*" in
    *"NAME:.metadata.name,CONTAINERS"*) printf '%s\n' 'prefill-1-pod ray-worker,lmcache-sidecar' ;;
    *"ports.env"*) echo 5566 ;;
    *"prefill-1-pod"*) status_json 4 1 0 ;;
esac; }
: >"$LOG_FILE"
rc=0; out=$(NAMESPACE=x-ns TIMEOUT_SECONDS=5 POLL_SECONDS=1 CONTRACT_OUTPUT=0 main) || rc=$?
[[ $rc -eq 0 ]] || { echo "CONTRACT_OUTPUT=0 应仍 PASS: rc=$rc" >&2; exit 1; }
[[ "$out" != *'LMCACHE_HEALTH='* ]] || { echo 'CONTRACT_OUTPUT=0 仍输出契约' >&2; exit 1; }
grep -q '就绪' "$LOG_FILE" || { echo '日志缺失' >&2; exit 1; }
unset -f kubectl

# --- 用例 12：参数校验 ---
rc=0; ( NAMESPACE=x-ns TIMEOUT_SECONDS=0 main ) >/dev/null 2>&1 || rc=$?
[[ $rc -eq 1 ]] || { echo "非法 TIMEOUT 未报错: rc=$rc" >&2; exit 1; }
rc=0; ( NAMESPACE=x-ns POLL_SECONDS=x main ) >/dev/null 2>&1 || rc=$?
[[ $rc -eq 1 ]] || { echo "非法 POLL 未报错: rc=$rc" >&2; exit 1; }

echo 'PASS: check-lmcache-readiness discovery, probe, progress, verdicts, contract, validation'
