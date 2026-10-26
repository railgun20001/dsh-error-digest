/**
 * dsh-error-digest —— 客户端半（浏览器 bundle 的 factory 体）
 *
 * 职责：
 *   1. 注册文案（zh / en）；
 *   2. 订阅受支持的会话列表快照（含每行的会话投影），供面板读取；
 *   3. 注册两个插槽：根级 `main` 的 keyed 面板（key 与侧栏 id 相同）+ `sidebar.panellist`
 *      图标；
 *   4. 「分析 / 防范」按钮的实现：**开启一个新对话，并把提示词填进输入框草稿**。
 *
 * ## 为什么按钮不直接发送消息
 *
 * 点击发生在用户已经明确表达意图的那一刻，但「发出去」是不可撤销的动作：
 * 新对话的工作目录、当前模式、模型都可能是用户还要调整的。把提示词放进新对话的
 * 草稿输入框，等于把「说清楚要做什么」的活替用户做完，发送仍由用户一键确认。
 * 走的也是宿主自己的 `uiWorkspace.startSession()`（与「新建对话」完全同一条通路），
 * 因此不会绕过任何权限、目录或预设逻辑。
 *
 * ## 数据面只有一条
 *
 * 面板的所有数据都来自 `ctx.sessions.list` 快照里的 `projectionsBySession`——
 * 宿主半折叠、客户端只合并排序。客户端不 retain 任何会话，也不会激活别人的历史。
 *
 * @module dsh-error-digest/client
 */

/** 插件 id（与 package.json 的 name 一致）。 */
const PLUGIN_ID = 'dsh-error-digest'

/** 主面板 id：侧栏 `sidebar.panellist` 的 id 与根级 `main` 的 key 必须是同一个值。 */
const PANEL_ID = 'error-digest'

/** 文案命名空间。 */
const NS = 'errorDigest'

/** 侧栏排序：排在插件/日程之后，不抢官方入口的位置。 */
const PANEL_ORDER = 20

/**
 * 硬依赖：插槽与文案是注册界面的前提；`uiWorkspace` 是「新建对话」的通路，
 * `layout` 用来在发起动作前先切回对话面板。
 *
 * `uiWorkspace` 必须走 inject 而不是 `ctx.get()`：它由客户端工作区插件提供，
 * 是**声明式**服务（与官方 schedule / entry-customization 插件的用法一致）。
 * 只靠 `ctx.get()` 取服务在某些组合下会拿到 undefined，表现就是「点了没反应」。
 */
const inject = ['slots', 'locale', 'uiWorkspace', 'layout']

/** 会话列表快照缺席时的稳定占位（引用必须稳定，否则 useSyncExternalStore 会空转）。 */
const EMPTY_LIST_STATE = Object.freeze({
  ids: [],
  byId: {},
  phase: 'pending',
  projectionsBySession: {},
})

/**
 * 自带文案：即使 locale 服务里的字典还没就绪，界面也不至于显示成键名。
 *
 * `prompt.*` 是给「分析 / 防范」新对话用的**模型输入**，因此写成了完整的任务描述，
 * 而不是一句标题。
 */
const ZH = {
  panel: '错误汇总',
  summary: '{distinct} 类错误 · 累计 {total} 次 · {sessions} 个会话',
  'scope.label': '统计范围',
  'scope.all': '全部会话',
  'scope.all.title': '合并本机所有会话里的错误',
  'scope.current': '当前对话',
  'scope.current.title': '只看当前打开的对话',
  'scope.current.disabled': '当前没有打开的对话',
  'kind.tool': '工具失败',
  'kind.turn': '回合失败',
  'kind.model': '模型重试',
  'kind.unknown': '其它',
  count: '×{count}',
  'count.title': '累计出现次数（同一错误的重复出现已合并）',
  'detail.empty': '（没有可读的错误信息）',
  'row.sessions': '{count} 个会话',
  'row.lastSeen': '最近 {time}',
  'action.analyze': '分析',
  'action.analyze.title': '开启一个新对话，分析这条错误的根因与修复方案',
  'action.prevent': '防范',
  'action.prevent.title': '开启一个新对话，改动规则/工具/文档，避免它再次发生',
  'empty.title': '还没有错误记录',
  'empty.body': '这里汇总对话日志里的工具失败、回合失败与模型重试；出现第一条错误后会自动按频次排序。',
  'empty.noCurrent.title': '当前没有打开的对话',
  'empty.noCurrent.body': '先打开一个对话，或把范围切回「全部会话」。',
  'empty.scanned': '已扫描 {sessions} 个会话；会话投影{state}',
  'empty.state.seen': '已就绪',
  'empty.state.missing': '尚未在任何会话上出现（新会话产生错误后即可见）',
  'footer.note': '数据来自会话投影「{key}」，随新事件自动更新，无需刷新。',
  'source.tool': '工具 {name}',
  'source.toolUnknown': '未知工具',
  'source.model': '模型请求',
  'source.modelProvider': '模型 {name}',
  'source.turn': '整轮对话',
  'source.unknown': '未知来源',
  'action.done': '已开启新对话，提示词已填入输入框',
  'action.failed': '无法开启新对话，提示词已复制到剪贴板',
  'prompt.analyze': [
    '请分析下面这条在 DSH 对话中反复出现的错误，输出：',
    '1) 根因判断（区分是提示词/工具契约/环境依赖/代码问题）；',
    '2) 触发条件与影响范围；',
    '3) 可执行的修复或规避步骤。',
    '排查以只读为主，需要改动前先说明方案。',
    '',
    '- 类别：{kind}',
    '- 来源：{source}',
    '- 错误码：{code}',
    '- 出现次数：{count}',
    '- 最近一次：{lastSeen}',
    '- 错误摘要：',
    '{detail}',
  ].join('\n'),
  'prompt.prevent': [
    '请针对下面这条在 DSH 对话里重复出现的错误做「防范」，目标是让它在后续对话里不再发生：',
    '1) 判断最该在哪一层拦住它（AGENTS.md 全局规则、相关 skill 说明、工具入参校验与错误提示、插件代码、文档）；',
    '2) 用最小改动落地，说明改了哪些文件、为什么这样改就能拦住；',
    '3) 给出以后自查这份防范是否失效的检查清单。',
    '需要改动前先说明方案。',
    '',
    '- 类别：{kind}',
    '- 来源：{source}',
    '- 错误码：{code}',
    '- 出现次数：{count}',
    '- 最近一次：{lastSeen}',
    '- 错误摘要：',
    '{detail}',
  ].join('\n'),
}

/** 英文文案（键集合与 {@link ZH} 完全一致）。 */
const EN = {
  panel: 'Error Digest',
  summary: '{distinct} kinds · {total} occurrences · {sessions} sessions',
  'scope.label': 'Scope',
  'scope.all': 'All sessions',
  'scope.all.title': 'Merge errors from every session on this machine',
  'scope.current': 'This chat',
  'scope.current.title': 'Only the conversation currently open',
  'scope.current.disabled': 'No conversation is open',
  'kind.tool': 'Tool failure',
  'kind.turn': 'Turn failure',
  'kind.model': 'Model retry',
  'kind.unknown': 'Other',
  count: '×{count}',
  'count.title': 'Total occurrences (repeats of the same error are merged)',
  'detail.empty': '(no readable error message)',
  'row.sessions': '{count} sessions',
  'row.lastSeen': 'last {time}',
  'action.analyze': 'Analyze',
  'action.analyze.title': 'Open a new conversation that analyzes the root cause and the fix',
  'action.prevent': 'Prevent',
  'action.prevent.title': 'Open a new conversation that changes rules/tools/docs so it cannot happen again',
  'empty.title': 'No errors recorded yet',
  'empty.body': 'Tool failures, failed turns and model retries from conversation logs are collected here and ranked by frequency as soon as the first one appears.',
  'empty.noCurrent.title': 'No conversation is open',
  'empty.noCurrent.body': 'Open a conversation first, or switch the scope back to "All sessions".',
  'empty.scanned': 'Scanned {sessions} sessions; session projection {state}',
  'empty.state.seen': 'is ready',
  'empty.state.missing': 'has not appeared on any session yet (visible once a new conversation fails)',
  'footer.note': 'Data comes from the session projection "{key}" and updates with new events; no refresh needed.',
  'source.tool': 'Tool {name}',
  'source.toolUnknown': 'Unknown tool',
  'source.model': 'Model request',
  'source.modelProvider': 'Model {name}',
  'source.turn': 'Whole turn',
  'source.unknown': 'Unknown source',
  'action.done': 'New conversation opened with the prompt in the composer',
  'action.failed': 'Could not open a new conversation; the prompt was copied to the clipboard',
  'prompt.analyze': [
    'Analyze this error that keeps recurring in DSH conversations and report:',
    '1) the root cause (prompt vs. tool contract vs. environment/dependency vs. code);',
    '2) the conditions that trigger it and the blast radius;',
    '3) concrete fix or workaround steps.',
    'Keep the investigation read-only and explain the plan before changing anything.',
    '',
    '- Kind: {kind}',
    '- Source: {source}',
    '- Code: {code}',
    '- Occurrences: {count}',
    '- Last seen: {lastSeen}',
    '- Error summary:',
    '{detail}',
  ].join('\n'),
  'prompt.prevent': [
    'Prevent this recurring DSH error from happening again:',
    '1) decide where it is best blocked (global AGENTS.md rules, the relevant skill instructions, tool argument validation and error messages, plugin code, docs);',
    '2) land the smallest change and explain which files changed and why that blocks it;',
    '3) leave a checklist for verifying later that the prevention is still in force.',
    'Explain the plan before changing anything.',
    '',
    '- Kind: {kind}',
    '- Source: {source}',
    '- Code: {code}',
    '- Occurrences: {count}',
    '- Last seen: {lastSeen}',
    '- Error summary:',
    '{detail}',
  ].join('\n'),
}

/**
 * 造一个「可延迟接入」的会话列表仓库。
 *
 * 为什么不是简单地拿到 `sessions.list` 就完事：客户端插件的物化顺序与服务的注册
 * 顺序不保证一致。这里把「有数据源」当成可变化的状态处理——接入时订阅源、断开时
 * 释放订阅，订阅者只跟这个仓库打交道，因此面板永远能安全渲染。
 * @returns {{ attach: (source: object) => () => void, getSnapshot: () => object,
 *   subscribe: (listener: () => void) => () => void }} 仓库。
 */
function createListStore() {
  /** 当前数据源（`sessions.list` 这样的快照对象）。 */
  let source = null
  /** 面板订阅者。 */
  const listeners = new Set()

  /**
   * 通知所有订阅者（单个订阅者抛错不影响其它订阅者，更不能影响 DSH）。
   * @returns {void}
   */
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] 快照订阅者抛错`, error)
      }
    }
  }

  return {
    /**
     * 接上一个数据源并转发它的变化。
     * @param {object} next `ctx.sessions.list`。
     * @returns {() => void} 断开函数（断开时退回到空快照）。
     */
    attach(next) {
      source = next
      let detachSource = () => {}
      try {
        if (typeof next?.subscribe === 'function') {
          detachSource = next.subscribe(notify) ?? (() => {})
        }
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] 订阅会话列表失败`, error)
      }
      notify()
      return () => {
        try {
          detachSource()
        } catch {
          /* 断开失败不影响后续清理 */
        }
        if (source === next) source = null
        notify()
      }
    },
    /** @returns {object} 当前快照（缺数据源时返回稳定空快照）。 */
    getSnapshot() {
      try {
        const value = source?.getSnapshot?.()
        return value !== null && typeof value === 'object' ? value : EMPTY_LIST_STATE
      } catch {
        return EMPTY_LIST_STATE
      }
    },
    /**
     * 订阅变化。
     * @param {() => void} listener 订阅者。
     * @returns {() => void} 取消订阅。
     */
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * 应用 Cordis 客户端插件。
 * @param {object} ctx 客户端 Cordis 上下文。
 */
function apply(ctx) {
  // ---- 文案 ----
  ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), `${PLUGIN_ID}: dictionaries`)
  const boundT = ctx.locale.bind(NS)

  // ---- 会话列表（含投影）快照仓库 ----
  const store = createListStore()
  /** 安全读取一个（可能尚未注册的）服务。 */
  const safeGet = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  try {
    ctx.inject(['sessions'], (scoped) => {
      scoped.effect(() => store.attach(scoped.sessions.list), `${PLUGIN_ID}: sessions feed`)
    })
  } catch (error) {
    console.warn(`[${PLUGIN_ID}] 注入 sessions 失败，面板将显示空状态`, error)
  }

  /**
   * 最近一次按钮动作的诊断（排障用：点下去到底发生了什么）。
   *
   * 为什么专门记这个：按钮的失败路径是**静默**的（服务缺席 → 退回剪贴板），
   * 界面上只表现为「点了没反应」。把 mode / 结果 / 失败原因留在诊断对象里，
   * 后续在控制台执行 `__DSH_ERROR_DIGEST__.lastAction` 就能一眼看出断在哪一步。
   */
  let lastAction = null

  /**
   * 取「新建对话」通路：优先用注入的服务，其次退回 `ctx.get()`。
   * @returns {object|undefined} `uiWorkspace` 服务。
   */
  const resolveUiWorkspace = () => {
    if (ctx.uiWorkspace !== undefined && ctx.uiWorkspace !== null) return ctx.uiWorkspace
    return safeGet('uiWorkspace')
  }

  /**
   * 等待排队的按钮动作，跨帧执行。
   *
   * ## 为什么必须「先切面板、下一帧再发起」
   *
   * `uiWorkspace.startSession()` 会在打开新会话的同一调用里准备草稿
   * （内部走 `conversation.input.requestDraftInitialization`）。而草稿初始化要求
   * **对话主面板已挂载**：用户点按钮时主面板正显示本插件，composer 不在树上，
   * 初始化会被判为阻断、`replaceMain` 抛错、整次打开被中止——表现就是「点了没反应」，
   * 而且只在控制台留一行 warning。
   *
   * 所以顺序是：先 `layout.selectPanel(null)` 切回对话（提交一帧），
   * 再在下一帧发起新建对话。`selectPanel` 本身不会连带新建会话，因此安全。
   */
  const pendingActions = []
  let pendingFlushTimer = null

  /**
   * 立刻执行所有排队的动作（诊断与单测用；真实界面由帧/定时器触发）。
   * @returns {number} 执行了几个动作。
   */
  const flushPendingActions = () => {
    if (pendingFlushTimer !== null) {
      clearTimeout(pendingFlushTimer)
      pendingFlushTimer = null
    }
    const queue = pendingActions.splice(0)
    for (const action of queue) {
      try {
        action()
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] 按钮动作执行失败`, error)
      }
    }
    return queue.length
  }

  /**
   * 把动作排到「下一帧之后」执行。
   * @param {() => void} action 动作。
   * @returns {void}
   */
  const scheduleAfterPaint = (action) => {
    pendingActions.push(action)
    try {
      if (typeof requestAnimationFrame === 'function') {
        // 双帧：第一帧提交「切回对话面板」，第二帧 composer 已挂载。
        requestAnimationFrame(() => {
          requestAnimationFrame(flushPendingActions)
        })
        return
      }
    } catch {
      /* 没有 rAF 的环境退回定时器 */
    }
    if (pendingFlushTimer === null) pendingFlushTimer = setTimeout(flushPendingActions, 50)
  }

  /**
   * 把提示词交给剪贴板 + 控制台（新对话通路不可用时的兜底）。
   * @param {string} prompt 提示词。
   * @param {Function} translate 文案函数。
   * @returns {void}
   */
  const fallBackToClipboard = (prompt, translate) => {
    try {
      void navigator?.clipboard?.writeText?.(prompt)?.catch?.(() => {})
    } catch {
      /* 剪贴板不可用时静默：提示词已经在控制台里留了一份 */
    }
    console.info(`[${PLUGIN_ID}] ${translate('action.failed')}\n${prompt}`)
  }

  /**
   * 主视图此刻是否已经换成「空白会话」。
   *
   * 这是「新建对话成功」唯一可靠的客户端信号：`startSession` 自己的失败路径是
   * 异步 catch + console.warn（界面上什么都不发生），所以只能用结果反查。
   * @returns {boolean} 主视图会话是否还没有任何事件（`blank`）。
   */
  const mainViewIsBlank = () => {
    const state = store.getSnapshot()
    const id = currentSessionIdOf(state)
    if (id === undefined) return false
    return state?.byId?.[id]?.blank === true
  }

  /**
   * 「分析 / 防范」：开启一个新对话，并把提示词填进它的输入框。
   * @param {object} row 合并后的错误行。
   * @param {'analyze'|'prevent'} mode 动作类型。
   * @param {Function} t 当前 locale 的文案函数。
   * @returns {boolean} 是否已排队发起（真正的打开在下一帧完成）。
   */
  const onAction = (row, mode, t) => {
    const translate = typeof t === 'function' ? t : boundT
    const record = { mode, at: Date.now(), promptLength: 0, opened: false, reason: null, retries: 0 }
    lastAction = record

    let prompt = ''
    try {
      prompt = buildPrompt(row, mode, translate, { lastSeen: formatDigestTime(row.lastTime) })
      record.promptLength = prompt.length
    } catch (error) {
      record.reason = `prompt: ${String(error)}`
      console.warn(`[${PLUGIN_ID}] 生成提示词失败`, error)
      return false
    }

    const uiWorkspace = resolveUiWorkspace()
    if (typeof uiWorkspace?.startSession !== 'function') {
      record.reason = 'ui-workspace-unavailable'
      fallBackToClipboard(prompt, translate)
      return false
    }

    /**
     * 发起一次新建对话；随后用「主视图是否变成空白会话」校验结果。
     *
     * 为什么要重试一次：`startSession` 内部有若干静默失败路径（工作区解析、
     * 草稿初始化被阻断），失败时界面什么都不显示。与其让用户面对「点了没反应」，
     * 不如在 300ms 后确认一次；仍未生效就再试一次，最后退回剪贴板。
     * 重试是安全的：`startSession` 复用同一个空白会话，不会产生两个新对话。
     * @param {number} remaining 还可以重试几次。
     */
    const attempt = (remaining) => {
      try {
        uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })
        record.opened = true
        record.reason = null
      } catch (error) {
        record.opened = false
        record.reason = `startSession: ${String(error)}`
        console.warn(`[${PLUGIN_ID}] 开启新对话失败，改用剪贴板`, error)
        fallBackToClipboard(prompt, translate)
        return
      }
      if (remaining <= 0) return
      setTimeout(() => {
        if (mainViewIsBlank()) return
        record.retries += 1
        attempt(remaining - 1)
      }, 300)
    }

    // 先切回对话主面板（让 composer 挂载），下一帧再发起新建对话。
    try {
      ctx.layout.selectPanel(null)
    } catch (error) {
      record.reason = `selectPanel: ${String(error)}`
      console.warn(`[${PLUGIN_ID}] 切回对话面板失败`, error)
    }
    scheduleAfterPaint(() => attempt(1))
    return true
  }

  // ---- 插槽：主面板 + 侧栏图标 ----
  const React = typeof require === 'function' ? require('react') : null
  if (React === null || typeof React.createElement !== 'function') {
    console.warn(`[${PLUGIN_ID}] 拿不到 React，跳过界面注册`)
    return
  }

  const DigestPanel = createDigestPanel(React, { store, onAction, fallbackT: boundT })
  const DigestIcon = createDigestIcon(React)

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, DigestPanel))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    locale: NS,
    label: () => boundT('panel'),
  }, DigestIcon))

  ctx.logger?.info?.(`[${PLUGIN_ID}] 客户端半已挂载：面板 ${PANEL_ID}（main + sidebar.panellist）`)

  // ---- 诊断入口（排障与自动化验收用；不影响界面） ----
  const diagnostics = {
    version: BUNDLE_VERSION,
    panelId: PANEL_ID,
    projectionKey: DIGEST_PROJECTION_KEY,
    /** 当前合并结果（与面板同一份推导逻辑）。 */
    snapshot: () => {
      const state = store.getSnapshot()
      const result = collectDigestRows(state, {})
      return {
        distinctCount: result.distinctCount,
        totalCount: result.totalCount,
        sessionsWithErrors: result.sessionsWithErrors,
        scannedSessions: result.scannedSessions,
        hasProjection: result.hasProjection,
        top: result.rows.slice(0, 10).map((row) => ({
          kind: row.kind,
          key: row.key,
          code: row.code,
          count: row.count,
          sessions: row.sessionCount,
          detail: row.detail.slice(0, 120),
        })),
      }
    },
    /**
     * 直接触发一次按钮动作（排障用；与点击走同一条实现）。
     * 跨帧调度会在返回前被立即清空，因此这里的返回值就是「有没有真的打开」。
     * @param {'analyze'|'prevent'} mode 动作。
     * @param {number} [index] 取排序后第几条（默认 0）。
     * @returns {boolean} 是否真的把提示词送进了新对话。
     */
    trigger: (mode, index = 0) => {
      const result = collectDigestRows(store.getSnapshot(), {})
      const row = result.rows[index]
      if (row === undefined) return false
      const accepted = onAction(row, mode === 'prevent' ? 'prevent' : 'analyze', boundT)
      flushPendingActions()
      return accepted && lastAction?.opened === true
    },
    /** 立即执行排队的按钮动作（排障用）。 */
    flushActions: () => flushPendingActions(),
    /** 当前「当前对话」会话 id（排障用）。 */
    currentSessionId: () => currentSessionIdOf(store.getSnapshot()),
    /** 最近一次按钮动作的结果（排障用）：`{ mode, opened, reason, promptLength }`。 */
    lastAction: () => lastAction,
    /** 「新建对话」通路是否可见（排障用）。 */
    canOpenConversation: () => typeof resolveUiWorkspace()?.startSession === 'function',
  }

  ctx.effect(() => {
    try {
      globalThis.__DSH_ERROR_DIGEST__ = diagnostics
    } catch {
      /* 宿主环境不允许挂全局：忽略 */
    }
    return () => {
      try {
        if (globalThis.__DSH_ERROR_DIGEST__ === diagnostics) delete globalThis.__DSH_ERROR_DIGEST__
      } catch {
        /* 忽略 */
      }
      // 插件被卸载时不要留下悬挂的定时器与排队动作。
      pendingActions.length = 0
      if (pendingFlushTimer !== null) {
        clearTimeout(pendingFlushTimer)
        pendingFlushTimer = null
      }
    }
  }, `${PLUGIN_ID}: diagnostics`)

  // 首帧空转告警：宿主半没挂上时界面只会「一直空」，日志里留一条线索。
  if (typeof boundT === 'function' && safeGet('sessions') === undefined) {
    console.warn(`[${PLUGIN_ID}] 尚未就绪：sessions 服务未注册，面板先显示空状态`)
  }
}
