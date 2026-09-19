#!/usr/bin/env bash
set -euo pipefail
script="$(cd "$(dirname "$0")/.." && pwd)/clear-lmcache-cache.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# 隔离函数加载，所有集群操作均使用模拟命令。
source <(sed '/^main "\$@"$/d' "$script")
LOG_FILE="$tmp/log"
NAMESPACE=

#ARGS_LINE="set -euo pipefail; exec lmcache server --l1-size-gb 200 --l2-store-policy default --l2-adapter '{\"base_path\":\"/mnt/paas/lmcache/x/shared\",\"eviction\":{\"eviction_policy\":\"LRU\"},\"type\":\"fs_native\"}'"

kubectl() {
    printf '%s\n' "$*" >>"$tmp/kubectl"
    case "$*" in
        *"get pods -A"*)  # discover_namespace 扫描
            printf '%s\n' 'other-ns ray-worker' 'x-ns ray-worker,lmcache-sidecar'
            ;;
        *"NODE:.spec.nodeName"*)  # sidecar_pods
            printf '%s\n' 'prefill-1-pod 192.0.2.1 ray-worker,lmcache-sidecar' 'prefill-2-pod 192.0.2.1 ray-worker,lmcache-sidecar' 'decode-1-pod 192.0.2.2 ray-worker'
            ;;
        *"ports.env"*) echo 5566;;
        *"get request"*) echo '2026-09-16 10:00:00' ;;
        *"NAME:.metadata.name"*)  # ensure_idle 的 frontgroup 列表
            printf '%s\n' 'frontgroup-1' 'frontgroup-2'
            ;;
        *"find /mnt/paas/lmcache/x/shared -type f -delete"*)
            echo delete >>"$tmp/deletes"
            ;;
        *"find /mnt/paas/lmcache/x/shared -type f"*)
            echo file-a; echo file-b; echo file-c
            ;;
    esac
    return 0
}

# --- discover_namespace：候选唯一 / 多候选报错 / 无候选报错 ---
[[ $(discover_namespace) == x-ns ]]
[[ $(NAMESPACE=zz discover_namespace) == zz ]]
kubectl() { case "$*" in *"get pods -A"*) printf '%s\n' 'ns-a ray-worker,lmcache-sidecar' 'ns-b ray-worker,lmcache-sidecar' ;; esac; }
( discover_namespace ) >/dev/null 2>&1 && { echo '多候选未报错' >&2; exit 1; }
kubectl() { :; }
( discover_namespace ) >/dev/null 2>&1 && { echo '无候选未报错' >&2; exit 1; }
err=$( ( discover_namespace ) 2>&1 >/dev/null ) || true
[[ "$err" == *'未发现包含'* ]] || { echo 'die 的报错未输出到 stderr' >&2; exit 1; }
unset -f kubectl

# --- pod_http_port：解析动态端口；坏输出返回非 0 ---
kubectl() { case "$*" in *"ports.env"*) echo 5566;; esac; }
[[ $(NAMESPACE=x-ns pod_http_port prefill-1-pod) == 5566 ]]
kubectl() { case "$*" in *"ports.env"*) echo 'garbage' ;; esac; }
NAMESPACE=x-ns pod_http_port prefill-1-pod >/dev/null 2>&1 && { echo '坏端口文件未报错' >&2; exit 1; }
unset -f kubectl

# --- pod_l2_path：从 pod json 的 --l2-adapter 提取 base_path ---
# fixture 必须用 json.dumps 生成：args 内含未转义双引号的话 json.load 会失败
POD_JSON=$(python3 - <<'PY'
import json
args = ['set -euo pipefail; exec lmcache server --l2-store-policy default --l2-adapter \'{"base_path":"/mnt/paas/lmcache/x/shared","eviction":{"eviction_policy":"LRU"},"type":"fs_native"}\'']
print(json.dumps({"spec": {"containers": [{"name": "lmcache-sidecar", "args": args}]}}))
PY
)
kubectl() { printf '%s\n' "$POD_JSON"; }
[[ $(NAMESPACE=x-ns pod_l2_path pod1) == /mnt/paas/lmcache/x/shared ]]
kubectl() { printf '%s\n' '{"spec":{"containers":[{"name":"lmcache-sidecar","args":["exec lmcache server --l1-size-gb 200"]}]}}'; }
NAMESPACE=x-ns pod_l2_path pod1 >/dev/null 2>&1 && { echo '无 L2 配置未跳过' >&2; exit 1; }
# 运行时优先：sidecar PID 1 已 exec 为 lmcache server，/proc/1/cmdline 是展开后的真实 argv
kubectl() { case "$*" in
    *"proc/1/cmdline"*) printf '%s\n' 'lmcache' 'server' '--l2-adapter' '{"base_path":"/mnt/paas/lmcache/x/rt","eviction":{"eviction_policy":"LRU"},"type":"fs_native"}' ;;
    *"-o json"*) printf '%s\n' "$POD_JSON" ;;
esac; }
[[ $(NAMESPACE=x-ns pod_l2_path pod1) == /mnt/paas/lmcache/x/rt ]] || { echo '运行时 l2 路径解析失败' >&2; exit 1; }
unset -f kubectl

# --- ensure_idle：最近请求过近报错，过远放行 ---
kubectl() { case "$*" in
    *"NAME:.metadata.name"*) printf '%s\n' 'frontgroup-1' 'frontgroup-2' ;;
    *"get request"*) echo '2026-09-16 10:00:00' ;;
esac; }
now_epoch() { echo $(( $(date -u -d '2026-09-16 10:00:00' +%s) + 3600 )); }
NAMESPACE=x-ns IDLE_SECONDS=60 ensure_idle
now_epoch() { echo $(( $(date -u -d '2026-09-16 10:00:00' +%s) + 10 )); }
( NAMESPACE=x-ns IDLE_SECONDS=60 ensure_idle ) >/dev/null 2>&1 && { echo '流量未停止被放行' >&2; exit 1; }
unset -f kubectl
unset -f now_epoch
now_epoch() { date -u +%s; }

# --- clear_l2：同节点多 sidecar 共享目录，按 node:path 去重只删一次 ---
kubectl() { case "$*" in
    *"NODE:.spec.nodeName"*) printf '%s\n' 'prefill-1-pod 192.0.2.1 ray-worker,lmcache-sidecar' 'prefill-2-pod 192.0.2.1 ray-worker,lmcache-sidecar' ;;
    *"-o json"*) printf '%s\n' "$POD_JSON" ;;
    *"find /mnt/paas/lmcache/x/shared -type f -delete"*) echo delete >>"$tmp/deletes" ;;
    *"find /mnt/paas/lmcache/x/shared -type f"*)
        # 有状态：删除发生过则计数为 0，模拟真实 find 行为
        [[ -f "$tmp/deletes" ]] || { echo file-a; echo file-b; echo file-c; }
        ;;
esac; }
rm -f "$tmp/deletes"
DRY_RUN=0 NAMESPACE=x-ns clear_l2
[[ $(wc -l <"$tmp/deletes") -eq 1 ]] || { echo 'L2 去重失败' >&2; exit 1; }
grep -q '当前 2 个文件' "$LOG_FILE" || grep -q '当前 3 个文件' "$LOG_FILE"

# --- clear_l1：DRY_RUN 只记录不执行 curl POST ---
kubectl() { case "$*" in
    *"NODE:.spec.nodeName"*) printf '%s\n' 'prefill-1-pod 192.0.2.1 ray-worker,lmcache-sidecar' 'prefill-2-pod 192.0.2.1 ray-worker,lmcache-sidecar' ;;
    *"ports.env"*) echo 5566;;
esac; }
: >"$tmp/kubectl"; : >"$LOG_FILE"
DRY_RUN=1 NAMESPACE=x-ns clear_l1
grep -q 'L1 清理: prefill-1-pod' "$LOG_FILE"
grep -q 'L1 清理: prefill-2-pod' "$LOG_FILE"
if grep -q -- '-X POST' "$tmp/kubectl"; then echo 'DRY_RUN 下不应真正 exec curl POST' >&2; exit 1; fi

# --- clear_l1 实清：版本不导出 lmcache_mp 指标 → 跳过归零验证且不空等 ---
kubectl() { case "$*" in
    *"NODE:.spec.nodeName"*) printf '%s\n' 'prefill-1-pod 192.0.2.1 ray-worker,lmcache-sidecar' ;;
    *"ports.env"*) echo 5566;;
    *"/cache/clear"*) echo '{"status":"ok","cleared":{"tier":"l1"}}';;
    *"/metrics"*) printf 'python_gc_objects_collected_total 1.0\n' ;;
esac; }
: >"$LOG_FILE"
DRY_RUN=0 NAMESPACE=x-ns clear_l1
grep -q '跳过归零验证' "$LOG_FILE" || { echo '无 lmcache 指标时未跳过验证' >&2; exit 1; }
grep -q '未在' "$LOG_FILE" && { echo '不应出现归零超时误报' >&2; exit 1; }
unset -f kubectl

# --- main 参数校验：非法布尔值直接失败 ---
( DRY_RUN=2 main ) >/dev/null 2>&1 && { echo '非法 DRY_RUN 未报错' >&2; exit 1; }

# --- HBM 引擎 success 验证：快照 → 新增 success 行 → 通过 ---
rm -f "$tmp/hbm_go"
kubectl() { case "$*" in
    *"NAME:.metadata.name"*) printf '%s\n' 'x-prefill-1-abc' 'x-decode-1-def' 'frontgroup-1' ;;
    *"wc -l"*)
        # 有状态：第一次（快照）返回 10 行，之后（reset 已发生）返回 12 行
        if [[ -f "$tmp/hbm_go" ]]; then printf '%s\n' '12 vllm_a.log' '12 total'
        else printf '%s\n' '10 vllm_a.log' '10 total'; : >"$tmp/hbm_go"; fi ;;
    *"sed -n 11,12p"*) printf '%s\n' \
        '09-18 13:17:49.216 - prefix_cache.py - reset_prefix_cache start, reset_running_requests=True.' \
        '09-18 13:17:49.253 - prefix_cache.py - reset_prefix_cache async task done, success.' ;;
esac; }
: >"$LOG_FILE"
NAMESPACE=x-ns TE_POD_PATTERN='prefill' hbm_snapshot
(( ${#HBM_SNAP[@]} == 1 )) || { echo '快照未记录引擎日志基线' >&2; exit 1; }
[[ ${HBM_SNAP['x-prefill-1-abc|vllm_a.log']} == 10 ]] || { echo '快照基线行数不对' >&2; exit 1; }
NAMESPACE=x-ns TE_POD_PATTERN='prefill' verify_hbm_reset
grep -q '全部引擎确认 success' "$LOG_FILE" || { echo 'HBM success 验证通过路径失败' >&2; exit 1; }

# --- Traceback 新增行 → 立即失败 ---
rm -f "$tmp/hbm_go"
kubectl() { case "$*" in
    *"NAME:.metadata.name"*) echo 'x-prefill-1-abc' ;;
    *"wc -l"*)
        if [[ -f "$tmp/hbm_go" ]]; then printf '%s\n' '11 vllm_a.log' '11 total'
        else printf '%s\n' '10 vllm_a.log' '10 total'; : >"$tmp/hbm_go"; fi ;;
    *"sed -n 11,11p"*) printf '%s\n' 'Traceback (most recent call last):' ;;
esac; }
: >"$LOG_FILE"
NAMESPACE=x-ns TE_POD_PATTERN='prefill' hbm_snapshot
err=$( NAMESPACE=x-ns TE_POD_PATTERN='prefill' verify_hbm_reset 2>&1 ) && { echo 'Traceback 未触发失败' >&2; exit 1; }
[[ "$err" == *'引擎侧异常'* ]] || { echo 'Traceback 失败文案不对' >&2; exit 1; }

# --- async task done 非 success → 失败 ---
rm -f "$tmp/hbm_go"
kubectl() { case "$*" in
    *"NAME:.metadata.name"*) echo 'x-prefill-1-abc' ;;
    *"wc -l"*)
        if [[ -f "$tmp/hbm_go" ]]; then printf '%s\n' '11 vllm_a.log' '11 total'
        else printf '%s\n' '10 vllm_a.log' '10 total'; : >"$tmp/hbm_go"; fi ;;
    *"sed -n 11,11p"*) printf '%s\n' '09-18 13:17:50.001 - prefix_cache.py - reset_prefix_cache async task done, fail.' ;;
esac; }
err=$( NAMESPACE=x-ns TE_POD_PATTERN='prefill' hbm_snapshot 2>/dev/null; NAMESPACE=x-ns TE_POD_PATTERN='prefill' verify_hbm_reset 2>&1 ) && { echo '非 success done 未触发失败' >&2; exit 1; }
[[ "$err" == *'引擎侧失败'* ]] || { echo '非 success 失败文案不对' >&2; exit 1; }

# --- 无新增行 → 超时报错并列出未确认 pod ---
kubectl() { case "$*" in
    *"NAME:.metadata.name"*) echo 'x-prefill-1-abc' ;;
    *"wc -l"*) printf '%s\n' '10 vllm_a.log' '10 total' ;;
esac; }
err=$( NAMESPACE=x-ns TE_POD_PATTERN='prefill' HBM_VERIFY_TIMEOUT_SECONDS=1 verify_hbm_reset 2>&1 ) && { echo '超时未报错' >&2; exit 1; }
[[ "$err" == *'确认超时'* && "$err" == *'x-prefill-1-abc'* ]] || { echo "超时文案不对: $err" >&2; exit 1; }

# --- 引擎 pod 匹配为空 → 直接报错 ---
err=$( NAMESPACE=x-ns TE_POD_PATTERN='nomatch' verify_hbm_reset 2>&1 ) && { echo '无引擎 pod 未报错' >&2; exit 1; }
[[ "$err" == *'未发现匹配'* ]] || { echo '无引擎 pod 失败文案不对' >&2; exit 1; }
unset -f kubectl

echo 'PASS: clear-lmcache discovery, parsing, idle guard, l2 dedupe, dry-run, hbm verify'
