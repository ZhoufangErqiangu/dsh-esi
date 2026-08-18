/**
 * End-to-end verification of the SDE-update settings card against the temp
 * GUI on :3081 (DSH_HOME=/home/alex/project/dsh-esi/.gui-home).
 *
 * Flow: a local mirror server serves a real jsonl-layout zip (throttled so
 * the progress bar is observable); playwright drives the settings dialog and
 * exercises: card presence, client-side URL validation, HTTP 404 error
 * status, a full update (check → download → extract → build → done with
 * progress), and the rollback path. Screenshots land in .gui-home/shots/.
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire('/home/alex/project/deepseek-harness/apps/web/')
const { chromium } = require('playwright')
const { strToU8, zipSync } = require('/home/alex/project/dsh-esi/node_modules/fflate')

const GUI = 'http://127.0.0.1:3081'
const SHOTS = '/home/alex/project/dsh-esi/.gui-home/shots'
mkdirSync(SHOTS, { recursive: true })

const BUILD = 20260103
const zip = zipSync({
  'manifest.json': strToU8(JSON.stringify({
    buildNumber: BUILD,
    releaseDate: `${BUILD}T00:00:00Z`,
    generatedAt: '2026-01-01T00:00:00Z',
    tables: {
      types: { rows: 3, sha256: 'a1', sizeBytes: 90 },
      groups: { rows: 2, sha256: 'b2', sizeBytes: 60 },
      mapSolarSystems: { rows: 1, sha256: 'c3', sizeBytes: 30 },
    },
  })),
  'types.jsonl': strToU8(['{"_key":34,"name":{"en":"Tritanium","zh":"三钛合金"},"published":true}', '{"_key":587,"name":{"en":"Rifter","zh":"裂谷级"},"published":true}', '{"_key":645,"name":{"en":"Dominix","zh":"多米尼克斯级"},"published":true}'].join('\n') + '\n'),
  'groups.jsonl': strToU8(['{"_key":6,"name":{"en":"Ship","zh":"舰船"}}', '{"_key":5,"name":{"en":"Tackle Frigate","zh":"拦截舰"}}'].join('\n') + '\n'),
  'mapSolarSystems.jsonl': strToU8(['{"_key":30000142,"name":{"en":"Jita","zh":"吉他"}}'].join('\n') + '\n'),
})
const ZIP_BYTES = Buffer.from(zip)

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  if (req.method === 'HEAD' && path === '/sde-20260103.zip') {
    res.writeHead(200, { 'content-length': ZIP_BYTES.byteLength })
    res.end()
    return
  }
  if (req.method === 'GET' && path === '/sde-20260103.zip') {
    res.writeHead(200, { 'content-length': ZIP_BYTES.byteLength, 'content-type': 'application/zip' })
    // Throttle: 256 KiB per 120 ms so download progress is observable.
    let offset = 0
    const tick = setInterval(() => {
      const chunk = ZIP_BYTES.subarray(offset, offset + 256 * 1024)
      offset += chunk.byteLength
      res.write(chunk)
      if (offset >= ZIP_BYTES.byteLength) {
        clearInterval(tick)
        res.end()
      }
    }, 120)
    req.on('close', () => clearInterval(tick))
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port
const MIRROR = `http://127.0.0.1:${PORT}`
console.log(`mirror on :${PORT} (zip ${ZIP_BYTES.byteLength} bytes, build ${BUILD})`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({
  executablePath: '/home/alex/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',
})
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
page.on('pageerror', (error) => console.log('PAGE ERROR:', error.message))

try {
  await page.goto(GUI, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  check('GUI loads', true)

  // Open settings → Plugins → configurable tab.
  console.log('STEP: open settings')
  const btns = await page.getByRole('button').allTextContents()
  console.log('BUTTONS:', JSON.stringify(btns.slice(0, 25)))
  await page.screenshot({ path: join(SHOTS, 'dbg-before-settings.png') })
  // Dismiss first-launch dialogs (beta notice, API-key onboarding) generically:
  // any modal without the settings dialog, click its last action button.
  for (let i = 0; i < 3; i++) {
    const dlg = page.getByRole('dialog').filter({ hasNotText: '设置' }).first()
    if (await dlg.count() === 0) break
    const btns = await dlg.getByRole('button').allTextContents()
    console.log('dismissing dialog, buttons:', JSON.stringify(btns))
    await dlg.getByRole("button").first().click()
    await dlg.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {})
  }
  await page.getByRole('button', { name: '设置', exact: true }).click({ force: true })
  await new Promise(r => setTimeout(r, 1500))
  const dialogs = await page.getByRole('dialog').allTextContents()
  console.log('DIALOGS:', JSON.stringify(dialogs.map(d => d.slice(0, 60))))
  await page.screenshot({ path: join(SHOTS, 'dbg-after-settings.png') })
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.waitFor({ timeout: 10_000 })
  console.log('STEP: plugins tab')
  await dialog.getByRole('button', { name: '插件', exact: true }).click()
  console.log('STEP: configurable tab')
  await dialog.getByRole('tab', { name: '插件配置', exact: true }).click()

  // The SDE card must be present among the cards.
  const cardHeader = dialog.getByRole('button', { name: /SDE 更新/ })
  await cardHeader.waitFor({ timeout: 10_000 })
  check('SDE card present in 插件配置', true)
  console.log('STEP: expand card')
  await cardHeader.click({ force: true })
  await page.screenshot({ path: join(SHOTS, '1-card-open.png') })

  const urlInput = dialog.locator('#dsh-esi-sde-url')
  await urlInput.waitFor({ timeout: 5000 })

  // A) Client-side URL validation.
  await urlInput.fill('not a url')
  await dialog.getByRole('button', { name: '下载并更新', exact: true }).click()
  await dialog.getByText('请输入以 http:// 或 https:// 开头的完整下载地址').waitFor({ timeout: 5000 })
  check('client-side URL validation', true)
  await page.screenshot({ path: join(SHOTS, '2-invalid-url.png') })

  // B) 404 → host reports a typed error status.
  await urlInput.fill(`${MIRROR}/missing.zip`)
  await dialog.getByRole('button', { name: '下载并更新', exact: true }).click()
  await dialog.getByText(/HTTP 404/).first().waitFor({ timeout: 30_000 })
  check('HTTP 404 error status', true)
  await page.screenshot({ path: join(SHOTS, '3-http-404.png') })

  // C) Real update with observable phases + progress.
  await urlInput.fill(`${MIRROR}/sde-20260103.zip`)
  await dialog.getByRole('button', { name: '下载并更新', exact: true }).click()
  // Watch the phase chip move through 检查中/下载中/… to 完成.
  await dialog.getByRole('progressbar').first().waitFor({ timeout: 20_000 }).catch(() => {})
  await page.screenshot({ path: join(SHOTS, '4-downloading.png') })
  await dialog.getByText(/更新完成/).waitFor({ timeout: 60_000 })
  check('full update reaches done', true)
  await page.screenshot({ path: join(SHOTS, '5-done.png') })

  // Verify the data landed: sde_query via the API needs a session prompt, so
  // instead check the status line carries the new build number.
  await dialog.getByText(/build 20260103/).first().waitFor({ timeout: 5000 })
  check('status shows new build', true)

  // C2) Primary button contrast + official link (regression: white-on-white).
  const updateBtn = dialog.getByRole('button', { name: '下载并更新', exact: true })
  const bg = await updateBtn.evaluate((el) => getComputedStyle(el).backgroundColor)
  const fg = await updateBtn.evaluate((el) => getComputedStyle(el).color)
  check('primary button has contrasting text color', bg !== fg && fg !== 'rgba(0, 0, 0, 0)', `${bg} vs ${fg}`)
  const link = dialog.locator('a[href="https://developers.eveonline.com/static-data"]')
  await link.waitFor({ timeout: 5000 })
  const linkText = await link.textContent()
  check('official static-data link present', linkText !== null && linkText.length > 0, linkText)

  // D) Rollback with one version → NO_ROLLBACK error box.
  await dialog.getByRole('button', { name: '回滚', exact: true }).click()
  await dialog.getByText('没有可回滚的旧版本').first().waitFor({ timeout: 20_000 })
  check('rollback with single version reports NO_ROLLBACK', true)
  await page.screenshot({ path: join(SHOTS, '6-rollback-error.png') })
} catch (error) {
  console.log('SCRIPT ERROR:', error.message)
  await page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => {})
  check('script completed without error', false, error.message)
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length > 0 ? 1 : 0)
