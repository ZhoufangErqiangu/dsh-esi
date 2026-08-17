/**
 * Authorization tools: esi_authorize, esi_accounts, esi_deauthorize.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { EsiaAuthService } from '../auth/service.ts'
import { SCOPES } from '../generated/catalog.ts'

const MAX_WAIT_SECONDS = 600

export function createAuthorizeTool(auth: EsiaAuthService) {
  return defineTool({
    name: 'esi_authorize',
    description:
      'Authorize EVE SSO for the current server: request the given OAuth scopes for one of the user\'s characters. '
      + 'The tool returns a login URL — the user must open it in a browser and complete the EVE login; the plugin '
      + 'captures the token via a local callback and verifies the character. The call blocks until the login completes '
      + 'or wait_seconds elapses. After success, protected endpoints (esi_call and materialized tools) automatically '
      + 'use this token. Scope names come from the EVE SSO scope table (e.g. esi-assets.read_assets.v1, '
      + 'esi-skills.read_skills.v1, esi-wallet.read_character_wallet.v1).',
    parameters: {
      scopes: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'EVE SSO scopes to request, e.g. ["esi-assets.read_assets.v1", "esi-skills.read_skills.v1"].',
      },
      wait_seconds: {
        type: 'integer',
        description: `How long to wait for the browser login (default 120, max ${MAX_WAIT_SECONDS}).`,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec): Promise<JsonValue> {
      const scopes = args.scopes as unknown as string[]
      if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new Error('esi_authorize requires a non-empty scopes array')
      }
      const waitSeconds = Math.min(
        Math.max(args.wait_seconds === undefined ? 120 : Number(args.wait_seconds), 5),
        MAX_WAIT_SECONDS,
      )
      const result = await auth.authorize(scopes, waitSeconds * 1000, exec.signal)
      return result as unknown as JsonValue
    },
    timeoutMs: (MAX_WAIT_SECONDS + 5) * 1000,
  })
}

export function createAccountsTool(auth: EsiaAuthService) {
  return defineTool({
    name: 'esi_accounts',
    description:
      'List the EVE characters authorized for the current server, with their granted scopes and token expiry. '
      + 'Use this to see which character a protected call will act as, and which scopes are still missing.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(): Promise<JsonValue> {
      const accounts = auth.listAccounts().map((token) => ({
        characterId: token.characterId,
        characterName: token.characterName,
        scopes: token.scopes,
        expiresAt: token.expiresAt,
        expired: token.expiresAt <= Date.now(),
      }))
      return Promise.resolve({ server: auth.serverProfile.id, accounts } as unknown as JsonValue)
    },
  })
}

export function createDeauthorizeTool(auth: EsiaAuthService) {
  return defineTool({
    name: 'esi_deauthorize',
    description:
      'Remove stored EVE SSO authorization(s) for the current server. With character_id, removes that character only; '
      + 'without it, removes all. Returns the names of the removed characters. Authorization is also lost automatically '
      + 'when tokens expire.',
    parameters: {
      character_id: { type: 'integer', description: 'Character to deauthorize; omit to deauthorize all characters on this server.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(args): Promise<JsonValue> {
      const removed = auth.deauthorize(args.character_id === undefined ? undefined : Number(args.character_id))
      return Promise.resolve({
        server: auth.serverProfile.id,
        removedCharacters: removed,
        remaining: auth.listAccounts().map((token) => token.characterName),
      } as unknown as JsonValue)
    },
  })
}

/** For the guide: the most commonly requested scopes, for quick reference. */
export function commonScopes(): string[] {
  const preferred = [
    'esi-assets.read_assets.v1',
    'esi-skills.read_skills.v1',
    'esi-wallet.read_character_wallet.v1',
    'esi-location.read_location.v1',
    'esi-mail.read_mail.v1',
    'esi-characters.read_contacts.v1',
    'esi-universe.read_structures.v1',
  ]
  const known = new Set(SCOPES.map((entry) => entry.scope))
  return preferred.filter((scope) => known.has(scope))
}
