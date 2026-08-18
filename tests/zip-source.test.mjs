/**
 * URL-driven SDE update tests: input validation, download robustness
 * (404/5xx, timeout, connection refused, size caps, corrupt/truncated zip,
 * zip-slip, missing/bad payload), and the full GuiRunner flow (status
 * sequence, atomic install, same-content no-op, rollback) — all against a
 * local HTTP server serving real zips built with fflate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { SdeService } from '../src/sde/service.ts'
import { SdeGuiRunner } from '../src/sde/gui-runner.ts'
import { buildManifestForVersionDir } from '../scripts/build-manifest.mjs'
import { installVersionDir, validateSdeUrl } from '../src/sde/zip-source.ts'
import { ZipSdeSource, SdeZipError } from '../src/sde/zip-source.ts'
import { swapCurrentSymlink } from '../src/sde/update.ts'

// ---- helpers ---------------------------------------------------------------

function makeMirrorZip(buildNumber, tables, options = {}) {
  const entries = {
    'manifest.json': strToU8(JSON.stringify({
      buildNumber,
      releaseDate: `${buildNumber}T00:00:00Z`,
      generatedAt: '2026-01-01T00:00:00Z',
      tables: Object.fromEntries(
        Object.entries(tables).map(([table, rows]) => [table, { rows: rows.length, sha256: `sha-${table}`, sizeBytes: 42 }]),
      ),
    })),
    ...Object.fromEntries(
      Object.entries(tables).map(([table, rows]) => [
        `${table}.jsonl`,
        strToU8(rows.map((row) => JSON.stringify(row)).join('\n') + '\n'),
      ]),
    ),
    ...(options.extra ?? {}),
  }
  return zipSync(entries)
}

const TYPES_V1 = [
  { _key: 34, name: { en: 'Tritanium' }, published: true },
  { _key: 587, name: { en: 'Rifter' }, published: true },
]
const GROUPS = [{ _key: 6, name: { en: 'Ship' } }]

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function url(port, path = '/sde.zip') {
  return `http://127.0.0.1:${port}${path}`
}

function makeDataRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-esi-zip-'))
}

/** Serve one fixed zip (HEAD + GET). */
function serveZip(zipBytes, headers = {}) {
  return (req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': zipBytes.byteLength, ...headers })
      res.end()
      return
    }
    res.writeHead(200, { 'content-length': zipBytes.byteLength, ...headers })
    res.end(Buffer.from(zipBytes))
  }
}

// ---- validateSdeUrl ---------------------------------------------------------

test('validateSdeUrl rejects non-http(s) and malformed inputs', () => {
  const urlCodes = new Set(['URL_EMPTY', 'URL_TOO_LONG', 'URL_CONTROL_CHAR', 'URL_MALFORMED', 'URL_SCHEME', 'URL_NO_HOST'])
  for (const bad of ['', '   ', '/tmp/x.zip', 'x.zip', 'relative/path', 'file:///etc/passwd', 'ftp://host/x.zip', 'http://', 'http://\u0000', 'https://a b.com/x.zip', 'not a url at all']) {
    assert.throws(() => validateSdeUrl(bad), (error) => error instanceof SdeZipError && urlCodes.has(error.code), `expected ${JSON.stringify(bad)} to be rejected`)
  }
  assert.equal(validateSdeUrl(' https://example.com/sde/sde-20260731.zip ').href, 'https://example.com/sde/sde-20260731.zip')
  assert.equal(validateSdeUrl('http://127.0.0.1:9999/a.zip').protocol, 'http:')
})

// ---- download + payload validation -------------------------------------------

test('downloads, extracts and validates a mirror zip', async () => {
  const zip = makeMirrorZip(20260101, { types: TYPES_V1, groups: GROUPS })
  const { server, port } = await startServer(serveZip(zip))
  const dataRoot = makeDataRoot()
  try {
    const source = new ZipSdeSource(url(port, '/sde-20260101.zip'))
    const probe = await source.probe()
    assert.equal(probe.buildNumber, 20260101)
    assert.ok(probe.estimatedBytes > 0)

    const { stagingDir, buildNumber, bytesDownloaded } = await source.downloadToStaging(dataRoot)
    assert.equal(buildNumber, 20260101)
    assert.ok(bytesDownloaded > 0)
    for (const file of ['manifest.json', 'types.jsonl', 'groups.jsonl', '_sde.jsonl']) {
      assert.ok(existsSync(join(stagingDir, file)), `missing ${file}`)
    }
    rmSync(stagingDir, { recursive: true, force: true })
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('rejects a corrupt archive (bad magic)', async () => {
  const { server, port } = await startServer(serveZip(new Uint8Array([1, 2, 3, 4, 5, 6])))
  const dataRoot = makeDataRoot()
  try {
    const source = new ZipSdeSource(url(port))
    await assert.rejects(source.downloadToStaging(dataRoot), (e) => e instanceof SdeZipError && e.code === 'ZIP_BAD_MAGIC')
    assert.equal(readdirCount(dataRoot), 0, 'staging must be cleaned up')
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('rejects a truncated archive', async () => {
  const zip = makeMirrorZip(20260101, { types: TYPES_V1 })
  const truncated = zip.slice(0, Math.floor(zip.byteLength / 2))
  const { server, port } = await startServer(serveZip(truncated))
  const dataRoot = makeDataRoot()
  try {
    await assert.rejects(new ZipSdeSource(url(port)).downloadToStaging(dataRoot), (e) => e instanceof SdeZipError && e.code === 'ZIP_CORRUPT')
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('rejects zip-slip entry paths', async () => {
  const zip = makeMirrorZip(20260101, { types: TYPES_V1 }, {
    extra: { '../evil.jsonl': strToU8('[]') },
  })
  const { server, port } = await startServer(serveZip(zip))
  const dataRoot = makeDataRoot()
  try {
    await assert.rejects(new ZipSdeSource(url(port)).downloadToStaging(dataRoot), (e) => e instanceof SdeZipError && e.code === 'PATH_TRAVERSAL')
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('rejects an archive without manifest.json', async () => {
  const zip = zipSync({ 'types.jsonl': strToU8('[]') })
  const { server, port } = await startServer(serveZip(zip))
  const dataRoot = makeDataRoot()
  try {
    await assert.rejects(new ZipSdeSource(url(port)).downloadToStaging(dataRoot), (e) => e instanceof SdeZipError && e.code === 'PAYLOAD_NO_MANIFEST' && e.message.includes('manifest.json'))
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('rejects a manifest listing a missing table file', async () => {
  const zip = makeMirrorZip(20260101, { types: TYPES_V1 }, {
    extra: { 'manifest.json': strToU8(JSON.stringify({ buildNumber: 20260101, releaseDate: 'x', generatedAt: 'x', tables: { types: { rows: 1, sha256: 'a', sizeBytes: 1 }, missing: { rows: 1, sha256: 'b', sizeBytes: 1 } } })) },
  })
  const { server, port } = await startServer(serveZip(zip))
  const dataRoot = makeDataRoot()
  try {
    await assert.rejects(new ZipSdeSource(url(port)).downloadToStaging(dataRoot), (e) => e instanceof SdeZipError && e.code === 'PAYLOAD_MISSING_TABLES' && e.message.includes('missing.jsonl'))
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('rejects an invalid buildNumber', async () => {
  const zip = makeMirrorZip('not-a-number', { types: TYPES_V1 })
  const { server, port } = await startServer(serveZip(zip))
  const dataRoot = makeDataRoot()
  try {
    await assert.rejects(new ZipSdeSource(url(port)).downloadToStaging(dataRoot), (e) => e instanceof SdeZipError && e.code === 'PAYLOAD_NO_BUILD')
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('maps HTTP errors with status', async () => {
  const { server, port } = await startServer((req, res) => { res.writeHead(404); res.end() })
  const dataRoot = makeDataRoot()
  try {
    await assert.rejects(new ZipSdeSource(url(port)).downloadToStaging(dataRoot), (e) => e instanceof SdeZipError && e.code === 'HTTP_ERROR' && e.status === 404)
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('reports connection failures as NETWORK', async () => {
  const dataRoot = makeDataRoot()
  try {
    // A port nobody listens on.
    await assert.rejects(new ZipSdeSource('http://127.0.0.1:1/sde.zip', { retries: 0 }).downloadToStaging(dataRoot), (e) => e instanceof SdeZipError && e.code === 'NETWORK')
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('times out on a stalled body (idle timeout)', async () => {
  const zip = makeMirrorZip(20260101, { types: TYPES_V1 })
  const { server, port } = await startServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': zip.byteLength }); res.end(); return }
    res.writeHead(200, { 'content-length': zip.byteLength })
    res.write(Buffer.from(zip.slice(0, 10)))
    // never finish
  })
  const dataRoot = makeDataRoot()
  try {
    await assert.rejects(
      new ZipSdeSource(url(port), { idleMs: 200, timeoutMs: 5000, retries: 0 }).downloadToStaging(dataRoot),
      (e) => e instanceof SdeZipError && e.code === 'TIMEOUT',
    )
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('rejects oversized downloads via content-length', async () => {
  const zip = makeMirrorZip(20260101, { types: TYPES_V1 })
  const { server, port } = await startServer(serveZip(zip))
  const dataRoot = makeDataRoot()
  try {
    await assert.rejects(
      new ZipSdeSource(url(port), { maxBytes: 100 }).downloadToStaging(dataRoot),
      (e) => e instanceof SdeZipError && e.code === 'TOO_LARGE',
    )
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('retries transient HTTP 500 then succeeds', async () => {
  const zip = makeMirrorZip(20260101, { types: TYPES_V1 })
  let calls = 0
  const { server, port } = await startServer((req, res) => {
    calls += 1
    if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': zip.byteLength }); res.end(); return }
    if (calls < 3) { res.writeHead(500); res.end(); return }
    res.writeHead(200, { 'content-length': zip.byteLength })
    res.end(Buffer.from(zip))
  })
  const dataRoot = makeDataRoot()
  try {
    const { stagingDir } = await new ZipSdeSource(url(port), { retries: 2 }).downloadToStaging(dataRoot)
    assert.ok(existsSync(join(stagingDir, 'types.jsonl')))
    rmSync(stagingDir, { recursive: true, force: true })
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

// ---- GuiRunner full flow ------------------------------------------------------

test('GuiRunner: full update + query + rollback', async () => {
  const zip = makeMirrorZip(20260101, { types: TYPES_V1, groups: GROUPS })
  const { server, port } = await startServer(serveZip(zip))
  const dataRoot = makeDataRoot()
  try {
    const runner = new SdeGuiRunner({ dataRoot })
    const statuses = []
    await runner.runUpdate(url(port), (s) => statuses.push(s))

    const phases = statuses.map((s) => s.phase)
    assert.ok(phases.includes('checking'))
    assert.ok(phases.includes('downloading'))
    assert.ok(phases.includes('extracting'))
    assert.ok(phases.includes('building'))
    assert.ok(phases.includes('installing'))
    assert.equal(phases[phases.length - 1], 'done')
    const done = statuses[statuses.length - 1]
    assert.equal(done.currentBuild, 20260101)
    assert.equal(done.messageKey, 'status.updated')
    assert.deepEqual(done.messageParams, { build: 20260101 })
    assert.equal(runner.status().phase, 'done')
    // Structured status lines carry a key; the raw zh message stays as fallback.
    const downloading = statuses.find((s) => s.phase === 'downloading')
    assert.ok(downloading.messageKey === 'status.downloading' || downloading.messageKey === 'status.downloadingPercent')
    assert.ok(typeof downloading.messageParams.size === 'string')
    assert.ok(downloading.message.length > 0)
    for (const s of statuses) {
      if (s.phase === 'error') continue
      assert.ok(typeof s.messageKey === 'string', `phase ${s.phase} should carry a messageKey`)
    }

    // The active version serves queries through the sqlite store.
    const sde = new SdeService({ dataRoot })
    assert.equal(sde.status().buildNumber, 20260101)
    const rifter = await sde.query({ table: 'types', ids: [587] })
    assert.equal(rifter.count, 1)
    assert.equal(rifter.rows[0].name, 'Rifter')

    // Rollback with only one version on disk reports no candidate.
    const rollbackStatuses = []
    await runner.rollback((s) => rollbackStatuses.push(s))
    assert.equal(rollbackStatuses[rollbackStatuses.length - 1].phase, 'error')
    assert.equal(rollbackStatuses[rollbackStatuses.length - 1].error.code, 'NO_ROLLBACK')
    assert.equal(rollbackStatuses[rollbackStatuses.length - 1].error.params, undefined)
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('GuiRunner: update then rollback to the previous version', async () => {
  const zipV1 = makeMirrorZip(20260101, { types: TYPES_V1, groups: GROUPS })
  const zipV2 = makeMirrorZip(20260102, { types: [{ _key: 587, name: { en: 'Rifter v2' } }], groups: GROUPS })
  const { server, port } = await startServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': 10 }); res.end(); return }
    const body = req.url?.includes('v2') ? zipV2 : zipV1
    res.writeHead(200, { 'content-length': body.byteLength })
    res.end(Buffer.from(body))
  })
  const dataRoot = makeDataRoot()
  try {
    const runner = new SdeGuiRunner({ dataRoot })
    await runner.runUpdate(url(port, '/v1.zip'), () => {})
    await runner.runUpdate(url(port, '/v2.zip'), () => {})
    assert.equal(new SdeService({ dataRoot }).status().buildNumber, 20260102)

    const statuses = []
    await runner.rollback((s) => statuses.push(s))
    assert.equal(statuses[statuses.length - 1].phase, 'done')
    assert.equal(new SdeService({ dataRoot }).status().buildNumber, 20260101)
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('GuiRunner: same-content re-download reuses the version dir', async () => {
  const zip = makeMirrorZip(20260101, { types: TYPES_V1, groups: GROUPS })
  const { server, port } = await startServer(serveZip(zip))
  const dataRoot = makeDataRoot()
  try {
    const runner = new SdeGuiRunner({ dataRoot })
    await runner.runUpdate(url(port), () => {})
    const versionDir = join(dataRoot, 'sde-20260101')
    const manifestBefore = readFileSync(join(versionDir, 'manifest.json'), 'utf8')
    await runner.runUpdate(url(port), () => {})
    assert.equal(readFileSync(join(versionDir, 'manifest.json'), 'utf8'), manifestBefore)
    // No staging leftovers.
    const leftovers = readdirSync(dataRoot).filter((n) => n.includes('staging'))
    assert.equal(leftovers.length, 0)
  } finally {
    server.close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('GuiRunner: bad URL and bad payload surface typed error statuses', async () => {
  const dataRoot = makeDataRoot()
  const runner = new SdeGuiRunner({ dataRoot })
  try {
    const badUrl = []
    await runner.runUpdate('not a url at all', (s) => badUrl.push(s))
    assert.equal(badUrl[badUrl.length - 1].phase, 'error')
    assert.equal(badUrl[badUrl.length - 1].error.code, 'URL_MALFORMED')
    assert.deepEqual(badUrl[badUrl.length - 1].error.params, { url: 'not a url at all' })

    const zip = zipSync({ 'types.jsonl': strToU8('[]') })
    const { server, port } = await startServer(serveZip(zip))
    try {
      const badPayload = []
      await runner.runUpdate(url(port), (s) => badPayload.push(s))
      assert.equal(badPayload[badPayload.length - 1].phase, 'error')
      assert.equal(badPayload[badPayload.length - 1].error.code, 'PAYLOAD_NO_MANIFEST')
    } finally {
      server.close()
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('installVersionDir handles same-build different content', async () => {
  const dataRoot = makeDataRoot()
  try {
    const stagingA = join(dataRoot, '.staging-a')
    const stagingB = join(dataRoot, '.staging-b')
    const zipA = makeMirrorZip(20260101, { types: TYPES_V1 })
    const zipB = makeMirrorZip(20260101, { types: [{ _key: 1, name: { en: 'x' } }] })
    // Extract both to staging dirs via the source (downloads from the same server).
    const { server, port } = await startServer((req, res) => {
      if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': 10 }); res.end(); return }
      const body = req.url?.includes('b') ? zipB : zipA
      res.writeHead(200, { 'content-length': body.byteLength })
      res.end(Buffer.from(body))
    })
    try {
      const sourceA = new ZipSdeSource(url(port, '/a.zip'))
      const sourceB = new ZipSdeSource(url(port, '/b.zip'))
      const a = await sourceA.downloadToStaging(dataRoot)
      buildManifestForVersionDir(a.stagingDir)
      const targetA = installVersionDir(dataRoot, a.stagingDir, a.buildNumber)
      assert.ok(existsSync(join(targetA, 'types.jsonl')))
      const b = await sourceB.downloadToStaging(dataRoot)
      buildManifestForVersionDir(b.stagingDir)
      const targetB = installVersionDir(dataRoot, b.stagingDir, b.buildNumber)
      assert.equal(targetA, targetB)
      // Content replaced: the second version's jsonl wins.
      const types = JSON.parse(readFileSync(join(targetB, 'types.jsonl'), 'utf8').split('\n')[0])
      assert.equal(types._key, 1)
    } finally {
      server.close()
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

// ---- misc ---------------------------------------------------------------------

test('swapCurrentSymlink flips the current symlink atomically', () => {
  const dataRoot = makeDataRoot()
  try {
    swapCurrentSymlink(dataRoot, 'sde-1')
    assert.equal(readlinkSync(join(dataRoot, 'current')), 'sde-1')
    swapCurrentSymlink(dataRoot, 'sde-2')
    assert.equal(readlinkSync(join(dataRoot, 'current')), 'sde-2')
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

function readdirCount(dir) {
  return readdirSync(dir).length
}
