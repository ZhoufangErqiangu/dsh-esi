/**
 * GUI-driven SDE update runner: orchestrates the URL-download pipeline with
 * per-phase status callbacks. Cordis-free (a plain class) so the update flow
 * is unit-testable; the plugin wiring in index.ts bridges statuses to the
 * settings namespace the settings card reads.
 *
 * Flow: validate URL → probe (HEAD) → download (progress) → extract/validate
 * → build manifest + sqlite index in staging (old version stays live) →
 * atomically install → swap the `current` symlink. Any failure produces a
 * typed error status and never leaves the previous version damaged.
 */

import { readlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { buildManifestForVersionDir } from '../../scripts/build-manifest.mjs'
import type { SdeLanguage } from './types.ts'
import { SdeService } from './service.ts'
import { swapCurrentSymlink } from './update.ts'
import {
  SdeZipError,
  ZipSdeSource,
  installVersionDir,
  listVersionDirs,
  readManifestSafe,
} from './zip-source.ts'

export type SdeGuiPhase = 'idle' | 'checking' | 'downloading' | 'extracting' | 'building' | 'installing' | 'done' | 'error'

export interface SdeGuiErrorInfo {
  readonly code: string
  readonly message: string
}

export interface SdeGuiStatus {
  readonly phase: SdeGuiPhase
  readonly message: string
  /** 0..1 download progress; present only while downloading. */
  readonly progress?: number
  readonly error?: SdeGuiErrorInfo
  /** Active build after a successful update/rollback. */
  readonly currentBuild?: number
  /** Build that was active before the last update. */
  readonly previousBuild?: number
  readonly at: number
}

/** A status before the timestamp is stamped (emit fills `at`). */
type SdeGuiStatusDraft = Omit<SdeGuiStatus, 'at'> & { readonly at?: number }

export interface SdeGuiRunnerOptions {
  readonly dataRoot: string
  readonly defaultLanguage?: SdeLanguage
}

const PROGRESS_THROTTLE_MS = 150
const PROGRESS_STEP = 0.01

export class SdeGuiRunner {
  private readonly sde: SdeService
  private readonly dataRoot: string
  private running = false
  private lastStatus: SdeGuiStatus
  private lastProgressAt = 0
  private lastProgressPercent: number | undefined

  constructor(options: SdeGuiRunnerOptions) {
    this.dataRoot = options.dataRoot
    this.sde = new SdeService({ dataRoot: options.dataRoot, defaultLanguage: options.defaultLanguage })
    this.lastStatus = this.idleStatus()
  }

  /** Whether an update or rollback is in flight (the settings watcher gates on this). */
  get busy(): boolean {
    return this.running
  }

  /** Latest published status (initial value: idle with the current build). */
  status(): SdeGuiStatus {
    return this.lastStatus
  }

  private idleStatus(): SdeGuiStatus {
    const build = this.currentBuild()
    return {
      phase: 'idle',
      message: build === undefined ? '尚未安装 SDE 数据' : `当前版本：build ${build}`,
      currentBuild: build,
      at: Date.now(),
    }
  }

  /** Run one URL-driven update; statuses are delivered through `onStatus`. */
  async runUpdate(rawUrl: string, onStatus: (status: SdeGuiStatus) => void, signal?: AbortSignal): Promise<void> {
    if (this.running) {
      this.emit(onStatus, this.failed('BUSY', '已有更新任务在运行，请等待完成'))
      return
    }
    this.running = true
    const previousBuild = this.currentBuild()
    try {
      let source: ZipSdeSource
      try {
        source = new ZipSdeSource(rawUrl)
      } catch (error) {
        this.fail(onStatus, error)
        return
      }
      this.lastProgressAt = 0
      this.lastProgressPercent = undefined

      this.emit(onStatus, { phase: 'checking', message: '正在检查下载地址…', previousBuild })
      let probe: Awaited<ReturnType<ZipSdeSource['probe']>>
      try {
        probe = await source.probe(signal)
      } catch (error) {
        this.fail(onStatus, error)
        return
      }
      const sizeHint = probe.estimatedBytes === undefined ? '' : `（${formatBytes(probe.estimatedBytes)}）`
      this.emit(onStatus, {
        phase: 'checking',
        message: probe.buildNumber === undefined
          ? `地址可访问，开始下载${sizeHint}`
          : `检查通过：镜像 build ${probe.buildNumber}${sizeHint}`,
        previousBuild,
      })

      const result = await source.downloadToStaging(this.dataRoot, signal, {
        onProgress: (progress) => this.reportProgress(onStatus, progress.bytes, progress.total, progress.percent, previousBuild),
      })

      this.emit(onStatus, { phase: 'extracting', message: '解压并校验数据…', previousBuild })
      this.emit(onStatus, { phase: 'building', message: '正在构建索引（约 1 分钟）…', previousBuild })
      buildManifestForVersionDir(result.stagingDir)

      this.emit(onStatus, { phase: 'installing', message: '正在切换版本…', previousBuild })
      const versionDir = installVersionDir(this.dataRoot, result.stagingDir, result.buildNumber)
      swapCurrentSymlink(this.dataRoot, basename(versionDir))

      this.emit(onStatus, {
        phase: 'done',
        message: `更新完成：已切换到 build ${result.buildNumber}`,
        currentBuild: result.buildNumber,
        previousBuild,
      })
    } catch (error) {
      this.fail(onStatus, error)
    } finally {
      this.running = false
    }
  }

  /** Roll back to the newest other version on disk. */
  async rollback(onStatus: (status: SdeGuiStatus) => void): Promise<void> {
    if (this.running) {
      this.emit(onStatus, this.failed('BUSY', '已有更新任务在运行，请等待完成'))
      return
    }
    this.running = true
    try {
      const current = this.currentDirName()
      const candidates = listVersionDirs(this.dataRoot)
        .filter((name) => name !== current)
        .map((name) => ({ name, build: readManifestSafe(join(this.dataRoot, name))?.buildNumber ?? -1 }))
        .sort((a, b) => b.build - a.build)
      const target = candidates[0]?.name
      if (target === undefined) {
        this.emit(onStatus, this.failed('NO_ROLLBACK', '没有可回滚的旧版本'))
        return
      }
      this.emit(onStatus, { phase: 'installing', message: `正在回滚到 build ${candidates[0]?.build}…` })
      swapCurrentSymlink(this.dataRoot, target)
      const build = readManifestSafe(join(this.dataRoot, target))?.buildNumber
      this.emit(onStatus, {
        phase: 'done',
        message: build === undefined ? '已回滚' : `已回滚到 build ${build}`,
        currentBuild: build,
      })
    } catch (error) {
      this.fail(onStatus, error)
    } finally {
      this.running = false
    }
  }

  // ---- internals ----------------------------------------------------------

  private currentBuild(): number | undefined {
    try {
      return this.sde.readManifest(this.sde.resolveVersionDir())?.buildNumber
    } catch {
      return undefined
    }
  }

  private currentDirName(): string | undefined {
    try {
      return readlinkSync(join(this.dataRoot, 'current'))
    } catch {
      return undefined
    }
  }

  private reportProgress(
    onStatus: (status: SdeGuiStatus) => void,
    bytes: number,
    total: number | undefined,
    percent: number | undefined,
    previousBuild: number | undefined,
  ): void {
    const now = Date.now()
    const step = percent === undefined ? 0 : Math.floor(percent / PROGRESS_STEP)
    if (this.lastProgressPercent === step && now - this.lastProgressAt < PROGRESS_THROTTLE_MS) return
    this.lastProgressPercent = step
    this.lastProgressAt = now
    const size = total === undefined ? formatBytes(bytes) : `${formatBytes(bytes)} / ${formatBytes(total)}`
    this.emit(onStatus, {
      phase: 'downloading',
      message: `正在下载 ${size}${percent === undefined ? '' : `（${Math.round(percent * 100)}%）`}`,
      progress: percent,
      previousBuild,
    })
  }

  private fail(onStatus: (status: SdeGuiStatus) => void, error: unknown): void {
    if (error instanceof SdeZipError) {
      this.emit(onStatus, this.failed(error.code, error.message))
      return
    }
    const message = error instanceof Error && error.message.length > 0 ? error.message : String(error)
    this.emit(onStatus, this.failed('INTERNAL', `更新失败：${truncate(message, 200)}`))
  }

  private failed(code: string, message: string): SdeGuiStatus {
    return {
      phase: 'error',
      message,
      error: { code, message },
      currentBuild: this.currentBuild(),
      at: Date.now(),
    }
  }

  private emit(onStatus: (status: SdeGuiStatus) => void, status: SdeGuiStatusDraft): void {
    const stamped: SdeGuiStatus = { ...status, at: status.at ?? Date.now() }
    this.lastStatus = stamped
    onStatus(stamped)
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / 1024).toFixed(1)} KiB`
}
