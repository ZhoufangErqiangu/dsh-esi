/**
 * SDE service tests against a synthetic version directory: manifest build,
 * indexed fast paths (ids / name search), stream-scan fallback, filters,
 * projection, localization, limits, and error paths.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManifest } from '../scripts/build-manifest.mjs'
import { SdeService } from '../src/sde/service.ts'

const TYPES = [
  { _key: 34, name: { en: 'Tritanium', zh: '三钛合金' }, mass: 0.1, published: true },
  { _key: 587, name: { en: 'Rifter', zh: '裂谷级' }, mass: 1.1, published: true },
  { _key: 588, name: { en: 'Rifter Blueprint', zh: '裂谷级蓝图' }, mass: 0, published: false },
  { _key: 644, name: { en: 'Raven', zh: '乌鸦级' }, mass: 2.2, published: true },
]
const GROUPS = [
  { _key: 1, name: { en: 'Ship', zh: '舰船' }, categoryID: 6 },
  { _key: 2, name: { en: 'Module', zh: '模块' }, categoryID: 7 },
]
const SHIPS = [
  { _key: 10, name: { en: 'Alpha cruiser' }, typeID: 587 },
  { _key: 11, name: { en: 'Beta frigate' }, typeID: 588 },
]

function setupData() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-esi-sde-'))
  const versionDir = join(dir, 'sde-test-1')
  mkdirSync(versionDir, { recursive: true })
  writeFileSync(join(versionDir, '_sde.jsonl'), JSON.stringify({ _key: 'sde', buildNumber: 1, releaseDate: '2026-01-01T00:00:00Z' }))
  const dump = (table, rows) => writeFileSync(join(versionDir, `${table}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  dump('types', TYPES)
  dump('groups', GROUPS)
  dump('ships', SHIPS)
  const summary = buildManifest(dir)
  assert.equal(summary.tableCount, 3)
  return { dir, versionDir }
}

function makeService(dir) {
  return new SdeService({ dataRoot: dir, defaultLanguage: 'en' })
}

test('status reports build, tables, and indexed set', () => {
  const { dir } = setupData()
  try {
    const status = makeService(dir).status()
    assert.equal(status.buildNumber, 1)
    assert.equal(status.releaseDate, '2026-01-01T00:00:00Z')
    assert.equal(status.tableCount, 3)
    assert.equal(status.totalRows, 8)
    assert.ok(status.totalBytes > 0)
    assert.equal(status.dbPresent, true)
    assert.equal(status.manifestPresent, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('indexed ids lookup resolves localized names', async () => {
  const { dir } = setupData()
  try {
    const sde = makeService(dir)
    const en = await sde.query({ table: 'types', ids: [587] })
    assert.equal(en.count, 1)
    assert.equal(en.rows[0].name, 'Rifter')
    assert.equal(en.meta.engine, 'sqlite')
    const zh = await sde.query({ table: 'types', ids: [34], language: 'zh' })
    assert.equal(zh.rows[0].name, '三钛合金')
    const missing = await sde.query({ table: 'types', ids: [999999] })
    assert.equal(missing.count, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('indexed name search finds all matches case-insensitively', async () => {
  const { dir } = setupData()
  try {
    const sde = makeService(dir)
    const result = await sde.query({ table: 'types', search: { text: 'rifter' } })
    assert.equal(result.count, 2)
    const names = result.rows.map((row) => row.name).sort()
    assert.deepEqual(names, ['Rifter', 'Rifter Blueprint'])
    assert.equal(result.meta.engine, 'sqlite')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exact and operator filters scan non-indexed paths correctly', async () => {
  const { dir } = setupData()
  try {
    const sde = makeService(dir)
    const exact = await sde.query({ table: 'types', filter: { published: true } })
    assert.equal(exact.count, 3)
    assert.equal(exact.meta.engine, 'sqlite')

    const ranged = await sde.query({ table: 'types', filter: { mass: { gte: 1 } } })
    const masses = ranged.rows.map((row) => row.mass).sort()
    assert.deepEqual(masses, [1.1, 2.2])

    const inFilter = await sde.query({ table: 'groups', filter: { categoryID: { in: [6, 7] } } })
    assert.equal(inFilter.count, 2)
    const neFilter = await sde.query({ table: 'groups', filter: { categoryID: { ne: 6 } } })
    assert.equal(neFilter.count, 1)
    assert.equal(neFilter.rows[0]._key, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search on a table without localized names matches plain name', async () => {
  const { dir } = setupData()
  try {
    const sde = makeService(dir)
    const result = await sde.query({ table: 'ships', search: { text: 'frigate' } })
    assert.equal(result.count, 1)
    assert.equal(result.rows[0]._key, 11)
    assert.equal(result.meta.engine, 'sqlite')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('projection, limit truncation, and localized default language', async () => {
  const { dir } = setupData()
  try {
    const sde = makeService(dir)
    const projected = await sde.query({ table: 'types', ids: [587], fields: ['_key', 'name'] })
    assert.deepEqual(Object.keys(projected.rows[0]).sort(), ['_key', 'name'])

    const zhDefault = new SdeService({ dataRoot: dir, defaultLanguage: 'zh' })
    const zh = await zhDefault.query({ table: 'types', ids: [587] })
    assert.equal(zh.rows[0].name, '裂谷级')

    const limited = await sde.query({ table: 'types', filter: { published: true }, limit: 2 })
    assert.equal(limited.count, 2)
    assert.equal(limited.meta.truncated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown tables and missing manifests produce actionable errors', async () => {
  const { dir } = setupData()
  try {
    const sde = makeService(dir)
    await assert.rejects(sde.query({ table: 'nope' }), /unknown SDE table "nope".*types/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // A version dir with no manifest yet.
  const bare = mkdtempSync(join(tmpdir(), 'dsh-esi-sde-bare-'))
  const versionDir = join(bare, 'v1')
  mkdirSync(versionDir, { recursive: true })
  writeFileSync(join(versionDir, '_sde.jsonl'), JSON.stringify({ _key: 'sde', buildNumber: 2, releaseDate: 'x' }))
  writeFileSync(join(versionDir, 'types.jsonl'), JSON.stringify({ _key: 1, name: { en: 'X' } }) + '\n')
  try {
    const sde = new SdeService({ dataRoot: bare })
    const status = sde.status()
    assert.equal(status.manifestPresent, false)
    await assert.rejects(sde.query({ table: 'types', ids: [1] }), /manifest missing/)
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})

test('multiple version dirs without a current symlink are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-esi-sde-multi-'))
  try {
    for (const name of ['v1', 'v2']) {
      const versionDir = join(dir, name)
      mkdirSync(versionDir, { recursive: true })
      writeFileSync(join(versionDir, '_sde.jsonl'), JSON.stringify({ _key: 'sde', buildNumber: 1, releaseDate: 'x' }))
    }
    assert.throws(() => new SdeService({ dataRoot: dir }).status(), /no "current" symlink/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
