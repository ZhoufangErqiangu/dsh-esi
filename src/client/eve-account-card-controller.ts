/**
 * Controller for the EVE account & market card: binds the `dsh-esi-account`
 * settings namespace, exposes the host-published OAuth status and character
 * list as a snapshot store, issues one-shot trigger writes for login /
 * deauthorize, and writes the default market region.
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { EveAccountLocaleKey } from './locales.ts'

/** Mirror of the host-side region catalog entry. */
export interface MarketRegionView {
  readonly id: number
  readonly name: string
}

/** Mirror of the host-side character projection. */
export interface AccountCharacterView {
  readonly characterId: number
  readonly characterName: string
  readonly scopes: readonly string[]
  readonly expiresAt: number
  readonly expired: boolean
}

/** Mirror of the host-side OAuth status. */
export interface OAuthStatusView {
  readonly phase: string
  readonly message: string
  readonly loginUrl?: string
  readonly error?: { readonly code: string; readonly message: string }
  readonly at: number
}

/** Wire shape of the namespace section the card reads and writes. */
export interface EveAccountSection {
  readonly defaultMarketRegionId?: number
  readonly oauthRequest?: { readonly nonce: number }
  readonly oauthDeauthRequest?: { readonly nonce: number; readonly characterId?: number }
  readonly oauthStatus?: OAuthStatusView
  readonly authorizedCharacters?: readonly AccountCharacterView[]
  readonly marketRegions?: readonly MarketRegionView[]
}

/** What the card renders. */
export interface EveAccountCardState {
  /** Whether the namespace is exposed and accepted. */
  readonly available: boolean
  readonly writable: boolean
  /** Region catalog (host publishes it in the base layer). */
  readonly regions: readonly MarketRegionView[]
  /** Currently selected default market region. */
  readonly regionId: number | undefined
  readonly characters: readonly AccountCharacterView[]
  readonly status: OAuthStatusView | undefined
  /** True while a login flow is in flight. */
  readonly busy: boolean
}

/** The registration-side face the card's slot entry injects. */
export interface EveAccountCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useEveAccountCard. */
    eveAccountCard: {
      getSnapshot(): EveAccountCardState
      subscribe(listener: () => void): () => void
    }
  }
  /** Namespace-bound translate (bound at apply time). */
  t: (key: EveAccountLocaleKey) => string
  /** Arm an EVE SSO login (one-shot trigger write). */
  login(): void
  /** Arm a deauthorize (one-shot trigger write; omit characterId to revoke all). */
  deauth(characterId?: number): void
  /** Persist the default market region. */
  setRegion(regionId: number): void
}

const LOGIN_PHASES = new Set(['starting', 'waiting'])

export class EveAccountCardController {
  private state: EveAccountCardState
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly scope: SettingsScope<EveAccountSection>,
    private readonly t: (key: EveAccountLocaleKey) => string,
  ) {
    this.state = this.project()
    this.scope.subscribe(() => {
      const next = this.project()
      if (next === this.state) return
      this.state = next
      for (const listener of this.listeners) listener()
    })
  }

  getSnapshot(): EveAccountCardState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Arm an EVE SSO login. */
  login(): void {
    void this.scope.set('oauthRequest', { nonce: Date.now() }).catch(() => {})
  }

  /** Arm a deauthorize (all characters when characterId is omitted). */
  deauth(characterId?: number): void {
    void this.scope.set('oauthDeauthRequest', characterId === undefined
      ? { nonce: Date.now() }
      : { nonce: Date.now(), characterId }).catch(() => {})
  }

  /** Persist the default market region. */
  setRegion(regionId: number): void {
    void this.scope.set('defaultMarketRegionId', regionId).catch(() => {})
  }

  /** Build the face the card's slot registration injects. */
  inject(): EveAccountCardFace {
    return {
      hooks: {
        eveAccountCard: {
          getSnapshot: () => this.getSnapshot(),
          subscribe: (listener) => this.subscribe(listener),
        },
      },
      t: this.t,
      login: () => this.login(),
      deauth: (characterId) => this.deauth(characterId),
      setRegion: (regionId) => this.setRegion(regionId),
    }
  }

  private project(): EveAccountCardState {
    const snapshot = this.scope.getSnapshot()
    const available = snapshot.status === 'ready'
    const value = available ? snapshot.value : undefined
    const status = value?.oauthStatus
    return {
      available,
      writable: available && snapshot.writable,
      regions: value?.marketRegions ?? [],
      regionId: value?.defaultMarketRegionId,
      characters: value?.authorizedCharacters ?? [],
      status,
      busy: status !== undefined && LOGIN_PHASES.has(status.phase),
    }
  }
}
