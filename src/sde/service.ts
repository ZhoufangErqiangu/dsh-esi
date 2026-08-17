/**
 * SDE query service: discovers the current version directory, reads the
 * manifest, and answers table queries against the derived SQLite store
 * (`sde.db`, built by scripts/build-manifest.mjs / the update pipeline).
 *
 * The model-facing query API stays structured (ids / filter / search /
 * fields / limit / language); this module translates it to SQL:
 *  - primary keys → the indexed `id` column;
 *  - promoted numeric fields → typed columns (range operators);
 *  - the localized `name` → `name_<lang>` columns (search uses the query
 *    language);
 *  - anything else → `json_extract(row, '$.field')` over the original row.
 *
 * Localized objects are resolved to the requested language in returned rows.
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
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
import { SDE_DB_FILE } from './db-build.ts'

const MANIFEST_FILE = 'manifest.json'
const VERSION_FILE = '_sde.jsonl'
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 200

export interface SdeServiceOptions {
  dataRoot: string
  defaultLanguage?: SdeLanguage
}

interface WherePiece {
  sql: string
  params: (string | number | null)[]
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
        dbPresent: false,
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
      dbPresent: existsSync(join(versionDir, SDE_DB_FILE)),
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
    const dbPath = join(versionDir, SDE_DB_FILE)
    if (!existsSync(dbPath)) {
      throw new Error(
        `SDE store missing (${SDE_DB_FILE}) in ${versionDir} — run scripts/build-manifest.mjs or sde_update first`,
      )
    }
    const language = this.resolveLanguage(options.language)
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[]).map((column) => column.name),
      )
      const where = this.buildWhere(table, columns, options, language)
      const sql = `SELECT "row" FROM ${quote(table)} ${where.sql} LIMIT ${limit + 1}`
      const statement = db.prepare(sql)
      const rows = statement.all(...where.params) as { row: string }[]
      const truncated = rows.length > limit
      const kept = rows.slice(0, limit)
      const projected = kept.map((entry) => {
        const row = JSON.parse(entry.row) as Record<string, unknown>
        return this.project(row, options.fields, language)
      })
      return {
        table,
        count: projected.length,
        rows: projected,
        meta: { engine: 'sqlite', truncated, language },
      }
    } finally {
      db.close()
    }
  }

  // ---- SQL translation -----------------------------------------------------

  private buildWhere(table: string, columns: ReadonlySet<string>, options: SdeQueryOptions, language: SdeLanguage): WherePiece {
    const clauses: string[] = []
    const params: (string | number | null)[] = []

    const ids = options.ids ?? []
    if (ids.length > 0) {
      clauses.push(`"id" IN (${ids.map(() => '?').join(', ')})`)
      params.push(...ids.map((id) => String(id)))
    }

    for (const [field, wanted] of Object.entries(options.filter ?? {})) {
      const { sql, params: pieceParams } = this.fieldCondition(columns, field, wanted, language)
      clauses.push(sql)
      params.push(...pieceParams)
    }

    if (options.search !== undefined && options.search.text !== '') {
      const fields = options.search.fields ?? ['name']
      const needle = escapeLike(options.search.text)
      const orClauses: string[] = []
      for (const field of fields) {
        const column = this.searchColumn(columns, field, language)
        orClauses.push(`${column} LIKE ? ESCAPE '\\'`)
        params.push(`%${needle}%`)
      }
      clauses.push(`(${orClauses.join(' OR ')})`)
    }

    return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params }
  }

  private fieldCondition(
    columns: ReadonlySet<string>,
    field: string,
    wanted: SdeFilterValue,
    language: SdeLanguage,
  ): WherePiece {
    const q = this.columnFor(columns, field, language)
    if (isOperatorFilter(wanted)) {
      const pieces: string[] = []
      const params: (string | number | null)[] = []
      if (wanted.gte !== undefined) { pieces.push(`${q} >= ?`); params.push(wanted.gte) }
      if (wanted.lte !== undefined) { pieces.push(`${q} <= ?`); params.push(wanted.lte) }
      if (wanted.gt !== undefined) { pieces.push(`${q} > ?`); params.push(wanted.gt) }
      if (wanted.lt !== undefined) { pieces.push(`${q} < ?`); params.push(wanted.lt) }
      if (wanted.ne !== undefined) { pieces.push(`${q} != ?`); params.push(sqlValue(wanted.ne)) }
      if (wanted.in !== undefined) {
        pieces.push(`${q} IN (${wanted.in.map(() => '?').join(', ')})`)
        params.push(...wanted.in.map((value) => sqlValue(value)))
      }
      return { sql: pieces.join(' AND '), params }
    }
    return { sql: `${q} = ?`, params: [sqlValue(wanted)] }
  }

  /** Resolve a filter field to a queryable SQL expression. */
  private columnFor(columns: ReadonlySet<string>, field: string, language: SdeLanguage): string {
    if (field === '_key' || field === 'id') return '"id"'
    if (field === 'name') return this.nameColumn(columns, language)
    // Tolerate snake_case spellings of the SDE's camelCase keys (category_id → categoryID).
    const sqlField = fieldCandidates(field).find((candidate) => columns.has(candidate)) ?? snakeToCamel(field)
    if (columns.has(sqlField)) return quote(sqlField)
    return `json_extract("row", '$.${sqlField.replaceAll("'", "''")}')`
  }

  /** Resolve a search field to a LIKE-able column. */
  private searchColumn(columns: ReadonlySet<string>, field: string, language: SdeLanguage): string {
    if (field === 'name' || field === '_key' || field === 'id') return this.nameColumn(columns, language)
    const sqlField = fieldCandidates(field).find((candidate) => columns.has(candidate)) ?? snakeToCamel(field)
    if (columns.has(sqlField)) return quote(sqlField)
    return `json_extract("row", '$.${sqlField.replaceAll("'", "''")}')`
  }

  private nameColumn(columns: ReadonlySet<string>, language: SdeLanguage): string {
    if (columns.has(`name_${language}`)) return quote(`name_${language}`)
    if (columns.has('name')) return quote('name')
    // No name column at all: search matches nothing meaningful.
    return `''`
  }

  // ---- row post-processing ---------------------------------------------------

  /**
   * Resolve a user-facing field name to a value in the raw jsonl row.
   * Tolerates the SQL-style snake_case spelling (`group_id`, `packaged_volume`)
   * for the SDE's camelCase keys (`groupID`, `packagedVolume`), and maps the
   * primary-key aliases `id`/`_key` to the raw `_key`. Returns `undefined`
   * when the field does not exist in the row.
   */
  private rawField(row: Record<string, unknown>, field: string): unknown {
    if (field === 'id' || field === '_key') return row._key
    for (const candidate of fieldCandidates(field)) {
      const value = row[candidate]
      if (value !== undefined) return value
    }
    return undefined
  }

  private project(row: Record<string, unknown>, fields: readonly string[] | undefined, language: SdeLanguage): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const keys = fields !== undefined && fields.length > 0 ? fields : Object.keys(row)
    for (const field of keys) {
      const value = this.rawField(row, field)
      // Unknown fields are skipped, never emitted as `undefined`: a property
      // with an undefined value breaks JSON round-trip losslessness (the tools
      // runtime rejects such output as "not lossless JSON").
      if (value === undefined) continue
      out[field] = typeof value === 'object' && value !== null && isLocalized(value)
        ? resolveLocalized(value, language)
        : value
    }
    return out
  }

  private resolveLanguage(language: SdeLanguage | undefined): SdeLanguage {
    const candidate = language ?? this.defaultLanguage
    return (SDE_LANGUAGES as readonly string[]).includes(candidate) ? candidate : 'en'
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

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/** snake_case → lowerCamelCase: `group_id` → `groupId`, `packaged_volume` → `packagedVolume`. */
function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

/**
 * Candidate spellings for a user-facing field name, most specific first.
 * The SDE keeps identifier acronyms uppercase (`categoryID`, `raceID`), which a
 * plain snake→camel conversion cannot recover (`category_id` → `categoryId`),
 * so the `Id`-suffix variant is added explicitly.
 */
function fieldCandidates(name: string): string[] {
  const camel = snakeToCamel(name)
  const candidates = [name, camel]
  if (camel.endsWith('Id')) candidates.push(`${camel.slice(0, -2)}ID`)
  return candidates
}

function isOperatorFilter(value: unknown): value is { gte?: number; lte?: number; gt?: number; lt?: number; in?: unknown[]; ne?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && ['gte', 'lte', 'gt', 'lt', 'in', 'ne'].some((key) => Object.hasOwn(value, key))
}

/** Bind a filter value: strings compare as themselves (json_extract decodes). */
function sqlValue(value: unknown): string | number | null {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'number') return value
  return JSON.stringify(value)
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&')
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
