/**
 * 流水线页「单文件视图」加载器（CommonJS）。
 *
 * pipeline.html 的页面脚本已拆分为 projects/pipeline/js/*.js（classic script，页面按序
 * <script src> 加载），采用两阶段结构：
 *   阶段一 01-*.js … 25-*.js      只含顶层 function 声明，按功能域分组；
 *   阶段二 99-state-and-boot.js   其余全部顶层语句（状态 let/const、事件绑定、启动渲染），严格保序，
 *                                 并按页面原有分节注入 `/* ===== [state:Snn] ===== *\/` 分组标记。
 * 这样拆是运行时正确性的硬要求：本页引导期会调用散布在各功能域的函数，原单内联脚本靠函数声明
 * 整体提升成立；拆成多个 classic script 后跨文件提升消失，必须让全部声明先于任何执行代码加载。
 *
 * 但本仓大量测试沿用另一个稳定契约：把整页当成一份文本，按字符串标记
 * （如 `function scanShellRefs(src)`、`/* ---------- 详情面板 ---------- *\/`、`const PIPELINE_DEFAULT_PRESET_KEYS`）
 * indexOf + slice 出待测片段喂给 vm。这些切片假定「同一分节内的函数与状态语句在文本上相邻」。
 * 两阶段的加载顺序（先全部函数、后全部状态）会打破该 locality，令切片取到缺依赖、或多出会在
 * vm 里真的执行起来的状态语句。
 *
 * 因此本模块重建的是**按分节交错**的视图：第 n 个分节的函数声明之后紧跟该分节的状态语句
 * （用 boot 文件里的 [state:Snn] 标记与阶段一里的分节标记配对）。分节是原文的连续行区间，
 * 因此同一分节内语句的相对顺序与原文一致，切片范围与拆分前基本吻合。
 * 该视图只服务测试切片，与浏览器实际加载顺序不同；页面运行时的正确性由
 * test_page_split_integrity.js 的两阶段不变量与真机实测保证。
 *
 * 只读工具，不改任何文件。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const PIPELINE_DIR = path.join(__dirname, '..')
/** 页面里外链分片的写法：<script src="./js/xxx.js"></script>；捕获组 = 相对 pipeline/ 的路径（含 js/ 前缀） */
const SCRIPT_SRC_RE = /<script src="\.\/([^"]+)"><\/script>/g
/** 外链分片标签（整行） */
const SCRIPT_LINE_RE = /^<script src="\.\/([^"]+)"><\/script>$/
/** 分片顶部的 banner，内联时剥除 */
const BANNER_RE = /^\/\* ===== [\s\S]*? \*\/\n/
/** boot 文件里的分节分组标记 */
const STATE_MARK_RE = /^\/\* ===== \[state:S(\d+)\] ===== \*\/$/
/** 页面原有的分节标记（列首），阶段一里用它切分节 */
const SECTION_MARK_RE = /^\/\* [-=]{3,}/
/** 阶段二分片名（加载顺序里必须最后） */
const BOOT_RE = /^js\/99-/

/** 解析页面 html 路径：显式入参 > PIPELINE_HTML 环境变量 > 默认 projects/pipeline/pipeline.html */
function resolvePagePath(explicit) {
  const p = explicit || process.env.PIPELINE_HTML || path.join(PIPELINE_DIR, 'pipeline.html')
  return path.resolve(p)
}

function readShard(baseDir, rel) {
  const file = path.resolve(baseDir, rel)
  if (!fs.existsSync(file)) throw new Error(`pipeline.html 引用的分片不存在: js/${rel}`)
  const text = fs.readFileSync(file, 'utf8')
  if (!BANNER_RE.test(text)) throw new Error(`分片 js/${rel} 缺少 banner 头`)
  const body = text.replace(BANNER_RE, '')
  return body.endsWith('\n') ? body.slice(0, -1) : body
}

/** 阶段一拼接文本按「列首分节标记」切成 section 数组（每段以其标记开头） */
function splitPhase1BySection(phase1Text) {
  const lines = phase1Text.split('\n')
  const starts = []
  lines.forEach((l, i) => { if (SECTION_MARK_RE.test(l)) starts.push(i) })
  if (!starts.length) throw new Error('阶段一里找不到任何分节标记，无法重建单文件视图')
  const sections = []
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length
    sections.push(lines.slice(starts[i], end).join('\n').replace(/\n+$/, ''))
  }
  const preamble = lines.slice(0, starts[0]).join('\n').trim()
  if (preamble) throw new Error(`阶段一首个分节标记之前存在内容，无法归属：${JSON.stringify(preamble.slice(0, 80))}`)
  return sections
}

/** boot 文件按 [state:Snn] 标记切成 Map<sectionIndex, 该分节状态语句文本> */
function splitBootBySection(bootBody) {
  const groups = new Map()
  const preamble = []
  let current = null
  for (const line of bootBody.split('\n')) {
    const m = line.match(STATE_MARK_RE)
    if (m) { current = Number(m[1]); groups.set(current, []); continue }
    if (current === null) preamble.push(line)
    else groups.get(current).push(line)
  }
  const pre = preamble.join('\n').trim()
  if (pre) throw new Error(`boot 文件首个 [state:Snn] 标记之前存在内容，无法归属：${JSON.stringify(pre.slice(0, 80))}`)
  const out = new Map()
  for (const [k, v] of groups) out.set(k, v.join('\n').replace(/^\n+|\n+$/g, ''))
  return out
}

/**
 * 读取流水线页并重建「按分节交错」的单文件视图：
 * 第 n 节的函数声明 + 第 n 节的状态语句，逐节拼接（节间保持原文顺序）。
 * @param {string} [explicitHtmlPath] 显式 html 路径（默认按 resolvePagePath 解析）
 * @returns {string}
 */
function loadPageSource(explicitHtmlPath) {
  const htmlPath = resolvePagePath(explicitHtmlPath)
  const html = fs.readFileSync(htmlPath, 'utf8')
  const baseDir = path.dirname(htmlPath)
  const lines = html.split('\n')

  // 定位连续的外链 <script src> 标签块
  const idx = []
  lines.forEach((l, i) => { const m = l.match(SCRIPT_LINE_RE); if (m) idx.push({ i, rel: m[1] }) })
  if (!idx.length) return html // 未拆分（例如 PIPELINE_HTML 指向历史版本）：原样返回
  const first = idx[0].i
  const last = idx[idx.length - 1].i
  for (let k = 0; k < idx.length; k++) if (idx[k].i !== first + k) throw new Error('外链 <script> 标签不连续，无法重建单文件视图')

  const order = idx.map((x) => x.rel)
  const bootRel = order.find((r) => BOOT_RE.test(r))
  const domainRels = order.filter((r) => !BOOT_RE.test(r))
  if (!bootRel) throw new Error('未找到阶段二分片（99-*），两阶段结构被破坏')
  if (order[order.length - 1] !== bootRel) throw new Error(`阶段二分片 ${bootRel} 必须最后加载`)

  const sections = splitPhase1BySection(domainRels.map((r) => readShard(baseDir, r)).join('\n'))
  const stateGroups = splitBootBySection(readShard(baseDir, bootRel))
  for (const s of stateGroups.keys()) {
    if (s >= sections.length) throw new Error(`boot 的 [state:S${s}] 超出阶段一分节数 ${sections.length}，分组标记与分节标记已失配`)
  }

  const parts = []
  for (let i = 0; i < sections.length; i++) {
    parts.push(sections[i])
    const st = stateGroups.get(i)
    if (st) parts.push(st)
  }
  return [...lines.slice(0, first), parts.join('\n'), ...lines.slice(last + 1)].join('\n')
}

/** 页面 html 原文（不内联分片），供需要断言 html 结构本身（DOM 标记、script 标签）的测试使用 */
function loadPageHtml(explicitHtmlPath) {
  return fs.readFileSync(resolvePagePath(explicitHtmlPath), 'utf8')
}

/** 页面外链分片的文件名列表，按 html 中出现顺序（= 浏览器执行顺序） */
function listPageScripts(explicitHtmlPath) {
  const html = fs.readFileSync(resolvePagePath(explicitHtmlPath), 'utf8')
  const out = []
  for (const m of html.matchAll(SCRIPT_SRC_RE)) out.push(m[1])
  return out
}

/** 浏览器实际加载顺序的拼接视图（阶段一全部函数 → 阶段二状态与引导），用于校验运行时语义 */
function loadPageSourceInLoadOrder(explicitHtmlPath) {
  const htmlPath = resolvePagePath(explicitHtmlPath)
  const baseDir = path.dirname(htmlPath)
  return listPageScripts(htmlPath).map((rel) => readShard(baseDir, rel)).join('\n')
}

/**
 * 从 from 起扫描到「第一个配平的 `}`」，返回该 `}` 的下标。
 * 跳过字符串、模板串与注释；正则字面量按「前一个有效字符不是标识符/数字/)]} 」的常用启发式识别
 * （页面源码里存在 /[{]/ 这类含花括号的正则，朴素计数会误判为未配平）。
 */
function scanBlockEnd(src, from) {
  let depth = 0, inStr = null, inLine = false, inBlock = false, inRe = false
  let prevSignificant = ''
  for (let i = from; i < src.length; i += 1) {
    const c = src[i], n = src[i + 1]
    if (inLine) { if (c === '\n') inLine = false; continue }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 1 } continue }
    if (inStr) {
      if (c === '\\') { i += 1; continue }
      if (c === inStr) { inStr = null; prevSignificant = c }
      continue
    }
    if (inRe) {
      if (c === '\\') { i += 1; continue }
      if (c === '[') { // 字符类里的 / 不结束正则
        while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i += 1; i += 1 }
        continue
      }
      if (c === '/') { inRe = false; prevSignificant = c }
      else if (c === '\n') inRe = false // 防御：正则不跨行，遇换行说明启发式误判
      continue
    }
    if (c === '/' && n === '/') { inLine = true; i += 1; continue }
    if (c === '/' && n === '*') { inBlock = true; i += 1; continue }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '/' && !/[)\]}A-Za-z0-9_$]/.test(prevSignificant)) { inRe = true; continue }
    if (/\s/.test(c)) continue
    if (c === '(' || c === '{' || c === '[') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1
      if (c === '}' && depth === 0) return i
    }
    prevSignificant = c
  }
  return -1
}

/** 行尾是否「明显还没写完」（续行符 / 悬空关键字），用于判断单条语句是否可在换行处结束 */
function looksContinued(text) {
  const t = text.replace(/\s+$/, '')
  if (t === '') return true
  if (/[(,+\-*/%&|<>=?:.]$/.test(t)) return true
  return /\b(?:return|typeof|instanceof|in|of|new|delete|void|await|yield|else|case|do)$/.test(t)
}

/**
 * 按名抽取一个顶层 function 声明的完整源码（花括号配平，跳过字符串/模板/注释/正则），与分片布局无关。
 * 拆分后函数声明与状态语句分处两阶段，原先「按相邻标记切片」的写法容易切空或切多；
 * 需要某个函数的测试改用本函数更稳。
 * @param {string} name 函数名
 * @param {string} [view] 源文本，默认取 loadPageSource()
 * @returns {string} 完整函数源码（含 async 前缀）
 */
function extractFunction(name, view) {
  const src = view === undefined ? loadPageSource() : view
  const re = new RegExp(`(?:^|\\n)(async\\s+)?function\\s+${name.replace(/[$]/g, '\\$')}\\s*\\(`)
  const m = re.exec(src)
  if (!m) throw new Error(`未找到顶层函数 ${name}`)
  const bodyStart = src.indexOf('{', m.index)
  if (bodyStart < 0) throw new Error(`函数 ${name} 缺少函数体`)
  const end = scanBlockEnd(src, bodyStart)
  if (end < 0) throw new Error(`函数 ${name} 花括号未配平`)
  return src.slice(m.index + (m[0].startsWith('\n') ? 1 : 0), end + 1)
}

/**
 * 从锚点所在行起，抽取**完整的一条顶层语句**（按 (){}[] 配平，跳过字符串与注释）。
 * 用于取多行状态语句，例如 `const gpuSession=(function(){ … })();`；
 * 无分号结尾的单行语句（如 `try{ … }catch(e){}`）也能在行尾正确收束，不会吞掉下一条。
 * 注意：锚点按 indexOf 首次匹配，若在视图中不唯一，请用带换行前缀等更长的锚点定位。
 * @param {string} anchor 锚点子串
 * @param {string} [view] 源文本，默认取 loadPageSource()
 */
function extractStatement(anchor, view) {
  const src = view === undefined ? loadPageSource() : view
  const at = src.indexOf(anchor)
  if (at < 0) throw new Error(`未找到锚点 ${JSON.stringify(anchor)}`)
  const start = src.lastIndexOf('\n', at) + 1
  let depth = 0, inStr = null, inLine = false, inBlock = false, inRe = false
  let prevSignificant = ''
  for (let i = start; i < src.length; i += 1) {
    const c = src[i], n = src[i + 1]
    if (inLine) { if (c === '\n') inLine = false; continue }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 1 } continue }
    if (inStr) {
      if (c === '\\') { i += 1; continue }
      if (c === inStr) { inStr = null; prevSignificant = c }
      continue
    }
    if (inRe) {
      if (c === '\\') { i += 1; continue }
      if (c === '[') { while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i += 1; i += 1 } continue }
      if (c === '/') { inRe = false; prevSignificant = c }
      else if (c === '\n') inRe = false
      continue
    }
    if (c === '/' && n === '/') { inLine = true; i += 1; continue }
    if (c === '/' && n === '*') { inBlock = true; i += 1; continue }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '/' && !/[)\]}A-Za-z0-9_$]/.test(prevSignificant)) { inRe = true; continue }
    if (c === '(' || c === '{' || c === '[') { depth += 1; prevSignificant = c; continue }
    if (c === ')' || c === '}' || c === ']') { depth -= 1; prevSignificant = c; continue }
    if (c === ';' && depth === 0) return src.slice(start, i + 1)
    if (c === '\n' && depth === 0) {
      const soFar = src.slice(start, i)
      if (!looksContinued(soFar)) return soFar
    }
    if (!/\s/.test(c)) prevSignificant = c
  }
  throw new Error(`锚点 ${JSON.stringify(anchor.slice(0, 40))} 所在语句未能配平结束`)
}

/**
 * 取包含指定锚点的**整行**源码（状态语句多为单行，用于精确取出 let/const 初始化或单行绑定）。
 * @param {string} anchor 锚点子串
 * @param {string} [view] 源文本，默认取 loadPageSource()
 */
function lineOf(anchor, view) {
  const src = view === undefined ? loadPageSource() : view
  const i = src.indexOf(anchor)
  if (i < 0) throw new Error(`未找到锚点 ${JSON.stringify(anchor)}`)
  const s = src.lastIndexOf('\n', i) + 1
  let e = src.indexOf('\n', i)
  if (e < 0) e = src.length
  return src.slice(s, e)
}

/**
 * 从锚点 from 起、到锚点 to 之前截取，两端都必须在视图中存在且 from 在 to 之前。
 * 与裸 indexOf+slice 的区别：锚点缺失或顺序颠倒时立刻给出明确报错，
 * 而不是静默返回空串/整页（那会让 vm 抛 SyntaxError 或断言莫名失败）。
 */
function sliceBetween(from, to, view) {
  const src = view === undefined ? loadPageSource() : view
  const a = src.indexOf(from)
  if (a < 0) throw new Error(`切片起点锚点未找到: ${JSON.stringify(from.slice(0, 60))}`)
  const b = to === undefined ? src.length : src.indexOf(to, a)
  if (to !== undefined && b < 0) throw new Error(`切片终点锚点在起点之后未找到: ${JSON.stringify(to.slice(0, 60))}`)
  return src.slice(a, b)
}

module.exports = {
  loadPageSource, loadPageHtml, loadPageSourceInLoadOrder, listPageScripts, resolvePagePath,
  extractFunction, extractStatement, lineOf, sliceBetween, PIPELINE_DIR,
}
