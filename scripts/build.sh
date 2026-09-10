#!/usr/bin/env bash
# tokens-worktable 仓内构建脚本——供 PR 检视台（projects/codereview）「编译发行」页选用，也可本机直接执行。
# 契约：页面包装脚本已浅克隆所选分支，并在克隆出的仓库根目录以 bash 执行本脚本（cwd=仓库根，
# 配置构建容器时挂载到 /mnt/repo 执行，契约相同）；注入环境变量（本脚本均有就地默认，单独运行亦可）：
#   GIT_BRANCH    待构建分支（仅回显）
#   RELEASE_TAG / RELEASE_NAME  本次发行的 Tag 与发行版名称
#   BUILD_CMD     可选自定义构建命令（非空时替代默认的 node build.mjs）
#   SKIP_VERSION_CHECK=1  跳过 RELEASE_TAG 与 package.json version 一致性校验
#   SKIP_TESTS=1  跳过测试；FULL_TESTS=1 改跑完整 npm test（含 projects/ 的 shell / python 用例）
# 行为：版本一致性校验（RELEASE_TAG 主版本段 = package.json version = dsh.plugin.json version）→
#   依赖就绪（本仓 node_modules 已随 git 跟踪，浅克隆即可用，缺失时才 npm ci）→ 构建 →
#   node --check 产物语法校验 → 测试 → npm pack 打包为 dist/tokens-worktable.tgz
#   （文件名固定，对应 README 安装地址 releases/latest/download/tokens-worktable.tgz）。
# 发行页「产物路径」配置 dist/*.tgz 即可把安装包上传为发行版附件。
set -eu
fail(){ echo "✗ $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "未找到 node（构建目标 node22，请使用 Node ≥ 18 的环境/镜像）"
command -v npm  >/dev/null 2>&1 || fail "未找到 npm"
nodeMajor=$(node -p 'process.versions.node.split(".")[0]')
[ "$nodeMajor" -ge 18 ] 2>/dev/null || fail "Node 版本过低（$(node -v)）：构建目标 node22，请使用 Node ≥ 18"
[ -f package.json ] && [ -f build.mjs ] || fail "请在 tokens-worktable 仓库根目录执行本脚本"

echo "→ tokens-worktable 编译发行构建（分支 ${GIT_BRANCH:-未知}，Tag ${RELEASE_TAG:-未指定}，Node $(node -v)）"

# —— 版本一致性：两处 version 相等，且 RELEASE_TAG（vllm 风格 vX.Y.Z[rcN|.postN|.devN]）主版本段与之相等 ——
pkgVer=$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version')
pluginVer=$(node -p 'JSON.parse(require("fs").readFileSync("dsh.plugin.json","utf8")).version')
[ "$pkgVer" = "$pluginVer" ] || fail "package.json version（$pkgVer）!= dsh.plugin.json version（$pluginVer）——发版前先统一两处版本号"
if [ -n "${RELEASE_TAG:-}" ] && [ "${SKIP_VERSION_CHECK:-}" != "1" ]; then
  tagVer=$(printf '%s' "$RELEASE_TAG" | sed -E 's/^v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
  [ "$tagVer" = "$pkgVer" ] || fail "RELEASE_TAG（$RELEASE_TAG → $tagVer）与 package.json version（$pkgVer）不一致——先 bump 版本号再发行（或设 SKIP_VERSION_CHECK=1 跳过）"
  echo "✓ 版本一致：$RELEASE_TAG ↔ $pkgVer"
fi

# —— 依赖：node_modules 已随仓跟踪（linux-x64），浅克隆即就绪；缺失时再 npm ci ——
if [ -x node_modules/.bin/esbuild ]; then
  echo "… 依赖已随仓就绪（node_modules 已跟踪），跳过 npm ci"
else
  echo "→ 安装依赖：npm ci …"
  npm ci || fail "npm ci 失败（检查网络 / NPM 镜像源，可经设置页「附加环境变量」注入 npm_config_registry）"
fi

# —— 构建：默认 node build.mjs；注入 BUILD_CMD 时改跑自定义命令 ——
if [ -n "${BUILD_CMD:-}" ]; then
  echo "→ 执行自定义构建命令：${BUILD_CMD}"
  bash -c "${BUILD_CMD}" || fail "构建命令执行失败（退出码 $?）"
else
  echo "→ 构建：node build.mjs …"
  node build.mjs || fail "node build.mjs 构建失败（退出码 $?）"
fi
[ -f lib/index.js ] && [ -f lib/client.js ] || fail "构建产物缺失：lib/index.js / lib/client.js"
node --check lib/index.js && node --check lib/client.js || fail "构建产物语法校验失败"
echo "✓ 构建完成：lib/index.js + lib/client.js"

# —— 测试：默认跑插件 node 用例；FULL_TESTS=1 跑完整 npm test；SKIP_TESTS=1 跳过 ——
if [ "${SKIP_TESTS:-}" = "1" ]; then
  echo "… SKIP_TESTS=1，跳过测试"
elif [ "${FULL_TESTS:-}" = "1" ]; then
  echo "→ 运行完整测试：npm test …"
  npm test || fail "完整测试失败（退出码 $?）"
  echo "✓ 完整测试通过"
else
  echo "→ 运行插件测试：node --test tests/*.test.mjs …"
  node --test tests/*.test.mjs || fail "插件测试失败（退出码 $?）"
  echo "✓ 插件测试通过"
fi

# —— 打包：npm pack 按 package.json files 收集发布文件，重命名为固定文件名 tokens-worktable.tgz ——
mkdir -p dist
echo "→ 打包发行安装包：npm pack …"
npm pack --pack-destination dist >/dev/null || fail "npm pack 打包失败（退出码 $?）"
packs=( dist/tokens-worktable-*.tgz )
[ -f "${packs[0]}" ] || fail "npm pack 未产出 dist/tokens-worktable-*.tgz"
mv -f "${packs[0]}" dist/tokens-worktable.tgz
tar -tzf dist/tokens-worktable.tgz | grep -q 'package/lib/client.js' || fail "安装包内容校验失败：缺少 lib/client.js"
echo "✓ 安装包就绪：dist/tokens-worktable.tgz（$(du -h dist/tokens-worktable.tgz | cut -f1)）"

echo "✓ 构建阶段全部完成${RELEASE_TAG:+：$RELEASE_TAG}（发行页「产物路径」配置 dist/*.tgz 即可随发行版上传）"
