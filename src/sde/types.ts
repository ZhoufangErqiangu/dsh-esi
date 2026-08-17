/**
 * SDE (Static Data Export) types: manifest, status, and query contracts.
 */

/** The single-line `_sde.jsonl` version record inside each version directory. */
export interface SdeVersionRecord {
  readonly _key: string
  readonly buildNumber: number
  readonly releaseDate: string
}

/** Per-table statistics recorded in the generated manifest. */
export interface SdeTableStats {
  readonly rows: number
  readonly sha256: string
  readonly sizeBytes: number
  /** True when a byte-offset index was built for this table. */
  readonly indexed: boolean
}

/** `manifest.json` inside a version directory. */
export interface SdeManifest {
  readonly buildNumber: number
  readonly releaseDate: string
  readonly generatedAt: string
  readonly tables: Record<string, SdeTableStats>
}

export interface SdeStatus {
  readonly dataRoot: string
  readonly versionDir: string
  readonly buildNumber: number
  readonly releaseDate: string
  readonly tableCount: number
  readonly totalRows: number
  readonly totalBytes: number
  readonly indexedTables: readonly string[]
  readonly manifestPresent: boolean
}

/** Localized-language codes used by the jsonl format. */
export const SDE_LANGUAGES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'] as const

export type SdeLanguage = (typeof SDE_LANGUAGES)[number]

/** Filter operators on a single field. */
export interface SdeFieldFilter {
  readonly gte?: number
  readonly lte?: number
  readonly gt?: number
  readonly lt?: number
  readonly in?: readonly unknown[]
  readonly ne?: unknown
}

export type SdeFilterValue = unknown | SdeFieldFilter

export interface SdeQueryOptions {
  /** Table name as it appears in the manifest, e.g. `types`, `mapSolarSystems`. */
  table: string
  /** Primary-key lookups (matches `_key`). */
  ids?: readonly (string | number)[]
  /** Exact-match or operator filters on top-level fields. */
  filter?: Record<string, SdeFilterValue>
  /** Case-insensitive text search on the named fields (default: the localized `name`). */
  search?: { text: string; fields?: readonly string[] }
  /** Projection: fields to include per row (default: all). */
  fields?: readonly string[]
  limit?: number
  language?: SdeLanguage
}

export interface SdeQueryResult {
  readonly table: string
  readonly count: number
  readonly rows: readonly Record<string, unknown>[]
  readonly meta: {
    readonly rowsScanned: number
    readonly truncated: boolean
    readonly usedIndex: boolean
    readonly language: SdeLanguage
  }
}
