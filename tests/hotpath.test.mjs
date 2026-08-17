/**
 * Hot-path tool tests: `esi_item_lookup` (type IDs ↔ names) and
 * `esi_market_prices` (server-wide averages + region best buy/sell).
 *
 * Both tools are exercised against a local mock ESI server (order books with
 * pagination) plus a synthetic SDE version directory (types + mapRegions),
 * mirroring how the tools are used in the manufacturing-analysis session.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManifest } from '../scripts/build-manifest.mjs'
import { EsiaClient } from '../src/esia-client.ts'
import { SdeService } from '../src/sde/service.ts'
import { SERVERS } from '../src/generated/catalog.ts'
import { createItemLookupTool } from '../src/tools/item-lookup.ts'
import { createMarketPricesTool } from '../src/tools/market-prices.ts'

const CN_BASE = SERVERS.cn.esiBase

// ---- synthetic SDE ----------------------------------------------------------

const TYPES = [
  { _key: 34, name: { en: 'Tritanium', zh: '三钛合金' }, groupID: 18, volume: 0.01, published: true },
  { _key: 587, name: { en: 'Rifter', zh: '裂谷级' }, groupID: 25, volume: 26500, published: true },
  { _key: 588, name: { en: 'Rifter Blueprint', zh: '裂谷级蓝图' }, groupID: 99, volume: 0.01, published: false },
  { _key: 25601, name: { en: 'Fried Interface Circuit', zh: '烧焦的接口电路' }, groupID: 754, volume: 0.01, published: true },
]
const REGIONS = [
  { _key: 10000002, name: { en: 'The Forge', zh: '铸造星域' } },
  { _key: 10000042, name: { en: 'Metropolis', zh: '大都会星域' } },
]

function setupSde() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-esi-hotpath-'))
  const versionDir = join(dir, 'sde-hot-1')
  mkdirSync(versionDir, { recursive: true })
  writeFileSync(join(versionDir, '_sde.jsonl'), JSON.stringify({ _key: 'sde', buildNumber: 1, releaseDate: '2026-08-17T00:00:00Z' }))
  const dump = (table, rows) => writeFileSync(join(versionDir, `${table}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  dump('types', TYPES)
  dump('mapRegions', REGIONS)
  buildManifest(dir)
  return new SdeService({ dataRoot: dir, defaultLanguage: 'en' })
}

// ---- mock ESI ---------------------------------------------------------------

const MARKET_PRICES = [
  { type_id: 34, average_price: 9.65, adjusted_price: 7.28 },
  { type_id: 25601, average_price: 4448, adjusted_price: 4420 },
  { type_id: 587, average_price: 851378 },
  { type_id: 999999, average_price: 100, adjusted_price: 99 },
]

/** Order books per (region, type). Page 2 exists only for 34 in The Forge. */
function orderBook(regionId, typeId, page) {
  if (regionId === 10000002 && typeId === 34) {
    if (page === 2) {
      return [
        { order_id: 30, type_id: 34, price: 9.47, volume_remain: 300, is_buy_order: false },
        { order_id: 31, type_id: 34, price: 8.92, volume_remain: 400, is_buy_order: true },
      ]
    }
    return [
      { order_id: 1, type_id: 34, price: 9.48, volume_remain: 100, is_buy_order: false },
      { order_id: 2, type_id: 34, price: 10, volume_remain: 50, is_buy_order: false },
      { order_id: 3, type_id: 34, price: 9.47, volume_remain: 200, is_buy_order: false },
      { order_id: 4, type_id: 34, price: 8.92, volume_remain: 1000, is_buy_order: true },
      { order_id: 5, type_id: 34, price: 8.5, volume_remain: 500, is_buy_order: true },
    ]
  }
  if (regionId === 10000002 && typeId === 25601) {
    return [
      { order_id: 10, type_id: 25601, price: 4448, volume_remain: 51234, is_buy_order: false },
      { order_id: 11, type_id: 25601, price: 3500, volume_remain: 10000, is_buy_order: true },
    ]
  }
  if (regionId === 10000002 && typeId === 587) {
    return [{ order_id: 20, type_id: 587, price: 851000, volume_remain: 7, is_buy_order: false }]
  }
  if (regionId === 10000042 && typeId === 34) {
    return [
      { order_id: 40, type_id: 34, price: 10.5, volume_remain: 999, is_buy_order: false },
      { order_id: 41, type_id: 34, price: 8.0, volume_remain: 888, is_buy_order: true },
    ]
  }
  return [] // 999999 and 588: no orders
}

function startMock() {
  const hits = { prices: 0, orders: [] }
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      res.setHeader('Content-Type', 'application/json')
      if (url.pathname === '/markets/prices/') {
        hits.prices += 1
        res.end(JSON.stringify(MARKET_PRICES))
        return
      }
      const match = url.pathname.match(/^\/markets\/(\d+)\/orders\//)
      if (match !== null) {
        const regionId = Number(match[1])
        const typeId = Number(url.searchParams.get('type_id'))
        const page = Number(url.searchParams.get('page') ?? '1')
        hits.orders.push({ regionId, typeId, page })
        const book = orderBook(regionId, typeId, page)
        if (regionId === 10000002 && typeId === 34) res.setHeader('X-Pages', '2')
        res.end(JSON.stringify(book))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: `no mock route for ${url.pathname}` }))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits }))
  })
}

function makeClient(port) {
  return new EsiaClient({
    server: 'cn',
    ratePerSecond: 0,
    fetchImpl: (url, init) => fetch(url.replace(CN_BASE, `http://127.0.0.1:${port}`), init),
  })
}

function execStub() {
  return {
    callId: `c-${Math.random().toString(36).slice(2)}`,
    name: 'test',
    arguments: {},
    signal: new AbortController().signal,
  }
}

async function withMock(fn) {
  const { server, port, hits } = await startMock()
  try {
    return await fn({ port, hits })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// ---- esi_item_lookup ---------------------------------------------------------

test('item lookup resolves type ids to a stable shape with not_found', async () => {
  const sde = setupSde()
  try {
    const tool = createItemLookupTool(sde)
    const result = await tool.execute({ type_ids: [25601, 587, 999999], language: 'zh' }, execStub())
    assert.equal(result.meta.count, 2)
    assert.deepEqual(result.not_found, [999999])
    assert.deepEqual(result.rows[0], {
      type_id: 25601,
      name: '烧焦的接口电路',
      group_id: 754,
      volume: 0.01,
      published: true,
    })
    assert.deepEqual(result.rows[1], { type_id: 587, name: '裂谷级', group_id: 25, volume: 26500, published: true })
    // Lossless JSON (the tools runtime rejects anything else).
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  } finally {
    rmSync(sde.resolveVersionDir().replace(/\/sde-hot-1$/, ''), { recursive: true, force: true })
  }
})

test('item lookup searches by localized name, honoring published_only and limit', async () => {
  const sde = setupSde()
  try {
    const tool = createItemLookupTool(sde)
    const en = await tool.execute({ search: 'rifter' }, execStub())
    const names = en.rows.map((row) => row.name).sort()
    assert.deepEqual(names, ['Rifter', 'Rifter Blueprint'])

    const published = await tool.execute({ search: 'rifter', published_only: true }, execStub())
    assert.deepEqual(published.rows.map((row) => row.type_id), [587])

    const zh = await tool.execute({ search: '三钛', language: 'zh' }, execStub())
    assert.equal(zh.rows.length, 1)
    assert.equal(zh.rows[0].name, '三钛合金')
    assert.equal(zh.rows[0].type_id, 34)
  } finally {
    rmSync(sde.resolveVersionDir().replace(/\/sde-hot-1$/, ''), { recursive: true, force: true })
  }
})

test('item lookup merges ids and search, deduping overlapping matches', async () => {
  const sde = setupSde()
  try {
    const tool = createItemLookupTool(sde)
    const result = await tool.execute({ type_ids: [34], search: 'rifter' }, execStub())
    const ids = result.rows.map((row) => row.type_id).sort((a, b) => a - b)
    assert.deepEqual(ids, [34, 587, 588])
  } finally {
    rmSync(sde.resolveVersionDir().replace(/\/sde-hot-1$/, ''), { recursive: true, force: true })
  }
})

test('item lookup rejects empty input and oversized baskets', async () => {
  const sde = setupSde()
  try {
    const tool = createItemLookupTool(sde)
    await assert.rejects(tool.execute({}, execStub()), /type_ids and\/or search/)
    const tooMany = Array.from({ length: 101 }, (_, i) => i)
    await assert.rejects(tool.execute({ type_ids: tooMany }, execStub()), /at most 100 type_ids/)
  } finally {
    rmSync(sde.resolveVersionDir().replace(/\/sde-hot-1$/, ''), { recursive: true, force: true })
  }
})

// ---- esi_market_prices -------------------------------------------------------

test('market prices return averages plus aggregated region best buy/sell', async () => {
  const sde = setupSde()
  await withMock(async ({ port, hits }) => {
    const client = makeClient(port)
    const tool = createMarketPricesTool(client, sde)
    const result = await tool.execute({ type_ids: [34, 25601], language: 'zh' }, execStub())

    // Region defaults to The Forge / Jita.
    assert.equal(result.meta.region_id, 10000002)
    assert.equal(result.meta.region_name, '铸造星域')
    assert.equal(result.meta.names, 'sde')

    const trit = result.rows.find((row) => row.type_id === 34)
    assert.equal(trit.name, '三钛合金')
    assert.equal(trit.average_price, 9.65)
    assert.equal(trit.adjusted_price, 7.28)
    // Two-page order book: best sell 9.47 across two orders (200+300), best buy 8.92 (1000+400).
    assert.equal(trit.best_sell_price, 9.47)
    assert.equal(trit.best_sell_volume, 500)
    assert.equal(trit.best_buy_price, 8.92)
    assert.equal(trit.best_buy_volume, 1400)
    assert.equal(trit.sell_orders, 4)
    assert.equal(trit.buy_orders, 3)

    const fic = result.rows.find((row) => row.type_id === 25601)
    assert.equal(fic.name, '烧焦的接口电路')
    assert.equal(fic.best_sell_price, 4448)
    assert.equal(fic.best_sell_volume, 51234)
    assert.equal(fic.best_buy_price, 3500)

    // Both pages of the 34 book were fetched.
    assert.ok(hits.orders.some((hit) => hit.typeId === 34 && hit.page === 2))
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  })
  rmSync(sde.resolveVersionDir().replace(/\/sde-hot-1$/, ''), { recursive: true, force: true })
})

test('market prices honor a custom region and survive empty order books', async () => {
  const sde = setupSde()
  await withMock(async ({ port }) => {
    const client = makeClient(port)
    const tool = createMarketPricesTool(client, sde)
    const result = await tool.execute({ type_ids: [34, 999999], region_id: 10000042, language: 'en' }, execStub())
    assert.equal(result.meta.region_id, 10000042)
    assert.equal(result.meta.region_name, 'Metropolis')
    const trit = result.rows.find((row) => row.type_id === 34)
    assert.equal(trit.best_sell_price, 10.5)
    assert.equal(trit.best_buy_price, 8.0)
    const empty = result.rows.find((row) => row.type_id === 999999)
    assert.equal(empty.average_price, 100)
    assert.equal(empty.best_sell_price, undefined)
    assert.equal(empty.sell_orders, 0)
    assert.equal(empty.buy_orders, 0)
  })
  rmSync(sde.resolveVersionDir().replace(/\/sde-hot-1$/, ''), { recursive: true, force: true })
})

test('market prices cache the server-wide list across calls', async () => {
  const sde = setupSde()
  await withMock(async ({ port, hits }) => {
    const client = makeClient(port)
    const tool = createMarketPricesTool(client, sde)
    await tool.execute({ type_ids: [34], include_names: false }, execStub())
    const second = await tool.execute({ type_ids: [34, 25601], include_names: false }, execStub())
    // /markets/prices/ hit exactly once; the second call reused the TTL cache.
    assert.equal(hits.prices, 1)
    assert.equal(second.meta.prices.cached, true)
    // Order books are NOT cached by the tool (fresh per call): 2 calls × 2 pages for type 34.
    assert.equal(hits.orders.filter((hit) => hit.typeId === 34).length, 4)
  })
  rmSync(sde.resolveVersionDir().replace(/\/sde-hot-1$/, ''), { recursive: true, force: true })
})

test('market prices degrade gracefully without an SDE service', async () => {
  await withMock(async ({ port }) => {
    const client = makeClient(port)
    const tool = createMarketPricesTool(client) // no SDE injected
    const result = await tool.execute({ type_ids: [587] }, execStub())
    assert.equal(result.meta.names, 'unavailable')
    assert.equal(result.rows[0].name, undefined)
    assert.equal(result.rows[0].best_sell_price, 851000)
    assert.equal(result.meta.language, 'en')
  })
})

test('market prices reject empty or oversized baskets', async () => {
  const sde = setupSde()
  await withMock(async ({ port }) => {
    const client = makeClient(port)
    const tool = createMarketPricesTool(client, sde)
    await assert.rejects(tool.execute({ type_ids: [] }, execStub()), /needs type_ids/)
    // Missing the required type_ids fails schema validation before execute runs.
    await assert.rejects(tool.execute({}, execStub()), /required property "type_ids"/)
    const tooMany = Array.from({ length: 51 }, (_, i) => i)
    await assert.rejects(tool.execute({ type_ids: tooMany }, execStub()), /at most 50 type_ids/)
  })
  rmSync(sde.resolveVersionDir().replace(/\/sde-hot-1$/, ''), { recursive: true, force: true })
})
