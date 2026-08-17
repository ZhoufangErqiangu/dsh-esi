#!/usr/bin/env node
/**
 * Build `manifest.json` and byte-offset indexes inside the current SDE version
 * directory. Pure Node, no dependencies.
 *
 *   node scripts/build-manifest.mjs [--root <dataRoot>] [--index a,b,c]
 *
 * The manifest records per-table row counts / sha256 / sizes (used by
 * sde_status and as the update-diff baseline); indexes enable instant
 * primary-key and name lookups for the curated hot tables.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, readlinkSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const VERSION_FILE = '_sde.jsonl'
const MANIFEST_FILE = 'manifest.json'
const INDEX_DIR = 'indexes'
const LANGUAGES = new Set(['de', 'en', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'])

/** Tables that get a byte-offset index for instant key/name lookups. */
export const DEFAULT_INDEX_TABLES = [
  'types',
  'groups',
  'categories',
  'mapSolarSystems',
  'mapRegions',
  'mapConstellations',
]

export function findVersionDirs(dataRoot) {
  const entries = readdirSync(dataRoot, { withFileTypes: true })
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dataRoot, entry.name))
    .filter((dir) => existsSync(join(dir, VERSION_FILE)))
  const currentLink = join(dataRoot, 'current')
  if (existsSync(currentLink)) {
    const target = readlinkSync(currentLink)
    const resolved = join(dataRoot, target)
    if (dirs.includes(resolved)) return { current: resolved, all: dirs }
  }
  if (dirs.length === 1) return { current: dirs[0], all: dirs }
  throw new Error(`cannot resolve a current SDE version under ${dataRoot}: ${dirs.length} candidate dirs`)
}

/** Scan one jsonl file: row count, sha256, byte-offset index (when requested). */
export function scanTable(filePath) {
  const buffer = readFileSync(filePath)
  const hash = createHash('sha256')
  hash.update(buffer)
  let rows = 0
  let offset = 0
  while (offset < buffer.length) {
    const nl = buffer.indexOf(0x0a, offset)
    const end = nl === -1 ? buffer.length : nl
    const line = buffer.subarray(offset, end)
    if (line.length > 0 && line.some((byte) => byte !== 0x0d && byte !== 0x20 && byte !== 0x09)) {
      rows += 1
    }
    offset = end + 1
  }
  return { rows, sha256: hash.digest('hex'), sizeBytes: buffer.length }
}

/** Build the byte-offset + name index for one table. */
export function buildIndex(filePath) {
  const buffer = readFileSync(filePath)
  const entries = {}
  const names = {}
  let offset = 0
  while (offset < buffer.length) {
    const nl = buffer.indexOf(0x0a, offset)
    const end = nl === -1 ? buffer.length : nl
    const line = buffer.subarray(offset, end).toString('utf8').trim()
    if (line !== '') {
      try {
        const row = JSON.parse(line)
        const key = row._key
        if (key !== undefined) {
          entries[String(key)] = [offset, end - offset + 1]
        }
        const name = row.name
        if (isLocalized(name)) {
          for (const value of Object.values(name)) {
            if (typeof value === 'string' && value !== '') {
              const normalized = value.toLowerCase()
              ;(names[normalized] ??= []).push(key)
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }
    offset = end + 1
  }
  return { table: basename(filePath, '.jsonl'), entries, names }
}

function isLocalized(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length === 0) return false
  return keys.every((key) => LANGUAGES.has(key) && typeof value[key] === 'string')
}

/** Build manifest + indexes for one explicit version directory. */
export function buildManifestForVersionDir(versionDir, options = {}) {
  const indexTables = options.indexTables ?? DEFAULT_INDEX_TABLES

  const versionRaw = readFileSync(join(versionDir, VERSION_FILE), 'utf8')
  const version = JSON.parse(versionRaw)

  const tables = {}
  const files = readdirSync(versionDir)
    .filter((name) => name.endsWith('.jsonl') && name !== VERSION_FILE)
    .sort()
  for (const file of files) {
    const table = file.slice(0, -'.jsonl'.length)
    tables[table] = scanTable(join(versionDir, file))
  }

  const indexDir = join(versionDir, INDEX_DIR)
  if (indexTables.length > 0) mkdirSync(indexDir, { recursive: true })
  for (const table of indexTables) {
    const path = join(versionDir, `${table}.jsonl`)
    if (!existsSync(path)) continue
    const index = buildIndex(path)
    writeFileSync(join(indexDir, `${table}.json`), JSON.stringify(index))
    if (tables[table] !== undefined) tables[table].indexed = true
  }

  const manifest = {
    buildNumber: version.buildNumber,
    releaseDate: version.releaseDate,
    generatedAt: new Date().toISOString(),
    tables,
  }
  writeFileSync(join(versionDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2))
  return manifest
}

export function buildManifest(dataRoot, options = {}) {
  const { current, all } = findVersionDirs(dataRoot)
  const manifest = buildManifestForVersionDir(current, options)

  return {
    versionDir: current,
    buildNumber: manifest.buildNumber,
    tableCount: Object.keys(manifest.tables).length,
    indexed: Object.entries(manifest.tables).filter(([, stats]) => stats.indexed === true).map(([name]) => name),
    totalBytes: Object.values(manifest.tables).reduce((sum, stats) => sum + stats.sizeBytes, 0),
    versionDirs: all,
  }
}

function main() {
  const args = process.argv.slice(2)
  const rootFlag = args.indexOf('--root')
  const dataRoot = rootFlag >= 0 ? args[rootFlag + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
  const indexFlag = args.indexOf('--index')
  const indexTables = indexFlag >= 0
    ? args[indexFlag + 1].split(',').map((name) => name.trim()).filter(Boolean)
    : DEFAULT_INDEX_TABLES
  const summary = buildManifest(dataRoot, { indexTables })
  console.log(`manifest built for build ${summary.buildNumber}: ${summary.tableCount} tables, ${summary.totalBytes} bytes`)
  console.log(`indexed: ${summary.indexed.join(', ') || '(none)'}`)
  console.log(`version dirs: ${summary.versionDirs.join(', ')}`)
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
