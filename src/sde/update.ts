/**
 * User-triggered SDE update machinery: source adapters, dry-run planning,
 * delta download, atomic `current` symlink swap, and rollback.
 *
 * A version directory is self-contained (jsonl tables + _sde.jsonl +
 * manifest.json + sde.db). The `current` symlink under the data root selects
 * the active version; previous versions are always kept, so rollback is a
 * symlink flip.
 *
 * Sources implement {@link SdeUpdateSource}. The shipped adapter is
 * {@link JsonlSdeSource} — it consumes the same jsonl+manifest layout the
 * plugin already uses, so any mirror (or the future official-zip converter
 * output) drives updates today. Updates are deliberately user-triggered: the
 * tool returns a dry-run plan first and only downloads on explicit
 * confirmation.
 */

import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { buildManifestForVersionDir } from '../../scripts/build-manifest.mjs'
import type { EsiaAbortSignal, EsiaFetch, EsiaFetchInit } from '../esia-client.ts'
import { SdeService } from './service.ts'
import type { SdeLanguage, SdeManifest, SdeVersionRecord } from './types.ts'

export interface SdeSourceProbe {
  readonly buildNumber: number
  readonly releaseDate?: string
  /** Per-table remote checksums/sizes when the source exposes them (drives the delta). */
  readonly tables?: Record<string, { sha256?: string; sizeBytes?: number }>
}

export interface SdeUpdateSource {
  /** Inspect the latest available version without downloading table data. */
  probe(signal?: EsiaAbortSignal): Promise<SdeSourceProbe>
  /**
   * Materialize the latest version into a directory under `dataRoot` (must be
   * complete: jsonl tables + `_sde.jsonl`). Returns the new version dir.
   */
  fetch(dataRoot: string, signal?: EsiaAbortSignal): Promise<{ versionDir: string; buildNumber: number }>
}

export interface UpdatePlan {
  readonly dryRun: true
  readonly currentBuild: number | undefined
  readonly latestBuild: number
  readonly updateAvailable: boolean
  /** Tables whose sha256 differs (source-provided), or null when unknown. */
  readonly changedTables: readonly string[] | null
  /** Estimated bytes to download (source-provided), or null when unknown. */
  readonly estimatedBytes: number | null
  readonly sourceDescription: string
}

export interface UpdateResult {
  readonly updated: boolean
  readonly buildNumber: number
  readonly versionDir: string
  readonly previousBuild: number | undefined
  readonly changedTables: readonly string[]
}

const STAGING_SUFFIX = '-staging'

/** Atomically repoint the `current` symlink under `dataRoot` (write-then-rename). */
export function swapCurrentSymlink(dataRoot: string, targetName: string): void {
  const link = join(dataRoot, 'current')
  const tmp = `${link}.new`
  if (existsSync(tmp)) unlinkSync(tmp)
  symlinkSync(targetName, tmp)
  if (existsSync(link)) unlinkSync(link)
  renameSync(tmp, link)
}

export class SdeUpdater {
  private readonly dataRoot: string
  private readonly source: SdeUpdateSource | undefined
  private readonly sde: SdeService

  constructor(options: { dataRoot: string; source?: SdeUpdateSource; defaultLanguage?: SdeLanguage }) {
    this.dataRoot = options.dataRoot
    this.source = options.source
    this.sde = new SdeService({ dataRoot: options.dataRoot, defaultLanguage: options.defaultLanguage })
  }

  listVersions(): string[] {
    if (!existsSync(this.dataRoot)) return []
    return readdirSync(this.dataRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.endsWith(STAGING_SUFFIX))
  }

  /** Dry-run: probe the source and diff against the current version. */
  async plan(signal?: EsiaAbortSignal): Promise<UpdatePlan> {
    if (this.source === undefined) {
      throw new Error('SDE update: no update source configured (set sdeUpdateSource in the plugin config)')
    }
    const probe = await this.source.probe(signal)
    let currentBuild: number | undefined
    let changedTables: string[] | null = null
    let estimatedBytes: number | null = null
    try {
      const current = this.sde.readManifest(this.sde.resolveVersionDir())
      if (current !== undefined) {
        currentBuild = current.buildNumber
        if (probe.tables !== undefined) {
          changedTables = Object.entries(probe.tables)
            .filter(([table, remote]) => {
              const local = current.tables[table]
              return local === undefined || (remote.sha256 !== undefined && local.sha256 !== remote.sha256)
            })
            .map(([table]) => table)
          estimatedBytes = Object.entries(probe.tables)
            .filter(([table]) => changedTables?.includes(table))
            .reduce((sum, [, remote]) => sum + (remote.sizeBytes ?? 0), 0)
        }
      }
    } catch {
      // No current version (or unreadable) — the update is a fresh install.
    }
    return {
      dryRun: true,
      currentBuild,
      latestBuild: probe.buildNumber,
      updateAvailable: currentBuild !== probe.buildNumber,
      changedTables,
      estimatedBytes,
      sourceDescription: describeSource(this.source),
    }
  }

  /** Execute the update: fetch → manifest/index → atomic `current` swap. */
  async run(signal?: EsiaAbortSignal): Promise<UpdateResult> {
    if (this.source === undefined) {
      throw new Error('SDE update: no update source configured (set sdeUpdateSource in the plugin config)')
    }
    const previousBuild = this.currentBuildNumber()
    const previousManifest = previousBuild === undefined ? undefined : this.currentManifest()
    const { versionDir, buildNumber } = await this.source.fetch(this.dataRoot, signal)

    // Ensure the version record exists inside the new dir.
    const recordPath = join(versionDir, '_sde.jsonl')
    if (!existsSync(recordPath)) {
      const record: SdeVersionRecord = { _key: 'sde', buildNumber, releaseDate: new Date().toISOString() }
      writeFileSync(recordPath, JSON.stringify(record), 'utf8')
    }

    buildManifestForVersionDir(versionDir)
    this.swapCurrent(basename(versionDir))

    const newManifest = this.sde.readManifest(versionDir)
    const changedTables = previousManifest === undefined || newManifest === undefined
      ? Object.keys(newManifest?.tables ?? {})
      : Object.entries(newManifest.tables)
          .filter(([table, stats]) => previousManifest.tables[table]?.sha256 !== stats.sha256)
          .map(([table]) => table)

    return {
      updated: true,
      buildNumber,
      versionDir,
      previousBuild,
      changedTables,
    }
  }

  /** Point `current` back at the previous version directory (highest other build). */
  rollback(): { rolledBack: boolean; now: number | undefined; previous: number | undefined } {
    const previous = this.currentBuildNumber()
    const currentName = this.currentDirName()
    const candidates = this.listVersions()
      .filter((name) => name !== currentName)
      .map((name) => ({ name, build: this.readBuild(join(this.dataRoot, name)) ?? -1 }))
      .sort((a, b) => b.build - a.build)
    const target = candidates[0]?.name
    if (target === undefined) {
      return { rolledBack: false, now: previous, previous }
    }
    this.swapCurrent(target)
    return { rolledBack: true, now: this.readBuild(join(this.dataRoot, target)), previous }
  }

  // ---- internals ----------------------------------------------------------

  private currentDirName(): string | undefined {
    const link = join(this.dataRoot, 'current')
    if (!existsSync(link)) return undefined
    try {
      return readlinkSync(link)
    } catch {
      return undefined
    }
  }

  private currentBuildNumber(): number | undefined {
    try {
      return this.sde.readManifest(this.sde.resolveVersionDir())?.buildNumber
    } catch {
      return undefined
    }
  }

  private currentManifest(): SdeManifest | undefined {
    try {
      return this.sde.readManifest(this.sde.resolveVersionDir())
    } catch {
      return undefined
    }
  }

  private readBuild(versionDir: string): number | undefined {
    try {
      return this.sde.readManifest(versionDir)?.buildNumber
    } catch {
      return undefined
    }
  }

  /** Atomically repoint the `current` symlink (write-then-rename). */
  private swapCurrent(targetName: string): void {
    swapCurrentSymlink(this.dataRoot, targetName)
  }
}

/**
 * Source that mirrors the plugin's own layout over HTTP:
 * `<baseUrl>/manifest.json` plus `<table>.jsonl` files. Delta download is
 * driven by the remote manifest's per-table sha256; unchanged tables are
 * hard-linked from the current version instead of re-downloaded.
 */
export class JsonlSdeSource implements SdeUpdateSource {
  readonly baseUrl: string
  private readonly fetchImpl: EsiaFetch

  constructor(options: { baseUrl: string; fetchImpl?: EsiaFetch }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl
      ?? ((input: string, init?: EsiaFetchInit) => fetch(input, init as RequestInit)) as unknown as EsiaFetch
  }

  async probe(signal?: EsiaAbortSignal): Promise<SdeSourceProbe> {
    const manifest = await this.fetchJson<SdeManifest>('/manifest.json', signal)
    const tables: Record<string, { sha256?: string; sizeBytes?: number }> = {}
    for (const [table, stats] of Object.entries(manifest.tables)) {
      tables[table] = { sha256: stats.sha256, sizeBytes: stats.sizeBytes }
    }
    return { buildNumber: manifest.buildNumber, releaseDate: manifest.releaseDate, tables }
  }

  async fetch(dataRoot: string, signal?: EsiaAbortSignal): Promise<{ versionDir: string; buildNumber: number }> {
    const manifest = await this.fetchJson<SdeManifest>('/manifest.json', signal)
    const versionDir = join(dataRoot, `sde-${manifest.buildNumber}`)
    mkdirSync(versionDir, { recursive: true })

    // Reuse unchanged tables from the current version via hard links.
    let previousDir: string | undefined
    try {
      previousDir = new SdeService({ dataRoot }).resolveVersionDir()
    } catch {
      previousDir = undefined
    }
    const previousManifest = previousDir === undefined ? undefined : readManifestSafe(previousDir)

    for (const [table, stats] of Object.entries(manifest.tables)) {
      const target = join(versionDir, `${table}.jsonl`)
      if (previousDir !== undefined && previousManifest?.tables[table]?.sha256 === stats.sha256) {
        linkOrCopy(join(previousDir, `${table}.jsonl`), target)
        continue
      }
      const response = await this.fetchImpl(`${this.baseUrl}/${table}.jsonl`, { signal })
      if (!response.ok) {
        throw new Error(`SDE update: failed to download ${table}.jsonl (HTTP ${response.status})`)
      }
      const text = await response.text()
      writeFileSync(target, text, 'utf8')
    }
    return { versionDir, buildNumber: manifest.buildNumber }
  }

  private async fetchJson<T>(path: string, signal?: EsiaAbortSignal): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { signal })
    if (!response.ok) {
      throw new Error(`SDE update: ${path} returned HTTP ${response.status}`)
    }
    const text = await response.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`SDE update: ${path} is not valid JSON`)
    }
  }
}

function describeSource(source: SdeUpdateSource): string {
  if (source instanceof JsonlSdeSource) return `jsonl mirror (${source.baseUrl})`
  return source.constructor.name
}

function readManifestSafe(versionDir: string): SdeManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(versionDir, 'manifest.json'), 'utf8')) as SdeManifest
  } catch {
    return undefined
  }
}

function linkOrCopy(source: string, target: string): void {
  try {
    linkSync(source, target)
  } catch {
    copyFileSync(source, target)
  }
}
