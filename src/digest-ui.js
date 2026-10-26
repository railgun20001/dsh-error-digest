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
