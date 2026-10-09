#!/usr/bin/env bash
# check-deploy-gate.sh 门禁契约测试：输入检查、目标机 GPU/磁盘/工具/Secret 检查、
# 控制/工作节点分级、TARGET_HOSTS 逐节点凭据下发。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$ROOT/check-deploy-gate.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

bash -n "$GATE"

FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/nvidia-smi" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-L" ]]; then
  for i in 0 1 2 3; do echo "GPU $i: Fake BNT (UUID: fake-$i)"; done
  exit 0
fi
exit 1
EOF
cat >"$FAKE_BIN/kubectl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "get namespace xds-ok") exit 0 ;;
  "get namespace "*) exit 1 ;;
  "-n xds-ok get secret default-secret") exit 0 ;;
  "-n xds-ok get secret "*) exit 1 ;;
  *) exit 1 ;;
esac
EOF
cat >"$FAKE_BIN/helm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BIN"/*

BASE_ENV=(env -u TARGET_HOSTS -u TARGET_IPS -u MIN_GPU -u PREFILL_GPU -u DECODE_GPU
  -u NAMESPACE -u IMAGE_PULL_SECRETS -u IMAGE_NAME -u DEPLOY_IMAGE -u IMAGE_TAG
  LOG_FILE="$WORK/gate.log" TARGET_RUN_DIR="$WORK")

# ① 输入门禁：IMAGE_NAME / DEPLOY_IMAGE 均为空 → FAIL
if "${BASE_ENV[@]}" bash "$GATE" >"$WORK/c1.out" 2>&1; then
  echo "case1 应失败（镜像名为空）" >&2; exit 1
fi
grep -q 'GATE_RESULT=FAIL' "$WORK/c1.out"
grep -q '镜像名为空' "$WORK/c1.out"
echo "PASS: 镜像名缺失判 FAIL"

# ② 仅输入检查：有镜像名、无目标节点 → PASS + WARN
"${BASE_ENV[@]}" IMAGE_NAME="reg/xds" IMAGE_TAG="t1" bash "$GATE" >"$WORK/c2.out"
grep -q 'GATE_RESULT=PASS' "$WORK/c2.out"
grep -q '无目标节点运行' "$WORK/c2.out"
echo "PASS: 无目标节点时仅执行输入检查"

# ③ 目标机检查（REMOTE_EXECUTION=1 在本地跑目标机逻辑）：全部就绪 → PASS
PATH="$FAKE_BIN:/usr/bin:/bin" "${BASE_ENV[@]}" \
  REMOTE_EXECUTION=1 GATE_ROLE=control MIN_DISK_FREE_GIB=1 \
  bash "$GATE" >"$WORK/c3.out"
grep -q 'GATE_RESULT=PASS' "$WORK/c3.out"
grep -q 'GPU 数量: 4 >= 1' "$WORK/c3.out"
echo "PASS: 目标机全部就绪判 PASS（GPU 自动门槛=1）"

# ④ GPU 数量不足：MIN_GPU=8 > 4 → FAIL
if PATH="$FAKE_BIN:/usr/bin:/bin" "${BASE_ENV[@]}" \
    REMOTE_EXECUTION=1 GATE_ROLE=control MIN_DISK_FREE_GIB=1 MIN_GPU=8 \
    bash "$GATE" >"$WORK/c4.out" 2>&1; then
  echo "case4 应失败（GPU 不足）" >&2; exit 1
fi
grep -q 'GPU 数量不足: 4 < 8' "$WORK/c4.out"
echo "PASS: MIN_GPU 显式门槛生效"

# ⑤ 自动门槛取 PREFILL_GPU/DECODE_GPU 较大值
if PATH="$FAKE_BIN:/usr/bin:/bin" "${BASE_ENV[@]}" \
    REMOTE_EXECUTION=1 GATE_ROLE=control MIN_DISK_FREE_GIB=1 PREFILL_GPU=8 DECODE_GPU=2 \
    bash "$GATE" >"$WORK/c5.out" 2>&1; then
  echo "case5 应失败（PREFILL_GPU=8 推导门槛）" >&2; exit 1
fi
grep -q 'GPU 数量不足: 4 < 8' "$WORK/c5.out"
PATH="$FAKE_BIN:/usr/bin:/bin" "${BASE_ENV[@]}" \
  REMOTE_EXECUTION=1 GATE_ROLE=control MIN_DISK_FREE_GIB=1 PREFILL_GPU=4 DECODE_GPU=2 \
  bash "$GATE" >"$WORK/c5b.out"
grep -q 'GPU 数量: 4 >= 4' "$WORK/c5b.out"
echo "PASS: PREFILL_GPU/DECODE_GPU 自动推导 MIN_GPU"

# ⑥ 磁盘剩余不足 → FAIL
if PATH="$FAKE_BIN:/usr/bin:/bin" "${BASE_ENV[@]}" \
    REMOTE_EXECUTION=1 GATE_ROLE=control MIN_DISK_FREE_GIB=99999999 \
    bash "$GATE" >"$WORK/c6.out" 2>&1; then
  echo "case6 应失败（磁盘不足）" >&2; exit 1
fi
grep -q '磁盘剩余不足' "$WORK/c6.out"
echo "PASS: 磁盘门槛生效"

# ⑦ 控制节点缺 helm → FAIL；工作节点缺 helm → WARN 不阻断
NOHELM="$WORK/bin-nohelm"
mkdir -p "$NOHELM"
cp "$FAKE_BIN/nvidia-smi" "$FAKE_BIN/kubectl" "$FAKE_BIN/curl" "$NOHELM/"
if PATH="$NOHELM:/usr/bin:/bin" "${BASE_ENV[@]}" \
    REMOTE_EXECUTION=1 GATE_ROLE=control MIN_DISK_FREE_GIB=1 \
    bash "$GATE" >"$WORK/c7.out" 2>&1; then
  echo "case7 应失败（控制节点缺 helm）" >&2; exit 1
fi
grep -q '控制节点缺少 helm' "$WORK/c7.out"
PATH="$NOHELM:/usr/bin:/bin" "${BASE_ENV[@]}" \
  REMOTE_EXECUTION=1 GATE_ROLE=worker MIN_DISK_FREE_GIB=1 \
  bash "$GATE" >"$WORK/c7b.out"
grep -q '工作节点缺少 helm' "$WORK/c7b.out"
grep -q 'GATE_RESULT=PASS' "$WORK/c7b.out"
echo "PASS: 工具检查按控制/工作节点分级"

# ⑧ Secret 检查：缺失判 FAIL，命名空间不存在只 WARN
PATH="$FAKE_BIN:/usr/bin:/bin" "${BASE_ENV[@]}" \
  REMOTE_EXECUTION=1 GATE_ROLE=control MIN_DISK_FREE_GIB=1 \
  NAMESPACE=xds-ok IMAGE_PULL_SECRETS="default-secret" \
  bash "$GATE" >"$WORK/c8.out"
grep -q '镜像凭证存在: xds-ok/default-secret' "$WORK/c8.out"
if PATH="$FAKE_BIN:/usr/bin:/bin" "${BASE_ENV[@]}" \
    REMOTE_EXECUTION=1 GATE_ROLE=control MIN_DISK_FREE_GIB=1 \
    NAMESPACE=xds-ok IMAGE_PULL_SECRETS="default-secret,missing-secret" \
    bash "$GATE" >"$WORK/c8b.out" 2>&1; then
  echo "case8b 应失败（Secret 缺失）" >&2; exit 1
fi
grep -q '镜像凭证缺失: xds-ok/missing-secret' "$WORK/c8b.out"
PATH="$FAKE_BIN:/usr/bin:/bin" "${BASE_ENV[@]}" \
  REMOTE_EXECUTION=1 GATE_ROLE=control MIN_DISK_FREE_GIB=1 \
  NAMESPACE=no-such-ns IMAGE_PULL_SECRETS="default-secret" \
  bash "$GATE" >"$WORK/c8c.out"
grep -q '命名空间 no-such-ns 不存在' "$WORK/c8c.out"
grep -q 'GATE_RESULT=PASS' "$WORK/c8c.out"
echo "PASS: 镜像凭证 Secret 检查"

# ⑨ TARGET_HOSTS 逐节点下发：各自凭据、首节点为 control
CALLS_LOG="$WORK/calls.log"
: >"$CALLS_LOG"
STUB_BIN="$WORK/bin-stub"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/sshpass" <<'EOF'
#!/usr/bin/env bash
echo "sshpass $*" >>"$CALLS_LOG"
shift   # 去掉 -e，透传执行剩余命令（scp/ssh 桩）
exec "$@"
EOF
cat >"$STUB_BIN/scp" <<'EOF'
#!/usr/bin/env bash
echo "scp $*" >>"$CALLS_LOG"
exit 0
EOF
cat >"$STUB_BIN/ssh" <<'EOF'
#!/usr/bin/env bash
echo "ssh $*" >>"$CALLS_LOG"
exit 0
EOF
chmod +x "$STUB_BIN"/*
PATH="$STUB_BIN:/usr/bin:/bin" CALLS_LOG="$CALLS_LOG" "${BASE_ENV[@]}" \
  IMAGE_NAME="reg/xds" \
  TARGET_HOSTS='[{"ip":"10.0.0.1","user":"root","pass":"p1"},{"ip":"10.0.0.2","user":"ops"}]' \
  TARGET_PASSWORD="fallback-pw" \
  bash "$GATE" >"$WORK/c9.out"
grep -q 'GATE_RESULT=PASS' "$WORK/c9.out"
grep -q 'sshpass -e ssh .*root@10.0.0.1 env .*GATE_ROLE=control' "$CALLS_LOG"
grep -q 'sshpass -e ssh .*ops@10.0.0.2 env .*GATE_ROLE=worker' "$CALLS_LOG"
echo "PASS: TARGET_HOSTS 逐节点凭据与 control/worker 角色下发"

echo "PASS: check-deploy-gate 全部契约用例通过"
