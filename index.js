/**
 * dsh-error-digest —— 宿主半
 *
 * 职责只有两件：
 *
 * 1. **注册 `dialogErrors` 会话投影**：把每个会话日志里的错误折叠成
 *    「按签名合并、带次数」的小状态（见 `src/digest-fold.js`）。投影由框架驱动，
 *    因此**所有会话**（含未打开过的冷会话）都会自动折叠，值经三条受支持通道到达
 *    客户端，不需要客户端 retain 任何会话：
 *      - 会话列表 RPC 的每行 projections 块；
 *      - 按需读取单会话投影；
 *      - 打开会话时尾页的 projections 基线。
 *    投影还按 `(sessionId, key, ver, seq)` 落检查点，宿主重启后不必从头重放。
 *
 * 2. **挂一个只读诊断路由** `POST /dsh-error-digest/debug`：回答「投影键到底注册上了
 *    没有、每个在挂会话当前折叠出了什么」。客户端不需要它（客户端读投影即可），
 *    它只在排障/验收时用——投影注册失败时界面上只会表现为「一条错误都没有」，
 *    那种「静默地什么都不显示」最容易误判，所以留一个可以直接问的证据入口。
 *
 * @module dsh-error-digest
 */

import { readFileSync } from 'node:fs'

import {
  DIGEST_PROJECTION_KEY,
  DIGEST_STATE_VERSION,
  digestStateSchema,
  digestViewSchema,
  foldDigestEvent,
  initDigestState,
  viewDigestState,
} from './src/digest-fold.js'

/**
 * 宿主半构建版本，直接读同目录的 package.json（单一事实来源）。
 *
 * 宿主半只在 DSH 启动或插件重载时加载，客户端半每次刷新页面都会重新取；
 * 两半版本错位是真实存在的运行状态，把版本打出来就能一眼定位。
 * @type {string}
 */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** Cordis 插件名（诊断与 patch 行定位用）。 */
export const name = 'error-digest'

/** 硬依赖：没有会话投影注册表就没有可注册的单元。 */
export const inject = ['sessionProjections']

/**
 * 客户端回调用的路由前缀。
 *
 * 客户端用**文档相对**路径请求（`dsh-error-digest/debug`，不带前导斜杠）：
 * 桌面端页面是 `dsh-app://app/`，其非静态路径会被 shell 同源转发到宿主；
 * Web 端页面带 `<base href="./">`，相对路径能正确落在部署前缀下。
 */
export const ROUTE_PATH = '/dsh-error-digest'

/**
 * 写一个 JSON 响应。
 * @param {object} res node:http 响应对象。
 * @param {number} status HTTP 状态码。
 * @param {object} body JSON 体。
 */
function respond(res, status, body) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  } catch {
    /* 连接已经断开：忽略 */
  }
}

/**
 * 造一个只读诊断处理器。
 *
 * 只认 POST，且任何内部异常都变成 200 + `{ error }`：诊断入口自己绝不能 500，
 * 否则「不知道发生了什么」会变成「知道它坏了但不知道为什么」。
 * @param {() => object} diagnostics 只读诊断回调。
 * @returns {(req: object, res: object) => void} node:http 处理器。
 */
export function createRouteHandler(diagnostics) {
  return (req, res) => {
    const url = typeof req.url === 'string' ? req.url : ''
    const action = url.startsWith(`${ROUTE_PATH}/`) ? url.slice(ROUTE_PATH.length + 1).split('?')[0] : ''
    if (req.method !== 'POST') {
      respond(res, 405, { error: 'method-not-allowed' })
      return
    }
    req.resume?.()
    if (action === 'ping') {
      respond(res, 200, { host: name, version: VERSION, projectionKey: DIGEST_PROJECTION_KEY })
      return
    }
    if (action === 'debug') {
      let body
      try {
        body = diagnostics()
      } catch (error) {
        body = { error: `diagnostics failed: ${String(error)}` }
      }
      respond(res, 200, body ?? { error: 'diagnostics-unavailable' })
      return
    }
    respond(res, 404, { error: 'unknown-action' })
  }
}

/**
 * Cordis 插件入口：注册投影单元（可选地挂上诊断路由）。
 * @param {object} ctx Cordis 上下文（注入了 ctx.sessionProjections）。
 */
export function apply(ctx) {
  ctx.sessionProjections.register({
    key: DIGEST_PROJECTION_KEY,
    stateVersion: DIGEST_STATE_VERSION,
    stateSchema: digestStateSchema,
    init: initDigestState,
    apply: foldDigestEvent,
    wire: {
      viewSchema: digestViewSchema,
      view: viewDigestState,
    },
  })
  ctx.logger?.info?.(`[error-digest] 宿主半 v${VERSION} 已加载：会话投影 ${DIGEST_PROJECTION_KEY} 已注册`)

  /** 只读诊断：投影键是否真的注册进了客户端可见集合，以及在挂会话折叠出了什么。 */
  const diagnostics = () => {
    const sessions = ctx.get?.('sessions')
    const attached = typeof sessions?.list === 'function' ? sessions.list() : []
    const rows = []
    for (const session of attached.slice(0, 25)) {
      const row = { id: session?.id }
      try {
        const cut = ctx.sessionProjections.snapshot(session)
        const view = cut.values?.[DIGEST_PROJECTION_KEY]
        row.registered = Object.hasOwn(cut.values ?? {}, DIGEST_PROJECTION_KEY)
        row.asOfSeq = cut.asOfSeq
        row.distinct = Array.isArray(view?.entries) ? view.entries.length : 0
        row.total = Array.isArray(view?.entries)
          ? view.entries.reduce((sum, entry) => sum + (Number.isInteger(entry?.count) ? entry.count : 0), 0)
          : 0
        row.sample = Array.isArray(view?.entries)
          ? view.entries.slice(0, 5).map((entry) => ({ kind: entry.kind, key: entry.key, code: entry.code, count: entry.count }))
          : []
      } catch (error) {
        row.error = String(error)
      }
      try {
        row.cached = Object.hasOwn(ctx.sessionProjections.cachedSnapshot(session)?.values ?? {}, DIGEST_PROJECTION_KEY)
      } catch {
        row.cached = null
      }
      rows.push(row)
    }
    return {
      hostHalf: true,
      plugin: name,
      version: VERSION,
      projectionKey: DIGEST_PROJECTION_KEY,
      stateVersion: DIGEST_STATE_VERSION,
      attachedSessions: attached.length,
      rows,
    }
  }

  /** webServer 是软依赖：没有它（例如纯 headless 组合）时投影照常工作，只是没有诊断入口。 */
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: createRouteHandler(diagnostics),
    }), 'error-digest: routes')
    ctx.logger?.info?.(`[error-digest] 宿主半 v${VERSION}：诊断路由 ${ROUTE_PATH}/debug 已挂载`)
  })
}

export default { name, inject, apply }
