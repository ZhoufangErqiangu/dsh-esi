/**
 * Build the derived SQLite read store (`sde.db`) for one SDE version directory.
 *
 * The jsonl files remain the canonical source (update deltas, checksums, and
 * human inspection all work on them); `sde.db` is a rebuildable read-side
 * projection that gives `sde_query` real indexed lookups, filters, and search
 * instead of streaming scans.
 *
 * Schema per table:
 *  - `id`            PRIMARY KEY (INTEGER when all `_key`s are integers)
 *  - `name_<lang>`   localized name columns (de/en/es/fr/ja/ko/ru/zh)
 *  - numeric scalar top-level fields as typed columns (range filters)
 *  - `row`           the original jsonl line, for projection/language fidelity
 * Filters on non-promoted fields fall back to `json_extract(row, ...)`.
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SDE_LANGUAGES } from './types.ts'

export const SDE_DB_FILE = 'sde.db'

const LANGUAGES = SDE_LANGUAGES as readonly string[]
/** Max promoted numeric columns per table (keeps INSERT/DDL compact). */
const MAX_NUMERIC_COLUMNS = 40
/** Fraction of rows that must carry a numeric field for it to be promoted. */
const NUMERIC_PROMOTE_FRACTION = 0.05

interface NumericColumn {
  name: string
  type: 'INTEGER' | 'REAL'
}

interface TableSchema {
  table: string
  idType: 'INTEGER' | 'TEXT'
  numeric: NumericColumn[]
  hasLocalizedName: boolean
}

/** Infer the schema for one table from its parsed rows. */
function inferSchema(table: string, rows: readonly Record<string, unknown>[]): TableSchema {
  const numericCounts = new Map<string, { int: number; real: number }>()
  const numericTypes = new Map<string, 'INTEGER' | 'REAL'>()
  let allIntegerKeys = rows.length > 0
  let hasLocalizedName = false

  for (const row of rows) {
    const key = row._key
    if (typeof key !== 'number' || !Number.isInteger(key)) allIntegerKeys = false
    if (typeof row.name === 'object' && row.name !== null && !Array.isArray(row.name)) {
      const name = row.name as Record<string, unknown>
      if (LANGUAGES.some((lang) => typeof name[lang] === 'string')) hasLocalizedName = true
    }
    for (const [field, value] of Object.entries(row)) {
      if (field === '_key' || field === 'name') continue
      if (typeof value === 'boolean' || typeof value === 'number') {
        const count = numericCounts.get(field) ?? { int: 0, real: 0 }
        if (typeof value === 'boolean' || Number.isInteger(value)) count.int += 1
        else count.real += 1
        numericCounts.set(field, count)
        numericTypes.set(field, count.real > 0 ? 'REAL' : 'INTEGER')
      }
    }
  }

  const threshold = Math.max(1, Math.floor(rows.length * NUMERIC_PROMOTE_FRACTION))
  const numeric: NumericColumn[] = [...numericCounts.entries()]
    .filter(([, count]) => count.int + count.real >= threshold)
    .sort((a, b) => (b[1].int + b[1].real) - (a[1].int + a[1].real))
    .slice(0, MAX_NUMERIC_COLUMNS)
    .map(([name]) => ({ name, type: numericTypes.get(name) === 'REAL' ? 'REAL' as const : 'INTEGER' as const }))

  return { table, idType: allIntegerKeys ? 'INTEGER' : 'TEXT', numeric, hasLocalizedName }
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Build (or rebuild) `sde.db` inside `versionDir` from its jsonl tables.
 * Returns the list of tables written and the DB byte size.
 */
export function buildSdeDb(versionDir: string, tableNames: readonly string[]): { tables: number; sizeBytes: number } {
  const dbPath = join(versionDir, SDE_DB_FILE)
  const db = new DatabaseSync(dbPath)
  try {
    for (const table of tableNames) {
      const file = join(versionDir, `${table}.jsonl`)
      const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
      const rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      const schema = inferSchema(table, rows)

      db.exec(`DROP TABLE IF EXISTS ${quoted(table)}`)
      const nameColumns = schema.hasLocalizedName
        ? LANGUAGES.map((lang) => `${quoted(`name_${lang}`)} TEXT`).join(', ')
        : `"name" TEXT`
      db.exec(`CREATE TABLE ${quoted(table)} (
        "id" ${schema.idType} PRIMARY KEY,
        ${nameColumns},
        ${schema.numeric.map((column) => `${quoted(column.name)} ${column.type}`).join(', ')}
        ${schema.numeric.length > 0 ? ',' : ''}
        "row" TEXT NOT NULL
      )`)

      const insertColumns = [
        'id',
        ...(schema.hasLocalizedName ? LANGUAGES.map((lang) => `name_${lang}`) : ['name']),
        ...schema.numeric.map((column) => column.name),
        'row',
      ]
      const placeholders = insertColumns.map(() => '?').join(', ')
      const insert = db.prepare(`INSERT INTO ${quoted(table)} (${insertColumns.map(quoted).join(', ')}) VALUES (${placeholders})`)

      db.exec('BEGIN')
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!
        const line = lines[i]!
        const params: (string | number | null)[] = [String(row._key)]
        if (schema.hasLocalizedName) {
          const name = row.name as Record<string, string> | undefined
          for (const lang of LANGUAGES) params.push(name?.[lang] ?? null)
        } else {
          params.push(typeof row.name === 'string' ? row.name : null)
        }
        for (const column of schema.numeric) {
          const value = row[column.name]
          params.push(typeof value === 'boolean' ? (value ? 1 : 0) : (typeof value === 'number' ? value : null))
        }
        params.push(line)
        insert.run(...params)
      }
      db.exec('COMMIT')

      // Name search index; range filters benefit from numeric indexes.
      const nameIndex = schema.hasLocalizedName ? `name_${LANGUAGES[1]}` : 'name'
      db.exec(`CREATE INDEX IF NOT EXISTS ${quoted(`idx_${table}_name`)} ON ${quoted(table)} (${quoted(nameIndex)})`)
      for (const column of schema.numeric) {
        db.exec(`CREATE INDEX IF NOT EXISTS ${quoted(`idx_${table}_${column.name}`)} ON ${quoted(table)} (${quoted(column.name)})`)
      }
    }
  } finally {
    db.close()
  }
  return { tables: tableNames.length, sizeBytes: statSync(dbPath).size }
}
