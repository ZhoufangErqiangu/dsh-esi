/**
 * dsh-esi plugin — bridges EVE Online ESI API and SDE static data into DSH.
 *
 * Tool-surface strategy (see docs/design.md §3): the model never sees all 204
 * ESI endpoints at once. The always-visible surface stays tiny (~9 tools) and
 * the endpoint catalog is queried on demand; hot endpoints can be materialized
 * as native tools per agent via `esi_endpoint_load` (Phase 3).
 *
 * Phase 0/1 status: this module establishes the plugin contract
 * (`name` / `inject` / `apply`) and the generated endpoint catalog; the only
 * registered tool is `esi_status`. Endpoint search, the generic dispatcher,
 * on-demand materialization, OAuth, and the SDE surface arrive in later phases.
 *
 * @module dsh-esi
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import {
  ENDPOINTS,
  SCOPES,
  SERVERS,
  SWAGGER_VERSION,
  TAGS,
} from './generated/catalog.ts'

export const name = 'dsh-esi'
export const inject = ['tools'] as const

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'esi_status',
    description:
      'Report the current state of the ESI plugin: swagger version the endpoint catalog was generated from, '
      + 'the available ESI servers (CN Serenity mirror and global Tranquility) with their base URLs and datasource '
      + 'values, and summary statistics of the 204-endpoint catalog (total, requiring OAuth, paginated, tags, scopes). '
      + 'Call this first to orient yourself before searching for endpoints.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(): Promise<JsonValue> {
      const authed = ENDPOINTS.filter((endpoint) => endpoint.scopes.length > 0).length
      const paginated = ENDPOINTS.filter((endpoint) => endpoint.paginated).length
      const servers = Object.fromEntries(
        Object.values(SERVERS).map((server) => [
          server.id,
          {
            label: server.label,
            esiBase: server.esiBase,
            loginBase: server.loginBase,
            datasource: server.datasource,
            datasourceOptions: server.datasourceOptions,
            languageOptions: server.languageOptions,
          },
        ]),
      )
      return Promise.resolve({
        plugin: name,
        swaggerVersion: SWAGGER_VERSION,
        endpointCount: ENDPOINTS.length,
        authedEndpointCount: authed,
        paginatedEndpointCount: paginated,
        tagCount: TAGS.length,
        scopeCount: SCOPES.length,
        servers,
      } as unknown as JsonValue)
    },
  }))
}
