#!/usr/bin/env bash
# list_vllm_model_archs.sh 契约测试：
#   - git 浅克隆兜底（file:// 本地仓）：按序去重输出合法 arch_name，过滤无拓扑后缀的顶层键
#   - MODEL_ARCH_URL 直指定（file:// + {branch} 占位）：raw 拉取路径
#   - github.com GIT_URL 推导地址：API contents 优先、raw 兜底（fake curl 拦截断言 URL 与调用顺序）
#   - 拓扑后缀后可跟 -<tag> 段：-6G / -PP2TP2-8G 等命名也能解析
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
GLM-5.3-NVFP4-NVIDIA-BNT3-1P1D-6G:
  description: 拓扑后缀后带 GPU 数标签
GLM-5.3-NVFP4-NVIDIA-BNT3-1P1D-PP2TP2-8G:
  description: 拓扑后缀后带并行策略与 GPU 数标签
META_REGISTRY_NOTE:
  x: 1
GLM-5.2-W4A4C8-MG40-BNT3-1P1D:
  description: duplicate
YAML
EXPECTED="$WORK/expected"
printf 'GLM-5.2-W4A4C8-MG40-BNT3-1P1D\nGLM-5.2-W4A4C8-EMS-3P1D\nGLM-5.3-NVFP4-NVIDIA-BNT3-1P1D-6G\nGLM-5.3-NVFP4-NVIDIA-BNT3-1P1D-PP2TP2-8G\n' >"$EXPECTED"

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

# ---- 3. github.com GIT_URL 推导地址（fake curl 拦截：API contents 优先、raw 兜底）----
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/curl" <<EOF
#!/usr/bin/env bash
out=''; url=''
while (( \$# )); do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    -H|--max-time) shift 2 ;;   # 带值选项整体跳过，避免把其值当成 URL
    -*) shift ;;
    *)  url="\$1"; shift ;;
  esac
done
printf '%s\n' "\$url" >>"$WORK/curl-urls"
case "\$url" in
  # FAIL_API=1 时模拟 api.github.com 失败，用以验证 raw 兜底分支
  *api.github.com*) [[ -n "\${FAIL_API:-}" ]] && exit 22 ;;
esac
cp "$FIXTURE" "\$out"
EOF
chmod +x "$FAKE_BIN/curl"

# 预期地址：api 走 contents API（raw 对新提交有 CDN 滞后，会把新加的 arch 漏掉），raw 作兜底
API_URL='https://api.github.com/repos/TokensService/vllm/contents/examples/disaggregated/tokens_native_pd/model_arch.yaml?ref=v0.30.0.tokens'
RAW_URL='https://raw.githubusercontent.com/TokensService/vllm/v0.30.0.tokens/examples/disaggregated/tokens_native_pd/model_arch.yaml'

for gh_url in 'https://github.com/TokensService/vllm' 'git@github.com:TokensService/vllm.git'; do
  rm -f "$WORK/curl-urls"
  PATH="$FAKE_BIN:$PATH" GIT_BRANCH=v0.30.0.tokens \
    GIT_URL="$gh_url" GIT_USER='' GIT_PASSWORD='' \
    bash "$ROOT/list_vllm_model_archs.sh" >"$WORK/out-gh"
  cmp "$EXPECTED" "$WORK/out-gh"
  cmp <(printf '%s\n' "$API_URL") "$WORK/curl-urls"
done

rm -f "$WORK/curl-urls"
PATH="$FAKE_BIN:$PATH" FAIL_API=1 GIT_BRANCH=v0.30.0.tokens \
  GIT_URL='https://github.com/TokensService/vllm' GIT_USER='' GIT_PASSWORD='' \
  bash "$ROOT/list_vllm_model_archs.sh" >"$WORK/out-gh-raw"
cmp "$EXPECTED" "$WORK/out-gh-raw"
cmp <(printf '%s\n%s\n' "$API_URL" "$RAW_URL") "$WORK/curl-urls"
echo 'PASS: github.com GIT_URL（https / ssh / .git 后缀）API contents 优先、raw 兜底'

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
