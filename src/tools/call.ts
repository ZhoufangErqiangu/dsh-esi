/**
 * `esi_call` — the generic dispatcher that can call ANY of the 204 ESI
 * endpoints without loading them as tools. Validates arguments against the
 * generated catalog, then hands the request to the EsiaClient (auth, pacing,
 * retry, pagination, caching, error normalization all happen inside).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { ENDPOINT_INDEX, ENDPOINTS } from '../generated/catalog.ts'
import type { EsiaClient } from '../esia-client.ts'

export function createCallTool(client: EsiaClient) {
  return defineTool({
    name: 'esi_call',
    description:
      'Call any ESI endpoint by its exact operationId (obtain it from esi_endpoint_search). '
      + 'Provide path_params for the {placeholders} in the path template, query_params for optional/required query '
      + 'parameters, and body for endpoints that need a request body. The dispatcher attaches OAuth tokens when the '
      + 'endpoint requires scopes, respects ESI rate limits with retries, and returns {data, meta} where meta carries '
      + 'status, pagination info (pages), and required scopes. For paginated endpoints use pages="auto" to fetch all '
      + 'pages (capped) or pages="first" for page 1 only.',
    parameters: {
      operation_id: { type: 'string', required: true, description: 'Exact operationId from esi_endpoint_search, e.g. get_characters_character_id_assets.' },
      path_params: { type: 'json', description: 'Values for the path template placeholders, keyed by parameter name, e.g. {"character_id": 95465499}.' },
      query_params: { type: 'json', description: 'Query parameters keyed by name (page is managed by the pages option).' },
      body: { type: 'json', description: 'Request body for POST/PUT endpoints (endpoints with a body flag).' },
      pages: { type: 'string', enum: ['first', 'auto'], description: 'first = page 1 only (default); auto = follow X-Pages and concatenate, capped.' },
      language: { type: 'string', description: 'Optional response language, e.g. "zh", "en-us" (server-dependent).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
    },
    async execute(args): Promise<JsonValue> {
      const operationId = String(args.operation_id)
      const index = ENDPOINT_INDEX[operationId]
      const endpoint = index === undefined ? undefined : ENDPOINTS[index]
      if (endpoint === undefined) {
        throw new Error(
          `unknown operationId "${operationId}" — search the catalog first with esi_endpoint_search, `
          + 'or call it with esi_endpoint_search to discover the exact operationId',
        )
      }
      const pages = args.pages === 'auto' ? 'auto' : 'first'
      const result = await client.call(
        endpoint,
        {
          pathParams: args.path_params as Record<string, unknown> | undefined,
          queryParams: args.query_params as Record<string, unknown> | undefined,
          body: args.body,
        },
        { pages, language: args.language === undefined ? undefined : String(args.language) },
      )
      return { operation_id: operationId, data: result.data, meta: result.meta } as unknown as JsonValue
    },
  })
}
