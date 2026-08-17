/**
 * SDE update machinery tests: dry-run planning (build diff, sha256 delta),
 * execution (delta download + hardlink reuse + atomic `current` swap),
 * rollback, and fresh install — all against a local HTTP mirror.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManifestForVersionDir } from '../scripts/build-manifest.mjs'
import { JsonlSdeSource, SdeUpdater } from '../src/sde/update.ts'
import { SdeService } from '../src/sde/service.ts'

function writeVersion(dir, build, tables) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '_sde.jsonl'), JSON.stringify({ _key: 'sde', buildNumber: build, releaseDate: `2026-01-0${build}T00:00:00Z` }))
  for (const [table, rows] of Object.entries(tables)) {
    writeFileSync(join(dir, `${table}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  }
  return buildManifestForVersionDir(dir, { indexTables: ['types'] })
}

const V1_TYPES = [
  { _key: 34, name: { en: 'Tritanium' }, published: true },
  { _key: 587, name: { en: 'Rifter' }, published: true },
]
const V2_TYPES = [
  { _key: 34, name: { en: 'Tritanium' }, published: true },
  { _key: 587, name: { en: 'Rifter (balanced)' }, published: true },
]
const GROUPS = [{ _key: 6, name: { en: 'Ship' } }]
const FACTIONS = [{ _key: 500001, name: { en: 'Caldari State' } }]

function startMirror(rootDir) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = new URL(req.url, 'http://x').pathname
      const rel = path.replace(/^\/sde\//, '')
      const file = join(rootDir, rel)
      if (existsSync(file)) {
        res.setHeader('Content-Type', 'application/json')
        res.end(readFileSync(file))
      } else {
        res.statusCode = 404
        res.end('{}')
      }
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function makeRemoteDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-esi-upd-remote-'))
}

function setupLocal(dataRoot, build, tables) {
  const versionDir = join(dataRoot, `v${build}`)
  writeVersion(versionDir, build, tables)
  symlinkSync(`v${build}`, join(dataRoot, 'current'))
  return versionDir
}

test('plan diffs builds and sha256s; updateAvailable reflects the change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-esi-upd-'))
  const remoteDir = makeRemoteDir()
  try {
    // Remote mirror is build 2 with types changed, groups same, factions new.
    writeVersion(remoteDir, 2, { types: V2_TYPES, groups: GROUPS, factions: FACTIONS })
    const mirror = await startMirror(remoteDir)

    // Local current is build 1.
    setupLocal(root, 1, { types: V1_TYPES, groups: GROUPS })
    const updater = new SdeUpdater({
      dataRoot: root,
      source: new JsonlSdeSource({ baseUrl: `http://127.0.0.1:${mirror.port}/sde` }),
    })

    const plan = await updater.plan()
    assert.equal(plan.currentBuild, 1)
    assert.equal(plan.latestBuild, 2)
    assert.equal(plan.updateAvailable, true)
    assert.deepEqual([...plan.changedTables].sort(), ['factions', 'types'])
    assert.ok(plan.estimatedBytes > 0)
    assert.match(plan.sourceDescription, /jsonl mirror/)

    // Same-build mirror → no update (probed through a fresh updater).
    const sameMirror = await startMirror(join(root, 'v1'))
    const same = await new SdeUpdater({
      dataRoot: root,
      source: new JsonlSdeSource({ baseUrl: `http://127.0.0.1:${sameMirror.port}/sde` }),
    }).plan()
    assert.equal(same.updateAvailable, false)
    assert.deepEqual(same.changedTables, [])
    await new Promise((resolve) => sameMirror.server.close(resolve))

    await new Promise((resolve) => mirror.server.close(resolve))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remoteDir, { recursive: true, force: true })
  }
})

test('run downloads the delta, hardlinks unchanged tables, and atomically swaps current', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-esi-upd-'))
  const remoteDir = makeRemoteDir()
  try {
    writeVersion(remoteDir, 2, { types: V2_TYPES, groups: GROUPS, factions: FACTIONS })
    const mirror = await startMirror(remoteDir)

    setupLocal(root, 1, { types: V1_TYPES, groups: GROUPS })
    const updater = new SdeUpdater({
      dataRoot: root,
      source: new JsonlSdeSource({ baseUrl: `http://127.0.0.1:${mirror.port}/sde` }),
    })

    const result = await updater.run()
    assert.equal(result.updated, true)
    assert.equal(result.buildNumber, 2)
    assert.equal(result.previousBuild, 1)
    assert.deepEqual([...result.changedTables].sort(), ['factions', 'types'])

    // Active version switched.
    const sde = new SdeService({ dataRoot: root })
    const status = sde.status()
    assert.equal(status.buildNumber, 2)
    assert.equal(status.tableCount, 3)

    // New data answers queries; unchanged table content carried over.
    const rifter = await sde.query({ table: 'types', ids: [587] })
    assert.equal(rifter.rows[0].name, 'Rifter (balanced)')
    const groups = await sde.query({ table: 'groups', ids: [6] })
    assert.equal(groups.rows[0].name, 'Ship')

    // Previous version still on disk for rollback.
    assert.ok(existsSync(join(root, 'v1', 'types.jsonl')))
    assert.ok(existsSync(join(root, 'sde-2', 'types.jsonl')))
    await new Promise((resolve) => mirror.server.close(resolve))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remoteDir, { recursive: true, force: true })
  }
})

test('rollback flips current back to the previous build', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-esi-upd-'))
  const remoteDir = makeRemoteDir()
  try {
    writeVersion(remoteDir, 2, { types: V2_TYPES, groups: GROUPS })
    const mirror = await startMirror(remoteDir)

    setupLocal(root, 1, { types: V1_TYPES, groups: GROUPS })
    const updater = new SdeUpdater({
      dataRoot: root,
      source: new JsonlSdeSource({ baseUrl: `http://127.0.0.1:${mirror.port}/sde` }),
    })
    await updater.run()
    assert.equal(new SdeService({ dataRoot: root }).status().buildNumber, 2)

    const rollback = updater.rollback()
    assert.equal(rollback.rolledBack, true)
    assert.equal(rollback.now, 1)
    assert.equal(rollback.previous, 2)
    assert.equal(new SdeService({ dataRoot: root }).status().buildNumber, 1)

    await new Promise((resolve) => mirror.server.close(resolve))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remoteDir, { recursive: true, force: true })
  }
})

test('fresh install creates the first version and current symlink', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-esi-upd-'))
  const remoteDir = makeRemoteDir()
  try {
    writeVersion(remoteDir, 1, { types: V1_TYPES })
    const mirror = await startMirror(remoteDir)

    const updater = new SdeUpdater({
      dataRoot: root,
      source: new JsonlSdeSource({ baseUrl: `http://127.0.0.1:${mirror.port}/sde` }),
    })
    const plan = await updater.plan()
    assert.equal(plan.currentBuild, undefined)
    assert.equal(plan.updateAvailable, true)

    const result = await updater.run()
    assert.equal(result.buildNumber, 1)
    assert.equal(new SdeService({ dataRoot: root }).status().buildNumber, 1)
    assert.ok(existsSync(join(root, 'current')))

    await new Promise((resolve) => mirror.server.close(resolve))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remoteDir, { recursive: true, force: true })
  }
})
