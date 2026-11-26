/**
 * Wire protocol shared by the Host bridge (`src/ui/bridge.ts`) and the
 * browser half (`src/client/`).
 *
 * The host exposes one small JSON surface over the Web server; the cards poll
 * `state` and POST one action per user gesture. Keeping the shapes here — a
 * dependency-free module with no `node:` or Cordis imports — lets both halves
 * share one declaration instead of maintaining mirrored copies.
 *
 * @module @dsh-esi/plugin-esi
 */

/** Base path of the browser bridge; also the Web server route prefix. */
export const BRIDGE_PREFIX = '/dsh-esi/api'

/** Endpoints the browser half calls, relative to the page origin. */
export const BRIDGE_ENDPOINTS = {
  state: `${BRIDGE_PREFIX}/state`,
  sdeUpdate: `${BRIDGE_PREFIX}/sde/update`,
  sdeRollback: `${BRIDGE_PREFIX}/sde/rollback`,
  login: `${BRIDGE_PREFIX}/account/login`,
  deauthorize: `${BRIDGE_PREFIX}/account/deauthorize`,
  region: `${BRIDGE_PREFIX}/account/region`,
} as const

/** Phases of the SDE download/install pipeline. */
export type SdeUiPhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'extracting'
  | 'building'
  | 'installing'
  | 'done'
  | 'error'

/** Typed update/rollback failure; `code` is stable, `message` is a raw fallback. */
export interface SdeUiError {
  readonly code: string
  /** Raw fallback text (zh) for logs / non-GUI consumers. */
  readonly message: string
  /** Interpolation params for the code-keyed client translation. */
  readonly params?: Readonly<Record<string, string | number>>
}

/** One SDE update/rollback status snapshot. */
export interface SdeUiStatus {
  readonly phase: SdeUiPhase
  /** Dictionary key of the status line; absent → the card renders `message` raw. */
  readonly messageKey?: string
  /** Interpolation params for `messageKey`. */
  readonly messageParams?: Readonly<Record<string, string | number>>
  /** Raw fallback text (zh). */
  readonly message: string
  /** 0..1 download progress; present only while downloading. */
  readonly progress?: number
  readonly error?: SdeUiError
  /** Active build after a successful update/rollback. */
  readonly currentBuild?: number
  /** Build that was active before the last update. */
  readonly previousBuild?: number
  readonly at: number
}

/** One authorized EVE character as surfaced to the card. */
export interface AccountCharacter {
  readonly characterId: number
  readonly characterName: string
  readonly scopes: readonly string[]
  readonly expiresAt: number
  readonly expired: boolean
}

/** One market region the default-region picker offers. */
export interface MarketRegion {
  readonly id: number
  readonly name: string
}

/** Phases of the browser-driven EVE SSO login. */
export type LoginPhase = 'idle' | 'starting' | 'waiting' | 'done' | 'error'

/** One EVE SSO login status snapshot. */
export interface LoginStatus {
  readonly phase: LoginPhase
  readonly messageKey?: string
  readonly messageParams?: Readonly<Record<string, string | number>>
  /** Raw fallback text (zh). */
  readonly message: string
  /** Login URL to open; present while `waiting`. */
  readonly loginUrl?: string
  readonly error?: { readonly code: string; readonly message: string }
  readonly at: number
}

/** SDE half of the bridge state. */
export interface SdeUiSection {
  /** False when the Host cannot offer the bridge at all (no Web server). */
  readonly available: boolean
  readonly status: SdeUiStatus
  /** Installed SDE builds, newest first. */
  readonly versions: readonly number[]
  /** Configured default mirror URL the card prefills. */
  readonly defaultUpdateUrl?: string
}

/** Account half of the bridge state. */
export interface AccountUiSection {
  readonly available: boolean
  readonly characters: readonly AccountCharacter[]
  readonly regions: readonly MarketRegion[]
  /** The region the market tools use when the caller omits one. */
  readonly defaultRegionId?: number
  readonly status: LoginStatus
}

/** Complete state the cards poll. `revision` bumps on every change. */
export interface EsiUiState {
  readonly revision: number
  readonly sde: SdeUiSection
  readonly account: AccountUiSection
}

/** Success envelope for every bridge response. */
export interface BridgeResponse {
  readonly ok: true
  readonly state: EsiUiState
}

/** Failure envelope; `status` is the HTTP status the Host answered with. */
export interface BridgeFailure {
  readonly ok: false
  readonly status: number
  readonly error: { readonly code: string; readonly message: string }
}
