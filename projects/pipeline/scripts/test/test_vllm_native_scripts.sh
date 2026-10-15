#!/usr/bin/env bash
# vllm-native-*.sh 契约测试：mock kubectl/curl 验证
#   - check：节点解析/并行度一致性/GPU 余量/模型路径/端口/契约输出
#   - prepare：命名空间创建 + MoERunner 修复文件落盘（幂等）
#   - deploy：prefill/decode/proxy 三角色 YAML 渲染（PP4 配方、Mooncake、moefix 挂载）、
#     standalone 模式裁剪、VLLM_ROLE 必填
#   - wait：Running+就绪日志标记 → 通过；Failed 终态 → 失败
#   - verify：/v1/models + /v1/completions + external_kv_transfer 指标
#   - cleanup：预演不删、正式删除
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for f in vllm-native-check.sh vllm-native-prepare.sh vllm-native-deploy.sh vllm-native-wait.sh vllm-native-verify.sh vllm-native-cleanup.sh; do
  bash -n "$ROOT/$f"
done
echo "PASS: 六个脚本 bash -n 语法检查"

FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"

MYIP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$MYIP" ] || MYIP="127.0.0.1"
NODE_NAME="gpu-node-1"

# kubectl 行为由 $FAKE_STATE 下的文件驱动：
#   phase        Pod phase（默认 Running）
#   log_marker   存在则 logs 输出含 Application startup complete
#   ns_exists    存在则 get namespace 成功
#   applied/     apply 捕获的 YAML
#   deleted.log  delete 调用记录
FAKE_STATE="$WORK/state"
mkdir -p "$FAKE_STATE/applied"
echo Running >"$FAKE_STATE/phase"
touch "$FAKE_STATE/log_marker" "$FAKE_STATE/ns_exists"

cat >"$FAKE_BIN/kubectl" <<EOF
#!/usr/bin/env bash
STATE="$FAKE_STATE"
NODE_NAME="$NODE_NAME"
MYIP="$MYIP"
args="\$*"
case "\$args" in
  "version --request-timeout=5s") exit 0 ;;
  "get nodes -o json --request-timeout=30s")
    cat <<JSON
{"items":[{"metadata":{"name":"\$NODE_NAME"},"status":{"addresses":[{"type":"InternalIP","address":"\$MYIP"}],"allocatable":{"nvidia.com/gpu":"8"}}}]}
JSON
    exit 0 ;;
  "get node \$NODE_NAME -o json --request-timeout=30s")
    echo '{"status":{"allocatable":{"nvidia.com/gpu":"8"}}}'
    exit 0 ;;
  "get runtimeclass dcgm-nvidia-runtime --request-timeout=15s") exit 0 ;;
  "get runtimeclass "*) exit 1 ;;
  "get namespace "*)
    [[ -f "\$STATE/ns_exists" ]] && exit 0 || exit 1 ;;
  "create namespace "*)
    touch "\$STATE/ns_exists"; exit 0 ;;
  "get pods -A --field-selector spec.nodeName=\$NODE_NAME -o json --request-timeout=60s")
    echo '{"items":[]}'
    exit 0 ;;
  "get pods -n "*" --request-timeout=15s -o jsonpath="*) echo ''; exit 0 ;;
  "-n "*" get pod "*" -o jsonpath={.status.phase}") cat "\$STATE/phase"; exit 0 ;;
  "-n "*" get pod "*" -o jsonpath='"*) cat "\$STATE/phase"; exit 0 ;;
  "-n "*" logs "*" -c vllm --tail=2000 --request-timeout=30s")
    if [[ -f "\$STATE/log_marker" ]]; then echo 'INFO: Application startup complete.'; else echo 'loading…'; fi
    exit 0 ;;
  "-n "*" logs "*" -c vllm --tail=80 --request-timeout=30s") echo 'tail-log'; exit 0 ;;
  "-n "*" get pod "*" --request-timeout=15s")
    # get pod 存在性查询：由 pods_exist 状态文件控制
    [[ -f "\$STATE/pods_exist" ]] && exit 0 || exit 1 ;;
  "-n "*" get pod "*" -o wide --request-timeout=30s") exit 0 ;;
  "-n "*" delete pod "*)
    echo "\$args" >>"\$STATE/deleted.log"; exit 0 ;;
  "apply -f "*" --request-timeout=60s")
    f="\$(echo "\$args" | sed -E 's/^apply -f ([^ ]+).*/\1/')"
    cp "\$f" "\$STATE/applied/\$(basename "\$f")"
    exit 0 ;;
  *) echo "fake kubectl: 未处理的调用: \$args" >&2; exit 1 ;;
esac
EOF
chmod +x "$FAKE_BIN/kubectl"

# curl 行为：/v1/models 返回模型列表；/v1/completions 返回文本；/metrics 带 external_kv_transfer；/query 200
# 支持 -o <file>（写文件）与 -w <fmt>（打印状态码）真实语义
cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
out=""; fmt=""; url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    -d) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */v1/models) body='{"data":[{"id":"GLM-5.2-NVFP4-W4A4C8-MG40-BNT3"}]}' ;;
  */v1/completions) body='{"choices":[{"text":"北京"}]}' ;;
  */metrics) body='vllm:prompt_tokens_by_source_total{source="external_kv_transfer"} 4096' ;;
  */query) body='{}' ;;
  *) echo 'fake curl: 未知 URL' >&2; exit 1 ;;
esac
if [[ -n "$out" ]]; then printf '%s' "$body" >"$out"; fi
if [[ -n "$fmt" ]]; then printf '200'; else printf '%s' "$body"; fi
exit 0
EOF
chmod +x "$FAKE_BIN/curl"

MODELS_ROOT="$WORK/models"
mkdir -p "$MODELS_ROOT/test-model/v1"
touch "$MODELS_ROOT/test-model/v1/config.json" "$MODELS_ROOT/test-model/v1/tokenizer.json"

BASE_ENV=(env -u TARGET_HOSTS -u TARGET_IPS -u TARGET_IP -u GIT_URL -u GIT_BRANCH
  PATH="$FAKE_BIN:/usr/bin:/bin"
  VLLM_NAMESPACE="native-vllm-test"
  MODEL_MOUNT_PATH="/models" MODEL_PATH="/models/test-model/v1" MODEL_HOST_PATH="$MODELS_ROOT"
  VLLM_MOEFIX_DIR="$WORK/moefix"
  PREFILL_PORT=18010 DECODE_PORT=18020 PROXY_PORT=18000 MOONCAKE_BOOTSTRAP_PORT=18998)

# ============ check ============
# ① standalone 全绿（/dev/infiniband 不参与）：PASS + 契约
"${BASE_ENV[@]}" DEPLOY_MODE=standalone bash "$ROOT/vllm-native-check.sh" >"$WORK/check1.out" 2>&1
grep -q "VLLM_NODE=$NODE_NAME" "$WORK/check1.out"
grep -q 'VLLM_GATE=PASS' "$WORK/check1.out"
grep -q 'VLLM_MODE=standalone' "$WORK/check1.out"
echo "PASS: check standalone 全绿（节点自动解析 + 契约输出）"

# ② pd 且 /dev/infiniband 缺失 → FAIL（本机若无该设备）
if [[ ! -d /dev/infiniband ]]; then
  if "${BASE_ENV[@]}" DEPLOY_MODE=pd bash "$ROOT/vllm-native-check.sh" >"$WORK/check2.out" 2>&1; then
    echo "check case2 应失败（pd 缺 /dev/infiniband）" >&2; exit 1
  fi
  grep -q 'infiniband' "$WORK/check2.out"
  echo "PASS: check pd 缺 /dev/infiniband 判 FAIL"
else
  "${BASE_ENV[@]}" DEPLOY_MODE=pd bash "$ROOT/vllm-native-check.sh" >"$WORK/check2.out" 2>&1
  grep -q 'VLLM_GATE=PASS' "$WORK/check2.out"
  echo "PASS: check pd（本机有 /dev/infiniband）"
fi

# ③ 并行度不一致 → FAIL
if "${BASE_ENV[@]}" DEPLOY_MODE=pd PREFILL_GPU=8 bash "$ROOT/vllm-native-check.sh" >"$WORK/check3.out" 2>&1; then
  echo "check case3 应失败（PREFILL_GPU 与 TP×PP 不符）" >&2; exit 1
fi
grep -q 'PREFILL_GPU（8）!= VLLM_TP×PREFILL_PP（4）' "$WORK/check3.out"
echo "PASS: check 并行度一致性拦截"

# ④ 模型文件缺失 → FAIL
if "${BASE_ENV[@]}" DEPLOY_MODE=standalone MODEL_PATH=/models/ghost/v1 bash "$ROOT/vllm-native-check.sh" >"$WORK/check4.out" 2>&1; then
  echo "check case4 应失败（模型缺失）" >&2; exit 1
fi
grep -q 'config.json 不存在' "$WORK/check4.out"
echo "PASS: check 模型路径缺失拦截"

# ============ prepare ============
rm -f "$FAKE_STATE/ns_exists"
"${BASE_ENV[@]}" bash "$ROOT/vllm-native-prepare.sh" >"$WORK/prep1.out" 2>&1
grep -q '已创建' "$WORK/prep1.out"
grep -q 'VLLM_PREPARED=1' "$WORK/prep1.out"
[[ -s "$WORK/moefix/vllm_native_moefix.py" && -s "$WORK/moefix/zz_vllm_native_moefix.pth" ]]
grep -q 'import vllm_native_moefix' "$WORK/moefix/zz_vllm_native_moefix.pth"
! grep -q '^import vllm$' "$WORK/moefix/zz_vllm_native_moefix.pth"
echo "PASS: prepare 建命名空间 + moefix 落盘（.pth 不直接 import vllm）"

# 幂等：再跑一次 → 跳过写入
"${BASE_ENV[@]}" bash "$ROOT/vllm-native-prepare.sh" >"$WORK/prep2.out" 2>&1
grep -q '跳过创建' "$WORK/prep2.out"
grep -q '已是最新，跳过写入' "$WORK/prep2.out"
echo "PASS: prepare 幂等重跑"

# ============ deploy ============
# ⑤ prefill（pd）：渲染 + 先删后建
"${BASE_ENV[@]}" DEPLOY_MODE=pd VLLM_ROLE=prefill bash "$ROOT/vllm-native-deploy.sh" >"$WORK/dep1.out" 2>&1
ls "$FAKE_STATE/applied/"*.yaml >/dev/null 2>&1
PYAML="$(ls -t "$FAKE_STATE/applied/"*.yaml | head -1)"
grep -q 'name: vllm-prefill' "$PYAML"
grep -q 'hostNetwork: true' "$PYAML"
grep -q 'runtimeClassName: dcgm-nvidia-runtime' "$PYAML"
grep -q 'nvidia.com/gpu: "4"' "$PYAML"
grep -q -- '--pipeline-parallel-size 4' "$PYAML"
grep -q -- '--block-size 64' "$PYAML"
grep -q -- '--kv-transfer-config '"'"'{"kv_connector":"MooncakeConnector","kv_role":"kv_producer"}'"'"'' "$PYAML"
grep -q -- '--speculative-config '"'"'{"method":"mtp","num_speculative_tokens":3}'"'"'' "$PYAML"
grep -q 'VLLM_PP_LAYER_PARTITION' "$PYAML"
grep -q 'value: "22,20,20,16"' "$PYAML"
grep -q 'mountPath: /dev/infiniband' "$PYAML"
grep -q "path: $MODELS_ROOT" "$PYAML"
grep -q 'VLLM_PREFILL_POD=vllm-prefill' "$WORK/dep1.out"
grep -q 'delete pod vllm-prefill' "$FAKE_STATE/deleted.log"
echo "PASS: deploy prefill（pd）YAML 配方正确（PP4/Mooncake producer/RDMA/先删后建）"

# ⑥ decode（pd）：consumer + moefix 挂载 + RAY env + async-scheduling
rm -rf "$FAKE_STATE/applied"; mkdir -p "$FAKE_STATE/applied"
"${BASE_ENV[@]}" DEPLOY_MODE=pd VLLM_ROLE=decode bash "$ROOT/vllm-native-deploy.sh" >"$WORK/dep2.out" 2>&1
DYAML="$(ls -t "$FAKE_STATE/applied/"*.yaml | head -1)"
grep -q 'name: vllm-decode' "$DYAML"
grep -q -- '--data-parallel-size 4 --data-parallel-backend ray' "$DYAML"
grep -q -- '--async-scheduling' "$DYAML"
grep -q 'kv_role":"kv_consumer"' "$DYAML"
grep -q 'RAY_EXPERIMENTAL_NOSET_CUDA_VISIBLE_DEVICES' "$DYAML"
grep -q 'vllm_native_moefix.py' "$DYAML"
grep -q 'zz_vllm_native_moefix.pth' "$DYAML"
grep -q 'subPath: vllm_native_moefix.py' "$DYAML"
echo "PASS: deploy decode（pd）YAML 配方正确（DP4/consumer/moefix 挂载/Ray CVD env）"

# ⑦ proxy（pd）：代理命令行 + 无 GPU runtimeClass/卷
rm -rf "$FAKE_STATE/applied"; mkdir -p "$FAKE_STATE/applied"
"${BASE_ENV[@]}" DEPLOY_MODE=pd VLLM_ROLE=proxy bash "$ROOT/vllm-native-deploy.sh" >"$WORK/dep3.out" 2>&1
XYAML="$(ls -t "$FAKE_STATE/applied/"*.yaml | head -1)"
grep -q 'name: vllm-pd-proxy' "$XYAML"
grep -q -- 'mooncake_connector_proxy.py --prefill http://127.0.0.1:18010 18998 --decode http://127.0.0.1:18020 --host 0.0.0.0 --port 18000' "$XYAML"
grep -q 'nvidia.com/gpu: "0"' "$XYAML"
! grep -q 'runtimeClassName' "$XYAML"
! grep -q 'volumes:' "$XYAML"
! grep -q 'volumeMounts:' "$XYAML"
echo "PASS: deploy proxy（pd）YAML 正确（代理参数/无 runtimeClass/无卷）"

# ⑧ standalone：prefill 直听对外端口、无 Mooncake；decode/proxy 跳过
rm -rf "$FAKE_STATE/applied"; mkdir -p "$FAKE_STATE/applied"
"${BASE_ENV[@]}" DEPLOY_MODE=standalone VLLM_ROLE=prefill bash "$ROOT/vllm-native-deploy.sh" >"$WORK/dep4.out" 2>&1
SYAML="$(ls -t "$FAKE_STATE/applied/"*.yaml | head -1)"
grep -q -- '--port 18000' "$SYAML"
! grep -q 'kv-transfer-config' "$SYAML"
! grep -q 'VLLM_MOONCAKE_BOOTSTRAP_PORT' "$SYAML"
! grep -q 'infiniband' "$SYAML"
"${BASE_ENV[@]}" DEPLOY_MODE=standalone VLLM_ROLE=decode bash "$ROOT/vllm-native-deploy.sh" >"$WORK/dep5.out" 2>&1
grep -q '跳过角色 decode' "$WORK/dep5.out"
"${BASE_ENV[@]}" DEPLOY_MODE=standalone VLLM_ROLE=proxy bash "$ROOT/vllm-native-deploy.sh" >"$WORK/dep6.out" 2>&1
grep -q '跳过角色 proxy' "$WORK/dep6.out"
echo "PASS: standalone 模式裁剪（prefill 直听对外端口，decode/proxy 跳过）"

# ⑨ VLLM_ROLE 缺失 → 失败（:? 必填校验）
if "${BASE_ENV[@]}" DEPLOY_MODE=pd bash "$ROOT/vllm-native-deploy.sh" >"$WORK/dep7.out" 2>&1; then
  echo "deploy case9 应失败（VLLM_ROLE 必填）" >&2; exit 1
fi
grep -q 'VLLM_ROLE' "$WORK/dep7.out"
echo "PASS: VLLM_ROLE 必填校验"

# ============ wait ============
# ⑩ Running + 就绪标记 → 通过
"${BASE_ENV[@]}" DEPLOY_MODE=pd VLLM_READY_TIMEOUT=30 VLLM_POLL_INTERVAL=1 bash "$ROOT/vllm-native-wait.sh" >"$WORK/wait1.out" 2>&1
grep -q 'VLLM_READY=1' "$WORK/wait1.out"
grep -q 'vllm-prefill 就绪' "$WORK/wait1.out"
grep -q 'vllm-decode 就绪' "$WORK/wait1.out"
echo "PASS: wait pd 双 Pod 就绪"

# ⑪ Failed 终态 → 失败
echo Failed >"$FAKE_STATE/phase"
if "${BASE_ENV[@]}" DEPLOY_MODE=standalone VLLM_READY_TIMEOUT=30 VLLM_POLL_INTERVAL=1 bash "$ROOT/vllm-native-wait.sh" >"$WORK/wait2.out" 2>&1; then
  echo "wait case11 应失败（Pod Failed）" >&2; exit 1
fi
grep -q '进入终态 Failed' "$WORK/wait2.out"
echo Running >"$FAKE_STATE/phase"
echo "PASS: wait 终态快速失败"

# ============ verify ============
# ⑫ pd：models + completions + KV 传输指标 + 契约
"${BASE_ENV[@]}" DEPLOY_MODE=pd VLLM_VERIFY_TIMEOUT=10 bash "$ROOT/vllm-native-verify.sh" >"$WORK/ver1.out" 2>&1
grep -q 'VLLM_VERIFY=PASS' "$WORK/ver1.out"
grep -q 'VLLM_SERVICE_ADDR=' "$WORK/ver1.out"
grep -q 'KV 外部传输已生效' "$WORK/ver1.out"
grep -q '模型列表：GLM-5.2-NVFP4-W4A4C8-MG40-BNT3' "$WORK/ver1.out"
echo "PASS: verify pd 全链路（models/completions/KV 传输指标）"

# ⑬ standalone：不经 Decode 指标
"${BASE_ENV[@]}" DEPLOY_MODE=standalone VLLM_VERIFY_TIMEOUT=10 bash "$ROOT/vllm-native-verify.sh" >"$WORK/ver2.out" 2>&1
grep -q 'VLLM_VERIFY=PASS' "$WORK/ver2.out"
! grep -q 'external_kv_transfer' "$WORK/ver2.out"
echo "PASS: verify standalone（跳过 KV 传输校验）"

# ============ cleanup ============
# ⑭ 预演（默认）：不调用 delete
rm -f "$FAKE_STATE/deleted.log"
touch "$FAKE_STATE/pods_exist"
"${BASE_ENV[@]}" DEPLOY_MODE=pd bash "$ROOT/vllm-native-cleanup.sh" >"$WORK/cl1.out" 2>&1
grep -q '预演' "$WORK/cl1.out"
grep -q '将删除 Pod：native-vllm-test/vllm-prefill' "$WORK/cl1.out"
grep -q '将删除 Pod：native-vllm-test/vllm-pd-proxy' "$WORK/cl1.out"
grep -q 'VLLM_CLEANED=DRY_RUN' "$WORK/cl1.out"
[[ ! -s "$FAKE_STATE/deleted.log" ]]
echo "PASS: cleanup 默认预演不删除"

# ⑮ 正式删除：三个 Pod 逐个删除
"${BASE_ENV[@]}" DEPLOY_MODE=pd VLLM_CLEANUP_DRY_RUN=0 bash "$ROOT/vllm-native-cleanup.sh" >"$WORK/cl2.out" 2>&1
grep -q 'VLLM_CLEANED=1' "$WORK/cl2.out"
[[ "$(grep -c 'delete pod' "$FAKE_STATE/deleted.log")" == "3" ]]
grep -q 'delete pod vllm-decode' "$FAKE_STATE/deleted.log"
echo "PASS: cleanup 正式删除（pd 三 Pod）"

# ⑯ standalone 只删 prefill；无 Pod 幂等
rm -f "$FAKE_STATE/deleted.log" "$FAKE_STATE/pods_exist"
"${BASE_ENV[@]}" DEPLOY_MODE=standalone VLLM_CLEANUP_DRY_RUN=0 bash "$ROOT/vllm-native-cleanup.sh" >"$WORK/cl3.out" 2>&1
grep -q '幂等退出' "$WORK/cl3.out"
echo "PASS: cleanup 幂等退出（无 Pod）"

echo "全部 vllm-native 脚本契约测试通过"
