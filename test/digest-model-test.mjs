/**
 * dsh-error-digest 客户端合并逻辑单测。
 *
 * 覆盖「宿主折叠完之后」的规则：跨会话怎么合并、频次怎么排、范围怎么切、
 * 提示词长什么样。这些都能纯函数验证，不需要浏览器。
 *
 * 运行：node --test test/digest-model-test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DIGEST_PROJECTION_KEY as HOST_PROJECTION_KEY,
} from '../src/digest-fold.js'
import {
  DIGEST_PROJECTION_KEY,
  buildPrompt,
  collectDigestRows,
  currentSessionIdOf,
  kindLabelKey,
  sessionTitleOf,
  sourceLabelOf,
} from '../src/digest-model.js'

/**
 * 造一条宿主折叠后的投影条目。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 条目。
 */
function entry(overrides = {}) {
  return {
    sig: overrides.sig ?? 'tool|pwsh|E|失败',
    kind: overrides.kind ?? 'tool',
    key: overrides.key ?? 'pwsh',
    code: overrides.code ?? 'E',
    detail: overrides.detail ?? '失败',
    count: overrides.count ?? 1,
    firstTime: overrides.firstTime ?? 1000,
    lastTime: overrides.lastTime ?? 2000,
    lastSeq: overrides.lastSeq ?? 5,
  }
}

/**
 * 造一个会话列表快照。
 * @param {Record<string, object[]>} bySession 会话 id → 投影条目。
 * @param {{ titles?: Record<string, string>, mainView?: string }} [options] 标题与当前会话。
 * @returns {object} 会话列表快照。
 */
function listState(bySession, options = {}) {
  const byId = {}
  const projectionsBySession = {}
  for (const [id, entries] of Object.entries(bySession)) {
    const title = options.titles?.[id] ?? `会话 ${id}`
    byId[id] = {
      id,
      title,
      displayTitle: title,
      blank: false,
      retainedBy: options.mainView === id ? { mainView: 1 } : {},
    }
    projectionsBySession[id] = {
      values: { [DIGEST_PROJECTION_KEY]: { entries } },
      state: 'ready',
      error: null,
    }
  }
  return { ids: Object.keys(byId), byId, phase: 'ready', projectionsBySession }
}

/** 极简文案函数：带 {name} 插值；缺键返回键名。 */
function translator(dict) {
  return (key, params) => {
    const template = dict[key] ?? key
    if (typeof params !== 'object' || params === null) return template
    return template.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole))
  }
}

test('客户端与宿主半共用同一个投影键', () => {
  assert.equal(DIGEST_PROJECTION_KEY, HOST_PROJECTION_KEY)
})

test('没有数据时不崩，且报告「投影未出现」', () => {
  const result = collectDigestRows(undefined)
  assert.deepEqual(result.rows, [])
  assert.equal(result.distinctCount, 0)
  assert.equal(result.totalCount, 0)
  assert.equal(result.hasProjection, false)
})

test('同签名跨会话合并成一行，次数相加、会话数分开记', () => {
  const state = listState({
    s1: [entry({ count: 3 })],
    s2: [entry({ count: 2, lastTime: 5000 })],
  })
  const result = collectDigestRows(state)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].count, 5)
  assert.equal(result.rows[0].sessionCount, 2)
  assert.equal(result.totalCount, 5)
  assert.equal(result.sessionsWithErrors, 2)
  assert.equal(result.hasProjection, true)
  // 最近出现时间取并集里最大的那个
  assert.equal(result.rows[0].lastTime, 5000)
})

test('按频次降序，次数相同按最近出现降序', () => {
  const state = listState({
    s1: [
      entry({ sig: 'a', detail: 'A', count: 2, lastTime: 100 }),
      entry({ sig: 'b', detail: 'B', count: 9, lastTime: 100 }),
      entry({ sig: 'c', detail: 'C', count: 2, lastTime: 900 }),
    ],
  })
  const { rows } = collectDigestRows(state)
  assert.deepEqual(rows.map((row) => row.sig), ['b', 'c', 'a'])
})

test('范围切换：只统计当前会话', () => {
  const state = listState({
    s1: [entry({ count: 4 })],
    s2: [entry({ count: 1, detail: '别的错误', sig: 'other' })],
  }, { mainView: 's2' })
  assert.equal(currentSessionIdOf(state), 's2')
  const scoped = collectDigestRows(state, { scopeSessionId: 's2' })
  assert.equal(scoped.rows.length, 1)
  assert.equal(scoped.rows[0].sig, 'other')
  assert.equal(scoped.totalCount, 1)
  assert.equal(scoped.scannedSessions, 1)
})

test('「当前对话」但没有打开的对话时，范围是空而不是退化成全部会话', () => {
  const state = listState({ s1: [entry()] })
  assert.equal(currentSessionIdOf(state), undefined)
  const scoped = collectDigestRows(state, { scopeSessionId: null })
  assert.equal(scoped.rows.length, 0)
  assert.equal(scoped.scannedSessions, 0)
  // 对照：不传 scopeSessionId 才是「全部会话」
  assert.equal(collectDigestRows(state).rows.length, 1)
})

test('兼容 byId 行内 projectionValues 的形状', () => {
  const state = {
    ids: ['s1'],
    byId: { s1: { id: 's1', title: '会话一', projectionValues: { [DIGEST_PROJECTION_KEY]: { entries: [entry({ count: 7 })] } } } },
    phase: 'ready',
  }
  const result = collectDigestRows(state)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].count, 7)
  assert.equal(result.hasProjection, true)
})

test('会话标题缺字段时回落到 id', () => {
  const state = { ids: ['s1'], byId: { s1: { id: 's1', projectionValues: { [DIGEST_PROJECTION_KEY]: { entries: [] } } } }, phase: 'ready' }
  assert.equal(sessionTitleOf(state, 's1'), 's1')
  assert.equal(sessionTitleOf(listState({ s1: [] }), 's1'), '会话 s1')
})

test('类别与来源文案键', () => {
  assert.equal(kindLabelKey('tool'), 'kind.tool')
  assert.equal(kindLabelKey('turn'), 'kind.turn')
  assert.equal(kindLabelKey('model'), 'kind.model')
  assert.equal(kindLabelKey('???'), 'kind.unknown')

  const t = translator({
    'source.tool': '工具 {name}',
    'source.modelProvider': '模型 {name}',
    'source.turn': '整轮对话',
    'source.toolUnknown': '未知工具',
  })
  assert.equal(sourceLabelOf({ kind: 'tool', key: 'pwsh' }, t), '工具 pwsh')
  assert.equal(sourceLabelOf({ kind: 'tool', key: 'unknown' }, t), '未知工具')
  assert.equal(sourceLabelOf({ kind: 'model', key: 'deepseek' }, t), '模型 deepseek')
  assert.equal(sourceLabelOf({ kind: 'turn' }, t), '整轮对话')
})

test('分析 / 防范提示词带上关键事实，且两者目标不同', () => {
  const t = translator({
    'kind.tool': '工具失败',
    'kind.turn': '回合失败',
    'kind.model': '模型重试',
    'source.tool': '工具 {name}',
    'detail.empty': '（无）',
    'prompt.analyze': '分析：{kind} / {source} / {code} / {count} / {lastSeen}\n摘要：{detail}',
    'prompt.prevent': '防范：{kind} / {source} / {code} / {count} / {lastSeen}\n摘要：{detail}',
  })
  const row = { kind: 'tool', key: 'edit', code: 'NO_MATCH', count: 5, detail: '未找到唯一匹配', lastTime: 0 }
  const analyze = buildPrompt(row, 'analyze', t, { lastSeen: '2026-10-26 10:00' })
  const prevent = buildPrompt(row, 'prevent', t, { lastSeen: '2026-10-26 10:00' })
  for (const prompt of [analyze, prevent]) {
    assert.match(prompt, /工具失败/)
    assert.match(prompt, /工具 edit/)
    assert.match(prompt, /NO_MATCH/)
    assert.match(prompt, /5/)
    assert.match(prompt, /2026-10-26 10:00/)
    assert.match(prompt, /未找到唯一匹配/)
  }
  assert.match(analyze, /^分析：/)
  assert.match(prevent, /^防范：/)
})

test('摘要为空时用占位文案，不产出空行', () => {
  const t = translator({ 'detail.empty': '（没有可读的错误信息）', 'prompt.analyze': '{detail}' })
  assert.equal(buildPrompt({ kind: 'turn' }, 'analyze', t), '（没有可读的错误信息）')
})
