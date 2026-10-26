/**
 * dsh-error-digest 构建产物契约测试。
 *
 * 三件事：
 *   1. `lib/client.js` 必须是当前源码的等价生成（防止「改了源码忘了重新构建」）；
 *   2. 产物必须能被 JS 解析（classic script，不是 ES 模块）；
 *   3. 产物里必须带齐协议要素：`window.__ModuleLoader__.load`、包名 id、版本号，
 *      并且不能残留 ESM 的 import/export。
 *
 * 运行：node --test test/bundle-test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { OUTPUT_PATH, buildBundle, checkBundle } from '../build/bundle.mjs'

/** 产物文本。 */
const bundleText = buildBundle()

test('lib/client.js 与源码一致', () => {
  const result = checkBundle()
  assert.equal(result.ok, true, result.message)
})

test('产物是可解析的 classic script', () => {
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(bundleText)
  })
  const source = readFileSync(OUTPUT_PATH, 'utf8')
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /^\s*export\s/m)
})

test('产物带齐客户端模块协议要素', () => {
  assert.match(bundleText, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(bundleText, /id:\s*"dsh-error-digest"/)
  assert.match(bundleText, /const BUNDLE_VERSION = "/)
  assert.match(bundleText, /exports\.apply = apply/)
  assert.match(bundleText, /exports\.inject = inject/)
})

test('两半共用同一个投影键', () => {
  assert.match(bundleText, /const DIGEST_PROJECTION_KEY = ['"]dialogErrors['"]/)
  const host = readFileSync(new URL('../src/digest-fold.js', import.meta.url), 'utf8')
  assert.match(host, /DIGEST_PROJECTION_KEY = 'dialogErrors'/)
})

test('面板 id 在两端一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-error-digest')
  assert.match(bundleText, /const PANEL_ID = ['"]error-digest['"]/)
})
