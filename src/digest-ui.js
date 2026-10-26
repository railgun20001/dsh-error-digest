/**
 * dsh-error-digest —— 客户端 UI（React 组件工厂，裸脚本，无 import/export）
 *
 * 两个组件：
 *   - `createDigestPanel`：主面板（注册进根级 `main` 的 keyed 插槽，key 与侧栏
 *     面板 id 相同），错误按频次排序，每条带「分析 / 防范 / 忽略」三个动作；
 *   - `createDigestIcon`：侧栏 `sidebar.panellist` 的图标（原装插槽只给
 *     `{ size, active }`，颜色必须跟随 `currentColor` 才能跟上选中态与主题）。
 *
 * ## 样式原则
 *
 * 宿主只用两种颜色体系：主题令牌（`--dsw-alias-*`）和自己打包的 CSS Modules。
 * 插件拿不到后者的类名，所以这里把少量结构样式写成一个**随组件一起渲染的**
 * `<style>` 元素：挂载时生效、卸载时随之消失，既不需要写 document.head，
 * 也不会在页面里留下孤儿样式。
 *
 * 颜色一律走令牌，**不写任何字面色值**（含文字色）：
 *   - 主操作用「品牌色淡底 + 品牌色文字」（`color-mix` 混透明），明暗主题都安全；
 *   - 次操作是描边 + 主文字色；
 *   - 「忽略」是安静动作：无描边、次要文字色，不与两个主动作抢注意力。
 * 每个 `color-mix` 前面都留了一条纯令牌的降级声明，旧内核下只是少了淡底，不会失色。
 *
 * ## 依赖
 *
 * `deps` 提供：会话列表仓库、忽略表仓库，以及四个回调
 * （`onAction(row, mode, t)`、`onIgnore(row)`、`onRestore(sig)`、`onRestoreAll()`）。
 * 数据推导全部交给同作用域的纯逻辑模块。
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
  margin-bottom: 14px;
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
  font-variant-numeric: tabular-nums;
}
.ded-controls {
  display: flex;
  align-items: center;
  gap: 8px;
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
.ded-act:focus-visible,
.ded-ignored-toggle:focus-visible {
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
  transition: border-color 120ms ease;
}
.ded-card:hover {
  border-color: var(--dsw-alias-border-l2);
}
.ded-rank {
  flex: 0 0 22px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  padding-top: 3px;
}
.ded-card[data-rank="1"] .ded-rank,
.ded-card[data-rank="2"] .ded-rank,
.ded-card[data-rank="3"] .ded-rank {
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
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
  padding: 0 7px;
  border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.ded-kind-tool {
  color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
}
.ded-kind-turn {
  color: var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
}
.ded-kind-model {
  color: var(--dsw-alias-state-idle-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-idle-primary) 12%, transparent);
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
  font-size: 11px;
  line-height: 18px;
  padding: 0 8px;
  border-radius: 999px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-bg-layer-2);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);
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
  align-self: center;
}
.ded-act {
  appearance: none;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  height: 26px;
  border-radius: 7px;
  cursor: pointer;
  border: 1px solid transparent;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.ded-act svg {
  flex: 0 0 auto;
  display: block;
}
.ded-act-primary {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: transparent;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
}
.ded-act-primary:hover {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
}
.ded-act-secondary {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l2);
  background: transparent;
}
.ded-act-secondary:hover {
  background: var(--dsw-alias-bg-layer-2);
}
.ded-act-quiet {
  color: var(--dsw-alias-label-secondary);
  border-color: transparent;
  background: transparent;
}
.ded-act-quiet:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
}
.ded-act[disabled] {
  cursor: not-allowed;
  opacity: 0.5;
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
.ded-ignored-toggle {
  appearance: none;
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  padding: 3px 10px;
  height: 26px;
  border-radius: 7px;
  cursor: pointer;
  border: 1px dashed var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.ded-ignored-toggle:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
}
.ded-ignored-toggle[aria-expanded="true"] {
  border-style: solid;
  color: var(--dsw-alias-label-primary);
}
.ded-ignored {
  margin-top: 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.ded-ignored-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.ded-ignored-head strong {
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  font-weight: 600;
}
.ded-ignored-head .ded-act {
  margin-left: auto;
}
.ded-ignored-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.ded-ignored-row:first-of-type {
  border-top: 0;
}
.ded-ignored-row .ded-ignored-detail {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
}
.ded-ignored-when {
  flex: 0 0 auto;
  font-size: 11px;
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
 * 造一个 13×13 的线性图标：统一描边宽度与圆角，看起来像同一套图标里的。
 * @param {object} h React.createElement。
 * @param {Array<[string, object]>} shapes 子图形（`[标签, 属性]`）。
 * @returns {object} React 元素。
 */
function icon(h, shapes) {
  return h('svg', {
    width: 13,
    height: 13,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
  }, shapes.map((shape, index) => h(shape[0], { key: index, ...shape[1] })))
}

/** 「分析」图标：放大镜。 */
const ANALYZE_SHAPES = [
  ['circle', { cx: 7, cy: 7, r: 4.2 }],
  ['path', { d: 'M10.2 10.2 L13.5 13.5' }],
]

/** 「防范」图标：盾牌 + 勾。 */
const PREVENT_SHAPES = [
  ['path', { d: 'M8 2.2 L13 4.1 V8c0 3-2.2 4.9-5 5.9C5.2 12.9 3 11 3 8V4.1L8 2.2Z' }],
  ['path', { d: 'M5.9 8.1 L7.4 9.6 L10.2 6.7' }],
]

/** 「忽略」图标：眼睛上划一道斜线。 */
const IGNORE_SHAPES = [
  ['path', { d: 'M1.8 8c1.6-2.6 3.8-4 6.2-4s4.6 1.4 6.2 4c-1.6 2.6-3.8 4-6.2 4S3.4 10.6 1.8 8Z' }],
  ['path', { d: 'M3 13 L13 3' }],
]

/** 「恢复」图标：回转箭头。 */
const RESTORE_SHAPES = [
  ['path', { d: 'M3 8a5 5 0 1 0 1.6-3.7' }],
  ['path', { d: 'M3 3.2 V6.4 H6.2' }],
]

/**
 * 造主面板组件。
 * @param {object} React React 命名空间（由模块工厂的 require 注入）。
 * @param {{
 *   store: { subscribe: Function, getSnapshot: Function },
 *   ignored: { subscribe: Function, getSnapshot: Function },
 *   onAction: (row: object, mode: 'analyze'|'prevent', t: Function) => void,
 *   onIgnore: (row: object) => void,
 *   onRestore: (sig: string) => void,
 *   onRestoreAll: () => void,
 *   fallbackT: (key: string, params?: object) => string,
 * }} deps 依赖。
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
   * 一条错误的卡片：类别、来源、次数、摘要、三个动作。
   * @param {{ row: object, rank: number, t: Function, onAction: Function, onIgnore: Function }} props 属性。
   * @returns {object} React 元素。
   */
  function Row(props) {
    const { row, rank, t, onAction, onIgnore } = props
    const detail = typeof row.detail === 'string' && row.detail !== '' ? row.detail : t('detail.empty')
    const sourceText = sourceLabelOf(row, t)
    return h('article', {
      className: 'ded-card',
      'data-testid': 'error-digest-row',
      'data-kind': row.kind,
      'data-sig': row.sig,
      'data-rank': rank,
    }, [
      h('div', { className: 'ded-rank', key: 'rank' }, String(rank)),
      h('div', { className: 'ded-main', key: 'main' }, [
        h('div', { className: 'ded-titleline', key: 'title' }, [
          h('span', { className: `ded-kind ded-kind-${row.kind}`, key: 'kind' }, t(kindLabelKey(row.kind))),
          h('span', { className: 'ded-source', key: 'source', title: sourceText }, sourceText),
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
          className: 'ded-act ded-act-primary',
          'data-testid': 'error-digest-analyze',
          title: t('action.analyze.title'),
          'aria-label': t('action.analyze.title'),
          onClick: () => onAction(row, 'analyze', t),
        }, [icon(h, ANALYZE_SHAPES), h('span', { key: 'label' }, t('action.analyze'))]),
        h('button', {
          type: 'button',
          key: 'prevent',
          className: 'ded-act ded-act-secondary',
          'data-testid': 'error-digest-prevent',
          title: t('action.prevent.title'),
          'aria-label': t('action.prevent.title'),
          onClick: () => onAction(row, 'prevent', t),
        }, [icon(h, PREVENT_SHAPES), h('span', { key: 'label' }, t('action.prevent'))]),
        h('button', {
          type: 'button',
          key: 'ignore',
          className: 'ded-act ded-act-quiet',
          'data-testid': 'error-digest-ignore',
          title: t('action.ignore.title'),
          'aria-label': t('action.ignore.title'),
          onClick: () => onIgnore(row),
        }, [icon(h, IGNORE_SHAPES), h('span', { key: 'label' }, t('action.ignore'))]),
      ]),
    ])
  }

  /**
   * 「已忽略」区块：默认折叠；展开后每条都能恢复，另有「全部恢复」。
   * @param {{ rows: object[], t: Function, onRestore: Function, onRestoreAll: Function }} props 属性。
   * @returns {object} React 元素。
   */
  function IgnoredSection(props) {
    const { rows, t, onRestore, onRestoreAll } = props
    return h('section', {
      className: 'ded-ignored',
      'data-testid': 'error-digest-ignored',
      'aria-label': t('ignored.title'),
    }, [
      h('div', { className: 'ded-ignored-head', key: 'head' }, [
        h('strong', { key: 'title' }, t('ignored.title')),
        h('span', { key: 'count' }, t('ignored.count', { count: rows.length })),
        h('button', {
          type: 'button',
          key: 'restoreAll',
          className: 'ded-act ded-act-secondary',
          'data-testid': 'error-digest-restore-all',
          title: t('ignored.restoreAll.title'),
          onClick: onRestoreAll,
        }, [icon(h, RESTORE_SHAPES), h('span', { key: 'label' }, t('ignored.restoreAll'))]),
      ]),
      ...rows.map((row) => h('div', {
        className: 'ded-ignored-row',
        key: row.sig,
        'data-testid': 'error-digest-ignored-row',
        'data-sig': row.sig,
      }, [
        h('span', { className: `ded-kind ded-kind-${row.kind}`, key: 'kind' }, t(kindLabelKey(row.kind))),
        h('span', { className: 'ded-source', key: 'source' }, sourceLabelOf(row, t)),
        h('span', { className: 'ded-ignored-detail', key: 'detail', title: row.detail },
          row.detail === '' ? t('detail.empty') : row.detail),
        h('span', { className: 'ded-ignored-when', key: 'when' }, t('ignored.at', { time: formatDigestTime(row.at) })),
        h('button', {
          type: 'button',
          key: 'restore',
          className: 'ded-act ded-act-secondary',
          'data-testid': 'error-digest-restore',
          title: t('ignored.restore.title'),
          'aria-label': t('ignored.restore.title'),
          onClick: () => onRestore(row.sig),
        }, [icon(h, RESTORE_SHAPES), h('span', { key: 'label' }, t('ignored.restore'))]),
      ])),
    ])
  }

  /**
   * 主面板：标题与统计、口径切换、按频次排序的列表、「已忽略」区块。
   * @param {{ t?: Function }} props 插槽属性（`locale` 注册会注入 `t`）。
   * @returns {object} React 元素。
   */
  function DigestPanel(props) {
    const t = typeof props?.t === 'function' ? props.t : deps.fallbackT
    const listState = useSnapshot(deps.store)
    const ignoredTable = useSnapshot(deps.ignored)
    const [scope, setScope] = React.useState('all')
    const [showIgnored, setShowIgnored] = React.useState(false)

    const currentId = currentSessionIdOf(listState)
    const hasCurrent = typeof currentId === 'string' && currentId !== ''
    const scoped = scope === 'current'
    // 「当前对话」但没有打开的对话时，显式传 null（空范围），
    // 而不是省掉参数——省掉参数会退化成「全部会话」，与按钮上写的口径不符。
    const result = collectDigestRows(listState, scoped ? { scopeSessionId: hasCurrent ? currentId : null } : {})
    const { visible, ignored } = partitionRows(result.rows, ignoredTable)
    const summary = summarizeRows(visible)

    /**
     * 忽略一条：同时把「已忽略」区块展开一次。
     *
     * 忽略会让行立刻消失，不给出可见落点的话，用户会以为「点掉了就找不回来」。
     * 展开一次是最低成本的解释。
     * @param {object} row 目标行。
     * @returns {void}
     */
    const handleIgnore = (row) => {
      deps.onIgnore(row)
      setShowIgnored(true)
    }

    const scopeButton = (id, label, disabled, title) => h('button', {
      type: 'button',
      key: id,
      'aria-pressed': scope === id ? 'true' : 'false',
      'data-testid': `error-digest-scope-${id}`,
      disabled,
      title,
      onClick: () => setScope(id),
    }, label)

    const noCurrent = scoped && !hasCurrent
    const allIgnored = !noCurrent && visible.length === 0 && ignored.length > 0
    const emptyTitle = noCurrent
      ? t('empty.noCurrent.title')
      : (allIgnored ? t('empty.allIgnored.title') : t('empty.title'))
    const emptyBody = noCurrent
      ? t('empty.noCurrent.body')
      : (allIgnored ? t('empty.allIgnored.body') : t('empty.body'))

    const empty = h('div', { className: 'ded-empty', 'data-testid': 'error-digest-empty', key: 'empty' }, [
      h('strong', { key: 'title' }, emptyTitle),
      h('p', { key: 'body' }, emptyBody),
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
            distinct: summary.distinct,
            total: summary.total,
            sessions: result.sessionsWithErrors,
          })),
        ]),
        h('div', { className: 'ded-controls', key: 'controls' }, [
          h('div', { className: 'ded-scope', key: 'scope', role: 'group', 'aria-label': t('scope.label') }, [
            scopeButton('all', t('scope.all'), false, t('scope.all.title')),
            scopeButton('current', t('scope.current'), !hasCurrent, hasCurrent ? t('scope.current.title') : t('scope.current.disabled')),
          ]),
          ignored.length > 0
            ? h('button', {
              type: 'button',
              key: 'ignoredToggle',
              className: 'ded-ignored-toggle',
              'data-testid': 'error-digest-ignored-toggle',
              'aria-expanded': showIgnored ? 'true' : 'false',
              title: t('ignored.toggle.title'),
              onClick: () => setShowIgnored((open) => !open),
            }, showIgnored ? t('ignored.hide', { count: ignored.length }) : t('ignored.show', { count: ignored.length }))
            : null,
        ]),
      ]),
      h('div', { className: 'ded-list', key: 'list' },
        visible.length === 0
          ? empty
          : visible.map((row, index) => h(Row, {
            key: row.sig,
            row,
            rank: index + 1,
            t,
            onAction: deps.onAction,
            onIgnore: handleIgnore,
          }))),
      showIgnored && ignored.length > 0
        ? h(IgnoredSection, {
          key: 'ignored',
          rows: ignored,
          t,
          onRestore: deps.onRestore,
          onRestoreAll: deps.onRestoreAll,
        })
        : null,
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
