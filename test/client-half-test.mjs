/**
 * dsh-error-digest 客户端半（bundle）集成单测。
 *
 * 这里**不跑浏览器**，而是把构建出来的 bundle 当普通脚本执行：
 *
 *   1. 用假 `window.__ModuleLoader__` 接住工厂注册（协议是否对）；
 *   2. 用假 `require('react')` 物化模块（模块体不许在顶层碰 React）；
 *   3. 用假 ctx 调 `apply`，把插槽注册表、文案字典、按钮行为全部录下来；
 *   4. 用极简 React（createElement 直接展开函数组件、useState 跨渲染保留）渲染面板，
 *      检查真实元素结构、三个动作按钮点下去到底发生了什么；
 *   5. 用假 localStorage 验证「忽略」真的落盘、真的可恢复。
 *
 * 覆盖的是「装上去能不能用」这一层：注册键名错了、按钮点了没反应、文案缺键、
 * 忽略丢了找不回来，都能在这里当场暴露，而不是等到界面上看见一片空白。
 *
 * 运行：node --test test/client-half-test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBundle } from '../build/bundle.mjs'

/** 面板 id（与源码里的常量保持一致）。 */
const PANEL_ID = 'error-digest'

/** 文案命名空间。 */
const NS = 'errorDigest'

/** 「已忽略」的 localStorage 键（与源码保持一致）。 */
const IGNORED_KEY = 'dsh-error-digest/ignored-v1'

/**
 * 极简 React：`createElement` 直接展开函数组件；`useState` 跨渲染保留状态。
 *
 * 为什么 useState 要跨渲染保留：面板的「展开已忽略」「切换口径」都是本地状态，
 * 每次渲染都重置的话，就没法验证「点忽略后能看到恢复入口」这类真实流程。
 * 组件内 hook 的调用顺序固定，所以用「渲染内的调用序号」当下标就够了。
 * @returns {object} React 替身。
 */
function createFakeReact() {
  const react = { states: [], cursor: 0 }

  react.createElement = (type, props, children) => {
    const normalized = props ?? {}
    const childList = children === undefined
      ? []
      : (Array.isArray(children) ? children : [children])
    const kept = childList.filter((child) => child !== null && child !== undefined && child !== false)
    if (typeof type === 'function') return type({ ...normalized, children: kept })
    return { type, props: normalized, children: kept }
  }

  react.useState = (initial) => {
    const index = react.cursor
    react.cursor += 1
    if (!(index in react.states)) {
      react.states[index] = typeof initial === 'function' ? initial() : initial
    }
    const setter = (next) => {
      react.states[index] = typeof next === 'function' ? next(react.states[index]) : next
    }
    return [react.states[index], setter]
  }

  react.useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot()
  react.useEffect = () => {}

  /** 每次顶层渲染前重置 hook 游标。 */
  react.beginRender = () => {
    react.cursor = 0
  }

  return react
}

/**
 * 装一个假 localStorage，返回底层 Map（供断言「到底写没写盘」）。
 * @returns {Map<string, string>} 存储内容。
 */
function installFakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(String(key), String(value)) },
    removeItem: (key) => { map.delete(key) },
    clear: () => { map.clear() },
    key: (index) => [...map.keys()][index] ?? null,
    get length() { return map.size },
  }
  return map
}

/**
 * 读回「已忽略」表（测试断言用）。
 * @param {Map<string, string>} map 存储。
 * @returns {object|undefined} 解析后的忽略表。
 */
function readIgnoredTable(map) {
  const raw = map.get(IGNORED_KEY)
  return raw === undefined ? undefined : JSON.parse(raw)
}

/**
 * 极简文案函数：`{name}` 插值，缺键回落成键名（与宿主行为一致）。
 * @param {object} dict 字典。
 * @returns {(key: string, params?: object) => string} 文案函数。
 */
function translator(dict) {
  return (key, params) => {
    const template = dict?.[key] ?? key
    if (typeof template !== 'string') return key
    if (typeof params !== 'object' || params === null) return template
    return template.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole))
  }
}

/**
 * 加载 bundle 并取回它注册的工厂。
 * @returns {{ id: string, factory: Function }} 注册项。
 */
function loadBundleDefinition() {
  const text = buildBundle()
  let captured = null
  const fakeWindow = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'globalThis', text)
  run(fakeWindow, globalThis)
  assert.ok(captured !== null, 'bundle 没有注册到 window.__ModuleLoader__')
  return captured
}

/**
 * 造一个假的客户端 Cordis 上下文。
 * @param {{ sessions?: object, uiWorkspace?: object, layout?: object }} [services] 可用服务。
 * @returns {object} 假 ctx（额外带 `registrations` / `dicts` / `panelSelections` 等录制字段）。
 */
function createFakeCtx(services = {}) {
  /** 录制到的插槽注册。 */
  const registrations = []
  /** 录制到的文案字典：命名空间 → { zh, en }。 */
  const dicts = {}
  /** 当前正在注入的插槽名。 */
  let currentSlot = null
  /** 录制到的 effect 标签。 */
  const effectLabels = []
  /** 录制到的 `layout.selectPanel()` 调用（null 表示「切回对话」）。 */
  const panelSelections = []

  const available = {
    sessions: services.sessions,
    uiWorkspace: services.uiWorkspace,
    layout: services.layout ?? { selectPanel: (panelId) => panelSelections.push(panelId) },
  }

  const ctx = {
    registrations,
    dicts,
    effectLabels,
    panelSelections,
    logger: { info() {}, warn() {} },
    effect(fn, label) {
      effectLabels.push(label)
      return fn()
    },
    get(name) {
      return available[name]
    },
    inject(deps, callback) {
      for (const dep of deps) this[dep] = available[dep]
      callback(this)
      return () => {}
    },
    slots: {
      inject(slotName, callback) {
        currentSlot = slotName
        const result = callback()
        currentSlot = null
        return typeof result === 'function' ? result : () => {}
      },
      register(definition, component) {
        registrations.push({ slot: currentSlot, definition, component })
        return () => {}
      },
    },
    locale: {
      register(namespace, byLocale) {
        dicts[namespace] = byLocale
        return () => {}
      },
      bind(namespace) {
        return translator(dicts[namespace]?.zh)
      },
    },
  }
  // Cordis 会把插件 `inject` 里声明的服务挂到它的 ctx 上（`ctx.uiWorkspace` 等）。
  // 本插件把这些服务都声明成硬依赖，所以假 ctx 同样直接挂上去。
  for (const [serviceName, service] of Object.entries(available)) {
    if (service !== undefined) ctx[serviceName] = service
  }
  return ctx
}

/**
 * 造一个可用的会话列表快照对象（`ctx.sessions.list`）。
 * @param {object} state 列表快照。
 * @returns {object} 快照源。
 */
function listSource(state) {
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
  }
}

/**
 * 造一份带两条错误的会话列表快照。
 * @returns {object} 会话列表快照。
 */
function sampleListState() {
  const toolEntry = {
    sig: 'tool|edit|NO_MATCH|未找到唯一匹配的片段',
    kind: 'tool',
    key: 'edit',
    code: 'NO_MATCH',
    detail: '未找到唯一匹配的片段',
    count: 5,
    firstTime: 1_700_000_000_000,
    lastTime: 1_700_000_500_000,
    lastSeq: 42,
  }
  const modelEntry = {
    sig: 'model|deepseek|SERVER_BUSY|服务繁忙',
    kind: 'model',
    key: 'deepseek',
    code: 'SERVER_BUSY',
    detail: '服务繁忙，请稍后重试',
    count: 2,
    firstTime: 1_700_000_100_000,
    lastTime: 1_700_000_200_000,
    lastSeq: 60,
  }
  return {
    ids: ['s1', 's2'],
    phase: 'ready',
    byId: {
      // s1 是主视图会话，`blank: true` 模拟「按钮动作已经切到新建的空白会话」，
      // 这样动作成功后的校验（mainViewIsBlank）成立，不会触发 300ms 后的重试。
      s1: { id: 's1', title: '会话一', displayTitle: '会话一', blank: true, retainedBy: { mainView: 1 } },
      s2: { id: 's2', title: '会话二', displayTitle: '会话二', retainedBy: {} },
    },
    projectionsBySession: {
      s1: { values: { dialogErrors: { entries: [toolEntry] } }, state: 'ready', error: null },
      s2: { values: { dialogErrors: { entries: [toolEntry, modelEntry] } }, state: 'ready', error: null },
    },
  }
}

/**
 * 遍历元素树。
 * @param {object} node 根节点。
 * @param {(node: object) => void} visit 访问器。
 * @returns {void}
 */
function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/**
 * 按 `data-testid` 收集元素。
 * @param {object} tree 根节点。
 * @param {string} testId testid。
 * @returns {object[]} 命中的元素。
 */
function findAll(tree, testId) {
  const hits = []
  walk(tree, (node) => {
    if (node.props?.['data-testid'] === testId) hits.push(node)
  })
  return hits
}

/**
 * 收集一个元素的纯文本。
 * @param {object} node 元素。
 * @returns {string} 文本。
 */
function textOf(node) {
  const parts = []
  walk(node, (current) => {
    for (const child of current.children ?? []) {
      if (typeof child === 'string') parts.push(child)
    }
  })
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * 物化客户端半并执行 apply。
 * @param {{ services?: object }} [options] 可用服务。
 * @returns {{ ctx: object, exportsObject: object, registration: Function, react: object,
 *   renderPanel: () => object }} 结果（`renderPanel` 渲染一次主面板）。
 */
function mountClientHalf(options = {}) {
  const definition = loadBundleDefinition()
  const fakeReact = createFakeReact()
  const exportsObject = definition.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`bundle 试图 require 未知模块：${name}`)
  })
  const ctx = createFakeCtx(options.services)
  exportsObject.apply(ctx)
  /** 取某个插槽的注册项。 */
  const registration = (slotName) => ctx.registrations.find((item) => item.slot === slotName)
  /** 渲染一次主面板：重置 hook 游标，让上一次点击的 setState 在这一轮生效。 */
  const renderPanel = () => {
    fakeReact.beginRender()
    return registration('main').component({ t: translator(ctx.dicts[NS].zh) })
  }
  return { ctx, exportsObject, registration, react: fakeReact, renderPanel }
}

test('bundle 以包名注册工厂，且导出 apply / inject', () => {
  const definition = loadBundleDefinition()
  assert.equal(definition.id, 'dsh-error-digest')
  assert.equal(typeof definition.factory, 'function')
  const exportsObject = definition.factory(() => createFakeReact())
  assert.equal(typeof exportsObject.apply, 'function')
  // uiWorkspace 与 layout 必须是硬依赖：只靠 ctx.get() 取它们会出现「点了没反应」
  assert.deepEqual(exportsObject.inject, ['slots', 'locale', 'uiWorkspace', 'layout'])
})

test('apply 注册主面板与侧栏图标，且两者的 id/key 一致', () => {
  const { registration } = mountClientHalf({ services: { sessions: { list: listSource(sampleListState()) } } })
  const main = registration('main')
  const panel = registration('sidebar.panellist')
  assert.ok(main !== undefined, '没有注册 main 面板')
  assert.ok(panel !== undefined, '没有注册侧栏图标')
  assert.equal(main.definition.key, PANEL_ID)
  assert.equal(main.definition.locale, NS)
  assert.equal(typeof main.component, 'function')
  assert.equal(panel.definition.id, PANEL_ID)
  assert.equal(panel.definition.locale, NS)
  assert.equal(typeof panel.definition.order, 'number')
  assert.equal(typeof panel.component, 'function')
  // 侧栏标签是 thunk：切换语言时不用重新注册
  assert.equal(typeof panel.definition.label, 'function')
  assert.equal(panel.definition.label(), '错误汇总')
})

test('zh / en 文案键集合完全一致', () => {
  const { ctx } = mountClientHalf({ services: { sessions: { list: listSource(sampleListState()) } } })
  const dict = ctx.dicts[NS]
  assert.ok(dict !== undefined, '没有注册文案字典')
  const zhKeys = Object.keys(dict.zh).sort()
  const enKeys = Object.keys(dict.en).sort()
  assert.deepEqual(enKeys, zhKeys)
  // 提示词必须是「能直接交给模型」的完整任务，不是一句标题
  assert.match(dict.zh['prompt.analyze'], /根因/)
  assert.match(dict.zh['prompt.prevent'], /AGENTS\.md/)
  assert.match(dict.en['prompt.analyze'], /root cause/)
  assert.match(dict.en['prompt.prevent'], /AGENTS\.md/)
  // 新增的忽略相关文案中英都要有
  for (const key of ['action.ignore', 'action.ignore.title', 'ignored.title', 'ignored.restore', 'ignored.restoreAll', 'ignored.show']) {
    assert.equal(typeof dict.zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof dict.en[key], 'string', `en 缺 ${key}`)
  }
})

test('面板渲染：按频次排序、跨会话合并、每条三个带图标的动作', () => {
  const { renderPanel } = mountClientHalf({ services: { sessions: { list: listSource(sampleListState()) } } })
  const tree = renderPanel()

  const rows = findAll(tree, 'error-digest-row')
  assert.equal(rows.length, 2)
  // 第一行是 5+5=10 次的 edit 失败，第二行是 2 次的模型重试
  assert.equal(rows[0].props['data-kind'], 'tool')
  const firstText = textOf(rows[0])
  assert.match(firstText, /×10/)
  assert.match(firstText, /工具 edit/)
  assert.match(firstText, /NO_MATCH/)
  assert.match(firstText, /2 个会话/)
  assert.equal(rows[1].props['data-kind'], 'model')
  assert.match(textOf(rows[1]), /×2/)

  // 三个动作：分析 / 防范 / 忽略；每个都是「图标 + 文案」且带可读的 aria-label
  assert.equal(findAll(tree, 'error-digest-analyze').length, 2)
  assert.equal(findAll(tree, 'error-digest-prevent').length, 2)
  assert.equal(findAll(tree, 'error-digest-ignore').length, 2)
  for (const testId of ['error-digest-analyze', 'error-digest-prevent', 'error-digest-ignore']) {
    const button = findAll(tree, testId)[0]
    const icons = (button.children ?? []).filter((child) => child?.type === 'svg')
    assert.equal(icons.length, 1, `${testId} 缺少图标`)
    assert.equal(typeof button.props['aria-label'], 'string')
    assert.match(textOf(button), /\S/)
  }
  // 标题 + 汇总（口径来自可见行）
  assert.match(textOf(findAll(tree, 'error-digest-page')[0]), /错误汇总/)
  assert.match(textOf(findAll(tree, 'error-digest-page')[0]), /2 类错误/)
  // 没有忽略过任何东西时，不显示「已忽略」开关
  assert.equal(findAll(tree, 'error-digest-ignored-toggle').length, 0)
})

test('没有数据时渲染空状态而不是崩溃', () => {
  const empty = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const { renderPanel } = mountClientHalf({ services: { sessions: { list: listSource(empty) } } })
  const tree = renderPanel()
  assert.equal(findAll(tree, 'error-digest-row').length, 0)
  const emptyState = findAll(tree, 'error-digest-empty')
  assert.equal(emptyState.length, 1)
  assert.match(textOf(emptyState[0]), /还没有错误记录/)
})

test('sessions 服务缺席时也不崩（渲染空状态）', () => {
  const { renderPanel } = mountClientHalf({})
  const tree = renderPanel()
  assert.equal(findAll(tree, 'error-digest-empty').length, 1)
})

test('「分析」按钮：先切回对话面板，再发起新建对话并预填提示词', () => {
  /** 录下的 startSession 调用。 */
  const calls = []
  const uiWorkspace = {
    startSession: (workspaceId, options) => {
      calls.push({ workspaceId, options })
    },
  }
  const { ctx, renderPanel } = mountClientHalf({
    services: { sessions: { list: listSource(sampleListState()) }, uiWorkspace },
  })
  const tree = renderPanel()
  findAll(tree, 'error-digest-analyze')[0].props.onClick()

  // 动作是跨帧排队的：这一刻只做了一件事——切回对话主面板（让 composer 挂载）
  assert.deepEqual(ctx.panelSelections, [null])
  assert.equal(calls.length, 0)

  globalThis.__DSH_ERROR_DIGEST__.flushActions()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].workspaceId, undefined)
  assert.equal(calls[0].options.whenDraftExists, 'append')
  const prompt = calls[0].options.prompt
  assert.match(prompt, /请分析/)
  assert.match(prompt, /工具失败/)
  assert.match(prompt, /工具 edit/)
  assert.match(prompt, /NO_MATCH/)
  assert.match(prompt, /出现次数：10/)
  assert.match(prompt, /未找到唯一匹配的片段/)
})

test('「防范」按钮走的是另一套提示词（目标是改规则防复现）', () => {
  /** 录下的 startSession 调用。 */
  const calls = []
  const uiWorkspace = { startSession: (workspaceId, options) => { calls.push(options) } }
  const { ctx, renderPanel } = mountClientHalf({
    services: { sessions: { list: listSource(sampleListState()) }, uiWorkspace },
  })
  findAll(renderPanel(), 'error-digest-prevent')[0].props.onClick()
  globalThis.__DSH_ERROR_DIGEST__.flushActions()

  assert.equal(calls.length, 1)
  const prompt = calls[0].prompt
  assert.match(prompt, /「防范」/)
  assert.match(prompt, /AGENTS\.md/)
  assert.match(prompt, /最小改动/)
  const analyze = translator(ctx.dicts[NS].zh)('prompt.analyze', {
    kind: '', source: '', code: '', count: '', lastSeen: '', detail: '',
  })
  assert.notEqual(prompt, analyze)
})

test('「忽略」把行移出列表、写进 localStorage，并给出恢复入口', () => {
  const storage = installFakeStorage()
  const { renderPanel } = mountClientHalf({ services: { sessions: { list: listSource(sampleListState()) } } })

  const before = renderPanel()
  assert.equal(findAll(before, 'error-digest-row').length, 2)
  findAll(before, 'error-digest-ignore')[0].props.onClick()

  // 落盘：忽略表按签名记账，并且连摘要一起存（错误消失后还能认出是哪条）
  const sig = 'tool|edit|NO_MATCH|未找到唯一匹配的片段'
  const table = readIgnoredTable(storage)
  assert.ok(table !== null && typeof table === 'object')
  assert.deepEqual(Object.keys(table), [sig])
  assert.equal(table[sig].kind, 'tool')
  assert.equal(table[sig].count, 10)
  assert.equal(table[sig].detail, '未找到唯一匹配的片段')

  // 重新渲染：行没了、汇总跟着变小、出现「已忽略」开关与恢复入口
  const after = renderPanel()
  assert.equal(findAll(after, 'error-digest-row').length, 1)
  assert.match(textOf(findAll(after, 'error-digest-page')[0]), /1 类错误 · 累计 2 次/)
  const toggle = findAll(after, 'error-digest-ignored-toggle')
  assert.equal(toggle.length, 1)
  // 忽略后自动展开，所以这里显示的是「收起」态与条数
  assert.equal(toggle[0].props['aria-expanded'], 'true')
  assert.match(textOf(toggle[0]), /1 条/)
  // 忽略后自动展开「已忽略」，因为那次点击把 showIgnored 置为 true
  const ignoredRows = findAll(after, 'error-digest-ignored-row')
  assert.equal(ignoredRows.length, 1)
  assert.match(textOf(ignoredRows[0]), /工具 edit/)

  // 恢复：行回到列表，忽略表被清空
  findAll(after, 'error-digest-restore')[0].props.onClick()
  assert.deepEqual(readIgnoredTable(storage), {})
  const restored = renderPanel()
  assert.equal(findAll(restored, 'error-digest-row').length, 2)
  assert.equal(findAll(restored, 'error-digest-ignored-toggle').length, 0)
  assert.equal(globalThis.__DSH_ERROR_DIGEST__.ignoredCount(), 0)
})

test('忽略可以全部恢复；全部忽略后空状态换成「都被忽略了」的说明', () => {
  const storage = installFakeStorage()
  const { renderPanel } = mountClientHalf({ services: { sessions: { list: listSource(sampleListState()) } } })

  let tree = renderPanel()
  findAll(tree, 'error-digest-ignore')[0].props.onClick()
  tree = renderPanel()
  findAll(tree, 'error-digest-ignore')[0].props.onClick()
  assert.equal(globalThis.__DSH_ERROR_DIGEST__.ignoredCount(), 2)
  assert.equal(Object.keys(readIgnoredTable(storage)).length, 2)

  // 两条都被忽略：列表空，但空状态要说明「是忽略掉的，不是坏掉了」
  tree = renderPanel()
  assert.equal(findAll(tree, 'error-digest-row').length, 0)
  const emptyText = textOf(findAll(tree, 'error-digest-empty')[0])
  assert.match(emptyText, /都被忽略了/)
  assert.match(emptyText, /全部恢复/)

  // 全部恢复
  findAll(tree, 'error-digest-restore-all')[0].props.onClick()
  tree = renderPanel()
  assert.equal(findAll(tree, 'error-digest-row').length, 2)
  assert.deepEqual(readIgnoredTable(storage), {})
})

test('忽略表里的脏数据不会让面板崩', () => {
  const storage = installFakeStorage()
  storage.set(IGNORED_KEY, JSON.stringify({
    'tool|edit|NO_MATCH|未找到唯一匹配的片段': { at: '不是数字', kind: 42, detail: null },
    '坏的键': null,
  }))
  const { renderPanel } = mountClientHalf({ services: { sessions: { list: listSource(sampleListState()) } } })
  const tree = renderPanel()
  // 非法项被丢弃或补成默认值：面板照常渲染，合法的忽略仍然生效
  assert.equal(findAll(tree, 'error-digest-row').length, 1)
  assert.equal(findAll(tree, 'error-digest-ignored-toggle').length, 1)
})

test('样式表：花括号配平、只用主题令牌、不写字面色值', () => {
  const { renderPanel } = mountClientHalf({ services: { sessions: { list: listSource(sampleListState()) } } })
  const tree = renderPanel()
  const styleNode = (tree.children ?? []).find((child) => child?.type === 'style')
  assert.ok(styleNode !== undefined, '面板没有渲染 <style>')
  const css = textOf(styleNode)
  assert.ok(css.length > 1000, '样式表内容异常')
  const opens = (css.match(/\{/g) ?? []).length
  const closes = (css.match(/\}/g) ?? []).length
  assert.equal(opens, closes, '样式表花括号不配平')
  // 字面色值是红线：插件必须继承宿主主题令牌，否则明暗主题下会错色
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(css, /\b(rgba?|hsla?)\(/)
  // 三个动作与已忽略区块的类名必须在场
  for (const className of ['.ded-act-primary', '.ded-act-secondary', '.ded-act-quiet', '.ded-ignored-row', '.ded-ignored-toggle']) {
    assert.ok(css.includes(className), `样式表缺少 ${className}`)
  }
})

test('uiWorkspace 缺席时按钮退化为复制提示词，不抛错', () => {
  const { ctx, exportsObject } = mountClientHalf({
    services: { sessions: { list: listSource(sampleListState()) } },
  })
  const diagnostics = globalThis.__DSH_ERROR_DIGEST__
  assert.ok(diagnostics !== undefined, '诊断入口没有挂上')
  assert.equal(typeof exportsObject.apply, 'function')
  // 没有 uiWorkspace：动作必须安全返回 false（把提示词交给剪贴板/控制台）
  assert.equal(diagnostics.trigger('analyze'), false)
  assert.equal(diagnostics.canOpenConversation(), false)
  // 失败原因必须可查：按钮失败是静默的，只有这里能看出断在哪一步
  const action = diagnostics.lastAction()
  assert.equal(action.mode, 'analyze')
  assert.equal(action.opened, false)
  assert.match(action.reason, /ui-workspace-unavailable/)
  assert.ok(action.promptLength > 0)
  assert.equal(diagnostics.snapshot().distinctCount, 2)
  assert.equal(diagnostics.snapshot().totalCount, 12)
  assert.equal(diagnostics.currentSessionId(), 's1')
  assert.equal(ctx.dicts[NS].zh.panel, '错误汇总')
})

test('注入的 uiWorkspace 走硬依赖，动作被记为已开启', () => {
  /** 录下的调用。 */
  const calls = []
  const { exportsObject } = mountClientHalf({
    services: {
      sessions: { list: listSource(sampleListState()) },
      uiWorkspace: { startSession: (workspaceId, options) => calls.push({ workspaceId, options }) },
    },
  })
  const diagnostics = globalThis.__DSH_ERROR_DIGEST__
  assert.equal(diagnostics.canOpenConversation(), true)
  assert.equal(diagnostics.trigger('prevent'), true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].options.prompt, /「防范」/)
  assert.deepEqual(diagnostics.lastAction().opened, true)
  assert.equal(typeof exportsObject.apply, 'function')
})

test('诊断入口暴露的面板口径与渲染一致', () => {
  const { exportsObject } = mountClientHalf({
    services: { sessions: { list: listSource(sampleListState()) }, uiWorkspace: { startSession: () => {} } },
  })
  assert.equal(typeof exportsObject.apply, 'function')
  const snapshot = globalThis.__DSH_ERROR_DIGEST__.snapshot()
  assert.equal(snapshot.distinctCount, 2)
  assert.equal(snapshot.hasProjection, true)
  assert.equal(snapshot.sessionsWithErrors, 2)
  assert.equal(snapshot.top[0].count, 10)
  assert.equal(snapshot.top[0].kind, 'tool')
})
