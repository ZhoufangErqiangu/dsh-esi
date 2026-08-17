/**
 * Composed ESI auth service: token store + SSO flow + character verification,
 * keyed to the active server profile. This is the single dependency of the
 * authorize/accounts/deauthorize tools and the client's tokenProvider.
 */

import type { ServerId } from '../catalog-types.ts'
import { SERVERS } from '../generated/catalog.ts'
import { SCOPES } from '../generated/catalog.ts'
import type { EsiaAbortSignal, EsiaFetch } from '../esia-client.ts'
import { startAuthorizeFlow, verifyCharacter } from './flow.ts'
import { TokenStore, type StoredToken } from './token-store.ts'

export interface EsiaAuthOptions {
  serverId: ServerId
  store: TokenStore
  /** EVE developer-app client id per server (must be registered for the login used). */
  clientIds: Partial<Record<ServerId, string>>
  /** Loopback redirect host (default 127.0.0.1). */
  callbackHost?: string
  /** Loopback redirect port (default 32418); must be registered as a callback URL. */
  callbackPort?: number
  /** Preferred character for token resolution when several qualify. */
  defaultCharacterId?: number
  fetchImpl?: EsiaFetch
  /** Called with the authorize URL as soon as the flow starts (auto-open browser / tests). */
  onFlowStart?: (url: string) => void
}

export interface AuthorizeResult {
  readonly status: 'authorized'
  readonly characterId: number
  readonly characterName: string
  readonly scopes: readonly string[]
  readonly tokenExpiresAt: number
  readonly server: ServerId
}

export class EsiaAuthService {
  private readonly serverId: ServerId
  private readonly store: TokenStore
  private readonly clientIds: Partial<Record<ServerId, string>>
  private readonly callbackHost: string
  private readonly callbackPort: number
  private readonly defaultCharacterId?: number
  private readonly fetchImpl?: EsiaFetch
  private readonly onFlowStart?: (url: string) => void

  constructor(options: EsiaAuthOptions) {
    this.serverId = options.serverId
    this.store = options.store
    this.clientIds = options.clientIds
    this.callbackHost = options.callbackHost ?? '127.0.0.1'
    this.callbackPort = options.callbackPort ?? 32418
    this.defaultCharacterId = options.defaultCharacterId
    this.fetchImpl = options.fetchImpl
    this.onFlowStart = options.onFlowStart
  }

  get serverProfile() {
    const server = SERVERS[this.serverId]
    if (server === undefined) throw new Error(`unknown ESI server id "${this.serverId}"`)
    return server
  }

  /** Validates requested scopes against the swagger scope table. */
  validateScopes(scopes: readonly string[]): string[] {
    const known = new Set(SCOPES.map((entry) => entry.scope))
    const invalid = scopes.filter((scope) => !known.has(scope))
    if (invalid.length > 0) {
      throw new Error(
        `unknown EVE SSO scope${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')} — known scopes: `
        + `see esi_status (scopeCount) or the swagger scope table`,
      )
    }
    return [...new Set(scopes)]
  }

  listAccounts(): StoredToken[] {
    return this.store.list(this.serverId)
  }

  deauthorize(characterId?: number): string[] {
    if (characterId === undefined) {
      const removed = this.listAccounts().map((token) => token.characterName)
      for (const token of this.listAccounts()) this.store.remove(this.serverId, token.characterId)
      return removed
    }
    const token = this.store.get(this.serverId, characterId)
    if (token === undefined) return []
    this.store.remove(this.serverId, characterId)
    return [token.characterName]
  }

  /** The EsiaClient tokenProvider: best stored token covering the scopes. */
  resolveToken(requiredScopes: readonly string[]): Promise<string | undefined> {
    return Promise.resolve(this.store.resolve(this.serverId, requiredScopes, this.defaultCharacterId))
  }

  /**
   * Run one authorization flow: returns the login URL immediately and awaits
   * the browser redirect. `waitMs` bounds the wait; `signal` aborts it.
   */
  async authorize(
    scopes: readonly string[],
    waitMs: number,
    signal?: EsiaAbortSignal,
  ): Promise<AuthorizeResult> {
    const validated = this.validateScopes(scopes)
    const server = this.serverProfile
    const clientId = this.clientIds[this.serverId]
    if (clientId === undefined || clientId === '') {
      throw new Error(
        `no EVE app client id configured for server "${this.serverId}" (${server.label}) — `
        + 'register an app in the EVE developer portal and configure clientIds in the dsh-esi plugin config',
      )
    }
    const redirectUri = `http://${this.callbackHost}:${this.callbackPort}/callback`
    const flow = startAuthorizeFlow({
      loginBase: server.loginBase,
      clientId,
      redirectUri,
      scopes: validated,
      fetchImpl: this.fetchImpl,
    })
    this.onFlowStart?.(flow.url)
    try {
      const outcome = await waitWithDeadline(flow.result, waitMs, signal)
      const verified = await verifyCharacter(server.loginBase, outcome.accessToken, this.fetchImpl, signal)
      const token: StoredToken = {
        server: this.serverId,
        characterId: verified.characterId,
        characterName: verified.characterName,
        accessToken: outcome.accessToken,
        scopes: verified.scopes.length > 0 ? verified.scopes : validated,
        expiresAt: verified.expiresOn,
        updatedAt: Date.now(),
      }
      this.store.put(token)
      return {
        status: 'authorized',
        characterId: token.characterId,
        characterName: token.characterName,
        scopes: token.scopes,
        tokenExpiresAt: token.expiresAt,
        server: this.serverId,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${message}\n\nAuthorize URL (open it in a browser and complete the login):\n${flow.url}`,
      )
    } finally {
      flow.close()
    }
  }
}

function waitWithDeadline(
  promise: Promise<unknown>,
  waitMs: number,
  signal?: EsiaAbortSignal,
): Promise<AuthorizeOutcomeValue> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`authorization timed out after ${Math.round(waitMs / 1000)}s — open the URL and complete the login within the window`))
    }, waitMs)
    const cleanup = () => clearTimeout(timer)
    promise.then(
      (value) => { cleanup(); resolve(value as AuthorizeOutcomeValue) },
      (error) => { cleanup(); reject(error) },
    )
    if (signal !== undefined) {
      if (signal.aborted) {
        cleanup()
        reject(new Error('authorization cancelled'))
        return
      }
      signal.addEventListener('abort', () => {
        cleanup()
        reject(new Error('authorization cancelled'))
      })
    }
  })
}

interface AuthorizeOutcomeValue {
  readonly accessToken: string
}
