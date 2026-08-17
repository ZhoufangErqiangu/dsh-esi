/**
 * SDE query service: discovers the current version directory, reads the
 * manifest, and answers table queries.
 *
 * Query strategy keeps memory flat:
 *  - indexed tables (curated hot tables) answer primary-key and name lookups
 *    via byte-offset indexes — no scan, constant reads;
 *  - everything else streams the jsonl line by line, applying filters and
 *    stopping at the limit.
 *
 * Localized objects (`{de,en,es,fr,ja,ko,ru,zh}`) are resolved to the
 * requested language in returned rows.
 */

import { createReadStream, existsSync, readFileSync, readSync, openSync, readdirSync, readlinkSync } from 'node:fs'
import { closeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, join } from 'node:path'
import {
  SDE_LANGUAGES,
  type SdeFilterValue,
  type SdeLanguage,
  type SdeManifest,
  type SdeQueryOptions,
  type SdeQueryResult,
  type SdeStatus,
  type SdeVersionRecord,
} from './types.ts'

const MANIFEST_FILE = 'manifest.json'
const VERSION_FILE = '_sde.jsonl'
const INDEX_DIR = 'indexes'
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 200

/** Byte-offset index: key → [offset, length]; names → keys. */
export interface TableIndex {
  readonly table: string
  readonly entries: Record<string, [number, number]>
  readonly names: Record<string, number[]>
}

export interface SdeServiceOptions {
  dataRoot: string
  defaultLanguage?: SdeLanguage
}

export class SdeService {
  private readonly dataRoot: string
  private readonly defaultLanguage: SdeLanguage

  constructor(options: SdeServiceOptions) {
    this.dataRoot = options.dataRoot
    this.defaultLanguage = options.defaultLanguage ?? 'en'
  }

  /** The current version directory: the `current` symlink, else the only `_sde.jsonl` dir. */
  resolveVersionDir(): string {
    const currentLink = join(this.dataRoot, 'current')
    if (existsSync(currentLink)) {
      const resolved = readlinkSync(currentLink)
      return join(this.dataRoot, resolved)
    }
    const candidates = readdirSync(this.dataRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(this.dataRoot, entry.name))
      .filter((dir) => existsSync(join(dir, VERSION_FILE)))
    if (candidates.length === 1) return candidates[0]!
    if (candidates.length === 0) {
      throw new Error(`no SDE version directory found under ${this.dataRoot} (looking for directories containing ${VERSION_FILE})`)
    }
    throw new Error(
      `multiple SDE version directories found under ${this.dataRoot} and no "current" symlink: `
      + candidates.map((dir) => basename(dir)).join(', '),
    )
  }

  readVersion(versionDir: string): SdeVersionRecord {
    const raw = readFileSync(join(versionDir, VERSION_FILE), 'utf8')
    const record = JSON.parse(raw) as SdeVersionRecord
    if (typeof record.buildNumber !== 'number') {
      throw new Error(`invalid ${VERSION_FILE} in ${versionDir}`)
    }
    return record
  }

  readManifest(versionDir: string): SdeManifest | undefined {
    const path = join(versionDir, MANIFEST_FILE)
    if (!existsSync(path)) return undefined
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as SdeManifest
    } catch {
      return undefined
    }
  }

  status(): SdeStatus {
    const versionDir = this.resolveVersionDir()
    const version = this.readVersion(versionDir)
    const manifest = this.readManifest(versionDir)
    if (manifest === undefined) {
      return {
        dataRoot: this.dataRoot,
        versionDir,
        buildNumber: version.buildNumber,
        releaseDate: version.releaseDate,
        tableCount: 0,
        totalRows: 0,
        totalBytes: 0,
        indexedTables: [],
        manifestPresent: false,
      }
    }
    const tables = Object.entries(manifest.tables)
    return {
      dataRoot: this.dataRoot,
      versionDir,
      buildNumber: manifest.buildNumber,
      releaseDate: manifest.releaseDate,
      tableCount: tables.length,
      totalRows: tables.reduce((sum, [, stats]) => sum + stats.rows, 0),
      totalBytes: tables.reduce((sum, [, stats]) => sum + stats.sizeBytes, 0),
      indexedTables: tables.filter(([, stats]) => stats.indexed).map(([name]) => name),
      manifestPresent: true,
    }
  }

  async query(options: SdeQueryOptions): Promise<SdeQueryResult> {
    const versionDir = this.resolveVersionDir()
    const manifest = this.readManifest(versionDir)
    const table = options.table
    const stats = manifest?.tables[table]
    if (manifest === undefined || stats === undefined) {
      throw new Error(this.unknownTableMessage(manifest, table))
    }
    const language = this.resolveLanguage(options.language)
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const filePath = join(versionDir, `${table}.jsonl`)

    // Indexed fast path: primary-key lookups and name search on indexed tables.
    const index = stats.indexed ? this.readIndex(versionDir, table) : undefined
    if (index !== undefined && this.canUseIndex(options, index)) {
      return this.queryByIndex(filePath, index, options, limit, language)
    }

    return this.scanTable(filePath, options, limit, language)
  }

  private canUseIndex(options: SdeQueryOptions, index: TableIndex): boolean {
    if (options.ids !== undefined && options.ids.length > 0) return true
    if (options.search !== undefined && options.search.text !== '') {
      const fields = options.search.fields ?? ['name']
      // The name index only covers the localized `name` field.
      if (fields.length === 1 && fields[0] === 'name') return true
    }
    return false
  }

  private async queryByIndex(
    filePath: string,
    index: TableIndex,
    options: SdeQueryOptions,
    limit: number,
    language: SdeLanguage,
  ): Promise<SdeQueryResult> {
    const wantedKeys = new Set<string>()
    let rowsScanned = 0
    for (const id of options.ids ?? []) {
      const key = String(id)
      if (index.entries[key] !== undefined) {
        wantedKeys.add(key)
        rowsScanned += 1
      }
    }
    if (options.search !== undefined && options.search.text !== '') {
      const needle = options.search.text.toLowerCase()
      for (const [name, keys] of Object.entries(index.names)) {
        if (name.includes(needle)) {
          for (const key of keys) wantedKeys.add(String(key))
          rowsScanned += keys.length
        }
      }
    }

    const rows = this.readRowsByOffset(filePath, index, wantedKeys)
    const projected = rows
      .filter((row) => this.matchesFilter(row, options.filter))
      .map((row) => this.project(row, options.fields, language))
    const truncated = projected.length > limit
    return {
      table: options.table,
      count: Math.min(projected.length, limit),
      rows: projected.slice(0, limit),
      meta: { rowsScanned, truncated, usedIndex: true, language },
    }
  }

  private readRowsByOffset(filePath: string, index: TableIndex, keys: Set<string>): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = []
    const fd = openSync(filePath, 'r')
    try {
      const buffer = Buffer.alloc(1 << 20)
      for (const key of keys) {
        const location = index.entries[key]
        if (location === undefined) continue
        const [offset, length] = location
        const read = readSync(fd, buffer, 0, length, offset)
        const line = buffer.subarray(0, read).toString('utf8').trim()
        if (line === '') continue
        try {
          const row = JSON.parse(line) as Record<string, unknown>
          rows.push(row)
        } catch {
          // skip malformed line
        }
      }
    } finally {
      closeSync(fd)
    }
    return rows
  }

  private async scanTable(
    filePath: string,
    options: SdeQueryOptions,
    limit: number,
    language: SdeLanguage,
  ): Promise<SdeQueryResult> {
    const rows: Record<string, unknown>[] = []
    let scanned = 0
    let truncated = false

    const input = createReadStream(filePath, { encoding: 'utf8' })
    const rl = createInterface({ input, crlfDelay: Infinity })
    const searchFields = options.search?.fields ?? ['name']
    const needle = options.search?.text?.toLowerCase() ?? ''

    for await (const line of rl) {
      if (line.trim() === '') continue
      scanned += 1
      let row: Record<string, unknown>
      try {
        row = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (!this.matchesFilter(row, options.filter)) continue
      if (needle !== '' && !this.matchesSearch(row, searchFields, needle, language)) continue
      rows.push(this.project(row, options.fields, language))
      if (rows.length >= limit) {
        truncated = true
        break
      }
    }
    return {
      table: options.table,
      count: rows.length,
      rows,
      meta: { rowsScanned: scanned, truncated, usedIndex: false, language },
    }
  }

  private matchesFilter(row: Record<string, unknown>, filter: Record<string, SdeFilterValue> | undefined): boolean {
    if (filter === undefined) return true
    for (const [field, wanted] of Object.entries(filter)) {
      const actual = row[field]
      if (isOperatorFilter(wanted)) {
        if (wanted.gte !== undefined && !(typeof actual === 'number' && actual >= wanted.gte)) return false
        if (wanted.lte !== undefined && !(typeof actual === 'number' && actual <= wanted.lte)) return false
        if (wanted.gt !== undefined && !(typeof actual === 'number' && actual > wanted.gt)) return false
        if (wanted.lt !== undefined && !(typeof actual === 'number' && actual < wanted.lt)) return false
        if (wanted.ne !== undefined && looseEqual(actual, wanted.ne)) return false
        if (wanted.in !== undefined && !wanted.in.some((candidate) => looseEqual(actual, candidate))) return false
      } else if (!looseEqual(actual, wanted)) {
        return false
      }
    }
    return true
  }

  private matchesSearch(
    row: Record<string, unknown>,
    fields: readonly string[],
    needle: string,
    language: SdeLanguage,
  ): boolean {
    for (const field of fields) {
      const value = row[field]
      if (typeof value === 'string' && value.toLowerCase().includes(needle)) return true
      if (isLocalized(value)) {
        const resolved = resolveLocalized(value, language)
        if (resolved.toLowerCase().includes(needle)) return true
      }
      if (typeof value === 'number' && String(value).includes(needle)) return true
    }
    return false
  }

  /** Project fields and resolve localized objects to the requested language. */
  private project(row: Record<string, unknown>, fields: readonly string[] | undefined, language: SdeLanguage): Record<string, unknown> {
    const source = fields !== undefined && fields.length > 0
      ? Object.fromEntries(fields.map((field) => [field, row[field]]))
      : row
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      out[key] = typeof value === 'object' && value !== null && isLocalized(value)
        ? resolveLocalized(value, language)
        : value
    }
    return out
  }

  private resolveLanguage(language: SdeLanguage | undefined): SdeLanguage {
    const candidate = language ?? this.defaultLanguage
    return (SDE_LANGUAGES as readonly string[]).includes(candidate) ? candidate : 'en'
  }

  private readIndex(versionDir: string, table: string): TableIndex | undefined {
    const path = join(versionDir, INDEX_DIR, `${table}.json`)
    if (!existsSync(path)) return undefined
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as TableIndex
    } catch {
      return undefined
    }
  }

  private unknownTableMessage(manifest: SdeManifest | undefined, table: string): string {
    if (manifest === undefined) {
      return `SDE manifest missing in the current version directory — run scripts/build-manifest.mjs (or sde_update) first`
    }
    const names = Object.keys(manifest.tables)
    const preview = names.slice(0, 10).join(', ')
    return `unknown SDE table "${table}" — ${names.length} tables available, e.g. ${preview}${names.length > 10 ? ', …' : ''}`
  }
}

function isOperatorFilter(value: unknown): value is { gte?: number; lte?: number; gt?: number; lt?: number; in?: unknown[]; ne?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && ['gte', 'lte', 'gt', 'lt', 'in', 'ne'].some((key) => Object.hasOwn(value, key))
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b)
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b
  return false
}

export function isLocalized(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0) return false
  return keys.every((key) => (SDE_LANGUAGES as readonly string[]).includes(key) && typeof record[key] === 'string')
}

export function resolveLocalized(value: Record<string, string>, language: SdeLanguage): string {
  return value[language] ?? value.en ?? Object.values(value)[0] ?? ''
}
