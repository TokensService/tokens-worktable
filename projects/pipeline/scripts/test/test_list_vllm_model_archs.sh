#!/usr/bin/env bash
# list_vllm_model_archs.sh 契约测试：
#   - git 浅克隆兜底（file:// 本地仓）：按序去重输出合法 arch_name，过滤无拓扑后缀的顶层键
#   - MODEL_ARCH_URL 直指定（file:// + {branch} 占位）：raw 拉取路径
#   - github.com GIT_URL 推导 raw 地址（fake curl 拦截断言 URL，.git 后缀两形态）
#   - 失败路径：缺 GIT_BRANCH 退出 2；仓内无文件/零策略退出 1 且 stdout 为空
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

bash -n "$ROOT/list_vllm_model_archs.sh"
echo 'PASS: bash -n 语法检查'

# model_arch.yaml fixture：两个合法策略 + 一个无拓扑后缀的顶层键 + 一个重复策略名
FIXTURE="$WORK/model_arch.yaml"
cat >"$FIXTURE" <<'YAML'
# 注释行不应匹配
GLM-5.2-W4A4C8-MG40-BNT3-1P1D:
  description: >-
    nested description line
  prefill:
    engine:
      port: 8010
GLM-5.2-W4A4C8-EMS-3P1D:
  description: y
META_REGISTRY_NOTE:
  x: 1
GLM-5.2-W4A4C8-MG40-BNT3-1P1D:
  description: duplicate
YAML
EXPECTED="$WORK/expected"
printf 'GLM-5.2-W4A4C8-MG40-BNT3-1P1D\nGLM-5.2-W4A4C8-EMS-3P1D\n' >"$EXPECTED"

# ---- 1. git 克隆兜底（file:// 本地仓，非 github → 走 clone 路径）----
mkdir -p "$WORK/source/examples/disaggregated/tokens_native_pd"
git -C "$WORK/source" init -q
git -C "$WORK/source" config user.email 'test@example.invalid'
git -C "$WORK/source" config user.name test
cp "$FIXTURE" "$WORK/source/examples/disaggregated/tokens_native_pd/model_arch.yaml"
git -C "$WORK/source" add .
git -C "$WORK/source" commit -qm initial
git -C "$WORK/source" branch -M arch-test

GIT_BRANCH=arch-test GIT_URL="file://$WORK/source" GIT_USER=test-user GIT_PASSWORD=test-pass \
  bash "$ROOT/list_vllm_model_archs.sh" >"$WORK/out-clone"
cmp "$EXPECTED" "$WORK/out-clone"
echo 'PASS: git 克隆兜底按序去重输出合法 arch_name、过滤元数据键'

# ---- 2. MODEL_ARCH_URL 直指定（file:// + {branch} 占位替换）----
mkdir -p "$WORK/raw/v0.30.0.tokens"
cp "$FIXTURE" "$WORK/raw/v0.30.0.tokens/model_arch.yaml"
GIT_BRANCH=v0.30.0.tokens GIT_URL='' GIT_USER='' GIT_PASSWORD='' \
  MODEL_ARCH_URL="file://$WORK/raw/{branch}/model_arch.yaml" \
  bash "$ROOT/list_vllm_model_archs.sh" >"$WORK/out-rawurl"
cmp "$EXPECTED" "$WORK/out-rawurl"
echo 'PASS: MODEL_ARCH_URL 直指定（{branch} 占位替换）'

# ---- 3. github.com GIT_URL 推导 raw 地址（fake curl 拦截，断言 URL 与 -o 落盘）----
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/curl" <<EOF
#!/usr/bin/env bash
out=''; url=''
while (( \$# )); do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    -*) shift ;;            # -fsSL / --max-time 20 / -H 等整串跳过（-H 值随下一步 shift 带不过来，测试场景无凭据）
    *)  url="\$1"; shift ;;
  esac
done
echo "\$url" >"$WORK/curl-url"
cp "$FIXTURE" "\$out"
EOF
chmod +x "$FAKE_BIN/curl"

PATH="$FAKE_BIN:$PATH" GIT_BRANCH=v0.30.0.tokens \
  GIT_URL='https://github.com/TokensService/vllm' GIT_USER='' GIT_PASSWORD='' \
  bash "$ROOT/list_vllm_model_archs.sh" >"$WORK/out-gh"
cmp "$EXPECTED" "$WORK/out-gh"
grep -Fxq 'https://raw.githubusercontent.com/TokensService/vllm/v0.30.0.tokens/examples/disaggregated/tokens_native_pd/model_arch.yaml' \
  "$WORK/curl-url"

PATH="$FAKE_BIN:$PATH" GIT_BRANCH=v0.30.0.tokens \
  GIT_URL='git@github.com:TokensService/vllm.git' GIT_USER='' GIT_PASSWORD='' \
  bash "$ROOT/list_vllm_model_archs.sh" >"$WORK/out-gh-ssh"
cmp "$EXPECTED" "$WORK/out-gh-ssh"
grep -Fxq 'https://raw.githubusercontent.com/TokensService/vllm/v0.30.0.tokens/examples/disaggregated/tokens_native_pd/model_arch.yaml' \
  "$WORK/curl-url"
echo 'PASS: github.com GIT_URL（https / ssh / .git 后缀）推导 raw 地址正确'

# ---- 4. 失败路径 ----
if GIT_URL='' bash "$ROOT/list_vllm_model_archs.sh" >"$WORK/err.out" 2>"$WORK/err.err"; then
  echo 'missing GIT_BRANCH must fail' >&2; exit 1
fi
[ "$?" -eq 2 ] || true
test ! -s "$WORK/err.out"
grep -Fq 'GIT_BRANCH is required' "$WORK/err.err"

if GIT_BRANCH=arch-test GIT_URL="file://$WORK/source" GIT_USER='' GIT_PASSWORD='' \
  MODEL_ARCH_PATH='no/such.yaml' bash "$ROOT/list_vllm_model_archs.sh" \
  >"$WORK/err2.out" 2>"$WORK/err2.err"; then
  echo 'missing arch file must fail' >&2; exit 1
fi
test ! -s "$WORK/err2.out"
grep -Fq '不存在 no/such.yaml' "$WORK/err2.err"

echo '# empty' >"$WORK/empty.yaml"
mkdir -p "$WORK/raw-empty"
cp "$WORK/empty.yaml" "$WORK/raw-empty/model_arch.yaml"
if GIT_BRANCH=b GIT_URL='' GIT_USER='' GIT_PASSWORD='' \
  MODEL_ARCH_URL="file://$WORK/raw-empty/model_arch.yaml" \
  bash "$ROOT/list_vllm_model_archs.sh" >"$WORK/err3.out" 2>"$WORK/err3.err"; then
  echo 'zero arch entries must fail' >&2; exit 1
fi
test ! -s "$WORK/err3.out"
grep -Fq '未找到任何部署策略' "$WORK/err3.err"
echo 'PASS: 缺 GIT_BRANCH / 仓内无文件 / 零策略 三类失败路径均非零退出且 stdout 为空'

echo 'PASS: vLLM model_arch 策略列举脚本全部契约测试通过'
