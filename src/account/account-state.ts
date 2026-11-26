/**
 * Browser-facing EVE account state: the authorized-character list, the market
 * region catalog, the default region the market tools use, and the EVE SSO
 * login flow the account card triggers.
 *
 * Cordis-free and storage-free (a plain class): the tokens still live in the
 * plugin's `TokenStore`; this class only projects them for the UI and drives
 * one login at a time. `src/ui/bridge.ts` exposes it over HTTP.
 *
 * @module @dsh-esi/plugin-esi
 */

import type { EsiaAuthService } from '../auth/service.ts'
import { SCOPES } from '../generated/catalog.ts'
import type { SdeService } from '../sde/service.ts'
import type { SdeLanguage } from '../sde/types.ts'
import type { AccountCharacter, LoginStatus, MarketRegion } from '../ui/protocol.ts'

export interface AccountUiOptions {
  readonly auth: EsiaAuthService
  readonly sde: SdeService
  readonly defaultLanguage?: SdeLanguage
  /** How long the card's login waits for the browser redirect. */
  readonly oauthWaitMs: number
  /** Initial default market region (from plugin config). */
  readonly defaultRegionId?: number
}

/** Curated fallback when no SDE data is installed yet. */
const FALLBACK_REGIONS: readonly MarketRegion[] = [
  { id: 10000002, name: 'The Forge (Jita)' },
  { id: 10000043, name: 'Domain (Amarr)' },
  { id: 10000032, name: 'Sinq Laison (Dodixie)' },
  { id: 10000030, name: 'Heimatar (Rens)' },
  { id: 10000042, name: 'Metropolis (Hek)' },
  { id: 10000067, name: 'Genesis' },
  { id: 10000069, name: 'Black Rise' },
  { id: 10000068, name: 'Verge Vendor' },
]

/** Scopes the card's login requests (filtered against the swagger table). */
const CARD_SCOPES = [
  'esi-assets.read_assets.v1',
  'esi-skills.read_skills.v1',
  'esi-wallet.read_character_wallet.v1',
  'esi-markets.read_character_orders.v1',
  'esi-industry.read_character_jobs.v1',
  'esi-location.read_location.v1',
  'esi-characters.read_contacts.v1',
  'esi-universe.read_structures.v1',
]

export class AccountUi {
  private readonly options: AccountUiOptions
  private regionId: number | undefined
  private oauthRunning = false
  private loginStatus: LoginStatus
  private regionsCache: MarketRegion[] | undefined
  private readonly listeners = new Set<() => void>()

  constructor(options: AccountUiOptions) {
    this.options = options
    this.regionId = options.defaultRegionId
    this.loginStatus = this.idleStatus()
  }

  /** The resolved default market region (undefined = fall back to Jita). */
  defaultRegionId(): number | undefined {
    return this.regionId
  }

  /** Whether a login flow is in flight. */
  get busy(): boolean {
    return this.oauthRunning
  }

  /** Current login status. */
  status(): LoginStatus {
    return this.loginStatus
  }

  /** Authorized characters for the active server, expired tokens included. */
  characters(): AccountCharacter[] {
    return this.options.auth.listAccounts().map((token) => ({
      characterId: token.characterId,
      characterName: token.characterName,
      scopes: [...token.scopes],
      expiresAt: token.expiresAt,
      expired: token.expiresAt <= Date.now(),
    }))
  }

  /** Market regions offered by the picker (SDE when available, hubs otherwise). */
  regions(): MarketRegion[] {
    if (this.regionsCache === undefined) this.regionsCache = this.buildRegions()
    return this.regionsCache
  }

  /** Run one browser-driven login; resolves with the settled status. */
  async login(): Promise<LoginStatus> {
    if (this.oauthRunning) return this.loginStatus
    this.oauthRunning = true
    this.publish('starting', '正在启动 EVE 登录…', { messageKey: 'status.starting' })
    let loginUrl: string | undefined
    try {
      const result = await this.options.auth.authorize(
        this.cardScopes(),
        this.options.oauthWaitMs,
        undefined,
        (url) => {
          loginUrl = url
          this.publish('waiting', '请在浏览器中打开链接完成 EVE 登录', {
            messageKey: 'status.waiting',
            loginUrl: url,
          })
        },
      )
      this.publish('done', `已授权：${result.characterName}`, {
        messageKey: 'status.authorized',
        messageParams: { name: result.characterName },
      })
    } catch (error) {
      this.publish('error', stripAuthorizeTrailer(errorMessage(error)), {
        loginUrl,
        error: { code: 'LOGIN_FAILED', message: errorMessage(error) },
      })
    } finally {
      this.oauthRunning = false
      this.notify()
    }
    return this.loginStatus
  }

  /** Revoke one character (or every character when `characterId` is omitted). */
  deauthorize(characterId?: number): string[] {
    const removed = this.options.auth.deauthorize(characterId)
    this.publish(
      'idle',
      this.characters().length === 0 ? '未授权任何角色' : '已授权角色可正常使用',
      { messageKey: this.characters().length === 0 ? 'status.idle.noCharacters' : 'status.idle.authorized' },
    )
    return removed
  }

  /** Select the default market region, or clear it with `undefined`. */
  setRegion(regionId: number | undefined): boolean {
    if (regionId !== undefined && !this.regions().some((region) => region.id === regionId)) return false
    this.regionId = regionId
    this.notify()
    return true
  }

  /** Observe state changes that the bridge should publish. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // ---- internals ------------------------------------------------------------

  private idleStatus(): LoginStatus {
    const empty = this.characters().length === 0
    return {
      phase: 'idle',
      messageKey: empty ? 'status.idle.noCharacters' : 'status.idle.authorized',
      message: empty ? '未授权任何角色' : '已授权角色可正常使用',
      at: Date.now(),
    }
  }

  private publish(
    phase: LoginStatus['phase'],
    message: string,
    extra: Pick<LoginStatus, 'messageKey' | 'messageParams' | 'loginUrl' | 'error'> = {},
  ): void {
    this.loginStatus = { phase, message, ...extra, at: Date.now() }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private cardScopes(): string[] {
    const known = new Set(SCOPES.map((entry) => entry.scope))
    return CARD_SCOPES.filter((scope) => known.has(scope))
  }

  /** Build the market region catalog synchronously from the SDE (fallback to hubs). */
  private buildRegions(): MarketRegion[] {
    try {
      const result = this.options.sde.querySync({
        table: 'mapRegions',
        fields: ['_key', 'name'],
        limit: 200,
        language: this.options.defaultLanguage,
      })
      const regions = result.rows
        .map((row) => ({ id: Number(row._key), name: String(row.name) }))
        .filter((entry) => Number.isInteger(entry.id) && entry.name.length > 0)
      if (regions.length > 0) return regions.sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      // No SDE data yet — fall through to the curated list.
    }
    return [...FALLBACK_REGIONS]
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error)
}

/**
 * `authorize()` appends the login URL to its failure message so a CLI caller
 * can still open it; the card renders the URL in its own control, so strip the
 * trailer here.
 */
function stripAuthorizeTrailer(message: string): string {
  const marker = message.indexOf('\n\nAuthorize URL')
  return marker >= 0 ? message.slice(0, marker) : message
}
