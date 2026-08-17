/**
 * dsh-esi plugin — bridges EVE Online ESI API and SDE static data into DSH.
 *
 * Tool-surface strategy (see docs/design.md §3): the model never sees all 204
 * ESI endpoints at once. The always-visible surface stays tiny (search +
 * generic dispatcher + on-demand materializer + auth + status), the endpoint
 * catalog is queried on demand via esi_endpoint_search, and hot endpoints can
 * be materialized as native tools per agent via esi_endpoint_load.
 *
 * Phase 4 status: OAuth authorization (esi_authorize via a loopback callback),
 * token persistence, per-agent scoped materialization, and approval-gated
 * mutating calls are implemented. SDE query/update arrive in later phases.
 *
 * @module dsh-esi
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { EsiaAuthService } from './auth/service.ts'
import { TokenStore } from './auth/token-store.ts'
import type { EsiaAbortSignal, EsiaClientConfig, ServerId } from './esia-client.ts'
import { EsiaClient } from './esia-client.ts'
import {
  ENDPOINT_INDEX,
  ENDPOINTS,
  SCOPES,
  SERVERS,
  SWAGGER_VERSION,
  TAGS,
} from './generated/catalog.ts'
import { ESI_GUIDE, ESI_GUIDE_SECTION_NAME } from './prompt.ts'
import { SdeService } from './sde/service.ts'
import { SdeUpdater } from './sde/update.ts'
import { SdeGuiRunner, type SdeGuiStatus } from './sde/gui-runner.ts'
import { createSdeQueryTool, createSdeStatusTool } from './tools/sde.ts'
import { createSdeRollbackTool, createSdeUpdateTool } from './tools/sde-update.ts'
import { createAccountsTool, createAuthorizeTool, createDeauthorizeTool } from './tools/authorize.ts'
import { createCallTool } from './tools/call.ts'
import { createItemLookupTool } from './tools/item-lookup.ts'
import { createLoadTool } from './tools/load.ts'
import { createMarketPricesTool } from './tools/market-prices.ts'
import { createSearchTool } from './tools/search.ts'

export const name = 'dsh-esi'
export const inject = ['tools', 'systemPrompt'] as const

export interface EsiaPluginConfig {
  /** ESI server profile: 'cn' (NetEase Serenity mirror) or 'global' (Tranquility). */
  server?: ServerId
  ratePerSecond?: number
  maxPages?: number
  maxRetries?: number
  /** Per-agent cap on materialized endpoint tools. */
  maxMaterialized?: number
  /** Custom transport (tests/debugging); defaults to the global fetch. */
  fetchImpl?: EsiaClientConfig['fetchImpl']
  /** EVE developer-app client id per server (required for esi_authorize). */
  clientIds?: Partial<Record<ServerId, string>>
  /** Loopback redirect host for the SSO callback (default 127.0.0.1). */
  callbackHost?: string
  /** Loopback redirect port (default 32418); register it as a callback URL. */
  callbackPort?: number
  /** Preferred character when several stored tokens qualify for a scope set. */
  defaultCharacterId?: number
  /** Where authorized tokens are persisted. */
  authStorePath?: string
  /** Called with the EVE login URL when esi_authorize starts (auto-open browser / tests). */
  onFlowStart?: (url: string) => void
  /** Root of the SDE data tree (default: <package>/data). */
  dataRoot?: string
  /** Default SDE localization for name/description fields (default en). */
  sdeLanguage?: 'de' | 'en' | 'es' | 'fr' | 'ja' | 'ko' | 'ru' | 'zh'
  /** SDE update source (default: none — sde_update reports how to configure). */
  sdeUpdateSource?: import('./sde/update.ts').SdeUpdateSource
}

export function apply(ctx: Context, config: EsiaPluginConfig = {}): void {
  const serverId = config.server ?? 'cn'
  const storePath = config.authStorePath ?? defaultStorePath()
  const store = new TokenStore(storePath)
  const auth = new EsiaAuthService({
    serverId,
    store,
    clientIds: config.clientIds ?? {},
    callbackHost: config.callbackHost,
    callbackPort: config.callbackPort,
    defaultCharacterId: config.defaultCharacterId,
    fetchImpl: config.fetchImpl,
    onFlowStart: config.onFlowStart,
  })

  const client = new EsiaClient({
    server: serverId,
    tokenProvider: (scopes) => auth.resolveToken(scopes),
    ratePerSecond: config.ratePerSecond,
    maxPages: config.maxPages,
    maxRetries: config.maxRetries,
    fetchImpl: config.fetchImpl,
  })

  const sde = new SdeService({
    dataRoot: config.dataRoot ?? defaultDataRoot(),
    defaultLanguage: config.sdeLanguage,
  })
  // The updater needs no source for rollback; plan/run against a source are
  // gated on sdeUpdateSource being configured (they raise a clear error).
  const updater = new SdeUpdater({
    dataRoot: config.dataRoot ?? defaultDataRoot(),
    source: config.sdeUpdateSource,
    defaultLanguage: config.sdeLanguage,
  })
  // URL-driven updates: sde_update accepts a download URL (zip mirror) even
  // without a configured source. The runner reports progress through status
  // callbacks; here they are collected and the final status returned.
  const sdeRunner = new SdeGuiRunner({
    dataRoot: config.dataRoot ?? defaultDataRoot(),
    defaultLanguage: config.sdeLanguage,
  })
  const urlRunner = (url: string, signal: EsiaAbortSignal | undefined): Promise<unknown> => {
    let last: SdeGuiStatus | undefined
    return sdeRunner.runUpdate(url, (status) => { last = status }, signal as AbortSignal | undefined)
      .then(() => last as unknown)
  }

  ctx.systemPrompt.section({ name: ESI_GUIDE_SECTION_NAME, order: 116, text: ESI_GUIDE })

  ctx.tools.register(createStatusTool(client, auth))
  ctx.tools.register(createSdeStatusTool(sde))
  ctx.tools.register(createSdeQueryTool(sde))
  ctx.tools.register(createSdeUpdateTool(updater, urlRunner))
  ctx.tools.register(createSdeRollbackTool(updater))
  ctx.tools.register(createSearchTool())
  ctx.tools.register(createCallTool(client))
  ctx.tools.register(createLoadTool(client, { cap: config.maxMaterialized }))
  // Hot-path tools: price snapshots and item-name resolution are the most
  // frequently repeated patterns (see the manufacturing session analysis) —
  // both get dedicated first-class tools instead of raw multi-call workflows.
  ctx.tools.register(createItemLookupTool(sde))
  ctx.tools.register(createMarketPricesTool(client, sde))
  ctx.tools.register(createAuthorizeTool(auth))
  ctx.tools.register(createAccountsTool(auth))
  ctx.tools.register(createDeauthorizeTool(auth))

  // Approval gate: mutating ESI calls (POST/PUT/DELETE) require user approval.
  // The registry turns `ask` into a denial when no approval service is mounted.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    const mutation = mutatingOperation(exec.name, exec.arguments)
    if (mutation === undefined) return decision
    return {
      kind: 'ask',
      reason: `ESI mutating call "${exec.name}" → ${mutation.method} ${mutation.path} (${mutation.operationId}) — this changes EVE data and needs user approval`,
    }
  })
}

function mutatingOperation(toolName: string, args: unknown): { operationId: string; method: string; path: string } | undefined {
  const find = (operationId: string) => {
    const index = ENDPOINT_INDEX[operationId]
    if (index === undefined) return undefined
    const endpoint = ENDPOINTS[index]
    if (endpoint === undefined) return undefined
    if (endpoint.method === 'GET') return undefined
    return { operationId: endpoint.operationId, method: endpoint.method, path: endpoint.path }
  }
  if (toolName === 'esi_call') {
    const operationId = (args as { operation_id?: unknown } | undefined)?.operation_id
    if (typeof operationId === 'string') return find(operationId)
    return undefined
  }
  if (toolName.startsWith('esi_')) {
    return find(toolName.slice('esi_'.length))
  }
  return undefined
}

function defaultStorePath(): string {
  const home = process.env.DSH_HOME ?? homedir()
  return join(home, '.dsh-esi', 'auth.json')
}

function defaultDataRoot(): string {
  return fileURLToPath(new URL('../data/', import.meta.url))
}

function createStatusTool(client: EsiaClient, auth: EsiaAuthService) {
  return defineTool({
    name: 'esi_status',
    description:
      'Report the current state of the ESI plugin: active server profile (CN Serenity mirror or global Tranquility) '
      + 'with its base URL and datasource value, the swagger version the endpoint catalog was generated from, catalog '
      + 'statistics (total endpoints, requiring OAuth, paginated, tags, scopes), and the authorized EVE characters for '
      + 'the active server. Call this first to orient yourself before searching for endpoints.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(): Promise<JsonValue> {
      const authed = ENDPOINTS.filter((endpoint) => endpoint.scopes.length > 0).length
      const paginated = ENDPOINTS.filter((endpoint) => endpoint.paginated).length
      const server = client.serverProfile
      const servers = Object.fromEntries(
        Object.values(SERVERS).map((profile) => [
          profile.id,
          {
            label: profile.label,
            esiBase: profile.esiBase,
            loginBase: profile.loginBase,
            datasource: profile.datasource,
            datasourceOptions: profile.datasourceOptions,
            languageOptions: profile.languageOptions,
          },
        ]),
      )
      const accounts = auth.listAccounts().map((token) => ({
        characterId: token.characterId,
        characterName: token.characterName,
        scopes: token.scopes,
        expiresAt: token.expiresAt,
        expired: token.expiresAt <= Date.now(),
      }))
      return Promise.resolve({
        plugin: name,
        activeServer: {
          id: server.id,
          label: server.label,
          esiBase: server.esiBase,
          datasource: server.datasource,
        },
        swaggerVersion: SWAGGER_VERSION,
        endpointCount: ENDPOINTS.length,
        authedEndpointCount: authed,
        paginatedEndpointCount: paginated,
        tagCount: TAGS.length,
        scopeCount: SCOPES.length,
        servers,
        authorizedCharacters: accounts,
      } as unknown as JsonValue)
    },
  })
}
