/**
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
	id: "dsh-error-digest",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 客户端半的构建版本；由 build/bundle.mjs 从 package.json 注入。 */
		const BUNDLE_VERSION = "0.1.0";

		//#region src/digest-model.js

		/**
		 * dsh-error-digest —— 客户端纯逻辑模型
		 *
		 * 这一层不碰 DOM、不碰 React、不碰任何 DSH 服务：输入是会话列表快照
		 * （`ctx.sessions.list.getSnapshot()`），输出是**已经合并好、排好序**的错误行。
		 * 因此它可以被单测直接覆盖，也解释了客户端半为什么不需要 retain 任何会话。
		 *
		 * ## 数据从哪来
		 *
		 * 宿主半注册了 `dialogErrors` 会话投影，值随会话列表 RPC 一起到达客户端
		 * （`SessionListState.projectionsBySession[id].values.dialogErrors`）。每个值形如：
		 *
		 *   { entries: [{ sig, kind, key, code, detail, count, firstTime, lastTime, lastSeq }] }
		 *
		 * 宿主半已按签名把**同一会话内**的重复错误合并过；这里再做一次**跨会话**合并，
		 * 于是「同一个错误在 20 个会话里各出现 3 次」会变成一行 ×60，而不是 20 行。
		 *
		 * ## 为什么不用客户端自己折叠会话事件
		 *
		 * 客户端的会话事件流只在会话被 retain 时才有；折叠它既拿不到冷会话，又会把别人的
		 * 历史激活。投影是受支持通道，主机侧折叠 + 客户端只做合并展示是唯一稳定的分工。
		 *
		 * @module dsh-error-digest/model
		 */

		/**
		 * 宿主半注册的会话投影键。
		 *
		 * 客户端 bundle 不能 import 宿主文件，所以这里重复一份字符串；
		 * `test/digest-model-test.mjs` 会断言它与宿主半导出的常量一致。
		 */
		const DIGEST_PROJECTION_KEY = 'dialogErrors'

		/** 合并后的行数上限（界面上一屏之外的排名没有意义，也防止极端会话把内存拉爆）。 */
		const MERGED_ROW_LIMIT = 200

		/** 每行最多记录多少个来源会话（其余折成「还有 N 个」）。 */
		const MERGED_SESSION_SAMPLE = 12

		/**
		 * 从会话列表快照里取某个会话的投影值。
		 *
		 * 兼容两个位置：
		 *   - `projectionsBySession[id].values[key]`（会话列表 RPC 的常规形状）；
		 *   - `byId[id].projectionValues[key]`（搜索 / 本地兜底行的形状）。
		 * 都没有时返回 `undefined`——它与「有键但值为空」含义不同：
		 * 前者表示宿主半还没给这个会话算出投影，后者表示确实一条错误都没有。
		 * @param {object} listState 会话列表快照。
		 * @param {string} sessionId 会话 id。
		 * @param {string} key 投影键。
		 * @returns {unknown} 投影值或 undefined。
		 */
		function projectionValueOf(listState, sessionId, key) {
		  const values = listState?.projectionsBySession?.[sessionId]?.values
		  if (values !== null && typeof values === 'object' && Object.hasOwn(values, key)) return values[key]
		  const row = listState?.byId?.[sessionId]
		  const inline = row?.projectionValues
		  if (inline !== null && typeof inline === 'object' && Object.hasOwn(inline, key)) return inline[key]
		  return undefined
		}

		/**
		 * 取会话的展示名，取不到时回落到 id。
		 * @param {object} listState 会话列表快照。
		 * @param {string} sessionId 会话 id。
		 * @returns {string} 展示名。
		 */
		function sessionTitleOf(listState, sessionId) {
		  const row = listState?.byId?.[sessionId]
		  const title = typeof row?.displayTitle === 'string' && row.displayTitle !== ''
		    ? row.displayTitle
		    : (typeof row?.title === 'string' && row.title !== '' ? row.title : '')
		  return title !== '' ? title : sessionId
		}

		/**
		 * 找出「主视图正在显示」的会话 id。
		 *
		 * DSH 的会话列表行带 `retainedBy.mainView` 计数，这正是「当前打开着哪个对话」的
		 * 权威来源；插件自己不保存任何选中状态。
		 * @param {object} listState 会话列表快照。
		 * @returns {string|undefined} 当前对话的会话 id。
		 */
		function currentSessionIdOf(listState) {
		  const byId = listState?.byId
		  if (byId === null || typeof byId !== 'object') return undefined
		  for (const id of Object.keys(byId)) {
		    const row = byId[id]
		    if (row !== null && typeof row === 'object' && (row.retainedBy?.mainView ?? 0) > 0) return id
		  }
		  return undefined
		}

		/**
		 * 造一个空的合并累加器。
		 * @returns {{ sig: string, kind: string, key: string, code: string, detail: string,
		 *   count: number, firstTime: number, lastTime: number, sessions: object[] }} 累加项。
		 */
		function emptyRow(entry, sessionId) {
		  return {
		    sig: entry.sig,
		    kind: entry.kind,
		    key: typeof entry.key === 'string' ? entry.key : '',
		    code: typeof entry.code === 'string' ? entry.code : '',
		    detail: typeof entry.detail === 'string' ? entry.detail : '',
		    count: 0,
		    firstTime: Number.isFinite(entry.firstTime) ? entry.firstTime : 0,
		    lastTime: Number.isFinite(entry.lastTime) ? entry.lastTime : 0,
		    sessions: [],
		    sessionId,
		  }
		}

		/**
		 * 把累加项按来源会话记账。
		 * @param {object} row 累加项。
		 * @param {string} sessionId 会话 id。
		 * @param {string} title 会话展示名。
		 * @param {number} count 该会话里的次数。
		 * @returns {void}
		 */
		function noteSession(row, sessionId, title, count) {
		  const found = row.sessions.find((item) => item.id === sessionId)
		  if (found === undefined) {
		    row.sessions.push({ id: sessionId, title, count })
		    return
		  }
		  found.count += count
		}

		/**
		 * 跨会话合并并排序。
		 *
		 * @param {object} listState 会话列表快照（`SessionListState`）。
		 * @param {{ scopeSessionId?: string|null, key?: string, limit?: number }} [options]
		 *   `scopeSessionId` 的三种取值刻意不同：
		 *     - 缺省（`undefined`）：统计全部会话；
		 *     - 会话 id：只统计这一个会话；
		 *     - `null`：统计范围为空（「当前对话」视图但此刻没有打开的对话），结果为空。
		 *   把 `null` 与 `undefined` 分开，是为了让「没有当前对话」看起来是空列表，
		 *   而不是悄悄退化成「全部会话」——后者会让界面上写着「当前对话」却列出别人的错误。
		 * @returns {{ rows: object[], distinctCount: number, totalCount: number,
		 *   sessionsWithErrors: number, scannedSessions: number, hasProjection: boolean,
		 *   scopeSessionId: string|null }} 合并结果。
		 */
		function collectDigestRows(listState, options = {}) {
		  const key = typeof options.key === 'string' && options.key !== '' ? options.key : DIGEST_PROJECTION_KEY
		  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : MERGED_ROW_LIMIT
		  const hasScope = options.scopeSessionId !== undefined
		  const scopeSessionId = hasScope && typeof options.scopeSessionId === 'string' && options.scopeSessionId !== ''
		    ? options.scopeSessionId
		    : null

		  const byId = listState?.byId !== null && typeof listState?.byId === 'object' ? listState.byId : {}
		  const projections = listState?.projectionsBySession
		  const known = new Set(Object.keys(byId))
		  if (projections !== null && typeof projections === 'object') {
		    for (const id of Object.keys(projections)) known.add(id)
		  }
		  let candidates = [...known]
		  if (hasScope) candidates = scopeSessionId === null ? [] : [scopeSessionId]

		  /** @type {Map<string, object>} */
		  const merged = new Map()
		  let hasProjection = false
		  let totalCount = 0
		  let sessionsWithErrors = 0

		  for (const sessionId of candidates) {
		    if (sessionId === null || sessionId === undefined || sessionId === '') continue
		    const value = projectionValueOf(listState, sessionId, key)
		    if (value === undefined) continue
		    hasProjection = true
		    const entries = Array.isArray(value?.entries) ? value.entries : []
		    if (entries.length === 0) continue
		    sessionsWithErrors += 1
		    const title = sessionTitleOf(listState, sessionId)
		    for (const entry of entries) {
		      if (entry === null || typeof entry !== 'object' || typeof entry.sig !== 'string') continue
		      const count = Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1
		      let row = merged.get(entry.sig)
		      if (row === undefined) {
		        row = emptyRow(entry, sessionId)
		        merged.set(entry.sig, row)
		      }
		      row.count += count
		      totalCount += count
		      if (Number.isFinite(entry.firstTime) && (row.firstTime === 0 || entry.firstTime < row.firstTime)) {
		        row.firstTime = entry.firstTime
		      }
		      if (Number.isFinite(entry.lastTime) && entry.lastTime > row.lastTime) {
		        row.lastTime = entry.lastTime
		      }
		      noteSession(row, sessionId, title, count)
		    }
		  }

		  const rows = [...merged.values()]
		  for (const row of rows) {
		    row.sessionCount = row.sessions.length
		    row.sessions.sort((left, right) => right.count - left.count)
		    row.sessions = row.sessions.slice(0, MERGED_SESSION_SAMPLE)
		  }
		  // 高频优先；次数相同时「最近出现」优先，让新故障排在老故障前面。
		  rows.sort((left, right) => (right.count - left.count) || (right.lastTime - left.lastTime) || left.sig.localeCompare(right.sig))

		  return {
		    rows: rows.slice(0, limit),
		    distinctCount: merged.size,
		    totalCount,
		    sessionsWithErrors,
		    scannedSessions: candidates.length,
		    hasProjection,
		    scopeSessionId,
		  }
		}

		/**
		 * 类别文案键。
		 * @param {string} kind 错误类别。
		 * @returns {string} locale 文案键。
		 */
		function kindLabelKey(kind) {
		  if (kind === 'tool') return 'kind.tool'
		  if (kind === 'turn') return 'kind.turn'
		  if (kind === 'model') return 'kind.model'
		  return 'kind.unknown'
		}

		/**
		 * 一条错误的「来源」文案：工具名 / 模型提供方 / 回合。
		 * @param {object} row 合并后的行。
		 * @param {(key: string, params?: object) => string} t 文案函数。
		 * @returns {string} 来源描述。
		 */
		function sourceLabelOf(row, t) {
		  const key = typeof row?.key === 'string' ? row.key : ''
		  if (row?.kind === 'tool') return key === '' || key === 'unknown' ? t('source.toolUnknown') : t('source.tool', { name: key })
		  if (row?.kind === 'model') return key === '' ? t('source.model') : t('source.modelProvider', { name: key })
		  if (row?.kind === 'turn') return t('source.turn')
		  return t('source.unknown')
		}

		/**
		 * 组装「分析 / 防范」提示词。
		 *
		 * 两个按钮的区别只在提示词：
		 *   - `analyze`：查清根因与影响，给出修复/规避方案（只读为主）；
		 *   - `prevent`：落到「改哪一层 + 最小改动 + 自查清单」，目标是**以后不再发生**。
		 * @param {object} row 合并后的行。
		 * @param {'analyze'|'prevent'} mode 动作。
		 * @param {(key: string, params?: object) => string} t 文案函数。
		 * @param {{ lastSeen?: string }} [extra] 额外替换项（界面已格式化好的时间）。
		 * @returns {string} 提示词。
		 */
		function buildPrompt(row, mode, t, extra = {}) {
		  const templateKey = mode === 'prevent' ? 'prompt.prevent' : 'prompt.analyze'
		  return t(templateKey, {
		    kind: t(kindLabelKey(row?.kind)),
		    source: sourceLabelOf(row, t),
		    code: typeof row?.code === 'string' && row.code !== '' ? row.code : '-',
		    count: String(row?.count ?? 0),
		    lastSeen: typeof extra.lastSeen === 'string' && extra.lastSeen !== '' ? extra.lastSeen : '-',
		    detail: typeof row?.detail === 'string' && row.detail !== '' ? row.detail : t('detail.empty'),
		  })
		}

		//#endregion
		//#region src/digest-ui.js

		/**
		 * dsh-error-digest —— 客户端 UI（React 组件工厂，裸脚本，无 import/export）
		 *
		 * 两个组件：
		 *   - `createDigestPanel`：主面板（注册进根级 `main` 的 keyed 插槽，key 与侧栏
		 *     面板 id 相同），错误按频次排序，每条带「分析」「防范」两个按钮；
		 *   - `createDigestIcon`：侧栏 `sidebar.panellist` 的图标（原装插槽只给
		 *     `{ size, active }`，颜色必须跟随 `currentColor` 才能跟上选中态与主题）。
		 *
		 * ## 样式为什么渲染成 <style> 元素
		 *
		 * 宿主只用两种颜色体系：主题令牌（`--dsw-alias-*`）和自己打包的 CSS Modules。
		 * 插件拿不到后者的类名，所以这里把少量结构样式写成一个**随组件一起渲染的**
		 * `<style>` 元素：挂载时生效、卸载时随之消失，既不需要写 document.head，
		 * 也不会在页面里留下孤儿样式。颜色一律走令牌，明暗主题自动跟随。
		 *
		 * 依赖（`deps`）只有两样：会话列表快照仓库（订阅 + 读取）与动作回调
		 * `onAction(row, mode, t)`。数据推导全部交给同作用域的纯逻辑模块。
		 *
		 * @module dsh-error-digest/ui
		 */

		/**
		 * 面板样式表。类名统一 `ded-` 前缀，避免与宿主或其它插件撞名。
		 * @returns {string} CSS 文本。
		 */
		function digestStyleText() {
		  return `
		.ded-page {
		  box-sizing: border-box;
		  height: 100%;
		  overflow-y: auto;
		  padding: 20px 24px 32px;
		  background: var(--dsw-alias-bg-base);
		  color: var(--dsw-alias-label-primary);
		  font-size: 13px;
		  line-height: 1.5;
		}
		.ded-header {
		  display: flex;
		  flex-direction: column;
		  gap: 10px;
		  margin-bottom: 16px;
		}
		.ded-heading {
		  display: flex;
		  align-items: baseline;
		  gap: 12px;
		  flex-wrap: wrap;
		}
		.ded-heading h1 {
		  margin: 0;
		  font-size: 18px;
		  font-weight: 600;
		  line-height: 1.3;
		}
		.ded-summary {
		  color: var(--dsw-alias-label-secondary);
		  font-size: 12px;
		}
		.ded-controls {
		  display: flex;
		  align-items: center;
		  gap: 10px;
		  flex-wrap: wrap;
		}
		.ded-scope {
		  display: inline-flex;
		  border: 1px solid var(--dsw-alias-border-l1);
		  border-radius: 8px;
		  overflow: hidden;
		  background: var(--dsw-alias-bg-layer-1);
		}
		.ded-scope button {
		  appearance: none;
		  border: 0;
		  background: transparent;
		  color: var(--dsw-alias-label-secondary);
		  font: inherit;
		  font-size: 12px;
		  padding: 4px 10px;
		  cursor: pointer;
		}
		.ded-scope button + button {
		  border-left: 1px solid var(--dsw-alias-border-l1);
		}
		.ded-scope button[aria-pressed="true"] {
		  background: var(--dsw-alias-bg-layer-2);
		  color: var(--dsw-alias-label-primary);
		  font-weight: 600;
		}
		.ded-scope button:disabled {
		  cursor: not-allowed;
		  opacity: 0.45;
		}
		.ded-scope button:focus-visible,
		.ded-btn:focus-visible {
		  outline: 2px solid var(--dsw-alias-brand-primary);
		  outline-offset: 2px;
		}
		.ded-list {
		  display: flex;
		  flex-direction: column;
		  gap: 8px;
		}
		.ded-card {
		  display: flex;
		  gap: 12px;
		  align-items: flex-start;
		  padding: 12px 14px;
		  border: 1px solid var(--dsw-alias-border-l1);
		  border-radius: 10px;
		  background: var(--dsw-alias-bg-layer-1);
		}
		.ded-rank {
		  flex: 0 0 20px;
		  text-align: right;
		  font-variant-numeric: tabular-nums;
		  font-size: 12px;
		  color: var(--dsw-alias-label-secondary);
		  padding-top: 2px;
		}
		.ded-main {
		  flex: 1 1 auto;
		  min-width: 0;
		}
		.ded-titleline {
		  display: flex;
		  align-items: center;
		  gap: 8px;
		  flex-wrap: wrap;
		}
		.ded-kind {
		  flex: 0 0 auto;
		  font-size: 11px;
		  line-height: 18px;
		  padding: 0 6px;
		  border-radius: 4px;
		  border: 1px solid var(--dsw-alias-border-l1);
		  color: var(--dsw-alias-label-secondary);
		  background: var(--dsw-alias-bg-layer-2);
		}
		.ded-kind-tool {
		  color: var(--dsw-alias-state-error-primary);
		}
		.ded-kind-turn {
		  color: var(--dsw-alias-state-warn-primary);
		}
		.ded-kind-model {
		  color: var(--dsw-alias-state-idle-primary);
		}
		.ded-source {
		  font-weight: 600;
		  overflow: hidden;
		  text-overflow: ellipsis;
		  white-space: nowrap;
		  max-width: 320px;
		}
		.ded-code {
		  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		  font-size: 11px;
		  color: var(--dsw-alias-label-secondary);
		}
		.ded-count {
		  margin-left: auto;
		  flex: 0 0 auto;
		  font-variant-numeric: tabular-nums;
		  font-weight: 600;
		  color: var(--dsw-alias-state-error-primary);
		}
		.ded-detail {
		  margin: 6px 0 0;
		  color: var(--dsw-alias-label-secondary);
		  font-size: 12px;
		  white-space: pre-wrap;
		  overflow-wrap: anywhere;
		}
		.ded-meta {
		  margin-top: 6px;
		  font-size: 11px;
		  color: var(--dsw-alias-label-secondary);
		}
		.ded-actions {
		  flex: 0 0 auto;
		  display: flex;
		  gap: 6px;
		  align-items: center;
		}
		.ded-btn {
		  appearance: none;
		  font: inherit;
		  font-size: 12px;
		  line-height: 20px;
		  padding: 3px 10px;
		  border-radius: 6px;
		  cursor: pointer;
		  border: 1px solid transparent;
		  white-space: nowrap;
		}
		.ded-btn-primary {
		  /* 刻意不用实心品牌色 + 白字：令牌里没有「品牌色上的文字色」，写死白色在浅色主题或
		     品牌色变亮时就会失去对比度。用「品牌色描边 + 品牌色文字」表达主次，明暗都安全。 */
		  background: transparent;
		  border-color: var(--dsw-alias-brand-primary);
		  color: var(--dsw-alias-brand-primary);
		  font-weight: 600;
		}
		.ded-btn-primary:hover {
		  background: var(--dsw-alias-bg-layer-2);
		}
		.ded-btn-ghost {
		  background: transparent;
		  border-color: var(--dsw-alias-border-l2);
		  color: var(--dsw-alias-label-primary);
		}
		.ded-btn-ghost:hover {
		  background: var(--dsw-alias-bg-layer-2);
		}
		.ded-empty {
		  border: 1px dashed var(--dsw-alias-border-l2);
		  border-radius: 10px;
		  padding: 28px 24px;
		  text-align: center;
		  color: var(--dsw-alias-label-secondary);
		  background: var(--dsw-alias-bg-layer-1);
		}
		.ded-empty strong {
		  display: block;
		  color: var(--dsw-alias-label-primary);
		  font-size: 14px;
		  margin-bottom: 6px;
		}
		.ded-empty p {
		  margin: 0;
		  font-size: 12px;
		}
		.ded-note {
		  margin-top: 14px;
		  font-size: 11px;
		  color: var(--dsw-alias-label-secondary);
		}
		`
		}

		/**
		 * 把时间戳格式化成本地时间（面板里展示「最近一次」）。
		 * @param {number} time epoch 毫秒；非法值返回占位符。
		 * @returns {string} 本地时间字符串。
		 */
		function formatDigestTime(time) {
		  if (!Number.isFinite(time) || time <= 0) return '-'
		  try {
		    return new Date(time).toLocaleString()
		  } catch {
		    return '-'
		  }
		}

		/**
		 * 造主面板组件。
		 * @param {object} React React 命名空间（由模块工厂的 require 注入）。
		 * @param {{
		 *   store: { subscribe: (listener: () => void) => () => void, getSnapshot: () => object },
		 *   onAction: (row: object, mode: 'analyze'|'prevent', t: Function) => void,
		 *   fallbackT: (key: string, params?: object) => string,
		 * }} deps 依赖：会话列表仓库、动作回调、文案回落。
		 * @returns {(props: object) => object} React 组件。
		 */
		function createDigestPanel(React, deps) {
		  const h = React.createElement

		  /**
		   * 订阅一个快照仓库：React 18+ 走 useSyncExternalStore，旧版本退化为单次读取。
		   * @param {object} store 仓库。
		   * @returns {object} 当前快照。
		   */
		  function useSnapshot(store) {
		    if (typeof React.useSyncExternalStore === 'function') {
		      return React.useSyncExternalStore(store.subscribe, store.getSnapshot)
		    }
		    return store.getSnapshot()
		  }

		  /**
		   * 一条错误的卡片。
		   * @param {{ row: object, rank: number, t: Function, onAction: Function }} props 行属性。
		   * @returns {object} React 元素。
		   */
		  function Row(props) {
		    const { row, rank, t, onAction } = props
		    const detail = typeof row.detail === 'string' && row.detail !== '' ? row.detail : t('detail.empty')
		    return h('article', {
		      className: 'ded-card',
		      'data-testid': 'error-digest-row',
		      'data-kind': row.kind,
		      'data-sig': row.sig,
		    }, [
		      h('div', { className: 'ded-rank', key: 'rank' }, String(rank)),
		      h('div', { className: 'ded-main', key: 'main' }, [
		        h('div', { className: 'ded-titleline', key: 'title' }, [
		          h('span', { className: `ded-kind ded-kind-${row.kind}`, key: 'kind' }, t(kindLabelKey(row.kind))),
		          h('span', { className: 'ded-source', key: 'source', title: sourceLabelOf(row, t) }, sourceLabelOf(row, t)),
		          typeof row.code === 'string' && row.code !== ''
		            ? h('code', { className: 'ded-code', key: 'code' }, row.code)
		            : null,
		          h('span', { className: 'ded-count', key: 'count', title: t('count.title') }, t('count', { count: row.count })),
		        ]),
		        h('p', { className: 'ded-detail', key: 'detail' }, detail),
		        h('div', { className: 'ded-meta', key: 'meta' },
		          `${t('row.sessions', { count: row.sessionCount })} · ${t('row.lastSeen', { time: formatDigestTime(row.lastTime) })}`),
		      ]),
		      h('div', { className: 'ded-actions', key: 'actions' }, [
		        h('button', {
		          type: 'button',
		          key: 'analyze',
		          className: 'ded-btn ded-btn-primary',
		          'data-testid': 'error-digest-analyze',
		          title: t('action.analyze.title'),
		          onClick: () => onAction(row, 'analyze', t),
		        }, t('action.analyze')),
		        h('button', {
		          type: 'button',
		          key: 'prevent',
		          className: 'ded-btn ded-btn-ghost',
		          'data-testid': 'error-digest-prevent',
		          title: t('action.prevent.title'),
		          onClick: () => onAction(row, 'prevent', t),
		        }, t('action.prevent')),
		      ]),
		    ])
		  }

		  /**
		   * 主面板：标题、口径切换（全部会话 / 当前对话）、按频次排序的错误列表。
		   * @param {{ t?: Function }} props 插槽属性（`locale` 注册会注入 `t`）。
		   * @returns {object} React 元素。
		   */
		  function DigestPanel(props) {
		    const t = typeof props?.t === 'function' ? props.t : deps.fallbackT
		    const listState = useSnapshot(deps.store)
		    const [scope, setScope] = React.useState('all')

		    const currentId = currentSessionIdOf(listState)
		    const hasCurrent = typeof currentId === 'string' && currentId !== ''
		    const scoped = scope === 'current'
		    // 「当前对话」但没有打开的对话时，显式传 null（空范围），
		    // 而不是省掉参数——省掉参数会退化成「全部会话」，与按钮上写的口径不符。
		    const result = collectDigestRows(listState, scoped ? { scopeSessionId: hasCurrent ? currentId : null } : {})
		    const { rows } = result

		    const scopeButton = (id, label, disabled, title) => h('button', {
		      type: 'button',
		      key: id,
		      'aria-pressed': scope === id ? 'true' : 'false',
		      'data-testid': `error-digest-scope-${id}`,
		      disabled,
		      title,
		      onClick: () => setScope(id),
		    }, label)

		    const empty = h('div', { className: 'ded-empty', 'data-testid': 'error-digest-empty', key: 'empty' }, [
		      h('strong', { key: 'title' }, scoped && !hasCurrent ? t('empty.noCurrent.title') : t('empty.title')),
		      h('p', { key: 'body' }, scoped && !hasCurrent ? t('empty.noCurrent.body') : t('empty.body')),
		      h('p', { key: 'scan', style: { marginTop: '8px' } },
		        t('empty.scanned', {
		          sessions: result.scannedSessions,
		          state: result.hasProjection ? t('empty.state.seen') : t('empty.state.missing'),
		        })),
		    ])

		    return h('section', { className: 'ded-page', 'aria-label': t('panel'), 'data-testid': 'error-digest-page' }, [
		      h('style', { key: 'style' }, digestStyleText()),
		      h('div', { className: 'ded-header', key: 'header' }, [
		        h('div', { className: 'ded-heading', key: 'heading' }, [
		          h('h1', { key: 'h1' }, t('panel')),
		          h('span', { className: 'ded-summary', key: 'summary' }, t('summary', {
		            distinct: result.distinctCount,
		            total: result.totalCount,
		            sessions: result.sessionsWithErrors,
		          })),
		        ]),
		        h('div', { className: 'ded-controls', key: 'controls' }, [
		          h('div', { className: 'ded-scope', key: 'scope', role: 'group', 'aria-label': t('scope.label') }, [
		            scopeButton('all', t('scope.all'), false, t('scope.all.title')),
		            scopeButton('current', t('scope.current'), !hasCurrent, hasCurrent ? t('scope.current.title') : t('scope.current.disabled')),
		          ]),
		        ]),
		      ]),
		      h('div', { className: 'ded-list', key: 'list' },
		        rows.length === 0
		          ? empty
		          : rows.map((row, index) => h(Row, {
		            key: row.sig,
		            row,
		            rank: index + 1,
		            t,
		            onAction: deps.onAction,
		          }))),
		      h('div', { className: 'ded-note', key: 'note' }, t('footer.note', { key: DIGEST_PROJECTION_KEY })),
		    ])
		  }

		  return DigestPanel
		}

		/**
		 * 造侧栏面板图标。
		 *
		 * 侧栏只给 `{ size, active }`：颜色必须走 `currentColor`，选中态与主题才会自动生效。
		 * 图形语义：三条由长到短的横条（频次排名）+ 右上角错误点。
		 * @param {object} React React 命名空间。
		 * @returns {(props: object) => object} React 组件。
		 */
		function createDigestIcon(React) {
		  const h = React.createElement
		  return function DigestIcon(props) {
		    const size = Number.isFinite(props?.size) && props.size > 0 ? props.size : 16
		    return h('svg', {
		      width: size,
		      height: size,
		      viewBox: '0 0 24 24',
		      fill: 'none',
		      'aria-hidden': true,
		      focusable: false,
		      style: { display: 'block' },
		    }, [
		      h('rect', { key: 'r1', x: 3, y: 8, width: 15, height: 2.4, rx: 1.2, fill: 'currentColor' }),
		      h('rect', { key: 'r2', x: 3, y: 12.6, width: 11, height: 2.4, rx: 1.2, fill: 'currentColor', opacity: 0.7 }),
		      h('rect', { key: 'r3', x: 3, y: 17.2, width: 7, height: 2.4, rx: 1.2, fill: 'currentColor', opacity: 0.45 }),
		      h('circle', { key: 'dot', cx: 19, cy: 5.5, r: 3.2, fill: 'var(--dsw-alias-state-error-primary, currentColor)' }),
		    ])
		  }
		}

		//#endregion
		//#region src/client-main.js

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

		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
