/**
 * dsh-error-digest 客户端 bundle 构建脚本。
 *
 * 产物 `lib/client.js` 是**手写协议**的浏览器 bundle：DSH 的客户端模块系统用
 * classic `<script>` 加载每个插件的客户端半，脚本执行时只做一件事——把自己注册进
 * `window.__ModuleLoader__`：
 *
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => exports })
 *
 * 客户端 bundle 里不能出现 `import` / `export`（它不是 ES 模块），也不能依赖包外的
 * 相对路径（浏览器只拿到这一个文件）。因此本脚本做一次极简的源码内联：
 *
 *   src/digest-model.js（ESM，纯逻辑，可单测）  → 去掉 `export ` 前缀
 *   src/digest-ui.js（裸脚本，React 组件工厂）  → 原样内联
 *   src/client-main.js（裸脚本，接线）          → 原样内联
 *   三者塞进 factory 函数体，末尾挂 `exports.apply` / `exports.inject`。
 *
 * 用法：
 *   node build/bundle.mjs            # 生成 lib/client.js
 *   node build/bundle.mjs --check    # 只校验产物是当前源码的等价生成（CI 用）
 *
 * @module dsh-error-digest/build
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 包名：注册到 __ModuleLoader__ 的 id，必须与 package.json 的 name 一致。 */
const PACKAGE_NAME = 'dsh-error-digest'

/** 源码与产物路径。 */
export const MODEL_SOURCE = join(ROOT, 'src', 'digest-model.js')
export const UI_SOURCE = join(ROOT, 'src', 'digest-ui.js')
export const MAIN_SOURCE = join(ROOT, 'src', 'client-main.js')
const PACKAGE_JSON = join(ROOT, 'package.json')
export const OUTPUT_PATH = join(ROOT, 'lib', 'client.js')

/**
 * 把 ESM 纯逻辑模块转成同一作用域内的普通声明。
 *
 * 只处理本插件自己写的模块：它们没有 import、没有 `export default`、没有重导出，
 * 全部导出都是 `export const` / `export function`。任何超出该假设的形状都直接报错，
 * 而不是悄悄生成一个坏 bundle。
 * @param {string} source 源码文本。
 * @param {string} label 报错用的文件名。
 * @returns {string} 去掉导出关键字后的源码。
 */
function inlineEsModule(source, label) {
  if (/^\s*import\s/m.test(source)) {
    throw new Error(`${label} 不允许出现 import（客户端 bundle 是单文件）`)
  }
  if (/^\s*export\s+default\b/m.test(source)) {
    throw new Error(`${label} 不允许 export default（内联后无法表达）`)
  }
  if (/^\s*export\s*\{/m.test(source)) {
    throw new Error(`${label} 不允许 export {...} 列表（内联后无法表达）`)
  }
  return source.replace(/^export\s+/gm, '')
}

/**
 * 缩进一段源码，方便产物阅读。
 * @param {string} source 源码。
 * @param {string} pad 前缀。
 * @returns {string} 缩进后的源码。
 */
function indent(source, pad) {
  return source
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${pad}${line}`))
    .join('\n')
}

/**
 * 生成 bundle 文本。
 * @returns {string} lib/client.js 的完整内容。
 */
export function buildBundle() {
  const model = inlineEsModule(readFileSync(MODEL_SOURCE, 'utf8'), 'digest-model.js')
  const ui = readFileSync(UI_SOURCE, 'utf8')
  const main = readFileSync(MAIN_SOURCE, 'utf8')
  // 版本从 package.json 注入，保证「宿主半读 package.json」与「客户端半内联」一致：
  // 两半版本不一致是真实存在的运行状态（宿主半随 DSH 启动加载，客户端半随页面加载）。
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
  const version = typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : 'unknown'

  const header = `/**
 * dsh-error-digest —— 客户端 bundle（由 build/bundle.mjs 生成，请不要手改）
 *
 * 内联自：
 *   - src/digest-model.js   跨会话合并、频次排序、提示词（纯逻辑）
 *   - src/digest-ui.js      面板与侧栏图标 React 组件
 *   - src/client-main.js    接线：会话快照 → 面板；按钮 → 新对话草稿
 *
 * 协议：DSH 客户端模块系统用 classic <script> 加载本文件，脚本执行时通过
 * window.__ModuleLoader__.load({ id, factory }) 注册工厂；工厂在首次
 * import/require 时物化，并作为 Cordis 插件激活（apply + inject）。
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PACKAGE_NAME)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

\t\t/** 客户端半的构建版本；由 build/bundle.mjs 从 package.json 注入。 */
\t\tconst BUNDLE_VERSION = ${JSON.stringify(version)};

\t\t//#region src/digest-model.js
`

  const footer = `
\t\t//#endregion
\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t}
});
`

  const body = [
    header,
    indent(model.trimEnd(), '\t\t'),
    '\n\t\t//#endregion\n\t\t//#region src/digest-ui.js\n',
    indent(ui.trimEnd(), '\t\t'),
    '\n\t\t//#endregion\n\t\t//#region src/client-main.js\n',
    indent(main.trimEnd(), '\t\t'),
    footer,
  ].join('\n')

  // 语法自检：产物必须是可解析的脚本。
  try {
    // eslint-disable-next-line no-new-func
    new Function(body)
  } catch (error) {
    throw new Error(`生成的 bundle 语法非法：${error.message}`)
  }
  return body
}

/**
 * 校验已存在的产物是否与当前源码一致。
 * @returns {{ ok: boolean, message: string }} 校验结果。
 */
export function checkBundle() {
  const expected = buildBundle()
  let existing = ''
  try {
    existing = readFileSync(OUTPUT_PATH, 'utf8')
  } catch {
    return { ok: false, message: 'lib/client.js 不存在，请先运行：node build/bundle.mjs' }
  }
  if (existing !== expected) {
    return { ok: false, message: 'lib/client.js 与源码不一致，请重新运行：node build/bundle.mjs' }
  }
  return { ok: true, message: 'lib/client.js 与源码一致' }
}

/**
 * 把产物写到 `lib/client.js`。
 * @returns {number} 写入的字节数。
 */
export function writeBundle() {
  const bundle = buildBundle()
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, bundle, 'utf8')
  return Buffer.byteLength(bundle, 'utf8')
}

/** 只有直接执行本文件时才跑 CLI（被测试 import 时不做任何写入）。 */
const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  if (process.argv.includes('--check')) {
    const result = checkBundle()
    if (!result.ok) {
      console.error(result.message)
      process.exit(1)
    }
    console.log(result.message)
  } else {
    const bytes = writeBundle()
    console.log(`已生成 ${OUTPUT_PATH}（${bytes} 字节）`)
  }
}
