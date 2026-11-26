/**
 * Browser-side state client for the two settings cards.
 *
 * The Host exposes one JSON bridge (`src/ui/bridge.ts`); this client polls its
 * `state` endpoint while the settings tab is mounted and POSTs one action per
 * user gesture. Every action answer already carries the fresh state, so a
 * gesture does not wait for the next poll tick.
 *
 * @module @dsh-esi/plugin-esi/client
 */

import type {
  AccountCharacter,
  BridgeFailure,
  BridgeResponse,
  EsiUiState,
  LoginStatus,
  MarketRegion,
  SdeUiStatus,
} from '../ui/protocol.ts'
import { BRIDGE_ENDPOINTS } from '../ui/protocol.ts'

/** What the SDE card renders. */
export interface SdeCardState {
  /** Whether the Host bridge answered at least once. */
  readonly available: boolean
  /** Latest update/rollback status. */
  readonly status: SdeUiStatus | undefined
  /** Installed builds, newest first. */
  readonly versions: readonly number[]
  /** Configured default mirror URL (prefill). */
  readonly defaultUpdateUrl: string | undefined
  /** True while an update or rollback is in flight. */
  readonly busy: boolean
  /** Whether the last status was an error. */
  readonly failed: boolean
}

/** What the EVE account card renders. */
export interface EveAccountCardState {
  readonly available: boolean
  readonly regions: readonly MarketRegion[]
  readonly regionId: number | undefined
  readonly characters: readonly AccountCharacter[]
  readonly status: LoginStatus | undefined
  readonly busy: boolean
}

/** One snapshot of the whole tab. */
export interface EsiTabSnapshot {
  readonly sde: SdeCardState
  readonly account: EveAccountCardState
  /** Transport-level failure (bridge unreachable); cleared by the next answer. */
  readonly error: string | undefined
}

/** Bound one bridge request so a hung server cannot pin the tab. */
function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(5000)
    : undefined
}

const RUNNING_PHASES = new Set(['checking', 'downloading', 'extracting', 'building', 'installing'])
const LOGIN_PHASES = new Set(['starting', 'waiting'])
const POLL_INTERVAL_MS = 1000

const EMPTY: EsiTabSnapshot = {
  sde: { available: false, status: undefined, versions: [], defaultUpdateUrl: undefined, busy: false, failed: false },
  account: { available: false, regions: [], regionId: undefined, characters: [], status: undefined, busy: false },
  error: undefined,
}

/**
 * Polls the Host bridge and owns the tab snapshot. One instance per settings
 * tab mount; `stop()` ends the timer and `start()` may resume it.
 */
export class EsiUiClient {
  private state: EsiUiState | undefined
  private error: string | undefined
  private snapshot: EsiTabSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private reading = false
  /** One user action at a time: a double click must not post twice. */
  private acting = false

  /** Begin polling; safe to call more than once, and after {@link stop}. */
  start(): void {
    if (this.timer !== undefined) return
    void this.refresh()
    this.timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void this.refresh()
    }, POLL_INTERVAL_MS)
  }

  /** Stop polling (tab unmount, plugin unload); {@link start} may resume it. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** @returns the current tab snapshot (stable while nothing changes). */
  getSnapshot(): EsiTabSnapshot {
    return this.snapshot
  }

  /** Observe snapshot replacements. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Start one URL update. */
  runUpdate(url: string): void {
    void this.post(BRIDGE_ENDPOINTS.sdeUpdate, { url })
  }

  /** Roll back to the newest other build. */
  rollback(): void {
    void this.post(BRIDGE_ENDPOINTS.sdeRollback)
  }

  /** Start one EVE SSO login. */
  login(): void {
    void this.post(BRIDGE_ENDPOINTS.login)
  }

  /** Revoke one character, or every character when `characterId` is omitted. */
  deauth(characterId?: number): void {
    void this.post(BRIDGE_ENDPOINTS.deauthorize, characterId === undefined ? {} : { characterId })
  }

  /** Select the default market region, or clear it with `undefined`. */
  setRegion(regionId: number | undefined): void {
    void this.post(BRIDGE_ENDPOINTS.region, { regionId: regionId ?? null })
  }

  // ---- transport ------------------------------------------------------------

  private async refresh(): Promise<void> {
    if (this.reading) return
    this.reading = true
    try {
      const response = await fetch(BRIDGE_ENDPOINTS.state, {
        headers: { accept: 'application/json' },
        signal: timeoutSignal(),
      })
      if (!response.ok) {
        this.fail(`HTTP ${response.status}`)
        return
      }
      const body = await response.json() as BridgeResponse | BridgeFailure
      if (body.ok !== true) {
        this.fail(body.error.message)
        return
      }
      this.accept(body.state)
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
    } finally {
      this.reading = false
    }
  }

  private async post(path: string, body?: Record<string, unknown>): Promise<void> {
    if (this.acting) return
    this.acting = true
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: timeoutSignal(),
      })
      const payload = await response.json() as BridgeResponse | BridgeFailure
      if (payload.ok === true) {
        this.accept(payload.state)
        return
      }
      this.fail(payload.error.message)
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
    } finally {
      this.acting = false
    }
  }

  private accept(state: EsiUiState): void {
    this.state = state
    this.error = undefined
    this.publish()
  }

  /**
   * Record a transport/action failure without discarding the last good state:
   * a rejected action (for example an unknown region) must not blank the cards
   * or lose the user's typed URL and disclosure state. Before the first answer
   * the snapshot stays unavailable and the tab shows the bridge error.
   */
  private fail(message: string): void {
    if (this.error === message) return
    this.error = message
    this.publish()
  }

  private publish(): void {
    const state = this.state
    const next: EsiTabSnapshot = state === undefined
      ? { ...EMPTY, error: this.error }
      : {
          sde: {
            available: state.sde.available,
            status: state.sde.status,
            versions: state.sde.versions,
            defaultUpdateUrl: state.sde.defaultUpdateUrl,
            busy: RUNNING_PHASES.has(state.sde.status.phase),
            failed: state.sde.status.phase === 'error',
          },
          account: {
            available: state.account.available,
            regions: state.account.regions,
            regionId: state.account.defaultRegionId,
            characters: state.account.characters,
            status: state.account.status,
            busy: LOGIN_PHASES.has(state.account.status.phase),
          },
          error: this.error,
        }
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
