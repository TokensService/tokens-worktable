/**
 * 流水线页「单文件视图」加载器（ESM 包装）。
 *
 * 实现见同目录 _page-source.cjs；本文件只为 ESM 测试（*.test.mjs）提供同一入口，
 * 避免两份实现走偏。projects/ 下 package.json 是 "type": "commonjs"，故用 createRequire 载入。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const impl = require('./_page-source.cjs')

export const loadPageSource = impl.loadPageSource
export const loadPageHtml = impl.loadPageHtml
export const loadPageSourceInLoadOrder = impl.loadPageSourceInLoadOrder
export const listPageScripts = impl.listPageScripts
export const resolvePagePath = impl.resolvePagePath
export const extractFunction = impl.extractFunction
export const extractStatement = impl.extractStatement
export const lineOf = impl.lineOf
export const sliceBetween = impl.sliceBetween
export const PIPELINE_DIR = impl.PIPELINE_DIR
