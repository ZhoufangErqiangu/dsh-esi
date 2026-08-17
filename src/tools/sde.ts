/**
 * SDE tools: sde_status and sde_query.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { SdeService } from '../sde/service.ts'

export function createSdeStatusTool(sde: SdeService) {
  return defineTool({
    name: 'sde_status',
    description:
      'Report the current EVE static-data (SDE) version: build number, release date, the version directory on disk, '
      + 'table count, total rows and bytes, and which tables have fast lookup indexes. The SDE is never loaded into the '
      + 'prompt — query it with sde_query. If the manifest is missing, run scripts/build-manifest.mjs or sde_update.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(): Promise<JsonValue> {
      return Promise.resolve(sde.status() as unknown as JsonValue)
    },
  })
}

export function createSdeQueryTool(sde: SdeService) {
  return defineTool({
    name: 'sde_query',
    description:
      'Query one EVE static-data (SDE) table. Tables include types (items), groups, categories, mapSolarSystems, '
      + 'mapRegions, mapConstellations, mapPlanets, blueprints, dogmaAttributes, dogmaEffects, factions, and ~90 more — '
      + 'sde_status lists the count; unknown tables produce an error listing examples. '
      + 'Filtering: ids=[...] looks up primary keys directly (fast when the table is indexed); filter matches top-level '
      + 'fields exactly or with operators {"gte":..,"lte":..,"gt":..,"lt":..,"in":[...],"ne":..}; search finds text in '
      + 'the named fields (default the localized name) case-insensitively. fields projects columns; language selects the '
      + 'localization for name/description (de,en,es,fr,ja,ko,ru,zh; default en). limit caps rows (default 20, max 200). '
      + 'Returns rows plus meta (engine, truncated, language).',
    parameters: {
      table: { type: 'string', required: true, description: 'SDE table name, e.g. types, mapSolarSystems, groups.' },
      ids: { type: 'array', items: { type: 'json' }, description: 'Primary-key lookups, e.g. [34, 587].' },
      filter: { type: 'json', description: 'Exact or operator filters on top-level fields, e.g. {"published": true} or {"mass": {"gte": 1000000}}.' },
      search_text: { type: 'string', description: 'Case-insensitive text to find (searches search_fields, default the localized name).' },
      search_fields: { type: 'array', items: { type: 'string' }, description: 'Fields to search when search_text is given (default ["name"]).' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Projection: which columns to return (default all).' },
      limit: { type: 'integer', description: 'Max rows (default 20, max 200).' },
      language: { type: 'string', enum: ['de', 'en', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'], description: 'Localization for name/description fields (default en).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
    },
    execute(args): Promise<JsonValue> {
      const search = args.search_text === undefined || String(args.search_text) === ''
        ? undefined
        : {
            text: String(args.search_text),
            ...(args.search_fields !== undefined ? { fields: args.search_fields as string[] } : {}),
          }
      return sde.query({
        table: String(args.table),
        ids: args.ids as unknown as (string | number)[] | undefined,
        filter: args.filter as Record<string, unknown> | undefined,
        search,
        fields: args.fields as string[] | undefined,
        limit: args.limit === undefined ? undefined : Number(args.limit),
        language: args.language as 'en' | 'zh' | undefined,
      }).then((result) => result as unknown as JsonValue)
    },
  })
}
