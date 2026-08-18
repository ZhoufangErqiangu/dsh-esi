/**
 * sde_update tool surface tests: the url mode (dry-run plan, execute via the
 * URL runner, invalid input handling) against a local mirror server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { SdeGuiRunner } from '../src/sde/gui-runner.ts'
import { createSdeUpdateTool, createSdeRollbackTool } from '../src/tools/sde-update.ts'

function makeZip() {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({
      buildNumber: 20260103,
      releaseDate: '20260103T00:00:00Z',
      generatedAt: 'x',
      tables: { types: { rows: 1, sha256: 'a', sizeBytes: 1 } },
    })),
    'types.jsonl': strToU8(JSON.stringify({ _key: 34, name: { en: 'Tritanium' } }) + '\n'),
  })
}

function startServer() {
  const zip = makeZip()
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': zip.byteLength }); res.end(); return }
      res.writeHead(200, { 'content-length': zip.byteLength })
      res.end(Buffer.from(zip))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('sde_update url mode: dry-run plan, then execute, then rollback', async () => {
  const { server, port } = await startServer()
  const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-esi-tool-'))
  try {
    const runner = new SdeGuiRunner({ dataRoot })
    const urlRunner = (url, signal) => {
      let last
      return runner.runUpdate(url, (s) => { last = s }, signal).then(() => last)
    }
    const tool = createSdeUpdateTool(undefined, urlRunner)
    const url = `http://127.0.0.1:${port}/sde-20260103.zip`

    const plan = await tool.execute({ confirm: false, url }, { signal: undefined })
    assert.equal(plan.dryRun, true)
    assert.equal(plan.reachable, true)
    assert.equal(plan.buildNumber, 20260103)
    assert.ok(plan.estimatedBytes > 0)

    const result = await tool.execute({ confirm: true, url }, { signal: undefined })
    assert.equal(result.phase, 'done')
    assert.equal(result.currentBuild, 20260103)

    // rollback with one version on disk reports no candidate via the tool too.
    const { SdeUpdater } = await import('../src/sde/update.ts')
    const rollback = createSdeRollbackTool(new SdeUpdater({ dataRoot }))
    const rbPlan = await rollback.execute({ confirm: false }, { signal: undefined })
    assert.equal(rbPlan.dryRun, true)
    assert.ok(Array.isArray(rbPlan.versions))
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('sde_update url mode: invalid URL and missing source surface typed errors', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-esi-tool-'))
  try {
    const runner = new SdeGuiRunner({ dataRoot })
    const urlRunner = (url, signal) => {
      let last
      return runner.runUpdate(url, (s) => { last = s }, signal).then(() => last)
    }
    const tool = createSdeUpdateTool(undefined, urlRunner)

    const badUrl = await tool.execute({ confirm: false, url: 'not a url' }, { signal: undefined })
    assert.equal(badUrl.ok, false)
    assert.equal(badUrl.error.code, 'URL_MALFORMED')

    const noUrl = await tool.execute({ confirm: true }, { signal: undefined })
    assert.equal(noUrl.ok, false)
    assert.equal(noUrl.error.code, 'NO_SOURCE')
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})
