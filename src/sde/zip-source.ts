/**
 * URL-driven SDE source: download a zip archive (the jsonl+manifest mirror
 * layout, see README) from an arbitrary user-supplied http(s) URL, verify it,
 * extract it safely, and install it as a new SDE version directory.
 *
 * Robustness contract (the GUI card feeds user-typed URLs here):
 * - Input validation: only http/https absolute URLs; everything else
 *   (relative paths, local paths, file://, ftp://, garbage) is a typed error.
 * - Network failures: connect errors, DNS, timeouts (overall + idle), HTTP
 *   statuses, and mid-stream drops are classified; transient failures are
 *   retried with backoff; 4xx is not.
 * - Archive safety: zip magic check, fflate integrity (CRC/central directory),
 *   zip-slip path guard, entry-count and extracted-size caps (zip bombs).
 * - Payload validation: manifest.json must exist and carry a valid
 *   buildNumber + non-empty tables; every listed table must have its .jsonl.
 * - Atomic install: extraction happens in a staging dir; the old version
 *   stays live until the staging dir is renamed into place; a same-content
 *   re-download reuses the existing version dir.
 * - Disk failures: ENOSPC/EACCES surface as typed errors; staging is always
 *   cleaned up.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { unzipSync } from 'fflate'
import type { EsiaAbortSignal } from '../esia-client.ts'
import type { SdeManifest } from './types.ts'

/**
 * Typed failure of a URL-driven SDE update. `code` is stable and doubles as
 * the card's i18n key (the browser maps code → dictionary key and translates
 * `params` into the localized template); `message` is the raw fallback text
 * (zh) shown when the code is unknown to the client or outside the GUI.
 */
export class SdeZipError extends Error {
  readonly code: string
  /** HTTP status when the failure came from an HTTP response. */
  readonly status?: number
  /** Interpolation params for the code-keyed translation (`{name}` placeholders). */
  readonly params?: Readonly<Record<string, string | number>>
  /** Lower-level cause, when one exists (kept out of the user-facing message). */
  readonly cause?: unknown

  constructor(code: string, message: string, options: { status?: number; params?: Record<string, string | number>; cause?: unknown } = {}) {
    super(message)
    this.name = 'SdeZipError'
    this.code = code
    this.status = options.status
    this.params = options.params
    this.cause = options.cause
  }
}

/** One progress tick of a download. `total`/`percent` are absent when the server sends no Content-Length. */
export interface ZipDownloadProgress {
  readonly bytes: number
  readonly total: number | undefined
  readonly percent: number | undefined
}

export interface ZipSourceOptions {
  /** Custom transport (tests); defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Overall download deadline (default 10 min). */
  timeoutMs?: number
  /** Idle read timeout — no chunk for this long aborts (default 30 s). */
  idleMs?: number
  /** Transient-failure retries (default 2, i.e. up to 3 attempts). */
  retries?: number
  /** Hard cap on the downloaded archive size (default 2 GiB). */
  maxBytes?: number
  /** Hard cap on total extracted bytes — zip-bomb guard (default 4 GiB). */
  maxExtractedBytes?: number
  /** Download progress callback (throttled by the caller if needed). */
  onProgress?: (progress: ZipDownloadProgress) => void
}

export const DEFAULT_ZIP_OPTIONS: Required<Omit<ZipSourceOptions, 'fetchImpl' | 'onProgress'>> = {
  timeoutMs: 10 * 60 * 1000,
  idleMs: 30 * 1000,
  retries: 2,
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxExtractedBytes: 4 * 1024 * 1024 * 1024,
}

const MAX_URL_LENGTH = 2048
const MAX_ENTRY_COUNT = 5000
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] // PK\x03\x04
/** Build-number pattern found in mirror filenames like sde-20240731-TRANQUILITY.zip. */
const BUILD_IN_FILENAME = /(?:^|\D)(\d{8})(?:\D|$)/

/** A real HTTP error for a typed 4xx/5xx response. */
export class HttpStatusError extends SdeZipError {
  constructor(status: number) {
    super('HTTP_ERROR', `下载失败：服务器返回 HTTP ${status}`, { status, params: { status } })
  }
}

/**
 * Validate a user-typed download URL. Throws {@link SdeZipError} with a
 * user-facing message for anything that is not an absolute http(s) URL.
 */
export function validateSdeUrl(rawInput: string): URL {
  const raw = rawInput.trim()
  if (raw.length === 0) {
    throw new SdeZipError('URL_EMPTY', '请输入下载地址')
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new SdeZipError('URL_TOO_LONG', `下载地址过长（超过 ${MAX_URL_LENGTH} 字符）`, { params: { max: MAX_URL_LENGTH } })
  }
  if (/[\u0000-\u001f]/.test(raw)) {
    throw new SdeZipError('URL_CONTROL_CHAR', '下载地址包含非法控制字符')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SdeZipError('URL_MALFORMED', `“${truncate(raw, 40)}”不是有效的 URL；请输入完整的 http(s) 下载地址`, { params: { url: truncate(raw, 40) } })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SdeZipError(
      'URL_SCHEME',
      `仅支持 http/https 下载地址（收到 ${url.protocol.replace(':', '')}://）；请使用以 https:// 开头的完整地址`,
      { params: { scheme: url.protocol.replace(':', '') } },
    )
  }
  if (url.hostname.length === 0) {
    throw new SdeZipError('URL_NO_HOST', '下载地址缺少主机名')
  }
  return url
}

/** Best-effort build-number estimate from a mirror filename (advisory only). */
export function estimateBuildFromUrl(url: URL): number | undefined {
  const name = basename(url.pathname)
  const match = BUILD_IN_FILENAME.exec(name)
  if (match?.[1] === undefined) return undefined
  const digits = Number(match[1])
  return Number.isFinite(digits) && digits > 0 ? digits : undefined
}

/** Result of {@link ZipSdeSource.downloadToStaging}. */
export interface ZipStagingResult {
  /** Staging directory holding the complete, validated payload (renamed away by the caller or cleaned on failure). */
  readonly stagingDir: string
  readonly buildNumber: number
  readonly manifest: SdeManifest
  readonly bytesDownloaded: number
}

/**
 * Download + verify + safely extract an SDE mirror zip into a staging
 * directory inside `dataRoot` (same filesystem, so the caller can atomically
 * rename it into place). The payload is validated before the staging dir is
 * handed back: manifest.json parses, buildNumber is valid, tables are
 * non-empty, and every listed table has its .jsonl file.
 */
export class ZipSdeSource {
  readonly url: URL
  private readonly options: Required<Omit<ZipSourceOptions, 'fetchImpl' | 'onProgress'>> & ZipSourceOptions

  constructor(rawUrl: string, options: ZipSourceOptions = {}) {
    this.url = validateSdeUrl(rawUrl)
    this.options = { ...DEFAULT_ZIP_OPTIONS, ...options }
  }

  /** HEAD the URL to check reachability and size without downloading. */
  async probe(signal?: EsiaAbortSignal): Promise<{ buildNumber: number | undefined; estimatedBytes: number | undefined }> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(this.url.href, { method: 'HEAD', signal: signal as AbortSignal | undefined })
    } catch (error) {
      throw classifyNetworkError(error, '无法连接下载服务器')
    }
    if (!response.ok) {
      if (response.status === 404) {
        throw new SdeZipError('HTTP_404', `下载地址不存在（HTTP 404）`, { status: 404 })
      }
      if (response.status === 403) {
        throw new SdeZipError('HTTP_403', '下载被拒绝（HTTP 403，服务器可能未公开该文件）', { status: 403 })
      }
      throw new HttpStatusError(response.status)
    }
    const lengthHeader = response.headers.get('content-length')
    const estimatedBytes = lengthHeader === null ? undefined : Number(lengthHeader)
    return {
      buildNumber: estimateBuildFromUrl(this.url),
      estimatedBytes: estimatedBytes !== undefined && Number.isFinite(estimatedBytes) ? estimatedBytes : undefined,
    }
  }

  /**
   * Download the archive, verify and extract it into a staging dir, and
   * validate the payload. Retries transient network failures internally.
   * `extra.onProgress` overrides the constructor-level callback for this call.
   */
  async downloadToStaging(
    dataRoot: string,
    signal?: EsiaAbortSignal,
    extra: { onProgress?: (progress: ZipDownloadProgress) => void } = {},
  ): Promise<ZipStagingResult> {
    const bytes = await this.downloadArchive(signal, extra.onProgress)
    const stagingDir = createStagingDir(dataRoot)
    try {
      const files = extractZip(bytes, stagingDir, this.options.maxExtractedBytes ?? DEFAULT_ZIP_OPTIONS.maxExtractedBytes)
      const manifest = validatePayload(stagingDir, files)
      ensureVersionRecord(stagingDir, manifest)
      return { stagingDir, buildNumber: manifest.buildNumber, manifest, bytesDownloaded: bytes.byteLength }
    } catch (error) {
      rmSync(stagingDir, { recursive: true, force: true })
      throw error
    }
  }

  /** Download the archive bytes with retries, timeouts, progress, and size guards. */
  private async downloadArchive(signal?: EsiaAbortSignal, onProgress?: (progress: ZipDownloadProgress) => void): Promise<Uint8Array> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const maxBytes = this.options.maxBytes ?? DEFAULT_ZIP_OPTIONS.maxBytes
    const retries = this.options.retries ?? DEFAULT_ZIP_OPTIONS.retries
    const report = onProgress ?? this.options.onProgress

    let attempt = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const controller = new AbortController()
      const external = signal
      const onExternalAbort = () => controller.abort()
      external?.addEventListener('abort', onExternalAbort)

      const overall = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? DEFAULT_ZIP_OPTIONS.timeoutMs,
      )
      let idle: ReturnType<typeof setTimeout> | undefined
      const resetIdle = () => {
        if (idle !== undefined) clearTimeout(idle)
        idle = setTimeout(
          () => controller.abort(),
          this.options.idleMs ?? DEFAULT_ZIP_OPTIONS.idleMs,
        )
      }

      try {
        let response: Response
        try {
          response = await fetchImpl(this.url.href, { signal: controller.signal, redirect: 'follow' })
        } catch (error) {
          if (controller.signal.aborted) throw classifyTimeout(error)
          throw classifyNetworkError(error, '无法连接下载服务器')
        }
        if (!response.ok) {
          if (retryableStatus(response.status) && attempt < retries) {
            attempt += 1
            await backoff(attempt - 1)
            continue
          }
          throw new HttpStatusError(response.status)
        }

        const lengthHeader = response.headers.get('content-length')
        const total = lengthHeader === null ? undefined : Number(lengthHeader)
        if (total !== undefined && Number.isFinite(total) && total > maxBytes) {
          throw new SdeZipError('TOO_LARGE', `文件过大（${formatBytes(total)}，上限 ${formatBytes(maxBytes)}）`, { params: { size: formatBytes(total), max: formatBytes(maxBytes) } })
        }
        if (response.body === null) {
          throw new SdeZipError('DOWNLOAD_EMPTY', '下载响应没有内容')
        }

        const chunks: Uint8Array[] = []
        let received = 0
        resetIdle()
        try {
          const reader = response.body.getReader()
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            resetIdle()
            received += value.byteLength
            if (received > maxBytes) {
              controller.abort()
              throw new SdeZipError('TOO_LARGE_STREAM', `文件过大（超过 ${formatBytes(maxBytes)}）`, { params: { max: formatBytes(maxBytes) } })
            }
            chunks.push(value)
            report?.({
              bytes: received,
              total,
              percent: total !== undefined && total > 0 ? Math.min(1, received / total) : undefined,
            })
          }
        } catch (error) {
          if (controller.signal.aborted && !external?.aborted) throw classifyTimeout(error)
          if (external?.aborted) throw new SdeZipError('DOWNLOAD_ABORTED', '下载已取消')
          throw classifyNetworkError(error, '下载中断')
        }

        const joined = new Uint8Array(received)
        let offset = 0
        for (const chunk of chunks) {
          joined.set(chunk, offset)
          offset += chunk.byteLength
        }
        report?.({
          bytes: received,
          total,
          percent: total !== undefined && total > 0 ? Math.min(1, received / total) : undefined,
        })
        return joined
      } catch (error) {
        if (error instanceof SdeZipError && retryableSdeError(error) && attempt < retries) {
          attempt += 1
          await backoff(attempt - 1)
          continue
        }
        throw error
      } finally {
        clearTimeout(overall)
        if (idle !== undefined) clearTimeout(idle)
        external?.removeEventListener('abort', onExternalAbort)
      }
    }
  }

}

// ---- helpers ---------------------------------------------------------------

function createStagingDir(dataRoot: string): string {
  mkdirSync(dataRoot, { recursive: true })
  const staging = join(dataRoot, `.staging-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`)
  mkdirSync(staging, { recursive: true })
  return staging
}

/**
 * Extract a verified zip into `dir`, guarding against zip-slip and bombs.
 * @returns the extracted file names (normalized, no leading slash).
 */
function extractZip(bytes: Uint8Array, dir: string, maxExtractedBytes: number): string[] {
  if (bytes.byteLength < 4 || bytes[0] !== ZIP_MAGIC[0] || bytes[1] !== ZIP_MAGIC[1]
    || bytes[2] !== ZIP_MAGIC[2] || bytes[3] !== ZIP_MAGIC[3]) {
    throw new SdeZipError('ZIP_BAD_MAGIC', '下载的文件不是有效的 zip 压缩包（文件头不正确）')
  }
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (error) {
    throw new SdeZipError(
      'ZIP_CORRUPT',
      '压缩包已损坏或不是有效的 zip（解压失败）；可能是下载不完整或文件格式不符',
      { cause: error },
    )
  }
  const names = Object.keys(entries)
  if (names.length === 0) {
    throw new SdeZipError('ZIP_EMPTY', '压缩包是空的')
  }
  if (names.length > MAX_ENTRY_COUNT) {
    throw new SdeZipError('ZIP_BOMB', `压缩包条目过多（${names.length}，上限 ${MAX_ENTRY_COUNT}）`, { params: { count: names.length, max: MAX_ENTRY_COUNT } })
  }

  let totalExtracted = 0
  for (const rawName of names) {
    const name = safeEntryPath(rawName)
    const content = entries[rawName]
    if (content === undefined) continue
    totalExtracted += content.byteLength
    if (totalExtracted > maxExtractedBytes) {
      throw new SdeZipError('ZIP_BOMB_SIZE', `解压后内容过大（超过 ${formatBytes(maxExtractedBytes)}）`, { params: { max: formatBytes(maxExtractedBytes) } })
    }
    const target = join(dir, ...name.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    try {
      writeFileSync(target, content)
    } catch (error) {
      throw mapFsError(error, `无法写入解压文件 ${name}`)
    }
  }
  return Object.keys(entries)
}

/** Reject zip-slip / absolute / drive-letter entry paths; returns the normalized safe name. */
function safeEntryPath(rawName: string): string {
  if (rawName.length === 0) throw new SdeZipError('PATH_EMPTY', '压缩包包含空路径条目')
  const name = rawName.replaceAll('\\', '/')
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.includes('\0')) {
    throw new SdeZipError('PATH_UNSAFE', `压缩包包含不安全的路径：${truncate(rawName, 40)}`, { params: { name: truncate(rawName, 40) } })
  }
  const segments = name.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new SdeZipError('PATH_TRAVERSAL', `压缩包包含越界路径（zip-slip）：${truncate(rawName, 40)}`, { params: { name: truncate(rawName, 40) } })
  }
  return name
}

/** Validate the extracted payload: manifest.json + every listed table's .jsonl. */
function validatePayload(versionDir: string, files: readonly string[]): SdeManifest {
  if (!files.includes('manifest.json')) {
    throw new SdeZipError(
      'PAYLOAD_NO_MANIFEST',
      '压缩包内没有 manifest.json；这不是 SDE 镜像包（镜像 zip 应包含 manifest.json 与各表 .jsonl）',
    )
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(versionDir, 'manifest.json'), 'utf8'))
  } catch {
    throw new SdeZipError('PAYLOAD_JSON_INVALID', '压缩包内的 manifest.json 无法解析（不是有效的 JSON）')
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new SdeZipError('PAYLOAD_STRUCT_INVALID', '压缩包内的 manifest.json 结构无效')
  }
  const record = manifest as Record<string, unknown>
  const buildNumber = record.buildNumber
  if (typeof buildNumber !== 'number' || !Number.isInteger(buildNumber) || buildNumber <= 0) {
    throw new SdeZipError('PAYLOAD_NO_BUILD', 'manifest.json 缺少有效的 buildNumber')
  }
  const tables = record.tables
  if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) {
    throw new SdeZipError('PAYLOAD_NO_TABLES', 'manifest.json 缺少 tables 表清单')
  }
  const tableNames = Object.keys(tables as Record<string, unknown>)
  if (tableNames.length === 0) {
    throw new SdeZipError('PAYLOAD_EMPTY_TABLES', 'manifest.json 的 tables 是空的（没有数据表）')
  }
  const missing = tableNames.filter((table) => !files.includes(`${table}.jsonl`))
  if (missing.length > 0) {
    const listed = missing.slice(0, 3).map((t) => `${t}.jsonl`).join('、')
    const many = missing.length > 3
    throw new SdeZipError(
      many ? 'PAYLOAD_MISSING_TABLES_MANY' : 'PAYLOAD_MISSING_TABLES',
      `压缩包缺少数据表文件：${truncate(listed, 80)}${many ? ` 等 ${missing.length} 个` : ''}`,
      { params: many ? { tables: truncate(listed, 80), count: missing.length } : { tables: truncate(listed, 80) } },
    )
  }
  return manifest as SdeManifest
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function retryableSdeError(error: SdeZipError): boolean {
  return error.code === 'NETWORK' || error.code === 'DOWNLOAD_INTERRUPTED'
    || error.code === 'HTTP_ERROR' || error.code === 'TIMEOUT'
}

function classifyTimeout(error: unknown): SdeZipError {
  void error
  return new SdeZipError('TIMEOUT', '下载超时：连接服务器或接收数据超时，请检查网络后重试')
}

function classifyNetworkError(error: unknown, fallback: string): SdeZipError {
  const message = error instanceof Error && error.message.length > 0 ? error.message : fallback
  return new SdeZipError('NETWORK', `网络错误：${truncate(message, 120)}`, { cause: error, params: { detail: truncate(message, 120) } })
}

function mapFsError(error: unknown, fallback: string): SdeZipError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOSPC') return new SdeZipError('DISK_FULL', '磁盘空间不足，无法写入数据')
  if (code === 'EACCES' || code === 'EPERM') return new SdeZipError('DISK_DENIED', '没有写入权限，无法保存数据')
  const message = error instanceof Error && error.message.length > 0 ? error.message : fallback
  return new SdeZipError('DISK_ERROR', `写入数据失败：${truncate(message, 120)}`, { cause: error, params: { detail: truncate(message, 120) } })
}

function backoff(attempt: number): Promise<void> {
  const delay = Math.min(500 * 2 ** attempt, 5000) + Math.random() * 250
  return new Promise((resolve) => setTimeout(resolve, delay))
}

/** Ensure `_sde.jsonl` exists in the staging dir (buildManifestForVersionDir requires it). */
function ensureVersionRecord(versionDir: string, manifest: SdeManifest): void {
  const recordPath = join(versionDir, '_sde.jsonl')
  if (existsSync(recordPath)) return
  writeFileSync(
    recordPath,
    JSON.stringify({ _key: 'sde', buildNumber: manifest.buildNumber, releaseDate: manifest.releaseDate }),
    'utf8',
  )
}

/** Read a manifest.json inside a version dir, or undefined when absent/unreadable. */
export function readManifestSafe(versionDir: string): SdeManifest | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(versionDir, 'manifest.json'), 'utf8')) as SdeManifest
    if (typeof raw.buildNumber !== 'number' || raw.tables === null || typeof raw.tables !== 'object') return undefined
    return raw
  } catch {
    return undefined
  }
}

/** List version directories (sde-<build>) under a data root. */
export function listVersionDirs(dataRoot: string): string[] {
  if (!existsSync(dataRoot)) return []
  return readdirSync(dataRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^sde-\d+$/.test(entry.name))
    .map((entry) => entry.name)
}

/** Same-content check: both manifests exist with equal per-table sha256. */
export function sameVersionContent(a: SdeManifest | undefined, b: SdeManifest | undefined): boolean {
  if (a === undefined || b === undefined) return false
  if (a.buildNumber !== b.buildNumber) return false
  const aTables = Object.entries(a.tables)
  if (aTables.length !== Object.keys(b.tables).length) return false
  return aTables.every(([table, stats]) => b.tables[table]?.sha256 === stats.sha256)
}

/**
 * Atomically install a validated staging dir as `sde-<buildNumber>` under
 * `dataRoot`. A re-download whose content matches the existing version dir is
 * a no-op (returns the existing dir). Otherwise the old dir is renamed aside,
 * the staging dir takes its place, and the old dir is removed — the `current`
 * symlink is never touched here, so the active version only changes when the
 * caller swaps it.
 * @returns the installed version directory path.
 */
export function installVersionDir(dataRoot: string, stagingDir: string, buildNumber: number): string {
  const target = join(dataRoot, `sde-${buildNumber}`)
  if (existsSync(target)) {
    if (sameVersionContent(readManifestSafe(stagingDir), readManifestSafe(target))) {
      rmSync(stagingDir, { recursive: true, force: true })
      return target
    }
    const old = `${target}.old`
    if (existsSync(old)) rmSync(old, { recursive: true, force: true })
    try {
      renameSync(target, old)
    } catch (error) {
      throw mapFsError(error, '无法移动旧版本目录')
    }
    try {
      renameSync(stagingDir, target)
    } catch (error) {
      // Best-effort restore so the previous version is never lost.
      try {
        renameSync(old, target)
      } catch {
        // nothing left to do — both names are logged by the outer handler
      }
      throw mapFsError(error, '无法安装新版本目录')
    }
    rmSync(old, { recursive: true, force: true })
    return target
  }
  try {
    renameSync(stagingDir, target)
  } catch (error) {
    throw mapFsError(error, '无法安装新版本目录')
  }
  return target
}
