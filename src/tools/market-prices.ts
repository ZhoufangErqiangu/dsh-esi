/**
 * `esi_market_prices` — one-call price snapshot for a basket of item type IDs.
 *
 * Hot-path tool replacing the ad-hoc session pattern: `get_markets_prices`
 * (returns the full server-wide list — ~12k rows; the session had to grep the
 * spill file for the few wanted type IDs) plus one
 * `get_markets_region_id_orders` call per type with raw order dumps landing in
 * the context. This tool returns compact per-type rows:
 *   - server-wide `average_price` / `adjusted_price` (cached with a TTL),
 *   - best sell / best buy in a region (default The Forge / Jita) with the
 *     volume available at that price and per-side order counts.
 * Order books are aggregated inside the tool; only the summary reaches the
 * model.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { ENDPOINT_INDEX, ENDPOINTS } from '../generated/catalog.ts'
import type { CatalogEndpoint } from '../catalog-types.ts'
import type { EsiaClient } from '../esia-client.ts'
import type { SdeService } from '../sde/service.ts'
import { SDE_LANGUAGES, type SdeLanguage } from '../sde/types.ts'

/** The Forge — the canonical trade hub (Jita) on both CN and global servers. */
const DEFAULT_REGION_ID = 10000002
/** How long the server-wide price list stays cached (avoid re-downloading ~12k rows). */
const PRICES_TTL_MS = 5 * 60_000
const MAX_TYPE_IDS = 50

interface PriceEntry {
  average_price?: number
  adjusted_price?: number
}

interface PricesCacheEntry {
  fetchedAt: number
  map: Map<number, PriceEntry>
}

interface RegionOrderStats {
  best_sell_price?: number
  best_sell_volume?: number
  best_buy_price?: number
  best_buy_volume?: number
  sell_orders: number
  buy_orders: number
}

export function createMarketPricesTool(
  client: EsiaClient,
  sde?: SdeService,
  options: { defaultRegionId?: () => number | undefined } = {},
) {
  // Server-wide price list cache, keyed by server id (one plugin = one server).
  const pricesCache = new Map<string, PricesCacheEntry>()
  const defaultRegionId = options.defaultRegionId ?? (() => undefined)

  return defineTool({
    name: 'esi_market_prices',
    description:
      'One-call market price snapshot for a basket of item type IDs. Returns per type: '
      + 'server-wide average_price / adjusted_price (cached) and, for the given region '
      + '(defaults to the configured default market region, else The Forge / Jita, region_id 10000002), the best sell price (lowest sell order), '
      + 'best buy price (highest buy order), the volume available at each best price, and order counts. '
      + 'Optionally attaches localized item names from the SDE (include_names, default true). '
      + 'This is the dedicated hot-path tool for "what does this item cost" — prefer it over raw '
      + 'esi_call to get_markets_prices / get_markets_region_id_orders.',
    parameters: {
      type_ids: {
        type: 'array',
        items: { type: 'integer' },
        required: true,
        description: `Item type IDs to price (cap ${MAX_TYPE_IDS}).`,
      },
      region_id: {
        type: 'integer',
        description: 'Region for best-buy/best-sell order stats (defaults to the configured default market region, else The Forge / Jita).',
      },
      include_names: {
        type: 'boolean',
        description: 'Attach localized item names from the SDE (default true; skipped when SDE data is unavailable).',
      },
      language: {
        type: 'string',
        enum: [...SDE_LANGUAGES],
        description: 'Localization for attached names (de,en,es,fr,ja,ko,ru,zh; default the plugin SDE language, usually en).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args): Promise<JsonValue> {
      const typeIds = uniqueIds(args.type_ids)
      if (typeIds.length === 0) {
        throw new Error('esi_market_prices needs type_ids — pass the item type IDs to price')
      }
      if (typeIds.length > MAX_TYPE_IDS) {
        throw new Error(`esi_market_prices accepts at most ${MAX_TYPE_IDS} type_ids, got ${typeIds.length}`)
      }
      const regionId = args.region_id === undefined
        ? (defaultRegionId() ?? DEFAULT_REGION_ID)
        : Number(args.region_id)
      const includeNames = args.include_names !== false
      const language = args.language as SdeLanguage | undefined

      const [prices, regionName, nameMap] = await Promise.all([
        serverPriceMap(client, pricesCache),
        sde === undefined ? undefined : regionNameOf(sde, regionId, language),
        sde !== undefined && includeNames ? typeNamesOf(sde, typeIds, language) : undefined,
      ])
      const priceMap = prices.map

      const ordersEndpoint = endpointOf('get_markets_region_id_orders')
      const rows: Record<string, unknown>[] = []
      let regionFetched = true
      for (const typeId of typeIds) {
        const row: Record<string, unknown> = { type_id: typeId }
        const price = priceMap.get(typeId)
        if (price !== undefined) {
          if (price.average_price !== undefined) row.average_price = price.average_price
          if (price.adjusted_price !== undefined) row.adjusted_price = price.adjusted_price
        }
        const name = nameMap?.get(typeId)
        if (name !== undefined) row.name = name
        try {
          const result = await client.call(
            ordersEndpoint,
            { pathParams: { region_id: regionId }, queryParams: { type_id: typeId, order_type: 'all' } },
            { pages: 'auto' },
          )
          const stats = aggregateOrders(Array.isArray(result.data) ? result.data : [])
          for (const [key, value] of Object.entries(stats)) {
            if (value !== undefined) row[key] = value
          }
        } catch (error) {
          // A failed order book for one type must not sink the whole basket:
          // keep the server-wide prices and record the failure.
          row.orders_error = errorMessage(error)
          regionFetched = false
        }
        rows.push(row)
      }

      const meta: Record<string, unknown> = {
        region_id: regionId,
        prices: { cached: prices.cached, ttl_seconds: PRICES_TTL_MS / 1000 },
        names: nameMap === undefined ? 'unavailable' : 'sde',
        language: language ?? sde?.defaultLanguage ?? 'en',
        region_orders: regionFetched ? 'ok' : 'partial',
      }
      if (regionName !== undefined) meta.region_name = regionName
      return {
        rows,
        meta,
      } as unknown as JsonValue
    },
  })
}

/** Fetch the server-wide price list once per TTL and return it as a type_id → entry map. */
async function serverPriceMap(
  client: EsiaClient,
  cache: Map<string, PricesCacheEntry>,
): Promise<{ map: Map<number, PriceEntry>; cached: boolean }> {
  const key = client.serverId
  const cached = cache.get(key)
  if (cached !== undefined && Date.now() - cached.fetchedAt < PRICES_TTL_MS) {
    return { map: cached.map, cached: true }
  }

  const result = await client.call(endpointOf('get_markets_prices'), {}, { pages: 'first' })
  const map = new Map<number, PriceEntry>()
  if (Array.isArray(result.data)) {
    for (const raw of result.data) {
      const entry = raw as { type_id?: unknown; average_price?: unknown; adjusted_price?: unknown }
      if (typeof entry.type_id !== 'number') continue
      const value: PriceEntry = {}
      if (typeof entry.average_price === 'number') value.average_price = entry.average_price
      if (typeof entry.adjusted_price === 'number') value.adjusted_price = entry.adjusted_price
      map.set(entry.type_id, value)
    }
  }
  cache.set(key, { fetchedAt: Date.now(), map })
  return { map, cached: false }
}

/** Best sell/buy from a raw order list; only the summary is kept. */
function aggregateOrders(orders: readonly unknown[]): RegionOrderStats {
  let bestSell = Number.POSITIVE_INFINITY
  let bestBuy = Number.NEGATIVE_INFINITY
  let sellVolume = 0
  let buyVolume = 0
  let sellOrders = 0
  let buyOrders = 0
  for (const raw of orders) {
    const order = raw as { is_buy_order?: unknown; price?: unknown; volume_remain?: unknown }
    if (typeof order.price !== 'number') continue
    const volume = typeof order.volume_remain === 'number' ? order.volume_remain : 0
    if (order.is_buy_order === true) {
      buyOrders += 1
      if (order.price > bestBuy) {
        bestBuy = order.price
        buyVolume = volume
      } else if (order.price === bestBuy) {
        buyVolume += volume
      }
    } else if (order.is_buy_order === false) {
      sellOrders += 1
      if (order.price < bestSell) {
        bestSell = order.price
        sellVolume = volume
      } else if (order.price === bestSell) {
        sellVolume += volume
      }
    }
  }
  const stats: RegionOrderStats = { sell_orders: sellOrders, buy_orders: buyOrders }
  if (Number.isFinite(bestSell)) {
    stats.best_sell_price = bestSell
    stats.best_sell_volume = sellVolume
  }
  if (Number.isFinite(bestBuy)) {
    stats.best_buy_price = bestBuy
    stats.best_buy_volume = buyVolume
  }
  return stats
}

/** Best-effort region name via the SDE (undefined when unavailable). */
async function regionNameOf(sde: SdeService, regionId: number, language: SdeLanguage | undefined): Promise<string | undefined> {
  try {
    const result = await sde.query({
      table: 'mapRegions',
      ids: [regionId],
      fields: ['name'],
      language,
    })
    const name = result.rows[0]?.name
    return typeof name === 'string' && name !== '' ? name : undefined
  } catch {
    return undefined
  }
}

/** Best-effort localized type names via the SDE (undefined when unavailable). */
async function typeNamesOf(
  sde: SdeService,
  typeIds: readonly number[],
  language: SdeLanguage | undefined,
): Promise<Map<number, string> | undefined> {
  try {
    const result = await sde.query({
      table: 'types',
      ids: typeIds,
      fields: ['_key', 'name'],
      language,
    })
    const map = new Map<number, string>()
    for (const raw of result.rows) {
      const key = raw._key
      const name = raw.name
      if (typeof name !== 'string' || name === '') continue
      const typeId = typeof key === 'number' ? key : Number(key)
      if (Number.isFinite(typeId)) map.set(typeId, name)
    }
    return map
  } catch {
    return undefined
  }
}

function endpointOf(operationId: 'get_markets_prices' | 'get_markets_region_id_orders'): CatalogEndpoint {
  const index = ENDPOINT_INDEX[operationId]
  const endpoint = index === undefined ? undefined : ENDPOINTS[index]
  if (endpoint === undefined) {
    throw new Error(`catalog missing endpoint ${operationId} — regenerate with scripts/gen-catalog.mjs`)
  }
  return endpoint
}

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
