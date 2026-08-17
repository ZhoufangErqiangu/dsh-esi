/** Type declarations for the pure-Node build-manifest script consumed by src. */
export function buildManifestForVersionDir(
  versionDir: string,
  options?: { indexTables?: readonly string[] },
): {
  buildNumber: number
  releaseDate: string
  generatedAt: string
  tables: Record<string, { rows: number; sha256: string; sizeBytes: number; indexed?: boolean }>
}
export function buildManifest(
  dataRoot: string,
  options?: { indexTables?: readonly string[] },
): {
  versionDir: string
  buildNumber: number
  tableCount: number
  indexed: string[]
  totalBytes: number
  versionDirs: string[]
}
export const DEFAULT_INDEX_TABLES: readonly string[]
export function scanTable(filePath: string): { rows: number; sha256: string; sizeBytes: number }
export function buildIndex(filePath: string): { table: string; entries: Record<string, [number, number]>; names: Record<string, number[]> }
export function findVersionDirs(dataRoot: string): { current: string; all: string[] }
