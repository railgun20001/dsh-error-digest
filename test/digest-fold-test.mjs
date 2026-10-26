/**
 * dsh-error-digest 宿主折叠逻辑单测。
 *
 * 覆盖的是「错误进状态之前」的全部规则：分不清哪些事件算错误、同一错误怎么合并、
 * 状态上限、schema 校验、视图引用稳定性。这些规则一旦错了，界面上只会表现为
 * 「数字不对」或「一直空」，很难在生产里查，所以逐条钉死。
 *
 * 运行：node --test test/digest-fold-test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DIGEST_MAX_ENTRIES,
  DIGEST_MAX_PENDING_CALLS,
  DIGEST_PROJECTION_KEY,
  DIGEST_STATE_VERSION,
  digestSignature,
  digestStateSchema,
  digestViewSchema,
  foldDigestEvent,
  initDigestState,
  normalizeForSignature,
  parseDigestState,
  viewDigestState,
} from '../src/digest-fold.js'

/**
 * 造一个会话事件。
 * @param {string} type 事件类型。
 * @param {object} data 事件负载。
 * @param {{ seq?: number, time?: number }} [at] 位置。
 * @returns {object} 事件。
 */
function ev(type, data, at = {}) {
  return { type, seq: at.seq ?? 1, time: at.time ?? 1000, data }
}

/**
 * 造一个工具调用事件。
 * @param {string} callId 调用 id。
 * @param {string} name 工具名。
 * @param {number} [seq] 序号。
 * @returns {object} 事件。
 */
function toolCall(callId, name, seq = 1) {
  return ev('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' }, { seq })
}

/**
 * 造一个成功的工具结果事件。
 * @param {string} callId 调用 id。
 * @param {number} [seq] 序号。
 * @returns {object} 事件。
 */
function toolOk(callId, seq = 2) {
  return ev('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: 'ok' }] },
  }, { seq })
}

/**
 * 造一个失败的工具结果事件。
 * @param {string} callId 调用 id。
 * @param {{ code?: string, reason?: string, text?: string, isErrorOnly?: boolean }} [options] 失败形态。
 * @param {number} [seq] 序号。
 * @returns {object} 事件。
 */
function toolFail(callId, options = {}, seq = 2) {
  const text = options.text ?? '命令以退出码 1 结束'
  const data = {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text }],
      isError: true,
    },
  }
  if (options.isErrorOnly !== true) {
    data.error = { name: 'ToolError', code: options.code ?? 'TOOL_FAILED', reason: options.reason ?? text }
  }
  return ev('tool/result', data, { seq })
}

/**
 * 把一串事件折叠成一个状态。
 * @param {object[]} events 事件序列。
 * @returns {object} 最终状态。
 */
function foldAll(events) {
  return events.reduce((state, event) => foldDigestEvent(state, event), initDigestState())
}

test('投影键与状态版本是稳定契约', () => {
  assert.equal(DIGEST_PROJECTION_KEY, 'dialogErrors')
  assert.equal(DIGEST_STATE_VERSION, 1)
})

test('工具失败进 tool 类，且带上配对调用里的工具名', () => {
  const state = foldAll([toolCall('c1', 'pwsh'), toolFail('c1', { code: 'EXIT_CODE', reason: 'exit code 1' })])
  assert.equal(state.entries.length, 1)
  const entry = state.entries[0]
  assert.equal(entry.kind, 'tool')
  assert.equal(entry.key, 'pwsh')
  assert.equal(entry.code, 'EXIT_CODE')
  assert.equal(entry.detail, 'exit code 1')
  assert.equal(entry.count, 1)
  assert.equal(entry.lastSeq, 2)
  // 结果到达后在途调用必须被清掉（否则状态会随会话无限长大）
  assert.deepEqual(state.calls, {})
})

test('只有 message.isError 没有 error 字段也算失败，摘要取自消息文本', () => {
  const state = foldAll([toolCall('c1', 'edit'), toolFail('c1', { isErrorOnly: true, text: '未找到唯一匹配' })])
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].code, 'TOOL_ERROR')
  assert.equal(state.entries[0].detail, '未找到唯一匹配')
})

test('成功结果不产生条目', () => {
  const state = foldAll([toolCall('c1', 'read'), toolOk('c1')])
  assert.equal(state.entries.length, 0)
})

test('同一错误重复出现合并成一条并累加次数', () => {
  const events = []
  for (let index = 0; index < 5; index += 1) {
    events.push(toolCall(`c${index}`, 'edit', index * 2 + 1))
    events.push(toolFail(`c${index}`, { code: 'NO_MATCH', reason: '未找到唯一匹配的片段' }, index * 2 + 2))
  }
  const state = foldAll(events)
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].count, 5)
})

test('易变部分（UUID / 路径 / 长数字）不拆散同一类错误', () => {
  const first = toolFail('c1', {
    code: 'WRITE_FAILED',
    reason: '写入 C:\\work\\proj\\src\\a.ts:12:34 失败，请求 3f2a1b9c8d7e6f50 超时 12000ms',
  }, 2)
  const second = toolFail('c2', {
    code: 'WRITE_FAILED',
    reason: '写入 C:\\work\\proj\\src\\b.ts:7:9 失败，请求 99887766aabbccdd 超时 3000ms',
  }, 4)
  const state = foldAll([toolCall('c1', 'write', 1), first, toolCall('c2', 'write', 3), second])
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].count, 2)
  // 保留的是首次出现的原文（界面文本不随时间跳动）
  assert.match(state.entries[0].detail, /a\.ts/)
})

test('不同工具的同文错误不会被合并', () => {
  const state = foldAll([
    toolCall('c1', 'pwsh', 1),
    toolFail('c1', { code: 'E', reason: '失败' }, 2),
    toolCall('c2', 'bash', 3),
    toolFail('c2', { code: 'E', reason: '失败' }, 4),
  ])
  assert.equal(state.entries.length, 2)
})

test('turn/end 只有 error 才是错误', () => {
  const completed = ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 3 })
  const failed = ev('turn/end', {
    turn: 2,
    reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '模型请求被限流' } },
  }, { seq: 7 })
  const afterCompleted = foldDigestEvent(initDigestState(), completed)
  assert.equal(afterCompleted.entries.length, 0)
  const afterFailed = foldDigestEvent(afterCompleted, failed)
  assert.equal(afterFailed.entries.length, 1)
  assert.equal(afterFailed.entries[0].kind, 'turn')
  assert.equal(afterFailed.entries[0].code, 'RATE_LIMIT')
  assert.equal(afterFailed.entries[0].lastSeq, 7)
})

test('llm/retry 记成 model 类，key 是提供方', () => {
  const state = foldDigestEvent(initDigestState(), ev('llm/retry', {
    retryId: 'r1',
    turn: 1,
    step: 1,
    provider: 'deepseek',
    mode: 'normal',
    policyKey: 'default',
    retry: 1,
    delayMs: 500,
    failure: { code: 'SERVER_BUSY', message: '服务繁忙，请稍后重试', status: 503 },
  }, { seq: 12 }))
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].kind, 'model')
  assert.equal(state.entries[0].key, 'deepseek')
  assert.equal(state.entries[0].code, 'SERVER_BUSY')
})

test('无关事件原样返回同一个引用', () => {
  const state = foldAll([toolCall('c1', 'pwsh'), toolFail('c1', {})])
  const same = foldDigestEvent(state, ev('step/start', { turn: 1, step: 1 }, { seq: 99 }))
  assert.equal(same, state)
})

test('未知 callId 的成功结果不制造新状态', () => {
  const state = foldAll([toolCall('c1', 'pwsh'), toolFail('c1', {})])
  const same = foldDigestEvent(state, toolOk('nope', 50))
  assert.equal(same, state)
})

test('条目数有上限，超出时砍掉次数最少的', () => {
  const events = []
  let seq = 0
  for (let index = 0; index < DIGEST_MAX_ENTRIES + 5; index += 1) {
    seq += 1
    events.push(toolCall(`c${index}`, `tool-${index}`, seq))
    seq += 1
    events.push(toolFail(`c${index}`, { code: `E${index}`, reason: `错误 ${index}` }, seq))
  }
  const state = foldAll(events)
  assert.equal(state.entries.length, DIGEST_MAX_ENTRIES)
})

test('在途调用表有上限', () => {
  const events = []
  for (let index = 0; index < DIGEST_MAX_PENDING_CALLS + 10; index += 1) {
    events.push(toolCall(`c${index}`, `tool-${index}`, index + 1))
  }
  const state = foldAll(events)
  assert.equal(Object.keys(state.calls).length, DIGEST_MAX_PENDING_CALLS)
  // 最早的已被丢弃，最新的一定还在
  assert.equal(Object.hasOwn(state.calls, `c${DIGEST_MAX_PENDING_CALLS + 9}`), true)
})

test('签名归一化：抹掉路径 / 行列 / 哈希 / 长数字', () => {
  const normalized = normalizeForSignature('读取 C:\\a\\b\\c.ts 时 hash 3f2a1b9c 失败，耗时 12000ms')
  assert.match(normalized, /<path>/)
  assert.match(normalized, /<hex>/)
  assert.match(normalized, /<n>ms/)
  assert.doesNotMatch(normalized, /12000/)
  // 行列号：POSIX 路径之外的 `:行:列` 单独归一化
  assert.match(normalizeForSignature('打开 /a/b/c.ts:1:2 失败'), /:<loc>/)
  // Windows 绝对路径本身就会把尾部的行列一起吃掉
  assert.match(normalizeForSignature('打开 C:\\a\\b.ts:1:2 失败'), /<path>/)
})

test('签名只由 kind/key/code/摘要尾部决定', () => {
  const left = digestSignature({ kind: 'tool', key: 'pwsh', code: 'E', detail: '同样的失败 120000' })
  const right = digestSignature({ kind: 'tool', key: 'pwsh', code: 'E', detail: '同样的失败 999999' })
  assert.equal(left, right)
  const other = digestSignature({ kind: 'tool', key: 'bash', code: 'E', detail: '同样的失败 120000' })
  assert.notEqual(left, other)
  // 短数字（状态码 / 退出码）不归一化：它们是区分错误的关键信息
  const notFound = digestSignature({ kind: 'tool', key: 'pwsh', code: 'E', detail: 'HTTP 404' })
  const serverError = digestSignature({ kind: 'tool', key: 'pwsh', code: 'E', detail: 'HTTP 500' })
  assert.notEqual(notFound, serverError)
})

test('schema 校验拒绝非法状态、接受合法状态', () => {
  const valid = foldAll([toolCall('c1', 'pwsh'), toolFail('c1', {})])
  assert.equal(parseDigestState(valid), valid)
  assert.throws(() => parseDigestState(null), /普通对象/)
  assert.throws(() => parseDigestState({ entries: [], calls: [] }), /calls/)
  assert.throws(() => parseDigestState({ entries: [{ sig: 'x', kind: 'nope', key: '', code: '', detail: '', count: 1, firstTime: 0, lastTime: 0, lastSeq: 0 }], calls: {} }), /kind/)
  assert.throws(() => parseDigestState({ entries: [{ sig: 'x', kind: 'tool', key: '', code: '', detail: '', count: 0, firstTime: 0, lastTime: 0, lastSeq: 0 }], calls: {} }), /count/)
  assert.equal(typeof digestStateSchema.parse, 'function')
})

test('视图 schema 与视图记忆化', () => {
  const state = foldAll([toolCall('c1', 'pwsh'), toolFail('c1', {})])
  const view = viewDigestState(state)
  assert.equal(digestViewSchema.parse(view), view)
  assert.throws(() => digestViewSchema.parse({ entries: [{}] }), /形状非法/)
  // 同一状态 → 同一视图引用（投影框架据此判定「没变」）
  assert.equal(viewDigestState(state), view)
  // 只有在途调用变化（entries 未变）时，视图引用也必须稳定
  const withPending = foldDigestEvent(state, toolCall('c9', 'read', 30))
  assert.notEqual(withPending, state)
  assert.equal(viewDigestState(withPending), view)
  // 真正的错误变化 → 新视图
  const withError = foldDigestEvent(withPending, toolFail('c9', { code: 'E2', reason: '另一个错误' }, 31))
  assert.notEqual(viewDigestState(withError), view)
})

test('非对象状态会被重置而不是抛错', () => {
  const state = foldDigestEvent(/** @type {any} */ (null), toolCall('c1', 'pwsh'))
  assert.equal(state.entries.length, 0)
  assert.equal(state.calls.c1, 'pwsh')
})
