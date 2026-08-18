/**
 * Controller for the SDE-update settings card: binds the `dsh-esi` settings
 * namespace, exposes the host-published status as a snapshot store, and
 * issues one-shot trigger writes (armed by a fresh nonce) that the host
 * watcher turns into an update or rollback.
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { SdeCardLocaleKey } from './locales.ts'

/** Mirror of the host-side status shape (client cannot import host packages). */
export interface SdeGuiStatusView {
  readonly phase: 'idle' | 'checking' | 'downloading' | 'extracting' | 'building' | 'installing' | 'done' | 'error' | string
  /** Dictionary key of the status line; absent → render `message` raw. */
  readonly messageKey?: string
  /** Interpolation params for `messageKey`. */
  readonly messageParams?: Readonly<Record<string, string | number>>
  readonly message: string
  readonly progress?: number
  readonly error?: { readonly code: string; readonly message: string; readonly params?: Readonly<Record<string, string | number>> }
  readonly currentBuild?: number
  readonly previousBuild?: number
  readonly at: number
}

/** Wire shape of the namespace section the card reads and writes. */
export interface SdeGuiSection {
  readonly sdeUpdateUrl?: string
  readonly sdeUpdateRequest?: { readonly url: string; readonly nonce: number }
  readonly sdeRollbackRequest?: { readonly nonce: number }
  readonly sdeUpdateStatus?: SdeGuiStatusView
}

/** What the card renders. */
export interface SdeCardState {
  /** Whether the namespace is exposed (dsh-esi mounted) and accepted. */
  readonly available: boolean
  /** Whether the Host document accepts writes. */
  readonly writable: boolean
  /** Latest host-published status; undefined until the first one arrives. */
  readonly status: SdeGuiStatusView | undefined
  /** True while an update or rollback is in flight. */
  readonly busy: boolean
  /** Whether the last status was an error. */
  readonly failed: boolean
}

/** The registration-side face the card's slot entry injects. */
export interface SdeCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useSdeCard. */
    sdeCard: {
      getSnapshot(): SdeCardState
      subscribe(listener: () => void): () => void
    }
  }
  /** Namespace-bound translate (bound at apply time; reads the active locale at call time). */
  t: (key: SdeCardLocaleKey, params?: Record<string, unknown>) => string
  /** Arm an update with the given URL (one-shot trigger write). */
  runUpdate(url: string): void
  /** Arm a rollback (one-shot trigger write). */
  rollback(): void
}

const RUNNING_PHASES = new Set(['checking', 'downloading', 'extracting', 'building', 'installing'])

export class SdeCardController {
  private state: SdeCardState
  private readonly listeners = new Set<() => void>()

  /**
   * @param scope - the bound settings scope for the `dsh-esi` namespace.
   * @param t - namespace-bound translate injected into the card face.
   */
  constructor(
    private readonly scope: SettingsScope<SdeGuiSection>,
    private readonly t: (key: SdeCardLocaleKey, params?: Record<string, unknown>) => string,
  ) {
    this.state = this.project()
    this.scope.subscribe(() => {
      const next = this.project()
      if (next === this.state) return
      this.state = next
      for (const listener of this.listeners) listener()
    })
  }

  /** @returns the current card state. */
  getSnapshot(): SdeCardState {
    return this.state
  }

  /** @returns the unsubscriber. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Arm an update from the URL the user typed. */
  runUpdate(url: string): void {
    void this.scope.set('sdeUpdateRequest', { url, nonce: Date.now() }).catch(() => {})
  }

  /** Arm a rollback. */
  rollback(): void {
    void this.scope.set('sdeRollbackRequest', { nonce: Date.now() }).catch(() => {})
  }

  /** Build the face the card's slot registration injects. */
  inject(): SdeCardFace {
    return {
      hooks: {
        sdeCard: {
          getSnapshot: () => this.getSnapshot(),
          subscribe: (listener) => this.subscribe(listener),
        },
      },
      t: this.t,
      runUpdate: (url) => this.runUpdate(url),
      rollback: () => this.rollback(),
    }
  }

  private project(): SdeCardState {
    const snapshot = this.scope.getSnapshot()
    const available = snapshot.status === 'ready'
    const status = available ? snapshot.value?.sdeUpdateStatus : undefined
    return {
      available,
      writable: available && snapshot.writable,
      status,
      busy: status !== undefined && RUNNING_PHASES.has(status.phase),
      failed: status !== undefined && status.phase === 'error',
    }
  }
}
