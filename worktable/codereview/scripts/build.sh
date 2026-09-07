#!/usr/bin/env bash
# PR 检视台「编译发行」默认构建脚本（参考实现，可按仓库需要自行替换/扩展）。
# 由页面经 /api/worktable/exec 调用，注入环境变量：
#   GIT_URL       仓库地址（https://gitcode.com/<owner>/<repo>.git）
#   GIT_AUTH_URL  带凭据的仓库地址（页面侧已 URL 编码；本脚本不 echo 凭据）
#   GIT_BRANCH    待构建分支
#   RELEASE_TAG / RELEASE_NAME  本次发行的 Tag 与发行版名称
#   BUILD_CMD     可选构建命令（在克隆出的仓库根目录执行，如 "npm ci && npm run build"）
#   GIT_PROXY_MODE / GIT_PROXY_URL  可选代理策略（inherit=沿用进程环境，默认；direct=清空代理变量直连；custom=改用 GIT_PROXY_URL）
# 行为：浅克隆指定分支到临时目录（克隆在本机执行，OS 用户=调用进程用户）；若提供 BUILD_CMD 则执行之，否则仅做克隆校验。
set -u
fail(){ echo "✗ $*" >&2; exit 1; }
[ -n "${GIT_URL:-}" ] || fail "缺少 GIT_URL"
[ -n "${GIT_BRANCH:-}" ] || fail "缺少 GIT_BRANCH"
CLONE_URL="${GIT_AUTH_URL:-$GIT_URL}"
mask(){ sed -e "s#${CLONE_URL}#<repo>#g"; }
# 代理策略：继承（默认）/ 直连 / 自定义；代理地址回显前脱敏 userinfo
maskurl(){ sed -E "s#(://)[^/@]+@#\1***@#g"; }
case "${GIT_PROXY_MODE:-inherit}" in
  direct) unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; echo "… 网络代理：直连（已清空继承的 http_proxy/https_proxy 等代理变量）" ;;
  custom) [ -n "${GIT_PROXY_URL:-}" ] || fail "GIT_PROXY_MODE=custom 但缺少 GIT_PROXY_URL"; export http_proxy="$GIT_PROXY_URL" https_proxy="$GIT_PROXY_URL" HTTP_PROXY="$GIT_PROXY_URL" HTTPS_PROXY="$GIT_PROXY_URL"; echo "… 网络代理：自定义代理 $(printf '%s' "$GIT_PROXY_URL" | maskurl)" ;;
  *) echo "… 网络代理：继承进程环境（http_proxy=$(printf '%s' "${http_proxy:-未设置}" | maskurl)）" ;;
esac
# 网络失败诊断：CONNECT tunnel failed 是 HTTP 代理拒绝建立隧道（代理侧故障，与证书/凭据无关）
net_hint(){ printf '%s' "$1" | grep -q "CONNECT tunnel failed" || return 0; echo "… 提示：CONNECT 隧道被代理拒绝（代理侧故障，与证书/令牌无关）。当前 http_proxy=$(printf '%s' "${http_proxy:-未设置}" | maskurl)；可改用 GIT_PROXY_MODE=direct 直连或修正代理服务后重试" >&2; }
TMPD=$(mktemp -d); trap 'rm -rf "$TMPD"' EXIT
echo "→ 浅克隆分支 ${GIT_BRANCH} …（本机执行，OS 用户 $(id -un 2>/dev/null || echo unknown)）"
out=$(git clone --quiet --depth 1 --branch "${GIT_BRANCH}" "${CLONE_URL}" "$TMPD/repo" 2>&1) || { printf '%s\n' "$out" | mask >&2; net_hint "$out"; fail "克隆失败（检查分支名/凭据/网络）"; }
cd "$TMPD/repo" || exit 1
echo "✓ 克隆完成：$(git log -1 --format='%h %s' 2>/dev/null || echo unknown)"
if [ -n "${BUILD_CMD:-}" ]; then
  echo "→ 执行构建命令：${BUILD_CMD}"
  bash -c "${BUILD_CMD}" || fail "构建命令执行失败（退出码 $?）"
  echo "✓ 构建命令执行成功"
else
  echo "… 未提供 BUILD_CMD，仅完成克隆校验（如需编译请设置构建命令或替换本脚本）"
fi
echo "✓ 构建阶段完成${RELEASE_TAG:+：$RELEASE_TAG}"
