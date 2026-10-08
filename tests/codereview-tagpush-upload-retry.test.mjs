// codereview「编译发行」Tag 兜底推送与产物上传脚本的网络抖动重试：
// PUSH_TAG_SCRIPT 浅克隆与 git push 按 GIT_CLONE_RETRIES（默认 3）递增退避重试
// （克隆每次失败先清理半截克隆目录，推送重试不清理目录）；
// UPLOAD_ASSETS_SCRIPT 每个文件的「获取上传地址 GET / PUT 直传 OBS」按 UPLOAD_RETRIES（默认 3）
// 逐文件重试（重试循环嵌在 while IFS= read -r f 循环体内）；
// 两段 net_hint 除保留 CONNECT tunnel 提示外，同时识别 Failed to connect / Couldn't connect /
// Connection timed out / Connection refused / Operation timed out 并给出中文提示。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../projects/codereview/code-review-prs.html', import.meta.url), 'utf8')

/* 抽取 JS 字符串数组形式的内嵌 bash 脚本（var NAME = [ ... ].join("\n");），经 vm 求值还原为脚本文本 */
function scriptText(name) {
  const start = source.indexOf('var ' + name + ' = [')
  assert.ok(start >= 0, '缺少脚本数组 ' + name)
  const tail = '].join("\\n");'
  const end = source.indexOf(tail, start)
  assert.ok(end >= 0, '脚本数组 ' + name + ' 缺少 ].join 结尾')
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(source.slice(start, end + tail.length), ctx)
  return ctx[name]
}

const PUSH_TAG = scriptText('PUSH_TAG_SCRIPT')
const UPLOAD = scriptText('UPLOAD_ASSETS_SCRIPT')

/* 断言 cmd 位于某个「while :; do … done」重试循环内，返回该循环体文本 */
function retryLoopOf(script, cmd, label) {
  const idx = script.indexOf(cmd)
  assert.ok(idx >= 0, label + '：缺少命令 ' + cmd)
  const loopStart = script.lastIndexOf('while :; do', idx)
  const loopEnd = script.indexOf('done', idx)
  assert.ok(loopStart >= 0 && loopEnd > idx, label + '：命令须位于重试循环内：' + cmd)
  return script.slice(loopStart, loopEnd)
}

/* 重试循环的公共形态：成功 break、每次失败脱敏回显 + net_hint、递增退避、最后一次 fail */
function assertRetryShape(loop, label) {
  assert.ok(loop.includes('&& break'), label + '：成功应跳出重试循环')
  assert.ok(loop.includes('| mask >&2; net_hint'), label + '：每次失败应先脱敏回显并输出网络诊断')
  assert.ok(loop.includes('sleep $((i*5))'), label + '：重试应递增退避')
  assert.ok(loop.includes('fail "'), label + '：最后一次失败应 fail 退出')
}

/* 断言 cmd 的重试循环嵌在「while IFS= read -r f」逐文件循环体内（重试逐文件生效） */
function assertPerFile(script, cmd, label) {
  const idx = script.indexOf(cmd)
  const fileLoopStart = script.lastIndexOf('while IFS= read -r f', idx)
  const fileLoopEnd = script.indexOf('done < <(find', idx)
  assert.ok(fileLoopStart >= 0 && fileLoopEnd > idx, label + '：命令须位于逐文件循环体内')
  assert.ok(script.lastIndexOf('while :; do', idx) > fileLoopStart, label + '：重试循环须嵌在逐文件循环体内')
}

test('PUSH_TAG_SCRIPT：浅克隆按 GIT_CLONE_RETRIES（默认 3）重试，每次失败清理克隆目录', () => {
  assert.match(PUSH_TAG, /\$\{GIT_CLONE_RETRIES:-3\}/, '应含 GIT_CLONE_RETRIES 默认 3')
  assert.match(PUSH_TAG, /# .*GIT_CLONE_RETRIES（默认 3）/, '头注释应补 GIT_CLONE_RETRIES 说明')
  const loop = retryLoopOf(PUSH_TAG, 'out=$(git clone --quiet --depth 1', '克隆')
  assertRetryShape(loop, '克隆')
  assert.ok(loop.includes('rm -rf "$TMPD/repo"'), '克隆：每次重试前应清理半截克隆目录')
  assert.ok(loop.includes('fail "克隆失败'), '克隆：保留原失败语义的 fail')
})

test('PUSH_TAG_SCRIPT：git push 同样带重试（不清理目录）', () => {
  const loop = retryLoopOf(PUSH_TAG, 'out=$(git push --quiet origin "refs/tags/${RELEASE_TAG}"', '推送')
  assertRetryShape(loop, '推送')
  assert.ok(!loop.includes('rm -rf'), '推送：重试不需要清理目录')
  assert.ok(loop.includes('fail "推送 Tag 失败'), '推送：保留原失败语义的 fail')
})

test('UPLOAD_ASSETS_SCRIPT：获取上传地址 GET 逐文件重试（UPLOAD_RETRIES 默认 3）', () => {
  assert.match(UPLOAD, /\$\{UPLOAD_RETRIES:-3\}/, '应含 UPLOAD_RETRIES 默认 3')
  assert.match(UPLOAD, /# .*UPLOAD_RETRIES（默认 3）/, '头注释应补 UPLOAD_RETRIES 说明')
  const loop = retryLoopOf(UPLOAD, 'resp=$(curl -sS -f -G', '获取上传地址')
  assertRetryShape(loop, '获取上传地址')
  assert.ok(loop.includes('fail "获取上传地址失败'), '获取上传地址：保留原失败语义的 fail')
  assertPerFile(UPLOAD, 'resp=$(curl -sS -f -G', '获取上传地址')
})

test('UPLOAD_ASSETS_SCRIPT：PUT 直传 OBS 逐文件重试', () => {
  const loop = retryLoopOf(UPLOAD, 'out=$(curl -sS -f -X PUT -T "$f"', 'PUT 直传')
  assertRetryShape(loop, 'PUT 直传')
  assert.ok(loop.includes('fail "上传失败'), 'PUT 直传：保留原失败语义的 fail')
  assertPerFile(UPLOAD, 'out=$(curl -sS -f -X PUT -T "$f"', 'PUT 直传')
})

test('两段脚本 net_hint 均识别连接失败/超时并保留 CONNECT tunnel 提示', () => {
  for (const [name, script] of [['PUSH_TAG_SCRIPT', PUSH_TAG], ['UPLOAD_ASSETS_SCRIPT', UPLOAD]]) {
    assert.ok(script.includes('CONNECT tunnel failed'), name + '：保留 CONNECT tunnel 分支')
    assert.ok(script.includes('CONNECT 隧道被代理拒绝'), name + '：保留 CONNECT 隧道中文提示')
    for (const pat of ['Failed to connect', "Couldn't connect", 'Connection timed out', 'Connection refused', 'Operation timed out']) {
      assert.ok(script.includes(pat), name + '：net_hint 应识别「' + pat + '」')
    }
    assert.match(script, /网络抖动（与凭据无关），已自动重试/, name + '：连接失败应提示网络抖动且与凭据无关')
    assert.ok(script.includes('「构建网络代理」改为「直连」或「自定义代理」'), name + '：应提示可在设置页调整构建网络代理')
  }
})
