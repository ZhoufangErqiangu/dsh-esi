/**
 * Persisted EVE SSO token store.
 *
 * One record per (server, characterId). Tokens are stored in a plain JSON
 * file under a configurable path (default `$DSH_HOME/dsh-esi/auth.json` or
 * `~/.dsh-esi/auth.json`); writes are atomic (tmp + rename). The store is
 * self-contained — no service dependency — so it works in any DSH profile.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ServerId } from '../catalog-types.ts'

export interface StoredToken {
  readonly server: ServerId
  readonly characterId: number
  readonly characterName: string
  readonly accessToken: string
  readonly scopes: readonly string[]
  /** Epoch ms after which the access token is expired. */
  readonly expiresAt: number
  readonly updatedAt: number
}

/** Grace margin before expiry so we never hand the client a dying token. */
const EXPIRY_MARGIN_MS = 60_000

export class TokenStore {
  private readonly path: string
  private tokens: StoredToken[] = []

  constructor(path: string) {
    this.path = path
    this.load()
  }

  list(server?: ServerId): StoredToken[] {
    return this.tokens
      .filter((token) => server === undefined || token.server === server)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(server: ServerId, characterId: number): StoredToken | undefined {
    return this.tokens.find((token) => token.server === server && token.characterId === characterId)
  }

  /** Upsert one token record keyed by (server, characterId). */
  put(token: StoredToken): void {
    const index = this.tokens.findIndex(
      (candidate) => candidate.server === token.server && candidate.characterId === token.characterId,
    )
    if (index >= 0) this.tokens[index] = token
    else this.tokens.push(token)
    this.save()
  }

  remove(server: ServerId, characterId: number): boolean {
    const before = this.tokens.length
    this.tokens = this.tokens.filter((token) => !(token.server === server && token.characterId === characterId))
    const removed = this.tokens.length !== before
    if (removed) this.save()
    return removed
  }

  /**
   * Resolve a usable access token covering `requiredScopes` for `server`.
   * Prefers `preferCharacterId` when it qualifies; otherwise the token with
   * the fewest extra scopes, then the most recently updated.
   */
  resolve(server: ServerId, requiredScopes: readonly string[], preferCharacterId?: number): string | undefined {
    const now = Date.now() + EXPIRY_MARGIN_MS
    const usable = this.tokens
      .filter((token) => token.server === server && token.expiresAt > now)
      .filter((token) => requiredScopes.every((scope) => token.scopes.includes(scope)))
      .sort((a, b) => {
        const aPref = a.characterId === preferCharacterId ? 1 : 0
        const bPref = b.characterId === preferCharacterId ? 1 : 0
        if (aPref !== bPref) return bPref - aPref
        const aExtra = a.scopes.length - requiredScopes.length
        const bExtra = b.scopes.length - requiredScopes.length
        if (aExtra !== bExtra) return aExtra - bExtra
        return b.updatedAt - a.updatedAt
      })
    return usable[0]?.accessToken
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, 'utf8')
      const parsed = JSON.parse(raw) as { tokens?: StoredToken[] }
      if (Array.isArray(parsed.tokens)) {
        this.tokens = parsed.tokens
      }
    } catch {
      this.tokens = []
    }
  }

  private save(): void {
    const dir = dirname(this.path)
    mkdirSync(dir, { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({ tokens: this.tokens }, null, 2), 'utf8')
    renameSync(tmp, this.path)
  }
}
