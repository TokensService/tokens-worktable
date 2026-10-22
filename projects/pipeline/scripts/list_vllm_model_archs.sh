#!/usr/bin/env bash
# list_vllm_model_archs.sh —— 部署策略来源脚本（代码仓设置选「策略·脚本」）：
# 列出 vLLM 仓库 model_arch.yaml 中注册的全部部署策略 arch_name，stdout 每行一个
# （输出契约见 README「部署策略脚本」：去空白、跳过空行、按序去重；非零退出视为失败）。
#
# 环境变量：
#   GIT_BRANCH（必填）    当前分支，如 v0.30.0.tokens
#   GIT_URL（按需）       仓库地址；github.com 仓库据此推导 raw 地址，其他远端走 git 浅克隆兜底
#   GIT_USER/GIT_PASSWORD  可选；公开仓库留空，非空时 raw 拉取与克隆均携带凭据
#   MODEL_ARCH_PATH       model_arch.yaml 在仓库内的路径
#                         （默认 examples/disaggregated/tokens_native_pd/model_arch.yaml）
#   MODEL_ARCH_URL        完整 raw 地址直指定（支持 {branch} 占位），优先级最高
set -euo pipefail

SCRIPT_NAME='list_vllm_model_archs.sh'

if (($# != 0)); then
  echo "[$SCRIPT_NAME] ERROR: 不支持命令行参数；请使用环境变量配置" >&2
  exit 2
fi
[[ -n "${GIT_BRANCH:-}" ]] || { echo "GIT_BRANCH is required" >&2; exit 2; }

MODEL_ARCH_PATH="${MODEL_ARCH_PATH:-examples/disaggregated/tokens_native_pd/model_arch.yaml}"
MODEL_ARCH_URL="${MODEL_ARCH_URL:-}"

die() { echo "[$SCRIPT_NAME] ERROR: $*" >&2; exit 1; }

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/vllm-model-archs.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

# ---- 解析 raw 地址：显式 MODEL_ARCH_URL 优先，其次按 github.com 的 GIT_URL 推导 ----
raw_url=''
api_url=''
if [[ -n "$MODEL_ARCH_URL" ]]; then
  raw_url="${MODEL_ARCH_URL//\{branch\}/$GIT_BRANCH}"
elif [[ -n "${GIT_URL:-}" ]]; then
  # github.com 仓库（https / ssh、可带 .git 后缀）推导 raw 地址；其余远端留空走克隆兜底
  gh_slug="${GIT_URL%.git}"
  gh_slug="${gh_slug%/}"
  case "$gh_slug" in
    https://github.com/*|http://github.com/*) gh_slug="${gh_slug#*github.com/}" ;;
    git@github.com:*)                        gh_slug="${gh_slug#git@github.com:}" ;;
    *)                                       gh_slug='' ;;
  esac
  # slug 必须恰为 org/repo 两段
  if [[ -n "$gh_slug" && "$gh_slug" == */* && "${gh_slug#*/}" != */* ]]; then
    raw_url="https://raw.githubusercontent.com/${gh_slug}/${GIT_BRANCH}/${MODEL_ARCH_PATH}"
    # API contents 不走 CDN（raw 对新提交有分钟级滞后，会把新加的 arch 漏掉）
    api_url="https://api.github.com/repos/${gh_slug}/contents/${MODEL_ARCH_PATH}?ref=${GIT_BRANCH}"
  fi
fi

arch_file=''
if [[ -n "$raw_url" ]]; then
  # ---- raw 拉取（github 公开仓库零凭据可用，秒级）----
  command -v curl >/dev/null 2>&1 || die "未找到 curl，且 GIT_URL 非 github.com 无法推导克隆地址"
  auth_args=()
  [[ -n "${GIT_PASSWORD:-}" ]] && auth_args=(-H "Authorization: Bearer ${GIT_PASSWORD}")
  fetched=''
  if [[ -n "${api_url:-}" ]] && curl -fsSL --max-time 20 ${auth_args[@]+"${auth_args[@]}"} \
       -H 'Accept: application/vnd.github.raw' "$api_url" -o "$work_dir/model_arch.yaml"; then
    fetched='api'
  elif curl -fsSL --max-time 20 ${auth_args[@]+"${auth_args[@]}"} "$raw_url" -o "$work_dir/model_arch.yaml"; then
    fetched='raw'
  fi
  [[ -n "$fetched" ]] || die "拉取 model_arch.yaml 失败：${api_url:-$raw_url}"
  arch_file="$work_dir/model_arch.yaml"
else
  # ---- 兜底：git 浅克隆（任意远端，含私有镜像；凭据经 GIT_ASKPASS 注入）----
  [[ -n "${GIT_URL:-}" ]] || { echo "GIT_URL is required" >&2; exit 2; }
  command -v git >/dev/null 2>&1 || die "未找到 git，且无法按 GIT_URL 推导 raw 地址：${GIT_URL}"
  if [[ -n "${GIT_USER:-}" && -n "${GIT_PASSWORD:-}" ]]; then
    askpass_file="${work_dir}/git-askpass"
    cat >"$askpass_file" <<'ASKPASS'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' "${GIT_USER}" ;;
  *Password*) printf '%s\n' "${GIT_PASSWORD}" ;;
esac
ASKPASS
    chmod 700 "$askpass_file"
    export GIT_ASKPASS="$askpass_file"
  fi
  export GIT_TERMINAL_PROMPT=0
  git -c credential.helper= clone --quiet --depth 1 --branch "$GIT_BRANCH" \
    --single-branch "$GIT_URL" "$work_dir/repo" \
    || die "克隆仓库失败（分支 $GIT_BRANCH）：$GIT_URL"
  arch_file="$work_dir/repo/$MODEL_ARCH_PATH"
  [[ -f "$arch_file" ]] || die "分支 $GIT_BRANCH 中不存在 $MODEL_ARCH_PATH"
fi

# ---- 解析：stdlib 正则提取顶层 arch_name 键（命名规则 <...>-<n>P<m>D 或 <...>-<n>P，
#      拓扑后缀之后还允许跟任意 -<tag> 段，如 -6G / -PP2TP2-8G 等区分标签），
#      规避对 PyYAML 的依赖；跳过注释/缩进行/无拓扑后缀的元数据键 ----
python3 - "$arch_file" <<'PY'
import re
import sys

key_re = re.compile(r"^([A-Za-z0-9][\w.-]*):[ \t]*(?:#.*)?$")
topo_re = re.compile(r"-\d+P(?:\d+D)?(?:-[A-Za-z0-9]+)*$")

try:
    text = open(sys.argv[1], encoding="utf-8-sig").read()
except OSError as error:
    raise SystemExit(f"读取 model_arch.yaml 失败: {error}")

names = []
seen = set()
for line in text.splitlines():
    match = key_re.match(line)
    if not match:
        continue
    name = match.group(1)
    if not topo_re.search(name) or name in seen:
        continue
    seen.add(name)
    names.append(name)

if not names:
    raise SystemExit(
        "model_arch.yaml 中未找到任何部署策略（顶层 <...>-<n>P<m>D 形式的 arch_name 键）"
    )
print("\n".join(names))
PY
