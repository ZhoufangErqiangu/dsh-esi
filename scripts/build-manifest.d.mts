/** Type declarations for the pure-Node build-manifest script consumed by src. */
export function buildManifestForVersionDir(
  versionDir: string,
  options?: { buildDb?: boolean },
): {
  buildNumber: number
  releaseDate: string
  generatedAt: string
  tables: Record<string, { rows: number; sha256: string; sizeBytes: number }>
}
export function buildManifest(
  dataRoot: string,
  options?: { buildDb?: boolean },
): {
  versionDir: string
  buildNumber: number
  tableCount: number
  totalBytes: number
  versionDirs: string[]
}
export function scanTable(filePath: string): { rows: number; sha256: string; sizeBytes: number }
export function findVersionDirs(dataRoot: string): { current: string; all: string[] }
