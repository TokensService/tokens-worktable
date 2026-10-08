// codereview「编译发行」包装脚本（BUILD_WRAP_SCRIPT）的浅克隆自动重试与网络失败诊断：
// 克隆循环次数经 GIT_CLONE_RETRIES 注入（默认 3），每次重试前清理克隆目标目录、按次数递增退避；
// net_hint 在 CONNECT tunnel failed 之外，新增识别 Failed to connect / Couldn't connect /
// Connection timed out / Connection refused / Operation timed out 等一次性连接失败并给出中文提示。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'

const source = await readFile(new URL('../projects/codereview/code-review-prs.html', import.meta.url), 'utf8')

/* 抽取 var <name> = [ ... ].join("\n") 并在 vm 中求值，得到生成的 shell 脚本文本 */
function scriptSource(name) {
  const marker = 'var ' + name + ' = ['
  const start = source.indexOf(marker)
  assert.ok(start >= 0, '缺少脚本数组 ' + name)
  const endMark = '].join("\\n");'
  const end = source.indexOf(endMark, start)
  assert.ok(end > start, '脚本数组 ' + name + ' 缺少 ' + endMark + ' 收尾')
  const literal = source.slice(start + ('var ' + name + ' = ').length, end + 1)
  const ctx = vm.createContext({})
  return vm.runInContext(literal + '.join("\\n")', ctx)
}

const buildScript = scriptSource('BUILD_WRAP_SCRIPT')

test('浅克隆自动重试：GIT_CLONE_RETRIES 默认 3、重试前清理目标目录、递增退避、末次才 fail', () => {
  assert.ok(buildScript.includes('GIT_CLONE_RETRIES'), '应支持注入 GIT_CLONE_RETRIES 调整重试次数')
  assert.ok(buildScript.includes('${GIT_CLONE_RETRIES:-3}'), '重试次数默认 3')
  assert.ok(buildScript.includes('while :; do'), '应存在重试循环')
  assert.ok(buildScript.includes('rm -rf "$TMPD/repo"'), '每次重试前应清理克隆目标目录（git clone 要求目标不存在/为空）')
  assert.ok(buildScript.includes('sleep $((clone_i*5))'), '第 i 次失败后应递增退避 sleep')
  assert.ok(buildScript.includes('克隆失败（第 $clone_i/$CLONE_RETRIES 次），等待'), '重试前应有中文进度提示')
  assert.ok(buildScript.includes('fail "克隆失败（已重试 $CLONE_RETRIES 次，检查分支名/凭据/网络）"'), '最后一次失败才 fail')
  assert.ok(buildScript.includes('printf "%s\\n" "$out" | mask >&2; net_hint "$out"'), '每次失败仍回显脱敏日志并经 net_hint 诊断')
  assert.ok(source.includes('浅克隆失败自动重试（GIT_CLONE_RETRIES，默认 3 次'), '数组前的 JS 注释块应同步说明自动重试')
})

test('net_hint 覆盖一次性连接失败模式（源码断言）', () => {
  assert.ok(buildScript.includes('Failed to connect|Couldn.t connect|Connection timed out|Connection refused|Operation timed out'),
    'net_hint 应识别 Failed to connect / Couldn\'t connect / Connection timed out / Connection refused / Operation timed out')
  assert.ok(buildScript.includes('CONNECT tunnel failed'), '原 CONNECT tunnel failed 识别仍在')
})

/* 从生成脚本中按花括号配平抽取 net_hint 函数体，打桩 mask/maskurl 后经 bash 实跑做行为断言 */
function extractShellFn(script, name) {
  const fnStart = script.indexOf(name + '(){')
  assert.ok(fnStart >= 0, '生成脚本中缺少函数 ' + name)
  let depth = 0
  for (let i = script.indexOf('{', fnStart); i < script.length; i += 1) {
    if (script[i] === '{') depth += 1
    if (script[i] === '}') depth -= 1
    if (depth === 0) return script.slice(fnStart, i + 1)
  }
  assert.fail('函数 ' + name + ' 缺少闭合括号')
}

function runNetHint(out) {
  const harness = 'mask(){ cat; }; maskurl(){ cat; }\n' + extractShellFn(buildScript, 'net_hint') + '\nnet_hint "$1" 2>&1'
  return execFileSync('bash', ['-c', harness, 'net_hint', out], { encoding: 'utf8' })
}

test('net_hint 行为：一次性连接失败提示对端不可达/网络抖动（与凭据无关）并建议代理设置', () => {
  const cases = [
    "fatal: unable to access 'https://github.com/TokensService/tokens-worktable.git/': Failed to connect to github.com port 443 after 134954 ms: Couldn't connect to server",
    "fatal: unable to access 'https://git.example/demo.git/': Failed to connect to git.example port 443: Connection timed out",
    "fatal: unable to access 'https://git.example/demo.git/': Failed to connect to git.example port 443: Connection refused",
    "fatal: unable to access 'https://git.example/demo.git/': Operation timed out after 300000 milliseconds with 0 bytes received",
  ]
  for (const out of cases) {
    const hint = runNetHint(out)
    assert.match(hint, /对端不可达或一次性网络抖动，与凭据无关/, '应说明是对端不可达/网络抖动且与凭据无关：' + out)
    assert.match(hint, /已自动重试/, '应说明脚本已自动重试：' + out)
    assert.match(hint, /构建网络代理/, '应建议在「设置」页调整构建网络代理：' + out)
  }
})

test('net_hint 行为：CONNECT tunnel failed 原提示保留，与网络无关的输出保持静默', () => {
  const tunnel = runNetHint('error: RPC failed; HTTP 500 curl 22 CONNECT tunnel failed, response 500')
  assert.match(tunnel, /CONNECT 隧道被代理拒绝/, 'CONNECT tunnel failed 的中文提示应保留')
  assert.equal(runNetHint("fatal: Authentication failed for 'https://git.example/demo.git/'"), '', '凭据类错误不应误报网络提示')
})

test('生成的 BUILD_WRAP_SCRIPT 通过 bash -n 语法校验', () => {
  execFileSync('bash', ['-n'], { input: buildScript })
})
