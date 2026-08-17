/**
 * `esi_item_lookup` — resolve EVE item type IDs to names (plus basic
 * metadata), or search items by (localized) name.
 *
 * Hot-path tool. The session resolved type IDs → names through repeated
 * `sde_query` calls on the `types` table with inconsistent field spellings
 * (type_id / typeID / _key / typeName) that silently dropped columns. This
 * tool absorbs that SDE schema friction and always returns a stable shape:
 * `type_id` + localized `name` + `group_id` / `volume` / `published`, with
 * unknown ids reported in `not_found`.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { SdeService } from '../sde/service.ts'
import { SDE_LANGUAGES, type SdeLanguage } from '../sde/types.ts'

const MAX_TYPE_IDS = 100
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

/** Projection requested from the types table; `_key` is the SDE primary key. */
const TYPE_FIELDS = ['_key', 'name', 'groupID', 'volume', 'published'] as const

interface ItemRow {
  type_id: number
  name: string
  group_id?: number
  volume?: number
  published?: boolean
}

export function createItemLookupTool(sde: SdeService) {
  return defineTool({
    name: 'esi_item_lookup',
    description:
      'Resolve EVE item type IDs to names (and basic metadata), or search items by name. '
      + 'Pass type_ids (e.g. [25601, 25605]) and/or a search text that matches the localized name '
      + '(Chinese or English, case-insensitive). Returns rows with type_id, the localized name, '
      + 'group_id, volume and published; ids without a match are reported in not_found. '
      + 'This is the dedicated hot-path tool for "what is this item / find its type_id" — '
      + 'prefer it over raw sde_query on the types table.',
    parameters: {
      type_ids: {
        type: 'array',
        items: { type: 'integer' },
        description: `Item type IDs to resolve to names (cap ${MAX_TYPE_IDS}).`,
      },
      search: {
        type: 'string',
        description: 'Search item names containing this text (case-insensitive, matches the chosen language).',
      },
      language: {
        type: 'string',
        enum: [...SDE_LANGUAGES],
        description: 'Localization for names (de,en,es,fr,ja,ko,ru,zh; default the plugin SDE language, usually en).',
      },
      published_only: {
        type: 'boolean',
        description: 'Only return published (real in-game) items, hiding blueprints and other unpublished entries. Default false.',
      },
      limit: {
        type: 'integer',
        description: `Max search matches (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT}); ignored when resolving type_ids.`,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args): Promise<JsonValue> {
      const typeIds = uniqueIds(args.type_ids)
      if (typeIds.length > MAX_TYPE_IDS) {
        throw new Error(`esi_item_lookup accepts at most ${MAX_TYPE_IDS} type_ids, got ${typeIds.length}`)
      }
      const search = args.search === undefined || String(args.search).trim() === ''
        ? undefined
        : String(args.search).trim()
      if (typeIds.length === 0 && search === undefined) {
        throw new Error(
          'esi_item_lookup needs type_ids and/or search — pass item type IDs to resolve, or a name text to search',
        )
      }
      const language = args.language as SdeLanguage | undefined
      const publishedOnly = args.published_only === true
      const limit = Math.min(Math.max(args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit), 1), MAX_LIMIT)

      const rows: ItemRow[] = []
      const seen = new Set<number>()
      const byId = new Map<number, ItemRow>()

      if (typeIds.length > 0) {
        const result = await sde.query({
          table: 'types',
          ids: typeIds,
          fields: TYPE_FIELDS,
          language,
        })
        for (const raw of result.rows) {
          const row = projectItem(raw)
          if (row === undefined || (publishedOnly && row.published !== true)) continue
          seen.add(row.type_id)
          byId.set(row.type_id, row)
        }
        // Preserve the caller's id order (SQLite IN does not guarantee it).
        for (const id of typeIds) {
          const row = byId.get(id)
          if (row !== undefined) rows.push(row)
        }
      }

      if (search !== undefined) {
        const result = await sde.query({
          table: 'types',
          search: { text: search },
          fields: TYPE_FIELDS,
          limit: limit + 1,
          language,
        })
        for (const raw of result.rows.slice(0, limit)) {
          const row = projectItem(raw)
          if (row === undefined || seen.has(row.type_id) || (publishedOnly && row.published !== true)) continue
          seen.add(row.type_id)
          rows.push(row)
        }
      }

      const notFound = typeIds.filter((id) => !seen.has(id))
      return {
        rows,
        ...(notFound.length > 0 ? { not_found: notFound } : {}),
        meta: {
          count: rows.length,
          language: language ?? sde.defaultLanguage,
          engine: 'sqlite',
        },
      } as unknown as JsonValue
    },
  })
}

/** Deduplicate and keep only finite integer ids, preserving order. */
function uniqueIds(raw: unknown): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  if (!Array.isArray(raw)) return out
  for (const value of raw) {
    const id = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(id) || !Number.isInteger(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Map one raw types row to the stable item shape; undefined when the key is unusable. */
function projectItem(raw: Record<string, unknown>): ItemRow | undefined {
  const key = raw._key
  if (key === undefined) return undefined
  const typeId = typeof key === 'number' ? key : Number(key)
  if (!Number.isFinite(typeId) || !Number.isInteger(typeId)) return undefined
  const name = typeof raw.name === 'string' ? raw.name : ''
  const row: ItemRow = { type_id: typeId, name }
  if (typeof raw.groupID === 'number') row.group_id = raw.groupID
  if (typeof raw.volume === 'number') row.volume = raw.volume
  if (typeof raw.published === 'boolean') row.published = raw.published
  return row
}
