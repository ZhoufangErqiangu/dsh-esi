/**
 * Browser-driven SDE update runner: orchestrates the URL-download pipeline with
 * per-phase status callbacks. Cordis-free (a plain class) so the update flow
 * is unit-testable; `src/ui/bridge.ts` shares one runner between the browser
 * cards and the `sde_update` tool.
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
import type { SdeUiStatus } from '../ui/protocol.ts'
import { SdeService } from './service.ts'
import { swapCurrentSymlink } from './update.ts'
import {
  SdeZipError,
  ZipSdeSource,
  installVersionDir,
  listVersionDirs,
  readManifestSafe,
} from './zip-source.ts'

export type { SdeUiError, SdeUiPhase, SdeUiStatus } from '../ui/protocol.ts'

/** A status before the timestamp is stamped (emit fills `at`). */
type SdeUiStatusDraft = Omit<SdeUiStatus, 'at'> & { readonly at?: number }

export interface SdeUpdateRunnerOptions {
  readonly dataRoot: string
  readonly defaultLanguage?: SdeLanguage
}

const PROGRESS_THROTTLE_MS = 150
const PROGRESS_STEP = 0.01
/** Ignore a repeated rollback right after one finished (double click / retry storm). */
const ROLLBACK_COOLDOWN_MS = 1500

export class SdeUpdateRunner {
  private readonly sde: SdeService
  private readonly dataRoot: string
  private running = false
  private lastStatus: SdeUiStatus
  private lastProgressAt = 0
  private lastProgressPercent: number | undefined
  private lastRollbackAt = 0

  constructor(options: SdeUpdateRunnerOptions) {
    this.dataRoot = options.dataRoot
    this.sde = new SdeService({ dataRoot: options.dataRoot, defaultLanguage: options.defaultLanguage })
    this.lastStatus = this.idleStatus()
  }

  /** Whether an update or rollback is in flight (shared by the card and the url tool). */
  get busy(): boolean {
    return this.running
  }

  /** Latest published status (initial value: idle with the current build). */
  status(): SdeUiStatus {
    return this.lastStatus
  }

  /** Installed SDE builds, newest first (empty when `data/` has no versions). */
  listVersions(): number[] {
    return listVersionDirs(this.dataRoot)
      .map((name) => readManifestSafe(join(this.dataRoot, name))?.buildNumber ?? -1)
      .filter((build) => build >= 0)
      .sort((a, b) => b - a)
  }

  private idleStatus(): SdeUiStatus {
    const build = this.currentBuild()
    return {
      phase: 'idle',
      messageKey: build === undefined ? 'status.idle.noData' : 'status.idle.version',
      messageParams: build === undefined ? undefined : { build },
      message: build === undefined ? '尚未安装 SDE 数据' : `当前版本：build ${build}`,
      currentBuild: build,
      at: Date.now(),
    }
  }

  /** Run one URL-driven update; statuses are delivered through `onStatus`. */
  async runUpdate(rawUrl: string, onStatus: (status: SdeUiStatus) => void, signal?: AbortSignal): Promise<void> {
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

      this.emit(onStatus, { phase: 'checking', messageKey: 'status.checking', message: '正在检查下载地址…', previousBuild })
      let probe: Awaited<ReturnType<ZipSdeSource['probe']>>
      try {
        probe = await source.probe(signal)
      } catch (error) {
        this.fail(onStatus, error)
        return
      }
      const sizeHint = probe.estimatedBytes === undefined ? undefined : formatBytes(probe.estimatedBytes)
      this.emit(onStatus, {
        phase: 'checking',
        messageKey: probe.buildNumber === undefined
          ? (sizeHint === undefined ? 'status.probeReady' : 'status.probeReadySize')
          : (sizeHint === undefined ? 'status.probePassed' : 'status.probePassedSize'),
        messageParams: probe.buildNumber === undefined
          ? (sizeHint === undefined ? undefined : { size: sizeHint })
          : (sizeHint === undefined ? { build: probe.buildNumber } : { build: probe.buildNumber, size: sizeHint }),
        message: probe.buildNumber === undefined
          ? `地址可访问，开始下载${sizeHint === undefined ? '' : `（${sizeHint}）`}`
          : `检查通过：镜像 build ${probe.buildNumber}${sizeHint === undefined ? '' : `（${sizeHint}）`}`,
        previousBuild,
      })

      const result = await source.downloadToStaging(this.dataRoot, signal, {
        onProgress: (progress) => this.reportProgress(onStatus, progress.bytes, progress.total, progress.percent, previousBuild),
      })

      this.emit(onStatus, { phase: 'extracting', messageKey: 'status.extracting', message: '解压并校验数据…', previousBuild })
      this.emit(onStatus, { phase: 'building', messageKey: 'status.building', message: '正在构建索引（约 1 分钟）…', previousBuild })
      buildManifestForVersionDir(result.stagingDir)

      this.emit(onStatus, { phase: 'installing', messageKey: 'status.installing', message: '正在切换版本…', previousBuild })
      const versionDir = installVersionDir(this.dataRoot, result.stagingDir, result.buildNumber)
      swapCurrentSymlink(this.dataRoot, basename(versionDir))

      this.emit(onStatus, {
        phase: 'done',
        messageKey: 'status.updated',
        messageParams: { build: result.buildNumber },
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
  async rollback(onStatus: (status: SdeUiStatus) => void): Promise<void> {
    if (this.running) {
      this.emit(onStatus, this.failed('BUSY', '已有更新任务在运行，请等待完成'))
      return
    }
    // A rollback is a synchronous symlink flip, so the running flag is already
    // clear when a double click's second request arrives. Keep the just-shown
    // result instead of flipping to the next build.
    if (Date.now() - this.lastRollbackAt < ROLLBACK_COOLDOWN_MS) return
    this.running = true
    try {
      const current = this.currentDirName()
      const candidates = listVersionDirs(this.dataRoot)
        .filter((name) => name !== current)
        .map((name) => ({ name, build: readManifestSafe(join(this.dataRoot, name))?.buildNumber ?? -1 }))
        .sort((a, b) => b.build - a.build)
      const candidate = candidates[0]
      if (candidate === undefined) {
        this.emit(onStatus, this.failed('NO_ROLLBACK', '没有可回滚的旧版本'))
        return
      }
      this.emit(onStatus, {
        phase: 'installing',
        messageKey: 'status.rollingBack',
        messageParams: { build: candidate.build },
        message: `正在回滚到 build ${candidate.build}…`,
      })
      swapCurrentSymlink(this.dataRoot, candidate.name)
      this.lastRollbackAt = Date.now()
      const build = readManifestSafe(join(this.dataRoot, candidate.name))?.buildNumber
      this.emit(onStatus, {
        phase: 'done',
        messageKey: build === undefined ? 'status.rolledBack' : 'status.rolledBackTo',
        messageParams: build === undefined ? undefined : { build },
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
    onStatus: (status: SdeUiStatus) => void,
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
    const percentRounded = percent === undefined ? undefined : Math.round(percent * 100)
    this.emit(onStatus, {
      phase: 'downloading',
      messageKey: percentRounded === undefined ? 'status.downloading' : 'status.downloadingPercent',
      messageParams: percentRounded === undefined ? { size } : { size, percent: percentRounded },
      message: `正在下载 ${size}${percentRounded === undefined ? '' : `（${percentRounded}%）`}`,
      progress: percent,
      previousBuild,
    })
  }

  private fail(onStatus: (status: SdeUiStatus) => void, error: unknown): void {
    if (error instanceof SdeZipError) {
      this.emit(onStatus, this.failed(error.code, error.message, error.params))
      return
    }
    const message = error instanceof Error && error.message.length > 0 ? error.message : String(error)
    this.emit(onStatus, this.failed('INTERNAL', `更新失败：${truncate(message, 200)}`, { detail: truncate(message, 200) }))
  }

  private failed(code: string, message: string, params?: Record<string, string | number>): SdeUiStatus {
    return {
      phase: 'error',
      message,
      error: { code, message, params },
      currentBuild: this.currentBuild(),
      at: Date.now(),
    }
  }

  private emit(onStatus: (status: SdeUiStatus) => void, status: SdeUiStatusDraft): void {
    const stamped: SdeUiStatus = { ...status, at: status.at ?? Date.now() }
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
