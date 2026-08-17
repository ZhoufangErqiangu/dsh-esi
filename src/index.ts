/**
 * dsh-esi plugin — bridges EVE Online ESI API and SDE static data into DSH.
 *
 * Tool-surface strategy (see docs/design.md §3): the model never sees all 204
 * ESI endpoints at once. The always-visible surface stays tiny (search +
 * generic dispatcher + on-demand materializer + status), the endpoint catalog
 * is queried on demand via esi_endpoint_search, and hot endpoints can be
 * materialized as native tools per agent via esi_endpoint_load.
 *
 * Phase 2/3 status: EsiaClient (auth/rate-limit/retry/pagination/cache/error
 * normalization), esi_endpoint_search, esi_call, esi_endpoint_load, and the
 * guide section are implemented. OAuth (esi_authorize), SDE query/update,
 * and per-call approval for mutating endpoints arrive in later phases.
 *
 * @module dsh-esi
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { EsiaClientConfig, ServerId } from './esia-client.ts'
import { EsiaClient } from './esia-client.ts'
import {
  ENDPOINTS,
  SCOPES,
  SERVERS,
  SWAGGER_VERSION,
  TAGS,
} from './generated/catalog.ts'
import { ESI_GUIDE, ESI_GUIDE_SECTION_NAME } from './prompt.ts'
import { createCallTool } from './tools/call.ts'
import { createLoadTool } from './tools/load.ts'
import { createSearchTool } from './tools/search.ts'

export const name = 'dsh-esi'
export const inject = ['tools', 'systemPrompt'] as const

export interface EsiaPluginConfig {
  /** ESI server profile: 'cn' (NetEase Serenity mirror) or 'global' (Tranquility). */
  server?: ServerId
  /** Token resolver for OAuth-protected endpoints; wired by the auth phase. */
  tokenProvider?: EsiaClientConfig['tokenProvider']
  ratePerSecond?: number
  maxPages?: number
  maxRetries?: number
  /** Per-agent cap on materialized endpoint tools. */
  maxMaterialized?: number
  /** Custom transport (tests/debugging); defaults to the global fetch. */
  fetchImpl?: EsiaClientConfig['fetchImpl']
}

export function apply(ctx: Context, config: EsiaPluginConfig = {}): void {
  const client = new EsiaClient({
    server: config.server ?? 'cn',
    tokenProvider: config.tokenProvider,
    ratePerSecond: config.ratePerSecond,
    maxPages: config.maxPages,
    maxRetries: config.maxRetries,
    fetchImpl: config.fetchImpl,
  })

  ctx.systemPrompt.section({ name: ESI_GUIDE_SECTION_NAME, order: 116, text: ESI_GUIDE })

  ctx.tools.register(createStatusTool(client))
  ctx.tools.register(createSearchTool())
  ctx.tools.register(createCallTool(client))
  ctx.tools.register(createLoadTool(client, { cap: config.maxMaterialized }))
}

function createStatusTool(client: EsiaClient) {
  return defineTool({
    name: 'esi_status',
    description:
      'Report the current state of the ESI plugin: active server profile (CN Serenity mirror or global Tranquility) '
      + 'with its base URL and datasource value, the swagger version the endpoint catalog was generated from, and '
      + 'catalog statistics (total endpoints, requiring OAuth, paginated, tags, scopes). Call this first to orient '
      + 'yourself before searching for endpoints.',
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
      } as unknown as JsonValue)
    },
  })
}
