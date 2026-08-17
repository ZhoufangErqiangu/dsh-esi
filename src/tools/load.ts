/**
 * `esi_endpoint_load` — materialize hot ESI endpoints as native tools.
 *
 * A materialized tool (`esi_<operationId>`) is registered into the calling
 * agent's scoped layer (`agent.ctx.tools.register`), so it:
 *  - is visible only to that agent (never pollutes other sessions),
 *  - disappears automatically when the agent context disposes,
 *  - gives the model per-endpoint parameter validation and guidance.
 *
 * The cap bounds how many tools one agent may materialize, so the always-
 * visible surface cannot grow without limit.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ParameterPropertySpec, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ENDPOINT_INDEX, ENDPOINTS } from '../generated/catalog.ts'
import type { CatalogEndpoint, CatalogParam } from '../catalog-types.ts'
import type { EsiaClient } from '../esia-client.ts'
import {
  dropLoaded,
  isLoaded,
  listLoaded,
  loadedCount,
  materializedToolName,
  recordLoaded,
  type EsiaAgentLike,
} from './load-state.ts'

const DEFAULT_CAP = 30

export interface LoadToolOptions {
  cap?: number
}

function paramToSpec(param: CatalogParam): ParameterPropertySpec {
  const required = param.required ? ({ required: true } as const) : {}
  const description = param.description
  switch (param.type) {
    case 'integer':
      return { type: 'integer', ...(param.enum !== undefined ? { enum: param.enum as number[] } : {}), description, ...required }
    case 'number':
      return { type: 'number', ...(param.enum !== undefined ? { enum: param.enum as number[] } : {}), description, ...required }
    case 'boolean':
      return { type: 'boolean', description, ...required }
    case 'array':
      return { type: 'array', items: { type: 'json' }, description, ...required }
    default:
      return { type: 'string', ...(param.enum !== undefined ? { enum: param.enum as string[] } : {}), description, ...required }
  }
}

/** Build a native tool definition for one catalog endpoint. */
export function buildEndpointTool(client: EsiaClient, endpoint: CatalogEndpoint): ToolDefinition {
  const parameters: Record<string, ParameterPropertySpec> = {}
  for (const param of endpoint.pathParams) parameters[param.name] = paramToSpec(param)
  for (const param of endpoint.queryParams) parameters[param.name] = paramToSpec(param)
  if (endpoint.body !== undefined) {
    parameters.body = {
      type: 'json',
      description: endpoint.body.required
        ? `Required request body. ${endpoint.body.description}`.trim()
        : `Optional request body. ${endpoint.body.description}`.trim(),
      ...(endpoint.body.required ? { required: true } : {}),
    }
  }

  const scopeLine = endpoint.scopes.length > 0
    ? `Requires EVE SSO OAuth scopes: ${endpoint.scopes.join(', ')}.`
    : 'Public endpoint — no authorization required.'
  const pageLine = endpoint.paginated
    ? ' Paginated: pass page=<n> to page manually.'
    : ''

  return defineTool({
    name: materializedToolName(endpoint.operationId),
    description: [
      `${endpoint.summary}.`,
      `${endpoint.method} ${endpoint.path}.`,
      scopeLine,
      pageLine,
    ].join(' '),
    parameters: parameters as never,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args): Promise<JsonValue> {
      const record = args as unknown as Record<string, unknown>
      const pathParams: Record<string, unknown> = {}
      for (const param of endpoint.pathParams) {
        if (record[param.name] !== undefined) pathParams[param.name] = record[param.name]
      }
      const queryParams: Record<string, unknown> = {}
      for (const param of endpoint.queryParams) {
        if (record[param.name] !== undefined) queryParams[param.name] = record[param.name]
      }
      const result = await client.call(endpoint, {
        pathParams,
        queryParams,
        body: record.body,
      }, { pages: 'first' })
      return { operation_id: endpoint.operationId, data: result.data, meta: result.meta } as unknown as JsonValue
    },
  })
}

export function createLoadTool(client: EsiaClient, options: LoadToolOptions = {}) {
  const cap = options.cap ?? DEFAULT_CAP
  return defineTool({
    name: 'esi_endpoint_load',
    description:
      'Materialize ESI endpoints as native tools for THIS agent: each loaded endpoint becomes a dedicated tool '
      + '`esi_<operationId>` with per-parameter validation, visible only to you, auto-removed when the session ends. '
      + 'Use for endpoints you will call repeatedly; use esi_call for one-off calls. Pass exact operationIds from '
      + 'esi_endpoint_search, or a domain tag to load a whole group. Loading respects a cap (default 30) — pass unload '
      + 'with operationIds to free slots.',
    parameters: {
      operation_ids: { type: 'array', items: { type: 'string' }, description: 'Exact operationIds to materialize (from esi_endpoint_search).' },
      tag: { type: 'string', description: 'Load every endpoint of one domain tag instead of listing ids.' },
      unload: { type: 'array', items: { type: 'string' }, description: 'operationIds to unload (dispose their tools), freeing cap slots.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec): Promise<JsonValue> {
      const agent = exec.agent as EsiaAgentLike | undefined
      if (agent === undefined) {
        throw new Error('esi_endpoint_load requires an agent-scoped session')
      }
      const unloaded: string[] = []
      const unload = args.unload as unknown as string[] | undefined
      if (unload !== undefined) {
        for (const operationId of unload) {
          if (dropLoaded(agent, operationId)) unloaded.push(operationId)
        }
      }

      const wanted = new Set<string>()
      const operationIds = args.operation_ids as unknown as string[] | undefined
      if (operationIds !== undefined) {
        for (const id of operationIds) {
          const index = ENDPOINT_INDEX[id]
          if (index === undefined) {
            throw new Error(`unknown operationId "${id}" — search first with esi_endpoint_search`)
          }
          wanted.add(id)
        }
      }
      if (args.tag !== undefined) {
        const tag = String(args.tag).toLowerCase()
        for (const endpoint of ENDPOINTS) {
          if (endpoint.tags.some((candidate) => candidate.toLowerCase() === tag)) wanted.add(endpoint.operationId)
        }
      }
      if (wanted.size === 0) {
        if (unloaded.length > 0) {
          // Unload-only call: report the freed slots.
          return {
            unloaded,
            count: loadedCount(agent),
            cap,
            note: `Unloaded ${unloaded.join(', ')}.`,
          } as unknown as JsonValue
        }
        throw new Error('esi_endpoint_load needs operation_ids or a tag — nothing to load')
      }

      const loaded: { name: string; operationId: string }[] = []
      const skipped: string[] = []
      for (const operationId of wanted) {
        if (isLoaded(agent, operationId)) {
          skipped.push(operationId)
          continue
        }
        if (loadedCount(agent) >= cap) {
          throw new Error(
            `materialized tool cap reached (${cap}) — unload some first (pass unload with operationIds), or use esi_call for one-off calls. `
            + `Currently loaded: ${listLoaded(agent).map((entry) => entry.operationId).join(', ') || '(none)'}`,
          )
        }
        const index = ENDPOINT_INDEX[operationId]
        if (index === undefined) continue // validated above; keeps the type narrow
        const endpoint = ENDPOINTS[index]
        if (endpoint === undefined) continue
        const tool = buildEndpointTool(client, endpoint)
        const dispose = agent.ctx.tools.register(tool)
        recordLoaded(agent, operationId, dispose)
        loaded.push({ name: materializedToolName(operationId), operationId })
      }

      return {
        loaded,
        ...(skipped.length > 0 ? { alreadyLoaded: skipped } : {}),
        count: loadedCount(agent),
        cap,
        note: loaded.length > 0
          ? `Loaded tools are now visible to you: ${loaded.map((entry) => entry.name).join(', ')}.`
          : 'Nothing new loaded.',
      } as unknown as JsonValue
    },
  })
}
