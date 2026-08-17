#!/usr/bin/env node
/**
 * Build `manifest.json` and the derived SQLite store (`sde.db`) inside the
 * current SDE version directory. Pure Node (uses node:sqlite), no other deps.
 *
 *   node scripts/build-manifest.mjs [--root <dataRoot>] [--index a,b,c]
 *
 * The manifest records per-table row counts / sha256 / sizes (used by
 * sde_status and as the update-diff baseline); sde.db backs all sde_query
 * lookups (indexed id / name / numeric columns, json_extract fallback).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSdeDb } from '../src/sde/db-build.ts'

const VERSION_FILE = '_sde.jsonl'
const MANIFEST_FILE = 'manifest.json'

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

/** Scan one jsonl file: row count, sha256, size (for the manifest). */
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

/** Build manifest + indexes for one explicit version directory. */
export function buildManifestForVersionDir(versionDir, options = {}) {
  const buildDb = options.buildDb ?? true

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

  const manifest = {
    buildNumber: version.buildNumber,
    releaseDate: version.releaseDate,
    generatedAt: new Date().toISOString(),
    tables,
  }
  writeFileSync(join(versionDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2))

  if (buildDb) {
    buildSdeDb(versionDir, Object.keys(tables))
  }
  return manifest
}

export function buildManifest(dataRoot, options = {}) {
  const { current, all } = findVersionDirs(dataRoot)
  const manifest = buildManifestForVersionDir(current, options)

  return {
    versionDir: current,
    buildNumber: manifest.buildNumber,
    tableCount: Object.keys(manifest.tables).length,
    totalBytes: Object.values(manifest.tables).reduce((sum, stats) => sum + stats.sizeBytes, 0),
    versionDirs: all,
  }
}

function main() {
  const args = process.argv.slice(2)
  const rootFlag = args.indexOf('--root')
  const dataRoot = rootFlag >= 0 ? args[rootFlag + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
  const summary = buildManifest(dataRoot)
  console.log(`manifest + sde.db built for build ${summary.buildNumber}: ${summary.tableCount} tables, ${summary.totalBytes} bytes`)
  console.log(`version dirs: ${summary.versionDirs.join(', ')}`)
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
