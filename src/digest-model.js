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
export const DIGEST_PROJECTION_KEY = 'dialogErrors'

/** 合并后的行数上限（界面上一屏之外的排名没有意义，也防止极端会话把内存拉爆）。 */
export const MERGED_ROW_LIMIT = 200

/** 每行最多记录多少个来源会话（其余折成「还有 N 个」）。 */
export const MERGED_SESSION_SAMPLE = 12

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
export function sessionTitleOf(listState, sessionId) {
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
export function currentSessionIdOf(listState) {
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
export function collectDigestRows(listState, options = {}) {
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
export function kindLabelKey(kind) {
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
export function sourceLabelOf(row, t) {
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
export function buildPrompt(row, mode, t, extra = {}) {
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
