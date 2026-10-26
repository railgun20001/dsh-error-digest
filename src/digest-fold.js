/**
 * dsh-error-digest —— 宿主半的错误折叠逻辑（纯函数，可单测）
 *
 * 这一层只做一件事：**把会话日志里「出错的那几个事件」折叠成一份可持久化、
 * 可序列化、有上限的小状态**，供会话投影（`ctx.sessionProjections`）驱动。
 *
 * ## 收哪些事件
 *
 * | 事件 | 含义 | 归类 |
 * | --- | --- | --- |
 * | `tool/result` + `data.error` 或 `message.isError` | 工具执行失败（命令非零退出、编辑找不到匹配、校验拒绝……） | `tool` |
 * | `turn/end` 且 `reason.kind === 'error'` | 整轮失败（模型请求在重试耗尽后仍失败） | `turn` |
 * | `llm/retry` | 一次模型请求失败并触发重试（503 / 超时 / 限流……） | `model` |
 *
 * 其它事件一律原样返回旧引用：投影框架按引用相等判定「值变没变」，
 * 返回同一个引用等于零成本。
 *
 * ## 为什么要「合并」
 *
 * 同一个错误在一个会话里会重复几十次（比如反复 `edit` 找不到唯一匹配）。
 * 逐条展示没有意义，所以每个错误在写入时就压成一个**签名**（kind + 工具/提供方 +
 * 错误码 + 归一化后的首段摘要），同签名累加次数：
 *
 *   { sig, kind, key, code, detail, count, firstTime, lastTime, lastSeq }
 *
 * 归一化会抹掉 UUID、长十六进制、长数字、绝对路径和行列号，因此
 * 「同一类错误在不同文件/不同会话里」也能合并到一起。
 *
 * ## 为什么状态里还要记 `calls`
 *
 * `tool/result` 不带工具名：工具名只出现在配对的 `tool/call` 事件里（结果消息只有
 * `callId`）。投影的 `apply` 只能看到一个事件，所以折叠时必须自己记住
 * 「callId → 工具名」。这张表在结果到达后立即删除对应项，正常滚动时只有几个正在
 * 执行中的调用，因此体积很小（另设上限防泄漏）。
 *
 * @module dsh-error-digest/fold
 */

/**
 * 本插件注册的会话投影键。
 *
 * 宿主半（写）、客户端半（读）、诊断路由（探活）共用这一个字符串，
 * 因此它只在这里定义一次，别处一律引用。
 */
export const DIGEST_PROJECTION_KEY = 'dialogErrors'

/**
 * 投影状态版本。
 *
 * 注册表按 `(sessionId, key, ver, seq)` 落检查点；**改变状态形状必须递增**，
 * 否则旧检查点会被当成新形状读入。
 */
export const DIGEST_STATE_VERSION = 1

/** 单个会话最多保留多少条「不同签名」的错误。 */
export const DIGEST_MAX_ENTRIES = 60

/** 在途工具调用（callId → 工具名）最多记多少个。 */
export const DIGEST_MAX_PENDING_CALLS = 128

/** 摘要（detail）长度上限。 */
export const DIGEST_DETAIL_LIMIT = 240

/** 参与签名的摘要长度上限：太长会让「同一类错误」因为尾巴不同而分家。 */
export const DIGEST_SIGNATURE_LIMIT = 96

/** 合法的错误类别。 */
export const DIGEST_KINDS = Object.freeze(['tool', 'turn', 'model'])

const KIND_SET = new Set(DIGEST_KINDS)

/**
 * 判断一个值是不是普通对象（排除 null / 数组）。
 * @param {unknown} value 待判断的值。
 * @returns {boolean} 是否普通对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把任意值压成「空串或去掉首尾空白的字符串」。
 * @param {unknown} value 原始值。
 * @returns {string} 字符串或空串。
 */
function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把空白（含换行、连续空格）压成单个空格，并截断到上限。
 * @param {unknown} value 原始值。
 * @param {number} limit 上限。
 * @returns {string} 归一化后的字符串。
 */
function collapse(value, limit) {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return ''
  const flat = text.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, Math.max(1, limit - 1))}…`
}

/**
 * 归一化一段错误摘要，供签名使用。
 *
 * 抹掉的都是「同一次故障每次都不同」的部分：UUID、长十六进制、绝对路径、
 * 行列号、三位以上数字。保留的是真正描述错误的文字。
 * @param {string} text 原始摘要。
 * @returns {string} 归一化后的摘要（未截断）。
 */
export function normalizeForSignature(text) {
  if (typeof text !== 'string' || text === '') return ''
  return text
    .replace(/\r\n?/g, '\n')
    // UUID（先于长十六进制处理，否则会被拆成 <hex>）
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    // Windows 绝对路径
    .replace(/[A-Za-z]:\\[^\s"'<>|]+/g, '<path>')
    // POSIX 多段路径
    .replace(/(?:\/(?:[\w.@-]+)){2,}/g, '<path>')
    // 行列号：src/a.ts:12:34
    .replace(/:\d+:\d+/g, ':<loc>')
    // 长十六进制（哈希、提交号）
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    // 带单位的时间 / 体积：耗时与字节数总是波动（3ms / 12000ms），与位数无关，
    // 所以这类数字不论长短一律抹掉。
    .replace(/\d+(?:\.\d+)?(?=\s?(?:ms|s|sec|secs|秒|毫秒|bytes?|kb|mb|gb|kib|mib|b)\b)/gi, '<n>')
    // 长数字：时间戳等（5 位以上）。
    // 只抹这么长的数字是刻意的——HTTP 状态码、退出码这类「短数字」本身就是区分
    // 错误的关键信息，抹掉会让 404 与 500 合并成同一条。
    .replace(/\d{5,}/g, '<n>')
    // 连续空白
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 计算一条错误的签名：同类错误（含跨会话）必须落到同一个签名上。
 * @param {{ kind: string, key: string, code: string, detail: string }} candidate 候选错误。
 * @returns {string} 签名。
 */
export function digestSignature(candidate) {
  const kind = asString(candidate?.kind)
  const key = asString(candidate?.key)
  const code = asString(candidate?.code)
  const tail = normalizeForSignature(asString(candidate?.detail)).slice(0, DIGEST_SIGNATURE_LIMIT)
  return `${kind}|${key}|${code}|${tail}`
}

/**
 * 造一个新会话的错误折叠初始状态。
 * @returns {{ entries: object[], calls: Record<string, string> }} 初始状态。
 */
export function initDigestState() {
  return { entries: [], calls: {} }
}

/**
 * 从消息内容里取第一段文本（工具失败的实际说明通常在这里）。
 * @param {unknown} message `tool/result` 的消息体。
 * @returns {string} 文本或空串。
 */
function messageText(message) {
  if (!isPlainObject(message)) return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim()
      if (text !== '') return text
    }
  }
  return ''
}

/**
 * 在条目数组里累加或插入一条错误。
 *
 * 纯函数：命中已有签名时只替换那一项（次数 +1、刷新 lastTime/lastSeq），
 * `detail` 保留**首次**出现时的原文，避免每次数字变化都让界面文本跳动。
 * @param {object[]} entries 现有条目。
 * @param {{ kind: string, key: string, code: string, detail: string }} candidate 候选错误。
 * @param {{ seq: number, time: number }} at 事件位置。
 * @returns {object[]} 新条目数组（可能被裁到上限）。
 */
function upsertEntry(entries, candidate, at) {
  const sig = digestSignature(candidate)
  const detail = collapse(candidate.detail, DIGEST_DETAIL_LIMIT)
  const index = entries.findIndex((entry) => entry.sig === sig)
  if (index >= 0) {
    const previous = entries[index]
    const next = {
      ...previous,
      count: previous.count + 1,
      lastTime: at.time,
      lastSeq: at.seq,
    }
    const copy = entries.slice()
    copy[index] = next
    return copy
  }
  const created = {
    sig,
    kind: candidate.kind,
    key: asString(candidate.key),
    code: asString(candidate.code),
    detail,
    count: 1,
    firstTime: at.time,
    lastTime: at.time,
    lastSeq: at.seq,
  }
  return capEntries(entries.concat([created]))
}

/**
 * 条目数超过上限时，优先砍掉「次数最少、最久没再出现」的那些。
 * @param {object[]} entries 条目数组。
 * @returns {object[]} 裁剪后的条目数组。
 */
function capEntries(entries) {
  if (entries.length <= DIGEST_MAX_ENTRIES) return entries
  const survivors = entries
    .slice()
    .sort((left, right) => (right.count - left.count) || (right.lastTime - left.lastTime))
    .slice(0, DIGEST_MAX_ENTRIES)
  return survivors
}

/**
 * 在途调用表超过上限时丢掉最早插入的项。
 *
 * 普通对象的字符串键保持插入顺序，因此第一个键就是最早的。
 * @param {Record<string, string>} calls 在途调用表。
 * @returns {Record<string, string>} 同一个对象（就地裁剪，调用方已持有副本）。
 */
function capCalls(calls) {
  const keys = Object.keys(calls)
  if (keys.length <= DIGEST_MAX_PENDING_CALLS) return calls
  for (const key of keys.slice(0, keys.length - DIGEST_MAX_PENDING_CALLS)) delete calls[key]
  return calls
}

/**
 * 删除在途调用表里的一项；不存在时返回原表（保持引用不变）。
 * @param {Record<string, string>} calls 在途调用表。
 * @param {string} callId 调用 id。
 * @returns {Record<string, string>} 原表或去掉该项后的新表。
 */
function dropCall(calls, callId) {
  if (typeof callId !== 'string' || callId === '' || !Object.hasOwn(calls, callId)) return calls
  const next = { ...calls }
  delete next[callId]
  return next
}

/**
 * 折叠一个 `tool/call`：只记「callId → 工具名」，供随后的结果认领。
 * @param {object} state 折叠前状态。
 * @param {object} event 会话事件。
 * @returns {object} 新状态或旧引用。
 */
function foldToolCall(state, event) {
  const callId = event.data?.callId
  if (typeof callId !== 'string' || callId === '') return state
  const toolName = asString(event.data?.name) || 'unknown'
  const calls = { ...state.calls }
  // 重放 / 重试可能复用同一个 callId：以最后一次的名字为准。
  delete calls[callId]
  calls[callId] = toolName
  capCalls(calls)
  return { ...state, calls }
}

/**
 * 折叠一个 `tool/result`：失败时记一条 `tool` 类错误，并清掉在途调用。
 * @param {object} state 折叠前状态。
 * @param {object} event 会话事件。
 * @returns {object} 新状态或旧引用。
 */
function foldToolResult(state, event) {
  const data = isPlainObject(event.data) ? event.data : {}
  const message = isPlainObject(data.message) ? data.message : {}
  const source = isPlainObject(message.source) ? message.source : {}
  const callId = asString(source.callId) || asString(message.toolCallId)
  const toolName = callId !== '' && Object.hasOwn(state.calls, callId) ? state.calls[callId] : 'unknown'

  const failure = isPlainObject(data.error) ? data.error : undefined
  const failed = failure !== undefined || message.isError === true

  if (!failed) {
    // 成功结果：只清在途调用（清不动就原样返回，避免无意义的状态变化）。
    const calls = dropCall(state.calls, callId)
    return calls === state.calls ? state : { ...state, calls }
  }

  const code = asString(failure?.code) || asString(failure?.name) || 'TOOL_ERROR'
  const reason = asString(failure?.reason)
  const detail = reason !== '' ? reason : messageText(message)
  const entries = upsertEntry(state.entries, { kind: 'tool', key: toolName, code, detail }, event)
  const calls = dropCall(state.calls, callId)
  return { ...state, entries, calls }
}

/**
 * 折叠一个 `turn/end`：只有 `reason.kind === 'error'` 才算错误。
 * @param {object} state 折叠前状态。
 * @param {object} event 会话事件。
 * @returns {object} 新状态或旧引用。
 */
function foldTurnEnd(state, event) {
  const reason = isPlainObject(event.data?.reason) ? event.data.reason : undefined
  if (reason?.kind !== 'error') return state
  const failure = isPlainObject(reason.error) ? reason.error : {}
  const code = asString(failure.code) || 'TURN_ERROR'
  const detail = asString(failure.message)
  const entries = upsertEntry(state.entries, { kind: 'turn', key: '', code, detail }, event)
  return { ...state, entries }
}

/**
 * 折叠一个 `llm/retry`：每次重试都是一次真实的模型请求失败。
 * @param {object} state 折叠前状态。
 * @param {object} event 会话事件。
 * @returns {object} 新状态或旧引用。
 */
function foldModelRetry(state, event) {
  const failure = isPlainObject(event.data?.failure) ? event.data.failure : undefined
  if (failure === undefined) return state
  const code = asString(failure.code) || 'MODEL_ERROR'
  const detail = asString(failure.message)
  const provider = asString(event.data?.provider)
  const entries = upsertEntry(state.entries, { kind: 'model', key: provider, code, detail }, event)
  return { ...state, entries }
}

/**
 * 投影折叠函数（纯函数）：一个已提交的会话事件进，新状态或旧引用出。
 * @param {object} state 折叠前状态。
 * @param {object} event 已提交的会话事件（含 type/seq/time/data）。
 * @returns {object} 新状态或旧引用（无关事件原样返回）。
 */
export function foldDigestEvent(state, event) {
  if (!isPlainObject(state) || !Array.isArray(state.entries) || !isPlainObject(state.calls)) {
    state = initDigestState()
  }
  if (!isPlainObject(event)) return state
  switch (event.type) {
    case 'tool/call':
      return foldToolCall(state, event)
    case 'tool/result':
      return foldToolResult(state, event)
    case 'turn/end':
      return foldTurnEnd(state, event)
    case 'llm/retry':
      return foldModelRetry(state, event)
    default:
      return state
  }
}

/**
 * 校验并原样返回一份投影状态（给投影框架的极简 schema 面）。
 *
 * 投影框架对 schema 的全部调用面就是 `.parse()`（viewCheckpoint / restore /
 * hydrate / viewCell 路径），因此这里实现一个语义等价的校验器：
 * 非法形状直接抛错，合法输入原样返回。
 * @param {unknown} value 待校验的值。
 * @returns {object} 原值。
 * @throws {Error} 形状非法时抛出。
 */
export function parseDigestState(value) {
  if (!isPlainObject(value)) throw new Error('dialogErrors: 状态必须是普通对象')
  if (!Array.isArray(value.entries)) throw new Error('dialogErrors: entries 必须是数组')
  if (!isPlainObject(value.calls)) throw new Error('dialogErrors: calls 必须是普通对象')
  for (const entry of value.entries) {
    if (!isPlainObject(entry)) throw new Error('dialogErrors: entries 的每一项必须是对象')
    if (typeof entry.sig !== 'string' || entry.sig === '') {
      throw new Error('dialogErrors: 条目缺少 sig')
    }
    if (!KIND_SET.has(entry.kind)) {
      throw new Error(`dialogErrors: 非法的 kind "${String(entry.kind)}"`)
    }
    if (typeof entry.key !== 'string' || typeof entry.code !== 'string' || typeof entry.detail !== 'string') {
      throw new Error('dialogErrors: 条目的 key/code/detail 必须是字符串')
    }
    if (!Number.isInteger(entry.count) || entry.count < 1) {
      throw new Error('dialogErrors: 条目的 count 必须是正整数')
    }
    for (const field of ['firstTime', 'lastTime', 'lastSeq']) {
      if (!Number.isInteger(entry[field]) || entry[field] < 0) {
        throw new Error(`dialogErrors: 条目的 ${field} 必须是非负整数`)
      }
    }
  }
  for (const [callId, toolName] of Object.entries(value.calls)) {
    if (typeof toolName !== 'string' || toolName === '') {
      throw new Error(`dialogErrors: calls["${callId}"] 必须是工具名`)
    }
  }
  return value
}

/**
 * 校验客户端可见视图（给投影框架的 `wire.viewSchema`）。
 * @param {unknown} value 待校验的值。
 * @returns {object} 原值。
 * @throws {Error} 形状非法时抛出。
 */
export function parseDigestView(value) {
  if (!isPlainObject(value)) throw new Error('dialogErrors 视图必须是普通对象')
  if (!Array.isArray(value.entries)) throw new Error('dialogErrors 视图的 entries 必须是数组')
  // 视图里的条目与状态同形（重建自状态），只需校验必要的可读字段。
  for (const entry of value.entries) {
    if (!isPlainObject(entry) || typeof entry.sig !== 'string' || !KIND_SET.has(entry.kind)) {
      throw new Error('dialogErrors 视图的条目形状非法')
    }
    if (!Number.isInteger(entry.count) || entry.count < 1) {
      throw new Error('dialogErrors 视图的条目 count 非法')
    }
  }
  return value
}

/** 状态 schema（框架只调用 .parse()）。 */
export const digestStateSchema = { parse: parseDigestState }

/** 视图 schema（框架只调用 .parse()）。 */
export const digestViewSchema = { parse: parseDigestView }

/** 上一次被视图化的 `entries` 引用与对应视图对象，用于保持视图引用稳定。 */
let viewMemoEntries = undefined
let viewMemoValue = undefined

/**
 * 把投影状态投影成客户端视图。
 *
 * 引用稳定是**关键**：投影框架按 `Object.is` 判定视图是否变化，只有变化才推给
 * 客户端。`tool/call` 与成功的 `tool/result` 只动 `calls`、不动 `entries`，
 * 不应该惊动客户端，所以记忆化的键是 **`entries` 数组的引用**（而不是状态对象：
 * 状态每次都会换新对象，拿它当键等于没有记忆化）。
 * @param {object} state 投影状态。
 * @returns {{ entries: object[] }} 客户端视图。
 */
export function viewDigestState(state) {
  const entries = Array.isArray(state?.entries) ? state.entries : []
  if (entries === viewMemoEntries && viewMemoValue !== undefined) return viewMemoValue
  viewMemoEntries = entries
  viewMemoValue = { entries }
  return viewMemoValue
}
