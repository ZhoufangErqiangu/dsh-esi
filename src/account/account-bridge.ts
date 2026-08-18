/**
 * Cordis bridge for the account/market settings card: registers the
 * `dsh-esi-account` settings namespace the card binds, watches the OAuth
 * trigger fields (`oauthRequest` / `oauthDeauthRequest`), runs the EVE SSO
 * login (reusing EsiaAuthService.authorize), publishes the login URL and
 * status back to the browser, and exposes the default market region the
 * market tools default to.
 *
 * Unlike the SDE bridge, status publishes go through provider `mutate`
 * path-ops (wholesale key replacement) so the user's `defaultMarketRegionId`
 * setting is never clobbered by a derived-state write.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { EsiaAuthService } from '../auth/service.ts'
import { SCOPES } from '../generated/catalog.ts'
import type { SdeService } from '../sde/service.ts'
import type { SdeLanguage } from '../sde/types.ts'

/** The namespace the account card binds. */
export const ACCOUNT_NS = 'dsh-esi-account'

/** One entry of the market region catalog (localized name + region id). */
export interface MarketRegionEntry {
  readonly id: number
  readonly name: string
}

/** One authorized character as surfaced to the card. */
export interface AccountCharacter {
  readonly characterId: number
  readonly characterName: string
  readonly scopes: readonly string[]
  readonly expiresAt: number
  readonly expired: boolean
}

/** Wire shape of the namespace section. */
export interface AccountSettings {
  readonly defaultMarketRegionId?: number
  readonly oauthRequest?: { readonly nonce: number }
  readonly oauthDeauthRequest?: { readonly nonce: number; readonly characterId?: number }
  readonly oauthStatus?: {
    readonly phase: string
    readonly message: string
    readonly loginUrl?: string
    readonly error?: { readonly code: string; readonly message: string }
    readonly at: number
  }
  readonly authorizedCharacters?: readonly AccountCharacter[]
  readonly marketRegions?: readonly MarketRegionEntry[]
}

/** Schemastery schema for the namespace (validates client writes and host statuses alike). */
export const AccountSettingsSchema = z.object({
  defaultMarketRegionId: z.number().required(false),
  oauthRequest: z.object({
    nonce: z.number(),
  }).required(false),
  oauthDeauthRequest: z.object({
    nonce: z.number(),
    characterId: z.number().required(false),
  }).required(false),
  oauthStatus: z.object({
    phase: z.string(),
    message: z.string(),
    loginUrl: z.string().required(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }).required(false),
    at: z.number(),
  }).required(false),
  authorizedCharacters: z.array(z.object({
    characterId: z.number(),
    characterName: z.string(),
    scopes: z.array(z.string()),
    expiresAt: z.number(),
    expired: z.boolean(),
  })).required(false),
  marketRegions: z.array(z.object({
    id: z.number(),
    name: z.string(),
  })).required(false),
})

export interface AccountBridgeOptions {
  readonly auth: EsiaAuthService
  readonly sde: SdeService
  readonly defaultLanguage?: SdeLanguage
  /** How long the card's login flow waits for the browser redirect (default 180 s). */
  readonly oauthWaitMs?: number
}

/** Curated fallback when no SDE data is installed yet. */
const FALLBACK_REGIONS: readonly MarketRegionEntry[] = [
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

/**
 * The account/market bridge. Instantiated per plugin; `defaultRegionId()`
 * feeds the market tools' region default.
 */
export class AccountBridge {
  private readonly options: AccountBridgeOptions
  private regionId: number | undefined
  private oauthRunning = false
  private lastLoginUrl: string | undefined

  constructor(options: AccountBridgeOptions) {
    this.options = options
  }

  /** The resolved default market region (undefined = fall back to Jita). */
  defaultRegionId(): number | undefined {
    return this.regionId
  }

  /** Mount the bridge; must be called from the plugin apply. */
  attach(ctx: Context): void {
    ctx.inject(['settings'], (settingsCtx) => {
      const scope = settingsCtx.settings.register(
        settingsNamespace(ACCOUNT_NS),
        AccountSettingsSchema,
        { base: { marketRegions: this.buildRegions() } },
      )
      this.regionId = scope.get().defaultMarketRegionId

      const publish = (patch: Partial<AccountSettings>): void => {
        const ops = Object.entries(patch).map(([path, value]) => ({
          op: 'set' as const,
          path: [path],
          value,
        }))
        void (settingsCtx.settings as SettingsProvider).mutate(settingsNamespace(ACCOUNT_NS), ops).catch((error) => {
          settingsCtx.logger.warn(`dsh-esi: failed to publish account status: ${String(error)}`)
        })
      }

      const publishStatus = (phase: string, message: string, loginUrl?: string): void => {
        publish({
          oauthStatus: {
            phase,
            message,
            ...(loginUrl !== undefined ? { loginUrl } : {}),
            at: Date.now(),
          },
        })
      }
      const publishCharacters = (): void => {
        publish({ authorizedCharacters: this.characters() })
      }

      // Initial snapshot: characters + idle status.
      publishCharacters()
      publishStatus('idle', this.characters().length === 0 ? '未授权任何角色' : '已授权角色可正常使用')

      let lastOauthNonce = 0
      let lastDeauthNonce = 0
      settingsCtx.effect(() => {
        const disposer = scope.watch(async (next) => {
          this.regionId = next.defaultMarketRegionId
          const request = next.oauthRequest
          if (typeof request?.nonce === 'number' && request.nonce !== lastOauthNonce && !this.oauthRunning) {
            lastOauthNonce = request.nonce
            await this.runLogin(settingsCtx, publishStatus, publishCharacters)
          }
          const deauth = next.oauthDeauthRequest
          if (typeof deauth?.nonce === 'number' && deauth.nonce !== lastDeauthNonce) {
            lastDeauthNonce = deauth.nonce
            this.auth.deauthorize(deauth.characterId)
            publishCharacters()
          }
        })
        return disposer
      }, 'dsh-esi: account gui watcher')
    })
  }

  // ---- internals ------------------------------------------------------------

  private get auth(): EsiaAuthService {
    return this.options.auth
  }

  private runLogin(
    settingsCtx: Context,
    publishStatus: (phase: string, message: string, loginUrl?: string) => void,
    publishCharacters: () => void,
  ): Promise<void> {
    this.oauthRunning = true
    this.lastLoginUrl = undefined
    publishStatus('starting', '正在启动 EVE 登录…')
    const waitMs = this.options.oauthWaitMs ?? 180_000
    return this.auth.authorize(
      this.cardScopes(),
      waitMs,
      undefined,
      (url) => {
        this.lastLoginUrl = url
        publishStatus('waiting', '请在浏览器中打开链接完成 EVE 登录', url)
      },
    )
      .then((result) => {
        publishStatus('done', `已授权：${result.characterName}`)
      })
      .catch((error: unknown) => {
        publishStatus('error', errorMessage(error), this.lastLoginUrl)
      })
      .finally(() => {
        this.oauthRunning = false
        publishCharacters()
      })
      .catch(() => { /* finally-safety: publishCharacters errors are logged by publish */ })
  }

  private characters(): AccountCharacter[] {
    return this.auth.listAccounts().map((token) => ({
      characterId: token.characterId,
      characterName: token.characterName,
      scopes: [...token.scopes],
      expiresAt: token.expiresAt,
      expired: token.expiresAt <= Date.now(),
    }))
  }

  private cardScopes(): string[] {
    const known = new Set(SCOPES.map((entry) => entry.scope))
    return CARD_SCOPES.filter((scope) => known.has(scope))
  }

  /** Build the market region catalog synchronously from the SDE (fallback to hubs). */
  private buildRegions(): MarketRegionEntry[] {
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
      if (regions.length > 0) {
        return regions.sort((a, b) => a.name.localeCompare(b.name))
      }
    } catch {
      // No SDE data yet — fall through to the curated list.
    }
    return [...FALLBACK_REGIONS]
  }
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error && error.message.length > 0 ? error.message : String(error)
  // authorize() appends the login URL after the message body; the card shows
  // the URL in its own control, so strip that trailer here.
  const marker = raw.indexOf('\n\nAuthorize URL')
  return marker >= 0 ? raw.slice(0, marker) : raw
}
