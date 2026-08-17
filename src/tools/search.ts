/**
 * `esi_endpoint_search` — the only entry point into the 204-endpoint catalog.
 *
 * The catalog is deliberately NOT part of the system prompt; the model queries
 * it on demand and receives only the matching subset, keeping the always-
 * visible tool surface tiny (the core tool-explosion mitigation).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { ENDPOINTS } from '../generated/catalog.ts'
import type { CatalogEndpoint } from '../catalog-types.ts'

export interface SearchMatch {
  readonly operationId: string
  readonly method: string
  readonly path: string
  readonly tags: readonly string[]
  readonly summary: string
  readonly scopes: readonly string[]
  readonly requiredPathParams: readonly string[]
  readonly paginated: boolean
  readonly hasBody: boolean
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 30

function scoreEndpoint(endpoint: CatalogEndpoint, tokens: readonly string[]): number {
  const opId = endpoint.operationId.toLowerCase()
  const path = endpoint.path.toLowerCase()
  const summary = endpoint.summary.toLowerCase()
  const tags = endpoint.tags.join(' ').toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (opId.includes(token)) score += 3
    if (path.includes(token)) score += 2
    if (summary.includes(token)) score += 2
    if (tags.includes(token)) score += 2
    if (endpoint.operationId.split('_').includes(token)) score += 1
  }
  if (tokens.length > 0 && tokens.every((token) => opId.includes(token))) score += 5
  return score
}

function toMatch(endpoint: CatalogEndpoint): SearchMatch {
  return {
    operationId: endpoint.operationId,
    method: endpoint.method,
    path: endpoint.path,
    tags: endpoint.tags,
    summary: endpoint.summary,
    scopes: endpoint.scopes,
    requiredPathParams: endpoint.pathParams.filter((p) => p.required).map((p) => p.name),
    paginated: endpoint.paginated,
    hasBody: endpoint.body !== undefined,
  }
}

export function createSearchTool() {
  return defineTool({
    name: 'esi_endpoint_search',
    description:
      'Search the ESI endpoint catalog (204 endpoints) by keywords or by domain tag. This is the only way to discover '
      + 'which ESI endpoint does what — the catalog is not listed in the prompt. Returns compact matches with the '
      + 'operationId, method, path template, required path parameters, OAuth scopes, and pagination support. Call this '
      + 'before esi_call or esi_endpoint_load; then pass an exact operationId to those tools.',
    parameters: {
      query: { type: 'string', description: 'Free-text keywords, e.g. "market orders", "character assets", "skill queue". Matches operationId, path, summary, and tags.' },
      tag: { type: 'string', description: 'Restrict to one domain tag, e.g. Character, Market, Industry, Fleets, Corporation. Omit to search all.' },
      limit: { type: 'integer', description: `Max matches to return (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT}).` },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(args): Promise<JsonValue> {
      const query = (args.query ?? '').toString().trim()
      const tag = args.tag === undefined ? undefined : String(args.tag)
      const limit = Math.min(
        Math.max(args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit), 1),
        MAX_LIMIT,
      )
      const tokens = query.toLowerCase().split(/\s+/).filter((token) => token.length > 0)

      let candidates = ENDPOINTS
      if (tag !== undefined) {
        const wanted = tag.toLowerCase()
        candidates = candidates.filter((endpoint) =>
          endpoint.tags.some((candidate) => candidate.toLowerCase() === wanted),
        )
      }

      const scored = candidates
        .map((endpoint) => ({ endpoint, score: scoreEndpoint(endpoint, tokens) }))
        .filter((entry) => tokens.length === 0 || entry.score > 0)
        .sort((a, b) => b.score - a.score || (a.endpoint.operationId < b.endpoint.operationId ? -1 : 1))

      const matches = scored.slice(0, limit).map((entry) => toMatch(entry.endpoint))
      return Promise.resolve({
        query,
        ...(tag !== undefined ? { tag } : {}),
        count: matches.length,
        totalMatches: scored.length,
        matches,
      } as unknown as JsonValue)
    },
  })
}
